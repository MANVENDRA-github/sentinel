import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { chatCompletionRequestSchema } from './schemas.js';
import { createAuthHook, extractBearerToken, hashApiKey } from './auth.js';
import { GatewayError, ValidationError } from './errors.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { TraceStore } from './telemetry/trace.js';
import type { SemanticCache } from './cache/cache.js';
import { traceRoutes } from './routes.traces.js';

export interface ServerDeps {
  registry: ProviderRegistry;
  apiKeys: ReadonlySet<string>;
  traceStore: TraceStore;
  adminKey?: string | undefined;
  cache?: SemanticCache | undefined;
  logger?: FastifyServerOptions['logger'];
}

const internalErrorBody = {
  error: { message: 'Internal server error', type: 'internal_error', code: null },
};

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

const requestSpans = new WeakMap<object, Span>();

/** Finalizes and ends the span attached to a request (no-op if none). Ends exactly once. */
function endSpan(request: object, status: number, error?: unknown): void {
  const span = requestSpans.get(request);
  if (span === undefined) return;
  requestSpans.delete(request);
  span.setAttribute('http.response.status_code', status);
  if (error === undefined) {
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    const err = error instanceof Error ? error : new Error(String(error));
    span.recordException(err);
    span.setAttribute('error.type', err.name);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }
  span.end();
}

/** Pulls OpenAI-style token usage off a (real or cached) response onto the span. */
function setUsageAttributes(span: Span | undefined, result: unknown): void {
  if (span === undefined || typeof result !== 'object' || result === null) return;
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return;
  const u = usage as Record<string, unknown>;
  if (typeof u.prompt_tokens === 'number')
    span.setAttribute('gen_ai.usage.input_tokens', u.prompt_tokens);
  if (typeof u.completion_tokens === 'number') {
    span.setAttribute('gen_ai.usage.output_tokens', u.completion_tokens);
  }
  if (typeof u.total_tokens === 'number')
    span.setAttribute('gen_ai.usage.total_tokens', u.total_tokens);
}

/** Builds the Sentinel gateway Fastify app. Dependencies are injected for testability. */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: deps.logger ?? {
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
        censor: '[redacted]',
      },
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof GatewayError ? error.status : 500;
    endSpan(request, status, error);
    if (error instanceof GatewayError) {
      return reply.status(error.status).send(error.toBody());
    }
    app.log.error({ err: error }, 'unhandled gateway error');
    return reply.status(500).send(internalErrorBody);
  });

  const authHook = createAuthHook(deps.apiKeys);

  app.post(
    '/v1/chat/completions',
    {
      onRequest: async (request) => {
        // Resolve the tracer lazily so it picks up the registered provider (set after
        // module load), rather than capturing a no-op tracer at import time.
        const span = trace.getTracer('@sentinel/gateway').startSpan('chat.completion', {
          kind: SpanKind.SERVER,
        });
        requestSpans.set(request, span);
      },
      preHandler: authHook,
    },
    async (request, reply) => {
      const span = requestSpans.get(request);
      const token = extractBearerToken(request.headers.authorization);
      const apiKeyHash = token !== null ? hashApiKey(token) : null;
      if (span !== undefined && apiKeyHash !== null) {
        span.setAttribute('sentinel.api_key_hash', apiKeyHash);
      }

      const parsed = chatCompletionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues
            .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
            .join('; '),
        );
      }
      const chatRequest = parsed.data;
      span?.setAttribute('gen_ai.request.model', chatRequest.model);
      span?.setAttribute('sentinel.stream', chatRequest.stream === true);

      const provider = deps.registry.resolve(chatRequest.model);
      span?.setAttribute('sentinel.provider', provider.name);

      // ── Non-streaming ──────────────────────────────────────────────────────
      if (chatRequest.stream !== true) {
        if (deps.cache !== undefined && apiKeyHash !== null) {
          const cached = await deps.cache.get(chatRequest, apiKeyHash);
          if (cached?.kind === 'json') {
            setUsageAttributes(span, cached.body);
            span?.setAttribute('sentinel.cache_hit', true);
            endSpan(request, 200);
            return reply.status(200).send(cached.body);
          }
        }
        const result = await provider.chat(chatRequest);
        setUsageAttributes(span, result);
        if (deps.cache !== undefined && apiKeyHash !== null) {
          await deps.cache.set(chatRequest, apiKeyHash, { kind: 'json', body: result });
        }
        span?.setAttribute('sentinel.cache_hit', false);
        endSpan(request, 200);
        return reply.status(200).send(result);
      }

      // ── Streaming ──────────────────────────────────────────────────────────
      // Replay a cached stream verbatim on a hit.
      if (deps.cache !== undefined && apiKeyHash !== null) {
        const cached = await deps.cache.get(chatRequest, apiKeyHash);
        if (cached?.kind === 'stream') {
          span?.setAttribute('sentinel.cache_hit', true);
          reply.hijack();
          reply.raw.writeHead(200, SSE_HEADERS);
          for (const chunk of cached.chunks) {
            reply.raw.write(`data: ${chunk}\n\n`);
          }
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
          endSpan(request, 200);
          return reply;
        }
      }

      // Miss: pull the first chunk *before* committing to a 200 SSE response, so an
      // immediate upstream failure still maps to a proper error status; buffer for caching.
      const iterator = provider.chatStream(chatRequest)[Symbol.asyncIterator]();
      const first = await iterator.next();

      reply.hijack();
      reply.raw.writeHead(200, SSE_HEADERS);

      const buffered: string[] = [];
      let streamError: unknown;
      try {
        for (let step = first; step.done !== true; step = await iterator.next()) {
          reply.raw.write(`data: ${step.value}\n\n`);
          buffered.push(step.value);
        }
        reply.raw.write('data: [DONE]\n\n');
      } catch (error) {
        streamError = error;
        const body = error instanceof GatewayError ? error.toBody() : internalErrorBody;
        reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
      } finally {
        reply.raw.end();
        span?.setAttribute('sentinel.cache_hit', false);
        endSpan(request, 200, streamError);
      }

      // Only cache a stream that completed cleanly.
      if (streamError === undefined && deps.cache !== undefined && apiKeyHash !== null) {
        await deps.cache.set(chatRequest, apiKeyHash, { kind: 'stream', chunks: buffered });
      }
      return reply;
    },
  );

  app.register(traceRoutes, { traceStore: deps.traceStore, adminKey: deps.adminKey });

  return app;
}

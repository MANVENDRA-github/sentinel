import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { chatCompletionRequestSchema } from './schemas.js';
import { createAuthHook, extractBearerToken, hashApiKey } from './auth.js';
import { GatewayError, ValidationError } from './errors.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { TraceStore } from './telemetry/trace.js';
import { traceRoutes } from './routes.traces.js';

export interface ServerDeps {
  registry: ProviderRegistry;
  apiKeys: ReadonlySet<string>;
  traceStore: TraceStore;
  adminKey?: string | undefined;
  logger?: FastifyServerOptions['logger'];
}

const internalErrorBody = {
  error: { message: 'Internal server error', type: 'internal_error', code: null },
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

/** Pulls OpenAI-style token usage off a non-streaming response onto the span. */
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
      if (span !== undefined && token !== null) {
        span.setAttribute('sentinel.api_key_hash', hashApiKey(token));
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

      if (chatRequest.stream !== true) {
        const result = await provider.chat(chatRequest);
        setUsageAttributes(span, result);
        endSpan(request, 200);
        return reply.status(200).send(result);
      }

      // Streaming: pull the first chunk *before* committing to a 200 SSE response,
      // so an immediate upstream failure still maps to a proper error status.
      const iterator = provider.chatStream(chatRequest)[Symbol.asyncIterator]();
      const first = await iterator.next();

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      let streamError: unknown;
      try {
        for (let step = first; step.done !== true; step = await iterator.next()) {
          reply.raw.write(`data: ${step.value}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
      } catch (error) {
        streamError = error;
        const body = error instanceof GatewayError ? error.toBody() : internalErrorBody;
        reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
      } finally {
        reply.raw.end();
        endSpan(request, 200, streamError);
      }
      return reply;
    },
  );

  app.register(traceRoutes, { traceStore: deps.traceStore, adminKey: deps.adminKey });

  return app;
}

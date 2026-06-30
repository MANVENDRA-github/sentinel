import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { chatCompletionRequestSchema } from './schemas.js';
import { computeCostUsd } from './cost.js';
import type { ModelPricing, TokenUsage } from './cost.js';
import { createAuthHook, extractBearerToken, hashApiKey } from './auth.js';
import {
  GatewayError,
  GuardrailBlockedError,
  RateLimitedError,
  ValidationError,
} from './errors.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { TraceStore } from './telemetry/trace.js';
import type { SemanticCache } from './cache/cache.js';
import { traceRoutes } from './routes.traces.js';
import { regressionRoutes } from './routes.regression.js';
import { createRouter } from './routing/router.js';
import type { RoutingConfig } from './routing/router.js';
import { runChat, openStream } from './routing/executor.js';
import type { ExecutorOptions, RouteOutcome } from './routing/executor.js';
import type { BucketRegistry } from './throttle/token-bucket.js';
import type { Verifier } from './verify/verifier.js';

/** Routing, retry, fallback, and throttle settings. Omit for a single-provider pass-through. */
export interface RoutingDeps {
  /** Tier list + fallback chain (from `sentinel.config.json`). */
  config?: RoutingConfig | undefined;
  /** Retries per candidate after the first attempt. */
  maxRetries?: number | undefined;
  /** Per-attempt timeout in ms (`0` disables). */
  timeoutMs?: number | undefined;
  /** Base retry backoff in ms. */
  baseBackoffMs?: number | undefined;
  /** Max throttle pacing wait per candidate before it is skipped. */
  maxWaitMs?: number | undefined;
  /** Per-provider rate-limit buckets. */
  throttle?: BucketRegistry | undefined;
  /** Injectable sleep (handy for tests). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface ServerDeps {
  registry: ProviderRegistry;
  apiKeys: ReadonlySet<string>;
  traceStore: TraceStore;
  adminKey?: string | undefined;
  cache?: SemanticCache | undefined;
  routing?: RoutingDeps | undefined;
  verifier?: Verifier | undefined;
  /** model → USD-per-1K-token pricing, for per-request cost attribution on the trace. */
  pricing?: ReadonlyMap<string, ModelPricing> | undefined;
  /** Per-API-key inbound rate-limit buckets (built from CLIENT_RPM). */
  clientThrottle?: BucketRegistry | undefined;
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

/** pino redaction for the default logger — keeps API keys out of request logs. */
export const logRedaction = {
  paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
  censor: '[redacted]',
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

/** Extracts OpenAI-style token usage as plain numbers (null when a field is absent). */
function extractUsage(result: unknown): TokenUsage {
  if (typeof result !== 'object' || result === null)
    return { promptTokens: null, completionTokens: null };
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null)
    return { promptTokens: null, completionTokens: null };
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
  };
}

/** Records the request's USD cost from usage × the price map (no-op if unpriced/unknown). */
function applyCost(
  span: Span | undefined,
  model: string,
  result: unknown,
  pricing: ReadonlyMap<string, ModelPricing> | undefined,
): void {
  if (span === undefined || pricing === undefined || pricing.size === 0) return;
  const cost = computeCostUsd(model, extractUsage(result), pricing);
  if (cost !== null) span.setAttribute('sentinel.cost_usd', cost);
}

/** Records which provider/model actually served the request after routing/fallback. */
function applyRouteAttributes(span: Span | undefined, outcome: RouteOutcome): void {
  span?.setAttribute('sentinel.provider', outcome.routedProvider);
  span?.setAttribute('sentinel.routed_provider', outcome.routedProvider);
  span?.setAttribute('sentinel.routed_model', outcome.routedModel);
  span?.setAttribute('sentinel.fallback_used', outcome.fallbackUsed);
  span?.setAttribute('sentinel.retry_count', outcome.retryCount);
}

/** Pulls the assistant message text out of a non-streaming OpenAI-style response. */
function extractText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const choices = (result as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/** Reassembles streamed text from buffered SSE delta chunks (best-effort, for the judge). */
function extractStreamText(chunks: string[]): string {
  let text = '';
  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk) as { choices?: { delta?: { content?: unknown } }[] };
      const piece = parsed.choices?.[0]?.delta?.content;
      if (typeof piece === 'string') text += piece;
    } catch {
      // non-JSON keep-alive chunk — nothing to add to the judged text
    }
  }
  return text;
}

/** preHandler: enforces a per-API-key inbound request-per-minute budget (429 when exceeded). */
function createClientLimitHook(throttle: BucketRegistry) {
  return async function clientLimitHook(request: {
    headers: { authorization?: string | undefined };
  }): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) return; // the auth hook already rejects a missing/invalid key
    const allowed = await throttle.acquire(hashApiKey(token), 0);
    if (!allowed) throw new RateLimitedError();
  };
}

/** Builds the Sentinel gateway Fastify app. Dependencies are injected for testability. */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: deps.logger ?? { redact: logRedaction },
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
  const preHandler = deps.clientThrottle
    ? [authHook, createClientLimitHook(deps.clientThrottle)]
    : authHook;

  const routerConfig = deps.routing?.config;
  const router = createRouter({
    registry: deps.registry,
    ...(routerConfig ? { routing: routerConfig } : {}),
  });
  const execOptions: ExecutorOptions = {
    maxRetries: deps.routing?.maxRetries ?? 0,
    timeoutMs: deps.routing?.timeoutMs ?? 0,
    baseBackoffMs: deps.routing?.baseBackoffMs ?? 200,
    maxWaitMs: deps.routing?.maxWaitMs ?? 0,
    ...(deps.routing?.throttle ? { throttle: deps.routing.throttle } : {}),
    ...(deps.routing?.sleep ? { sleep: deps.routing.sleep } : {}),
  };

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
      preHandler,
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

      const candidates = router.resolveCandidates(chatRequest);

      // ── Non-streaming ──────────────────────────────────────────────────────
      if (chatRequest.stream !== true) {
        if (deps.cache !== undefined && apiKeyHash !== null) {
          const cached = await deps.cache.get(chatRequest, apiKeyHash);
          if (cached?.kind === 'json') {
            setUsageAttributes(span, cached.body);
            // Cost recorded on a hit = the upstream spend this cache avoided.
            applyCost(span, chatRequest.model, cached.body, deps.pricing);
            span?.setAttribute('sentinel.cache_hit', true);
            endSpan(request, 200);
            return reply.status(200).send(cached.body);
          }
        }
        const { result, outcome } = await runChat(candidates, chatRequest, execOptions);
        setUsageAttributes(span, result);
        applyRouteAttributes(span, outcome);
        applyCost(span, outcome.routedModel, result, deps.pricing);

        let responseText: string | undefined;
        if (deps.verifier !== undefined) {
          span?.setAttribute('sentinel.prompt_fingerprint', deps.verifier.fingerprint(chatRequest));
          responseText = extractText(result);
          const verdict = deps.verifier.inspect(chatRequest, responseText);
          span?.setAttribute('sentinel.guardrail_status', verdict.status);
          if (verdict.violations.length > 0) {
            span?.setAttribute('sentinel.guardrail_violations', verdict.violations.join(','));
          }
          if (verdict.status === 'block') {
            throw new GuardrailBlockedError(verdict.violations);
          }
        }

        if (deps.cache !== undefined && apiKeyHash !== null) {
          await deps.cache.set(chatRequest, apiKeyHash, { kind: 'json', body: result });
        }
        span?.setAttribute('sentinel.cache_hit', false);
        endSpan(request, 200);
        // Async, sampled judge runs after the row is written; never blocks the response.
        if (deps.verifier !== undefined && span !== undefined && responseText !== undefined) {
          deps.verifier.scheduleJudge(span.spanContext().spanId, chatRequest, responseText);
        }
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
      // immediate upstream failure still routes/falls back to a proper error status;
      // buffer for caching. Fallback is bounded to this first chunk (pre-hijack).
      const { iterator, first, outcome } = await openStream(candidates, chatRequest, execOptions);
      applyRouteAttributes(span, outcome);
      if (deps.verifier !== undefined) {
        span?.setAttribute('sentinel.prompt_fingerprint', deps.verifier.fingerprint(chatRequest));
      }

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

      // Only cache / judge a stream that completed cleanly.
      if (streamError === undefined && deps.cache !== undefined && apiKeyHash !== null) {
        await deps.cache.set(chatRequest, apiKeyHash, { kind: 'stream', chunks: buffered });
      }
      if (streamError === undefined && deps.verifier !== undefined && span !== undefined) {
        deps.verifier.scheduleJudge(
          span.spanContext().spanId,
          chatRequest,
          extractStreamText(buffered),
        );
      }
      return reply;
    },
  );

  app.register(traceRoutes, { traceStore: deps.traceStore, adminKey: deps.adminKey });
  app.register(regressionRoutes, { traceStore: deps.traceStore, adminKey: deps.adminKey });

  return app;
}

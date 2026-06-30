import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';

/** A persisted, queryable record of one gateway request. Metadata only — no prompt/response content. */
export interface TraceRecord {
  id: string;
  traceId: string;
  timestamp: number;
  durationMs: number;
  model: string | null;
  provider: string | null;
  stream: boolean;
  status: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Estimated USD cost from token usage × the per-model price map (null = unpriced/unknown). */
  costUsd: number | null;
  errorType: string | null;
  errorMessage: string | null;
  apiKeyHash: string | null;
  cacheHit: boolean;
  /** Provider that actually served the response (after routing/fallback). */
  routedProvider: string | null;
  /** Model that actually served the response (e.g. the tier chosen for `auto`). */
  routedModel: string | null;
  /** A non-primary candidate served the request. */
  fallbackUsed: boolean;
  /** Retries spent before the request succeeded. */
  retryCount: number;
  /** Inline guardrail outcome: `pass` | `flag` | `block` (null when guardrails are off). */
  guardrailStatus: string | null;
  /** Matched guardrail category codes (comma-joined), e.g. `pii.email`. Never raw content. */
  guardrailViolations: string | null;
  /** Async LLM-judge score, 1–5 (null = not sampled or "unscored"). */
  judgeScore: number | null;
  /** Judge's short critique (judge-authored metadata, capped — not the response body). */
  judgeReason: string | null;
  /** Judge transport/parse error, when scoring failed (⇒ "unscored", never a pass). */
  judgeError: string | null;
  /** Model-independent prompt fingerprint, for regression grouping across models/versions. */
  promptFingerprint: string | null;
}

/** Fields the async judge attaches to an already-recorded trace. */
export interface VerdictUpdate {
  judgeScore: number | null;
  judgeReason: string | null;
  judgeError: string | null;
}

/** Filters for querying traces (all optional). */
export interface TraceQuery {
  model?: string;
  provider?: string;
  status?: number;
  stream?: boolean;
  since?: number;
  until?: number;
  cacheHit?: boolean;
  routedProvider?: string;
  fallbackUsed?: boolean;
  guardrailStatus?: string;
  judgeScoreMin?: number;
  judgeScoreMax?: number;
  promptFingerprint?: string;
  /** Restrict to one client's traces (by API-key hash) — used by the self-scoped read API. */
  apiKeyHash?: string;
  limit?: number;
  offset?: number;
}

/** A persistence sink for trace records. Implemented by the in-memory and SQLite stores. */
export interface TraceStore {
  record(trace: TraceRecord): void;
  /** Attaches an async judge verdict to an already-recorded trace (no-op if the id is unknown). */
  attachVerdict(id: string, verdict: VerdictUpdate): void;
  query(filter?: TraceQuery): TraceRecord[];
  get(id: string): TraceRecord | undefined;
  close(): void;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function hrTimeToMs(time: readonly [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6;
}

/** Maps a finished OpenTelemetry span into a metadata-only trace record. */
export function spanToTraceRecord(span: ReadableSpan): TraceRecord {
  const attrs = span.attributes;
  const ctx = span.spanContext();
  const isError = span.status.code === SpanStatusCode.ERROR;
  return {
    id: ctx.spanId,
    traceId: ctx.traceId,
    timestamp: Math.round(hrTimeToMs(span.startTime)),
    durationMs: Math.round(hrTimeToMs(span.duration) * 1000) / 1000,
    model: asString(attrs['gen_ai.request.model']),
    provider: asString(attrs['sentinel.provider']),
    stream: attrs['sentinel.stream'] === true,
    status: asNumber(attrs['http.response.status_code']) ?? 0,
    promptTokens: asNumber(attrs['gen_ai.usage.input_tokens']),
    completionTokens: asNumber(attrs['gen_ai.usage.output_tokens']),
    totalTokens: asNumber(attrs['gen_ai.usage.total_tokens']),
    costUsd: asNumber(attrs['sentinel.cost_usd']),
    errorType: asString(attrs['error.type']),
    errorMessage: isError ? (span.status.message ?? null) : null,
    apiKeyHash: asString(attrs['sentinel.api_key_hash']),
    cacheHit: attrs['sentinel.cache_hit'] === true,
    routedProvider: asString(attrs['sentinel.routed_provider']),
    routedModel: asString(attrs['sentinel.routed_model']),
    fallbackUsed: attrs['sentinel.fallback_used'] === true,
    retryCount: asNumber(attrs['sentinel.retry_count']) ?? 0,
    guardrailStatus: asString(attrs['sentinel.guardrail_status']),
    guardrailViolations: asString(attrs['sentinel.guardrail_violations']),
    // Judge fields are filled in later via attachVerdict, not from the span.
    judgeScore: null,
    judgeReason: null,
    judgeError: null,
    promptFingerprint: asString(attrs['sentinel.prompt_fingerprint']),
  };
}

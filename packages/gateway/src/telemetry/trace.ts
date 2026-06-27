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
  errorType: string | null;
  errorMessage: string | null;
  apiKeyHash: string | null;
}

/** Filters for querying traces (all optional). */
export interface TraceQuery {
  model?: string;
  provider?: string;
  status?: number;
  stream?: boolean;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/** A persistence sink for trace records. Implemented by the in-memory and SQLite stores. */
export interface TraceStore {
  record(trace: TraceRecord): void;
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
    errorType: asString(attrs['error.type']),
    errorMessage: isError ? (span.status.message ?? null) : null,
    apiKeyHash: asString(attrs['sentinel.api_key_hash']),
  };
}

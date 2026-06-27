import { describe, it, expect } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { TraceStoreSpanExporter } from './exporter.js';
import { spanToTraceRecord } from './trace.js';
import { InMemoryTraceStore } from './store.memory.js';
import type { TraceStore } from './trace.js';

function fakeSpan(over: Partial<ReadableSpan> = {}): ReadableSpan {
  const base = {
    name: 'chat.completion',
    spanContext: () => ({ traceId: 'trace-abc', spanId: 'span-abc', traceFlags: 1 }),
    startTime: [1, 500_000_000],
    endTime: [1, 505_000_000],
    duration: [0, 5_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {
      'gen_ai.request.model': 'gpt-4o-mini',
      'sentinel.provider': 'openai',
      'sentinel.stream': false,
      'http.response.status_code': 200,
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 22,
      'gen_ai.usage.total_tokens': 33,
      'sentinel.api_key_hash': 'hash1',
    },
  };
  return { ...base, ...over } as unknown as ReadableSpan;
}

describe('spanToTraceRecord', () => {
  it('maps span attributes and timing into a record', () => {
    const rec = spanToTraceRecord(fakeSpan());
    expect(rec.id).toBe('span-abc');
    expect(rec.traceId).toBe('trace-abc');
    expect(rec.timestamp).toBe(1500);
    expect(rec.durationMs).toBe(5);
    expect(rec.model).toBe('gpt-4o-mini');
    expect(rec.provider).toBe('openai');
    expect(rec.stream).toBe(false);
    expect(rec.status).toBe(200);
    expect(rec.promptTokens).toBe(11);
    expect(rec.completionTokens).toBe(22);
    expect(rec.totalTokens).toBe(33);
    expect(rec.apiKeyHash).toBe('hash1');
    expect(rec.errorType).toBeNull();
    expect(rec.errorMessage).toBeNull();
  });

  it('captures error status/message and tolerates missing attributes', () => {
    const rec = spanToTraceRecord(
      fakeSpan({
        status: { code: SpanStatusCode.ERROR, message: 'upstream failed' },
        attributes: { 'error.type': 'UpstreamError' },
      }),
    );
    expect(rec.errorMessage).toBe('upstream failed');
    expect(rec.errorType).toBe('UpstreamError');
    expect(rec.model).toBeNull();
    expect(rec.status).toBe(0);
    expect(rec.promptTokens).toBeNull();
    expect(rec.stream).toBe(false);
  });
});

describe('TraceStoreSpanExporter', () => {
  it('persists spans to the store and reports success', () => {
    const store = new InMemoryTraceStore();
    const exporter = new TraceStoreSpanExporter(store);
    let code: ExportResultCode | undefined;
    exporter.export(
      [
        fakeSpan(),
        fakeSpan({ spanContext: () => ({ traceId: 't2', spanId: 's2', traceFlags: 1 }) }),
      ],
      (result: ExportResult) => {
        code = result.code;
      },
    );
    expect(code).toBe(ExportResultCode.SUCCESS);
    expect(store.query()).toHaveLength(2);
  });

  it('reports failure when the store throws', () => {
    const throwingStore: TraceStore = {
      record() {
        throw new Error('disk full');
      },
      query: () => [],
      get: () => undefined,
      close() {
        // no resources
      },
    };
    const exporter = new TraceStoreSpanExporter(throwingStore);
    let result: ExportResult | undefined;
    exporter.export([fakeSpan()], (r: ExportResult) => {
      result = r;
    });
    expect(result?.code).toBe(ExportResultCode.FAILED);
    expect(result?.error?.message).toBe('disk full');
  });
});

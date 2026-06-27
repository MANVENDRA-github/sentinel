import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { TraceStore } from './trace.js';
import { spanToTraceRecord } from './trace.js';

/** An OpenTelemetry SpanExporter that persists finished spans to a TraceStore. */
export class TraceStoreSpanExporter implements SpanExporter {
  private readonly store: TraceStore;

  constructor(store: TraceStore) {
    this.store = store;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      for (const span of spans) {
        this.store.record(spanToTraceRecord(span));
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { TraceStore } from './trace.js';
import { TraceStoreSpanExporter } from './exporter.js';

export interface TelemetryOptions {
  /** If set, spans are also exported to this OTLP/HTTP endpoint (Jaeger, a collector, ...). */
  otlpEndpoint?: string | undefined;
}

/**
 * Registers the global OpenTelemetry tracer provider: every span is persisted to the
 * trace store, and (optionally) exported to an external OTLP collector. Returns a
 * shutdown function. Bootstrap-only — invoked from main.ts.
 */
export function initTelemetry(
  store: TraceStore,
  options: TelemetryOptions = {},
): () => Promise<void> {
  const processors: SpanProcessor[] = [new SimpleSpanProcessor(new TraceStoreSpanExporter(store))];

  if (options.otlpEndpoint !== undefined && options.otlpEndpoint.length > 0) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: options.otlpEndpoint })));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '@sentinel/gateway' }),
    spanProcessors: processors,
  });
  provider.register();

  return async () => {
    await provider.shutdown();
  };
}

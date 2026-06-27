import 'dotenv/config';
import { loadServerEnv, loadConfig } from './config.js';
import { createRegistry } from './providers/registry.js';
import { buildServer } from './server.js';
import { ConfigError } from './errors.js';
import { createTraceStore } from './telemetry/store.js';
import { initTelemetry } from './telemetry/otel.js';
import { createOllamaEmbedder } from './cache/embedder.js';
import { createSemanticCache } from './cache/cache.js';
import type { SemanticCache } from './cache/cache.js';
import { createBucketRegistry } from './throttle/token-bucket.js';

async function main(): Promise<void> {
  const env = loadServerEnv(process.env);
  const config = loadConfig({ path: env.configPath, env: process.env });
  const registry = createRegistry(config);
  const store = createTraceStore({ kind: env.traceDb, path: env.traceDbPath });
  const shutdownTelemetry = initTelemetry(store, {
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  let cache: SemanticCache | undefined;
  if (env.cacheEnabled) {
    cache = createSemanticCache({
      embedder: createOllamaEmbedder({ baseUrl: env.ollamaBaseUrl, model: env.embedModel }),
      threshold: env.cacheThreshold,
      ttlMs: env.cacheTtlSeconds * 1000,
      maxEntries: env.cacheMaxEntries,
      embedModel: env.embedModel,
    });
  }

  const rpmByProvider: Record<string, number> = {};
  for (const provider of config.providers.values()) {
    if (provider.rpm !== undefined) rpmByProvider[provider.name] = provider.rpm;
  }
  const throttle = createBucketRegistry({ rpmByProvider, defaultRpm: env.defaultRpm });

  const app = buildServer({
    registry,
    apiKeys: env.apiKeys,
    traceStore: store,
    adminKey: env.adminKey,
    cache,
    routing: {
      config: config.routing,
      maxRetries: env.maxRetries,
      timeoutMs: env.requestTimeoutMs,
      maxWaitMs: env.throttleMaxWaitMs,
      throttle,
    },
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await shutdownTelemetry();
    store.close();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError ? error.message : `Failed to start Sentinel: ${String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

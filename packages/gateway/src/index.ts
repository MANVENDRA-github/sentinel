/** Public API surface of the Sentinel gateway. */

export const SENTINEL_VERSION = '0.1.0';

export { buildServer } from './server.js';
export type { ServerDeps, RoutingDeps } from './server.js';
export { loadConfig, loadServerEnv } from './config.js';
export type {
  ResolvedConfig,
  ResolvedProvider,
  ResolvedRouting,
  ServerEnv,
  LoadConfigOptions,
} from './config.js';
export { createRegistry } from './providers/registry.js';
export type { ProviderRegistry } from './providers/registry.js';
export { createRouter } from './routing/router.js';
export type { Router, Candidate, RoutingConfig } from './routing/router.js';
export { runChat, openStream } from './routing/executor.js';
export type { RouteOutcome, ExecutorOptions, StreamHandle } from './routing/executor.js';
export { isRetryable } from './routing/retryable.js';
export { classifyTier } from './routing/classifier.js';
export { createTokenBucket, createBucketRegistry } from './throttle/token-bucket.js';
export type {
  TokenBucket,
  TokenBucketOptions,
  BucketRegistry,
  BucketRegistryOptions,
} from './throttle/token-bucket.js';
export { createOpenAICompatibleProvider } from './providers/openai-compatible.js';
export type { Provider, FetchLike } from './providers/types.js';
export {
  GatewayError,
  ValidationError,
  AuthError,
  ModelNotFoundError,
  UpstreamError,
  ConfigError,
} from './errors.js';
export { createTraceStore } from './telemetry/store.js';
export type { TraceStore, TraceRecord, TraceQuery } from './telemetry/trace.js';
export { createSemanticCache } from './cache/cache.js';
export type { SemanticCache, CachedResponse } from './cache/cache.js';
export { createOllamaEmbedder } from './cache/embedder.js';
export type { Embedder } from './cache/embedder.js';

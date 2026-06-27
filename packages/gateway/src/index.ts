/** Public API surface of the Sentinel gateway. */

export const SENTINEL_VERSION = '0.1.0';

export { buildServer } from './server.js';
export type { ServerDeps } from './server.js';
export { loadConfig, loadServerEnv } from './config.js';
export type { ResolvedConfig, ResolvedProvider, ServerEnv, LoadConfigOptions } from './config.js';
export { createRegistry } from './providers/registry.js';
export type { ProviderRegistry } from './providers/registry.js';
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

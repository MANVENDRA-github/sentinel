import type { TraceStore } from './trace.js';
import { InMemoryTraceStore } from './store.memory.js';
import { SqliteTraceStore } from './store.sqlite.js';

export interface TraceStoreOptions {
  kind: 'sqlite' | 'memory';
  path?: string;
}

/** Builds the configured trace store. Mirrors the provider-registry factory style. */
export function createTraceStore(options: TraceStoreOptions): TraceStore {
  if (options.kind === 'memory') {
    return new InMemoryTraceStore();
  }
  return new SqliteTraceStore(options.path ?? './traces.db');
}

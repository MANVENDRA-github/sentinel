import { describe, it, expect } from 'vitest';
import type { TraceRecord, TraceStore } from './trace.js';
import { InMemoryTraceStore } from './store.memory.js';
import { SqliteTraceStore } from './store.sqlite.js';
import { createTraceStore } from './store.js';

function sample(over: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: 'span-1',
    traceId: 'trace-1',
    timestamp: 1000,
    durationMs: 5,
    model: 'gpt-4o-mini',
    provider: 'openai',
    stream: false,
    status: 200,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    errorType: null,
    errorMessage: null,
    apiKeyHash: 'abc',
    ...over,
  };
}

const backends: [string, () => TraceStore][] = [
  ['InMemoryTraceStore', () => new InMemoryTraceStore()],
  ['SqliteTraceStore', () => new SqliteTraceStore(':memory:')],
];

for (const [name, makeStore] of backends) {
  describe(name, () => {
    it('records and fetches a trace by id', () => {
      const store = makeStore();
      store.record(sample());
      expect(store.get('span-1')?.model).toBe('gpt-4o-mini');
      expect(store.get('missing')).toBeUndefined();
      store.close();
    });

    it('returns traces newest-first', () => {
      const store = makeStore();
      store.record(sample({ id: 'a', timestamp: 100 }));
      store.record(sample({ id: 'b', timestamp: 300 }));
      store.record(sample({ id: 'c', timestamp: 200 }));
      expect(store.query().map((t) => t.id)).toEqual(['b', 'c', 'a']);
      store.close();
    });

    it('filters by model, status, stream, and time window', () => {
      const store = makeStore();
      store.record(sample({ id: 'a', model: 'm1', status: 200, stream: false, timestamp: 100 }));
      store.record(sample({ id: 'b', model: 'm2', status: 500, stream: true, timestamp: 200 }));
      expect(store.query({ model: 'm2' }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ status: 500 }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ stream: true }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ provider: 'openai' }).map((t) => t.id)).toEqual(['b', 'a']);
      expect(store.query({ since: 150 }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ until: 150 }).map((t) => t.id)).toEqual(['a']);
      store.close();
    });

    it('respects limit and offset', () => {
      const store = makeStore();
      for (let i = 0; i < 5; i++) store.record(sample({ id: `s${i}`, timestamp: i }));
      expect(store.query({ limit: 2 }).map((t) => t.id)).toEqual(['s4', 's3']);
      expect(store.query({ limit: 2, offset: 2 }).map((t) => t.id)).toEqual(['s2', 's1']);
      store.close();
    });

    it('round-trips nullable fields and the stream flag', () => {
      const store = makeStore();
      store.record(
        sample({
          id: 'e',
          model: null,
          provider: null,
          stream: true,
          status: 502,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorType: 'UpstreamError',
          errorMessage: 'boom',
          apiKeyHash: null,
        }),
      );
      const got = store.get('e');
      expect(got?.model).toBeNull();
      expect(got?.stream).toBe(true);
      expect(got?.errorType).toBe('UpstreamError');
      expect(got?.promptTokens).toBeNull();
      store.close();
    });
  });
}

describe('createTraceStore', () => {
  it('builds the requested backend', () => {
    const mem = createTraceStore({ kind: 'memory' });
    mem.record(sample());
    expect(mem.query()).toHaveLength(1);
    mem.close();

    const sql = createTraceStore({ kind: 'sqlite', path: ':memory:' });
    sql.record(sample());
    expect(sql.query()).toHaveLength(1);
    sql.close();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
    costUsd: null,
    errorType: null,
    errorMessage: null,
    apiKeyHash: 'abc',
    cacheHit: false,
    routedProvider: 'openai',
    routedModel: 'gpt-4o-mini',
    fallbackUsed: false,
    retryCount: 0,
    guardrailStatus: null,
    guardrailViolations: null,
    judgeScore: null,
    judgeReason: null,
    judgeError: null,
    promptFingerprint: null,
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

    it('filters by routedProvider and fallbackUsed', () => {
      const store = makeStore();
      store.record(sample({ id: 'a', routedProvider: 'p1', fallbackUsed: false }));
      store.record(sample({ id: 'b', routedProvider: 'p2', fallbackUsed: true }));
      expect(store.query({ routedProvider: 'p2' }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ fallbackUsed: true }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ fallbackUsed: false }).map((t) => t.id)).toEqual(['a']);
      store.close();
    });

    it('filters by guardrailStatus, judge score range, and promptFingerprint', () => {
      const store = makeStore();
      store.record(
        sample({ id: 'a', guardrailStatus: 'flag', judgeScore: 2, promptFingerprint: 'fp1' }),
      );
      store.record(
        sample({ id: 'b', guardrailStatus: 'pass', judgeScore: 5, promptFingerprint: 'fp2' }),
      );
      expect(store.query({ guardrailStatus: 'flag' }).map((t) => t.id)).toEqual(['a']);
      expect(store.query({ judgeScoreMax: 3 }).map((t) => t.id)).toEqual(['a']);
      expect(store.query({ judgeScoreMin: 4 }).map((t) => t.id)).toEqual(['b']);
      expect(store.query({ promptFingerprint: 'fp2' }).map((t) => t.id)).toEqual(['b']);
      store.close();
    });

    it('attachVerdict updates judge fields and ignores unknown ids', () => {
      const store = makeStore();
      store.record(sample({ id: 'v', judgeScore: null }));
      store.attachVerdict('v', { judgeScore: 4, judgeReason: 'solid', judgeError: null });
      const got = store.get('v');
      expect(got?.judgeScore).toBe(4);
      expect(got?.judgeReason).toBe('solid');
      expect(got?.judgeError).toBeNull();
      store.attachVerdict('missing', { judgeScore: 1, judgeReason: null, judgeError: 'x' });
      expect(store.query()).toHaveLength(1);
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
          routedProvider: null,
          routedModel: null,
          fallbackUsed: true,
          retryCount: 3,
        }),
      );
      const got = store.get('e');
      expect(got?.model).toBeNull();
      expect(got?.stream).toBe(true);
      expect(got?.errorType).toBe('UpstreamError');
      expect(got?.promptTokens).toBeNull();
      expect(got?.routedProvider).toBeNull();
      expect(got?.fallbackUsed).toBe(true);
      expect(got?.retryCount).toBe(3);
      store.close();
    });

    it('round-trips costUsd (present and null)', () => {
      const store = makeStore();
      store.record(sample({ id: 'cost', costUsd: 0.0123 }));
      store.record(sample({ id: 'free', costUsd: null }));
      expect(store.get('cost')?.costUsd).toBe(0.0123);
      expect(store.get('free')?.costUsd).toBeNull();
      store.close();
    });

    it('filters by apiKeyHash (per-key trace isolation)', () => {
      const store = makeStore();
      store.record(sample({ id: 'k1', apiKeyHash: 'aaa' }));
      store.record(sample({ id: 'k2', apiKeyHash: 'bbb' }));
      expect(store.query({ apiKeyHash: 'aaa' }).map((t) => t.id)).toEqual(['k1']);
      expect(store.query({ apiKeyHash: 'bbb' }).map((t) => t.id)).toEqual(['k2']);
      store.close();
    });
  });
}

describe('SqliteTraceStore migration', () => {
  it('adds the cost_usd column to a DB created before it existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-mig-'));
    const file = join(dir, 'legacy.db');
    // A DB written by a pre-cost build: the full schema minus the cost_usd column.
    const legacy = new Database(file);
    legacy.exec(
      `CREATE TABLE traces (
         id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
         duration_ms REAL NOT NULL, model TEXT, provider TEXT, stream INTEGER NOT NULL,
         status INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
         total_tokens INTEGER, error_type TEXT, error_message TEXT, api_key_hash TEXT,
         cache_hit INTEGER NOT NULL DEFAULT 0, routed_provider TEXT, routed_model TEXT,
         fallback_used INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
         guardrail_status TEXT, guardrail_violations TEXT, judge_score REAL, judge_reason TEXT,
         judge_error TEXT, prompt_fingerprint TEXT
       )`,
    );
    legacy.close();

    const store = new SqliteTraceStore(file);
    store.record(sample({ id: 'm', costUsd: 0.5 }));
    expect(store.get('m')?.costUsd).toBe(0.5);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

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

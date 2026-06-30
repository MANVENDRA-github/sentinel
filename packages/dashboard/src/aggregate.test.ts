import { describe, it, expect } from 'vitest';
import { computeStats, percentile, EMPTY_STATS } from './aggregate';
import type { TraceRecord } from './types';

function trace(over: Partial<TraceRecord>): TraceRecord {
  return {
    id: 'id',
    traceId: 'tid',
    timestamp: 1_000_000,
    durationMs: 100,
    model: 'gpt-4o-mini',
    provider: 'openai',
    stream: false,
    status: 200,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: null,
    errorType: null,
    errorMessage: null,
    apiKeyHash: null,
    cacheHit: false,
    routedProvider: null,
    routedModel: null,
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

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 95)).toBe(0);
  });
  it('computes nearest-rank percentiles', () => {
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });
});

describe('computeStats', () => {
  it('returns the empty stats for no traces', () => {
    expect(computeStats([])).toEqual(EMPTY_STATS);
  });

  it('aggregates rates, tokens, latency and distributions', () => {
    const stats = computeStats([
      trace({ status: 200, cacheHit: true, totalTokens: 100, durationMs: 50 }),
      trace({ status: 500, errorType: 'upstream_error', totalTokens: 0, durationMs: 200 }),
      trace({
        status: 200,
        fallbackUsed: true,
        provider: 'groq',
        totalTokens: 50,
        durationMs: 100,
      }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.errorCount).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(stats.fallbacks).toBe(1);
    expect(stats.totalTokens).toBe(150);
    expect(stats.byProvider.find((c) => c.label === 'openai')?.count).toBe(2);
    expect(stats.byProvider.find((c) => c.label === 'groq')?.count).toBe(1);
    expect(stats.byStatusClass.find((c) => c.label === '5xx')?.count).toBe(1);
  });

  it('builds the judge histogram and average', () => {
    const stats = computeStats([
      trace({ judgeScore: 5 }),
      trace({ judgeScore: 5 }),
      trace({ judgeScore: 3 }),
    ]);
    expect(stats.avgJudgeScore).toBeCloseTo(4.33, 2);
    expect(stats.judgeHistogram.find((b) => b.score === 5)?.count).toBe(2);
    expect(stats.judgeHistogram.find((b) => b.score === 3)?.count).toBe(1);
    expect(stats.judgeScoredCount).toBe(3);
  });

  it('buckets requests over time', () => {
    const stats = computeStats(
      [trace({ timestamp: 0 }), trace({ timestamp: 30_000 }), trace({ timestamp: 90_000 })],
      60_000,
    );
    expect(stats.overTime).toHaveLength(2);
    expect(stats.overTime[0]?.count).toBe(2);
    expect(stats.overTime[1]?.count).toBe(1);
  });

  it('sums cost spent vs saved by cache (null cost ignored)', () => {
    const stats = computeStats([
      trace({ costUsd: 0.01, cacheHit: false }),
      trace({ costUsd: 0.02, cacheHit: false }),
      trace({ costUsd: 0.05, cacheHit: true }),
      trace({ costUsd: null, cacheHit: false }),
    ]);
    expect(stats.totalCostUsd).toBe(0.03);
    expect(stats.savedCostUsd).toBe(0.05);
  });

  it('buckets cost over time, excluding cache hits', () => {
    const stats = computeStats(
      [
        trace({ timestamp: 0, costUsd: 0.01, cacheHit: false }),
        trace({ timestamp: 30_000, costUsd: 0.02, cacheHit: false }),
        trace({ timestamp: 30_000, costUsd: 0.04, cacheHit: true }),
      ],
      60_000,
    );
    expect(stats.overTime[0]?.costUsd).toBeCloseTo(0.03, 6);
  });
});

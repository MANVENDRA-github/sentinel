import { describe, it, expect } from 'vitest';
import { aggregateRegression } from './regression.js';
import type { TraceRecord } from '../telemetry/trace.js';

function record(over: Partial<TraceRecord>): TraceRecord {
  return {
    id: 'x',
    traceId: 't',
    timestamp: 1,
    durationMs: 1,
    model: null,
    provider: null,
    stream: false,
    status: 200,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
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

describe('aggregateRegression', () => {
  it('groups by fingerprint + model and summarizes scores', () => {
    const groups = aggregateRegression([
      record({ id: '1', promptFingerprint: 'fp', model: 'a', judgeScore: 4 }),
      record({ id: '2', promptFingerprint: 'fp', model: 'a', judgeScore: 2 }),
      record({ id: '3', promptFingerprint: 'fp', model: 'b', judgeScore: 5 }),
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.model === 'a');
    expect(a).toMatchObject({ count: 2, meanScore: 3, minScore: 2, maxScore: 4 });
  });

  it('ignores records without a judge score or fingerprint', () => {
    expect(
      aggregateRegression([record({ id: '1', judgeScore: null, promptFingerprint: 'fp' })]),
    ).toHaveLength(0);
    expect(
      aggregateRegression([record({ id: '2', judgeScore: 3, promptFingerprint: null })]),
    ).toHaveLength(0);
  });
});

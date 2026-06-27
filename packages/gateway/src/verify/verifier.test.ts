import { describe, it, expect, vi } from 'vitest';
import { createVerifier } from './verifier.js';
import type { Judge } from './judge.js';
import { InMemoryTraceStore } from '../telemetry/store.memory.js';
import type { TraceRecord } from '../telemetry/trace.js';
import type { ChatCompletionRequest } from '../schemas.js';

const request: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

function record(id: string): TraceRecord {
  return {
    id,
    traceId: 't',
    timestamp: 1,
    durationMs: 1,
    model: 'm',
    provider: 'p',
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
  };
}

function seeded(id: string): InMemoryTraceStore {
  const store = new InMemoryTraceStore();
  store.record(record(id));
  return store;
}

describe('createVerifier', () => {
  it('passes through inspect when guardrails are unconfigured', () => {
    const verifier = createVerifier({ store: new InMemoryTraceStore() });
    expect(verifier.inspect(request, 'mail a@b.com').status).toBe('pass');
  });

  it('runs guardrails when configured', () => {
    const verifier = createVerifier({
      store: new InMemoryTraceStore(),
      guardrails: { block: false },
    });
    expect(verifier.inspect(request, 'a@b.com').violations).toContain('pii.email');
  });

  it('does not call the judge when not sampled', async () => {
    const judge: Judge = { score: vi.fn(() => Promise.resolve({ score: 5, reason: 'g' })) };
    const verifier = createVerifier({
      store: new InMemoryTraceStore(),
      judge,
      shouldSample: () => false,
    });
    verifier.scheduleJudge('id', request, 'x');
    await verifier.drain();
    expect(judge.score).not.toHaveBeenCalled();
  });

  it('judges and attaches a verdict when sampled', async () => {
    const store = seeded('id');
    const judge: Judge = { score: () => Promise.resolve({ score: 4, reason: 'solid' }) };
    const verifier = createVerifier({ store, judge, shouldSample: () => true });
    verifier.scheduleJudge('id', request, 'x');
    await verifier.drain();
    expect(store.get('id')?.judgeScore).toBe(4);
    expect(store.get('id')?.judgeReason).toBe('solid');
  });

  it('records "unscored" (null score + error) on a judge failure', async () => {
    const store = seeded('id');
    const judge: Judge = { score: () => Promise.reject(new Error('ollama down')) };
    const verifier = createVerifier({ store, judge, shouldSample: () => true });
    verifier.scheduleJudge('id', request, 'x');
    await verifier.drain();
    expect(store.get('id')?.judgeScore).toBeNull();
    expect(store.get('id')?.judgeError).toBe('ollama down');
  });

  it('uses the default sampler (rate 1 = always, rate 0 = never)', async () => {
    const counter = { calls: 0 };
    const judge: Judge = {
      score: () => {
        counter.calls += 1;
        return Promise.resolve({ score: 5, reason: '' });
      },
    };
    const always = createVerifier({ store: seeded('id'), judge, sampleRate: 1 });
    always.scheduleJudge('id', request, 'x');
    await always.drain();
    const never = createVerifier({ store: new InMemoryTraceStore(), judge, sampleRate: 0 });
    never.scheduleJudge('id', request, 'x');
    await never.drain();
    expect(counter.calls).toBe(1);
  });

  it('truncates a long judge reason', async () => {
    const store = seeded('id');
    const judge: Judge = { score: () => Promise.resolve({ score: 3, reason: 'x'.repeat(500) }) };
    const verifier = createVerifier({
      store,
      judge,
      shouldSample: () => true,
      reasonMaxLength: 10,
    });
    verifier.scheduleJudge('id', request, 'x');
    await verifier.drain();
    expect(store.get('id')?.judgeReason?.length).toBe(10);
  });

  it('produces a stable, model-independent fingerprint', () => {
    const verifier = createVerifier({ store: new InMemoryTraceStore() });
    const a = verifier.fingerprint({ model: 'm1', messages: request.messages });
    const b = verifier.fingerprint({ model: 'm2', messages: request.messages });
    expect(a).toBe(b);
  });
});

import { describe, it, expect } from 'vitest';
import { runChat, openStream } from './executor.js';
import type { ExecutorOptions } from './executor.js';
import type { Candidate } from './router.js';
import type { Provider } from '../providers/types.js';
import type { ChatCompletionRequest } from '../schemas.js';
import { UpstreamError } from '../errors.js';

const baseOpts: ExecutorOptions = {
  maxRetries: 0,
  timeoutMs: 0,
  baseBackoffMs: 1,
  maxWaitMs: 0,
  sleep: () => Promise.resolve(),
};

const req: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

function provider(name: string, over: Partial<Provider> = {}): Provider {
  return {
    name,
    chat: () => Promise.resolve({ ok: name }),
    chatStream: async function* () {
      yield `{"p":"${name}"}`;
    },
    ...over,
  };
}

const cand = (p: Provider, model = 'm'): Candidate => ({ provider: p, model });

describe('runChat', () => {
  it('returns the first candidate result on success', async () => {
    const { result, outcome } = await runChat([cand(provider('a'))], req, baseOpts);
    expect(result).toEqual({ ok: 'a' });
    expect(outcome).toMatchObject({
      routedProvider: 'a',
      routedModel: 'm',
      fallbackUsed: false,
      retryCount: 0,
    });
  });

  it('rewrites the request model to the chosen candidate', async () => {
    const seen: string[] = [];
    const p = provider('a', {
      chat: (request) => {
        seen.push(request.model);
        return Promise.resolve({ ok: 'a' });
      },
    });
    await runChat([cand(p, 'gpt-tier')], req, baseOpts);
    expect(seen).toEqual(['gpt-tier']);
  });

  it('retries a retryable error then succeeds on the same candidate', async () => {
    let calls = 0;
    const p = provider('a', {
      chat: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new UpstreamError('a', 429, 'rl'))
          : Promise.resolve({ ok: 'a', calls });
      },
    });
    const { result, outcome } = await runChat([cand(p)], req, { ...baseOpts, maxRetries: 1 });
    expect(result).toEqual({ ok: 'a', calls: 2 });
    expect(outcome.retryCount).toBe(1);
    expect(outcome.fallbackUsed).toBe(false);
  });

  it('fails over to the next candidate after retryable exhaustion', async () => {
    const p1 = provider('a', { chat: () => Promise.reject(new UpstreamError('a', 502, 'boom')) });
    const { result, outcome } = await runChat([cand(p1), cand(provider('b'))], req, {
      ...baseOpts,
      maxRetries: 1,
    });
    expect(result).toEqual({ ok: 'b' });
    expect(outcome.routedProvider).toBe('b');
    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.retryCount).toBe(1);
  });

  it('throws a terminal error immediately without falling back', async () => {
    let p2calls = 0;
    const p1 = provider('a', { chat: () => Promise.reject(new UpstreamError('a', 400, 'bad')) });
    const p2 = provider('b', {
      chat: () => {
        p2calls += 1;
        return Promise.resolve({});
      },
    });
    await expect(
      runChat([cand(p1), cand(p2)], req, { ...baseOpts, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(p2calls).toBe(0);
  });

  it('throws the last error when every candidate fails', async () => {
    const p1 = provider('a', { chat: () => Promise.reject(new UpstreamError('a', 502, 'a-down')) });
    const p2 = provider('b', { chat: () => Promise.reject(new UpstreamError('b', 429, 'b-rl')) });
    await expect(runChat([cand(p1), cand(p2)], req, baseOpts)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('throws 503 when there are no candidates', async () => {
    await expect(runChat([], req, baseOpts)).rejects.toMatchObject({ status: 503 });
  });

  it('throws 503 when every candidate is throttled', async () => {
    const throttle = { acquire: () => Promise.resolve(false) };
    await expect(
      runChat([cand(provider('a')), cand(provider('b'))], req, { ...baseOpts, throttle }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('skips a throttled candidate and uses the next one', async () => {
    const throttle = { acquire: (name: string) => Promise.resolve(name === 'b') };
    const { outcome } = await runChat([cand(provider('a')), cand(provider('b'))], req, {
      ...baseOpts,
      throttle,
    });
    expect(outcome.routedProvider).toBe('b');
    expect(outcome.fallbackUsed).toBe(true);
  });

  it('times out a slow attempt and fails over', async () => {
    const slow = provider('a', {
      chat: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    });
    const { outcome } = await runChat([cand(slow), cand(provider('b'))], req, {
      ...baseOpts,
      timeoutMs: 5,
    });
    expect(outcome.routedProvider).toBe('b');
  });
});

describe('openStream', () => {
  it('opens a stream from the first healthy candidate', async () => {
    const { first, outcome } = await openStream([cand(provider('a'))], req, baseOpts);
    expect(first.value).toBe('{"p":"a"}');
    expect(outcome.routedProvider).toBe('a');
  });

  it('fails over when the first stream errors on its first chunk', async () => {
    const p1 = provider('a', {
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw new UpstreamError('a', 503, 'down');
      },
    });
    const { first, outcome } = await openStream([cand(p1), cand(provider('b'))], req, baseOpts);
    expect(first.value).toBe('{"p":"b"}');
    expect(outcome.fallbackUsed).toBe(true);
  });
});

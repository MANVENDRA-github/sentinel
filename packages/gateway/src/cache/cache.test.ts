import { describe, it, expect } from 'vitest';
import { createSemanticCache } from './cache.js';
import type { Embedder } from './embedder.js';
import type { ChatCompletionRequest } from '../schemas.js';

function req(content: string, over: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'm', messages: [{ role: 'user', content }], ...over };
}

function embedderFrom(fn: (text: string) => number[]): Embedder {
  return { embed: (text) => Promise.resolve(fn(text)) };
}

const base = { threshold: 0.9, ttlMs: 1000, maxEntries: 10, embedModel: 'e' };

describe('createSemanticCache', () => {
  it('hits a semantically similar request and misses a dissimilar one', async () => {
    const vec = (t: string): number[] =>
      t.includes('bye') ? [0, 1] : t.includes('there') ? [0.99, 0.14] : [1, 0];
    const cache = createSemanticCache({ embedder: embedderFrom(vec), ...base });
    await cache.set(req('hi'), 'key1', { kind: 'json', body: { answer: 1 } });
    expect(await cache.get(req('hi there'), 'key1')).toEqual({ kind: 'json', body: { answer: 1 } });
    expect(await cache.get(req('bye'), 'key1')).toBeUndefined();
  });

  it('does not hit across tenants', async () => {
    const cache = createSemanticCache({ embedder: embedderFrom(() => [1, 0]), ...base });
    await cache.set(req('hi'), 'key1', { kind: 'json', body: 1 });
    expect(await cache.get(req('hi'), 'key2')).toBeUndefined();
  });

  it('does not hit across models', async () => {
    const cache = createSemanticCache({ embedder: embedderFrom(() => [1, 0]), ...base });
    await cache.set(req('hi', { model: 'a' }), 'key1', { kind: 'json', body: 1 });
    expect(await cache.get(req('hi', { model: 'b' }), 'key1')).toBeUndefined();
  });

  it('keeps stream and non-stream entries in separate buckets', async () => {
    const cache = createSemanticCache({ embedder: embedderFrom(() => [1, 0]), ...base });
    await cache.set(req('hi', { stream: true }), 'key1', { kind: 'stream', chunks: ['a'] });
    expect(await cache.get(req('hi'), 'key1')).toBeUndefined();
    expect(await cache.get(req('hi', { stream: true }), 'key1')).toEqual({
      kind: 'stream',
      chunks: ['a'],
    });
  });

  it('expires entries past their TTL', async () => {
    let t = 1000;
    const cache = createSemanticCache({
      embedder: embedderFrom(() => [1, 0]),
      threshold: 0.9,
      ttlMs: 100,
      maxEntries: 10,
      embedModel: 'e',
      now: () => t,
    });
    await cache.set(req('hi'), 'key1', { kind: 'json', body: 1 });
    t = 1050;
    expect(await cache.get(req('hi'), 'key1')).toEqual({ kind: 'json', body: 1 });
    t = 1200;
    expect(await cache.get(req('hi'), 'key1')).toBeUndefined();
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    const vecByContent: Record<string, number[]> = { q1: [1, 0, 0], q2: [0, 1, 0], q3: [0, 0, 1] };
    const embed = embedderFrom((text) => {
      const c = text.includes('q1') ? 'q1' : text.includes('q2') ? 'q2' : 'q3';
      return vecByContent[c]!;
    });
    const cache = createSemanticCache({
      embedder: embed,
      threshold: 0.99,
      ttlMs: 10000,
      maxEntries: 2,
      embedModel: 'e',
    });
    await cache.set(req('q1'), 'k', { kind: 'json', body: 1 });
    await cache.set(req('q2'), 'k', { kind: 'json', body: 2 });
    await cache.set(req('q3'), 'k', { kind: 'json', body: 3 });
    expect(await cache.get(req('q1'), 'k')).toBeUndefined();
    expect(await cache.get(req('q3'), 'k')).toEqual({ kind: 'json', body: 3 });
  });

  it('fails open when the embedder throws', async () => {
    const cache = createSemanticCache({
      embedder: { embed: () => Promise.reject(new Error('down')) },
      ...base,
    });
    await expect(cache.set(req('hi'), 'k', { kind: 'json', body: 1 })).resolves.toBeUndefined();
    expect(await cache.get(req('hi'), 'k')).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { createTokenBucket, createBucketRegistry } from './token-bucket.js';

describe('createTokenBucket', () => {
  it('allows everything when rpm is 0 (limiting disabled)', async () => {
    const bucket = createTokenBucket({ rpm: 0 });
    expect(await bucket.acquire(0)).toBe(true);
    expect(await bucket.acquire(0)).toBe(true);
  });

  it('grants up to the burst capacity then refuses with no wait budget', async () => {
    const t = 0;
    const bucket = createTokenBucket({ rpm: 60, now: () => t, sleep: () => Promise.resolve() });
    for (let i = 0; i < 60; i += 1) expect(await bucket.acquire(0)).toBe(true);
    expect(await bucket.acquire(0)).toBe(false);
  });

  it('refills over time', async () => {
    let t = 0;
    const bucket = createTokenBucket({ rpm: 60, now: () => t, sleep: () => Promise.resolve() });
    for (let i = 0; i < 60; i += 1) await bucket.acquire(0);
    expect(await bucket.acquire(0)).toBe(false);
    t += 1000; // one second → one token at 60 rpm
    expect(await bucket.acquire(0)).toBe(true);
  });

  it('waits for a refill when it fits the wait budget', async () => {
    let t = 0;
    const slept: number[] = [];
    const bucket = createTokenBucket({
      rpm: 60,
      now: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    for (let i = 0; i < 60; i += 1) await bucket.acquire(0);
    expect(await bucket.acquire(2000)).toBe(true);
    expect(slept[0]).toBeGreaterThan(0);
  });
});

describe('createBucketRegistry', () => {
  it('applies per-provider rpm and a default', async () => {
    const t = 0;
    const reg = createBucketRegistry({
      rpmByProvider: { tight: 60 },
      defaultRpm: 0,
      now: () => t,
      sleep: () => Promise.resolve(),
    });
    for (let i = 0; i < 60; i += 1) expect(await reg.acquire('tight', 0)).toBe(true);
    expect(await reg.acquire('tight', 0)).toBe(false); // capped
    expect(await reg.acquire('loose', 0)).toBe(true); // default 0 = unlimited
    expect(await reg.acquire('loose', 0)).toBe(true);
  });

  it('reuses one bucket per provider', async () => {
    const t = 0;
    const reg = createBucketRegistry({
      defaultRpm: 60,
      now: () => t,
      sleep: () => Promise.resolve(),
    });
    for (let i = 0; i < 60; i += 1) await reg.acquire('p', 0);
    expect(await reg.acquire('p', 0)).toBe(false);
  });
});

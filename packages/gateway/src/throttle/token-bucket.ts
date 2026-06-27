/**
 * In-memory token-bucket rate limiter (requests per minute) with continuous refill.
 * Clock and sleep are injectable so it can be unit-tested without real time, and so
 * it can be swapped for a Redis-backed implementation later.
 */
export interface TokenBucket {
  /**
   * Consumes one token. If none is available, waits up to `maxWaitMs` for a refill;
   * returns `false` (without waiting) when the required wait would exceed `maxWaitMs`.
   */
  acquire(maxWaitMs: number): Promise<boolean>;
}

export interface TokenBucketOptions {
  /** Sustained requests per minute (also the burst capacity). `0` or less disables limiting. */
  rpm: number;
  /** Injectable clock (defaults to `Date.now`). */
  now?: () => number;
  /** Injectable sleep (defaults to a `setTimeout` promise). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const capacity = options.rpm;
  const ratePerMs = options.rpm / 60_000;

  let tokens = capacity;
  let last = now();

  function refill(): void {
    const current = now();
    tokens = Math.min(capacity, tokens + (current - last) * ratePerMs);
    last = current;
  }

  return {
    async acquire(maxWaitMs: number): Promise<boolean> {
      if (capacity <= 0) return true; // limiting disabled
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      const waitMs = Math.ceil((1 - tokens) / ratePerMs);
      if (waitMs > maxWaitMs) return false;
      await sleep(waitMs);
      refill();
      tokens = Math.max(0, tokens - 1); // waiting earns the grant even if the clock lags
      return true;
    },
  };
}

/** Resolves a per-provider token bucket, created lazily from configured RPM. */
export interface BucketRegistry {
  acquire(provider: string, maxWaitMs: number): Promise<boolean>;
}

export interface BucketRegistryOptions {
  /** Per-provider requests-per-minute overrides. */
  rpmByProvider?: Record<string, number>;
  /** Fallback RPM for providers without an override (`0` = unlimited). */
  defaultRpm?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createBucketRegistry(options: BucketRegistryOptions = {}): BucketRegistry {
  const buckets = new Map<string, TokenBucket>();

  function bucketFor(provider: string): TokenBucket {
    let bucket = buckets.get(provider);
    if (bucket === undefined) {
      const rpm = options.rpmByProvider?.[provider] ?? options.defaultRpm ?? 0;
      bucket = createTokenBucket({
        rpm,
        ...(options.now ? { now: options.now } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
      buckets.set(provider, bucket);
    }
    return bucket;
  }

  return {
    acquire(provider, maxWaitMs) {
      return bucketFor(provider).acquire(maxWaitMs);
    },
  };
}

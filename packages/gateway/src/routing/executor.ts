import type { ChatCompletionRequest } from '../schemas.js';
import { GatewayError } from '../errors.js';
import { isRetryable } from './retryable.js';
import type { Candidate } from './router.js';
import type { BucketRegistry } from '../throttle/token-bucket.js';

/** What actually happened while running the candidate chain — recorded on the trace. */
export interface RouteOutcome {
  routedProvider: string;
  routedModel: string;
  /** A non-primary candidate served the request. */
  fallbackUsed: boolean;
  /** Total retries spent across the chain before success. */
  retryCount: number;
}

export interface ExecutorOptions {
  /** Retries per candidate after the first attempt (`0` = single attempt). */
  maxRetries: number;
  /** Per-attempt timeout in ms (`0` disables). */
  timeoutMs: number;
  /** Base retry backoff in ms; doubles each retry. */
  baseBackoffMs: number;
  /** Max time the throttle may pace one candidate before it is skipped. */
  maxWaitMs: number;
  /** Per-provider rate-limit buckets (omit to disable throttling). */
  throttle?: BucketRegistry;
  /** Injectable sleep (defaults to a `setTimeout` promise). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Attempt<T> = (candidate: Candidate, signal: AbortSignal | undefined) => Promise<T>;

async function withTimeout<T>(
  candidate: Candidate,
  attempt: Attempt<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return attempt(candidate, undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await attempt(candidate, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs an attempt across the candidate chain: throttle → retry-with-backoff per
 * candidate on retryable errors → fail over to the next candidate. Terminal errors
 * throw immediately. Throws a 503 if every candidate is throttled.
 */
async function execute<T>(
  candidates: Candidate[],
  options: ExecutorOptions,
  attempt: Attempt<T>,
): Promise<{ value: T; outcome: RouteOutcome }> {
  const sleep = options.sleep ?? defaultSleep;
  let retryCount = 0;
  let lastError: unknown;
  let anyThrottled = false;
  let index = 0;

  for (const candidate of candidates) {
    const isFallback = index > 0;
    index += 1;

    if (options.throttle !== undefined) {
      const allowed = await options.throttle.acquire(candidate.provider.name, options.maxWaitMs);
      if (!allowed) {
        anyThrottled = true;
        continue;
      }
    }

    for (let tryNum = 0; tryNum <= options.maxRetries; tryNum += 1) {
      try {
        const value = await withTimeout(candidate, attempt, options.timeoutMs);
        return {
          value,
          outcome: {
            routedProvider: candidate.provider.name,
            routedModel: candidate.model,
            fallbackUsed: isFallback,
            retryCount,
          },
        };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error; // terminal: no retry, no fallback
        if (tryNum < options.maxRetries) {
          retryCount += 1;
          await sleep(options.baseBackoffMs * 2 ** tryNum);
        }
      }
    }
  }

  if (lastError !== undefined) throw lastError;
  if (anyThrottled) {
    throw new GatewayError(
      503,
      'All candidate providers are rate-limited; retry shortly.',
      'rate_limited',
      'rate_limited',
    );
  }
  throw new GatewayError(503, 'No provider candidates were available.', 'no_candidates', null);
}

/** Runs a non-streaming completion across the candidate chain. */
export async function runChat(
  candidates: Candidate[],
  request: ChatCompletionRequest,
  options: ExecutorOptions,
): Promise<{ result: unknown; outcome: RouteOutcome }> {
  const { value, outcome } = await execute(candidates, options, (candidate, signal) =>
    candidate.provider.chat({ ...request, model: candidate.model }, signal),
  );
  return { result: value, outcome };
}

/** A live stream plus its already-pulled first chunk, after routing/fallback. */
export interface StreamHandle {
  iterator: AsyncIterator<string>;
  first: IteratorResult<string>;
  outcome: RouteOutcome;
}

/**
 * Opens a streaming completion across the candidate chain, pulling the first chunk
 * so an immediate upstream failure can still fail over. Fallback is bounded to this
 * point — once the first chunk is in hand, the caller owns the live stream.
 */
export async function openStream(
  candidates: Candidate[],
  request: ChatCompletionRequest,
  options: ExecutorOptions,
): Promise<StreamHandle> {
  const { value, outcome } = await execute(candidates, options, async (candidate, signal) => {
    const stream = candidate.provider.chatStream({ ...request, model: candidate.model }, signal);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    return { iterator, first };
  });
  return { iterator: value.iterator, first: value.first, outcome };
}

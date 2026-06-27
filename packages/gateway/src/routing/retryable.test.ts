import { describe, it, expect } from 'vitest';
import { isRetryable } from './retryable.js';
import { UpstreamError, ValidationError, AuthError, ModelNotFoundError } from '../errors.js';

describe('isRetryable', () => {
  it('treats rate limits and upstream 5xx as retryable', () => {
    expect(isRetryable(new UpstreamError('p', 429, 'rate limited'))).toBe(true);
    expect(isRetryable(new UpstreamError('p', 500, 'boom'))).toBe(true); // collapses to 502
    expect(isRetryable(new UpstreamError('p', 503, 'down'))).toBe(true); // collapses to 502
  });

  it('treats upstream 4xx as terminal', () => {
    expect(isRetryable(new UpstreamError('p', 400, 'bad'))).toBe(false);
    expect(isRetryable(new UpstreamError('p', 401, 'no key'))).toBe(false);
    expect(isRetryable(new UpstreamError('p', 404, 'gone'))).toBe(false);
  });

  it('treats other gateway errors as terminal', () => {
    expect(isRetryable(new ValidationError('x'))).toBe(false);
    expect(isRetryable(new AuthError())).toBe(false);
    expect(isRetryable(new ModelNotFoundError('m'))).toBe(false);
  });

  it('treats aborts, timeouts, and network faults as retryable', () => {
    expect(isRetryable(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('boom'), { name: 'FetchError' }))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats unrelated errors and non-errors as terminal', () => {
    expect(isRetryable(new TypeError('bad argument'))).toBe(false);
    expect(isRetryable(new Error('whatever'))).toBe(false);
    expect(isRetryable('nope')).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

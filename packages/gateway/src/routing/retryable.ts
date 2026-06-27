import { GatewayError, UpstreamError } from '../errors.js';

/**
 * Whether a failed provider attempt is worth retrying or failing over to another
 * candidate. Transient conditions (rate limits, upstream 5xx, timeouts, network
 * faults) are retryable; client-side errors (validation, auth, model-not-found,
 * upstream 4xx) are terminal — they would fail on every candidate.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof UpstreamError) {
    return (
      error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504
    );
  }
  if (error instanceof GatewayError) return false;
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    if (error.name === 'FetchError') return true;
    if (error.name === 'TypeError' && /fetch|network/i.test(error.message)) return true;
  }
  return false;
}

/**
 * Sentinel gateway package entry point.
 *
 * Phase 0 placeholder: this exists so the workspace, type-checker, linter, and
 * test runner have real code to operate on. The OpenAI-compatible proxy is
 * built here starting in ROADMAP Phase 1.
 */

export const SENTINEL_VERSION = '0.0.0';

/** Human-readable identifier for the gateway build. */
export function banner(): string {
  return `sentinel-gateway v${SENTINEL_VERSION}`;
}

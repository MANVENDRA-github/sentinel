import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Writes the README's dashboard screenshot. Runs as part of the E2E suite (so it
// stays current) but exists primarily to regenerate docs/dashboard.png on demand:
//   pnpm --filter @sentinel/dashboard exec playwright test screenshot
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/dashboard.png');

test.use({ viewport: { width: 1440, height: 1100 } });

// Deterministic PRNG so the screenshot is stable run-to-run.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length) % xs.length] as T;
}

function trace(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'x',
    traceId: 't',
    timestamp: 1_700_000_000_000,
    durationMs: 120,
    model: 'gpt-4o-mini',
    provider: 'openai',
    stream: false,
    status: 200,
    promptTokens: 40,
    completionTokens: 20,
    totalTokens: 60,
    costUsd: null,
    errorType: null,
    errorMessage: null,
    apiKeyHash: null,
    cacheHit: false,
    routedProvider: null,
    routedModel: null,
    fallbackUsed: false,
    retryCount: 0,
    guardrailStatus: 'pass',
    guardrailViolations: null,
    judgeScore: null,
    judgeReason: null,
    judgeError: null,
    promptFingerprint: null,
    ...over,
  };
}

const routes = [
  ['openai', 'gpt-4o-mini'],
  ['openai', 'gpt-4o'],
  ['groq', 'llama-3.3-70b-versatile'],
  ['ollama', 'llama3.2'],
  ['mistral', 'mistral-small'],
] as const;

function buildTraces(): Record<string, unknown>[] {
  const r = rng(42);
  const base = 1_700_000_000_000;
  // Per-minute request counts (rise → peak → dip → second peak), summing to 72. The
  // dashboard buckets by the minute, so this is what gives the sparkline a real curve
  // instead of a flat line of equal-height buckets.
  const perMinute = [1, 2, 3, 4, 5, 4, 3, 2, 2, 3, 5, 6, 5, 4, 3, 2, 1, 2, 4, 4, 3, 2, 1, 1];
  const out: Record<string, unknown>[] = [];
  let i = 0;
  for (let b = 0; b < perMinute.length; b++) {
    const n = perMinute[b] ?? 0;
    for (let j = 0; j < n; j++) {
      const [provider, model] = pick(r, routes);
      const sr = r();
      const status = sr < 0.06 ? 500 : sr < 0.1 ? 429 : sr < 0.12 ? 503 : 200;
      const ok = status === 200;
      const cacheHit = ok && r() < 0.3;
      const fallbackUsed = ok && !cacheHit && r() < 0.16;
      const scored = ok && !cacheHit && r() < 0.65;
      const gr = r();
      const guardrailStatus = !ok ? 'pass' : gr < 0.07 ? 'block' : gr < 0.2 ? 'flag' : 'pass';
      const prompt = 20 + Math.floor(r() * 380);
      const completion = ok ? 10 + Math.floor(r() * 280) : 0;
      out.push(
        trace({
          id: `r${String(i)}`,
          traceId: `tr${String(i)}`,
          timestamp: base + b * 60_000 + j * 6_000, // same minute-bucket, staggered within it
          durationMs: 60 + Math.floor(r() * 840),
          provider,
          model,
          status,
          errorType: ok ? null : status === 429 ? 'rate_limit_error' : 'upstream_error',
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          costUsd: Math.round((prompt * 0.00002 + completion * 0.00006) * 1e6) / 1e6,
          cacheHit,
          fallbackUsed,
          routedProvider: fallbackUsed ? 'ollama' : null,
          routedModel: fallbackUsed ? 'llama3.2' : null,
          retryCount: fallbackUsed ? 1 : 0,
          guardrailStatus,
          guardrailViolations: guardrailStatus === 'pass' ? null : 'pii.email',
          judgeScore: scored ? pick(r, [3, 4, 4, 5, 5, 5, 2]) : null,
          promptFingerprint: pick(r, ['fp-summarize', 'fp-extract', 'fp-classify']),
        }),
      );
      i++;
    }
  }
  return out;
}

const regression = [
  { promptFingerprint: 'fp-summarize', model: 'gpt-4o-mini', count: 14, meanScore: 4.6, minScore: 4, maxScore: 5 },
  { promptFingerprint: 'fp-summarize', model: 'llama3.2', count: 11, meanScore: 2.7, minScore: 1, maxScore: 4 },
  { promptFingerprint: 'fp-extract', model: 'gpt-4o', count: 9, meanScore: 4.8, minScore: 4, maxScore: 5 },
  { promptFingerprint: 'fp-extract', model: 'llama-3.3-70b-versatile', count: 8, meanScore: 3.9, minScore: 3, maxScore: 5 },
  { promptFingerprint: 'fp-classify', model: 'mistral-small', count: 7, meanScore: 4.1, minScore: 3, maxScore: 5 },
  { promptFingerprint: 'fp-classify', model: 'llama3.2', count: 6, meanScore: 3.2, minScore: 2, maxScore: 4 },
];

test('capture dashboard screenshot', async ({ page }) => {
  await page.route('**/traces*', (route) => route.fulfill({ json: buildTraces() }));
  await page.route('**/regression*', (route) => route.fulfill({ json: regression }));
  await page.addInitScript(() => {
    window.localStorage.setItem('sentinel.adminKey', 'demo-admin-key');
    window.localStorage.setItem('sentinel.baseUrl', '');
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sentinel' })).toBeVisible();
  await expect(page.getByTestId('stat-total')).toContainText('72');
  await expect(page.getByRole('heading', { name: 'Requests over time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Judge scores' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent requests' })).toBeVisible();
  await page.waitForTimeout(500); // let the bar/spark layouts settle

  await page.screenshot({ path: OUT, fullPage: true });
});

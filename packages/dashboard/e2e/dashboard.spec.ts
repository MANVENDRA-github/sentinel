import { test, expect } from '@playwright/test';

function sampleTrace(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'x',
    traceId: 't',
    timestamp: 1_700_000_000_000,
    durationMs: 120,
    model: 'gpt-4o-mini',
    provider: 'openai',
    stream: false,
    status: 200,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
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
    ...over,
  };
}

const traces = [
  sampleTrace({ id: 'a', status: 200, cacheHit: true, judgeScore: 5 }),
  sampleTrace({ id: 'b', status: 500, errorType: 'upstream_error' }),
  sampleTrace({ id: 'c', status: 200, provider: 'groq', fallbackUsed: true, judgeScore: 3 }),
];

test('renders aggregated stats from the trace API', async ({ page }) => {
  await page.route('**/traces*', (route) => route.fulfill({ json: traces }));
  await page.route('**/regression*', (route) => route.fulfill({ json: [] }));
  await page.addInitScript(() => {
    window.localStorage.setItem('sentinel.adminKey', 'test-admin');
    window.localStorage.setItem('sentinel.baseUrl', '');
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sentinel' })).toBeVisible();
  await expect(page.getByTestId('stat-total')).toContainText('3');
  await expect(page.getByTestId('stat-cache')).toContainText('33');
  // 'groq' appears in both the provider bar (with a title) and the table; assert the bar.
  await expect(page.getByTitle('groq')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent requests' })).toBeVisible();
  await expect(page.getByTestId('stat-judge')).toContainText('4'); // mean of [5,3]
});

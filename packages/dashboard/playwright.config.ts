import { defineConfig } from '@playwright/test';

// Hermetic E2E: builds the dashboard, serves the static preview, and the spec
// stubs the gateway's admin API with seeded traces (no real gateway needed).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

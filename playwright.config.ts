import { defineConfig, devices } from '@playwright/test';
import { e2eEnv, E2E_PORT } from './tests/e2e/env';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // next dev compiles each route on first visit, which can take well over 30 seconds on a cold CI runner.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${E2E_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next dev -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: e2eEnv,
  },
});

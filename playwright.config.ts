import { defineConfig, devices } from '@playwright/test';
import { e2eEnv, E2E_APP_PORT, E2E_PORT } from './tests/e2e/env';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The Vite dev server compiles each module on first visit, which can be slow on a cold CI runner.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  // The specs drive the web-ui app; it reaches the backend through its dev proxy.
  use: { baseURL: `http://localhost:${E2E_APP_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx src/entry/cli.ts web',
      url: `http://localhost:${E2E_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...e2eEnv, PORT: String(E2E_PORT) },
    },
    {
      command: `npm --prefix web-ui run dev -- --port ${E2E_APP_PORT}`,
      url: `http://localhost:${E2E_APP_PORT}/signin`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { SCOUT_BACKEND_URL: `http://localhost:${E2E_PORT}` },
    },
  ],
});

import { defineConfig } from "@playwright/test";

// Browser smoke tests against the dev server (npm run dev). Uses the installed Microsoft Edge so no
// browser download is needed on this laptop.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4240",
    channel: process.env.E2E_CHANNEL ?? "msedge",
    navigationTimeout: 150_000,
  },
});

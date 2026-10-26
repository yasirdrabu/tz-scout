import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    environment: "node",
    testTimeout: 30000,
    fileParallelism: false,
    // Tests always run on sample data, whatever .env says for the live app.
    env: Object.fromEntries(["PROSPECTS", "HUBSPOT", "META", "LINKEDIN", "GOOGLE_ADS", "COMPANY_DATA", "BOOKING", "MESSAGING", "ANTHROPIC"].map((k) => [`INTEGRATION_${k}`, "mock"])),
  },
});

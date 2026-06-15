import { defineConfig } from "@playwright/test";

// E2E requires the telemetry backend running (Playwright only starts the web app):
//   pnpm infra:up && pnpm dev:read-api & pnpm dev:telemetry
// Then: pnpm test:e2e:driver
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3102" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3102",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

import { defineConfig } from "@playwright/test";

// E2E needs the read backend running (Playwright only starts the web app):
//   pnpm infra:up && pnpm dev:write-api & pnpm dev:outbox & pnpm dev:projection & pnpm dev:read-api
// Then: pnpm test:e2e:admin
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3103" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3103",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

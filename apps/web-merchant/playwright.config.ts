import { defineConfig } from "@playwright/test";

// E2E requires the full backend stack running (Playwright only starts the web app):
//   pnpm infra:up && pnpm dev:write-api & pnpm dev:outbox & pnpm dev:projection & pnpm dev:read-api & pnpm dev:saga
// Then: pnpm test:e2e:merchant
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3101" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3101",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

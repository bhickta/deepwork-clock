import { defineConfig, devices } from "@playwright/test";

/**
 * Configuration for the frontend browser checks.
 *
 * The preview server has to run in development mode, because the preview
 * bridge is only available in a development build:
 *
 *   npm run dev -- --port 1421
 *   npx playwright test --config tests/frontend/browser/playwright.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env["PREVIEW_URL"] ?? "http://127.0.0.1:1421",
    trace: "off",
    ...devices["Desktop Chrome"]
  }
});

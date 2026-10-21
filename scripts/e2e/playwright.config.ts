import { defineConfig, devices } from "@playwright/test";

/**
 * Browser level checks for the frontend.
 *
 * The suite runs against the Vite *development* server with the `?demo=1`
 * preview bridge: the production bundle cannot talk to the Tauri backend, so
 * in a plain browser it would only render the "backend unavailable" shell.
 * These are therefore preview tests of the frontend, not tests of the
 * packaged desktop application.
 *
 * The packaged WebView accessibility tree, the native menus and the
 * screen-reader matrix still need the manual script from PLAN.md section 9.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1423",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev:e2e",
    url: "http://127.0.0.1:1423",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

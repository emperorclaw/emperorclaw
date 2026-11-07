import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Browser regression gate for the UI invariants static tests cannot see
 * (pointer hit-testing, CSS containing blocks). Runs against a real instance:
 * `E2E_BASE_URL` when given (staging/prod), otherwise it starts the built app
 * from this worktree. Credentials come from E2E_EMAIL / E2E_PASSWORD and
 * default to the seeded local account.
 */
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3210";

export default defineConfig({
  testDir: __dirname,
  globalSetup: resolve(__dirname, "global-setup.ts"),
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start",
        cwd: resolve(__dirname, "../.."),
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});

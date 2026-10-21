import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite.
 *
 * WHAT IT COVERS
 * --------------
 * Six functional tests plus one accessibility test. That is deliberately
 * small: the suite exists to prove the FLOWS, not to re-test the logic the
 * unit tests already cover.
 *
 * WHY THE CHAT ROUTE IS MOCKED
 * ----------------------------
 * Every test that asks a question intercepts `POST /api/chat` and answers
 * with a canned UI MESSAGE STREAM (the same `data:` frames the real route
 * emits). Two reasons:
 *
 *   1. It costs $0.00. The real route calls DeepSeek, and a test suite must
 *      never spend money. The answer benchmark is where the model is
 *      measured.
 *   2. It is deterministic. A test that depends on a model's mood is a test
 *      that fails on a Tuesday.
 *
 * The suite therefore proves the CLIENT: streaming, the visual card, the
 * citation chip, the conversation context and the navigation.
 *
 * THE VIEWPORTS
 * -------------
 * Three, because the layout is the thing most likely to break:
 *
 *   mobile   390 x 844   the iPhone 14 size
 *   tablet   768 x 1024  the iPad portrait size
 *   desktop 1440 x 900   a laptop
 */

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // The suite is deterministic, so it must not retry into a false green.
  retries: 0,
  // A single worker keeps the dev server from being hammered and keeps the
  // run order predictable. The whole suite is a few seconds.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    // The first retrieval call loads the ONNX embedding model, which takes a
    // while on a cold start. The generous timeout keeps a slow cold start
    // from being read as a broken app.
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

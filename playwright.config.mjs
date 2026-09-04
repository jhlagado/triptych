import { defineConfig } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "./test/wasm/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? "github" : "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tools/serve-wasm-browser.mjs",
    env: { PORT: String(port) },
    port,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

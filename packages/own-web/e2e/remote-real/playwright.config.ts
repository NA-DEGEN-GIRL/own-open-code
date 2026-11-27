// Real-host own-web suite (04 §20.3 RG13 web fallback, RG16) against the approved SSH host. Opt-in: set
// OWN_REAL_HOST=dev-host and run own-remote's real-host phase A first. Edge only, no browser download:
// `OWN_REAL_HOST=dev-host bunx playwright test --config e2e/remote-real/playwright.config.ts` from packages/own-web.
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

process.env.OWN_WEB_REMOTE_REAL_SHOTS ??= path.join(os.tmpdir(), "own-web-e2e-remote-real", "shots")
const port = Number(process.env.OWN_WEB_E2E_REMOTE_REAL_PORT ?? 5422)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: "../test-results/remote-real",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  globalTeardown: "./teardown.ts",
  webServer: {
    command: "bun e2e/remote-real/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/`,
    timeout: 400_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ko-KR",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
})

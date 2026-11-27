// SSH remote suite (04 §17, RG13 in the web fallback's dev path) against own-remote's fake-SSH harness. Edge only, no
// browser download. Run: `bunx playwright test --config e2e/remote/playwright.config.ts` from packages/own-web.
import path from "node:path"
import { defineConfig } from "@playwright/test"
import { checkoutTmp } from "../gateway/support"

// Workers inherit it: the spec writes its screenshots there.
process.env.OWN_WEB_REMOTE_SHOTS ??= path.join(checkoutTmp("own-web-e2e-remote"), "shots")
const port = Number(process.env.OWN_WEB_E2E_REMOTE_PORT ?? 5421)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: "../test-results/remote",
  // Install, ensure and the first boot of two servers from source take a while, and the fake SSH host's Git Bash is
  // slow on this PC under the user's load (remote.pw.ts `SSH_STEP`, `CONNECT`, `SERVICE_START`; decisions US6-21).
  timeout: 900_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  globalTeardown: "./teardown.ts",
  webServer: {
    command: "bun e2e/remote/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/`,
    // oldbox's install and connect over the fake SSH host, then the local server's boot from source.
    timeout: 900_000,
    // A busy port fails fast instead of silently testing another checkout's backend. OWN_WEB_E2E_REMOTE_REUSE=1
    // attaches to a backend of this checkout started by hand (`bun e2e/remote/backend.ts`).
    reuseExistingServer: process.env.OWN_WEB_E2E_REMOTE_REUSE === "1",
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

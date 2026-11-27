// Requests suite (03 §18.1, §18.2, §18.8) in the installed Microsoft Edge against the lead's real-server backend
// (e2e/backend.ts: real server from source + own.accounts/own.telemetry + fake OpenAI + "Alpha" account). The specs
// also run in the main suite (e2e/playwright.config.ts matches every `*.spec.ts` under e2e/); this config runs them
// alone on their own ports and temp directory, so it can run next to other suites.
//
// Run from packages/own-web:  bunx playwright test --config e2e/requests/playwright.config.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const dev = Number(process.env.OWN_WEB_REQUESTS_E2E_PORT ?? 5463)
const preview = dev - 1
const tmp = process.env.OWN_WEB_REQUESTS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-requests-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit this, so `backend()` in e2e/support.ts reads this suite's state file.
process.env.OWN_WEB_REQUESTS_E2E_TMP = tmp
process.env.TEMP = tmp
process.env.TMP = tmp

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${dev}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_REQUESTS_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      OWN_WEB_E2E_DEV_PORT: String(dev),
      OWN_WEB_E2E_PREVIEW_PORT: String(preview),
      TEMP: tmp,
      TMP: tmp,
    },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${dev}`,
    locale: "ko-KR",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
})

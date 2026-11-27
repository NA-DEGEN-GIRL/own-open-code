// Sidebar browser tests (03 §4.3) in the installed Microsoft Edge, against the lead's real-server backend
// (e2e/backend.ts: real server from source + own.accounts/own.telemetry + fake OpenAI + "Alpha" account + three
// sessions). The files end in `.pw.ts` so `bun test ./src` never picks them up.
//
// Run from packages/own-web:  bunx playwright test --config src/sidebar/e2e/playwright.config.ts
//
// Isolation: other suites may run at the same time, so this one uses its own ports and its own temp directory
// (the backend writes its state file and server data under os.tmpdir()).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const dev = Number(process.env.OWN_WEB_SIDEBAR_E2E_PORT ?? 5189)
const preview = dev - 1
const tmp = process.env.OWN_WEB_SIDEBAR_E2E_TMP ?? path.join(os.tmpdir(), "own-web-sidebar-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit this, so `backend()` in e2e/support.ts reads this suite's state file.
process.env.OWN_WEB_SIDEBAR_E2E_TMP = tmp
process.env.TEMP = tmp
process.env.TMP = tmp

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/backend.ts",
    cwd: "../../..",
    url: `http://127.0.0.1:${dev}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: false,
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
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
})

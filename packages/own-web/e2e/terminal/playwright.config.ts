// Terminal browser tests (03 §18.6) in the installed Microsoft Edge, against the lead's real-server backend
// (e2e/backend.ts: real server from source with its PTY service, own plugins, three sessions in one workspace).
// The specs also run under the main e2e config (`bun run test:e2e`); this config isolates them with their own ports
// and temp directory so they can run while other suites do.
//
// Run from packages/own-web:  bunx playwright test --config e2e/terminal/playwright.config.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const dev = Number(process.env.OWN_WEB_TERMINAL_E2E_PORT ?? 5169)
const preview = dev - 1
const tmp = process.env.OWN_WEB_TERMINAL_E2E_TMP ?? path.join(os.tmpdir(), "own-web-terminal-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit this, so `backend()` in e2e/support.ts reads this suite's state file.
process.env.OWN_WEB_TERMINAL_E2E_TMP = tmp
process.env.TEMP = tmp
process.env.TMP = tmp

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/backend.ts",
    cwd: "../..",
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
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
})

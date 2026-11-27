// Composer-plus browser tests (03 §19.6 skills, §19.9 history, drafts and `!` shell mode, §19.12 fork and manual
// compact, §12 IME) in the installed Microsoft Edge, against this folder's backend (real server + own plugins + fakes).
//
// Run from packages/own-web:  bunx playwright test --config e2e/composer-plus/playwright.config.ts
//
// Isolation: other suites may run at the same time, so this one uses its own port and temp directory. The specs end in
// `.pw.ts`, so the lead's `e2e/playwright.config.ts` (`.spec.ts`) never picks them up without this backend.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_COMPOSER_PLUS_PORT ?? 5287)
const tmp = process.env.OWN_WEB_COMPOSER_PLUS_TMP ?? path.join(os.tmpdir(), "own-web-composer-plus")
fs.mkdirSync(tmp, { recursive: true })
process.env.OWN_WEB_COMPOSER_PLUS_TMP = tmp

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/composer-plus/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/composer-plus/harness.html`,
    timeout: 300_000,
    // `OWN_WEB_COMPOSER_PLUS_REUSE=1`: use a backend started by hand (`bun e2e/composer-plus/backend.ts`, same env).
    reuseExistingServer: process.env.OWN_WEB_COMPOSER_PLUS_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_COMPOSER_PLUS_PORT: String(port), OWN_WEB_COMPOSER_PLUS_TMP: tmp, TEMP: tmp, TMP: tmp },
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

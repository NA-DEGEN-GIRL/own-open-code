// Composer-ext browser tests (03 §18.12 `@` mentions, §18.13 `/` commands, §12 IME) in the installed Microsoft Edge,
// against this folder's backend (real server + own plugins + fakes, see backend.ts).
//
// Run from packages/own-web:  bunx playwright test --config e2e/composer-ext/playwright.config.ts
//
// Isolation: other suites may run at the same time, so this one uses its own port and temp directory. The specs end in
// `.pw.ts`, so the lead's `e2e/playwright.config.ts` (`.spec.ts`) never picks them up without this backend.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_COMPOSER_EXT_PORT ?? 5263)
const tmp = process.env.OWN_WEB_COMPOSER_EXT_TMP ?? path.join(os.tmpdir(), "own-web-composer-ext")
fs.mkdirSync(tmp, { recursive: true })
process.env.OWN_WEB_COMPOSER_EXT_TMP = tmp

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
    command: "bun e2e/composer-ext/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/composer-ext/harness.html`,
    timeout: 300_000,
    // `OWN_WEB_COMPOSER_EXT_REUSE=1`: use a backend started by hand (`bun e2e/composer-ext/backend.ts`, same env).
    reuseExistingServer: process.env.OWN_WEB_COMPOSER_EXT_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_COMPOSER_EXT_PORT: String(port), OWN_WEB_COMPOSER_EXT_TMP: tmp, TEMP: tmp, TMP: tmp },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ko-KR",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    acceptDownloads: true,
  },
})

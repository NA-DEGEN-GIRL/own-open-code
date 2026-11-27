// Preset screens (07 §7; PG1 and PG11 on screen) in the installed Microsoft Edge against backend.ts: the real server
// from source with own-accounts, fake model providers driven by own-team's directive responder, and own-web through
// Vite dev. presets.spec.ts also holds the PF5 check (01 §16.3): the team and preset screens stay out of the initial JS.
// speed.spec.ts drives 속도 through the composer and the switcher popover (02 §4.8) on the same backend.
//
//   bun run test:e2e:presets            (from packages/own-web)
//
// Own port (5771) and temp directory, so it runs next to the other suites. The main e2e/playwright.config.ts
// ignores this folder; presets.spec.ts also skips itself without this backend.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_PRESETS_E2E_PORT ?? 5771)
const tmp = process.env.OWN_WEB_PRESETS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-presets")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: tests read the backend state file under this temp directory.
process.env.OWN_WEB_PRESETS_E2E_TMP = tmp
process.env.OWN_WEB_PRESETS_E2E_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /(presets|speed)\.spec\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/presets/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_PRESETS_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_PRESETS_E2E_PORT: String(port), OWN_WEB_PRESETS_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

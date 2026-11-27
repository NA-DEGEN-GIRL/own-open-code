// Session-UX browser tests (03 §19.10 notes, 19.11 pin/archive/ID search/date groups, 19.13 find, 19.14 timeline
// presets) in the installed Microsoft Edge against backend.ts (real server from source + own plugins + fake OpenAI).
// The find tests run on fixture sessions (find-harness) served by the same Vite dev server.
// Files end in `.pw.ts` so neither `bun test ./src` nor the lead's `e2e/playwright.config.ts` (`*.spec.ts`) pick them.
//
// Run from packages/own-web:  bunx playwright test --config e2e/session-ux/playwright.config.ts
//
// Isolation: own port (5733) and temp directory, so it can run next to the other suites.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_SESSION_UX_PORT ?? 5733)
const tmp = process.env.OWN_WEB_SESSION_UX_TMP ?? path.join(os.tmpdir(), "own-web-session-ux")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: tests read the backend state file under this temp directory.
process.env.OWN_WEB_SESSION_UX_TMP = tmp
process.env.OWN_WEB_SESSION_UX_PORT = String(port)

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
    command: "bun e2e/session-ux/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/session-ux/harness.html`,
    timeout: 300_000,
    // OWN_WEB_SESSION_UX_REUSE=1 reuses a backend started by hand (`bun e2e/session-ux/backend.ts`, same TMP).
    reuseExistingServer: process.env.OWN_WEB_SESSION_UX_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_SESSION_UX_PORT: String(port), OWN_WEB_SESSION_UX_TMP: tmp, TEMP: tmp, TMP: tmp },
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

// Worktree + background jobs browser tests (03 §19.3 worktree flow, §19.7 background jobs) in the installed Microsoft
// Edge against backend.ts (real server from source + own plugins + scripted fake OpenAI + a Git project).
// Files end in `.pw.ts` so neither `bun test ./src` nor the lead's `e2e/playwright.config.ts` (`*.spec.ts`) pick them.
//
// Run from packages/own-web:  bunx playwright test --config e2e/worktree-bg/playwright.config.ts
//
// Isolation: own port (5347) and temp directory, so it can run next to the other suites.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_WTBG_PORT ?? 5347)
const tmp = process.env.OWN_WEB_WTBG_TMP ?? path.join(os.tmpdir(), "own-web-worktree-bg")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: tests read the backend state file under this temp directory.
process.env.OWN_WEB_WTBG_TMP = tmp
process.env.OWN_WEB_WTBG_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 150_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/worktree-bg/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/worktree-bg/harness.html`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_WTBG_PORT: String(port), OWN_WEB_WTBG_TMP: tmp, TEMP: tmp, TMP: tmp },
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

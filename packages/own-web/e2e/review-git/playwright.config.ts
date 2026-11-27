// Review line comments + Git actions + branch chip (03 §19.1, §19.2, §19.15) in the installed Microsoft Edge, against
// e2e/review-git/backend.ts (real server from source, fake OpenAI, a Git workspace with a bare `origin`, a fake `gh`).
// The files end in `.pw.ts` so neither `bun test ./src` nor the main e2e suite (`*.spec.ts`) picks them up.
//
// Run from packages/own-web:  bunx playwright test --config e2e/review-git/playwright.config.ts
// Own port (OWN_WEB_REVIEW_GIT_E2E_PORT, default 5621) and state file, so it runs next to the other suites. A fresh
// backend per run (the tests change the working copy); OWN_WEB_REVIEW_GIT_E2E_REUSE=1 reuses a running one.
import path from "node:path"
import os from "node:os"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_REVIEW_GIT_E2E_PORT ?? 5621)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: path.join(os.tmpdir(), "own-web-review-git-e2e", "results"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/review-git/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/review-git/harness.html`,
    timeout: 300_000,
    reuseExistingServer: process.env.OWN_WEB_REVIEW_GIT_E2E_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_REVIEW_GIT_E2E_PORT: String(port) },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ko-KR",
    viewport: { width: 1280, height: 960 },
    trace: "retain-on-failure",
  },
})

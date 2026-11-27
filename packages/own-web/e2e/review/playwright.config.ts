// Review tab browser tests (03 §18.5) in the installed Microsoft Edge, against e2e/review/backend.ts (real server from
// source, fake OpenAI provider, a git workspace with committed/branch/uncommitted changes, a worktree with an
// inferred base, a plain folder, and a session whose turn wrote a file through the real `write` tool). The files end
// in `.pw.ts` so neither `bun test ./src` nor the main e2e suite (`*.spec.ts`) picks them up.
//
// Run from packages/own-web:  bunx playwright test --config e2e/review/playwright.config.ts
// Own port (OWN_WEB_REVIEW_E2E_PORT, default 5179) and state file, so it can run next to the other suites. A fresh
// backend per run by default (tests change the working copy); OWN_WEB_REVIEW_E2E_REUSE=1 reuses a running one.
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_REVIEW_E2E_PORT ?? 5179)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  // Under e2e/test-results (git-ignored).
  outputDir: "../test-results/review",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/review/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/review/harness.html`,
    timeout: 300_000,
    reuseExistingServer: process.env.OWN_WEB_REVIEW_E2E_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_REVIEW_E2E_PORT: String(port) },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ko-KR",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
})

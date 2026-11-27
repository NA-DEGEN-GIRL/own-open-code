// Performance benchmarks (01 §6.6, §16.3; 03 §20.4). Kept out of `bun run test:e2e` discovery by the `.bench.ts`
// suffix. Serial, no retries, installed Microsoft Edge (channel "msedge"; no Playwright browser download), against
// the production bundle served by e2e/performance/backend.ts. Run through `bun e2e/performance/run.ts`, which builds,
// sets the run id and results file, and writes perf.json; or directly for one bench:
//   bunx playwright test --config e2e/performance/playwright.config.ts session-switch --repeat-each=5
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

process.env.OPENCODE_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
const port = Number(process.env.OWN_PERF_PREVIEW_PORT ?? 5196)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.bench\.ts/,
  outputDir: process.env.OWN_PERF_OUTPUT ?? path.join(os.tmpdir(), "own-web-perf", "test-results"),
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/performance/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/`,
    timeout: 300_000,
    reuseExistingServer: process.env.OWN_PERF_REUSE_BACKEND === "1",
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    channel: "msedge",
    headless: process.env.OWN_PERF_HEADED !== "1",
    locale: "ko-KR",
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
})

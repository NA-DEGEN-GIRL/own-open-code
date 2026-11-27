// The model @ account sheet's Claude rows (decisions CAM) in the installed Microsoft Edge against backend.ts: the real
// server from source with own-accounts, the Claude subscription slot, a Claude Agent account on own-team's fake
// `claude` (reporting each alias's model, window and Fast as Claude Code does), and own-web through Vite dev.
//
//   bun run test:e2e:claude-models            (from packages/own-web)
//
// Own port (5793) and temp directory, so it runs next to the other suites.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_CLAUDE_MODELS_E2E_PORT ?? 5793)
const tmp = process.env.OWN_WEB_CLAUDE_MODELS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-claude-models")
fs.mkdirSync(tmp, { recursive: true })
process.env.OWN_WEB_CLAUDE_MODELS_E2E_TMP = tmp
process.env.OWN_WEB_CLAUDE_MODELS_E2E_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /claude-models\.spec\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/claude-models/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_CLAUDE_MODELS_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_CLAUDE_MODELS_E2E_PORT: String(port), OWN_WEB_CLAUDE_MODELS_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

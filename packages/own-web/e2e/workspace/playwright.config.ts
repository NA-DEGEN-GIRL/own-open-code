// Workspace suite (project open 03 §18.3, MCP 03 §18.14, browser tool policy 01 §10.1) in the installed Microsoft
// Edge, against its own real-server backend (e2e/workspace/backend.ts: real server + own.accounts/own.telemetry +
// fake OpenAI + fake MCP/OAuth servers + project folders). Files end in `.pw.ts` so neither `bun test ./src` nor the
// lead's e2e config (`*.spec.ts` under e2e/) picks them up.
//
// Run from packages/own-web:  bunx playwright test --config e2e/workspace/playwright.config.ts
//
// Isolation: other suites may run at the same time, so this one uses its own port and its own temp directory.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const dev = Number(process.env.OWN_WEB_WORKSPACE_E2E_PORT ?? 5231)
const tmp = process.env.OWN_WEB_WORKSPACE_E2E_TMP ?? path.join(os.tmpdir(), "own-web-workspace-e2e-run")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these, so the spec reads this suite's state file.
process.env.OWN_WEB_WORKSPACE_E2E_TMP = tmp
process.env.OWN_WEB_WORKSPACE_E2E_PORT = String(dev)
process.env.TEMP = tmp
process.env.TMP = tmp

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
    command: "bun e2e/workspace/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${dev}/e2e/workspace/harness.html`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_WORKSPACE_E2E_PORT: String(dev), TEMP: tmp, TMP: tmp },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${dev}`,
    locale: "ko-KR",
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
  },
})

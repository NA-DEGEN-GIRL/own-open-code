// 설정 > 웹 검색 (03 §18.2, WM 2026-10-19) in the installed Microsoft Edge against backend.ts: the real server from source
// with own.accounts (linked ChatGPT accounts on a fake Codex backend, a DeepSeek API account), the e2e kit's
// `fake-search` service and own-web through Vite dev. The spec ends in `.pw.ts` so neither `bun test ./src` nor the main
// e2e suite (`*.spec.ts`) picks it up.
//
//   bun run test:e2e:websearch            (from packages/own-web)
//
// Own port (6791) and temp directory, so it runs next to the other suites; OWN_WEB_WEBSEARCH_E2E_PORT and
// OWN_WEB_WEBSEARCH_E2E_TMP move them.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_WEBSEARCH_E2E_PORT ?? 6791)
const tmp = process.env.OWN_WEB_WEBSEARCH_E2E_TMP ?? path.join(os.tmpdir(), "own-web-websearch")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: the spec reads the backend state file under this temp directory.
process.env.OWN_WEB_WEBSEARCH_E2E_TMP = tmp
process.env.OWN_WEB_WEBSEARCH_E2E_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/websearch/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: process.env.OWN_WEB_WEBSEARCH_E2E_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_WEBSEARCH_E2E_PORT: String(port), OWN_WEB_WEBSEARCH_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

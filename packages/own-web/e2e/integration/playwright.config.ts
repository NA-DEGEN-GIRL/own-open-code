// Integration walkthrough (P3 integrator): the whole app against dev/serve.ts — the real server from source with
// own.accounts + own.telemetry, fake OpenAI (chunked streaming) / Codex / ChatGPT issuer, a fake old-app profile tree,
// accounts made through RPC and seeded sessions — in the installed Microsoft Edge. Screenshots go to
// $OWN_WEB_SHOTS (default <tmp>/own-web-integration/shots).
//
//   bun run test:integration            (from packages/own-web)
//
// Isolation: own ports (5401), its own temp directory and its own Vite dependency cache (e2e/vite-dev.ts), so it can
// run next to the other suites.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_INTEGRATION_PORT ?? 5401)
const tmp = process.env.OWN_WEB_INTEGRATION_TMP ?? path.join(os.tmpdir(), "own-web-integration")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: the walkthrough reads the service state file under this temp directory.
process.env.OWN_WEB_INTEGRATION_TMP = tmp
process.env.OWN_WEB_SHOTS ??= path.join(tmp, "shots")

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.flow\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: `bun dev/serve.ts --port ${port}`,
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: { TEMP: tmp, TMP: tmp },
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

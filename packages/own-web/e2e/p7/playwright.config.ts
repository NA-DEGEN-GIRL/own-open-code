// P7 acceptance walkthrough (integrator): items 17–32 of 03 §19 in the whole app in the installed Microsoft Edge
// against e2e/p7/backend.ts (real server from source with own.accounts/own.telemetry, scripted fake OpenAI, a Git
// workspace with a bare origin and a fake `gh`).
//
//   bun run test:e2e:p7            (from packages/own-web)
//
// Own port (5711) and temp directory, so it runs next to the other suites. Dark theme by default (03 §13); some tests
// switch to light. Screenshots go to $OWN_WEB_P7_SHOTS (default <tmp>/shots). Spec files end in `.p7.ts`.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_P7_PORT ?? 5711)
const tmp = process.env.OWN_WEB_P7_TMP ?? path.join(os.tmpdir(), "own-web-p7")
fs.mkdirSync(tmp, { recursive: true })
process.env.OWN_WEB_P7_TMP = tmp
process.env.OWN_WEB_P7_SHOTS ??= path.join(tmp, "shots")

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.p7\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 150_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/p7/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_P7_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_P7_PORT: String(port), OWN_WEB_P7_TMP: tmp },
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

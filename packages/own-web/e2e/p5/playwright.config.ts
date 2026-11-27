// P5 acceptance walkthrough (integrator): the whole app in the installed Microsoft Edge against e2e/p5/backend.ts (real
// server from source with own.accounts/own.telemetry, scripted fake OpenAI, fake MCP/OAuth, Git workspace).
//
//   bun run test:e2e:p5            (from packages/own-web)
//
// Own port (5511) and temp directory, so it runs next to the other suites. Screenshots go to $OWN_WEB_P5_SHOTS
// (default <tmp>/shots). Spec files end in `.p5.ts`, so no other config picks them up.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_P5_PORT ?? 5511)
const tmp = process.env.OWN_WEB_P5_TMP ?? path.join(os.tmpdir(), "own-web-p5")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: the specs read the backend's state file and write screenshots.
process.env.OWN_WEB_P5_TMP = tmp
process.env.OWN_WEB_P5_SHOTS ??= path.join(tmp, "shots")

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.p5\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/p5/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_P5_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_P5_PORT: String(port), OWN_WEB_P5_TMP: tmp, TEMP: tmp, TMP: tmp },
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

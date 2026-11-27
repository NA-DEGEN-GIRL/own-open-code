// Palette + shortcut settings + shell settings suite (03 §3, §10, §19.8) in the installed Microsoft Edge, against its
// own real-server backend (e2e/palette-shell/backend.ts). Files end in `.pw.ts` so neither `bun test ./src` nor the
// lead's e2e config (`*.spec.ts` under e2e/) picks them up.
//
// Run from packages/own-web:  bunx playwright test --config e2e/palette-shell/playwright.config.ts
// Screenshots (both themes) go to $OWN_WEB_PALETTE_SHOTS (default <tmp>/shots).
//
// Isolation: other suites may run at the same time, so this one uses its own port and its own temp directory.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_PALETTE_E2E_PORT ?? 5377)
const tmp = process.env.OWN_WEB_PALETTE_E2E_TMP ?? path.join(os.tmpdir(), "own-web-palette-shell-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these, so the spec reads this suite's state file and writes screenshots there.
process.env.OWN_WEB_PALETTE_E2E_TMP = tmp
process.env.OWN_WEB_PALETTE_E2E_PORT = String(port)
process.env.OWN_WEB_PALETTE_SHOTS ??= path.join(tmp, "shots")

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
    command: "bun e2e/palette-shell/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/palette-shell/harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_PALETTE_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_PALETTE_E2E_PORT: String(port), OWN_WEB_PALETTE_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

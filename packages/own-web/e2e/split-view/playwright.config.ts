// Split view suite (03 §4.1, §4.7, 05 §7.2, §8.2: panes, side-by-side chat and browser, tabs fallback) in the
// installed Microsoft Edge, against the palette suite's real-server backend (e2e/palette-shell/backend.ts: real server +
// own.accounts/own.telemetry + fake OpenAI, three named sessions and 120 fillers) on its own port and temp directory.
// Files end in `.pw.ts` so neither `bun test ./src` nor the lead's e2e config (`*.spec.ts` under e2e/) picks them up.
//
// Run from packages/own-web:  bunx playwright test --config e2e/split-view/playwright.config.ts
// Screenshots go to $OWN_WEB_SPLIT_SHOTS (default <repo>/own/.out/split-view, not committed).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_SPLIT_E2E_PORT ?? 5393)
const tmp = process.env.OWN_WEB_SPLIT_E2E_TMP ?? path.join(os.tmpdir(), "own-web-split-view-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these, so the spec reads this suite's state file and writes screenshots there.
process.env.OWN_WEB_SPLIT_E2E_TMP = tmp
process.env.OWN_WEB_SPLIT_E2E_PORT = String(port)
process.env.OWN_WEB_SPLIT_SHOTS ??= path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../own/.out/split-view",
)

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
    url: `http://127.0.0.1:${port}/e2e/split-view/harness.html`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.OWN_WEB_SPLIT_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_PALETTE_E2E_PORT: String(port), OWN_WEB_PALETTE_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
  },
  use: {
    channel: "msedge",
    headless: true,
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ko-KR",
    viewport: { width: 1724, height: 960 },
    trace: "retain-on-failure",
  },
})

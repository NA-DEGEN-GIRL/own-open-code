// Server sections suite (03 §4.3: the three zones, this PC, SSH hosts and other PCs as the same section, dragging,
// moving and pinning, persistence, the older service) in the installed Microsoft Edge, on its own port and temp
// directory. Files end in `.pw.ts` so neither `bun test ./src` nor the lead's e2e config picks them up.
//
// Run from packages/own-web:  bun run test:e2e:sections
// Screenshots go to $OWN_WEB_SECTIONS_SHOTS (default <repo>/own/.out/sections, not committed).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_SECTIONS_E2E_PORT ?? 5419)
const tmp = process.env.OWN_WEB_SECTIONS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-sections-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these, so the specs read this suite's state file and write screenshots there.
process.env.OWN_WEB_SECTIONS_E2E_TMP = tmp
process.env.OWN_WEB_SECTIONS_E2E_PORT = String(port)
process.env.OWN_WEB_SECTIONS_SHOTS ??= path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../own/.out/sections",
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
    command: "bun e2e/sections/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/sections/harness.html`,
    timeout: 400_000,
    reuseExistingServer: !!process.env.OWN_WEB_SECTIONS_E2E_REUSE,
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_SECTIONS_E2E_PORT: String(port), OWN_WEB_SECTIONS_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

// The layout audit (audit.ts) in the installed Microsoft Edge against the user manual's demo world
// (e2e/manual/backend.ts, `main`: the real server from source, fake ChatGPT, DeepSeek, Anthropic and Claude
// subscription accounts, presets, a dozen conversations in three projects). It opens every menu, popover, dialog and
// pill of the session screen, the new-conversation screen and the pages at each window width the app supports and
// fails on what audit.ts finds that allowlist.ts does not allow. Pictures of every popup land in the results folder
// (`screens/<width>/`) for a review by eye.
//
//   bun run test:e2e:ui-audit          (from packages/own-web; the world takes a few minutes to boot)
//
// Own ports (6371 and the world's phone stand-in on 6372) and temp directory, so it runs next to the other suites.
// OWN_WEB_UI_AUDIT_REUSE=1 attaches to a world started by hand with the same port and OWN_MANUAL_TMP.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_UI_AUDIT_PORT ?? 6371)
const tmp = process.env.OWN_WEB_UI_AUDIT_TMP ?? path.join(os.tmpdir(), "own-web-ui-audit")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: the spec reads the world's state file under this temp directory.
process.env.OWN_WEB_UI_AUDIT_TMP = tmp
process.env.OWN_WEB_UI_AUDIT_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /ui-audit\.spec\.ts$/,
  outputDir: path.join(tmp, "results"),
  timeout: 600_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/manual/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 900_000,
    reuseExistingServer: process.env.OWN_WEB_UI_AUDIT_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      OWN_MANUAL_WORLD: "main",
      OWN_MANUAL_PORT: String(port),
      OWN_MANUAL_TMP: tmp,
      TEMP: tmp,
      TMP: tmp,
    },
  },
  use: {
    channel: "msedge",
    headless: true,
    locale: "ko-KR",
    // A layout audit, not a speed check: several hundred clicks, reloads and pictures per width, where on a busy PC
    // a single one passed 10 s (a settings reload, a picture of the MCP page) in three runs at three different widths.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
  },
})

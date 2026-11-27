// 다른 도구의 대화 (09 §6) in the installed Microsoft Edge against backend.ts: the real server from source with
// own-accounts and own-import, synthetic Codex and Claude Code stores (own-import's test fixtures) as its only roots,
// and own-web through Vite dev. import.spec.ts walks the I1 screens (IG1 and IG10 on screen, IG5's PF5); migrate.spec.ts
// walks I2 (the dialog, the LLM and LLM-free paths, cancel and restore, hiding the helper; IG8, IG9 and IG10 on screen).
//
//   bun run build && bun run test:e2e:import            (from packages/own-web; the PF5 test reads dist/)
//
// Own port (5781) and a temp directory of this checkout (`checkoutTmp`), so it runs next to the other suites and other
// worktrees. OWN_WEB_IMPORT_E2E_REUSE=1 attaches to a backend of this checkout started by hand
// (`bun e2e/import/backend.ts`); otherwise a busy port fails fast. The main e2e/playwright.config.ts ignores this
// folder; the specs also skip themselves without this backend.
import fs from "node:fs"
import path from "node:path"
import { defineConfig } from "@playwright/test"
import { checkoutTmp } from "../gateway/support"

const port = Number(process.env.OWN_WEB_IMPORT_E2E_PORT ?? 5781)
const tmp = process.env.OWN_WEB_IMPORT_E2E_TMP ?? checkoutTmp("own-web-import-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: tests read the backend state file under this temp directory.
process.env.OWN_WEB_IMPORT_E2E_TMP = tmp
process.env.OWN_WEB_IMPORT_E2E_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  outputDir: path.join(tmp, "results"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/import/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    // The server's boot from source, the seeded conversations and two turns: past 300 s on this PC under the user's
    // load (2026-11-12, decisions US6-21).
    timeout: 600_000,
    reuseExistingServer: process.env.OWN_WEB_IMPORT_E2E_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    // TEMP: the harness's temp root and the stores land in this checkout's folder, removed when the backend stops.
    env: { OWN_WEB_IMPORT_E2E_PORT: String(port), OWN_WEB_IMPORT_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

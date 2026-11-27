// 설정 > 스킬 and MCP 서버 (SM 2026-10-24) in the installed Microsoft Edge against backend.ts: the real server from
// source with own-accounts and own-import, fake Codex and Claude Code homes, and own-web through Vite dev. The spec ends
// in `.pw.ts` so neither `bun test ./src` nor the main e2e suite (`*.spec.ts`) picks it up.
//
//   bun run test:e2e:tools            (from packages/own-web)
//
// Own port (6831) and a temp directory of this checkout (`checkoutTmp`), so it runs next to the other suites;
// OWN_WEB_TOOLS_E2E_PORT and OWN_WEB_TOOLS_E2E_TMP move them, OWN_WEB_TOOLS_E2E_REUSE=1 attaches to a backend started
// by hand (`bun e2e/tools/backend.ts`).
import fs from "node:fs"
import path from "node:path"
import { defineConfig } from "@playwright/test"
import { checkoutTmp } from "../gateway/support"

const port = Number(process.env.OWN_WEB_TOOLS_E2E_PORT ?? 6831)
const tmp = process.env.OWN_WEB_TOOLS_E2E_TMP ?? checkoutTmp("own-web-tools-e2e")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: the spec reads the backend state file under this temp directory.
process.env.OWN_WEB_TOOLS_E2E_TMP = tmp
process.env.OWN_WEB_TOOLS_E2E_PORT = String(port)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: path.join(tmp, "results"),
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  // Playwright hard-kills the backend on Windows: the teardown has it stop and removes what is left.
  globalTeardown: "./teardown.ts",
  webServer: {
    command: "bun e2e/tools/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    reuseExistingServer: process.env.OWN_WEB_TOOLS_E2E_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: { OWN_WEB_TOOLS_E2E_PORT: String(port), OWN_WEB_TOOLS_E2E_TMP: tmp, TEMP: tmp, TMP: tmp },
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

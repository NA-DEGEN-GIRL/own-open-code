// M1 remote-access suite (05 §15 M1: MG1–MG6, MG8) in the installed Edge: a PC tab pairs a phone tab (375 px mobile
// emulation) through own-remote's gateway on loopback, then the phone works through /srv/<serverKey>. Run:
// `bun run test:e2e:gateway` from packages/own-web (Edge only, no browser download).
import path from "node:path"
import { defineConfig } from "@playwright/test"
import { STATE_DIR } from "./support"

process.env.OWN_WEB_GATEWAY_SHOTS ??= path.join(STATE_DIR, "shots")
const port = Number(process.env.OWN_WEB_E2E_GATEWAY_PORT ?? 5431)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: "../test-results/gateway",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  globalTeardown: "./teardown.ts",
  webServer: {
    command: "bun e2e/gateway/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/`,
    timeout: 900_000,
    // A busy port fails fast instead of silently testing another checkout's backend. OWN_WEB_E2E_GATEWAY_REUSE=1
    // attaches to a backend of this checkout started by hand (`bun e2e/gateway/backend.ts`).
    reuseExistingServer: process.env.OWN_WEB_E2E_GATEWAY_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
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

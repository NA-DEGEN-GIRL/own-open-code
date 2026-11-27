// 설정 > MCP 서버 `SSH 호스트에서 쓰기` (04 §13 "MCP", 03 §18.14, MH 2026-11-26) against own-remote's fake-SSH harness:
// one host with a real service from source (`buildbox`) and one at an older release (`oldbox`). Edge only, no browser
// download. Run: `bun run test:e2e:mcp-hosts` from packages/own-web.
import path from "node:path"
import { defineConfig } from "@playwright/test"
import { checkoutTmp } from "../gateway/support"

process.env.OWN_WEB_MCP_HOSTS_SHOTS ??= path.join(checkoutTmp("own-web-e2e-mcp-hosts"), "shots")
const port = Number(process.env.OWN_WEB_E2E_MCP_HOSTS_PORT ?? 5431)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: "../test-results/mcp-hosts",
  // Install, ensure and the first boot of two servers from source over the fake SSH host take a while.
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  globalTeardown: "./teardown.ts",
  webServer: {
    command: "bun e2e/mcp-hosts/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/`,
    timeout: 900_000,
    // OWN_WEB_E2E_MCP_HOSTS_REUSE=1 attaches to a backend of this checkout started by hand.
    reuseExistingServer: process.env.OWN_WEB_E2E_MCP_HOSTS_REUSE === "1",
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

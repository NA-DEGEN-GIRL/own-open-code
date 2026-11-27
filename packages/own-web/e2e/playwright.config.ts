// Browser tests run in the installed Microsoft Edge (channel "msedge"); no Playwright browser download.
// The backend (e2e/backend.ts) boots the real server with own plugins and serves own-web; tests read its state file.
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_E2E_DEV_PORT ?? 5199)

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  // These suites boot their own backends (bun run test:e2e:team, test:e2e:presets, test:e2e:import,
  // test:e2e:ui-audit, test:e2e:mobile, test:e2e:claude-models).
  testIgnore: ["team/**", "presets/**", "import/**", "ui-audit/**", "mobile/**", "claude-models/**"],
  outputDir: "./test-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/backend.ts",
    cwd: "..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 300_000,
    // A busy port fails fast instead of silently testing another checkout's backend. OWN_WEB_E2E_REUSE=1 attaches to
    // a backend of this checkout started by hand (`bun e2e/backend.ts`).
    reuseExistingServer: process.env.OWN_WEB_E2E_REUSE === "1",
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

// RG2 Linux build checks (04 §5.2, §5.5) against the release bundles written by own/scripts/build-remote.ps1. No
// browser page is opened (Edge channel only, no Playwright browser download). Run from packages/own-web:
//   bunx playwright test --config e2e/linux-build/playwright.config.ts
// OWN_REMOTE_ARTIFACTS=<dir with manifest.json> picks the bundles; otherwise the newest own/.out/*/<ver>/remote.
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.ts/,
  outputDir: "../test-results/linux-build",
  // Hashing and unpacking two ~60 MB archives, then uploading each to a fake host.
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    channel: "msedge",
    headless: true,
  },
})

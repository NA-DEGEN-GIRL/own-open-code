// The phone suite (MUX 2026-11-06): the main flows of own-web as the Android app shows them, at phone sizes, in the
// installed Microsoft Edge against the user manual's demo world (e2e/manual/backend.ts, `main`: the real server from
// source, fake ChatGPT, DeepSeek, Anthropic and Claude subscription accounts, presets, a dozen conversations). Pages
// open through the world's phone stand-in (a paired device with `read`, `prompt` and `switch`) with the app's user
// agent, so the app bridge (src/host/app-bridge.ts) loads as it does inside the Android app.
//
//   bun run test:e2e:mobile             (from packages/own-web; the world takes a few minutes to boot)
//
// Projects: 360x780 and 412x915 portrait, the user's Galaxy S23 Ultra (384x742 at 2.8125, s23.spec.ts), 915x412
// landscape (a phone on its side is the tablet tier by width), and the Galaxy Z Fold8 and Fold8 Ultra folded and
// unfolded (fold8.spec.ts; the phone tests also run on the Fold8's cover); the swipe gestures (swipe.spec.ts) on the
// S23, the Fold8's cover and its main screen upright; icon centring (centre.spec.ts) there and on a 1366 px desktop.
// Own ports (6381 and the stand-in on 6382) and temp directory, so it runs next to the other suites;
// OWN_WEB_MOBILE_REUSE=1 attaches to a world started by hand with the same port and OWN_MANUAL_TMP.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

const port = Number(process.env.OWN_WEB_MOBILE_PORT ?? 6381)
const tmp = process.env.OWN_WEB_MOBILE_TMP ?? path.join(os.tmpdir(), "own-web-mobile")
fs.mkdirSync(tmp, { recursive: true })
// Workers inherit these: the spec reads the world's state file under this temp directory.
process.env.OWN_WEB_MOBILE_TMP = tmp
process.env.OWN_WEB_MOBILE_PORT = String(port)

/** The Android app's WebView user agent (08 §3.4: ` OwnOpenCodeApp/1 (android)` after the system's). */
const APP_AGENT =
  "Mozilla/5.0 (Linux; Android 10; LM-G710N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36 OwnOpenCodeApp/1 (android)"
const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: APP_AGENT }
/** The user's Galaxy S23 Ultra (S23 pass, 2026-11-19): FHD+ 1080×2316 at 2.8125, 384×742 CSS px under its bars. */
const S23_AGENT =
  "Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 OwnOpenCodeApp/1 (android)"

/**
 * The Galaxy Z Fold8 and Z Fold8 Ultra (Fold8 pass, 2026-11-20; specs from Samsung and the launch coverage, report
 * own/reports/fold8-2026-11-20.md): pixels at Samsung's foldable density 2.625 (420 dpi, as Chrome's Galaxy Z Fold 5
 * and 6 entries) less 81 px of status and navigation bars, as the S23's 742 of 823. Fold8: cover 1248×1972 → 475×670,
 * main 2448×1848, landscape first → 932×623 (704×851 upright). Fold8 Ultra: cover 1080×2520 → 411×879, main
 * 2256×2504 → 859×873 upright (954×778 on its side). The model number in the agent is a stand-in.
 */
const FOLD8_AGENT =
  "Mozilla/5.0 (Linux; Android 16; SM-F971N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 OwnOpenCodeApp/1 (android)"
const fold8 = { ...phone, deviceScaleFactor: 2.625, userAgent: FOLD8_AGENT }

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  outputDir: path.join(tmp, "results"),
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  webServer: {
    command: "bun e2e/manual/backend.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/e2e/ime-harness.html`,
    timeout: 900_000,
    reuseExistingServer: process.env.OWN_WEB_MOBILE_REUSE === "1",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      OWN_MANUAL_WORLD: "main",
      // The real gateway behind the phone stand-in, for the browser pane on a device (browser.spec.ts, 05 §8.10).
      OWN_MANUAL_BROWSER: "1",
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
    timezoneId: "Asia/Seoul",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    baseURL: `http://127.0.0.1:${port + 1}`,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone-360", use: { ...phone, viewport: { width: 360, height: 780 } } },
    { name: "phone-412", use: { ...phone, viewport: { width: 412, height: 915 } } },
    {
      name: "s23",
      use: { ...phone, deviceScaleFactor: 2.8125, userAgent: S23_AGENT, viewport: { width: 384, height: 742 } },
    },
    { name: "landscape", use: { ...phone, viewport: { width: 915, height: 412 } } },
    { name: "fold8-cover", use: { ...fold8, viewport: { width: 475, height: 670 } } },
    { name: "fold8-main", use: { ...fold8, viewport: { width: 932, height: 623 } } },
    { name: "fold8-main-portrait", use: { ...fold8, viewport: { width: 704, height: 851 } } },
    { name: "fold8u-cover", use: { ...fold8, viewport: { width: 411, height: 879 } } },
    { name: "fold8u-main", use: { ...fold8, viewport: { width: 859, height: 873 } } },
    { name: "fold8u-main-landscape", use: { ...fold8, viewport: { width: 954, height: 778 } } },
    // A desktop window with a mouse on the PC's own page (centre.spec.ts only; every other spec skips it).
    {
      name: "desktop",
      use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1366, height: 768 }, isMobile: false, hasTouch: false },
    },
  ],
})

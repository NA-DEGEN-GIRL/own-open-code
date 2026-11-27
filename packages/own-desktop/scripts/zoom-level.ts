// This PC's window zoom on the built shell (05 §7.9, 03 §4.2.1), never installed: kept across a restart, the title
// bar's indicator and bubble, Ctrl+wheel and 설정 > 일반 `화면 크기`. Fake credentials only; one temp root (OWN_HOME,
// OWN_CONFIG_DIR, XDG_*, TEMP and the shell's userData) removed afterwards; every process started here is stopped.
// It runs `out/` (`bun run build`) unpackaged on the workspace's Electron with OPENCODE_DESKTOP_TEST_ROOT, so the
// settings file is the temp root's, never the installed app's `%APPDATA%\dev.own.opencode.desktop`. The user works
// on this PC: input is CDP only (no OS key presses), the window opens off-screen (a saved window state at -32000, which
// upstream window-state.ts keeps when it carries no displayBounds, and OWN_DESKTOP_TEST_RUN, which also keeps it off
// the taskbar and ends the shell when this run is gone), the installed-UI pointer is the temp root's, and each
// start is ended by killing its process tree (no window close: the settings file is written at once), with a hard
// timeout per start. At the end no electron.exe of this package may be left.
//
//   bun scripts/zoom-level.ts --web <own-web build dir> [--shots <dir>] [--label zoom-level] [--keep]
//
// Checks:
//  - start.default: a first start is at 100 % with no indicator;
//  - keys.step: Ctrl+= is 110 % (the page's devicePixelRatio, main's factor), the indicator says `110%` left of the
//    window buttons, the header keeps its place free, and the bubble flashes and closes by itself;
//  - bubble.control: the indicator opens `−  110%  +  초기화(100%)`; + is 125 %; Esc closes it;
//  - wheel.step (recorded): Ctrl+wheel up through CDP steps one level;
//  - settings.row: 설정 > 일반 `화면 크기` shows the factor and its − changes it without the bubble;
//  - kept.file: the shell's settings file holds `ownZoomFactor`;
//  - restart.restored: after the shell is gone, the next start shows the kept factor from its first look, the indicator and a band sized to it (max(44, round(44 × z)) DIP);
//  - restart.from-settings-file: with Chromium's own per-host zoom levels removed from its Preferences, the settings
//    file alone brings the zoom back; Ctrl+0 is 100 %, no indicator, 1 kept;
//  - panel.head-keeps-place: with the work panel open (a sheet at this width), its head's band row stays left of
//    the pill.
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Browser, Page } from "@playwright/test"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { ALLOWED } from "../../own-web/e2e/ui-audit/allowlist"
import { Audit, line } from "../../own-web/e2e/ui-audit/audit"
import { REPO_ROOT, startOpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { registerService } from "./dev-service"
import { connect, waitForMarks } from "./probe"
import {
  alive,
  appDataDir,
  cleanEnv,
  freePort,
  installUi,
  killTree,
  PACKAGE,
  removeNewOsArtifacts,
  removeNewTrayIconSettings,
  sameMachine,
  shellVersion,
  snapshotMachine,
  trayIconSettings,
  windowShot,
  xdgDirs,
} from "./run-kit"

const args = parseArgs({
  options: {
    web: { type: "string" },
    shots: { type: "string" },
    label: { type: "string", default: "zoom-level" },
    keep: { type: "boolean", default: false },
  },
}).values

if (!existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("run `bun run build` first")
if (!args.web || !existsSync(path.join(args.web, "index.html")))
  throw new Error("--web <own-web build dir> is required")
const label = args.label!
const shots = args.shots
if (shots) mkdirSync(shots, { recursive: true })

const root = path.join(os.tmpdir(), `own-desktop-zoom-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
const shellTemp = path.join(root, "tmp")
const testRoot = path.join(root, "desktop")
mkdirSync(configDir, { recursive: true })
mkdirSync(shellTemp, { recursive: true })
// upstream configure.ts: userData is <OPENCODE_DESKTOP_TEST_ROOT>\desktop; the settings store is opencode.settings.
const settingsFile = path.join(testRoot, "desktop", "opencode.settings")

const machine = snapshotMachine()
// Each start shows the tray icon (05 §7.3) and Windows keeps an entry per icon for the exe's real path: the run's go.
const electronDir = realpathSync(path.dirname(createRequire(import.meta.url)("electron") as unknown as string))
const trayIconsBefore = new Set(trayIconSettings(electronDir))
const report: Record<string, unknown> = { label, root, rpcHash: RPC_HASH }
const checks: Record<string, boolean> = {}
const shotsTaken: string[] = []
const check = (name: string, value: boolean) => {
  checks[name] = value
  console.error(`[zoom-level] ${value ? "PASS" : "FAIL"} ${name}`)
}
const log = (message: string) => console.error(`[zoom-level] ${message}`)
const near = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance

const fake = startFakeOpenAIResponses({ models: ["gpt-5.5"] })
const service = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  // A source boot is CPU-bound; with other builds and tests on the PC it can take minutes.
  startupTimeoutMs: 600_000,
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-desktop-zoom-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: fake.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
    }),
})
const password = atob(service.authorization.slice("Basic ".length)).slice("opencode:".length)
const ownHome = service.paths.ownHome
mkdirSync(path.join(ownHome, "control"), { recursive: true })

let shell: ReturnType<typeof Bun.spawn> | undefined
const appData = appDataDir()
const appDataExisted = existsSync(appData)
const watchdog = setTimeout(async () => {
  log("watchdog: the run took too long; stopping everything")
  if (shell) killTree(shell.pid)
  killTree(service.pid)
  await removeTree(root)
  await removeTree(service.paths.root)
  process.exit(2)
}, 12 * 60_000)

/** What the page and main say about the zoom now. */
async function zoomNow(page: Page) {
  return page.evaluate(async () => {
    const own = (window as unknown as { own: { zoom: { get(): Promise<number> } } }).own
    const pill = document.querySelector<HTMLElement>('[data-testid="zoom-indicator"]')
    const bubble = document.querySelector<HTMLElement>('[data-testid="zoom-bubble"]')
    const header = document.querySelector<HTMLElement>(".own-header")
    const overlay = (navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } })
      .windowControlsOverlay
    const rect = overlay?.getTitlebarAreaRect()
    const pillRect = pill?.getBoundingClientRect()
    return {
      factor: await own.zoom.get(),
      dpr: devicePixelRatio,
      pill: pill?.textContent?.trim(),
      pillRight: pillRect ? Math.round(innerWidth - pillRect.right) : undefined,
      pillWidth: pillRect ? Math.round(pillRect.width) : undefined,
      pillRegion: pill ? getComputedStyle(pill).getPropertyValue("-webkit-app-region") : undefined,
      buttons: rect ? Math.round(innerWidth - rect.x - rect.width) : undefined,
      band: rect ? Math.round(rect.height * 10) / 10 : undefined,
      headerPadding: header ? Math.round(Number.parseFloat(getComputedStyle(header).paddingRight)) : undefined,
      bubble: bubble?.matches(":popover-open") ? bubble.dataset.mode : "closed",
      control: bubble
        ? [...bubble.querySelectorAll("button, output")].map((node) => node.textContent?.trim())
        : undefined,
    }
  })
}

const WINDOW_ID = "zoom-e2e"

/** The shell's first window opens off-screen (its id first in `windowIds`, its saved bounds at -32000). */
function offscreen() {
  const userData = path.dirname(settingsFile)
  mkdirSync(userData, { recursive: true })
  const settings = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as object) : {}
  writeFileSync(settingsFile, JSON.stringify({ ...settings, windowIds: [WINDOW_ID] }, null, "	"))
  writeFileSync(
    path.join(userData, `window-state-${WINDOW_ID}.json`),
    JSON.stringify({ x: -32000, y: -32000, width: 1280, height: 800 }),
  )
}

/** Every electron.exe still running from this package or on this run's userData (a start that outlived its kill). */
function leftovers() {
  const like = (text: string) => `$_.CommandLine -like '*${text.replaceAll("'", "''")}*'`
  const run = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
        `Where-Object { ${like(PACKAGE)} -or ${like(root)} } | ForEach-Object { $_.ProcessId }`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  return run.stdout.toString().split(/\s+/).filter(Boolean).map(Number)
}

async function launch(name: string) {
  offscreen()
  const cdp = await freePort()
  const env = cleanEnv({ ...xdg, OWN_HOME: ownHome, OWN_CONFIG_DIR: configDir, TEMP: shellTemp, TMP: shellTemp })
  const electron = createRequire(import.meta.url)("electron") as unknown as string
  shell = Bun.spawn([electron, PACKAGE], {
    env: {
      ...env,
      OPENCODE_DESKTOP_TEST_ROOT: testRoot,
      OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdp),
      // 05 §7.3 test hook of the development shell: every window off the screen and the taskbar, and the shell exits
      // by itself when this run is gone (tray-quit's TQ-8; the saved window state above stays for the first look).
      OWN_DESKTOP_TEST_RUN: String(process.pid),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const pid = shell.pid
  // Hard timeout per start: whatever happens below, this shell is gone after 5 minutes.
  const deadline = setTimeout(() => killTree(pid), 5 * 60_000)
  shell.exited.then(() => clearTimeout(deadline))
  const connected = await connect(`http://127.0.0.1:${cdp}`, 120_000)
  // The first look: before own-web is up, the page already has the kept zoom (Chromium restored it at the commit).
  const first = await connected.page.evaluate(() => devicePixelRatio).catch(() => undefined)
  await connected.page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
  await waitForMarks(connected.page, ["own:t0:connect", "own:t0:ready"])
  const winShot = (shot: string) => {
    if (!shots) return undefined
    const out = windowShot(pid, path.join(shots, `${label}-${name}-${shot}-window.png`))
    shotsTaken.push(out)
    return out
  }
  return { ...connected, first, winShot }
}

/** Ends this start: the CDP connection, then the shell's whole process tree. */
async function stop(browser: Browser) {
  await browser.close().catch(() => undefined)
  killTree(shell!.pid)
  const exited = await Promise.race([shell!.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
  return exited ? "stopped" : "still running"
}

/**
 * The layout audit (own-web e2e/ui-audit) over the desktop-only UI the browser audit cannot reach, at 110 %: the zoom
 * indicator's bubble, 설정 > 일반 (화면 크기, the folder rows) and 설정 > 데스크톱 앱 (창을 닫으면, 종료), and the
 * sidebar's 이 PC popover with 앱 종료 / 완전 종료. The band is the window's own (its caption buttons at this zoom). The
 * audit measures in the page; its pictures (CDP) come out cropped at a zoom, the window shots above are the real ones.
 */
async function desktopAudit(page: Page) {
  const band = await page.evaluate(() => {
    const overlay = (navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } })
      .windowControlsOverlay
    const rect = overlay?.getTitlebarAreaRect()
    return rect && rect.width > 0
      ? { right: Math.round(innerWidth - rect.x - rect.width), height: rect.height }
      : undefined
  })
  const out = path.join(shots ?? root, `${label}-ui-audit`)
  const width = await page.evaluate(() => innerWidth)
  const audit = new Audit(
    { outputPath: (...parts: string[]) => path.join(out, ...parts), attach: async () => undefined },
    width,
    ALLOWED,
    band,
    new Set(),
  )
  await audit.check(page, "settings/general")
  await page.getByTestId("settings-nav-desktop").click()
  await page.getByTestId("settings-desktop").waitFor({ timeout: 15_000 })
  await Bun.sleep(1_000)
  await audit.check(page, "settings/desktop")
  await audit.popup(page, "settings/desktop", {
    name: "zoom-bubble",
    open: () => page.getByTestId("zoom-indicator").click(),
    trigger: page.getByTestId("zoom-indicator"),
    popup: page.getByTestId("zoom-bubble"),
  })
  await audit.popup(page, "settings/desktop", {
    name: "server-status",
    open: () => page.getByTestId("server-status-button").first().click(),
    trigger: page.getByTestId("server-status-button").first(),
    popup: page.getByTestId("server-panel"),
  })
  const lines = await audit.write()
  report.uiAudit = { dir: out, lines }
  check("ui-audit.desktop", audit.violations().length === 0)
  for (const item of audit.violations()) log(`ui-audit: ${line(item)}`)
  await page.getByTestId("settings-nav-general").click()
  await Bun.sleep(500)
}

/** Chromium's own per-host zoom levels in the shell's Preferences (sessionData), which own does not rely on. */
function chromiumZoom(strip: boolean) {
  const file = path.join(testRoot, "session", "Preferences")
  try {
    const prefs = JSON.parse(readFileSync(file, "utf8")) as { partition?: { per_host_zoom_levels?: unknown } }
    const levels = prefs.partition?.per_host_zoom_levels
    if (strip && prefs.partition) {
      delete prefs.partition.per_host_zoom_levels
      writeFileSync(file, JSON.stringify(prefs))
    }
    return levels
  } catch {
    return undefined
  }
}

const kept = () => {
  try {
    return (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>).ownZoomFactor
  } catch {
    return undefined
  }
}

try {
  await registerService({
    url: service.url,
    authorization: service.authorization,
    password,
    stateHome: xdg.XDG_STATE_HOME,
    channel: "own",
  })
  installUi(ownHome, { version: shellVersion(), web: args.web, hash: RPC_HASH })

  // ------------------------------------------------------------------ run 1
  const run1 = await launch("run1")
  const base = await zoomNow(run1.page)
  report.base = base
  check("start.default", base.factor === 1 && base.pill === undefined && base.bubble === "closed")
  const dpr0 = base.dpr

  await run1.page.keyboard.press("Control+Equal")
  await Bun.sleep(300)
  const stepped = await zoomNow(run1.page)
  report.stepped = stepped
  run1.winShot("110")
  await Bun.sleep(2_200)
  const settled = await zoomNow(run1.page)
  report.settled = settled
  check(
    "keys.step",
    near(stepped.factor, 1.1) &&
      near(stepped.dpr / dpr0, 1.1) &&
      stepped.pill === "110%" &&
      stepped.bubble === "flash" &&
      settled.bubble === "closed" &&
      stepped.pillRegion === "no-drag" &&
      stepped.pillRight !== undefined &&
      stepped.buttons !== undefined &&
      Math.abs(stepped.pillRight - stepped.buttons) <= 1 &&
      // The header keeps the buttons and the pill free (12 px own padding + buttons + 52).
      stepped.headerPadding !== undefined &&
      Math.abs(stepped.headerPadding - (12 + stepped.buttons + 52)) <= 1,
  )

  await run1.page.getByTestId("zoom-indicator").click()
  await Bun.sleep(200)
  const opened = await zoomNow(run1.page)
  report.opened = opened
  run1.winShot("bubble")
  await run1.page.getByTestId("zoom-bubble-control-in").click()
  await Bun.sleep(300)
  const plus = await zoomNow(run1.page)
  report.plus = plus
  await run1.page.keyboard.press("Escape")
  await Bun.sleep(200)
  const escaped = await zoomNow(run1.page)
  check(
    "bubble.control",
    opened.bubble === "open" &&
      JSON.stringify(opened.control) === JSON.stringify(["−", "110%", "+", "초기화(100%)"]) &&
      near(plus.factor, 1.25) &&
      plus.pill === "125%" &&
      plus.bubble === "open" &&
      escaped.bubble === "closed",
  )

  // Ctrl+wheel through CDP (Chromium may not hand a synthetic wheel to zoom-changed): recorded, not gated.
  const box = await run1.page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight / 2 }))
  await run1.page.mouse.move(box.x, box.y)
  await run1.page.keyboard.down("Control")
  await run1.page.mouse.wheel(0, -120)
  await run1.page.keyboard.up("Control")
  await Bun.sleep(500)
  const wheeled = await zoomNow(run1.page)
  report.wheel = { factor: wheeled.factor, pill: wheeled.pill }
  report.wheelStepped = near(wheeled.factor, 1.5)
  if (!near(wheeled.factor, 1.25)) {
    await run1.page.keyboard.press("Control+Minus")
    await Bun.sleep(300)
  }

  // 설정 > 일반 `화면 크기`.
  await run1.page.keyboard.press("Control+Comma")
  const row = run1.page.getByTestId("settings-zoom")
  await row.waitFor({ timeout: 15_000 })
  await Bun.sleep(2_000)
  const rowBefore = await row.getByTestId("settings-zoom-value").textContent()
  await row.getByTestId("settings-zoom-out").click()
  await Bun.sleep(300)
  const rowAfter = await row.getByTestId("settings-zoom-value").textContent()
  const afterRow = await zoomNow(run1.page)
  report.settings = { rowBefore, rowAfter, afterRow }
  run1.winShot("settings")
  check(
    "settings.row",
    rowBefore === "125%" && rowAfter === "110%" && near(afterRow.factor, 1.1) && afterRow.bubble === "closed",
  )
  await desktopAudit(run1.page)
  report.keptBeforeClose = kept()
  check("kept.file", typeof report.keptBeforeClose === "number" && near(report.keptBeforeClose as number, 1.1))
  report.run1Exit = await stop(run1.browser)

  // ------------------------------------------------------------------ run 2: the same userData
  const run2 = await launch("run2")
  const restored = await zoomNow(run2.page)
  report.restored = { ...restored, first: run2.first }
  run2.winShot("restored")
  const expectBand = Math.max(44, Math.round(44 * 1.1)) / 1.1
  check(
    "restart.restored",
    near(restored.factor, 1.1) &&
      near(restored.dpr / dpr0, 1.1) &&
      run2.first !== undefined &&
      near(run2.first / dpr0, 1.1) &&
      restored.pill === "110%" &&
      restored.band !== undefined &&
      Math.abs(restored.band - expectBand) <= 1,
  )
  await run2.page.keyboard.press("Control+Equal")
  await Bun.sleep(400)
  report.run2Exit = await stop(run2.browser)
  report.keptAfterRun2 = kept()

  // ------------------------------------------------------------------ run 3: Chromium's own zoom memory gone
  // The shell's settings file alone brings the zoom back (Chromium's Preferences can be reset or lost).
  report.chromiumZoomBeforeStrip = chromiumZoom(true)
  const run3 = await launch("run3")
  const fromFile = await zoomNow(run3.page)
  report.fromFile = { ...fromFile, first: run3.first }
  // The work panel pushed open: its head is the band's right part and keeps the pill's place free too.
  if ((await run3.page.getByTestId("app").getAttribute("data-panel")) !== "open")
    await run3.page.keyboard.press("Control+Alt+KeyB")
  await Bun.sleep(600)
  const panel = await run3.page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('[data-testid="app"]')
    const head = document.querySelector<HTMLElement>(".own-panel-head")
    const pill = document.querySelector<HTMLElement>('[data-testid="zoom-indicator"]')?.getBoundingClientRect()
    const overlay = (navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } })
      .windowControlsOverlay
    const band = overlay?.getTitlebarAreaRect().height || 44
    // What the head shows in the band row (its tabs may wrap below it in a narrow panel).
    const inBand = [...(head?.querySelectorAll<HTMLElement>('button, [role="tab"]') ?? [])]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.top < band)
    return {
      mode: app?.dataset.panelMode,
      open: app?.dataset.panel,
      pillLeft: pill ? Math.round(pill.left) : undefined,
      rightmost: inBand.length ? Math.round(Math.max(...inBand.map((rect) => rect.right))) : undefined,
    }
  })
  report.panel = panel
  run3.winShot("panel")
  check(
    "panel.head-keeps-place",
    panel.open === "open" &&
      panel.pillLeft !== undefined &&
      panel.rightmost !== undefined &&
      panel.rightmost <= panel.pillLeft + 1,
  )
  await run3.page.keyboard.press("Control+Digit0")
  await Bun.sleep(400)
  const reset = await zoomNow(run3.page)
  report.reset = reset
  report.keptAfterReset = kept()
  check(
    "restart.from-settings-file",
    near(report.keptAfterRun2 as number, 1.25) &&
      near(fromFile.factor, 1.25) &&
      near(fromFile.dpr / dpr0, 1.25) &&
      fromFile.pill === "125%" &&
      reset.factor === 1 &&
      near(reset.dpr, dpr0) &&
      reset.pill === undefined &&
      report.keptAfterReset === 1,
  )
  report.run3Exit = await stop(run3.browser)
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(`error: ${String(report.error).slice(0, 2_000)}`)
} finally {
  if (shell && alive(shell.pid)) killTree(shell.pid)
  // A killed shell's helpers (crashpad, utility processes) can take a few seconds to go: wait up to 20 s for none.
  for (let tries = 0; tries < 20; tries++) {
    const left = leftovers()
    report.leftoverShells = left.length
    if (left.length === 0) break
    left.forEach(killTree)
    await Bun.sleep(1_000)
  }
  await service.stop().catch(() => undefined)
  await fake.stop().catch(() => undefined)
  if (!appDataExisted) await removeTree(appData)
  report.osArtifactsCreated = removeNewOsArtifacts(machine.os)
  report.trayIconSettingsRemoved = removeNewTrayIconSettings(electronDir, trayIconsBefore)
  check("machine.unchanged", sameMachine(machine, snapshotMachine()))
  check(
    "tray-icon-settings.removed",
    trayIconSettings(electronDir).every((key) => trayIconsBefore.has(key)),
  )
  check("no-shell-left", report.leftoverShells === 0)
  report.checks = checks
  report.shots = shotsTaken
  report.passed = Object.values(checks).every(Boolean) && !report.error
  if (!args.keep) await removeTree(root, 20, 500)
  clearTimeout(watchdog)
  if (shots) writeFileSync(path.join(shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}

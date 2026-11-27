// Smoke run of the packaged shell (win-unpacked, never installed) in an isolated temp root, with before/after checks
// of what must not change on the machine (G-D1, G-D2). Fake credentials only.
//
//   bun scripts/smoke.ts --web <own-web build dir> [--exe <win-unpacked\own-desktop.exe>]
//        [--service dev|launcher] [--opencode <own-channel opencode.exe>] [--ui ok|skew|missing|renderer-skew]
//        [--browser] [--capabilities] [--restart] [--restart-ui] [--window-shot] [--shots <dir>] [--label <name>]
//        [--first-frames] [--seed-background <color>] [--keep]
//
// Layout of the temp root: own\ (OWN_HOME: app\<ver>\{web,manifest.json}, app\current.json, bin\own.ps1,
// control\), config\ (OWN_CONFIG_DIR), xdg\{config,state,data,cache} (XDG_*). The shell starts with exactly these
// variables, so its env snapshot, the launcher and the service all agree on paths (05 §5.2, §11.3).
//  --service dev       own-web's dev service (seeded sessions, fake providers) registered as service-own.json.
//  --service launcher  nothing registered: the shell must run `own.ps1 start` once (05 §5.3), which starts the
//                      own-channel opencode.exe (OWN_OPENCODE_EXE) on a free port. `--restart` then drives
//                      window.own.service.restart({force:true}) and waits for own-web's reconnect; `--restart-ui`
//                      does the same through own-web's settings button (서버 연결 > 서비스 다시 시작, serviceControl).
//  --capabilities      capabilityProbe (probe.ts): host capabilities and adapters, the title bar band across zoom
//                      levels, drag regions, the panel tabs in the band, Ctrl+O's native folder dialog (captured and
//                      cancelled, native-dialog.ps1), the desktop and server settings sections.
//  --ui skew|missing   manifest with another rpcHash / no web: the shell must show its fallback page (G-D6 b, c).
//  --ui renderer-skew  --web built for another contract, manifest matching the shell: own-web must show its own
//                      mismatch screen (05 §5.5 renderer re-check), with the drag band and window.own.support.
//  --first-frames      the window as Windows draws it from the spawn on (first-frames.ps1: native background before
//                      the renderer paints, the page, the caption buttons), to check a start for a light flash and
//                      for caption buttons that do not contrast (src/main/window-tone.ts). Needs an empty userData.
//  --seed-background   an older start's stored window background (opencode.settings `backgroundColor`, e.g. an older
//                      build's `#080808ff`) written into the empty userData first; the run removes it again.
// The packaged app keeps its userData at %APPDATA%\dev.own.opencode.desktop (a packaged exe cannot move it); the run
// copies its logs next to the screenshots and removes the folder again when the run created it.
import { randomBytes } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { startRegisteredDevService, type RegisteredDevService } from "./dev-service"
import { browserPaneProbe, capabilityProbe, connect, marks, probe, shot, waitForMarks } from "./probe"
import {
  alive,
  appDataDir,
  cleanEnv,
  collectLogs,
  freePort,
  installUi,
  killTree,
  removeNewOsArtifacts,
  packagedExe,
  REPO,
  sameMachine,
  shellVersion,
  snapshotMachine,
  windowShot as captureWindow,
  xdgDirs,
  quitShell,
} from "./run-kit"

const args = parseArgs({
  options: {
    exe: { type: "string" },
    web: { type: "string" },
    service: { type: "string", default: "dev" },
    opencode: { type: "string" },
    ui: { type: "string", default: "ok" },
    browser: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
    "restart-ui": { type: "boolean", default: false },
    capabilities: { type: "boolean", default: false },
    "window-shot": { type: "boolean", default: false },
    "first-frames": { type: "boolean", default: false },
    "seed-background": { type: "string" },
    shots: { type: "string" },
    label: { type: "string" },
    keep: { type: "boolean", default: false },
  },
}).values

const exe = packagedExe(args.exe)
if (args.ui !== "missing" && (!args.web || !existsSync(path.join(args.web, "index.html"))))
  throw new Error("--web <own-web build dir with index.html> is required")
const mode = args.service === "launcher" ? "launcher" : "dev"
const label = args.label ?? `packaged-${mode}${args.ui === "ok" ? "" : `-${args.ui}`}`
const version = shellVersion()

const root = path.join(os.tmpdir(), `own-desktop-smoke-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
mkdirSync(configDir, { recursive: true })

// ---------------------------------------------------------------- before

const machine = snapshotMachine()
const report: Record<string, unknown> = { label, exe, mode, ui: args.ui, root, rpcHash: RPC_HASH, before: machine }

// ---------------------------------------------------------------- service and OWN_HOME

let dev: RegisteredDevService | undefined
let ownHome = path.join(root, "own")
let serviceUrl: string | undefined
const extraEnv: Record<string, string> = {}
if (mode === "dev") {
  dev = await startRegisteredDevService({ stateHome: xdg.XDG_STATE_HOME, channel: "own", seed: true })
  ownHome = dev.ownHome
  serviceUrl = dev.service.server.url
  report.service = { url: serviceUrl, version: dev.version, registration: dev.registration }
} else {
  const opencode = args.opencode ?? latestOwnBuild()
  const port = await freePort()
  mkdirSync(path.join(ownHome, "bin"), { recursive: true })
  cpSync(path.join(REPO, "own/launcher/own.ps1"), path.join(ownHome, "bin", "own.ps1"))
  // The launcher keeps port and password from its service config (own.ps1 Write-EnvBridge): a free port here keeps
  // the run off the real own channel port.
  writeFileSync(
    path.join(configDir, "service-own.json"),
    JSON.stringify({ hostname: "127.0.0.1", port, password: randomBytes(24).toString("base64url") }),
  )
  Object.assign(extraEnv, { OWN_OPENCODE_EXE: opencode })
  serviceUrl = `http://127.0.0.1:${port}`
  report.service = { url: serviceUrl, opencode, launcher: path.join(ownHome, "bin", "own.ps1") }
}
mkdirSync(path.join(ownHome, "control"), { recursive: true })
// Manifest with another rpcHash for --ui skew, no web for --ui missing (G-D6 b, c).
installUi(ownHome, {
  version,
  web: args.ui === "missing" ? undefined : args.web,
  hash: args.ui === "skew" ? "0000000000000000" : RPC_HASH,
})

// ---------------------------------------------------------------- run the shell

const appData = appDataDir()
const appDataExisted = existsSync(appData)
if ((args["first-frames"] || args["seed-background"]) && appDataExisted)
  throw new Error(`--first-frames and --seed-background need an empty userData; ${appData} exists (left untouched)`)
report.userData = { path: appData, existedBefore: appDataExisted }
if (args["seed-background"]) {
  mkdirSync(appData, { recursive: true })
  writeFileSync(
    path.join(appData, "opencode.settings"),
    JSON.stringify({ backgroundColor: args["seed-background"] }, null, "\t"),
  )
  report.userData = { ...(report.userData as object), seededBackground: args["seed-background"] }
}
const cdp = await freePort()
const env = cleanEnv({
  ...xdg,
  OWN_HOME: ownHome,
  OWN_CONFIG_DIR: configDir,
  ...extraEnv,
})
const shots = args.shots
const frames = args["first-frames"]
  ? await startFirstFrames(path.join(shots ?? root, `${label}-first-frames`))
  : undefined
const shell = Bun.spawn([exe, `--remote-debugging-port=${cdp}`], {
  env,
  stdout: "ignore",
  stderr: "ignore",
})
frames?.attach(shell.pid)
report.shell = { pid: shell.pid, cdp }
try {
  const { browser, page } = await connect(`http://127.0.0.1:${cdp}`, 120_000)
  try {
    if (args.ui === "renderer-skew") {
      // The manifest matches the shell, the installed own-web was built for another contract: main serves it and
      // own-web's own T0-0 check shows its mismatch screen instead of the app (05 §5.5 "렌더러 재검사").
      await page.waitForSelector('[data-testid="shell-mismatch"]', { timeout: 30_000 })
      const shotsTaken: string[] = []
      await shot(page, shots, `${label}-mismatch`, shotsTaken)
      if (args["window-shot"]) report.windowShot = windowShot(`${label}-mismatch-window`)
      report.mismatch = await supportProbe(page, '[data-testid="shell-mismatch"] [data-action="browser"]')
      report.mismatch = {
        ...(report.mismatch as object),
        text: await page.locator('[data-testid="shell-mismatch"]').textContent(),
        drag: await page
          .locator('[data-testid="shell-mismatch-drag"]')
          .evaluate(
            (element) =>
              getComputedStyle(element).getPropertyValue("-webkit-app-region") || element.getAttribute("style"),
          ),
        buttons: await page
          .locator('[data-testid="shell-mismatch"] [data-action]')
          .evaluateAll((items) => items.map((item) => item.getAttribute("data-action"))),
        app: await page.locator('[data-testid="app"]').count(),
        shots: shotsTaken,
      }
    } else if (args.ui !== "ok") {
      await page.waitForSelector('[data-testid="own-fallback"]', { timeout: 30_000 })
      await page.waitForFunction(() => document.documentElement.dataset.reason, undefined, { timeout: 10_000 })
      const shotsTaken: string[] = []
      await shot(page, shots, `${label}-fallback`, shotsTaken)
      if (args["window-shot"]) report.windowShot = windowShot(`${label}-fallback-window`)
      report.fallback = {
        url: page.url(),
        reason: await page.evaluate(() => document.documentElement.dataset.reason),
        title: await page.locator("#title").textContent(),
        ui: await page.locator("#ui").textContent(),
        app: await page.locator('[data-testid="app"]').count(),
        buttons: await page.locator("button:not([hidden])").evaluateAll((items) => items.map((item) => item.id)),
        shots: shotsTaken,
      }
      if (args.ui === "skew")
        report.fallback = { ...(report.fallback as object), ...(await supportProbe(page, "#browser")) }
    } else {
      report.probe = await probe(page, { shots, label, serviceUrl })
      if (args.browser) report.browserPane = await browserPaneProbe(page, { shots, label })
      if (args["window-shot"]) report.windowShot = windowShot(`${label}-window`)
      if (args.capabilities)
        report.capabilities = await capabilityProbe(page, {
          shots,
          label,
          windowShot: args["window-shot"] ? windowShot : undefined,
          nativeDialog,
        })
      if (args.restart && mode === "launcher") report.restart = await restartProbe(page)
      if (args["restart-ui"] && mode === "launcher") report.restartUi = await restartUiProbe(page)
    }
  } finally {
    await quitShell(page)
    await browser.close().catch(() => undefined)
  }
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
} finally {
  const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) killTree(shell.pid)
  report.shellExit = exited ? "window closed" : "killed"
  if (frames) report.firstFrames = await frames.result
  // What the run left in the settings store: the window background main started with or own-web reported last.
  report.settings = readSettings()
  const logs = collectLogs(shots ? path.join(shots, `${label}-logs`) : undefined)
  if (logs) {
    const { text: _text, ...counts } = logs
    report.logs = counts
  }
  if (dev) await dev.service.stop()
  else report.serviceStop = stopLauncherService()
  if (!appDataExisted) await removeTree(appData)
  report.osArtifactsCreated = removeNewOsArtifacts(machine.os)
  report.after = snapshotMachine()
  report.unchanged = sameMachine(machine, report.after as ReturnType<typeof snapshotMachine>)
  if (!args.keep) await removeTree(root)
  if (shots) writeFileSync(path.join(shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

// ---------------------------------------------------------------- helpers

/**
 * The 5.5 mismatch screens' shell calls (`window.own.support`, 05 §5.6): both exist, and [브라우저로 열기] reaches
 * main and the launcher. Clicked only with `--service dev`, whose OWN_HOME has no own.ps1, so the launcher run fails
 * at once and nothing starts or opens; [로그 폴더] is never clicked (it would open an Explorer window).
 */
async function supportProbe(page: Awaited<ReturnType<typeof connect>>["page"], browserButton: string) {
  const support = await page.evaluate(() => {
    const own = (window as { own?: { support?: Record<string, unknown> } }).own
    return {
      openLogs: typeof own?.support?.openLogs === "function",
      openInBrowser: typeof own?.support?.openInBrowser === "function",
    }
  })
  if (mode !== "dev") return { support, clicked: false }
  await page.locator(browserButton).click()
  const status = page.locator('[role="status"]').first()
  await page.waitForFunction(
    (selector) => {
      const text = document.querySelector(selector)?.textContent ?? ""
      return text.length > 0 && !text.includes("여는 중")
    },
    '[role="status"]',
    { timeout: 90_000 },
  )
  return { support, clicked: true, status: (await status.textContent())?.slice(0, 300) }
}

async function restartProbe(page: Awaited<ReturnType<typeof connect>>["page"]) {
  const before = registration()
  const result = await page.evaluate(() =>
    (window as { own?: { service: { restart(input: { force: boolean }): Promise<unknown> } } }).own?.service.restart({
      force: true,
    }),
  )
  await waitForMarks(page, ["own:t0:reconnect"], 90_000).catch(() => undefined)
  const after = registration()
  const status = await page.evaluate(() =>
    (window as { own?: { service: { status(): Promise<unknown> } } }).own?.service.status(),
  )
  const shotsTaken: string[] = []
  await Bun.sleep(1_000)
  await shot(page, shots, `${label}-after-restart`, shotsTaken)
  return { result, pidBefore: before?.pid, pidAfter: after?.pid, status, marks: await marks(page), shots: shotsTaken }
}

/** Settings > 서버 연결 > 서비스 다시 시작: host.service.restart({force:false}) from own-web's own button. */
async function restartUiProbe(page: Awaited<ReturnType<typeof connect>>["page"]) {
  const before = registration()
  const reconnects = await page.evaluate(() => performance.getEntriesByName("own:t0:reconnect", "mark").length)
  if (
    !(await page
      .locator('[data-testid="page-settings"]')
      .isVisible()
      .catch(() => false))
  )
    await page.keyboard.press("Control+Comma")
  await page.locator('[data-testid="page-settings"] nav a', { hasText: "서버 연결" }).first().click()
  const button = page.getByRole("button", { name: "서비스 다시 시작" })
  await button.waitFor({ timeout: 10_000 })
  await button.click()
  await page.waitForFunction(
    (count) => performance.getEntriesByName("own:t0:reconnect", "mark").length > count,
    reconnects,
    { timeout: 90_000, polling: 250 },
  )
  await Bun.sleep(1_500)
  const after = registration()
  const shotsTaken: string[] = []
  await shot(page, shots, `${label}-after-restart-ui`, shotsTaken)
  return {
    pidBefore: before?.pid,
    pidAfter: after?.pid,
    reconnectMarks: await page.evaluate(() => performance.getEntriesByName("own:t0:reconnect", "mark").length),
    status: await page.evaluate(() =>
      (window as { own?: { service: { status(): Promise<unknown> } } }).own?.service.status(),
    ),
    shots: shotsTaken,
  }
}

/** Ctrl+O's native folder dialog: captured, then cancelled (native-dialog.ps1). Nothing is chosen. */
async function nativeDialog(name: string) {
  const out = shots ? path.join(shots, `${name}.png`) : path.join(root, `${name}.png`)
  const run = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, "native-dialog.ps1"),
      "-ProcessId",
      String(shell.pid),
      "-Out",
      out,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
  await run.exited
  try {
    return JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "")
  } catch {
    return { error: `${stdout} ${stderr}`.trim().slice(0, 400) }
  }
}

/** The whole window as Windows draws it: WCO buttons and native browser views included (capture-window.ps1). */
function windowShot(name: string) {
  if (!shots) return undefined
  return captureWindow(shell.pid, path.join(shots, `${name}.png`))
}

/**
 * first-frames.ps1, compiled and waiting before the shell is spawned; `attach(pid)` starts the capture, which runs
 * for `durationMs` after it. `result` is its JSON summary (or the error).
 */
async function startFirstFrames(out: string, durationMs = 6_000) {
  const run = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, "first-frames.ps1"),
      "-Out",
      out,
      "-DurationMs",
      String(durationMs),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const reader = run.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 60_000
  while (!text.includes("ready")) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined),
    ])
    if (!next || next.done) {
      killTree(run.pid)
      throw new Error(`first-frames.ps1 did not start: ${text} ${await new Response(run.stderr).text()}`.trim())
    }
    text += decoder.decode(next.value, { stream: true })
  }
  const rest = (async () => {
    for (let next = await reader.read(); !next.done; next = await reader.read())
      text += decoder.decode(next.value, { stream: true })
  })()
  return {
    attach(pid: number) {
      run.stdin.write(`${pid}\n`)
      void run.stdin.end()
    },
    result: (async () => {
      const exited = await Promise.race([run.exited.then(() => true), Bun.sleep(durationMs + 60_000).then(() => false)])
      if (!exited) killTree(run.pid)
      await rest.catch(() => undefined)
      const stderr = await new Response(run.stderr).text().catch(() => "")
      try {
        return { out, ...JSON.parse(text.trim().split(/\r?\n/).pop() ?? "") }
      } catch {
        return { out, error: `${text} ${stderr}`.trim().slice(0, 600) }
      }
    })(),
  }
}

function readSettings() {
  try {
    const settings: Record<string, unknown> = JSON.parse(readFileSync(path.join(appData, "opencode.settings"), "utf8"))
    return { backgroundColor: settings.backgroundColor }
  } catch {
    return undefined
  }
}

function registration() {
  const file = path.join(xdg.XDG_STATE_HOME, "opencode", "service-own.json")
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { pid?: number; url?: string; version?: string }
  } catch {
    return undefined
  }
}

/** `own.ps1 stop --force` with the run's env, then make sure the registered pid is gone. */
function stopLauncherService() {
  const before = registration()
  const launcher = path.join(ownHome, "bin", "own.ps1")
  const stop = Bun.spawnSync(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "stop", "--force"],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  let killed = false
  if (before?.pid && alive(before.pid)) {
    killTree(before.pid)
    killed = true
  }
  return { code: stop.exitCode, pid: before?.pid, stillAlive: before?.pid ? alive(before.pid) : false, killed }
}

function latestOwnBuild() {
  const builds = path.join(REPO, "own/.out/build")
  const found = [...new Bun.Glob("*/cli-windows-x64/bin/opencode.exe").scanSync({ cwd: builds })].sort().pop()
  if (!found)
    throw new Error("no own-channel build under own/.out/build (own/scripts/build-own.ps1), or pass --opencode")
  return path.join(builds, found)
}

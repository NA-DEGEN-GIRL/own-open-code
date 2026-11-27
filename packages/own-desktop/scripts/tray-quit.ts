// Tray and quit on the built shell (05 §7.3, never installed): `out/` (`bun run build`) unpackaged on the workspace's
// Electron with OPENCODE_DESKTOP_TEST_ROOT, so userData (the settings store with the close action) is the temp root's
// and never the installed app's `%APPDATA%\dev.own.opencode.desktop`. The service is a stand-in in this process,
// registered in a temp XDG_STATE_HOME; the launcher is the repository's own.ps1 in a temp OWN_HOME, with a fake
// opencode.cmd (OWN_OPENCODE_EXE) whose `service stop` stops the stand-in; the UI is a one-line page installed as
// app\<version>\web. The user's own service, its registration and the installed app are never touched
// (snapshotMachine before and after).
//
// Nothing shows on the user's screen: OWN_DESKTOP_TEST_RUN (this process's pid) makes the development shell put every
// window off the screen and the taskbar, and exit by itself when this process is gone. With OWN_DESKTOP_TEST_ANSWER
// (a button label this run writes) 완전 종료's question is answered from that file instead of a message box, which
// Windows keeps on a monitor; the question goes to the shell's log, where the run reads it. The tray icon is clicked
// through the shell's own notify-icon host window, never through the taskbar, and never right-clicked (its menu would
// open at the mouse). The one-time hint, a Windows notification, is marked as shown first. Every shell ends through the app's own quit (never the X, which now hides); one still
// alive at the end is quit, then killed, and no electron.exe of this worktree may remain. Hard limit: 4 minutes.
//
//   bun scripts/tray-quit.ts [--keep]
//
// Checks:
//  run 1: the tray is up; the installed page (not the not-installed one) is off the screen; the X hides the last
//   window and the shell lives on, a minimized one too (the taskbar's 창 닫기); tray click, double-click and a second start show it again; in the tray, a log-off
//   query (WM_QUERYENDSESSION) is answered "yes" by every window; 완전 종료 from the page names the 2 running
//   conversations and the remote access, 취소 keeps everything, 앱만 종료 quits the shell and keeps the service.
//  run 2: the close action is stored (`quit`, back to `tray`); 완전 종료 runs `own.ps1 stop --force` → the fake
//   `opencode service stop`: the stand-in stops and unregisters, the shell exits and starts nothing again.
//  run 3: a log-off (WM_ENDSESSION) is answered at once.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Browser, Page } from "@playwright/test"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { connect } from "./probe"
import {
  alive,
  cleanEnv,
  installUi,
  killTree,
  PACKAGE,
  REPO,
  removeNewTrayIconSettings,
  sameMachine,
  snapshotMachine,
  trayIconSettings,
  xdgDirs,
} from "./run-kit"

const args = parseArgs({ options: { keep: { type: "boolean", default: false } } }).values
const VERSION = "2.0.24-own.0"
const TITLE = "tray-quit 시험 창"
const electron = path.join(PACKAGE, "node_modules", "electron", "dist", "electron.exe")
if (!existsSync(electron)) throw new Error(`${electron} is missing (node install.js in the electron package)`)
/**
 * This worktree's Electron folder as Windows names its processes and tray icons: node_modules/electron is a link into
 * bun's store, and a process's ExecutablePath is the real path.
 */
const electronDir = realpathSync(path.dirname(electron))
if (!existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("out/ is missing (bun run build)")

const checks: Record<string, boolean> = {}
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = ok
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 300)}`}`,
  )
}
const log = (message: string) => console.log(`[tray-quit] ${message}`)

const before = snapshotMachine()
const iconSettingsBefore = new Set(trayIconSettings(electronDir))
const root = mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "tq-"))
const ownHome = path.join(root, "own")
const xdg = xdgDirs(root)
const testRoot = path.join(root, "desktop")
const userData = path.join(testRoot, "desktop")
const fakeLog = path.join(root, "opencode.log")
const answerFile = path.join(root, "answer.txt")
const registration = path.join(xdg.XDG_STATE_HOME, "opencode", "service-own.json")
for (const dir of [
  path.join(ownHome, "bin"),
  path.join(root, "config"),
  userData,
  path.join(root, "tmp"),
  path.join(root, "web"),
])
  mkdirSync(dir, { recursive: true })
cpSync(path.join(REPO, "own", "launcher", "own.ps1"), path.join(ownHome, "bin", "own.ps1"))
writeFileSync(
  path.join(root, "web", "index.html"),
  `<!doctype html><meta charset="utf-8"><title>${TITLE}</title><p>tray-quit`,
)
installUi(ownHome, { version: VERSION, web: path.join(root, "web"), hash: RPC_HASH })
// Remote access on, so 완전 종료 names the phones and other PCs.
writeFileSync(
  path.join(ownHome, "gateway.json"),
  JSON.stringify({ version: 1, enabled: true, bind: "127.0.0.1", port: 7149, publicOrigin: null, updatedAt: 0 }),
)
writeFileSync(path.join(userData, "opencode.settings"), JSON.stringify({ ownTrayHintShown: true }))

const port = await freeTestPort()
const exe = path.join(root, "bin", "opencode.cmd")
mkdirSync(path.dirname(exe), { recursive: true })
writeFileSync(
  exe,
  [
    "@echo off",
    'echo %*>>"%OWN_FAKE_LOG%"',
    'if "%~1"=="--version" (',
    `  echo opencode ${VERSION}`,
    "  exit /b 0",
    ")",
    'if "%~1 %~2"=="service stop" "%SystemRoot%\\System32\\curl.exe" -s -X POST http://127.0.0.1:%OWN_FAKE_PORT%/shutdown >nul',
    "exit /b 0",
    "",
  ].join("\r\n"),
)

/** The service stand-in: /api/info with this process's pid (the launcher and discover check it), 2 running sessions. */
const stand = { stops: 0, running: true }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/info") return Response.json({ pid: process.pid, version: VERSION })
    if (url.pathname === "/api/session/active") return Response.json({ data: { ses_a: {}, ses_b: {} } })
    if (url.pathname === "/shutdown" && request.method === "POST") {
      stand.stops++
      stand.running = false
      rmSync(registration, { force: true })
      return new Response("bye")
    }
    return new Response("not found", { status: 404 })
  },
})
/** The stand-in's registration, as a starting service writes it. */
function register() {
  mkdirSync(path.dirname(registration), { recursive: true })
  writeFileSync(
    registration,
    JSON.stringify({
      id: "tray-quit",
      version: VERSION,
      url: `http://127.0.0.1:${port}`,
      pid: process.pid,
      password: "x",
    }),
  )
  stand.running = true
}
register()

const env = (() => {
  const base = cleanEnv({
    ...xdg,
    OWN_HOME: ownHome,
    OWN_CONFIG_DIR: path.join(root, "config"),
    OWN_OPENCODE_EXE: exe,
    OWN_FAKE_LOG: fakeLog,
    OWN_FAKE_PORT: String(port),
    OWN_DESKTOP_TEST_RUN: String(process.pid),
    OWN_DESKTOP_TEST_ANSWER: answerFile,
    OPENCODE_DESKTOP_TEST_ROOT: testRoot,
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
  })
  // Like a start from Explorer: no PowerShell 7 module path for the launcher's Windows PowerShell.
  delete base.PSModulePath
  return base
})()

type Shell = { readonly process: ReturnType<typeof Bun.spawn>; readonly browser: Browser; readonly page: Page }
const shells: Shell[] = []
let finished = false
const watchdog = setTimeout(() => {
  log("watchdog: 4 minutes are up; stopping everything")
  for (const shell of shells) killTree(shell.process.pid)
  process.exit(2)
}, 4 * 60_000)

/** tray-input.ps1 (or window-input.ps1), asynchronously: the stand-in service answers from this process while it runs. */
async function ps(pid: number, action: string, extra: string[] = [], script = "tray-input.ps1") {
  const run = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, script),
      "-ProcessId",
      String(pid),
      "-Action",
      action,
      ...extra,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(run.stdout),
    Bun.readableStreamToText(run.stderr),
  ])
  await run.exited
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? ""
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return { ok: false, raw: line, stderr: stderr.trim().slice(-400) }
  }
}

/** The app window (the installed page's title): shown, and where. */
async function appWindow(pid: number) {
  const windows = ((await ps(pid, "windows")).windows ?? []) as { title: string; visible: boolean; left: number }[]
  return windows.find((window) => window.title === TITLE)
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await Bun.sleep(300)
  }
}

const logFolders = () =>
  new Set(existsSync(path.join(userData, "logs")) ? readdirSync(path.join(userData, "logs")) : [])

/** main.log and own.log of the shell runs that started after `earlier` (userData\logs\<start time>\). */
function runLog(earlier: ReadonlySet<string>) {
  return [...logFolders()]
    .filter((folder) => !earlier.has(folder))
    .flatMap((folder) => ["main.log", "own.log"].map((file) => path.join(userData, "logs", folder, file)))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
}

async function launch(label: string) {
  const cdp = await freeTestPort(port + 1)
  const earlier = logFolders()
  const child = Bun.spawn([electron, PACKAGE], {
    env: { ...env, OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdp) },
    stdout: "ignore",
    stderr: "ignore",
  })
  const { browser, page } = await connect(`http://127.0.0.1:${cdp}`, 60_000)
  const shell = { process: child, browser, page }
  shells.push(shell)
  check(`${label}.tray-ready`, await until(() => runLog(earlier).includes("tray ready"), 30_000))
  return { ...shell, log: () => runLog(earlier) }
}

type OwnWindow = {
  own: {
    shell: { renderer: Promise<{ source: string }> }
    app: {
      quit(mode: string): Promise<boolean>
      closeAction(): Promise<string>
      setCloseAction(action: string): Promise<string>
    }
  }
}

/** 완전 종료's question as the shell logged it, once `count` questions were asked in this run. */
async function question(log: () => string, count: number) {
  const asked = () => log().split("quit: test answer").slice(1)
  await until(() => asked().length >= count, 15_000)
  return asked()[count - 1] ?? ""
}

/** The app's own 앱 종료 or 완전 종료 from the page; the page goes away with the shell, so nothing is awaited. */
function quitFromPage(page: Page, mode: "app" | "all") {
  void page.evaluate((value) => void (window as unknown as OwnWindow).own.app.quit(value), mode).catch(() => undefined)
}

const exited = (child: ReturnType<typeof Bun.spawn>, timeoutMs = 20_000) =>
  Promise.race([child.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)])

let failed: unknown
try {
  // ---------------------------------------------------------------- run 1
  log("run 1: hide and show again, log-off query, 완전 종료 → 취소, 완전 종료 → 앱만 종료")
  {
    const shell = await launch("run1")
    const pid = shell.process.pid
    const page = shell.page
    const state = await page.evaluate(async () => {
      const own = (window as unknown as OwnWindow).own
      return { renderer: (await own.shell.renderer).source, action: await own.app.closeAction() }
    })
    check("run1.installed-page-and-app-api", state.renderer === "installed" && state.action === "tray", state)
    const shown = async () => (await appWindow(pid))?.visible === true
    const hidden = async () => (await appWindow(pid))?.visible === false
    check(
      "run1.window-off-screen",
      await until(async () => ((await appWindow(pid))?.left ?? 0) < -10_000 && (await shown())),
      await appWindow(pid),
    )

    await ps(pid, "close", ["-Title", TITLE])
    check("x.hides-to-tray", (await until(hidden)) && alive(pid) && shell.log().includes("window hidden to the tray"))
    check("x.page-lives-on", (await page.evaluate(() => document.title).catch(() => "")) === TITLE)
    await ps(pid, "tray", ["-Mouse", "click"])
    check("tray.click-shows", await until(shown))
    // Electron calls a minimized window not visible: its X (the taskbar's 창 닫기) quit the app instead (2026-11-20).
    const minimized = await ps(pid, "minimize", [], "window-input.ps1")
    await ps(pid, "close", ["-Title", TITLE])
    check(
      "x.minimized-hides-to-tray",
      minimized.iconic === true &&
        (await until(hidden)) &&
        alive(pid) &&
        shell.log().includes("window hidden to the tray { minimized: true }"),
      minimized,
    )
    await ps(pid, "tray", ["-Mouse", "click"])
    check("tray.click-shows-the-minimized-one", await until(shown))
    await ps(pid, "close", ["-Title", TITLE])
    await until(hidden)
    await ps(pid, "tray", ["-Mouse", "dblclick"])
    check("tray.double-click-shows", await until(shown))
    await ps(pid, "close", ["-Title", TITLE])
    await until(hidden)
    const second = Bun.spawn([electron, PACKAGE], {
      env: { ...env, OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(await freeTestPort(port + 20)) },
      stdout: "ignore",
      stderr: "ignore",
    })
    check("second-start.shows-the-hidden-window", (await exited(second)) && (await until(shown)))

    await ps(pid, "close", ["-Title", TITLE])
    await until(hidden)
    const query = await ps(pid, "session", ["-Message", "query"])
    const answers = (query.answers ?? []) as { answered: boolean; allows: boolean }[]
    check(
      "log-off-query.not-blocked-from-the-tray",
      answers.length > 0 && answers.every((answer) => answer.answered && answer.allows),
      { windows: answers.length },
    )
    await ps(pid, "tray", ["-Mouse", "click"])
    await until(shown)

    writeFileSync(answerFile, "취소")
    quitFromPage(page, "all")
    const text = await question(shell.log, 1)
    check(
      "full-quit.question-names-what-stops",
      text.includes("완전 종료할까요?") &&
        text.includes("실행 중인 대화 2개") &&
        text.includes("휴대폰과 다른 PC") &&
        /'완전 종료',\s*'앱만 종료',\s*'취소'/.test(text),
      text.slice(0, 300),
    )
    await Bun.sleep(1_500)
    check("full-quit.cancel-keeps-all", alive(pid) && (await shown()) && stand.running && stand.stops === 0)

    writeFileSync(answerFile, "앱만 종료")
    quitFromPage(page, "all")
    await question(shell.log, 2)
    await shell.browser.close().catch(() => undefined)
    check("full-quit.app-only-quits-the-shell", await exited(shell.process))
    check("full-quit.app-only-keeps-the-service", stand.running && stand.stops === 0 && existsSync(registration))
  }

  // ---------------------------------------------------------------- run 2
  log("run 2: close action stored, 완전 종료 → 완전 종료")
  {
    const shell = await launch("run2")
    const pid = shell.process.pid
    const set = await shell.page.evaluate(async () => {
      const app = (window as unknown as OwnWindow).own.app
      return [await app.setCloseAction("quit"), await app.setCloseAction("tray"), await app.closeAction()]
    })
    const stored = JSON.parse(readFileSync(path.join(userData, "opencode.settings"), "utf8")) as Record<string, unknown>
    check(
      "close-action.stored",
      JSON.stringify(set) === '["quit","tray","tray"]' && stored.ownCloseAction === "tray",
      set,
    )
    writeFileSync(answerFile, "완전 종료")
    quitFromPage(shell.page, "all")
    const asked = await question(shell.log, 1)
    await shell.browser.close().catch(() => undefined)
    const gone = await exited(shell.process, 30_000)
    const calls = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : ""
    check(
      "full-quit.stops-through-the-launcher",
      asked.includes("완전 종료할까요?") && stand.stops === 1 && /service stop/.test(calls),
      {
        stops: stand.stops,
        calls: calls.split(/\r?\n/).filter(Boolean),
      },
    )
    check("full-quit.launcher-args", /launcher stop --force \{[\s\S]{0,800}?'stop',\s*'--force'/.test(shell.log()))
    check("full-quit.unregistered-and-shell-gone", gone && !existsSync(registration) && !stand.running)
    await Bun.sleep(2_000)
    check(
      "full-quit.nothing-started-again",
      !/service start/.test(calls) && !shell.log().includes("starting the service through the launcher"),
    )
  }

  // ---------------------------------------------------------------- run 3
  // Windows ends the process right after WM_ENDSESSION; here the app's own quit stands in for that.
  log("run 3: log-off (WM_ENDSESSION) is answered at once")
  {
    register()
    const shell = await launch("run3")
    const end = await ps(shell.process.pid, "session", ["-Message", "end"])
    const ended = (end.answers ?? []) as { answered: boolean }[]
    check("log-off.answered", ended.length > 0 && ended.every((answer) => answer.answered), { windows: ended.length })
    quitFromPage(shell.page, "app")
    await shell.browser.close().catch(() => undefined)
    check("log-off.then-quits", await exited(shell.process))
  }
  finished = true
} catch (error) {
  failed = error
  check("walkthrough completed", false, error instanceof Error ? error.message : String(error))
} finally {
  clearTimeout(watchdog)
  // A shell still running is quit the app's way first (its tray icon goes with it), then killed.
  for (const shell of shells.filter((item) => alive(item.process.pid))) {
    quitFromPage(shell.page, "app")
    if (!(await exited(shell.process, 10_000))) killTree(shell.process.pid)
    await shell.browser.close().catch(() => undefined)
  }
  server.stop(true)
  const left = worktreeElectrons()
  left.forEach((pid) => killTree(pid))
  check("no electron.exe of this worktree left", left.length === 0, left)
  // Windows remembers every tray icon's program (HKCU\Control Panel\NotifyIconSettings); the run's own entry goes.
  const icons = removeNewTrayIconSettings(electronDir, iconSettingsBefore)
  check(
    "tray icon settings of the run removed",
    trayIconSettings(electronDir).every((key) => iconSettingsBefore.has(key)),
    icons,
  )
  check("machine unchanged (user registration, protocol keys, OS artifacts)", sameMachine(before, snapshotMachine()))
  if (args.keep) log(`kept ${root}`)
  else {
    await Bun.sleep(1_000)
    await removeTree(root, 20, 250)
  }
}

const passed = finished && Object.values(checks).every(Boolean)
console.log(JSON.stringify({ passed, checks, failed: failed ? String(failed) : undefined }))
process.exit(passed ? 0 : 1)

/** A free port in 7100–7149, the range automated shell runs use. */
async function freeTestPort(from = 7100) {
  for (let candidate = from; candidate < 7150; candidate++) {
    const free = await new Promise<boolean>((resolve) => {
      Bun.listen({ hostname: "127.0.0.1", port: candidate, socket: { data() {} } }).stop(true)
      resolve(true)
    }).catch(() => false)
    if (free) return candidate
  }
  throw new Error("no free port in 7100-7149")
}

function powershell(command: string) {
  const run = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  return run.stdout.toString().trim()
}

/** electron.exe processes started from this worktree's Electron (never another checkout's or the installed app). */
function worktreeElectrons() {
  return powershell(
    `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${electronDir.replaceAll("'", "''")}', 'OrdinalIgnoreCase') } | ForEach-Object { $_.ProcessId }) -join ','`,
  )
    .split(",")
    .filter(Boolean)
    .map(Number)
}

// Desktop release gates on the packaged shell (win-unpacked, never installed) through the real launcher path
// (own.ps1 start → own-channel opencode.exe service) with fake providers, in one temp root: G-D1, G-D2, G-D3 (a, c,
// d, f), G-D4, G-D6 (d) and the restore/reload half of G-D6 (01 §16.2, 05 §14.1). G-D5 is browser-agent.ts, G-D6
// (b, c) is smoke.ts --ui skew|missing, PF1/PF6/PF8 is perf-shell.ts.
//
//   bun scripts/gates.ts --out <build-desktop.ps1 output, e.g. own/.out/build/2.0.18-own.0> [--shots <dir>]
//        [--label gates] [--keep] [--no-keys] [--no-clipboard]
//   (or --exe <win-unpacked\own-desktop.exe> --web <own-web build> --opencode <own-channel opencode.exe>)
//
// Temp root: own\ (OWN_HOME: bin\own.ps1, app\<ver>\{web,manifest.json}, app\current.json), config\
// (OWN_CONFIG_DIR: opencode.jsonc with two fake OpenAI providers and `shell: ask`, service-own.json with a free port),
// xdg\{config,state,data,cache}, workspace\. The shell gets exactly these variables (05 §11.3). The packaged app keeps
// userData in %APPDATA%\dev.own.opencode.desktop; the run removes it again when it created it.
//
// G-D1 stand-in: fake-upstream-service.ts runs as a separate process and registers itself as
// <temp XDG_STATE_HOME>\opencode\service.json with another version. The shell must never touch it: its file hash and
// mtime stay, its pid lives, and it receives zero requests. The real ~/.local/state/opencode files are compared too.
//
// Scenarios:
//  run 1 (no service yet): the shell starts the launcher exactly once (G-D1).
//   G-D3 (c)  real key presses (window-input.ps1, only while the shell's window is in the foreground): Ctrl+W, Ctrl+R,
//             Ctrl+Shift+I close, reload and open nothing; Ctrl+-/Ctrl+=/Ctrl+0 zoom through window.zoom and the WCO
//             band follows (height max(44, 44·z) DIP, upstream windows/defaults.ts).
//   G-D3 (d)  composer Ctrl+A/C/X/V/Z with real key presses; the user's clipboard text is saved and restored, and the
//             step is skipped when the clipboard holds anything but text.
//   G-D4      window minimized, a turn asks for `shell` permission: own-web's approval notification is delivered as a
//             Windows toast under AUMID dev.own.opencode.desktop (Action Center history), without action buttons;
//             its click (the page's Notification onclick, which Electron calls for a toast click) shows the window
//             and opens the session. The run's toasts are removed from the Action Center afterwards.
//   G-D3 (f)  during a 60 s streaming turn: host.service.restart({force:false}) → {ok:false, refused:"session_running"},
//             service pid unchanged.
//   G-D3 (a)  still streaming: the window is closed (WM_CLOSE) and goes to the tray (05 §7.3), 앱 종료 ends the shell;
//             the service and the turn go on.
//  run 2 (60 s after the close, service running): no launcher start (G-D1), same service pid, the window comes back
//   on the same session route with the finished answer (G-D3 a, G-D6 restore); a reload keeps the route with no 404
//   (G-D6); app\current.json is switched to a UI with another rpcHash and the window reloaded: own-web's
//   mismatch screen (with its drag band), no IPC client run, no crash, then switched back (G-D6 d);
//   restart({force:true}) reconnects with one launcher restart (G-D1 reconnect).
//  G-D2: HKCU\Software\Classes\{opencode, own, dev.own.opencode.desktop}, the AUMID and notification-settings keys,
//   Start-menu shortcuts and the Documents folder listing are the same before and after; the build's static checks
//   (desktop-build.json) are copied into the report.
import { createHash, randomBytes } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Browser, Page } from "@playwright/test"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../own-accounts/test/e2e-kit/fakes/shared"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { startStreamProvider } from "../../own-web/e2e/performance/fixture/stream-provider"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { cdpTargets, rawCdp } from "./cdp-raw"
import { connect, marks, shot, waitForMarks } from "./probe"
import {
  alive,
  appDataDir,
  cleanEnv,
  collectLogs,
  freePort,
  installUi,
  killTree,
  pointAt,
  REPO,
  removeNewOsArtifacts,
  snapshotMachine,
  windowShot,
  xdgDirs,
  quitShell,
} from "./run-kit"

const args = parseArgs({
  options: {
    out: { type: "string" },
    exe: { type: "string" },
    web: { type: "string" },
    opencode: { type: "string" },
    shots: { type: "string" },
    label: { type: "string", default: "gates" },
    keep: { type: "boolean", default: false },
    "no-keys": { type: "boolean", default: false },
    "no-clipboard": { type: "boolean", default: false },
    "cdp-keys": { type: "boolean", default: false },
  },
}).values

const out = args.out ? path.resolve(args.out) : undefined
const exe = args.exe ?? (out ? path.join(out, "desktop", "win-unpacked", "own-desktop.exe") : undefined)
const web = args.web ?? (out ? path.join(out, "web") : undefined)
const opencode = args.opencode ?? (out ? path.join(out, "cli-windows-x64", "bin", "opencode.exe") : undefined)
for (const [name, file] of [
  ["--exe", exe],
  ["--web", web && path.join(web, "index.html")],
  ["--opencode", opencode],
] as const)
  if (!file || !existsSync(file)) throw new Error(`${name}: ${file ?? "missing"} not found (build-desktop.ps1 --out)`)
const version = out
  ? (JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as { version: string }).version
  : (JSON.parse(readFileSync(path.join(REPO, "packages/own-desktop/package.json"), "utf8")) as { version: string })
      .version
const label = args.label!
const shots = args.shots
if (shots) mkdirSync(shots, { recursive: true })
const AUMID = "dev.own.opencode.desktop"
const MODEL = "gpt-5.5"

const report: Record<string, unknown> = { label, exe, web, opencode, version, rpcHash: RPC_HASH }
const checks: Record<string, boolean> = {}
const notes: Record<string, string> = {}
const shotsTaken: string[] = []
const check = (name: string, value: boolean, note?: string) => {
  checks[name] = value
  if (note) notes[name] = note
  console.error(`[gates] ${value ? "PASS" : "FAIL"} ${name}${note ? ` (${note})` : ""}`)
}
const log = (message: string) => console.error(`[gates] ${message}`)

// ---------------------------------------------------------------- temp root

const root = path.join(os.tmpdir(), `own-desktop-gates-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const ownHome = path.join(root, "own")
const configDir = path.join(root, "config")
const workspace = path.join(root, "workspace")
for (const dir of [ownHome, configDir, workspace, path.join(ownHome, "bin"), path.join(ownHome, "control")])
  mkdirSync(dir, { recursive: true })
cpSync(path.join(REPO, "own/launcher/own.ps1"), path.join(ownHome, "bin", "own.ps1"))
installUi(ownHome, { version, web, hash: RPC_HASH })

// ---------------------------------------------------------------- machine state (G-D1, G-D2)

function regKey(name: string) {
  return (
    Bun.spawnSync(["reg", "query", name], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0
  )
}
function listing(dir: string) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}
function shortcuts() {
  const programs = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs")
  return listing(programs).filter((name) => /own|opencode/i.test(name))
}
function machineState() {
  return {
    ...snapshotMachine(),
    hkcuAppKey: regKey("HKCU\\Software\\Classes\\dev.own.opencode.desktop"),
    hkcuAumid: regKey(`HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`),
    notificationSettings: regKey(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`),
    uninstallKey: regKey(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${AUMID}`),
    startMenu: shortcuts(),
    documents: listing(path.join(os.homedir(), "Documents")),
    oneDriveDocuments: listing(path.join(os.homedir(), "OneDrive", "Documents")),
  }
}
const machineBefore = machineState()
report.before = machineBefore

function fileState(file: string) {
  if (!existsSync(file)) return { exists: false }
  return {
    exists: true,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16),
    mtimeMs: statSync(file).mtimeMs,
  }
}

// ---------------------------------------------------------------- fakes: providers and an "upstream service"

const toolRequests: string[] = []
const tools = startFakeOpenAIResponses({
  models: [MODEL],
  responder(request: RecordedRequest): Reply | undefined {
    if (request.body.includes("You name conversations so the user can find them later")) return { type: "text", text: "게이트 시험" }
    const input = (request.json as { input?: unknown })?.input
    const last = Array.isArray(input) ? JSON.stringify(input.at(-1) ?? "") : ""
    toolRequests.push(last.slice(0, 120))
    if (last.includes("[gate:ask]") && !last.includes("function_call_output"))
      return { type: "tool-call", name: "shell", input: { command: "echo own-gate" } }
    return { type: "text", text: "확인했습니다." }
  },
})
const stream = startStreamProvider({ models: [MODEL] })
const upstreamProc = Bun.spawn(
  [process.execPath, path.join(import.meta.dir, "fake-upstream-service.ts"), "--state", xdg.XDG_STATE_HOME],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
)
const upstreamLine = await readFirstLine(upstreamProc.stdout)
const upstream = JSON.parse(upstreamLine) as { url: string; pid: number; registration: string }
const upstreamBefore = fileState(upstream.registration)
report.upstream = { ...upstream, before: upstreamBefore }

// ---------------------------------------------------------------- service config (launcher mode)

const servicePort = await freePort()
writeFileSync(
  path.join(configDir, "service-own.json"),
  JSON.stringify({ hostname: "127.0.0.1", port: servicePort, password: randomBytes(24).toString("base64url") }),
)
const provider = (name: string, baseURL: string, key: string) => ({
  name,
  package: "@opencode/ai/providers/openai",
  settings: { baseURL, apiKey: key },
  models: { [MODEL]: { name: MODEL } },
})
writeFileSync(
  path.join(configDir, "opencode.jsonc"),
  JSON.stringify(
    {
      update: "disable",
      share: "disabled",
      model: `fake/${MODEL}`,
      providers: {
        fake: provider("Fake tools", tools.baseURL, "sk-fake-own-gates-tools-000000000001"),
        stream: provider("Fake stream", stream.baseURL, "sk-fake-own-gates-stream-00000000001"),
      },
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
      compaction: { auto: false },
    },
    null,
    2,
  ),
)

const env = cleanEnv({ ...xdg, OWN_HOME: ownHome, OWN_CONFIG_DIR: configDir, OWN_OPENCODE_EXE: opencode! })
const registrationFile = path.join(xdg.XDG_STATE_HOME, "opencode", "service-own.json")
const registration = () => {
  try {
    return JSON.parse(readFileSync(registrationFile, "utf8")) as { pid?: number; url?: string; password?: string }
  } catch {
    return undefined
  }
}
async function api(method: string, route: string, body?: unknown) {
  const info = registration()
  if (!info?.url || !info.password) throw new Error("no service registration")
  const response = await fetch(new URL(route, info.url), {
    method,
    headers: {
      authorization: `Basic ${btoa(`opencode:${info.password}`)}`,
      "x-opencode-directory": encodeURIComponent(workspace),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`)
  return text ? (JSON.parse(text) as { data?: unknown }) : {}
}
const createSession = async (title: string, providerID: string) =>
  ((await api("POST", "/api/session", {
    title,
    model: { providerID, id: MODEL },
    location: { directory: workspace },
  })) as { data: { id: string } }).data.id
const prompt = (sessionID: string, text: string) => api("POST", `/api/session/${sessionID}/prompt`, { text })
const activeSessions = async () => JSON.stringify(((await api("GET", "/api/session/active")) as { data?: unknown }).data ?? {})
const sessionMessages = async (sessionID: string) => JSON.stringify(await api("GET", `/api/session/${sessionID}/message`))

// ---------------------------------------------------------------- shell runs

const appData = appDataDir()
const appDataExisted = existsSync(appData)
let shell: ReturnType<typeof Bun.spawn> | undefined
let cdpUrl = ""
const launcherStartsSoFar = () => collectLogs(undefined)?.launcherStarts ?? 0
const launcherRestartsSoFar = () => collectLogs(undefined)?.launcherRestarts ?? 0

async function launch(name: string, expectSessions = true) {
  const cdp = await freePort()
  cdpUrl = `http://127.0.0.1:${cdp}`
  const startedAt = Date.now()
  shell = Bun.spawn([exe!, `--remote-debugging-port=${cdp}`], { env, stdout: "ignore", stderr: "ignore" })
  log(`${name}: shell pid ${shell.pid}`)
  const { browser, page } = await connect(cdpUrl, 180_000)
  await page.waitForSelector('[data-testid="app"]', { timeout: 120_000 })
  await waitForMarks(page, ["own:t0:connect", "own:t0:ready"], 120_000)
  if (expectSessions) await page.waitForSelector('[data-testid="session-row"]', { timeout: 60_000 }).catch(() => undefined)
  return { browser, page, pid: shell.pid, startedAt }
}
const winShot = (name: string) => {
  if (!shots || !shell) return undefined
  const file = windowShot(shell.pid, path.join(shots, `${label}-${name}-window.png`))
  shotsTaken.push(file)
  return file
}
const domShot = (page: Page, name: string) => shot(page, shots, `${label}-${name}`, shotsTaken)
function ps(script: string, extra: string[]) {
  const run = Bun.spawnSync(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dir, script), ...extra],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const text = run.stdout.toString().trim().split(/\r?\n/).pop() ?? ""
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, raw: `${text} ${run.stderr.toString().trim()}`.slice(0, 500) }
  }
}
// Real key presses need the shell's window in the foreground (window-input.ps1). When Windows refuses that (another
// window keeps the foreground, e.g. a pending system dialog; this run never touches other windows), the same keys go
// through CDP Input.dispatchKeyEvent: the renderer handles them first, and keys it leaves unhandled reach Electron's
// window accelerator handling in main, where the default menu's roles would act.
let osKeys: boolean | undefined
const PLAYWRIGHT_KEYS: Record<string, string> = {
  "ctrl+w": "Control+KeyW",
  "ctrl+r": "Control+KeyR",
  "ctrl+shift+i": "Control+Shift+KeyI",
  "ctrl+m": "Control+KeyM",
  "ctrl+minus": "Control+Minus",
  "ctrl+oemplus": "Control+Equal",
  "ctrl+0": "Control+Digit0",
  "ctrl+a": "Control+KeyA",
  "ctrl+c": "Control+KeyC",
  "ctrl+x": "Control+KeyX",
  "ctrl+v": "Control+KeyV",
  "ctrl+z": "Control+KeyZ",
}
async function keys(page: Page, combos: string) {
  osKeys ??= !args["cdp-keys"] && ps("window-input.ps1", ["-ProcessId", String(shell!.pid), "-Action", "focus"]).ok === true
  const results: { combo: string; sent: boolean; via: string; reason?: string }[] = []
  for (const combo of combos.split(";").filter(Boolean)) {
    if (osKeys) {
      const os = ps("window-input.ps1", ["-ProcessId", String(shell!.pid), "-Action", "keys", "-Keys", combo])
      const item = (os.results as { sent: boolean; reason?: string }[] | undefined)?.[0]
      if (item?.sent) {
        results.push({ combo, sent: true, via: "os" })
        continue
      }
    }
    await page.keyboard.press(PLAYWRIGHT_KEYS[combo] ?? combo)
    await Bun.sleep(400)
    results.push({ combo, sent: true, via: "cdp" })
  }
  return { ok: true, results } as Record<string, unknown>
}
const allSent = (result: Record<string, unknown>) =>
  Array.isArray(result.results) && (result.results as { sent: boolean }[]).every((item) => item.sent)
async function openSession(page: Page, title: string) {
  await page.locator('[data-testid="session-row"]', { hasText: title }).first().click()
  await page.waitForFunction(
    (wanted) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === wanted,
    sessionIds[title],
    { timeout: 20_000 },
  )
}
const currentSession = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") ?? null)
const COMPOSER = '#own-composer-input, [data-testid="composer"] textarea, [data-testid="composer"] [contenteditable="true"]'
const composerText = (page: Page) =>
  page
    .locator(COMPOSER)
    .first()
    .evaluate((element) =>
      element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : (element.textContent ?? ""),
    )
const devtoolsOpen = async () => {
  const targets = (await fetch(`${cdpUrl}/json/list`).then((response) => response.json())) as { url: string; type: string }[]
  return targets.some((target) => target.url.startsWith("devtools://"))
}
const band = (page: Page) =>
  page.evaluate(() => {
    const overlay = (navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect } })
      .windowControlsOverlay
    return { dpr: devicePixelRatio, height: overlay?.getTitlebarAreaRect().height ?? 0 }
  })
const badResources = (page: Page) =>
  page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => {
        const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? 0
        return status >= 400
      })
      .map((entry) => entry.name),
  )

const sessionIds: Record<string, string> = {}
const TITLES = { notify: "알림 시험 세션", stream: "스트리밍 시험 세션", keys: "키 입력 시험 세션" }
const STREAM = { marker: "[gate:stream]", deltas: 1_200, rate: 20, startMarker: "OWNGATE-START", doneMarker: "OWNGATE-DONE" }
let clipboardSaved: { text: string } | undefined
let upstreamRequests: unknown

const watchdog = setTimeout(() => {
  log("watchdog: the run took too long; stopping everything")
  cleanup().finally(() => process.exit(2))
}, 20 * 60_000)

try {
  // ============================================================== run 1: no service yet
  const startsBefore = launcherStartsSoFar()
  let { browser, page } = await launch("run1", false)
  report.run1 = { marks: await marks(page) }
  const service1 = registration()
  check("G-D1.first-start-runs-launcher-once", launcherStartsSoFar() - startsBefore === 1 && !!service1?.pid)
  const launcherLine = /own: starting the service through the launcher \{[^}]*\}/s.exec(collectLogs(undefined)?.text ?? "")?.[0]
  report.launcherCommand = launcherLine?.replace(/\s+/g, " ").slice(0, 400)
  check(
    "G-D1.launcher-is-powershell-own.ps1-start",
    !!launcherLine && /powershell\.exe/i.test(launcherLine) && /own\.ps1/.test(launcherLine) && /'start'/.test(launcherLine),
  )
  for (const [key, title] of Object.entries(TITLES))
    sessionIds[title] = await createSession(title, key === "stream" ? "stream" : "fake")
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="session-row"]').length >= count,
    3,
    { timeout: 20_000 },
  )
  await openSession(page, TITLES.keys)
  await domShot(page, "run1-app")
  winShot("run1")

  // -------------------------------------------------------------- G-D3 (c): menu keys and zoom
  if (!args["no-keys"]) {
    await page.evaluate(() => ((window as { __ownGate?: number }).__ownGate = 1))
    const zoom0 = await band(page)
    const sent = await keys(page, "ctrl+w;ctrl+r;ctrl+shift+i;ctrl+m")
    await Bun.sleep(1_500)
    await page.keyboard.press("Escape").catch(() => undefined)
    const survived = await page
      .evaluate(() => (window as { __ownGate?: number }).__ownGate === 1)
      .catch(() => false)
    const state = ps("window-input.ps1", ["-ProcessId", String(shell!.pid), "-Action", "state"])
    const menuKeys = {
      sent,
      shellAlive: alive(shell!.pid),
      sameDocument: survived,
      devtools: await devtoolsOpen(),
      minimized: state.iconic,
    }
    report.menuKeys = menuKeys
    notes["G-D3c.input"] = osKeys
      ? "real key presses (SendInput to the shell's foreground window)"
      : "CDP Input.dispatchKeyEvent: Windows kept another window in the foreground, so no real key presses were sent"
    check(
      "G-D3c.ctrl-w-r-shift-i-m-do-nothing",
      allSent(sent) && menuKeys.shellAlive && survived && !menuKeys.devtools && state.iconic === false,
    )
    const zoomSteps: Record<string, unknown>[] = []
    const expectBand = (z: number) => Math.max(44, Math.round(44 * z)) / z
    for (const combo of ["ctrl+minus", "ctrl+minus", "ctrl+0", "ctrl+oemplus", "ctrl+0"]) {
      const result = await keys(page, combo)
      await Bun.sleep(900)
      const now = await band(page)
      const z = now.dpr / zoom0.dpr
      zoomSteps.push({ combo, sent: allSent(result), zoom: Math.round(z * 100) / 100, band: now.height, expected: expectBand(z) })
      if (combo === "ctrl+minus" && zoomSteps.length === 2) winShot("zoom-out")
    }
    report.zoomKeys = zoomSteps
    const zoomed = zoomSteps.filter((step) => Math.abs((step.zoom as number) - 1) > 0.01)
    check(
      "G-D3c.zoom-keys-follow-window-zoom-and-band",
      zoomSteps.every((step) => step.sent) &&
        zoomed.length >= 3 &&
        zoomSteps.every((step) => Math.abs((step.band as number) - (step.expected as number)) <= 1.5) &&
        Math.abs((zoomSteps.at(-1)!.zoom as number) - 1) < 0.01,
    )
  } else notes["G-D3c"] = "skipped (--no-keys)"

  // -------------------------------------------------------------- G-D3 (d): composer editing keys
  if (!args["no-keys"]) {
    const clip = args["no-clipboard"] ? { ok: false, formats: ["(--no-clipboard)"], textOnly: false } : clipboard("probe")
    report.clipboardBefore = { formats: clip.formats, textOnly: clip.textOnly }
    // Ctrl+C/X/V go through the system clipboard: only when it holds nothing but text, which is saved and restored.
    const withClipboard = clip.ok && clip.textOnly === true
    if (withClipboard) clipboardSaved = { text: String((clip as { text?: string }).text ?? "") }
    const composer = page.locator(COMPOSER).first()
    await composer.click()
    const sample = `own gate 편집 확인 ${randomBytes(3).toString("hex")}`
    const insert = async (text: string) => {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Input.insertText", { text })
      await cdp.detach()
    }
    const selection = () =>
      page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
          return active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
        return window.getSelection()?.toString() ?? ""
      })
    await insert(sample)
    const steps: Record<string, unknown> = { withClipboard, typed: await composerText(page) }
    const sent: Record<string, unknown>[] = []
    sent.push(await keys(page, "ctrl+a"))
    steps.selectedAll = await selection()
    if (withClipboard) {
      sent.push(await keys(page, "ctrl+c"))
      steps.copied = clipboard("read").text
      sent.push(await keys(page, "ctrl+x"))
      steps.afterCut = await composerText(page)
      steps.cutClipboard = clipboard("read").text
      sent.push(await keys(page, "ctrl+v"))
      steps.afterPaste = await composerText(page)
      sent.push(await keys(page, "ctrl+z"))
      steps.afterUndo = await composerText(page)
    } else {
      sent.push(await keys(page, "ctrl+z"))
      steps.afterUndo = await composerText(page)
    }
    steps.sent = sent.every(allSent)
    steps.keyResults = sent
    report.composerKeys = steps
    const trimmed = (value: unknown) => String(value ?? "").trim()
    check(
      "G-D3d.composer-ctrl-a-z",
      steps.sent === true &&
        trimmed(steps.typed) === sample &&
        trimmed(steps.selectedAll) === sample &&
        trimmed(steps.afterUndo) !== trimmed(withClipboard ? steps.afterPaste : steps.typed),
    )
    if (withClipboard)
      check(
        "G-D3d.composer-ctrl-c-x-v",
        trimmed(steps.copied) === sample &&
          trimmed(steps.afterCut) === "" &&
          trimmed(steps.cutClipboard) === sample &&
          trimmed(steps.afterPaste) === sample,
      )
    else
      notes["G-D3d.composer-ctrl-c-x-v"] =
        `not run: the user's clipboard holds non-text data (${JSON.stringify(clip.formats)}), which this run does not overwrite`
    await composer.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) element.value = ""
      else element.textContent = ""
      element.dispatchEvent(new InputEvent("input", { bubbles: true }))
    })
    if (clipboardSaved) clipboard("restore", clipboardSaved.text)
    clipboardSaved = undefined
  }

  // -------------------------------------------------------------- G-D4: approval toast
  {
    report.toastHistoryBefore = ps("toast.ps1", ["-Action", "history", "-Aumid", AUMID]).count
    // Playwright emulates focus on the pages it attaches to (document.hasFocus() stays true), which would suppress
    // the notification: it is disconnected here and a bare CDP client drives the page.
    await browser.close().catch(() => undefined)
    const raw = await rawCdp((await cdpTargets(cdpUrl)).page!)
    const until = async (expression: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await raw.evaluate<boolean>(expression).catch(() => false)) return true
        await Bun.sleep(250)
      }
      return false
    }
    await raw.send("Page.enable")
    // Keep the Notification objects the host creates (it captures `Notification` at start, so the page is reloaded
    // with the wrapper in place). The wrapper only records; the toast is Electron's.
    const { identifier } = await raw.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const Original = window.Notification
        if (typeof Original !== "function") return
        const made = []
        class Recorded extends Original {
          constructor(title, options) { super(title, options); made.push({ title, body: options && options.body, tag: options && options.tag, n: this }) }
        }
        window.Notification = Recorded
        window.__ownGateToasts = made
      })()`,
    })
    await raw.send("Page.reload")
    await until(
      `!!document.querySelector('[data-testid="app"]') && performance.getEntriesByName("own:t0:connect").length > 0`,
      60_000,
    )
    await raw.send("Page.removeScriptToEvaluateOnNewDocument", { identifier })
    await until(`document.querySelectorAll('[data-testid="session-row"]').length >= 3`, 20_000)
    await raw.evaluate(
      `[...document.querySelectorAll('[data-testid="session-row"]')].find((row) => row.textContent.includes(${JSON.stringify(TITLES.keys)}))?.click()`,
    )
    const minimized = ps("window-input.ps1", ["-ProcessId", String(shell!.pid), "-Action", "minimize"])
    await until(`document.visibilityState === "hidden"`, 10_000)
    const pageState = await raw.evaluate<{ visibility: string; focus: boolean; wrapped: boolean }>(
      `({ visibility: document.visibilityState, focus: document.hasFocus(), wrapped: Array.isArray(window.__ownGateToasts) })`,
    )
    await prompt(sessionIds[TITLES.notify]!, "[gate:ask] 셸 명령을 실행해 줘")
    const recorded = await until(`(window.__ownGateToasts || []).length > 0`, 45_000)
    const made = await raw.evaluate<{ title: string; body?: string; tag?: string }[]>(
      `(window.__ownGateToasts || []).map(({ title, body, tag }) => ({ title, body, tag }))`,
    )
    const pending = (await api("GET", `/api/session/${sessionIds[TITLES.notify]}/permission`).catch(() => ({
      data: [],
    }))) as { data?: { id: string; action?: string }[] }
    await Bun.sleep(1_500)
    const history = ps("toast.ps1", ["-Action", "history", "-Aumid", AUMID])
    const popup = ps("toast.ps1", [
      "-Action",
      "find",
      "-Match",
      "승인이 필요합니다",
      "-TimeoutSeconds",
      "3",
      ...(shots ? ["-Shot", path.join(shots, `${label}-toast.png`)] : []),
    ])
    const toasts = (history.toasts as { texts: string[]; actions: number; tag?: string }[] | undefined) ?? []
    const ours = toasts.filter((toast) => toast.texts.some((text) => text.includes("승인이 필요합니다")))
    // A toast click reaches the page as the Notification's onclick (Electron); the host shows and focuses the window
    // and the requests notifier opens the session.
    const clickAt = Date.now()
    await raw.evaluate(
      `(() => { const last = (window.__ownGateToasts || []).at(-1); if (last && last.n.onclick) last.n.onclick(new Event("click")) })()`,
    )
    const opened = await until(
      `document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === ${JSON.stringify(sessionIds[TITLES.notify])}`,
      10_000,
    )
    const openedMs = opened ? Date.now() - clickAt : -1
    await Bun.sleep(800)
    const afterClick = ps("window-input.ps1", ["-ProcessId", String(shell!.pid), "-Action", "state"])
    winShot("toast-click-opened")
    raw.close()
    ;({ browser, page } = await connect(cdpUrl, 30_000))
    report.toast = {
      minimized,
      pageState,
      pendingPermissions: pending.data?.map((item) => item.action ?? item.id),
      recorded: made,
      history: { count: history.count, ours, error: history.error },
      popup,
      openedMs,
      windowAfterClick: afterClick,
    }
    check(
      "G-D4.notification-created-while-minimized",
      pageState.visibility === "hidden" && recorded && made.some((item) => item.title.includes("승인이 필요합니다")),
    )
    check(
      "G-D4.toast-in-action-center-under-aumid",
      ours.length >= 1,
      `ToastNotificationHistory.GetHistory("${AUMID}"); unpacked exe, no Start-menu shortcut`,
    )
    check("G-D4.toast-has-no-action-buttons", ours.length >= 1 && ours.every((toast) => toast.actions === 0))
    check("G-D4.click-shows-window-and-opens-session", opened && afterClick.iconic === false)
    notes["G-D4.popup"] =
      popup.count === 0
        ? "no toast banner window found on screen by UI Automation (none for a plain PowerShell toast either on this PC); delivery is taken from the Action Center history"
        : `banner found: ${JSON.stringify(popup.toasts)}`
    for (const request of pending.data ?? [])
      await api("POST", `/api/session/${sessionIds[TITLES.notify]}/permission/${request.id}/reply`, {
        decision: "once",
      }).catch(() => undefined)
    ps("toast.ps1", ["-Action", "clear", "-Aumid", AUMID])
  }

  // -------------------------------------------------------------- G-D3 (f): restart refused while a turn runs
  await openSession(page, TITLES.stream)
  await fetch(`${stream.url}/__bench/stream`, { method: "POST", body: JSON.stringify(STREAM) })
  await prompt(sessionIds[TITLES.stream]!, `${STREAM.marker} 60초 동안 스트리밍해 줘`)
  const streamState = async () =>
    ((await fetch(`${stream.url}/__bench/state`).then((response) => response.json())) as {
      streams: { sent: number; startedAt?: number; finishedAt?: number }[]
    }).streams[0]
  for (let tries = 0; tries < 120 && ((await streamState())?.sent ?? 0) < 40; tries++) await Bun.sleep(250)
  await page
    .waitForFunction((marker) => document.body.innerText.includes(marker), STREAM.startMarker, { timeout: 20_000 })
    .catch(() => undefined)
  winShot("streaming")
  const pidBeforeRestart = registration()?.pid
  const refused = await page.evaluate(() =>
    (window as { own?: { service: { restart(input: { force: boolean }): Promise<unknown> } } }).own?.service.restart({
      force: false,
    }),
  )
  const pidAfterRestart = registration()?.pid
  report.restartRefused = { result: refused, pidBefore: pidBeforeRestart, pidAfter: pidAfterRestart, stream: await streamState() }
  check(
    "G-D3f.restart-refused-while-running",
    JSON.stringify(refused) === JSON.stringify({ ok: false, refused: "session_running" }) &&
      pidBeforeRestart === pidAfterRestart &&
      !!pidBeforeRestart &&
      alive(pidBeforeRestart),
  )

  // -------------------------------------------------------------- G-D3 (a): close the window mid-turn
  const servicePid = registration()?.pid
  const sentAtClose = (await streamState())?.sent ?? 0
  // 05 §7.3: the X hides the last window to the tray and the shell stays; 앱 종료 then ends the shell.
  const closeAsked = ps("window-close.ps1", ["-ProcessId", String(shell!.pid)])
  await Bun.sleep(2_000)
  const hiddenToTray =
    alive(shell!.pid) &&
    ps("window-input.ps1", ["-ProcessId", String(shell!.pid), "-Action", "state"]).error === "no window"
  await quitShell(page)
  await browser.close().catch(() => undefined)
  const closedAt = Date.now()
  const shellExited = await Promise.race([shell!.exited.then(() => true), Bun.sleep(20_000).then(() => false)])
  const shellExitMs = Date.now() - closedAt
  const activeAfterClose = (await activeSessions()).includes(sessionIds[TITLES.stream]!)
  for (let tries = 0; tries < 240 && !(await streamState())?.finishedAt; tries++) await Bun.sleep(500)
  await api("POST", `/api/experimental/session/${sessionIds[TITLES.stream]}/wait`).catch(() => undefined)
  const finished = await streamState()
  const messages = await sessionMessages(sessionIds[TITLES.stream]!)
  report.closeMidTurn = {
    close: closeAsked,
    hiddenToTray,
    shellExited,
    shellExitMs,
    sentAtClose,
    activeAfterClose,
    stream: finished,
    servicePid,
    servicePidAfter: registration()?.pid,
    serviceAlive: servicePid ? alive(servicePid) : false,
  }
  check("G-D3a.window-close-hides-to-tray", String(closeAsked.raw ?? "").includes("WM_CLOSE posted") && hiddenToTray)
  check("G-D3a.app-quit-exits-shell", shellExited)
  check("G-D3a.turn-running-after-close", activeAfterClose && sentAtClose < STREAM.deltas)
  check(
    "G-D3a.turn-completes-service-pid-same",
    !!finished?.finishedAt &&
      messages.includes(STREAM.doneMarker) &&
      registration()?.pid === servicePid &&
      !!servicePid &&
      alive(servicePid),
  )

  // ============================================================== run 2: 60 s later, the service still runs
  const wait = 60_000 - (Date.now() - closedAt)
  if (wait > 0) await Bun.sleep(wait)
  const startsBefore2 = launcherStartsSoFar()
  ;({ browser, page } = await launch("run2"))
  report.run2 = { marks: await marks(page), relaunchAfterMs: Date.now() - closedAt }
  check("G-D1.relaunch-adopts-running-service", launcherStartsSoFar() === startsBefore2 && registration()?.pid === servicePid)
  const restored = await page
    .waitForFunction(
      (wanted) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === wanted,
      sessionIds[TITLES.stream],
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  const resultVisible = await page
    .waitForFunction((marker) => document.body.innerText.includes(marker), STREAM.doneMarker, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  await Bun.sleep(500)
  winShot("run2-restored")
  await domShot(page, "run2-restored")
  check("G-D3a.relaunch-shows-finished-turn", restored && resultVisible)
  check("G-D6.restored-window-same-session-route", restored)

  // -------------------------------------------------------------- G-D6: reload keeps the route, no 404
  const cdp = await page.context().newCDPSession(page)
  const failed: string[] = []
  await cdp.send("Network.enable")
  cdp.on("Network.responseReceived", (event: { response: { url: string; status: number } }) => {
    if (event.response.status >= 400) failed.push(`${event.response.status} ${event.response.url}`)
  })
  cdp.on("Network.loadingFailed", (event: { errorText: string; type?: string }) => {
    if (!/ERR_ABORTED/.test(event.errorText)) failed.push(`failed ${event.type ?? ""} ${event.errorText}`)
  })
  const initialBad = await badResources(page)
  await page.reload()
  await page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
  const reloadRoute = await page
    .waitForFunction(
      (wanted) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === wanted,
      sessionIds[TITLES.stream],
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  await Bun.sleep(1_500)
  const renderer404 = failed.filter((line) => line.includes("oc://renderer"))
  report.reload = { initialBad, failed: failed.slice(0, 20), sameRoute: reloadRoute }
  const initialRenderer404 = initialBad.filter((name) => name.startsWith("oc://renderer"))
  check("G-D6.reload-same-route-no-404", reloadRoute && renderer404.length === 0 && initialRenderer404.length === 0)

  // -------------------------------------------------------------- G-D6 (d): pointer switched to another contract
  {
    const otherHash = "ffffffffffffffff"
    // What own update/rollback does to the UI: app\current.json names another version folder (no junction).
    const swap = (target: string) => pointAt(ownHome, path.basename(target))
    const release = (name: string, rename: boolean) => {
      const dir = path.join(ownHome, "app", name)
      cpSync(web!, path.join(dir, "web"), { recursive: true })
      const result = rebuildWithHash(path.join(dir, "web"), RPC_HASH, otherHash, rename)
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ version: name, channel: "own", desktop: { version: name, rpc_hash: otherHash } }),
      )
      return { dir, ...result }
    }
    // The IPC client's chunk is preloaded with the page (05 R-D12), so "not loaded" means "never ran": own-web asks
    // the preload for main's port (OwnIpc.portRequest) only after importing it. Counted from before the page's scripts.
    await page.addInitScript(() => {
      const scope = window as Window & { __ownPortRequests?: number }
      scope.__ownPortRequests = 0
      window.addEventListener("message", (event) => {
        if (event.source === window && event.data === "own:ipc.port-request")
          scope.__ownPortRequests = (scope.__ownPortRequests ?? 0) + 1
      })
    })
    const reloadAndLook = async () => {
      failed.length = 0
      await page.reload()
      // own-web's mismatch screen (src/host/mismatch.ts, 05 §5.5) in place of the app.
      const mismatch = await page
        .waitForSelector('[data-testid="shell-mismatch"]', { timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
      await Bun.sleep(500)
      return {
        mismatch,
        text: await page.evaluate(() => document.body.innerText.slice(0, 200)),
        app: await page.evaluate(() => !!document.querySelector('[data-testid="app"]')),
        ipcClient: await page.evaluate(
          () => ((window as Window & { __ownPortRequests?: number }).__ownPortRequests ?? 0) > 0,
        ),
        drag: await page.evaluate(
          () => !!document.querySelector('[data-testid="shell-mismatch-drag"]')?.getAttribute("style")?.includes("drag"),
        ),
        t0: await page.evaluate(() => performance.getEntriesByName("own:t0:connect", "mark").length),
        failed: failed.filter((line) => line.includes("oc://renderer")).slice(0, 10),
      }
    }
    // Informational, first: the same file names with only the constant replaced (same length). The renderer may keep
    // the old compiled code for an unchanged URL of unchanged length (V8 code cache for oc://renderer); a real rebuild
    // never keeps a name for changed content. Run first so its cache entries cannot outlive the gate step below.
    const inPlace = release(`${version}-inplace`, false)
    swap(inPlace.dir)
    const sameNames = await reloadAndLook()
    // N+1 as a real rebuild lays it out: the chunk whose contract changed gets a new content-hash name, and so does
    // every chunk that imports it (index.html keeps its name).
    const rebuilt = release(`${version}-next`, true)
    swap(rebuilt.dir)
    const state = await reloadAndLook()
    await Bun.sleep(500)
    winShot("pointer-mismatch")
    await domShot(page, "pointer-mismatch")
    const warned = /installed UI no longer matches this shell/.test(collectLogs(undefined)?.text ?? "")
    swap(path.join(ownHome, "app", version))
    failed.length = 0
    await page.reload()
    const back = await page
      .waitForSelector('[data-testid="app"]', { timeout: 60_000 })
      .then(() => true)
      .catch(() => false)
    report.pointer = {
      rebuilt: { renamed: rebuilt.renamed, hashFiles: rebuilt.hashFiles },
      state,
      mainLogWarned: warned,
      sameNamesInPlace: { hashFiles: inPlace.hashFiles, ...sameNames },
      backToApp: back,
      failedAfterBack: failed.filter((line) => line.includes("oc://renderer")).slice(0, 10),
    }
    check(
      "G-D6d.pointer-swap-shows-mismatch-no-ipc",
      rebuilt.hashFiles >= 1 &&
        state.mismatch &&
        state.drag &&
        !state.app &&
        !state.ipcClient &&
        state.t0 === 0 &&
        state.failed.length === 0 &&
        alive(shell!.pid),
    )
    check("G-D6d.main-logs-manifest-mismatch", warned)
    check("G-D6d.switch-back-restores-app", back)
    notes["G-D6d.same-names-in-place"] = sameNames.mismatch
      ? "a same-name, same-length in-place edit was picked up too"
      : "a same-name, same-length in-place edit of the desktop chunk was NOT picked up after reload (stale code cache for oc://renderer); real rebuilds rename changed chunks"
  }
  await cdp.detach().catch(() => undefined)

  // -------------------------------------------------------------- G-D1: reconnect after a restart
  {
    await waitForMarks(page, ["own:t0:connect"], 60_000)
    const restartsBefore = launcherRestartsSoFar()
    const reconnects = await page.evaluate(() => performance.getEntriesByName("own:t0:reconnect", "mark").length)
    const pidBefore = registration()?.pid
    const result = await page.evaluate(() =>
      (window as { own?: { service: { restart(input: { force: boolean }): Promise<unknown> } } }).own?.service.restart({
        force: true,
      }),
    )
    const reconnected = await page
      .waitForFunction((count) => performance.getEntriesByName("own:t0:reconnect", "mark").length > count, reconnects, {
        timeout: 90_000,
        polling: 250,
      })
      .then(() => true)
      .catch(() => false)
    const pidAfter = registration()?.pid
    report.reconnect = { result, pidBefore, pidAfter, reconnected, launcherRestarts: launcherRestartsSoFar() - restartsBefore }
    check(
      "G-D1.restart-reconnects-through-launcher",
      JSON.stringify(result) === '{"ok":true}' &&
        reconnected &&
        !!pidAfter &&
        pidAfter !== pidBefore &&
        launcherRestartsSoFar() - restartsBefore === 1,
    )
  }
  upstreamRequests = await fetch(`${upstream.url}/__count`).then((response) => response.json())
  // 앱 종료 (05 §7.3): the X would only hide the window to the tray.
  await quitShell(page)
  await browser.close().catch(() => undefined)
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(`error: ${String(report.error).slice(0, 2_000)}`)
} finally {
  await cleanup()
  clearTimeout(watchdog)
  report.checks = checks
  report.notes = notes
  report.shots = shotsTaken
  report.passed = Object.values(checks).every(Boolean) && !report.error
  if (shots) writeFileSync(path.join(shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}

async function cleanup() {
  if (clipboardSaved) clipboard("restore", clipboardSaved.text)
  clipboardSaved = undefined
  if (shell) {
    const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    if (!exited) killTree(shell.pid)
    report.shellExit = exited ? "app quit" : "killed"
  }
  const logs = collectLogs(shots ? path.join(shots, `${label}-logs`) : undefined)
  if (logs) {
    const { text, ...counts } = logs
    report.logs = counts
    const password = registration()?.password
    const secrets = [password, password && Buffer.from(`opencode:${password}`).toString("base64")].filter(
      (value): value is string => !!value,
    )
    check("G14.no-service-password-in-shell-logs", secrets.every((secret) => !text.includes(secret)))
  }
  // Service: the launcher's own stop, then the registered pid for sure.
  const before = registration()
  const stop = Bun.spawnSync(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ownHome, "bin", "own.ps1"), "stop", "--force"],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  if (before?.pid && alive(before.pid)) killTree(before.pid)
  report.serviceStop = { code: stop.exitCode, pid: before?.pid, stillAlive: before?.pid ? alive(before.pid) : false }
  // G-D1: the "upstream" service was never touched.
  const upstreamAfter = fileState(upstream.registration)
  const upstreamAlive = alive(upstream.pid)
  upstreamRequests ??= await fetch(`${upstream.url}/__count`)
    .then((response) => response.json())
    .catch(() => undefined)
  report.upstreamAfter = { file: upstreamAfter, alive: upstreamAlive, requests: upstreamRequests }
  check(
    "G-D1.upstream-service-json-and-pid-untouched",
    JSON.stringify(upstreamAfter) === JSON.stringify(upstreamBefore) &&
      upstreamAlive &&
      (upstreamRequests as { requests?: number } | undefined)?.requests === 0,
  )
  upstreamProc.stdin.write("stop\n")
  upstreamProc.stdin.end()
  await Promise.race([upstreamProc.exited, Bun.sleep(3_000)])
  if (alive(upstream.pid)) killTree(upstream.pid)
  await tools.stop().catch(() => undefined)
  stream.stop()
  ps("toast.ps1", ["-Action", "clear", "-Aumid", AUMID])
  if (!appDataExisted) await removeTree(appData)
  // Electron's first toast registers a Start-menu shortcut and a COM activator for the exe (run-kit osArtifacts);
  // the run records what it created and removes it, so the comparison below is about everything else.
  report.osArtifactsCreated = removeNewOsArtifacts(machineBefore.os)
  const machineAfter = machineState()
  report.after = machineAfter
  check("G-D2.machine-unchanged", JSON.stringify(machineAfter) === JSON.stringify(machineBefore))
  check(
    "G-D1.real-service-json-untouched",
    JSON.stringify([machineAfter.upstreamServiceJson, machineAfter.ownServiceJson]) ===
      JSON.stringify([machineBefore.upstreamServiceJson, machineBefore.ownServiceJson]),
  )
  if (out && existsSync(path.join(out, "desktop-build.json"))) {
    const build = JSON.parse(readFileSync(path.join(out, "desktop-build.json"), "utf8")) as { checks?: Record<string, boolean> }
    for (const [name, value] of Object.entries(build.checks ?? {})) if (name.startsWith("G-D2")) check(`${name} (build)`, value)
  }
  if (!args.keep) await removeTree(root)
}

/** The user's clipboard: probe (formats, text-only?), read, restore. Windows PowerShell 5.1 is STA. */
function clipboard(action: "probe" | "read" | "restore", text?: string) {
  const script =
    action === "restore"
      ? `[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $t = [Console]::In.ReadToEnd(); if ($t.Length -gt 0) { [Windows.Forms.Clipboard]::SetText($t) } else { [Windows.Forms.Clipboard]::Clear() }; '{"ok":true}'`
      : `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d = [Windows.Forms.Clipboard]::GetDataObject(); $f = @(); if ($d) { $f = @($d.GetFormats()) }; $text = [Windows.Forms.Clipboard]::GetText(); $textOnly = @($f | Where-Object { $_ -notmatch '^(Text|UnicodeText|System\\.String|OEMText|Locale)$' }).Count -eq 0; @{ ok = $true; formats = $f; textOnly = $textOnly; text = $text } | ConvertTo-Json -Compress`
  const run = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-Sta", "-Command", script], {
    stdin: action === "restore" ? Buffer.from(text ?? "", "utf8") : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    return JSON.parse(run.stdout.toString().trim().split(/\r?\n/).pop() ?? "") as {
      ok: boolean
      formats?: string[]
      textOnly?: boolean
      text?: string
    }
  } catch {
    return { ok: false, formats: [], textOnly: false, text: undefined }
  }
}

/**
 * Simulates an own-web build of another IPC contract in `dir`: the rpcHash constant is replaced, and with `rename`
 * every changed chunk gets a new name and every chunk importing a renamed one is rewritten and renamed too, as
 * Vite's content-hash names do (index.html keeps its name).
 */
function rebuildWithHash(dir: string, from: string, to: string, rename: boolean) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|html|css)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
  const texts = new Map(files.map((file) => [file, readFileSync(file, "utf8")]))
  const dirty = new Set<string>()
  let hashFiles = 0
  for (const [file, text] of texts)
    if (text.includes(from)) {
      texts.set(file, text.replaceAll(from, to))
      dirty.add(file)
      hashFiles++
    }
  const renamed = new Map<string, string>()
  if (rename) {
    for (;;) {
      let grew = false
      for (const file of dirty) {
        const base = path.basename(file)
        if (!file.endsWith(".js") || renamed.has(base)) continue
        renamed.set(base, base.replace(/\.js$/, "n.js"))
        grew = true
      }
      if (!grew) break
      for (const [file, text] of texts) {
        let next = text
        for (const [before, after] of renamed) next = next.replaceAll(`/${before}`, `/${after}`).replaceAll(`"./${before}"`, `"./${after}"`)
        if (next !== text) {
          texts.set(file, next)
          dirty.add(file)
        }
      }
    }
  }
  for (const file of dirty) {
    const base = path.basename(file)
    const target = renamed.has(base) ? path.join(path.dirname(file), renamed.get(base)!) : file
    writeFileSync(target, texts.get(file)!)
    if (target !== file) rmSync(file)
  }
  return { hashFiles, renamed: [...renamed.entries()].map(([before, after]) => `${before} -> ${after}`) }
}

async function readFirstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return text.split("\n")[0]!
}

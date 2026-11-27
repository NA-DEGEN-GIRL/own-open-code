// Many concurrent sessions on the built shell (never installed): UI latency, frames, session switches, page opens,
// RAM per process, JS heaps, idle CPU and event traffic with N sessions of which K stream at once. Fake credentials
// only; one temp root (OWN_HOME, OWN_CONFIG_DIR, XDG_*, TEMP and the shell's userData) removed afterwards; every
// process started here is stopped.
//
//   bun scripts/perf-many-sessions.ts [--n 20] [--streams <n>] [--open <n>] [--rate 50] [--seconds 60] [--fillers 300]
//        [--turns 40] [--areas <n/5>] [--web <own-web build>] [--service source|source-full|release]
//        [--app <release app dir>] [--profile] [--service-profile] [--provider-process] [--heap-snapshot]
//        [--reduced-motion] [--inject-css <rules>] [--no-frames] [--no-memory-dump] [--shell-args "<switches>"]
//        [--label many] [--out <dir>]
//        [--keep]
//
// The shell is `out/` (`bun run build`) unpackaged on the workspace's Electron, like zoom-level.ts: userData in the
// temp root (OPENCODE_DESKTOP_TEST_ROOT), the window off the screen and the taskbar (a saved window state at -32000
// and OWN_DESKTOP_TEST_RUN, which also ends the shell when this run is gone), input through CDP only, the shell ended
// through the app's own quit (then killed if it is still there), a hard timeout per run. The window is off-screen, so
// Windows' occlusion tracking would mark it hidden; `--disable-features=CalculateNativeWinOcclusion` is passed so the
// renderer paints like a window on screen (recorded as `shellArgs`). OS notifications are stubbed in the page (a
// background turn ending would otherwise show a Windows toast on the user's screen); the stub counts them.
//
// Service: the upstream server from source with own.accounts + own.telemetry (`--service source`, default), or the
// release `opencode.exe` with the release's bundled plugins (`--service release --app <...>/app`), both in the temp
// root on a free port, plus a bench-only heap sampler plugin (many-sessions/heap-plugin). The fixture: F short filler
// sessions (the sidebar list), N work sessions with T turns each spread over A folders (Locations, like team areas),
// and a paced fake OpenAI Responses provider (own-web e2e/performance/fixture/stream-provider.ts).
//
// Phases (each records RAM per process role, renderer metrics and the event feed):
//   boot      shell start → sessions visible; sidebar rows and DOM size
//   open      every work session opened once from the sidebar (cold switch), then the first five again (warm)
//   idle      30 s idle with N sessions opened: CPU per process, renderer task time, timers
//   stream    K sessions stream at R deltas/s for S seconds; meanwhile in the active (streaming) session: following
//             frames, Korean IME typing (input → paint), wheel scroll frames, warm switches between streaming
//             sessions, page opens (accounts, limits, settings, team), a sidebar fling
//   after     30 s idle after the streams ended; heaps after a full GC (renderer and service)
//   closed    the N work sessions deleted, the view on a filler session; heaps after a full GC
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Browser, CDPSession, Page } from "@playwright/test"
import type { OpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { startStreamProvider } from "../../own-web/e2e/performance/fixture/stream-provider"
import { startLoadSampler, loadBetween } from "../../own-web/e2e/performance/load"
import { classifySwitch, inputLatency, round, summarize } from "../../own-web/e2e/performance/metrics"
import {
  findScroller,
  installInputProbe,
  installMarkerLocator,
  installSwitchProbe,
  readInputProbe,
  readSwitchProbe,
} from "../../own-web/e2e/performance/probes"
import { COMPOSER, imeWorkload, measureFrames, scrollGesture, typeIme } from "../../own-web/e2e/performance/support"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { summarizeHeapSnapshot, summarizeProfile, type CpuProfile } from "./many-sessions/cpu-profile"
import { eventRate, startEventCounter } from "./many-sessions/events"
import { memoryDump } from "./many-sessions/memory-dump"
import { cpuBetween, isService, isShell, startProcSampler, totals, type ProcSample } from "./many-sessions/proc"
import {
  addAccount,
  providerProcess,
  sessionImporter,
  startBenchService,
  type ServiceMode,
} from "./many-sessions/service"
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
  quitShell,
  removeNewOsArtifacts,
  removeNewTrayIconSettings,
  sameMachine,
  snapshotMachine,
  trayIconSettings,
  xdgDirs,
} from "./run-kit"

const args = parseArgs({
  options: {
    n: { type: "string", default: "20" },
    open: { type: "string" },
    streams: { type: "string" },
    rate: { type: "string", default: "50" },
    seconds: { type: "string", default: "60" },
    fillers: { type: "string", default: "300" },
    turns: { type: "string", default: "40" },
    areas: { type: "string" },
    web: { type: "string" },
    service: { type: "string", default: "source" },
    app: { type: "string" },
    profile: { type: "boolean", default: false },
    "heap-snapshot": { type: "boolean", default: false },
    "no-frames": { type: "boolean", default: false },
    "service-profile": { type: "boolean", default: false },
    "provider-process": { type: "boolean", default: false },
    "reduced-motion": { type: "boolean", default: false },
    "inject-css": { type: "string" },
    "no-memory-dump": { type: "boolean", default: false },
    "shell-args": { type: "string", default: "--disable-features=CalculateNativeWinOcclusion" },
    "idle-seconds": { type: "string", default: "30" },
    label: { type: "string", default: "many" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
}).values

const N = Number(args.n)
const K = Math.min(N, Number(args.streams ?? N))
/** Work sessions opened once in the UI (newest first); the others stream without ever being shown. */
const OPEN = Math.min(N, Number(args.open ?? N))
const RATE = Number(args.rate)
const STREAM_SECONDS = Number(args.seconds)
const FILLERS = Number(args.fillers)
const TURNS = Number(args.turns)
const AREAS = Math.max(1, Number(args.areas ?? Math.ceil(N / 5)))
const IDLE_SECONDS = Number(args["idle-seconds"])
const SHELL_ARGS = args["shell-args"]!.split(" ").filter(Boolean)
const WEB = path.resolve(args.web ?? path.join(PACKAGE, "../own-web/dist"))
const MODEL = "gpt-5.5"
const label = args.label!
const outDir = path.resolve(args.out ?? path.join(os.tmpdir(), "own-many-sessions"))
mkdirSync(outDir, { recursive: true })
const log = (message: string) => console.error(`[many ${new Date().toISOString().slice(11, 19)}] ${message}`)

if (!existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("run `bun run build` first")
if (!existsSync(path.join(WEB, "index.html"))) throw new Error(`--web: own-web build not found (${WEB})`)
const releaseApp = args.service === "release" ? path.resolve(args.app ?? "") : undefined
if (releaseApp && !existsSync(path.join(releaseApp, "opencode.exe")))
  throw new Error(`--app: no opencode.exe in ${releaseApp}`)

const root = path.join(os.tmpdir(), `own-many-${randomBytes(3).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
const shellTemp = path.join(root, "tmp")
const testRoot = path.join(root, "desktop")
const heapFile = path.join(root, "service-heap.jsonl")
mkdirSync(configDir, { recursive: true })
mkdirSync(shellTemp, { recursive: true })
const settingsFile = path.join(testRoot, "desktop", "opencode.settings")

const machine = snapshotMachine()
const electronPath = createRequire(import.meta.url)("electron") as unknown as string
const electronDir = realpathSync(path.dirname(electronPath))
const trayIconsBefore = new Set(trayIconSettings(electronDir))
const appData = appDataDir()
const appDataExisted = existsSync(appData)
const load = startLoadSampler(1_000)
const startedAt = Date.now()
const report: Record<string, unknown> = {
  label,
  date: new Date().toISOString(),
  config: {
    n: N,
    streams: K,
    open: OPEN,
    rate: RATE,
    seconds: STREAM_SECONDS,
    fillers: FILLERS,
    turns: TURNS,
    areas: AREAS,
  },
  service: releaseApp ? { mode: "release", app: releaseApp } : { mode: args.service },
  shellArgs: SHELL_ARGS,
  providerProcess: args["provider-process"],
  reducedMotion: args["reduced-motion"],
  injectCss: args["inject-css"] ?? null,
  web: WEB,
  machine: {
    os: `${os.type()} ${os.release()}`,
    cpus: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
  },
}
const phases: Record<string, unknown> = {}
report.phases = phases

// ------------------------------------------------------------------------------------------------ service
const provider = args["provider-process"] ? await providerProcess(MODEL) : startStreamProvider({ models: [MODEL] })
log(`service (${releaseApp ? "release" : args.service}) …`)
// many-sessions/service.ts: the temp OWN_HOME with the installed-app layout (own.accounts trusts only plugins under
// `<OWN_HOME>\app\<version>\plugins`), the release's or the source plugins, and the heap sampler.
const started = await startBenchService({
  mode: (releaseApp ? "release" : args.service) as ServiceMode,
  app: releaseApp,
  root,
  heapFile,
  providerBaseURL: provider.baseURL,
})
const service: OpencodeServer = started.service
const ownHome = started.ownHome
const password = atob(service.authorization.slice("Basic ".length)).slice("opencode:".length)

const proc = startProcSampler()
const events = startEventCounter({ url: service.url, authorization: service.authorization })
let shell: ReturnType<typeof Bun.spawn> | undefined
const watchdog = setTimeout(
  async () => {
    log("watchdog: the run took too long; stopping everything")
    if (shell) killTree(shell.pid)
    killTree(service.pid)
    provider.stop()
    await removeTree(root)
    process.exit(2)
  },
  (25 + Math.ceil(N / 10) * 4 + Math.ceil(STREAM_SECONDS / 60) * 3) * 60_000,
)

type Work = { id: string; tag: string; title: string; directory: string; last: string }

try {
  // ---------------------------------------------------------------------------------------------- fixture
  const model = await addAccount(service, started.control, MODEL)
  const importSession = await sessionImporter(service, model)
  const importStarted = Date.now()
  const base = Date.UTC(2026, 8, 1)
  const fillers: Work[] = []
  for (let index = 0; index < FILLERS; index++)
    fillers.push(
      await importSession(
        `F${index}`,
        `짧은 세션 ${index + 1} · 결제 웹훅 재시도`,
        3,
        base - (index + 1) * 3_600_000,
        service.paths.workspace,
      ),
    )
  const areaDirs = Array.from({ length: AREAS }, (_, index) =>
    path.join(service.paths.workspace, `area-${String(index + 1).padStart(2, "0")}`),
  )
  areaDirs.forEach((dir) => mkdirSync(dir, { recursive: true }))
  const work: Work[] = []
  for (let index = 0; index < N; index++) {
    const directory = areaDirs[index % AREAS]!
    const title = `작업 ${String(index + 1).padStart(2, "0")} · ${path.basename(directory)}`
    work.push(await importSession(`W${index}`, title, TURNS, base + (index + 1) * 3_600_000, directory))
  }
  // Newest first in the list: W(N-1) on top. The active session is the newest one.
  report.fixture = { importMs: Date.now() - importStarted, sessions: FILLERS + N, messagesPerWork: TURNS * 2 }
  log(`fixture: ${FILLERS} fillers + ${N} work sessions in ${AREAS} folders (${Date.now() - importStarted} ms)`)

  // The shell discovers the service through its XDG_STATE_HOME; own.team's self-HTTP through the service's own.
  for (const stateHome of [xdg.XDG_STATE_HOME, path.join(started.serviceRoot, "xdg-state")])
    await registerService({
      url: service.url,
      authorization: service.authorization,
      password,
      stateHome,
      channel: "own",
    })
  installUi(ownHome, { version: started.appVersion, web: WEB, hash: RPC_HASH })
  const serviceInfo = (await service.call("GET", "/api/info")) as { version?: string; pid?: number }
  const servicePids = [
    service.pid,
    ...(typeof serviceInfo.pid === "number" && serviceInfo.pid !== service.pid ? [serviceInfo.pid] : []),
  ]
  report.serviceVersion = serviceInfo.version

  // ---------------------------------------------------------------------------------------------- shell
  offscreen()
  const cdpPort = await freePort()
  const env = cleanEnv({ ...xdg, OWN_HOME: ownHome, OWN_CONFIG_DIR: configDir, TEMP: shellTemp, TMP: shellTemp })
  const spawnedAt = Date.now()
  shell = Bun.spawn([electronPath, PACKAGE, ...SHELL_ARGS], {
    env: {
      ...env,
      OPENCODE_DESKTOP_TEST_ROOT: testRoot,
      OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdpPort),
      OWN_DESKTOP_TEST_RUN: String(process.pid),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const shellPid = shell.pid
  const hardStop = setTimeout(() => killTree(shellPid), (20 + Math.ceil(N / 10) * 4) * 60_000)
  shell.exited.then(() => clearTimeout(hardStop))
  const connected = await connect(`http://127.0.0.1:${cdpPort}`, 180_000)
  const browser: Browser = connected.browser
  let page: Page = connected.page
  // OS notifications: a stub in the page (see the header), installed for every document, then a reload.
  const boot = await page.context().newCDPSession(page)
  await boot.send("Page.enable")
  await boot.send("Page.addScriptToEvaluateOnNewDocument", { source: notificationStub() })
  await page.waitForSelector('[data-testid="app"]', { timeout: 120_000 })
  await page.reload()
  const reloadedAt = Date.now()
  await page.waitForSelector('[data-testid="app"]', { timeout: 120_000 })
  await waitForMarks(page, ["own:t0:connect", "own:t0:ready"], 60_000)
  await page.waitForFunction(() => performance.getEntriesByName("own:sessions-visible", "mark").length > 0, undefined, {
    timeout: 120_000,
    polling: 100,
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" })
  // `--reduced-motion`: prefers-reduced-motion for the page (every motion rule of own-web and session-ui).
  if (args["reduced-motion"])
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  // `--inject-css "<rules>"`: a style sheet added to the page, to A/B one rule without a build (diagnostics only).
  if (args["inject-css"]) await page.addStyleTag({ content: args["inject-css"] })
  await cdp.send("HeapProfiler.enable")
  const browserCdp = await browser.newBrowserCDPSession()
  const view = await page.evaluate(() => ({
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }))
  const refresh = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const times: number[] = []
        const tick = (time: number) => {
          times.push(time)
          if (times.length < 61) requestAnimationFrame(tick)
          else resolve((times.at(-1)! - times[0]!) / 60)
        }
        requestAnimationFrame(tick)
      }),
  )
  phases.boot = {
    spawnToConnectMs: reloadedAt - spawnedAt,
    reloadToVisibleMs: await page.evaluate(() =>
      Math.round(performance.getEntriesByName("own:sessions-visible", "mark")[0]!.startTime),
    ),
    view,
    rafIntervalMs: round(refresh),
    dom: await domStats(page),
    memory: await memoryPoint("boot"),
  }
  log(`boot: ${JSON.stringify(phases.boot).slice(0, 400)}`)
  if (view.visibility !== "visible") log("WARNING: the page is hidden; frame numbers would be meaningless")

  // ---------------------------------------------------------------------------------------------- open
  // Every work session once from the sidebar, newest first (cold: fetched on open), then five again (warm).
  const ordered = work.toReversed()
  const cold: Record<string, unknown>[] = []
  let current: Work | undefined
  for (const target of ordered.slice(0, OPEN)) {
    cold.push({ tag: target.tag, ...(await switchTo(page, current, target)) })
    current = target
  }
  const warmTargets = ordered.slice(0, Math.min(6, OPEN)).toReversed()
  const warm: Record<string, unknown>[] = []
  for (const target of warmTargets.filter((item) => item !== current)) {
    warm.push({ tag: target.tag, ...(await switchTo(page, current, target)) })
    current = target
  }
  const coldMs = cold
    .map((item) => item.firstCorrectObservedMs)
    .filter((value): value is number => typeof value === "number")
  const warmMs = warm
    .map((item) => item.firstCorrectObservedMs)
    .filter((value): value is number => typeof value === "number")
  phases.open = {
    cold: summarize(coldMs),
    coldMissing: cold.length - coldMs.length,
    warm: summarize(warmMs),
    warmMissing: warm.length - warmMs.length,
    coldSamples: cold.map((item) => [item.tag, item.firstCorrectObservedMs, item.via]),
    warmSamples: warm.map((item) => [item.tag, item.firstCorrectObservedMs, item.via]),
    dom: await domStats(page),
    memory: await memoryPoint("open", { gc: true }),
  }
  log(`open: cold ${JSON.stringify(summarize(coldMs))} warm ${JSON.stringify(summarize(warmMs))}`)

  // The active session for the rest: the newest work session (it streams too).
  const active = ordered[0]!
  if (current !== active) await switchTo(page, current, active)
  current = active
  await settle(page)

  // ---------------------------------------------------------------------------------------------- idle
  phases.idle = await idleWindow(page, cdp, "idle")
  log(`idle: ${JSON.stringify((phases.idle as { cpu: unknown }).cpu)}`)
  // The same Korean IME typing as during the streams, with nothing streaming: the baseline for input → paint.
  phases.idleInput = await typingWindow(page, 6_000)

  // ---------------------------------------------------------------------------------------------- stream
  const streaming = ordered.slice(0, K)
  const run = randomBytes(3).toString("hex")
  const deltas = Math.max(1, Math.round(RATE * STREAM_SECONDS))
  for (const [index, target] of streaming.entries()) {
    const plan = {
      marker: `OWNBM-${run}-${index}`,
      deltas,
      rate: RATE,
      tag: target.tag,
      startMarker: `OWNB-${target.tag}-8001-R`,
      doneMarker: `OWNB-${target.tag}-8002-R`,
    }
    await fetch(`${provider.url}/__bench/stream`, { method: "POST", body: JSON.stringify(plan) })
  }
  const streamState = async () =>
    (await (await fetch(`${provider.url}/__bench/state`)).json()) as {
      streams: { marker: string; sent: number; deltas: number; startedAt?: number; finishedAt?: number }[]
    }
  const streamBefore = await streamPoint()
  const promptedAt = Date.now()
  await Promise.all(
    streaming.map((target, index) =>
      service.call("POST", `/api/session/${target.id}/prompt`, {
        body: { text: `여러 세션 동시 스트리밍 측정입니다. OWNBM-${run}-${index} OWNB-${target.tag}-8000-U` },
        directory: target.directory,
      }),
    ),
  )
  const startedStreams = await waitUntil(async () => {
    const state = await streamState()
    return state.streams.filter((item) => item.marker.startsWith(`OWNBM-${run}`) && item.sent > 0).length >= K
  }, 120_000)
  const firstDeltaMs = Date.now() - promptedAt
  log(`stream: ${K} streams ${startedStreams ? "running" : "NOT all running"} after ${firstDeltaMs} ms`)
  await Bun.sleep(3_000)
  const pings = startPings()
  const serviceProfile = args["service-profile"] ? startServiceProfile(20_000) : undefined
  const mutations = await page.evaluate(installMutationCounter)
  void mutations
  const streamPhase: Record<string, unknown> = { firstDeltaMs, allStarted: startedStreams }
  const profiler = args.profile ? await startProfile(cdp) : undefined

  // a) following the stream, no input
  const idleRefreshMs = refresh
  const frames = !args["no-frames"]
  if (frames)
    streamPhase.follow = frameSummary(await measureFrames(page, "many-follow", () => Bun.sleep(6_000), idleRefreshMs))
  else await Bun.sleep(6_000)
  // b) Korean IME typing in the composer while K sessions stream (the active one among them)
  streamPhase.input = await typingWindow(page, 8_000)
  // c) wheel scroll in the active transcript while streaming
  const geometry = await page.evaluate(findScroller)
  if (geometry && frames) {
    const wheel = await page.context().newCDPSession(page)
    streamPhase.scroll = frameSummary(
      await measureFrames(
        page,
        "many-scroll",
        async () => {
          await scrollGesture(wheel, { x: geometry.x, y: geometry.y, distance: -6_000, speed: 3_000 })
          await scrollGesture(wheel, { x: geometry.x, y: geometry.y, distance: 6_000, speed: 3_000 })
        },
        idleRefreshMs,
      ),
    )
    await wheel.detach().catch(() => undefined)
  }
  if (profiler) streamPhase.profile = await profiler.stop(path.join(outDir, `${label}-renderer.cpuprofile`))
  // d) warm switches between streaming sessions
  const switches: Record<string, unknown>[] = []
  for (const target of streaming.slice(1, 5)) {
    switches.push({ tag: target.tag, ...(await switchTo(page, current, target)) })
    current = target
  }
  // Back to the first streaming session (the slowest switch: its view was detached while it streamed). With a profile
  // (OWN_PERF_PROFILE) it runs inside a frame trace, `many-switch-back`, for trace-tasks.ts.
  if (process.env.OWN_PERF_PROFILE) {
    const back: { result?: Awaited<ReturnType<typeof switchTo>> } = {}
    streamPhase.switchBackFrames = frameSummary(
      await measureFrames(
        page,
        "many-switch-back",
        async () => {
          back.result = await switchTo(page, current, active)
        },
        idleRefreshMs,
      ),
    )
    switches.push({ tag: active.tag, ...back.result })
  } else switches.push({ tag: active.tag, ...(await switchTo(page, current, active)) })
  current = active
  const switchMs = switches
    .map((item) => item.firstCorrectObservedMs)
    .filter((value): value is number => typeof value === "number")
  streamPhase.switch = {
    summary: summarize(switchMs),
    samples: switches.map((item) => [item.tag, item.firstCorrectObservedMs, item.via]),
  }
  // e) pages while streaming
  streamPhase.pages = await openPages(page, active)
  // f) sidebar fling while streaming
  if (frames) streamPhase.sidebar = await sidebarFling(page, idleRefreshMs)
  streamPhase.mutations = await page.evaluate(readMutationCounter)
  streamPhase.animations = await page.evaluate(animationCensus)
  streamPhase.service = { pingMs: pings.stop(), ...(serviceProfile ? { profile: await serviceProfile() } : {}) }
  streamPhase.window = await streamWindow("stream", streamBefore)
  phases.stream = streamPhase
  log(
    `stream: input ${JSON.stringify((streamPhase.input as { processing?: unknown }).processing)} follow ${JSON.stringify((streamPhase.follow as { intervals?: unknown } | undefined)?.intervals ?? null)}`,
  )

  const finished = await waitUntil(
    async () => {
      const state = await streamState()
      return state.streams.filter((item) => item.marker.startsWith(`OWNBM-${run}`) && item.finishedAt).length >= K
    },
    (STREAM_SECONDS + 240) * 1_000,
  )
  phases.streamEnd = {
    allFinished: finished,
    lastFinishMs: Date.now() - promptedAt,
    idle: await Promise.race([
      Promise.all(streaming.map((target) => service.waitIdle(target.id).catch(() => undefined))).then(() => true),
      Bun.sleep(60_000).then(() => false),
    ]),
    notifications: await page.evaluate(
      () => (window as unknown as { __ownbNotifications?: number }).__ownbNotifications ?? 0,
    ),
  }
  await Bun.sleep(3_000)

  // ---------------------------------------------------------------------------------------------- after
  phases.after = await idleWindow(page, cdp, "after", { gc: true, snapshot: args["heap-snapshot"] })
  log(`after: ${JSON.stringify((phases.after as { memory: { total?: unknown } }).memory.total)}`)

  // ---------------------------------------------------------------------------------------------- closed
  // A short filler session on screen, then the work sessions are deleted (the strongest "closed": nothing may keep them).
  if (fillers[0]) await switchTo(page, active, fillers[0])
  await Bun.sleep(1_500)
  for (const target of work)
    await service.request("DELETE", `/api/session/${target.id}`, { directory: target.directory }).catch(() => undefined)
  await Bun.sleep(10_000)
  phases.closed = {
    rows: await page.evaluate(() => document.querySelectorAll('[data-testid="session-row"]').length),
    dom: await domStats(page),
    memory: await memoryPoint("closed", { gc: true }),
  }
  log(`closed: ${JSON.stringify((phases.closed as { memory: { total?: unknown } }).memory.total)}`)

  // ---------------------------------------------------------------------------------------------- quit
  await quitShell(page)
  await browser.close().catch(() => undefined)
  const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(20_000).then(() => false)])
  report.shellExit = exited ? "app quit" : "killed"
  if (!exited) killTree(shellPid)
  page = undefined as unknown as Page

  // --------------------------------------------------------------------------------------------- helpers in scope
  async function memoryPoint(name: string, options: { gc?: boolean; snapshot?: boolean } = {}) {
    if (options.gc) {
      await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined)
      writeFileSync(`${heapFile}.gc`, "1")
      await Bun.sleep(2_500)
    }
    const heap = (await cdp.send("Runtime.getHeapUsage").catch(() => undefined)) as
      | { usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number }
      | undefined
    const dom = (await cdp.send("Memory.getDOMCounters").catch(() => undefined)) as
      | { documents: number; nodes: number; jsEventListeners: number }
      | undefined
    const sample = await proc.sample({ shell: shellPid, service: servicePids })
    const serviceHeap = lastHeapLine(options.gc)
    const connections = serviceConnections(sample)
    let snapshot: unknown
    if (options.snapshot) snapshot = await heapSnapshot(cdp, path.join(outDir, `${label}-${name}.heapsnapshot`))
    const chromium = options.gc && !args["no-memory-dump"] ? await chromiumBreakdown(sample) : undefined
    return {
      at: Math.round((Date.now() - startedAt) / 1000),
      total: { shell: totals(sample, isShell), service: totals(sample, isService), all: totals(sample) },
      roles: sample.roles,
      rendererHeapMB: heap
        ? {
            used: round(heap.usedSize / 1024 ** 2, 1),
            total: round(heap.totalSize / 1024 ** 2, 1),
            embedder: heap.embedderHeapUsedSize === undefined ? null : round(heap.embedderHeapUsedSize / 1024 ** 2, 1),
            backing: heap.backingStorageSize === undefined ? null : round(heap.backingStorageSize / 1024 ** 2, 1),
          }
        : null,
      domCounters: dom ?? null,
      serviceHeap,
      connections,
      ...(snapshot ? { snapshot } : {}),
      ...(chromium ? { chromium } : {}),
    }
  }

  /** memory-infra dump of the shell's processes, each labelled with its role from the process sample. */
  async function chromiumBreakdown(sample: ProcSample) {
    const dump = await memoryDump(browserCdp).catch((error: unknown) => ({
      success: false,
      error: String(error),
      processes: [],
    }))
    const roleOf = new Map(sample.rows.map((row) => [row.pid, row.role]))
    return {
      ...dump,
      processes: dump.processes.map((item) => ({ role: roleOf.get(item.pid) ?? "?", ...item })),
    }
  }

  async function idleWindow(
    target: Page,
    session: CDPSession,
    name: string,
    options: { gc?: boolean; snapshot?: boolean } = {},
  ) {
    const metricsBefore = await perfMetrics(session)
    const before = await proc.sample({ shell: shellPid, service: servicePids })
    const eventsBefore = events.snapshot()
    const timers = await target.evaluate(installTimerCounter)
    const serviceProfile = args["service-profile"] ? startServiceProfile(IDLE_SECONDS * 1_000 - 2_000) : undefined
    void timers
    const from = Date.now()
    await Bun.sleep(IDLE_SECONDS * 1_000)
    const after = await proc.sample({ shell: shellPid, service: servicePids })
    const metricsAfter = await perfMetrics(session)
    return {
      seconds: IDLE_SECONDS,
      cpu: cpuBetween(before, after),
      renderer: metricDelta(metricsBefore, metricsAfter, (Date.now() - from) / 1000),
      timers: await target.evaluate(readTimerCounter),
      events: eventRate(eventsBefore, events.snapshot(), (Date.now() - from) / 1000),
      load: loadBetween(load.samples, from, Date.now()),
      dom: await domStats(target),
      memory: await memoryPoint(name, options),
      ...(serviceProfile ? { serviceProfile: await serviceProfile() } : {}),
    }
  }

  async function streamPoint() {
    return {
      at: Date.now(),
      proc: await proc.sample({ shell: shellPid, service: servicePids }),
      metrics: await perfMetrics(cdp),
      events: events.snapshot(),
    }
  }

  /** CPU per process role, renderer task time, event volume and memory since `previous` (a `streamPoint`). */
  async function streamWindow(name: string, previous: Awaited<ReturnType<typeof streamPoint>>) {
    const point = await streamPoint()
    const seconds = (point.at - previous.at) / 1000
    const rate = eventRate(previous.events, point.events, seconds)
    return {
      name,
      seconds: round(seconds, 1),
      cpu: cpuBetween(previous.proc, point.proc),
      renderer: metricDelta(previous.metrics, point.metrics, seconds),
      events: {
        ...rate,
        perStreamFramesPerSecond: rate.framesPerSecond === null ? null : round(rate.framesPerSecond / K, 1),
      },
      load: loadBetween(load.samples, previous.at, point.at),
      memory: await memoryPoint(name),
    }
  }
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(`error: ${String(report.error).slice(0, 2_000)}`)
} finally {
  if (shell && shell.exitCode === null) {
    killTree(shell.pid)
    await Promise.race([shell.exited, Bun.sleep(10_000)])
  }
  await events.stop().catch(() => undefined)
  await proc.stop().catch(() => undefined)
  load.stop()
  await service.stop().catch(() => undefined)
  provider.stop()
  const left = leftovers()
  left.forEach((pid) => killTree(pid))
  report.leftoverElectron = left
  if (!appDataExisted) await removeTree(appData)
  report.osArtifactsCreated = removeNewOsArtifacts(machine.os)
  report.trayIconsRemoved = removeNewTrayIconSettings(electronDir, trayIconsBefore)
  report.machineUnchanged = sameMachine(machine, snapshotMachine())
  report.load = { whole: loadBetween(load.samples, startedAt, Date.now()) }
  report.durationS = Math.round((Date.now() - startedAt) / 1000)
  // Best effort: a process that is still letting go of a file must not cost the report.
  if (!args.keep)
    await removeTree(root).catch((error: unknown) => {
      report.cleanup = `temp root left: ${String(error)}`
    })
  clearTimeout(watchdog)
  const file = path.join(outDir, `${label}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2))
  log(`report: ${file}`)
  process.exit(report.error ? 1 : 0)
}

// ================================================================================================ helpers

/** The shell's first window opens off-screen (its id first in `windowIds`, its saved bounds at -32000). */
function offscreen() {
  const id = "many-sessions"
  const userData = path.dirname(settingsFile)
  mkdirSync(userData, { recursive: true })
  writeFileSync(settingsFile, JSON.stringify({ windowIds: [id], ownTrayHintShown: true }, null, "\t"))
  writeFileSync(
    path.join(userData, `window-state-${id}.json`),
    JSON.stringify({ x: -32000, y: -32000, width: 1440, height: 900 }),
  )
}

/** electron.exe processes started from this worktree's Electron or on this run's root. */
function leftovers() {
  const run = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${electronDir.replaceAll("'", "''")}', 'OrdinalIgnoreCase')) -or ($_.CommandLine -like '*${root.replaceAll("'", "''")}*') } | ForEach-Object { $_.ProcessId }) -join ','`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  return run.stdout.toString().trim().split(",").filter(Boolean).map(Number)
}

/** Established TCP connections to the service's port, per process role of the sample (who keeps how many streams). */
function serviceConnections(sample: ProcSample) {
  const port = new URL(service.url).port
  const run = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `@(Get-NetTCPConnection -State Established -RemotePort ${port} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const roleOf = new Map(sample.rows.map((row) => [row.pid, row.role]))
  const counts: Record<string, number> = {}
  for (const pid of run.stdout.toString().trim().split(",").filter(Boolean).map(Number)) {
    const role = roleOf.get(pid) ?? (pid === process.pid ? "bench" : "other")
    counts[role] = (counts[role] ?? 0) + 1
  }
  return counts
}

function lastHeapLine(gc?: boolean) {
  if (!existsSync(heapFile)) return null
  const lines = readFileSync(heapFile, "utf8").trim().split("\n")
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const pick = gc ? (parsed.findLast((line) => line.gc) ?? parsed.at(-1)) : parsed.at(-1)
  if (!pick) return null
  const mb = (value: unknown) => (typeof value === "number" ? round(value / 1024 ** 2, 1) : null)
  return {
    gc: pick.gc,
    heapSizeMB: mb(pick.heapSize),
    heapCapacityMB: mb(pick.heapCapacity),
    extraMemoryMB: mb(pick.extraMemorySize),
    rssMB: mb(pick.rss),
    externalMB: mb(pick.external),
    objectCount: pick.objectCount,
    moduleLoads: pick.moduleLoads,
    setups: pick.setups,
    locations: pick.locations,
    ...(pick.topTypes ? { topTypes: pick.topTypes } : {}),
  }
}

async function perfMetrics(session: CDPSession) {
  const result = (await session.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
  return Object.fromEntries(result.metrics.map((item) => [item.name, item.value]))
}

/** Renderer main-thread time per second (ms/s, i.e. ‰ of a core / 10) and counters between two metric reads. */
function metricDelta(before: Record<string, number>, after: Record<string, number>, seconds: number) {
  const per = (name: string, scale = 1) => round((((after[name] ?? 0) - (before[name] ?? 0)) * scale) / seconds, 1)
  return {
    taskMsPerS: per("TaskDuration", 1000),
    scriptMsPerS: per("ScriptDuration", 1000),
    layoutMsPerS: per("LayoutDuration", 1000),
    styleMsPerS: per("RecalcStyleDuration", 1000),
    layoutsPerS: per("LayoutCount"),
    styleRecalcsPerS: per("RecalcStyleCount"),
    nodes: after.Nodes,
    listeners: after.JSEventListeners,
    jsHeapUsedMB: round((after.JSHeapUsedSize ?? 0) / 1024 ** 2, 1),
  }
}

function frameSummary(measurement: Awaited<ReturnType<typeof measureFrames>>) {
  return {
    intervals: measurement.trace.intervals,
    frames: measurement.trace,
    raf: measurement.raf,
    longTasks: measurement.longTasks,
    longAnimationFrames: measurement.longAnimationFrames,
  }
}

/** Event Timing `duration` (input → next paint, 8 ms units) of the reported (≥ 16 ms) entries, plus how many. */
function paintStats(timings: readonly { duration: number }[]) {
  return { reported: timings.length, duration: summarize(timings.map((item) => item.duration)) }
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await Bun.sleep(800)
}

/**
 * Korean IME typing through CDP into the composer for `ms` (35 ms a key), then the composer cleared: input
 * processing (every event, own listener) and input → next paint (Event Timing entries of 16 ms and more).
 */
async function typingWindow(page: Page, ms: number) {
  const typing = await page.context().newCDPSession(page)
  await page.locator(COMPOSER).first().focus()
  await page.evaluate(installInputProbe, COMPOSER)
  const end = Date.now() + ms
  const typed = await typeIme(typing, imeWorkload(10_000), 35, () => Date.now() > end)
  const input = await page.evaluate(readInputProbe)
  await typing.detach().catch(() => undefined)
  await clearComposer(page)
  return { keystrokes: typed, ...inputLatency(input.events, input.timings), paint: paintStats(input.timings) }
}

async function clearComposer(page: Page) {
  await page
    .locator(COMPOSER)
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) element.value = ""
      else element.textContent = ""
      element.dispatchEvent(new InputEvent("input", { bubbles: true }))
    })
    .catch(() => undefined)
}

/**
 * Opens `target` from the sidebar (its row's mousedown starts the clock; PF7's probe: first frame with the
 * destination's markers visible and none of the source's). A row of a virtualized list is scrolled into the DOM
 * first; a session whose row cannot be found is reported as `via: "missing"`.
 */
async function switchTo(page: Page, source: Work | undefined, target: Work) {
  await page.evaluate(installMarkerLocator)
  await page.evaluate(findScroller).catch(() => undefined)
  const row = await findRow(page, target.title)
  if (!row) return { via: "missing", firstCorrectObservedMs: null }
  await page.evaluate(installSwitchProbe, {
    trigger: "[data-ownb-trigger]",
    destination: target.tag,
    source: source?.tag ?? "NONE",
    last: `OWNB-${target.tag}-`,
    limitMs: 5_000,
  })
  await row.evaluate((element) => {
    document.querySelectorAll("[data-ownb-trigger]").forEach((item) => item.removeAttribute("data-ownb-trigger"))
    element.setAttribute("data-ownb-trigger", "")
  })
  await row.scrollIntoViewIfNeeded().catch(() => undefined)
  // A busy renderer can miss Playwright's actionability window; the row's own click handler is the fallback.
  await row.click({ timeout: 10_000 }).catch(() =>
    row.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
      ;(element as HTMLElement).click()
    }),
  )
  await page
    .waitForFunction(() => (window as Window & { __ownbSwitch?: { done: boolean } }).__ownbSwitch?.done, undefined, {
      timeout: 15_000,
    })
    .catch(() => undefined)
  // Any marker of the destination counts as its content (`last`): a streaming answer's tail carries them too.
  const samples = (await page.evaluate(readSwitchProbe)).samples.map((item) => ({
    ...item,
    last: item.destination > 0,
  }))
  const result = classifySwitch(samples)
  await page
    .waitForFunction(
      (id) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === id,
      target.id,
      {
        timeout: 15_000,
      },
    )
    .catch(() => undefined)
  return { via: "row", firstCorrectObservedMs: result.firstCorrectObservedMs }
}

/** The sidebar row of `title`; a virtualized list (over 200 roots) is scrolled from its top until the row mounts. */
async function findRow(page: Page, title: string) {
  const row = page.locator('[data-testid="session-row"]', { hasText: title }).first()
  if ((await row.count()) > 0) return row
  for (let step = 0; step < 80; step++) {
    const moved = await page.evaluate((index) => {
      let scroller = document.querySelector('[data-testid="session-row"]')?.parentElement ?? null
      while (
        scroller &&
        !(
          scroller.scrollHeight > scroller.clientHeight + 4 &&
          /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
        )
      )
        scroller = scroller.parentElement
      if (!scroller) return false
      const before = scroller.scrollTop
      scroller.scrollTop = index === 0 ? 0 : before + scroller.clientHeight * 0.8
      return index === 0 || scroller.scrollTop !== before
    }, step)
    await Bun.sleep(150)
    if ((await row.count()) > 0) return row
    if (!moved) return undefined
  }
  return undefined
}

/** Time from the button click to the page's first frame with content, and to three frames without DOM changes. */
async function openPages(page: Page, back: Work) {
  // The desktop renderer uses a memory router: pages open from their sidebar buttons (`togglePage`), the team
  // section from the settings nav; the same button closes its page again.
  const pages = [
    {
      name: "accounts",
      click: ['[data-testid="sidebar-accounts"]'],
      selector: '[data-testid="page-accounts"]',
      close: '[data-testid="sidebar-accounts"]',
    },
    {
      name: "limits",
      click: ['[data-testid="sidebar-limits"]'],
      selector: '[data-testid="page-limits"]',
      close: '[data-testid="sidebar-limits"]',
    },
    {
      name: "settings",
      click: ['[data-testid="sidebar-settings"]'],
      selector: '[data-testid="page-settings"]',
      close: undefined,
    },
    {
      name: "team",
      click: ['[data-testid="settings-nav-team"]'],
      selector: '[data-testid="settings-team"]',
      close: '[data-testid="sidebar-settings"]',
    },
  ]
  const results: Record<string, unknown> = {}
  for (const item of pages) {
    results[item.name] = await page.evaluate(
      (input) =>
        new Promise<{ visibleMs: number | null; settledMs: number | null; nodes: number; missing?: string }>(
          (resolve) => {
            const button = input.click.map((selector) => document.querySelector<HTMLElement>(selector)).find(Boolean)
            if (!button) return resolve({ visibleMs: null, settledMs: null, nodes: 0, missing: input.click.join(" ") })
            let visible: number | null = null
            let quiet = 0
            let changes = 0
            const observer = new MutationObserver((records) => (changes += records.length))
            observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
            const start = performance.now()
            button.click()
            const frame = () => {
              const at = performance.now() - start
              const element = document.querySelector(input.selector)
              if (visible === null && element && (element.textContent ?? "").trim().length > 20) visible = at
              if (visible !== null) {
                quiet = changes === 0 ? quiet + 1 : 0
                changes = 0
              }
              if ((visible !== null && quiet >= 3) || at > 8_000) {
                observer.disconnect()
                resolve({
                  visibleMs: visible === null ? null : Math.round(visible),
                  settledMs: visible === null ? null : Math.round(at),
                  nodes: element ? element.querySelectorAll("*").length : 0,
                })
                return
              }
              requestAnimationFrame(() => setTimeout(frame, 0))
            }
            requestAnimationFrame(() => setTimeout(frame, 0))
          },
        ),
      item,
    )
    await Bun.sleep(600)
    if (item.close) {
      await page
        .locator(item.close)
        .first()
        .click()
        .catch(() => undefined)
      await Bun.sleep(400)
    }
  }
  const open = await page.evaluate(
    (id) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === id,
    back.id,
  )
  if (!open) await switchTo(page, undefined, back)
  await settle(page)
  return results
}

/** Presented frames while the sidebar list is flung down and up. */
async function sidebarFling(page: Page, idleRefreshMs: number) {
  const list = await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid="session-row"]')
    const first = rows[0] as HTMLElement | undefined
    if (!first) return null
    let scroller: HTMLElement | null = first.parentElement
    while (
      scroller &&
      !(scroller.scrollHeight > scroller.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
    )
      scroller = scroller.parentElement
    if (!scroller) return null
    const rect = scroller.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height / 2, 300),
      height: scroller.scrollHeight,
      rows: rows.length,
    }
  })
  if (!list) return { skipped: "no scrollable sidebar list" }
  const wheel = await page.context().newCDPSession(page)
  const frames = await measureFrames(
    page,
    "many-sidebar",
    async () => {
      await scrollGesture(wheel, { x: list.x, y: list.y, distance: Math.min(list.height, 20_000), speed: 4_000 })
      await scrollGesture(wheel, { x: list.x, y: list.y, distance: -Math.min(list.height, 20_000), speed: 4_000 })
    },
    idleRefreshMs,
  )
  await wheel.detach().catch(() => undefined)
  return { rowsInDom: list.rows, scrollHeight: list.height, ...frameSummary(frames) }
}

async function domStats(page: Page) {
  return page.evaluate(() => ({
    nodes: document.getElementsByTagName("*").length,
    sidebarRows: document.querySelectorAll('[data-testid="session-row"]').length,
    sidebarNodes: document.querySelector('[data-testid="sidebar"]')?.querySelectorAll("*").length ?? 0,
    transcriptNodes: document.querySelector('[data-testid="transcript"]')?.querySelectorAll("*").length ?? 0,
  }))
}

async function startProfile(session: CDPSession) {
  await session.send("Profiler.enable")
  await session.send("Profiler.setSamplingInterval", { interval: 500 })
  await session.send("Profiler.start")
  return {
    async stop(file: string) {
      const result = (await session.send("Profiler.stop")) as { profile: CpuProfile }
      writeFileSync(file, JSON.stringify(result.profile))
      return { file, ...summarizeProfile(result.profile, WEB) }
    },
  }
}

async function heapSnapshot(session: CDPSession, file: string) {
  const chunks: string[] = []
  const listener = (payload: { chunk: string }) => chunks.push(payload.chunk)
  session.on("HeapProfiler.addHeapSnapshotChunk", listener)
  await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false })
  session.off("HeapProfiler.addHeapSnapshotChunk", listener)
  const text = chunks.join("")
  writeFileSync(file, text)
  return { file, ...summarizeHeapSnapshot(text) }
}

/**
 * Asks the service's heap plugin for a JavaScriptCore sampling profile of the next `ms` (the whole process: core,
 * every Location's plugins); the returned function waits for its summary.
 */
function startServiceProfile(ms: number) {
  const result = `${heapFile}.prof.json`
  rmSync(result, { force: true })
  writeFileSync(`${heapFile}.prof`, String(ms))
  return async () => {
    for (let waited = 0; waited < ms + 30_000 && !existsSync(result); waited += 500) await Bun.sleep(500)
    if (!existsSync(result)) return { error: "no profile written" }
    const text = readFileSync(result, "utf8")
    writeFileSync(path.join(outDir, `${label}-service-${Date.now()}.prof.json`), text)
    return JSON.parse(text) as Record<string, unknown>
  }
}

function startPings() {
  const samples: number[] = []
  let running = true
  void (async () => {
    while (running) {
      const start = performance.now()
      await service.request("GET", "/api/info").catch(() => undefined)
      samples.push(performance.now() - start)
      await Bun.sleep(500)
    }
  })()
  return {
    stop: () => {
      running = false
      return summarize(samples)
    },
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true
    await Bun.sleep(500)
  }
  return false
}

// ------------------------------------------------------------------------------------------------ in-page code

/** Replaces the page's `Notification` before own-web reads it: nothing reaches Windows; the calls are counted. */
function notificationStub() {
  return `(() => {
  const host = window;
  host.__ownbNotifications = 0;
  class Stub { constructor() { host.__ownbNotifications++; } close() {} }
  Stub.permission = "granted";
  Stub.requestPermission = async () => "granted";
  Object.defineProperty(host, "Notification", { value: Stub, configurable: true, writable: true });
})()`
}

/** DOM mutation records per region (sidebar, transcript, other) until `readMutationCounter`. */
function installMutationCounter() {
  const host = window as Window & {
    __ownbMutations?: { counts: Record<string, number>; kinds: Record<string, number>; start: number; stop(): void }
  }
  host.__ownbMutations?.stop()
  const counts: Record<string, number> = {}
  // What changes outside the transcript, by kind (region, mutation type, attribute, target), for the report.
  const kinds: Record<string, number> = {}
  const describe = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    if (!element) return "#text"
    const testid = element.getAttribute("data-testid")
    const name = element.getAttribute("class")?.split(" ")[0]
    return `${element.tagName.toLowerCase()}${testid ? `[${testid}]` : name ? `.${name}` : ""}`
  }
  const region = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    if (!element) return "other"
    if (element.closest('[data-testid="sidebar"]')) return "sidebar"
    if (element.closest('[data-testid="transcript"]')) return "transcript"
    if (element.closest('[data-testid="composer"]')) return "composer"
    return "other"
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const key = region(record.target)
      counts[key] = (counts[key] ?? 0) + 1
      if (key === "transcript") continue
      const kind = `${key} ${record.type}${record.attributeName ? ` ${record.attributeName}` : ""} ${describe(record.target)}`
      if (kind in kinds || Object.keys(kinds).length < 300) kinds[kind] = (kinds[kind] ?? 0) + 1
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  host.__ownbMutations = { counts, kinds, start: performance.now(), stop: () => observer.disconnect() }
  return true
}

function readMutationCounter() {
  const host = window as Window & {
    __ownbMutations?: { counts: Record<string, number>; kinds: Record<string, number>; start: number; stop(): void }
  }
  const probe = host.__ownbMutations
  if (!probe) return null
  probe.stop()
  const seconds = (performance.now() - probe.start) / 1000
  const perSecond = (value: number) => Math.round((value / seconds) * 10) / 10
  return {
    ...Object.fromEntries(Object.entries(probe.counts).map(([key, value]) => [key, Math.round(value / seconds)])),
    kinds: Object.fromEntries(
      Object.entries(probe.kinds)
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([key, value]) => [key, perSecond(value)]),
    ),
  }
}

/** Timer and animation-frame callbacks the page schedules until `readTimerCounter` (wraps the globals). */
function installTimerCounter() {
  type Host = Window & { __ownbTimers?: { counts: Record<string, number>; start: number; restore(): void } }
  const host = window as Host
  host.__ownbTimers?.restore()
  const counts: Record<string, number> = { setTimeout: 0, setInterval: 0, requestAnimationFrame: 0, fired: 0 }
  const original = {
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    requestAnimationFrame: window.requestAnimationFrame,
  }
  const wrap = <T extends (...items: never[]) => unknown>(name: keyof typeof original, fn: T) =>
    ((callback: unknown, ...rest: unknown[]) => {
      counts[name]!++
      const wrapped =
        typeof callback === "function"
          ? (...inner: unknown[]) => (counts.fired!++, (callback as (...items: unknown[]) => unknown)(...inner))
          : callback
      return (fn as unknown as (...items: unknown[]) => unknown).call(window, wrapped, ...rest)
    }) as unknown as T
  window.setTimeout = wrap("setTimeout", original.setTimeout)
  window.setInterval = wrap("setInterval", original.setInterval)
  window.requestAnimationFrame = wrap("requestAnimationFrame", original.requestAnimationFrame)
  host.__ownbTimers = {
    counts,
    start: performance.now(),
    restore: () => Object.assign(window, original),
  }
  return true
}

function readTimerCounter() {
  type Host = Window & { __ownbTimers?: { counts: Record<string, number>; start: number; restore(): void } }
  const probe = (window as Host).__ownbTimers
  if (!probe) return null
  probe.restore()
  const seconds = (performance.now() - probe.start) / 1000
  return Object.fromEntries(
    Object.entries(probe.counts).map(([key, value]) => [`${key}PerS`, Math.round((value / seconds) * 10) / 10]),
  )
}

/** Running CSS animations and transitions now, by name and the region and component of their element. */
function animationCensus() {
  const counts: Record<string, number> = {}
  for (const animation of document.getAnimations()) {
    if (animation.playState !== "running") continue
    const target = (animation.effect as KeyframeEffect | null)?.target
    const element = target instanceof Element ? target : null
    const region = element?.closest('[data-testid="sidebar"]')
      ? "sidebar"
      : element?.closest('[data-testid="transcript"]')
        ? "transcript"
        : element?.closest('[data-testid="composer"]')
          ? "composer"
          : "other"
    const component =
      element?.closest("[data-component]")?.getAttribute("data-component") ??
      element?.getAttribute("class")?.split(" ")[0] ??
      element?.tagName.toLowerCase() ??
      "?"
    const name =
      (animation as Animation & { animationName?: string; transitionProperty?: string }).animationName ??
      (animation as Animation & { transitionProperty?: string }).transitionProperty ??
      animation.constructor.name
    const key = `${region} ${component} ${name}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).toSorted((a, b) => b[1] - a[1]))
}

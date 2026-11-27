// PF1, PF6 and PF8 on the packaged shell (01 §6.6, §16.3; 05 §9.1): win-unpacked exe, never installed, CDP on a
// free port, in one temp root. Fake credentials only; every process started here is stopped.
//
//   bun scripts/perf-shell.ts --out <build-desktop.ps1 output> [--shots <dir>] [--label perf-shell]
//        [--warm 5] [--cold 3] [--pf6-seconds 240] [--pf8-minutes 10] [--fillers 200] [--turns 1000]
//        [--only pf1] [--exe <own-desktop.exe>] [--web <own-web build>]   (--only pf1: stop after PF1)
//
// Service: the upstream server from source with own.accounts (one fake OpenAI key account) + own.telemetry, like
// own-web's perf backend, with 200 short sessions and one 2,000-message session imported. It is registered as
// service-own.json in the temp XDG_STATE_HOME, so the shell discovers it (service warm in every run; the launcher's
// cold start is measured by gates.ts). The warm-up run opens the long session, so later warm runs restore into it.
//
//  PF1  shell main start (own:shell-start, the first line of the main bundle) → own:sessions-visible (the list painted
//       from the renderer cache, or from the server on a cold userData; never before the first contentful paint was
//       presented, own-web perf/marks.ts), and own:sessions-fresh. Warm ×N (userData kept), cold ×M
//       (%APPDATA%\dev.own.opencode.desktop removed first; the run refuses to start when that folder existed before
//       it). Gate (01 §6.6, 05 §9.1): p95 over the warm runs ≤ 1,000 ms (`pass`). Spawn → visible is reported too
//       (`spawnPass`, not gated): it adds Windows' process creation before any shell code runs, which swung by up to
//       +600 ms on single runs here. Every run also records the renderer's boot breakdown (navigation timing, paint
//       timing, long animation frames), where PF1 regressions show first (05 R-D12).
//  PF6  one more warm launch: input probes are installed as soon as CDP connects (window listeners for the PF2 event
//       types, Event Timing with durationThreshold 16, long tasks), then Korean IME typing into the restored session's
//       composer (CDP Input.imeSetComposition, 35 ms per key, bursts of 24 keys) until 240 s after spawn. Budget: no
//       input event with processing (processingEnd − startTime) over 50 ms in the first 90 s; 90–240 s recorded.
//  PF8  the same window, idle, minimized (hidden) for N minutes: a CDP trace (devtools.timeline: TimerInstall with
//       stack, TimerFire, FireAnimationFrame, toplevel tasks) and per-process CPU time sampled every minute. Budget:
//       no timer that fires repeatedly while hidden (a 60 s countdown excepted), renderer CPU ≈ 0 (< 1 % of a core).
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CDPSession, Page } from "@playwright/test"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { buildHistory, firstMarker, lastMarker, sessionID } from "../../own-web/e2e/performance/fixture/history"
import { startStreamProvider } from "../../own-web/e2e/performance/fixture/stream-provider"
import { percentile, summarize } from "../../own-web/e2e/performance/metrics"
import {
  imeWorkload,
  loadHistory,
  measureFrames,
  scrollGesture,
  scroller,
  scrollToBottom,
  typeIme,
  waitForMarker,
  waitForStableBottom,
} from "../../own-web/e2e/performance/support"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { cdpTargets, rawCdp } from "./cdp-raw"
import { registerService } from "./dev-service"
import { connect, marks } from "./probe"
import {
  alive,
  appDataDir,
  cleanEnv,
  collectLogs,
  freePort,
  installUi,
  killTree,
  removeNewOsArtifacts,
  sameMachine,
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
    shots: { type: "string" },
    label: { type: "string", default: "perf-shell" },
    warm: { type: "string", default: "5" },
    cold: { type: "string", default: "3" },
    "pf6-seconds": { type: "string", default: "240" },
    "pf8-minutes": { type: "string", default: "10" },
    fillers: { type: "string", default: "200" },
    turns: { type: "string", default: "1000" },
    keep: { type: "boolean", default: false },
    only: { type: "string", default: "pf1,pf3,pf6,pf8" },
    trace: { type: "string" },
  },
}).values

const out = args.out ? path.resolve(args.out) : undefined
const exe = args.exe ?? (out ? path.join(out, "desktop", "win-unpacked", "own-desktop.exe") : undefined)
const web = args.web ?? (out ? path.join(out, "web") : undefined)
if (!exe || !existsSync(exe)) throw new Error(`--exe/--out: packaged shell not found (${exe})`)
if (!web || !existsSync(path.join(web, "index.html"))) throw new Error(`--web/--out: own-web build not found (${web})`)
const label = args.label!
const shots = args.shots
if (shots) mkdirSync(shots, { recursive: true })
const WARM = Number(args.warm)
const COLD = Number(args.cold)
const PF6_SECONDS = Number(args["pf6-seconds"])
const PF6_GATE_SECONDS = 90
const TRACE_SECONDS = 4
// Diagnostics only (e.g. Chromium switches to compare): OWN_PERF_SHELL_ARGS="--a --b".
const SHELL_ARGS = (process.env.OWN_PERF_SHELL_ARGS ?? "").split(" ").filter(Boolean)
const PF8_MINUTES = Number(args["pf8-minutes"])
const FILLERS = Number(args.fillers)
const TURNS = Number(args.turns)
const ONLY = new Set(args.only!.split(",").map((item) => item.trim().toLowerCase()))
/** Thrown after PF1 when neither PF6 nor PF8 was asked for (`--only pf1`): skips to the cleanup. */
class Done extends Error {}
const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownDesktopPerfFakeKey000000000001"
const COMPOSER = '#own-composer-input, [data-testid="composer"] textarea, [data-testid="composer"] [contenteditable="true"]'
const log = (message: string) => console.error(`[perf-shell] ${message}`)

const appData = appDataDir()
if (existsSync(appData))
  throw new Error(`${appData} exists: cold runs remove it, so this run only starts when the folder is absent`)
const machine = snapshotMachine()
const report: Record<string, unknown> = {
  label,
  exe,
  web,
  rpcHash: RPC_HASH,
  machine: { os: `${os.type()} ${os.release()}`, cpus: os.cpus()[0]?.model, cores: os.cpus().length },
  before: machine,
}
const root = path.join(os.tmpdir(), `own-desktop-perf-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
mkdirSync(configDir, { recursive: true })

// ---------------------------------------------------------------- service with the fixture

const provider = startStreamProvider({ models: [MODEL] })
const service = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-desktop-perf-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: provider.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
      extra: { compaction: { auto: false } },
    }),
})
let shell: ReturnType<typeof Bun.spawn> | undefined
const watchdog = setTimeout(
  async () => {
    log("watchdog: stopping everything")
    if (shell) killTree(shell.pid)
    killTree(service.pid)
    provider.stop()
    await removeTree(appData)
    process.exit(2)
  },
  (PF6_SECONDS + PF8_MINUTES * 60 + 20 * 60) * 1000,
)
try {
  const control = path.join(service.paths.ownHome, "control")
  mkdirSync(control, { recursive: true })
  const rpc = async (method: string, input: unknown) => {
    const response = await service.request("POST", `/api/rpc/own.accounts/${method}`, {
      body: { input },
      query: { "location[directory]": control },
      directory: control,
    })
    const body = (await response.json()) as { output?: Record<string, unknown> }
    if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
    return body.output ?? {}
  }
  const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY })
  const account = added.account as { providerID: string }
  const model = { providerID: account.providerID, id: MODEL }
  await service.waitForModels([model])
  const template = await service.createSession({ title: "template", model })
  const exported = (await service.call("GET", `/api/experimental/session/${template.id}/export`)) as {
    data: { info: Record<string, unknown> }
  }
  const importSession = async (tag: string, title: string, turns: number, startMs: number) => {
    const history = buildHistory({ tag, turns, model, startMs })
    const id = sessionID(tag, startMs)
    const info: Record<string, unknown> = {
      ...exported.data.info,
      id,
      title,
      model,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: startMs, updated: startMs + turns * 60_000 },
    }
    delete info.revert
    delete info.parentID
    delete info.fork
    await service.call("POST", "/api/experimental/session/import", {
      body: { info, messages: history.messages, location: { directory: service.paths.workspace } },
    })
    return id
  }
  const importStarted = Date.now()
  const base = Date.UTC(2026, 5, 1)
  for (let index = 0; index < FILLERS; index++)
    await importSession(`F${index}`, `짧은 세션 ${index + 1} · 결제 웹훅 재시도`, 3, base - (index + 1) * 3_600_000)
  const longTitle = `긴 세션 · 메시지 ${TURNS * 2}개`
  const longID = await importSession("L", longTitle, TURNS, base + 3_600_000)
  await service.request("DELETE", `/api/session/${template.id}`).catch(() => undefined)
  const password = atob(service.authorization.slice("Basic ".length)).slice("opencode:".length)
  await registerService({
    url: service.url,
    authorization: service.authorization,
    password,
    stateHome: xdg.XDG_STATE_HOME,
    channel: "own",
  })
  const ownHome = service.paths.ownHome
  const version = JSON.parse(await Bun.file(path.join(import.meta.dir, "../package.json")).text()).version as string
  installUi(ownHome, { version, web, hash: RPC_HASH })
  report.fixture = { sessions: FILLERS + 1, fillers: FILLERS, longMessages: TURNS * 2, importMs: Date.now() - importStarted }
  log(`fixture ready: ${FILLERS + 1} sessions (${Date.now() - importStarted} ms)`)

  const env = cleanEnv({
    ...xdg,
    OWN_HOME: ownHome,
    OWN_CONFIG_DIR: configDir,
    // Comparison runs only: Chromium's GPU raster instead of the shell's CPU raster (05 R-D13, src/main/raster.ts).
    ...(process.env.OWN_DESKTOP_GPU_RASTER === "1" ? { OWN_DESKTOP_GPU_RASTER: "1" } : {}),
  })

  // -------------------------------------------------------------- launches
  const launch = async () => {
    const cdp = await freePort()
    const spawnedAt = Date.now()
    shell = Bun.spawn([exe, `--remote-debugging-port=${cdp}`, ...SHELL_ARGS], { env, stdout: "ignore", stderr: "ignore" })
    const { browser, page } = await connect(`http://127.0.0.1:${cdp}`, 120_000)
    return { browser, page, spawnedAt, connectedMs: Date.now() - spawnedAt, pid: shell.pid, cdp }
  }
  const close = async (page: Page, browser: { close(): Promise<void> }) => {
    await quitShell(page)
    await browser.close().catch(() => undefined)
    const exited = await Promise.race([shell!.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    if (!exited) killTree(shell!.pid)
    await Bun.sleep(1_000)
  }
  // `--trace <file>`: one more warm launch under Chromium startup tracing (`--trace-startup`, from process start in
  // every process), for profiling PF1. The trace is written after `TRACE_SECONDS`; summarized per main thread.
  const tracedLaunch = async (file: string) => {
    const port = await freePort()
    rmSync(file, { force: true })
    const categories = [
      "toplevel",
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "blink.user_timing",
      "loading",
      "v8.execute",
      "v8",
      "navigation",
    ]
      .concat(process.env.OWN_TRACE_CATEGORIES ? process.env.OWN_TRACE_CATEGORIES.split(",") : [])
      .join(",")
    const spawnedAt = Date.now()
    shell = Bun.spawn(
      [
        exe,
        `--remote-debugging-port=${port}`,
        ...SHELL_ARGS,
        `--trace-startup=${categories}`,
        `--trace-startup-file=${file}`,
        `--trace-startup-duration=${TRACE_SECONDS}`,
        "--trace-startup-format=json",
      ],
      { env, stdout: "ignore", stderr: "ignore" },
    )
    const connected = await connect(`http://127.0.0.1:${port}`, 60_000)
    const measured = await pf1(connected.page, spawnedAt)
    for (let waited = 0; waited < 30_000 && !existsSync(file); waited += 250) await Bun.sleep(250)
    await Bun.sleep(2_000)
    await close(connected.page, connected.browser)
    if (!existsSync(file)) return { file, error: "no trace written" }
    const parsed = JSON.parse(await Bun.file(file).text()) as { traceEvents?: TraceEvent[] } | TraceEvent[]
    const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])
    return { file, spawnToVisibleMs: measured.spawnToVisibleMs, events: events.length, summary: summarizeTrace(events) }
  }
  const pf1 = async (page: Page, spawnedAt: number) => {
    await page.waitForFunction(() => performance.getEntriesByName("own:sessions-visible", "mark").length > 0, undefined, {
      timeout: 60_000,
      polling: 50,
    })
    await page
      .waitForFunction(() => performance.getEntriesByName("own:sessions-fresh", "mark").length > 0, undefined, {
        timeout: 30_000,
        polling: 100,
      })
      .catch(() => undefined)
    const at = await page.evaluate(() => ({
      origin: performance.timeOrigin,
      visible: performance.getEntriesByName("own:sessions-visible", "mark")[0]?.startTime ?? null,
      fresh: performance.getEntriesByName("own:sessions-fresh", "mark")[0]?.startTime ?? null,
      fcp: performance.getEntriesByName("first-contentful-paint", "paint")[0]?.startTime ?? null,
      rows: document.querySelectorAll('[data-testid="session-row"]').length,
    }))
    const own = await marks(page)
    const boot = await page.evaluate(bootBreakdown)
    return {
      spawnToVisibleMs: at.visible === null ? null : Math.round(at.origin + at.visible - spawnedAt),
      spawnToFreshMs: at.fresh === null ? null : Math.round(at.origin + at.fresh - spawnedAt),
      shellStartToVisibleMs:
        at.visible === null || own.shellToOrigin === undefined ? null : Math.round(own.shellToOrigin + at.visible),
      spawnToOriginMs: Math.round(at.origin - spawnedAt),
      // First presented contentful frame (paint timing). own:sessions-visible is never earlier (perf/marks.ts).
      spawnToFirstContentfulPaintMs: at.fcp === null ? null : Math.round(at.origin + at.fcp - spawnedAt),
      rows: at.rows,
      marks: own,
      boot,
    }
  }

  // Warm-up (discarded): Defender scans the fresh exe; the long session becomes the restored route.
  {
    const run = await launch()
    await pf1(run.page, run.spawnedAt)
    await run.page.locator('[data-testid="session-row"]', { hasText: longTitle }).first().click()
    await run.page.waitForFunction(
      (id) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === id,
      longID,
      { timeout: 30_000 },
    )
    await Bun.sleep(1_500)
    await close(run.page, run.browser)
    log("warm-up done")
  }
  const warm: Awaited<ReturnType<typeof pf1>>[] = []
  for (let index = 0; index < WARM; index++) {
    const run = await launch()
    warm.push(await pf1(run.page, run.spawnedAt))
    if (index === 0 && shots) windowShot(run.pid, path.join(shots, `${label}-pf1-warm-window.png`))
    await close(run.page, run.browser)
    log(`warm ${index + 1}: ${warm.at(-1)?.spawnToVisibleMs} ms`)
  }
  if (args.trace) report.pf1Trace = await tracedLaunch(args.trace)
  const cold: Awaited<ReturnType<typeof pf1>>[] = []
  for (let index = 0; index < COLD; index++) {
    await removeTree(appData)
    const run = await launch()
    cold.push(await pf1(run.page, run.spawnedAt))
    await close(run.page, run.browser)
    log(`cold ${index + 1}: ${cold.at(-1)?.spawnToVisibleMs} ms`)
  }
  // Cold runs left an empty userData: one warm-up restores the long session route for PF6.
  if (ONLY.has("pf6") || ONLY.has("pf8")) {
    const run = await launch()
    await pf1(run.page, run.spawnedAt)
    await run.page.locator('[data-testid="session-row"]', { hasText: longTitle }).first().click()
    await run.page.waitForFunction(
      (id) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === id,
      longID,
      { timeout: 30_000 },
    )
    await Bun.sleep(1_500)
    await close(run.page, run.browser)
  }
  const values = (list: typeof warm, key: "spawnToVisibleMs" | "spawnToFreshMs" | "shellStartToVisibleMs") =>
    list.map((item) => item[key]).filter((value): value is number => typeof value === "number")
  report.pf1 = {
    budgetMs: 1_000,
    warm,
    cold,
    warmSpawnToVisible: summarize(values(warm, "spawnToVisibleMs")),
    warmShellStartToVisible: summarize(values(warm, "shellStartToVisibleMs")),
    warmFresh: summarize(values(warm, "spawnToFreshMs")),
    coldSpawnToVisible: summarize(values(cold, "spawnToVisibleMs")),
    coldShellStartToVisible: summarize(values(cold, "shellStartToVisibleMs")),
    warmBoot: summarizeBoot(warm.map((run) => run.boot)),
    gate: "p95(warm own:shell-start → own:sessions-visible) ≤ 1,000 ms (01 §6.6, 05 §9.1)",
    pass:
      values(warm, "shellStartToVisibleMs").length === WARM &&
      (percentile(values(warm, "shellStartToVisibleMs"), 95) ?? Infinity) <= 1_000,
    spawnPass:
      values(warm, "spawnToVisibleMs").length === WARM &&
      (percentile(values(warm, "spawnToVisibleMs"), 95) ?? Infinity) <= 1_000,
  }
  log(
    `PF1 warm p95: spawn → visible ${percentile(values(warm, "spawnToVisibleMs"), 95)} ms, ` +
      `shell start → visible ${percentile(values(warm, "shellStartToVisibleMs"), 95)} ms`,
  )
  // -------------------------------------------------------------- PF3 in the shell: the 2,000-message session
  // own-web's PF3 bench (e2e/performance/timeline-scroll.bench.ts) against the packaged window instead of Edge: the
  // restored long session, its whole history paged in, then wheel flings up and down (4,000 px/s, 10 s) under a
  // frame trace. The shell's raster setup (05 §9.2 R-D13) is what differs from the Edge run.
  if (ONLY.has("pf3")) {
    const run = await launch()
    try {
      const last = lastMarker("L", TURNS)
      // Cold runs left a fresh userData, so the long session is opened from the list rather than restored.
      const open = await run.page
        .evaluate((id) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === id, longID)
        .catch(() => false)
      if (!open) {
        await run.page.locator('[data-testid="session-row"]', { hasText: longTitle }).first().click({ timeout: 30_000 })
        await run.page.waitForFunction(
          (id) => document.querySelector('[data-testid="composer"]')?.getAttribute("data-session-id") === id,
          longID,
          { timeout: 30_000 },
        )
      }
      if (!(await waitForMarker(run.page, last, 60_000))) throw new Error("PF3: the long session did not render")
      const start = await scroller(run.page)
      const history = await loadHistory(run.page, {
        x: start.x,
        y: start.y,
        tag: "L",
        first: firstMarker("L"),
        timeoutMs: 240_000,
        idleMs: 15_000,
      })
      await scrollToBottom(run.page)
      await waitForStableBottom(run.page)
      const geometry = await scroller(run.page)
      const cdpScroll = await run.page.context().newCDPSession(run.page)
      const speed = 4_000
      const distance = (speed * 10) / 2
      const frames = await measureFrames(run.page, "PF3 shell scroll", async () => {
        await scrollGesture(cdpScroll, { x: geometry.x, y: geometry.y, distance, speed })
        await scrollGesture(cdpScroll, { x: geometry.x, y: geometry.y, distance: -distance, speed })
      })
      await cdpScroll.detach().catch(() => undefined)
      const { presentedIntervals: _p, rafIntervals: _r, longTaskDurations: _l, ...summary } = frames
      report.pf3 = {
        budget: "presented frame interval p95 ≤ 16.7 ms (01 §6.6), rAF intervals > 2F ≤ 1 % (03 §20.1), long tasks 0",
        shellArgs: SHELL_ARGS,
        history,
        scrolledHeight: geometry.scrollHeight,
        ...summary,
        gate: {
          pass:
            (summary.trace.intervals.p95 ?? Infinity) <= 16.7 &&
            (summary.raf.longFrameRatio ?? 1) <= 0.01 &&
            summary.longTasks.over50 === 0,
        },
      }
      log(`PF3: ${JSON.stringify((report.pf3 as { gate: unknown }).gate)} ${JSON.stringify(summary.trace.intervals)}`)
    } finally {
      await close(run.page, run.browser)
    }
  }
  if (!ONLY.has("pf6") && !ONLY.has("pf8")) throw new Done()

  // -------------------------------------------------------------- PF6: input during the first 240 s
  const run = await launch()
  await run.page.evaluate(installStartupProbe)
  const probeFrom = await run.page.evaluate(() => performance.timeOrigin + performance.now())
  await run.page.waitForSelector(COMPOSER, { timeout: 60_000 })
  await run.page.locator(COMPOSER).first().click()
  const firstInputAt = Date.now()
  const cdp: CDPSession = await run.page.context().newCDPSession(run.page)
  const steps = imeWorkload(24)
  let bursts = 0
  let sent = 0
  const deadline = run.spawnedAt + PF6_SECONDS * 1000
  while (Date.now() < deadline) {
    sent += await typeIme(cdp, steps, 35, () => Date.now() >= deadline)
    bursts++
    if (bursts % 8 === 0)
      await run.page
        .locator(COMPOSER)
        .first()
        .evaluate((element) => {
          if (element instanceof HTMLTextAreaElement) element.value = ""
          else element.textContent = ""
          element.dispatchEvent(new InputEvent("input", { bubbles: true }))
        })
    await Bun.sleep(250)
  }
  const probe = await run.page.evaluate(readStartupProbe)
  report.pf6 = analyzePf6(probe, run.spawnedAt, probeFrom, firstInputAt, sent)
  log(`PF6: ${JSON.stringify((report.pf6 as { gate: unknown }).gate)}`)
  await run.page
    .locator(COMPOSER)
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) element.value = ""
      else element.textContent = ""
      element.dispatchEvent(new InputEvent("input", { bubbles: true }))
    })

  // -------------------------------------------------------------- PF8: hidden and idle
  // Playwright emulates focus and keeps the pages it attaches to "active"; PF8 runs with it disconnected and bare CDP
  // clients only (cdp-raw.ts): one on the page for its visibility, one on the browser for the trace.
  await cdp.detach().catch(() => undefined)
  await run.browser.close().catch(() => undefined)
  await Bun.sleep(30_000)
  const cdpBase = `http://127.0.0.1:${run.cdp}`
  const targets = await cdpTargets(cdpBase)
  const pageCdp = await rawCdp(targets.page!)
  const minimize = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, "window-input.ps1"),
      "-ProcessId",
      String(run.pid),
      "-Action",
      "minimize",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  for (let tries = 0; tries < 40; tries++) {
    if ((await pageCdp.evaluate<string>("document.visibilityState")) === "hidden") break
    await Bun.sleep(250)
  }
  const visibility = await pageCdp.evaluate<string>("document.visibilityState")
  pageCdp.close()
  const browserCdp = await rawCdp(targets.browser)
  const trace: TraceEvent[] = []
  browserCdp.on("Tracing.dataCollected", (params) => trace.push(...((params.value as TraceEvent[] | undefined) ?? [])))
  await browserCdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.stack", "toplevel"],
      recordMode: "recordContinuously",
    },
  })
  const hiddenAt = Date.now()
  const samples: { minute: number; cpu: Record<string, number> }[] = []
  let previous = cpuByType(run.pid)
  for (let minute = 1; minute <= PF8_MINUTES; minute++) {
    await Bun.sleep(60_000)
    const now = cpuByType(run.pid)
    const delta: Record<string, number> = {}
    for (const [type, ms] of Object.entries(now)) delta[type] = Math.round(ms - (previous[type] ?? 0))
    samples.push({ minute, cpu: delta })
    previous = now
    log(`PF8 minute ${minute}: ${JSON.stringify(delta)}`)
  }
  const done = browserCdp.once("Tracing.tracingComplete")
  await browserCdp.send("Tracing.end")
  await done
  const hiddenMs = Date.now() - hiddenAt
  browserCdp.close()
  report.pf8 = analyzePf8(trace, samples, hiddenMs, visibility, minimize.stdout.toString().trim())
  log(`PF8: ${JSON.stringify((report.pf8 as { gate: unknown }).gate)}`)
  // 앱 종료 (05 §7.3): the window's X would only hide it to the tray. The page goes with the shell, so nothing waits.
  const quitCdp = await rawCdp(targets.page!)
  void quitCdp.evaluate('void window.own.app?.quit("app")').catch(() => undefined)
  await Bun.sleep(500)
  quitCdp.close()
  const exited = await Promise.race([shell!.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
  if (!exited) killTree(shell!.pid)
} catch (error) {
  if (!(error instanceof Done)) {
    report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    log(`error: ${String(report.error).slice(0, 1_500)}`)
  }
} finally {
  if (shell && alive(shell.pid)) killTree(shell.pid)
  const logs = collectLogs(shots ? path.join(shots, `${label}-logs`) : undefined)
  if (logs) {
    const { text: _text, ...counts } = logs
    report.logs = counts
  }
  await service.stop().catch(() => undefined)
  provider.stop()
  await removeTree(appData)
  report.osArtifactsCreated = removeNewOsArtifacts(machine.os)
  report.after = snapshotMachine()
  report.unchanged = sameMachine(machine, report.after as ReturnType<typeof snapshotMachine>)
  clearTimeout(watchdog)
  if (!args.keep) await removeTree(root)
  if (shots) writeFileSync(path.join(shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.error ? 1 : 0)
}

// ---------------------------------------------------------------- PF1 boot breakdown (serialized into the page)

interface BootBreakdown {
  /** Navigation timing, ms from the time origin. */
  readonly responseEnd?: number
  readonly domInteractive?: number
  readonly domContentLoaded?: number
  /** Scripts and styles from oc://renderer that finished before own:sessions-visible. */
  readonly files: number
  readonly bytes: number
  readonly lastFileEnd?: number
  /** Scripts fetched after own:boot, i.e. lazy chunks the first render waited for or that raced it. */
  readonly afterBoot: readonly { readonly name: string; readonly start: number; readonly end: number }[]
  /** Chromium paint timing (first-paint, first-contentful-paint). */
  readonly paint: Record<string, number>
  /** Long animation frames before the list was visible, with their longest scripts. */
  readonly frames: readonly {
    readonly start: number
    readonly duration: number
    readonly blocking: number
    readonly scripts: readonly { readonly source: string; readonly duration: number; readonly start: number }[]
  }[]
}

async function bootBreakdown(): Promise<BootBreakdown> {
  const buffered = (type: string) =>
    new Promise<PerformanceEntry[]>((resolve) => {
      try {
        const observer = new PerformanceObserver((list) => {
          observer.disconnect()
          resolve(list.getEntries())
        })
        observer.observe({ type, buffered: true })
        setTimeout(() => {
          observer.disconnect()
          resolve([])
        }, 200)
      } catch {
        resolve([])
      }
    })
  const loaf = (await buffered("long-animation-frame")) as (PerformanceEntry & {
    blockingDuration?: number
    scripts?: {
      startTime: number
      duration: number
      invoker?: string
      sourceURL?: string
      sourceFunctionName?: string
      sourceCharPosition?: number
    }[]
  })[]
  const visible = performance.getEntriesByName("own:sessions-visible", "mark")[0]?.startTime ?? Infinity
  const boot = performance.getEntriesByName("own:boot", "mark")[0]?.startTime ?? Infinity
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
  const files = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
    (entry) => /\.(m?js|css)(\?|$)/.test(entry.name) && entry.responseEnd <= visible,
  )
  const round = (value: number | undefined) => (value === undefined ? undefined : Math.round(value))
  return {
    responseEnd: round(navigation?.responseEnd),
    domInteractive: round(navigation?.domInteractive),
    domContentLoaded: round(navigation?.domContentLoadedEventEnd),
    files: files.length,
    bytes: files.reduce((sum, entry) => sum + (entry.decodedBodySize || entry.encodedBodySize || 0), 0),
    lastFileEnd: files.length ? Math.round(Math.max(...files.map((entry) => entry.responseEnd))) : undefined,
    afterBoot: files
      .filter((entry) => entry.startTime >= boot && /\.m?js(\?|$)/.test(entry.name))
      .map((entry) => ({
        name: entry.name.split("/").pop() ?? entry.name,
        start: Math.round(entry.startTime),
        end: Math.round(entry.responseEnd),
      })),
    paint: Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)])),
    frames: loaf
      .filter((frame) => frame.startTime <= visible)
      .map((frame) => ({
        start: Math.round(frame.startTime),
        duration: Math.round(frame.duration),
        blocking: Math.round(frame.blockingDuration ?? 0),
        scripts: (frame.scripts ?? [])
          .toSorted((a, b) => b.duration - a.duration)
          .slice(0, 4)
          .map((script) => ({
            source: `${script.invoker ?? ""} ${script.sourceFunctionName ?? ""} ${String(script.sourceURL ?? "").split("/").pop()}:${script.sourceCharPosition ?? ""}`.trim(),
            duration: Math.round(script.duration),
            start: Math.round(script.startTime),
          })),
      })),
  }
}

function summarizeBoot(list: readonly BootBreakdown[]) {
  const pick = (key: "responseEnd" | "domInteractive" | "domContentLoaded" | "lastFileEnd" | "files" | "bytes") =>
    summarize(list.map((item) => item[key]).filter((value): value is number => typeof value === "number"))
  return {
    responseEnd: pick("responseEnd"),
    domInteractive: pick("domInteractive"),
    domContentLoaded: pick("domContentLoaded"),
    lastFileEnd: pick("lastFileEnd"),
    files: pick("files"),
    bytes: pick("bytes"),
    lazyBeforeList: list[0]?.afterBoot.map((entry) => entry.name) ?? [],
  }
}

// ---------------------------------------------------------------- in-page probe (serialized into the page)

type StartupProbe = {
  events: { type: string; start: number; end: number }[]
  timings: { name: string; startTime: number; processingStart: number; processingEnd: number; duration: number }[]
  longTasks: { start: number; duration: number }[]
  frames: { start: number; duration: number; blocking: number }[]
}

function installStartupProbe() {
  const host = window as Window & { __ownPf6?: StartupProbe }
  if (host.__ownPf6) return
  const probe: StartupProbe = { events: [], timings: [], longTasks: [], frames: [] }
  host.__ownPf6 = probe
  const types = ["keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]
  const listener = (event: Event) => probe.events.push({ type: event.type, start: event.timeStamp, end: performance.now() })
  types.forEach((type) => window.addEventListener(type, listener))
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      if (!types.includes(entry.name)) continue
      probe.timings.push({
        name: entry.name,
        startTime: entry.startTime,
        processingStart: entry.processingStart,
        processingEnd: entry.processingEnd,
        duration: entry.duration,
      })
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit)
  new PerformanceObserver((list) =>
    list.getEntries().forEach((entry) => probe.longTasks.push({ start: entry.startTime, duration: entry.duration })),
  ).observe({ type: "longtask", buffered: true })
  try {
    new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) =>
        probe.frames.push({
          start: entry.startTime,
          duration: entry.duration,
          blocking: (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0,
        }),
      ),
    ).observe({ type: "long-animation-frame", buffered: true })
  } catch {}
}

async function readStartupProbe() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))
  const probe = (window as Window & { __ownPf6?: StartupProbe }).__ownPf6
  return { origin: performance.timeOrigin, probe }
}

function analyzePf6(
  result: { origin: number; probe?: StartupProbe },
  spawnedAt: number,
  probeFrom: number,
  firstInputAt: number,
  keystrokes: number,
) {
  const probe = result.probe ?? { events: [], timings: [], longTasks: [], frames: [] }
  const toSpawn = (t: number) => result.origin + t - spawnedAt
  const key = (name: string, start: number) => `${name}:${Math.round(start * 10)}`
  const reported = new Map(probe.timings.map((entry) => [key(entry.name, entry.startTime), entry]))
  const samples = probe.events.map((event) => {
    const entry = reported.get(key(event.type, event.start))
    return {
      at: toSpawn(event.start),
      type: event.type,
      processing: Math.max(event.end - event.start, entry ? entry.processingEnd - entry.startTime : 0),
      paint: entry?.duration ?? 0,
    }
  })
  // Event Timing entries of events the listener did not see (e.g. before it was installed) count too.
  const seen = new Set(probe.events.map((event) => key(event.type, event.start)))
  for (const entry of probe.timings)
    if (!seen.has(key(entry.name, entry.startTime)))
      samples.push({
        at: toSpawn(entry.startTime),
        type: entry.name,
        processing: entry.processingEnd - entry.startTime,
        paint: entry.duration,
      })
  const window_ = (from: number, to: number) => {
    const inside = samples.filter((sample) => sample.at >= from && sample.at < to)
    const processing = inside.map((sample) => sample.processing)
    const tasks = probe.longTasks.filter((task) => toSpawn(task.start) >= from && toSpawn(task.start) < to)
    return {
      events: inside.length,
      over16: processing.filter((value) => value > 16).length,
      over50: processing.filter((value) => value > 50).length,
      processing: summarize(processing),
      eventToPaintMax: inside.length ? Math.max(...inside.map((sample) => sample.paint)) : null,
      longTasks: tasks.length,
      longTaskMax: tasks.length ? Math.round(Math.max(...tasks.map((task) => task.duration))) : 0,
      worst: inside
        .toSorted((a, b) => b.processing - a.processing)
        .slice(0, 5)
        .map((sample) => ({ at: Math.round(sample.at), type: sample.type, processing: Math.round(sample.processing) })),
    }
  }
  const first = window_(0, PF6_GATE_SECONDS * 1000)
  return {
    budget: "0 input events with processing > 50 ms in the first 90 s after spawn",
    probeInstalledAtMs: Math.round(probeFrom - spawnedAt),
    firstInputAtMs: firstInputAt - spawnedAt,
    keystrokes,
    first90s: first,
    from90to240s: window_(PF6_GATE_SECONDS * 1000, PF6_SECONDS * 1000),
    longTasksBeforeFirstInput: probe.longTasks
      .filter((task) => toSpawn(task.start) < firstInputAt - spawnedAt)
      .map((task) => ({ at: Math.round(toSpawn(task.start)), ms: Math.round(task.duration) })),
    gate: { pass: first.events > 0 && first.over50 === 0, over50: first.over50, events: first.events },
  }
}

// ---------------------------------------------------------------- PF1 trace summary

/**
 * Per main thread (browser = the shell's main process, renderer = own-web): the own:* user-timing marks and every
 * top-level task over 8 ms, with its direct children by name (EvaluateScript, v8.compile, Layout, …), in ms from
 * the first traced event. Enough to see what the renderer waited for and what kept each thread busy.
 */
function summarizeTrace(events: TraceEvent[]) {
  const t0 = Math.min(...events.filter((event) => event.ts > 0).map((event) => event.ts))
  const ms = (us: number) => Math.round((us - t0) / 100) / 10
  const names = new Map<string, string>()
  for (const event of events)
    if (event.ph === "M" && event.name === "thread_name") names.set(`${event.pid}:${event.tid}`, String(event.args?.name))
  const threads = [...names.entries()].filter(([, name]) => name === "CrBrowserMain" || name === "CrRendererMain")
  const result: Record<string, unknown> = {}
  for (const [key, name] of threads) {
    const own = events.filter((event) => `${event.pid}:${event.tid}` === key)
    const marks = own
      .filter((event) => event.cat.includes("blink.user_timing") && event.name.startsWith("own:"))
      .map((event) => ({ name: event.name, at: ms(event.ts) }))
    const complete = own.filter((event) => event.ph === "X" && typeof event.dur === "number")
    if (!complete.length && !marks.length) continue
    complete.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
    const tasks: { at: number; ms: number; children: Record<string, number> }[] = []
    const stack: { event: TraceEvent; task?: (typeof tasks)[number] }[] = []
    for (const event of complete) {
      while (stack.length && stack.at(-1)!.event.ts + (stack.at(-1)!.event.dur ?? 0) <= event.ts) stack.pop()
      const parent = stack.at(-1)
      const isTask = event.name.endsWith("RunTask")
      let task: (typeof tasks)[number] | undefined
      if (isTask && !parent && (event.dur ?? 0) >= 8_000) {
        task = { at: ms(event.ts), ms: Math.round((event.dur ?? 0) / 100) / 10, children: {} }
        tasks.push(task)
      }
      if (parent?.task && parent.event.name.endsWith("RunTask")) {
        const label = event.name === "FunctionCall" || event.name === "EvaluateScript"
          ? `${event.name} ${String((event.args?.data as { url?: string } | undefined)?.url ?? "").split("/").pop()}`.trim()
          : event.name
        parent.task.children[label] = Math.round(((parent.task.children[label] ?? 0) + (event.dur ?? 0) / 1000) * 10) / 10
      }
      stack.push({ event, task })
    }
    result[`${name} ${key}`] = {
      marks,
      tasks: tasks.slice(0, 60).map((task) => ({
        ...task,
        children: Object.fromEntries(Object.entries(task.children).toSorted((a, b) => b[1] - a[1]).slice(0, 5)),
      })),
    }
  }
  return result
}

// ---------------------------------------------------------------- PF8 analysis

interface TraceEvent {
  readonly name: string
  readonly cat: string
  readonly ph: string
  readonly ts: number
  readonly dur?: number
  readonly pid: number
  readonly tid: number
  readonly args?: { readonly data?: Record<string, unknown>; readonly name?: string }
}

function analyzePf8(
  trace: TraceEvent[],
  samples: { minute: number; cpu: Record<string, number> }[],
  hiddenMs: number,
  visibility: string,
  minimize: string,
) {
  const installs = new Map<string, { timeout?: number; singleShot?: boolean; stack?: string }>()
  const fires = new Map<string, number>()
  let animationFrames = 0
  let busyUs = 0
  // The renderer's main thread by name (trace metadata), for its busy time.
  const rendererMain = new Set(
    trace
      .filter((event) => event.ph === "M" && event.name === "thread_name")
      .filter((event) => (event.args as { name?: string } | undefined)?.name === "CrRendererMain")
      .map((event) => `${event.pid}:${event.tid}`),
  )
  for (const event of trace) {
    const data = event.args?.data ?? {}
    if (event.name === "TimerInstall") {
      const stack = (data.stackTrace as { functionName?: string; url?: string; lineNumber?: number }[] | undefined)?.[0]
      installs.set(`${event.pid}:${String(data.timerId)}`, {
        timeout: data.timeout as number | undefined,
        singleShot: data.singleShot as boolean | undefined,
        stack: stack ? `${stack.functionName || "(anonymous)"} ${String(stack.url ?? "").split("/").pop()}:${stack.lineNumber ?? ""}` : undefined,
      })
    }
    if (event.name === "TimerFire") {
      const id = `${event.pid}:${String(data.timerId)}`
      fires.set(id, (fires.get(id) ?? 0) + 1)
    }
    if (event.name === "FireAnimationFrame") animationFrames++
    // "RunTask" or "ThreadControllerImpl::RunTask" (toplevel), by Chromium version.
    if (event.name.endsWith("RunTask") && event.ph === "X" && rendererMain.has(`${event.pid}:${event.tid}`))
      busyUs += event.dur ?? 0
  }
  const timers = [...fires.entries()].map(([id, count]) => ({ id, count, ...installs.get(id) }))
  const repeating = timers.filter((timer) => timer.count >= 2)
  const countdown = (timer: (typeof timers)[number]) => timer.timeout !== undefined && timer.timeout >= 59_000
  const offending = repeating.filter((timer) => !countdown(timer))
  const rendererCpuMs = samples.reduce((sum, sample) => sum + (sample.cpu.renderer ?? 0), 0)
  const rendererCpuPct = hiddenMs > 0 ? (rendererCpuMs / hiddenMs) * 100 : null
  return {
    budget: "hidden + idle: no repeating timer (60 s countdown excepted), renderer CPU ≈ 0 (< 1 % of one core)",
    minimize,
    visibility,
    hiddenMs,
    timerFires: timers.reduce((sum, timer) => sum + timer.count, 0),
    timers: timers.slice(0, 30),
    repeating,
    animationFrames,
    rendererMainThreadBusyMs: Math.round(busyUs / 1000),
    cpuSamples: samples,
    rendererCpuMs,
    rendererCpuPct: rendererCpuPct === null ? null : Math.round(rendererCpuPct * 1000) / 1000,
    gate: {
      pass: visibility === "hidden" && offending.length === 0 && rendererCpuPct !== null && rendererCpuPct < 1,
      repeatingTimers: offending.length,
      rendererCpuPct,
    },
  }
}

/** CPU ms per process type of the shell tree (browser, renderer, gpu-process, utility), from Win32_Process. */
function cpuByType(pid: number): Record<string, number> {
  const script =
    `$all = Get-CimInstance Win32_Process; $tree = @{ ${pid} = $true }; ` +
    `do { $added = $false; foreach ($p in $all) { if (-not $tree.ContainsKey([int]$p.ProcessId) -and $tree.ContainsKey([int]$p.ParentProcessId)) { $tree[[int]$p.ProcessId] = $true; $added = $true } } } while ($added); ` +
    `$out = @{}; foreach ($p in $all) { if ($tree.ContainsKey([int]$p.ProcessId) -and $p.Name -eq 'own-desktop.exe') { ` +
    `$type = if ($p.CommandLine -match '--type=([\\w-]+)') { $Matches[1] } else { 'browser' }; ` +
    `if ($type -eq 'utility' -and $p.CommandLine -match '--utility-sub-type=([\\w.]+)') { $type = 'utility:' + $Matches[1] }; ` +
    `$ms = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000; if ($out.ContainsKey($type)) { $out[$type] += $ms } else { $out[$type] = $ms } } }; ` +
    `$out | ConvertTo-Json -Compress`
  const run = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    return JSON.parse(run.stdout.toString().trim() || "{}") as Record<string, number>
  } catch {
    return {}
  }
}

// One huge session on the built shell (never installed): what opening, paging and switching cost when a single
// session holds 1, 10 or 100 GB (or 200k short messages), on the service and in the UI. Fake credentials only; one
// root `C:\t\bigs-<label>` (service, OWN_HOME, XDG_*, TEMP and the shell's userData); every process started here is
// stopped.
//
//   bun scripts/perf-big-session.ts --label <name> [--shape screens|small|text] [--tiers 1,10,100] [--messages 200000]
//        [--fillers 50] [--pages 30] [--reps 3] [--no-ui] [--no-prompt] [--profile] [--fresh] [--delete-data]
//        [--web <own-web build>] [--shell-args "<switches>"] [--out <dir>] [--root <dir>] [--detach-sample]
//        [--quiet-paging [--quiet-network] [--heap-snapshot]] [--dump-every 100]
//
// Data (big-session/seed.ts): the service starts once in the root, a fake OpenAI key account and `--fillers` short
// sessions are imported (the sidebar), and the big session `B` (`M` for `--shape small`, `T` for `text`) is imported with a
// template turn; then, with the service stopped, the session is grown in place in the service's SQLite file, tier by
// tier (`--tiers` in GB of database file, or `--messages` rows). The root is kept between runs (`--fresh` starts over,
// `--delete-data` removes it at the end), so a later run continues at the next tier.
//
// Per tier:
//   db        direct SQLite timings on the stopped database: the newest page (30 rows) and a page 20 rows deep in
//   service   start to ready on the big database; `GET /api/session` (list); the open requests (session row, newest
//             30 messages; median of `--reps`) and `--pages` older pages of 20 (time, bytes); service memory
//   ui        the shell (unpackaged `out/`, off-screen like perf-many-sessions.ts): boot; open B from the sidebar (row
//             mousedown → first frame with B's markers, → B's last answer visible); paging up `--pages` pages (time per
//             page from request to response, main-thread long tasks and frame gaps after each page, renderer heap); a
//             wheel fling over the loaded history; jump to the end; opening the biggest visible tool output; switching
//             to a filler and back (`--reps`); renderer heap, DOM counters and process memory after a full GC
//   profile   (`--profile`) a renderer CPU profile of the cold open and of the paging, summarized per function and file
//   detached  (`--detach-sample`) the renderer's memory after a critical memory-pressure signal (Chromium purges its
//             allocators' free pages and its caches, as the OS asks it to when memory runs short), and again after the
//             bench's CDP connection is closed (DevTools keeps the network bodies it saw while it is attached)
//   quiet     (`--quiet-paging`) instead of the paging and everything after it: Playwright detaches after the cold open
//             and a bare CDP connection (big-session/raw-cdp.ts, no Network domain, so DevTools keeps no response
//             bodies in the renderer) wheels up `--pages` pages, counted by the page's own resource timing; a
//             memory-infra dump (every allocator of every process) with the renderer's private bytes at the start, every
//             `--dump-every` pages, at the end, after a critical memory-pressure signal and 30 s later;
//             `--quiet-network` enables the Network domain on that connection (what the plain paging's sessions do);
//             `--heap-snapshot` saves a JS heap snapshot of the page at the start and at the end
//   prompt    one prompt on B with the fake provider until idle (the runner reloads history since the last compaction)
//
// Isolation: the process environment is cut to a strict allowlist before anything starts (no user names, mail, tokens
// or provider settings reach a child), HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP point into the root, the service and
// CDP listen on free ports (never 28538, asserted), and the page is watched for any request to port 28538.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Database } from "bun:sqlite"
import type { Browser, CDPSession, Page } from "@playwright/test"
import type { OpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { startStreamProvider } from "../../own-web/e2e/performance/fixture/stream-provider"
import { sessionID } from "../../own-web/e2e/performance/fixture/history"
import { classifySwitch, round, summarize } from "../../own-web/e2e/performance/metrics"
import {
  findScroller,
  installMarkerLocator,
  installSwitchProbe,
  readSwitchProbe,
} from "../../own-web/e2e/performance/probes"
import { measureFrames, scrollGesture } from "../../own-web/e2e/performance/support"
import { RPC_HASH } from "../src/shared/rpc-hash"
import {
  captureTemplates,
  compileTemplates,
  dropTemplateRows,
  grow,
  importTemplateSession,
  marker,
  markerTag,
  type RawTemplates,
  type SeedState,
  type Shape,
} from "./big-session/seed"
import { rawBrowser, rawRenderer } from "./big-session/raw-cdp"
import { registerService } from "./dev-service"
import { summarizeProfile, type CpuProfile } from "./many-sessions/cpu-profile"
import { memoryDump } from "./many-sessions/memory-dump"
import { addAccount, sessionImporter, startBenchService } from "./many-sessions/service"
import { isService, isShell, startProcSampler, totals } from "./many-sessions/proc"
import { connect, waitForMarks } from "./probe"
import { cleanEnv, freePort, installUi, killTree, PACKAGE, quitShell, xdgDirs } from "./run-kit"

const args = parseArgs({
  options: {
    label: { type: "string" },
    shape: { type: "string", default: "screens" },
    tiers: { type: "string", default: "1" },
    messages: { type: "string" },
    fillers: { type: "string", default: "50" },
    pages: { type: "string", default: "30" },
    reps: { type: "string", default: "3" },
    "no-ui": { type: "boolean", default: false },
    "no-prompt": { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    "detach-sample": { type: "boolean", default: false },
    "quiet-paging": { type: "boolean", default: false },
    "dump-every": { type: "string", default: "100" },
    "quiet-network": { type: "boolean", default: false },
    "heap-snapshot": { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    "delete-data": { type: "boolean", default: false },
    web: { type: "string" },
    "shell-args": { type: "string", default: "--disable-features=CalculateNativeWinOcclusion" },
    out: { type: "string" },
    root: { type: "string" },
  },
}).values

if (!args.label || !/^[a-z0-9-]+$/.test(args.label)) throw new Error("--label <lowercase name> is required")
const SHAPE = args.shape as Shape
if (!["screens", "small", "text"].includes(SHAPE)) throw new Error("--shape screens|small|text")
const TIERS = args.messages
  ? args.messages.split(",").map((value) => ({ messages: Number(value) }))
  : args.tiers!.split(",").map((value) => ({ gb: Number(value) }))
const FILLERS = Number(args.fillers)
const PAGES = Number(args.pages)
const REPS = Number(args.reps)
const DUMP_EVERY = Number(args["dump-every"])
const SHELL_ARGS = args["shell-args"]!.split(" ").filter(Boolean)
const WEB = path.resolve(args.web ?? path.join(PACKAGE, "../own-web/dist"))
const MODEL = "gpt-5.5"
const LIVE_PORT = "28538"
const TAG = { screens: "B", small: "M", text: "T" }[SHAPE]

// ------------------------------------------------------------------------------------------------ environment
// A strict allowlist: system paths only. Everything a child needs beyond that is set below to the root.
const ALLOWED =
  /^(SystemRoot|windir|Path|PATHEXT|ComSpec|OS|PROCESSOR_[A-Z_]+|NUMBER_OF_PROCESSORS|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|ProgramData|SystemDrive)$/i
// `--root` keeps parallel stages apart; the default is one root per label.
const root = args.root ? path.resolve(args.root) : path.join("C:\\t", `bigs-${args.label}`)
if (args.fresh) await removeTree(root)
const dirs = {
  home: path.join(root, "home"),
  tmp: path.join(root, "tmp"),
  appData: path.join(root, "appdata"),
  localAppData: path.join(root, "localappdata"),
}
Object.values(dirs).forEach((dir) => mkdirSync(dir, { recursive: true }))
const dropped = Object.keys(process.env).filter((name) => !ALLOWED.test(name))
dropped.forEach((name) => delete process.env[name])
Object.assign(process.env, {
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appData,
  LOCALAPPDATA: dirs.localAppData,
  TEMP: dirs.tmp,
  TMP: dirs.tmp,
  PSModulePath: [
    path.join(process.env.SystemRoot ?? "C:\\Windows", "system32", "WindowsPowerShell", "v1.0", "Modules"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsPowerShell", "Modules"),
  ].join(";"),
})

const outDir = path.resolve(args.out ?? path.join(root, "reports"))
mkdirSync(outDir, { recursive: true })
const log = (message: string) => console.error(`[bigs ${new Date().toISOString().slice(11, 19)}] ${message}`)
log(`env: kept ${Object.keys(process.env).toSorted().join(", ")}; dropped ${dropped.length} names`)

if (!existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("run `bun run build` first")
if (!existsSync(path.join(WEB, "index.html"))) throw new Error(`--web: own-web build not found (${WEB})`)

const statePath = path.join(root, "seed-state.json")
const templatePath = path.join(root, "seed-templates.json")
const heapFile = path.join(root, "service-heap.jsonl")
const dbFile = path.join(root, "svc", "opencode.db")
const electronPath = createRequire(import.meta.url)("electron") as unknown as string
const electronDir = realpathSync(path.dirname(electronPath))
const startedAt = Date.now()
const report: Record<string, unknown> = {
  label: args.label,
  date: new Date().toISOString(),
  shape: SHAPE,
  config: { tiers: TIERS, fillers: FILLERS, pages: PAGES, reps: REPS, shellArgs: SHELL_ARGS },
  machine: {
    os: `${os.type()} ${os.release()}`,
    cpus: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    bun: Bun.version,
  },
  tiers: [] as unknown[],
}
const provider = startStreamProvider({ models: [MODEL] })
const proc = startProcSampler()
const live: { service?: OpencodeServer; shell?: ReturnType<typeof Bun.spawn> } = {}

try {
  // ---------------------------------------------------------------------------------------------- fixture
  const fixture = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as Fixture)
    : await createFixture()
  const templates = compileTemplates(JSON.parse(readFileSync(templatePath, "utf8")) as RawTemplates)
  report.fixture = { session: fixture.state.sessionID, fillers: fixture.fillers.length, title: fixture.title }

  for (const [index, tier] of TIERS.entries()) {
    const name = "gb" in tier ? `${tier.gb}GB` : `${tier.messages}msg`
    log(`tier ${name}: growing …`)
    const seeded = grow({
      file: dbFile,
      state: fixture.state,
      templates,
      ...("gb" in tier ? { targetBytes: tier.gb! * 1024 ** 3 } : { targetMessages: tier.messages }),
      log,
      // Rows of every kind through core decoder before the first bulk write.
      decode: index === 0 && fixture.state.rows === 0 ? await coreDecoder() : undefined,
    })
    writeFileSync(statePath, JSON.stringify(fixture, null, 2))
    log(`tier ${name}: ${JSON.stringify(seeded)}`)
    const result: Record<string, unknown> = {
      tier: name,
      seeded,
      session: { ...fixture.state },
      files: {
        db: statSync(dbFile).size,
        wal: existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0,
      },
      load: machineLoad(),
    }
    log(`load: ${JSON.stringify(result.load)}`)
    ;(report.tiers as unknown[]).push(result)
    result.db = directReads(fixture.state.sessionID)
    log(`db: ${JSON.stringify(result.db)}`)
    result.service = await serviceTier(fixture)
    if (!args["no-ui"]) result.ui = await uiTier(fixture, name)
    if (!args["no-prompt"]) result.prompt = await promptTier(fixture)
    await stopService()
    result.loadAfter = machineLoad()
    log(`load after: ${JSON.stringify(result.loadAfter)}`)
    writeFileSync(path.join(outDir, `${args.label}.json`), JSON.stringify(report, null, 2))
  }
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(`error: ${String(report.error).slice(0, 3_000)}`)
} finally {
  if (live.shell && live.shell.exitCode === null) killTree(live.shell.pid)
  await stopService()
  provider.stop()
  await proc.stop().catch(() => undefined)
  report.leftoverElectron = leftovers()
  ;(report.leftoverElectron as number[]).forEach((pid) => killTree(pid))
  report.durationS = Math.round((Date.now() - startedAt) / 1000)
  const file = path.join(outDir, `${args.label}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2))
  log(`report: ${file}`)
  if (args["delete-data"]) {
    // The report goes with the root unless --out points elsewhere.
    await removeTree(root).catch((error: unknown) => log(`cleanup: ${String(error)}`))
  }
  process.exit(report.error ? 1 : 0)
}

// ================================================================================================ phases

interface Fixture {
  state: SeedState
  title: string
  directory: string
  fillers: { id: string; tag: string; title: string; directory: string; last: string }[]
  appVersion: string
  ownHome: string
  model: { providerID: string; id: string }
}

/** Service once: account, fillers, the big session with its template turn; then the template rows are captured. */
async function createFixture(): Promise<Fixture> {
  log("fixture: service …")
  const service = await startService()
  const model = await addAccount(service, path.join(root, "svc", "own-home", "control"), MODEL)
  const importSession = await sessionImporter(service, model)
  const base = Date.UTC(2026, 8, 1)
  const fillers = []
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
  const template = await service.createSession({ title: "template", model })
  const exported = (await service.call("GET", `/api/experimental/session/${template.id}/export`)) as {
    data: { info: Record<string, unknown> }
  }
  await service.request("DELETE", `/api/session/${template.id}`).catch(() => undefined)
  const title = {
    screens: "아주 긴 세션 · 화면 자동화",
    small: "아주 긴 대화 · 짧은 메시지",
    text: "아주 긴 세션 · 코드 작업",
  }[SHAPE]
  const id = sessionID(TAG, base + 3_600_000)
  const ids = await importTemplateSession(service, {
    info: exported.data.info,
    id,
    title,
    directory: service.paths.workspace,
    model,
  })
  const fixture: Fixture = {
    state: {
      sessionID: id,
      tag: TAG,
      shape: SHAPE,
      turn: 0,
      seq: 0,
      time: base + 3_600_000,
      stepsSinceCompaction: 0,
      rows: 0,
      bytes: 0,
      compactions: 0,
      images: 0,
      counts: {},
    },
    title,
    directory: service.paths.workspace,
    fillers,
    appVersion: "",
    ownHome: path.join(root, "svc", "own-home"),
    model,
  }
  await stopService()
  writeFileSync(templatePath, JSON.stringify(captureTemplates(dbFile, id, ids), null, 2))
  dropTemplateRows(dbFile, id)
  writeFileSync(statePath, JSON.stringify(fixture, null, 2))
  log(`fixture: ${FILLERS} fillers + ${TAG} (${id})`)
  return fixture
}

/**
 * Core row decoder, loaded at run time: core sources do not typecheck under this package (vite/client declares
 * `*.wasm` differently), so they stay out of its program.
 */
async function coreDecoder() {
  const module = (await import(path.join(PACKAGE, "..", "core", "src", "session", "history.ts"))) as {
    decodeMessageRowSync: (row: unknown) => unknown
  }
  return module.decodeMessageRowSync
}

async function startService() {
  const started = await startBenchService({ mode: "source", root, heapFile, providerBaseURL: provider.baseURL })
  if (new URL(started.service.url).port === LIVE_PORT) throw new Error("the bench service got port 28538")
  live.service = started.service
  return started.service
}

async function stopService() {
  const service = live.service
  live.service = undefined
  await service?.stop().catch(() => undefined)
}

/** The stopped database read directly: what the page queries cost without the service around them. */
function directReads(id: string) {
  const db = new Database(dbFile, { readonly: true })
  const time = (run: () => unknown) => {
    const start = performance.now()
    const value = run()
    return { ms: round(performance.now() - start), value }
  }
  const newest = time(() =>
    db
      .query<{ bytes: number }, [string]>(
        "select length(data) as bytes from (select data from session_message where session_id = ? order by seq desc limit 30)",
      )
      .all(id)
      .reduce((sum, row) => sum + row.bytes, 0),
  )
  const deep = time(() => {
    const seq = db
      .query<{ seq: number }, [string]>("select max(seq) as seq from session_message where session_id = ?")
      .get(id)!.seq
    return db
      .query<{ data: string }, [string, number]>(
        "select data from session_message where session_id = ? and seq < ? order by seq desc limit 20",
      )
      .all(id, Math.floor(seq / 2))
      .reduce((sum, row) => sum + row.data.length, 0)
  })
  const count = time(
    () =>
      db.query<{ n: number }, [string]>("select count(*) as n from session_message where session_id = ?").get(id)!.n,
  )
  db.close()
  return {
    newest30: { ms: newest.ms, bytes: newest.value },
    middle20: { ms: deep.ms, chars: deep.value },
    countRows: { ms: count.ms, rows: count.value },
  }
}

/** Service start on the big database, the session list, the open requests and older pages. */
async function serviceTier(fixture: Fixture) {
  const bootStart = performance.now()
  const service = await startService()
  const bootMs = round(performance.now() - bootStart)
  const pids = await servicePids(service)
  const timed = async (route: string) => {
    const start = performance.now()
    const response = await service.request("GET", route, { directory: fixture.directory })
    const text = await response.text()
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text.slice(0, 300)}`)
    return { ms: round(performance.now() - start), bytes: Buffer.byteLength(text), text }
  }
  const list = await timed("/api/session?limit=200")
  const id = fixture.state.sessionID
  const memory0 = await serviceMemory(pids)
  const open = []
  for (let rep = 0; rep < REPS; rep++) {
    const session = await timed(`/api/session/${id}`)
    const page = await timed(`/api/session/${id}/message?limit=30&order=desc`)
    open.push({ sessionMs: session.ms, firstPageMs: page.ms, firstPageBytes: page.bytes, page })
  }
  const first = JSON.parse(open[0]!.page.text) as { data: { type: string }[]; cursor: { next?: string } }
  const pages: { ms: number; bytes: number; messages: number }[] = []
  let cursor = first.cursor.next
  for (let index = 0; index < PAGES && cursor; index++) {
    const page = await timed(`/api/session/${id}/message?limit=20&cursor=${encodeURIComponent(cursor)}`)
    const parsed = JSON.parse(page.text) as { data: unknown[]; cursor: { next?: string } }
    pages.push({ ms: page.ms, bytes: page.bytes, messages: parsed.data.length })
    cursor = parsed.data.length ? parsed.cursor.next : undefined
  }
  const compactions = await timed(`/api/session/${id}/message?limit=200&type=compaction&order=desc`)
  // What else a session open asks for, alone: the context window (every message since the latest compaction) and the
  // own.accounts reads the UI fires on open (session.preset.get reads that window for the newest user message id).
  const rpc = async (name: string, input: Record<string, unknown>) => {
    const start = performance.now()
    const response = await service.request("POST", `/api/rpc/own.accounts/${name}`, {
      body: { input },
      query: { "location[directory]": fixture.directory },
      directory: fixture.directory,
    })
    const text = await response.text()
    return { ms: round(performance.now() - start), bytes: Buffer.byteLength(text), status: response.status }
  }
  const filler = fixture.fillers[0]!.id
  const reads = {
    context: await timed(`/api/session/${id}/context`).then((item) => ({ ms: item.ms, bytes: item.bytes })),
    presetGet: await rpc("session.preset.get", { sessionID: id }),
    presetGetFiller: await rpc("session.preset.get", { sessionID: filler }),
    // B again: the first own.accounts call after a start also pays the plugin's own warm-up.
    presetGetWarm: await rpc("session.preset.get", { sessionID: id }),
    ledgerSession: await rpc("ledger.session", { sessionID: id }),
    approvalGet: await rpc("session.approval.get", { sessionID: id }),
  }
  // The same burst as the UI's cold open (two preset reads, three ledger reads, the approval read, the first page):
  // the first page's time with that company, against its time alone above.
  const burstStart = performance.now()
  const burst = await Promise.all([
    timed(`/api/session/${id}/message?limit=30&order=desc`).then((item) => item.ms),
    rpc("session.preset.get", { sessionID: id }),
    rpc("session.preset.get", { sessionID: id }),
    rpc("ledger.session", { sessionID: id }),
    rpc("ledger.session", { sessionID: id }),
    rpc("ledger.session", { sessionID: id }),
    rpc("session.approval.get", { sessionID: id }),
  ])
  const openBurst = {
    firstPageMs: burst[0],
    allDoneMs: round(performance.now() - burstStart),
    presetGetMs: [burst[1].ms, burst[2].ms],
    ledgerMs: [burst[3].ms, burst[4].ms, burst[5].ms],
  }
  const memory1 = await serviceMemory(pids)
  const result = {
    bootMs,
    listMs: list.ms,
    listBytes: list.bytes,
    open: {
      sessionMs: summarize(open.map((item) => item.sessionMs)),
      firstPageMs: summarize(open.map((item) => item.firstPageMs)),
      firstPageBytes: open[0]!.firstPageBytes,
      firstPageTypes: count(first.data.map((item) => item.type)),
    },
    olderPages: {
      count: pages.length,
      ms: summarize(pages.map((item) => item.ms)),
      bytes: summarize(pages.map((item) => item.bytes)),
      totalBytes: pages.reduce((sum, item) => sum + item.bytes, 0),
      samples: pages.map((item) => [item.ms, item.bytes]),
    },
    compactionList: { ms: compactions.ms, bytes: compactions.bytes },
    reads,
    openBurst,
    memoryAfterBoot: memory0,
    memoryAfterReads: memory1,
  }
  log(`service: ${JSON.stringify({ ...result, olderPages: { ...result.olderPages, samples: undefined } })}`)
  return result
}

/** The shell on the running service: open, page up, fling, jump to the end, open a big output, switch away and back. */
async function uiTier(fixture: Fixture, name: string) {
  const service = live.service!
  const pids = await servicePids(service)
  const password = atob(service.authorization.slice("Basic ".length)).slice("opencode:".length)
  const shellRoot = path.join(root, "shell")
  await removeTree(shellRoot)
  const xdg = xdgDirs(shellRoot)
  const testRoot = path.join(shellRoot, "desktop")
  const configDir = path.join(shellRoot, "config")
  mkdirSync(configDir, { recursive: true })
  for (const stateHome of [xdg.XDG_STATE_HOME, path.join(root, "svc", "xdg-state")])
    await registerService({
      url: service.url,
      authorization: service.authorization,
      password,
      stateHome,
      channel: "own",
    })
  installUi(fixture.ownHome, { version: readVersion(fixture.ownHome), web: WEB, hash: RPC_HASH })
  offscreen(testRoot)
  const cdpPort = await freePort()
  if (String(cdpPort) === LIVE_PORT) throw new Error("CDP got port 28538")
  const env = cleanEnv({ ...xdg, OWN_HOME: fixture.ownHome, OWN_CONFIG_DIR: configDir })
  const spawnedAt = Date.now()
  const shell = Bun.spawn([electronPath, PACKAGE, ...SHELL_ARGS], {
    env: {
      ...env,
      OPENCODE_DESKTOP_TEST_ROOT: testRoot,
      OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdpPort),
      OWN_DESKTOP_TEST_RUN: String(process.pid),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  live.shell = shell
  const hardStop = setTimeout(() => killTree(shell.pid), 45 * 60_000)
  shell.exited.then(() => clearTimeout(hardStop))
  const result: Record<string, unknown> = {}
  const connected = await connect(`http://127.0.0.1:${cdpPort}`, 180_000)
  const browser: Browser = connected.browser
  const page: Page = connected.page
  try {
    const boot = await page.context().newCDPSession(page)
    await boot.send("Page.enable")
    await boot.send("Page.addScriptToEvaluateOnNewDocument", { source: notificationStub() })
    await page.waitForSelector('[data-testid="app"]', { timeout: 120_000 })
    await page.reload()
    await page.waitForSelector('[data-testid="app"]', { timeout: 120_000 })
    await waitForMarks(page, ["own:t0:connect", "own:t0:ready"], 120_000)
    await page.waitForFunction(
      () => performance.getEntriesByName("own:sessions-visible", "mark").length > 0,
      undefined,
      {
        timeout: 180_000,
        polling: 100,
      },
    )
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" })
    await cdp.send("HeapProfiler.enable")
    const network = await watchNetwork(cdp, new URL(service.url).port)
    result.boot = {
      spawnToVisibleMs: Date.now() - spawnedAt,
      view: await page.evaluate(() => ({
        visibility: document.visibilityState,
        width: innerWidth,
        height: innerHeight,
      })),
    }
    await page.evaluate(() => performance.setResourceTimingBufferSize(100_000))

    // Start on a filler, then open B cold (its first open in this window).
    // The newest filler: the big session takes the first sidebar row, so the oldest of the 50 fillers drops off the list.
    const filler = fixture.fillers.at(-1)!
    const big = {
      id: fixture.state.sessionID,
      title: fixture.title,
      tag: markerTag(TAG, fixture.state.turn - 1),
      last: marker(TAG, fixture.state.turn - 1, "R"),
    }
    const small = { id: filler.id, title: filler.title, tag: filler.tag, last: filler.last }
    await switchTo(page, undefined, small)
    await settle(page)
    network.takeAll()
    const memoryBefore = await memoryPoint(cdp, pids, shell.pid, true)
    const openProfile = args.profile ? await startProfile(cdp) : undefined
    const openCold = await switchTo(page, small, big, 30_000)
    // Not in the sidebar's first rows: the run would measure the filler it stayed on.
    if (openCold.via === "missing") throw new Error(`${TAG} is not in the sidebar`)
    await settle(page, 2_000)
    if (openProfile)
      result.openProfile = await openProfile.stop(path.join(outDir, `${args.label}-${name}-open.cpuprofile`))
    result.open = {
      cold: openCold,
      requests: network.take(),
      serviceRequests: network.takeAll(),
      dom: await domStats(page),
      memoryBefore,
      memory: await memoryPoint(cdp, pids, shell.pid, false),
    }
    log(`ui open: ${JSON.stringify(openCold)}`)
    await shot(page, `${name}-open`)

    if (args["quiet-paging"]) {
      const geometry = await page.evaluate(findScroller)
      if (!geometry) throw new Error("no transcript scroller")
      await browser.close()
      result.quiet = await quietPaging({ cdpPort, shellPid: shell.pid, pids, geometry })
      return result
    }

    // Paging up: wheel input from the transcript until --pages older pages have arrived.
    const geometry = await page.evaluate(findScroller)
    if (!geometry) throw new Error("no transcript scroller")
    const pagingProfile = args.profile ? await startProfile(cdp) : undefined
    await page.evaluate(startPagingProbe)
    const pagingStart = Date.now()
    const heaps: unknown[] = []
    await page.mouse.move(geometry.x, geometry.y)
    let lastCount = network.count()
    let lastProgress = Date.now()
    while (
      network.count() - lastCount < PAGES &&
      Date.now() - lastProgress < 30_000 &&
      Date.now() - pagingStart < 15 * 60_000
    ) {
      const before = network.count()
      await page.mouse.wheel(0, -4_000)
      await page.waitForTimeout(150)
      if (network.count() > before) {
        lastProgress = Date.now()
        if ((network.count() - lastCount) % 5 === 0)
          heaps.push({ pages: network.count() - lastCount, ...(await heapPoint(cdp)) })
      }
    }
    await page.waitForTimeout(1_500)
    const pagingRequests = network.take()
    const probe = await page.evaluate(stopPagingProbe)
    if (pagingProfile)
      result.pagingProfile = await pagingProfile.stop(path.join(outDir, `${args.label}-${name}-paging.cpuprofile`))
    const loadedPages = pagingRequests.length
    lastCount = network.count()
    result.paging = {
      wallMs: Date.now() - pagingStart,
      pages: loadedPages,
      requests: summarizeRequests(pagingRequests),
      perPage: perPage(probe),
      longTasks: summarize(probe.longTasks.map((item) => item.duration)),
      longTaskTotalMs: round(probe.longTasks.reduce((sum, item) => sum + item.duration, 0)),
      frameGapsOver50: probe.gaps.filter((gap) => gap.ms > 50).length,
      maxFrameGapMs: round(Math.max(0, ...probe.gaps.map((gap) => gap.ms))),
      heaps,
      dom: await domStats(page),
      earliestMarker: await page.evaluate(earliestMarker),
    }
    log(`ui paging: ${JSON.stringify({ ...(result.paging as object), heaps: undefined }).slice(0, 1_500)}`)
    await shot(page, `${name}-paged`)

    // A fling over what is loaded (PF3-like): presented frames, rAF gaps, long tasks.
    const wheel = await page.context().newCDPSession(page)
    const fling = await measureFrames(page, "big-fling", async () => {
      await scrollGesture(wheel, { x: geometry.x, y: geometry.y, distance: 20_000, speed: 4_000 })
      await scrollGesture(wheel, { x: geometry.x, y: geometry.y, distance: -20_000, speed: 4_000 })
    })
    await wheel.detach().catch(() => undefined)
    result.fling = {
      intervals: fling.trace.intervals,
      raf: fling.raf,
      longTasks: fling.longTasks,
      longAnimationFrames: fling.longAnimationFrames,
      requestsDuring: network.take().length,
    }
    log(`ui fling: ${JSON.stringify(result.fling).slice(0, 600)}`)

    result.memoryAfterPaging = await memoryPoint(cdp, pids, shell.pid, true)
    log(`ui memory after paging: ${JSON.stringify(result.memoryAfterPaging).slice(0, 600)}`)

    // Jump to the end: the 맨 아래로 button until B's last answer is visible.
    const jumpProfile = args.profile ? await startProfile(cdp) : undefined
    result.jumpToEnd = await page.evaluate(jumpToEnd, big.last)
    if (jumpProfile)
      result.jumpProfile = await jumpProfile.stop(path.join(outDir, `${args.label}-${name}-jump.cpuprofile`))
    log(`ui jump: ${JSON.stringify(result.jumpToEnd)}`)
    await settle(page)

    // Tool output nearest the end: its group (or row) scrolled into view, then opened; time to a quiet DOM.
    const toolRow = page
      .locator(
        '[data-testid="transcript"] [data-component="context-tool-group-trigger"], [data-testid="transcript"] [data-component="tool-trigger"]',
      )
      .last()
    // The newest answer may fill the view: wheel up until a tool row is mounted.
    for (let step = 0; step < 15 && (await toolRow.count()) === 0; step++) {
      await page.mouse.wheel(0, -600)
      await page.waitForTimeout(250)
    }
    if ((await toolRow.count()) > 0) {
      await toolRow.scrollIntoViewIfNeeded().catch(() => undefined)
      await settle(page)
    }
    result.openTool = await page.evaluate(openBiggestTool)
    log(`ui tool: ${JSON.stringify(result.openTool)}`)
    await shot(page, `${name}-tool`)
    await settle(page)

    // Away to a filler and back (warm: B's view is pooled), --reps times.
    const switches = []
    const switchProfile = args.profile ? await startProfile(cdp) : undefined
    for (let rep = 0; rep < REPS; rep++) {
      const away = await switchTo(page, big, small)
      await settle(page)
      const awayRequests = network.take()
      network.takeAll()
      const back = await switchTo(page, small, big, 15_000)
      await settle(page)
      switches.push({ away, back, awayRequests, backRequests: network.take(), backService: network.takeAll() })
    }
    if (switchProfile)
      result.switchProfile = await switchProfile.stop(path.join(outDir, `${args.label}-${name}-switch.cpuprofile`))
    result.switches = {
      awayMs: summarize(
        switches.flatMap((item) =>
          item.away.firstCorrectObservedMs === null ? [] : [item.away.firstCorrectObservedMs],
        ),
      ),
      backMs: summarize(
        switches.flatMap((item) =>
          item.back.firstCorrectObservedMs === null ? [] : [item.back.firstCorrectObservedMs],
        ),
      ),
      backLastMs: summarize(
        switches.flatMap((item) => (item.back.lastVisibleMs === null ? [] : [item.back.lastVisibleMs])),
      ),
      samples: switches,
      backRequests: summarizeRequests(switches.flatMap((item) => item.backRequests)),
    }
    log(`ui switches: ${JSON.stringify({ ...(result.switches as object), samples: undefined })}`)
    result.memoryEnd = await memoryPoint(cdp, pids, shell.pid, true)
    if (args["detach-sample"]) {
      await cdp.send("Memory.simulatePressureNotification", { level: "critical" }).catch(() => undefined)
      await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined)
      await Bun.sleep(3_000)
      const pressed = await proc.sample({ shell: shell.pid, service: pids })
      result.memoryPressure = { ...(await heapPoint(cdp)), roles: pressed.roles, shell: totals(pressed, isShell) }
      log(`ui memory after pressure: ${JSON.stringify(result.memoryPressure).slice(0, 400)}`)
      await browser.close().catch(() => undefined)
      await Bun.sleep(5_000)
      const sample = await proc.sample({ shell: shell.pid, service: pids })
      result.memoryDetached = { roles: sample.roles, shell: totals(sample, isShell) }
      // Freed DevTools buffers go back to the system over the allocators' next purges: once more 30 s later.
      await Bun.sleep(25_000)
      const later = await proc.sample({ shell: shell.pid, service: pids })
      result.memoryDetachedLater = { roles: later.roles, shell: totals(later, isShell) }
      log(`ui memory detached: ${JSON.stringify(result.memoryDetached).slice(0, 400)}`)
    }
    result.liveServiceRequests = network.liveHits()
    result.messagePreflights = network.preflights()
    if (network.liveHits() > 0) throw new Error("the page sent requests to port 28538")
  } finally {
    await quitShell(page).catch(() => undefined)
    await browser.close().catch(() => undefined)
    const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(20_000).then(() => false)])
    if (!exited) killTree(shell.pid)
    live.shell = undefined
  }
  return result
}

/**
 * `--quiet-paging`: uiTier's paging with no DevTools Network domain in the renderer, and where the renderer's memory
 * goes (memory-infra) as it pages. Quits the shell at the end.
 */
async function quietPaging(input: {
  cdpPort: number
  shellPid: number
  pids: number[]
  geometry: { x: number; y: number }
}) {
  // Playwright's sessions leave the renderer with its DevTools agents; their kept bodies are freed by then.
  await Bun.sleep(3_000)
  const page = await rawRenderer(input.cdpPort)
  const browser = await rawBrowser(input.cdpPort)
  const points: unknown[] = []
  const startedAt = Date.now()
  const point = async (label: string, pages: number) => {
    const dump = await memoryDump(browser, {
      all: true,
      save: path.join(outDir, `${args.label}-dump-${label.replaceAll(" ", "-")}.json`),
    }).catch((error: unknown) => ({
      success: false,
      error: String(error),
      processes: [],
    }))
    const sample = await proc.sample({ shell: input.shellPid, service: input.pids })
    const rows = new Map(sample.rows.map((row) => [row.pid, row]))
    const heap = (await page.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number }
    const item = {
      label,
      pages,
      atS: Math.round((Date.now() - startedAt) / 1000),
      heapUsedMB: round(heap.usedSize / 1024 ** 2, 1),
      renderer: sample.roles.renderer,
      processes: dump.processes.map((process) => ({
        role: rows.get(process.pid)?.role ?? "?",
        privateMB: round((rows.get(process.pid)?.privateBytes ?? 0) / 1024 ** 2, 1),
        ...process,
      })),
      ...("error" in dump ? { error: dump.error } : {}),
    }
    points.push(item)
    if (args["heap-snapshot"] && (label === "start" || label === "later")) {
      const chunks: string[] = []
      const collect = (payload: { chunk: string }) => chunks.push(payload.chunk)
      page.on("HeapProfiler.addHeapSnapshotChunk", collect)
      await page.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
      page.off("HeapProfiler.addHeapSnapshotChunk", collect)
      await Bun.write(path.join(outDir, `${args.label}-${label}.heapsnapshot`), chunks.join(""))
    }
    log(
      `quiet ${label}: renderer ${JSON.stringify(sample.roles.renderer)} ${JSON.stringify(item.processes.filter((process) => process.role === "renderer").map((process) => ({ pid: process.pid, privateMB: process.privateMB, allocators: process.allocators })))}`.slice(
        0,
        1_500,
      ),
    )
  }
  if (args["quiet-network"]) await page.send("Network.enable")
  const count = () => page.evaluate<number>("window.__bigsPaging.resources.length")
  await page.evaluate(`(${startPagingProbe.toString()})()`)
  const load = machineLoad()
  await point("start", 0)
  const pagingStart = Date.now()
  const progress = { at: Date.now(), dumped: 0, stuck: false }
  for (;;) {
    const before = await count()
    if (before >= PAGES || Date.now() - progress.at > 30_000 || Date.now() - pagingStart > 45 * 60_000) break
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: input.geometry.x,
      y: input.geometry.y,
      deltaX: 0,
      deltaY: -4_000,
    })
    await Bun.sleep(150)
    const after = await count()
    if (after > before) progress.at = Date.now()
    if (after === before && Date.now() - progress.at > 10_000 && !progress.stuck) {
      progress.stuck = true
      log(`quiet: no page for 10 s at ${after}: ${JSON.stringify(await page.evaluate(`(${findScroller.toString()})()`))}`)
    }
    if (after > before) progress.stuck = false
    if (after - progress.dumped < DUMP_EVERY) continue
    progress.dumped = after
    await point(`${after} pages`, after)
    // A dump takes seconds under load: it is not time without pages.
    progress.at = Date.now()
  }
  await Bun.sleep(1_500)
  const pagingMs = Date.now() - pagingStart
  const pages = await count()
  await point("end", pages)
  await page.send("Memory.simulatePressureNotification", { level: "critical" })
  await Bun.sleep(3_000)
  await point("pressure", pages)
  await Bun.sleep(30_000)
  await point("later", pages)
  const earliest = await page.evaluate<unknown>(`(${earliestMarker.toString()})()`)
  // What the performance timeline holds (the bench raises the resource buffer to 100k entries at boot).
  const timeline = await page.evaluate<unknown>(`(() => {
    const entries = performance.getEntriesByType("resource")
    const kinds = {}
    for (const entry of entries) {
      const kind = entry.initiatorType + ":" + entry.name.slice(0, entry.name.indexOf(":"))
      const item = (kinds[kind] ??= { count: 0, chars: 0 })
      item.count++
      item.chars += entry.name.length
    }
    return { resources: entries.length, kinds }
  })()`)
  await page.evaluate(`void window.own?.app?.quit("app")`).catch(() => undefined)
  page.close()
  browser.close()
  return { pages, pagingMs, load, loadAfter: machineLoad(), earliest, timeline, points }
}

/** One prompt on the big session with the fake provider, until idle: the runner's history reload. */
async function promptTier(fixture: Fixture) {
  const service = live.service ?? (await startService())
  // The bench vault is memory-only: a restarted service has the account but not its key. A fresh key account, and B
  // switched onto it (one model-switch row), so the runner reaches the fake provider.
  const model = await addAccount(service, path.join(fixture.ownHome, "control"), MODEL)
  await service.switchModel(fixture.state.sessionID, model)
  const pids = await servicePids(service)
  const before = await serviceMemory(pids)
  const peak = { privateMB: 0 }
  const sampling = { on: true }
  const sampler = (async () => {
    while (sampling.on) {
      const memory = await serviceMemory(pids)
      peak.privateMB = Math.max(peak.privateMB, memory.privateMB)
      await Bun.sleep(250)
    }
  })()
  const start = performance.now()
  await service.call("POST", `/api/session/${fixture.state.sessionID}/prompt`, {
    body: { text: "이 세션의 최근 작업을 한 줄로 요약해 주세요." },
    directory: fixture.directory,
  })
  const admittedMs = round(performance.now() - start)
  const idle = await Promise.race([
    service.waitIdle(fixture.state.sessionID).then(() => true),
    Bun.sleep(600_000).then(() => false),
  ])
  const idleMs = round(performance.now() - start)
  sampling.on = false
  await sampler
  const state = (await (await fetch(`${provider.url}/__bench/state`)).json()) as Record<string, unknown>
  const result = {
    admittedMs,
    idleMs,
    idle,
    before,
    peakPrivateMB: peak.privateMB,
    after: await serviceMemory(pids),
    provider: state,
  }
  log(`prompt: ${JSON.stringify(result).slice(0, 800)}`)
  return result
}

// ================================================================================================ helpers

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

async function servicePids(service: OpencodeServer) {
  const info = (await service.call("GET", "/api/info")) as { pid?: number }
  return [service.pid, ...(typeof info.pid === "number" && info.pid !== service.pid ? [info.pid] : [])]
}

async function serviceMemory(pids: number[]) {
  const sample = await proc.sample({ service: pids })
  const service = totals(sample, isService)
  return { privateMB: service.privateBytes, wsMB: service.ws, cpuSeconds: service.cpuSeconds }
}

async function heapPoint(cdp: CDPSession) {
  const heap = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number
    totalSize: number
    embedderHeapUsedSize?: number
    backingStorageSize?: number
  }
  const dom = (await cdp.send("Memory.getDOMCounters")) as { nodes: number }
  return {
    heapUsedMB: round(heap.usedSize / 1024 ** 2, 1),
    heapTotalMB: round(heap.totalSize / 1024 ** 2, 1),
    // Blink's own heap (DOM, styles) and ArrayBuffer backing stores, outside the JS heap.
    embedderMB: round((heap.embedderHeapUsedSize ?? 0) / 1024 ** 2, 1),
    backingMB: round((heap.backingStorageSize ?? 0) / 1024 ** 2, 1),
    nodes: dom.nodes,
  }
}

async function memoryPoint(cdp: CDPSession, pids: number[], shellPid: number, gc: boolean) {
  if (gc) {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined)
    await Bun.sleep(1_500)
  }
  const sample = await proc.sample({ shell: shellPid, service: pids })
  return {
    gc,
    ...(await heapPoint(cdp)),
    dom: await cdp.send("Memory.getDOMCounters").catch(() => null),
    shell: totals(sample, isShell),
    roles: sample.roles,
    service: totals(sample, isService),
  }
}

function readVersion(ownHome: string) {
  return (JSON.parse(readFileSync(path.join(ownHome, "app", "current.json"), "utf8")) as { version: string }).version
}

function count(values: readonly string[]) {
  return values.reduce<Record<string, number>>((out, value) => ((out[value] = (out[value] ?? 0) + 1), out), {})
}

/** CPU load of this PC right now (other agents share it): processor time and the busiest processes. */
function machineLoad() {
  const run = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$c = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $m = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ cpuPercent = $c; freeMemGB = [math]::Round($m.FreePhysicalMemory / 1MB, 1) } | ConvertTo-Json -Compress",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  return JSON.parse(run.stdout.toString().trim() || "{}") as Record<string, unknown>
}

/** Message page requests seen by the page (CDP Network), and a guard against any request to the live port. */
async function watchNetwork(cdp: CDPSession, port: string) {
  await cdp.send("Network.enable")
  const requests = new Map<string, { url: string; sent: number; finished?: number; bytes: number; decoded: number }>()
  const order: string[] = []
  const state = { taken: 0, live: 0, allTaken: 0, preflights: 0 }
  // Every request to the service (what else the page asks for while a session opens).
  const all = new Map<string, { path: string; sent: number; finished?: number; bytes: number }>()
  const allOrder: string[] = []
  cdp.on(
    "Network.requestWillBeSent",
    (event: { requestId: string; request: { url: string; method: string }; timestamp: number }) => {
      if (event.request.url.includes(`:${LIVE_PORT}`)) state.live++
      if (event.request.url.includes(`:${port}/`)) {
        all.set(event.requestId, {
          path: `${event.request.method} ${new URL(event.request.url).pathname}`,
          sent: event.timestamp,
          bytes: 0,
        })
        allOrder.push(event.requestId)
      }
      if (!event.request.url.includes(`:${port}/`) || !/\/api\/session\/[^/]+\/message/.test(event.request.url)) return
      if (event.request.url.includes("type=compaction")) return
      // A CORS preflight is not a page: counting it would stop the paging after half the pages.
      if (event.request.method !== "GET") return void state.preflights++
      requests.set(event.requestId, { url: event.request.url, sent: event.timestamp, bytes: 0, decoded: 0 })
      order.push(event.requestId)
    },
  )
  cdp.on("Network.dataReceived", (event: { requestId: string; dataLength: number }) => {
    const item = requests.get(event.requestId)
    if (item) item.decoded += event.dataLength
  })
  cdp.on("Network.loadingFinished", (event: { requestId: string; timestamp: number; encodedDataLength: number }) => {
    const any = all.get(event.requestId)
    if (any) {
      any.finished = event.timestamp
      any.bytes = event.encodedDataLength
    }
    const item = requests.get(event.requestId)
    if (!item) return
    item.finished = event.timestamp
    item.bytes = event.encodedDataLength
  })
  return {
    count: () => order.length,
    take() {
      const taken = order.slice(state.taken).map((id) => requests.get(id)!)
      state.taken = order.length
      return taken.map((item) => ({
        url: item.url.replace(/^.*\/message/, "message"),
        ms: item.finished === undefined ? null : round((item.finished - item.sent) * 1000),
        bytes: item.bytes,
        decoded: item.decoded,
      }))
    },
    liveHits: () => state.live,
    preflights: () => state.preflights,
    /** Every service request since the last call: path, start (ms after the first), duration, encoded bytes. */
    takeAll() {
      const taken = allOrder.slice(state.allTaken).map((id) => all.get(id)!)
      state.allTaken = allOrder.length
      const origin = taken[0]?.sent ?? 0
      return taken.map((item) => ({
        path: item.path.replace(/ses_[A-Za-z0-9]+/, ":id"),
        atMs: round((item.sent - origin) * 1000),
        ms: item.finished === undefined ? null : round((item.finished - item.sent) * 1000),
        bytes: item.bytes,
      }))
    },
  }
}

function summarizeRequests(items: readonly { ms: number | null; bytes: number; decoded: number }[]) {
  return {
    count: items.length,
    ms: summarize(items.flatMap((item) => (item.ms === null ? [] : [item.ms]))),
    bytes: summarize(items.map((item) => Math.max(item.bytes, item.decoded))),
    totalMB: round(items.reduce((sum, item) => sum + Math.max(item.bytes, item.decoded), 0) / 1024 ** 2, 1),
  }
}

/** Per older page (resource timing of each message request): network time, then main-thread blocking until the next. */
function perPage(probe: PagingProbe) {
  const pages = probe.resources.map((item, index) => {
    const end = probe.resources[index + 1]?.start ?? item.end + 3_000
    const tasks = probe.longTasks.filter((task) => task.start >= item.end - 1 && task.start < end)
    const gaps = probe.gaps.filter((gap) => gap.at >= item.end && gap.at < end + 100)
    return {
      netMs: round(item.end - item.start),
      blockedMs: round(tasks.reduce((sum, task) => sum + task.duration, 0)),
      maxTaskMs: round(Math.max(0, ...tasks.map((task) => task.duration))),
      maxGapMs: round(Math.max(0, ...gaps.map((gap) => gap.ms))),
    }
  })
  const fifths = (key: "blockedMs" | "maxTaskMs" | "netMs") => {
    const size = Math.max(1, Math.ceil(pages.length / 5))
    return Array.from({ length: Math.ceil(pages.length / size) }, (_, index) =>
      round(summarize(pages.slice(index * size, (index + 1) * size).map((item) => item[key])).median ?? 0),
    )
  }
  return {
    netMs: summarize(pages.map((item) => item.netMs)),
    blockedMs: summarize(pages.map((item) => item.blockedMs)),
    maxTaskMs: summarize(pages.map((item) => item.maxTaskMs)),
    // Median per fifth of the run: does a page cost more as more history is loaded?
    blockedMsByFifth: fifths("blockedMs"),
    maxTaskMsByFifth: fifths("maxTaskMs"),
    netMsByFifth: fifths("netMs"),
    samples: pages,
  }
}

async function settle(page: Page, ms = 800) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await Bun.sleep(ms)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(outDir, `${args.label}-${name}.png`) }).catch(() => undefined)
}

async function domStats(page: Page) {
  return page.evaluate(() => ({
    nodes: document.getElementsByTagName("*").length,
    transcriptNodes: document.querySelector('[data-testid="transcript"]')?.querySelectorAll("*").length ?? 0,
    images: document.querySelector('[data-testid="transcript"]')?.querySelectorAll("img").length ?? 0,
  }))
}

type Target = { id: string; title: string; tag: string; last: string }

/**
 * Opens `target` from the sidebar (perf-many-sessions.ts's switch): the row's mousedown starts the clock; the first
 * frame with the destination's markers and none of the source's, and the first frame with `target.last` visible.
 */
async function switchTo(page: Page, source: Target | undefined, target: Target, limitMs = 8_000) {
  await page.evaluate(installMarkerLocator)
  await page.evaluate(findScroller).catch(() => undefined)
  const row = page.locator('[data-testid="session-row"]', { hasText: target.title }).first()
  if ((await row.count()) === 0) return { via: "missing", firstCorrectObservedMs: null, lastVisibleMs: null }
  await page.evaluate(installSwitchProbe, {
    trigger: "[data-ownb-trigger]",
    destination: target.tag,
    source: source?.tag ?? "NONE",
    last: target.last,
    limitMs,
  })
  await row.evaluate((element) => {
    document.querySelectorAll("[data-ownb-trigger]").forEach((item) => item.removeAttribute("data-ownb-trigger"))
    element.setAttribute("data-ownb-trigger", "")
  })
  await row.scrollIntoViewIfNeeded().catch(() => undefined)
  await row.click({ timeout: 10_000 }).catch(() =>
    row.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
      ;(element as HTMLElement).click()
    }),
  )
  await page
    .waitForFunction(() => (window as Window & { __ownbSwitch?: { done: boolean } }).__ownbSwitch?.done, undefined, {
      timeout: limitMs + 20_000,
    })
    .catch(() => undefined)
  const samples = (await page.evaluate(readSwitchProbe)).samples
  const result = classifySwitch(samples.map((item) => ({ ...item, last: item.destination > 0 })))
  const last = samples.find((item) => item.last)
  return {
    via: "row",
    firstCorrectObservedMs: result.firstCorrectObservedMs,
    lastVisibleMs: last ? round(last.at) : null,
    samples: samples.length,
  }
}

/** The shell's first window opens off-screen (as perf-many-sessions.ts does). */
function offscreen(testRoot: string) {
  const id = "big-session"
  const userData = path.join(testRoot, "desktop")
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    path.join(userData, "opencode.settings"),
    JSON.stringify({ windowIds: [id], ownTrayHintShown: true }, null, "\t"),
  )
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

// ------------------------------------------------------------------------------------------------ in-page code

type PagingProbe = {
  resources: { start: number; end: number }[]
  longTasks: { start: number; duration: number }[]
  gaps: { at: number; ms: number }[]
}

/** Message requests (resource timing), long tasks and rAF gaps over 34 ms until `stopPagingProbe`. */
function startPagingProbe() {
  const host = window as Window & { __bigsPaging?: PagingProbe & { stop(): void } }
  const resources: PagingProbe["resources"] = []
  const longTasks: PagingProbe["longTasks"] = []
  const gaps: PagingProbe["gaps"] = []
  let running = true
  let last = performance.now()
  const tick = (time: number) => {
    if (!running) return
    if (time - last > 34) gaps.push({ at: last, ms: time - last })
    last = time
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const resourceObserver = new PerformanceObserver((list) =>
    list.getEntries().forEach((entry) => {
      if (!/\/api\/session\/[^/]+\/message/.test(entry.name) || entry.name.includes("type=compaction")) return
      resources.push({ start: entry.startTime, end: (entry as PerformanceResourceTiming).responseEnd })
    }),
  )
  resourceObserver.observe({ type: "resource" })
  const taskObserver = new PerformanceObserver((list) =>
    list.getEntries().forEach((entry) => longTasks.push({ start: entry.startTime, duration: entry.duration })),
  )
  taskObserver.observe({ type: "longtask" })
  host.__bigsPaging = {
    resources,
    longTasks,
    gaps,
    stop() {
      running = false
      resourceObserver.disconnect()
      taskObserver.disconnect()
    },
  }
}

function stopPagingProbe(): PagingProbe {
  const probe = (window as Window & { __bigsPaging?: PagingProbe & { stop(): void } }).__bigsPaging!
  probe.stop()
  return { resources: probe.resources, longTasks: probe.longTasks, gaps: probe.gaps }
}

/** The earliest mounted fixture marker (how far back the transcript got). */
function earliestMarker() {
  const locate = (window as Window & { __ownbLocate?: () => { marker: string; tag: string; turn: number }[] })
    .__ownbLocate
  const located = locate?.() ?? []
  const turns = located.map((item) => Number(item.tag.replace(/^[A-Z]+/, "") || "0") * 10_000 + item.turn)
  return { mounted: located.length, earliestTurn: turns.length ? Math.min(...turns) : null }
}

/** Clicks the transcript's jump-to-latest button; ms until `last` is visible (and the frames on the way). */
function jumpToEnd(last: string) {
  return new Promise<{ ms: number | null; maxGapMs: number; found: boolean }>((resolve) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="transcript"] button, button')].find(
      (item) => item.querySelector('path[d^="M12.3333 8.66665"]') && item.getAttribute("aria-hidden") !== "true",
    )
    if (!button) return resolve({ ms: null, maxGapMs: 0, found: false })
    const locate = (window as Window & { __ownbLocate?: () => { marker: string; visible: boolean }[] }).__ownbLocate!
    const start = performance.now()
    let previous = start
    let maxGap = 0
    button.click()
    const frame = (time: number) => {
      maxGap = Math.max(maxGap, time - previous)
      previous = time
      if (locate().some((item) => item.visible && item.marker === last))
        return resolve({ ms: Math.round(performance.now() - start), maxGapMs: Math.round(maxGap), found: true })
      if (performance.now() - start > 20_000) return resolve({ ms: null, maxGapMs: Math.round(maxGap), found: true })
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

/**
 * Opens tool output the way a user does: the nearest visible tool group (`context-tool-group-trigger`, e.g. "Grep 및
 * computer_screenshot · 3번") or tool row, then every closed tool trigger inside it. ms from the first click to three
 * quiet frames, the longest frame on the way, and the nodes, characters and images it added.
 */
function openBiggestTool() {
  return new Promise<Record<string, unknown>>((resolve) => {
    const root = document.querySelector('[data-testid="transcript"]')
    if (!root) return resolve({ found: false, candidates: 0 })
    const visible = (item: Element) => {
      const rect = item.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
    }
    const triggers = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-component="context-tool-group-trigger"], [data-component="tool-trigger"]',
      ),
    ].filter(visible)
    const target = triggers.at(-1)
    if (!target) return resolve({ found: false, candidates: 0 })
    const clickable = (element: HTMLElement) =>
      (element.closest("a,button,[role=button]") as HTMLElement | null) ?? element
    const nodesBefore = root.querySelectorAll("*").length
    const charsBefore = root.textContent?.length ?? 0
    const imagesBefore = root.querySelectorAll("img").length
    let changes = 0
    let quiet = 0
    let maxGap = 0
    let inner = 0
    const observer = new MutationObserver((records) => (changes += records.length))
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    const start = performance.now()
    let previous = start
    clickable(target).click()
    let expandedInner = false
    const frame = (time: number) => {
      maxGap = Math.max(maxGap, time - previous)
      previous = time
      quiet = changes === 0 ? quiet + 1 : 0
      changes = 0
      // Once the group is open: its own tool rows, opened once each.
      if (!expandedInner && quiet >= 2) {
        expandedInner = true
        const scope = target.closest('[data-component="context-tool-group"]')?.parentElement ?? target.parentElement
        const rows = [...(scope?.querySelectorAll<HTMLElement>('[data-component="tool-trigger"]') ?? [])].filter(
          (item) => item !== target && visible(item),
        )
        rows.forEach((item) => clickable(item).click())
        inner = rows.length
        if (rows.length) quiet = 0
      }
      if ((expandedInner && quiet >= 3) || performance.now() - start > 10_000) {
        observer.disconnect()
        return resolve({
          found: true,
          candidates: triggers.length,
          kind: target.getAttribute("data-component"),
          title: target.textContent?.slice(0, 80),
          innerOpened: inner,
          settledMs: Math.round(performance.now() - start),
          maxGapMs: Math.round(maxGap),
          nodesAdded: root.querySelectorAll("*").length - nodesBefore,
          charsAdded: (root.textContent?.length ?? 0) - charsBefore,
          imagesAdded: root.querySelectorAll("img").length - imagesBefore,
        })
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

/** Replaces the page's `Notification` before own-web reads it: nothing reaches Windows. */
function notificationStub() {
  return `(() => {
  class Stub { constructor() {} close() {} }
  Stub.permission = "granted";
  Stub.requestPermission = async () => "granted";
  Object.defineProperty(window, "Notification", { value: Stub, configurable: true, writable: true });
})()`
}

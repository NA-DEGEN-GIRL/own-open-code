// One command for the own-web performance gate (01 §6.6, §16.3; 03 §20.4). From packages/own-web:
//
//   bun e2e/performance/run.ts            # build, PF5, all benches ×3, perf.json, exit 1 on a failed budget
//   bun e2e/performance/run.ts --gate     # release gate: ×20, no retries, pending (unmeasurable) PFs fail too
//
// Options: --repeat <n>, --grep <regex>, --out <dir> (default: <tmp>/own-web-perf/<run id>), --no-build, --headed,
// --version <v> (default: package version + git head). perf.json has the shape of own/release/<version>/perf.json;
// copy it there for a release (or pass --out own/release/<version>). Raw records stay next to it (records.jsonl),
// with the machine-load samples (load.jsonl: whole-machine CPU busy share every second, baseline before the backend).
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { evaluate, type BenchRecord, type CheckResult } from "./budgets"
import { loadBetween, startLoadSampler, type LoadSample } from "./load"
import { round, summarize, type Summary } from "./metrics"

const PACKAGE = path.resolve(import.meta.dir, "../..")
const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    gate: { type: "boolean", default: false },
    repeat: { type: "string" },
    grep: { type: "string" },
    out: { type: "string" },
    "no-build": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    version: { type: "string" },
  },
}).values
const gate = args.gate
/** Seconds of load sampling before the backend starts: the baseline is other applications' load. */
const BASELINE_SECONDS = Number(process.env.OWN_PERF_BASELINE_SECONDS ?? 5)
/** Baseline busy share (%) from which the summary warns that the machine was busy. */
const BUSY_WARNING = 25
const repeat = Number(args.repeat ?? (gate ? 20 : 3))
const runID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
const out = path.resolve(args.out ?? path.join(os.tmpdir(), "own-web-perf", runID))
fs.mkdirSync(out, { recursive: true })
const recordsFile = path.join(out, "records.jsonl")
fs.writeFileSync(recordsFile, "")

const log = (line: string) => console.log(`[own-perf] ${line}`)
const run = async (command: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn(command, {
    cwd: PACKAGE,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  })
  return proc.exited
}
const capture = (command: string[]) => {
  const result = Bun.spawnSync(command, { cwd: PACKAGE, stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

log(`run ${runID} (${gate ? "gate" : "bench"}, ×${repeat}) → ${out}`)
if (!args["no-build"]) {
  log("vite build (production bundle)")
  if ((await run(["bun", "run", "build"])) !== 0) {
    log("build failed (fix it, or pass --no-build to measure the existing dist/)")
    process.exit(1)
  }
}

// Snapshot the bundle: the benches serve this copy, so another process rebuilding dist/ cannot change it mid-run.
const snapshot = path.join(out, "dist")
fs.cpSync(path.join(PACKAGE, "dist"), snapshot, { recursive: true, filter: (source) => !source.endsWith(".map") })
const snapshotSha = sha(path.join(snapshot, "index.html"))

// PF5: the bundle-size script (exit 1 when over budget; its JSON line is the record either way).
const size = Bun.spawnSync(["bun", "script/bundle-size.ts", "--json"], { cwd: PACKAGE, stdout: "pipe", stderr: "pipe" })
const sizeSha = sha(path.join(PACKAGE, "dist/index.html"))
const sizeLine = size.stdout.toString().trim().split("\n").at(-1) ?? ""
const bundle = sizeLine.startsWith("{") ? (JSON.parse(sizeLine) as Record<string, unknown>) : null
fs.appendFileSync(
  recordsFile,
  `${JSON.stringify({
    name: "PF5 bundle size",
    status: bundle ? "passed" : "failed",
    metrics: bundle,
    error: bundle ? undefined : size.stderr.toString().slice(0, 500),
  })}\n`,
)

// Machine load: sampled from here to the end; the first seconds (nothing of the bench running yet) are the baseline.
const load = startLoadSampler(1_000)
const baselineFrom = Date.now()
await Bun.sleep(BASELINE_SECONDS * 1_000 + 100)
const baselineTo = Date.now()
const baseline = loadBetween(load.samples, baselineFrom, baselineTo)
log(`machine load baseline (other applications): mean ${baseline.mean ?? "—"} %, max ${baseline.max ?? "—"} %`)

// The fixture backend runs under this process (not Playwright's webServer, which force-kills it on Windows), so
// it can be stopped gracefully at the end and its temp directories are removed.
log("fixture backend (real server + imported sessions + vite preview)")
const backend = Bun.spawn(["bun", "e2e/performance/backend.ts"], {
  cwd: PACKAGE,
  env: { ...process.env, OWN_PERF_DIST: snapshot },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
})
if (!(await backendReady(backend.stdout))) {
  log("fixture backend did not start")
  process.exit(1)
}

log(`playwright (msedge${args.headed ? ", headed" : ""})`)
const benchFrom = Date.now()
const playwright = await run(
  [
    "node",
    path.join(PACKAGE, "node_modules/@playwright/test/cli.js"),
    "test",
    "--config",
    "e2e/performance/playwright.config.ts",
    `--repeat-each=${repeat}`,
    "--retries=0",
    ...(args.grep ? ["--grep", args.grep] : []),
  ],
  {
    OPENCODE_PERFORMANCE_RUN_ID: runID,
    OWN_PERF_RESULTS: recordsFile,
    OWN_PERF_OUTPUT: path.join(out, "test-results"),
    OWN_PERF_REUSE_BACKEND: "1",
    OWN_PERF_DIST: snapshot,
    ...(args.headed ? { OWN_PERF_HEADED: "1" } : {}),
  },
)
const benchTo = Date.now()
load.stop()
fs.writeFileSync(path.join(out, "load.jsonl"), load.samples.map((sample) => `${JSON.stringify(sample)}\n`).join(""))
// "stop" lets the backend close Vite and the server and remove its temp directories before it exits.
backend.stdin.write("stop\n")
await backend.stdin.flush()
await Promise.race([backend.exited, Bun.sleep(60_000).then(() => backend.kill())])

const records = fs
  .readFileSync(recordsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as BenchRecord)
const result = evaluate(records)
const harness = records.filter((record) => record.name.startsWith("harness self-test"))
const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8")) as { version: string }
const head = capture(["git", "rev-parse", "--short", "HEAD"])
const dirty = (capture(["git", "status", "--porcelain", "--", "."]) ?? "").length > 0
const firstWithContext = records.find((record) => record.context?.browser)
const perf = {
  schema: "own.perf/1",
  version: args.version ?? `${packageJson.version}+${head ?? "unknown"}${dirty ? ".dirty" : ""}`,
  runID,
  createdAt: new Date().toISOString(),
  mode: gate ? "gate" : "bench",
  scope:
    "own-web production bundle in Edge (P3 scope of 01 §16.3: PF2–PF5, PF7; PF1 web variant). PF1 desktop, PF6, PF8 are measured in the packaged shell (P4).",
  environment: {
    machine: {
      os: `${os.type()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    },
    powerScheme: process.platform === "win32" ? (capture(["powercfg", "/getactivescheme"]) ?? null) : null,
    browser: {
      channel: "msedge",
      version: firstWithContext?.context?.browser ?? null,
      headless: !args.headed,
      viewport: "1440x900",
    },
    /**
     * Observed refresh: the display mode Windows reports, and per frame bench the idle rAF rate (before the run) and
     * the active one (median rAF interval during it). Recorded only: the long-frame threshold is 2 × 16.7 ms.
     */
    display: {
      reportedHz: reportedRefreshHz(),
      frameClock: frameClock(records),
    },
    load: {
      method: `os.cpus() busy share of all ${os.cpus().length} logical CPUs, sampled every 1 s (load.jsonl)`,
      baseline: { seconds: BASELINE_SECONDS, note: "before the backend started: other applications", ...baseline },
      benchmarks: loadBetween(load.samples, benchFrom, benchTo),
      busy: (baseline.mean ?? 0) >= BUSY_WARNING,
    },
    build: {
      gitHead: head ?? null,
      dirty,
      distIndexSha256: snapshotSha,
      /** PF5 reads dist/ itself; true means dist/ was rebuilt by someone else before the size check ran. */
      distChangedBeforeSizeCheck: sizeSha !== snapshotSha,
    },
    fixture: firstWithContext?.context?.setup ?? null,
    repeat,
  },
  gate: {
    required: result.pfs.map((item) => item.pf),
    passed: result.pfs.every((item) => item.status === "pass") && playwright === 0,
    failing: result.pfs.filter((item) => item.status === "fail").map((item) => item.pf),
    pending: result.pfs.filter((item) => item.status === "pending").map((item) => item.pf),
  },
  results: Object.fromEntries(
    result.pfs.map((item) => [item.pf, { ...item, checks: result.checks.filter((check) => check.pf === item.pf) }]),
  ),
  notMeasured: {
    PF6: "startup contention (90 s) — packaged shell bench-startup adapter (P4)",
    PF8: "idle timers/CPU — desktop app.getAppMetrics() (P4)",
  },
  harness: {
    selfTest: harness.length ? (harness.every((record) => record.status === "passed") ? "pass" : "fail") : "not run",
  },
  benchmarks: summarizeRecords(records),
  /** Release exceptions with reasons (01 §16.3); filled by hand when a gate is waived. */
  exceptions: [] as { pf: string; reason: string }[],
  records: path.relative(out, recordsFile),
}
fs.writeFileSync(path.join(out, "perf.json"), `${JSON.stringify(perf, null, 2)}\n`)

console.log("")
for (const check of result.checks) console.log(formatCheck(check))
console.log("")
const during = perf.environment.load.benchmarks
log(
  `machine load: baseline ${baseline.mean ?? "—"} % (other applications), during benches mean ${during.mean ?? "—"} % / p95 ${during.p95 ?? "—"} %${perf.environment.load.busy ? " — BUSY machine: PF1–PF4 and PF7 numbers are pessimistic, rerun idle for a release" : ""}`,
)
for (const [name, clock] of Object.entries(perf.environment.display.frameClock))
  log(
    `frame clock ${name}: idle ${clock.idleHz.join("/")} Hz, active ${clock.activeHz.join("/")} Hz; rAF > 16.7 ms ${clock.overBudgetRatio ?? "—"}, > 2 × idle F ${clock.displayNormalizedRatio ?? "—"} (diagnostics)`,
  )
for (const item of result.pfs)
  console.log(`${item.pf}: ${item.status.toUpperCase()}${item.reasons.length ? ` — ${item.reasons[0]}` : ""}`)
log(`harness self-test: ${perf.harness.selfTest}; playwright exit ${playwright}`)
log(`perf.json → ${path.join(out, "perf.json")}`)

const measuredFail = result.checks.some((check) => check.gate && check.status === "fail")
process.exit(playwright !== 0 || measuredFail || (gate && !perf.gate.passed) ? 1 : 0)

/** Mirrors the backend's stdout and resolves once it printed its ready line (false when it exits first). */
async function backendReady(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return false
    const text = decoder.decode(chunk.value, { stream: true })
    process.stdout.write(text)
    buffer = (buffer + text).slice(-4_096)
    if (buffer.includes("OWN_WEB_PERF_READY")) {
      void (async () => {
        for (let next = await reader.read(); !next.done; next = await reader.read())
          process.stdout.write(decoder.decode(next.value, { stream: true }))
      })()
      return true
    }
  }
}

function sha(file: string) {
  return fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16) : null
}

function formatCheck(check: CheckResult) {
  const value =
    check.value === null
      ? "—"
      : `${check.value}${check.unit === "ratio" || check.unit === "count" ? "" : ` ${check.unit}`}`
  const status = check.status === "pass" ? "ok  " : check.status === "fail" ? "FAIL" : "pend"
  return `${status} ${check.gate ? "gate " : "track"} ${check.id.padEnd(24)} ${value.padStart(11)} ≤ ${check.budget} (median ${check.median ?? "—"}, n=${check.samples}/${check.runs} runs)`
}

function summarizeRecords(list: readonly BenchRecord[]) {
  const names = [...new Set(list.map((record) => record.name))]
  return names.map((name) => {
    const own = list.filter((record) => record.name === name)
    return {
      name,
      runs: own.length,
      passed: own.filter((record) => record.status === "passed").length,
      skipped: own.filter((record) => record.status === "skipped").length,
      failed: own.filter((record) => record.status !== "passed" && record.status !== "skipped").length,
      skipReason: own.find((record) => record.skipReason)?.skipReason,
      errors: [...new Set(own.flatMap((record) => (record.error ? [record.error.slice(0, 300)] : [])))],
      /** Machine CPU busy share (%) while this bench ran (pooled over its runs; includes the bench's own processes). */
      cpuBusy: loadDuring(own, load.samples),
    }
  })
}

function loadDuring(own: readonly BenchRecord[], samples: readonly LoadSample[]): Summary {
  const spans = own.flatMap((record) => (record.timing ? [record.timing] : []))
  return summarize(
    samples
      .filter((sample) => spans.some((span) => sample.at > span.startedAt && sample.at <= span.endedAt))
      .map((sample) => sample.busy),
  )
}

/**
 * Refresh rate of the primary display's current mode (Win32 `EnumDisplaySettings`; WMI's
 * `Win32_VideoController.CurrentRefreshRate` reports 59 Hz for this PC's 240 Hz mode). `null` elsewhere or on error.
 */
function reportedRefreshHz() {
  if (process.platform !== "win32") return null
  const source = `using System; using System.Runtime.InteropServices;
public static class OwnPerfDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields, dmPositionX, dmPositionY,
      dmDisplayOrientation, dmDisplayFixedOutput; public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency,
      dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string name, int mode, ref DEVMODE mode2);
  public static int Hz() { var mode = new DEVMODE(); mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    return EnumDisplaySettings(null, -1, ref mode) ? mode.dmDisplayFrequency : 0; } }`
  const value = capture([
    "powershell",
    "-NoProfile",
    "-Command",
    `Add-Type -TypeDefinition @'\n${source}\n'@; [OwnPerfDisplay]::Hz()`,
  ])
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 1 ? rate : null
}

type RafRecord = {
  readonly frames?: number
  readonly overBudget?: number
  readonly refresh?: { readonly idleHz?: number | null; readonly activeHz?: number | null }
  readonly displayNormalized?: { readonly longFrames?: number }
}

interface FrameClock {
  readonly idleHz: number[]
  readonly activeHz: number[]
  readonly overBudgetRatio: number | null
  readonly displayNormalizedRatio: number | null
}

/** Per frame bench: idle/active rAF rates of each run and the pooled diagnostic ratios (see `rafFrames`). */
function frameClock(list: readonly BenchRecord[]): Record<string, FrameClock> {
  const benches = { PF3: "PF3 timeline scroll", PF4: "PF4 streaming" }
  const result: Record<string, FrameClock> = {}
  for (const [pf, bench] of Object.entries(benches)) {
    const rafs = list
      .filter((record) => record.name.startsWith(bench) && record.status === "passed" && record.metrics)
      .map((record) => (record.metrics!.raf ?? (record.metrics!.scroll as { raf?: unknown } | null)?.raf) as RafRecord)
      .filter((raf): raf is RafRecord => Boolean(raf?.refresh))
    if (!rafs.length) continue
    const frames = rafs.reduce((sum, raf) => sum + (raf.frames ?? 0), 0)
    const ratio = (count: (raf: RafRecord) => number | undefined) =>
      frames ? round(rafs.reduce((sum, raf) => sum + (count(raf) ?? 0), 0) / frames, 4) : null
    const rates = (pick: (raf: RafRecord) => number | null | undefined) =>
      rafs.flatMap((raf) => {
        const rate = pick(raf)
        return typeof rate === "number" ? [Math.round(rate)] : []
      })
    result[pf] = {
      idleHz: rates((raf) => raf.refresh?.idleHz),
      activeHz: rates((raf) => raf.refresh?.activeHz),
      overBudgetRatio: ratio((raf) => raf.overBudget),
      displayNormalizedRatio: ratio((raf) => raf.displayNormalized?.longFrames),
    }
  }
  return result
}

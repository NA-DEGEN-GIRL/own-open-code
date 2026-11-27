// Long-task attribution for a profile trace (`OWN_PERF_PROFILE=1|tasks` + `OPENCODE_PERFORMANCE_TRACE_DIR`, README):
//
//   bun e2e/performance/trace-tasks.ts <trace.json> [--min 50] [--top 12]
//
// Lists the renderer main thread's tasks longer than --min ms inside the probe's `ownb:measure:*` window: wall time,
// thread (CPU) time — a task whose thread time is far below its wall time was descheduled, i.e. the machine was
// busy, not the page — its cause (`traceTasks` in metrics.ts), the trace events inside it by self time (script,
// style, layout, paint, GC …; `OWN_PERF_PROFILE=1` only) and the functions with the most CPU samples in it. Also
// prints the same breakdown for the whole window. Script locations are the bundle's (resolve them with dist/*.map).
import fs from "node:fs"
import { parseArgs } from "node:util"
import { round, traceTasks, type TraceEvent } from "./metrics"

const args = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { min: { type: "string", default: "50" }, top: { type: "string", default: "12" } },
})
const file = args.positionals[0]
if (!file) {
  console.error("usage: bun e2e/performance/trace-tasks.ts <trace.json> [--min 50] [--top 12]")
  process.exit(2)
}
const MIN_MS = Number(args.values.min)
const TOP = Number(args.values.top)

interface Event {
  readonly name: string
  readonly cat?: string
  readonly ph: string
  readonly pid: number
  readonly tid: number
  readonly ts: number
  readonly dur?: number
  readonly tdur?: number
  readonly id?: string
  readonly args?: Record<string, any>
}

const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { traceEvents?: Event[] } | Event[]
const events = Array.isArray(raw) ? raw : (raw.traceEvents ?? [])

// The page's main thread: the CrRendererMain whose process carries the probe marks.
const mainThreads = events.filter((event) => event.ph === "M" && event.name === "thread_name")
const markPid = events.find((event) => event.name === "ownb:measure:start")?.pid
const main = mainThreads.find((event) => event.args?.name === "CrRendererMain" && event.pid === markPid)
if (!main) {
  console.error(
    "no CrRendererMain with the ownb:measure marks in this trace (profile trace needed: OWN_PERF_PROFILE=1|tasks)",
  )
  process.exit(1)
}
const start = events.find((event) => event.name === "ownb:measure:start")?.ts ?? 0
const end = events.find((event) => event.name === "ownb:measure:end")?.ts ?? Number.MAX_SAFE_INTEGER
const onMain = events
  .filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === "X" && event.dur !== undefined)
  .toSorted((a, b) => a.ts - b.ts || b.dur! - a.dur!)
const TASK = "ThreadControllerImpl::RunTask"
const tasks = onMain.filter((event) => event.name === TASK && event.ts >= start && event.ts <= end)
const causes = new Map(
  (traceTasks(events as TraceEvent[], { start, end }, MIN_MS) ?? []).map((task) => [task.atMs, task.kind]),
)

/** Self time per event name inside [from, to] (nested complete events on the main thread). */
function selfTimes(from: number, to: number) {
  const inside = onMain.filter(
    (event) => event.ts >= from && event.ts + event.dur! <= to && event.name !== TASK && event.name !== "RunTask",
  )
  const totals = new Map<string, number>()
  const stack: { end: number; name: string; child: number; dur: number }[] = []
  const close = (until: number) => {
    while (stack.length && stack.at(-1)!.end <= until) {
      const done = stack.pop()!
      totals.set(done.name, (totals.get(done.name) ?? 0) + Math.max(0, done.dur - done.child))
      if (stack.length) stack.at(-1)!.child += done.dur
    }
  }
  for (const event of inside) {
    close(event.ts)
    stack.push({ end: event.ts + event.dur!, name: label(event), child: 0, dur: event.dur! })
  }
  close(Number.MAX_SAFE_INTEGER)
  return [...totals].toSorted((a, b) => b[1] - a[1])
}

function label(event: Event) {
  const data = event.args?.data ?? {}
  if (event.name === "FunctionCall" && (data.functionName || data.url))
    return `FunctionCall ${data.functionName || "(anonymous)"} ${short(data.url)}:${data.lineNumber ?? "?"}`
  if (event.name === "EventDispatch" && data.type) return `EventDispatch ${data.type}`
  if (event.name === "TimerFire") return "TimerFire"
  return event.name
}

function short(url: unknown) {
  return typeof url === "string" ? (url.split("/").at(-1) ?? url) : ""
}

// CPU samples (Profile + ProfileChunk events of the main thread's profiler).
const profileIds = new Set(
  events
    .filter((event) => event.name === "Profile" && event.pid === main.pid && event.tid === main.tid)
    .map((event) => event.id),
)
const nodes = new Map<number, { name: string; url: string; line: number }>()
const samples: { ts: number; node: number }[] = []
const profileStart = new Map<string | undefined, number>()
for (const event of events) {
  if (event.name === "Profile" && profileIds.has(event.id)) profileStart.set(event.id, event.args?.data?.startTime)
}
const cursor = new Map<string | undefined, number>()
for (const event of events.filter((item) => item.name === "ProfileChunk" && profileIds.has(item.id))) {
  const data = event.args?.data ?? {}
  for (const node of data.cpuProfile?.nodes ?? [])
    nodes.set(node.id, {
      name: node.callFrame?.functionName || "(anonymous)",
      url: short(node.callFrame?.url),
      line: (node.callFrame?.lineNumber ?? -1) + 1,
    })
  let time = cursor.get(event.id) ?? profileStart.get(event.id) ?? event.ts
  const deltas: number[] = data.timeDeltas ?? []
  ;(data.cpuProfile?.samples ?? []).forEach((node: number, index: number) => {
    time += deltas[index] ?? 0
    samples.push({ ts: time, node })
  })
  cursor.set(event.id, time)
}

function hotFunctions(from: number, to: number) {
  const counts = new Map<string, number>()
  const inside = samples.filter((sample) => sample.ts >= from && sample.ts <= to)
  for (const sample of inside) {
    const node = nodes.get(sample.node)
    if (!node) continue
    const key = node.url ? `${node.name} ${node.url}:${node.line}` : node.name
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return { total: inside.length, top: [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, TOP) }
}

const ms = (us: number) => (us / 1_000).toFixed(1)
const windowMs = (end === Number.MAX_SAFE_INTEGER ? 0 : end - start) / 1_000
console.log(`${file}\nmeasure window ${windowMs.toFixed(0)} ms; ${tasks.length} main-thread tasks`)
const long = tasks.filter((task) => task.dur! / 1_000 > MIN_MS)
console.log(`${long.length} task(s) over ${MIN_MS} ms\n`)
for (const task of long) {
  const cpu = task.tdur === undefined ? "?" : ms(task.tdur)
  const cause = causes.get(round((task.ts - start) / 1_000)) ?? "?"
  console.log(
    `task at +${ms(task.ts - start)} ms: ${cause}; wall ${ms(task.dur!)} ms, thread ${cpu} ms${task.tdur !== undefined ? ` (${Math.round((task.tdur / task.dur!) * 100)} % on CPU)` : ""}`,
  )
  for (const [name, time] of selfTimes(task.ts, task.ts + task.dur!).slice(0, TOP))
    console.log(`  ${ms(time).padStart(7)} ms  ${name}`)
  const hot = hotFunctions(task.ts, task.ts + task.dur!)
  if (hot.total) {
    console.log(`  cpu samples: ${hot.total}`)
    for (const [name, count] of hot.top) console.log(`  ${String(count).padStart(7)}     ${name}`)
  }
  console.log("")
}
const totalWall = tasks.reduce((sum, task) => sum + task.dur!, 0)
const totalCpu = tasks.reduce((sum, task) => sum + (task.tdur ?? 0), 0)
console.log(`whole window: tasks wall ${ms(totalWall)} ms, thread ${ms(totalCpu)} ms`)
for (const [name, time] of selfTimes(start, end).slice(0, TOP)) console.log(`  ${ms(time).padStart(7)} ms  ${name}`)

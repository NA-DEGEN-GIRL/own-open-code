// Bench-only service plugin for perf-many-sessions.ts: memory of the service process into a JSON-lines file
// (`options.out`). Never part of a release config. It imports nothing from the host so it loads the same way under a
// source boot and a release `opencode.exe`.
//
// - Every 5 s a cheap line: `process.memoryUsage()` (rss, heap used and total, external), how many times this module
//   was evaluated and how many Locations ran `setup` (a module evaluated more than once means each Location imports
//   its own copy).
// - Writing `<out>.gc` asks for a full collection and then a full `bun:jsc` heapStats line (heap size, extra memory,
//   object count, the top object types; `gc: true`). heapStats walks the whole heap, so it is never sampled on a
//   timer: a once-a-second heapStats took 40% of the service's JavaScript samples while it streamed (2026-10-19).
// - Writing `<out>.prof` (its content: a duration in ms) runs JavaScriptCore's sampling profiler over the whole
//   process for that long and writes a summary (self samples per function and file, inclusive samples per file and
//   package) to `<out>.prof.json`.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { heapStats, profile } from "bun:jsc"

type State = {
  loads: number
  setups: number
  locations: Set<string>
  timer?: ReturnType<typeof setInterval>
  ticks: number
  profiling?: boolean
}
const key = Symbol.for("own.perf.heap")
const host = globalThis as unknown as Record<symbol, State | undefined>
const state = (host[key] ??= { loads: 0, setups: 0, locations: new Set(), ticks: 0 })
state.loads++

export default {
  id: "own.perf.heap",
  setup: async (ctx: { readonly options?: unknown; readonly location?: { readonly directory?: string } }) => {
    const out = (ctx.options as { out?: unknown } | undefined)?.out
    if (typeof out !== "string") return
    state.setups++
    if (ctx.location?.directory) state.locations.add(ctx.location.directory)
    if (state.timer) return
    const sample = () => {
      if (existsSync(`${out}.prof`) && !state.profiling) {
        const ms = Number(readFileSync(`${out}.prof`, "utf8")) || 20_000
        rmSync(`${out}.prof`, { force: true })
        state.profiling = true
        void Promise.resolve(profile(() => Bun.sleep(ms), 1_000))
          .then((result) => writeFileSync(`${out}.prof.json`, JSON.stringify(summarize(result), null, 1)))
          .catch((error: unknown) => writeFileSync(`${out}.prof.json`, JSON.stringify({ error: String(error) })))
          .finally(() => (state.profiling = false))
      }
      const gc = existsSync(`${out}.gc`)
      if (!gc && state.ticks++ % 5 !== 0) return
      if (gc) {
        Bun.gc(true)
        rmSync(`${out}.gc`, { force: true })
      }
      const jsc = gc ? heapStats() : undefined
      const memory = process.memoryUsage()
      appendFileSync(
        out,
        JSON.stringify({
          t: Date.now(),
          gc,
          ...(jsc
            ? {
                heapSize: jsc.heapSize,
                heapCapacity: jsc.heapCapacity,
                extraMemorySize: jsc.extraMemorySize,
                objectCount: jsc.objectCount,
                protectedObjectCount: jsc.protectedObjectCount,
                topTypes: Object.entries(jsc.objectTypeCounts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 25),
              }
            : {}),
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
          moduleLoads: state.loads,
          setups: state.setups,
          locations: state.locations.size,
        }) + "\n",
      )
    }
    state.timer = setInterval(sample, 1_000)
    state.timer.unref?.()
    sample()
  },
}

type Profile = Awaited<ReturnType<typeof profile<() => Promise<void>>>>

/** Self samples per function and per file, inclusive samples per file and per package (top entries). */
function summarize(result: Profile) {
  const traces = result.stackTraces.traces
  const urls = new Map(
    result.stackTraces.sources.map((source) => [source.sourceID, source.url ?? source.sourceURL ?? ""]),
  )
  const file = (frame: Profile["stackTraces"]["traces"][number]["frames"][number]) => {
    const url = urls.get(frame.sourceID) ?? frame.sourceURL ?? ""
    return url
      ? url.replaceAll("\\", "/").replace(/^.*\/(packages|node_modules|plugins)\//, "$1/")
      : `(${frame.category || "native"})`
  }
  const group = (path: string) =>
    /^(packages|plugins)\/([^/]+)/.exec(path)?.slice(1, 3).join("/") ??
    /^node_modules\/(\.bun\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)/.exec(path)?.[2] ??
    path
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
  const selfFn = new Map<string, number>()
  const selfFile = new Map<string, number>()
  const inclusiveFile = new Map<string, number>()
  const inclusiveGroup = new Map<string, number>()
  for (const trace of traces) {
    const top = trace.frames[0]
    if (!top) {
      count(selfFn, "(idle/no JS)")
      continue
    }
    count(selfFn, `${top.name || "(anonymous)"} ${file(top)}:${top.line}`)
    count(selfFile, file(top))
    new Set(trace.frames.map(file)).forEach((item) => count(inclusiveFile, item))
    new Set(trace.frames.map((frame) => group(file(frame)))).forEach((item) => count(inclusiveGroup, item))
  }
  const top = (map: Map<string, number>, n = 30) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, value]) => ({
        key,
        samples: value,
        share: Math.round((value / Math.max(1, traces.length)) * 1000) / 10,
      }))
  return {
    samples: traces.length,
    intervalS: result.stackTraces.interval,
    selfByFunction: top(selfFn, 40),
    selfByFile: top(selfFile),
    inclusiveByFile: top(inclusiveFile),
    inclusiveByGroup: top(inclusiveGroup),
    functionsText: result.functions.split("\n").slice(0, 60).join("\n"),
  }
}

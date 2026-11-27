// Table of perf-many-sessions.ts reports: one row per run, then the median and range per label (the label without a
// trailing `-r<n>` repetition suffix), so repeated runs on a loaded PC can be read as median and spread.
//
//   bun scripts/many-sessions/summarize.ts <report.json | dir> … [--md] [--json out.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const argv = process.argv.slice(2)
const jsonAt = argv.indexOf("--json")
const jsonOut = jsonAt >= 0 ? argv[jsonAt + 1] : undefined
const markdown = argv.includes("--md")
const inputs = argv.filter(
  (item, index) => item !== "--md" && (jsonAt < 0 || (index !== jsonAt && index !== jsonAt + 1)),
)
const files = inputs.flatMap((input) =>
  statSync(input).isDirectory()
    ? readdirSync(input)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(input, name))
    : [input],
)

type Report = Record<string, any>
const get = (value: unknown, keys: string): number | null => {
  const result = keys
    .split(".")
    .reduce<unknown>((item, key) => (item as Record<string, unknown> | undefined)?.[key], value)
  return typeof result === "number" ? result : null
}

const METRICS: Record<string, string> = {
  "boot.visibleMs": "phases.boot.reloadToVisibleMs",
  "boot.shellPrivMB": "phases.boot.memory.total.shell.privateBytes",
  "boot.servicePrivMB": "phases.boot.memory.total.service.privateBytes",
  "open.coldMedMs": "phases.open.cold.median",
  "open.coldP95Ms": "phases.open.cold.p95",
  "open.warmMedMs": "phases.open.warm.median",
  "open.warmP95Ms": "phases.open.warm.p95",
  "open.shellPrivMB": "phases.open.memory.total.shell.privateBytes",
  "open.rendererPrivMB": "phases.open.memory.roles.renderer.privateBytes",
  "open.rendererHeapMB": "phases.open.memory.rendererHeapMB.used",
  "idle.cpuTotal%": "phases.idle.cpu.total",
  "idle.cpuRenderer%": "phases.idle.cpu.renderer",
  "idle.cpuService%": "phases.idle.cpu.service",
  "idle.rendererTaskMsPerS": "phases.idle.renderer.taskMsPerS",
  "idle.keys": "phases.idleInput.keystrokes",
  "idle.inputEvents": "phases.idleInput.processing.count",
  "idle.inputP95Ms": "phases.idleInput.processing.p95",
  "idle.paintMedMs": "phases.idleInput.paint.duration.median",
  "idle.paintP95Ms": "phases.idleInput.paint.duration.p95",
  "idle.paintReported": "phases.idleInput.paint.reported",
  "stream.keys": "phases.stream.input.keystrokes",
  "stream.inputEvents": "phases.stream.input.processing.count",
  "stream.inputP95Ms": "phases.stream.input.processing.p95",
  "stream.inputMaxMs": "phases.stream.input.processing.max",
  "stream.paintReported": "phases.stream.input.paint.reported",
  "stream.paintMedMs": "phases.stream.input.paint.duration.median",
  "stream.paintP95Ms": "phases.stream.input.paint.duration.p95",
  "stream.followP95Ms": "phases.stream.follow.intervals.p95",
  "stream.followMedMs": "phases.stream.follow.intervals.median",
  "stream.followLong50": "phases.stream.follow.longTasks.over50",
  "stream.scrollP95Ms": "phases.stream.scroll.intervals.p95",
  "stream.scrollLong50": "phases.stream.scroll.longTasks.over50",
  "stream.switchMedMs": "phases.stream.switch.summary.median",
  "stream.switchP95Ms": "phases.stream.switch.summary.p95",
  "stream.accountsMs": "phases.stream.pages.accounts.visibleMs",
  "stream.limitsMs": "phases.stream.pages.limits.visibleMs",
  "stream.settingsMs": "phases.stream.pages.settings.visibleMs",
  "stream.teamMs": "phases.stream.pages.team.visibleMs",
  "stream.sidebarP95Ms": "phases.stream.sidebar.intervals.p95",
  "stream.pingP95Ms": "phases.stream.service.pingMs.p95",
  "stream.cpuRenderer%": "phases.stream.window.cpu.renderer",
  "stream.cpuService%": "phases.stream.window.cpu.service",
  "stream.cpuGpu%": "phases.stream.window.cpu.gpu",
  "stream.cpuMain%": "phases.stream.window.cpu.electron-main",
  "stream.rendererTaskMsPerS": "phases.stream.window.renderer.taskMsPerS",
  "stream.eventsPerS": "phases.stream.window.events.framesPerSecond",
  "stream.eventKBPerS": "phases.stream.window.events.kbPerSecond",
  "stream.mutTranscript/s": "phases.stream.mutations.transcript",
  "stream.mutSidebar/s": "phases.stream.mutations.sidebar",
  "stream.mutOther/s": "phases.stream.mutations.other",
  "stream.load%": "phases.stream.window.load.median",
  "after.cpuTotal%": "phases.after.cpu.total",
  "after.shellPrivMB": "phases.after.memory.total.shell.privateBytes",
  "after.rendererPrivMB": "phases.after.memory.roles.renderer.privateBytes",
  "after.gpuPrivMB": "phases.after.memory.roles.gpu.privateBytes",
  "after.mainPrivMB": "phases.after.memory.roles.electron-main.privateBytes",
  "after.rendererHeapMB": "phases.after.memory.rendererHeapMB.used",
  "after.servicePrivMB": "phases.after.memory.total.service.privateBytes",
  "after.serviceHeapMB": "phases.after.memory.serviceHeap.heapSizeMB",
  "after.serviceRssMB": "phases.after.memory.serviceHeap.rssMB",
  "after.domNodes": "phases.after.memory.domCounters.nodes",
  "closed.rendererHeapMB": "phases.closed.memory.rendererHeapMB.used",
  "closed.rendererPrivMB": "phases.closed.memory.roles.renderer.privateBytes",
  "closed.serviceHeapMB": "phases.closed.memory.serviceHeap.heapSizeMB",
  "closed.servicePrivMB": "phases.closed.memory.total.service.privateBytes",
  "run.load%": "load.whole.median",
}

// Only perf-many-sessions reports (they have phases); profiles and service-only reports in the same folder are skipped.
const rows = files.flatMap((file) => {
  const report = JSON.parse(readFileSync(file, "utf8")) as Report
  if (!report.phases) return []
  const values = Object.fromEntries(Object.entries(METRICS).map(([name, key]) => [name, get(report, key)]))
  return {
    label: String(report.label),
    file,
    error: report.error ? String(report.error).split("\n")[0] : undefined,
    values,
  }
})

const groups = new Map<string, typeof rows>()
for (const row of rows) {
  const key = row.label.replace(/-r\d+$/, "")
  groups.set(key, [...(groups.get(key) ?? []), row])
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const summary = Object.fromEntries(
  [...groups.entries()].map(([label, items]) => [
    label,
    {
      runs: items.length,
      errors: items.filter((item) => item.error).map((item) => `${item.label}: ${item.error}`),
      metrics: Object.fromEntries(
        Object.keys(METRICS).map((name) => {
          const values = items.map((item) => item.values[name]).filter((value): value is number => value !== null)
          if (!values.length) return [name, null]
          return [
            name,
            { median: Math.round(median(values) * 10) / 10, min: Math.min(...values), max: Math.max(...values) },
          ]
        }),
      ),
    },
  ]),
)

const labels = [...groups.keys()]
const cellText = (label: string, name: string) => {
  const cell = summary[label]!.metrics[name] as { median: number; min: number; max: number } | null
  if (!cell) return "–"
  return summary[label]!.runs > 1 && cell.min !== cell.max
    ? `${cell.median} (${cell.min}–${cell.max})`
    : `${cell.median}`
}
if (markdown) {
  // `--md`: the same table as Markdown, for the report (median, and the range when there is more than one run).
  console.log(`| metric | ${labels.map((label) => `${label} (${summary[label]!.runs})`).join(" | ")} |`)
  console.log(`|---|${labels.map(() => "---").join("|")}|`)
  for (const name of Object.keys(METRICS))
    console.log(`| ${name} | ${labels.map((label) => cellText(label, name)).join(" | ")} |`)
}
if (!markdown) {
  const width = Math.max(...Object.keys(METRICS).map((name) => name.length)) + 2
  console.log("metric".padEnd(width) + labels.map((label) => label.padStart(22)).join(""))
  for (const name of Object.keys(METRICS))
    console.log(name.padEnd(width) + labels.map((label) => cellText(label, name).padStart(22)).join(""))
}
for (const [label, value] of Object.entries(summary))
  for (const error of value.errors) console.log(`! ${label}: ${error}`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ files, summary }, null, 2))

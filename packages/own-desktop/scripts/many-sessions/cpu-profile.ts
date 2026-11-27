// Summaries of the renderer's CPU profile (CDP `Profiler`) and heap snapshot (CDP `HeapProfiler`) for
// perf-many-sessions.ts: self time per function, resolved to own-web source files through the bundle's source maps,
// grouped by source file and by package; heap self size per constructor.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

interface CallFrame {
  readonly functionName: string
  readonly url: string
  readonly lineNumber: number
  readonly columnNumber: number
}

export interface CpuProfile {
  readonly nodes: readonly { id: number; callFrame: CallFrame; hitCount?: number; children?: number[] }[]
  readonly samples?: readonly number[]
  readonly timeDeltas?: readonly number[]
  readonly startTime: number
  readonly endTime: number
}

/** Self time per function and per source file/package (ms), top entries only. `dist` resolves bundle locations. */
export function summarizeProfile(profile: CpuProfile, dist?: string, top = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (deltas[index + 1] ?? deltas[index] ?? 0)))
  const maps = new SourceMaps(dist)
  const functions = new Map<string, { ms: number; where: string; group: string }>()
  for (const [id, micros] of self) {
    const frame = byId.get(id)?.callFrame
    if (!frame) continue
    const source = maps.resolve(frame)
    const name = frame.functionName || "(anonymous)"
    const key = `${name} ${source.where}`
    const entry = functions.get(key) ?? { ms: 0, where: source.where, group: source.group }
    entry.ms += micros / 1000
    functions.set(key, entry)
  }
  const totalMs = [...self.values()].reduce((sum, value) => sum + value, 0) / 1000
  const group = (pick: (entry: { where: string; group: string }) => string) => {
    const sums = new Map<string, number>()
    for (const entry of functions.values()) sums.set(pick(entry), (sums.get(pick(entry)) ?? 0) + entry.ms)
    return [...sums.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([key, ms]) => ({ key, ms: Math.round(ms), share: Math.round((ms / totalMs) * 1000) / 10 }))
  }
  return {
    durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
    sampledMs: Math.round(totalMs),
    byPackage: group((entry) => entry.group),
    byFile: group((entry) => entry.where.replace(/:\d+$/, "")),
    byFunction: [...functions.entries()]
      .toSorted((a, b) => b[1].ms - a[1].ms)
      .slice(0, top)
      .map(([key, entry]) => ({ key, ms: Math.round(entry.ms), share: Math.round((entry.ms / totalMs) * 1000) / 10 })),
  }
}

/** Self size per (node type, constructor) of a `.heapsnapshot`, top entries (MB). */
export function summarizeHeapSnapshot(text: string, top = 30) {
  const snapshot = JSON.parse(text) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]] }; node_count: number }
    nodes: number[]
    strings: string[]
  }
  const fields = snapshot.snapshot.meta.node_fields
  const width = fields.length
  const typeAt = fields.indexOf("type")
  const nameAt = fields.indexOf("name")
  const sizeAt = fields.indexOf("self_size")
  const types = snapshot.snapshot.meta.node_types[0]
  const sums = new Map<string, { size: number; count: number }>()
  let total = 0
  for (let index = 0; index < snapshot.nodes.length; index += width) {
    const type = types[snapshot.nodes[index + typeAt]!] ?? "?"
    const size = snapshot.nodes[index + sizeAt]!
    total += size
    const name =
      type === "object" || type === "closure" || type === "native"
        ? snapshot.strings[snapshot.nodes[index + nameAt]!]!.slice(0, 60)
        : ""
    const key = name ? `${type}:${name}` : type
    const entry = sums.get(key) ?? { size: 0, count: 0 }
    entry.size += size
    entry.count++
    sums.set(key, entry)
  }
  const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100
  return {
    totalMB: mb(total),
    nodes: snapshot.nodes.length / width,
    top: [...sums.entries()]
      .toSorted((a, b) => b[1].size - a[1].size)
      .slice(0, top)
      .map(([key, value]) => ({ key, mb: mb(value.size), count: value.count })),
  }
}

/** Bundle location → original source through `<dist>/_assets/<file>.js.map` (source map v3, VLQ decoded here). */
class SourceMaps {
  private readonly cache = new Map<string, { sources: string[]; lines: number[][][] } | null>()
  constructor(private readonly dist?: string) {}

  resolve(frame: CallFrame) {
    const file = frame.url.split("/").pop() ?? ""
    const fallback = { where: `${frame.url ? file : "(native)"}:${frame.lineNumber + 1}`, group: groupOf(frame.url) }
    if (!this.dist || !frame.url.includes("_assets/")) return fallback
    const map = this.load(file)
    const segments = map?.lines[frame.lineNumber]
    if (!map || !segments?.length) return fallback
    const segment = segments.findLast((item) => item[0]! <= frame.columnNumber) ?? segments[0]!
    if (segment.length < 4) return fallback
    const source = map.sources[segment[1]!] ?? "?"
    const clean = source.replace(/^(\.\.\/)+/, "").replace(/^.*node_modules\/(\.bun\/[^/]+\/node_modules\/)?/, "npm:")
    return { where: `${clean}:${segment[2]! + 1}`, group: groupOf(clean) }
  }

  private load(file: string) {
    if (this.cache.has(file)) return this.cache.get(file)!
    const target = path.join(this.dist!, "_assets", `${file}.map`)
    const parsed = existsSync(target)
      ? (JSON.parse(readFileSync(target, "utf8")) as { sources: string[]; mappings: string })
      : undefined
    const value = parsed ? { sources: parsed.sources, lines: decodeMappings(parsed.mappings) } : null
    this.cache.set(file, value)
    return value
  }
}

function groupOf(source: string) {
  if (!source) return "(native/gc)"
  const npm = /npm:(@[^/]+\/[^/]+|[^/]+)/.exec(source)
  if (npm) return `npm:${npm[1]}`
  const pkg = /packages\/([^/]+)\/(src\/)?([^/]+)?/.exec(source)
  if (pkg) return pkg[1] === "own-web" && pkg[3] ? `own-web/${pkg[3]}` : (pkg[1] ?? source)
  return source.split("/").slice(0, 2).join("/")
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]))

/** Absolute [generatedColumn, source, originalLine, originalColumn] segments per generated line. */
function decodeMappings(mappings: string) {
  const lines: number[][][] = []
  const state = [0, 0, 0, 0]
  for (const line of mappings.split(";")) {
    state[0] = 0
    const segments: number[][] = []
    for (const part of line.split(",")) {
      if (!part) continue
      const values: number[] = []
      let value = 0
      let shift = 0
      for (const char of part) {
        const digit = DIGIT.get(char) ?? 0
        value += (digit & 31) << shift
        if (digit & 32) {
          shift += 5
          continue
        }
        values.push(value & 1 ? -(value >>> 1) : value >>> 1)
        value = 0
        shift = 0
      }
      values.slice(0, 4).forEach((delta, index) => (state[index]! += delta))
      segments.push(values.length >= 4 ? state.slice(0, 4) : [state[0]!])
    }
    lines.push(segments)
  }
  return lines
}

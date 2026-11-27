// `@path#L10-40` line ranges (03 §18.12). The suffix is stripped before `fs.find` and applied to the chosen file; the
// server reads `?start=&end=` from the file URI and slices text files by line (core session/prompt.ts).
import type { LineRange } from "./types"

/** `#L10-40`, `#L10-L40`, `#L10`, `#10-40`, and the half-typed `#`, `#L`, `#L10-`. */
const SUFFIX = /#L?(?:(\d+)(?:-L?(\d*))?)?$/i

export function splitRange(query: string): { readonly query: string; readonly range?: LineRange } {
  const match = SUFFIX.exec(query)
  if (!match) return { query }
  const base = query.slice(0, match.index)
  const first = Number(match[1])
  const second = match[2] ? Number(match[2]) : undefined
  if (!first) return { query: base }
  if (second === undefined || second === first) return { query: base, range: { start: first } }
  if (!second) return { query: base, range: { start: first } }
  return {
    query: base,
    range: { start: Math.min(first, second), end: Math.max(first, second) },
  }
}

export function formatRange(range: LineRange | undefined) {
  if (!range) return ""
  return range.end === undefined ? `#L${range.start}` : `#L${range.start}-${range.end}`
}

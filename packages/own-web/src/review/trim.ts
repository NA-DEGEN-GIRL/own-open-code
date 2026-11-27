// Shrinks a full-context unified diff (vcs.diff and session.diff without `context` return whole files) to hunks with
// `context` unchanged lines around each change. One linear pass over the patch lines: the diff is not recomputed.
// Runs in the review worker (diff.worker.ts) for large files so the main thread never rebuilds and re-diffs a
// multi-thousand-line file (03 §20.2 R4). The output has plain `---`/`+++` headers without `diff --git` and without
// tab suffixes, so session-ui treats it as a partial patch (hunks only) instead of reconstructing full contents.

interface Entry {
  readonly kind: " " | "-" | "+"
  readonly text: string
  /** Old line number of a context/removed line, or the next old line for an added one (1-based). */
  readonly old: number
  readonly next: number
  readonly hunk: number
  noNewline: boolean
}

export interface TrimResult {
  readonly patch: string
  readonly trimmed: boolean
  /** Diff lines kept (context + changes). */
  readonly lines: number
}

export function trimPatch(file: string, patch: string, context = 3): TrimResult {
  const entries = parseEntries(patch)
  const keep = keptEntries(entries, context)
  const kept = keep.filter(Boolean).length
  if (kept >= entries.length) return { patch, trimmed: false, lines: entries.length }
  const hunks = groups(entries, keep).map(render)
  return { patch: [`--- a/${file}`, `+++ b/${file}`, ...hunks, ""].join("\n"), trimmed: true, lines: kept }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function parseEntries(patch: string) {
  const entries: Entry[] = []
  const position = { old: 0, next: 0, hunk: -1 }
  for (const line of patch.split("\n")) {
    const header = HUNK.exec(line)
    if (header) {
      position.hunk += 1
      // A zero-length range names the line before it (unified diff convention).
      position.old = Number(header[1]) + (header[2] === "0" ? 1 : 0)
      position.next = Number(header[3]) + (header[4] === "0" ? 1 : 0)
      continue
    }
    if (position.hunk < 0) continue
    if (line.startsWith("\\")) {
      const last = entries.at(-1)
      if (last) last.noNewline = true
      continue
    }
    const kind = line[0]
    if (kind !== " " && kind !== "-" && kind !== "+") continue
    entries.push({
      kind,
      text: line.slice(1),
      old: position.old,
      next: position.next,
      hunk: position.hunk,
      noNewline: false,
    })
    if (kind !== "+") position.old += 1
    if (kind !== "-") position.next += 1
  }
  return entries
}

/** An entry stays when a change of the same original hunk is at most `context` entries away. */
function keptEntries(entries: readonly Entry[], context: number) {
  const distance = entries.map(() => Number.POSITIVE_INFINITY)
  const sweep = (indexes: number[]) =>
    indexes.reduce<{ hunk: number; last: number }>(
      (state, index) => {
        const entry = entries[index]!
        const last = entry.hunk === state.hunk ? state.last : Number.NEGATIVE_INFINITY
        const next = entry.kind === " " ? last : index
        distance[index] = Math.min(distance[index]!, Math.abs(index - next))
        return { hunk: entry.hunk, last: next }
      },
      { hunk: -1, last: Number.NEGATIVE_INFINITY },
    )
  sweep(entries.map((_, index) => index))
  sweep(entries.map((_, index) => entries.length - 1 - index))
  return distance.map((value) => value <= context)
}

function groups(entries: readonly Entry[], keep: readonly boolean[]) {
  return entries.reduce<Entry[][]>((result, entry, index) => {
    if (!keep[index]) return result
    const previous = entries[index - 1]
    const joins = index > 0 && keep[index - 1] && previous?.hunk === entry.hunk
    if (joins) result.at(-1)!.push(entry)
    if (!joins) result.push([entry])
    return result
  }, [])
}

function render(group: readonly Entry[]) {
  const first = group[0]!
  const oldCount = group.filter((entry) => entry.kind !== "+").length
  const newCount = group.filter((entry) => entry.kind !== "-").length
  const oldStart = oldCount === 0 ? first.old - 1 : first.old
  const newStart = newCount === 0 ? first.next - 1 : first.next
  const lines = group.flatMap((entry) =>
    entry.noNewline ? [entry.kind + entry.text, "\\ No newline at end of file"] : [entry.kind + entry.text],
  )
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines].join("\n")
}

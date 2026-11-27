import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Paths } from "../../src/sources/paths.js"

/**
 * The read-only guard of the tests (IG1): wraps code that reads fixture roots and reports anything that is not a pure
 * read. Before and after, a recursive listing (size and mtime of every file and folder, links not followed) is
 * compared; meanwhile `fs.watch` on each root records every create, rename and write, and the allowlist's reports
 * ({@link Paths.observe}) record every open and stat own-import performed. It fails on a created, removed or changed
 * entry (a new `-wal`, `-shm` or `-journal` beside a DB is a `sibling`), on any watch event, and on an open or stat of
 * a never-open file, judged by its own list below rather than the allowlist's.
 */

export interface Violation {
  readonly kind: "created" | "removed" | "changed" | "sibling" | "event" | "opened"
  readonly path: string
  readonly detail?: string
}

export interface Guard {
  /** Every allowlist decision while the guard ran, refused ones included. */
  readonly reports: ReadonlyArray<Paths.Report>
  /** Stops watching and returns the violations; an empty list means the roots were only read. */
  stop(): Promise<Violation[]>
}

/** Never-open files as the guard sees them, independent of the allowlist (09 §2.1). */
const NEVER = [
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])\.credentials\.json$/i,
  /\.(key|pem)$/i,
  // A lock file is a skill's own content in a skill area (SK2: `uv.lock`, `Cargo.lock`), never-open elsewhere.
  /^(?!.*[\\/](skills|plugins)[\\/]).*\.lock$/i,
  /-shm$/i,
  /(^|[\\/])config\.toml$/i,
  /(^|[\\/])history\.jsonl$/i,
  /(^|[\\/])thread_history_\d+\.sqlite/i,
  /(^|[\\/])codex-dev\.db/i,
  /[\\/]thread-writer-locks[\\/]/i,
  /[\\/]file-history[\\/]/i,
  /[\\/]shell-snapshots[\\/]/i,
  /[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/i,
  /[\\/]sessions[\\/]\d+\.json$/i,
]

/** Whether the guard counts `file` as never-open. */
export function isNeverOpen(file: string) {
  return NEVER.some((pattern) => pattern.test(file))
}

export async function start(roots: ReadonlyArray<string>): Promise<Guard> {
  // Listed before watching: Windows reports a `change` on a new folder the first time it is enumerated.
  const before = await Promise.all(roots.map(listing))
  const reports: Paths.Report[] = []
  const events: Violation[] = []
  const unobserve = Paths.observe((report) => reports.push(report))
  const watchers = roots.map((root) =>
    fs.watch(root, { recursive: true }, (event, name) =>
      events.push({ kind: "event", path: path.join(root, String(name ?? "")), detail: event }),
    ),
  )
  return {
    reports,
    stop: async () => {
      // Watch events arrive asynchronously; give late ones a moment before closing.
      await Bun.sleep(150)
      watchers.forEach((watcher) => watcher.close())
      unobserve()
      const after = await Promise.all(roots.map(listing))
      const folders = new Set(
        after.flatMap((map) => [...map].filter((entry) => entry[1].directory).map((entry) => entry[0])),
      )
      const opened = reports.flatMap((report): Violation[] =>
        report.real !== undefined && report.op !== "list" && isNeverOpen(report.real)
          ? [{ kind: "opened", path: report.real, detail: report.op }]
          : [],
      )
      return [
        ...before.flatMap((map, index) => compare(map, after[index])),
        // A folder's own `change` is metadata (access times); what changed inside it has an event of its own.
        ...events.filter((event) => !(event.detail === "change" && folders.has(event.path))),
        ...opened,
      ]
    },
  }
}

interface Entry {
  readonly size: number
  readonly mtimeMs: number
  readonly directory: boolean
}

/** Every file and folder below `root` (links listed, not followed) with size and mtime. */
async function listing(root: string): Promise<Map<string, Entry>> {
  const names = await fsp.readdir(root, { recursive: true })
  const entries = await Promise.all(
    [root, ...names.map((name) => path.join(root, name))].map(async (file) => {
      const stat = await fsp.lstat(file)
      return [file, { size: stat.size, mtimeMs: stat.mtimeMs, directory: stat.isDirectory() }] as const
    }),
  )
  return new Map(entries)
}

function compare(before: Map<string, Entry>, after: Map<string, Entry>): Violation[] {
  const created = [...after.keys()]
    .filter((file) => !before.has(file))
    .map((file): Violation => ({ kind: /-(wal|shm|journal)$/i.test(file) ? "sibling" : "created", path: file }))
  const removed = [...before.keys()]
    .filter((file) => !after.has(file))
    .map((file): Violation => ({ kind: "removed", path: file }))
  const changed = [...before].flatMap(([file, entry]): Violation[] => {
    const now = after.get(file)
    if (now === undefined || (now.size === entry.size && now.mtimeMs === entry.mtimeMs)) return []
    return [{ kind: "changed", path: file, detail: `${entry.size}@${entry.mtimeMs} -> ${now.size}@${now.mtimeMs}` }]
  })
  return [...created, ...removed, ...changed]
}

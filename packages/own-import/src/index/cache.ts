export * as IndexCache from "./cache.js"

import path from "node:path"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { Fsx } from "@own/runtime"
import { Option, Schema } from "effect"

/**
 * The index's caches (09 §2.3 캐시, IG10). Two kinds, kept apart on purpose:
 *
 * - {@link memory}: values read from a conversation file (a Codex head, a Claude Code lite read, a confirm pass),
 *   keyed by `(path, size, mtimeMs)`, so a changed file is read again. Titles, first prompts and previews live only
 *   here: they are the user's content and never touch the disk.
 * - {@link load} / {@link save}: `OWN_HOME/state/import-index.json`, so the first list after a restart knows which
 *   files belong to which folders without reading them all again. It holds only what is not conversation content:
 *   the file's path, size and mtime, its kind and ids, the normalized working folders, the parent, the sub-agent and
 *   `codex exec` flags, the times, the tool versions and whether the folders came from the whole file. It is written
 *   atomically (own-runtime `Fsx.writeAtomic`), never through core KV (plain text) or plugin storage.
 */

export interface Stamp {
  readonly size: number
  readonly mtimeMs: number
}

export interface Memory<T> {
  /** The value stored for `path` when the file still has the stamp it had then. */
  get(path: string, stamp: Stamp): T | undefined
  set(path: string, stamp: Stamp, value: T): void
  delete(path: string): void
  readonly size: number
}

/** A memory-only map from a file to a value read from it, valid while the file keeps its size and mtime. */
export function memory<T>(): Memory<T> {
  const values = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly value: T }>()
  return {
    get: (file, stamp) => {
      const found = values.get(file)
      return found !== undefined && found.size === stamp.size && found.mtimeMs === stamp.mtimeMs
        ? found.value
        : undefined
    },
    set: (file, stamp, value) => {
      values.set(file, { size: stamp.size, mtimeMs: stamp.mtimeMs, value })
    },
    delete: (file) => {
      values.delete(file)
    },
    get size() {
      return values.size
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// import-index.json

/** One conversation file without its content. */
export const Entry = Schema.Struct({
  path: Schema.String,
  size: NonNegativeInt,
  mtimeMs: Schema.Finite,
  kind: Schema.Literals(["codex", "claude-code"]),
  rootID: Schema.String,
  /** The tool's id of the conversation (Codex thread id, Claude Code session id). */
  id: Schema.String,
  /** The working folders, normalized (`Paths.norm`). */
  cwds: Schema.Array(Schema.String),
  /** A sub-agent conversation's parent id. */
  parent: optional(Schema.String),
  subagent: Schema.Boolean,
  /** Codex: a `codex exec` run, listed only with `include.exec`. */
  exec: optional(Schema.Boolean),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  versions: Schema.Array(Schema.String),
  /** Claude Code: `cwds` come from the whole file (confirm pass or full parse), not the 64 KiB windows. */
  confirmed: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Import.IndexEntry" })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const File = Schema.Struct({ v: Schema.Literal(1), entries: Schema.Array(Entry) }).annotate({
  identifier: "Own.Import.IndexFile",
})

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(File))

/** More than this is not an index own wrote; it is ignored. */
const MAX_BYTES = 64 * 1024 * 1024

export function file(home: string) {
  return path.join(home, "state", "import-index.json")
}

/** The stored entries by path; a missing, oversized or unusable file gives none (it is rewritten on the next save). */
export async function load(home: string): Promise<Map<string, Entry>> {
  const read = await Fsx.readBounded(file(home), MAX_BYTES).catch(() => undefined)
  if (read?.type !== "ok") return new Map()
  const decoded = Option.getOrUndefined(decodeFile(read.text))
  return new Map((decoded?.entries ?? []).map((entry) => [entry.path, entry]))
}

/** Replaces the file atomically with exactly the {@link Entry} fields of `entries` (nothing else is copied). */
export function save(home: string, entries: Iterable<Entry>) {
  const content = { v: 1, entries: [...entries].map(pick) }
  return Fsx.writeAtomic(file(home), `${JSON.stringify(content)}\n`)
}

/** Only the declared fields, so a caller's richer object can never put content into the file. */
function pick(entry: Entry): Entry {
  return {
    path: entry.path,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    kind: entry.kind,
    rootID: entry.rootID,
    id: entry.id,
    cwds: [...entry.cwds],
    ...(entry.parent === undefined ? {} : { parent: entry.parent }),
    subagent: entry.subagent,
    ...(entry.exec === undefined ? {} : { exec: entry.exec }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    versions: [...entry.versions],
    ...(entry.confirmed === undefined ? {} : { confirmed: entry.confirmed }),
  }
}

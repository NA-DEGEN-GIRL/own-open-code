export * as Snapshot from "./snapshot.js"

import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { Fsx } from "@own/runtime"
import { Option, Schema } from "effect"
import { Paths } from "../sources/paths.js"

/**
 * Codex's fast path (09 §2.3): the thread list of `state_<n>.sqlite` read from a private copy. The original is a WAL
 * database that Codex keeps open; opening it in place, even read-only, creates or updates `-shm`/`-wal` next to it,
 * takes a shared lock and holds back Codex's checkpoints (IM-D2), and `immutable=1` would ignore the WAL and miss the
 * newest threads. So the highest-numbered `state_*.sqlite` and its `-wal` (never `-shm`) are copied quickly into
 * `OWN_HOME/tmp/import-<random>/`, copied again (at most 3 tries) when either changed during the copy, and only the
 * copy is opened, read-only. The copy holds user content (titles), so it lives only while it is read: the folder is
 * removed before {@link read} resolves, and {@link sweep} removes what a run that ended mid-copy left. Any failure
 * answers `undefined`, and the caller falls back to the file scan.
 */

export interface FileStamp {
  readonly size: number
  readonly mtimeMs: number
}

/** What a copy is checked against, and what the index compares to skip copying again (09 §2.3 "증분"). */
export interface Stamp {
  readonly db: FileStamp
  readonly wal: FileStamp | null
}

export interface Located {
  /** The original `state_<n>.sqlite`; never opened by SQLite. */
  readonly file: string
  readonly version: number
  readonly stamp: Stamp
}

/** One `threads` row with the 09 §2.3 columns. */
export interface Thread {
  readonly id: string
  readonly rolloutPath: string
  readonly cwd: string
  readonly source: string
  readonly threadSource?: string
  readonly archived: boolean
  readonly title: string
  readonly name?: string
  readonly model?: string
  readonly modelProvider: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly cliVersion: string
  readonly historyMode: string
}

/** A sub-agent thread under its parent (`thread_spawn_edges`). */
export interface Edge {
  readonly parent: string
  readonly child: string
}

export interface Taken extends Located {
  readonly threads: ReadonlyArray<Thread>
  readonly edges: ReadonlyArray<Edge>
}

export interface Input {
  readonly root: Paths.Root
  /** `OWN_HOME/tmp`. */
  readonly tmp: string
  /** Opens the copy; tests spy on it to prove the original is never opened. Default: `bun:sqlite` read-only. */
  readonly open?: (file: string) => Database
  /** Called after each copy, before the originals are stat'ed again; tests change the originals here. */
  readonly copied?: (attempt: number) => void | Promise<void>
}

const ATTEMPTS = 3

/** The highest-numbered `state_*.sqlite` of a Codex root and the stamp of it and its `-wal`: stats only. */
export async function locate(root: Paths.Root): Promise<Located | undefined> {
  if (root.kind !== "codex") return undefined
  const entries = await Paths.list(root, root.directory)
  if (!entries.ok) return undefined
  const best = entries.value
    .flatMap((entry) => {
      const match = /^state_(\d+)\.sqlite$/i.exec(entry.name)
      return match && entry.kind !== "directory" ? [{ name: entry.name, version: Number(match[1]) }] : []
    })
    .reduce<{ name: string; version: number } | undefined>(
      (found, item) => (found === undefined || item.version > found.version ? item : found),
      undefined,
    )
  if (best === undefined) return undefined
  const file = path.join(root.directory, best.name)
  const stamp = await stampOf(root, file)
  return stamp && { file, version: best.version, stamp }
}

/** The threads and sub-agent edges of the root's state DB, read from a temporary copy; `undefined` on any failure. */
export async function read(input: Input): Promise<Taken | undefined> {
  const located = await locate(input.root)
  if (located === undefined) return undefined
  const dir = path.join(input.tmp, `import-${randomBytes(8).toString("hex")}`)
  return take(input, located, dir)
    .catch(() => undefined)
    .finally(() => Fsx.removeTree(dir).catch(() => undefined))
}

/** A copy is read within seconds; older `import-*` folders were left by a run that ended mid-copy. */
export const STALE_MS = 10 * 60_000

/**
 * Removes the copies a run left in `tmp` when it ended between the copy and {@link read}'s `finally` (a Worker the
 * service terminated, a crash, a killed service), so no copy outlives its read for long (IG10). Only own.import makes
 * `import-*` folders there; another service sharing OWN_HOME may be copying right now, so only folders untouched for
 * {@link STALE_MS} go. Never fails.
 */
export async function sweep(tmp: string, now = Date.now()) {
  const entries = await fsp.readdir(tmp, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("import-"))
      .map(async (entry) => {
        const dir = path.join(tmp, entry.name)
        const stat = await fsp.stat(dir).catch(() => undefined)
        if (stat === undefined || now - stat.mtimeMs < STALE_MS) return
        await Fsx.removeTree(dir).catch(() => undefined)
      }),
  )
}

async function take(input: Input, located: Located, dir: string): Promise<Taken | undefined> {
  await fsp.mkdir(dir, { recursive: true })
  const copy = path.join(dir, path.basename(located.file))
  const stamp = await copyStable(input, located.file, copy, 1)
  if (stamp === undefined) return undefined
  const rows = query((input.open ?? openReadOnly)(copy))
  return rows && { ...located, stamp, ...rows }
}

/** Copies the DB and its `-wal` until both are unchanged across one copy; the stamp the copy matches. */
async function copyStable(input: Input, file: string, copy: string, attempt: number): Promise<Stamp | undefined> {
  if (attempt > ATTEMPTS) return undefined
  const before = await stampOf(input.root, file)
  if (before === undefined) return undefined
  const db = await copyFile(input.root, file, copy)
  // Without a `-wal` beside the original, none may be left beside the copy from an earlier try.
  const wal = before.wal ? await copyFile(input.root, `${file}-wal`, `${copy}-wal`) : await removed(`${copy}-wal`)
  await input.copied?.(attempt)
  const after = await stampOf(input.root, file)
  if (db && wal && after && sameStamp(before, after)) return after
  return copyStable(input, file, copy, attempt + 1)
}

async function copyFile(root: Paths.Root, from: string, to: string) {
  const result = await Paths.withFile(root, from, "copy", (handle) => fsp.writeFile(to, Paths.chunks(handle)))
  return result.ok
}

function removed(file: string) {
  return fsp.rm(file, { force: true }).then(
    () => true,
    () => false,
  )
}

async function stampOf(root: Paths.Root, file: string): Promise<Stamp | undefined> {
  const [db, wal] = await Promise.all([Paths.stat(root, file, "copy"), Paths.stat(root, `${file}-wal`, "copy")])
  if (!db.ok || !db.value.file) return undefined
  return {
    db: { size: db.value.size, mtimeMs: db.value.mtimeMs },
    wal: wal.ok && wal.value.file ? { size: wal.value.size, mtimeMs: wal.value.mtimeMs } : null,
  }
}

function sameStamp(a: Stamp, b: Stamp) {
  const same = (x: FileStamp | null, y: FileStamp | null) =>
    x === null || y === null ? x === y : x.size === y.size && x.mtimeMs === y.mtimeMs
  return same(a.db, b.db) && same(a.wal, b.wal)
}

function openReadOnly(file: string) {
  return new Database(file, { readonly: true })
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the copy

const Row = Schema.Struct({
  id: Schema.String,
  rollout_path: Schema.String,
  cwd: Schema.String,
  source: Schema.String,
  thread_source: Schema.NullOr(Schema.String),
  archived: Schema.Number,
  title: Schema.String,
  name: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  model_provider: Schema.String,
  created_at_ms: Schema.NullOr(Schema.Number),
  updated_at_ms: Schema.NullOr(Schema.Number),
  cli_version: Schema.String,
  history_mode: Schema.String,
})

const EdgeRow = Schema.Struct({ parent_thread_id: Schema.String, child_thread_id: Schema.String })

/** The `threads` columns of 09 §2.3; a DB without one of them (another Codex version) falls back to the file scan. */
export const THREAD_COLUMNS = Object.keys(Row.fields)

export const EDGE_COLUMNS = Object.keys(EdgeRow.fields)

const decodeColumns = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ name: Schema.String })))
const decodeRows = Schema.decodeUnknownOption(Schema.Array(Row))
const decodeEdges = Schema.decodeUnknownOption(Schema.Array(EdgeRow))

/** Checks the columns and reads both tables; always closes the copy so its folder can be removed. */
function query(db: Database) {
  try {
    if (!hasColumns(db, "threads", THREAD_COLUMNS) || !hasColumns(db, "thread_spawn_edges", EDGE_COLUMNS))
      return undefined
    const rows = Option.getOrUndefined(decodeRows(all(db, `SELECT ${THREAD_COLUMNS.join(", ")} FROM threads`)))
    const edges = Option.getOrUndefined(
      decodeEdges(all(db, `SELECT ${EDGE_COLUMNS.join(", ")} FROM thread_spawn_edges`)),
    )
    if (rows === undefined || edges === undefined) return undefined
    return {
      threads: rows.map(
        (row): Thread => ({
          id: row.id,
          rolloutPath: row.rollout_path,
          cwd: row.cwd,
          source: row.source,
          threadSource: row.thread_source ?? undefined,
          archived: row.archived !== 0,
          title: row.title,
          name: row.name ?? undefined,
          model: row.model ?? undefined,
          modelProvider: row.model_provider,
          createdAt: row.created_at_ms ?? undefined,
          updatedAt: row.updated_at_ms ?? undefined,
          cliVersion: row.cli_version,
          historyMode: row.history_mode,
        }),
      ),
      edges: edges.map((edge): Edge => ({ parent: edge.parent_thread_id, child: edge.child_thread_id })),
    }
  } finally {
    db.close()
  }
}

function hasColumns(db: Database, table: string, columns: ReadonlyArray<string>) {
  const names = new Set(
    Option.getOrElse(decodeColumns(all(db, `PRAGMA table_info(${table})`)), () => []).map((c) => c.name),
  )
  return columns.every((column) => names.has(column))
}

/** Runs one statement and finalizes it, so closing the copy releases its files at once. */
function all(db: Database, sql: string) {
  const statement = db.prepare(sql)
  const rows = statement.all()
  statement.finalize()
  return rows
}

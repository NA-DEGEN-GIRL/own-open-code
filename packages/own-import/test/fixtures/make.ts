import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { removeTree } from "../support/remove.js"

/**
 * Synthetic roots for own-import tests (09 §7.3). Everything here is written from the documented formats and the key
 * lists of the research notes; nothing is copied or cut from a real `~/.codex` or `~/.claude`. Every fixture lives in
 * its own temp folder: a Codex root, a Claude Code root and an OWN_HOME, removed by `cleanup()`. The source parsers
 * add their record builders on top (`codex.ts`, `claude.ts`); this file only writes files.
 */

/** Text that must never leave the roots (IG1, IG10): every sentinel file holds it. */
export const SENTINEL = "own-import-sentinel-5f1c0de"

/** Obviously fake, key-shaped strings, one per own-runtime `Redact.PATTERNS` label the redaction tests need. */
export const FAKE = {
  apiKey: "sk-FAKE0000own0import0fixture0000",
  anthropic: "sk-ant-FAKE0000own0import0fixture0000",
  github: "ghp_FAKE0000own0import0fixture0000",
  aws: "AKIAFAKE0OWN0IMPORT0",
  jwt: "eyJGQUtFIjoib3duLWltcG9ydCJ9.eyJmYWtlIjp0cnVlfQ.RkFLRS1zaWduYXR1cmU",
  privateKey: "-----BEGIN PRIVATE KEY-----\nRkFLRSBvd24taW1wb3J0IGZpeHR1cmUga2V5\n-----END PRIVATE KEY-----",
} as const

export interface Fixture extends AsyncDisposable {
  /** The temp folder holding everything below. */
  readonly dir: string
  /** A Codex root (`CODEX_HOME`-like), created empty. */
  readonly codex: string
  /** A Claude Code root (`CLAUDE_CONFIG_DIR`-like), created empty. */
  readonly claude: string
  /** OWN_HOME for the test; `tmp` is where the DB copies go. */
  readonly home: string
  readonly tmp: string
  /**
   * Plugin options with exactly these roots and this home, and no codex-multi-provider control center (SK2), so no test
   * reaches this PC's.
   */
  readonly options: {
    readonly home: string
    readonly roots: { readonly codex: string[]; readonly claude: string[] }
    readonly controlCenter: string | null
  }
  /** Creates `<dir>/<segments…>` (e.g. a project folder with Hangul or `#`) and returns it. */
  folder(...segments: ReadonlyArray<string>): Promise<string>
  cleanup(): Promise<void>
}

/** A fresh fixture; `under` puts the roots below a sub-folder of that name (e.g. `한글 #폴더`). */
export async function fixture(input: { readonly under?: string } = {}): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-import-fixture-"))
  const base = input.under ? path.join(dir, input.under) : dir
  const codex = path.join(base, "codex")
  const claude = path.join(base, "claude")
  const home = path.join(dir, "own-home")
  await Promise.all([codex, claude, home].map((folder) => fs.mkdir(folder, { recursive: true })))
  const cleanup = () => removeTree(dir)
  return {
    dir,
    codex,
    claude,
    home,
    tmp: path.join(home, "tmp"),
    options: { home, roots: { codex: [codex], claude: [claude] }, controlCenter: null },
    folder: async (...segments) => {
      const folder = path.join(dir, ...segments)
      await fs.mkdir(folder, { recursive: true })
      return folder
    },
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// JSONL

/** A torn last line: a record cut off mid-write, without a newline (the tool may still be writing, 09 §2.8). */
export const TORN = '{"timestamp":"2026-10-08T09:00:00.000Z","type":"response_item","payload":{"type":"mess'

export interface WriteOptions {
  /** Appends a torn last line: `true` for {@link TORN}, or the given fragment. */
  readonly torn?: boolean | string
  /** Sets the file's mtime (and atime), e.g. to make a conversation look live or old. */
  readonly mtime?: Date | number
  readonly eol?: "\n" | "\r\n"
}

/**
 * Writes `records` as JSON lines to `file`, creating its folders. A name ending in `.zst` is compressed with zstd
 * (`node:zlib`), like Codex's cold rollouts. Returns `file`.
 */
export async function writeJsonl(file: string, records: ReadonlyArray<unknown>, options: WriteOptions = {}) {
  const eol = options.eol ?? "\n"
  const torn = options.torn === true ? TORN : options.torn || ""
  const text = records.map((record) => JSON.stringify(record) + eol).join("") + torn
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, file.endsWith(".zst") ? zlib.zstdCompressSync(Buffer.from(text)) : text)
  if (options.mtime !== undefined) await fs.utimes(file, options.mtime, options.mtime)
  return file
}

/** Writes a plain text or JSON file (`custom-title.json`, `session_index.jsonl` lines, …), creating its folders. */
export async function writeText(file: string, text: string, mtime?: Date | number) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  if (mtime !== undefined) await fs.utimes(file, mtime, mtime)
  return file
}

// ---------------------------------------------------------------------------------------------------------------
// Layouts

/** `YYYY-MM-DDThh-mm-ss` of `at` in UTC, the timestamp part of a rollout name. */
function stamp(at: Date) {
  return at.toISOString().slice(0, 19).replaceAll(":", "-")
}

/**
 * The rollout path of a Codex thread: `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl[.zst]` (UTC date folders), or
 * `archived_sessions/rollout-…` when archived. `rolloutId` gives the second file of a rolled-back thread
 * (`rollout-<ts>-<threadId>_<rolloutId>.jsonl`).
 */
export function codexRollout(
  root: string,
  input: {
    readonly id: string
    readonly at: Date | string | number
    readonly zst?: boolean
    readonly archived?: boolean
    readonly rolloutId?: string
  },
) {
  const at = new Date(input.at)
  const name = `rollout-${stamp(at)}-${input.id}${input.rolloutId ? `_${input.rolloutId}` : ""}.jsonl${input.zst ? ".zst" : ""}`
  if (input.archived) return path.join(root, "archived_sessions", name)
  const iso = at.toISOString()
  return path.join(root, "sessions", iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), name)
}

/**
 * Claude Code's project folder name for `cwd`: every non-alphanumeric character becomes `-`; over 200 characters the
 * name is cut and gets a hash suffix (the CLI hashes with `Bun.hash`, so only the prefix is stable).
 */
export function claudeFolder(cwd: string) {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= 200) return sanitized
  return `${sanitized.slice(0, 200)}-${Bun.hash(cwd).toString(36)}`
}

/** `projects/<folder of cwd>/<sessionId>.jsonl`. */
export function claudeSession(root: string, cwd: string, sessionId: string) {
  return path.join(root, "projects", claudeFolder(cwd), `${sessionId}.jsonl`)
}

// ---------------------------------------------------------------------------------------------------------------
// Codex state DB

/** A `threads` row; omitted columns get the values Codex's schema defaults to. */
export interface ThreadRow {
  readonly id: string
  readonly rollout_path: string
  readonly cwd: string
  readonly source?: string
  readonly thread_source?: string | null
  readonly archived?: number
  readonly title?: string
  readonly name?: string | null
  readonly model?: string | null
  readonly model_provider?: string
  readonly created_at_ms?: number | null
  readonly updated_at_ms?: number | null
  readonly cli_version?: string
  readonly history_mode?: string
}

/**
 * `current`: the threads and spawn-edge tables as Codex 0.153 writes them (structure from the research notes).
 * `old-columns`: a `threads` table without `name` and `history_mode`. `no-edges`: no `thread_spawn_edges` table.
 */
export type StateSchema = "current" | "old-columns" | "no-edges"

const THREADS_SQL = (columns: "current" | "old") => `CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL DEFAULT 'workspace-write',
  approval_mode TEXT NOT NULL DEFAULT 'on-request',
  tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  git_branch TEXT,
  cli_version TEXT NOT NULL DEFAULT '',
  first_user_message TEXT NOT NULL DEFAULT '',
  model TEXT,
  reasoning_effort TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  thread_source TEXT,
  preview TEXT NOT NULL DEFAULT ''${
    columns === "current" ? ",\n  history_mode TEXT NOT NULL DEFAULT 'legacy',\n  name TEXT" : ""
  }
)`

const EDGES_SQL = `CREATE TABLE thread_spawn_edges (
  parent_thread_id TEXT NOT NULL,
  child_thread_id TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL
)`

export interface StateDb {
  /** `<root>/state_<version>.sqlite`. */
  readonly file: string
  /** Adds rows through the writer connection; with `keepOpen` they stay in the un-checkpointed `-wal`. */
  insert(rows: ReadonlyArray<ThreadRow>): void
  edge(parent: string, child: string): void
  /** Closes the writer: SQLite checkpoints and removes `-wal` and `-shm`. */
  close(): void
}

/**
 * A Codex state DB in WAL mode built with `bun:sqlite`. `threads` and `edges` are checkpointed into the main file;
 * `walThreads` are written afterwards and, while the writer connection stays open (`keepOpen`, default true), exist
 * only in the `-wal` beside it, like a live Codex. Without `keepOpen` the writer closes and no `-wal` or `-shm` remains.
 */
export function stateDb(
  root: string,
  input: {
    readonly version?: number
    readonly schema?: StateSchema
    readonly threads?: ReadonlyArray<ThreadRow>
    readonly edges?: ReadonlyArray<readonly [string, string]>
    readonly walThreads?: ReadonlyArray<ThreadRow>
    readonly keepOpen?: boolean
  } = {},
): StateDb {
  const file = path.join(root, `state_${input.version ?? 5}.sqlite`)
  const writer = new Database(file, { create: true })
  writer.exec("PRAGMA journal_mode=WAL")
  writer.exec("PRAGMA wal_autocheckpoint=0")
  writer.exec(THREADS_SQL(input.schema === "old-columns" ? "old" : "current"))
  if (input.schema !== "no-edges") writer.exec(EDGES_SQL)
  const current = input.schema !== "old-columns"
  const insert = (rows: ReadonlyArray<ThreadRow>) =>
    rows.forEach((row) => {
      const created = row.created_at_ms ?? Date.UTC(2026, 9, 8, 9)
      const values: Record<string, string | number | null> = {
        id: row.id,
        rollout_path: row.rollout_path,
        created_at: Math.floor(created / 1000),
        updated_at: Math.floor((row.updated_at_ms ?? created) / 1000),
        source: row.source ?? "cli",
        model_provider: row.model_provider ?? "openai",
        cwd: row.cwd,
        title: row.title ?? "",
        archived: row.archived ?? 0,
        cli_version: row.cli_version ?? "0.153.0",
        model: row.model ?? null,
        created_at_ms: row.created_at_ms === undefined ? created : row.created_at_ms,
        updated_at_ms: row.updated_at_ms === undefined ? created : row.updated_at_ms,
        thread_source: row.thread_source ?? null,
        ...(current ? { history_mode: row.history_mode ?? "legacy", name: row.name ?? null } : {}),
      }
      const columns = Object.keys(values)
      writer.run(
        `INSERT INTO threads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        Object.values(values),
      )
    })
  const edge = (parent: string, child: string) =>
    writer.run("INSERT INTO thread_spawn_edges VALUES (?, ?, 'completed')", [parent, child])
  insert(input.threads ?? [])
  ;(input.edges ?? []).forEach((pair) => edge(pair[0], pair[1]))
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  insert(input.walThreads ?? [])
  const db: StateDb = { file, insert, edge, close: () => writer.close() }
  if (input.keepOpen === false) db.close()
  return db
}

// ---------------------------------------------------------------------------------------------------------------
// Never-open sentinels

/**
 * Files own must never open (09 §2.1, IG1), each holding {@link SENTINEL} and a fake key: Codex `auth.json`,
 * `config.toml`, `history.jsonl`, `thread_history_1.sqlite`, `sqlite/codex-dev.db`, a writer lock and a `*.key`;
 * Claude Code `.credentials.json`, `history.jsonl`, `sessions/<pid>.json`, `file-history/`, `shell-snapshots/`, a
 * project `memory/` note and a `*.key`. `project` names the Claude project folder for the memory note.
 */
export async function sentinels(root: string, kind: "codex" | "claude-code", project = "C--fixture-project") {
  const body = `${SENTINEL} ${FAKE.apiKey} ${FAKE.privateKey}\n`
  const files =
    kind === "codex"
      ? [
          "auth.json",
          "config.toml",
          "history.jsonl",
          "thread_history_1.sqlite",
          path.join("sqlite", "codex-dev.db"),
          path.join("thread-writer-locks", "019a0000-0000-7000-8000-000000000001.lock"),
          "signing.key",
        ]
      : [
          ".credentials.json",
          "history.jsonl",
          path.join("sessions", "4242.json"),
          path.join("file-history", "0f1e2d3c", "v1"),
          path.join("shell-snapshots", "snapshot-bash-1.sh"),
          path.join("projects", project, "memory", "MEMORY.md"),
          "signing.key",
        ]
  return Promise.all(files.map((file) => writeText(path.join(root, file), body)))
}

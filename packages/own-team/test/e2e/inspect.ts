// Inspectors for team e2e verdicts (06 §11.2: "판정은 내구 상태로 한다"): the own.team namespace of core's KV, a
// session's durable log seq, inbox rows, `git worktree list`, sparse patterns, files on disk, and, per model request
// the fakes recorded, the tool-definition and Code Mode catalog hashes and the prompt-cache counters. Reads only:
// SQLite opens read-only beside the running server (WAL), git runs with GIT_OPTIONAL_LOCKS=0.

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Prefix } from "@own/runtime"
import { sha256, type OpencodeServer, type RecordedRequest } from "../../../own-accounts/test/e2e-kit"
import { git } from "../fixtures/repo.js"
import { turn } from "./directives.js"

export { files } from "../fixtures/repo.js"
export { toolNames } from "./directives.js"

// ---------------------------------------------------------------------------------------------------------------
// Core state

/** A plugin's KV namespace (core `plugin/host.ts` `storage`: every UTF-16 unit of the id as four hex digits). */
export function kvNamespace(pluginID: string) {
  return `plugin:${pluginID
    .split("")
    .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("")}:`
}

/** Every value of the plugin's KV (default own.team, 06 §2.4) by key without the namespace, in key order. */
export function kv(database: string, pluginID: string = OwnTeam.ID): Readonly<Record<string, unknown>> {
  const namespace = kvNamespace(pluginID)
  const rows = query(database, (db) =>
    db
      .query<{ key: string; value: string }, [string]>("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key")
      .all(`${namespace}%`),
  )
  return Object.fromEntries(rows.map((row) => [row.key.slice(namespace.length), json(row.value)]))
}

export interface InboxRow {
  readonly id: string
  readonly sessionID: string
  readonly type: string
  readonly delivery: string
  /** `enqueued_seq`: the admission order within the session. */
  readonly seq: number
  readonly payload: unknown
}

/** The unconsumed inbox rows (core `session_inbox`), of one session or of all, in admission order. */
export function inbox(database: string, sessionID?: string): ReadonlyArray<InboxRow> {
  const rows = query(database, (db) =>
    sessionID === undefined
      ? db.query<InboxSql, []>(`${INBOX} ORDER BY session_id, enqueued_seq`).all()
      : db.query<InboxSql, [string]>(`${INBOX} WHERE session_id = ? ORDER BY enqueued_seq`).all(sessionID),
  )
  return rows.map((row) => ({
    id: row.id,
    sessionID: row.session_id,
    type: row.type,
    delivery: row.delivery,
    seq: row.enqueued_seq,
    payload: json(row.payload),
  }))
}

interface InboxSql {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly delivery: string
  readonly enqueued_seq: number
  readonly payload: string
}

const INBOX = "SELECT id, session_id, type, delivery, enqueued_seq, payload FROM session_inbox"

export interface SessionLog {
  /**
   * The durable session events after `after` that the log still holds, oldest first (`type`, `aggregateID`, `seq`).
   * Core keeps no event rows for a plain local session (its projections hold the state), so this is often empty.
   */
  readonly events: ReadonlyArray<Readonly<Record<string, unknown>>>
  /** The log's watermark (`log.synced`): the session's newest seq, the value own.team's `cursor:<sessionID>` follows. */
  readonly seq: number | undefined
}

/** A session's durable log (`GET /api/experimental/session/:id/log`, read to its watermark, no follow). */
export async function sessionLog(
  server: Pick<OpencodeServer, "request">,
  sessionID: string,
  options: { readonly after?: number; readonly directory?: string } = {},
): Promise<SessionLog> {
  const response = await server.request("GET", `/api/experimental/session/${encodeURIComponent(sessionID)}/log`, {
    query: {
      ...(options.after === undefined ? {} : { after: String(options.after) }),
      ...(options.directory === undefined ? {} : { "location[directory]": options.directory }),
    },
    ...(options.directory === undefined ? {} : { directory: options.directory }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`session.log ${sessionID}: HTTP ${response.status} ${text}`)
  const items = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => json(line.slice(5).trim()))
    .filter(isRecord)
  const synced = items.find((item) => item.type === "log.synced")
  const events = items.filter((item) => item.type !== "log.synced")
  const last = events.map((item) => item.seq).findLast((seq) => typeof seq === "number")
  return { events, seq: typeof synced?.seq === "number" ? synced.seq : typeof last === "number" ? last : undefined }
}

// ---------------------------------------------------------------------------------------------------------------
// Git

export interface WorktreeEntry {
  /** Native path. */
  readonly path: string
  readonly head?: string
  /** `refs/heads/<name>` without the prefix; absent when detached or bare. */
  readonly branch?: string
  readonly detached: boolean
  readonly bare: boolean
  /** The lock reason (`""` when locked without one); absent when not locked. */
  readonly locked?: string
  readonly prunable?: string
}

/** `git worktree list --porcelain -z` of the repository that holds `directory`. */
export function worktrees(directory: string): ReadonlyArray<WorktreeEntry> {
  const fields = read(directory, ["worktree", "list", "--porcelain", "-z"]).split("\0")
  const records = fields.reduce<string[][]>(
    (all, field) => (field === "" ? [...all, []] : [...all.slice(0, -1), [...(all.at(-1) ?? []), field]]),
    [[]],
  )
  return records
    .filter((record) => record.length > 0)
    .map((record) => {
      const value = (name: string) => {
        const line = record.find((item) => item === name || item.startsWith(`${name} `))
        return line === undefined ? undefined : line.slice(name.length + 1)
      }
      const branch = value("branch")
      const head = value("HEAD")
      const locked = value("locked")
      const prunable = value("prunable")
      return {
        path: path.resolve(value("worktree") ?? ""),
        ...(head === undefined ? {} : { head }),
        ...(branch === undefined ? {} : { branch: branch.replace(/^refs\/heads\//, "") }),
        detached: record.includes("detached"),
        bare: record.includes("bare"),
        ...(locked === undefined ? {} : { locked }),
        ...(prunable === undefined ? {} : { prunable }),
      }
    })
}

export interface Sparse {
  /** `core.sparseCheckout` of this worktree. */
  readonly enabled: boolean
  readonly cone: boolean
  /** `git sparse-checkout list`: the cone folders (or the patterns in non-cone mode). */
  readonly list: ReadonlyArray<string>
  /** The raw lines of this worktree's `info/sparse-checkout` file. */
  readonly patterns: ReadonlyArray<string>
}

/** The sparse checkout of the worktree at `directory` (06 §4.5). */
export function sparse(directory: string): Sparse {
  const enabled = optional(directory, ["config", "--get", "core.sparseCheckout"])?.trim() === "true"
  const cone = optional(directory, ["config", "--get", "core.sparseCheckoutCone"])?.trim() === "true"
  const file = path.resolve(directory, read(directory, ["rev-parse", "--git-path", "info/sparse-checkout"]).trim())
  const patterns = fs.existsSync(file) ? lines(fs.readFileSync(file, "utf8")) : []
  const list = enabled ? lines(optional(directory, ["sparse-checkout", "list"]) ?? "") : []
  return { enabled, cone, list, patterns }
}

// ---------------------------------------------------------------------------------------------------------------
// Model requests

/** Requests that called a model (not `/v1/models`, the balance probe or an OAuth call). */
export function modelRequests(requests: ReadonlyArray<RecordedRequest>) {
  return requests.filter((request) => request.model !== undefined)
}

/**
 * The model requests of one session, oldest first, by core's `x-opencode-session-id` header (upstream f46fa72a92; a
 * WebSocket follow-up records its handshake's headers). Since upstream v2.0.24 neither older signal names a child:
 * `prompt_cache_key` and the affinity headers carry the parent's id (6cf442b545), and the environment line
 * `session ID: <id>` is gone (bda798b167).
 */
export function ofSession(requests: ReadonlyArray<RecordedRequest>, sessionID: string) {
  return modelRequests(requests).filter((request) => request.headers["x-opencode-session-id"] === sessionID)
}

/**
 * Hash of the tool definitions of a Responses, Anthropic or chat request (TG16: "도구 정의 해시"; `Prefix`, P0-2b):
 * canonical, so JSON key order and cache hints do not count. The gates assert {@link toolBytes} next to it.
 */
export function toolsHash(request: Pick<RecordedRequest, "json">) {
  return Prefix.section(request.json, "tools")
}

/**
 * sha256 of the tool definitions as sent (`tools`, in wire key order, cache hints included): a change of key order or
 * cache hints rewrites the bytes a provider's prompt cache sees, which {@link toolsHash} leaves out.
 */
export function toolBytes(request: Pick<RecordedRequest, "json">) {
  return sha256(JSON.stringify(isRecord(request.json) && Array.isArray(request.json.tools) ? request.json.tools : []))
}

/** The heading core renders above the Code Mode catalog, and the one above its tool list (`codemode/instructions.ts`). */
export const CATALOG_HEADING = "# Code Mode"
const TOOLS_HEADING = "## Code Mode tools (call only inside `execute`)\n\n"

/**
 * The Code Mode catalog the request shows the model: from {@link CATALOG_HEADING} in its system text through the tool
 * list, which ends at the first blank line (the next instruction section follows it). `undefined` without a catalog.
 * A catalog without the tool list heading throws: core renamed it (v2.2 did), and the hash would run to the end of the
 * system text.
 */
export function catalog(request: Pick<RecordedRequest, "json">) {
  const system = turn(request).system
  const start = system.indexOf(CATALOG_HEADING)
  if (start < 0) return undefined
  const list = system.indexOf(TOOLS_HEADING, start)
  if (list < 0) throw new Error(`Code Mode catalog without ${JSON.stringify(TOOLS_HEADING.trim())}`)
  const end = system.indexOf("\n\n", list + TOOLS_HEADING.length)
  return system.slice(start, end < 0 ? undefined : end)
}

/**
 * TG16 with the worktree conversation tools (`worktree`, 06 §13.3), which every conversation has: `withTools`'s catalog
 * is still complete and holds every line of `without`'s, so own-team adds those tools and changes nothing else.
 * Returns the lines `without` has that `withTools` lacks (none when it holds).
 */
export function catalogMissing(withTools: Pick<RecordedRequest, "json">, without: Pick<RecordedRequest, "json">) {
  const lines = new Set((catalog(withTools) ?? "").split(/\r?\n/))
  return (catalog(without) ?? "").split(/\r?\n/).filter((line) => !lines.has(line))
}

/**
 * Whether a Responses request continues the previous response (`previous_response_id`, Codex over WebSocket). Since
 * upstream v2.3.2 (#64542) the system text, the Code Mode catalog with it, is the input's leading developer message, so
 * such a request carries no catalog of its own: its prefix is the earlier request's.
 */
export function chained(request: Pick<RecordedRequest, "json">) {
  return isRecord(request.json) && typeof request.json.previous_response_id === "string"
}

/** The {@link catalogHash}es of the requests that carry their catalog (not {@link chained} ones). */
export function catalogHashes(requests: ReadonlyArray<Pick<RecordedRequest, "json">>) {
  return new Set(requests.filter((request) => !chained(request)).map(catalogHash))
}

/** sha256 of {@link catalog} (TG16: "카탈로그 해시"); `undefined` without a catalog. */
export function catalogHash(request: Pick<RecordedRequest, "json">) {
  const text = catalog(request)
  return text === undefined ? undefined : sha256(text)
}

export interface CacheTotals {
  readonly requests: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly writtenTokens: number
  /** `cachedTokens / promptTokens` (0 without prompt tokens). */
  readonly ratio: number
}

/** The fakes' prompt-cache counters summed over `requests` (estimates: compare ratios, not absolute numbers). */
export function cache(requests: ReadonlyArray<Pick<RecordedRequest, "cache">>): CacheTotals {
  const used = requests.flatMap((request) => (request.cache ? [request.cache] : []))
  const sum = (pick: (usage: (typeof used)[number]) => number) => used.reduce((total, usage) => total + pick(usage), 0)
  const promptTokens = sum((usage) => usage.promptTokens)
  const cachedTokens = sum((usage) => usage.cachedTokens)
  return {
    requests: used.length,
    promptTokens,
    cachedTokens,
    writtenTokens: sum((usage) => usage.writtenTokens),
    ratio: promptTokens === 0 ? 0 : cachedTokens / promptTokens,
  }
}

// ---------------------------------------------------------------------------------------------------------------

function query<T>(database: string, run: (db: Database) => T): T {
  const db = new Database(database, { readonly: true })
  db.exec("PRAGMA busy_timeout = 5000")
  const result = run(db)
  db.close()
  return result
}

/** git output in `directory`; throws on failure (fixture `git`). */
function read(directory: string, args: ReadonlyArray<string>) {
  return git(directory, ["-c", "core.quotepath=false", ...args], { env: { GIT_OPTIONAL_LOCKS: "0" } })
}

/** git output, or `undefined` when git exits non-zero (an unset config key, a worktree that is not sparse). */
function optional(directory: string, args: ReadonlyArray<string>) {
  const result = Bun.spawnSync(["git", "-c", "core.quotepath=false", "-C", directory, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  })
  return result.exitCode === 0 ? result.stdout.toString() : undefined
}

function lines(text: string) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "")
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function json(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

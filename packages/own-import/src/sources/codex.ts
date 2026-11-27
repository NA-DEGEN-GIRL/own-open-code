export * as CodexStore from "./codex.js"

import path from "node:path"
import { Readable, pipeline } from "node:stream"
import { finished } from "node:stream/promises"
import zlib from "node:zlib"
import { optional } from "@opencode/schema/schema"
import { Option, Schema } from "effect"
import { Snapshot } from "../index/snapshot.js"
import { CodexTranscript } from "../transcript/codex.js"
import type { Transcript } from "../transcript/ir.js"
import { Paths } from "./paths.js"

/**
 * Codex's store, read only (09 §2.1, §2.3, §2.5, §2.8): which threads a root holds and the streaming reader of their
 * rollouts. Every file access goes through {@link Paths} (allowlist, read-only opens that are never held between
 * calls). The state DB is read only as a private copy ({@link Snapshot}); without it, or when its columns differ, the
 * rollout folders are scanned instead.
 *
 * - **Discovery** ({@link discover}): with the DB copy, its `threads` rows (and `thread_spawn_edges`) name the
 *   threads, and each row's rollout is matched by name in the listing: `.jsonl`, then `.jsonl.zst`, then
 *   `archived_sessions`; a row without a file is `missing`, not an error. Files no row names, or all files when there
 *   is no DB, are grouped by thread id from their names (a reverted thread has two files; the one no other file names
 *   as `history_base` is current, else the newest) and their first line gives `session_meta`.
 * - **Reading** ({@link transcript}): one pass over the decoded lines into {@link CodexTranscript.parser}. `.zst` files
 *   are decoded as a stream (`node:zlib` `createZstdDecompress`) and never written anywhere; a line longer than
 *   {@link LINE_MAX} is skipped and counted, a torn last line is ignored; a file Codex compresses or restores while
 *   own opens it is looked up once more. For I2, a `history_base` prefix is read first, up to its `end_byte_offset`.
 */

/** The first-line window of the file scan (09 §2.3): `session_meta` is at most about 48 KB. */
export const HEAD_BYTES = 64 * 1024

/** Longer lines are skipped and counted as `oversizedLine` (09 §2.8). */
export const LINE_MAX = 32 * 1024 * 1024

export type Problem = Paths.Failure | "decode_failed" | "too_large"

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Problem }

/** One rollout file found in a root (stat only, nothing read). */
export interface RolloutFile {
  readonly path: string
  /** The plain name (`rollout-<ts>-<threadId>[_<rolloutId>].jsonl`), the same for both forms of the file. */
  readonly name: string
  readonly threadID: string
  /** The thread id, or the second id in a reverted thread's file name (Codex `RolloutFileName`). */
  readonly rolloutID: string
  /** The name's `YYYY-MM-DD` (the date folder it belongs in) and its time, read as UTC. */
  readonly date: string
  readonly time: number
  readonly zst: boolean
  readonly archived: boolean
  readonly size: number
  readonly mtimeMs: number
}

// ---------------------------------------------------------------------------------------------------------------
// Listing

/** Thread and rollout ids are path-free tokens (`OwnImport.SourceID`); a name with anything else is not listed. */
const NAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([A-Za-z0-9][A-Za-z0-9.:-]{0,255})(?:_([A-Za-z0-9][A-Za-z0-9.:-]{0,255}))?\.jsonl(\.zst)?$/

/** The parts of a rollout file name, or `undefined` when it is not one. */
export function parseName(name: string) {
  const match = NAME.exec(name)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, threadID, rolloutID, zst] = match
  return {
    name: zst ? name.slice(0, -4) : name,
    threadID,
    rolloutID: rolloutID ?? threadID,
    date: `${year}-${month}-${day}`,
    time: Date.UTC(+year, +month - 1, +day, +hour, +minute, +second),
    zst: zst !== undefined,
  }
}

/**
 * The rollout files of a root: `sessions\YYYY\MM\DD\` (only day folders from `since`, `YYYY-MM-DD`, when given) and
 * `archived_sessions\` (unless `archived: false`). Folders are listed and files stat'ed; no file is opened.
 */
export async function files(
  root: Paths.Root,
  input: { readonly since?: string; readonly archived?: boolean } = {},
): Promise<RolloutFile[]> {
  const days = await dayFolders(root)
  const folders = [
    ...days
      .filter((day) => input.since === undefined || day.date >= input.since)
      .map((day) => ({ dir: day.dir, archived: false })),
    ...(input.archived === false ? [] : [{ dir: path.join(root.directory, "archived_sessions"), archived: true }]),
  ]
  const found = await Promise.all(
    folders.map(async (folder) => {
      const entries = await Paths.list(root, folder.dir)
      if (!entries.ok) return []
      const named = entries.value.flatMap((entry) => {
        const parsed = entry.kind === "directory" ? undefined : parseName(entry.name)
        return parsed ? [{ ...parsed, path: path.join(folder.dir, entry.name) }] : []
      })
      const stated = await Promise.all(
        named.map(async (item): Promise<RolloutFile | undefined> => {
          const stat = await Paths.stat(root, item.path)
          if (!stat.ok || !stat.value.file) return undefined
          return { ...item, archived: folder.archived, size: stat.value.size, mtimeMs: stat.value.mtimeMs }
        }),
      )
      return stated.filter((item) => item !== undefined)
    }),
  )
  return found.flat()
}

async function dayFolders(root: Paths.Root) {
  const sessions = path.join(root.directory, "sessions")
  const level = async (dir: string, pattern: RegExp) => {
    const entries = await Paths.list(root, dir)
    if (!entries.ok) return []
    return entries.value
      .filter((entry) => (entry.kind === "directory" || entry.kind === "link") && pattern.test(entry.name))
      .map((entry) => entry.name)
  }
  const years = await level(sessions, /^\d{4}$/)
  const months = (
    await Promise.all(
      years.map(async (year) => (await level(path.join(sessions, year), /^\d{2}$/)).map((month) => [year, month])),
    )
  ).flat()
  return (
    await Promise.all(
      months.map(async ([year, month]) =>
        (await level(path.join(sessions, year, month), /^\d{2}$/)).map((day) => ({
          date: `${year}-${month}-${day}`,
          dir: path.join(sessions, year, month, day),
        })),
      ),
    )
  ).flat()
}

/** The order a thread's file is looked up in (09 §2.3): `.jsonl`, `.jsonl.zst`, then `archived_sessions`. */
function rank(file: RolloutFile) {
  return (file.archived ? 2 : 0) + (file.zst ? 1 : 0)
}

/** Of the files with one name (both forms, active and archived), the one to read. */
function preferred(list: ReadonlyArray<RolloutFile>) {
  return list.toSorted((a, b) => rank(a) - rank(b))[0]
}

/**
 * The file of a recorded rollout path (a state DB `rollout_path`) inside `root`, looked up by its name in the order of
 * 09 §2.3 with one stat per candidate; also the second lookup after a file vanished while Codex (de)compressed it.
 * The day folder comes from the recorded path when it is `sessions\YYYY\MM\DD\`, else from the name's date.
 */
export async function resolve(root: Paths.Root, recorded: string): Promise<RolloutFile | undefined> {
  const parts = Paths.norm(recorded).split("\\")
  const parsed = parseName(parts.at(-1) ?? "")
  if (parsed === undefined) return undefined
  const recordedDay = parts.slice(-4, -1)
  const day =
    parts.at(-5)?.toLowerCase() === "sessions" &&
    /^\d{4}$/.test(recordedDay[0]) &&
    recordedDay.slice(1).every((part) => /^\d{2}$/.test(part))
      ? recordedDay
      : parsed.date.split("-")
  const active = path.join(root.directory, "sessions", ...day, parsed.name)
  const archived = path.join(root.directory, "archived_sessions", parsed.name)
  const candidates = [
    { file: active, archived: false, zst: false },
    { file: `${active}.zst`, archived: false, zst: true },
    { file: archived, archived: true, zst: false },
    { file: `${archived}.zst`, archived: true, zst: true },
  ]
  const first = async (index: number): Promise<RolloutFile | undefined> => {
    const candidate = candidates[index]
    if (candidate === undefined) return undefined
    const stat = await Paths.stat(root, candidate.file)
    if (!stat.ok || !stat.value.file) return first(index + 1)
    return {
      ...parsed,
      path: candidate.file,
      zst: candidate.zst,
      archived: candidate.archived,
      size: stat.value.size,
      mtimeMs: stat.value.mtimeMs,
    }
  }
  return first(0)
}

// ---------------------------------------------------------------------------------------------------------------
// session_index.jsonl (thread names, 09 §2.3)

const IndexEntry = Schema.Struct({ id: Schema.String, thread_name: optional(Schema.NullOr(Schema.String)) })
const decodeIndexEntry = Schema.decodeUnknownOption(Schema.fromJsonString(IndexEntry))

/** Thread names from `session_index.jsonl`: append-only, the last entry of an id wins; no file, no names. */
export async function names(root: Paths.Root): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  await decoded(root, path.join(root.directory, "session_index.jsonl"), false, undefined, (chunks) =>
    eachLine(chunks, LINE_MAX, (line) => {
      const entry = Option.getOrUndefined(decodeIndexEntry(line.text))
      if (entry === undefined) return
      if (!entry.thread_name) return void found.delete(entry.id)
      found.set(entry.id, entry.thread_name)
    }),
  )
  return found
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery (09 §2.3, §2.5)

/** A Codex thread as the list sees it. */
export interface Thread {
  /** The list's fields (title, first prompt, cwd, models, times, parent, …); turns are known only after a parse. */
  readonly source: Transcript.Source
  /** The current rollout file; absent when the state DB names a thread whose file is gone. */
  readonly file?: RolloutFile
  /** `missing` without a file; otherwise why its first line could not be read. */
  readonly problem?: Problem
  /** A Codex archived thread (DB `archived`, or a file in `archived_sessions`). */
  readonly archived: boolean
  /** A `codex exec` run, listed only with `include.exec`. */
  readonly exec: boolean
  /** Sub-agent threads folded under this one (DB `thread_spawn_edges`, else their `session_meta` parent). */
  readonly children: ReadonlyArray<string>
}

export interface DiscoverInput {
  /** `OWN_HOME/tmp`, where the state DB copy lives while it is read. */
  readonly tmp: string
  readonly now?: number
  /** `false` skips the state DB (the file scan alone); default: the DB copy first. */
  readonly snapshot?: boolean
  /** The index's head of an unchanged file (same path, size and mtime), so its first line is not read again. */
  readonly cached?: (file: RolloutFile) => CodexTranscript.Head | undefined
}

export interface Discovered {
  readonly threads: ReadonlyArray<Thread>
  readonly via: "snapshot" | "scan"
  /** The DB stamp the copy matched: the index copies again only when it changes (09 §2.3 증분). */
  readonly stamp?: Snapshot.Stamp
  readonly files: ReadonlyArray<RolloutFile>
  /** Heads read in this call, for the index's cache. */
  readonly heads: ReadonlyArray<{ readonly file: RolloutFile; readonly head: CodexTranscript.Head }>
}

/** The threads of one Codex root; never throws, an unreadable thread is listed with its `problem`. */
export async function discover(root: Paths.Root, input: DiscoverInput): Promise<Discovered> {
  const now = input.now ?? Date.now()
  const [listed, titles, taken] = await Promise.all([
    files(root),
    names(root),
    input.snapshot === false ? undefined : Snapshot.read({ root, tmp: input.tmp }),
  ])
  const heads: Array<{ file: RolloutFile; head: CodexTranscript.Head }> = []
  const queue = limiter(HEAD_READS)
  const reads = new Map<string, Promise<Result<CodexTranscript.Head>>>()
  const readHead = (file: RolloutFile): Promise<Result<CodexTranscript.Head>> => {
    const known = input.cached?.(file)
    if (known !== undefined) return Promise.resolve({ ok: true, value: known })
    const pending =
      reads.get(file.path) ??
      queue(() => head(root, file)).then((result) => {
        if (result.ok) heads.push({ file, head: result.value })
        return result
      })
    reads.set(file.path, pending)
    return pending
  }
  const byName = group(listed, (file) => file.name)
  const unique = [...byName.values()].map(preferred)
  const byThread = group(unique, (file) => file.threadID)
  const context: Context = { root, now, titles, readHead, byName, edges: taken?.edges ?? [] }
  const fromDb = taken ? await Promise.all(taken.threads.map((row) => fromRow(context, row, byThread.get(row.id)))) : []
  const known = new Set(fromDb.map((thread) => thread.source.id))
  const scanned = await Promise.all(
    [...byThread].filter(([id]) => !known.has(id)).map(([, list]) => fromFiles(context, list)),
  )
  return {
    threads: link([...fromDb, ...scanned], context.edges),
    via: taken ? "snapshot" : "scan",
    stamp: taken?.stamp,
    files: listed,
    heads,
  }
}

interface Context {
  readonly root: Paths.Root
  readonly now: number
  readonly titles: ReadonlyMap<string, string>
  readonly readHead: (file: RolloutFile) => Promise<Result<CodexTranscript.Head>>
  readonly byName: ReadonlyMap<string, ReadonlyArray<RolloutFile>>
  readonly edges: ReadonlyArray<Snapshot.Edge>
}

/** A thread from its state DB row; the head is read only for listed (non-sub-agent) threads, for the first prompt. */
async function fromRow(
  context: Context,
  row: Snapshot.Thread,
  own: ReadonlyArray<RolloutFile> | undefined,
): Promise<Thread> {
  const kind = CodexTranscript.sourceKind(row.source, row.threadSource)
  const edgeParent = context.edges.find((edge) => edge.child === row.id)?.parent
  const subagent = kind.subagent || edgeParent !== undefined
  const named = context.byName.get(parseName(Paths.norm(row.rolloutPath).split("\\").at(-1) ?? "")?.name ?? "")
  // The recorded file, else (a DB that lags a revert) the newest file of the thread.
  const file = named ? preferred(named) : own && newest(own)
  const read = file && !subagent ? await context.readHead(file) : undefined
  const meta = read?.ok ? read.value : undefined
  const createdAt = row.createdAt ?? meta?.time ?? file?.time ?? 0
  return {
    source: CodexTranscript.omitUndefined({
      kind: "codex",
      id: row.id,
      rootID: context.root.rootID,
      path: file?.path ?? row.rolloutPath,
      versions: row.cliVersion ? [row.cliVersion] : meta?.cliVersion ? [meta.cliVersion] : [],
      app: kind.app,
      cwds: row.cwd ? [row.cwd] : meta?.cwd ? [meta.cwd] : [],
      branch: meta?.branch,
      title: context.titles.get(row.id) || row.name || row.title || meta?.firstPrompt || "",
      firstPrompt: meta?.firstPrompt,
      models: row.model
        ? [CodexTranscript.omitUndefined({ provider: row.modelProvider || undefined, id: row.model })]
        : [],
      createdAt,
      updatedAt: row.updatedAt ?? file?.mtimeMs ?? createdAt,
      bytes: file?.size ?? 0,
      parentID: kind.parentID ?? edgeParent ?? meta?.parentID,
      base: meta?.base
        ? CodexTranscript.omitUndefined({ id: meta.base.rolloutID, endByteOffset: meta.base.endByteOffset })
        : undefined,
      subagent,
      live: file !== undefined && context.now - file.mtimeMs < CodexTranscript.LIVE_MS,
    }),
    file,
    problem: file === undefined ? "missing" : read?.ok === false ? read.reason : undefined,
    archived: row.archived || file?.archived === true,
    exec: kind.app === "exec",
    children: [],
  }
}

/** A thread found by the file scan: its current file and that file's first line. */
async function fromFiles(context: Context, list: ReadonlyArray<RolloutFile>): Promise<Thread> {
  const file = await current(context, list)
  const read = await context.readHead(file)
  const meta = read.ok ? read.value : undefined
  const createdAt = meta?.time ?? file.time
  return {
    source: CodexTranscript.omitUndefined({
      kind: "codex",
      id: file.threadID,
      rootID: context.root.rootID,
      path: file.path,
      versions: meta?.cliVersion ? [meta.cliVersion] : [],
      app: meta?.app,
      cwds: meta?.cwd ? [meta.cwd] : [],
      branch: meta?.branch,
      title: context.titles.get(file.threadID) || meta?.firstPrompt || "",
      firstPrompt: meta?.firstPrompt,
      models: [],
      createdAt,
      updatedAt: file.mtimeMs,
      bytes: file.size,
      parentID: meta?.parentID,
      base: meta?.base
        ? CodexTranscript.omitUndefined({ id: meta.base.rolloutID, endByteOffset: meta.base.endByteOffset })
        : undefined,
      subagent: meta?.subagent ?? false,
      live: context.now - file.mtimeMs < CodexTranscript.LIVE_MS,
    }),
    file,
    problem: read.ok ? undefined : read.reason,
    archived: file.archived,
    exec: meta?.app === "exec",
    children: [],
  }
}

/**
 * The current file of a thread found by the scan (09 §2.5): a reverted thread has a second file whose `history_base`
 * names the first one's rollout id; the file no other file names is current, and of several the newest.
 */
async function current(context: Context, list: ReadonlyArray<RolloutFile>) {
  if (list.length === 1) return list[0]
  const reads = await Promise.all(list.map((file) => context.readHead(file)))
  const referenced = new Set(
    reads.flatMap((read, index) =>
      read.ok && read.value.base && read.value.base.rolloutID !== list[index].rolloutID
        ? [read.value.base.rolloutID]
        : [],
    ),
  )
  const open = list.filter((file) => !referenced.has(file.rolloutID))
  return newest(open.length > 0 ? open : list)
}

function newest(list: ReadonlyArray<RolloutFile>) {
  return list.toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.time - a.time || (a.name < b.name ? 1 : -1))[0]
}

/** Children per parent: the DB's spawn edges plus sub-agents whose `session_meta` names the parent. */
function link(threads: ReadonlyArray<Thread>, edges: ReadonlyArray<Snapshot.Edge>): Thread[] {
  const children = new Map<string, string[]>()
  const add = (parent: string, child: string) => {
    const list = children.get(parent) ?? []
    if (!list.includes(child)) children.set(parent, [...list, child])
  }
  edges.forEach((edge) => add(edge.parent, edge.child))
  threads.forEach((thread) => {
    if (thread.source.subagent && thread.source.parentID) add(thread.source.parentID, thread.source.id)
  })
  return threads.map((thread) => ({ ...thread, children: children.get(thread.source.id) ?? [] }))
}

/**
 * One thread per id across roots (09 §2.5): the copy with the latest activity (then the larger file) wins, else the
 * earlier root's; the result keeps the roots' order.
 */
export function dedupe(lists: ReadonlyArray<ReadonlyArray<Thread>>): Thread[] {
  const all = lists.flat()
  const better = (a: Thread, b: Thread) =>
    b.source.updatedAt > a.source.updatedAt ||
    (b.source.updatedAt === a.source.updatedAt && b.source.bytes > a.source.bytes)
  const winner = all.reduce((best, thread) => {
    const known = best.get(thread.source.id)
    if (known === undefined || better(known, thread)) best.set(thread.source.id, thread)
    return best
  }, new Map<string, Thread>())
  return all.filter((thread) => winner.get(thread.source.id) === thread)
}

function group<T>(list: ReadonlyArray<T>, by: (item: T) => string) {
  return list.reduce((map, item) => {
    const key = by(item)
    map.set(key, [...(map.get(key) ?? []), item])
    return map
  }, new Map<string, T[]>())
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/**
 * The head of a rollout (09 §2.3): its first {@link HEAD_BYTES} of decoded content (a `.zst` is decoded only that
 * far), the `session_meta` on the first line and the first real user request in the window.
 */
export async function head(root: Paths.Root, file: RolloutFile): Promise<Result<CodexTranscript.Head>> {
  return again<CodexTranscript.Head>(root, file, async (target) => {
    const window = await decoded(root, target.path, target.zst, HEAD_BYTES, collect)
    if (!window.ok) return window
    const parts = window.value.toString("utf8").split("\n")
    // The rest after the last newline: cut by the window, or a torn last line.
    const rest = parts.pop() ?? ""
    const lines = parts.map((line) => line.replace(/\r$/, ""))
    const value =
      lines.length > 0
        ? CodexTranscript.head({ lines })
        : CodexTranscript.head({ lines: [], partial: window.value.length >= HEAD_BYTES ? rest : undefined })
    return value ? { ok: true, value } : { ok: false, reason: "decode_failed" }
  })
}

export interface ReadInput {
  readonly now?: number
  /** The list's title (`session_index.jsonl` name, the DB's name or title). */
  readonly title?: string
  /** I2: read the `history_base` prefix first, up to its `end_byte_offset` (09 §2.5, IG4). */
  readonly base?: boolean
  /** The root's files when the caller has them, to find the prefix's file without listing again. */
  readonly files?: ReadonlyArray<RolloutFile>
  /** Default {@link LINE_MAX}. */
  readonly maxLine?: number
  /** Decoded bytes read at most, the prefix included; past it the parse is `too_large`. Default `Paths.PARSE_BYTES`. */
  readonly maxBytes?: number
  /**
   * Called after each line of the conversation's own file with the line's byte offset in the decoded content; `false`
   * stops reading (a cancelled view). The viewer notes where each turn starts (09 §2.8).
   */
  readonly visit?: (
    parser: CodexTranscript.Parser,
    at: { readonly offset: number; readonly line: number },
  ) => boolean | void
}

export interface Read {
  readonly info: Transcript.Info
  /** The file that was read (after a second lookup, the new one). */
  readonly file: RolloutFile
  /** With `base`: the prefix was read to its end, its file ended before (`history_base_partial`), or is gone. */
  readonly base?: "complete" | "partial" | "missing"
}

/**
 * Parses a thread's rollout (streamed, 09 §2.8). Every turn stays in memory, so past `maxBytes` of decoded content the
 * parse stops and is `too_large` (IG4).
 */
export async function transcript(root: Paths.Root, file: RolloutFile, input: ReadInput = {}): Promise<Result<Read>> {
  const max = input.maxLine ?? LINE_MAX
  const meta = await head(root, file)
  if (!meta.ok) return meta
  const run = CodexTranscript.parser({
    rootID: root.rootID,
    path: file.path,
    bytes: file.size,
    mtimeMs: file.mtimeMs,
    now: input.now ?? Date.now(),
    head: meta.value,
    title: input.title,
  })
  const base = input.base && meta.value.base ? await prefix(root, meta.value.base, input.files, run, max) : undefined
  const room = (input.maxBytes ?? Paths.PARSE_BYTES) - (base?.bytes ?? 0)
  return again<Read>(root, file, async (target) => {
    const over = { value: false }
    const read = await decoded(root, target.path, target.zst, undefined, (chunks) =>
      eachLine(chunks, max, (line) => {
        over.value = line.offset + line.text.length > room
        if (over.value) return false
        run.push(line.text, { line: line.line, torn: line.torn })
        return input.visit?.(run, line)
      }),
    )
    if (!read.ok) return read
    if (over.value) return { ok: false, reason: "too_large" }
    run.drop("oversizedLine", read.value.oversized)
    const info = run.info()
    return {
      ok: true,
      value: {
        info: { ...info, source: { ...info.source, path: target.path, bytes: target.size } },
        file: target,
        ...(base === undefined ? {} : { base: base.state }),
      },
    }
  })
}

/**
 * Reads the `history_base` prefix into the parser, up to its end (09 §2.5): bounded, never past `end_byte_offset`.
 * `bytes` is what it read, which counts against the parse's `maxBytes`.
 */
async function prefix(
  root: Paths.Root,
  base: NonNullable<CodexTranscript.Head["base"]>,
  known: ReadonlyArray<RolloutFile> | undefined,
  run: CodexTranscript.Parser,
  max: number,
): Promise<{ readonly state: "complete" | "partial" | "missing"; readonly bytes: number }> {
  const candidates = (known ?? (await files(root))).filter((file) => file.rolloutID === base.rolloutID)
  if (candidates.length === 0) return { state: "missing", bytes: 0 }
  const file = preferred(candidates)
  const read = await decoded(root, file.path, file.zst, base.endByteOffset, (chunks) =>
    eachLine(chunks, max, (line) => run.push(line.text, { line: line.line, base: true, torn: line.torn })),
  )
  if (!read.ok) return { state: "missing", bytes: 0 }
  run.drop("oversizedLine", read.value.oversized)
  const partial = base.endByteOffset !== undefined && read.value.bytes < base.endByteOffset
  return { state: partial ? "partial" : "complete", bytes: read.value.bytes }
}

/** Runs `use` on the file; when it vanished (Codex compressed or restored it meanwhile), looks it up once more. */
async function again<T>(root: Paths.Root, file: RolloutFile, use: (file: RolloutFile) => Promise<Result<T>>) {
  const first = await use(file)
  if (first.ok || first.reason !== "missing") return first
  const moved = await resolve(root, file.path)
  if (moved === undefined || moved.path === file.path) return first
  return use(moved)
}

/**
 * The decoded content of a file in chunks: a plain file from its handle (up to `end`), a `.zst` through a streaming
 * zstd decoder (stopped at `end` decoded bytes). Nothing is written to disk; the handle is closed before this
 * resolves. A zstd error is `decode_failed`.
 */
async function decoded<T>(
  root: Paths.Root,
  file: string,
  zst: boolean,
  end: number | undefined,
  use: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
): Promise<Result<T>> {
  return Paths.withFile(root, file, "read", async (handle) => {
    if (!zst) return use(Paths.chunks(handle, { end }))
    const source = Readable.from(Paths.chunks(handle))
    const decoder = pipeline(source, zlib.createZstdDecompress(), () => undefined)
    return use(bounded(decoder, end)).finally(async () => {
      decoder.destroy()
      // The handle closes after this resolves: wait until the source stopped reading from it.
      await finished(source).catch(() => undefined)
    })
  }).catch((): Result<T> => ({ ok: false, reason: "decode_failed" }))
}

async function* bounded(chunks: AsyncIterable<Uint8Array>, end: number | undefined): AsyncGenerator<Uint8Array> {
  if (end === undefined) return yield* chunks
  const read = { total: 0 }
  for await (const chunk of chunks) {
    if (read.total + chunk.length >= end) return yield chunk.subarray(0, end - read.total)
    read.total += chunk.length
    yield chunk
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}

export interface Line {
  readonly text: string
  /** 0-based line number in the file. */
  readonly line: number
  /** Byte offset of the line's start in the decoded content. */
  readonly offset: number
  /** The file ended inside this line. */
  readonly torn?: boolean
}

/**
 * Splits decoded chunks into lines without holding more than one line (09 §2.8): a line longer than `max` bytes is
 * skipped (counted in `oversized`); the rest after the last newline is handed over as `torn`. `visit` returning
 * `false` stops the read.
 */
export async function eachLine(
  chunks: AsyncIterable<Uint8Array>,
  max: number,
  visit: (line: Line) => boolean | void,
): Promise<{ readonly oversized: number; readonly bytes: number; readonly stopped: boolean }> {
  const state = {
    pending: [] as Uint8Array[],
    length: 0,
    skipping: false,
    line: 0,
    start: 0,
    position: 0,
    oversized: 0,
  }
  const take = (piece: Uint8Array) => {
    if (state.skipping) return
    if (state.length + piece.length > max) {
      state.skipping = true
      state.oversized += 1
      state.pending = []
      state.length = 0
      return
    }
    state.pending.push(piece)
    state.length += piece.length
  }
  const emit = (torn: boolean) => {
    const skipped = state.skipping
    const text = Buffer.concat(state.pending).toString("utf8").replace(/\r$/, "")
    const line = { text, line: state.line, offset: state.start, torn: torn || undefined }
    state.pending = []
    state.length = 0
    state.skipping = false
    state.line += 1
    if (skipped || text.trim() === "") return true
    return visit(line) !== false
  }
  for await (const chunk of chunks) {
    const cursor = { from: 0 }
    for (const at of newlines(chunk)) {
      take(chunk.subarray(cursor.from, at))
      const go = emit(false)
      state.start = state.position + at + 1
      cursor.from = at + 1
      if (!go) return { oversized: state.oversized, bytes: state.start, stopped: true }
    }
    take(chunk.subarray(cursor.from))
    state.position += chunk.length
  }
  if (state.length > 0 || state.skipping) emit(true)
  return { oversized: state.oversized, bytes: state.position, stopped: false }
}

function* newlines(chunk: Uint8Array) {
  for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) yield at
}

/** Runs at most `size` tasks at once: the file scan reads one 64 KiB head per thread, not thousands together. */
function limiter(size: number) {
  const state = { active: 0, queue: [] as Array<() => void> }
  const next = () => {
    if (state.active >= size) return
    const run = state.queue.shift()
    if (run === undefined) return
    state.active += 1
    run()
  }
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      state.queue.push(() =>
        task()
          .then(resolve, reject)
          .finally(() => {
            state.active -= 1
            next()
          }),
      )
      next()
    })
}

/** Head reads at once during discovery. */
const HEAD_READS = 16

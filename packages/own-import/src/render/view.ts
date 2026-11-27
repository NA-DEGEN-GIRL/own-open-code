export * as View from "./view.js"

import { createHash } from "node:crypto"
import { Readable, pipeline } from "node:stream"
import { finished } from "node:stream/promises"
import zlib from "node:zlib"
import { Base64 } from "@opencode/schema/prompt"
import { NonNegativeInt } from "@opencode/schema/schema"
import type { SessionMessage } from "@opencode/schema/session-message"
import { OwnImport } from "@own/protocol/rpc-import"
import { Token } from "@own/protocol/token"
import { Option, Schema } from "effect"
import { ClaudeSource } from "../sources/claude.js"
import { CodexStore } from "../sources/codex.js"
import { Paths } from "../sources/paths.js"
import { ClaudeTranscript } from "../transcript/claude.js"
import { CodexTranscript } from "../transcript/codex.js"
import { Transcript } from "../transcript/ir.js"

/**
 * The read-only view of another tool's conversation (09 §3, §2.8): pages of turns as `SessionMessage.Info` in their
 * encoded (JSON) form, which `sessions.read` decodes once and own-web feeds to the production timeline. Nothing here
 * creates a session, calls a model or writes a file: decoded content lives only in memory.
 *
 * - **Messages** ({@link render}): per turn a `user` message, `assistant` messages (text, readable reasoning summaries
 *   as `reasoning`, tool calls as `tool` parts under the v2 renderer's name when the input fits it, else the original
 *   name for `GenericTool`; diffs from Codex FileChange and Claude `structuredPatch` as the parts' `metadata.files`),
 *   one-line notes as `synthetic` notices, the tool's compactions as completed `compaction` messages at their mid-turn
 *   place, and `idle` at the end of every finished turn. {@link VIEW_KEY} metadata ties each message to its turn.
 * - **Outline** (`OwnImport.Outline`): the turn list, checkpoint places, children, rolled-back and other-branch counts
 *   and the token estimate (`Token.estimate`, the P-016 rule), built by the first full read.
 * - **Codex** rollouts are read as a stream, one turn at a time ({@link walker}): a parser per turn, so memory holds one
 *   turn plus the outline, never the whole conversation. The byte offset where each turn starts (in the decoded
 *   content) is kept in memory: a `.jsonl` page is read again from its offset with the file reopened, a `.zst` page
 *   (zstd cannot start mid-stream) is decoded from the start again with the lines before the offset skipped unparsed.
 *   The first page is answered as soon as it is decoded while the outline keeps streaming until `outlineComplete`.
 * - **Claude Code** conversations are a `parentUuid` DAG, so the whole file is parsed (`ClaudeSource.transcript`) and
 *   paged; a `<persisted-output>` preview is replaced by its `tool-results` file when a page is shown (09 §2.6).
 * - **Memory**: decoded turns are kept in one LRU of {@link LRU_BYTES} (their JSON size). Turns a read asked for are
 *   hot; turns the outline pass decoded on the way are cold and leave first, oldest first, so after a pass the first
 *   page and the newest turns stay. Every read is cancellable (`AbortSignal`); a cancelled outline pass resumes from
 *   the last turn it finished.
 */

/** Decoded turns kept in memory across conversations (09 §2.8 ⚠IG5), measured as the UTF-8 size of their JSON. */
export const LRU_BYTES = 64 * 1024 * 1024
/** Turns per page when `count` is not given (09 §5.2 `sessions.read`). */
export const PAGE_TURNS = 20
/** Conversations whose outline and offsets the viewer keeps; the least recently read idle one goes first. */
export const ENTRIES = 32
/** The most of a Claude Code `tool-results` file a page shows in place of its `<persisted-output>` preview. */
export const TOOL_RESULT_VIEW = 1024 * 1024
/** Message metadata key holding the message's {@link Place}. */
export const VIEW_KEY = "own.import.view"
/** Display provider ids, the same an imported session's assistant messages carry (09 §4.2, Q1). */
export const PROVIDER: Readonly<Record<Transcript.Kind, string>> = { codex: "codex-cli", "claude-code": "claude-code" }
/** The agent the view's assistant messages name. */
export const AGENT = "build"

export type Message = typeof SessionMessage.Info.Encoded
type User = typeof SessionMessage.User.Encoded
type Assistant = typeof SessionMessage.Assistant.Encoded
type Part = Assistant["content"][number]
type Tool = typeof SessionMessage.AssistantTool.Encoded
type Compaction = typeof SessionMessage.CompactionCompleted.Encoded

/**
 * Where a message sits in the source conversation (`metadata[VIEW_KEY]`): its 0-based turn; a compaction adds the step
 * it stands before, its kind and how many user requests its `recent` keeps (the `codex-remote` marker text); a queued
 * user prompt is marked.
 */
export interface Place {
  readonly turn: number
  readonly step?: number
  readonly kind?: OwnImport.CheckpointKind
  readonly requests?: number
  readonly queued?: true
}

/** A Codex thread to show: its current rollout as the index found it (stat'ed again on every read). */
export interface CodexTarget {
  readonly kind: "codex"
  readonly ref: OwnImport.SourceRef
  readonly root: Paths.Root
  readonly file: CodexStore.RolloutFile
}

/** A Claude Code conversation (or a sub-agent conversation) to show. */
export interface ClaudeTarget {
  readonly kind: "claude-code"
  readonly ref: OwnImport.SourceRef
  readonly root: Paths.Root
  readonly conversation: ClaudeSource.Conversation | ClaudeSource.Child
}

export type Target = CodexTarget | ClaudeTarget

/** Why a read gave nothing: the source's problem (09 §5.4 `source_unreadable`) or the caller's cancellation. */
export type Failure = OwnImport.Unreadable | "cancelled"

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Failure }

/** A `sessions.read` answer without `summary` (the index owns it). */
export interface Page {
  readonly outline: OwnImport.Outline
  /** `false` while the outline still streams (`읽는 중`). */
  readonly outlineComplete: boolean
  readonly messages: ReadonlyArray<Message>
  /** `from` of the next page; absent on the last. */
  readonly next?: number
}

export interface ReadInput {
  /** The first turn of the page (default 0). */
  readonly from?: number
  /** Turns per page (default {@link PAGE_TURNS}). */
  readonly count?: number
}

export interface WalkInput {
  /** The first turn handed to the visitor (default 0); a known offset is used to start there. */
  readonly from?: number
  readonly signal?: AbortSignal
  /** `Date.now()` after which the walk stops between lines (a search budget). */
  readonly until?: number
}

export interface Visitor {
  /** Each finished turn from `from` on, in order; `false` stops the walk. */
  readonly turn: (turn: Transcript.Turn) => boolean | void
  /** The tool rolled back: turns from `count` on are gone (a Codex `thread_rolled_back` later in the file). */
  readonly rollback?: (count: number) => void
}

export interface Walked {
  /** The walk reached the end of the conversation. */
  readonly complete: boolean
  /** The first turn not handed to the visitor: where a resumed walk starts. */
  readonly next: number
}

export type Viewer = ReturnType<typeof viewer>

/**
 * The process's viewer: outlines, offsets and the page LRU of every conversation it read. One per process (the
 * Worker), shared by `sessions.read` and `sessions.search`. `budget` and `entries` are for tests.
 */
export function viewer(options: { readonly budget?: number; readonly entries?: number } = {}) {
  const shared: Shared = {
    cache: cache(options.budget ?? LRU_BYTES),
    entries: new Map(),
    limit: options.entries ?? ENTRIES,
    counters: { lines: 0 },
  }
  return {
    /** A page of turns as view messages, with the outline as far as it is known. */
    read: (target: Target, input: ReadInput = {}, signal?: AbortSignal) => read(shared, target, input, signal),
    /** The finished turns of a conversation in order, for searching; nothing is cached. */
    walk: (target: Target, input: WalkInput, visitor: Visitor) => walk(shared, target, input, visitor),
    /** Stops the outline pass of a conversation (its viewer closed); the next read resumes it. */
    cancel: (ref: OwnImport.SourceRef) => shared.entries.get(key(ref))?.pass?.controller.abort(),
    /** LRU size and tiers, kept conversations, and JSONL lines parsed so far (perf and tests). */
    stats: () => ({ ...shared.cache.stats(), entries: shared.entries.size, lines: shared.counters.lines }),
    clear: () => {
      shared.entries.forEach((entry) => entry.pass?.controller.abort())
      shared.entries.clear()
      shared.cache.clear()
    },
  }
}

/** The key of a conversation: its kind, root and id (path-free tokens). */
export function key(ref: OwnImport.SourceRef) {
  return `${ref.kind}/${ref.rootID}/${ref.id}`
}

// ---------------------------------------------------------------------------------------------------------------
// Reading pages

interface Shared {
  readonly cache: Cache
  readonly entries: Map<string, Entry>
  readonly limit: number
  readonly counters: { lines: number }
}

/** What the viewer keeps of one conversation while its file stays the same. */
interface Entry {
  readonly key: string
  /** The LRU key prefix of this version of the file. */
  readonly slot: string
  /** The message id prefix (a hash of the ref). */
  readonly prefix: string
  readonly target: Target
  readonly stamp: Stamp
  head?: CodexTranscript.Head
  built: Built
  /** Codex: where each turn starts in the decoded content. */
  marks: Mark[]
  complete: boolean
  pass?: Pass
}

interface Stamp {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/** The outline while it is built. */
interface Built {
  turns: OwnImport.OutlineTurn[]
  tokens: number[]
  checkpoints: Transcript.Checkpoint[]
  children: OwnImport.OutlineChild[]
  rolledBack: number
  branches: number
  unknownRecords: number
  base?: OwnImport.SourceRef
}

/** The outline pass: one per conversation at a time; reads that need turns it has not reached wait on it. */
interface Pass {
  readonly controller: AbortController
  readonly waiters: Set<Waiter>
  /** A read was answered from it: a later cancelled read no longer stops it (the outline keeps streaming). */
  answered: boolean
}

interface Waiter {
  readonly from: number
  readonly to: number
  readonly turns: Map<number, ReadonlyArray<Message>>
  readonly settle: (result: Result<void>) => void
}

const generations = { next: 0 }

async function read(shared: Shared, target: Target, input: ReadInput, signal?: AbortSignal): Promise<Result<Page>> {
  const from = input.from ?? 0
  const to = from + (input.count ?? PAGE_TURNS)
  const opened = await open(shared, target)
  if (!opened.ok) return opened
  const entry = opened.value
  const turns = await collect(shared, entry, from, to, signal)
  if (!turns.ok) return turns
  const messages = turns.value.flat()
  const end = from + turns.value.length
  const last = turns.value.length < to - from || (entry.complete && end >= entry.built.turns.length)
  return {
    ok: true,
    value: {
      outline: outline(entry),
      outlineComplete: entry.complete,
      messages: entry.target.kind === "claude-code" ? await expand(entry.target, messages) : messages,
      ...(last ? {} : { next: end }),
    },
  }
}

/**
 * The entry of a conversation, stat'ed again: a file that changed (size, mtime or a Codex file found again under its
 * other name) starts over, unless its outline pass is still streaming.
 */
async function open(shared: Shared, target: Target): Promise<Result<Entry>> {
  const located = await locate(target)
  if (!located.ok) return located
  const name = key(target.ref)
  const known = shared.entries.get(name)
  if (known !== undefined && (same(known.stamp, located.value.stamp) || known.pass !== undefined)) {
    shared.entries.delete(name)
    shared.entries.set(name, known)
    return { ok: true, value: known }
  }
  if (known !== undefined) forget(shared, known)
  const entry: Entry = {
    key: name,
    slot: `${name}|${generations.next++}`,
    prefix: prefix(target.ref),
    target: located.value.target,
    stamp: located.value.stamp,
    built: empty(),
    marks: [],
    complete: false,
  }
  shared.entries.set(name, entry)
  const idle = [...shared.entries.values()].filter((item) => item !== entry && item.pass === undefined)
  idle.slice(0, Math.max(0, shared.entries.size - shared.limit)).forEach((item) => forget(shared, item))
  return { ok: true, value: entry }
}

async function locate(target: Target): Promise<Result<{ readonly target: Target; readonly stamp: Stamp }>> {
  const file = target.kind === "codex" ? target.file.path : target.conversation.path
  const stat = await Paths.stat(target.root, file)
  if (stat.ok) return { ok: true, value: { target, stamp: { path: file, ...sizeOf(stat.value) } } }
  if (target.kind !== "codex" || stat.reason !== "missing") return stat
  // Codex compressed or restored the rollout meanwhile (09 §2.5): its other name.
  const moved = await CodexStore.resolve(target.root, file)
  if (moved === undefined) return stat
  return { ok: true, value: { target: { ...target, file: moved }, stamp: { path: moved.path, ...sizeOf(moved) } } }
}

function forget(shared: Shared, entry: Entry) {
  entry.pass?.controller.abort()
  if (shared.entries.get(entry.key) === entry) shared.entries.delete(entry.key)
  shared.cache.drop(entry.slot, 0)
}

/** The page's turns: from the LRU, from the running outline pass, or read again. */
async function collect(
  shared: Shared,
  entry: Entry,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
): Promise<Result<ReadonlyArray<ReadonlyArray<Message>>>> {
  const known = entry.built.turns.length
  const cached = range(from, Math.min(to, known)).map((turn) => shared.cache.get(slot(entry, turn)))
  const hits = cached.filter((messages) => messages !== undefined)
  const all = hits.length === cached.length
  if (all && (entry.complete || to <= known)) return { ok: true, value: hits }
  if (entry.target.kind === "claude-code" || (all && !entry.complete)) {
    const known = cached.flatMap((messages, index) =>
      messages === undefined ? [] : [[from + index, messages] as const],
    )
    return wait(shared, entry, from, to, signal, new Map(known))
  }
  return reread(shared, entry, entry.target, from, to, signal)
}

/** Waits for the outline pass (started or resumed here) to decode the page. */
function wait(
  shared: Shared,
  entry: Entry,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
  turns: Map<number, ReadonlyArray<Message>>,
): Promise<Result<ReadonlyArray<ReadonlyArray<Message>>>> {
  const pass = ensure(shared, entry)
  return new Promise((resolve) => {
    const state = { settled: false }
    const waiter: Waiter = {
      from,
      to,
      turns,
      settle: (result) => {
        if (state.settled) return
        state.settled = true
        pass.waiters.delete(waiter)
        signal?.removeEventListener("abort", abort)
        if (!result.ok) return resolve(result)
        pass.answered = true
        const list = ordered(waiter)
        // Turns a read asked for become hot.
        list.forEach((_, index) => shared.cache.get(slot(entry, from + index)))
        resolve({ ok: true, value: list })
      },
    }
    const abort = () => {
      waiter.settle({ ok: false, reason: "cancelled" })
      if (pass.waiters.size === 0 && !pass.answered) pass.controller.abort()
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener("abort", abort, { once: true })
    pass.waiters.add(waiter)
    if (full(waiter)) waiter.settle({ ok: true, value: undefined })
  })
}

function ensure(shared: Shared, entry: Entry): Pass {
  if (entry.pass !== undefined) return entry.pass
  const pass: Pass = { controller: new AbortController(), waiters: new Set(), answered: false }
  entry.pass = pass
  const run =
    entry.target.kind === "codex"
      ? codexPass(shared, entry, entry.target, pass)
      : claudePass(shared, entry, entry.target, pass)
  void run
    .catch((): Result<void> => ({ ok: false, reason: "decode_failed" }))
    .then((result) => {
      entry.pass = undefined
      if (result.ok) entry.complete = true
      ;[...pass.waiters].forEach((waiter) => waiter.settle(result))
    })
  return pass
}

function deliver(pass: Pass, turn: number, messages: ReadonlyArray<Message>) {
  pass.waiters.forEach((waiter) => {
    if (turn < waiter.from || turn >= waiter.to) return
    waiter.turns.set(turn, messages)
    if (full(waiter)) waiter.settle({ ok: true, value: undefined })
  })
}

function full(waiter: Waiter) {
  return range(waiter.from, waiter.to).every((turn) => waiter.turns.has(turn))
}

/** The waiter's turns from `from` up to the first one it does not have. */
function ordered(waiter: Waiter) {
  const list = range(waiter.from, waiter.to).map((turn) => waiter.turns.get(turn))
  const gap = list.indexOf(undefined)
  return (gap === -1 ? list : list.slice(0, gap)).filter((messages) => messages !== undefined)
}

/**
 * The outline pass of a Codex rollout: every turn is decoded, added to the outline, rendered into the LRU (cold) and
 * handed to waiting reads. A pass stopped earlier resumes at the turn it was decoding.
 */
async function codexPass(shared: Shared, entry: Entry, target: CodexTarget, pass: Pass): Promise<Result<void>> {
  const head = await headOf(entry, target)
  if (!head.ok) return head
  const base = head.value.base === undefined ? undefined : ref(target, head.value.base.rolloutID)
  if (base !== undefined) entry.built.base = base
  const resume = entry.built.turns.length
  const mark = resume > 0 ? entry.marks[resume] : undefined
  if (resume > 0 && mark === undefined) {
    entry.built = { ...empty(), ...(base === undefined ? {} : { base }) }
    entry.marks = []
  }
  const from = mark === undefined ? { index: 0, keys: [] } : origin(entry, resume)
  const before = { rolledBack: entry.built.rolledBack, unknownRecords: entry.built.unknownRecords }
  const context = { ref: target.ref, prefix: entry.prefix }
  const walk = walker(start(target, head.value), from, {
    open: (turn, at) => {
      entry.marks[turn] = at
    },
    turn: (harvest) => {
      const built = entry.built
      built.turns[harvest.index] = outlineTurn(harvest.turn)
      built.tokens[harvest.index] = tokens(harvest.turn)
      built.checkpoints.push(...harvest.checkpoints)
      harvest.children.forEach((child) => adopt(built, target, child))
      built.rolledBack = before.rolledBack + harvest.rolledBack
      built.unknownRecords = before.unknownRecords + harvest.unknownRecords
      const messages = render(context, harvest.turn, harvest.checkpoints)
      shared.cache.put(slot(entry, harvest.index), messages, "cold")
      deliver(pass, harvest.index, messages)
    },
    rollback: (count, rolledBack) => {
      const built = entry.built
      built.turns.length = Math.min(built.turns.length, count)
      built.tokens.length = Math.min(built.tokens.length, count)
      entry.marks.length = Math.min(entry.marks.length, count)
      built.checkpoints = built.checkpoints.filter((checkpoint) => checkpoint.at.turn < count)
      built.children = built.children.map((child) =>
        child.turn !== undefined && child.turn >= count ? omitTurn(child) : child,
      )
      built.rolledBack = before.rolledBack + rolledBack
      shared.cache.drop(entry.slot, count)
      pass.waiters.forEach((waiter) =>
        [...waiter.turns.keys()].filter((turn) => turn >= count).forEach((turn) => waiter.turns.delete(turn)),
      )
    },
  })
  const streamed = await stream(shared, target, { start: from.mark, signal: pass.controller.signal }, (line) => {
    walk.push(line)
    return true
  })
  if (!streamed.ok) return streamed
  if (streamed.value.stopped) return { ok: false, reason: "cancelled" }
  const rest = walk.end()
  entry.built.checkpoints.push(...rest.checkpoints)
  rest.children.forEach((child) => adopt(entry.built, target, child))
  entry.built.unknownRecords = before.unknownRecords + rest.unknownRecords
  return { ok: true, value: undefined }
}

/** The outline pass of a Claude Code conversation: the whole file is parsed (its records form a DAG), then paged. */
async function claudePass(shared: Shared, entry: Entry, target: ClaudeTarget, pass: Pass): Promise<Result<void>> {
  const parsed = await abortable(ClaudeSource.transcript(target.root, target.conversation), pass.controller.signal)
  if (parsed === undefined) return { ok: false, reason: "cancelled" }
  if (!parsed.ok) return parsed
  const info = parsed.value
  entry.built = {
    turns: info.turns.map(outlineTurn),
    tokens: info.turns.map(tokens),
    checkpoints: [...info.checkpoints],
    children: [],
    rolledBack: info.dropped.rolledBack ?? 0,
    branches: info.dropped.abandonedBranch ?? 0,
    unknownRecords: info.dropped.unknownRecord ?? 0,
  }
  info.children.forEach((child) => adopt(entry.built, target, child))
  const context = { ref: target.ref, prefix: entry.prefix, model: info.source.models.at(-1)?.id }
  info.turns.forEach((turn) => {
    const messages = render(
      context,
      turn,
      info.checkpoints.filter((checkpoint) => checkpoint.at.turn === turn.index),
    )
    shared.cache.put(slot(entry, turn.index), messages, "cold")
    deliver(pass, turn.index, messages)
  })
  return { ok: true, value: undefined }
}

/**
 * A Codex page read again (09 §2.8): from the offset of its first turn up to the offset of the turn after it, a
 * `.jsonl` file reopened at that offset, a `.zst` decoded from the start with the earlier lines skipped unparsed.
 */
async function reread(
  shared: Shared,
  entry: Entry,
  target: CodexTarget,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
): Promise<Result<ReadonlyArray<ReadonlyArray<Message>>>> {
  const head = await headOf(entry, target)
  if (!head.ok) return head
  const at = origin(entry, from)
  // Where the turn after the page opens. Unknown for the last page of a complete outline (read to the end) and
  // beyond a pass still running (until the page's last turn is finished).
  const stop = entry.marks[to]?.offset
  const running = !entry.complete
  const context = { ref: target.ref, prefix: entry.prefix }
  const turns = new Map<number, ReadonlyArray<Message>>()
  const walk = walker(start(target, head.value), at, {
    turn: (harvest) => {
      if (harvest.index >= from && harvest.index < to)
        turns.set(harvest.index, render(context, harvest.turn, harvest.checkpoints))
    },
    rollback: (count) => [...turns.keys()].filter((turn) => turn >= count).forEach((turn) => turns.delete(turn)),
  })
  const streamed = await stream(shared, target, { start: at.mark, signal }, (line) => {
    walk.push(line)
    // The line that opens the turn after the page finishes the page's last turn.
    return stop === undefined ? !(running && turns.has(to - 1)) : line.offset < stop
  })
  if (!streamed.ok) return streamed
  if (signal?.aborted) return { ok: false, reason: "cancelled" }
  if (!streamed.value.stopped) walk.end()
  const list = range(from, to).map((turn) => turns.get(turn))
  const gap = list.indexOf(undefined)
  const value = (gap === -1 ? list : list.slice(0, gap)).filter((messages) => messages !== undefined)
  value.forEach((messages, index) => shared.cache.put(slot(entry, from + index), messages, "hot"))
  return { ok: true, value }
}

async function walk(shared: Shared, target: Target, input: WalkInput, visitor: Visitor): Promise<Result<Walked>> {
  const from = input.from ?? 0
  const opened = await open(shared, target)
  if (!opened.ok) return opened
  const entry = opened.value
  const located = entry.target
  if (located.kind === "claude-code") {
    const parsed = await abortable(ClaudeSource.transcript(located.root, located.conversation), input.signal)
    if (parsed === undefined) return { ok: false, reason: "cancelled" }
    if (!parsed.ok) return parsed
    const turns = parsed.value.turns.slice(from)
    const stopped = turns.findIndex((turn) => visitor.turn(turn) === false)
    return {
      ok: true,
      value:
        stopped === -1 ? { complete: true, next: from + turns.length } : { complete: false, next: from + stopped + 1 },
    }
  }
  const head = await headOf(entry, located)
  if (!head.ok) return head
  const at = origin(entry, from)
  const state = { stop: false, next: from }
  const run = walker(start(located, head.value), at, {
    turn: (harvest) => {
      if (harvest.index < from || state.stop) return
      state.next = harvest.index + 1
      if (visitor.turn(harvest.turn) === false) state.stop = true
    },
    rollback: (count) => {
      state.next = Math.min(state.next, Math.max(from, count))
      visitor.rollback?.(count)
    },
  })
  const streamed = await stream(shared, located, { start: at.mark, signal: input.signal }, (line) => {
    run.push(line)
    return !state.stop && (input.until === undefined || Date.now() <= input.until)
  })
  if (!streamed.ok) return streamed
  if (input.signal?.aborted) return { ok: false, reason: "cancelled" }
  if (streamed.value.stopped) return { ok: true, value: { complete: false, next: state.next } }
  run.end()
  return { ok: true, value: { complete: true, next: state.next } }
}

async function headOf(entry: Entry, target: CodexTarget): Promise<Result<CodexTranscript.Head>> {
  if (entry.head !== undefined) return { ok: true, value: entry.head }
  const read = await CodexStore.head(target.root, target.file)
  if (read.ok) entry.head = read.value
  return read
}

/** Where a walk to turn `index` starts: at that turn when the outline knows where it is, else at the beginning. */
function origin(entry: Entry, index: number): Origin {
  const mark = entry.marks[index]
  if (mark === undefined) return { index: 0, keys: [] }
  return { index, mark, keys: entry.marks.slice(0, index).map((item) => item.key) }
}

function start(target: CodexTarget, head: CodexTranscript.Head): CodexTranscript.Start {
  return {
    rootID: target.root.rootID,
    path: target.file.path,
    bytes: target.file.size,
    mtimeMs: target.file.mtimeMs,
    now: Date.now(),
    head,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Codex: a rollout as a stream of turns

/** Where a turn starts in the decoded content, and the parser state a reread needs to start there. */
interface Mark {
  readonly offset: number
  /** Its 0-based line number in the file (`ordinal` fallback, sub-agent start). */
  readonly line: number
  /** The model in effect before it: its text steps without a model of their own were written by this one. */
  readonly model?: string
  /** The last (repaired) time before it, `NaN` before the first turn. */
  readonly before: number
  /** Codex's turn id in effect before it (`task_started`, `turn_context`). */
  readonly codex?: string
  /** Its rollback key: Codex's turn id, else `#<turn>` (the parser's rule). */
  readonly key: string
}

interface Harvest {
  readonly index: number
  readonly turn: Transcript.Turn
  /** The checkpoints inside the turn. */
  readonly checkpoints: ReadonlyArray<Transcript.Checkpoint>
  /** Sub-agent conversations first seen in the turn. */
  readonly children: ReadonlyArray<Transcript.ChildRef>
  /** Turns rolled back so far in this walk. */
  readonly rolledBack: number
  /** Records of an unknown kind so far in this walk. */
  readonly unknownRecords: number
}

interface Handlers {
  readonly open?: (turn: number, mark: Mark) => void
  readonly turn: (harvest: Harvest) => void
  readonly rollback?: (count: number, rolledBack: number) => void
}

/** Where a walk starts: turn `index` at its mark, with the rollback keys of the turns before it. */
interface Origin {
  readonly index: number
  readonly mark?: Mark
  readonly keys: ReadonlyArray<string>
}

/** The record kinds the walker reads itself show their type in the first characters of their line. */
const HEAD = 256
const ROLLBACK = '"type":"thread_rolled_back"'
const TURN_STARTS = ['"type":"task_started"', '"type":"turn_started"', '"type":"turn_context"']
const Maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))
const decodeRolledBack = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("event_msg"),
      payload: Schema.Struct({ type: Schema.Literal("thread_rolled_back"), num_turns: NonNegativeInt }),
    }),
  ),
)
const decodeTurnStart = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("event_msg"),
        payload: Schema.Struct({
          type: Schema.Literals(["task_started", "turn_started"]),
          turn_id: Maybe(Schema.String),
        }),
      }),
      Schema.Struct({
        type: Schema.Literal("turn_context"),
        payload: Schema.Struct({ turn_id: Maybe(Schema.String) }),
      }),
    ]),
  ),
)
const decodeOpening = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("response_item"),
      payload: Schema.Struct({
        type: Schema.Literal("message"),
        role: Schema.Literal("user"),
        internal_chat_message_metadata_passthrough: Maybe(Schema.Struct({ turn_id: Maybe(Schema.String) })),
      }),
    }),
  ),
)

/**
 * Splits a rollout into turns with one {@link CodexTranscript.parser} per turn (the "window"), so a turn is handed on
 * and dropped once the next one opens. The line that opens a turn goes into both windows: it finishes the old turn
 * (`completed`) and opens the new one. Across windows this keeps what one parser would carry: the model in effect
 * (for text steps without their own), monotonic times, children seen once, and rollbacks. A rollback removes the
 * newest N of Codex's turns by turn id, as the parser does, so the walker follows Codex's turn ids itself (decoding
 * only the turn-start records and the line that opens a turn). Checkpoints and children get absolute turn numbers.
 */
function walker(begin: CodexTranscript.Start, from: Origin, on: Handlers) {
  const state = {
    window: CodexTranscript.parser(begin),
    /** The turn number of the window's turn. */
    index: from.index,
    /** The model in effect when the window started. */
    model: from.mark?.model,
    last: from.mark?.before ?? Number.NaN,
    codex: from.mark?.codex,
    /** The rollback key of every turn opened so far, the window's included. */
    keys: Array.from({ length: from.index }, (_, index) => from.keys[index] ?? `#${index}`),
    unknown: 0,
    rolledBack: 0,
    /** Last time and step count of each turn this walk finished, from `from.index` on. */
    done: [] as Array<{ readonly last: number; readonly steps: number }>,
    children: new Set<string>(),
  }

  function push(line: CodexStore.Line) {
    const before = state.window.turns()
    state.window.push(line.text, { line: line.line, ...(line.torn ? { torn: true } : {}) })
    const after = state.window.turns()
    const head = line.text.slice(0, HEAD)
    if (TURN_STARTS.some((tag) => head.includes(tag))) track(line.text)
    const rolled = head.includes(ROLLBACK) ? Option.getOrUndefined(decodeRolledBack(line.text)) : undefined
    if (rolled !== undefined) return rollback(rolled.payload.num_turns)
    if (before === 0 && after === 1) return open(line, state.window.info().source.models.at(-1)?.id ?? state.model)
    if (after === 2) next(line)
  }

  /** Codex's current turn id, as the parser follows it. */
  function track(text: string) {
    const start = Option.getOrUndefined(decodeTurnStart(text))
    if (start === undefined) return
    if (start.type === "event_msg") {
      state.codex = start.payload.turn_id ?? undefined
      return
    }
    if (start.payload.turn_id) state.codex = start.payload.turn_id
  }

  function open(line: CodexStore.Line, model: string | undefined) {
    const opening = Option.getOrUndefined(decodeOpening(line.text))
    const codex =
      opening === undefined
        ? undefined
        : (opening.payload.internal_chat_message_metadata_passthrough?.turn_id ?? state.codex)
    const key = codex ?? `#${state.index}`
    state.keys[state.index] = key
    on.open?.(state.index, {
      offset: line.offset,
      line: line.line,
      ...(model === undefined ? {} : { model }),
      before: state.last,
      ...(state.codex === undefined ? {} : { codex: state.codex }),
      key,
    })
  }

  /** The window's turn is finished: hand it on and start a window with the line that opened the next one. */
  function next(line: CodexStore.Line) {
    const info = state.window.info()
    emit(info)
    const model = info.source.models.at(-1)?.id ?? state.model
    state.unknown += info.dropped.unknownRecord ?? 0
    state.window = CodexTranscript.parser(begin)
    state.window.push(line.text, { line: line.line, ...(line.torn ? { torn: true } : {}) })
    state.model = model
    state.index += 1
    open(line, model)
  }

  function emit(info: Transcript.Info) {
    const raw = info.turns[0]
    const turn = continued(
      {
        ...raw,
        index: state.index,
        steps: raw.steps.map((step) =>
          step.type === "text" && step.model === undefined && state.model !== undefined
            ? { ...step, model: state.model }
            : step,
        ),
      },
      state.last,
    )
    const children = info.children
      .filter((child) => !state.children.has(child.id))
      .map((child) => (child.at === undefined ? child : { ...child, at: { ...child.at, turn: state.index } }))
    children.forEach((child) => state.children.add(child.id))
    state.last = turn.steps.at(-1)?.time ?? turn.time
    state.done[state.index - from.index] = { last: state.last, steps: turn.steps.length }
    on.turn({
      index: state.index,
      turn,
      checkpoints: info.checkpoints
        .filter((checkpoint) => checkpoint.at.turn === 0)
        .map((checkpoint) => ({ ...checkpoint, at: { ...checkpoint.at, turn: state.index } })),
      children,
      rolledBack: state.rolledBack,
      unknownRecords: state.unknown + (info.dropped.unknownRecord ?? 0),
    })
  }

  /**
   * `thread_rolled_back{num_turns}`: the newest `count` turn ids leave, with every turn from the first one that has
   * one of them (the parser's rule). The window already dropped its own turn.
   */
  function rollback(count: number) {
    const removed = [...new Set(state.keys.toReversed())].slice(0, count)
    const keep = state.keys.findIndex((key) => removed.includes(key))
    if (keep === -1) return
    state.rolledBack += state.keys.length - keep
    state.keys.length = keep
    state.index = keep
    state.done.length = Math.max(0, keep - from.index)
    state.last = state.done.at(-1)?.last ?? from.mark?.before ?? Number.NaN
    on.rollback?.(keep, state.rolledBack)
  }

  /** The end of the file: the last turn (it may still be `open`) and what an empty window still holds. */
  function end() {
    const info = state.window.info()
    const unknownRecords = state.unknown + (info.dropped.unknownRecord ?? 0)
    if (info.turns.length > 0) {
      emit(info)
      return { checkpoints: [], children: [], unknownRecords }
    }
    // Only after a rollback emptied it (or in a file without turns): its compactions follow the last turn.
    const turn = Math.max(0, state.index - 1)
    const step = state.done[turn - from.index]?.steps ?? 0
    return {
      checkpoints: info.checkpoints.map((checkpoint) => ({ ...checkpoint, at: { ...checkpoint.at, turn, step } })),
      children: info.children.filter((child) => !state.children.has(child.id)),
      unknownRecords,
    }
  }

  return { push, end }
}

/** `turn`'s times made monotonic after `last` (the global rule of `Transcript.repairTimes`, across windows). */
function continued(turn: Transcript.Turn, last: number) {
  if (Number.isNaN(last)) return turn
  const anchor: Transcript.Turn = { index: 0, time: last, user: { text: "", images: [] }, steps: [], end: "completed" }
  return Transcript.repairTimes([anchor, turn], last)[1]
}

/**
 * The decoded lines of a rollout from `start` (its offset and line number), each handed to `visit` until it answers
 * `false` or `signal` aborts (`stopped`). A `.jsonl` file is opened at the offset; a `.zst` is decoded from the start
 * (zstd cannot start mid-stream) and the lines before the offset are skipped without parsing. Nothing is written
 * anywhere; the handle is closed before this resolves. A file Codex compressed or restored meanwhile is found once
 * more under its other name.
 */
async function stream(
  shared: Shared,
  target: CodexTarget,
  input: { readonly start?: Mark; readonly signal?: AbortSignal },
  visit: (line: CodexStore.Line) => boolean,
): Promise<Result<{ readonly stopped: boolean }>> {
  const counted = (line: CodexStore.Line) => {
    if (input.signal?.aborted) return false
    shared.counters.lines += 1
    return visit(line)
  }
  const first = await lines(target.root, target.file, input, counted)
  if (first.ok || first.reason !== "missing") return first
  const moved = await CodexStore.resolve(target.root, target.file.path)
  if (moved === undefined || moved.path === target.file.path) return first
  return lines(target.root, moved, input, counted)
}

async function lines(
  root: Paths.Root,
  file: CodexStore.RolloutFile,
  input: { readonly start?: Mark; readonly signal?: AbortSignal },
  visit: (line: CodexStore.Line) => boolean,
): Promise<Result<{ readonly stopped: boolean }>> {
  const start = input.start
  return Paths.withFile(root, file.path, "read", async (handle) => {
    if (!file.zst) {
      const offset = start?.offset ?? 0
      const line = start?.line ?? 0
      return CodexStore.eachLine(Paths.chunks(handle, { start: offset }), CodexStore.LINE_MAX, (item) =>
        visit({ ...item, line: item.line + line, offset: item.offset + offset }),
      )
    }
    const source = Readable.from(Paths.chunks(handle))
    const decoder = pipeline(source, zlib.createZstdDecompress(), () => undefined)
    return CodexStore.eachLine(decoder, CodexStore.LINE_MAX, (item) =>
      start !== undefined && item.offset < start.offset ? input.signal?.aborted !== true : visit(item),
    ).finally(async () => {
      decoder.destroy()
      // The handle closes after this resolves: wait until the source stopped reading from it.
      await finished(source).catch(() => undefined)
    })
  }).catch((): Result<{ readonly stopped: boolean }> => ({ ok: false, reason: "decode_failed" }))
}

// ---------------------------------------------------------------------------------------------------------------
// Messages

export interface Context {
  readonly ref: OwnImport.SourceRef
  /** The message and part id prefix; default a hash of `ref`. */
  readonly prefix?: string
  /** The model a text step without its own is shown with (default the next text step's, else `unknown`). */
  readonly model?: string
}

/**
 * One turn as view messages (09 §3): `user`, then `assistant` messages (a new one where the model changes, a note
 * or a compaction stands), `synthetic` notices for notes, completed `compaction` messages before the step they stand
 * before, and `idle` when the turn ended. Ids are deterministic: `msg_<prefix>_<turn>_<n>`, tool parts
 * `prt_<prefix>_<turn>_<step>`.
 */
export function render(
  context: Context,
  turn: Transcript.Turn,
  checkpoints: ReadonlyArray<Transcript.Checkpoint>,
): Message[] {
  const tag = context.prefix ?? prefix(context.ref)
  const out: Message[] = []
  const id = () => `msg_${tag}_${turn.index}_${out.length}`
  const place = { [VIEW_KEY]: { turn: turn.index } satisfies Place }
  const run = { parts: [] as Part[], model: "", created: 0, completed: 0 }
  // A step without a model belongs to the next text step's model (a tool call before the answer).
  const models = new Array<string>(turn.steps.length)
  turn.steps.reduceRight((model, step, index) => {
    models[index] = step.type === "text" && step.model !== undefined ? step.model : model
    return models[index]
  }, context.model ?? "unknown")

  const flush = () => {
    if (run.parts.length === 0) return
    const message: Assistant = {
      id: id(),
      type: "assistant",
      agent: AGENT,
      model: { id: run.model, providerID: PROVIDER[context.ref.kind] },
      content: run.parts,
      finish: run.parts.at(-1)?.type === "tool" ? "tool-calls" : "stop",
      time: { created: run.created, completed: run.completed },
      metadata: place,
    }
    out.push(message)
    run.parts = []
  }
  const add = (part: Part, time: number, model: string) => {
    if (run.parts.length > 0 && model !== run.model) flush()
    if (run.parts.length === 0) {
      run.model = model
      run.created = time
    }
    run.parts.push(part)
    run.completed = time
  }
  const compact = (checkpoint: Transcript.Checkpoint, step: number) => {
    flush()
    const message: Compaction = {
      id: id(),
      type: "compaction",
      status: "completed",
      reason: checkpoint.trigger === "manual" ? "manual" : "auto",
      summary: checkpoint.summary ?? "",
      time: { created: turn.steps[step - 1]?.time ?? turn.time },
      metadata: {
        // Where core reads a checkpoint's kept text since upstream v2.1 (`SessionRecentText`).
        recent: checkpoint.recent.map((line) => `${LINE[line.role]}: ${line.text}`).join("\n"),
        [VIEW_KEY]: {
          turn: turn.index,
          step,
          kind: checkpoint.kind,
          requests: checkpoint.recent.filter((line) => line.role === "user").length,
        } satisfies Place,
      },
    }
    out.push(message)
  }

  if (turn.user.text !== "" || turn.user.images.length > 0) out.push(user(id(), turn))
  turn.steps.forEach((step, index) => {
    checkpoints.filter((checkpoint) => checkpoint.at.step === index).forEach((checkpoint) => compact(checkpoint, index))
    if (step.type === "note") {
      flush()
      out.push({
        id: id(),
        type: "synthetic",
        text: step.text,
        description: step.text,
        time: { created: step.time },
        metadata: place,
      })
      return
    }
    if (step.type === "text") return add({ type: "text", text: step.text }, step.time, models[index])
    if (step.type === "reasoning-summary")
      return add({ type: "reasoning", text: step.text, time: { created: step.time } }, step.time, models[index])
    add(tool(context.ref, `prt_${tag}_${turn.index}_${index}`, step), step.time, models[index])
  })
  checkpoints
    .filter((checkpoint) => checkpoint.at.step >= turn.steps.length)
    .forEach((checkpoint) => compact(checkpoint, turn.steps.length))
  flush()
  if (turn.end !== "open")
    out.push({
      id: id(),
      type: "idle",
      outcome: OUTCOME[turn.end],
      time: { created: turn.steps.at(-1)?.time ?? turn.time },
      metadata: place,
    })
  return out
}

const LINE: Readonly<Record<Transcript.Line["role"], string>> = {
  user: "[User]",
  assistant: "[Assistant]",
  "tool-call": "[Assistant tool call]",
  "tool-result": "[Tool result]",
}

const OUTCOME: Readonly<Record<Exclude<Transcript.End, "open">, "succeeded" | "failed" | "interrupted">> = {
  completed: "succeeded",
  error: "failed",
  interrupted: "interrupted",
}

const isBase64 = Schema.is(Base64)

/** The human's message: images with their bytes as inline files, the others as `[image: …]` lines. */
function user(id: string, turn: Transcript.Turn): User {
  const images = turn.user.images
  const files = images.flatMap((image) =>
    image.data !== undefined && isBase64(image.data)
      ? [{ data: image.data, mime: image.mime, source: { type: "inline" as const } }]
      : [],
  )
  const missing = images.filter((image) => image.data === undefined || !isBase64(image.data))
  const text = [turn.user.text, ...missing.map(ClaudeTranscript.placeholder)].filter((part) => part !== "").join("\n")
  return {
    id,
    type: "user",
    text,
    ...(files.length > 0 ? { files } : {}),
    time: { created: turn.time },
    metadata: { [VIEW_KEY]: { turn: turn.index, ...(turn.user.queued ? { queued: true } : {}) } satisfies Place },
  }
}

/**
 * A tool call as a part: under the v2 renderer's name when its input fits ({@link renamed}), else its own name with
 * its input as it was (`GenericTool`). `metadata`: `original` (a renamed call's own name), `exit`, `files` (the
 * diff), `child` (the sub-agent conversation it started, a `SourceRef`), `truncatedFrom`.
 */
function tool(ref: OwnImport.SourceRef, id: string, step: Transcript.ToolStep): Tool {
  const mapped = renamed(step)
  const input = mapped?.input ?? fields(step.input)
  const metadata = {
    ...(mapped === undefined || mapped.name === step.name ? {} : { original: step.name }),
    ...(step.exit === undefined ? {} : { exit: step.exit }),
    ...(step.diff === undefined
      ? {}
      : {
          files: step.diff.map((diff) => ({
            file: diff.file,
            patch: diff.patch,
            additions: diff.additions,
            deletions: diff.deletions,
            status: diff.status,
          })),
        }),
    ...(step.child === undefined ? {} : { child: { kind: ref.kind, rootID: ref.rootID, id: step.child } }),
    ...(step.output?.truncatedFrom === undefined ? {} : { truncatedFrom: step.output.truncatedFrom }),
  }
  const extra = Object.keys(metadata).length > 0 ? { metadata } : {}
  const output = step.output
  return {
    type: "tool",
    id,
    name: mapped?.name ?? step.name,
    state:
      output === undefined || output.error
        ? {
            status: "error",
            input,
            error: { type: "tool", message: output?.text ?? CodexTranscript.INTERRUPTED },
            ...extra,
          }
        : { status: "completed", input, content: [{ type: "text", text: output.text }], ...extra },
    time: { created: step.time, completed: step.time },
  }
}

const isFields = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/** A JSON object input as it is; anything else (free text such as a patch body, a list) under `input`. */
function fields(input: unknown): Record<string, unknown> {
  return !Array.isArray(input) && isFields(input) ? input : { input }
}

// The original tools' input shapes, decoded once here; a call whose input does not fit keeps its own name.
const Command = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const decodeExec = Schema.decodeUnknownOption(Schema.Struct({ cmd: Command, workdir: Maybe(Schema.String) }))
const decodeShell = Schema.decodeUnknownOption(Schema.Struct({ command: Command, workdir: Maybe(Schema.String) }))
const decodeLocalShell = Schema.decodeUnknownOption(
  Schema.Struct({ command: Schema.Array(Schema.String), working_directory: Maybe(Schema.String) }),
)
const decodeFile = Schema.decodeUnknownOption(
  Schema.Struct({ file_path: Schema.String, offset: Maybe(Schema.Finite), limit: Maybe(Schema.Finite) }),
)
const decodeEdit = Schema.decodeUnknownOption(
  Schema.Struct({
    file_path: Schema.String,
    old_string: Schema.String,
    new_string: Schema.String,
    replace_all: Maybe(Schema.Boolean),
  }),
)
const decodeWrite = Schema.decodeUnknownOption(Schema.Struct({ file_path: Schema.String, content: Schema.String }))
const decodePatch = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Struct({ input: Schema.String })]))
const decodeSearch = Schema.decodeUnknownOption(
  Schema.Struct({
    pattern: Schema.String,
    path: Maybe(Schema.String),
    glob: Maybe(Schema.String),
    include: Maybe(Schema.String),
  }),
)
const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }))
const decodeDir = Schema.decodeUnknownOption(Schema.Struct({ dir_path: Schema.String }))
const decodeUrl = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }))
const decodeQuery = Schema.decodeUnknownOption(Schema.Struct({ query: Schema.String }))
const decodeWeb = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("search"), query: Schema.String }),
    Schema.Struct({ type: Schema.Literals(["open_page", "find_in_page"]), url: Schema.String }),
  ]),
)
const decodeAgent = Schema.decodeUnknownOption(
  Schema.Struct({ description: Schema.String, prompt: Schema.String, subagent_type: Maybe(Schema.String) }),
)

/** File types the `read` renderer would load as an image: those reads stay generic (the view opens no file). */
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i

interface Renamed {
  readonly name: string
  readonly input: Record<string, unknown>
}

/** The v2 renderer names (`session-ui` `ToolRegistry`) the original tools map to, by original name. */
const RENAMES: Readonly<Record<string, (step: Transcript.ToolStep) => Renamed | undefined>> = {
  // Codex
  exec_command: (step) => shaped(decodeExec(step.input), (value) => asShell(value.cmd, value.workdir)),
  shell: (step) => shaped(decodeShell(step.input), (value) => asShell(value.command, value.workdir)),
  shell_command: (step) => shaped(decodeShell(step.input), (value) => asShell(value.command, value.workdir)),
  local_shell: (step) =>
    shaped(decodeLocalShell(step.input), (value) => asShell(value.command, value.working_directory)),
  apply_patch: (step) =>
    shaped(decodePatch(step.input), (value) => ({
      name: "patch",
      input: { patchText: typeof value === "string" ? value : value.input },
    })),
  read_file: (step) => asRead(step),
  grep_files: (step) => asGrep(step),
  list_dir: (step) => shaped(decodeDir(step.input), (value) => ({ name: "list", input: { path: value.dir_path } })),
  web_search: (step) =>
    shaped(decodeWeb(step.input), (value) =>
      value.type === "search"
        ? { name: "websearch", input: { query: value.query } }
        : { name: "webfetch", input: { url: value.url } },
    ),
  // Claude Code
  Bash: (step) => shaped(decodeShell(step.input), (value) => asShell(value.command)),
  Read: (step) => asRead(step),
  Edit: (step) =>
    shaped(decodeEdit(step.input), (value) => ({
      name: "edit",
      input: {
        path: value.file_path,
        oldString: value.old_string,
        newString: value.new_string,
        ...(value.replace_all ? { replaceAll: true } : {}),
      },
    })),
  MultiEdit: (step) => (step.diff === undefined ? undefined : { name: "patch", input: {} }),
  Write: (step) =>
    shaped(decodeWrite(step.input), (value) => ({
      name: "write",
      input: { path: value.file_path, content: value.content },
    })),
  Grep: (step) => asGrep(step),
  Glob: (step) =>
    shaped(decodeSearch(step.input), (value) => ({
      name: "glob",
      input: { pattern: value.pattern, ...(value.path ? { path: value.path } : {}) },
    })),
  LS: (step) => shaped(decodePath(step.input), (value) => ({ name: "list", input: { path: value.path } })),
  WebFetch: (step) => shaped(decodeUrl(step.input), (value) => ({ name: "webfetch", input: { url: value.url } })),
  WebSearch: (step) =>
    shaped(decodeQuery(step.input), (value) => ({ name: "websearch", input: { query: value.query } })),
  Task: (step) => asAgent(step),
  Agent: (step) => asAgent(step),
}

function renamed(step: Transcript.ToolStep) {
  return Object.hasOwn(RENAMES, step.name) ? RENAMES[step.name](step) : undefined
}

function shaped<A>(value: Option.Option<A>, map: (value: A) => Renamed | undefined) {
  return Option.getOrUndefined(Option.map(value, map))
}

function asShell(command: string | ReadonlyArray<string>, workdir?: string | null): Renamed {
  return { name: "shell", input: { command: commandLine(command), ...(workdir ? { workdir } : {}) } }
}

/**
 * A command as one line: an argv list joined, or the script of a shell wrapper (`bash -lc <script>`,
 * `powershell -Command <script>`, `cmd /c <script>`).
 */
function commandLine(command: string | ReadonlyArray<string>) {
  if (typeof command === "string") return command
  const flag = command.at(-2)
  if (command.length >= 3 && flag !== undefined && /^(?:-l?c|-command|\/c)$/i.test(flag)) return command.at(-1) ?? ""
  return command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" ")
}

function asRead(step: Transcript.ToolStep) {
  return shaped(decodeFile(step.input), (value) =>
    IMAGE_PATH.test(value.file_path)
      ? undefined
      : {
          name: "read",
          input: {
            path: value.file_path,
            ...(typeof value.offset === "number" ? { offset: value.offset } : {}),
            ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
          },
        },
  )
}

function asGrep(step: Transcript.ToolStep) {
  return shaped(decodeSearch(step.input), (value) => {
    const include = value.glob ?? value.include
    return {
      name: "grep",
      input: { pattern: value.pattern, ...(value.path ? { path: value.path } : {}), ...(include ? { include } : {}) },
    }
  })
}

function asAgent(step: Transcript.ToolStep) {
  return shaped(decodeAgent(step.input), (value) => ({
    name: "subagent",
    input: { agent: value.subagent_type ?? "general", description: value.description, prompt: value.prompt },
  }))
}

/**
 * A Claude Code page with each `<persisted-output>` preview replaced by its `tool-results` file (read only now, at most
 * {@link TOOL_RESULT_VIEW}; 09 §2.6). `metadata.persisted` names the file.
 */
async function expand(target: ClaudeTarget, messages: ReadonlyArray<Message>): Promise<Message[]> {
  return Promise.all(
    messages.map(async (message): Promise<Message> => {
      if (message.type !== "assistant") return message
      const content = await Promise.all(message.content.map((part) => persisted(target, part)))
      return { ...message, content }
    }),
  )
}

async function persisted(target: ClaudeTarget, part: Part): Promise<Part> {
  if (part.type !== "tool" || part.state.status !== "completed") return part
  const preview = part.state.content.find((item) => item.type === "text")
  const name = preview?.type === "text" ? ClaudeTranscript.persisted(preview.text) : undefined
  if (name === undefined) return part
  const file = await ClaudeSource.toolResult(target.root, target.conversation, name, TOOL_RESULT_VIEW)
  if (!file.ok) return part
  const rest = file.value.bytes - TOOL_RESULT_VIEW
  const text = rest > 0 ? `${file.value.text}\n[… ${rest} bytes not shown]` : file.value.text
  return {
    ...part,
    state: {
      ...part.state,
      content: [{ type: "text", text }],
      metadata: { ...part.state.metadata, persisted: name },
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The outline

function empty(): Built {
  return { turns: [], tokens: [], checkpoints: [], children: [], rolledBack: 0, branches: 0, unknownRecords: 0 }
}

function outline(entry: Entry): OwnImport.Outline {
  const built = entry.built
  return {
    turns: [...built.turns],
    checkpoints: built.checkpoints.map((checkpoint) => ({
      turn: checkpoint.at.turn,
      step: checkpoint.at.step,
      kind: checkpoint.kind,
    })),
    children: [...built.children],
    rolledBack: built.rolledBack,
    branches: built.branches,
    tokens: built.tokens.reduce((sum, value) => sum + value, 0),
    unknownRecords: built.unknownRecords,
    ...(built.base === undefined ? {} : { base: built.base }),
  }
}

function outlineTurn(turn: Transcript.Turn): OwnImport.OutlineTurn {
  return { index: turn.index, firstLine: CodexTranscript.firstLine(turn.user.text) ?? "", time: turn.time }
}

/**
 * The turn's size for the view header (09 §2.3): `Token.estimate` of what the model saw, the human's text, the
 * answers, the tool inputs and results and the notes; readable reasoning summaries are view-only and not counted.
 */
export function tokens(turn: Transcript.Turn) {
  return turn.steps.reduce((sum, step) => {
    if (step.type === "reasoning-summary") return sum
    if (step.type !== "tool") return sum + Token.estimate(step.text)
    const input = typeof step.input === "string" ? step.input : (JSON.stringify(step.input) ?? "")
    return sum + Token.estimate(input) + Token.estimate(step.output?.text ?? "")
  }, Token.estimate(turn.user.text))
}

const decodeRef = Schema.decodeUnknownOption(OwnImport.SourceRef)

/** A conversation of the same root by id, when the id is a path-free token. */
function ref(target: Target, id: string) {
  return Option.getOrUndefined(decodeRef({ kind: target.ref.kind, rootID: target.ref.rootID, id }))
}

function adopt(built: Built, target: Target, child: Transcript.ChildRef) {
  const link = ref(target, child.id)
  if (link === undefined || built.children.some((known) => known.ref.id === link.id)) return
  const title = child.title ?? child.agent
  built.children.push({
    ref: link,
    ...(title === undefined ? {} : { title }),
    ...(child.at === undefined ? {} : { turn: child.at.turn }),
  })
}

function omitTurn(child: OwnImport.OutlineChild): OwnImport.OutlineChild {
  return { ref: child.ref, ...(child.title === undefined ? {} : { title: child.title }) }
}

// ---------------------------------------------------------------------------------------------------------------
// The page LRU

interface Slot {
  readonly messages: ReadonlyArray<Message>
  readonly bytes: number
}

type Cache = ReturnType<typeof cache>

/**
 * Decoded turns by `<entry slot>#<turn>`, at most `budget` bytes of JSON. `hot` (asked for by a read) is least
 * recently used first; `cold` (decoded on the way by an outline pass) is oldest first and is evicted before any hot
 * turn. Reading a cold turn makes it hot. A turn larger than the budget is not kept.
 */
function cache(budget: number) {
  const hot = new Map<string, Slot>()
  const cold = new Map<string, Slot>()
  const state = { bytes: 0 }
  const remove = (name: string) => {
    const known = hot.get(name) ?? cold.get(name)
    if (known === undefined) return
    hot.delete(name)
    cold.delete(name)
    state.bytes -= known.bytes
  }
  const evict = () => {
    while (state.bytes > budget) {
      const name = cold.keys().next().value ?? hot.keys().next().value
      if (name === undefined) return
      remove(name)
    }
  }
  return {
    get(name: string) {
      const known = hot.get(name) ?? cold.get(name)
      if (known === undefined) return undefined
      cold.delete(name)
      hot.delete(name)
      hot.set(name, known)
      return known.messages
    },
    put(name: string, messages: ReadonlyArray<Message>, tier: "hot" | "cold") {
      const bytes = Buffer.byteLength(JSON.stringify(messages))
      const wasHot = hot.has(name)
      remove(name)
      if (bytes > budget) return
      ;(tier === "hot" || wasHot ? hot : cold).set(name, { messages, bytes })
      state.bytes += bytes
      evict()
    },
    /** Removes the turns of `prefix` from turn `from` on. */
    drop(prefix: string, from: number) {
      ;[...hot.keys(), ...cold.keys()]
        .filter((name) => name.startsWith(`${prefix}#`) && Number(name.slice(prefix.length + 1)) >= from)
        .forEach(remove)
    },
    stats: () => ({ bytes: state.bytes, hot: hot.size, cold: cold.size }),
    clear() {
      hot.clear()
      cold.clear()
      state.bytes = 0
    },
  }
}

function slot(entry: Entry, turn: number) {
  return `${entry.slot}#${turn}`
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

function prefix(ref: OwnImport.SourceRef) {
  return createHash("sha256").update(key(ref)).digest("hex").slice(0, 12)
}

function same(a: Stamp, b: Stamp) {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function sizeOf(value: { readonly size: number; readonly mtimeMs: number }) {
  return { size: value.size, mtimeMs: value.mtimeMs }
}

function range(from: number, to: number) {
  return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index)
}

/** `work`, or `undefined` when `signal` aborts first (the work itself runs on; its result is dropped). */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined)
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

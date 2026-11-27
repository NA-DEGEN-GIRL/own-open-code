export * as ClaudeTranscript from "./claude.js"

import { FileDiff } from "@opencode/schema/file-diff"
import { optional } from "@opencode/schema/schema"
import { Option, Schema } from "effect"
import { Clean } from "./clean.js"
import { Transcript } from "./ir.js"

/**
 * Claude Code conversations → {@link Transcript.Info} (09 §2.6, §2.7). A conversation file is append-only JSONL whose
 * message records form a `parentUuid` DAG: edits and rewinds leave abandoned branches, parallel tool results hang off
 * sibling branches, and a compaction starts a new root (`compact_boundary`) that points back with
 * `logicalParentUuid`. The format is internal to Claude Code and changes between releases, so every line is decoded
 * once here with Effect Schema, tolerantly: unknown record types and content blocks are skipped and counted.
 *
 * The chain, title and first-prompt rules are ported from the Claude Agent SDK for Python
 * (`claude_agent_sdk/_internal/sessions.py`, MIT License, Copyright (c) Anthropic, PBC): `_build_conversation_chain`,
 * `_is_visible_message`, `_parse_session_info_from_lite`, `_extract_first_prompt_from_head` and
 * `_extract_json_string_field`. Beyond the SDK, the walk follows `logicalParentUuid` across compactions (the view
 * shows the whole history), parallel results are re-attached from sibling branches, compactions become checkpoints at
 * their mid-turn place, and prompts the human queued (`queued_command`) become turns.
 */

/** The first-request line of the list and titles derived from prompts (09 §2.3): one line, 120 characters. */
export const FIRST_PROMPT_MAX = 120
export const TITLE_MAX = 120

/** The result of a tool call whose result was never written (09 §2.6 병렬 도구 결과). */
export const INTERRUPTED = "interrupted before result was recorded"

/** Within this long after the last write a conversation may still be running (v1 rule, 09 §2.5, §2.6). */
export const LIVE_MS = 2 * 60 * 1000

// ---------------------------------------------------------------------------------------------------------------
// Records (decoded once, at the line)

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  source: optional(
    Schema.NullOr(Schema.Struct({ media_type: optional(Schema.String), data: optional(Schema.String) })),
  ),
})
const ThinkingBlock = Schema.Struct({
  type: Schema.Literals(["thinking", "redacted_thinking"]),
  thinking: optional(Schema.String),
})
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: optional(Schema.Unknown),
})
const ToolReferenceBlock = Schema.Struct({
  type: Schema.Literal("tool_reference"),
  tool_name: optional(Schema.String),
  name: optional(Schema.String),
})
const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]))),
  is_error: optional(Schema.NullOr(Schema.Boolean)),
})
const Block = Schema.Union([TextBlock, ImageBlock, ThinkingBlock, ToolUseBlock, ToolReferenceBlock, ToolResultBlock])
type Block = typeof Block.Type
type ImageBlock = typeof ImageBlock.Type
type ToolResultBlock = typeof ToolResultBlock.Type
const decodeBlock = Schema.decodeUnknownOption(Block)

/** `message.content` and a queued prompt: a string, or blocks decoded one by one ({@link blocks}). */
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
type Content = typeof Content.Type

const Origin = optional(Schema.NullOr(Schema.Struct({ kind: optional(Schema.String) })))
type Origin = { readonly kind?: string } | null | undefined

/**
 * Fields every message record carries (SDK `_TranscriptEntry`). Only `uuid` is required: the format is not
 * documented, so a missing or `null` field never costs the record.
 */
const Common = {
  uuid: Schema.String,
  parentUuid: optional(Schema.NullOr(Schema.String)),
  isSidechain: optional(Schema.NullOr(Schema.Boolean)),
  isMeta: optional(Schema.NullOr(Schema.Boolean)),
  teamName: optional(Schema.NullOr(Schema.String)),
  timestamp: optional(Schema.NullOr(Schema.String)),
  cwd: optional(Schema.NullOr(Schema.String)),
  gitBranch: optional(Schema.NullOr(Schema.String)),
  version: optional(Schema.NullOr(Schema.String)),
  entrypoint: optional(Schema.NullOr(Schema.String)),
}

const UserRecord = Schema.Struct({
  type: Schema.Literal("user"),
  ...Common,
  message: Schema.Struct({ content: Content }),
  isCompactSummary: optional(Schema.NullOr(Schema.Boolean)),
  /** UI data the model never saw (stdout, `structuredPatch`, whole files): read once for the view, then let go. */
  toolUseResult: optional(Schema.Unknown),
  toolDenialKind: optional(Schema.NullOr(Schema.String)),
  usageLimitNote: optional(Schema.Unknown),
  origin: Origin,
})
type UserRecord = typeof UserRecord.Type

const Usage = Schema.Struct({
  input_tokens: optional(Schema.NullOr(Schema.Finite)),
  output_tokens: optional(Schema.NullOr(Schema.Finite)),
  cache_creation_input_tokens: optional(Schema.NullOr(Schema.Finite)),
  cache_read_input_tokens: optional(Schema.NullOr(Schema.Finite)),
})
type Usage = typeof Usage.Type

const AssistantRecord = Schema.Struct({
  type: Schema.Literal("assistant"),
  ...Common,
  message: Schema.Struct({
    id: optional(Schema.NullOr(Schema.String)),
    model: optional(Schema.NullOr(Schema.String)),
    content: Content,
    usage: optional(Schema.NullOr(Usage)),
  }),
  isApiErrorMessage: optional(Schema.NullOr(Schema.Boolean)),
})
type AssistantRecord = typeof AssistantRecord.Type

const Segment = Schema.Struct({ anchorUuid: optional(Schema.String), headUuid: Schema.String, tailUuid: Schema.String })
type Segment = typeof Segment.Type

const SystemRecord = Schema.Struct({
  type: Schema.Literal("system"),
  ...Common,
  subtype: optional(Schema.NullOr(Schema.String)),
  logicalParentUuid: optional(Schema.NullOr(Schema.String)),
  compactMetadata: optional(
    Schema.NullOr(
      Schema.Struct({
        trigger: optional(Schema.String),
        preTokens: optional(Schema.Finite),
        postTokens: optional(Schema.Finite),
        preservedSegment: optional(Schema.NullOr(Segment)),
      }),
    ),
  ),
})
type SystemRecord = typeof SystemRecord.Type

const AttachmentRecord = Schema.Struct({
  type: Schema.Literal("attachment"),
  ...Common,
  attachment: optional(Schema.Unknown),
})
type AttachmentRecord = typeof AttachmentRecord.Type

/** A prompt typed while the tool worked, delivered mid-turn (`attachment.type: "queued_command"`). */
const Queued = Schema.Struct({
  type: Schema.Literal("queued_command"),
  prompt: Content,
  commandMode: optional(Schema.String),
  origin: Origin,
  source_uuid: optional(Schema.String),
  isMeta: optional(Schema.Boolean),
  humanTurn: optional(Schema.Boolean),
})
const decodeQueued = Schema.decodeUnknownOption(Queued)

const Record = Schema.Union([
  UserRecord,
  AssistantRecord,
  SystemRecord,
  AttachmentRecord,
  Schema.Struct({ type: Schema.Literal("custom-title"), customTitle: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ai-title"), aiTitle: Schema.String }),
  Schema.Struct({ type: Schema.Literal("last-prompt"), lastPrompt: optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("summary"), summary: Schema.String }),
  Schema.Struct({ type: Schema.Literal("relocated"), relocatedCwd: Schema.String }),
])
const KNOWN = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "custom-title",
  "ai-title",
  "last-prompt",
  "summary",
  "relocated",
])

/** Records that are metadata, not conversation (09 §2.6): skipped without counting. */
const METADATA = new Set([
  "pr-link",
  "cost-state",
  "mode",
  "permission-mode",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "atis-latch",
  "agent-name",
  "tag",
  "progress",
])

/** Enough of any record to keep the `parentUuid` chain whole when the record itself is not used. */
const Head = Schema.Struct({
  type: Schema.String,
  uuid: optional(Schema.NullOr(Schema.String)),
  parentUuid: optional(Schema.NullOr(Schema.String)),
})
type Head = typeof Head.Type

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeHead = Schema.decodeUnknownOption(Head)
const decodeRecord = Schema.decodeUnknownOption(Record)
const decodeString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

const Hunk = Schema.Struct({
  oldStart: Schema.Finite,
  oldLines: Schema.Finite,
  newStart: Schema.Finite,
  newLines: Schema.Finite,
  lines: Schema.Array(Schema.String),
})
/** The part of `toolUseResult` the view uses: a shell result's exit, an edit's diff, the started agent. */
const ToolUseResult = Schema.Struct({
  stdout: optional(Schema.String),
  interrupted: optional(Schema.Boolean),
  exitCode: optional(Schema.Finite),
  filePath: optional(Schema.String),
  type: optional(Schema.String),
  structuredPatch: optional(Schema.Array(Hunk)),
  agentId: optional(Schema.String),
})
type ToolUseResult = typeof ToolUseResult.Type
const decodeToolUseResult = Schema.decodeUnknownOption(ToolUseResult)

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** One line of the file as the source splits it (09 §2.8): a line, one over the 32 MiB cap, or a torn last line. */
export type Line =
  | { readonly type: "line"; readonly text: string }
  | { readonly type: "oversized" }
  | { readonly type: "torn" }

/** A sub-agent conversation of this one (`subagents/**\/agent-*.jsonl` with its `.meta.json`), for view links. */
export interface Child {
  /** `<sessionId>:<agentId>` (09 §5.2). */
  readonly id: string
  readonly agentId: string
  /** `meta.description`. */
  readonly title?: string
  /** `meta.agentType` (`general-purpose`, `Explore`, …). */
  readonly agent?: string
  /** The parent's Agent tool call that started it. */
  readonly toolUseId?: string
}

export interface Context {
  /** The session id, or `<sessionId>:<agentId>` for a sub-agent conversation. */
  readonly id: string
  readonly rootID: string
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
  /** "Now" for `live` (a write within the last two minutes, 09 §2.6). */
  readonly now: number
  /** A sub-agent conversation's session id. */
  readonly parentID?: string
  /** A title kept beside the file: `<session>/custom-title.json`, or a sub-agent's `meta.description`. */
  readonly customTitle?: string
  readonly children: ReadonlyArray<Child>
}

interface Node {
  readonly uuid: string
  readonly parent?: string
  readonly index: number
  readonly time: number
  /** Absent for a record kept only as a link of the chain (`progress`, an unknown or undecodable record). */
  readonly record?: UserRecord | AssistantRecord | SystemRecord | AttachmentRecord
  readonly blocks: ReadonlyArray<Block>
  /** Content blocks of a kind this parser does not know. */
  readonly unknown: number
}

/** A tool result found anywhere in the file, by `tool_use_id`. */
interface Found {
  readonly output: Transcript.Output
  readonly exit?: number
  readonly diff?: ReadonlyArray<FileDiff.Info>
  readonly agentId?: string
}

interface Titles {
  /** The last `custom-title` record. */
  readonly custom?: string
  /** `custom-title.json` beside the conversation. */
  readonly file?: string
  /** The last `ai-title` record. */
  readonly ai?: string
  /** The last `last-prompt` record. */
  readonly prompt?: string
  /** The last legacy `summary` record. */
  readonly summary?: string
  /** The first meaningful human line. */
  readonly first?: string
}

/** What the reader gathers besides the chain: titles, folders, versions, times and the drop counts. */
interface Gathered {
  custom?: string
  ai?: string
  prompt?: string
  summary?: string
  branch?: string
  app?: string
  first: number
  last: number
  dropped: Transcript.Dropped
  readonly cwds: string[]
  readonly versions: string[]
}

/**
 * Reads one conversation line by line and builds its transcript in `finish`. Only decoded records are kept (the DAG
 * needs all of them), and `toolUseResult` is reduced to what the view uses as soon as its line is read. `subagent`:
 * a sub-agent file, whose records are all sidechain records of their own conversation.
 */
export function reader(options: { readonly subagent: boolean }) {
  const nodes = new Map<string, Node>()
  const results = new Map<string, Found>()
  const gathered: Gathered = { first: Number.NaN, last: Number.NaN, dropped: {}, cwds: [], versions: [] }
  const drop = (kind: Transcript.DropKind, count = 1) => {
    if (count > 0) gathered.dropped = Transcript.drop(gathered.dropped, kind, count)
  }
  const add = (list: string[], value: string | null | undefined) => {
    if (value && !list.includes(value)) list.push(value)
  }
  const link = (head: Head) => {
    if (!head.uuid) return
    nodes.set(head.uuid, {
      uuid: head.uuid,
      parent: head.parentUuid ?? undefined,
      index: nodes.size,
      time: Number.NaN,
      blocks: [],
      unknown: 0,
    })
  }

  const push = (line: Line) => {
    if (line.type === "torn") return drop("tornLine")
    if (line.type === "oversized") return drop("oversizedLine")
    const text = line.text.trim()
    if (text === "") return
    const json = decodeJson(text)
    const head = Option.flatMap(json, decodeHead)
    if (Option.isNone(head)) return drop("decodeFailed")
    if (!KNOWN.has(head.value.type)) {
      if (!METADATA.has(head.value.type)) drop("unknownRecord")
      return link(head.value)
    }
    const decoded = Option.getOrUndefined(Option.flatMap(json, decodeRecord))
    if (decoded === undefined) {
      drop("decodeFailed")
      return link(head.value)
    }
    if (decoded.type === "custom-title") {
      gathered.custom = decoded.customTitle
      return
    }
    if (decoded.type === "ai-title") {
      gathered.ai = decoded.aiTitle
      return
    }
    if (decoded.type === "last-prompt") {
      gathered.prompt = decoded.lastPrompt ?? gathered.prompt
      return
    }
    if (decoded.type === "summary") {
      gathered.summary = decoded.summary
      return
    }
    if (decoded.type === "relocated") return add(gathered.cwds, decoded.relocatedCwd)
    const time = decoded.timestamp ? Date.parse(decoded.timestamp) : Number.NaN
    add(gathered.cwds, decoded.cwd)
    add(gathered.versions, decoded.version)
    if (decoded.gitBranch) gathered.branch = decoded.gitBranch
    if (decoded.entrypoint) gathered.app = decoded.entrypoint
    if (Number.isFinite(time)) {
      gathered.first = Number.isNaN(gathered.first) ? time : Math.min(gathered.first, time)
      gathered.last = Number.isNaN(gathered.last) ? time : Math.max(gathered.last, time)
    }
    const content =
      decoded.type === "user" || decoded.type === "assistant" ? blocks(decoded.message.content) : undefined
    if (decoded.type === "user") collect(decoded, content?.blocks ?? [])
    // Sub-agent records inside a main file (older releases) are counted here, on the path or not, and never used.
    if (decoded.isSidechain && !options.subagent) drop("sidechain")
    nodes.set(decoded.uuid, {
      uuid: decoded.uuid,
      parent: decoded.parentUuid ?? undefined,
      index: nodes.size,
      time,
      // Whole files and command output live in `toolUseResult`; `collect` took what the view needs.
      record: decoded.type === "user" ? { ...decoded, toolUseResult: undefined } : decoded,
      blocks: content?.blocks ?? [],
      unknown: content?.unknown ?? 0,
    })
  }

  /** Every tool result of the file, so results on sibling branches can be re-attached (09 §2.6). */
  const collect = (record: UserRecord, list: ReadonlyArray<Block>) => {
    const tools = list.filter((block): block is ToolResultBlock => block.type === "tool_result")
    // `toolUseResult` belongs to the record; it describes its call only when the record holds one result.
    const extra = tools.length === 1 ? Option.getOrUndefined(decodeToolUseResult(record.toolUseResult)) : undefined
    const denied = record.toolDenialKind !== undefined && record.toolDenialKind !== null
    tools
      .filter((block) => !results.has(block.tool_use_id))
      .forEach((block) => results.set(block.tool_use_id, outcome(block, denied, extra)))
  }

  const finish = (context: Context): Transcript.Info => {
    const walked = chain(nodes, options.subagent)
    drop("abandonedBranch", walked.abandoned)
    const live = context.now - context.mtimeMs < LIVE_MS
    const built = build({
      path: walked.path,
      nodes,
      results,
      children: context.children,
      subagent: options.subagent,
      live,
      drop,
    })
    const createdAt = Number.isNaN(gathered.first) ? context.mtimeMs : gathered.first
    const turns = Transcript.repairTimes(built.turns, createdAt)
    const first = turns.find((turn) => turn.user.text !== "" && !SKIP.test(turn.user.text))?.user.text
    const firstPrompt = first === undefined ? undefined : Clean.oneLine(first, FIRST_PROMPT_MAX)
    const named = title({
      custom: gathered.custom,
      file: context.customTitle,
      ai: gathered.ai,
      prompt: gathered.prompt,
      summary: gathered.summary,
      first: firstPrompt,
    })
    return {
      source: {
        kind: "claude-code",
        id: context.id,
        rootID: context.rootID,
        path: context.path,
        versions: gathered.versions,
        ...(gathered.app === undefined ? {} : { app: gathered.app }),
        cwds: gathered.cwds,
        ...(gathered.branch === undefined ? {} : { branch: gathered.branch }),
        title: named,
        ...(firstPrompt === undefined ? {} : { firstPrompt }),
        models: built.models.map((id) => ({ id })),
        createdAt,
        updatedAt: Number.isNaN(gathered.last) ? Math.max(createdAt, context.mtimeMs) : gathered.last,
        bytes: context.bytes,
        ...(context.parentID === undefined ? {} : { parentID: context.parentID }),
        subagent: options.subagent,
        live,
      },
      turns,
      checkpoints: built.checkpoints,
      children: built.children,
      dropped: gathered.dropped,
      ...(built.usage === undefined ? {} : { usage: built.usage }),
    }
  }

  return { push, finish }
}

export type Reader = ReturnType<typeof reader>

/** Parses a whole conversation given as lines (tests, small inputs). */
export function parse(lines: Iterable<string>, context: Context, options = { subagent: false }) {
  const read = reader(options)
  for (const text of lines) read.push({ type: "line", text })
  return read.finish(context)
}

/** Content as decoded blocks; a block of a kind this parser does not know is counted, not kept. */
function blocks(content: Content): { readonly blocks: ReadonlyArray<Block>; readonly unknown: number } {
  if (typeof content === "string") return { blocks: [{ type: "text", text: content }], unknown: 0 }
  const decoded = content.map((item) => Option.getOrUndefined(decodeBlock(item)))
  return {
    blocks: decoded.filter((block): block is Block => block !== undefined),
    unknown: decoded.filter((block) => block === undefined).length,
  }
}

function outcome(block: ToolResultBlock, denied: boolean, extra: ToolUseResult | undefined): Found {
  const text = resultText(block.content ?? undefined)
  // A denied call (`toolDenialKind`) stays a tool error so the model knows it did not run (09 §2.6).
  const error = block.is_error === true || denied
  const exit = exitCode(extra, text, error)
  const diff = patch(extra)
  return {
    output: { text, error },
    ...(exit === undefined ? {} : { exit }),
    ...(diff === undefined ? {} : { diff }),
    ...(extra?.agentId === undefined ? {} : { agentId: extra.agentId }),
  }
}

/** What the model saw of a tool result: text, `[image: …]` and `[tool reference: <name>]` (09 §2.6). */
function resultText(content: string | ReadonlyArray<unknown> | undefined) {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return blocks(content)
    .blocks.flatMap((block) => {
      if (block.type === "text") return [block.text]
      if (block.type === "image") return [placeholder(image(block))]
      if (block.type === "tool_reference") return [`[tool reference: ${block.tool_name ?? block.name ?? "unknown"}]`]
      return []
    })
    .join("\n")
}

/** `[image: image/png, 120 KB]`: an image that is not kept as an image (09 §4.2). */
export function placeholder(item: Transcript.Image) {
  return `[image: ${item.mime}, ${size(item.bytes)}]`
}

export function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function image(block: ImageBlock): Transcript.Image {
  const mime = block.source?.media_type ?? "image/*"
  const data = block.source?.data
  if (data === undefined) return { mime, bytes: 0 }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return { mime, bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding), data }
}

/** A shell call's exit code: the recorded one, `Exit code N` of an error, else 0 for a finished shell result. */
function exitCode(extra: ToolUseResult | undefined, text: string, error: boolean) {
  if (extra?.exitCode !== undefined) return Math.trunc(extra.exitCode)
  const coded = /^Exit code (-?\d+)/.exec(text)
  if (error && coded) return Number(coded[1])
  if (extra?.stdout !== undefined && !error && extra.interrupted !== true) return 0
  return undefined
}

/** The view's diff from `structuredPatch` (never sent to a model). */
function patch(extra: ToolUseResult | undefined): FileDiff.Info[] | undefined {
  const hunks = extra?.structuredPatch
  if (extra?.filePath === undefined || hunks === undefined || hunks.length === 0) return undefined
  const lines = hunks.flatMap((hunk) => hunk.lines)
  return [
    {
      file: extra.filePath,
      patch: hunks
        .map(
          (hunk) =>
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`,
        )
        .join(""),
      additions: lines.filter((line) => line.startsWith("+")).length,
      deletions: lines.filter((line) => line.startsWith("-")).length,
      status: extra.type === "create" ? "added" : "modified",
    },
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// The chain (SDK `_build_conversation_chain`)

/**
 * The conversation as one path from the root to the leaf. Leaf: of the nodes without children, the nearest
 * user/assistant record walking up, preferring ones that are not sidechain, team or meta, the latest in the file
 * (`last-prompt.leafUuid` is not trusted: it is written when the prompt is sent). The walk follows `parentUuid` and,
 * unlike the SDK, crosses a `compact_boundary` through `logicalParentUuid`, so the view shows the whole history.
 * `abandoned` counts the branch tips left by edits and rewinds that are not on the path (`다른 갈래 N개`).
 */
function chain(nodes: ReadonlyMap<string, Node>, subagent: boolean) {
  const all = [...nodes.values()]
  const parents = new Set(all.flatMap((node) => (node.parent === undefined ? [] : [node.parent])))
  const leaves = [
    ...new Map(
      all
        .filter((node) => !parents.has(node.uuid))
        .flatMap((node) => nearest(nodes, node))
        .map((node) => [node.uuid, node] as const),
    ).values(),
  ]
  const main = leaves.filter((leaf) => mainLine(leaf, subagent))
  const pick = (main.length > 0 ? main : leaves).reduce<Node | undefined>(
    (best, leaf) => (best === undefined || leaf.index > best.index ? leaf : best),
    undefined,
  )
  const path = pick === undefined ? [] : walk(nodes, pick)
  const on = new Set(path.map((node) => node.uuid))
  return { path, abandoned: main.filter((leaf) => !on.has(leaf.uuid) && tip(leaf)).length }
}

/** The nearest user or assistant record at or above `node` (parent links only). */
function nearest(nodes: ReadonlyMap<string, Node>, node: Node): Node[] {
  const seen = new Set<string>()
  for (let current: Node | undefined = node; current && !seen.has(current.uuid); current = parentOf(nodes, current)) {
    seen.add(current.uuid)
    if (current.record?.type === "user" || current.record?.type === "assistant") return [current]
  }
  return []
}

function parentOf(nodes: ReadonlyMap<string, Node>, node: Node) {
  return node.parent === undefined ? undefined : nodes.get(node.parent)
}

/** Root → leaf; a `compact_boundary` without a parent continues at its `logicalParentUuid`. */
function walk(nodes: ReadonlyMap<string, Node>, leaf: Node) {
  const path: Node[] = []
  const seen = new Set<string>()
  for (let current: Node | undefined = leaf; current && !seen.has(current.uuid); current = up(nodes, current)) {
    seen.add(current.uuid)
    path.push(current)
  }
  return path.reverse()
}

function up(nodes: ReadonlyMap<string, Node>, node: Node) {
  if (node.parent !== undefined) return nodes.get(node.parent)
  const record = node.record
  if (record?.type !== "system" || record.subtype !== "compact_boundary" || !record.logicalParentUuid) return undefined
  return nodes.get(record.logicalParentUuid)
}

/** SDK `_is_visible_message` for leaves: not sidechain (unless a sub-agent file), team or meta. */
function mainLine(node: Node, subagent: boolean) {
  const record = node.record
  return record !== undefined && (subagent || !record.isSidechain) && !record.teamName && !record.isMeta
}

/**
 * A leaf that ends a branch the human or the model wrote: not a parallel tool result hanging off the chain, an API
 * error or synthetic notice, a usage-limit note or a compact summary.
 */
function tip(node: Node) {
  const record = node.record
  if (record?.type === "assistant") return !record.isApiErrorMessage && record.message.model !== "<synthetic>"
  if (record?.type !== "user") return false
  if (record.usageLimitNote !== undefined || record.isCompactSummary) return false
  return !node.blocks.every((block) => block.type === "tool_result")
}

// ---------------------------------------------------------------------------------------------------------------
// Turns

interface Open {
  readonly index: number
  readonly time: number
  readonly user: Transcript.User
  readonly steps: Transcript.Step[]
  interrupted: boolean
  error: boolean
}

interface BuildInput {
  readonly path: ReadonlyArray<Node>
  readonly nodes: ReadonlyMap<string, Node>
  readonly results: ReadonlyMap<string, Found>
  readonly children: ReadonlyArray<Child>
  readonly subagent: boolean
  readonly live: boolean
  readonly drop: (kind: Transcript.DropKind, count?: number) => void
}

/** What one human message holds once the harness wrappers are removed ({@link Clean.human}). */
interface Said {
  readonly text: string
  readonly images: ReadonlyArray<Transcript.Image>
  readonly notes: ReadonlyArray<string>
  readonly command?: string
  readonly interrupted: boolean
  readonly stripped: number
}

function said(list: ReadonlyArray<Block>): Said {
  const parts = list.flatMap((block) => (block.type === "text" ? [Clean.human(block.text)] : []))
  return {
    text: parts
      .map((part) => part.text)
      .filter((text) => text !== "")
      .join("\n\n"),
    images: list.flatMap((block) => (block.type === "image" ? [image(block)] : [])),
    notes: parts.flatMap((part) => part.notes),
    command: parts.find((part) => part.command !== undefined)?.command,
    interrupted: parts.some((part) => part.interrupted),
    stripped: parts.reduce((total, part) => total + part.stripped, 0),
  }
}

/** Build state besides the turns themselves. */
interface Progress {
  /** A slash command waiting for the model's answer to become a turn. */
  pending?: { readonly text: string; readonly time: number }
  /** The checkpoint whose summary record has not been read yet. */
  awaiting?: number
  /** The text step the next text block of the same response joins. */
  text?: { readonly message: string; readonly turn: number; readonly step: number }
}

/**
 * Walks the chain once, root to leaf, and builds turns (09 §2.4, §2.6). A turn starts at each real human message (a
 * typed prompt, a slash command the model answered, or a prompt the human queued); the model's text, readable
 * reasoning, tool calls and one-line notes are its steps. Consecutive records of one `message.id` are one response:
 * adjacent text blocks join and usage counts once. A `compact_boundary` becomes a checkpoint after the steps written
 * so far, so a mid-turn compaction sits between steps; its summary is the `isCompactSummary` record without the
 * harness phrases.
 */
function build(input: BuildInput) {
  const drop = input.drop
  const turns: Open[] = []
  const calls: Array<{
    readonly turn: number
    readonly step: number
    readonly id: string
    readonly value: Transcript.ToolStep
  }> = []
  const checkpoints: Transcript.Checkpoint[] = []
  const usage = new Map<string, Usage>()
  const models: string[] = []
  const consumed = new Set<string>()
  const progress: Progress = {}
  const userUuids = new Set(
    [...input.nodes.values()].flatMap((node) =>
      node.record?.type === "user" && !node.record.isMeta ? [node.uuid] : [],
    ),
  )
  const humanTexts = new Set(
    input.path.flatMap((node) => {
      const record = node.record
      if (record?.type !== "user" || record.isMeta || record.isCompactSummary || !byHuman(record.origin)) return []
      if (node.blocks.some((block) => block.type === "tool_result")) return []
      const text = said(node.blocks).text
      return text === "" ? [] : [text]
    }),
  )

  const current = () => turns.at(-1)
  const open = (user: Transcript.User, time: number) => {
    // A slash command nobody answered (e.g. `/model`) is harness, not a turn.
    if (progress.pending !== undefined) drop("harnessWrapper")
    progress.pending = undefined
    progress.text = undefined
    turns.push({ index: turns.length, time, user, steps: [], interrupted: false, error: false })
  }
  /** The turn a step of the model goes to: a slash command it answers, else the current turn, else a first one. */
  const ensure = (time: number) => {
    const pending = progress.pending
    progress.pending = undefined
    if (pending !== undefined) open({ text: pending.text, images: [] }, pending.time)
    if (turns.length === 0) open({ text: "", images: [] }, time)
    return turns[turns.length - 1]
  }
  const step = (turn: Open, value: Transcript.Step) => {
    turn.steps.push(value)
    progress.text = undefined
  }
  const note = (text: string, time: number) => {
    const turn = current()
    if (turn === undefined) return drop("harnessWrapper")
    step(turn, { type: "note", text, time })
  }
  const place = (source: Transcript.Anchor) => {
    const turn = current()
    return { turn: turn?.index ?? 0, step: turn?.steps.length ?? 0, source }
  }
  const summarize = (index: number, text: string) => {
    const cleaned = Clean.summary(text)
    drop("boilerplateUnmatched", cleaned.unmatched)
    checkpoints[index] = { ...checkpoints[index], summary: cleaned.text }
  }

  const user = (node: Node, record: UserRecord) => {
    if (record.isSidechain && !input.subagent) return
    if (record.teamName) return drop("sidechain")
    if (record.isMeta) return drop("metaRecord")
    if (record.usageLimitNote !== undefined) return drop("usageLimit")
    if (record.isCompactSummary) return compactSummary(node)
    drop("unknownField", node.unknown)
    const words = said(node.blocks)
    const turn = current()
    if (words.interrupted && turn !== undefined) turn.interrupted = true
    words.notes.forEach((text) => note(text, node.time))
    // A tool result record (results are attached by id later) or a message from a task or a peer: text is a note.
    if (node.blocks.some((block) => block.type === "tool_result") || !byHuman(record.origin)) {
      if (words.text !== "") note(Clean.oneLine(words.text, Clean.NOTE_MAX), node.time)
      return
    }
    if (words.text !== "" || words.images.length > 0) return open({ text: words.text, images: words.images }, node.time)
    if (words.command !== undefined) {
      if (progress.pending !== undefined) drop("harnessWrapper")
      progress.pending = { text: words.command, time: node.time }
      return
    }
    if (words.stripped > 0 && words.notes.length === 0) drop("harnessWrapper")
  }

  const assistant = (node: Node, record: AssistantRecord) => {
    if (record.isSidechain && !input.subagent) return
    if (record.teamName) return drop("sidechain")
    if (record.isApiErrorMessage) {
      drop("apiError")
      const turn = current()
      if (turn !== undefined) turn.error = true
      return
    }
    if (record.message.model === "<synthetic>") return drop("syntheticRecord")
    if (record.isMeta) return drop("metaRecord")
    drop("unknownField", node.unknown)
    const turn = ensure(node.time)
    turn.error = false
    const message = record.message.id ?? undefined
    const model = record.message.model ?? undefined
    if (message !== undefined && record.message.usage && !usage.has(message)) usage.set(message, record.message.usage)
    if (model !== undefined && !models.includes(model)) models.push(model)
    node.blocks.forEach((block) => {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        // Signatures are bound to the model, prompt and account (09 §2.7); readable text stays for the view only.
        drop("thinking")
        const text = block.thinking?.trim() ?? ""
        if (text !== "") step(turn, { type: "reasoning-summary", text, time: node.time })
        return
      }
      if (block.type === "text") return written(turn, block.text, message, model, node.time)
      if (block.type === "tool_use") {
        const value: Transcript.ToolStep = { type: "tool", name: block.name, input: block.input ?? {}, time: node.time }
        calls.push({ turn: turn.index, step: turn.steps.length, id: block.id, value })
        return step(turn, value)
      }
      drop("unknownField")
    })
  }

  /** A text block; the next text block of the same response joins it (split responses, 09 §2.6). */
  const written = (turn: Open, value: string, message: string | undefined, model: string | undefined, time: number) => {
    if (value.trim() === "") return
    const joins = progress.text
    const last = turn.steps.at(-1)
    if (
      joins !== undefined &&
      joins.message === message &&
      joins.turn === turn.index &&
      joins.step === turn.steps.length - 1 &&
      last?.type === "text"
    ) {
      turn.steps[joins.step] = { ...last, text: `${last.text}\n\n${value}` }
      return
    }
    step(turn, { type: "text", text: value, time, ...(model === undefined ? {} : { model }) })
    if (message !== undefined) progress.text = { message, turn: turn.index, step: turn.steps.length - 1 }
  }

  const boundary = (node: Node, record: SystemRecord) => {
    const metadata = record.compactMetadata ?? undefined
    const segment = metadata?.preservedSegment ?? undefined
    const anchor = segment?.anchorUuid === undefined ? undefined : input.nodes.get(segment.anchorUuid)
    checkpoints.push({
      at: place({ uuid: node.uuid }),
      kind: "foreign",
      recent: segment === undefined ? [] : recent(preserved(input.nodes, segment)),
      ...(metadata?.trigger === undefined ? {} : { trigger: metadata.trigger }),
      ...(metadata?.preTokens === undefined ? {} : { preTokens: whole(metadata.preTokens) }),
      ...(metadata?.postTokens === undefined ? {} : { postTokens: whole(metadata.postTokens) }),
    })
    if (anchor?.record?.type === "user" && anchor.record.isCompactSummary) {
      consumed.add(anchor.uuid)
      return summarize(checkpoints.length - 1, plain(anchor.blocks))
    }
    progress.awaiting = checkpoints.length - 1
  }

  const compactSummary = (node: Node) => {
    if (consumed.has(node.uuid)) return
    const awaiting = progress.awaiting
    progress.awaiting = undefined
    if (awaiting !== undefined) return summarize(awaiting, plain(node.blocks))
    // A summary without a boundary record (older releases): a checkpoint at its own place.
    checkpoints.push({ at: place({ uuid: node.uuid }), kind: "foreign", recent: [] })
    summarize(checkpoints.length - 1, plain(node.blocks))
  }

  const attachment = (node: Node, record: AttachmentRecord) => {
    if (record.isSidechain && !input.subagent) return
    const queued = Option.getOrUndefined(decodeQueued(record.attachment))
    // Everything else Claude Code attaches is its own context (`prompt_snapshot` holds its system prompt).
    if (queued === undefined) return drop("attachment")
    const words = said(blocks(queued.prompt).blocks)
    const fromHuman =
      (queued.origin?.kind === "human" || queued.humanTurn === true) &&
      !record.isMeta &&
      !queued.isMeta &&
      (queued.commandMode ?? "prompt") === "prompt"
    if (!fromHuman) {
      if (words.notes.length > 0) return words.notes.forEach((value) => note(value, node.time))
      const kind = queued.origin?.kind ?? queued.commandMode ?? "unknown"
      return note(
        Clean.oneLine(`Queued message (${kind}): ${words.text || words.command || ""}`, Clean.NOTE_MAX),
        node.time,
      )
    }
    // The same prompt also written as a user record: the user record stays (09 §2.6).
    if ((queued.source_uuid !== undefined && userUuids.has(queued.source_uuid)) || humanTexts.has(words.text))
      return drop("queuedDuplicate")
    if (words.text === "" && words.images.length === 0) return drop("harnessWrapper")
    open({ text: words.text, images: words.images, queued: true }, node.time)
  }

  input.path.forEach((node) => {
    const record = node.record
    if (record?.type === "user") return user(node, record)
    if (record?.type === "assistant") return assistant(node, record)
    if (record?.type === "attachment") return attachment(node, record)
    if (record?.type === "system" && record.subtype === "compact_boundary") return boundary(node, record)
  })
  if (progress.pending !== undefined) drop("harnessWrapper")

  // Results by `tool_use_id`, from the path or a sibling branch; a call without one was interrupted.
  const linked = new Map<string, { readonly turn: number; readonly step: number }>()
  calls.forEach((call) => {
    const turn = turns[call.turn]
    const found = input.results.get(call.id)
    const child = input.children.find(
      (item) => item.toolUseId === call.id || (found?.agentId !== undefined && item.agentId === found.agentId),
    )
    if (child !== undefined && !linked.has(child.id)) linked.set(child.id, { turn: call.turn, step: call.step })
    if (found === undefined) turn.interrupted = true
    turn.steps[call.step] = {
      ...call.value,
      output: found?.output ?? { text: INTERRUPTED, error: true },
      ...(found?.exit === undefined ? {} : { exit: found.exit }),
      ...(found?.diff === undefined ? {} : { diff: found.diff }),
      ...(child === undefined ? {} : { child: child.id }),
    }
  })

  return {
    turns: turns.map(
      (turn, index): Transcript.Turn => ({
        index: turn.index,
        time: turn.time,
        user: turn.user,
        steps: turn.steps,
        end: end(turn, index === turns.length - 1, input.live),
      }),
    ),
    checkpoints,
    children: input.children.map((child): Transcript.ChildRef => {
      const at = linked.get(child.id)
      return {
        id: child.id,
        ...(child.title === undefined ? {} : { title: child.title }),
        ...(child.agent === undefined ? {} : { agent: child.agent }),
        ...(at === undefined ? {} : { at }),
      }
    }),
    models,
    usage: usage.size === 0 ? undefined : total([...usage.values()]),
  }
}

/** How a turn ended: marked interrupted or failed, else answered; the last turn may still be open when live. */
function end(turn: Open, last: boolean, live: boolean): Transcript.End {
  if (turn.interrupted) return "interrupted"
  if (turn.error) return "error"
  if (!last || turn.steps.at(-1)?.type === "text") return "completed"
  return live ? "open" : "interrupted"
}

/** Display totals, each response once: input includes cache writes and reads, `cached` the reads. */
function total(list: ReadonlyArray<Usage>): Transcript.Usage {
  const sum = (pick: (item: Usage) => number | null | undefined) =>
    whole(list.reduce((all, item) => all + (pick(item) ?? 0), 0))
  return {
    input: sum(
      (item) =>
        (item.input_tokens ?? 0) + (item.cache_creation_input_tokens ?? 0) + (item.cache_read_input_tokens ?? 0),
    ),
    output: sum((item) => item.output_tokens),
    cached: sum((item) => item.cache_read_input_tokens),
  }
}

/** The human wrote it: no origin (older releases) or `origin.kind: "human"`; task notifications and peers did not. */
function byHuman(origin: Origin) {
  return origin?.kind === undefined || origin.kind === "human"
}

function plain(list: ReadonlyArray<Block>) {
  return list.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}

function whole(value: number) {
  return Math.max(0, Math.round(value))
}

/** The preserved segment `head..tail`: walked up from `tail` by parent links; empty when `head` is not reached. */
function preserved(nodes: ReadonlyMap<string, Node>, segment: Segment) {
  const seen = new Set<string>()
  const out: Node[] = []
  for (
    let current: Node | undefined = nodes.get(segment.tailUuid);
    current && !seen.has(current.uuid);
    current = parentOf(nodes, current)
  ) {
    seen.add(current.uuid)
    out.push(current)
    if (current.uuid === segment.headUuid) return out.reverse()
  }
  return []
}

/** A checkpoint's `recent` lines (09 §2.4): the human's words, the model's text, tool calls and results. */
function recent(list: ReadonlyArray<Node>): Transcript.Line[] {
  return list.flatMap((node): Transcript.Line[] => {
    const record = node.record
    if (record?.type === "assistant") {
      if (record.isApiErrorMessage || record.message.model === "<synthetic>" || record.isMeta) return []
      return node.blocks.flatMap((block): Transcript.Line[] => {
        if (block.type === "text" && block.text.trim() !== "") return [{ role: "assistant", text: block.text }]
        if (block.type === "tool_use")
          return [{ role: "tool-call", text: `${block.name}(${JSON.stringify(block.input ?? {})})` }]
        return []
      })
    }
    if (record?.type !== "user" || record.isMeta || record.isCompactSummary || record.usageLimitNote !== undefined)
      return []
    const results = node.blocks.flatMap((block): Transcript.Line[] =>
      block.type === "tool_result" ? [{ role: "tool-result", text: resultText(block.content ?? undefined) }] : [],
    )
    if (results.length > 0 || !byHuman(record.origin)) return results
    const text = said(node.blocks).text
    return text === "" ? [] : [{ role: "user", text }]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Titles and the lite read (SDK `_parse_session_info_from_lite`)

/** First lines the SDK never takes for the first prompt (`_SKIP_FIRST_PROMPT_PATTERN`, beyond the wrappers). */
const SKIP = /^(?:<session-start-hook>|<tick>|<goal>)/

/**
 * The title (09 §2.3): `custom-title` (the last record, else `custom-title.json`) > `ai-title` > `last-prompt` or the
 * legacy `summary` > the first meaningful human line. One line of at most {@link TITLE_MAX} characters; empty when the
 * conversation has none of them.
 */
export function title(input: Titles) {
  const named = [input.custom, input.file, input.ai]
    .map((value) => (value === undefined ? "" : Clean.oneLine(value, TITLE_MAX)))
    .find((value) => value !== "")
  if (named !== undefined) return named
  const prompt = [input.prompt, input.summary]
    .map((value) => (value === undefined ? "" : Clean.oneLine(Clean.human(value).text, TITLE_MAX)))
    .find((value) => value !== "")
  return prompt ?? input.first ?? ""
}

/** What the list needs of a conversation, read from its first and last 64 KiB only (SDK `_read_session_lite`). */
export interface Lite {
  /** A sub-agent transcript written at a project's top level: the list skips it. */
  readonly sidechain: boolean
  /** Every `cwd` and `relocatedCwd` seen, first to last: provisional membership (09 §2.2, §2.3). */
  readonly cwds: ReadonlyArray<string>
  readonly titles: Pick<Titles, "custom" | "ai" | "prompt" | "summary">
  readonly firstPrompt?: string
  readonly branch?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly versions: ReadonlyArray<string>
  /** The model of the last assistant record that is not a synthetic notice. */
  readonly model?: string
  /** `compact_boundary` records seen: a lower bound. */
  readonly compactions: number
}

const UserLine = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: Content }),
  origin: Origin,
})
const AssistantLine = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({ model: optional(Schema.NullOr(Schema.String)) }),
  isApiErrorMessage: optional(Schema.NullOr(Schema.Boolean)),
})
const decodeUserLine = Schema.decodeUnknownOption(UserLine)
const decodeAssistantLine = Schema.decodeUnknownOption(AssistantLine)

const VERSION = /^\d+\.\d+\.\d+/

/**
 * The lite fields of a conversation from `head` (its first 64 KiB) and `tail` (up to 64 KiB at its end, after the
 * head; empty for a small file). String fields are found without parsing JSON (`"key":"value"`), so a line longer
 * than the window still yields them; the first prompt and the model come from the complete lines of each window.
 */
export function lite(input: { readonly head: string; readonly tail: string }): Lite {
  const both = (key: string) => [...values(input.head, key), ...values(input.tail, key)]
  const headLines = input.head.split("\n")
  // The tail starts mid-line: its first piece is never a whole record.
  const tailLines = input.tail.split("\n").slice(1)
  const flag = headLines.find((line) => line.includes('"isSidechain"'))
  const createdAt = Date.parse(values(input.head, "timestamp")[0] ?? "")
  const updatedAt = Date.parse(both("timestamp").at(-1) ?? "")
  return {
    sidechain: flag !== undefined && /"isSidechain":\s?true/.test(flag),
    cwds: [...new Set([...cwdsOf(input.head), ...cwdsOf(input.tail)])],
    titles: {
      custom: both("customTitle").at(-1),
      ai: both("aiTitle").at(-1),
      prompt: both("lastPrompt").at(-1),
      summary: [...headLines, ...tailLines]
        .filter((line) => /"type":\s?"summary"/.test(line))
        .flatMap((line) => values(line, "summary"))
        .at(-1),
    },
    firstPrompt: firstLine(headLines),
    branch: both("gitBranch")
      .filter((value) => value !== "")
      .at(-1),
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
    versions: [...new Set(both("version").filter((value) => VERSION.test(value)))],
    model: [...headLines, ...tailLines]
      .filter((line) => line.includes('"assistant"'))
      .flatMap((line) => Option.toArray(Option.flatMap(decodeJson(line), decodeAssistantLine)))
      .flatMap((record) => (record.isApiErrorMessage ? [] : [record.message.model ?? "<synthetic>"]))
      .filter((value) => value !== "<synthetic>")
      .at(-1),
    compactions: count(input.head, '"compact_boundary"') + count(input.tail, '"compact_boundary"'),
  }
}

/**
 * The first meaningful human line (SDK `_extract_first_prompt_from_head`): user records that are not tool results,
 * meta or compact summaries, wrappers removed, the SDK's skip patterns applied; a slash command only as the fallback.
 */
function firstLine(lines: ReadonlyArray<string>) {
  const candidates = lines
    .filter(
      (line) =>
        /"type":\s?"user"/.test(line) &&
        !line.includes('"tool_result"') &&
        !/"isMeta":\s?true/.test(line) &&
        !/"isCompactSummary":\s?true/.test(line),
    )
    .flatMap((line) => Option.toArray(Option.flatMap(decodeJson(line), decodeUserLine)))
    .filter((record) => byHuman(record.origin))
    .flatMap((record) => blocks(record.message.content).blocks)
    .flatMap((block) => (block.type === "text" ? [Clean.human(block.text)] : []))
  const prompt = candidates.find((part) => part.text !== "" && !SKIP.test(part.text))
  if (prompt !== undefined) return Clean.oneLine(prompt.text, FIRST_PROMPT_MAX)
  const command = candidates.find((part) => part.command !== undefined)?.command
  return command === undefined ? undefined : Clean.oneLine(command, FIRST_PROMPT_MAX)
}

/** Every `cwd` and `relocatedCwd` value in `text`, found as substrings (the lite read and the confirm pass, 09 §2.3). */
export function cwdsOf(text: string) {
  return [...values(text, "cwd"), ...values(text, "relocatedCwd")]
}

function count(text: string, needle: string) {
  return text.split(needle).length - 1
}

/**
 * Every value of the JSON string field `key` in `text`, in order, without parsing the JSON (SDK
 * `_extract_json_string_field`): `"key":"value"` and `"key": "value"`. Inside a JSON string the quotes are escaped,
 * so a match is a key of some object of the line.
 */
export function values(text: string, key: string) {
  return [`"${key}":"`, `"${key}": "`]
    .flatMap((pattern) => {
      const found: Array<{ readonly at: number; readonly value: string }> = []
      for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + pattern.length)) {
        const start = at + pattern.length
        const close = closing(text, start)
        if (close === -1) break
        const raw = text.slice(start, close)
        found.push({ at, value: raw.includes("\\") ? Option.getOrElse(decodeString(`"${raw}"`), () => raw) : raw })
      }
      return found
    })
    .sort((a, b) => a.at - b.at)
    .map((item) => item.value)
}

/** The index of the quote that closes a JSON string starting at `start`, or -1. */
function closing(text: string, start: number) {
  for (let index = start; index < text.length; index++) {
    if (text[index] === '"') return index
    if (text[index] === "\\") index++
  }
  return -1
}

/** The file a `<persisted-output>` preview names (`tool-results/<name>`): its name only, opened on view demand. */
export function persisted(text: string) {
  const saved = /<persisted-output>[\s\S]*?saved to:?[ \t]*([^\r\n]+)/i.exec(text)?.[1]?.trim()
  const name = saved?.split(/[\\/]/).at(-1)
  return name !== undefined && FILE_NAME.test(name) ? name : undefined
}

/** A file name without separators: the only form of a `tool-results` name own opens. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

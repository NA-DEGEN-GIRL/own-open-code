export * as CodexTranscript from "./codex.js"

import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { FileDiff } from "@opencode/schema/file-diff"
import { Option, Schema } from "effect"
import { Transcript } from "./ir.js"

/**
 * Codex rollouts → {@link Transcript.Info} (09 §2.5). Pure: the reader in `sources/codex.ts` feeds it one JSONL line at
 * a time, so a `.zst` rollout is parsed while it is decoded and `info()` can be called at any point (the viewer's
 * outline grows while it streams, 09 §2.8). Every line is decoded once here with Effect Schema; unknown record kinds
 * and envelope fields are skipped and counted.
 *
 * Turns come from `response_item`s, which both history modes (legacy and paginated) persist: a real user message opens
 * a turn; assistant text, reasoning summaries, tool calls (paired with their outputs by `call_id`) and other agents'
 * hand-offs are its steps. `event_msg`s only add what the viewer shows beside them: turn ends, exit codes and per-file
 * diffs (paginated `item_completed`, legacy `patch_apply_end` / `exec_command_end`), rollbacks and sub-agent links.
 * Developer messages, the context Codex injects as user messages, encrypted reasoning and the encrypted remote
 * compaction item never enter the IR (IM-D5); they are counted in `dropped`.
 */

/** Codex's local compaction summary starts with this paragraph (`codex-rs/prompts/templates/compact/summary_prefix.md`). */
export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"

/** User-role text Codex injects in files without `content_item_kinds` (09 §2.5), matched at the start of an item. */
export const INJECTED_TAGS = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<recommended_plugins>",
  "<skill>",
  "<turn_aborted>",
] as const

/** The result a call gets when the record ends before its output (09 §2.5, same words as the Claude Code parser). */
export const INTERRUPTED = "interrupted before result was recorded"

/** `live`: the tool wrote the file within this long (v1 rule, 09 §2.5). */
export const LIVE_MS = 2 * 60 * 1000

/** Length of the list's title fallback and second line (09 §2.3). */
export const PROMPT_CHARS = 120

// ---------------------------------------------------------------------------------------------------------------
// Records (decoded once, here)

const nullable = <S extends Schema.Top>(schema: S) => optional(Schema.NullOr(schema))

const Raw = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** `{timestamp, type, payload, ordinal}`; `metadata` is Codex harness metadata beside a `response_item`. */
const Envelope = Schema.Struct({
  timestamp: nullable(Schema.String),
  type: Schema.String,
  payload: optional(Schema.Unknown),
  ordinal: nullable(NonNegativeInt),
  metadata: optional(Schema.Unknown),
})
type Envelope = typeof Envelope.Type
const ENVELOPE_KEYS = new Set(Object.keys(Envelope.fields))

const ThreadSpawn = Schema.Struct({
  parent_thread_id: nullable(Schema.String),
  agent_path: nullable(Schema.String),
  agent_nickname: nullable(Schema.String),
  agent_role: nullable(Schema.String),
})

/** `SessionSource`: `cli`, `vscode`, `exec`, `mcp`, `{custom}`, `{internal}` or `{subagent: …}`. */
const SessionSource = Schema.Union([
  Schema.String,
  Schema.Struct({
    subagent: optional(
      Schema.Union([
        Schema.String,
        Schema.Struct({ thread_spawn: nullable(ThreadSpawn), other: nullable(Schema.String) }),
      ]),
    ),
    internal: optional(Schema.Unknown),
    custom: nullable(Schema.String),
  }),
])
type SessionSource = typeof SessionSource.Type

const HistoryPosition = Schema.Struct({
  thread_id: Schema.String,
  end_ordinal_exclusive: nullable(NonNegativeInt),
  end_byte_offset: nullable(NonNegativeInt),
})

/** The fields of `session_meta` (with its flattened `git`) that own uses; the rest (instructions, tools) is ignored. */
const Meta = Schema.Struct({
  id: Schema.String,
  timestamp: nullable(Schema.String),
  cwd: nullable(Schema.String),
  originator: nullable(Schema.String),
  cli_version: nullable(Schema.String),
  source: optional(SessionSource),
  thread_source: nullable(Schema.String),
  model_provider: nullable(Schema.String),
  forked_from_id: nullable(Schema.String),
  parent_thread_id: nullable(Schema.String),
  agent_nickname: nullable(Schema.String),
  agent_role: nullable(Schema.String),
  agent_path: nullable(Schema.String),
  history_mode: nullable(Schema.String),
  history_base: nullable(HistoryPosition),
  subagent_history_start_ordinal: nullable(NonNegativeInt),
  git: nullable(Schema.Struct({ branch: nullable(Schema.String) })),
})
type Meta = typeof Meta.Type

const ContentItem = Schema.Struct({
  type: Schema.String,
  text: nullable(Schema.String),
  image_url: nullable(Schema.String),
})
type ContentItem = typeof ContentItem.Type

const Passthrough = Schema.Struct({
  turn_id: nullable(Schema.String),
  content_item_kinds: nullable(Schema.Array(Schema.NullOr(Schema.String))),
})

const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.String,
  content: Schema.Array(ContentItem),
  internal_chat_message_metadata_passthrough: nullable(Passthrough),
})
type Message = typeof Message.Type

const OutputValue = Schema.Union([
  Schema.String,
  Schema.Array(ContentItem),
  Schema.Struct({
    content: optional(Schema.Union([Schema.String, Schema.Array(ContentItem)])),
    success: nullable(Schema.Boolean),
  }),
])
type OutputValue = typeof OutputValue.Type

const Named = Schema.Struct({ name: nullable(Schema.String), tools: nullable(Schema.Array(Schema.Unknown)) })
const decodeNamed = Schema.decodeUnknownOption(Named)

const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  summary: nullable(Schema.Array(ContentItem)),
  content: nullable(Schema.Array(ContentItem)),
  encrypted_content: nullable(Schema.String),
})
const FunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  name: Schema.String,
  namespace: nullable(Schema.String),
  arguments: nullable(Schema.String),
  call_id: Schema.String,
})
const CustomCall = Schema.Struct({
  type: Schema.Literal("custom_tool_call"),
  name: Schema.String,
  input: nullable(Schema.String),
  call_id: Schema.String,
})
const CallOutput = Schema.Struct({
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
  call_id: Schema.String,
  output: optional(OutputValue),
})
const LocalShell = Schema.Struct({
  type: Schema.Literal("local_shell_call"),
  call_id: nullable(Schema.String),
  id: nullable(Schema.String),
  action: optional(Schema.Unknown),
})
const WebSearch = Schema.Struct({
  type: Schema.Literal("web_search_call"),
  status: nullable(Schema.String),
  action: optional(Schema.Unknown),
})
const ToolSearchCall = Schema.Struct({
  type: Schema.Literal("tool_search_call"),
  call_id: nullable(Schema.String),
  arguments: optional(Schema.Unknown),
})
const ToolSearchOutput = Schema.Struct({
  type: Schema.Literal("tool_search_output"),
  call_id: nullable(Schema.String),
  tools: nullable(Schema.Array(Schema.Unknown)),
})
const ImageGeneration = Schema.Struct({
  type: Schema.Literal("image_generation_call"),
  status: nullable(Schema.String),
  revised_prompt: nullable(Schema.String),
})
const AgentMessage = Schema.Struct({
  type: Schema.Literal("agent_message"),
  author: nullable(Schema.String),
  recipient: nullable(Schema.String),
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: nullable(Schema.String) })),
})
const EncryptedCompaction = Schema.Struct({ type: Schema.Literals(["compaction", "context_compaction"]) })
const Silent = Schema.Struct({ type: Schema.Literals(["additional_tools", "configuration_update"]) })

const Item = Schema.Union([
  Message,
  Reasoning,
  FunctionCall,
  CustomCall,
  CallOutput,
  LocalShell,
  WebSearch,
  ToolSearchCall,
  ToolSearchOutput,
  ImageGeneration,
  AgentMessage,
  EncryptedCompaction,
  Silent,
])
type Item = typeof Item.Type

/** Per-path change of a Codex FileChange / `patch_apply_end`: internally tagged, or externally in older versions. */
const Change = Schema.Union([
  Schema.Struct({
    type: Schema.String,
    unified_diff: nullable(Schema.String),
    content: nullable(Schema.String),
    move_path: nullable(Schema.String),
  }),
  Schema.Struct({ add: Schema.Struct({ content: nullable(Schema.String) }) }),
  Schema.Struct({ delete: Schema.Struct({ content: nullable(Schema.String) }) }),
  Schema.Struct({
    update: Schema.Struct({ unified_diff: nullable(Schema.String), move_path: nullable(Schema.String) }),
  }),
])
type Change = typeof Change.Type
const Changes = Schema.Record(Schema.String, Change)

const Usage = Schema.Struct({
  input_tokens: nullable(NonNegativeInt),
  cached_input_tokens: nullable(NonNegativeInt),
  output_tokens: nullable(NonNegativeInt),
})

const TurnBoundary = Schema.Struct({
  type: Schema.Literals(["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted"]),
  turn_id: nullable(Schema.String),
})
const ErrorEvent = Schema.Struct({ type: Schema.Literal("error") })
const RolledBack = Schema.Struct({ type: Schema.Literal("thread_rolled_back"), num_turns: NonNegativeInt })
const TokenCount = Schema.Struct({
  type: Schema.Literal("token_count"),
  info: nullable(Schema.Struct({ total_token_usage: nullable(Usage) })),
})
const SettingsApplied = Schema.Struct({
  type: Schema.Literal("thread_settings_applied"),
  thread_settings: Schema.Struct({
    model: nullable(Schema.String),
    model_provider_id: nullable(Schema.String),
    cwd: nullable(Schema.String),
  }),
})
const ItemCompleted = Schema.Struct({
  type: Schema.Literal("item_completed"),
  item: Schema.Struct({
    type: Schema.String,
    id: nullable(Schema.String),
    exit_code: nullable(Schema.Int),
    changes: nullable(Changes),
    agent_thread_id: nullable(Schema.String),
    agent_path: nullable(Schema.String),
  }),
})
const PatchApplyEnd = Schema.Struct({
  type: Schema.Literal("patch_apply_end"),
  call_id: Schema.String,
  changes: nullable(Changes),
})
const ExecEnd = Schema.Struct({
  type: Schema.Literal("exec_command_end"),
  call_id: Schema.String,
  exit_code: nullable(Schema.Int),
})
const SubAgentActivity = Schema.Struct({
  type: Schema.Literal("sub_agent_activity"),
  agent_thread_id: Schema.String,
  agent_path: nullable(Schema.String),
})

/** The `event_msg`s the parser reads; every other event is UI traffic and is skipped without counting. */
const Event = Schema.Union([
  TurnBoundary,
  ErrorEvent,
  RolledBack,
  TokenCount,
  SettingsApplied,
  ItemCompleted,
  PatchApplyEnd,
  ExecEnd,
  SubAgentActivity,
])
type Event = typeof Event.Type

const TurnContext = Schema.Struct({
  turn_id: nullable(Schema.String),
  cwd: nullable(Schema.String),
  model: nullable(Schema.String),
  model_provider: nullable(Schema.String),
})

const TokenUsageRecord = Schema.Struct({
  served_by: nullable(Schema.Struct({ provider_id: nullable(Schema.String), model: nullable(Schema.String) })),
})

const Compacted = Schema.Struct({
  message: nullable(Schema.String),
  replacement_history: nullable(Schema.Array(Schema.Unknown)),
})

const Typed = Schema.Struct({ type: Schema.String })

/** Record kinds that carry nothing for the transcript and are skipped without counting. */
const QUIET = new Set([
  "world_state",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "retained_context",
  "security_risk_score",
  "realtime_item",
])

const decodeRaw = Schema.decodeUnknownOption(Raw)
const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodeStrict = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope), { onExcessProperty: "error" })
const decodeMeta = Schema.decodeUnknownOption(Meta)
const decodeTyped = Schema.decodeUnknownOption(Typed)
const decodeMessage = Schema.decodeUnknownOption(Message)
const decodeTurnContext = Schema.decodeUnknownOption(TurnContext)
const decodeTokenUsage = Schema.decodeUnknownOption(TokenUsageRecord)
const decodeCompacted = Schema.decodeUnknownOption(Compacted)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))
const decodeSource = Schema.decodeUnknownOption(SessionSource)
const decodeSourceJson = Schema.decodeUnknownOption(Schema.fromJsonString(SessionSource))

type Decoder<T> = (input: unknown) => Option.Option<T>

/**
 * Decoders by `type`: a payload is decoded by its own member schema, never by trying a union's members in turn
 * (failed attempts dominate the cost on large rollouts). A type without an entry is unknown (items) or ignored
 * (events).
 */
function byType<T>(
  entries: ReadonlyArray<readonly [ReadonlyArray<string>, Decoder<T>]>,
): ReadonlyMap<string, Decoder<T>> {
  return new Map(entries.flatMap((entry) => entry[0].map((type) => [type, entry[1]] as const)))
}

const ITEMS = byType<Item>([
  [["message"], decodeMessage],
  [["reasoning"], Schema.decodeUnknownOption(Reasoning)],
  [["function_call"], Schema.decodeUnknownOption(FunctionCall)],
  [["custom_tool_call"], Schema.decodeUnknownOption(CustomCall)],
  [["function_call_output", "custom_tool_call_output"], Schema.decodeUnknownOption(CallOutput)],
  [["local_shell_call"], Schema.decodeUnknownOption(LocalShell)],
  [["web_search_call"], Schema.decodeUnknownOption(WebSearch)],
  [["tool_search_call"], Schema.decodeUnknownOption(ToolSearchCall)],
  [["tool_search_output"], Schema.decodeUnknownOption(ToolSearchOutput)],
  [["image_generation_call"], Schema.decodeUnknownOption(ImageGeneration)],
  [["agent_message"], Schema.decodeUnknownOption(AgentMessage)],
  [["compaction", "context_compaction"], Schema.decodeUnknownOption(EncryptedCompaction)],
  [["additional_tools", "configuration_update"], Schema.decodeUnknownOption(Silent)],
])

const EVENTS = byType<Event>([
  [
    ["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted"],
    Schema.decodeUnknownOption(TurnBoundary),
  ],
  [["error"], Schema.decodeUnknownOption(ErrorEvent)],
  [["thread_rolled_back"], Schema.decodeUnknownOption(RolledBack)],
  [["token_count"], Schema.decodeUnknownOption(TokenCount)],
  [["thread_settings_applied"], Schema.decodeUnknownOption(SettingsApplied)],
  [["item_completed"], Schema.decodeUnknownOption(ItemCompleted)],
  [["patch_apply_end"], Schema.decodeUnknownOption(PatchApplyEnd)],
  [["exec_command_end"], Schema.decodeUnknownOption(ExecEnd)],
  [["sub_agent_activity"], Schema.decodeUnknownOption(SubAgentActivity)],
])

/**
 * The envelope of one JSONL line and how many of its top-level keys own does not know; `undefined`: not a record.
 * Lines with only known keys take one strict decode; the others are decoded once more to count the extra keys.
 */
function envelopeOf(text: string): { readonly envelope: Envelope; readonly extra: number } | undefined {
  const strict = Option.getOrUndefined(decodeStrict(text))
  if (strict !== undefined) return { envelope: strict, extra: 0 }
  const raw = Option.getOrUndefined(decodeRaw(text))
  const envelope = raw && Option.getOrUndefined(decodeEnvelope(raw))
  if (raw === undefined || envelope === undefined) return undefined
  return { envelope, extra: Object.keys(raw).filter((key) => !ENVELOPE_KEYS.has(key)).length }
}

// ---------------------------------------------------------------------------------------------------------------
// The conversation's head (first line, 09 §2.3)

/** What the list needs from a rollout's first line (`session_meta`) and the first real user request after it. */
export interface Head {
  /** The thread id (`session_meta.id`). */
  readonly id: string
  readonly time?: number
  readonly cwd?: string
  readonly cliVersion?: string
  readonly originator?: string
  /** `source` as the list shows it: `cli`, `vscode`, `exec`, `mcp`, a custom name, `subagent` or `internal`. */
  readonly app?: string
  /** A sub-agent (or Codex-internal) thread: hidden from the list and folded under its parent (09 §2.5). */
  readonly subagent: boolean
  /** The thread a sub-agent was spawned from, or the thread a fork was made from. */
  readonly parentID?: string
  /** A sub-agent's path, nickname or role. */
  readonly agent?: string
  readonly provider?: string
  readonly historyMode?: string
  /** `history_base`: this rollout continues the first records of another rollout file (09 §2.5). */
  readonly base?: { readonly rolloutID: string; readonly endOrdinal?: number; readonly endByteOffset?: number }
  /** `subagent_history_start_ordinal`: records before it are context inherited from the parent. */
  readonly subagentStart?: number
  readonly branch?: string
  /** The first real user request, at most {@link PROMPT_CHARS} characters, when it lies in the head window. */
  readonly firstPrompt?: string
}

/**
 * The head of a rollout from its first bytes (09 §2.3): `lines` are the complete lines of the window, `partial` the
 * first line when it did not end inside the window (its leading scalar fields are still read). `undefined`: not a
 * Codex rollout. Records before `subagent_history_start_ordinal` are inherited and never give the first prompt.
 */
export function head(input: { readonly lines: ReadonlyArray<string>; readonly partial?: string }): Head | undefined {
  const first = input.lines[0]
  if (first === undefined) return input.partial === undefined ? undefined : prefixHead(input.partial)
  const envelope = envelopeOf(first)?.envelope
  if (envelope?.type !== "session_meta") return undefined
  const meta = Option.getOrUndefined(decodeMeta(envelope.payload))
  if (meta === undefined) return undefined
  const base = headOf(meta)
  const prompt = input.lines.slice(1).reduce<string | undefined>((found, line, index) => {
    if (found !== undefined) return found
    const record = envelopeOf(line)?.envelope
    if (record?.type !== "response_item") return undefined
    if (base.subagentStart !== undefined && (record.ordinal ?? index + 1) < base.subagentStart) return undefined
    const message = Option.getOrUndefined(decodeMessage(record.payload))
    if (message?.role !== "user") return undefined
    return firstLine(userContent(message).text)
  }, undefined)
  return { ...base, firstPrompt: prompt }
}

/** {@link Head} fields of a decoded `session_meta`. */
function headOf(meta: Meta): Head {
  const kind = sourceKind(meta.source, meta.thread_source ?? undefined)
  const time = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN
  return {
    id: meta.id,
    time: Number.isFinite(time) ? time : undefined,
    cwd: meta.cwd || undefined,
    cliVersion: meta.cli_version || undefined,
    originator: meta.originator ?? undefined,
    app: kind.app,
    subagent: kind.subagent,
    parentID: kind.parentID ?? meta.parent_thread_id ?? meta.forked_from_id ?? undefined,
    agent: kind.agent ?? meta.agent_path ?? meta.agent_nickname ?? meta.agent_role ?? undefined,
    provider: meta.model_provider ?? undefined,
    historyMode: meta.history_mode ?? undefined,
    base: meta.history_base
      ? {
          rolloutID: meta.history_base.thread_id,
          endOrdinal: meta.history_base.end_ordinal_exclusive ?? undefined,
          endByteOffset: meta.history_base.end_byte_offset ?? undefined,
        }
      : undefined,
    subagentStart: meta.subagent_history_start_ordinal ?? undefined,
    branch: meta.git?.branch ?? undefined,
  }
}

/**
 * The leading scalar fields of a first line longer than the head window. Codex writes them before the large
 * `base_instructions` and `dynamic_tools`, so id, cwd, version, source and parent survive the cut.
 */
function prefixHead(partial: string): Head | undefined {
  const at = partial.indexOf('"payload":')
  if (at === -1 || !partial.slice(0, at).includes('"type":"session_meta"')) return undefined
  const body = partial.slice(at)
  const field = (name: string) => {
    const match = new RegExp(`"${name}":("(?:[^"\\\\]|\\\\.)*")`).exec(body)
    return match ? Option.getOrUndefined(decodeString(match[1])) : undefined
  }
  const id = field("id")
  if (id === undefined) return undefined
  const time = Date.parse(field("timestamp") ?? "")
  const app = field("source")
  const subagent = app === undefined && body.includes('"source":{"subagent"')
  return {
    id,
    time: Number.isFinite(time) ? time : undefined,
    cwd: field("cwd"),
    cliVersion: field("cli_version"),
    originator: field("originator"),
    app: subagent ? "subagent" : app,
    subagent,
    parentID: field("parent_thread_id") ?? field("forked_from_id"),
    provider: field("model_provider"),
  }
}

/**
 * How a `SessionSource` (the rollout's object or the state DB's `source` text) is listed: the app name, whether it is
 * a sub-agent or Codex-internal thread, and a sub-agent's parent and agent name. `threadSource` is the DB's or the
 * meta's `thread_source` (`subagent` marks a sub-agent).
 */
export function sourceKind(source: unknown, threadSource?: string) {
  const decoded =
    typeof source === "string" && source.startsWith("{")
      ? Option.getOrUndefined(decodeSourceJson(source))
      : Option.getOrUndefined(decodeSource(source))
  const kind = describe(decoded)
  return { ...kind, subagent: kind.subagent || threadSource === "subagent" }
}

function describe(source: SessionSource | undefined): {
  app?: string
  subagent: boolean
  parentID?: string
  agent?: string
} {
  if (source === undefined) return { subagent: false }
  if (typeof source === "string") return { app: source, subagent: false }
  if (source.subagent !== undefined) {
    const spawn = typeof source.subagent === "string" ? undefined : (source.subagent.thread_spawn ?? undefined)
    return {
      app: "subagent",
      subagent: true,
      parentID: spawn?.parent_thread_id ?? undefined,
      agent: spawn?.agent_path ?? spawn?.agent_nickname ?? spawn?.agent_role ?? undefined,
    }
  }
  if (source.internal !== undefined) return { app: "internal", subagent: true }
  return { app: source.custom ?? undefined, subagent: false }
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

/** Whether a user-role text item is context Codex injected (09 §2.5) or its own compaction summary. */
export function injected(text: string) {
  const start = text.trimStart()
  return INJECTED_TAGS.some((tag) => start.startsWith(tag)) || start.startsWith(`${SUMMARY_PREFIX}\n`)
}

/** The summary of a local compaction without {@link SUMMARY_PREFIX}; a text without the prefix is kept whole. */
export function stripSummaryPrefix(message: string) {
  const at = message.indexOf(SUMMARY_PREFIX)
  if (at === -1 || message.slice(0, at).trim() !== "") return message.trim()
  return message.slice(at + SUMMARY_PREFIX.length).trim()
}

/** The first non-empty line, cut to {@link PROMPT_CHARS} characters (whole code points). */
export function firstLine(text: string) {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "")
  return line === undefined ? undefined : Array.from(line).slice(0, PROMPT_CHARS).join("")
}

/**
 * The human's part of a user message (09 §2.5). With `content_item_kinds` each item is kept only when its kind is
 * `user.*` (text, images): injected items (`agents_md.*`, `environments.*`, `plugins.*`, …) go, so a message mixing a
 * prompt, an image and injected context keeps the first two. Without kinds (older files) the leading-tag deny list
 * decides per text item. `injected` counts the items left out.
 */
function userContent(message: Message) {
  const kinds = message.internal_chat_message_metadata_passthrough?.content_item_kinds ?? undefined
  const kept = message.content.filter((item, index) => {
    const kind = kinds?.[index]
    if (typeof kind === "string") return kind.startsWith("user.") && !(item.text && injected(item.text))
    return !(item.type === "input_text" && item.text && injected(item.text))
  })
  const text = kept
    .flatMap((item) => ((item.type === "input_text" || item.type === "text") && item.text ? [item.text] : []))
    .join("\n")
  const images = kept.flatMap((item) => (item.type === "input_image" && item.image_url ? [image(item.image_url)] : []))
  return { text, images, injected: message.content.length - kept.length }
}

/** A user image from its `data:` URL (bytes kept for the migration) or a link (size unknown). */
function image(url: string): Transcript.Image {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url)
  if (!match) return { mime: "image/unknown", bytes: 0 }
  const data = match[2]
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return { mime: match[1], bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding), data }
}

function imageNote(url: string) {
  const item = image(url)
  return `[image: ${item.mime}, ${Math.max(1, Math.round(item.bytes / 1024))} KB]`
}

function contentText(items: ReadonlyArray<ContentItem>) {
  return items
    .flatMap((item) => {
      if (item.type === "input_image" && item.image_url) return [imageNote(item.image_url)]
      return item.text ? [item.text] : []
    })
    .join("\n")
}

/** A tool result as the model saw it: a string, content items, or (older files) `{content, success}`. */
function output(value: OutputValue | undefined): Transcript.Output {
  if (value === undefined) return { text: "", error: false }
  if (typeof value === "string") return { text: value, error: false }
  if (items(value)) return { text: contentText(value), error: false }
  const content = value.content
  const text = content === undefined ? "" : typeof content === "string" ? content : contentText(content)
  return { text, error: value.success === false }
}

// `Array.isArray` does not narrow a readonly array out of a union.
function items(value: OutputValue): value is ReadonlyArray<ContentItem> {
  return Array.isArray(value)
}

/** Per-file diffs for the viewer (FileDiff.Info), from a FileChange or `patch_apply_end` change map. */
function diffs(changes: Readonly<Record<string, Change>>): FileDiff.Info[] {
  return Object.entries(changes).map(([file, change]) => {
    const normalized = normalizeChange(change)
    const patch =
      normalized.diff ??
      (normalized.kind === "added"
        ? lines("+", normalized.content)
        : normalized.kind === "deleted"
          ? lines("-", normalized.content)
          : "")
    const counted = patch.split("\n").reduce(
      (sum, line) => ({
        additions: sum.additions + (line.startsWith("+") && !line.startsWith("+++") ? 1 : 0),
        deletions: sum.deletions + (line.startsWith("-") && !line.startsWith("---") ? 1 : 0),
      }),
      { additions: 0, deletions: 0 },
    )
    return { file: normalized.move ?? file, patch, ...counted, status: normalized.kind }
  })
}

function normalizeChange(change: Change): {
  kind: FileDiff.Info["status"]
  diff?: string
  content: string
  move?: string
} {
  if ("add" in change) return { kind: "added", content: change.add.content ?? "" }
  if ("delete" in change) return { kind: "deleted", content: change.delete.content ?? "" }
  if ("update" in change)
    return {
      kind: "modified",
      diff: change.update.unified_diff ?? undefined,
      content: "",
      move: change.update.move_path ?? undefined,
    }
  const kind = change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified"
  return {
    kind,
    diff: change.unified_diff ?? undefined,
    content: change.content ?? "",
    move: change.move_path ?? undefined,
  }
}

function lines(sign: "+" | "-", content: string) {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content
  if (body === "") return ""
  const all = body.split("\n")
  const header = sign === "+" ? `@@ -0,0 +1,${all.length} @@` : `@@ -1,${all.length} +0,0 @@`
  return [header, ...all.map((line) => `${sign}${line}`)].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// The parser

export interface Start {
  readonly rootID: string
  /** The rollout file (the current one of its thread). */
  readonly path: string
  /** Its size on disk. */
  readonly bytes: number
  readonly mtimeMs: number
  /** For `live` (09 §2.5). */
  readonly now: number
  /**
   * The rollout's own `session_meta`, when the reader knows it before the records: always when it reads a
   * `history_base` prefix first, because the prefix's records are judged by this thread's sub-agent start.
   */
  readonly head?: Head
  /** The index title (`session_index.jsonl` name, the DB's `name` or `title`); default: the first real user line. */
  readonly title?: string
}

/** Where a line came from: its 0-based line number in its file, and whether it is the `history_base` prefix. */
export interface At {
  readonly line: number
  readonly base?: boolean
  /** The file ended inside this line: it is ignored (and counted) unless it still decodes whole. */
  readonly torn?: boolean
}

interface Draft {
  user: Transcript.User
  time: number
  steps: Transcript.Step[]
  end?: Transcript.End
  /** Codex's own turn id (`task_started`, the message metadata), for rollback and turn ends. */
  codex?: string
}

interface CallRef {
  readonly draft: Draft
  readonly step: number
}

export type Parser = ReturnType<typeof parser>

/**
 * A streaming parser for one rollout (plus, for I2, its `history_base` prefix first). `push` takes one JSONL line;
 * `drop` counts lines the reader could not hand over (`oversizedLine`, `tornLine`); `info` builds the transcript of
 * everything pushed so far without changing the parser, so it can be called while the file streams.
 */
export function parser(start: Start) {
  const state = {
    self: start.head,
    metas: 0,
    drafts: [] as Draft[],
    checkpoints: [] as Transcript.Checkpoint[],
    children: [] as Transcript.ChildRef[],
    dropped: {} as Transcript.Dropped,
    calls: new Map<string, CallRef>(),
    models: [] as Transcript.Model[],
    model: undefined as string | undefined,
    cwds: [] as string[],
    versions: [] as string[],
    firstTime: Number.NaN,
    lastTime: Number.NaN,
    codexTurn: undefined as string | undefined,
    firstPrompt: undefined as string | undefined,
    usage: undefined as Transcript.Usage | undefined,
    parentID: undefined as string | undefined,
  }
  if (start.head) adopt(start.head)

  function drop(kind: Transcript.DropKind, count = 1) {
    if (count > 0) state.dropped = Transcript.drop(state.dropped, kind, count)
  }

  function adopt(meta: Head) {
    if (meta.cliVersion && !state.versions.includes(meta.cliVersion)) state.versions.push(meta.cliVersion)
    if (meta.cwd) addCwd(meta.cwd)
    if (meta.time !== undefined && Number.isNaN(state.firstTime)) state.firstTime = meta.time
  }

  function addCwd(cwd: string) {
    const key = cwd
      .replace(/^\\\\\?\\/, "")
      .replaceAll("/", "\\")
      .toLowerCase()
    if (
      !state.cwds.some(
        (known) =>
          known
            .replace(/^\\\\\?\\/, "")
            .replaceAll("/", "\\")
            .toLowerCase() === key,
      )
    )
      state.cwds.push(cwd)
  }

  function useModel(id: string, provider: string | undefined) {
    state.model = id
    state.models = [
      ...state.models.filter((item) => !(item.id === id && item.provider === provider)),
      omitUndefined({ provider, id }),
    ]
  }

  function current(time: number) {
    const last = state.drafts.at(-1)
    if (last) return last
    // Steps before the first real user message (a fork's own beginning): they open a turn without a request.
    const draft: Draft = { user: { text: "", images: [] }, time, steps: [] }
    state.drafts.push(draft)
    return draft
  }

  function step(value: Transcript.Step) {
    const draft = current(value.time)
    draft.steps.push(value)
    return { draft, step: draft.steps.length - 1 }
  }

  function call(id: string | undefined, value: Transcript.ToolStep) {
    const ref = step(value)
    if (id) state.calls.set(id, ref)
  }

  function patch(id: string | null | undefined, change: (tool: Transcript.ToolStep) => Transcript.ToolStep) {
    const ref = id ? state.calls.get(id) : undefined
    const tool = ref?.draft.steps[ref.step]
    if (ref === undefined || tool?.type !== "tool") return
    ref.draft.steps[ref.step] = change(tool)
  }

  function child(id: string, agent: string | undefined) {
    if (state.children.some((item) => item.id === id)) return
    const draft = state.drafts.at(-1)
    const at = draft ? { turn: state.drafts.length - 1, step: draft.steps.length } : undefined
    state.children.push(omitUndefined({ id, agent, at }))
    // The spawn call that started it, when it is the latest one without a child.
    const index = draft?.steps.findLastIndex((item) => item.type === "tool" && /spawn/i.test(item.name)) ?? -1
    const spawn = draft?.steps[index]
    if (draft && spawn?.type === "tool" && spawn.child === undefined) draft.steps[index] = { ...spawn, child: id }
  }

  function end(turnID: string | null | undefined, status: Transcript.End) {
    const draft = turnID
      ? (state.drafts.findLast((item) => item.codex === turnID) ?? state.drafts.at(-1))
      : state.drafts.at(-1)
    if (draft === undefined) return
    // An interruption or error stays: Codex still completes the task afterwards.
    if (draft.end === "interrupted" || draft.end === "error") return
    draft.end = status
  }

  /** `thread_rolled_back{num_turns}`: the newest N of Codex's turns leave the history (09 §2.5). */
  function rollback(count: number) {
    const keys = state.drafts.map((draft, index) => draft.codex ?? `#${index}`)
    const removed = [...new Set(keys.toReversed())].slice(0, count)
    const keep = keys.findIndex((key) => removed.includes(key))
    if (keep === -1) return
    drop("rolledBack", state.drafts.length - keep)
    state.drafts = state.drafts.slice(0, keep)
    state.checkpoints = state.checkpoints.filter((item) => item.at.turn < keep)
    state.children = state.children.map((item) =>
      item.at !== undefined && item.at.turn >= keep
        ? omitUndefined({ id: item.id, agent: item.agent, title: item.title })
        : item,
    )
  }

  function item(payload: unknown, time: number) {
    const typed = Option.getOrUndefined(decodeTyped(payload))
    const decode = typed && ITEMS.get(typed.type)
    if (decode === undefined) return drop("unknownRecord")
    const value = Option.getOrUndefined(decode(payload))
    if (value === undefined) return drop("decodeFailed")
    handle(value, time)
  }

  function handle(value: Item, time: number) {
    switch (value.type) {
      case "message":
        return message(value, time)
      case "reasoning": {
        if (value.encrypted_content) drop("encryptedReasoning")
        const text = contentText(value.summary ?? []) || contentText(value.content ?? [])
        if (text) step({ type: "reasoning-summary", text, time })
        return
      }
      case "function_call": {
        const name =
          value.namespace && !value.name.startsWith(value.namespace) ? `${value.namespace}.${value.name}` : value.name
        const input = value.arguments ? Option.getOrElse(decodeJson(value.arguments), () => value.arguments) : {}
        return call(value.call_id, { type: "tool", name, input, time })
      }
      case "custom_tool_call":
        return call(value.call_id, { type: "tool", name: value.name, input: value.input ?? "", time })
      case "function_call_output":
      case "custom_tool_call_output":
        return patch(value.call_id, (tool) => ({ ...tool, output: output(value.output) }))
      case "local_shell_call":
        return call(value.call_id ?? value.id ?? undefined, {
          type: "tool",
          name: "local_shell",
          input: value.action ?? {},
          time,
        })
      case "web_search_call":
        return call(undefined, {
          type: "tool",
          name: "web_search",
          input: value.action ?? {},
          output: { text: "", error: value.status === "failed" },
          time,
        })
      case "tool_search_call":
        return call(value.call_id ?? undefined, {
          type: "tool",
          name: "tool_search",
          input: value.arguments ?? {},
          time,
        })
      case "tool_search_output":
        return patch(value.call_id, (tool) => ({
          ...tool,
          output: { text: toolNames(value.tools ?? []), error: false },
        }))
      case "image_generation_call":
        return call(undefined, {
          type: "tool",
          name: "image_generation",
          input: value.revised_prompt ? { prompt: value.revised_prompt } : {},
          output: { text: "[image generated]", error: value.status === "failed" },
          time,
        })
      case "agent_message": {
        // Another agent's hand-off: readable parts become a note; encrypted parts are provider state (09 §2.7).
        drop("encryptedReasoning", value.content.filter((part) => part.type === "encrypted_content").length)
        const text = value.content.flatMap((part) => (part.text ? [part.text] : [])).join("\n")
        if (text)
          step({ type: "note", text: `${value.author ?? "agent"} → ${value.recipient ?? "agent"}: ${text}`, time })
        return
      }
      case "compaction":
      case "context_compaction":
        return drop("remoteCompaction")
      case "additional_tools":
      case "configuration_update":
        return
    }
  }

  function message(value: Message, time: number) {
    if (value.role === "user") return userMessage(value, time)
    if (value.role !== "assistant") return drop("developerMessage")
    const text = value.content.flatMap((part) => (part.text ? [part.text] : [])).join("\n")
    if (text) step(omitUndefined({ type: "text", text, time, model: state.model }))
  }

  function userMessage(value: Message, time: number) {
    const content = userContent(value)
    drop("injectedContext", content.injected)
    if (content.text.trim() === "" && content.images.length === 0) return
    const last = state.drafts.at(-1)
    if (last !== undefined && last.end === undefined && last.steps.length > 0) last.end = "completed"
    state.drafts.push({
      user: { text: content.text, images: content.images },
      time,
      steps: [],
      codex: value.internal_chat_message_metadata_passthrough?.turn_id ?? state.codexTurn,
    })
    state.firstPrompt ??= firstLine(content.text)
  }

  function event(payload: unknown) {
    const decode = Option.getOrUndefined(decodeTyped(payload).pipe(Option.map((typed) => EVENTS.get(typed.type))))
    const value = decode && Option.getOrUndefined(decode(payload))
    if (value === undefined) return
    switch (value.type) {
      case "task_started":
      case "turn_started":
        state.codexTurn = value.turn_id ?? undefined
        return
      case "task_complete":
      case "turn_complete":
        return end(value.turn_id, "completed")
      case "turn_aborted":
        return end(value.turn_id, "interrupted")
      case "error":
        return end(undefined, "error")
      case "thread_rolled_back":
        return rollback(value.num_turns)
      case "token_count": {
        const total = value.info?.total_token_usage
        if (total)
          state.usage = {
            input: total.input_tokens ?? 0,
            output: total.output_tokens ?? 0,
            cached: total.cached_input_tokens ?? 0,
          }
        return
      }
      case "thread_settings_applied": {
        const settings = value.thread_settings
        if (settings.model) useModel(settings.model, settings.model_provider_id ?? state.self?.provider)
        if (settings.cwd) addCwd(settings.cwd)
        return
      }
      case "item_completed": {
        const done = value.item
        if (done.type === "CommandExecution" && done.exit_code != null) {
          const exit = done.exit_code
          return patch(done.id, (tool) => ({ ...tool, exit }))
        }
        if (done.type === "FileChange" && done.changes) {
          const diff = diffs(done.changes)
          return patch(done.id, (tool) => ({ ...tool, diff }))
        }
        if (done.type === "SubAgentActivity" && done.agent_thread_id)
          return child(done.agent_thread_id, done.agent_path ?? undefined)
        return
      }
      case "patch_apply_end": {
        if (!value.changes) return
        const diff = diffs(value.changes)
        return patch(value.call_id, (tool) => ({ ...tool, diff }))
      }
      case "exec_command_end": {
        const exit = value.exit_code
        if (exit == null) return
        return patch(value.call_id, (tool) => ({ ...tool, exit }))
      }
      case "sub_agent_activity":
        return child(value.agent_thread_id, value.agent_path ?? undefined)
    }
  }

  /**
   * `compacted`: a checkpoint right after this record, inside the current turn after its steps so far (09 §2.5).
   * A non-empty `message` is a local summary (`foreign`); otherwise the summary is OpenAI's encrypted `compaction`
   * item (`codex-remote`). `recent` is the user requests Codex kept in `replacement_history`, without the summary item
   * and the start context it re-injected.
   */
  function compacted(payload: unknown, ordinal: number) {
    const value = Option.getOrUndefined(decodeCompacted(payload))
    if (value === undefined) return drop("decodeFailed")
    const history = value.replacement_history ?? []
    const encrypted = history.filter((entry) => {
      const typed = Option.getOrUndefined(decodeTyped(entry))
      return typed?.type === "compaction" || typed?.type === "context_compaction"
    }).length
    drop("remoteCompaction", encrypted)
    const recent = history.flatMap((entry): Transcript.Line[] => {
      const kept = Option.getOrUndefined(decodeMessage(entry))
      if (kept?.role !== "user") return []
      const text = userContent(kept).text
      return text.trim() === "" ? [] : [{ role: "user", text }]
    })
    const summary = value.message?.trim() ? stripSummaryPrefix(value.message) : undefined
    const draft = state.drafts.at(-1)
    state.checkpoints.push(
      omitUndefined({
        at: { turn: Math.max(0, state.drafts.length - 1), step: draft?.steps.length ?? 0, source: { ordinal } },
        kind: summary === undefined ? "codex-remote" : "foreign",
        summary,
        recent,
      }),
    )
  }

  function push(text: string, at: At) {
    const decoded = envelopeOf(text)
    if (decoded === undefined) return drop(at.torn ? "tornLine" : "decodeFailed")
    drop("unknownField", decoded.extra)
    const envelope = decoded.envelope
    const time = envelope.timestamp ? Date.parse(envelope.timestamp) : Number.NaN
    const ordinal = envelope.ordinal ?? at.line
    if (envelope.type === "session_meta") return meta(envelope.payload, at)
    if (at.base && state.self?.base?.endOrdinal !== undefined && ordinal >= state.self.base.endOrdinal) return
    const start = state.self?.subagentStart
    if (start !== undefined && ordinal < start) {
      // Context a fork or sub-agent inherited from its parent (09 §2.5).
      if (envelope.type === "response_item" || envelope.type === "compacted") drop("inheritedContext")
      return
    }
    if (Number.isFinite(time)) {
      if (Number.isNaN(state.firstTime)) state.firstTime = time
      state.lastTime = time
    }
    switch (envelope.type) {
      case "response_item":
        return item(envelope.payload, time)
      case "event_msg":
        return event(envelope.payload)
      case "compacted":
        return compacted(envelope.payload, ordinal)
      case "turn_context": {
        const context = Option.getOrUndefined(decodeTurnContext(envelope.payload))
        if (context?.turn_id) state.codexTurn = context.turn_id
        if (context?.model) useModel(context.model, context.model_provider ?? state.self?.provider)
        if (context?.cwd) addCwd(context.cwd)
        return
      }
      case "token_usage_record": {
        const served = Option.getOrUndefined(decodeTokenUsage(envelope.payload))?.served_by
        if (served?.model && state.model === undefined)
          useModel(served.model, served.provider_id ?? state.self?.provider)
        return
      }
      default:
        if (!QUIET.has(envelope.type)) drop("unknownRecord")
    }
  }

  /** The first `session_meta` of the file is the thread itself; the second is its parent (forks, sub-agents). */
  function meta(payload: unknown, at: At) {
    if (at.base) return
    state.metas += 1
    const decoded = Option.getOrUndefined(decodeMeta(payload))
    if (decoded === undefined) return drop("decodeFailed")
    if (state.metas === 1) {
      state.self ??= headOf(decoded)
      adopt(state.self)
      return
    }
    if (state.metas === 2) state.parentID = decoded.id
  }

  function info(): Transcript.Info {
    const createdAt = [state.self?.time, state.firstTime, start.mtimeMs].find(
      (time): time is number => time !== undefined && Number.isFinite(time),
    )
    const turns = Transcript.repairTimes(
      state.drafts.map((draft, index) => ({
        index,
        time: draft.time,
        user: draft.user,
        // A call without a result in the record (09 §2.5).
        steps: draft.steps.map((value) =>
          value.type === "tool" && value.output === undefined
            ? { ...value, output: { text: INTERRUPTED, error: true } }
            : value,
        ),
        end: draft.end ?? (index === state.drafts.length - 1 ? "open" : "completed"),
      })),
      createdAt ?? 0,
    )
    const self = state.self
    const base = self?.base
    return omitUndefined({
      source: omitUndefined({
        kind: "codex",
        id: self?.id ?? "",
        rootID: start.rootID,
        path: start.path,
        versions: [...state.versions],
        app: self?.app,
        cwds: [...state.cwds],
        branch: self?.branch,
        title: start.title || state.firstPrompt || self?.firstPrompt || "",
        firstPrompt: state.firstPrompt ?? self?.firstPrompt,
        models: [...state.models],
        createdAt: createdAt ?? 0,
        updatedAt: Number.isFinite(state.lastTime) ? state.lastTime : start.mtimeMs,
        bytes: start.bytes,
        parentID: self?.parentID ?? state.parentID,
        base: base ? omitUndefined({ id: base.rolloutID, endByteOffset: base.endByteOffset }) : undefined,
        subagent: self?.subagent ?? false,
        live: start.now - start.mtimeMs < LIVE_MS,
      }),
      turns,
      checkpoints: [...state.checkpoints],
      children: [...state.children],
      dropped: state.dropped,
      usage: state.usage,
    })
  }

  return {
    push,
    drop,
    info,
    /** Turns so far (the viewer notes the byte offset where each one starts, 09 §2.8). */
    turns: () => state.drafts.length,
  }
}

/** A `tool_search_output`'s tool list as the names the model was offered (the schemas are not history). */
function toolNames(tools: ReadonlyArray<unknown>): string {
  return tools
    .flatMap((tool) => {
      const named = Option.getOrUndefined(decodeNamed(tool))
      if (named === undefined) return []
      const inner = (named.tools ?? []).flatMap((entry) => {
        const name = Option.getOrUndefined(decodeNamed(entry))?.name
        return name ? [named.name ? `${named.name}.${name}` : name] : []
      })
      return inner.length > 0 ? inner : named.name ? [named.name] : []
    })
    .join(", ")
}

/**
 * `value` without its `undefined` properties (shallow): the IR's optional fields are exact (`optionalKey`), so a key
 * that is present must hold a value, and a transcript crossing the Worker boundary is decoded again.
 */
export function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T
}

/** Parses a whole rollout given as lines (tests, small files). */
export function parse(lines: ReadonlyArray<string>, start: Start) {
  const run = parser(start)
  lines.forEach((line, index) => run.push(line, { line: index }))
  return run.info()
}

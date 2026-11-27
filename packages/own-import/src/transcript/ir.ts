export * as Transcript from "./ir.js"

import { createHash } from "node:crypto"
import { FileDiff } from "@opencode/schema/file-diff"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { Schema } from "effect"

/**
 * The common record model (09 §2.4): every source parser produces one {@link Info}, and the viewer (3) and the
 * migration (4) both read it. Parsers decode the other tool's records once at their boundary and build typed values;
 * an {@link Info} crossing another boundary (the Worker's messages) is decoded once more with {@link decode}. Times
 * are epoch milliseconds, made monotonic by {@link repairTimes}. Nothing here holds provider state, encrypted
 * reasoning or the other tool's ids (IM-D5): those are dropped by the parsers and only counted in `dropped`.
 */

const Time = Schema.Finite

export const Kind = Schema.Literals(["codex", "claude-code"]).annotate({ identifier: "Own.Import.Transcript.Kind" })
export type Kind = typeof Kind.Type

/** A model the original tool used: provenance only, never resolved against own's catalog. */
export const Model = Schema.Struct({ provider: optional(Schema.String), id: Schema.String }).annotate({
  identifier: "Own.Import.Transcript.Model",
})
export interface Model extends Schema.Schema.Type<typeof Model> {}

/** A prefix this conversation inherits from another file (Codex `history_base`), read up to `endByteOffset`. */
export const Base = Schema.Struct({ id: Schema.String, endByteOffset: optional(NonNegativeInt) }).annotate({
  identifier: "Own.Import.Transcript.Base",
})
export interface Base extends Schema.Schema.Type<typeof Base> {}

export const Source = Schema.Struct({
  kind: Kind,
  /** The tool's own id: a Codex thread id or a Claude Code session id. */
  id: Schema.String,
  rootID: Schema.String,
  /** The conversation file (local only; never sent to a client as an input). */
  path: Schema.String,
  /** Every tool version seen in the file (`cli_version`, Claude `version`), oldest first. */
  versions: Schema.Array(Schema.String),
  /** The tool's front end when it records one (Codex `source`, e.g. `cli`, `vscode`, `exec`). */
  app: optional(Schema.String),
  /** Every working folder the conversation ran in, as recorded, first to last. */
  cwds: Schema.Array(Schema.String),
  branch: optional(Schema.String),
  title: Schema.String,
  firstPrompt: optional(Schema.String),
  models: Schema.Array(Model),
  createdAt: Time,
  updatedAt: Time,
  bytes: NonNegativeInt,
  parentID: optional(Schema.String),
  base: optional(Base),
  subagent: Schema.Boolean,
  /** Written by the tool in the last two minutes (v1 rule, 09 §2.5): it may still be running. */
  live: Schema.Boolean,
}).annotate({ identifier: "Own.Import.Transcript.Source" })
export interface Source extends Schema.Schema.Type<typeof Source> {}

/** A user image. `data` (base64, without a `data:` prefix) is absent when the parser did not keep the bytes. */
export const Image = Schema.Struct({
  mime: Schema.String,
  bytes: NonNegativeInt,
  data: optional(Schema.String),
}).annotate({
  identifier: "Own.Import.Transcript.Image",
})
export interface Image extends Schema.Schema.Type<typeof Image> {}

/** What the human sent. `queued`: a prompt the human queued while the tool worked (Claude `queued_command`). */
export const User = Schema.Struct({
  text: Schema.String,
  images: Schema.Array(Image),
  queued: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Import.Transcript.User" })
export interface User extends Schema.Schema.Type<typeof User> {}

/**
 * A tool result as the original model saw it. `truncatedFrom`: its size before the tool or the parser cut it.
 * `persisted`: the `tool-results` file name a Claude Code `<persisted-output>` preview points at (a name, never a
 * path), which only the viewer opens on demand (09 §2.6).
 */
export const Output = Schema.Struct({
  text: Schema.String,
  error: Schema.Boolean,
  truncatedFrom: optional(NonNegativeInt),
  persisted: optional(Schema.String),
}).annotate({ identifier: "Own.Import.Transcript.Output" })
export interface Output extends Schema.Schema.Type<typeof Output> {}

export const TextStep = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  time: Time,
  /** The model that wrote it, when the record says (the assistant message's display model). */
  model: optional(Schema.String),
}).annotate({ identifier: "Own.Import.Transcript.TextStep" })
export interface TextStep extends Schema.Schema.Type<typeof TextStep> {}

/** A readable reasoning summary: shown by the viewer, never migrated. */
export const ReasoningStep = Schema.Struct({
  type: Schema.Literal("reasoning-summary"),
  text: Schema.String,
  time: Time,
}).annotate({ identifier: "Own.Import.Transcript.ReasoningStep" })
export interface ReasoningStep extends Schema.Schema.Type<typeof ReasoningStep> {}

export const ToolStep = Schema.Struct({
  type: Schema.Literal("tool"),
  /** The original tool name (`exec_command`, `apply_patch`, `Bash`, `Edit`, …). */
  name: Schema.String,
  /** Parsed JSON arguments when the tool took JSON, else the free-text input (e.g. an `apply_patch` body). */
  input: Schema.Unknown,
  /** Absent while the call has no result in the record (a parser closes unpaired calls with an error result). */
  output: optional(Output),
  exit: optional(Schema.Int),
  /** Per-file changes for the viewer (Codex FileChange, Claude `structuredPatch`). */
  diff: optional(Schema.Array(FileDiff.Info)),
  /** The {@link ChildRef} id of a sub-agent conversation this call started. */
  child: optional(Schema.String),
  time: Time,
}).annotate({ identifier: "Own.Import.Transcript.ToolStep" })
export interface ToolStep extends Schema.Schema.Type<typeof ToolStep> {}

/** One line of context that is not the model's own text: a task notification, another agent's hand-off. */
export const NoteStep = Schema.Struct({
  type: Schema.Literal("note"),
  text: Schema.String,
  time: Time,
}).annotate({ identifier: "Own.Import.Transcript.NoteStep" })
export interface NoteStep extends Schema.Schema.Type<typeof NoteStep> {}

export const Step = Schema.Union([TextStep, ReasoningStep, ToolStep, NoteStep]).annotate({
  identifier: "Own.Import.Transcript.Step",
})
export type Step = typeof Step.Type

export const End = Schema.Literals(["completed", "interrupted", "error", "open"]).annotate({
  identifier: "Own.Import.Transcript.End",
})
export type End = typeof End.Type

/** One real message from the human and everything the tool did until the next one. */
export const Turn = Schema.Struct({
  index: NonNegativeInt,
  time: Time,
  user: User,
  steps: Schema.Array(Step),
  end: End,
}).annotate({ identifier: "Own.Import.Transcript.Turn" })
export interface Turn extends Schema.Schema.Type<typeof Turn> {}

export const Line = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool-call", "tool-result"]),
  text: Schema.String,
}).annotate({ identifier: "Own.Import.Transcript.Line" })
export interface Line extends Schema.Schema.Type<typeof Line> {}

/** The original record a checkpoint stands for: a Claude Code record uuid or a Codex line ordinal. */
export const Anchor = Schema.Union([
  Schema.Struct({ uuid: Schema.String }),
  Schema.Struct({ ordinal: NonNegativeInt }),
]).annotate({ identifier: "Own.Import.Transcript.Anchor" })
export type Anchor = typeof Anchor.Type

/**
 * Where the tool compacted: right after the original record, inside turn `turn` after its first `step` steps (tools
 * compact mid-turn, 09 §2.5, §2.6). `foreign`: the summary is readable; `codex-remote`: it is encrypted, `summary` is
 * filled by the migration (`briefAt`) and `recent` holds the user requests Codex kept.
 */
export const Checkpoint = Schema.Struct({
  at: Schema.Struct({ turn: NonNegativeInt, step: NonNegativeInt, source: Anchor }),
  kind: Schema.Literals(["foreign", "codex-remote"]),
  summary: optional(Schema.String),
  recent: Schema.Array(Line),
  trigger: optional(Schema.String),
  preTokens: optional(NonNegativeInt),
  postTokens: optional(NonNegativeInt),
}).annotate({ identifier: "Own.Import.Transcript.Checkpoint" })
export interface Checkpoint extends Schema.Schema.Type<typeof Checkpoint> {}

/** A sub-agent conversation: a view-only link (09 §2.5, §2.6). `at` is where the parent started it. */
export const ChildRef = Schema.Struct({
  id: Schema.String,
  title: optional(Schema.String),
  agent: optional(Schema.String),
  at: optional(Schema.Struct({ turn: NonNegativeInt, step: NonNegativeInt })),
}).annotate({ identifier: "Own.Import.Transcript.ChildRef" })
export interface ChildRef extends Schema.Schema.Type<typeof ChildRef> {}

/**
 * What a parser left out, counted per kind (09 §2.7, §2.8): records it could not use (`oversizedLine`, `tornLine`,
 * `decodeFailed`, `unknownRecord`, `unknownField`), injected or harness context (`developerMessage`,
 * `injectedContext`, `harnessWrapper`, `attachment`, `metaRecord`), provider-bound state (`encryptedReasoning`,
 * `encryptedMessage` for the encrypted parts of another agent's Codex hand-off, `thinking`, `remoteCompaction`), the
 * tool's own notices (`syntheticRecord`, `apiError`, `usageLimit`), history that
 * is not this conversation's line (`sidechain`, `abandonedBranch`, `rolledBack`, `inheritedContext`,
 * `queuedDuplicate`) and summary boilerplate that did not match the cleaner (`boilerplateUnmatched`).
 */
export const DropKind = Schema.Literals([
  "oversizedLine",
  "tornLine",
  "decodeFailed",
  "unknownRecord",
  "unknownField",
  "developerMessage",
  "injectedContext",
  "harnessWrapper",
  "attachment",
  "metaRecord",
  "encryptedReasoning",
  "encryptedMessage",
  "thinking",
  "remoteCompaction",
  "syntheticRecord",
  "apiError",
  "usageLimit",
  "sidechain",
  "abandonedBranch",
  "rolledBack",
  "inheritedContext",
  "queuedDuplicate",
  "boilerplateUnmatched",
]).annotate({ identifier: "Own.Import.Transcript.DropKind" })
export type DropKind = typeof DropKind.Type

export const Dropped = Schema.Record(DropKind, Schema.optionalKey(NonNegativeInt)).annotate({
  identifier: "Own.Import.Transcript.Dropped",
})
export type Dropped = typeof Dropped.Type

/** Token totals for display only (each Claude `message.id` counted once). */
export const Usage = Schema.Struct({ input: NonNegativeInt, output: NonNegativeInt, cached: NonNegativeInt }).annotate({
  identifier: "Own.Import.Transcript.Usage",
})
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const Info = Schema.Struct({
  source: Source,
  turns: Schema.Array(Turn),
  checkpoints: Schema.Array(Checkpoint),
  children: Schema.Array(ChildRef),
  dropped: Dropped,
  usage: optional(Usage),
}).annotate({ identifier: "Own.Import.Transcript.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/** Decodes a transcript that crossed a boundary (the Worker's messages); never throws. */
export const decode = Schema.decodeUnknownResult(Info)

/** Adds `count` drops of `kind`. */
export function drop(dropped: Dropped, kind: DropKind, count = 1): Dropped {
  return { ...dropped, [kind]: (dropped[kind] ?? 0) + count }
}

/**
 * Makes turn and step times monotonic (09 §2.4): a time that is missing (not finite) or earlier than the one before it
 * becomes the one before + 1 ms. The first time falls back to `start` (e.g. the file's creation time). Parsers write
 * `NaN` for a record without a time and call this before handing the turns on.
 */
export function repairTimes(turns: ReadonlyArray<Turn>, start = 0): Turn[] {
  const clock = { last: Number.NaN }
  const next = (time: number) => {
    const fixed = Number.isNaN(clock.last)
      ? Number.isFinite(time)
        ? time
        : start
      : Number.isFinite(time) && time >= clock.last
        ? time
        : clock.last + 1
    clock.last = fixed
    return fixed
  }
  return turns.map((turn) => {
    const time = next(turn.time)
    return { ...turn, time, steps: turn.steps.map((step) => ({ ...step, time: next(step.time) })) }
  })
}

/**
 * `sha256` (hex) of the normalized IR of `turns` (09 §4.7): object keys sorted, `undefined` left out, strings in NFC
 * with `\n` line ends. Equal for the same turns however a parser built them, so a source that only grew keeps the
 * hash of its first turns (`원본에 새 턴 N개`, 09 §4.8).
 */
export function contentHash(turns: ReadonlyArray<Turn>) {
  return createHash("sha256").update(canonical(turns)).digest("hex")
}

function canonical(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.replace(/\r\n?/g, "\n").normalize("NFC"))
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map((entry) => `${JSON.stringify(entry[0])}:${canonical(entry[1])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

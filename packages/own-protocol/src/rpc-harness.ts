/**
 * RPC `own.harness` (10 §3.2): which harness a session runs and switching it, and what each harness sends with the
 * user's 내 지시문 (10 §3.11). Exported as `@own/protocol/rpc-harness`; own.harness registers it and own-web calls it.
 * The metadata helpers are in `@own/protocol/rpc-harness-routing`.
 */
export * as OwnHarness from "./rpc-harness.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { SessionID } from "@opencode/schema/session-id"
import { CUSTOM_HARNESSES, ID, IDS, PREVIEW_HARNESSES, PROMPTS } from "./rpc-harness-routing.js"

export {
  ID,
  META_KEY,
  FALLBACK,
  PROMPTS,
  PROMPT_FALLBACK,
  CUSTOM_HARNESSES,
  PREVIEW_HARNESSES,
  CLAUDE_AGENT,
  CLAUDE_AGENT_ROLE,
  CLAUDE_AGENT_INSTRUCTIONS,
  bound,
  harnessOf,
  promptOf,
  value,
} from "./rpc-harness-routing.js"

const empty = Schema.Struct({})

export const HarnessID = Schema.Literals(IDS).annotate({ identifier: "OwnHarness.HarnessID" })
export type HarnessID = typeof HarnessID.Type

/** A base system prompt variant (10 §3.9): the harness's original, own's revision, or the user's (내 지시문). */
export const PromptID = Schema.Literals(PROMPTS).annotate({ identifier: "OwnHarness.PromptID" })
export type PromptID = typeof PromptID.Type

/** A harness whose prompt has a part the user may edit (`codex`, `pi`, `dsh`). */
export const CustomHarnessID = Schema.Literals(CUSTOM_HARNESSES).annotate({ identifier: "OwnHarness.CustomHarnessID" })
export type CustomHarnessID = typeof CustomHarnessID.Type

/** A harness `prompt.preview` shows: one with 내 지시문, or `claude-code`. */
export const PreviewHarnessID = Schema.Literals(PREVIEW_HARNESSES).annotate({
  identifier: "OwnHarness.PreviewHarnessID",
})
export type PreviewHarnessID = typeof PreviewHarnessID.Type

export const List = Schema.Struct({
  harnesses: Schema.Array(HarnessID),
  /**
   * The harness own.harness gives a new top-level session that names none: the choice stored by `defaults.set`, else
   * plugin option `default`.
   */
  default: HarnessID,
  prompts: Schema.Array(PromptID),
  /** The variant such a session runs: the choice stored by `defaults.set`, else plugin option `prompt`. */
  defaultPrompt: PromptID,
  /**
   * The harnesses with a saved 내 지시문 (`prompt.custom.set`); a `custom` session of any other harness runs `own`.
   * Absent from services before 2026-10-18, which have no `custom` variant either.
   */
  custom: Schema.optionalKey(Schema.Array(CustomHarnessID)),
  /** The plugin bundle's build id and version (01 §4), as the other own plugins report theirs. */
  buildId: Schema.String,
  version: Schema.String,
}).annotate({ identifier: "OwnHarness.List" })
export type List = typeof List.Type

/** own's approval modes (own-accounts `switching/approval.ts`), which pick the permissions text. */
export const ApprovalMode = Schema.Literals(["full", "ask", "read-only"]).annotate({
  identifier: "OwnHarness.ApprovalMode",
})
export type ApprovalMode = typeof ApprovalMode.Type

/** A model the prompt page can preview: one of the service's enabled models, or an example when it has none. */
export const PromptModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "OwnHarness.PromptModel" })
export type PromptModel = typeof PromptModel.Type

/**
 * What a part of the request is. Codex: `base` (base instructions, the part 내 지시문 replaces), `identity` (core's
 * `# Your Model`), `permissions`, `collaboration`, `tools` (`<tools>`, the deferred tool namespaces), `agents`
 * (multi-agent role and mode), `context` (other developer text), `agents-md`, `environment`. Pi: `preamble` (the part 내 지시문 replaces), `tools`, `rules`, `addendum`,
 * `project`, `skills`, `cwd`. dsh (13): `harness` (its fixed identity line), `persona` (the part 내 지시문 replaces),
 * `tools` (the tools' guidance sections), `context` (own's additions), then the messages it adds after the first user
 * message: `agents-md`, `environment` (its runtime context), `skills` and `time`.
 */
export const PromptPartKind = Schema.Literals([
  "base",
  "identity",
  "permissions",
  "collaboration",
  "agents",
  "context",
  "agents-md",
  "environment",
  "preamble",
  "tools",
  "rules",
  "addendum",
  "project",
  "skills",
  "cwd",
  "harness",
  "persona",
  "time",
]).annotate({ identifier: "OwnHarness.PromptPartKind" })
export type PromptPartKind = typeof PromptPartKind.Type

export const PromptPart = Schema.Struct({
  kind: PromptPartKind,
  /**
   * Where it goes: `developer` (an OpenAI Responses developer message), `system` (the system prompt of other routes),
   * `user` (the first user message, which Codex fills with AGENTS.md and the environment).
   */
  role: Schema.Literals(["system", "developer", "user"]),
  text: Schema.String,
  /** The part 내 지시문 replaces; every other part is generated and read-only. */
  editable: Schema.Boolean,
}).annotate({ identifier: "OwnHarness.PromptPart" })
export type PromptPart = typeof PromptPart.Type

/** A tool the harness sends, under the name and with the description the model sees. */
export const PromptTool = Schema.Struct({ name: Schema.String, description: Schema.String }).annotate({
  identifier: "OwnHarness.PromptTool",
})
export type PromptTool = typeof PromptTool.Type

/** One change own's revision makes to the original (variant.ts), with its Korean title and reason. */
export const PromptChange = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  why: Schema.String,
  /** The part it changes; `catalog` is core's Code Mode tool list, which differs per conversation. */
  part: Schema.Literals(["base", "identity", "permissions", "environment", "tools", "catalog"]),
  /** The original text; empty for an addition, or when it differs per conversation (`catalog`). */
  before: Schema.String,
  /** own's text; empty for a removal, or when it differs per conversation. */
  after: Schema.String,
  /** Whether 개선판 makes this change for the previewed model (under 내 지시문 too, except the base text's). */
  applies: Schema.Boolean,
}).annotate({ identifier: "OwnHarness.PromptChange" })
export type PromptChange = typeof PromptChange.Type

/**
 * How an 에이전트 방식 hands work to a child conversation (설정 > 에이전트 방식 `하위 에이전트`, 10 §3.11). Each field
 * is read from the code that sends it, so the page cannot drift from what runs.
 */
export const PromptSubagent = Schema.Struct({
  /**
   * `core`: core's `subagent` tool (OpenCode 기본, Pi, DeepSeek, Claude Agent 기본, and Codex in Code Mode on a v1
   * model such as GPT-5.6 Luna on Responses, which sends no v1 agent tools). `codex-v1`: Codex's MultiAgent v1 tools
   * (`spawn_agent`, `wait_agent`, …: gpt-5.5 and models outside Codex's catalog). `codex-v2`: Codex's MultiAgentV2
   * `collaboration` tools (the catalog models that use them).
   */
  kind: Schema.Literals(["core", "codex-v1", "codex-v2"]),
  /** The tool that starts a child, under the name and with the description the model gets; absent when not registered. */
  tool: Schema.optionalKey(PromptTool),
  /** `core`: the agent whose permissions pick the description's "Available subagents:" list (a new conversation's). */
  agent: Schema.optionalKey(Schema.String),
  /** What a new child's first message carries before the parent's text, which follows word for word; empty for none. */
  opening: Schema.String,
  /** Text the harness gives every child besides its task (Codex v2's `<multi_agent_role>` for a child); empty for none. */
  guidance: Schema.String,
  /** `core`: where a foreground result is cut, keeping its start (core's tool output limit). */
  cut: Schema.optionalKey(Schema.Struct({ lines: Schema.Number, bytes: Schema.Number })),
}).annotate({ identifier: "OwnHarness.PromptSubagent" })
export type PromptSubagent = typeof PromptSubagent.Type

export const PromptPreview = Schema.Struct({
  harness: PreviewHarnessID,
  /** The variant asked for. */
  prompt: PromptID,
  /** The variant that runs: `own` for `custom` while no text is saved, else `prompt`. */
  applied: PromptID,
  model: PromptModel,
  /**
   * Codex's base text for this model: `catalog` (a GPT model in Codex's catalog: Codex's template under 개선판 too),
   * `lean` (own's short text for Claude Opus 4.8 and later, Fable, Mythos), `fallback` (Codex's fallback prompt with
   * own's replacements). Absent for pi and dsh, whose text is the same for every model, and for claude-code.
   */
  tier: Schema.optionalKey(Schema.Literals(["catalog", "lean", "fallback"])),
  /** The model's route speaks OpenAI Responses (developer messages); other routes get system text. */
  responses: Schema.Boolean,
  mode: ApprovalMode,
  /** The request's instructions in order, as the harness's request builder made them for an empty conversation. */
  parts: Schema.Array(PromptPart),
  tools: Schema.Array(PromptTool),
  /** own's changes to the original for this harness; `applies` says which this model gets. */
  changes: Schema.Array(PromptChange),
  /** The editable part under 원본 and 개선판 for this model, as 내 지시문 starts from it. */
  starts: Schema.Struct({ reference: Schema.String, own: Schema.String }),
  /** The saved 내 지시문 of this harness. */
  custom: Schema.optionalKey(Schema.Struct({ text: Schema.String, updatedAt: Schema.Number })),
  /** The models to pick from; `examples` when the service has no enabled model. */
  models: Schema.Array(PromptModel),
  examples: Schema.Boolean,
  /** The longest 내 지시문 `prompt.custom.set` takes, in characters. */
  limit: Schema.Number,
  /** How this harness hands work to a child for this model. Absent from services before 2026-11-07. */
  subagent: Schema.optionalKey(PromptSubagent),
}).annotate({ identifier: "OwnHarness.PromptPreview" })
export type PromptPreview = typeof PromptPreview.Type

export const Binding = Schema.Struct({
  sessionID: SessionID,
  harness: HarnessID,
  /** False when the session's metadata names no harness and it runs the fallback (`opencode`). */
  explicit: Schema.Boolean,
  prompt: PromptID,
}).annotate({ identifier: "OwnHarness.Binding" })
export type Binding = typeof Binding.Type

export const Changed = Schema.Struct({
  sessionID: SessionID,
  harness: HarnessID,
  previous: HarnessID,
  prompt: PromptID,
}).annotate({ identifier: "OwnHarness.Changed" })
export type Changed = typeof Changed.Type

/** A model on one account that a failed compaction may hand over to (own/docs/11 §3). */
export const FallbackModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
}).annotate({ identifier: "OwnHarness.FallbackModel" })
export type FallbackModel = typeof FallbackModel.Type

export const CompactionFallback = Schema.Struct({
  /** True while the user has not chosen: own picks by its model preference (plugin option `compactionFallback`). */
  automatic: Schema.Boolean,
  /** The models in effect, in order: the user's list, or what the automatic choice finds among the accounts now. */
  models: Schema.Array(FallbackModel),
}).annotate({ identifier: "OwnHarness.CompactionFallback" })
export type CompactionFallback = typeof CompactionFallback.Type

export const errors = portable({
  session_not_found: Schema.Struct({ sessionID: SessionID }),
  /** The session is running; a harness changes only between runs. */
  session_busy: Schema.Struct({ sessionID: SessionID }),
  /** A 내 지시문 with no text but blanks, or longer than `limit` characters. */
  prompt_invalid: Schema.Struct({ reason: Schema.Literals(["empty", "too_long"]), limit: Schema.Number }),
  /** `omo` while own-omo is not loaded (or turned off) in this Location (15 §2.2). */
  harness_unavailable: Schema.Struct({ harness: HarnessID }),
})

function portable<const Schemas extends Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>>(schemas: Schemas) {
  // Since effect 4.0.6 toStandardSchemaV1 returns a copy with `~standard` instead of changing the schema in place.
  // SAFETY: one converted entry per key of `schemas`, each the type toStandardSchemaV1 returns for it.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, Schema.toStandardSchemaV1(schema)]),
  ) as { readonly [K in keyof Schemas]: ReturnType<typeof Schema.toStandardSchemaV1<Schemas[K]>> }
}

function method<
  const Input extends Schema.ConstraintDecoder<unknown>,
  const Output extends Schema.ConstraintDecoder<unknown>,
  const Errors extends Rpc.ErrorMap,
>(input: Input, output: Output, errors: Errors) {
  return { input: Schema.toStandardSchemaV1(input), output: Schema.toStandardSchemaV1(output), errors }
}

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

export const Definition = Rpc.define({
  id: ID,
  methods: {
    list: method(empty, List, {}),
    "session.get": method(Schema.Struct({ sessionID: SessionID }), Binding, {
      session_not_found: errors.session_not_found,
    }),
    /**
     * Binds the session to `harness` and records one durable notice that the next request reads (10 §3.7). Setting the
     * harness it already runs changes nothing. `prompt` picks the base prompt variant (10 §3.9); left out, the session
     * keeps its variant. A variant change takes effect at the next request without a notice.
     */
    "session.set": method(
      Schema.Struct({ sessionID: SessionID, harness: HarnessID, prompt: Schema.optionalKey(PromptID) }),
      Binding,
      {
        session_not_found: errors.session_not_found,
        session_busy: errors.session_busy,
        harness_unavailable: errors.harness_unavailable,
      },
    ),
    /**
     * Sets the harness and prompt variant a new top-level session gets when its creator names none (Settings > 일반);
     * answers the list with the new defaults. Children still inherit their parent's. A field equal to the plugin option
     * is not stored, so it keeps following the plugin's default (own.harness `defaults.ts`).
     */
    "defaults.set": method(Schema.Struct({ harness: HarnessID, prompt: PromptID }), List, {
      harness_unavailable: errors.harness_unavailable,
    }),
    "compaction.get": method(empty, CompactionFallback, {}),
    /**
     * Sets the models a failed compaction falls back to, in order; `null` returns to the automatic choice and an empty
     * list goes straight to the checkpoint code makes without a model. The session's own account is always skipped.
     */
    "compaction.set": method(Schema.Struct({ models: Schema.NullOr(Schema.Array(FallbackModel)) }), CompactionFallback, {}),
    /**
     * What `harness` sends `model` (default: the service's first enabled model) under `prompt` in approval mode `mode`
     * (default `ask`), built by the harness's own request builder for an empty conversation in `directory` (default the
     * call's Location): the instructions part by part, the harness's tools, own's changes and the saved 내 지시문
     * (10 §3.11). Core's per-conversation additions (AGENTS.md, skills, Code Mode catalog, MCP) are not in it.
     * `claude-code` answers an outline of what reaches Claude: Claude Code's own prompt, then OpenCode's agent role and
     * instructions (it has no variant, changes or 내 지시문).
     */
    "prompt.preview": method(
      Schema.Struct({
        harness: PreviewHarnessID,
        prompt: PromptID,
        model: Schema.optionalKey(FallbackModel),
        mode: Schema.optionalKey(ApprovalMode),
        directory: Schema.optionalKey(Schema.String),
      }),
      PromptPreview,
      {},
    ),
    /**
     * How core's `subagent` tool hands work to a child (OpenCode 기본's `하위 에이전트`, which has no preview): the tool's
     * description with the "Available subagents:" list core adds for a new conversation's agent, a child's first line
     * and where a foreground result is cut. Absent from services before 2026-11-07 (`rpc.method_not_found`).
     */
    "prompt.subagent": method(empty, PromptSubagent, {}),
    /**
     * Saves `text` as `harness`'s 내 지시문, or deletes it with `null` (기본으로 되돌리기): sessions on `custom` run `own`
     * again from their next request. Answers the list, whose `custom` names the harnesses with a text.
     */
    "prompt.custom.set": method(Schema.Struct({ harness: CustomHarnessID, text: Schema.NullOr(Schema.String) }), List, {
      prompt_invalid: errors.prompt_invalid,
    }),
  },
  events: { "session.changed": event(Changed) },
})
export type Definition = typeof Definition

export type MethodName = keyof Definition["methods"] & string

/** `read | drive | local` (the own.remote vocabulary). A switch changes how the session runs, like a model switch. */
export const Scope = Schema.Literals(["read", "drive", "local"]).annotate({ identifier: "OwnHarness.Scope" })
export type Scope = typeof Scope.Type

export const MethodScope: { readonly [M in MethodName]: Scope } = {
  list: "read",
  "session.get": "read",
  "session.set": "drive",
  "defaults.set": "local",
  "compaction.get": "read",
  "compaction.set": "local",
  "prompt.preview": "read",
  "prompt.subagent": "read",
  "prompt.custom.set": "local",
}

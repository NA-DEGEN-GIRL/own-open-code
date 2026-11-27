// Ports codex-rs/models-manager/src/manager.rs (longest-prefix and namespaced lookup, the served catalog of a ChatGPT
// login), model_info.rs (`model_info_from_slug`), codex-rs/core/src/tools/handlers/multi_agents_spec.rs
// (`spawn_agent_models_description`) and codex-rs/prompts/src/update_plan_instructions.rs.
// Ported from openai/codex (Apache-2.0) @ rust-v0.171.0.
export * as Catalog from "./catalog.js"

import { CodexModels } from "@own/protocol/codex-models"
import models from "../../codex-data/models.json" with { type: "json" }
import FALLBACK_PROMPT from "../../codex-data/prompt.md" with { type: "text" }
import { RustStr } from "./apply-patch/rust-str.js"

export interface ModelMessages {
  readonly instructions_template?: string
  readonly [key: string]: unknown
}

/** The catalog fields the harness reads (codex-data/models.json is generated with these). */
export interface Model {
  readonly slug: string
  readonly tool_mode: "code_mode_only" | "code_mode" | null
  readonly use_responses_lite: boolean
  readonly apply_patch_tool_type: "freeform" | null
  readonly truncation_policy: { readonly mode: "tokens" | "bytes"; readonly limit: number }
  readonly supports_parallel_tool_calls: boolean
  readonly support_verbosity: boolean
  readonly default_verbosity: "low" | "medium" | "high" | null
  readonly default_reasoning_summary: "none" | "auto" | "concise" | "detailed"
  readonly default_reasoning_level: string | null
  /** The model takes reasoning-effort `configuration_update` items (effort.ts). */
  readonly supports_reasoning_effort_updates?: boolean | null
  readonly supports_image_detail_original?: boolean
  readonly input_modalities?: ReadonlyArray<string>
  readonly multi_agent_version?: string | null
  /** Optional tool groups the model gets, e.g. `clock` (GPT-6). */
  readonly experimental_supported_tools?: ReadonlyArray<string>
  /** Deferred tools (the v1 agent tools) go behind client `tool_search` instead of being sent up front. */
  readonly supports_search_tool?: boolean
  /** `text_and_image` adds image results to hosted web search. */
  readonly web_search_tool_type?: "text" | "text_and_image"
  readonly model_messages: ModelMessages | null
  /** False for a model outside the catalog (Codex's fallback metadata). */
  readonly known: boolean
  /**
   * From a ChatGPT account's served model list (10 §6.14), not the bundled catalog; `borrowed` names the bundled model
   * whose instructions it runs with when its row has none.
   */
  readonly served?: { readonly borrowed?: string }
}

/**
 * The `experimental_supported_tools` names the pinned Codex reads (rust-v0.171.0 `spec_plan.rs`, `world_state.rs`,
 * `ext/web-search`) and what the harness does with each: `clock` (code-mode-tools.ts), the async question under both
 * names (async-question.ts), `send_message_to_user_async` (send-message.ts), and `literature_search_query`, which only
 * shapes Codex's `web.run`, a tool own has not (golden KNOWN_GAPS). Codex ignores other names, and so does own. A
 * codex-sync that finds a name the new release reads and this list lacks needs code (own/scripts/codex-sync-trial.ts).
 */
export const EXPERIMENTAL_TOOLS: ReadonlyArray<string> = [
  "clock",
  "request_user_input_async",
  "send_user_message_async",
  "send_message_to_user_async",
  "literature_search_query",
]

const CATALOG: ReadonlyArray<Model> = (models.models as ReadonlyArray<Omit<Model, "known">>).map((model) => ({
  ...model,
  known: true,
}))

/**
 * The served catalog (10 §6.14): the rows a ChatGPT account's model list gave own.accounts that the harness can run
 * (`CodexModels.HarnessRow`), handed over by `Served.refresh`. Codex on a ChatGPT login builds every request from these
 * rows (`apply_remote_models`, remote only), so they come before the bundled catalog; a model they lack keeps the
 * bundled entry (an API key login, or none of the account's rows fits).
 */
const served: { revision?: string; rows: ReadonlyArray<CodexModels.HarnessRow>; models: ReadonlyArray<Model> } = {
  rows: [],
  models: [],
}

/** Takes the served rows of `revision` (`codexModels.rows`) as the served catalog. */
export function serve(revision: string, rows: ReadonlyArray<CodexModels.HarnessRow>) {
  served.revision = revision
  served.rows = rows
  served.models = rows.map(fromServed)
}

/** The revision of the served catalog in use; `undefined` before any. */
export function revision() {
  return served.revision
}

/**
 * The catalog entry for a model id: the longest served slug the id starts with, else the longest bundled one, else the
 * same after one leading `namespace/` segment, else Codex's fallback metadata (`prompt.md`, no apply_patch tool,
 * 10000-byte truncation, no verbosity, reasoning summary `auto`).
 */
export function lookup(model: string): Model {
  return longestPrefix(model, served.models) ?? longestPrefix(model) ?? namespaced(model) ?? fallback(model)
}

/**
 * Codex's `spawn_agent` model list for the served catalog (`spawn_agent_models_description`): the picker-visible rows
 * whose agent tools are not disabled, in priority order, at most 16, each with its reasoning levels (the default
 * marked) and speed tiers. `undefined` without a served catalog, where the captured list (the bundled catalog's)
 * stands.
 */
export function spawnModels(): string | undefined {
  if (served.rows.length === 0) return undefined
  const visible = served.rows
    .filter((row) => row.visibility === "list")
    .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .slice(0, MAX_SPAWN_AGENT_MODEL_OVERRIDES)
  if (visible.length === 0) return "No picker-visible model overrides are currently loaded."
  const lines = visible.map((row) => {
    const efforts = (row.supported_reasoning_levels ?? [])
      .map((level) => {
        const effort = [...level.effort].slice(0, MAX_REASONING_EFFORT_CHARS).join("")
        return level.effort === row.default_reasoning_level ? `${effort} (default)` : effort
      })
      .join(", ")
    const tiers = (row.service_tiers ?? []).map((tier) => tier.id).join(", ")
    return `- \`${row.slug}\`: ${row.description ?? ""}${efforts === "" ? "" : ` Reasoning efforts: ${efforts}.`}${tiers === "" ? "" : ` Service tiers: ${tiers}.`}`
  })
  return `Available model overrides (optional; inherited parent model is preferred):\n${lines.join("\n")}`
}

/** `MAX_SPAWN_AGENT_MODEL_OVERRIDES` and `MAX_REASONING_EFFORT_CHARS_IN_SPAWN_AGENT_DESCRIPTION`. */
const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 16
const MAX_REASONING_EFFORT_CHARS = 64

/**
 * A served row as a catalog entry, with Codex's defaults for what the row leaves out (`ModelInfo`'s serde defaults:
 * text and image input, text web search, reasoning summary `auto`). `supports_parallel_tool_calls` is no `ModelInfo`
 * field: Codex sends parallel tool calls unless the model uses Responses Lite (`session/turn.rs`). A row without
 * instructions runs with the nearest bundled model's (`CodexModels.nearest`).
 */
function fromServed(row: CodexModels.HarnessRow): Model {
  const lender =
    row.model_messages.instructions_template === undefined
      ? CATALOG.find((model) => model.slug === CodexModels.nearest(row.slug))
      : undefined
  return {
    slug: row.slug,
    tool_mode: row.tool_mode === "code_mode_only" ? "code_mode_only" : null,
    use_responses_lite: row.use_responses_lite === true,
    apply_patch_tool_type: row.apply_patch_tool_type ?? null,
    truncation_policy: row.truncation_policy,
    supports_parallel_tool_calls: true,
    support_verbosity: row.support_verbosity === true,
    default_verbosity: row.default_verbosity ?? null,
    default_reasoning_summary: row.default_reasoning_summary ?? "auto",
    default_reasoning_level: row.default_reasoning_level ?? null,
    supports_reasoning_effort_updates: row.supports_reasoning_effort_updates === true,
    supports_image_detail_original: row.supports_image_detail_original === true,
    input_modalities: row.input_modalities ?? ["text", "image"],
    multi_agent_version: row.multi_agent_version ?? null,
    experimental_supported_tools: row.experimental_supported_tools ?? [],
    supports_search_tool: row.supports_search_tool === true,
    web_search_tool_type: row.web_search_tool_type ?? "text",
    model_messages: {
      ...row.model_messages,
      ...(lender ? { instructions_template: lender.model_messages?.instructions_template ?? FALLBACK_PROMPT } : {}),
    },
    known: true,
    served: lender ? { borrowed: lender.slug } : {},
  }
}

/** The base instructions Codex sends for the model, with the checklist-tool guidance removed (update_plan is off). */
export function instructions(model: Model) {
  return withoutUpdatePlan(model.model_messages?.instructions_template ?? FALLBACK_PROMPT)
}

/** {@link instructions} of a model outside the catalog: Codex's fallback prompt. */
export function fallbackInstructions() {
  return withoutUpdatePlan(FALLBACK_PROMPT)
}

function longestPrefix(model: string, catalog: ReadonlyArray<Model> = CATALOG) {
  return catalog.filter((candidate) => model.startsWith(candidate.slug)).reduce<Model | undefined>(
    (best, candidate) => (best === undefined || candidate.slug.length > best.slug.length ? candidate : best),
    undefined,
  )
}

function namespaced(model: string) {
  const at = model.indexOf("/")
  if (at < 0) return undefined
  const namespace = model.slice(0, at)
  const suffix = model.slice(at + 1)
  if (suffix.includes("/") || !/^[A-Za-z0-9_-]+$/.test(namespace)) return undefined
  return longestPrefix(suffix)
}

function fallback(slug: string): Model {
  return {
    slug,
    tool_mode: null,
    use_responses_lite: false,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: true,
    support_verbosity: false,
    default_verbosity: null,
    default_reasoning_summary: "auto",
    default_reasoning_level: null,
    supports_reasoning_effort_updates: false,
    supports_image_detail_original: false,
    supports_search_tool: false,
    web_search_tool_type: "text",
    model_messages: { instructions_template: FALLBACK_PROMPT },
    known: false,
  }
}

const CHECKLIST_SECTIONS = new Set([
  "## Planning",
  "## `update_plan`",
  "## Plan tool",
  "## Plan Mode vs update_plan tool",
])

/** `without_update_plan_instructions`: drops the checklist-tool sections, notes and bullets, keeping every other byte. */
export function withoutUpdatePlan(text: string) {
  const lines = text.split(/(?<=\n)/)
  const kept: Array<string> = []
  const step = (index: number): number => {
    if (index >= lines.length) return index
    const line = RustStr.trimEnd(lines[index]!)
    if (CHECKLIST_SECTIONS.has(line)) {
      const found = lines.findIndex((next, at) => at > index && (next.startsWith("# ") || next.startsWith("## ")))
      const end = found < 0 ? lines.length : found
      const checklist =
        line !== "## Planning" ||
        lines
          .slice(index, end)
          .some(
            (entry) =>
              entry.startsWith("You have access to an `update_plan` tool") ||
              entry.startsWith("When `update_plan` is available, follow this section"),
          )
      if (checklist) return end
    }
    if (line === "Progress visibility:" && lines[index + 1]?.startsWith("If update_plan is available")) {
      const next = index + 2
      return lines[next] !== undefined && RustStr.trim(lines[next]!) === "" ? next + 1 : next
    }
    if (line.startsWith("- Use the plan tool ") || line.startsWith("- If you create a checklist or task list,")) {
      const rest = lines.slice(index + 1).findIndex((entry) => !(entry.startsWith(" ") || entry.startsWith("\t")))
      return rest < 0 ? lines.length : index + 1 + rest
    }
    kept.push(lines[index]!)
    return index + 1
  }
  for (let index = 0; index < lines.length; ) index = step(index)
  return kept.join("")
}

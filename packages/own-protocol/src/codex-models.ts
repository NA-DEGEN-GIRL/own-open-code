export * as CodexModels from "./codex-models.js"

import { Option, Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { CODEX_RETIRED_SLUGS, CODEX_SLUGS } from "./codex-slugs.js"
import { EpochMillis } from "./id.js"

/**
 * Codex model metadata, the second layer of model facts (07 §4.5): what the Codex backend's model list says and
 * models.dev does not (the subscription window, retirement, the default reasoning level and the order of levels, the
 * priority, ultra's effort). own-accounts fetches it with a `codex` slot token and stores it per kind
 * (`OWN_HOME\codex-meta.json`); before a fetch succeeds, the Codex CLI's `models_cache.json` on this PC is the
 * temporary source. Codex only: a `siwc` account never reads it (07 §2.2). Nothing here names a model, a window or a
 * price; every value comes from the rows (07 §3.5). The namespace is `CodexModels` because own-accounts already
 * exports `CodexMeta` (its PC reader).
 */

/** One reasoning level as Codex lists it (`{effort, description}`); the description is not kept. */
export interface Level extends Schema.Schema.Type<typeof Level> {}
export const Level = Schema.Struct({ effort: Schema.NonEmptyString }).annotate({
  identifier: "Own.CodexModels.Level",
})

/**
 * Codex's upgrade hint of a model (07 §4.3): the model it points to, and when the model retires (`retirement_at`,
 * an ISO date ⚠PG7; `null` while none is announced). A retirement date is shown dimmed and never raises a notice.
 */
export interface Upgrade extends Schema.Schema.Type<typeof Upgrade> {}
export const Upgrade = Schema.Struct({
  model: Schema.NonEmptyString,
  retirement_at: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Own.CodexModels.Upgrade" })

/**
 * One speed tier a model row lists for the asking account (`service_tiers[]`, Codex `ModelServiceTier`): `id` is the
 * request value (`priority` for Fast, `ultrafast`), `name` the label Codex shows (`Fast`, `Ultrafast`). The list
 * depends on the account's plan and workspace, so it is read per account (02 §4.8).
 */
export interface Tier extends Schema.Schema.Type<typeof Tier> {}
export const Tier = Schema.Struct({
  id: Schema.NonEmptyString,
  name: optional(Schema.String),
  description: optional(Schema.String),
}).annotate({ identifier: "Own.CodexModels.Tier" })

/**
 * One model row, with Codex's own field names (07 §4.5); every other field of a row (instructions, tools, display
 * texts …) is dropped when decoding. `null` and absent both mean Codex says nothing.
 * - `context_window`: Codex's default window (272k for every row, 07 Appendix A), not the model's capacity, so own
 *   never registers it; `max_context_window`: the largest input it accepts (the window own registers, R8).
 * - `supported_reasoning_levels`: the model's levels in Codex's order (⚠PG5 low → high), client-only `ultra`
 *   included.
 * - `multi_agent_reasoning_effort`: the effort Codex sends for ultra (07 §2.9).
 * - `supports_reasoning_effort_updates`: compared with own's upstream mirror only (`effort_update_drift`, 07 §4.5).
 * - `priority`: 1 comes first (the ChatGPT group's `auto` default ②, 07 §2.2; ahead of price in 07 §3.4).
 * - `service_tiers`: the speed tiers this account may send for the model (02 §4.8); `default_service_tier` the tier
 *   Codex uses when the user chose none (own never applies it: a new conversation starts at Standard);
 *   `additional_speed_tiers` the deprecated form (`["fast"]`).
 * - `description`: Codex's one-line description of the model, frozen into a model pool card (07 §3.3 모델 묶음).
 */
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Model = Schema.Struct({
  slug: Schema.NonEmptyString,
  context_window: optional(Schema.NullOr(PositiveInt)),
  max_context_window: optional(Schema.NullOr(PositiveInt)),
  default_reasoning_level: optional(Schema.NullOr(Schema.String)),
  supported_reasoning_levels: optional(Schema.Array(Level)),
  multi_agent_reasoning_effort: optional(Schema.NullOr(Schema.String)),
  supports_reasoning_effort_updates: optional(Schema.NullOr(Schema.Boolean)),
  priority: optional(Schema.NullOr(Schema.Int)),
  upgrade: optional(Schema.NullOr(Upgrade)),
  service_tiers: optional(Schema.NullOr(Schema.Array(Tier))),
  default_service_tier: optional(Schema.NullOr(Schema.String)),
  additional_speed_tiers: optional(Schema.NullOr(Schema.Array(Schema.String))),
  description: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Own.CodexModels.Model" })

/** Where a snapshot came from: the Codex backend (own's fetch), or the Codex CLI's cache on this PC. */
export const Source = Schema.Literals(["backend", "pc-cache"]).annotate({ identifier: "Own.CodexModels.Source" })
export type Source = typeof Source.Type

/**
 * A served row as own's `codex` harness takes it at runtime (07 §4.5 "서버가 알려 준 모델", 10 §6.14): the fields that
 * decide Codex's request for the model, with Codex's own names, plus the display facts `spawn_agent`'s model list
 * shows. Codex on a ChatGPT login builds every request from the backend's rows (`models-manager` `apply_remote_models`,
 * remote only), so the harness does the same: a served row it can take wins over its bundled catalog entry, and a model
 * the bundled catalog does not know runs from its row instead of waiting for the next Codex sync.
 * `model_messages.instructions_template` is Codex's base instructions, promoted from the legacy top-level
 * `base_instructions` as Codex promotes it (`deserialize_model_infos_with_legacy_base`); absent, the harness borrows
 * the nearest bundled model's ({@link nearest}). Only the three message kinds the harness renders are kept.
 */
export interface HarnessRow extends Schema.Schema.Type<typeof HarnessRow> {}
export const HarnessRow = Schema.Struct({
  slug: Schema.NonEmptyString,
  /** Codex's display name and largest input: what own registers a model with when no catalog lists it yet (07 §4.4). */
  display_name: optional(Schema.NullOr(Schema.String)),
  max_context_window: optional(Schema.NullOr(PositiveInt)),
  description: optional(Schema.NullOr(Schema.String)),
  visibility: optional(Schema.NullOr(Schema.String)),
  priority: optional(Schema.NullOr(Schema.Int)),
  default_reasoning_level: optional(Schema.NullOr(Schema.String)),
  supported_reasoning_levels: optional(Schema.Array(Level)),
  service_tiers: optional(Schema.NullOr(Schema.Array(Tier))),
  tool_mode: optional(Schema.NullOr(Schema.Literals(["code_mode_only", "direct"]))),
  use_responses_lite: optional(Schema.NullOr(Schema.Boolean)),
  apply_patch_tool_type: optional(Schema.NullOr(Schema.Literal("freeform"))),
  web_search_tool_type: optional(Schema.NullOr(Schema.Literals(["text", "text_and_image"]))),
  supports_image_detail_original: optional(Schema.NullOr(Schema.Boolean)),
  truncation_policy: Schema.Struct({ mode: Schema.Literals(["tokens", "bytes"]), limit: NonNegativeInt }),
  support_verbosity: optional(Schema.NullOr(Schema.Boolean)),
  default_verbosity: optional(Schema.NullOr(Schema.Literals(["low", "medium", "high"]))),
  default_reasoning_summary: optional(Schema.NullOr(Schema.Literals(["none", "auto", "concise", "detailed"]))),
  supports_reasoning_effort_updates: optional(Schema.NullOr(Schema.Boolean)),
  input_modalities: optional(Schema.NullOr(Schema.Array(Schema.String))),
  experimental_supported_tools: optional(Schema.NullOr(Schema.Array(Schema.String))),
  multi_agent_version: optional(Schema.NullOr(Schema.Literals(["v1", "v2"]))),
  supports_search_tool: optional(Schema.NullOr(Schema.Boolean)),
  model_messages: Schema.Struct({
    instructions_template: optional(Schema.String),
    collaboration_modes: optional(Schema.Unknown),
    multi_agent: optional(Schema.Unknown),
  }),
}).annotate({ identifier: "Own.CodexModels.HarnessRow" })

/**
 * A row own left out, with why (07 §4.5): the first field whose value own's `codex` harness cannot reproduce, and that
 * value as JSON text (`row` with an empty value for a row that does not decode at all). The card names both.
 */
export interface Left extends Schema.Schema.Type<typeof Left> {}
export const Left = Schema.Struct({
  slug: Schema.String,
  field: Schema.String,
  value: Schema.String,
}).annotate({ identifier: "Own.CodexModels.Left" })

/** A runtime model without its own instructions, and the bundled model whose instructions the harness uses for it. */
export interface Borrowed extends Schema.Schema.Type<typeof Borrowed> {}
export const Borrowed = Schema.Struct({ slug: Schema.String, from: Schema.String }).annotate({
  identifier: "Own.CodexModels.Borrowed",
})

/**
 * How a snapshot's rows were judged ({@link Model}'s fields and {@link decode}'s rules), as a number: a snapshot stored
 * by a build that judged otherwise (no `rows`, or a smaller one) kept rows this build would not, or lost fields, so its
 * etag must not be sent back (a 304 would keep those rows). Raised whenever {@link Model} gains a field or
 * {@link decode} leaves out other rows. 3 (CA, 2026-10-19): rows with values own's Codex harness does not handle are
 * left out ({@link HARNESS_VALUES}) and counted (`rejected`). 4 (2026-10-30): so are rows of a model newer than the harness's
 * bundled Codex catalog ({@link unknown}). 5 (2026-11-23): such a row is taken at runtime when the harness can run it
 * ({@link HarnessRow}, `harness`), and left-out rows keep why (`left`).
 */
export const ROWS = 5

/**
 * A Codex release version as the model list's `client_version` takes it: `major.minor.patch`, digits only. Codex's
 * `client_version_to_whole()` drops a pre-release part the same way (07 §4.5).
 */
export const Version = Schema.String.check(Schema.isPattern(/^\d{1,9}\.\d{1,9}\.\d{1,9}$/)).annotate({
  identifier: "Own.CodexModels.Version",
})
export type Version = typeof Version.Type

/**
 * The metadata of one kind as last fetched or read (07 §4.5). `etag` is sent back as `If-None-Match` only while
 * `clientVersion` (the Codex client version the list was asked for, ⚠PG7) is the one asked now and `rows` is
 * {@link ROWS}. A failed fetch keeps the last snapshot. `rejected`: the rows Codex lists that own left out (malformed,
 * or a value own's harness cannot reproduce, {@link decode}); absent in snapshots stored before it. `left`: those rows
 * with why. `harness`: the served rows the harness takes ({@link HarnessRow}); kept on the shared snapshot only.
 */
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  source: Source,
  fetchedAt: EpochMillis,
  etag: optional(Schema.String),
  clientVersion: optional(Schema.String),
  rows: optional(Schema.Number),
  rejected: optional(NonNegativeInt),
  left: optional(Schema.Array(Left)),
  harness: optional(Schema.Array(HarnessRow)),
  models: Schema.Array(Model),
}).annotate({ identifier: "Own.CodexModels.Snapshot" })

/**
 * The newest Codex release own read from the npm registry (`@openai/codex`'s `latest` tag, 07 §4.5 "최신 버전 자동
 * 확인"), and when it read it. A failed read keeps the last one.
 */
export interface Latest extends Schema.Schema.Type<typeof Latest> {}
export const Latest = Schema.Struct({ version: Version, fetchedAt: EpochMillis }).annotate({
  identifier: "Own.CodexModels.Latest",
})

/**
 * `OWN_HOME\codex-meta.json`: one snapshot per kind, and only `codex` has one (siwc never reads Codex metadata).
 * `accounts`: each `codex` account's own list (02 §4.8), keyed by account id, for what depends on the plan (the speed
 * tiers); the model facts every account shares stay in `kinds.codex`. Absent in files written before it.
 * `latest` and `autoVersion` (CA, 2026-10-19): the newest Codex release read from the registry, and the setting
 * `Codex 최신 모델 자동 확인` (absent: on). Both absent in files written before them.
 */
export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  version: Schema.Literal(1),
  kinds: Schema.Struct({ codex: optional(Snapshot) }),
  accounts: optional(Schema.Record(Schema.String, Snapshot)),
  latest: optional(Latest),
  autoVersion: optional(Schema.Boolean),
}).annotate({ identifier: "Own.CodexModels.File" })

/**
 * `codexModels.get` (07 §4.5, 02 §9.2): which Codex version the model lists are asked as, and what own left out.
 * - `autoVersion`: `Codex 최신 모델 자동 확인`. On, the lists are asked as the newer of this build's version and the
 *   newest Codex release own read; off, as this build's only.
 * - `version`: the `client_version` asked now; `build`: this build's (never asked lower); `latest`: the registry's
 *   newest release and when it was read, absent before the first read.
 * - `fetchedAt`: when the shared list (`kinds.codex`) was last fetched from the backend; absent before.
 * - `rejected`: rows of the shared list own left out ({@link decode}); `accounts`: the same per codex account whose own
 *   list was fetched.
 * - `left`, `accountLeft`: those rows with why ({@link Left}); absent from an older service.
 * - `borrowed`: runtime models whose row has no instructions, run with a bundled model's ({@link Borrowed}).
 */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  autoVersion: Schema.Boolean,
  version: Version,
  build: Version,
  latest: optional(Latest),
  fetchedAt: optional(EpochMillis),
  rejected: NonNegativeInt,
  accounts: Schema.Record(Schema.String, NonNegativeInt),
  left: optional(Schema.Array(Left)),
  accountLeft: optional(Schema.Record(Schema.String, Schema.Array(Left))),
  borrowed: optional(Schema.Array(Borrowed)),
}).annotate({ identifier: "Own.CodexModels.View" })

/**
 * `codexModels.rows` (in-process, own.harness, 10 §6.14): the served rows the `codex` harness takes, and a revision
 * that changes with them. With `have` equal to the current revision the rows are left out (nothing changed).
 */
export const RowsInput = Schema.Struct({ have: optional(Schema.String) }).annotate({
  identifier: "Own.CodexModels.RowsInput",
})
export type RowsInput = typeof RowsInput.Type
export const Rows = Schema.Struct({
  revision: Schema.String,
  rows: optional(Schema.Array(HarnessRow)),
}).annotate({ identifier: "Own.CodexModels.Rows" })
export type Rows = typeof Rows.Type

/** `codexModels.set`: the setting `Codex 최신 모델 자동 확인`. */
export const SetInput = Schema.Struct({ autoVersion: Schema.Boolean }).annotate({
  identifier: "Own.CodexModels.SetInput",
})
export type SetInput = typeof SetInput.Type

export function empty(): File {
  return { version: 1, kinds: {} }
}

/**
 * A decoded model list: the rows that decode (own's metadata fields), how many rows Codex would show were left out and
 * why, and the served rows own's `codex` harness takes at runtime.
 */
export interface Decoded {
  readonly models: ReadonlyArray<Model>
  readonly rejected: number
  readonly left: ReadonlyArray<Left>
  readonly harness: ReadonlyArray<HarnessRow>
}

const decodeList = Schema.decodeUnknownOption(Schema.Struct({ models: Schema.Array(Schema.Unknown) }))
const decodeModel = Schema.decodeUnknownOption(Model)
const decodeTier = Schema.decodeUnknownOption(Tier)
const decodeHarnessRow = Schema.decodeUnknownOption(HarnessRow)
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/**
 * The row fields that decide how a Codex client builds a model's tools and requests, with the values own's `codex`
 * harness handles (packages/own-harness, ported from Codex rust-v0.171.0): Codex's unified exec under each of its
 * shell names, the freeform apply_patch tool, code mode only or direct tools, token or byte truncation, text or text
 * and image web search, the v1 or v2 agent tools, and Codex's reasoning summary and verbosity values. A row naming
 * another value comes from a newer Codex than own, so {@link decode} leaves it out like a malformed row: its window,
 * priority and tiers never reach own, and it is counted with the field and value (07 §4.5 "own이 아직 모르는 모델").
 * Absent and `null` pass; a field not named here is never judged here. own-harness's catalog test checks that its
 * bundled rows pass.
 */
export const HARNESS_VALUES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["shell_type", ["shell_command", "unified_exec", "default", "local"]],
  ["apply_patch_tool_type", ["freeform"]],
  ["tool_mode", ["code_mode_only", "direct"]],
  ["truncation_policy.mode", ["tokens", "bytes"]],
  ["web_search_tool_type", ["text", "text_and_image"]],
  ["multi_agent_version", ["v1", "v2"]],
  ["default_reasoning_summary", ["none", "auto", "concise", "detailed"]],
  ["default_verbosity", ["low", "medium", "high"]],
]

/**
 * What else a served row must say for the harness to send what Codex rust-v0.171.0 sends for it (10 §6.14): the
 * `ModelInfo` fields and message kinds the harness does not reproduce, each with the value(s) under which Codex's
 * request equals own's. Codex's skill usage text, the code-mode copy of the collaboration tools, a web search provider,
 * Guardian, a model without a reasoning summary parameter, other input kinds than text and image, and model-specific
 * tool, app, plugin, permission, approval or content-filter texts change Codex's request in ways own does not follow
 * yet; a row with one of them is not taken (a bundled model keeps its bundled entry, an unknown one is left out with
 * that field). `experimental_supported_tools` is not judged: Codex itself ignores names it does not know, and the
 * harness implements every name the pinned Codex reads (own-harness `catalog.test.ts`). The apps and plugin usage
 * flags are not judged either: own has neither Codex apps nor Codex plugins, as a Codex without any.
 */
function runtimeGap(row: Readonly<Record<string, unknown>>): { field: string; value: unknown } | undefined {
  const messages = isRecord(row.model_messages) ? row.model_messages : {}
  const approvals = isRecord(messages.approvals) ? messages.approvals : {}
  const set = (value: unknown) => value !== undefined && value !== null
  const modalities = row.input_modalities
  const checks: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["truncation_policy", row.truncation_policy, !isRecord(row.truncation_policy)],
    [
      "include_skills_usage_instructions",
      row.include_skills_usage_instructions,
      row.include_skills_usage_instructions === true,
    ],
    ["multi_agent_tools_in_code_mode", row.multi_agent_tools_in_code_mode, row.multi_agent_tools_in_code_mode === true],
    ["web_search_provider", row.web_search_provider, set(row.web_search_provider)],
    ["guardian", row.guardian, set(row.guardian)],
    [
      "supports_reasoning_summary_parameter",
      row.supports_reasoning_summary_parameter,
      row.supports_reasoning_summary_parameter === false &&
        set(row.default_reasoning_summary) &&
        row.default_reasoning_summary !== "none",
    ],
    [
      "input_modalities",
      modalities,
      set(modalities) &&
        !(
          Array.isArray(modalities) &&
          modalities.length === 2 &&
          modalities.includes("text") &&
          modalities.includes("image")
        ),
    ],
    ...(["tools", "apps", "plugins", "permissions", "content_filter_guidance"] as const).map(
      (key) => [`model_messages.${key}`, messages[key], set(messages[key])] as const,
    ),
    ...Object.entries(approvals)
      .filter(([key]) => key !== "on_request_auto_review")
      .map(([key, value]) => [`model_messages.approvals.${key}`, value, set(value)] as const),
  ]
  const found = checks.find((check) => check[2])
  return found && { field: found[0], value: found[1] }
}

/**
 * A row of a model newer than own's bundled Codex catalog: its slug starts with no slug of the catalog the harness
 * bundles ({@link CODEX_SLUGS}, generated with it; Codex's longest-prefix match, so a model id that extends a catalog
 * slug is that model), names no model an earlier catalog up to the pin had ({@link CODEX_RETIRED_SLUGS}), and carries
 * no upgrade hint (Codex points such a model at its successor, so it is an older one). Such a model runs from its
 * served row when the harness can take it ({@link HarnessRow}); else it is left out until an own update (07 §4.5).
 */
function unknown(model: Model) {
  return (
    !CODEX_SLUGS.some((prefix) => model.slug.startsWith(prefix)) &&
    !CODEX_RETIRED_SLUGS.includes(model.slug) &&
    !model.upgrade
  )
}

/** A row Codex never shows (`visibility` `hide` or `none`): left out unseen, so never counted. */
const hidden = Schema.is(Schema.Struct({ visibility: Schema.Literals(["hide", "none"]) }))

/**
 * A model id Codex's bundled catalog offers ({@link CODEX_SLUGS}): a catalog slug itself, or one extended after a `-`
 * (a mode such as its fast entry), as the harness looks models up. A specialised model the Codex picker never lists is
 * none.
 */
export function catalogued(id: string) {
  return CODEX_SLUGS.some((slug) => id === slug || id.startsWith(`${slug}-`))
}

/**
 * The bundled model whose instructions a served row without any borrows (10 §6.14): the first bundled slug (Codex's
 * catalog order) of the same family, the part after `<name>-<version>` (a `-sol` model borrows the first bundled
 * `-sol` model's), else the first bundled model. Codex itself refuses a list with such a row; own runs it and says so
 * on the card.
 */
export function nearest(slug: string) {
  const family = (id: string) => id.replace(/^[a-z]+-\d+(?:\.\d+)?/, "")
  const own = family(slug)
  const named = own !== slug && own !== ""
  return (named ? CODEX_SLUGS.find((candidate) => family(candidate) === own) : undefined) ?? CODEX_SLUGS[0]!
}

/** The runtime models of `rows` that have no instructions of their own, with the bundled model each borrows from. */
export function borrowed(rows: ReadonlyArray<HarnessRow>): ReadonlyArray<Borrowed> {
  return rows
    .filter((row) => row.model_messages.instructions_template === undefined)
    .map((row) => ({ slug: row.slug, from: nearest(row.slug) }))
}

/**
 * The rows of a model list body, the backend's answer or `models_cache.json` (both carry `models`). Each row is
 * judged alone ({@link judge}): a malformed row, one whose harness fields carry a value own does not handle
 * ({@link HARNESS_VALUES}), or one of a model newer than the bundled catalog ({@link unknown}) that the harness cannot
 * take at runtime ({@link runtimeGap}) is left out and counted, with why, unless Codex hides it; the others stay,
 * older models' rows included. A malformed speed tier entry drops only that entry, never the row (whose window own
 * registers, R8). `undefined` when the body has no `models` list at all (the caller then keeps its last snapshot).
 */
export function decode(body: unknown): Decoded | undefined {
  const list = Option.getOrUndefined(decodeList(body))
  if (!list) return undefined
  const judged = list.models.map(judge)
  const shown = judged.filter((item) => item.left !== undefined && !hidden(item.row))
  return {
    models: judged.flatMap((item) => (item.model ? [item.model] : [])),
    rejected: shown.length,
    left: shown.flatMap((item) => (item.left ? [item.left] : [])),
    harness: judged.flatMap((item) => (item.harness ? [item.harness] : [])),
  }
}

interface Judged {
  readonly row: unknown
  readonly model?: Model
  readonly harness?: HarnessRow
  readonly left?: Left
}

/**
 * One row: own's metadata fields when the row decodes and every harness value is one own handles; the harness row
 * when the harness can also reproduce Codex's request for it (and the row has instructions, or names a model the
 * bundled catalog lacks, which then borrows, {@link nearest}); a bundled or older model keeps its metadata either way,
 * a newer one only with a harness row.
 */
function judge(row: unknown): Judged {
  const slug = isRecord(row) && typeof row.slug === "string" ? row.slug : ""
  const model = isRecord(row) ? Option.getOrUndefined(decodeModel(withTiers(row))) : undefined
  if (!isRecord(row) || !model) return { row, left: leftOf(slug, "row", undefined) }
  const policy = row.truncation_policy
  if (policy !== undefined && policy !== null && !isRecord(policy)) return { row, left: leftOf(slug, "truncation_policy", policy) }
  const value = HARNESS_VALUES.map(([field, values]) => [field, at(row, field), values] as const).find(
    ([, found, values]) => found !== undefined && found !== null && !(typeof found === "string" && values.includes(found)),
  )
  if (value) return { row, left: leftOf(slug, value[0], value[1]) }
  const gap = runtimeGap(row)
  const harness = gap ? undefined : Option.getOrUndefined(decodeHarnessRow(promoted(row)))
  const newer = unknown(model)
  const runnable = harness && (newer || harness.model_messages.instructions_template !== undefined) ? harness : undefined
  if (runnable) return { row, model, harness: runnable }
  if (!newer) return { row, model }
  return { row, left: gap ? leftOf(slug, gap.field, gap.value) : leftOf(slug, "row", undefined) }
}

/** `deserialize_model_infos_with_legacy_base`: a top-level `base_instructions` fills a missing instructions template. */
function promoted(row: Readonly<Record<string, unknown>>) {
  const messages = isRecord(row.model_messages) ? row.model_messages : {}
  const template = typeof messages.instructions_template === "string" ? messages.instructions_template : undefined
  const base = typeof row.base_instructions === "string" ? row.base_instructions : undefined
  const instructions = template ?? base
  const tiered = withTiers(row)
  return {
    ...(isRecord(tiered) ? tiered : row),
    model_messages: {
      ...(instructions === undefined || instructions === "" ? {} : { instructions_template: instructions }),
      ...(messages.collaboration_modes === undefined ? {} : { collaboration_modes: messages.collaboration_modes }),
      ...(messages.multi_agent === undefined ? {} : { multi_agent: messages.multi_agent }),
    },
  }
}

/** A dotted path's value in a row (`truncation_policy.mode`). */
function at(row: Readonly<Record<string, unknown>>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), row)
}

/** {@link Left} with the value as short JSON text (a long text is cut: the card names the field, not a prompt). */
function leftOf(slug: string, field: string, value: unknown): Left {
  const text = value === undefined ? "" : (JSON.stringify(value) ?? "")
  return { slug, field, value: text.length > 80 ? `${text.slice(0, 79)}…` : text }
}

/** A row whose speed tier lists keep only well-formed entries; a list of another shape is dropped. */
function withTiers(row: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row
  const fields: Record<string, unknown> = { ...row }
  const tiers = fields.service_tiers
  if (Array.isArray(tiers)) fields.service_tiers = tiers.flatMap((tier) => Option.toArray(decodeTier(tier)))
  else if (tiers !== null) delete fields.service_tiers
  const legacy = fields.additional_speed_tiers
  if (Array.isArray(legacy))
    fields.additional_speed_tiers = legacy.filter((tier): tier is string => typeof tier === "string" && tier !== "")
  else if (legacy !== null) delete fields.additional_speed_tiers
  if (typeof fields.default_service_tier !== "string" && fields.default_service_tier !== null)
    delete fields.default_service_tier
  return fields
}

const decodeCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      fetched_at: optional(Schema.NullOr(Schema.String)),
      etag: optional(Schema.NullOr(Schema.String)),
      client_version: optional(Schema.NullOr(Schema.String)),
      models: Schema.Array(Schema.Unknown),
    }),
  ),
)

/**
 * The Codex CLI's `models_cache.json` text as a `pc-cache` snapshot (07 §4.5): its rows ({@link decode}), its etag
 * and client version, and its `fetched_at` (else `modified`, the file's own time). `undefined` for text that is not
 * such a file.
 */
export function fromCache(text: string, modified: number): Snapshot | undefined {
  const cache = Option.getOrUndefined(decodeCache(text))
  const rows = cache && decode(cache)
  if (!cache || !rows) return undefined
  const fetched = cache.fetched_at ? Date.parse(cache.fetched_at) : Number.NaN
  return {
    source: "pc-cache",
    fetchedAt: Number.isFinite(fetched) && fetched >= 0 ? fetched : modified,
    ...(cache.etag ? { etag: cache.etag } : {}),
    ...(cache.client_version ? { clientVersion: cache.client_version } : {}),
    models: rows.models,
  }
}

/** The row of `slug`, if the snapshot has one. */
export function find(snapshot: Pick<Snapshot, "models"> | undefined, slug: string): Model | undefined {
  return snapshot?.models.find((model) => model.slug === slug)
}

/**
 * The speed tiers a row lists for its account (02 §4.8): `service_tiers`, else the deprecated `additional_speed_tiers`
 * (`fast` meaning Codex's Fast, request value `priority`). `undefined` when the row says nothing about tiers, so the
 * caller can tell "no tiers" (an empty list) from "not reported".
 */
export function tiers(model: Model): ReadonlyArray<Tier> | undefined {
  if (model.service_tiers) return model.service_tiers
  if (!model.additional_speed_tiers) return undefined
  return model.additional_speed_tiers.map((id) => (id === "fast" ? { id: "priority", name: "Fast" } : { id }))
}

/**
 * The speed tiers of one model list entry ({@link tiers}), read without judging its model: token sharing's account
 * catalog (own-accounts `ChatgptSharing.tiersOf`) lists models the `codex` harness need not know. `undefined` when the
 * entry is malformed or says nothing about tiers.
 */
export function entryTiers(entry: unknown): ReadonlyArray<Tier> | undefined {
  const model = Option.getOrUndefined(decodeModel(withTiers(entry)))
  return model && tiers(model)
}

/**
 * The largest input the model accepts (07 §4.5, R8): `max_context_window` only. A row without it gives no window:
 * `context_window` is Codex's default, not the model's capacity, and registering it would shorten the context below
 * what the model takes (U6/R8); the caller then falls back to what it knows without the metadata.
 */
export function maxInput(model: Model): number | undefined {
  return model.max_context_window ?? undefined
}

/**
 * A model's reasoning levels in Codex's order (07 §2.3). With `offered` (the registered model's variant ids) only the
 * levels it offers are kept, since core rejects any other variant. Without metadata, or when the row lists no
 * levels, `offered` stays as it is.
 */
export function levels(model: Model | undefined, offered?: ReadonlyArray<string>): string[] {
  const listed = (model?.supported_reasoning_levels ?? []).map((level) => level.effort)
  if (listed.length === 0) return [...(offered ?? [])]
  return offered ? listed.filter((level) => offered.includes(level)) : listed
}

/** Codex's client-only ultra mode: a level of the list that is never sent (07 §2.9, Appendix A). */
const ULTRA = "ultra"

/**
 * The effort Codex sends with ultra on (Codex's `resolve_reasoning_effort`, 07 Appendix A): the model's
 * `multi_agent_reasoning_effort` when it is a listed level other than `ultra`, else `max` when listed, else the
 * highest listed level other than `ultra`. `undefined` without levels (Codex would fall back to `medium`; own sends
 * none instead). `offered` narrows the levels as in {@link levels}.
 */
export function ultraLevel(model: Model, offered?: ReadonlyArray<string>): string | undefined {
  const list = levels(model, offered).filter((level) => level !== ULTRA)
  const multi = model.multi_agent_reasoning_effort
  if (multi && list.includes(multi)) return multi
  return list.includes("max") ? "max" : list.at(-1)
}

/** The model's Codex priority (1 first); `undefined` when the row has none. */
export function priority(model: Model): number | undefined {
  return model.priority ?? undefined
}

/**
 * The model's upgrade hint (07 §4.3): the successor Codex names, and the retirement time in epoch ms when the row
 * has a readable date. `undefined` without a hint.
 */
export function upgrade(model: Model): { readonly model: string; readonly retirementAt?: number } | undefined {
  const hint = model.upgrade
  if (!hint) return undefined
  const at = hint.retirement_at ? Date.parse(hint.retirement_at) : Number.NaN
  return { model: hint.model, ...(Number.isFinite(at) ? { retirementAt: at } : {}) }
}

/** The rows as `Preset.CodexHints.models` reads them for the ChatGPT group's `auto` default (07 §2.2 ②). */
export function hints(models: ReadonlyArray<Model>) {
  return models.map((model) => ({
    slug: model.slug,
    ...(model.priority == null ? {} : { priority: model.priority }),
    ...(model.default_reasoning_level ? { defaultEffort: model.default_reasoning_level } : {}),
  }))
}

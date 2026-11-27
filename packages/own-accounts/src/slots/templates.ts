export * as Templates from "./templates.js"

import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { CodexModels, Kind, OwnID, Registry, type Account, type OwnAccounts } from "@own/protocol"
import { CodexMeta } from "./codex-meta.js"
import { LocalModel } from "./local-model.js"

/**
 * Pinned model templates (02 §2.4.2, §3.6a). A template is a copy of the catalog provider's model definitions as the
 * own-accounts provider fold saw them (before claude-auth and before any model transform), with the kind rules of
 * 02 §3.6 applied once. Every slot of a kind shares its kind's current template, so `model.name`, family and variants
 * stay byte-identical across slots (D4, D9); the fields outside the request bytes are read live ({@link live}, 07
 * §4.4). Pure functions only: capture and I/O live in `slots.ts`, and the Codex window reads the metadata snapshot
 * that `CodexMeta` keeps in memory unless a caller passes one.
 */

/** Kinds registered from a shared catalog template. `compat` builds one template per slot from user input. */
export type CatalogKind = Exclude<Kind.Own, "compat">

export const CATALOG_KINDS: ReadonlyArray<CatalogKind> = ["codex", "siwc", "oai", "anth", "ds", "xai", "or"]

/** Catalog provider each kind copies its template from (02 §3.6a rule 2). */
export const SOURCE: Readonly<Record<CatalogKind, Provider.ID>> = {
  codex: Provider.ID.make("openai"),
  siwc: Provider.ID.make("openai"),
  oai: Provider.ID.make("openai"),
  anth: Provider.ID.make("anthropic"),
  ds: Provider.ID.make("deepseek"),
  xai: Provider.ID.make("xai"),
  or: Provider.ID.make("openrouter"),
}

/** The catalog providers captured in the fold. */
export const SOURCES: ReadonlyArray<Provider.ID> = [...new Set(Object.values(SOURCE))]

/** Pay-as-you-go kinds: a model without a price is never registered, so spend never shows as $0 (02 §3.6a rule 4). */
export const METERED: ReadonlySet<Kind.Own> = new Set(["oai", "anth", "ds", "xai", "or"])

// Mirrors the upstream ChatGPT wiring (`core/src/plugin/provider/openai.ts` `codexDisallowed` and its model transform);
// `check-surface` compares. Since upstream v2.1 (cdf1c200a6) Codex rejects gpt-5.5 and older models, gpt-5.3-codex-spark
// included, for ChatGPT accounts.
const CODEX_DISALLOWED = new Set(["gpt-5.6"])

// Codex's model metadata (`max_context_window`, 07 §4.5) for the models it is known for: 872k maximum input (128k
// output reserved) where the catalog advertises the larger API window. Stands in for a model the metadata snapshot
// lacks until T2.21 removes it, once the metadata fetch is verified live (07 PG7 (나)).
const CODEX_LONG_CONTEXT = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
])

/**
 * Models a Sign in with ChatGPT account may call before its own catalog is known: upstream's fallback set
 * (`core/src/plugin/provider/chatgpt.ts` `fallbackModels` at bd55d4895f, upstream 209346a0fe added the GPT-6 Luna and
 * Sol models and 4e982c0814 GPT-6.1 Terra; `check-surface` compares). `-fast` twins carry `service_tier`.
 */
export const SHARING_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
  "gpt-6-astra",
  "gpt-6-astra-fast",
  "gpt-6-luna",
  "gpt-6-luna-fast",
  "gpt-6-sol",
  "gpt-6-sol-fast",
  "gpt-6.1-sol",
  "gpt-6.1-sol-fast",
  "gpt-6.1-terra",
  "gpt-6.1-terra-fast",
])

/**
 * The Codex subscription window of a model, or `undefined` when none is known: that model registers with its live
 * catalog window instead of a shorter guess (07 §6.1, §6.2 #4) and raises `codex_window_unverified`.
 * - The Codex metadata's largest input (`max_context_window`) when the snapshot has the model, with the model's output
 *   room on top for the context (07 §4.5). A row with only `context_window` gives no window: that is Codex's default
 *   (272k for every model), not the model's capacity, and taking it would shorten a long-context model (R8). `meta`
 *   defaults to the snapshot loaded outside the fold (`CodexMeta.current()`), so the fold's callers pass nothing.
 * - Without it: the upstream mirror's spark and GPT-5.5 windows, then the stand-in list (`CODEX_LONG_CONTEXT`).
 */
export function codexLimit(
  model: Pick<Registry.TemplateModel, "id" | "modelID"> & {
    readonly limit?: Pick<Registry.TemplateModel["limit"], "output">
  },
  meta: CodexModels.Snapshot | undefined = CodexMeta.current(),
) {
  // A speed mode entry (`-fast`, `-ultrafast`, models.dev `experimental.modes`) has its base model's window.
  const id = (model.modelID ?? model.id).replace(/-(?:fast|ultrafast)$/, "")
  const row = CodexModels.find(meta, id)
  const max = row && CodexModels.maxInput(row)
  if (max !== undefined) return { context: max + (model.limit?.output ?? 0), input: max }
  if (id === "gpt-5.3-codex-spark") return { context: 128_000, input: 100_000 }
  // GPT-5.5 keeps 272k input on subscriptions even though its API window is larger.
  if (id === "gpt-5.5") return { context: 400_000, input: 272_000 }
  if (CODEX_LONG_CONTEXT.has(id)) return { context: 1_000_000, input: 872_000 }
  return undefined
}

/**
 * The window a model registers with: a known Codex subscription window ({@link codexLimit}, `codex` only, never `siwc`)
 * over the catalog's API window.
 */
export function limit(
  kind: Kind.Own,
  model: Pick<Registry.TemplateModel, "id" | "modelID" | "limit">,
  meta: CodexModels.Snapshot | undefined = CodexMeta.current(),
) {
  const codex = kind === "codex" ? codexLimit(model, meta) : undefined
  return codex ? { ...model.limit, ...codex } : model.limit
}

/** Catalog providers as a provider fold last saw them, keyed by provider id (`Slots` keeps one per instance). */
export type Live = ReadonlyMap<string, { readonly models: ReadonlyMap<string, Model.Info> }>

/**
 * A pinned model as it registers now (07 §4.4). `limit`, `cost`, `status` and the release date never reach the
 * request bytes (02 §4.3 D6), so they come from the live fold snapshot of the same model id; the fields that do
 * (name, family, variants, package, settings, capabilities) stay pinned. A model the snapshot lacks keeps its pinned
 * values. Codex and siwc stay free (`cost: []`, plan-billed), and a live entry without a price keeps the pinned one:
 * claude-auth rewrites `anthropic` to `cost: []` (I6) and a metered model is never registered as $0 (02 §3.6a rule 4).
 * siwc takes the `openai` snapshot's API window like upstream's token sharing (209346a0fe), also over a template an
 * older build lowered to its account catalog's window (R8, 02 §3.2c). A `codex` model's window then follows
 * {@link limit} (the Codex metadata snapshot, `meta`).
 */
export function live(
  kind: Kind.Own,
  model: Registry.TemplateModel,
  snapshot: Live,
  meta: CodexModels.Snapshot | undefined = CodexMeta.current(),
): Registry.TemplateModel {
  const source = kind === "compat" ? undefined : snapshot.get(SOURCE[kind])?.models.get(model.id)
  const current = source
    ? {
        ...model,
        limit: source.limit,
        status: source.status,
        time: { ...model.time, released: source.time.released },
        cost: Kind.isOAuth(kind) || source.cost.length === 0 ? model.cost : source.cost,
      }
    : model
  return { ...current, limit: limit(kind, current, meta) }
}

/** Ids of the models live Codex slots register with their catalog window, since no Codex window is known. */
export function unverifiedCodex(registry: Registry.File, meta: CodexModels.Snapshot | undefined = CodexMeta.current()) {
  return [
    ...new Set(
      Object.values(registry.slots)
        .filter((slot) => slot.kind === "codex" && !slot.retired)
        .flatMap((slot) => registry.modelTemplates[slot.modelTemplate]?.models ?? [])
        .filter((model) => model.enabled && codexLimit(model, meta) === undefined)
        .map((model) => String(model.id)),
    ),
  ].toSorted()
}

const isProMode = Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))

/** Whether a Sign in with ChatGPT token may call this model before its catalog is known (pro mode never). */
export function sharingAllowed(model: Pick<Model.Info, "id" | "body">) {
  return !isProMode(model.body?.reasoning) && SHARING_MODELS.has(model.id)
}

/**
 * Whether a model reads and writes text: upstream's `Model.supportsText` (`core/src/model.ts`, 944959566f), which keeps
 * every other model out of the models.dev catalog (`core/src/plugin/models-dev.ts`; `check-surface` compares). A pinned
 * model failing it is therefore never "gone upstream" (`TemplateDiff.diff`).
 */
export function supportsText(model: Pick<Model.Info, "capabilities">) {
  return (
    (model.capabilities.input.length === 0 || model.capabilities.input.some((item) => item.startsWith("text"))) &&
    (model.capabilities.output.length === 0 || model.capabilities.output.some((item) => item.startsWith("text")))
  )
}

/** Whether a ChatGPT token may call this model (the upstream codex filter, 02 §3.6 "codex 모델 규칙"). */
export function codexAllowed(model: Pick<Model.Info, "id" | "modelID" | "body">) {
  if (isProMode(model.body?.reasoning)) return false
  // Flex processing is an API-key service tier (models.dev lists `-flex` modes since upstream v2.4.0); a ChatGPT login
  // has none, and own's speeds skip it (@own/protocol `Speed.modes`).
  if (model.body?.service_tier === "flex") return false
  const apiID = model.modelID ?? model.id
  const match = apiID.match(/^gpt-(\d+)(?:\.(\d+))?/)
  if (CODEX_DISALLOWED.has(apiID) || !match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor > 5)
}

export type Built =
  | {
      readonly ok: true
      readonly template: Registry.ModelTemplate
      /** Metered models left out because the catalog has no price for them (alert `template_cost_missing`). */
      readonly dropped: ReadonlyArray<string>
    }
  | { readonly ok: false; readonly reason: string }

/**
 * Builds a kind's template from a fold snapshot of its catalog provider (02 §3.6a rule 2). `anth` refuses a snapshot
 * with any priceless model: claude-auth writes `cost: []` into `anthropic`, and that must never leak into our slots
 * (I6); the caller then falls back to the bundled template (rule 3). Models without text in or out are left out, as
 * core's catalog leaves them out ({@link supportsText}).
 */
export function fromCatalog(kind: CatalogKind, models: Iterable<Model.Info>, capturedAt: string): Built {
  const all = [...models].filter(supportsText)
  if (all.length === 0) return { ok: false, reason: "catalog_empty" }
  if (kind === "anth" && all.some((model) => model.cost.length === 0)) return { ok: false, reason: "cost_missing" }
  const eligible = kind === "codex" ? all.filter(codexAllowed) : kind === "siwc" ? all.filter(sharingAllowed) : all
  const priced = METERED.has(kind) ? eligible.filter((model) => model.cost.length > 0) : eligible
  if (priced.length === 0) return { ok: false, reason: "no_eligible_models" }
  return {
    ok: true,
    template: {
      kind,
      sourceProvider: SOURCE[kind],
      source: "snapshot",
      capturedAt,
      models: priced.map((model) =>
        kind === "codex"
          ? codexModel(copy(kind, model))
          : kind === "siwc"
            ? sharingModel(copy(kind, model))
            : copy(kind, model),
      ),
    },
    dropped: eligible.filter((model) => model.cost.length === 0).map((model) => model.id),
  }
}

/**
 * A `compat` model's output cap when neither its server nor the user gave one (07 §6.2 #7). Recorded as `fallback` and
 * shown as `모름`; never above the model's window.
 */
const COMPAT_FALLBACK_OUTPUT = 32_000

/**
 * The output cap a `compat` model registers with before its server was asked (07 §6.2 #7): the user's add-account value
 * (`user`), else {@link COMPAT_FALLBACK_OUTPUT} (`fallback`), never above the window. A value the server reports later
 * wins over both (`CompatProbe.apply`).
 */
export function compatOutput(model: OwnAccounts.CompatModel): Account.CompatOutput {
  const context = model.contextLimit ?? COMPAT_FALLBACK_OUTPUT
  return model.outputLimit === undefined
    ? { tokens: Math.min(COMPAT_FALLBACK_OUTPUT, context), source: "fallback" }
    : { tokens: Math.min(model.outputLimit, context), source: "user" }
}

/**
 * A `compat` model's registered capabilities (02 §3.3): image input and tools follow the user's setting, else what the
 * server reported, else text only with tools on (what every `compat` model registered with before). Output is text.
 */
export function compatCapabilities(stored: Account.CompatCapabilities | undefined): Model.Capabilities {
  const image = stored?.image === undefined ? stored?.detected?.image === true : stored.image === "on"
  const tools = stored?.tools === undefined ? stored?.detected?.tools !== false : stored.tools === "on"
  return { tools, input: image ? ["text", "image"] : ["text"], output: ["text"] }
}

/**
 * `stored` with the user's settings (02 §3.3): an absent setting keeps the stored one, `auto` drops it (the server's
 * value applies again), `on` and `off` are stored. What the server reported is kept.
 */
export function compatSettings(
  stored: Account.CompatCapabilities | undefined,
  settings: {
    readonly image?: Account.CompatSetting
    readonly tools?: Account.CompatSetting
    readonly reasoning?: Account.ReasoningSetting
  },
): Account.CompatCapabilities {
  const image = settings.image === undefined ? stored?.image : settings.image === "auto" ? undefined : settings.image
  const tools = settings.tools === undefined ? stored?.tools : settings.tools === "auto" ? undefined : settings.tools
  const reasoning =
    settings.reasoning === undefined
      ? stored?.reasoning
      : settings.reasoning === "auto"
        ? undefined
        : settings.reasoning
  return {
    ...(stored?.detected ? { detected: stored.detected } : {}),
    ...(image ? { image } : {}),
    ...(tools ? { tools } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

/**
 * `compat` template from the user's model list (02 §3.3 "compat 전용"). `limit.context` is required: without it core
 * never compacts automatically (`core/src/session/compaction.ts:870-871`).
 */
export function fromCompat(
  models: ReadonlyArray<OwnAccounts.CompatModel>,
  capturedAt: string,
  local?: Account.Local,
): Built {
  if (models.length === 0) return { ok: false, reason: "compat_models_required" }
  const missing = models.filter((model) => model.contextLimit === undefined).map((model) => model.id)
  if (missing.length > 0) return { ok: false, reason: `compat_context_required:${missing.join(",")}` }
  return {
    ok: true,
    template: {
      kind: "compat",
      source: "user",
      capturedAt,
      models: models.map((model) => compatModel(model, local)),
    },
    dropped: [],
  }
}

/** A template id that is not in the registry yet: `tpl_<kind>_<yyyymmdd>[_<n>]` (02 §2.4.1). */
export function newID(kind: Kind.Own, now: number, taken: Readonly<Record<string, unknown>>) {
  const base = `tpl_${kind}_${new Date(now).toISOString().slice(0, 10).replaceAll("-", "")}`
  const free = (index: number): string => {
    const id = index === 1 ? base : `${base}_${index}`
    return id in taken ? free(index + 1) : id
  }
  return OwnID.TemplateID.make(free(1))
}

/** The kind's current shared template: the one its live slots use, else the newest captured one. */
export function current(registry: Registry.File, kind: CatalogKind): string | undefined {
  const used = Object.values(registry.slots).find((slot) => slot.kind === kind && !slot.retired)?.modelTemplate
  if (used && registry.modelTemplates[used]) return used
  return Object.entries(registry.modelTemplates)
    .filter((entry) => entry[1].kind === kind)
    .sort((a, b) => b[1].capturedAt.localeCompare(a[1].capturedAt))[0]?.[0]
}

const decodeModelTemplate = Schema.decodeUnknownOption(Registry.ModelTemplate)

/**
 * Bundled fallback template (02 §3.6a rule 3): `templates/<kind>.json`, generated from the fork base's bundled
 * models.dev snapshot with the same rules as {@link fromCatalog} (`test/slots/generate-templates.ts`). Used when no
 * fold snapshot is usable, e.g. `anthropic` already rewritten to `cost: []`. Loaded lazily; `undefined` if unusable.
 */
export async function bundled(kind: CatalogKind): Promise<Registry.ModelTemplate | undefined> {
  const loaded: unknown = await BUNDLED[kind]()
    .then((module) => module.default)
    .catch(() => undefined)
  return Option.getOrUndefined(decodeModelTemplate(loaded))
}

// Static specifiers so a bundler keeps each file; each is imported only when needed.
const BUNDLED: Readonly<Record<CatalogKind, () => Promise<{ readonly default: unknown }>>> = {
  codex: () => import("./templates/codex.json", { with: { type: "json" } }),
  siwc: () => import("./templates/siwc.json", { with: { type: "json" } }),
  oai: () => import("./templates/oai.json", { with: { type: "json" } }),
  anth: () => import("./templates/anth.json", { with: { type: "json" } }),
  ds: () => import("./templates/ds.json", { with: { type: "json" } }),
  xai: () => import("./templates/xai.json", { with: { type: "json" } }),
  or: () => import("./templates/or.json", { with: { type: "json" } }),
}

/**
 * One catalog model as a template entry: `providerID` and `canonical` dropped (the slot supplies both), the kind's
 * native package on the model (02 §3.6 "각 모델 항목의 package도 같은 값으로"), and no model-level `baseURL`, so the
 * slot's static `settings.baseURL` is the only endpoint (hooks never change it, 02 §3.6).
 */
function copy(kind: Kind.Own, model: Model.Info): Registry.TemplateModel {
  const { providerID: _providerID, canonical: _canonical, settings, ...rest } = model
  const kept = settings && Object.fromEntries(Object.entries(settings).filter((entry) => entry[0] !== "baseURL"))
  return {
    ...structuredClone(rest),
    package: Kind.meta[kind].package,
    ...(kept && Object.keys(kept).length > 0 ? { settings: structuredClone(kept) } : {}),
  }
}

/** ChatGPT plans cover usage and use the maximum subscription window of each model. */
function codexModel(model: Registry.TemplateModel): Registry.TemplateModel {
  return { ...model, cost: [], limit: limit("codex", model) }
}

/**
 * Token sharing is plan-billed and has no native `/responses/compact`, so every model compacts by summary even if a
 * catalog setting says otherwise (upstream forces it per model as well as per provider).
 */
function sharingModel(model: Registry.TemplateModel): Registry.TemplateModel {
  return { ...model, cost: [], settings: { ...model.settings, compaction: { type: "summary" } } }
}

function compatModel(model: OwnAccounts.CompatModel, local: Account.Local | undefined): Registry.TemplateModel {
  const context = model.contextLimit ?? 0
  const id = Model.ID.make(model.id)
  const settings = compatSettings(undefined, model)
  return {
    id,
    modelID: id,
    name: model.id,
    package: local ? LocalModel.PACKAGES[local.format] : Kind.meta.compat.package,
    // The add form's settings; what the server reports arrives with `CompatProbe.apply`.
    capabilities: compatCapabilities(settings),
    variants: LocalModel.variants(
      LocalModel.reasoningOf(settings),
      local?.format ?? "chat",
      compatOutput(model).tokens,
    ),
    time: { released: 0 },
    cost: model.cost
      ? [
          {
            input: Money.USDPerMillionTokens.make(model.cost.input),
            output: Money.USDPerMillionTokens.make(model.cost.output),
            cache: {
              read: Money.USDPerMillionTokens.make(model.cost.cacheRead ?? 0),
              write: Money.USDPerMillionTokens.make(model.cost.cacheWrite ?? 0),
            },
          },
        ]
      : [],
    status: "active",
    enabled: true,
    limit: { context, output: compatOutput(model).tokens },
  }
}

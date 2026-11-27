export * as Registration from "./registration.js"

import { Struct } from "effect"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { CodexModels, Compaction, Kind, type Account, type Policy, type Registry } from "@own/protocol"
import type { Endpoints } from "../endpoints.js"
import { LocalModel } from "./local-model.js"
import { Templates } from "./templates.js"

/**
 * Provider and model definitions of the own slots (02 §3.6, 01 §8.2), built from the registry in memory and the
 * catalog the provider fold just saw (07 §4.4). Pure: no I/O in folds (02 §3.8).
 *
 * Every slot goes through core's `Auth.none` path (`core/src/model-resolver.ts:374-380`): `activation: "enabled"`, no
 * `integrationID` (no connection can exist for `own-*`), no `apiKey`/`authToken`/`accessToken` in settings, and a
 * native package from core's `usesAPIKeyAuth` list on the provider and on every model (`editor.add` skips
 * `AISDKNative.rewrite`, so the package is written native from the start). Credentials are injected per request by
 * the `model.request` hook; nothing secret or account-identifying is ever written here (C1).
 */

/** Display names; `provider.name` may carry the account label, `model.name` never does (R-ID-5). */
export const KIND_NAMES: Readonly<Record<Kind.Own, string>> = {
  codex: "ChatGPT",
  siwc: "ChatGPT",
  oai: "OpenAI",
  anth: "Anthropic",
  ds: "DeepSeek",
  xai: "xAI",
  or: "OpenRouter",
  compat: "OpenAI-compatible",
}

/** Endpoint override of each kind whose production slot omits `settings.baseURL` (02 §3.6). */
const ENDPOINT: Readonly<Partial<Record<Kind.Own, Endpoints.Name>>> = {
  oai: "openai",
  // Sign in with ChatGPT is served by the public API at its default base URL (02 §3.2c), never the Codex backend.
  siwc: "openai",
  anth: "anthropic",
  ds: "deepseek",
  xai: "xai",
  or: "openrouter",
}

/** Static ChatGPT headers of the upstream wiring (`openai.ts:264-268`). Not secret, not account specific. */
export const CODEX_HEADERS: Readonly<Record<string, string>> = {
  originator: "opencode",
  "x-codex-beta-features": "remote_compaction_v2",
}

/**
 * Route timeouts of a `compat` slot: none, as before upstream 4c0d0ff478 gave every route five-minute header and chunk
 * timeouts (`core/src/provider.ts` DEFAULT_TIMEOUT_MS) with up to three timeout retries. A local server can read a long
 * prompt for longer than that before its first byte, and each retry starts the prompt over (U6). Not request bytes.
 */
const COMPAT_TIMEOUTS = { headerTimeout: false, chunkTimeout: false } as const

/** The Claude subscription slot's provider: never ours, never hidden by `hideBuiltinProviders` (02 §8.4). */
const ANTHROPIC = Provider.ID.make("anthropic")

export interface Definition {
  readonly info: Provider.Info
  readonly models: ReadonlyArray<Model.Info>
}

export interface Problem {
  readonly providerID: string
  readonly reason: "account_missing" | "template_missing" | "definition_failed"
  /** `definition_failed`: what building the slot's provider or models threw. */
  readonly error?: unknown
}

/** The account registered in a slot (MVP: one account per slot, 02 §2.2 R-ID-2). */
export function accountOf(registry: Registry.File, slot: Registry.Slot): Account.Info | undefined {
  return registry.accounts.find((account) => account.id === slot.accounts[0])
}

/** What the auto-compaction threshold of a slot model depends on besides the account (02 §4.7.4). */
export interface CompactionInput {
  /** `policy.compaction.byKind`. */
  readonly policy?: Compaction.ByKind | undefined
  /** Core `keep` from the own global config (`T_floor`); default 15k. */
  readonly keep?: number | undefined
}

/**
 * `editor.add` inputs for every slot of the registry, retired slots included (their models are disabled). `live` is
 * the catalog of the current fold; without it every model keeps its pinned values. A slot whose definition throws (a
 * live catalog entry another fold left malformed, a defect) is reported as `definition_failed` and left out, so the
 * other slots, the built-in hiding and the `anthropic` rule of the same fold still apply.
 */
export function definitions(
  registry: Registry.File,
  endpoints: Endpoints.Endpoints,
  compaction: CompactionInput = {},
  live: Templates.Live = new Map(),
  /** The served Codex rows (10 §6.14): models no catalog lists yet register from them ({@link served}). */
  rows: ReadonlyArray<CodexModels.HarnessRow> = [],
) {
  const problems: Problem[] = []
  const built = Object.entries(registry.slots).flatMap(([id, slot]): Definition[] => {
    const providerID = Kind.ProviderID.make(id)
    const account = accountOf(registry, slot)
    if (!account) {
      problems.push({ providerID, reason: "account_missing" })
      return []
    }
    const template = registry.modelTemplates[slot.modelTemplate]
    if (!template) {
      problems.push({ providerID, reason: "template_missing" })
      return []
    }
    try {
      return [
        {
          info: providerInfo({ providerID, slot, account, endpoints }),
          models: models({ providerID, slot, account, template, compaction, live, rows }),
        },
      ]
    } catch (error) {
      problems.push({ providerID, reason: "definition_failed", error })
      return []
    }
  })
  return { definitions: built, problems }
}

/** Provider info of one slot (02 §3.6 table and examples). */
export function providerInfo(input: {
  readonly providerID: Kind.ProviderID
  readonly slot: Registry.Slot
  readonly account: Account.Info
  readonly endpoints: Endpoints.Endpoints
}): Provider.Info {
  const kind = input.slot.kind
  const meta = Kind.meta[kind]
  const baseURL = baseURLOf(kind, input.slot, input.endpoints)
  // `transport` is written for codex only; `"http"` means the key is left out (HTTP SSE, AC-P15 fallback). Token
  // sharing (siwc) is HTTP only and, like every kind but codex, gets no static ChatGPT headers.
  const transport = kind === "codex" && (input.slot.transport ?? "websocket") === "websocket" ? "websocket" : undefined
  return {
    id: input.providerID,
    name: `${KIND_NAMES[kind]} · ${input.account.label}`,
    ...(meta.writesCanonical ? { canonical: Provider.ID.make(meta.canonical) } : {}),
    activation: "enabled",
    // 02 §3.3a: a local model registers with its format's package (Responses, Anthropic Messages).
    package: kind === "compat" ? LocalModel.packageOf(input.account.compat) : meta.package,
    settings: {
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(transport === undefined ? {} : { transport }),
      ...(kind === "compat" ? COMPAT_TIMEOUTS : {}),
      // The ChatGPT backend rejects uncompressed bodies over ~1 MiB and decodes zstd (upstream openai.ts, v2.0.28).
      // A test fake behind an endpoint override need not decode it.
      ...(kind === "codex" && input.endpoints.overrides.codex === undefined ? { encoding: "zstd" } : {}),
      // Token sharing too (upstream chatgpt.ts, 5673bfa4a8), unless the slot has a base URL of its own: upstream sends
      // plain JSON to a configured one. The test fakes decode zstd like the route, so an endpoint override keeps it.
      ...(kind === "siwc" && input.slot.baseURL === undefined ? { encoding: "zstd" } : {}),
      compaction: { type: "summary" },
    },
    ...(kind === "codex" ? { headers: { ...CODEX_HEADERS } } : {}),
  }
}

/**
 * A pinned model as it registers now: {@link Templates.live}, and a model the live catalog dropped (`upstream:
 * "missing"`, 07 §4.4) stays registered and enabled with the status `deprecated`. models.dev drops a model it
 * deprecates while the provider may still serve it, so a session on it keeps running (U3: repair notices only, never a
 * forced stop), while nothing picks it anew: new-session defaults and lighter pairs take `active` models only, preset
 * targets skip `deprecated` ones (`Preset.candidates`, `Preset.callable`, which also raise the repair notices of 07
 * §4.3), and own-web's pickers leave it out. The template's own marks stay on the result; {@link models} strips them
 * before core sees the model.
 */
export function current(kind: Kind.Own, pinned: Registry.TemplateModel, live: Templates.Live): Registry.TemplateModel {
  const model = Templates.live(kind, pinned, live)
  return pinned.upstream === "missing" ? { ...model, status: "deprecated" } : model
}

/**
 * The slot's models: each pinned template model as it registers now ({@link current}: the live catalog's limit, cost,
 * status and release date; a model gone upstream `deprecated`) without own's template marks (`addedAt`, `upstream`), the
 * slot's provider id, the kind's native package on every model, and `limit.input` set to the compaction window
 * `ctx_eff` of the resolved threshold (02 §4.7.3–4.7.4; a threshold equal to core's ceiling keeps the model limit). A
 * `compat` model below a 160k window registers a `limit.input` above its window to compact at 90% of it
 * (`Compaction.ceilingOf`); `limit.context` and `limit.output` stay the model's, so core's output limit still fits
 * the real window.
 * Retired slots and disabled accounts keep every model registered but disabled, so past turns stay attributed (R-ID-3,
 * 9.2 `accounts.remove.*`).
 */
export function models(input: {
  readonly providerID: Kind.ProviderID
  readonly slot: Registry.Slot
  readonly account: Account.Info
  readonly template: Registry.ModelTemplate
  readonly compaction?: CompactionInput
  readonly live?: Templates.Live
  readonly rows?: ReadonlyArray<CodexModels.HarnessRow>
}): Model.Info[] {
  const kind = input.slot.kind
  const usable = !input.slot.retired && input.account.status !== "disabled" && input.account.status !== "retired"
  const pinnedAndServed = [...input.template.models, ...served(kind, input.template, input.live ?? new Map(), input.rows ?? [])]
  return pinnedAndServed.map((pinned) => {
    const model = current(kind, pinned, input.live ?? new Map())
    const window = threshold(kind, input.account, model, input.compaction ?? {})?.effectiveInput ?? null
    return {
      ...Struct.omit(model, ["addedAt", "upstream"]),
      providerID: input.providerID,
      package: kind === "compat" ? LocalModel.packageOf(input.account.compat) : Kind.meta[kind].package,
      enabled: model.enabled && usable,
      limit: window === null ? model.limit : { ...model.limit, input: window },
    }
  })
}

/**
 * Codex models a ChatGPT account's served list names that neither the kind's pinned template nor the live catalog has
 * (10 §6.14, 07 §4.4 "서버 행"): models.dev lists a new model later than Codex serves it, so own registers it from the
 * row at once, as a template entry built like the nearest pinned model (`CodexModels.nearest`, else the first): its
 * package, capabilities, family and variant settings, with the row's slug, display name, largest input (the output
 * room of the lender on top) and reasoning levels (`ultra` is no variant). Only rows Codex lists in its picker; never
 * persisted, so the model gives way to the catalog's entry once models.dev lists it (the template diff adds that) and
 * goes when the row goes. `codex` only: other kinds read no Codex list.
 */
export function served(
  kind: Kind.Own,
  template: Registry.ModelTemplate,
  live: Templates.Live,
  rows: ReadonlyArray<CodexModels.HarnessRow>,
): Registry.TemplateModel[] {
  if (kind !== "codex" || rows.length === 0 || template.models.length === 0) return []
  const catalog = live.get(Templates.SOURCE.codex)?.models
  const pinned = new Set(template.models.flatMap((model) => [String(model.id), String(model.modelID)]))
  return rows
    .filter((row) => row.visibility === "list" && !pinned.has(row.slug) && catalog?.has(Model.ID.make(row.slug)) !== true)
    .map((row) => {
      const lender =
        template.models.find((model) => model.id === CodexModels.nearest(row.slug)) ?? template.models[0]!
      const base = Struct.omit(lender, ["addedAt", "upstream"])
      const efforts = (row.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter((effort) => effort !== "ultra")
      const shape = lender.variants[0]
      const variants =
        efforts.length === 0 || shape === undefined
          ? lender.variants
          : efforts.map(
              (effort) =>
                lender.variants.find((variant) => variant.id === effort) ?? {
                  ...shape,
                  id: Model.VariantID.make(effort),
                  settings: { ...shape.settings, reasoningEffort: effort },
                },
            )
      const max = row.max_context_window ?? undefined
      return {
        ...base,
        id: Model.ID.make(row.slug),
        modelID: Model.ID.make(row.slug),
        name: row.display_name ?? row.slug,
        variants,
        limit:
          max === undefined ? lender.limit : { context: max + lender.limit.output, input: max, output: lender.limit.output },
      }
    })
}

/**
 * `T_slot` of one template model of an account (02 §4.7.4 steps 1–5), up to the kind's ceiling (`compat`: 90% of the
 * window); `undefined` for an unknown window.
 */
export function threshold(
  kind: Kind.Own,
  account: Pick<Account.Info, "compaction">,
  model: Pick<Registry.TemplateModel, "id" | "modelID" | "limit">,
  compaction: CompactionInput,
) {
  return Compaction.resolve(
    Compaction.chain({ kind, modelID: model.id, policy: compaction.policy, account: account.compaction }),
    Templates.limit(kind, model),
    compaction.keep,
    kind,
  )
}

/**
 * Built-in providers to hide (02 §2.4.3, 01 §8.2): `"auto"` hides the catalog provider of every kind the user has a
 * live own account of, a list hides exactly those ids, `false` hides nothing. `anthropic` is never hidden here; it
 * follows the Claude slot rule ({@link apply}).
 */
export function hiddenBuiltins(registry: Registry.File, setting: Policy.File["hideBuiltinProviders"]) {
  if (setting === false) return []
  const ids =
    setting === "auto"
      ? registry.accounts
          .filter((account) => account.status !== "retired")
          .flatMap((account) => Kind.meta[account.kind].builtin ?? [])
      : setting
  return [...new Set(ids)].filter((id) => id !== ANTHROPIC && Kind.ProviderID.parse(id) === undefined).sort()
}

export interface FoldInput {
  readonly definitions: ReadonlyArray<Definition>
  readonly hidden: ReadonlyArray<string>
  /**
   * The Claude slot (02 §8.4, 04 §8.11.4.3): `plugin` = claude-auth is detected and acknowledged on this PC (it folds
   * `anthropic` itself); `remote` = a remote service whose PC relays the slot; `off` = `anthropic` disabled.
   */
  readonly claudeSlot: "plugin" | "remote" | "off"
}

/**
 * The provider fold body. Order: own slots, hidden built-ins, `anthropic` activation. `anthropic` stays untouched
 * when claude-auth serves the slot (its built-in activation is kept, 02 §8.4) and is disabled when the slot is off,
 * which also closes the `ANTHROPIC_API_KEY`/global credential billing path. On a remote service whose PC relays the
 * slot, `anthropic` is enabled with every model's cost cleared, as the claude-auth fold does for a subscription; with
 * no connection on the host core resolves it to `Auth.none`, so no credential header is ever added there.
 */
export function apply(editor: ProviderEditor, input: FoldInput) {
  for (const definition of input.definitions) editor.add({ info: definition.info, models: definition.models })
  for (const id of input.hidden) disable(editor, id)
  if (input.claudeSlot === "off") disable(editor, ANTHROPIC)
  if (input.claudeSlot === "remote") relayed(editor)
}

/** `anthropic` as the PC's egress relay serves it (04 §8.11.4.3): enabled, subscription models without a price. */
function relayed(editor: ProviderEditor) {
  const anthropic = editor.get(ANTHROPIC)
  if (!anthropic) return
  editor.update(ANTHROPIC, (provider) => {
    provider.activation = "enabled"
  })
  for (const [modelID] of anthropic.models)
    editor.models.update(ANTHROPIC, modelID, (model) => {
      model.cost = []
    })
}

function disable(editor: ProviderEditor, id: string) {
  if (!editor.get(id)) return
  editor.update(id, (provider) => {
    provider.activation = "disabled"
  })
}

function baseURLOf(kind: Kind.Own, slot: Registry.Slot, endpoints: Endpoints.Endpoints) {
  if (kind === "codex") return endpoints.url.codex
  if (slot.baseURL !== undefined) return slot.baseURL
  const name = ENDPOINT[kind]
  return name === undefined ? undefined : endpoints.overrides[name]
}

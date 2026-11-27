export * as ClaudeProvider from "./provider.js"

import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect"
import { Model } from "../../../model.js"
import { Provider } from "../../../provider.js"
import type { ClaudeIO } from "./claude/io.js"
// OWN-PATCH(P-053) begin
import { ClaudeObserver } from "./claude/observer.js"
// OWN-PATCH(P-053) end
import type { ClaudeProbe } from "./claude/probe.js"
import { ClaudeQueryOptions } from "./claude/query-options.js"
import type { ClaudeStatus } from "./claude/status.js"

export const ID = Provider.ID.claudeAgent
export const PACKAGE = "@opencode/claude-agent"

// The model list we keep between starts, so opencode can list models without running `claude`
const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Number),
  resolvedModel: Schema.optionalKey(Schema.String),
  hidden: Schema.optionalKey(Schema.Boolean),
  // OWN-PATCH(P-060) begin
  supportsFastMode: Schema.optionalKey(Schema.Boolean),
  // OWN-PATCH(P-060) end
})
type CatalogModel = typeof CatalogModel.Type
const Catalog = Schema.Struct({
  priceSource: Schema.optionalKey(Provider.ID),
  models: Schema.Array(CatalogModel),
  // OWN-PATCH(P-060) begin
  // The models a full login check asked for their window (answered or not); a model outside it is checked once.
  checked: Schema.optionalKey(Schema.Array(Schema.String)),
  // OWN-PATCH(P-060) end
})
type Catalog = typeof Catalog.Type
const CATALOG_KEY = "models"

// OWN-PATCH(P-052) begin
// own: every Location's provider instance of this process hears a list one of them read (the login check runs where
// the connection was made, the control Location's on an SSH host), so a Location that opened before it does not stay
// without models (a host's first conversation, 02 §8.10.13).
const catalogs = new Set<(catalog: Catalog) => void>()
// OWN-PATCH(P-052) end

// Mantle is Bedrock serving Anthropic's API, and opencode drops most of its `anthropic.…` IDs from Bedrock's list,
// so it uses Anthropic's prices.
const PRICE_SOURCES: Partial<Record<NonNullable<AccountInfo["apiProvider"]>, Provider.ID>> = {
  firstParty: Provider.ID.anthropic,
  anthropicAws: Provider.ID.anthropic,
  anthropicGoogleCloud: Provider.ID.anthropic,
  mantle: Provider.ID.anthropic,
  bedrock: Provider.ID.amazonBedrock,
  vertex: Provider.ID.googleVertex,
  foundry: Provider.ID.azure,
}

export const register = Effect.fn("ClaudeProvider.register")(function* (
  ctx: Context,
  status: ClaudeStatus.Interface,
  io: ClaudeIO.Interface,
) {
  const saved = Schema.decodeUnknownOption(Catalog)(yield* ctx.storage.get(CATALOG_KEY))
  const current = { catalog: Option.getOrElse(saved, (): Catalog => ({ models: [] })) }

  yield* ctx.provider.transform((editor) => {
    const source = current.catalog.priceSource
    const prices = source ? editor.get(source)?.models : undefined
    editor.add({
      info: {
        id: ID,
        name: "Claude Agent",
        activation: "auto",
        package: Provider.aisdk(PACKAGE),
      },
      models: current.catalog.models.map((model) => toModel(model, prices)),
    })
  })

  const checked = new Set<string>()
  yield* SubscriptionRef.changes(status.state).pipe(
    Stream.runForEach((state) =>
      Effect.gen(function* () {
        if (state.type !== "ready") return
        const baseURL = (yield* connection(ctx)).ANTHROPIC_BASE_URL ?? io.env().ANTHROPIC_BASE_URL
        // Another project folder may have saved IDs since this one loaded
        const stored = Schema.decodeUnknownOption(Catalog)(yield* ctx.storage.get(CATALOG_KEY))
        // OWN-PATCH(P-060) begin
        const discovered = state.probe.discovered ?? current.catalog.checked
        const next = {
          priceSource: priceSource(state.probe.account, baseURL),
          models: fromClaude(state.probe.models, Option.getOrElse(stored, () => current.catalog).models),
          ...(discovered === undefined ? {} : { checked: discovered }),
        }
        const unknown = next.models.filter(
          (model) => !model.hidden && model.contextWindow === undefined && !checked.has(model.id),
        )
        if (state.fromChat && unknown.length > 0) {
          for (const model of unknown) checked.add(model.id)
          yield* status.refresh().pipe(Effect.forkScoped)
        }
        // OWN-PATCH(P-060) end
        if (JSON.stringify(next) === JSON.stringify(current.catalog)) return
        current.catalog = next
        yield* ctx.storage.set(CATALOG_KEY, current.catalog)
        yield* ctx.provider.reload()
        // OWN-PATCH(P-052) begin
        for (const listener of catalogs) listener(next)
        // OWN-PATCH(P-052) end
        // OWN-PATCH(P-060) begin
        publish(current.catalog)
        // OWN-PATCH(P-060) end
      }),
    ),
    Effect.forkScoped,
  )

  // OWN-PATCH(P-052) begin
  const context = yield* Effect.context<never>()
  const heard = (catalog: Catalog) => {
    if (JSON.stringify(catalog) === JSON.stringify(current.catalog)) return
    current.catalog = catalog
    Effect.runFork(ctx.provider.reload().pipe(Effect.provide(context), Effect.ignore))
  }
  catalogs.add(heard)
  yield* Effect.addFinalizer(() => Effect.sync(() => catalogs.delete(heard)))
  // OWN-PATCH(P-052) end

  // OWN-PATCH(P-053) begin
  // own: Claude Code reports each model's context window in every turn's result. A model the login check left
  // without one (a discovery that timed out or failed for it) keeps core's 200k fallback until the next check; the
  // first turn on it now fills the window from Claude Code's own report. A window the check did read stays. Every
  // Location's instance hears the same observation, so each updates its own list.
  const learn = (observation: ClaudeObserver.Observation) => {
    const window = observation.windows && turnWindow(observation.windows, current.catalog.models)
    // OWN-PATCH(P-060) begin
    // A Claude Code that lists no resolved model names it in the turn: the only model the turn ran.
    const resolved = observation.windows && turnModel(observation.windows, current.catalog.models)
    if (!window && !resolved) return
    current.catalog = {
      ...current.catalog,
      models: current.catalog.models.map((model) => ({
        ...model,
        ...(model.id === window?.model ? { contextWindow: window.contextWindow } : {}),
        ...(model.id === resolved?.model ? { resolvedModel: resolved.resolvedModel } : {}),
      })),
    }
    publish(current.catalog)
    // OWN-PATCH(P-060) end
    Effect.runFork(
      ctx.storage
        .set(CATALOG_KEY, current.catalog)
        .pipe(Effect.andThen(ctx.provider.reload()), Effect.provide(context), Effect.ignore),
    )
  }
  ClaudeObserver.channel().listeners.add(learn)
  yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.channel().listeners.delete(learn)))
  // OWN-PATCH(P-053) end

  // Without a saved list there is no model to pick, so the first message that would fill it can never be sent.
  // OWN-PATCH(P-051) begin
  // own: a list saved with no context window at all (a check that skipped discovery, CAG-52) is checked again, else
  // its models keep the 200k fallback for good: a chat's own startup report never carries windows. One model whose
  // discovery fails (one the login cannot use) does not start a check every time.
  const unwindowed = current.catalog.models.every((model) => model.contextWindow === undefined)
  // OWN-PATCH(P-060) begin
  // own: also a list with a model no full check has asked yet (Claude Code listed it in a chat's startup report, e.g.
  // after an update), once per process for that list: it would keep the 200k fallback until its first turn. A model a
  // check asked and could not read (one the login cannot use) is not asked again. A list saved before `checked` counts
  // its models without a window as unchecked.
  publish(current.catalog)
  const asked = current.catalog.checked
  const unchecked = current.catalog.models
    .filter((model) => (asked ? !asked.includes(model.id) : model.contextWindow === undefined))
    .map((model) => model.id)
  const recheck = unchecked.length > 0 && claimRecheck(unchecked)
  // An empty list counts too (`every` of none).
  if ((unwindowed || recheck) && (yield* ctx.integration.connection.active(ID))) {
    // OWN-PATCH(P-060) end
    // OWN-PATCH(P-051) end
    yield* status.refresh().pipe(Effect.forkScoped)
  }
})

export const connection = Effect.fn("ClaudeProvider.connection")(function* (ctx: Context) {
  const provider = yield* ctx.provider.get({ providerID: ID }).pipe(Effect.option)
  if (Option.isNone(provider)) return {}
  const info = provider.value.data
  return ClaudeQueryOptions.connectionEnv({ settings: info.settings, headers: info.headers, body: info.body })
})

// OWN-PATCH(P-053) begin
// The window a turn reported for the catalog model it ran, when the saved list has none for it: the usage entry keyed
// (or canonically named) as the model's resolved id, with or without the `[1m]` suffix, else the only entry. Another
// model's entry (a helper call on Haiku) never fills it.
export function turnWindow(windows: ClaudeObserver.TurnWindows, models: readonly CatalogModel[]) {
  const model = models.find((item) => item.id === windows.model)
  if (!model) return
  const plain = (id: string) => id.replace(/\[1m\]$/, "")
  const resolved = plain(model.resolvedModel ?? model.id)
  const matching = windows.usage.filter(
    (entry) => plain(entry.key) === resolved || (entry.canonical !== undefined && plain(entry.canonical) === resolved),
  )
  const entry = matching.length === 1 ? matching[0] : windows.usage.length === 1 ? windows.usage[0] : undefined
  if (!entry || model.contextWindow !== undefined) return
  return { model: model.id, contextWindow: entry.contextWindow }
}
// OWN-PATCH(P-053) end

// OWN-PATCH(P-060) begin
// The model a turn ran, for a catalog model without a resolved id: the only `modelUsage` entry of that turn.
export function turnModel(windows: ClaudeObserver.TurnWindows, models: readonly CatalogModel[]) {
  const model = models.find((item) => item.id === windows.model)
  if (!model || model.resolvedModel !== undefined || windows.usage.length !== 1) return
  const entry = windows.usage[0]
  return { model: model.id, resolvedModel: entry.canonical ?? entry.key }
}

// "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5", "anthropic.claude-fable-5-2[1m]" → "Fable 5.2".
export function versionName(resolved: string) {
  const words = resolved
    .replace(/\[1m\]$/i, "")
    .replace(/@.*$/, "")
    .replace(/^.*?claude-/, "")
    .split("-")
    .filter((word) => word !== "" && !/^\d{6,}$/.test(word))
  const family = words.filter((word) => !/^\d+$/.test(word)).map((word) => word[0].toUpperCase() + word.slice(1))
  const numbers = words.filter((word) => /^\d+$/.test(word))
  return [...family, ...(numbers.length > 0 ? [numbers.join(".")] : [])].join(" ")
}

// The name a client shows: Claude Code's label with the model the alias runs now ("Opus · Opus 5.5"); the label alone
// when Claude Code did not say, or when the label already names it.
export function displayName(model: Pick<CatalogModel, "name" | "resolvedModel">) {
  if (model.resolvedModel === undefined) return model.name
  const version = versionName(model.resolvedModel)
  if (version === "" || model.name.toLowerCase().includes(version.toLowerCase())) return model.name
  return `${model.name} · ${version}`
}

// Hands the list to own-accounts (the observer channel): what each alias runs, its window and Fast.
function publish(catalog: Catalog) {
  ClaudeObserver.emit({
    models: catalog.models.map((model) => ({
      id: model.id,
      name: displayName(model),
      ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.supportsFastMode === undefined ? {} : { supportsFastMode: model.supportsFastMode }),
    })),
  })
}

// One re-check per process for a list of unchecked models: every Location's instance registers, and one claude is
// enough (the others hear its list, P-052).
const RECHECKED = Symbol.for("opencode.claude-agent.rechecked")
function claimRecheck(unchecked: readonly string[]) {
  const scope = globalThis as { [RECHECKED]?: Set<string> }
  const claimed = (scope[RECHECKED] ??= new Set())
  const key = [...unchecked].sort().join(",")
  if (claimed.has(key)) return false
  claimed.add(key)
  return true
}
// OWN-PATCH(P-060) end

export const configDirs = Effect.fn("ClaudeProvider.configDirs")(function* (ctx: Context) {
  const provider = yield* ctx.provider.get({ providerID: ID }).pipe(Effect.option)
  if (Option.isNone(provider)) return []
  return ClaudeQueryOptions.configDirs(provider.value.data.settings?.configDir)
})

// Claude Code lists Fable under whatever name the chat was started with, and each account caches its own list, while a
// chat or the config may hold any ID that was ever listed. So no ID is dropped, and a model already offered under one
// ID keeps it when Claude Code lists it under another.
// Context windows only come from the full check, so a chat's startup report keeps the saved ones.
function fromClaude(models: readonly ClaudeProbe.Model[], saved: readonly CatalogModel[]): CatalogModel[] {
  // "default" follows Claude Code's own default, which can change under a running opencode session
  const listed = models.filter((model) => model.value !== "default")
  const result = new Map<string, CatalogModel>()
  for (const model of listed) {
    const own = saved.find((item) => item.id === model.value)
    const offered =
      own && !own.hidden
        ? undefined
        : saved.find(
            (item) =>
              !item.hidden &&
              item.resolvedModel !== undefined &&
              item.resolvedModel === model.resolvedModel &&
              // An alias that is still listed has moved to another version, and this row is the old one
              !listed.some((other) => other.value === item.id),
          )
    // OWN-PATCH(P-060) begin
    const fast = model.supportsFastMode ?? (offered ?? own)?.supportsFastMode
    // OWN-PATCH(P-060) end
    const entry = {
      id: model.value,
      name: model.displayName,
      efforts: model.supportedEffortLevels ?? [],
      contextWindow: model.contextWindow ?? (offered ?? own)?.contextWindow,
      // OWN-PATCH(P-060) begin
      // What a turn taught (`turnModel`) stays until Claude Code names the model itself.
      resolvedModel: model.resolvedModel ?? own?.resolvedModel,
      ...(fast === undefined ? {} : { supportsFastMode: fast }),
      // OWN-PATCH(P-060) end
    }
    if (offered) result.set(offered.id, { ...entry, id: offered.id })
    result.set(entry.id, offered ? { ...entry, hidden: true } : entry)
  }
  for (const model of saved) {
    if (!result.has(model.id)) result.set(model.id, { ...model, hidden: true })
  }
  return [...result.values()]
}

// A subscription covers usage, and a custom base URL or an enterprise gateway can bill anything, so they show no cost.
function priceSource(account: AccountInfo, baseURL: string | undefined) {
  if (baseURL) return
  if (account.apiProvider === undefined) return
  if (account.apiProvider === "firstParty" && account.apiKeySource === undefined) return
  return PRICE_SOURCES[account.apiProvider]
}

function toModel(model: CatalogModel, prices: ReadonlyMap<string, Model.Info> | undefined): Model.Info {
  const defaults = Model.Info.default(ID, Model.ID.make(model.id))
  // The 1M context version's price tiers are on the base model
  const id = (model.resolvedModel ?? model.id).replace(/\[1m\]$/, "")
  // Mantle names models `anthropic.claude-…`, and Vertex lists current models as `claude-…@default`
  const priced = prices?.get(id) ?? prices?.get(id.replace(/^anthropic\./, "")) ?? prices?.get(`${id}@default`)
  return {
    ...defaults,
    // OWN-PATCH(P-060) begin
    name: displayName(model),
    // OWN-PATCH(P-060) end
    // The SDK reports context windows before a prompt, but not output limits. 0 means unknown in OpenCode.
    limit: { context: model.contextWindow ?? defaults.limit.context, output: 0 },
    // OpenCode picks the title model by family (Model.small).
    family: model.id.includes("haiku") ? Model.Family.make("claude-haiku") : undefined,
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
    cost: priced?.cost ?? [],
    // opencode keeps a deprecated model out of its pickers and still runs chats on it
    status: model.hidden ? "deprecated" : defaults.status,
  }
}

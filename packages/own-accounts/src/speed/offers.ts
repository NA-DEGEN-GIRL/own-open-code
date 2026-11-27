export * as SpeedOffers from "./offers.js"

import { Option, Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { Account, ClaudeAgent, CodexModels, Ratecard, Speed, type Kind } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { CodexMeta } from "../slots/codex-meta.js"
import { Rates } from "../telemetry/rates.js"

/**
 * Owner: SPEED (02 §4.8, decision 2). Which speeds a session's main may use, discovered rather than hard-coded:
 * - `codex`: the account's own Codex model list (`codex-meta.json` `accounts`, fetched per account with its etag).
 *   Until that list is read, the shared list (the first account's) and then the pinned template's `-fast` modes, both
 *   unverified.
 * - `siwc`: the account's own catalog when it names tiers (`runtime.speed` lists, read at `accounts.test` and once per
 *   process here); else the catalog's modes, unverified, and the provider's answer decides.
 * - `oai`, `anth`: the catalog's modes (the fold's live snapshot, then the pinned template), priced at the mode price.
 * - Claude subscription slot (`anthropic`): the catalog's modes of the fold's snapshot, taken before claude-auth sets
 *   every cost to 0 (02 §8.3 I6), so Fast shows (and the ledger prices it at) its usage-credit price.
 * Plan multiples (`codex`, `siwc`) come from `ratecards.json` `speed`, else the seed's (a file written before the
 * field). Other kinds offer nothing.
 */

/** A main's speed facts before the account's marks: where it runs and the candidate tiers. */
export interface Target {
  readonly kind: Kind.Any
  readonly providerID: string
  readonly accountID: string
  readonly modelID: string
  readonly wire: Speed.Wire
  /** The main is a catalog mode entry: its speed is the model's own and nothing is added. */
  readonly fixed?: Speed.Faster
  readonly candidates: ReadonlyArray<Speed.Candidate>
}

export interface Api {
  /** The target of a main; `undefined` for a provider own does not run (a built-in, a local server, no Claude slot). */
  target(providerID: string, modelID: string): Promise<Target | undefined>
  /** The target's offers now, with the account's marks (refusals until a list refresh, cooldowns). */
  offers(target: Target): Speed.Offer[]
  /** The speed cards (`ratecards.json` `speed`, else the seed's). */
  cards(): Promise<ReadonlyArray<Ratecard.SpeedCard>>
  /**
   * The catalog price of a tier on an API kind or the Claude slot (USD per 1M tokens, the mode entry's cost), for the
   * ledger and the estimate; `undefined` for plan kinds and unknown entries.
   */
  price(target: Target, tier: string): Promise<Rates.CatalogCost | undefined>
  /** Fetches a Sign in with ChatGPT account's catalog once in this process, for its tiers (no billing). */
  sharing(accountID: string): void
}

/**
 * The key the Claude Agent route's speed marks live under (its provider id): one Claude Code serves every account
 * folder (CAM-6); Claude Code's model list read again clears them (agent.ts).
 */
export const AGENT_MARKS: string = ClaudeAgent.PROVIDER_ID

/** The kinds whose speed is the OpenAI `service_tier`; `anth` and the Claude slot use Anthropic's `speed`. */
const OPENAI: ReadonlySet<string> = new Set(["codex", "siwc", "oai"])

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(Ratecard.File))

export function create(deps: Deps, peers: Module.Peers, fetchSharing: (accountID: string) => Promise<void>): Api {
  const log = deps.log.child("speed.offers")
  const state = { seed: undefined as Promise<ReadonlyArray<Ratecard.SpeedCard>> | undefined }
  const asked = new Set<string>()

  const seed = () =>
    (state.seed ??= Bun.file(deps.options.ratecardsSeed ?? deps.runtime.layout.ratecardsSeed)
      .text()
      .then(
        (text) => Option.getOrUndefined(decodeFile(text))?.speed ?? [],
        () => [],
      ))

  const cards: Api["cards"] = async () => {
    const file =
      deps.runtime.ratecards.cached() ??
      (await deps.runtime.ratecards.read().catch((error: unknown) => {
        log.warn("ratecards_unreadable", { error })
        return undefined
      }))
    return file?.speed ?? (await seed())
  }

  /** The plan multiple of a tier (`included`, `credits`); both `null` without a card. */
  const plan = (list: ReadonlyArray<Ratecard.SpeedCard>, kind: Kind.Any, modelID: string) => (tier: string) => {
    const card = Rates.match(
      list.filter((item) => item.tier === tier),
      kind,
      modelID,
    )
    return { type: "plan" as const, included: card?.included ?? null, credits: card?.credits ?? null }
  }

  /** A mode entry's untiered price as `api` (or `extra` for the Claude slot). */
  const priced =
    (type: "api" | "extra") =>
    (entry: {
      readonly cost?: ReadonlyArray<{ readonly input: number; readonly output: number; readonly tier?: unknown }>
    }) => {
      const cost = entry.cost?.find((item) => item.tier === undefined) ?? entry.cost?.[0]
      return cost && cost.input > 0 ? { type, input: cost.input, output: cost.output } : undefined
    }

  const target: Api["target"] = async (providerID, modelID) => {
    const slots = peers().slots
    if (providerID === Provider.ID.claudeAgent) return agentTarget(modelID)
    if (providerID === Provider.ID.anthropic) {
      if (!peers().plugins.claudeSlot().detected) return undefined
      const catalog = await slots.catalog(Provider.ID.anthropic)
      const fixed = Speed.modeOf(catalog.find((model) => model.id === modelID) ?? { id: modelID })
      return {
        kind: "claude-sub",
        providerID,
        accountID: Account.ID.claudeSlot,
        modelID,
        wire: "speed",
        ...(fixed ? { fixed } : {}),
        candidates: fixed ? [] : Speed.modes(catalog, modelID, { billing: priced("extra") }),
      }
    }
    const slot = slots.slot(providerID)
    if (!slot) return undefined
    const kind = slot.kind
    const own = slots.models(providerID)
    const fixed = Speed.modeOf(own.find((model) => model.id === modelID) ?? { id: modelID })
    const base = {
      kind,
      providerID,
      accountID: slot.account.id,
      modelID,
      wire: OPENAI.has(kind) ? ("service_tier" as const) : ("speed" as const),
      ...(fixed ? { fixed } : {}),
    }
    if (fixed) return { ...base, candidates: [] }
    if (kind === "codex") {
      const billing = plan(await cards(), kind, modelID)
      const row = await CodexMeta.accountModel(deps, slot.account.id, modelID)
      const tiers = row && CodexModels.tiers(row)
      if (tiers) return { ...base, candidates: Speed.listed(tiers, { billing }) }
      const shared = await CodexMeta.model(deps, modelID)
      const guessed = shared && CodexModels.tiers(shared)
      if (guessed) return { ...base, candidates: Speed.listed(guessed, { verified: false, billing }) }
      return {
        ...base,
        candidates: Speed.modes(own, modelID, { verified: false, billing: (entry) => billing(tierOf(entry)) }),
      }
    }
    if (kind === "siwc") {
      const billing = plan(await cards(), kind, modelID)
      const list = deps.runtime.speed.list(slot.account.id)
      if (!list) sharing(slot.account.id)
      const tiers = list?.models.get(modelID)
      if (tiers) return { ...base, candidates: Speed.listed(tiers, { billing }) }
      const guess = { verified: false, billing: (entry: Speed.ModeEntry) => billing(tierOf(entry)) }
      const live = await slots.catalog(Provider.ID.openai)
      return { ...base, candidates: [...Speed.modes(live, modelID, guess), ...Speed.modes(own, modelID, guess)] }
    }
    if (kind === "oai" || kind === "anth") {
      const live = await slots.catalog(kind === "oai" ? Provider.ID.openai : Provider.ID.anthropic)
      const billing = { billing: priced("api") }
      return { ...base, candidates: [...Speed.modes(live, modelID, billing), ...Speed.modes(own, modelID, billing)] }
    }
    return { ...base, candidates: [] }
  }

  /**
   * The Claude Agent route (CAM-6): Claude Code itself says which model takes its Fast mode (`supportsFastMode` of its
   * model list, core P-060), and Fast there is billed to the plan's usage credits like the Claude slot's; the price is
   * the anthropic catalog's Fast entry of the model the alias runs, when the catalog has one. Marks are the route's
   * (one Claude Code, every account folder: an account whose usage credits are off answers Standard and is marked).
   */
  const agentTarget = async (modelID: string): Promise<Target | undefined> => {
    const agent = peers().claudeAgent
    if (!agent.account()) return undefined
    const fact = agent.models().find((model) => model.id === modelID)
    const base = { kind: "claude-agent" as const, providerID: Provider.ID.claudeAgent, accountID: AGENT_MARKS, modelID }
    if (!fact?.supportsFastMode) return { ...base, wire: "speed", candidates: [] }
    const resolved = fact.resolvedModel?.replace(/\[1m\]$/i, "")
    const catalog = resolved ? await peers().slots.catalog(Provider.ID.anthropic) : []
    const billing = resolved
      ? Speed.modes(catalog, resolved, { billing: priced("extra") }).find((item) => item.choice === "fast")?.billing
      : undefined
    const fast: Speed.Candidate = {
      choice: "fast",
      tier: "fast",
      wire: "speed",
      basis: "account",
      verified: true,
      ...(billing ? { billing } : {}),
    }
    return { ...base, wire: "speed", candidates: [fast] }
  }

  const sharing: Api["sharing"] = (accountID) => {
    if (asked.has(accountID) || deps.remote) return
    asked.add(accountID)
    void fetchSharing(accountID).catch((error: unknown) => log.warn("speed_sharing_list_failed", { accountID, error }))
  }

  return {
    target,
    offers: (item) =>
      Speed.offers(item.candidates, deps.runtime.speed.marks(item.accountID, item.modelID), deps.clock.now()),
    cards,
    price: async (item, tier) => {
      if (item.kind !== "oai" && item.kind !== "anth" && item.kind !== "claude-sub" && item.kind !== "claude-agent")
        return undefined
      const source = item.kind === "oai" ? Provider.ID.openai : Provider.ID.anthropic
      const live = await peers().slots.catalog(source)
      const entries =
        item.kind === "claude-sub" || item.kind === "claude-agent"
          ? live
          : [...live, ...peers().slots.models(item.providerID)]
      // A Claude Agent alias is priced as the model it runs now (CAM-6).
      const modelID =
        item.kind === "claude-agent"
          ? peers()
              .claudeAgent.models()
              .find((model) => model.id === item.modelID)
              ?.resolvedModel?.replace(/\[1m\]$/i, "")
          : item.modelID
      const entry = entries.find(
        (model) => model.modelID === modelID && Speed.modeOf(model) !== undefined && tierOf(model) === tier,
      )
      const cost = entry?.cost.find((item) => item.tier === undefined) ?? entry?.cost[0]
      return cost && cost.input > 0
        ? { input: cost.input, output: cost.output, cacheRead: cost.cache.read, cacheWrite: cost.cache.write }
        : undefined
    },
    sharing,
  }
}

/**
 * The tier a mode entry offers, as `Speed.modes` names it: an OpenAI `body.service_tier` as its request value (`fast`
 * → `priority`), Anthropic's `body.speed` as sent (`fast`); `""` when it names none. Mapping Anthropic's `fast` too
 * found no Fast price for the Claude slot or an `anth` key (every estimate `rate_unknown`, SL-22).
 */
function tierOf(entry: Speed.ModeEntry) {
  const tier = entry.body?.service_tier
  if (typeof tier === "string") return Speed.requestTier(tier) ?? tier
  const speed = entry.body?.speed
  return typeof speed === "string" ? speed : ""
}

export * as PresetSuggest from "./suggest.js"

import { Model } from "@opencode/schema/model"
import { CodexModels, Policy, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import { CodexMeta } from "../slots/codex-meta.js"
import { PresetCards } from "./cards.js"
import type { PresetResolve } from "./resolve.js"
import { PresetStarters } from "./starters.js"

/**
 * Owner: PRESETS (07 §3.4). `presets.suggest`: a draft for a group's editor, each role's suggestion with where it came
 * from, and the starters' state, all from what the live registry and catalog offer now (no model name in code).
 * - Candidates: the relative targets, and the models of user accounts a saved preset of the group may pin (R4 with
 *   `main: null`, so no subscription of the group's own company, the same-login sibling included), the Claude slot
 *   once installed and acknowledged, and local models whose running window is verified (`localVerified`).
 * - Accounts that cannot run at all (needs re-login, disabled) are left out; a temporary limit is not a reason.
 * - A paid target (metered or prepaid) is never suggested, nor is it in a starter: the user adds one by hand.
 * - "Strongest" ranks by input price, with Codex's priority ahead of it for a `codex` account ({@link byPriority}).
 * - `pool` (T4, 07 §3.4 모델 묶음): every model a model pool may take, with frozen cards, facts and stable keys
 *   (`Preset.poolOffer`): the group's live accounts' models (one entry per model, on the main account), each other
 *   company's subscription account (R4 with `main: null`; the roomiest first), local models (verified or not) and
 *   paid accounts; and the `추천 묶음`. Raw ranking prices only: `byPriority` plays no part in a pool.
 */
export function create(deps: Deps, peers: Module.Peers): RpcTypes.Handler<"presets.suggest"> {
  /** What the group's editor may suggest pinning now, before `Preset.suggest` applies its rules. */
  const pins = async (group: Preset.Group): Promise<ReadonlyArray<Preset.Pinnable>> => {
    const resolver = peers().presets.resolver
    const offers = await resolver.inventories()
    const codex = offers.some((offer) => offer.kind === "codex") ? await CodexMeta.snapshot(deps) : undefined
    return offers
      .filter((offer) => offer.ready)
      .flatMap((offer) => {
        const candidates = Preset.candidates(offer.models, offer.price)
        const models = offer.kind === "codex" ? byPriority(candidates, codex) : candidates
        const first = models[0]
        if (!first) return []
        const local = Preset.isLocal(offer.account)
        const single = { pin: { account: offer.account, model: Model.ID.make(first.id) } }
        if (
          !local &&
          !Preset.allowed({ group, workers: { mode: "single", single, roles: {} } }, null, resolver.lookup).ok
        )
          return []
        const headroom = local ? undefined : headroomOf(deps, offer.account)
        return models.map((model) => ({
          account: offer.account,
          model: model.id,
          billing: offer.billing,
          ...(offer.company === undefined ? {} : { company: offer.company }),
          tools: model.tools !== false,
          ...(model.price === undefined ? {} : { price: model.price }),
          ...(headroom === undefined ? {} : { headroom }),
          ...(local ? { verified: resolver.localVerified(offer.providerID, model.id) } : {}),
        }))
      })
  }

  /** The pool editor's sections for a group (07 §3.4 모델 묶음), in `Preset.poolOffer`'s order. */
  const sections = async (group: Preset.Group): Promise<ReadonlyArray<Preset.PoolSection>> => {
    const resolver = peers().presets.resolver
    const offers = (await resolver.inventories()).filter((offer) => offer.ready)
    const codex = offers.some((offer) => offer.kind === "codex") ? await CodexMeta.snapshot(deps) : undefined
    const now = deps.clock.now()
    const modelsOf = (offers: ReadonlyArray<PresetResolve.Inventory>) => {
      const seen = new Set<string>()
      return offers.flatMap((offer) =>
        Preset.candidates(offer.models, offer.price).flatMap((model): Preset.PoolModel[] => {
          const entry = offer.models.find((item) => item.id === model.id)
          if (model.tools === false || !entry || seen.has(model.id)) return []
          seen.add(model.id)
          const local = Preset.isLocal(offer.account) || offer.local === true
          const window = local ? resolver.localWindow(offer.providerID, model.id) : undefined
          const card = PresetCards.of(
            entry,
            offer.kind,
            offer.kind === "codex" ? codex : undefined,
            local
              ? {
                  verified: resolver.localVerified(offer.providerID, model.id),
                  ...(window === undefined ? {} : { runtime: window }),
                }
              : undefined,
            now,
          )
          return [
            {
              id: model.id,
              ...(model.family === undefined ? {} : { family: model.family }),
              released: model.released,
              ...(model.price === undefined ? {} : { price: model.price }),
              card,
            },
          ]
        }),
      )
    }
    const own = offers.filter((offer) => (Preset.isLocal(group) ? offer.account === group : offer.kind === group))
    // A group's own local models (an OpenAI-compatible account on a server of this PC or the LAN, PF 2026-11-03) are a
    // section of their own: still main-account entries, but free and never "only when others fail".
    const ownLocal = own.filter((offer) => offer.local === true)
    const billing = own.find((offer) => offer.local !== true)?.billing
    const home = Preset.isLocal(group) ? undefined : Preset.company({ kind: group })
    const main: Preset.PoolSection = {
      runs: billing === "local" ? "local" : billing === "subscription" ? "main" : "main-paid",
      ...(home === undefined ? {} : { company: home }),
      models: modelsOf(own.filter((offer) => offer.local !== true)),
    }
    const mainLocal: Preset.PoolSection = { runs: "local", models: modelsOf(ownLocal) }
    const others = offers.filter((offer) => !own.includes(offer))
    const allowed = (offer: PresetResolve.Inventory) => {
      const first = offer.models[0]
      const single = first && { pin: { account: offer.account, model: Model.ID.make(first.id) } }
      return (
        Preset.isLocal(offer.account) ||
        (single !== undefined &&
          Preset.allowed({ group, workers: { mode: "single", single, roles: {} } }, null, resolver.lookup).ok)
      )
    }
    const section = (offer: PresetResolve.Inventory, runs: Preset.PoolRuns): Preset.PoolSection => ({
      runs,
      account: offer.account,
      ...(offer.company === undefined ? {} : { company: offer.company }),
      models: modelsOf([offer]),
    })
    const subscriptions = others
      .filter((offer) => offer.billing === "subscription" && offer.company !== home && allowed(offer))
      .toSorted(
        (a, b) =>
          (a.company ?? "").localeCompare(b.company ?? "") ||
          (headroomOf(deps, b.account) ?? -Infinity) - (headroomOf(deps, a.account) ?? -Infinity),
      )
    return [
      ...(main.models.length ? [main] : []),
      ...(mainLocal.models.length ? [mainLocal] : []),
      ...subscriptions.map((offer) => section(offer, "subscription")),
      ...others
        .filter((offer) => offer.billing === "local" || offer.local === true)
        .map((offer) => section(offer, "local")),
      ...others
        .filter(
          (offer) =>
            (offer.billing === "metered" || offer.billing === "prepaid") && offer.local !== true && allowed(offer),
        )
        .map((offer) => section(offer, "paid")),
    ].filter((item) => item.models.length > 0)
  }

  return async (input) => {
    const suggestion = Preset.suggest(input.group, await pins(input.group), input.template)
    const named = PresetStarters.named(
      suggestion,
      peers()
        .presets.presetsOf(input.group)
        .map((preset) => preset.name),
    )
    return { ...named, pool: await withoutHidden(await sections(input.group), input.group) }
  }

  /**
   * `Preset.poolOffer` whose `추천 묶음` skips the models the user hid (07 §7.1 숨긴 모델, PF 2026-11-03); the hidden
   * ones stay candidates, so the editor can show them behind `숨긴 모델 n개` and keep a pool's checked entry.
   */
  async function withoutHidden(sections: ReadonlyArray<Preset.PoolSection>, group: Preset.Group) {
    const offer = Preset.poolOffer(sections)
    const policy = deps.runtime.policy.cached() ?? (await deps.runtime.policy.read().catch(() => undefined))
    if (!policy?.hiddenModels?.length) return offer
    const lookup = peers().presets.resolver.lookup
    const groupOf = (candidate: Preset.PoolCandidate) =>
      candidate.account === undefined
        ? group
        : Preset.isLocal(candidate.account)
          ? candidate.account
          : lookup(candidate.account)?.kind
    const hidden = new Set(
      offer.candidates
        .filter((candidate) => Policy.hidden(policy, groupOf(candidate), candidate.model))
        .map((candidate) => candidate.key),
    )
    return { ...offer, recommended: offer.recommended.filter((key) => !hidden.has(key)) }
  }
}

/**
 * Codex priority ahead of price (07 §3.4, §4.5) for `Preset.suggest`, which ranks subscription models by input price:
 * a `codex` account's prices are handed out again in Codex's priority order (1 first; models without a priority after
 * it, by their own price), so its priority-1 model ranks as the account's most expensive, while every comparison with
 * another account or company still sees the account's own price range. A model one place lower ranks a hair lower than
 * the price it takes, so equal prices keep the priority order. Without priorities the models stay as they are.
 */
export function byPriority(
  models: ReadonlyArray<Preset.Candidate>,
  snapshot: CodexModels.Snapshot | undefined,
): ReadonlyArray<Preset.Candidate> {
  const priority = (model: Preset.Candidate) => CodexModels.find(snapshot, model.id)?.priority ?? undefined
  if (!models.some((model) => priority(model) !== undefined)) return models
  const prices = models.flatMap((model) => (model.price === undefined ? [] : [model.price])).toSorted((a, b) => b - a)
  return models
    .toSorted(
      (a, b) =>
        (priority(a) ?? Infinity) - (priority(b) ?? Infinity) ||
        (b.price ?? -Infinity) - (a.price ?? -Infinity) ||
        a.id.localeCompare(b.id),
    )
    .map((model, index) => {
      const { price: _own, ...rest } = model
      const price = prices[index]
      return price === undefined ? rest : { ...rest, price: price * (1 - index * 1e-9) }
    })
}

/**
 * Room left on an account (07 §3.4 "여유가 가장 큰 계정"): the smallest `1 − used%/100` over its limit windows;
 * `undefined` while none reports a percentage.
 */
function headroomOf(deps: Deps, accountID: string) {
  const left = deps.runtime.limits
    .list({ accountID })
    .flatMap((window) => (window.usedPercent === undefined ? [] : [1 - window.usedPercent / 100]))
  return left.length ? Math.min(...left) : undefined
}

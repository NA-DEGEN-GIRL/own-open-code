export * as Planner from "./planner.js"

import { Option, Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Store, type Limits } from "@own/runtime"
import {
  Account,
  Cache,
  ClaudeAgent,
  Compaction,
  Estimate,
  Kind,
  Kv,
  LimitModel,
  LimitRank,
  OwnID,
  Switch,
  Policy,
  type Preset,
  type Registry,
} from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { CacheState } from "../telemetry/cache.js"
import { Estimator } from "./estimator.js"
import { Rates } from "./rates.js"
import { Targets } from "./targets.js"
import { Tracker } from "./tracker.js"
import { Variant } from "./variant.js"

/** A Ref resolved to what the estimator needs (02 §2.1): slot, account, rates, window, domains. */
export interface Resolved {
  readonly ref: Model.Ref
  readonly kind: Kind.Any | undefined
  readonly account: Account.Info | undefined
  readonly slot: Registry.Slot | undefined
  /** An own slot id whose account is missing from the registry (never registered or removed). */
  readonly unknownOwn: boolean
  /** Template or catalog model entry; `undefined` when neither lists it. */
  readonly model: { readonly window: number; readonly tools: boolean } | undefined
  /** Side without this session's cache state; see {@link Planner.side}. */
  readonly side: Omit<Estimator.Side, "cache">
  /**
   * Auto-compaction of this Ref (02 §4.7.4): the slot threshold and, with a session, the effective one (the session
   * value is kept from a larger slot and raised to this slot's floor). `undefined` for an unknown window.
   */
  readonly compaction:
    | { readonly slot: Compaction.Resolved; readonly effective: Compaction.SessionResolved }
    | undefined
}

/** Why a target cannot be estimated or applied (02 §9.4). */
export type Refusal =
  | { readonly type: "account_not_found"; readonly accountID: string }
  | { readonly type: "slot_misconfigured"; readonly providerID: string; readonly problems: string[] }
  | { readonly type: "no_eligible_target"; readonly reasons: string[] }

/** Account states that make a target unusable, and the "until" of exhausted ones. */
export interface Usability {
  readonly usable: boolean
  readonly reason?: string
  readonly until?: number
}

const decodeEpoch = Schema.decodeUnknownOption(Schema.Int)
const decodeTtlMode = Schema.decodeUnknownOption(Cache.TtlMode)
const decodeSessionCompaction = Schema.decodeUnknownOption(Switch.SessionCompaction)

/** Built-in providers and the kind whose ratecard describes them (02 §2.4.3 `hideBuiltinProviders`). */
const BUILTIN_KINDS: Readonly<Record<string, Kind.Any>> = {
  openai: "oai",
  deepseek: "ds",
  xai: "xai",
  openrouter: "or",
  anthropic: "claude-sub",
  // 02 §8.10: upstream's Claude Agent provider, the route's account.
  "claude-agent": "claude-agent",
}

export const ESTIMATE_TTL_MS = 5 * 60_000

export type Planner = ReturnType<typeof create>

/**
 * Glue between the pure estimator and the plugin: registry and templates (slots), ratecards and limits (runtime),
 * telemetry's KV cache state with the switching tracker as fallback, and policy thresholds.
 */
export function create(deps: Deps, peers: Module.Peers, tracker: Tracker.Store) {
  const log = deps.log.child("switching.planner")

  const cards = async () => {
    const cached = deps.runtime.ratecards.cached()
    if (cached) return cached.cards
    return (
      (
        await deps.runtime.ratecards.read().catch((error: unknown) => {
          log.warn("ratecards_unreadable", { error })
          return undefined
        })
      )?.cards ?? []
    )
  }

  const catalog = async () => {
    const listed = await deps.ctx.model.list().catch((error: unknown) => {
      log.debug("model_list_failed", { error })
      return undefined
    })
    return listed?.data ?? []
  }

  /** Resolves a Ref without session state. Registry first (own slots), then the model catalog. */
  async function resolve(input: Variant.Ref, sessionID?: string): Promise<Resolved> {
    const ref = Variant.ref(input)
    const slots = peers().slots
    const registry = slots.snapshot()
    const info = slots.slot(ref.providerID)
    // A retired account still answers for its slot, so a target on it is refused with its status.
    const account =
      info?.account ??
      Store.accountFor(registry, ref.providerID) ??
      registry.accounts.find((item) => item.providerID === ref.providerID)
    const slot = info?.slot ?? registry.slots[ref.providerID]
    const parsed = Kind.ProviderID.parse(ref.providerID)
    const kind = info?.kind ?? account?.kind ?? parsed?.kind ?? BUILTIN_KINDS[ref.providerID]
    // An own slot model as it registers now (live limit and price, 07 §4.4), else the model catalog.
    const entry =
      slots.model(ref.providerID, ref.id) ??
      (await catalog()).find((model) => model.providerID === ref.providerID && model.id === ref.id)
    const window = entry ? Compaction.windowOf(entry.limit) : 0
    const oneHour =
      sessionID !== undefined &&
      Option.getOrUndefined(
        decodeTtlMode(await deps.ctx.storage.get(Kv.ttlMode(sessionID, ref.providerID)).catch(() => undefined)),
      ) === "1h"
    const rates = Rates.resolve({
      kind,
      card: kind === undefined ? undefined : Rates.match(await cards(), kind, ref.id),
      catalog: Rates.catalogCost(entry?.cost),
      oneHour,
      at: deps.clock.now(),
    })
    const cacheDomain = account?.cacheDomain ?? ref.providerID
    const compaction = await compactionOf(ref, window, sessionID)
    return {
      ref,
      kind,
      account,
      slot,
      unknownOwn: parsed !== undefined && account === undefined && slot === undefined,
      model: entry ? { window, tools: entry.capabilities.tools } : undefined,
      side: {
        providerID: ref.providerID,
        kind,
        modelID: ref.id,
        variant: ref.variant,
        cacheDomain,
        quotaDomain: account?.quotaDomain,
        poolingVerified: account ? (registry.cacheDomains[account.cacheDomain]?.poolingVerified ?? false) : false,
        billing: account?.billing ?? (kind === "claude-sub" || kind === "claude-agent" ? "subscription" : undefined),
        rates,
        window,
        trigger: compaction?.effective.triggerTokens ?? Number.POSITIVE_INFINITY,
      },
      compaction,
    }
  }

  /** The session's "compact earlier" value (KV `sess:<sid>:compaction`, 02 §4.7.4). */
  async function sessionTrigger(sessionID: string) {
    const stored = await deps.ctx.storage.get(Kv.compaction(sessionID)).catch(() => undefined)
    return Option.getOrUndefined(decodeSessionCompaction(stored))?.triggerTokens
  }

  async function compactionOf(ref: Model.Ref, window: number, sessionID: string | undefined) {
    const slots = peers().slots
    const slot =
      slots.compaction(ref.providerID, ref.id, undefined, sessionID) ??
      (window > 0 ? slots.compaction(ref.providerID, ref.id, window, sessionID) : undefined)
    if (!slot) return undefined
    const session = sessionID === undefined ? undefined : await sessionTrigger(sessionID)
    return { slot, effective: Compaction.withSession(slot, session) }
  }

  /** Target checks of `switch.estimate`/`apply` (02 §9.4). Unknown non-own providers are allowed (external Refs). */
  function refusal(target: Resolved): Refusal | undefined {
    if (target.unknownOwn && target.model === undefined)
      return { type: "account_not_found", accountID: target.ref.providerID }
    const account = target.account
    if (account?.status === "misconfigured")
      return { type: "slot_misconfigured", providerID: target.ref.providerID, problems: ["misconfigured"] }
    if (target.slot && target.model === undefined)
      return { type: "slot_misconfigured", providerID: target.ref.providerID, problems: ["model_not_found"] }
    if (account?.status === "retired" || account?.status === "disabled")
      return { type: "no_eligible_target", reasons: [account.status] }
    return undefined
  }

  /**
   * `sessionID`: judge `anthropic` by the Claude account that session's tree runs on (02 §8.7); without one, Claude is
   * usable while any of this PC's Claude accounts is. `model`: the model that would run, so a model weekly bucket's
   * exhaustion holds back only its family (without one, account-wide exhaustions only).
   */
  const usable = (account: Account.Info | undefined, providerID: string, sessionID?: string, model?: string) =>
    usability(
      deps.runtime.limits,
      account,
      providerID,
      account === undefined ? claudeIDs(peers, providerID, sessionID) : undefined,
      model,
    )

  /** What R4 reads of an account id (07 §5.4): an own account, the Claude slot or one of its accounts (as `lookupOf`). */
  const lookup: Preset.Lookup = (accountID) =>
    accountID === Account.ID.claudeSlot || peers().claude.entry(accountID)
      ? CLAUDE_SLOT
      : (peers().claudeAgent.lookup(accountID) ?? peers().slots.account(accountID))

  /**
   * The account a provider's requests run on, as R4 reads it: its own account, the Claude slot for `anthropic` while
   * the slot is installed, else none (a built-in or local provider).
   */
  const member = (providerID: string): Preset.Member | undefined => {
    if (providerID === Provider.ID.anthropic) return peers().plugins.claudeSlot().detected ? CLAUDE_SLOT : undefined
    return peers().claudeAgent.member(providerID) ?? peers().slots.slot(providerID)?.account
  }

  /**
   * The Claude account a session's `anthropic` requests run on (its tree's, 02 §8.7), the account whose cache the
   * estimate reads (SL-8); `undefined` for every other provider (one account each, keyed by the provider). Read from
   * the tree's binding: the sync `peek` answers the default account until a request or a binding read ran after a
   * restart (SL-17).
   */
  const cacheAccount = async (sessionID: string, providerID: string) => {
    if (providerID === Provider.ID.claudeAgent) return await peers().claudeAgent.accountOf(sessionID)
    return providerID === Provider.ID.anthropic && peers().plugins.claudeSlot().detected
      ? await peers().claude.accountOf(sessionID)
      : undefined
  }

  /**
   * The session's cache view: telemetry's KV entries when telemetry keeps this session (its epoch key exists or it has
   * any entry), otherwise the tracker's. One source per session so epochs compare consistently. An `anthropic` side is
   * read for the Claude account it runs on (`accountID`, SL-8): one account's cache is no other's.
   */
  async function cacheView(
    sessionID: string,
    sides: ReadonlyArray<{ readonly providerID: string; readonly accountID?: string }>,
  ) {
    const storage = deps.ctx.storage
    const epochValue = await storage.get(Kv.epoch(sessionID)).catch(() => undefined)
    const keyOf = (side: { readonly providerID: string; readonly accountID?: string }) =>
      `${side.providerID}@${Cache.keyAccount(side.providerID, side.accountID) ?? ""}`
    const entries = new Map(
      await Promise.all(
        sides.map(
          async (side) =>
            [
              keyOf(side),
              await CacheState.read((key) => storage.get(key), sessionID, side.providerID, side.accountID),
            ] as const,
        ),
      ),
    )
    const kvEpoch = Option.getOrUndefined(decodeEpoch(epochValue))
    // Another account's entry keeps the session too: a Claude account without one is cold, not the tracker's slot.
    const kept =
      kvEpoch !== undefined ||
      [...entries.values()].some((entry) => entry !== undefined) ||
      (await storage
        .scan({ prefix: `${Kv.sessionPrefix(sessionID)}cache:`, limit: 1 })
        .then((page) => page.entries.length > 0)
        .catch(() => false))
    if (kept)
      return {
        epoch: kvEpoch ?? 0,
        entry: (providerID: string, accountID?: string): Estimator.SlotCache | undefined => {
          const found = entries.get(keyOf({ providerID, ...(accountID === undefined ? {} : { accountID }) }))
          if (!found) return undefined
          return {
            lastReqAt: found.lastReqAt,
            L: found.L,
            epoch: found.epoch,
            modelID: found.modelID,
            variant: found.variant,
            blocksSince: found.blocksSince,
            messageEndsSince: found.messageEndsSince,
            watermark: found.watermark !== null,
          }
        },
      }
    return {
      epoch: tracker.epoch(sessionID),
      entry: (providerID: string, _accountID?: string) => tracker.slot(sessionID, providerID),
    }
  }

  function context(sessionID: string, policy: Policy.File, epoch: number): Estimator.Context {
    // Unmeasured in this process (a restart): the index's last value; after a reset or an undo the tracker's estimate.
    const P = tracker.estimated(sessionID)
      ? tracker.P(sessionID)
      : (deps.runtime.sessions.get(sessionID)?.P ?? tracker.P(sessionID))
    const Z = Math.min(tracker.Z(sessionID), P || tracker.Z(sessionID))
    return {
      now: deps.clock.now(),
      epoch,
      P,
      Z,
      Zu1: Math.max(Z, tracker.Zu1(sessionID)),
      Zpre: Z,
      delta: tracker.delta(sessionID),
      summary: tracker.summary(sessionID),
      message: Tracker.DEFAULTS.message,
      seed: Tracker.DEFAULTS.seed,
      keep: peers().slots.core().keepTokens ?? Compaction.KEEP_TOKENS,
      horizon: tracker.horizon(sessionID, policy.horizonRequests),
      d9: true,
      toolsetAt: peers().auth.toolsetChangedAt(sessionID),
    }
  }

  /** Plans one target for a session; the RPC result and the stored estimate come from here. */
  async function planFor(input: {
    readonly sessionID: string
    readonly current: Variant.Ref | undefined
    readonly target: Variant.Ref
    /** SL-8: the Claude account the target runs on; default the account the session's tree runs on. */
    readonly accountID?: Account.ID
    readonly reason: "manual" | "hard" | "auth"
    readonly policy: Policy.File
  }) {
    const source = input.current ? await resolve(input.current, input.sessionID) : undefined
    const target = await resolve(input.target, input.sessionID)
    const from = input.current && {
      providerID: input.current.providerID,
      accountID: await cacheAccount(input.sessionID, input.current.providerID),
    }
    const to = {
      providerID: input.target.providerID,
      accountID:
        (input.target.providerID === Provider.ID.anthropic || input.target.providerID === Provider.ID.claudeAgent) &&
        input.accountID !== undefined
          ? input.accountID
          : await cacheAccount(input.sessionID, input.target.providerID),
    }
    const view = await cacheView(input.sessionID, [...(from ? [from] : []), to])
    const ctx = context(input.sessionID, input.policy, view.epoch)
    const sourceSide: Estimator.Side =
      source && from
        ? { ...source.side, cache: view.entry(from.providerID, from.accountID) }
        : { ...target.side, providerID: "", cacheDomain: "", quotaDomain: undefined, cache: undefined }
    const targetSide: Estimator.Side = { ...target.side, cache: view.entry(to.providerID, to.accountID) }
    const sourceAvailable =
      input.reason === "manual" && (source === undefined || usable(source.account, source.ref.providerID).usable)
    const variantOnly = Variant.only(input.current, input.target, target.kind)
    const plan = Estimator.plan({
      source: sourceSide,
      target: targetSide,
      ctx,
      sourceAvailable,
      thresholds: input.policy.thresholds,
      variantOnly,
    })
    return { source, target, ctx, plan, variantOnly, sourceSide, targetSide, targetAccount: to.accountID }
  }

  /** `switch.estimate` result (02 §9.2). */
  function result(planned: Awaited<ReturnType<typeof planFor>>, confidence: Estimate.Result["confidence"]) {
    const now = deps.clock.now()
    const plan = planned.plan
    const rates = planned.targetSide.rates
    const target = planned.target.ref
    const warnings = plan.warnings
    const compaction = planned.target.compaction
    return {
      estimateID: OwnID.EstimateID.create(),
      expiresAt: now + ESTIMATE_TTL_MS,
      context: { P: Estimator.round(planned.ctx.P), Z: Estimator.round(planned.ctx.Z), units: plan.units },
      target: {
        providerID: target.providerID,
        id: target.id,
        ...(target.variant === undefined ? {} : { variant: target.variant }),
        fits: plan.fits,
        ...(compaction === undefined
          ? {}
          : {
              compactAt: {
                windowTokens: compaction.slot.windowTokens,
                triggerTokens: compaction.effective.triggerTokens,
                source: compaction.effective.source,
              },
            }),
        ...(planned.targetAccount === undefined ? {} : { accountID: planned.targetAccount }),
      },
      options: plan.options,
      ...(warnings.length > 0 ? { warnings } : {}),
      variantOnly: planned.variantOnly,
      confidence,
      inputs: {
        W_lo: Estimator.round(plan.W.lo),
        W_hi: Estimator.round(plan.W.hi),
        rates: { in: rates.in, read: rates.read, cold: rates.cold, out: rates.out },
        ttl: { lo: rates.ttlLo, hi: rates.ttlHi },
      },
    } satisfies Estimate.Result
  }

  /**
   * Candidate targets for a session leaving `current` (02 §5.7): every live own slot but the source, the same model
   * when the target's template has it (D7), else the new-session default of the target's provider group with its
   * effort (07 §2.2), else its first enabled model. Excluded ones keep their reason; `auto` also applies the policy
   * and account `autoSwitch`. The group default is read as known now (`PresetStore.known`): planning never decides or
   * writes one. With the session tree's `team` (07 §5.5 팀 거르기) another subscription of a team account's company
   * is left out altogether, not listed as excluded: only own.team's team account operation goes there.
   */
  async function candidates(input: {
    readonly sessionID: string
    readonly current: Variant.Ref
    readonly reason: "manual" | "hard" | "auth"
    readonly policy: Policy.File
    readonly exclude: (resolved: Resolved) => string | undefined
    readonly team?: Preset.Team
  }) {
    const registry = peers().slots.snapshot()
    const source = await resolve(input.current, input.sessionID)
    const presets = peers().presets
    const team = input.team
    const refs = registry.accounts.flatMap((account): Variant.Ref[] => {
      if (account.providerID === input.current.providerID || account.status === "retired") return []
      if (team && Targets.outsideTeam(account, team, lookup)) return []
      const slot = registry.slots[account.providerID]
      const template = slot ? registry.modelTemplates[slot.modelTemplate] : undefined
      const enabled = template?.models.filter((model) => model.enabled) ?? []
      if (enabled.some((model) => model.id === input.current.id))
        return [{ ...input.current, providerID: account.providerID }]
      // A model the user hid (07 §7.1 숨긴 모델) is never picked here while another one fits.
      const shown = (id: string) => !Policy.hidden(input.policy, account.kind, id)
      const known = presets.known(account.kind)
      const grouped = known && enabled.some((model) => model.id === known.id) ? known : undefined
      const pick = grouped && shown(grouped.id) ? grouped : (enabled.find((model) => shown(model.id)) ?? grouped)
      if (pick === grouped && grouped)
        return [
          {
            providerID: account.providerID,
            id: grouped.id,
            ...(grouped.variant === undefined ? {} : { variant: grouped.variant }),
          },
        ]
      const first = pick ?? enabled[0]
      return first ? [{ providerID: account.providerID, id: first.id }] : []
    })
    const resolved = await Promise.all(refs.map((ref) => resolve(ref, input.sessionID)))
    const from = {
      providerID: input.current.providerID,
      accountID: await cacheAccount(input.sessionID, input.current.providerID),
    }
    const view = await cacheView(input.sessionID, [from, ...refs.map((ref) => ({ providerID: ref.providerID }))])
    const ctx = context(input.sessionID, input.policy, view.epoch)
    const now = deps.clock.now()
    const ranked = Targets.rank({
      source: { ...source.side, cache: view.entry(from.providerID, from.accountID) },
      candidates: resolved.map((item) => {
        const state = usable(item.account, item.ref.providerID, undefined, item.ref.id)
        const excluded = !state.usable ? state.reason : item.model?.tools === false ? "no_tools" : input.exclude(item)
        return {
          side: { ...item.side, cache: view.entry(item.ref.providerID) },
          accountID: item.account?.id ?? null,
          target: item.ref,
          ...(excluded === undefined ? {} : { excluded }),
          headroom: item.account
            ? Targets.headroom(
                deps.runtime.limits
                  .list({ accountID: item.account.id })
                  .filter((window) => LimitModel.limits(window.id, item.ref.id) && !LimitRank.extra(window.id)),
                now,
              )
            : null,
        }
      }),
      ctx,
      thresholds: input.policy.thresholds,
      chain: input.policy.fallbackChains.default ?? [],
      sourceAvailable:
        input.reason === "manual" && usable(source.account, source.ref.providerID, undefined, source.ref.id).usable,
    })
    return { source, ranked, resolved }
  }

  return {
    resolve,
    refusal,
    usability: usable,
    planFor,
    result,
    candidates,
    cacheView,
    sessionTrigger,
    lookup,
    member,
  }
}

/** R4 member of the Claude slot (`acc_claude_slot`, 02 §8.5). */
const CLAUDE_SLOT: Preset.Member = { id: Account.ID.claudeSlot, kind: "claude-sub", billing: "subscription" }

/** Strips the internal `unit` of a ranked candidate for the `switch.suggested` event. */
export function candidate(ranked: Targets.Ranked): Estimate.Candidate {
  return {
    providerID: ranked.providerID,
    accountID: ranked.accountID ?? null,
    ...(ranked.target === undefined ? {} : { target: ranked.target }),
    score: ranked.score,
    deltaNow: ranked.deltaNow,
    perRequest: ranked.perRequest,
    headroom: ranked.headroom,
    ...(ranked.excludedReason === undefined ? {} : { excludedReason: ranked.excludedReason }),
  }
}

/**
 * Whether an account can serve requests of `model` now (02 §5.7 "거르기"): no exhaustion or auth failure recorded for
 * it that holds that model back (a model weekly bucket's only for its family; without a model account-wide ones only,
 * LV 2026-10-24), and `ready` or `unverified`. A provider without an own account is usable. `anthropic` answers for the
 * Claude accounts named (`claude`, default the slot's own): usable while any of them is; otherwise the one that resets
 * first.
 */
export function usability(
  limits: Pick<Limits.Store, "exhaustion">,
  account: Account.Info | undefined,
  providerID: string,
  claude?: ReadonlyArray<string>,
  model?: string,
): Usability {
  // `claude`: the accounts a provider without an own account runs on (the Claude slot's, the Claude Agent route's).
  const ids =
    account !== undefined ? [account.id] : (claude ?? (providerID === "anthropic" ? [Account.ID.claudeSlot] : []))
  const exhaustions = ids.map((id) => limits.exhaustion(id, model))
  const exhaustion = exhaustions.some((item) => item === undefined)
    ? undefined
    : exhaustions.toSorted((a, b) => a!.until - b!.until)[0]
  if (exhaustion)
    return {
      usable: false,
      reason: exhaustion.class === "auth" ? "auth_failed" : "exhausted",
      until: exhaustion.until,
    }
  if (!account) return { usable: true }
  if (account.status === "ready" || account.status === "unverified") return { usable: true }
  return { usable: false, reason: account.status }
}

/** The Claude accounts `anthropic` is judged by: the session tree's own, else every one of this PC. */
function claudeIDs(peers: Module.Peers, providerID: string, sessionID: string | undefined) {
  // The Claude Agent route (02 §8.10): the session tree's account, else every account of the route.
  if (providerID === ClaudeAgent.PROVIDER_ID) {
    const agent = peers().claudeAgent
    if (sessionID !== undefined) {
      const accountID = agent.peek(sessionID)
      return accountID === undefined ? undefined : [accountID]
    }
    const all = agent.list().map((item) => item.accountID)
    return all.length > 0 ? all : undefined
  }
  if (providerID !== Provider.ID.anthropic) return undefined
  const claude = peers().claude
  if (sessionID !== undefined) return [claude.peek(sessionID)]
  const all = claude.list().map((item) => item.accountID)
  return all.length === 0 ? undefined : all
}

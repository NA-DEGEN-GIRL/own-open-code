export * as Estimator from "./estimator.js"

import { Estimate, type Kind, type Policy } from "@own/protocol"
import type { Rates } from "./rates.js"

/**
 * The cost model of 02 §6 as pure functions. Token counts are tokens, rates are per 1M tokens (02 §6.2), and every
 * money value is in the rate's unit (codex credits, API USD). Ranges come from the two TTL bounds (02 §6.1 TTL_lo /
 * TTL_hi), the unknown summary-request hit ratio `h_c` (02 §6.3 ⑥) and the source's own warmth.
 */

/** Session cache state of one slot (02 §2.4.6 `Cache.Entry`; the switching tracker when telemetry has none). */
export interface SlotCache {
  readonly lastReqAt: number
  /** Input size of the slot's last request. */
  readonly L: number
  /** Compaction epoch of that request; compared with {@link Context.epoch}. */
  readonly epoch: number
  readonly modelID: string
  readonly variant: string | null
  readonly blocksSince: number
  readonly messageEndsSince: number
  /** A watermark cache hint exists for the return (02 §4.5), so the Anthropic lookback is satisfied. */
  readonly watermark: boolean
}

/** One side of a switch: the session's current slot (source) or the candidate (target). */
export interface Side {
  readonly providerID: string
  readonly kind: Kind.Any | undefined
  readonly modelID: string
  readonly variant: string | undefined
  readonly cacheDomain: string
  readonly quotaDomain: string | undefined
  /** Server-side sharing between slots of the domain is verified (AC-P05/P33/P35): same-domain reuse counts in W^lo. */
  readonly poolingVerified: boolean
  readonly billing: "subscription" | "metered" | "prepaid" | undefined
  readonly rates: Rates.Rates
  readonly cache: SlotCache | undefined
  /** ctx_t: the template's original window (`limit.input || limit.context`), not the registered `ctx_eff`. */
  readonly window: number
  /** T_t: the effective auto-compaction trigger (02 §4.7). */
  readonly trigger: number
}

/** Session-level estimator inputs (02 §6.1). */
export interface Context {
  readonly now: number
  /** Current compaction epoch, in the same numbering as the {@link SlotCache} entries. */
  readonly epoch: number
  /** P_cur: next request input on the current slot (last step input + its output). */
  readonly P: number
  /** Z: system + tools. */
  readonly Z: number
  /** Z + u_1: the prefix same-domain slots share when D9 normalization holds (02 §6.3 ①). */
  readonly Zu1: number
  /** Z_pre: tools + system[0], shared when D9 is not verified. */
  readonly Zpre: number
  /** δ: new cold part per request (median). */
  readonly delta: number
  /** S_sum: summary output tokens. */
  readonly summary: number
  /** m: the next message (02 §6.4 uses 2k). */
  readonly message: number
  /** seed_out: new-session handoff summary output (02 §6.4 uses 6k). */
  readonly seed: number
  /** K: recent tokens a compaction keeps verbatim. */
  readonly keep: number
  /** H: expected requests on the target (02 §5.7). */
  readonly horizon: number
  /** D9 identity normalization is in place (02 §4.3). */
  readonly d9: boolean
  /**
   * When the session's tool definitions or system last changed (`toolset_changed`, 02 §4.3 D10, from
   * `Auth.toolsetChangedAt`). A slot cache entry recorded before it shares no prefix with the next request, so it
   * counts as cold (`W = 0`).
   */
  readonly toolsetAt?: number
}

export interface Range {
  readonly lo: number
  readonly hi: number
}

/** Warnings of a plan, including the v0.3 compaction ones (02 §9.5). */
export type Warning = Estimate.Warning

const PER = 1_000_000

/** `tokens` at `rate` per 1M tokens. */
export function cost(tokens: number, rate: number) {
  return (tokens * rate) / PER
}

/** Rounds away float noise so ranges compare and print cleanly. */
export function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

function sameVariant(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? "default") === (b ?? "default")
}

/** The entry's cache is still kept, and it was written with the session's current tool definitions and system (D10). */
function warm(entry: SlotCache, ttlSec: number, ctx: Context) {
  return ctx.now - entry.lastReqAt < ttlSec * 1000 && entry.lastReqAt >= (ctx.toolsetAt ?? Number.NEGATIVE_INFINITY)
}

/** 02 §6.3 ① lookbackOK: anth `blocksSince < 20 ∨ watermark`, oai 5.6+ `messageEndsSince < 20` ⚠, else true ⚠. */
export function lookbackOK(rates: Rates.Rates, entry: SlotCache) {
  if (rates.lookback === null) return true
  if ("blocks" in rates.lookback) return entry.blocksSince < rates.lookback.blocks || entry.watermark
  return entry.messageEndsSince < rates.lookback.messageEnds
}

/**
 * W_t (02 §6.3 ①): the prefix of the target's cache this request can reuse. `lo` uses TTL_lo, `hi` TTL_hi (unknown
 * TTL_hi → `hi = lo`). Same-domain reuse across slots counts only in `hi` until the domain's pooling is verified.
 * When the lookback fails, the fixed-prefix breakpoints (tools, system) still hit, so `W = Z` (02 §6.4 example 3).
 */
export function reuse(target: Side, source: Side, ctx: Context): Range {
  const lo = reuseWithin(target, source, ctx, target.rates.ttlLo, source.rates.ttlLo, false)
  if (target.rates.ttlHi === null) return { lo, hi: lo }
  const hi = reuseWithin(target, source, ctx, target.rates.ttlHi, source.rates.ttlHi ?? source.rates.ttlLo, true)
  return { lo, hi: Math.max(lo, hi) }
}

function reuseWithin(target: Side, source: Side, ctx: Context, ttlSec: number, sourceTtlSec: number, upper: boolean) {
  const entry = target.cache
  if (
    entry &&
    warm(entry, ttlSec, ctx) &&
    entry.epoch === ctx.epoch &&
    entry.modelID === target.modelID &&
    sameVariant(entry.variant, target.variant)
  )
    return lookbackOK(target.rates, entry) ? entry.L : Math.min(ctx.Z, entry.L)
  const sameDomain = target.cacheDomain === source.cacheDomain && target.providerID !== source.providerID
  if (
    sameDomain &&
    source.cache !== undefined &&
    warm(source.cache, sourceTtlSec, ctx) &&
    (upper || target.poolingVerified)
  )
    return ctx.d9 ? ctx.Zu1 : ctx.Zpre
  return 0
}

const ANTHROPIC_KINDS: ReadonlyArray<Kind.Any | undefined> = ["anth", "claude-sub", "claude-agent"]

/** P_t = ρ_t·(P_cur − Z) + Z_t (02 §6.1); ρ = 1.1 into an Anthropic tokenizer ⚠AC-P14, Z_t ≈ Z. */
export function targetInput(target: Side, source: Side, ctx: Context) {
  if (ctx.P === 0) return 0
  const rho = ANTHROPIC_KINDS.includes(target.kind) && !ANTHROPIC_KINDS.includes(source.kind) ? 1.1 : 1
  return ctx.Z + rho * Math.max(0, ctx.P - ctx.Z)
}

/** ② C_first = W·r_read + (P_t − W)·r_cold. */
export function firstRequest(rates: Rates.Rates, W: number, Pt: number) {
  if (rates.read === null || rates.cold === null) return null
  const reused = Math.min(W, Pt)
  return cost(reused, rates.read) + cost(Pt - reused, rates.cold)
}

/** ⑤ c_req = P·r_read + δ·r_cold. */
export function perRequest(rates: Rates.Rates, P: number, delta: number) {
  if (rates.read === null || rates.cold === null) return null
  return cost(P, rates.read) + cost(delta, rates.cold)
}

/** ⑥ C_compact(src) = (Z + P_older)·[h·r_read + (1−h)·r_cold] + S_sum·r_out. */
export function compactRequest(rates: Rates.Rates, prefix: number, summary: number, h: number) {
  if (rates.read === null || rates.cold === null || rates.out === null) return null
  return cost(prefix * h, rates.read) + cost(prefix * (1 - h), rates.cold) + cost(summary, rates.out)
}

/** ⑪ Δused% from `(U, C, O)` token classes, with `k_c ∈ [0.1·k_u, k_u]` until calibrated (02 §6.3 ⑪, §7.6). */
export function quotaDelta(input: {
  readonly ku: number
  readonly kc?: Range
  readonly ko?: number
  readonly switched: { readonly U: number; readonly C: number; readonly O: number }
  readonly stayed: { readonly U: number; readonly C: number; readonly O: number }
}): Range {
  const kc = input.kc ?? { lo: 0.1 * input.ku, hi: input.ku }
  const ko = input.ko ?? 0
  const used = (tokens: { readonly U: number; readonly C: number; readonly O: number }, k: number) =>
    input.ku * tokens.U + k * tokens.C + ko * tokens.O
  return {
    lo: round(Math.max(0, used(input.switched, kc.lo) - used(input.stayed, kc.hi))),
    hi: round(used(input.switched, kc.hi) - used(input.stayed, kc.lo)),
  }
}

/** Planner input for one target (02 §5.6, §6). */
export interface PlanInput {
  readonly source: Side
  readonly target: Side
  readonly ctx: Context
  /** The source can still serve requests (not exhausted, not failing auth, and the trigger is manual). */
  readonly sourceAvailable: boolean
  readonly thresholds: Policy.Thresholds
  readonly variantOnly: Estimate.VariantOnly | null
}

export interface Plan {
  /** P_t. */
  readonly Pt: number
  /** W_t. */
  readonly W: Range
  /** W of staying on the source. */
  readonly Wcur: Range
  /** P_t < T_t. */
  readonly fits: boolean
  readonly units: { readonly source: Estimate.Unit; readonly target: Estimate.Unit }
  readonly options: ReadonlyArray<Estimate.Option>
  readonly warnings: ReadonlyArray<Warning>
  /** The option marked `recommended` (02 §5.6), if any. */
  readonly recommended: Estimate.Strategy | undefined
  /** Δ_now (④) in the target unit; `null` when a rate is unknown. */
  readonly deltaNow: Estimate.Delta | null
  /** c_req(t) (⑤). */
  readonly perRequest: number | null
  /** H* of ⑦ for switch-then-compact; `null` when it never pays off or rates are unknown. */
  readonly breakeven: number | null
  /** Cold tokens of the first request on the target: `P_t − W^lo` (AC-P14 compares it with the ledger). */
  readonly predictedCold: number
}

/**
 * Builds every `switch.estimate` option for one target (02 §5.6, §6.3, §9.2): `now`, `compact-then-switch`,
 * `switch-then-compact`, `cold-point`, `new-session`, `fork`. Deltas are the extra cost over staying when both sides
 * bill in the same unit and the source is usable; otherwise they are the target-side cost alone (02 §6.3 ⑤ "단위가
 * 다르면 따로 적는다"). `recommended` follows 02 §5.6 and is never set across billing units except for the forced
 * choice when the target context is too small.
 */
export function plan(input: PlanInput): Plan {
  const source = input.source
  const target = input.target
  const ctx = input.ctx
  const t = target.rates
  const s = source.rates
  const sameUnit = s.unit === t.unit
  const preserves = input.variantOnly?.preservesCache === true
  const Pt = targetInput(target, source, ctx)
  const Wcur = reuse(source, source, ctx)
  const W = preserves ? Wcur : reuse(target, source, ctx)
  const stayKnown = s.read !== null && s.cold !== null
  const useBaseline = input.sourceAvailable && sameUnit && stayKnown
  const baseline = (Wc: number) => (useBaseline ? (firstRequest(s, Wc, ctx.P) ?? 0) : 0)
  const range = (values: ReadonlyArray<number | null>): Estimate.Delta | null => {
    if (values.some((value) => value === null)) return null
    const numbers = values.filter((value): value is number => value !== null)
    return { lo: round(Math.min(...numbers)), hi: round(Math.max(...numbers)), unit: t.unit }
  }
  const sub = (value: number | null, minus: number) => (value === null ? null : value - minus)

  // ④ Δ_now: best case pairs a warm target with a cold source, worst case the reverse.
  const deltaNow = preserves
    ? { lo: 0, hi: 0, unit: t.unit }
    : range([sub(firstRequest(t, W.hi, Pt), baseline(Wcur.lo)), sub(firstRequest(t, W.lo, Pt), baseline(Wcur.hi))])
  const cReq = perRequest(t, Pt, ctx.delta)

  // ⑥ compaction on the source, then a small cold first request on the target.
  const older = Math.max(0, ctx.P - ctx.Z - ctx.keep)
  const prefix = ctx.P === 0 ? 0 : Math.min(ctx.P, ctx.Z + older)
  const S = ctx.P === 0 ? 0 : Math.min(ctx.Z + ctx.summary + ctx.keep + ctx.message, Pt)
  const sourceAge = source.cache ? ctx.now - source.cache.lastReqAt : Number.POSITIVE_INFINITY
  const hHi = source.cache && (s.ttlHi === null || sourceAge < s.ttlHi * 1000) ? 1 : 0
  const hLo = source.cache && s.mode === "prefix" && sourceAge < s.ttlLo * 1000 ? 1 : 0
  const firstAfterCompact = t.cold === null ? null : cost(S, t.cold)
  const cReqAfterCompact = perRequest(t, S, ctx.delta)
  const compactCost = (h: number, Wc: number) => {
    const summary = compactRequest(s, prefix, ctx.summary, h)
    if (summary === null || firstAfterCompact === null) return null
    return sameUnit ? summary + firstAfterCompact - baseline(Wc) : firstAfterCompact
  }
  const compactKnown = s.out !== null && s.read !== null && s.cold !== null && t.cold !== null && t.read !== null
  const compactDelta = compactKnown
    ? range([
        compactCost(hHi, Wcur.lo),
        compactCost(hLo, Wcur.hi),
        compactCost(hHi, Wcur.hi),
        compactCost(hLo, Wcur.lo),
      ])
    : null

  // ⑦ switch first, then the target summarizes everything cold.
  const switchCompactFixed = (Wt: number) => {
    if (t.read === null || t.cold === null || t.out === null) return null
    const reused = Math.min(Wt, prefix)
    return cost(reused, t.read) + cost(prefix - reused, t.cold) + cost(ctx.summary, t.out) + cost(S, t.cold)
  }
  const fixedLo = switchCompactFixed(W.lo)
  const firstLo = firstRequest(t, W.lo, Pt)
  const gainPerRequest = cReq !== null && cReqAfterCompact !== null ? cReq - cReqAfterCompact : null
  const breakeven =
    fixedLo !== null && firstLo !== null && gainPerRequest !== null && gainPerRequest > 0
      ? round(1 + Math.max(0, fixedLo - firstLo) / gainPerRequest)
      : null

  // ⑩ new session: the source writes a handoff summary, the target starts from Z + seed + m cold.
  const handoff = ctx.Z + ctx.seed + ctx.message
  const newTarget = t.cold === null ? null : cost(handoff, t.cold)
  const newSource = input.sourceAvailable ? (s.out === null ? null : cost(ctx.seed, s.out)) : 0
  const newDelta =
    newTarget === null || newSource === null ? null : range([sameUnit ? newSource + newTarget : newTarget])

  const tooSmall = Pt > 0 && Pt >= target.trigger
  const compactsSoon = !tooSmall && Pt > 0 && Pt >= 0.8 * target.trigger
  const rateUnknown = () => ({ available: false, reason: "rate_unknown" as const, delta: null })
  const quota = quotaImpact(target)
  const nowBlocked = tooSmall && input.sourceAvailable && compactKnown
  const nowOption: Estimate.Option = {
    strategy: "now",
    available: !nowBlocked,
    display: "primary",
    ...(nowBlocked ? { reason: "target_context_too_small" as const } : {}),
    delta: deltaNow,
    perRequestAfter: cReq === null ? null : round(cReq),
    ...(quota ? { quota } : {}),
    ...(tooSmall ? { warnings: ["target_context_too_small" as const] } : {}),
  }

  const compactOption: Estimate.Option = {
    strategy: "compact-then-switch",
    display: "primary",
    ...(!input.sourceAvailable
      ? { available: false, reason: "source_exhausted" as const }
      : compactKnown
        ? {
            available: true,
            delta: compactDelta,
            perRequestAfter: cReqAfterCompact === null ? null : round(cReqAfterCompact),
            ...(ANTHROPIC_KINDS.includes(source.kind)
              ? { warnings: ["anthropic_compaction_may_be_cold" as const] }
              : {}),
          }
        : rateUnknown()),
  }

  const switchCompactKnown = fixedLo !== null
  const switchCompactOption: Estimate.Option = {
    strategy: "switch-then-compact",
    display: "primary",
    ...(input.sourceAvailable
      ? { available: false, reason: "source_available" as const }
      : switchCompactKnown
        ? {
            available: true,
            delta: range([switchCompactFixed(W.hi), switchCompactFixed(W.lo)]),
            perRequestAfter: cReqAfterCompact === null ? null : round(cReqAfterCompact),
          }
        : rateUnknown()),
  }

  const sourceCold = ctx.P === 0 || source.cache === undefined || (s.ttlHi !== null && sourceAge >= s.ttlHi * 1000)
  const idleMinutes = s.ttlHi !== null ? Math.ceil(s.ttlHi / 60) : input.thresholds.unknownTtlIdleMinutes
  const coldPointDelta =
    t.cold === null || t.read === null ? null : range([0, Math.max(0, cost(ctx.Z, t.cold) - cost(ctx.Z, t.read))])
  const coldPointOption: Estimate.Option = {
    strategy: "cold-point",
    display: "primary",
    trigger: "either",
    idleMinutes,
    uncertain: s.ttlHi === null,
    ...(!input.sourceAvailable
      ? { available: false, reason: "source_exhausted" as const }
      : sourceCold
        ? { available: false, reason: "source_already_cold" as const }
        : s.ttlHi !== null && s.ttlHi > 86_400
          ? { available: false, reason: "ttl_too_long" as const }
          : { available: true, delta: coldPointDelta }),
  }

  const newCReq = perRequest(t, handoff, ctx.delta)
  const newSessionOption: Estimate.Option = {
    strategy: "new-session",
    display: "primary",
    contextLoss: true,
    ...(newDelta === null
      ? rateUnknown()
      : { available: true, delta: newDelta, perRequestAfter: newCReq === null ? null : round(newCReq) }),
  }

  const forkOption: Estimate.Option = {
    ...nowOption,
    strategy: "fork",
    display: "secondary",
  }

  const options = [nowOption, compactOption, switchCompactOption, coldPointOption, newSessionOption, forkOption]
  const available = (strategy: Estimate.Strategy) =>
    options.some((option) => option.strategy === strategy && option.available)

  const recommended = recommend({
    input,
    sameUnit,
    preserves,
    tooSmall,
    compactsSoon,
    S,
    available,
    breakeven,
  })

  const warnings: Warning[] = [
    ...(tooSmall ? ["target_context_too_small" as const] : []),
    ...(compactsSoon ? ["target_compacts_soon" as const] : []),
    ...(!input.sourceAvailable && ctx.P > 0 && ctx.Z + older > target.trigger
      ? ["compaction_may_truncate" as const]
      : []),
    ...(ctx.P > 0 && canonical(source.kind) !== canonical(target.kind)
      ? ["cross_provider_reasoning_loss" as const]
      : []),
    ...(available("compact-then-switch") && ANTHROPIC_KINDS.includes(source.kind)
      ? ["anthropic_compaction_may_be_cold" as const]
      : []),
    ...(source.quotaDomain !== undefined &&
    source.quotaDomain === target.quotaDomain &&
    source.providerID !== target.providerID
      ? ["same_org_no_headroom" as const]
      : []),
    ...(deltaNow === null || options.some((option) => option.reason === "rate_unknown")
      ? ["rate_unknown" as const]
      : []),
  ]

  return {
    Pt: round(Pt),
    W,
    Wcur,
    fits: !tooSmall,
    units: { source: s.unit, target: t.unit },
    options: options.map((option) => (option.strategy === recommended ? { ...option, recommended: true } : option)),
    warnings,
    recommended,
    deltaNow,
    perRequest: cReq === null ? null : round(cReq),
    breakeven,
    predictedCold: round(Math.max(0, Pt - W.lo)),
  }
}

function canonical(kind: Kind.Any | undefined) {
  if (kind === "codex" || kind === "siwc" || kind === "oai") return "openai"
  if (kind === "anth" || kind === "claude-sub" || kind === "claude-agent") return "anthropic"
  return kind
}

function quotaImpact(target: Side): Estimate.QuotaImpact | undefined {
  if (target.kind === "claude-sub" || target.kind === "claude-agent")
    return { window: "claude.5h", percent: null, state: "calibrating" }
  if (target.kind === "codex" && target.billing !== "metered")
    return { window: "codex.primary", percent: null, state: "calibrating" }
  return undefined
}

/**
 * 02 §5.6 default choice; only it is marked `recommended`. Context-changing choices follow the target's window only
 * (07 §6.2 #9–#11): no token-size threshold, and cost alone never recommends compacting before a switch.
 */
function recommend(input: {
  readonly input: PlanInput
  readonly sameUnit: boolean
  readonly preserves: boolean
  readonly tooSmall: boolean
  readonly compactsSoon: boolean
  readonly S: number
  readonly available: (strategy: Estimate.Strategy) => boolean
  readonly breakeven: number | null
}): Estimate.Strategy | undefined {
  const plan = input.input
  const ctx = plan.ctx
  const target = plan.target
  if (input.preserves) return "now"
  if (input.tooSmall) {
    if (plan.sourceAvailable && input.available("compact-then-switch")) return "compact-then-switch"
    if (input.available("new-session")) return "new-session"
    if (input.available("switch-then-compact")) return "switch-then-compact"
    return undefined
  }
  if (!input.sameUnit) return undefined
  if (ctx.P === 0) return "now"
  if (!plan.sourceAvailable) {
    if (
      ctx.P >= 0.6 * target.window &&
      input.available("switch-then-compact") &&
      input.breakeven !== null &&
      ctx.horizon >= input.breakeven
    )
      return "switch-then-compact"
    return "now"
  }
  if (input.compactsSoon) {
    if (input.S >= 0.8 * target.trigger && input.available("new-session")) return "new-session"
    if (input.available("compact-then-switch")) return "compact-then-switch"
  }
  return "now"
}

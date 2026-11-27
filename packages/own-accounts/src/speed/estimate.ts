export * as SpeedEstimate from "./estimate.js"

import type { Estimate, Speed } from "@own/protocol"

/**
 * Owner: SPEED (02 §6.3 ⑬, decision 7). The cost of a speed-only change, pure. The prompt bytes stay the same, so only
 * the cache and the per-token price can change:
 * - OpenAI family: whether a tier change keeps the cached prefix is not documented (⚠, live check 1). Until this
 *   kind's changes were measured (`runtime.speed` retention, from the first request after a change), the first
 *   request is a range: `lo` the cache kept, `hi` the whole prefix written again at the new tier's price.
 * - Anthropic: the beta header is part of the cache key. The first fast request of a conversation writes the whole
 *   prefix again at the fast price (`first_fast_rewrite`); after it the header stays, so later changes keep the cache
 *   and only the price changes (⚠ `cache_unverified`, live check 3).
 *
 * `C_stay = L·r_read + (P − L)·r_cold` at today's rates, `C_first = L·r_read' + (P − L)·r_cold'` with the cache kept
 * or `P·r_cold'` with it lost; `delta = C_first − C_stay` (02 §6.3 ②–④). The Claude subscription slot's Standard is
 * plan limit (no money), so its delta is the fast request's usage-credit cost itself (`extra_usage`).
 */

/** Rates per 1M tokens in `unit` (02 §6.1); `undefined` = not known. */
export interface Rates {
  readonly unit: Estimate.Unit
  readonly input?: number
  readonly read?: number
  readonly cold?: number
}

export interface Input {
  readonly from: Speed.Choice
  readonly to: Speed.Choice
  readonly wire: Speed.Wire | undefined
  /** P: the next request's input. */
  readonly P: number
  /** L: the cached input of the slot's last request while it is still warm, else 0. */
  readonly L: number
  /** Rates of the speed now and after the change. */
  readonly before: Rates | undefined
  readonly after: Rates | undefined
  /** Plan multiple of the target speed over Standard (`codex`, `siwc`: included usage), when there is no rate. */
  readonly multiple?: number
  /** Anthropic: the conversation already sends the beta header. */
  readonly beta: boolean
  /** The Claude subscription slot: money is usage credits only for a fast request. */
  readonly extra: boolean
  /** Measured tier changes of this kind: how many kept the cache and how many lost it. */
  readonly retention?: { readonly kept: number; readonly lost: number }
  /** The target speed is offered from the catalog only (`unverified`). */
  readonly unverified: boolean
}

/** Changes needed before a measured verdict is used instead of the range (02 §6.3 ⑬). */
export const MEASURED_MIN = 3

export function change(input: Input): Speed.Change {
  const anthropic = input.wire === "speed"
  const measured = !anthropic ? verdict(input.retention) : undefined
  const firstFast = anthropic && input.to !== "standard" && !input.beta
  const cache: Speed.Change["cache"] = anthropic ? (firstFast ? "lost" : "kept") : (measured ?? "unknown")
  const warnings: Speed.ChangeWarning[] = [
    ...(firstFast ? ["first_fast_rewrite" as const] : []),
    ...((anthropic && !firstFast) || (!anthropic && !measured) ? ["cache_unverified" as const] : []),
    ...(input.extra && input.to !== "standard" ? ["extra_usage" as const] : []),
    ...(input.unverified ? ["unverified_tier" as const] : []),
  ]
  const before = input.before
  const after = input.after
  const priced =
    after?.input !== undefined && (input.extra || (before?.input !== undefined && before.unit === after.unit))
  const factor =
    before?.input !== undefined && after?.input !== undefined && before.input > 0 && before.unit === after.unit
      ? round(after.input / before.input)
      : (input.multiple ?? null)
  const base = {
    from: input.from,
    to: input.to,
    P: round(input.P),
    basis: measured ? ("measured" as const) : ("rule" as const),
    cache,
    factor,
  }
  // Back to Standard on the Claude subscription slot: plan limits again, no usage-credit cost.
  if (input.extra && input.to === "standard")
    return { ...base, unit: "USD", delta: { lo: 0, hi: 0, unit: "USD" }, warnings }
  if (!priced || !after) {
    const unit = after?.unit ?? before?.unit ?? "credits"
    return { ...base, unit, delta: null, warnings: [...warnings, "rate_unknown"] }
  }
  const L = Math.min(input.L, input.P)
  const stay = input.extra || !before ? 0 : costOf(before, input.P, L)
  const kept = costOf(after, input.P, L) - stay
  const lost = costOf(after, input.P, 0) - stay
  const range = cache === "kept" ? [kept, kept] : cache === "lost" ? [lost, lost] : [kept, lost]
  const [lo = 0, hi = 0] = range.toSorted((a, b) => a - b)
  return { ...base, unit: after.unit, delta: { lo: round(lo), hi: round(hi), unit: after.unit }, warnings }
}

/** `L·r_read + (P − L)·r_cold` per 1M tokens; a missing read or cold rate is the input rate. */
function costOf(rates: Rates, P: number, L: number) {
  const input = rates.input ?? 0
  return (L * (rates.read ?? input) + (P - L) * (rates.cold ?? input)) / 1_000_000
}

/** `kept`/`lost` once enough changes agree (≥ 80 %), else none (the range stays). */
function verdict(retention: Input["retention"]): "kept" | "lost" | undefined {
  if (!retention) return undefined
  const total = retention.kept + retention.lost
  if (total < MEASURED_MIN) return undefined
  if (retention.kept / total >= 0.8) return "kept"
  return retention.lost / total >= 0.8 ? "lost" : undefined
}

/** Scales every rate by `factor` (a mode price over the base price, a plan's credits multiple). */
export function scale(rates: Rates | undefined, factor: number | undefined): Rates | undefined {
  if (!rates || factor === undefined) return undefined
  const times = (rate: number | undefined) => (rate === undefined ? undefined : rate * factor)
  return {
    unit: rates.unit,
    ...(rates.input === undefined ? {} : { input: times(rates.input) }),
    ...(rates.read === undefined ? {} : { read: times(rates.read) }),
    ...(rates.cold === undefined ? {} : { cold: times(rates.cold) }),
  }
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

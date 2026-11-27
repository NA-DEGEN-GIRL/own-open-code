export * as Hysteresis from "./hysteresis.js"

import type { Policy } from "@own/protocol"

/** One applied switch of a session, for the breaker (02 §5.5). */
export interface SwitchRecord {
  readonly at: number
  readonly from: string | null
  readonly to: string
  /** Chosen by the policy (T-HARD/T-AUTH auto), not by the user. */
  readonly auto: boolean
}

/** Cold tokens (`input + cache.write`) of one step. */
export interface ColdSample {
  readonly at: number
  readonly cold: number
}

export type BreakerReason = "auto_per_hour" | "flap" | "cold_sum"

const MINUTE = 60_000
const COLD_WINDOW = 15 * MINUTE

/** COOLDOWN after a switch: `cooldownMinutes` AND `cooldownRequests`, whichever ends later (02 §5.4, §5.5). */
export function cooldown(hysteresis: Policy.Hysteresis, now: number) {
  return { until: now + hysteresis.cooldownMinutes * MINUTE, requestsLeft: hysteresis.cooldownRequests }
}

export function cooldownDone(state: { readonly until: number; readonly requestsLeft: number }, now: number) {
  return now >= state.until && state.requestsLeft <= 0
}

/**
 * Whether the circuit breaker trips (02 §5.5): at least `breakerAutoPerHour` automatic switches in the last hour,
 * an automatic A→B→A within `breakerFlapMinutes` with no user action in between, or cold tokens of the last 15
 * minutes above `coldSumFactor · P`. While open (`breakerOpenMinutes`) automatic switches become suggestions.
 */
export function breaker(input: {
  readonly hysteresis: Policy.Hysteresis
  readonly switches: ReadonlyArray<SwitchRecord>
  /** Last user action on the session's switching (manual switch, apply, cancel). */
  readonly manualAt: number | undefined
  readonly colds: ReadonlyArray<ColdSample>
  /** Current context size. */
  readonly P: number
  readonly now: number
}): BreakerReason | undefined {
  const h = input.hysteresis
  const recentAuto = input.switches.filter((record) => record.auto && input.now - record.at < 60 * MINUTE)
  if (h.breakerAutoPerHour > 0 && recentAuto.length >= h.breakerAutoPerHour) return "auto_per_hour"
  const [first, second] = input.switches.slice(-2)
  if (
    first &&
    second &&
    first.auto &&
    second.auto &&
    first.from !== null &&
    second.from === first.to &&
    second.to === first.from &&
    second.at - first.at <= h.breakerFlapMinutes * MINUTE &&
    (input.manualAt ?? Number.NEGATIVE_INFINITY) < first.at
  )
    return "flap"
  const cold = input.colds
    .filter((sample) => input.now - sample.at < COLD_WINDOW)
    .reduce((sum, sample) => sum + sample.cold, 0)
  if (input.P > 0 && cold > h.coldSumFactor * input.P) return "cold_sum"
  return undefined
}

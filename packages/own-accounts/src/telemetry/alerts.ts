export * as Alerts from "./alerts.js"

/**
 * Alert conditions judged from the ledger stream (02 §7.7): `low_hit`, `return_miss`, `prefix_drift` (the "cold sum"
 * breaker signal) and `flap`. Pure functions over a session's recent steps; the module raises the alerts.
 */

/** One primary step of a session as the alert rules see it. */
export interface Step {
  readonly ts: number
  readonly providerID: string
  /** Request input `input + cacheRead + cacheWrite`. */
  readonly P: number
  readonly cacheRead: number
  /** Uncached part: `input + cacheWrite`. */
  readonly cold: number
  /** First step after a switch or a compaction (excluded from the rolling hit rate). */
  readonly first: boolean
}

export const LOW_HIT = { steps: 5, minP: 20_000, threshold: 0.6 } as const
export const PREFIX_DRIFT = { windowMs: 15 * 60_000, minP: 20_000 } as const
export const RETURN_MISS = { factor: 0.8 } as const

/**
 * `low_hit`: rolling hit of the last {@link LOW_HIT.steps} non-first steps of the current stay on one provider, each
 * with `P ≥ 20k`, below 60 %. Returns the rolling hit when the alert applies.
 */
export function lowHit(history: ReadonlyArray<Step>) {
  const latest = history.at(-1)
  if (!latest) return undefined
  const stay = trailing(history, (step) => step.providerID === latest.providerID).filter((step) => !step.first)
  const window = stay.slice(-LOW_HIT.steps)
  if (window.length < LOW_HIT.steps || window.some((step) => step.P < LOW_HIT.minP)) return undefined
  const P = window.reduce((sum, step) => sum + step.P, 0)
  const hit = window.reduce((sum, step) => sum + step.cacheRead, 0) / P
  return hit < LOW_HIT.threshold ? hit : undefined
}

/**
 * `prefix_drift`: the cold input of the last 15 minutes exceeds `factor × P` (policy `hysteresis.coldSumFactor`,
 * default 3) for a session whose current `P ≥ 20k`. Returns the cold sum when the alert applies.
 */
export function prefixDrift(history: ReadonlyArray<Step>, now: number, factor: number) {
  const latest = history.at(-1)
  if (!latest || latest.P < PREFIX_DRIFT.minP) return undefined
  const cold = history
    .filter((step) => step.ts >= now - PREFIX_DRIFT.windowMs)
    .reduce((sum, step) => sum + step.cold, 0)
  return cold > factor * latest.P ? cold : undefined
}

/** The slot's cache state before the returning step (KV `sess:<sid>:cache:<pid>`). */
export interface Previous {
  readonly L: number
  readonly lastReqAt: number
  readonly epoch: number
  readonly modelID: string
  readonly variant: string | null
}

/**
 * `return_miss`: the session came back to a slot within its `TTL_lo` (same epoch, model and variant) and the first
 * step's hit is below `0.8 · L/P`. Returns the expected hit when the alert applies.
 */
export function returnMiss(input: {
  readonly previous: Previous | undefined
  readonly step: Step
  readonly epoch: number
  readonly modelID: string
  readonly variant: string | null
  readonly ttlLoMs: number
}) {
  const previous = input.previous
  if (!previous || !input.step.first || input.step.P <= 0) return undefined
  if (input.step.ts - previous.lastReqAt >= input.ttlLoMs) return undefined
  if (previous.epoch !== input.epoch || previous.modelID !== input.modelID || previous.variant !== input.variant)
    return undefined
  const expected = Math.min(1, previous.L / input.step.P)
  const hit = input.step.cacheRead / input.step.P
  return hit < RETURN_MISS.factor * expected ? expected : undefined
}

/** A model selection of a session (`session.model.selected`). */
export interface Selection {
  readonly at: number
  readonly providerID: string
}

/**
 * `flap`: A → B → A where both switches happen within `windowMs` (policy `hysteresis.breakerFlapMinutes`, default
 * 10 min): the time from leaving A to coming back.
 */
export function flap(selections: ReadonlyArray<Selection>, windowMs: number) {
  const changes = selections.filter(
    (selection, index) => index === 0 || selection.providerID !== selections[index - 1].providerID,
  )
  const [a, b, c] = changes.slice(-3)
  if (!a || !b || !c) return false
  return a.providerID === c.providerID && a.providerID !== b.providerID && c.at - b.at <= windowMs
}

function trailing<T>(items: ReadonlyArray<T>, keep: (item: T) => boolean) {
  const start = items.findLastIndex((item) => !keep(item))
  return items.slice(start + 1)
}

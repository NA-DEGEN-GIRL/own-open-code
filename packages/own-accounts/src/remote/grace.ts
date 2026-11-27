export * as Grace from "./grace.js"

import { Broker } from "@own/protocol"

/**
 * The fail-closed grace of a remote turn (04 §8.7). Counted against a deadline fixed at the first failure
 * (`firstFailureAt + failClosedGraceSeconds`), spread over the retries core still allows: each attempt waits
 * `min(30 s, (deadline − now) / remaining attempts)`; at or after the deadline the turn ends. Core calls the retry
 * hook with `attempt` 2 for the first retry and allows `Broker.CORE_RETRIES` retries (`retry.ts` `Schedule.recurs(10)`).
 */
export type Decision = { readonly retry: false } | { readonly retry: true; readonly delay: number }

export function decide(input: {
  readonly now: number
  readonly deadline: number
  readonly attempt: number
  readonly retries?: number
}): Decision {
  if (input.now >= input.deadline) return { retry: false }
  const retries = input.retries ?? Broker.CORE_RETRIES
  const remaining = Math.max(1, retries + 2 - input.attempt)
  const delay = Math.min(Broker.GRACE_DELAY_CAP_MS, Math.floor((input.deadline - input.now) / remaining))
  return { retry: true, delay: Math.max(0, delay) }
}

/** Upper bound of how long a turn keeps retrying before it stops: the grace plus the first attempt's broker wait. */
export function bound(graceSeconds: number, brokerWaitMs: number) {
  return graceSeconds * 1000 + brokerWaitMs
}

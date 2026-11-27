// Live `switch.estimate` for the switcher footer and the cost dialog (03 §16.4): selection changes are debounced
// (150 ms), results are cached per (session, target) for 30 s and never past the router's `expiresAt`, and an older
// answer never replaces a newer selection. A switch or a compaction in the session drops its cache.
import type { Estimate } from "@own/protocol"
import type { TargetRef } from "./cost"

export const DEBOUNCE_MS = 150
export const CACHE_MS = 30_000

export type EstimateState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly key: string }
  | { readonly status: "ready"; readonly key: string; readonly result: Estimate.Result }
  | { readonly status: "error"; readonly key: string; readonly error: unknown }

export interface Estimator {
  /**
   * Debounced: the latest call wins; `onState` gets loading → ready | error for that key only. `accountID`: the Claude
   * account the target would run on (SL-8, `switch.estimate{accountID}`); omitted = the session's own.
   */
  schedule(sessionID: string, target: TargetRef, onState: (state: EstimateState) => void, accountID?: string): void
  /** Cached or fetched now (dialog confirm, variant button). */
  fetch(sessionID: string, target: TargetRef, accountID?: string): Promise<Estimate.Result>
  /** A fresh cached result, if any. */
  peek(sessionID: string, target: TargetRef, accountID?: string): Estimate.Result | undefined
  /** Stops the pending schedule (popover closed). An answer already on its way is ignored. */
  cancel(): void
  invalidate(sessionID?: string): void
}

export function estimateKey(sessionID: string, target: TargetRef, accountID?: string) {
  return `${sessionID}|${target.providerID}|${target.id}|${target.variant ?? ""}|${accountID ?? ""}`
}

export function createEstimator(input: {
  readonly call: (sessionID: string, target: TargetRef, accountID?: string) => Promise<Estimate.Result>
  readonly now?: () => number
  readonly debounceMs?: number
  readonly cacheMs?: number
}): Estimator {
  const now = input.now ?? Date.now
  const cache = new Map<string, { readonly at: number; readonly sessionID: string; readonly result: Estimate.Result }>()
  const inflight = new Map<string, Promise<Estimate.Result>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let latest = ""

  const fresh = (key: string) => {
    const entry = cache.get(key)
    if (!entry) return undefined
    const at = now()
    if (at - entry.at > (input.cacheMs ?? CACHE_MS) || at >= entry.result.expiresAt) {
      cache.delete(key)
      return undefined
    }
    return entry.result
  }

  const load = (sessionID: string, target: TargetRef, accountID?: string) => {
    const key = estimateKey(sessionID, target, accountID)
    const cached = fresh(key)
    if (cached) return Promise.resolve(cached)
    const running = inflight.get(key)
    if (running) return running
    const request = input
      .call(sessionID, target, accountID)
      .then((result) => {
        cache.set(key, { at: now(), sessionID, result })
        return result
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
  }

  return {
    schedule(sessionID, target, onState, accountID) {
      const key = estimateKey(sessionID, target, accountID)
      latest = key
      clearTimeout(timer)
      const cached = fresh(key)
      if (cached) return onState({ status: "ready", key, result: cached })
      onState({ status: "loading", key })
      timer = setTimeout(() => {
        load(sessionID, target, accountID).then(
          (result) => latest === key && onState({ status: "ready", key, result }),
          (error: unknown) => latest === key && onState({ status: "error", key, error }),
        )
      }, input.debounceMs ?? DEBOUNCE_MS)
    },
    fetch: load,
    peek: (sessionID, target, accountID) => fresh(estimateKey(sessionID, target, accountID)),
    cancel() {
      clearTimeout(timer)
      latest = ""
    },
    invalidate(sessionID) {
      for (const [key, entry] of cache) if (sessionID === undefined || entry.sessionID === sessionID) cache.delete(key)
    },
  }
}

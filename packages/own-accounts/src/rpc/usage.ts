export * as UsageRpc from "./usage.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: TELEMETRY agent. Limits, ledger, cache state and rate cards. */
export type Methods =
  | "quota.snapshot"
  | "ledger.session"
  | "accounts.usage"
  | "cache.state"
  | "cache.setTtlMode"
  | "ratecards.get"
  | "ratecards.set"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "quota.snapshot": (input, context) => modules.telemetry.quotaSnapshot(input, context),
    "ledger.session": (input, context) => modules.telemetry.ledgerSession(input, context),
    "accounts.usage": (input, context) => modules.telemetry.usage(input, context),
    "cache.state": (input, context) => modules.telemetry.cacheState(input, context),
    "cache.setTtlMode": (input, context) => modules.telemetry.cacheSetTtlMode(input, context),
    "ratecards.get": (input, context) => modules.telemetry.ratecardsGet(input, context),
    "ratecards.set": (input, context) => modules.telemetry.ratecardsSet(input, context),
  }
}

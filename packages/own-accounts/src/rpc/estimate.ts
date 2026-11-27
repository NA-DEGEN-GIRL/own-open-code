export * as EstimateRpc from "./estimate.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: SWITCHING. `estimate.request` (09 §5.6): the 02 §6 estimator's price of requests on a slot no session runs on
 * yet, with the slot's Z, one exchange, its window and the account's remaining quota, for own.import's `migrate.plan`
 * (over loopback). It reads only and arrives at the control Location.
 */
export type Methods = "estimate.request"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "estimate.request": (input, context) => modules.switching.estimateRequest(input, context),
  }
}

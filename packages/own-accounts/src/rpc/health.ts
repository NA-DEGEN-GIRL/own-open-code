export * as HealthRpc from "./health.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: HEALTH agent. */
export type Methods = "health" | "diagnostics.selfTest"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    health: (input, context) => modules.health.health(input, context),
    "diagnostics.selfTest": (input, context) => modules.health.selfTest(input, context),
  }
}

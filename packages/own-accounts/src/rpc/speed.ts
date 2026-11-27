export * as SpeedRpc from "./speed.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: SPEED. A root session's speed (02 §4.8, `session.speed.*`): the view and the change with its speed-only
 * estimate, answered by the speed module. Session methods, at the session's Location. `speed.offers` (2026-10-10) is
 * the same offers for a main before any session runs on it, at the control location.
 */
export type Methods = "session.speed.get" | "session.speed.set" | "speed.offers"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "session.speed.get": (input, context) => modules.speed.get(input, context),
    "session.speed.set": (input, context) => modules.speed.set(input, context),
    "speed.offers": (input, context) => modules.speed.offers(input, context),
  }
}

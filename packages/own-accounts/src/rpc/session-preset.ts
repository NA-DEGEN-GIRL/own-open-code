export * as SessionPresetRpc from "./session-preset.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: PRESETS. A root session's preset (07 §5.1–§5.4, §2.9; 07 §8.1 `session.preset.*`, `session.ultra.set`):
 * binding and guidance, ultra, the per-message raise and paid-use consent, all answered by the presets module.
 * Session methods, at the session's Location.
 */
export type Methods =
  | "session.preset.get"
  | "session.preset.apply"
  | "session.ultra.set"
  | "session.preset.raiseOnce"
  | "session.preset.consent"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "session.preset.get": (input, context) => modules.presets.sessionGet(input, context),
    "session.preset.apply": (input, context) => modules.presets.sessionApply(input, context),
    "session.ultra.set": (input, context) => modules.presets.ultraSet(input, context),
    "session.preset.raiseOnce": (input, context) => modules.presets.raiseOnce(input, context),
    "session.preset.consent": (input, context) => modules.presets.consent(input, context),
  }
}

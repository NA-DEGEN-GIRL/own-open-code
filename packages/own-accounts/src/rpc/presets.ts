export * as PresetsRpc from "./presets.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: PRESETS. The provider groups' presets, ★, lighter pairs, new-session default models and global preset
 * settings (07 §2.2, §3.4, §4.2, §8.1), all answered by the presets module; `presets.list` carries the repair notices
 * and `presets.set{repairOf}` records a fix in the group's history (07 §4.3, §7.2).
 */
export type Methods = "presets.list" | "presets.suggest" | "presets.set" | "presets.remove" | "presets.defaults.set"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "presets.list": (input, context) => modules.presets.list(input, context),
    "presets.suggest": (input, context) => modules.presets.suggest(input, context),
    "presets.set": (input, context) => modules.presets.set(input, context),
    "presets.remove": (input, context) => modules.presets.remove(input, context),
    "presets.defaults.set": (input, context) => modules.presets.defaultsSet(input, context),
  }
}

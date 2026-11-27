export * as AccountsRpc from "./accounts.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: SLOTS agent. Account views and registry changes; secret parts go through `modules.logins`. */
export type Methods = "accounts.list" | "accounts.update" | "accounts.remove.plan" | "accounts.remove.execute"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "accounts.list": (input, context) => modules.slots.list(input, context),
    "accounts.update": (input, context) => modules.slots.update(input, context),
    "accounts.remove.plan": (input, context) => modules.slots.removePlan(input, context),
    "accounts.remove.execute": (input, context) => modules.slots.removeExecute(input, context),
  }
}

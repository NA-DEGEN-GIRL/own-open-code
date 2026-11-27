export * as SideRpc from "./side.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: SIDE (곁질문, 02 §9.7). Session methods, answered where the conversation runs (an SSH host's own service). */
export type Methods = "side.ask" | "side.get" | "side.list" | "side.cancel" | "side.remove"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "side.ask": (input, context) => modules.side.ask(input, context),
    "side.get": (input, context) => modules.side.get(input, context),
    "side.list": (input, context) => modules.side.list(input, context),
    "side.cancel": (input, context) => modules.side.cancel(input, context),
    "side.remove": (input, context) => modules.side.remove(input, context),
  }
}
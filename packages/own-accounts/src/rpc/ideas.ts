export * as IdeasRpc from "./ideas.js"

import { Ideas } from "@own/protocol"
import type { Deps } from "../deps.js"
import { IdeaStore } from "../ideas/store.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: IDEAS (02 §9.2 "아이디어 노트"). The global sticky notes in the own-accounts KV, for every client of this PC:
 * the desktop app, a phone through the gateway (`read` lists, `prompt` writes) and another PC's window. Global methods:
 * they arrive at the control Location, whose instance leads and sends `ideas.changed`. Stateless like the workspace
 * notes, so it needs no module. A remote service refuses them (`REMOTE_MANAGED`).
 */
export type Methods = "ideas.list" | "ideas.put" | "ideas.remove"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  return {
    "ideas.list": (_input, context) =>
      IdeaStore.list(deps).then(
        (ideas) => ({ ideas }),
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
    "ideas.put": (input, context) =>
      IdeaStore.put(deps, input).then(
        (result) => {
          if (result.type === "conflict")
            return context.error("idea_conflict", "the idea changed elsewhere", { current: result.current })
          if (result.type === "limit")
            return context.error("ideas_limit", `this PC keeps up to ${Ideas.MAX} ideas`, { max: Ideas.MAX })
          void deps.emitter.global("ideas.changed", { id: input.id, rev: result.idea.rev })
          return result.idea
        },
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
    "ideas.remove": (input, context) =>
      IdeaStore.remove(deps, input).then(
        (result) => {
          if (result.type === "conflict")
            return context.error("idea_conflict", "the idea changed elsewhere", { current: result.current })
          if (result.type === "missing") return { removed: false }
          void deps.emitter.global("ideas.changed", { id: input.id, rev: null })
          return { removed: true }
        },
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

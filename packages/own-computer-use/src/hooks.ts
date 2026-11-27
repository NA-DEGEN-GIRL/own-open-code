export * as Hooks from "./hooks.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { PositiveInt } from "@opencode/schema/schema"
import { Effect, Option, Schema } from "effect"
import { Budget } from "./core/budget.js"

/**
 * Screenshot pruning in the `context` (every model request) and `compaction` hooks. The (keep, batch) a session first
 * pruned with is stored in plugin storage and used for the rest of that session, so a later option change never
 * reshuffles an existing session's prefix (01 R8). A request without any of our screenshots costs one pass over its
 * messages and no storage access. Runs before core's 25 MiB request image budget, which our images alone never reach:
 * each is capped so the most a request carries after pruning fits `Budget.REQUEST_BYTES` (`Budget.imageLimit`).
 */
export const register = (ctx: Pick<Context, "session" | "storage">, history: Budget.History) =>
  Effect.gen(function* () {
    const known = new Map<string, Budget.History>()
    const paramsOf = (sessionID: string) =>
      Effect.gen(function* () {
        const cached = known.get(sessionID)
        if (cached !== undefined) return cached
        const stored = decodeHistory(yield* ctx.storage.get(key(sessionID)))
        const value = Option.getOrElse(stored, () => history)
        if (Option.isNone(stored)) yield* ctx.storage.set(key(sessionID), { keep: value.keep, batch: value.batch })
        known.set(sessionID, value)
        return value
      })
    const prune = (input: Pick<SessionContext, "sessionID" | "messages">) =>
      Effect.gen(function* () {
        if (Budget.count(input.messages) === 0) return
        Budget.pruneScreenshots(input.messages, yield* paramsOf(input.sessionID))
      })
    yield* ctx.session.hook("context", prune)
    yield* ctx.session.hook("compaction", prune)
    return {
      /** Drops the stored parameters of a deleted session. */
      forget: (sessionID: string) =>
        Effect.suspend(() => {
          known.delete(sessionID)
          return ctx.storage.remove(key(sessionID))
        }),
    }
  })

export function key(sessionID: string) {
  return `history/${sessionID}`
}

const decodeHistory = Schema.decodeUnknownOption(Schema.Struct({ keep: PositiveInt, batch: PositiveInt }))

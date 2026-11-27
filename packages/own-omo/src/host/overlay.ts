export * as Overlays from "./overlay.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"

/**
 * What omo asked for on its last prompt to a session that OpenCode 2 has no per-prompt field for (15 §3.4): extra
 * system text (`body.system`, the skill content of a delegated task) and tools switched on or off (`body.tools`, by
 * OpenCode 1 name). The request hooks apply them to every request of the session (hooks.ts), and V1View shows the tools
 * on the session's user messages as OpenCode 1 recorded them. Kept in the plugin's storage, so a restart keeps them.
 */
export const Overlay = Schema.Struct({
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})
export type Overlay = typeof Overlay.Type

const decode = Schema.decodeUnknownOption(Overlay)
const key = (sessionID: string) => `omo/overlay/${sessionID}`

export class Store {
  private readonly cache = new Map<string, Overlay>()

  constructor(private readonly ctx: Pick<Context, "storage">) {}

  get(sessionID: string): Effect.Effect<Overlay> {
    const cached = this.cache.get(sessionID)
    if (cached !== undefined) return Effect.succeed(cached)
    return this.ctx.storage.get(key(sessionID)).pipe(
      Effect.map((value) => Option.getOrElse(decode(value), () => ({}))),
      Effect.tap((value) => Effect.sync(() => this.cache.set(sessionID, value))),
    )
  }

  /** Replaces the fields `patch` names; an undefined field keeps the stored one. */
  set(sessionID: string, patch: Overlay): Effect.Effect<void> {
    return this.get(sessionID).pipe(
      Effect.flatMap((current) => {
        const system = patch.system ?? current.system
        const tools = patch.tools ?? current.tools
        const next: Overlay = {
          ...(system === undefined ? {} : { system }),
          ...(tools === undefined ? {} : { tools: { ...tools } }),
        }
        if (JSON.stringify(next) === JSON.stringify(current)) return Effect.void
        this.cache.set(sessionID, next)
        return this.ctx.storage.set(key(sessionID), next)
      }),
    )
  }

  forget(sessionID: string) {
    this.cache.delete(sessionID)
    return this.ctx.storage.remove(key(sessionID))
  }
}

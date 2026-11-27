export * as ToolHook from "./tool.js"

import type { SessionID } from "@opencode/schema/session-id"
import { Guard } from "../assets/guard.js"
import type { Services } from "../services.js"

/** The fields of core's tool hook events own.team reads (`execute.before` / `execute.after`). */
export interface Call {
  readonly tool: string
  readonly sessionID: SessionID
  /** The tool call's id: `execute.after` of a shell call finds the HEAD its `execute.before` read (06 §4.8). */
  readonly id: string
  readonly input: unknown
}

/**
 * The longest a tool call waits for these hooks. Core waits for every hook without a limit; past this the call goes on
 * and the cone work finishes on its own (it is serialized per folder, so nothing races).
 */
export const LIMIT_MS = 30_000

/**
 * The tool hooks (06 §4.8–4.9): `execute.before` adds the narrowest parent of a non-heavy folder outside the cone
 * before a write (never throws to refuse: a rejected promise hook becomes a defect the model never sees) and reads the
 * area's HEAD before a shell call; `execute.after` of shell and write tools brings a heavy folder that appeared on disk
 * into the cone without deleting anything, and after a shell call that moved HEAD the cone follows it (`Drift.check`).
 * Both hold the call at most {@link LIMIT_MS}, and the guards skip their cone changes until this controller holds the
 * controller lock (`Services.Base.started`), whose registry writes would wait for it.
 */
export function create(services: Services.Context) {
  return {
    before: (call: Call) => bounded(services, "execute.before", Guard.before(services, call)),
    after: (call: Call & { readonly status: "completed" | "error" }) =>
      bounded(services, "execute.after", Guard.after(services, call)),
  }
}

/**
 * `work`, or nothing once {@link LIMIT_MS} passed on the services' clock (tests drive it); a failure after that is
 * still logged.
 */
function bounded(services: Services.Context, hook: string, work: Promise<void>) {
  const logged = work.catch((error: unknown) => services.log.warn("hook_failed", { hook, error }))
  const limit = Promise.withResolvers<void>()
  const cancel = services.clock.schedule(LIMIT_MS, () => {
    services.log.warn("hook_slow", { hook, limitMs: LIMIT_MS })
    limit.resolve()
  })
  return Promise.race([logged, limit.promise]).finally(cancel)
}

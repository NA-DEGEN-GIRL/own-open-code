export * as Fragments from "./fragments.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Creator } from "@own/protocol/creator"
import { Effect, Stream } from "effect"
import { Match } from "./match.js"
import type { CreatorState } from "./state.js"

/**
 * Prompt fragments (17 §5.1) are session instruction entries `own.creator.ext.<id>`, one per extension, never a system
 * prompt edit: before a session's first step core puts them in the epoch baseline, and a later change becomes one
 * durable System message after the conversation at the next step boundary, so the cached prefix stays. The entries are
 * brought in line with the extensions in force at every prompt (the `prompt` hook, before core admits it), when the
 * session's model, agent or harness changes, and when an extension changes. An unchanged value is never written again.
 * Creator mode's own guidance is the entry `own.creator.mode` in creator sessions.
 */

/** Every entry own.creator writes starts with this; an extension's is `own.creator.ext.<id>`. */
export const PREFIX = "own.creator."
export const EXTENSION_PREFIX = `${PREFIX}ext.`
export const MODE_KEY = `${PREFIX}mode`

type Ctx = Pick<Context, "session" | "location" | "event">

export const register = (ctx: Ctx, state: CreatorState.State, mode: string) =>
  Effect.gen(function* () {
    yield* ctx.session.hook("prompt", (event) => reconcile(ctx, state, event.sessionID, mode))
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (
          (event.type === "session.model.selected" ||
            event.type === "session.agent.selected" ||
            event.type === "session.metadata.updated") &&
          state.known.has(event.data.sessionID)
        )
          return reconcile(ctx, state, event.data.sessionID, mode)
        return Effect.void
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  })

/** Every known session again, after an extension changed. */
export const refresh = (ctx: Ctx, state: CreatorState.State, mode: string) =>
  Effect.forEach([...state.known], (sessionID) => reconcile(ctx, state, sessionID as Session.ID, mode), {
    discard: true,
    concurrency: 4,
  })

/** Puts the entries the session should carry and removes the ones it should not. Never fails the prompt. */
export const reconcile = (ctx: Ctx, state: CreatorState.State, sessionID: Session.ID, mode: string) =>
  Effect.gen(function* () {
    const facts = yield* Match.facts(ctx, sessionID)
    // Events reach every Location's instance; a session's entries are its own Location's to decide.
    if (facts === undefined || facts.directory !== ctx.location.directory) return
    state.remember(sessionID)
    const wanted = desired(state.list, facts, mode)
    const existing = (yield* ctx.session.instructions.entry.list({ sessionID })).filter((entry) =>
      entry.key.startsWith(PREFIX),
    )
    const current = new Map(existing.map((entry) => [entry.key, entry.value]))
    yield* Effect.forEach(
      [...wanted].filter(([key, value]) => current.get(key) !== value),
      ([key, value]) => ctx.session.instructions.entry.put({ sessionID, key, value }),
      { discard: true },
    )
    yield* Effect.forEach(
      existing.filter((entry) => !wanted.has(entry.key)),
      (entry) => ctx.session.instructions.entry.remove({ sessionID, key: entry.key }),
      { discard: true },
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        process.stderr.write(
          `${JSON.stringify({ level: "warn", scope: "own.creator", msg: "fragments_failed", cause: String(cause) })}\n`,
        ),
      ),
    ),
  )

/**
 * The entries `facts` calls for: each extension's matching fragments joined in item order, in store order, while the
 * session's total stays within {@link Creator.LIMITS.sessionFragments}; an extension that would pass it is left out.
 */
export function desired(list: ReadonlyArray<Match.Applicable>, facts: Match.Facts, mode: string) {
  const entries = new Map<string, string>()
  if (facts.agent === "creator") entries.set(MODE_KEY, mode)
  list.reduce((used, applicable) => {
    const text = applicable.extension.items
      .flatMap((item) => (item.type === "prompt.fragment" && Match.when(item.when, facts) ? [item.text] : []))
      .join("\n\n")
    if (text === "" || used + text.length > Creator.LIMITS.sessionFragments) return used
    entries.set(`${EXTENSION_PREFIX}${applicable.loaded.entry.id}`, text)
    return used + text.length
  }, 0)
  return entries
}

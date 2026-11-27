export * as Resets from "./resets.js"

import type { Plugin } from "@opencode/plugin"
import type { Module } from "./module.js"

/** A message as `ctx.session.context` returns it. */
type SessionMessageInfo = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

/** Inbox items whose kind one tracker remembers between admission and delivery (oldest forgotten first). */
export const MAX_ITEMS = 1_000

/** A context reset applied (`reset`) or undone (`undo`). */
export interface ColdPoint {
  readonly kind: "reset" | "undo"
  readonly sessionID: string
  /** The reset's inbox id, which its marker message keeps. */
  readonly resetID: string
}

/**
 * Whether the item a `session.inbox.delivered` names was a context reset, asked only for an item whose admission this
 * process did not see (admitted before a restart). Core projects a delivered reset as the marker the session's context
 * starts with, under the item's id.
 */
export type Lookup = (sessionID: string, inboxID: string) => Promise<boolean>

/** {@link Lookup} over the session's context (`ctx.session.context`); a read that fails counts as no reset. */
export function contextLookup(read: (sessionID: string) => Promise<ReadonlyArray<SessionMessageInfo>>): Lookup {
  return (sessionID, inboxID) =>
    read(sessionID).then(
      (messages) => {
        const first = messages[0]
        return (
          first?.id === inboxID &&
          first.type === "compaction" &&
          first.status === "completed" &&
          first.reason === "reset"
        )
      },
      () => false,
    )
}

/**
 * Context resets in the event stream (core P-035, 11 §7). A reset is admitted as a `reset` inbox item and applied by
 * that item's `session.inbox.delivered`, which names only its id; `session.reset.undone` undoes one. Both are cold
 * points: the request's message part changes from its first message, and the last measured size no longer holds
 * (02 §4.7.4). The event dispatcher keeps one tracker and hands each event's cold point to the modules
 * (`EventMeta.reset`); a delivery it did not see admitted is looked up ({@link Lookup}), so a restart between the two
 * still counts.
 */
export class Tracker {
  /** Inbox id → whether it is a reset, from its admission until its delivery or cancellation. */
  readonly #items = new Map<string, boolean>()
  readonly #lookup: Lookup | undefined

  constructor(lookup?: Lookup) {
    this.#lookup = lookup
  }

  async observe(event: Module.OpenCodeEvent): Promise<ColdPoint | undefined> {
    if (event.type === "session.inbox.enqueued") {
      this.#items.set(event.data.inboxID, event.data.item.type === "reset")
      const oldest = this.#items.keys().next().value
      if (this.#items.size > MAX_ITEMS && oldest !== undefined) this.#items.delete(oldest)
      return undefined
    }
    if (event.type === "session.inbox.cancelled") {
      this.#items.delete(event.data.inboxID)
      return undefined
    }
    if (event.type === "session.inbox.delivered") {
      const inboxID = event.data.inboxID
      const known = this.#items.get(inboxID)
      this.#items.delete(inboxID)
      const reset = known ?? (await this.#lookup?.(event.data.sessionID, inboxID)) ?? false
      return reset ? { kind: "reset", sessionID: event.data.sessionID, resetID: inboxID } : undefined
    }
    if (event.type === "session.reset.undone")
      return { kind: "undo", sessionID: event.data.sessionID, resetID: event.data.messageID }
    return undefined
  }
}

/**
 * The size an undo brings back, from the session's history (03 §18.18 "되돌리기", like own-web's `undoCost`): the
 * newest measured request before the reset's marker plus what the conversation after it added (its newest measured
 * size minus its first request's). `undefined` when nothing before the marker was measured.
 */
export function restoredSize(messages: ReadonlyArray<SessionMessageInfo>, resetID: string) {
  const index = messages.findIndex((message) => message.id === resetID)
  if (index < 0) return undefined
  const before = measured(messages.slice(0, index).findLast(isMeasured))
  if (before === undefined) return undefined
  const after = messages.slice(index + 1).filter(isMeasured)
  const first = measured(after[0])
  const newest = measured(after.at(-1))
  return before.total + (first === undefined || newest === undefined ? 0 : Math.max(0, newest.total - first.prompt))
}

type Measured = Extract<SessionMessageInfo, { type: "assistant" }> & {
  readonly tokens: NonNullable<Extract<SessionMessageInfo, { type: "assistant" }>["tokens"]>
}

function isMeasured(message: SessionMessageInfo): message is Measured {
  return (
    message.type === "assistant" &&
    message.tokens !== undefined &&
    message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0
  )
}

function measured(message: Measured | undefined) {
  if (message === undefined) return undefined
  const tokens = message.tokens
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  return { prompt, total: prompt + tokens.output + tokens.reasoning }
}

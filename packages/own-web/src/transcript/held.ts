// What each open transcript holds of its session (history.ts: its own older pages and the store's newest messages),
// for UI outside the transcript that reads a message the store may have let go: the revert dialog and bar (03 §18.7).
// A lazy module: the transcript, the dialog and the bar load it, the first chunk does not.
import type { SessionMessageInfo } from "@opencode/client/promise"
import type { Accessor } from "solid-js"

export interface HeldMessages {
  /** Oldest first. */
  readonly messages: Accessor<readonly SessionMessageInfo[]>
  /** Messages the view does not hold lie between this one and the newest (it shows pages far up). */
  readonly gapAfter: (messageID: string) => boolean
}

const views = new Map<string, Set<HeldMessages>>()

/** Registers a view's messages until the returned function runs. */
export function holdMessages(serverKey: string, sessionID: string, held: HeldMessages) {
  const key = `${serverKey}/${sessionID}`
  const set = views.get(key) ?? new Set()
  views.set(key, set.add(held))
  return () => {
    set.delete(held)
    if (set.size === 0) views.delete(key)
  }
}

/** A view that holds the message (any view of the session without one); undefined when no view of it is open. */
export function heldMessages(serverKey: string, sessionID: string, messageID: string) {
  const set = [...(views.get(`${serverKey}/${sessionID}`) ?? [])]
  return set.find((held) => held.messages().some((message) => message.id === messageID)) ?? set[0]
}

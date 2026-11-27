// A conversation's first message read (03 §16.4) that keeps what the event stream added while it was in flight.
import { createComputed, createRoot } from "solid-js"
import type { TranscriptRuntime } from "./context"

/** Reads after the first one; each is one request, and a turn rarely starts a step inside two read windows. */
const REREADS = 3

/**
 * Reads the session's newest messages again until a read keeps every message the event stream added while it was in
 * flight. createData's read replaces the session's list with the server's snapshot (keeping only prompts not yet
 * delivered), so a message that an event added after the server took the snapshot is dropped when the answer lands,
 * and createData then drops that message's later events as never loaded. The transcript chunk loads lazily, so a
 * conversation opened just before a prompt reads a moment after it: the step that started meanwhile vanished with its
 * search card while the next step's answer showed (websearch e2e, 2026-10-24). A message the store already held when
 * the read started was durable by then, so the snapshot holds it unless it is older than the newest page: such older
 * pages are dropped on purpose and ask no second read (by membership, not by time: messages of one turn, imported or
 * forked ones may share a millisecond).
 */
export async function readMessages(data: TranscriptRuntime["data"], sessionID: string) {
  for (let read = 0; ; read++) {
    const held = new Set(data.session.message.list(sessionID).map((message) => message.id))
    const added = new Set<string>()
    const stop = createRoot((dispose) => {
      createComputed(() =>
        data.session.message.list(sessionID).forEach((message) => {
          if (!held.has(message.id)) added.add(message.id)
        }),
      )
      return dispose
    })
    await data.session.message.sync(sessionID).finally(stop)
    const lost = [...added].some((id) => data.session.message.get(sessionID, id) === undefined)
    if (!lost || read === REREADS) return
    data.session.message.invalidate(sessionID)
  }
}

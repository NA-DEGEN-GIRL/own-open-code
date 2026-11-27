// `이전 대화 접기` (03 §4.5): per viewer, in memory, whether the turns before a session's active reset are folded into
// the marker line. The transcript leaves the folded messages out; opening the session's find bar unfolds them.
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createSignal } from "solid-js"
import { boundaryIndex, isReset } from "./model"

const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set())

const key = (serverKey: string, sessionID: string, resetID: string) => `${serverKey}/${sessionID}/${resetID}`

export function isFolded(serverKey: string, sessionID: string, resetID: string) {
  return folded().has(key(serverKey, sessionID, resetID))
}

export function setFold(serverKey: string, sessionID: string, resetID: string, fold: boolean) {
  const id = key(serverKey, sessionID, resetID)
  setFolded((current) => {
    if (current.has(id) === fold) return current
    const next = new Set(current)
    if (fold) next.add(id)
    else next.delete(id)
    return next
  })
}

/** Unfolds every reset of the session (its find bar opened). */
export function unfoldSession(serverKey: string, sessionID: string) {
  const prefix = `${serverKey}/${sessionID}/`
  setFolded((current) =>
    [...current].some((id) => id.startsWith(prefix))
      ? new Set([...current].filter((id) => !id.startsWith(prefix)))
      : current,
  )
}

/** `messages` without what comes before the active reset when the viewer folded it; else `messages` itself. */
export function foldedView(serverKey: string, sessionID: string, messages: readonly SessionMessageInfo[]) {
  const index = boundaryIndex(messages)
  const reset = messages[index]
  if (!isReset(reset) || !isFolded(serverKey, sessionID, reset.id)) return messages
  return messages.slice(index)
}

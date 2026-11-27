// Local read state for the `•` symbol (03 §7.6 "로컬 읽음 상태", 9 "턴 완료 → •"). Two sources:
// - a turn that finished while the session was not in front marks it unread (event path, live),
// - a session whose server `updated` time moved past the last time it was seen (reload path: a turn finished while
//   this window was closed). Sessions never seen here are not unread, so a fresh install starts clean.
// Kept per server in localStorage, bounded, written when idle and when the page is left. [gap] 37 (`session.view`)
// can replace it later.
import { createStore, produce } from "solid-js/store"

const SEEN_LIMIT = 500
const SAVE_DELAY = 1_000
/** Server `updated` and the local clock differ slightly; changes within this window count as seen. */
const SLACK_MS = 2_000

export interface ReadStateData {
  unread: Record<string, true>
  seen: Record<string, number>
}

export function createReadState(input: { readonly storageKey: string; readonly now?: () => number }) {
  const now = input.now ?? Date.now
  const [state, setState] = createStore<ReadStateData>(load(input.storageKey))
  let timer: ReturnType<typeof setTimeout> | undefined

  // A pending write is one whose timer is set; the timer is cleared once it is written.
  const flush = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    write(input.storageKey, trimmed(state))
  }
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle(flush), SAVE_DELAY)
  }
  // A reload or a closed window inside the delay lost the last change: a conversation opened just before it came
  // back unread. Leaving the page writes what is pending.
  window.addEventListener("pagehide", flush)

  return {
    state,
    /** A turn finished while the user was elsewhere. */
    markUnread(sessionID: string) {
      if (state.unread[sessionID]) return
      setState("unread", sessionID, true)
      save()
    },
    /** The session is in front (opened, or visible while a turn finishes). */
    markSeen(sessionID: string, at = now()) {
      if (!state.unread[sessionID] && (state.seen[sessionID] ?? 0) >= at) return
      setState(
        produce((draft) => {
          delete draft.unread[sessionID]
          draft.seen[sessionID] = Math.max(draft.seen[sessionID] ?? 0, at)
        }),
      )
      save()
    },
    isUnread(sessionID: string, updated?: number) {
      if (state.unread[sessionID]) return true
      const seen = state.seen[sessionID]
      return seen !== undefined && updated !== undefined && updated > seen + SLACK_MS
    },
    forget(sessionID: string) {
      if (!state.unread[sessionID] && state.seen[sessionID] === undefined) return
      setState(
        produce((draft) => {
          delete draft.unread[sessionID]
          delete draft.seen[sessionID]
        }),
      )
      save()
    },
    dispose() {
      clearTimeout(timer)
      window.removeEventListener("pagehide", flush)
    },
  }
}

export type ReadState = ReturnType<typeof createReadState>

function trimmed(state: ReadStateData): ReadStateData {
  const seen = Object.entries(state.seen)
  const kept = seen.length > SEEN_LIMIT ? seen.toSorted((a, b) => b[1] - a[1]).slice(0, SEEN_LIMIT) : seen
  return { unread: { ...state.unread }, seen: Object.fromEntries(kept) }
}

function load(key: string): ReadStateData {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (typeof value !== "object" || value === null) return { unread: {}, seen: {} }
    const data: ReadStateData = { unread: {}, seen: {} }
    const unread = "unread" in value && typeof value.unread === "object" && value.unread !== null ? value.unread : {}
    const seen = "seen" in value && typeof value.seen === "object" && value.seen !== null ? value.seen : {}
    for (const [id, flag] of Object.entries(unread)) if (flag === true) data.unread[id] = true
    for (const [id, at] of Object.entries(seen)) if (typeof at === "number") data.seen[id] = at
    return data
  } catch {
    return { unread: {}, seen: {} }
  }
}

function write(key: string, value: ReadStateData) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function idle(fn: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2_000 })
  else setTimeout(fn, 0)
}

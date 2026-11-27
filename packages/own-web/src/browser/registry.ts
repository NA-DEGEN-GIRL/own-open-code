// Window-level registry of the browser activity trackers (activity.ts). Kept tiny and dependency-free because the work
// panel's tab head (first chunk) reads it for the `●` badge (03 §4.7), while the trackers themselves are created by
// attach.tsx, the desktop-only chunk, one per server whose sessions this window attaches.
import { createSignal, type Accessor } from "solid-js"

export type ActivityPhase = "operating" | "recent" | "takeover" | "idle"

export interface BrowserActivityTracker {
  phase(sessionID: string): ActivityPhase
  /** The agent's last browser call in the session, for the header ("클릭 · e12"). */
  last(sessionID: string): { readonly action: string; readonly detail?: string; readonly tabID?: string } | undefined
  /** The tab the agent's last call targeted, if any. */
  agentTab(sessionID: string): string | undefined
  /** The user took over (after interrupting the turn); cleared by the agent's next browser call. */
  takeover(sessionID: string, tabID?: string): void
  /** Dismisses the takeover notice. */
  release(sessionID: string): void
  /** A user command on a tab while the agent is active marks the tab as the user's (03 §18.17). */
  userCommand(sessionID: string, tabID: string | undefined): void
  touched(sessionID: string, tabID: string): boolean
  dispose(): void
}

const [trackers, setTrackers] = createSignal<ReadonlyMap<string, BrowserActivityTracker>>(new Map())

/** Trackers by server key; empty on hosts without the browser pane. */
export const windowActivity: Accessor<ReadonlyMap<string, BrowserActivityTracker>> = trackers

export function setWindowActivity(serverKey: string, tracker: BrowserActivityTracker | undefined) {
  const map = new Map(trackers())
  if (tracker) map.set(serverKey, tracker)
  else map.delete(serverKey)
  setTrackers(map)
}

/** The session's phase in this window ("idle" without a tracker). */
export function browserPhase(serverKey: string, sessionID: string | undefined): ActivityPhase {
  if (!sessionID) return "idle"
  return trackers().get(serverKey)?.phase(sessionID) ?? "idle"
}

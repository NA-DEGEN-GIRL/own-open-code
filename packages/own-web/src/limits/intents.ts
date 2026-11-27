// Requests to surfaces other modules own. The switcher (5.2), the session info drawer (5.6) and new-session creation
// live outside accounts/limits, and the skeleton has no shared command bus yet, so these go out as window events that
// the owners listen for (proposed contract; see the accounts/limits report). Nothing secret is ever put in `detail`.
import type { ServerKey } from "@/data"

export interface SwitcherIntent {
  readonly serverKey: ServerKey
  readonly sessionID: string
  /** Preselect this account (4.7.1 `이 세션을 여기로 전환`, 6.6 `다른 계정으로 전환…`). */
  readonly accountID?: string
}

export interface NewSessionIntent {
  readonly accountID: string
  readonly providerID: string
}

export const INTENT = {
  /** `detail: SwitcherIntent`. */
  switcher: "own:open-switcher",
  /** `detail: { serverKey, sessionID }`. */
  sessionInfo: "own:open-session-info",
  /** `detail: NewSessionIntent` (5.4 step 3 `이 계정으로 새 세션`). */
  newSession: "own:new-session",
} as const

export function openSwitcher(detail: SwitcherIntent) {
  window.dispatchEvent(new CustomEvent(INTENT.switcher, { detail }))
}

export function openSessionInfo(detail: { readonly serverKey: ServerKey; readonly sessionID: string }) {
  window.dispatchEvent(new CustomEvent(INTENT.sessionInfo, { detail }))
}

export function requestNewSession(detail: NewSessionIntent) {
  window.dispatchEvent(new CustomEvent(INTENT.newSession, { detail }))
}

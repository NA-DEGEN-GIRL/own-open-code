// What the device viewer shows and lets through (05 §8.10), as pure rules:
//  - `screenOf`: the frame, or which sentence stands in its place. Everything that needs no socket (no session, no
//    `browser` scope on this device, a session without the browser tools) is decided first: a refusal before the
//    WebSocket upgrade is invisible to the page, so the view never opens a socket it knows the gateway refuses. A
//    conversation of an SSH host is viewed like one of this PC (05 §8.10.8): the PC's desktop pane holds both.
//  - `gateOf`: whether input and navigation go to the PC. A device without `prompt` watches; while the agent operates
//    the page (activity.ts `operating`) nothing is sent, one step stricter than the desktop pane, because on a phone
//    the picture is the input surface and a finger that lands on it must not shake the agent's work.
//  - `viewportOf`: the view area the gateway accepts (RemoteBrowser limits).
import { RemoteBrowser } from "@own/protocol/remote-browser"
import type { ActivityPhase } from "../registry"

/** The socket as the view needs to know it (connection.ts). */
export type Link = "idle" | "connecting" | "open" | "retrying" | "busy"

export type Screen =
  /** The new-conversation screen: a browser belongs to a conversation. */
  | "none"
  /** This device was not given `브라우저` on the PC. */
  | "permission"
  /** The session started without the browser tools: the PC never attaches its pane. */
  | "removed"
  /** Too many viewers (close code 1013). */
  | "busy"
  | "connecting"
  | "absent"
  | "attaching"
  | "detached"
  /** The pane is there and has no tab. */
  | "empty"
  | "frame"

export function screenOf(input: {
  readonly sessionID: string | undefined
  /** The device's scopes as the gateway holds them (`HostConnection.deviceScopes`). */
  readonly scopes: readonly string[]
  /** `browserRemoved(info.permissions)`; false until the session's rules are known. */
  readonly removed: boolean
  readonly link: Link
  readonly state: RemoteBrowser.ViewState | undefined
}): Screen {
  if (!input.sessionID) return "none"
  if (!input.scopes.includes(RemoteBrowser.SCOPE)) return "permission"
  if (input.removed) return "removed"
  if (input.link === "busy") return "busy"
  if (!input.state) return "connecting"
  if (input.state.host !== "ready") return input.state.host
  return input.state.tabs.length ? "frame" : "empty"
}

/** Screens that need the viewer socket; the others are decided without asking the gateway. */
export function connects(screen: Screen) {
  return screen !== "none" && screen !== "permission" && screen !== "removed"
}

/**
 * - `control`: taps, typing, the address row and the tab actions go to the PC;
 * - `watch`: this device may only look (`ready.control` is false);
 * - `agent`: the agent is operating the page: nothing is sent until `멈추고 직접 조작`.
 */
export type Gate = "control" | "watch" | "agent"

export function gateOf(input: { readonly control: boolean; readonly phase: ActivityPhase }): Gate {
  if (!input.control) return "watch"
  return input.phase === "operating" ? "agent" : "control"
}

export function focusedTab(state: RemoteBrowser.PaneState | undefined) {
  if (!state) return undefined
  return state.tabs.find((tab) => tab.id === state.focusedTabID) ?? state.tabs[0]
}

/** The address row's action: on the focused tab, or a new tab when there is none (as the desktop pane's `go`). */
export function goAction(state: RemoteBrowser.PaneState | undefined, url: string): RemoteBrowser.Action {
  return focusedTab(state) ? { type: "navigate", url } : { type: "tabs.open", url }
}

/** A view area inside the contract's limits, or `undefined` while the area is not laid out. */
export function viewportOf(input: {
  readonly width: number
  readonly height: number
  readonly dpr: number
}): RemoteBrowser.Viewport | undefined {
  if (!(input.width > 0) || !(input.height > 0)) return undefined
  const side = (value: number) => Math.round(Math.min(RemoteBrowser.MAX_SIDE, Math.max(RemoteBrowser.MIN_SIDE, value)))
  return {
    width: side(input.width),
    height: side(input.height),
    dpr: Math.min(RemoteBrowser.MAX_DPR, Math.max(0.5, Number.isFinite(input.dpr) ? input.dpr : 1)),
  }
}

/**
 * The area the frame is fitted into and the phone emulation takes. A soft keyboard that takes height away does not
 * make a new viewport: the page would reflow under the finger. So while a text field of the view has the focus on a
 * touch screen (`typing`) and the width stays, the taller area is kept; a new width (a fold, a rotation) or the end
 * of typing follows the area again.
 */
export function stableBox(
  previous: { readonly width: number; readonly height: number } | undefined,
  area: { readonly width: number; readonly height: number },
  typing: boolean,
) {
  if (!typing || !previous || Math.abs(previous.width - area.width) >= 1) return area
  return area.height > previous.height ? area : previous
}

/** Reconnect delays while the view is visible: 1 s, 2 s, 4 s, 8 s, then 15 s. */
export function backoff(attempt: number) {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 10)))
}

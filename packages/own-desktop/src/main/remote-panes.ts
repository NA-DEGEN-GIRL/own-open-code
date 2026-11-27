// The live browser panes of this shell, by pane key: what the bridge that shows a pane on a paired device works with
// (remote-browser.ts, 05 §8.10). The pane override (overrides/browser-pane.ts) adds an attachment here once its server
// confirmed it and takes it out when it closes. Panes of this PC's own service (the sidecar) are named by their session
// id; panes of an SSH host's conversations by `RemoteBrowser.paneKey(hostId, sessionID)` (05 §8.10.8): the hub that
// asks for them is this PC's service either way, and its gateway decides which servers a device may name. Nothing here
// imports Electron, so the bridge and its tests can use a registry of their own.
import type { Browser } from "../../../plugin-browser/src/rpc"
import { RemoteBrowser } from "../../../own-protocol/src/remote-browser"

/** One tab's page, driven through the debugger upstream's page already attached (CDP 1.3). */
export interface RemotePage {
  readonly tabID: string
  /** Settles when the page's own setup is done (its debugger is attached by then). */
  readonly ready: Promise<void>
  send(method: string, params?: object): Promise<unknown>
  /** CDP events of the page's own target (not of its out-of-process frames). Returns the function that stops it. */
  on(listener: (method: string, params: unknown) => void): () => void
  closed(): boolean
  /**
   * Before a screenshot of a page whose screencast says it is not shown: upstream's own compositor kick, and for a
   * tab that never was on screen in a window that is hidden or minimized, a display surface (remote-surface.ts).
   */
  kick(): Promise<void>
  /** The bridge starts streaming the page: its text caret stops blinking (remote-caret.ts) until `rest`. */
  steady(): void
  /** The bridge is done with the page: the caret blinks again, and whatever `kick` borrowed for it goes back. */
  rest(): void
}

export interface RemotePane {
  /** `RemoteBrowser.LOCAL` or the SSH host the session runs on. */
  readonly serverKey: string
  readonly sessionID: string
  state(): Browser.State
  /** The focused tab's page; a restored tab that was never shown is loaded now. Undefined without tabs. */
  page(): RemotePage | undefined
  /**
   * Runs a pane action with the checks the window's own controls get. Rejects with an Error whose message is the
   * address refusal code (`browser.address.*`) or the page's own failure.
   */
  run(action: Browser.Action): Promise<unknown>
  /**
   * Upstream's answer to `dialog get` on the focused tab (`{value: {dialog}}`: the page's open JavaScript dialog or
   * null), read from the page's own record without publishing anything; undefined without a loaded focused tab.
   */
  dialog(): Promise<unknown>
  /** Whether `contents` (an Electron WebContents) is one of this pane's tab pages. */
  owns(contents: object): boolean
}

export type RemotePaneEvent =
  /** The set of sessions with a pane changed. */
  | { readonly type: "sessions" }
  /** The pane published its state: tabs, focus, loading, a dialog opened or closed. `key`: its pane key. */
  | { readonly type: "changed"; readonly key: string }
  | { readonly type: "download"; readonly key: string }

export interface RemotePaneRegistry {
  /** The pane keys. */
  sessions(): string[]
  get(key: string): RemotePane | undefined
  /** Returns the function that stops the listener. */
  on(listener: (event: RemotePaneEvent) => void): () => void
}

const panes = new Map<string, RemotePane>()
const listeners = new Set<(event: RemotePaneEvent) => void>()

function emit(event: RemotePaneEvent) {
  listeners.forEach((listener) => listener(event))
}

export const remotePanes: RemotePaneRegistry = {
  sessions: () => [...panes.keys()],
  get: (key) => panes.get(key),
  on(listener) {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
}

/** Adds a confirmed attachment. The service replaces a session's older attachment, so the newest one wins here too. */
export function addRemotePane(pane: RemotePane) {
  const key = RemoteBrowser.paneKey(pane.serverKey, pane.sessionID)
  panes.set(key, pane)
  emit({ type: "sessions" })
  return {
    changed() {
      if (panes.get(key) === pane) emit({ type: "changed", key })
    },
    remove() {
      if (panes.get(key) !== pane) return
      panes.delete(key)
      emit({ type: "sessions" })
    },
  }
}

/** A pane tab started a download (own-browser.ts): told to the session's viewers, never handed to them. */
export function remotePaneDownload(contents: object) {
  const pane = [...panes.values()].find((item) => item.owns(contents))
  if (pane) emit({ type: "download", key: RemoteBrowser.paneKey(pane.serverKey, pane.sessionID) })
}

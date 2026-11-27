// Browser attachments of one window (05 §8.2): one per (server, session) the window has opened, kept while the window
// lives so the agent's browser work in a session does not stop when the user looks at another one. The registry is
// window-scoped: attach.tsx (mounted by the shell on hosts with a pane) creates it; the lazy panel tab (index.tsx)
// reads it through `windowAttachments()`.
import { createSignal, type Accessor } from "solid-js"
import { createPaneConnection, type PaneConnection, type PaneConnectionState } from "./connection"
import type { BrowserPaneEndpoint, BrowserPanePlatform } from "./types"

export interface SessionAttachment extends Omit<PaneConnection, "state"> {
  readonly serverKey: string
  readonly sessionID: string
  readonly state: Accessor<PaneConnectionState>
}

export interface BrowserAttachments {
  get(serverKey: string, sessionID: string): SessionAttachment | undefined
  /** Every attachment of the window (reactive: tracks creation and disposal). */
  list(): SessionAttachment[]
  /** The session's attachment, created on first use; undefined while the server has no endpoint. */
  ensure(serverKey: string, sessionID: string): SessionAttachment | undefined
  /** 8.2 re-register rule for every attachment of a server (service restarted: new password). */
  reset(serverKey: string): void
  dispose(): void
}

export function createBrowserAttachments(input: {
  readonly platform: BrowserPanePlatform
  readonly endpoint: (serverKey: string) => BrowserPaneEndpoint | undefined
  readonly focus?: (serverKey: string, sessionID: string, tabID: string) => void
  readonly preview?: (serverKey: string, sessionID: string, path: string) => void
}): BrowserAttachments {
  const all = new Map<string, SessionAttachment>()
  const [version, setVersion] = createSignal(0)
  const key = (serverKey: string, sessionID: string) => `${serverKey}\u0000${sessionID}`
  // The host's pane came back after it went away: the attachments it suspended register again.
  const stopAvailable = input.platform.onAvailable?.(() => {
    for (const attachment of all.values()) attachment.refresh()
  })
  return {
    get: (serverKey, sessionID) => all.get(key(serverKey, sessionID)),
    list() {
      version()
      return [...all.values()]
    },
    ensure(serverKey, sessionID) {
      const existing = all.get(key(serverKey, sessionID))
      if (existing) return existing
      if (!input.endpoint(serverKey)) return undefined
      const [state, setState] = createSignal<PaneConnectionState>(
        { browser: null, attached: false, registered: false, suspended: false },
        { equals: false },
      )
      const connection = createPaneConnection({
        platform: input.platform,
        target: () => {
          const endpoint = input.endpoint(serverKey)
          return endpoint ? { serverKey, sessionID, endpoint } : undefined
        },
        change: setState,
        focus: (tabID) => input.focus?.(serverKey, sessionID, tabID),
        preview: (path) => input.preview?.(serverKey, sessionID, path),
      })
      const attachment: SessionAttachment = {
        serverKey,
        sessionID,
        state,
        wake: connection.wake,
        refresh: connection.refresh,
        command: connection.command,
        capture: connection.capture,
        setLayout: connection.setLayout,
        reset: connection.reset,
        unblock: connection.unblock,
        dispose: connection.dispose,
      }
      all.set(key(serverKey, sessionID), attachment)
      setVersion((value) => value + 1)
      return attachment
    },
    reset(serverKey) {
      for (const attachment of all.values()) if (attachment.serverKey === serverKey) attachment.reset()
    },
    dispose() {
      stopAvailable?.()
      for (const attachment of all.values()) attachment.dispose()
      all.clear()
      setVersion((value) => value + 1)
    },
  }
}

const [current, setCurrent] = createSignal<BrowserAttachments>()

/** The window's registry, or undefined on hosts without a pane (or before attach.tsx mounted). */
export const windowAttachments: Accessor<BrowserAttachments | undefined> = current

export function setWindowAttachments(value: BrowserAttachments | undefined) {
  setCurrent(() => value)
}

/** 05 §7.2: a running session of the window holds a browser with tabs, so closing or reloading needs a confirmation. */
export function closeGuardNeeded(
  attachments: Pick<BrowserAttachments, "list">,
  running: (serverKey: string, sessionID: string) => boolean,
) {
  return attachments.list().some((attachment) => {
    const state = attachment.state()
    return state.attached && !!state.browser?.tabs.length && running(attachment.serverKey, attachment.sessionID)
  })
}

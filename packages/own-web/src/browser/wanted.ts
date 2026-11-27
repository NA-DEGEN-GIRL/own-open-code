// Panes a paired device asks for (05 §8.10.4). The desktop window is the only maker of browser attachments (8.2), so
// when a phone opens the browser view of a session no pane of this window shows, or prompts it, the gateway's hub says
// so: the event `browser.pane.wanted{serverKey?, sessionID}`, and the method of the same name for what is wanted now
// (read at start and after every reconnect; the hub repeats the event every 5 s while a session stays wanted and
// unattached). A session of an SSH host names its host (05 §8.10.8); one of this PC's service does not.
// attach.tsx wires this to the window's registry. The decision is here so it can be tested without a window:
//  - a session this window has not loaded (another client just created it) is read first: its rules decide;
//  - only an attachable session is attached (rules known, no browser deny: attach.tsx header, rule 1 and 2). An
//    attachment appends `browser allow` to the session's rules, so a denied one is left alone and nothing is written;
//  - a failed read or RPC attaches nothing and never throws into the window.

/** One wanted pane: its server (`local` or an SSH host's id) and session. */
export interface WantedPane {
  readonly serverKey: string
  readonly sessionID: string
}

export interface WantedPanes {
  /** The event: one session is wanted. */
  want(pane: WantedPane): Promise<void>
  /** Start and every reconnect: the sessions wanted now. */
  refresh(): Promise<void>
}

export function createWantedPanes(input: {
  /** `own.remote` `browser.pane.wanted`: its `sessionIDs` (this PC) and `hosts`. */
  readonly wanted: () => Promise<readonly WantedPane[]>
  /** The window's data store holds the session's info. */
  readonly known: (pane: WantedPane) => boolean
  /** The data layer's session read. */
  readonly load: (pane: WantedPane) => Promise<unknown>
  readonly attachable: (pane: WantedPane) => boolean
  /** Makes the session's attachment when it has none and wakes it; harmless when repeated. */
  readonly attach: (pane: WantedPane) => void
}): WantedPanes {
  const want = async (pane: WantedPane) => {
    if (!input.known(pane)) await input.load(pane).catch(() => undefined)
    if (input.attachable(pane)) input.attach(pane)
  }
  return {
    want,
    async refresh() {
      const panes = await input.wanted().catch((): readonly WantedPane[] => [])
      await Promise.all(panes.map(want))
    },
  }
}

// One session's browser attachment (05 §8.2), written after upstream's behavior (packages/app/src/session/browser/
// connection.ts, since f406d93a66 packages/gui-extensions/src/browser/connection.ts; reference only): register
// lazily, keep the last state for `restore`, and react to main's closing
// reasons — `unsupported` / `replaced` stop retrying until the user asks, `suspended` and `missing` (a session the
// server does not know yet, since v2.2.2) wait for the next use (or,
// when the host's pane itself went away, for `refresh()` once it is back), `registration.closed` retries with backoff
// (1 s … 30 s). `reset()` is the 8.2 re-register rule (local service restarted with a new password, window reload):
// main fixes the Authorization of an attachment at register time.
import {
  PANE_CLOSED,
  type BrowserPaneCommand,
  type BrowserPaneLayout,
  type BrowserPanePlatform,
  type BrowserPaneRegistration,
  type BrowserPaneTarget,
  type BrowserState,
} from "./types"

export interface PaneConnectionState {
  readonly browser: BrowserState | null
  /** A state event arrived for the current registration: main attached (attach v4) and reports tabs. */
  readonly attached: boolean
  readonly registered: boolean
  readonly suspended: boolean
  readonly blocked?: "unsupported" | "replaced"
  readonly error?: string
}

export interface PaneConnection {
  state(): PaneConnectionState
  /** Registers when not registered (no-op while blocked or without a target). */
  wake(): void
  /** The host's pane is back: registers again when the pane going away suspended it (upstream `refresh`). */
  refresh(): void
  command(command: BrowserPaneCommand): Promise<void>
  capture(tabID: string): Promise<Blob | null>
  setLayout(layout?: BrowserPaneLayout): void
  /** 8.2: close and register again with the current target (new credentials, new endpoint). */
  reset(): void
  /** After `replaced`/`unsupported`, the user's explicit "다시 연결". */
  unblock(): void
  dispose(): void
}

type Schedule = (run: () => void, ms: number) => () => void

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

export function createPaneConnection(input: {
  readonly platform: BrowserPanePlatform
  readonly target: () => BrowserPaneTarget | undefined
  readonly change?: (state: PaneConnectionState) => void
  readonly focus?: (tabID: string) => void
  readonly preview?: (path: string) => void
  readonly schedule?: Schedule
}): PaneConnection {
  const schedule = input.schedule ?? defaultSchedule
  let state: PaneConnectionState = { browser: null, attached: false, registered: false, suspended: false }
  let registration: BrowserPaneRegistration | undefined
  let disposed = false
  let blocked = false
  // Suspended because the host's pane went away (`lost` event), not by an idle eviction.
  let lost = false
  let attempts = 0
  let cancelRetry: (() => void) | undefined
  const set = (next: PaneConnectionState) => {
    state = next
    input.change?.(state)
  }
  const drop = () => {
    registration?.close()
    registration = undefined
  }
  const register = () => {
    if (disposed || blocked || registration) return
    const target = input.target()
    if (!target) return
    lost = false
    cancelRetry?.()
    cancelRetry = undefined
    const current = input.platform.register(state.browser ? { ...target, restore: state.browser } : target, (event) => {
      if (disposed || registration !== current) return
      if (event.type === "focus") return input.focus?.(event.tabID)
      if (event.type === "preview") return input.preview?.(event.path)
      // A host event own-web does not know (a newer shell) is not a state; the fallthrough below would clear the tabs.
      if (event.type !== "state") return
      if (event.error === PANE_CLOSED.unsupported || event.error === PANE_CLOSED.replaced) {
        blocked = true
        drop()
        return set({
          browser: null,
          attached: false,
          registered: false,
          suspended: false,
          blocked: event.error === PANE_CLOSED.unsupported ? "unsupported" : "replaced",
        })
      }
      if (
        event.error === PANE_CLOSED.suspended ||
        event.error === PANE_CLOSED.closed ||
        event.error === PANE_CLOSED.missing
      ) {
        drop()
        // A session the server does not know yet (upstream's `missing`) waits for the next use like an idle eviction,
        // keeping the tabs it had and showing no error; retrying could not succeed before the session exists.
        const suspended = event.error !== PANE_CLOSED.closed
        lost = suspended && event.lost === true
        set({
          browser: suspended && event.state ? event.state : state.browser,
          attached: false,
          registered: false,
          suspended,
        })
        // An idle eviction waits for the next use (user or agent); a closed registration retries.
        if (!suspended) cancelRetry = schedule(register, Math.min(30_000, 1_000 * 2 ** attempts++))
        return
      }
      if (event.state) attempts = 0
      set({ browser: event.state, attached: true, registered: true, suspended: false, error: event.error })
    })
    registration = current
    set({ ...state, registered: true, suspended: false, blocked: undefined, error: undefined })
  }
  return {
    state: () => state,
    wake: register,
    refresh() {
      if (lost) register()
    },
    command(command) {
      register()
      return registration?.command(command) ?? Promise.reject(new Error("browser.pane.unavailable"))
    },
    capture: (tabID) => registration?.capture(tabID) ?? Promise.resolve(null),
    setLayout: (layout) => registration?.setLayout(layout),
    reset() {
      if (disposed) return
      drop()
      attempts = 0
      set({ ...state, attached: false, registered: false })
      register()
    },
    unblock() {
      blocked = false
      attempts = 0
      register()
    },
    dispose() {
      disposed = true
      cancelRetry?.()
      drop()
    },
  }
}

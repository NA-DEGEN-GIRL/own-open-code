// Browser pane contract between own-web and a host (03 §18.17, 05 §8). It started as upstream's `BrowserPanePlatform`
// (the pre-f406d93a66 packages/app/src/runtime/platform/browser-pane.ts) written structurally, and stays own-web's
// since that moved into the `browser` GUI extension: the desktop host (src/host/desktop.ts) implements it over that
// extension's `browser.pane` Ipc (packages/gui-extensions/src/browser/ipc.ts, surface `browser-pane-ipc`).
// Tab and state fields mirror @opencode/plugin-browser `Browser.Tab` / `Browser.State`; main validates every command
// with `Browser.Action`, so the command union below lists only what the pane UI sends.
import type { HostBrowserPane, OwnHost } from "@/host/types"

export interface BrowserTab {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly loadError?: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly generation: number
}

export interface BrowserState {
  readonly tabs: readonly BrowserTab[]
  readonly focusedTabID: string | null
}

/**
 * Local sidecar: `{url}` only, exactly `host.connect().baseUrl` (main adds Basic only for that exact origin,
 * extension/host.ts `server` / sidecar-credentials.ts). SSH remote: `{url, username: "opencode", password: <session
 * token>}`. The desktop host hands it to main as the window's server endpoint named by `serverKey`.
 */
export interface BrowserPaneEndpoint {
  readonly url: string
  readonly username?: string
  readonly password?: string
}

export interface BrowserPaneTarget {
  readonly serverKey: string
  readonly sessionID: string
  readonly endpoint: BrowserPaneEndpoint
  readonly restore?: BrowserState
}

/** Where the pane shows a tab: the desktop host lays it on that tab page's embed and hides the one shown before. */
export interface BrowserPaneLayout {
  readonly tabID: string
  readonly visible: boolean
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly background?: readonly [number, number, number, number]
  readonly radius?: number
}

export type BrowserPaneCommand =
  | { readonly type: "tabs.open"; readonly url?: string; readonly focus?: boolean }
  | { readonly type: "tabs.focus"; readonly tabID: string }
  | { readonly type: "tabs.close"; readonly tabID: string }
  | { readonly type: "navigate"; readonly tabID: string; readonly url: string }
  | { readonly type: "back"; readonly tabID: string }
  | { readonly type: "forward"; readonly tabID: string }
  | { readonly type: "reload"; readonly tabID: string }
  | { readonly type: "stop"; readonly tabID: string }

export type BrowserPaneEvent =
  | { readonly type: "focus"; readonly tabID: string }
  | { readonly type: "preview"; readonly path: string }
  | {
      readonly type: "state"
      readonly state: BrowserState | null
      readonly error?: string
      /**
       * With `suspended`: the host's pane itself went away (its extension stopped or never came up), not an idle
       * eviction. The connection registers again when the platform reports the pane back (`onAvailable`).
       */
      readonly lost?: true
    }

export interface BrowserPaneRegistration {
  setLayout(layout?: BrowserPaneLayout): void
  command(command: BrowserPaneCommand): Promise<void>
  /** The shown page as a JPEG, or null when nothing is on screen. */
  capture(tabID: string): Promise<Blob | null>
  close(): void
}

/**
 * A download of one of this window's pane tabs (05 §8.4): the host keeps the file in its temp folder for the agent
 * and deletes it with the tab; `save` copies it where the user picks (`PC에 저장`). Same shape as the shell's
 * `OwnBrowserDownload` (own-desktop preload/own-api.ts), written structurally.
 */
export interface BrowserDownload {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly bytes: number
  readonly total: number
  readonly state: "progressing" | "completed" | "failed" | "cancelled" | "removed"
  readonly sourceURL: string
  readonly saved: boolean
}

export type BrowserDownloadSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown" | "incomplete" | "gone" | "canceled" | "failed" }

export interface BrowserDownloads {
  subscribe(listener: (download: BrowserDownload) => void): () => void
  save(id: string): Promise<BrowserDownloadSaveResult>
}

export interface BrowserPanePlatform extends HostBrowserPane {
  register(target: BrowserPaneTarget, listener: (event: BrowserPaneEvent) => void): BrowserPaneRegistration
  /** Hosts whose shell reports pane downloads (own-desktop `window.own.browser`). */
  readonly downloads?: BrowserDownloads
  /** 05 §7.2: while on, the shell asks before the window closes (a running session holds browser tabs). */
  guardClose?(on: boolean): void
  /** The host's pane is there again after it went away (upstream connection `refresh`); returns the unsubscribe. */
  onAvailable?(listener: () => void): () => void
  /**
   * The user clicked into one of this window's native views (03 §4.1.1: the split pane holding it takes the focus).
   * The bounds are the view's on screen, in the units `setLayout` sends (window DIPs × zoom). Shells without the
   * event (older own-desktop) leave it out.
   */
  onViewFocus?(listener: (bounds: { x: number; y: number; width: number; height: number }) => void): () => void
}

/**
 * The host's pane platform, if it has one. `HostBrowserPane` in src/host/types.ts is still the opaque P3 placeholder;
 * the desktop host returns this wider shape (03 §16.7 `browser?: BrowserPanePlatform`).
 */
export function browserPlatform(host: Pick<OwnHost, "capabilities" | "browser">): BrowserPanePlatform | undefined {
  const pane = host.browser
  if (!host.capabilities.browserPane || !pane) return undefined
  return "register" in pane && typeof pane.register === "function" ? (pane as BrowserPanePlatform) : undefined
}

/** Closing reasons main reports in `state.error` (05 §8.2). */
export const PANE_CLOSED = {
  unsupported: "browser.pane.unsupported",
  replaced: "browser.pane.replaced",
  suspended: "browser.pane.suspended",
  closed: "browser.pane.registration.closed",
  /** The server does not know the session (yet): no error and no retry, the next use registers again (v2.2.2). */
  missing: "browser.pane.missing",
} as const

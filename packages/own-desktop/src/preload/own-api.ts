// `window.own`: the shell side of the desktop OwnHost (05 §5.6). Only own-web's src/host/desktop.ts reads it.
// This file is an rpcHash input (05 §5.5): changing the contract changes the hash, so the shell and the renderer
// must be rebuilt together. Keep it type-only apart from the channel names.

export const OwnIpc = {
  shellInfo: "own:shell.info",
  serviceStatus: "own:service.status",
  serviceRestart: "own:service.restart",
  /**
   * Window message the page posts once upstream's `renderer/ipc-client.ts` is loaded and listening. own-web imports
   * that client lazily (after T0-0), so the preload holds main's MessagePort until asked instead of posting it on
   * arrival, where a page without a listener yet would lose it and every IPC call would hang.
   */
  portRequest: "own:ipc.port-request",
  /** main → renderer: a download of one of this window's browser-pane tabs changed (05 §8.4). */
  browserDownload: "own:browser.download",
  /** renderer → main: copy a finished download to a place the user picks (`PC에 저장`). */
  browserSaveDownload: "own:browser.save-download",
  /** renderer → main: a running session of this window holds browser tabs, so a window close asks first (7.2). */
  browserCloseGuard: "own:browser.close-guard",
  /** main → renderer: the user clicked into one of this window's pane views; its bounds (03 §4.1.1 split panes). */
  browserViewFocus: "own:browser.view-focus",
  /** main → renderer: a pane-focus chord typed inside a pane view (F6, Shift+F6, Ctrl+Alt+1–4), see OwnBrowserViewKey. */
  browserViewKey: "own:browser.view-key",
  /** renderer → main: open the shell's log folder in Explorer (5.5 mismatch screen [로그 폴더]). */
  openLogs: "own:support.open-logs",
  /** renderer → main: `own open --browser` through the launcher (5.5 mismatch screen [브라우저로 열기]). */
  openInBrowser: "own:support.open-in-browser",
  /** renderer → main: the 원격 PC list (08 §4.1); first call also checks each PC once. */
  remotePcsList: "own:remote-pcs.list",
  /** renderer → main: start pairing from a pasted `ownpc://pair?…` link; answers with the confirmation number. */
  remotePcsPair: "own:remote-pcs.pair",
  /** renderer → main: the pairing's ending (approved and stored, or why not). */
  remotePcsPairWait: "own:remote-pcs.pair-wait",
  /** renderer → main: stop waiting for the PC's approval. */
  remotePcsPairCancel: "own:remote-pcs.pair-cancel",
  /** renderer → main: open (or focus) that PC's window. */
  remotePcsOpen: "own:remote-pcs.open",
  /** renderer → main: forget a PC: the PC revokes this device (when it answers), then window, storage, record go. */
  remotePcsRemove: "own:remote-pcs.remove",
  /** main → renderer: the 원격 PC list changed (added, removed, state, window opened or closed). */
  remotePcsChanged: "own:remote-pcs.changed",
  /** renderer → main: the 모바일 미리보기 device (08 §4.3); first call also checks it once. */
  mobilePreviewStatus: "own:mobile-preview.status",
  /** renderer → main: pair the preview from a `devices.pair.start{appRoute:"loopback"}` link; answers with the SAS. */
  mobilePreviewPair: "own:mobile-preview.pair",
  /** renderer → main: the preview pairing's ending. */
  mobilePreviewPairWait: "own:mobile-preview.pair-wait",
  /** renderer → main: stop waiting for this PC's approval. */
  mobilePreviewPairCancel: "own:mobile-preview.pair-cancel",
  /** renderer → main: open (or focus) the preview window, the app listener at `port`. */
  mobilePreviewOpen: "own:mobile-preview.open",
  /** renderer → main: forget the preview: the gateway revokes it (when it answers), then window, storage, record go. */
  mobilePreviewRemove: "own:mobile-preview.remove",
  /** main → renderer: the preview changed (paired, removed, state, window opened or closed). */
  mobilePreviewChanged: "own:mobile-preview.changed",
  /** renderer → main: this PC's window zoom factor (05 §7.9). */
  zoomGet: "own:zoom.get",
  /** renderer → main: set the zoom of every own-web window and keep it; answers the factor applied. */
  zoomSet: "own:zoom.set",
  /** renderer → main: one zoom level up or down from the kept factor; answers the factor applied. */
  zoomStep: "own:zoom.step",
  /** main → renderer: the zoom factor, after every set or step (keys, controls, Ctrl+wheel, another window). */
  zoomChanged: "own:zoom.changed",
  /** renderer → main: 앱 종료 (`app`) or 완전 종료 (`all`, main asks first) (05 §7.3). */
  appQuit: "own:app.quit",
  /** renderer → main: what the last window's X does; with `action`, it is set first (05 §7.3). */
  appCloseAction: "own:app.close-action",
} as const

/** Where the renderer page came from (05 §5.5). `fallback` pages explain `reason`. */
export type OwnRendererSource =
  | { readonly source: "installed"; readonly root: string; readonly uiVersion?: string }
  | { readonly source: "dev"; readonly url: string }
  | {
      readonly source: "fallback"
      readonly reason: "missing" | "skew"
      readonly uiVersion?: string
      readonly uiRpcHash?: string
    }

export interface OwnShellInfo {
  /** Shell main start, epoch ms (05 §5.2, T0-6 `own:shell-start`). */
  readonly startedAt: number
  /** `<OWN_HOME>\control`, the control location (02 §9.1, Q41). */
  readonly controlDir: string
  readonly renderer: OwnRendererSource
  readonly channel: "own" | "local"
}

export interface OwnServiceStatus {
  readonly running: boolean
  readonly version?: string
  /** Registration file the shell discovers (`service-own.json`, or `service-local.json` in dev). */
  readonly registration?: string
  /** 01 §5.4 guard 2: the running service is the installed release (`app\current\manifest.json` version). */
  readonly managed: boolean
  /** Launcher service config env (03 §16.3): `OPENCODE_CONFIG_PROJECT_DISABLE=1` is untrusted. */
  readonly mode?: "trusted" | "untrusted"
}

export interface OwnServiceRestartInput {
  readonly force: boolean
  readonly claudeConfigDir?: string
}

export type OwnServiceRestartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refused: "session_running" }
  | { readonly ok: false; readonly refused: "launcher_failed"; readonly detail: string }

/**
 * A download of a browser-pane tab (05 §8.4) as the owning window sees it. Upstream keeps the file for the agent in
 * `%TEMP%\opencode-browser-client-<uuid>\<fileId>\<name>` and deletes it with the tab; the path stays in main.
 */
export interface OwnBrowserDownload {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly bytes: number
  /** 0 when the server sent no length. */
  readonly total: number
  /** `removed`: the temp copy is gone (its tab or the attachment closed), so it can no longer be saved. */
  readonly state: "progressing" | "completed" | "failed" | "cancelled" | "removed"
  /** The page that started it, so the renderer can place it with a tab of the session. */
  readonly sourceURL: string
  /** Copied to a user folder through the save dialog at least once. */
  readonly saved: boolean
}

export type OwnBrowserSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown" | "incomplete" | "gone" | "canceled" | "failed" }

/** A pane view's bounds in its window (DIPs, as the renderer laid it out: CSS pixels × zoom). */
export interface OwnBrowserViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A key a pane view swallowed that belongs to the window (03 §4.1.1): the native view has the keyboard, so the shell
 * hands these chords to the renderer, which runs them as if typed there. Only F6, Shift+F6 and Ctrl+Alt+1–4 (no
 * other modifiers); everything else stays with the page (AltGr+1–4, which is Ctrl+Alt+1–4 on Windows, is taken).
 */
export interface OwnBrowserViewKey {
  readonly code: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
}

/** own addition to 05 §5.6 for 05 §8.4 (`PC에 저장`) and §7.2 (close guard). Absent in shells without it. */
export interface OwnBrowserApi {
  onDownload(listener: (download: OwnBrowserDownload) => void): () => void
  saveDownload(id: string): Promise<OwnBrowserSaveResult>
  /** While on, closing the window (X, Alt+F4) asks first; the page's `beforeunload` covers reloads. */
  guardClose(on: boolean): void
  /** 03 §4.1.1: a click into a pane view (the renderer never sees it); absent in shells before split panes. */
  onViewFocus?(listener: (bounds: OwnBrowserViewBounds) => void): () => void
  /** 03 §4.1.1: a pane-focus chord typed inside a pane view; absent in shells before split panes. */
  onViewKey?(listener: (key: OwnBrowserViewKey) => void): () => void
}

export type OwnOpenInBrowserResult = { readonly ok: true } | { readonly ok: false; readonly detail: string }

/**
 * own addition to 05 §5.6 for the 5.5 mismatch screens (own-web's and the fallback page): what they offer besides
 * "reinstall". A page must feature-detect it (`window.own.support?.openLogs`): the whole point of those screens is a
 * shell of another contract, which may not have it.
 */
export interface OwnSupportApi {
  /** Opens the shell's log folder (userData\logs) in Explorer; `false` when Windows could not open it. */
  openLogs(): Promise<boolean>
  /** Runs `own open --browser` (service start or reuse, a pairing link, the browser); refused on the dev channel. */
  openInBrowser(): Promise<OwnOpenInBrowserResult>
}

/**
 * A paired 원격 PC as the renderer sees it (08 §4.1). No pin, routes or token: those stay in main.
 * - `checking`: not checked yet in this run.
 * - `connected`: its gateway answered over the pinned connection.
 * - `unreachable`: no route accepted a connection.
 * - `reauth`: the PC refused the device (revoked, expired), its key changed, or the credential is gone: pair again.
 */
export interface OwnRemotePc {
  readonly pcKey: string
  readonly name: string
  readonly state: "checking" | "connected" | "unreachable" | "reauth"
  /** Epoch ms. */
  readonly addedAt: number
  /** Device credential expiry, epoch ms. */
  readonly expiresAt: number
  /** Its window is open. */
  readonly open: boolean
}

/**
 * Why pairing did not happen. `invalid_link`: not a valid `ownpc://pair` link (`detail` names the part).
 * `expired`: the link or the approval timed out (or was used). `rejected`: the PC said no (a different confirmation
 * number). `cancelled`: the PC cancelled. `rate_limited`: too many attempts. `unreachable`: no route connected.
 * `pin_mismatch`: the PC's certificate key is not the link's. `key_changed`: the link names a stored PC under another
 * key (refused before any request, 08 §3.5). `aborted`: cancelled here. `failed`: anything else.
 */
export type OwnRemotePcError =
  | "invalid_link"
  | "expired"
  | "rejected"
  | "cancelled"
  | "rate_limited"
  | "unreachable"
  | "pin_mismatch"
  | "key_changed"
  | "aborted"
  | "failed"

export type OwnRemotePcPairStart =
  | {
      readonly ok: true
      readonly pairingId: string
      readonly pcKey: string
      /** The PC's name from the link. */
      readonly name: string
      /** The confirmation number the PC shows next to [허용]. */
      readonly sas: string
      /** Epoch ms. */
      readonly expiresAt: number
    }
  | { readonly ok: false; readonly error: OwnRemotePcError; readonly detail?: string }

export type OwnRemotePcPairResult =
  | { readonly ok: true; readonly pcKey: string; readonly name: string }
  | { readonly ok: false; readonly error: OwnRemotePcError; readonly detail?: string }

/** own addition (08 §4.1 원격 PC): other PCs' own-web in their own pinned windows. Absent in shells without it. */
export interface OwnRemotePcsApi {
  list(): Promise<readonly OwnRemotePc[]>
  pair(link: string): Promise<OwnRemotePcPairStart>
  waitPairing(pairingId: string): Promise<OwnRemotePcPairResult>
  cancelPairing(pairingId: string): Promise<void>
  /** `false`: no such PC. */
  open(pcKey: string): Promise<boolean>
  /** `false`: no such PC. */
  remove(pcKey: string): Promise<boolean>
  onChange(listener: (pcs: readonly OwnRemotePc[]) => void): () => void
}

/** 모바일 미리보기 screen presets (08 §4.3, own-desktop `remote-pcs/emulation.ts`). */
export type OwnMobilePreviewPreset = "compact" | "pixel" | "galaxy" | "fold" | "tablet"

export type OwnMobilePreviewOrientation = "portrait" | "landscape"

/**
 * This PC's 모바일 미리보기 device as the renderer sees it (08 §4.3). `none`: not made yet. The other states are
 * OwnRemotePc's. `pcKey` and `pin` are this PC's own app identity as paired (public, the gateway view shows them too):
 * own-web compares them with `gateway.status().app` to offer 다시 만들기. The token and the route stay in main.
 */
export type OwnMobilePreview =
  | { readonly state: "none" }
  | {
      readonly state: "checking" | "connected" | "unreachable" | "reauth"
      readonly pcKey: string
      readonly pin: string
      readonly deviceId: string
      /** Epoch ms. */
      readonly addedAt: number
      /** Device credential expiry, epoch ms. */
      readonly expiresAt: number
      /** Its window is open. */
      readonly open: boolean
      readonly preset: OwnMobilePreviewPreset
      readonly orientation: OwnMobilePreviewOrientation
    }

/**
 * own addition (08 §4.3 모바일 미리보기): this PC's own-web as the Android app sees it, in a window of this shell.
 * Pairing reuses the 원격 PC types; `invalid_link` also covers a link that is not exactly one loopback route.
 * Absent in shells without it.
 */
export interface OwnMobilePreviewApi {
  status(): Promise<OwnMobilePreview>
  /** `link`: `appLink` of `devices.pair.start{appRoute:"loopback"}`; it is never shown. */
  pair(link: string): Promise<OwnRemotePcPairStart>
  waitPairing(pairingId: string): Promise<OwnRemotePcPairResult>
  cancelPairing(pairingId: string): Promise<void>
  /** `port`: `gateway.status().app.port` (the stored route follows it). `false`: no preview device. */
  open(input: { readonly port: number }): Promise<boolean>
  /** `false`: no preview device. */
  remove(): Promise<boolean>
  onChange(listener: (preview: OwnMobilePreview) => void): () => void
}

/**
 * own addition (05 §7.9): this PC's window zoom, one factor (1 = 100 %, 50–200 %) for every own-web window of the
 * shell, kept in its settings file. Absent in shells without it.
 */
export interface OwnZoomApi {
  get(): Promise<number>
  /** Clamped to 50–200 %. */
  set(factor: number): Promise<number>
  /** The next of Chrome's levels (src/shared/zoom.ts) up or down; at an end it stays. */
  step(direction: "in" | "out"): Promise<number>
  /** Every set and step, also one that left the factor as it was (Ctrl+= at 200 %). */
  onChange(listener: (factor: number) => void): () => void
}

/** 05 §7.3: the last window's X hides it to the tray (default) or quits the app. */
export type OwnCloseAction = "tray" | "quit"

/**
 * own addition (05 §7.3 tray and quit). `quit("app")` closes the shell; the service keeps serving phones, other PCs and
 * running conversations. `quit("all")` asks first (a dialog of main's), then stops this PC's service and closes the
 * shell; `false` when nothing closed (cancelled, or the stop failed and the user stayed). Absent in shells without it.
 */
export interface OwnAppApi {
  quit(mode: "app" | "all"): Promise<boolean>
  closeAction(): Promise<OwnCloseAction>
  setCloseAction(action: OwnCloseAction): Promise<OwnCloseAction>
}

export interface OwnShellApi {
  readonly shell: {
    readonly rpcHash: string
    readonly version: string
    readonly startedAt: Promise<number>
    readonly controlDir: Promise<string>
    /** own addition to 05 §5.6: the fallback page and diagnostics read why the page is what it is. */
    readonly renderer: Promise<OwnRendererSource>
  }
  readonly service: {
    status(): Promise<OwnServiceStatus>
    restart(input: OwnServiceRestartInput): Promise<OwnServiceRestartResult>
  }
  readonly browser?: OwnBrowserApi
  readonly support?: OwnSupportApi
  readonly remotePcs?: OwnRemotePcsApi
  readonly mobilePreview?: OwnMobilePreviewApi
  readonly zoom?: OwnZoomApi
  readonly app?: OwnAppApi
}

// OwnHost: the only contract between own-web and whatever embeds it (03 §16.7, 05 §6.2–6.6).
// Capability names follow 03 §16.7's table. UI code gates on `capabilities`, never on `kind`: comparing `kind` is
// allowed only inside src/host/ (enforced by test/boundaries).
import type { OwnAccounts } from "@own/protocol"

export type HostKind = "web" | "desktop" | "mobile"

/**
 * - `injected`: something outside the page adds auth (desktop main, the dev proxy). The renderer holds no secret.
 * - `cookie`: web fallback, same-origin pairing cookie.
 * - `device`: a paired remote device behind the own-remote gateway (M1).
 */
export type ConnectionAuth = "injected" | "cookie" | "device"

export interface HostConnection {
  /** Absolute URL; may carry a path prefix (`https://pc.tailnet.ts.net/srv/local`, 04 §12.1). */
  readonly baseUrl: string
  readonly auth: ConnectionAuth
  /** Control location for global RPCs (02 §9.1, Q41). Absent: fall back to `health` on a known project location. */
  readonly controlDir?: string
  /** Device scopes granted by the gateway (`auth: "device"` only, 05 §13.5). PC windows get every scope. */
  readonly scopes?: readonly OwnAccounts.Scope[]
  /** A device's: the name of the PC the service runs on (`/own/device` `pc`), named by view-only notices (06 §9.8). */
  readonly pc?: string
  /**
   * A device's scopes as the gateway holds them (`auth: "device"` only), the ones {@link scopes} leaves out included:
   * `files`, `terminal`, and `browser` (05 §8.10: the session's browser pane on this device).
   */
  readonly deviceScopes?: readonly string[]
}

export type OsNotifications = "none" | "web" | "native" | "push"

export interface HostCapabilities {
  /** Session header rides the desktop title bar band (03 §4.2.1). */
  readonly windowControlsOverlay: boolean
  /** Local server sessions only (03 §16.7). */
  readonly nativeDirectoryPicker: boolean
  /** Local server sessions only. */
  readonly nativeFilePaths: boolean
  /** Local server sessions only. */
  readonly openInApp: boolean
  readonly clipboardImage: boolean
  readonly saveDialog: boolean
  readonly osNotifications: OsNotifications
  /** Work panel `브라우저` tab (18.17). The tool list never depends on this (18.15). */
  readonly browserPane: boolean
  readonly serviceControl: boolean
  readonly multiWindow: boolean
  readonly keepScreenAwake: boolean
  /** `(pointer: coarse)`, detected at startup (4.2.2). */
  readonly touch: boolean
  readonly offlineCatalog: boolean
  /** Sidebar `원격 PC` (08 §4.1): other PCs' own-web in pinned shell windows. Absent: off (web, mobile). */
  readonly remotePcs?: boolean
  /** 설정 > 기기 `모바일 미리보기` (08 §4.3): this PC's own-web as the Android app sees it. Absent: off (web, mobile). */
  readonly mobilePreview?: boolean
  /** 05 §7.3 `앱 종료` / `완전 종료` and what the window's X does (the desktop shell's tray). Absent: off (web, mobile). */
  readonly appQuit?: boolean
}

export interface ServiceStatus {
  readonly running: boolean
  readonly version?: string
  readonly registration?: string
  readonly managed: boolean
  /** 03 asks 05 for this (open question 46/48): restart keeps the trust mode. */
  readonly mode?: "trusted" | "untrusted"
}

export type ServiceRestartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refused: "session_running" }
  | { readonly ok: false; readonly refused: "launcher_failed"; readonly detail: string }

export interface HostService {
  status(): Promise<ServiceStatus>
  restart(input: { readonly force: boolean; readonly claudeConfigDir?: string }): Promise<ServiceRestartResult>
}

/**
 * The window zoom of a host that zooms its own windows (desktop, 05 §7.9): one factor (1 = 100 %) for every window of
 * the host, kept by the host across starts. Absent where the browser or the OS zooms (web, phone).
 */
export interface HostZoom {
  /** The levels `step` moves through, ascending; the first and the last are the ends `set` clamps to. */
  readonly levels: readonly number[]
  get(): Promise<number>
  /** Answers the factor applied (clamped). */
  set(factor: number): Promise<number>
  /** One level up or down; at an end it stays. Answers the factor applied. */
  step(direction: "in" | "out"): Promise<number>
  /** Every set and step, from any window of the host (also one that left the factor as it was). */
  onChange(listener: (factor: number) => void): () => void
}

export interface HostWindow {
  focus(): void
  show(): void
  isFocused(): boolean
  /** 03 §4.2.1, 05 §7.9: the zoom keys, the title bar's zoom indicator and 설정 > 일반 `화면 크기` need it. */
  readonly zoom?: HostZoom
}

export interface HostNotification {
  readonly title: string
  readonly body?: string
  /** Same-kind notifications of one session within 10 s merge on this tag (03 §9). */
  readonly tag?: string
  readonly onClick?: () => void
}

export interface HostFiles {
  /**
   * The native folder dialog; `defaultPath` is where it opens (03 §18.3 폴더 열기 시작 위치). Without one Windows reopens
   * the folder it showed last, often Downloads.
   */
  pickDirectory?(options?: { readonly defaultPath?: string }): Promise<string | null>
  /**
   * The native open-file dialog: the picked file's path, never its content (설정 > 승인·권한 `에이전트가 못 여는
   * 파일·폴더`, PP). Local server sessions only, like {@link pickDirectory}.
   */
  pickFile?(options?: { readonly defaultPath?: string }): Promise<string | null>
  pathForFile?(file: File): string | null
  readClipboardImage?(): Promise<Blob | null>
  openPath?(path: string, app?: string): Promise<void>
  revealPath?(path: string): Promise<void>
  saveFile?(input: { readonly name: string; readonly data: Blob }): Promise<boolean>
}

/**
 * Opaque until P4: the desktop host implements upstream `BrowserPanePlatform` (import type from
 * `@opencode/app/desktop`, 03 §15.1), which needs the `../app` project reference the web build does not have yet.
 */
export interface HostBrowserPane {
  readonly platform: "desktop"
}

/**
 * A paired 원격 PC (08 §4.1). The shell keeps its pin, routes and device token; the page sees names and states.
 * `checking`: not checked yet; `connected`: its gateway answered; `unreachable`: no route connected; `reauth`: the PC
 * refused this device, its key changed or the credential is gone (pair again with a new link).
 */
export interface RemotePc {
  readonly pcKey: string
  readonly name: string
  readonly state: "checking" | "connected" | "unreachable" | "reauth"
  readonly addedAt: number
  readonly expiresAt: number
  /** Its window is open. */
  readonly open: boolean
}

export type RemotePcError =
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

export type RemotePcPairStart =
  | {
      readonly ok: true
      readonly pairingId: string
      readonly pcKey: string
      readonly name: string
      /** The confirmation number the PC shows next to [허용]. */
      readonly sas: string
      readonly expiresAt: number
    }
  | { readonly ok: false; readonly error: RemotePcError; readonly detail?: string }

export type RemotePcPairResult =
  | { readonly ok: true; readonly pcKey: string; readonly name: string }
  | { readonly ok: false; readonly error: RemotePcError; readonly detail?: string }

/** 원격 PC calls (08 §4.1); present with `capabilities.remotePcs`. */
export interface HostRemotePcs {
  list(): Promise<readonly RemotePc[]>
  /** Starts pairing from a pasted `ownpc://pair?…` link. */
  pair(link: string): Promise<RemotePcPairStart>
  /** The pairing's ending: the PC approved (and the shell stored it), or why not. */
  waitPairing(pairingId: string): Promise<RemotePcPairResult>
  cancelPairing(pairingId: string): Promise<void>
  /** Opens (or focuses) the PC's window; `false` for an unknown PC. */
  open(pcKey: string): Promise<boolean>
  /**
   * Asks the PC to revoke this device (08 §3.6a, skipped when it does not answer), then forgets it here (window,
   * stored login, record); `false` for an unknown PC.
   */
  remove(pcKey: string): Promise<boolean>
  onChange(listener: (pcs: readonly RemotePc[]) => void): () => void
}

export type MobilePreviewPreset = "compact" | "pixel" | "galaxy" | "fold" | "tablet"

/**
 * This PC's 모바일 미리보기 device (08 §4.3). `none`: not made yet; the other states are RemotePc's. `pcKey` and `pin`
 * are this PC's app identity as paired (public, `gateway.status().app` shows them too); the token and the route stay
 * in the shell.
 */
export type MobilePreview =
  | { readonly state: "none" }
  | {
      readonly state: "checking" | "connected" | "unreachable" | "reauth"
      readonly pcKey: string
      readonly pin: string
      readonly deviceId: string
      readonly addedAt: number
      readonly expiresAt: number
      /** Its window is open. */
      readonly open: boolean
      readonly preset: MobilePreviewPreset
      readonly orientation: "portrait" | "landscape"
    }

/** 모바일 미리보기 calls (08 §4.3); present with `capabilities.mobilePreview`. */
export interface HostMobilePreview {
  status(): Promise<MobilePreview>
  /** `appLink` of `devices.pair.start{appRoute:"loopback"}`, handed over and never shown. */
  pair(link: string): Promise<RemotePcPairStart>
  waitPairing(pairingId: string): Promise<RemotePcPairResult>
  cancelPairing(pairingId: string): Promise<void>
  /** Opens (or focuses) the preview window on the app listener's `port`; `false` without a preview device. */
  open(input: { readonly port: number }): Promise<boolean>
  /** Revokes the device (when the gateway answers), then forgets it here; `false` without a preview device. */
  remove(): Promise<boolean>
  onChange(listener: (preview: MobilePreview) => void): () => void
}

/** 05 §7.3: the last window's X hides the app to the tray (default) or quits it. */
export type CloseAction = "tray" | "quit"

/** The desktop app's quit calls (05 §7.3); present with `capabilities.appQuit`. */
export interface HostApp {
  /**
   * `app`: closes the app; the service keeps serving phones, other PCs and running conversations. `all`: the shell asks
   * (its own dialog), then stops this PC's service and closes the app. `false` when nothing closed.
   */
  quit(mode: "app" | "all"): Promise<boolean>
  closeAction(): Promise<CloseAction>
  setCloseAction(action: CloseAction): Promise<CloseAction>
}

/**
 * A paired device's view of the PC's desktop app (05 §8.10.5). The app, not the device, holds a conversation's browser
 * pane, so the agent's browser tools follow it: a conversation created on the device gets them while it runs.
 */
export interface HostRemotePane {
  /**
   * The PC's desktop app is running with a window (own.remote `browser.status`), as last read: `false` until the first
   * answer and after a read that failed. Reactive.
   */
  available(): boolean
}

/**
 * Why `탐색기에서 열기` / `탐색기에서 보기` opened nothing (05 §7.10, own-desktop src/shared/explorer.ts). `outside`: not
 * inside a folder the app has open. `missing`: the folder or file is gone. `service`: the PC's service did not say
 * which folders are open. `unconfigured`: no SSH file explorer program chosen yet. `program`: the chosen program is
 * gone. `blocked`: Windows refused to start it. `failed`: it did not start or open. `host`, `path`, `template`: a value
 * the desktop app refuses. `unavailable`: a desktop app older than this screen.
 */
export type ExplorerFailure =
  | "outside"
  | "missing"
  | "service"
  | "unconfigured"
  | "program"
  | "blocked"
  | "failed"
  | "host"
  | "path"
  | "template"
  | "unavailable"

export type ExplorerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExplorerFailure; readonly detail?: string }

/** The SSH file explorer program of 설정; no `program` until the user picked one. */
export interface ExplorerProgram {
  readonly program?: string
  readonly template: string
}

/**
 * `탐색기에서 열기` / `탐색기에서 보기` (03 §19.5, 05 §7.10). Present where the page runs on the PC whose folders it
 * shows, inside the desktop app: absent in a browser, on the phone and in a 원격 PC window, where items that need it are
 * left out. Only a click calls it.
 */
export interface HostExplorer {
  /** A path of this PC: a folder opens in Explorer, a file is shown selected in its folder (never opened). */
  reveal(path: string): Promise<ExplorerResult>
  /** A path on an SSH host: starts the user's program with `{host}` and `{path}` of its argument template. */
  launch(input: { readonly host: string; readonly path: string }): Promise<ExplorerResult>
  program(): Promise<ExplorerProgram>
  /** The desktop app's own file dialog; answers the setting as it is afterwards (unchanged when cancelled). */
  pickProgram(): Promise<ExplorerProgram>
  /** Kept only when usable (it needs `{path}`); answers the setting as it is afterwards. */
  setTemplate(template: string): Promise<ExplorerProgram>
  clearProgram(): Promise<ExplorerProgram>
}

export interface ChromeTheme {
  readonly mode: "light" | "dark"
  readonly scheme?: "light" | "dark" | "system"
  readonly background: string
}

export interface OwnHost {
  /** Diagnostics only. Never compare outside src/host/. */
  readonly kind: HostKind
  readonly capabilities: HostCapabilities
  /** T0-1. */
  connect(): Promise<HostConnection>
  reconnect(): Promise<HostConnection>
  /** T0-3: once, right after the first themed paint. */
  ready(): void
  /** T0-4: first paint and every theme change. */
  setChrome(theme: ChromeTheme): void
  /** T0-5: http, https and mailto only. */
  openExternal(url: string): void
  readonly files?: HostFiles
  readonly browser?: HostBrowserPane
  readonly service?: HostService
  readonly window?: HostWindow
  notify?(input: HostNotification): void
  /** 08 §4.1 원격 PC; with `capabilities.remotePcs`. */
  readonly remotePcs?: HostRemotePcs
  /** 08 §4.3 모바일 미리보기; with `capabilities.mobilePreview`. */
  readonly mobilePreview?: HostMobilePreview
  /** 05 §7.3 앱 종료 / 완전 종료; with `capabilities.appQuit`. */
  readonly app?: HostApp
  /** 05 §8.10.5: a paired device's host only (`auth: "device"`); absent on the PC's windows and the web fallback. */
  readonly remotePane?: HostRemotePane
  /** 05 §7.10 탐색기에서 열기 / 탐색기에서 보기; the desktop app only. */
  readonly explorer?: HostExplorer
}

export class HostUnavailableError extends Error {
  override readonly name: string = "HostUnavailableError"
}

/**
 * A page served by the gateway (05 §13.9 M1) without a valid device credential: never paired, or the PC revoked or
 * let it expire. The entry shows the device pairing screen (src/pairing/device-screen.tsx) instead of the app.
 */
export class DeviceAuthRequiredError extends HostUnavailableError {
  override readonly name = "DeviceAuthRequiredError"
  constructor(readonly reason: "device_unauthorized" | "device_revoked" | "device_expired") {
    super(`device authentication required (${reason})`)
  }
}

/**
 * T0-0 refused the shell (05 §5.5 "렌더러 재검사"): its `window.own.shell.rpcHash` is not this build's, or it has no
 * `window.own`. Here rather than in desktop.ts so the entry can show the mismatch screen (host/mismatch.ts) without
 * the desktop host in its chunk (PF5).
 */
export class ShellMismatchError extends HostUnavailableError {
  override readonly name = "ShellMismatchError"
  constructor(
    /** The shell's rpcHash; `undefined` when the page has no `window.own`. */
    readonly shell: string | undefined,
    /** This build's rpcHash. */
    readonly ui: string,
  ) {
    super(
      shell === undefined
        ? "셸과 화면 버전이 맞지 않아요: 데스크톱 셸에 window.own이 없어요"
        : `셸과 화면 버전이 맞지 않아요 (셸 ${shell}, 화면 ${ui}). 데스크톱 앱을 다시 설치하세요`,
    )
  }
}

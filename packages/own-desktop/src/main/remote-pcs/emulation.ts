// 모바일 미리보기 emulation (08 §4.3): what makes one window of this shell look to own-web like the Android app's
// WebView. The parameters are built here without Electron (tested under bun); `emulate` sends them through the
// window's in-process `webContents.debugger` before the first load (own-web picks the mobile host and reads
// `(pointer: coarse)` at startup). No remote-debugging port is opened.
//  - The viewport is the screen minus the system bars, as the app's EdgeToEdge leaves it: safe-area insets stay 0.
//  - The keyboard shrinks the viewport like Android's `adjustResize` (portrait: about 40 %, landscape: about 55 %).
//  - Touch emulation with 5 points makes `(pointer: coarse)` and `(hover: none)` match; mouse input becomes touches.
//  - The user agent is the app's (` OwnOpenCodeApp/1 (android)`, so own-web acts as in the app) plus ` OwnPreview/1`,
//    so the PC's approval dialog and device list name the preview (own-remote summarizeAgent).
import type { WebContents } from "electron"
import type { OwnMobilePreviewOrientation, OwnMobilePreviewPreset } from "../../preload/own-api"

/** Rough first values of common screens minus the system bars (portrait, CSS px). */
export const PRESETS = {
  compact: { label: "작은 휴대폰", width: 360, height: 740 },
  pixel: { label: "Pixel", width: 412, height: 868 },
  galaxy: { label: "Galaxy", width: 384, height: 790 },
  fold: { label: "폴더블 (펼침)", width: 673, height: 790 },
  tablet: { label: "태블릿", width: 800, height: 1220 },
} as const satisfies Record<OwnMobilePreviewPreset, { readonly label: string; readonly width: number; readonly height: number }>

export const PRESET_IDS = Object.keys(PRESETS) as OwnMobilePreviewPreset[]
export const DEFAULT_PRESET: OwnMobilePreviewPreset = "pixel"

export type ColorScheme = "system" | "light" | "dark"

export interface EmulationState {
  readonly preset: OwnMobilePreviewPreset
  readonly orientation: OwnMobilePreviewOrientation
  /** The on-screen keyboard is up. */
  readonly keyboard: boolean
  readonly scheme: ColorScheme
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface CdpCommand {
  readonly method: string
  readonly params: Record<string, unknown>
}

/** The screen of the preset in this orientation (what `screen.width/height` report). */
export function screenSize(state: Pick<EmulationState, "preset" | "orientation">): Size {
  const preset = PRESETS[state.preset]
  return state.orientation === "portrait"
    ? { width: preset.width, height: preset.height }
    : { width: preset.height, height: preset.width }
}

/** The page's viewport: the screen, minus the keyboard while it is up. */
export function viewport(state: Pick<EmulationState, "preset" | "orientation" | "keyboard">): Size {
  const screen = screenSize(state)
  if (!state.keyboard) return screen
  return { width: screen.width, height: Math.round(screen.height * (state.orientation === "portrait" ? 0.6 : 0.45)) }
}

/**
 * How much the window shrinks the emulated screen to fit the work area (frame and menu bar included), at most 1:
 * the page still lays out at the full size (CDP `scale`), only the picture is smaller.
 */
export function fitScale(screen: Size, area: Size) {
  const scale = Math.min(1, (area.width - 32) / screen.width, (area.height - 96) / screen.height)
  return Math.max(0.25, Math.floor(scale * 100) / 100)
}

/** The app WebView's user agent (Chromium `chrome`, e.g. `140.0.7339.80`) with both tokens. */
export function previewUserAgent(chrome: string) {
  return `Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${chrome} Mobile Safari/537.36 OwnOpenCodeApp/1 (android) OwnPreview/1`
}

/** Every CDP command of one state, in order; sent again in full on every change (they are idempotent). */
export function emulationCommands(state: EmulationState, options: { readonly chrome: string; readonly scale: number }) {
  const screen = screenSize(state)
  const view = viewport(state)
  const major = options.chrome.split(".")[0] ?? options.chrome
  return [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: view.width,
        height: view.height,
        // 0: this monitor's own ratio, so the picture stays sharp.
        deviceScaleFactor: 0,
        mobile: true,
        scale: options.scale,
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenOrientation:
          state.orientation === "portrait" ? { type: "portraitPrimary", angle: 0 } : { type: "landscapePrimary", angle: 90 },
      },
    },
    { method: "Emulation.setTouchEmulationEnabled", params: { enabled: true, maxTouchPoints: 5 } },
    { method: "Emulation.setEmitTouchEventsForMouse", params: { enabled: true, configuration: "mobile" } },
    {
      method: "Emulation.setUserAgentOverride",
      params: {
        userAgent: previewUserAgent(options.chrome),
        platform: "Linux armv8l",
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: major },
            { brand: "Android WebView", version: major },
          ],
          fullVersion: options.chrome,
          platform: "Android",
          platformVersion: "15.0.0",
          architecture: "",
          model: "Pixel 8",
          mobile: true,
        },
      },
    },
    {
      method: "Emulation.setEmulatedMedia",
      params: { features: [{ name: "prefers-color-scheme", value: state.scheme === "system" ? "" : state.scheme }] },
    },
  ] satisfies CdpCommand[]
}

/**
 * Sends the commands through the window's own debugger, attaching it first when needed. Electron documents that
 * DevTools opening for the window detaches it; the caller applies the state again once DevTools closes. The emulation
 * stays with the window across navigations and reloads, cross-site ones included.
 */
export async function emulate(contents: WebContents, commands: readonly CdpCommand[]) {
  // Electron 44 crashes its main process when device metrics reach a window that never loaded a document.
  if (contents.getURL() === "") await contents.loadURL("about:blank")
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
  for (const command of commands) await contents.debugger.sendCommand(command.method, command.params)
}

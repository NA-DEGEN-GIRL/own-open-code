// Substitutes packages/desktop/src/main/windows/appearance.ts @ 79349e840f (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for its one importer (windows/index.ts; electron.vite.config.ts, 05 §4.3); keeps all
// thirteen exports.
// own (05 §7.9, this PC's window zoom, src/main/zoom.ts):
//  - wireZoom joins the window to the kept zoom factor instead of upstream's saved level (`ZOOM_LEVEL_KEY`, 100 % to
//    200 % only); the early window starts at it too (own-shell.ts prepareWindowAppearance keeps that key equal to the
//    kept factor when the factor is one of upstream's levels).
//  - Ctrl+wheel (`zoom-changed`) is one zoom level for every window, kept like the keys', instead of a reset to the
//    saved level (pinch zoom off) or ±0.2 for this window only (pinch zoom on).
//  - setZoomLevel (upstream's macOS menu items and WindowSetZoomLevel) sets the kept factor; setPinchZoomEnabled no
//    longer resets the zoom. The per-window pinch flag and upstream's 0.2–10 clamp went with them (src/shared/zoom.ts
//    clamps to 50–200 %). WindowZoomChanged names the kept factor's level, or 100 % between upstream's levels.
//  - The frame's overlay is sized to the kept factor.
//  - Upstream modules by package path. Everything else is upstream's text.
import { app, BrowserWindow, nativeImage, nativeTheme } from "electron"
import { desktopZoomLevels, type DesktopZoomLevel } from "@opencode/app/desktop-menu"
import type { Path } from "effect"
import { type TitlebarTheme } from "@opencode/desktop/src/shared/ipc-contract"
import {
  WindowFocusChanged,
  WindowFullscreenChanged,
  WindowPinchZoomChanged,
  WindowZoomChanged,
} from "@opencode/desktop/src/shared/ipc-rpc/events"
import { emitIpcEvent } from "@opencode/desktop/src/main/ipc-events"
import type { DesktopPaths } from "@opencode/desktop/src/main/paths"
import { BACKGROUND_COLOR_KEY, PINCH_ZOOM_ENABLED_KEY } from "@opencode/desktop/src/main/storage/keys"
import { getStore } from "@opencode/desktop/src/main/storage/store"
import {
  platformFrame,
  savedBackgroundColor,
  storedBackgroundColor,
  titlebarOverlay,
  tone,
} from "@opencode/desktop/src/main/windows/defaults"
import { joinZoom, setZoom, stepWindowZoom, zoomFactor } from "../main/zoom"

const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()

let backgroundColor: string | undefined

export function windowAppearance(path: Path.Path, paths: DesktopPaths.Resolved) {
  return {
    title: "OpenCode",
    icon: iconPath(path, paths),
    backgroundColor: backgroundColor ?? storedBackgroundColor(),
    // own: the overlay of the kept factor.
    ...platformFrame(tone(), zoomFactor()),
    webPreferences: {
      preload: paths.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

export function setDockIcon(path: Path.Path, paths: DesktopPaths.Resolved) {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(path.join(iconsDir(path, paths), "dock.png"))

  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function setBackgroundColor(color: string) {
  // The renderer reports its theme background on every boot; electron-store rewrites and fsyncs the
  // settings file on each set, so only persist a change.
  if (getBackgroundColor() !== color) getStore().set(BACKGROUND_COLOR_KEY, color)
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => {
    win.setBackgroundColor(color)

    if (process.platform === "darwin") win.invalidateShadow()
  })
}

export function getBackgroundColor() {
  return backgroundColor ?? savedBackgroundColor()
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)

  // Native window controls follow nativeTheme, not the renderer theme.
  if (process.platform === "darwin" || process.platform === "win32") {
    nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"
  }

  updateTitlebar(win)
}

export function setTrafficLightsPosition(win: BrowserWindow, position: { x: number; y: number }) {
  if (process.platform !== "darwin") return
  win.setWindowButtonPosition({ x: Math.round(position.x), y: Math.round(position.y) })
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  // own: the setting no longer touches the zoom (Ctrl+wheel steps the kept factor either way).
  BrowserWindow.getAllWindows().forEach((win) => emitIpcEvent(win.webContents, new WindowPinchZoomChanged({ enabled })))
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function setZoomLevel(level: DesktopZoomLevel) {
  // own: the kept factor of every window (main/zoom.ts), kept in own's key instead of upstream's.
  setZoom(level)
}

export function wireZoom(win: BrowserWindow) {
  // own: the kept factor instead of 1; joining also sizes the overlay and tells the renderer (updateZoom).
  joinZoom(win, () => updateZoom(win))
  win.webContents.on("zoom-changed", (event, direction) => {
    event.preventDefault()
    // own: Ctrl+wheel is one zoom level, for every window and kept, like Ctrl+= and Ctrl+-.
    stepWindowZoom(direction === "in" ? "in" : "out")
  })
}

export function wireFullscreen(win: BrowserWindow) {
  const send = (fullscreen: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    emitIpcEvent(win.webContents, new WindowFullscreenChanged({ fullscreen }))
  }

  win.on("enter-full-screen", () => send(true))
  win.on("leave-full-screen", () => send(false))
}

export function wireFocus(win: BrowserWindow) {
  const send = (focused: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    emitIpcEvent(win.webContents, new WindowFocusChanged({ focused }))
  }

  win.on("focus", () => send(true))
  win.on("blur", () => send(false))
}

function iconsDir(path: Path.Path, paths: DesktopPaths.Resolved) {
  return app.isPackaged ? path.join(process.resourcesPath, "icons") : path.join(paths.developmentResourcesRoot, "icons")
}

function iconPath(path: Path.Path, paths: DesktopPaths.Resolved) {
  return path.join(iconsDir(path, paths), `icon.${process.platform === "win32" ? "ico" : "png"}`)
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  return titlebarOverlay(theme.mode ?? tone(), zoom)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  const factor = win.webContents.getZoomFactor()
  // own: the level of the kept factor; between upstream's levels (below 100 %) there is none, so 100 %.
  const level = desktopZoomLevels.find((item) => Math.abs(item - factor) < 0.005) ?? 1
  emitIpcEvent(win.webContents, new WindowZoomChanged({ factor, level }))
}

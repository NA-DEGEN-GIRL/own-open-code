// This PC's window zoom (05 §7.9): one factor for every own-web window of the shell, kept in the shell's settings file
// (userData\opencode.settings, key `ownZoomFactor`, next to the window list and the window background).
//  - Windows join from the appearance substitute's wireZoom (src/overrides/appearance.ts), which upstream calls for
//    every app window it creates, the adopted early window included. Joining and every top-frame commit apply the
//    kept factor when the page's differs. Electron ignores a set before a window's first commit; Chromium then applies
//    the renderer host's zoom level at the commit (per host, persisted in its own Preferences), which every set here
//    keeps equal to the kept factor, and the commit check corrects a difference (lost Preferences).
//  - Each change reaches every joined window as `own:zoom.changed`, whoever made it: own-web's keys and controls
//    (`own:zoom.set|step`) or Ctrl+wheel (`zoom-changed`, the substitute).
//  - 원격 PC and 모바일 미리보기 windows never join: other partitions, no preload, and the preview shows the phone's
//    own scale.
//  - Upstream (v2.2) starts its early window at its own saved level (`zoomLevel`, 100–200 %, windows/early.ts
//    `webPreferences.zoomFactor`). Right before that window (own-shell.ts prepareWindowAppearance) the level follows
//    the kept factor when the factor is one of upstream's levels; below 100 % it is cleared and the early window starts
//    at 100 % until it joins.
import type { BrowserWindow } from "electron"
import { ZOOM_LEVEL_KEY } from "@opencode/desktop/src/main/storage/keys"
import { getStore } from "@opencode/desktop/src/main/storage/store"
import { OwnIpc } from "../preload/own-api"
import { clampZoom, earlyZoomLevel, stepZoom } from "../shared/zoom"

export const ZOOM_KEY = "ownZoomFactor"

/** Joined windows, each with what its appearance does after a zoom change (overlay height, WindowZoomChanged). */
const windows = new Map<BrowserWindow, () => void>()

export function zoomFactor() {
  return clampZoom(getStore().get(ZOOM_KEY))
}

export function joinZoom(win: BrowserWindow, applied: () => void) {
  windows.set(win, applied)
  win.once("closed", () => windows.delete(win))
  win.webContents.on("did-navigate", () => apply(win, zoomFactor()))
  apply(win, zoomFactor())
}

/** Applies `factor` (clamped) to every joined window, announces it and keeps it; answers the factor applied. */
export function setZoom(factor: unknown) {
  const next = clampZoom(factor)
  for (const win of windows.keys()) {
    apply(win, next)
    if (!win.isDestroyed()) win.webContents.send(OwnIpc.zoomChanged, next)
  }
  const store = getStore()
  if (store.get(ZOOM_KEY) === next) return next
  try {
    store.set(ZOOM_KEY, next)
  } catch {
    // The store takes the value in memory before it writes the file: this run keeps it, the next start may not.
  }
  return next
}

/** Keeps upstream's saved level equal to the kept factor before the early window reads it. */
export function prepareEarlyZoom() {
  const store = getStore()
  const level = earlyZoomLevel(zoomFactor())
  if (store.get(ZOOM_LEVEL_KEY) === level) return
  try {
    if (level === undefined) store.delete(ZOOM_LEVEL_KEY)
    else store.set(ZOOM_LEVEL_KEY, level)
  } catch {
    // The store takes the value in memory before it writes the file, so the early window still gets it.
  }
}

export function stepWindowZoom(direction: "in" | "out") {
  return setZoom(stepZoom(zoomFactor(), direction))
}

function apply(win: BrowserWindow, factor: number) {
  if (win.isDestroyed()) return
  const contents = win.webContents
  if (Math.abs(contents.getZoomFactor() - factor) > 1e-6) contents.setZoomFactor(factor)
  windows.get(win)?.()
}

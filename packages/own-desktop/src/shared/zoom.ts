// Window zoom levels (05 §7.9): Chrome's steps from 50 to 200 %. Shared by main (the stored factor, Ctrl+wheel and
// the shortcuts' steps) and own-web's desktop host (the zoom control's ends). Pure: no Electron.

/** Chrome's zoom levels between 50 and 200 % (1 = 100 %), ascending. */
export const ZOOM_LEVELS: readonly number[] = [0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** Factors this close are the same level (Chromium hands 1.1 back as 1.1000000000000003). */
const SAME = 0.005

/** A requested or stored factor within 50–200 %; anything but a positive finite number is 100 %. */
export function clampZoom(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(ZOOM_LEVELS.at(-1)!, Math.max(ZOOM_LEVELS[0]!, value))
}

/**
 * The next level above (`in`) or below (`out`) `current`; a factor between two levels (one an older build stored)
 * moves to the next level in that direction. At either end it stays at the end.
 */
export function stepZoom(current: number, direction: "in" | "out") {
  const next =
    direction === "in"
      ? ZOOM_LEVELS.find((level) => level > current + SAME)
      : ZOOM_LEVELS.findLast((level) => level < current - SAME)
  return next ?? clampZoom(current)
}

/**
 * Upstream's saved level that starts its early window at `factor` (`desktopZoomLevels`, Chrome's levels from 50 to
 * 200 % since v2.2.6, written to two decimals: 0.67), or none for a factor between levels (the early window then
 * starts at 100 % until it joins).
 */
export function earlyZoomLevel(factor: number) {
  const level = ZOOM_LEVELS.find((item) => Math.abs(item - factor) < SAME)
  return level === undefined ? undefined : Math.round(level * 100) / 100
}

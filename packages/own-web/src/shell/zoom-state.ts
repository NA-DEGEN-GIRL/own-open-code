// Window zoom in one own-web window (03 §4.2.1, 05 §7.9): the state the zoom keys, the title bar's indicator and its
// bubble, and 설정 > 일반 `화면 크기` share, over `host.window.zoom`. Only hosts that zoom their own windows have it
// (desktop); the web and the phone leave zoom to the browser and the OS, so none of this runs there.
//  - The factor follows every change the host announces: this window's keys and controls, Ctrl+wheel, other windows.
//  - The bubble (`−  110%  +  초기화(100%)`) opens from the indicator and stays until dismissed (`open`), or shows
//    for FLASH_MS after a change (`flash`, like a browser's zoom bubble), longer while the pointer or the focus is in
//    it. Changes asked with `quiet` (the settings row shows its own value) do not flash it, nor do changes while the
//    page is hidden.
import { createRoot, createSignal } from "solid-js"
import type { HostZoom } from "@/host/types"

export const FLASH_MS = 1_500

/** Factors this close are the same level (Chromium hands 1.1 back as 1.1000000000000003). */
const SAME = 0.005

export type ZoomBubble = "closed" | "flash" | "open"

export interface ZoomState {
  readonly levels: readonly number[]
  factor(): number
  bubble(): ZoomBubble
  atMin(): boolean
  atMax(): boolean
  /** 100 %: no indicator, nothing to reset. */
  atDefault(): boolean
  step(direction: "in" | "out", options?: { readonly quiet?: boolean }): void
  reset(options?: { readonly quiet?: boolean }): void
  open(): void
  close(): void
  /** The pointer or the focus came into (`true`) or left (`false`) the bubble: a flash stays while either is in it. */
  hold(on: boolean): void
}

/** `110%`. */
export function zoomPercent(factor: number) {
  return `${Math.round(factor * 100)}%`
}

const states = new WeakMap<HostZoom, ZoomState>()

/** The window's one state for the host's zoom (made on first use, alive as long as the page). */
export function zoomState(zoom: HostZoom) {
  const known = states.get(zoom)
  if (known) return known
  const made = createZoomState(zoom)
  states.set(zoom, made)
  return made
}

export function createZoomState(
  zoom: HostZoom,
  options: { readonly flashMs?: number; readonly visible?: () => boolean } = {},
): ZoomState {
  const flashMs = options.flashMs ?? FLASH_MS
  const visible = options.visible ?? (() => document.visibilityState !== "hidden")
  return createRoot(() => {
    const [factor, setFactor] = createSignal(1)
    const [bubble, setBubble] = createSignal<ZoomBubble>("closed")
    let quiet = 0
    let holds = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer =
        holds > 0 ? undefined : setTimeout(() => setBubble((mode) => (mode === "flash" ? "closed" : mode)), flashMs)
    }
    // Main announces a change before it answers the request that made it, so a quiet request is still counted here.
    zoom.onChange((next) => {
      setFactor(next)
      if (quiet > 0 || bubble() === "open" || !visible()) return
      setBubble("flash")
      later()
    })
    void zoom.get().then(setFactor, () => undefined)
    const request = (run: () => Promise<number>, ask?: { readonly quiet?: boolean }) => {
      if (ask?.quiet) quiet++
      void run()
        .then(setFactor, () => undefined)
        .finally(() => {
          if (ask?.quiet) quiet--
        })
    }
    return {
      levels: zoom.levels,
      factor,
      bubble,
      atMin: () => factor() <= zoom.levels[0]! + SAME,
      atMax: () => factor() >= zoom.levels.at(-1)! - SAME,
      atDefault: () => Math.abs(factor() - 1) < SAME,
      step: (direction, ask) => request(() => zoom.step(direction), ask),
      reset: (ask) => request(() => zoom.set(1), ask),
      open() {
        clearTimeout(timer)
        setBubble("open")
      },
      close() {
        clearTimeout(timer)
        holds = 0
        setBubble("closed")
      },
      hold(on) {
        holds = Math.max(0, holds + (on ? 1 : -1))
        if (bubble() === "flash") later()
      },
    }
  })
}

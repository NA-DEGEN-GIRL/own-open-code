// Geometry of the desktop title bar band (03 §4.2.1, 05 §7.1), mirrored on <html> for code that cannot use env():
//  - `data-wco-visible`: Windows draws its window buttons over the page (false in fullscreen, where it does not);
//  - `--own-wco-band-right`: width of the buttons' area at the right end, in CSS px;
//  - `--own-wco-band-height`: the band's height in CSS px;
//  - `data-wco-modal`: a <dialog> is open (toggle events, caught on <html>). titlebar.css used
//    `:root:has(dialog[open])` for this; Blink checks a `:has()` on the root on every DOM insertion and then restyles
//    every element carrying a feature of any `:has()` rule (tabs.css adds `[data-slot]`): about 550 elements, 35 ms, on
//    each new block of a streaming answer (SR 2026-10-20).
// Main sizes the overlay to max(44, round(44 × zoom)) device-independent px (windows/defaults.ts titlebarOverlay), so
// in CSS px the band is 44 at zoom ≥ 1 and taller below 1 (44 / 0.8 = 55 at 80 %); the buttons' width scales the other
// way. The CSS reads env(titlebar-area-*) and follows by itself. These values are recomputed on `geometrychange`,
// window resize and zoom: a zoom below 1 changes CSS px without any DIP change, so no `geometrychange` may come.
export interface TitlebarOverlay extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

export interface BandGeometry {
  readonly visible: boolean
  /** CSS px between the band's usable area and the window's right edge (the window buttons). */
  readonly right: number
  /** CSS px; 0 when not visible. */
  readonly height: number
}

export function bandGeometry(
  overlay: Pick<TitlebarOverlay, "visible" | "getTitlebarAreaRect">,
  viewport: number,
): BandGeometry {
  if (!overlay.visible) return { visible: false, right: 0, height: 0 }
  const rect = overlay.getTitlebarAreaRect()
  // Before the first layout the rect can be empty: visible, but nothing to reserve yet.
  if (!(rect.width > 0)) return { visible: true, right: 0, height: Math.max(0, Math.round(rect.height)) }
  return {
    visible: true,
    right: Math.max(0, Math.round(viewport - rect.x - rect.width)),
    height: Math.round(rect.height),
  }
}

export interface BandWatch {
  readonly overlay: TitlebarOverlay
  readonly root: HTMLElement
  readonly view: Pick<Window, "innerWidth" | "addEventListener" | "removeEventListener">
  /** `host.window.zoom.onChange` (the desktop host reports its own sets as well as Ctrl+wheel). */
  readonly onZoom?: (listener: () => void) => () => void
  /** Next frame: the overlay's new size lands after main handles the zoom. */
  readonly frame?: (callback: () => void) => () => void
}

/** Keeps <html> in step with the band until the returned function is called, which also clears what it set. */
export function watchBand(input: BandWatch): () => void {
  const { overlay, root, view } = input
  const apply = () => {
    const geometry = bandGeometry(overlay, view.innerWidth)
    root.toggleAttribute("data-wco-visible", geometry.visible)
    root.style.setProperty("--own-wco-band-right", `${geometry.right}px`)
    if (geometry.height > 0) root.style.setProperty("--own-wco-band-height", `${geometry.height}px`)
    else root.style.removeProperty("--own-wco-band-height")
  }
  const frame = input.frame ?? nextFrame
  let cancel: (() => void) | undefined
  const later = () => {
    if (cancel) return
    cancel = frame(() => {
      cancel = undefined
      apply()
    })
  }
  // A popover's or <details>' toggle asks again too: cheap, and no type check in the first chunk (PF5).
  const modal = () => root.toggleAttribute("data-wco-modal", !!root.querySelector("dialog[open]"))
  apply()
  overlay.addEventListener("geometrychange", apply)
  view.addEventListener("resize", later)
  // A dialog's toggle event does not bubble; the capture phase on <html> sees every one.
  root.addEventListener("toggle", modal, true)
  const offZoom = input.onZoom?.(later)
  return () => {
    overlay.removeEventListener("geometrychange", apply)
    view.removeEventListener("resize", later)
    root.removeEventListener("toggle", modal, true)
    offZoom?.()
    cancel?.()
    root.removeAttribute("data-wco-visible")
    root.removeAttribute("data-wco-modal")
    root.style.removeProperty("--own-wco-band-right")
    root.style.removeProperty("--own-wco-band-height")
  }
}

function nextFrame(callback: () => void) {
  const id = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(id)
}

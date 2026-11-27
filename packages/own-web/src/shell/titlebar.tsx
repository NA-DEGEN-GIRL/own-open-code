// Desktop title bar band (03 §4.2.1, 05 §7.1): the frameless window's top 44 px (× zoom) where Windows draws the
// window controls (WCO). The session header and the sidebar head already sit in the band (shell.css `[data-wco]`,
// sidebar/index.tsx); this module adds what depends on the whole row:
//  - titlebar.css: the work panel's head joins the band when it reaches the window buttons (drag area, band height,
//    the buttons' area left empty, tabs that shrink instead of scrolling out of sight), the session header stops
//    reserving that area when the pushed panel covers it, every control in the band is `no-drag`, and layers that
//    float over the band (dialogs, menus, popovers) are not drag areas, so their clicks reach the page;
//  - TitlebarBand: mirrors `navigator.windowControlsOverlay` on <html> (titlebar-band.ts) — `data-wco-visible`
//    (false in fullscreen, where the OS hides the buttons), `--own-wco-band-right` and `--own-wco-band-height` in CSS
//    pixels, recomputed on geometry changes, resize and zoom.
// Hosts without the capability render nothing and get no attributes (web: a normal 52 px header).
import "./titlebar.css"
import { onCleanup } from "solid-js"
import { useHost } from "@/host"
import { watchBand, type TitlebarOverlay } from "./titlebar-band"

export function TitlebarBand() {
  const host = useHost()
  if (!host.capabilities.windowControlsOverlay) return null
  const overlay = (navigator as Navigator & { windowControlsOverlay?: TitlebarOverlay }).windowControlsOverlay
  if (!overlay) return null
  const zoom = host.window?.zoom
  onCleanup(
    watchBand({
      overlay,
      root: document.documentElement,
      view: window,
      onZoom: zoom ? (listener) => zoom.onChange(() => listener()) : undefined,
    }),
  )
  return null
}

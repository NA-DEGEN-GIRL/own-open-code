// A display surface for a pane tab that a paired device watches while the app window cannot give it one (05 §8.10).
// Chromium draws a page only once its view was shown in a shown window: after that it keeps drawing for a screencast
// although the view, or the whole window, is hidden. A tab the agent opened while the window sat in the tray (or was
// minimized) never was: its screencast sends nothing, a screenshot never answers and `capturePage` rejects with
// "Current display surface not available for capture" (measured on Electron 44, Chromium 152; in a shown window a
// screenshot is enough, which the bridge takes anyway). Such a tab's view is lent to a capture window here: a bare
// window off the screen, shown without focus, outside the taskbar, that nothing can activate. The view goes back to
// its place among the app window's views the moment that window is shown or restored (before the PC user can look at
// it), or when the bridge is done with the page; a view put back into a still hidden window stops drawing again,
// which is why it stays lent that long. The capture window exists only while a view is lent.
import { BrowserWindow, type WebContents, type WebContentsView } from "electron"
import log from "electron-log/main.js"

const logger = log.scope("own")

interface Lent {
  readonly win: BrowserWindow
  readonly back: () => void
}

const lent = new Map<WebContentsView, Lent>()
let capture: BrowserWindow | undefined

/** Lends `view` to the capture window unless it is on screen in `win` (a view the PC user sees is never taken). */
export function lendView(view: WebContentsView, win: BrowserWindow) {
  if (lent.has(view) || win.isDestroyed() || view.webContents.isDestroyed()) return
  if (view.getVisible() && win.isVisible() && !win.isMinimized()) return
  const bounds = view.getBounds()
  // Its place in the stacking order: the embed's corner layers sit above it.
  const index = win.contentView.children.indexOf(view)
  if (index < 0) return
  capture ??= new BrowserWindow({
    x: -32000,
    y: -32000,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
  })
  const host = capture
  host.setPosition(-32000, -32000)
  host.setContentSize(
    Math.max(bounds.width, host.getContentSize()[0] ?? 0),
    Math.max(bounds.height, host.getContentSize()[1] ?? 0),
  )
  if (!host.isVisible()) host.showInactive()
  const back = () => {
    if (!lent.delete(view)) return
    win.off("show", back)
    win.off("restore", back)
    win.off("closed", back)
    if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
      // Hidden until the window's own layout places it again, as a tab that never was on screen.
      view.setVisible(false)
      win.contentView.addChildView(view, Math.min(index, win.contentView.children.length))
      view.setBounds(bounds)
    }
    logger.info("remote browser: tab view returned from the capture window", { left: lent.size })
    if (lent.size) return
    capture = undefined
    if (!host.isDestroyed()) host.destroy()
  }
  lent.set(view, { win, back })
  win.once("show", back)
  win.once("restore", back)
  win.once("closed", back)
  logger.info("remote browser: tab view lent to the capture window", { lent: lent.size })
  host.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
  view.setVisible(true)
}

/** The bridge is done with the page: a lent view goes back to its window. */
export function returnView(view: WebContentsView) {
  lent.get(view)?.back()
}

/** The app window a lent tab page belongs to, and its view (own-browser.ts `hostView` looks here first). */
export function lentHost(source: WebContents) {
  for (const [view, entry] of lent) if (view.webContents === source) return { win: entry.win, view }
  return undefined
}

// The Android app's calls into the page (08 §4.2, MUX 2026-11-06), a lazy chunk loaded only under the app's user agent
// (` OwnOpenCodeApp/1 (android)`). The shell calls `window.ownApp` with `evaluateJavascript`; the page never calls the
// shell (the app adds no JavaScript interface, 08 §3.4), so nothing here can reach native code.
// - `back()`: the system back button closes what is open on top (a sheet, menu or dialog, then the drawer or the
//   overlaid work panel) through its own Escape handling and answers true; with nothing open it answers false and the
//   shell goes back in the page's history, or leaves the PC screen.
// - `theme()`: the page's color scheme and background, for the status and navigation bars.

/** Open surfaces that close on Escape: dialogs, menus and popovers (closed ones stay in the DOM, hidden). */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open]'

export interface AppTheme {
  readonly scheme: "light" | "dark"
  /** The page's background as CSS computes it (`rgb(23, 24, 26)`). */
  readonly background: string
}

export interface AppBridge {
  back(): boolean
  theme(): AppTheme
}

declare global {
  interface Window {
    ownApp?: AppBridge
  }
}

export function installAppBridge() {
  window.ownApp = { back, theme }
}

export function back() {
  const open = topOverlay()
  if (!open) return closeDrawer()
  const focused = document.activeElement
  const target = focused instanceof HTMLElement && open.contains(focused) ? focused : open
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))
  // A native popover (`popover="auto"`, the folder picker) or `<dialog>` closes only on a trusted Escape: close it
  // the way the browser would (seen on the G7: back left the picker open and went back a screen).
  if (visible(open) && open.hasAttribute("popover") && open.matches(":popover-open")) open.hidePopover()
  if (visible(open) && open instanceof HTMLDialogElement) open.close()
  // Solid updates synchronously: an overlay that ignored Escape is still there, so back leaves it to the shell
  // instead of swallowing every press.
  return !visible(open)
}

export function theme(): AppTheme {
  const root = document.documentElement
  const scheme = root.dataset.colorScheme === "light" ? "light" : "dark"
  const app = document.querySelector<HTMLElement>(".own-app") ?? document.body
  return { scheme, background: getComputedStyle(app).backgroundColor }
}

/**
 * The drawer (the conversation list on a tablet or an unfolded Fold8 upright) or the overlaid work panel: they are not
 * dialogs, so back went back a page and left them open. The shell closes them on Escape (app-shell.tsx) while its scrim
 * is up.
 */
function closeDrawer() {
  if (!document.querySelector(".own-app > .own-scrim")) return false
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }))
  return true
}

/** The last open overlay in document order: popovers and dialogs are appended after what opened them. */
function topOverlay() {
  return [...document.querySelectorAll<HTMLElement>(OVERLAYS)].filter(visible).at(-1)
}

function visible(element: HTMLElement) {
  if (!element.isConnected) return false
  if (typeof element.checkVisibility === "function") return element.checkVisibility()
  return element.getClientRects().length > 0
}

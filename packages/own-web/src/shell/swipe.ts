// Swipe gestures on touch screens (03 §4.2.4, swipe pass 2026-11-20). Before, the phone had only its back button and
// the header's `‹` / `☰` to reach the conversation list. A lazy chunk, loaded on touch screens only (app-shell.tsx
// through ./touch.ts); a mouse never starts one, so desktop behaviour is unchanged.
//
// - The conversation, swiped right: the phone's conversation list (what `‹` opens) or, where the list is a drawer (an
//   unfolded Fold8 upright, a tablet), the drawer. The list follows the finger; letting go past 40 % of the way, or
//   with a flick, finishes the move through the same control a tap uses, otherwise it springs back. Beside the
//   conversation (840 px and wider) there is no drawer and no swipe.
// - The phone's list, swiped left: back to the conversation it was opened from.
// - An open drawer swiped left, or the work panel swiped right, closes it (as the scrim and Esc do).
// - A settings page, swiped right: back to the settings list (`← 설정`).
// - The model sheet, dragged down by its head or from a list scrolled to its top, closes.
//
// The first 10 px decide the axis: a vertical move is the page's scroll and never becomes a swipe. A touch that starts
// in a field, a slider, selected text, something that scrolls sideways (a code block, a diff, a table, the tab strip) or
// a surface marked `data-gesture-lock` (the browser view) is that element's. Scrolling stays the browser's own
// (`touch-action: pan-y` on the swipe surfaces, shell.css), and every listener here is passive.

/** The distance that decides the axis (and below which nothing moves). */
export const SLOP = 10

export function axisOf(dx: number, dy: number) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return undefined
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y"
}

/** Whether letting go finishes the move: 40 % of its way, or a flick of 0.4 px/ms that went at least 24 px. */
export function finishes(distance: number, velocity: number, size: number) {
  if (distance >= size * 0.4) return true
  return velocity >= 0.4 && distance >= 24
}

/** The speed of the last 100 ms of samples (px/ms, along the axis; positive in the move's direction). */
export function velocityOf(samples: readonly { readonly t: number; readonly at: number }[]) {
  const last = samples.at(-1)
  if (!last) return 0
  const first = samples.find((sample) => last.t - sample.t <= 100) ?? last
  if (last.t === first.t) return 0
  return (last.at - first.at) / (last.t - first.t)
}

interface Move {
  /** The axis and the sign of a finishing move along it. */
  readonly vertical: boolean
  readonly sign: 1 | -1
  /** The way to go, in px. */
  readonly size: number
  /** Draws the move at `offset` (0 … size). */
  readonly draw: (offset: number) => void
  /** Animates to the end (`true`, then finishes the move through its control) or back to the start. */
  readonly settle: (finish: boolean) => void
}

const SETTLE_MS = 180

export function swipes() {
  const app = document.querySelector<HTMLElement>(".own-app")
  if (!app) return () => {}
  // Touch-action on the swipe surfaces (shell.css); the model sheet may sit outside the app's element.
  document.documentElement.dataset.swipe = ""
  const still = matchMedia("(prefers-reduced-motion: reduce)")
  // The conversation the phone's list goes back to: the last one a touch began in.
  let last: string | undefined
  let gesture:
    | {
        readonly id: number
        readonly x: number
        readonly y: number
        readonly move: Move
        /** Began on the scrim: a tap there closes the drawer or panel here (see `up`). */
        readonly scrim: boolean
        locked: boolean
        offset: number
        samples: { t: number; at: number }[]
      }
    | undefined

  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary || gesture) return
    if (app.dataset.phoneView === "session") last = location.pathname
    const target = event.target
    if (!(target instanceof Element)) return
    const move = pick(app, target, last, still.matches)
    if (!move) return
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      move,
      scrim: !!target.closest(".own-scrim"),
      locked: false,
      offset: 0,
      samples: [],
    }
  }
  const moved = (event: PointerEvent) => {
    const current = gesture
    if (!current || event.pointerId !== current.id) return
    // The touch became a drag of a list header (sidebar/reorder.ts, a long press).
    if (!current.locked && document.documentElement.hasAttribute("data-reordering")) return void (gesture = undefined)
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!current.locked) {
      const axis = axisOf(dx, dy)
      if (!axis) return
      // The other axis, or the wrong way: the page's (a scroll), not a swipe.
      const along = current.move.vertical ? dy : dx
      if ((axis === "y") !== current.move.vertical || along * current.move.sign <= 0) return void (gesture = undefined)
      current.locked = true
    }
    const along = (current.move.vertical ? dy : dx) * current.move.sign
    current.offset = Math.max(0, Math.min(current.move.size, along))
    current.samples.push({ t: event.timeStamp, at: along })
    if (current.samples.length > 12) current.samples.shift()
    current.move.draw(current.offset)
  }
  const up = (event: PointerEvent) => {
    const current = gesture
    if (!current || event.pointerId !== current.id) return
    gesture = undefined
    // A tap on the scrim closes what it covers here, not only through its click: Chromium turns a tap that lands while
    // the page still flings (the few px of vertical drift of the swipe that opened the drawer start one) into a
    // fling stop and sends no click, so the drawer stayed open (swipe.spec.ts, 2.2.6-own.12's tier, RL21-T). The
    // click, when it comes, finds nothing open.
    if (!current.locked) return void (current.scrim && event.type === "pointerup" && closeOverlays())
    current.move.settle(
      event.type === "pointerup" && finishes(current.offset, velocityOf(current.samples), current.move.size),
    )
  }
  // The sheet's lists say whether they are at their top (their touch-action, shell.css).
  const scrolled = (event: Event) => {
    const list = event.target
    if (!(list instanceof HTMLElement) || !list.matches(".own-sw-sheet .own-sw-col")) return
    list.toggleAttribute("data-scrolled", list.scrollTop > 0)
  }
  const options = { capture: true, passive: true }
  document.addEventListener("scroll", scrolled, options)
  document.addEventListener("pointerdown", down, options)
  document.addEventListener("pointermove", moved, options)
  document.addEventListener("pointerup", up, options)
  document.addEventListener("pointercancel", up, options)
  return () => {
    delete document.documentElement.dataset.swipe
    document.removeEventListener("scroll", scrolled, options)
    document.removeEventListener("pointerdown", down, options)
    document.removeEventListener("pointermove", moved, options)
    document.removeEventListener("pointerup", up, options)
    document.removeEventListener("pointercancel", up, options)
  }
}

/** The move a touch on `target` can start, if any. */
function pick(app: HTMLElement, target: Element, last: string | undefined, still: boolean): Move | undefined {
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider']")) return
  // A surface that sends its touches elsewhere (the browser view's page on the PC, 05 §8.10): every touch is its own.
  if (target.closest("[data-gesture-lock]")) return
  if (sideways(target)) return
  const selection = getSelection()
  if (selection && !selection.isCollapsed) return
  const sheet = target.closest<HTMLElement>(".own-sw-sheet")
  // From the sheet's lists only while they are at their top: then the browser leaves a downward drag to us
  // (`touch-action: pan-down` until they scroll, shell.css).
  if (sheet) return target.closest(".own-sw-col")?.scrollTop ? undefined : sheetMove(sheet, still)
  // Menus, popovers and dialogs keep their touches (a tap outside closes them).
  if (document.querySelector("[popover]:popover-open, dialog[open], [role='dialog'][aria-modal='true']")) return
  const sidebar = app.querySelector<HTMLElement>(":scope > .own-sidebar")
  const panel = app.querySelector<HTMLElement>(":scope > .own-panel")
  const main = app.querySelector<HTMLElement>(":scope > .own-main")
  if (!sidebar || !panel || !main) return
  const scrim = app.querySelector<HTMLElement>(":scope > .own-scrim")
  const mode = app.dataset.sidebarMode
  if (app.dataset.panel === "open" && app.dataset.panelMode !== "push")
    return target.closest(".own-panel, .own-scrim") ? slide(panel, 1, scrim, still, true, closeOverlays) : undefined
  if (mode === "drawer" && app.dataset.sidebar === "open")
    return target.closest(".own-sidebar, .own-scrim") ? slide(sidebar, -1, scrim, still, true, closeOverlays) : undefined
  if (mode === "list" && app.dataset.phoneView === "list") {
    const row = last ? listRow(sidebar, last) : undefined
    return row ? listMove(sidebar, still, () => row.click()) : undefined
  }
  if (!target.closest(".own-main")) return
  const back = visible(app.querySelector<HTMLElement>("[data-testid='settings-back']"))
  if (back) return pageMove(main, still, () => back.click())
  const home = visible(app.querySelector<HTMLElement>("[data-testid='header-back']"))
  if (mode === "list" && home) return revealList(sidebar, still, () => home.click())
  const toggle = visible(app.querySelector<HTMLElement>("[data-testid='sidebar-toggle']"))
  if (mode === "drawer" && toggle) return slide(sidebar, 1, null, still, false, () => toggle.click())
  return
}

/** Inside something that scrolls sideways now (a code block, a diff, a table, a strip of tabs). */
function sideways(target: Element) {
  for (let element: Element | null = target; element && !element.classList.contains("own-app"); element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth) continue
    const overflow = getComputedStyle(element).overflowX
    if (overflow === "auto" || overflow === "scroll") return true
  }
  return false
}

function visible(element: HTMLElement | null) {
  return element?.checkVisibility() ? element : undefined
}

function listRow(sidebar: HTMLElement, path: string) {
  const id = /\/s\/([^/?#]+)/.exec(path)?.[1]
  if (!id) return undefined
  return sidebar.querySelector<HTMLElement>(`[data-testid='session-row'][data-session-id='${CSS.escape(id)}']`) ?? undefined
}

/** Closes the open drawer or overlaid panel the way Esc does (app-shell.tsx). */
function closeOverlays() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }))
}

/**
 * A drawer or panel sliding along x: `sign` 1 moves it right. `open` says it starts on screen (and slides off it); a
 * closed drawer starts off screen at its own width (shell.css). The scrim fades with it.
 */
function slide(
  element: HTMLElement,
  sign: 1 | -1,
  scrim: HTMLElement | null,
  still: boolean,
  open: boolean,
  finish: () => void,
): Move {
  const size = element.offsetWidth
  // Closed, the drawer is translated by -100 % (from the left); open, by nothing.
  const at = (offset: number) => (open ? offset * sign : offset - size)
  return {
    vertical: false,
    sign,
    size,
    draw: (offset) => {
      element.style.transition = "none"
      element.style.transform = `translateX(${at(offset)}px)`
      if (!open) element.style.boxShadow = "var(--own-shadow-float)"
      if (scrim) scrim.style.opacity = String(1 - offset / size)
    },
    settle: (end) =>
      animate(element, still, `translateX(${at(end ? size : 0)}px)`, scrim, end ? "0" : "1", () => {
        if (end) finish()
        // The class state now draws the same place: the stylesheet has the element back.
        requestAnimationFrame(() => clear(element, scrim))
      }),
  }
}

/** The phone's list over the conversation from the left, as the screen `‹` opens. */
function revealList(sidebar: HTMLElement, still: boolean, finish: () => void): Move {
  const size = innerWidth
  return {
    vertical: false,
    sign: 1,
    size,
    draw: (offset) => {
      // In the conversation the list has no column (shell.css): it lies over the conversation while it moves.
      Object.assign(sidebar.style, {
        position: "fixed",
        inset: "0 auto 0 0",
        width: "100vw",
        zIndex: "45",
        visibility: "visible",
        boxShadow: "var(--own-shadow-float)",
        transition: "none",
        transform: `translateX(${offset - size}px)`,
      })
    },
    settle: (end) =>
      animate(sidebar, still, `translateX(${end ? 0 : -size}px)`, null, "", () => {
        if (end) finish()
        requestAnimationFrame(() => clear(sidebar))
      }),
  }
}

/**
 * The phone's list sliding off to the left. Under it is the app's background, not the conversation: in the list's
 * view the main area holds the home screen (the conversation comes back with the route).
 */
function listMove(sidebar: HTMLElement, still: boolean, finish: () => void): Move {
  const size = innerWidth
  return {
    vertical: false,
    sign: -1,
    size,
    draw: (offset) => {
      Object.assign(sidebar.style, {
        boxShadow: "var(--own-shadow-float)",
        transition: "none",
        transform: `translateX(${-offset}px)`,
      })
    },
    settle: (end) =>
      animate(sidebar, still, `translateX(${end ? -size : 0}px)`, null, "", () => {
        if (end) finish()
        requestAnimationFrame(() => clear(sidebar))
      }),
  }
}

/** A settings page sliding right before `← 설정` takes it back to the list. */
function pageMove(main: HTMLElement, still: boolean, finish: () => void): Move {
  const page = main.querySelector<HTMLElement>(".own-page") ?? main
  const size = page.offsetWidth
  return {
    vertical: false,
    sign: 1,
    size,
    draw: (offset) => {
      page.style.transition = "none"
      page.style.transform = `translateX(${offset}px)`
      page.style.opacity = String(1 - (offset / size) * 0.6)
    },
    settle: (end) =>
      animate(page, still, `translateX(${end ? size : 0}px)`, null, "", () => {
        if (end) finish()
        requestAnimationFrame(() => clear(page))
      }),
  }
}

/** The model sheet dragged down; it closes through its own Esc (switcher/popover.tsx). */
function sheetMove(sheet: HTMLElement, still: boolean): Move {
  const size = sheet.offsetHeight
  return {
    vertical: true,
    sign: 1,
    size,
    draw: (offset) => {
      sheet.style.transition = "none"
      sheet.style.transform = `translateY(${offset}px)`
    },
    settle: (end) =>
      animate(sheet, still, `translateY(${end ? size : 0}px)`, null, "", () => {
        if (end) sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }))
        requestAnimationFrame(() => clear(sheet))
      }),
  }
}

/** Moves `element` to `transform` (at once when the system asks for less motion), then runs `done`. */
function animate(
  element: HTMLElement,
  still: boolean,
  transform: string,
  scrim: HTMLElement | null,
  opacity: string,
  done: () => void,
) {
  element.style.transition = still ? "none" : `transform ${SETTLE_MS}ms ease-out`
  element.style.transform = transform
  if (scrim) {
    scrim.style.transition = still ? "none" : `opacity ${SETTLE_MS}ms ease-out`
    scrim.style.opacity = opacity
  }
  if (still) return done()
  // transitionend does not come when nothing moved (already there): a timer instead.
  setTimeout(done, SETTLE_MS + 20)
}

function clear(element: HTMLElement, scrim?: HTMLElement | null) {
  for (const name of ["transition", "transform", "box-shadow", "position", "inset", "width", "z-index", "visibility", "opacity"])
    element.style.removeProperty(name)
  scrim?.style.removeProperty("opacity")
  scrim?.style.removeProperty("transition")
}

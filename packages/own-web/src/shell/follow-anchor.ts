// Open menus stay with their button and inside the window (Fold8 pass, 2026-11-20). Unfolding a Galaxy Z Fold8 with
// the conversation `⋯` open left the menu where the folded header had its button, over the conversation list, and on
// the Fold8's 670 px cover that menu ran 15 px past the bottom. Each menu places itself once as it opens
// (servers/menu.tsx, limits/kit.tsx: fixed `left` and `top`, measured before all of its items are in); this keeps the
// side and the distance it chose from the button that opens it (`aria-controls`), keeps it inside the window, scrolling
// what does not fit, whenever the window or the menu changes size, and closes it when the new layout hides that button.
interface Offset {
  readonly button: HTMLElement
  readonly x: number
  /** Below the button: from the button's top to the menu's top; above it: from the menu's bottom to the button's top. */
  readonly y: number
  readonly below: boolean
}

export function followAnchors() {
  const offsets = new Map<HTMLElement, Offset>()
  const fit = (menu: HTMLElement) => {
    const offset = offsets.get(menu)
    if (!offset) return
    if (!offset.button.checkVisibility()) return menu.hidePopover()
    const from = offset.button.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(from.left + offset.x, innerWidth - menu.offsetWidth - 8))}px`
    // Its room on its side of the button; the menu scrolls inside it ([popover][role=menu] in shell.css).
    const top = offset.below ? Math.max(8, from.top + offset.y) : 8
    const bottom = offset.below ? innerHeight - 8 : Math.min(innerHeight - 8, from.top - offset.y)
    menu.style.maxHeight = `${Math.max(0, bottom - top)}px`
    menu.style.top = `${offset.below ? top : Math.max(8, bottom - menu.offsetHeight)}px`
  }
  const observer = new ResizeObserver((entries) => entries.forEach((entry) => fit(entry.target as HTMLElement)))
  const toggle = (event: Event) => {
    const menu = event.target
    if (!(menu instanceof HTMLElement) || !menu.id) return
    if ((event as ToggleEvent).newState !== "open") {
      offsets.delete(menu)
      observer.unobserve(menu)
      menu.style.maxHeight = ""
      return
    }
    // A listener added now runs in this same dispatch, after the menu's own one has placed it: a frame later the
    // window may already have its new size.
    menu.addEventListener(
      "toggle",
      () => {
        const button = document.querySelector<HTMLElement>(`[aria-controls="${menu.id}"]`)
        if (!button || !menu.style.left) return
        const from = button.getBoundingClientRect()
        const at = menu.getBoundingClientRect()
        const below = at.top >= from.top
        offsets.set(menu, {
          button,
          x: at.left - from.left,
          y: below ? at.top - from.top : from.top - at.bottom,
          below,
        })
        observer.observe(menu)
      },
      { once: true },
    )
  }
  const resize = () => requestAnimationFrame(() => offsets.forEach((_, menu) => fit(menu)))
  // `toggle` does not bubble: caught on its way down.
  addEventListener("toggle", toggle, true)
  addEventListener("resize", resize)
  return () => {
    removeEventListener("toggle", toggle, true)
    removeEventListener("resize", resize)
    observer.disconnect()
  }
}

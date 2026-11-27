/**
 * The composer's menus, cards and popovers open beside their button (composer.css `.own-cp-menu`, `.own-cp-pop`). As
 * wide as their longest line since 2026-10-18, one that would pass an edge of the window (a phone, a narrow window:
 * the layout audit found the speed menu 17 px out on the right and the context popover 52 px out on the left at
 * 375 px) moves sideways until it fits, 8 px from the edges.
 */
export function fitMenu(menu: HTMLElement | undefined) {
  if (!menu) return
  menu.style.removeProperty("translate")
  const rect = menu.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  const shift =
    rect.left < 8 ? 8 - rect.left : rect.right > width - 8 ? Math.max(8 - rect.left, width - 8 - rect.right) : 0
  if (shift !== 0) menu.style.translate = `${Math.round(shift)}px 0`
}

/**
 * The limit in `모델 @ 계정` (03 §4.6, §7.2) folds by the room the toolbar has, not by the composer's width (UX
 * 2026-10-27: a 720–799 px band hid it at 1024 px and at 1440 px with the work panel closed, the default desktop
 * layouts, where nothing else shows it). The steps, each kept only when the one before does not fit:
 *   0. the density's own form: a bar and `남음 58%`, at 아주 간단히 the ring and `58%`;
 *   1. the ring and its number;
 *   2. the same, with the tokens beside the context ring giving their room;
 *   3. the ring alone (composer.css): its value is still read out, so the limit never leaves the toolbar.
 * A step fits when nothing in `모델 @ 계정` is cut for room (the model in full, the account up to its own cap) and the
 * limit is not clipped. The new-conversation screen's two-row toolbar never folds: its second row has the room.
 * Each step is laid out and measured a frame after the toolbar resized or changed, so a fold never changes layout
 * inside the observer's own delivery; the fold's own changes are not watched.
 */
export type LimitFold = 0 | 1 | 2 | 3

const TRIES = [0, 1, 2] as const

export function watchLimitFit(bar: HTMLElement, apply: (fold: LimitFold) => void) {
  return watchFit(bar, () => apply(twoRows(bar) ? 0 : (TRIES.find((fold) => tryFold(bar, apply, fold)) ?? 3)))
}

/**
 * Runs `fit` a frame after `root` resized or its text or children changed, and once the fonts are in: a fit never
 * changes layout inside the observer's own delivery, and what the fit itself changes is taken back from the observer.
 * The header's give-way order uses it too (shell/header-fit.ts).
 */
export function watchFit(root: HTMLElement, fit: () => void) {
  let frame = 0
  const refit = () => {
    frame = 0
    fit()
    changes.takeRecords()
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(refit)
  }
  const sizes = new ResizeObserver(schedule)
  const changes = new MutationObserver(schedule)
  sizes.observe(root)
  changes.observe(root, { subtree: true, childList: true, characterData: true })
  void document.fonts.ready.then(schedule)
  return () => {
    sizes.disconnect()
    changes.disconnect()
    cancelAnimationFrame(frame)
  }
}

function tryFold(bar: HTMLElement, apply: (fold: LimitFold) => void, fold: LimitFold) {
  apply(fold)
  const button = bar.querySelector<HTMLElement>(".own-cp-switch")
  if (!button) return true
  const glance = button.querySelector<HTMLElement>(".own-glance")
  if (glance && glance.scrollWidth > glance.clientWidth) return false
  return ![...button.querySelectorAll<HTMLElement>(".own-cp-switch-label > [data-part]")].some(cut)
}

/**
 * Shortened for room, measured to the subpixel (a 0.03 px shortfall already draws the ellipsis, and `scrollWidth`
 * rounds it away): a visually hidden part (the phone's model) and an account longer than its cap do not count. The
 * header's running-on pill is measured the same way (shell/header-fit.ts).
 */
export function cut(part: HTMLElement) {
  const style = getComputedStyle(part)
  if (style.position === "absolute") return false
  const box = part.getBoundingClientRect().width
  const text = document.createRange()
  text.selectNodeContents(part)
  if (text.getBoundingClientRect().width <= box + 0.01) return false
  // The model has no cap (`none` parses to NaN): any shortening counts.
  const cap = parseFloat(style.maxWidth)
  return Number.isNaN(cap) || box + 0.5 < cap
}

/** The new-conversation screen from 600 px: where on the first row, who and how on the second (composer.css). */
function twoRows(bar: HTMLElement) {
  return bar.querySelector<HTMLElement>(".own-cp-break")?.offsetParent != null
}

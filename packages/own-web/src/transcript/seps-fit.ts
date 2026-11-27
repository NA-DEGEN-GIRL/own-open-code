// A marker's pill around a wrapped styles/seps.css line ends where its widest line does (merge round 7). A wrapped line
// box takes the whole width it was offered, so a switch marker that wrapped at 1440 px left about 250 px of empty pill
// after its first line; CSS cannot size a wrapped box to its lines, so the width is measured and set here.

/**
 * Fits `seps` (an `.own-seps` box) to its widest line, again whenever the row around it (`row`) or the parts change
 * size. One line, or lines as wide as the box, set nothing. The work runs in the next frame, never inside the
 * observer's callback. Returns the cleanup.
 */
export function fitSeps(seps: HTMLElement, row: HTMLElement) {
  let frame = 0
  const fit = () => {
    frame = 0
    const inner = seps.firstElementChild
    if (!inner) return
    seps.style.width = ""
    const box = seps.getBoundingClientRect()
    const right = Math.max(box.left, ...Array.from(inner.children, (part) => part.getBoundingClientRect().right))
    if (box.right - right > 1) seps.style.width = `${Math.ceil(right - box.left) + 1}px`
  }
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(fit)
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(row)
  if (seps.firstElementChild) observer.observe(seps.firstElementChild)
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  }
}

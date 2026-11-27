// Find highlights and scrolling over the mounted rows (03 §19.13). Highlights use the CSS Custom Highlight API: no
// DOM is changed, so virtual rows, streaming markdown and IME input are untouched, and unmounted rows simply have no
// ranges. Same approach as upstream `packages/app/src/session/timeline/search-controller.ts`; the ranges are
// re-applied when rows mount (MutationObserver, once per frame).
import type { FindDoc } from "./model"

export const HIT = "own-find-hit"
export const ACTIVE = "own-find-active"
const BODIES = '[data-slot="text-part-body"], [data-slot="user-message-text"]'

export function supportsHighlights() {
  return typeof CSS !== "undefined" && typeof CSS.highlights === "object" && CSS.highlights !== null
}

export function clearHighlights() {
  if (!supportsHighlights()) return
  CSS.highlights.delete(HIT)
  CSS.highlights.delete(ACTIVE)
}

/**
 * Ranges of `needle` in the mounted text bodies whose part is one of `docs` (reasoning, tool output and other rows are
 * not searched, so they are not highlighted either). `active` picks the n-th occurrence inside one part.
 */
export function collectRanges(
  root: HTMLElement,
  needle: string,
  docs: ReadonlySet<string>,
  active?: { readonly doc: string; readonly occurrence: number },
) {
  const hits: Range[] = []
  const current: Range[] = []
  if (!needle) return { hits, current }
  for (const body of root.querySelectorAll<HTMLElement>(BODIES)) {
    const partID = body.closest("[data-timeline-part-id]")?.getAttribute("data-timeline-part-id")
    if (!partID || !docs.has(partID)) continue
    const isActive = active?.doc === partID
    let occurrence = 0
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = (node.nodeValue ?? "").normalize("NFC").toLowerCase()
      // NFC can shorten decomposed Hangul; ranges are placed on the original text only when lengths agree.
      if (value.length !== (node.nodeValue ?? "").length) continue
      for (let at = value.indexOf(needle); at !== -1; at = value.indexOf(needle, at + needle.length)) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        if (isActive && occurrence === active.occurrence) current.push(range)
        else hits.push(range)
        occurrence++
      }
    }
  }
  return { hits, current }
}

export function paintHighlights(ranges: { readonly hits: Range[]; readonly current: Range[] }) {
  if (!supportsHighlights()) return
  CSS.highlights.set(HIT, new Highlight(...ranges.hits))
  CSS.highlights.set(ACTIVE, new Highlight(...ranges.current))
}

/** Scrolls `root` so a box (a range or an element) sits in the middle of the view. */
export function centerBox(root: HTMLElement, box: Range | HTMLElement) {
  const rect = box.getBoundingClientRect()
  const view = root.getBoundingClientRect()
  const top = rect.top - view.top + root.scrollTop - (view.height - Math.min(rect.height, view.height)) / 2
  root.scrollTo({ top: Math.max(0, top), behavior: "instant" })
}

/** The box's middle is in the middle band of the view and the box is inside it. */
export function centered(root: HTMLElement, box: Range | HTMLElement) {
  const rect = box.getBoundingClientRect()
  const view = root.getBoundingClientRect()
  const middle = (rect.top + rect.bottom) / 2
  return (
    rect.height > 0 &&
    rect.top >= view.top &&
    rect.bottom <= view.bottom &&
    Math.abs(middle - (view.top + view.bottom) / 2) <= view.height / 4
  )
}

/** The turn nearest the top of the view among the mounted rows (`data-message-id`), as an index into `turns`. */
export function topTurn(root: HTMLElement, turns: readonly string[]) {
  const view = root.getBoundingClientRect()
  let best: { index: number; top: number } | undefined
  for (const row of root.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom <= view.top + 8 || rect.top >= view.bottom) continue
    const index = turns.indexOf(row.dataset.messageId ?? "")
    if (index < 0) continue
    if (!best || rect.top < best.top) best = { index, top: rect.top }
  }
  return best?.index
}

/** The first mounted row of a turn. */
export function turnRow(root: HTMLElement, turn: string) {
  return root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(turn)}"]`) ?? undefined
}

/** The row that starts a turn (its user message or shell command), once mounted. */
export function turnStart(root: HTMLElement, turn: string) {
  const id = CSS.escape(turn)
  return (
    root.querySelector<HTMLElement>(
      `[data-message-id="${id}"][data-timeline-row="UserMessage"], [data-message-id="${id}"][data-timeline-row="Shell"]`,
    ) ?? undefined
  )
}

/** The part element of a searched text (`data-timeline-part-id`), once mounted. */
export function partElement(root: HTMLElement, partID: string) {
  return root.querySelector<HTMLElement>(`[data-timeline-part-id="${CSS.escape(partID)}"]`) ?? undefined
}

/** Aligns a row to the top of the view (message navigation). */
export function alignTop(root: HTMLElement, row: HTMLElement) {
  const top = row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 8
  root.scrollTo({ top: Math.max(0, top), behavior: "instant" })
}

/** The row's top is at the top of the view. */
export function atTop(root: HTMLElement, row: HTMLElement) {
  const offset = row.getBoundingClientRect().top - root.getBoundingClientRect().top
  return offset >= 0 && offset <= 24
}

export interface ReachTarget<T> {
  /** The turn (`data-message-id`) the target belongs to. */
  readonly turn: string
  /** The final target once mounted (a match's range, a turn's first row). */
  readonly find: (root: HTMLElement) => T | undefined
  /** An element that holds the target, brought to the middle while the target itself is not found yet. */
  readonly anchor: (root: HTMLElement) => HTMLElement | undefined
  readonly placed: (root: HTMLElement, target: T) => boolean
  readonly place: (root: HTMLElement, target: T) => void
  /** Which way to go when rows of the turn are mounted but not the anchor: -1 up, 1 down. */
  readonly within: (root: HTMLElement) => -1 | 1
}

/**
 * Brings a target into place in the virtualized list without the virtualizer's own API, and keeps it there while the
 * list settles. Each step (every other frame, so the virtualizer renders the rows of the new offset in between):
 *   - the target is mounted: place it; three placed steps in a row end the loop (rows above it are measured and
 *     move it again for a few frames after a jump);
 *   - only its anchor is mounted: center the anchor;
 *   - only other rows of its turn are mounted: move through the turn (`within`);
 *   - otherwise: jump by the turn distance from the mounted turns (proportional when nothing is mounted).
 * Used after the virtualizer's `revealMessage` too, where it only settles. `done(reached)` ends it.
 */
export function reach<T>(
  root: () => HTMLElement | undefined,
  turns: readonly string[],
  target: ReachTarget<T>,
  done?: (reached: boolean) => void,
  attempts = 90,
) {
  const want = turns.indexOf(target.turn)
  let frame = 0
  let left = attempts
  let stable = 0
  const next = () => {
    frame = requestAnimationFrame(() => (frame = requestAnimationFrame(step)))
  }
  const step = () => {
    const scroller = root()
    if (!scroller || want < 0 || --left < 0) return done?.(false)
    const found = target.find(scroller)
    if (found !== undefined) {
      if (!target.placed(scroller, found)) {
        stable = 0
        target.place(scroller, found)
      } else if (++stable >= 3) return done?.(true)
      return next()
    }
    stable = 0
    const anchor = target.anchor(scroller)
    if (anchor) {
      centerBox(scroller, anchor)
      return next()
    }
    const mounted = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((row) => turns.indexOf(row.dataset.messageId ?? ""))
      .filter((index) => index >= 0)
    const span = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
    if (mounted.includes(want)) scroller.scrollTop += target.within(scroller) * scroller.clientHeight * 0.6
    else if (!mounted.length) scroller.scrollTop = (want / Math.max(1, turns.length - 1)) * span
    else {
      const low = Math.min(...mounted)
      const high = Math.max(...mounted)
      const perTurn = scroller.scrollHeight / Math.max(1, turns.length)
      const distance = want < low ? want - low : want - high
      scroller.scrollTop = Math.max(0, Math.min(span, scroller.scrollTop + distance * perTurn))
    }
    next()
  }
  step()
  return () => cancelAnimationFrame(frame)
}

/**
 * Stops the transcript from following the tail before a jump when no `unpin` was handed over: the vendored
 * virtualizer treats an upward wheel as the user leaving the tail (`handleListWheel`).
 */
export function leaveTail(root: HTMLElement) {
  root.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }))
}

export function docIDs(docs: readonly FindDoc[]) {
  return new Set(docs.map((doc) => doc.id))
}

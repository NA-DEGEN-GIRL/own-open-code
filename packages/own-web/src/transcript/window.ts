// Long transcripts (03 §20.2): a view projects at most WINDOW messages of what it holds, so paging further up costs
// the same at any depth (the projection, its rows and the virtualizer's measurements were rebuilt over every loaded
// message on each page: quadratic to the start of a long session, the 2026-11 huge-session bench). Reaching an edge of
// the window moves it there without a request while held messages remain; the view's pages beyond MARGIN on either
// side are dropped (history.ts), so what it holds stays bounded too.

/** Messages a view projects at most. */
export const WINDOW = 300
/** Messages the window moves by at an edge. */
export const STEP = 60
/**
 * Messages of the view's own pages kept on each side of the window. 300 lets the user scroll back 15 pages without a
 * read, and keeps a view at about 900 messages (some 10-25 MB) at any depth.
 */
export const MARGIN = 300

/** The window's `[start, end)` in `list`: it ends after the message `end`, or at the tail when that is unset or gone. */
export function span(list: readonly { readonly id: string }[], end: string | undefined) {
  const at = (end === undefined ? 0 : list.findIndex((message) => message.id === end) + 1) || list.length
  return [Math.max(0, at - WINDOW), at] as const
}

/**
 * The window end for a full window ending at `index` (exclusive) of `list`: unset (the tail) at or past its end. With
 * `open`, newer messages follow that the list does not hold yet: the end stays on its last message.
 */
export function endAt(list: readonly { readonly id: string }[], index: number, open = false) {
  if (open) return list[Math.min(Math.max(index, WINDOW), list.length) - 1]?.id
  return index >= list.length || list.length <= WINDOW ? undefined : list[Math.max(index, WINDOW) - 1]!.id
}

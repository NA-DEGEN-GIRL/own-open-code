// `own:open-ideas` (03 §4.4.1 아이디어 노트): the header button, the palette and the `idea.capture` shortcut open the
// quick capture or the board. The shell mounts `<IdeasLayer />` once; it loads both on first use (lazy chunks, 03 §20.2
// R5). First-chunk safe: nothing here imports them.
export const OPEN_IDEAS = "own:open-ideas"

export type IdeasView = "capture" | "board"

export interface OpenIdeasDetail {
  readonly view: IdeasView
}

export function openIdeas(view: IdeasView) {
  window.dispatchEvent(new CustomEvent<OpenIdeasDetail>(OPEN_IDEAS, { detail: { view } }))
}

export function isOpenIdeas(value: unknown): value is OpenIdeasDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "view" in value &&
    (value.view === "capture" || value.view === "board")
  )
}

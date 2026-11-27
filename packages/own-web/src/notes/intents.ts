// `own:open-notes` (03 §19.10): the header `⋯` → `대화 메모` and the palette open the memo editor of a session. The
// shell mounts `<NotesLayer />` once; it loads the editor on first use (lazy chunk, 03 §20.2 R5). First-chunk safe:
// nothing here imports the editor.
import type { ServerKey } from "@/data"

export const OPEN_NOTES = "own:open-notes"

export interface OpenNotesDetail {
  readonly serverKey: ServerKey
  readonly sessionID: string
}

export function openNotes(detail: OpenNotesDetail) {
  window.dispatchEvent(new CustomEvent<OpenNotesDetail>(OPEN_NOTES, { detail }))
}

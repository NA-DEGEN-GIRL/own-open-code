// `own:open-compactions` (03 §4.5 "압축 내용 보기", UC 2026-10-18): the header `⋯` item and a compaction marker's
// button open the 압축 내용 dialog of a conversation, the marker's own compaction open. The shell mounts
// `<CompactionsLayer />` once; it loads the dialog on first use (lazy chunk, 03 §20.2 R5). First-chunk safe.
import type { ServerKey } from "@/data"

export const OPEN_COMPACTIONS = "own:open-compactions"

export interface OpenCompactionsDetail {
  readonly serverKey: ServerKey
  readonly sessionID: string
  /** The compaction to open and scroll to (a marker's); without it the newest one. */
  readonly messageID?: string
}

export function openCompactions(detail: OpenCompactionsDetail) {
  window.dispatchEvent(new CustomEvent<OpenCompactionsDetail>(OPEN_COMPACTIONS, { detail }))
}

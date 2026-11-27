// Adding a mention from outside the composer without a shared import (03 §10 `Ctrl+Shift+L` "선택 영역을 문맥에
// 추가": the review and files tabs turn picked lines into a mention chip). Same window-event pattern as
// src/limits/intents.ts; the composer's suggestion controller listens and adds the chip to the draft on screen when
// the session matches. Nothing secret goes into `detail`.
import type { ServerKey } from "@/data"
import type { MentionChip } from "./types"

export interface MentionIntent {
  readonly serverKey: ServerKey
  /** `undefined`: the new-session screen. */
  readonly sessionID: string | undefined
  readonly chip: MentionChip
}

export const MENTION_INTENT = "own:composer-add-mention"

export function requestMention(detail: MentionIntent) {
  window.dispatchEvent(new CustomEvent(MENTION_INTENT, { detail }))
}

// Requests to show the review tab (03 §18.5 turn footer `변경 3개 · 리뷰 →`, `/review`, 18.7 `변경 보기`). The shell
// owns the panel, so this goes out as a window event it resolves with `shell.openTab("review")` (after navigating to
// the session when another one is on screen), like the intents in limits/intents.ts. The mode is set here first.
import type { ServerKey } from "@/data"
import type { ReviewMode } from "./model"
import { reviewKey, reviewState } from "./state"

export interface ReviewIntent {
  readonly serverKey: ServerKey
  readonly sessionID: string
  /** Mode to show; the user asked for it, so turn ends do not switch it afterwards. */
  readonly mode?: ReviewMode
}

export const REVIEW_INTENT = "own:open-review"

export function openReview(detail: ReviewIntent) {
  if (detail.mode) reviewState.setMode(reviewKey(detail.serverKey, detail.sessionID), detail.mode, true)
  window.dispatchEvent(new CustomEvent(REVIEW_INTENT, { detail }))
}

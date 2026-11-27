// Review module (03 §18.5, 4.7 `리뷰` tab). First-chunk-safe exports only: the tab itself is the lazy chunk
// `src/adapter/review.tsx` → `./panel` (session-ui + pierre), never imported from here.
import { SPLIT_MIN_WIDTH } from "./model"
import { reviewPrefs } from "./state"

export { lastTurnChanges, ReviewChangesLink, reviewBadgeCount, watchReviewTurns } from "./badge"
export { ReviewCommentChips } from "./comment-chips"
export {
  commentLines,
  reviewComments,
  withCommentPresentation,
  withReviewComments,
  type CommentedParts,
  type LineSelection,
  type ReviewComment,
  type UserPresentation,
} from "./comments"
export { openReview, REVIEW_INTENT, type ReviewIntent } from "./intents"
export { SPLIT_MIN_WIDTH, type DiffStyle, type ExpandMode, type ReviewMode } from "./model"
export { reviewKey, reviewPrefs, reviewState } from "./state"
export { reviewEn, reviewKo, reviewText, type ReviewKey } from "./strings"
export { createVcsStatus, notifyGitChanged, summarizeStatus, type VcsStatusSummary } from "./vcs-status"

/**
 * 4.7: choosing the split view raises the panel's minimum width to 560 px (the shell applies it). The panel's 1 px
 * left border comes out of that width, so it is one more: the review content itself must measure 560 px.
 */
export function reviewMinWidth() {
  return reviewPrefs.get().diffStyle === "split" ? SPLIT_MIN_WIDTH + 1 : undefined
}

// Pending review comments above the composer (03 §19.1 "코멘트는 입력창 위 칩으로 모이고 전송 때 프롬프트에 붙는다").
// First chunk and small: own chips (the session-ui comment card belongs to the transcript chunk; sent messages show
// their comments with it through `withCommentPresentation`). A chip opens the comment in the review tab; ✕ removes it.
import "./comment-chips.css"
import { For, Show } from "solid-js"
import type { ServerKey } from "@/data"
import { commentLines, reviewComments, type ReviewComment } from "./comments"
import { openReview } from "./intents"
import { reviewKey, reviewState } from "./state"
import { useReviewText } from "./strings"

export function ReviewCommentChips(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const text = useReviewText()
  const comments = () => reviewComments.list(props.serverKey(), props.sessionID())
  const name = (comment: ReviewComment) => comment.file.slice(comment.file.lastIndexOf("/") + 1)
  const open = (sessionID: string, comment: ReviewComment) => {
    const serverKey = props.serverKey()
    reviewState.setFile(reviewKey(serverKey, sessionID), comment.file)
    reviewComments.setFocus(serverKey, sessionID, { file: comment.file, id: comment.id })
    openReview({ serverKey, sessionID, ...(comment.mode ? { mode: comment.mode } : {}) })
  }
  return (
    <Show when={comments().length > 0 && props.sessionID()}>
      {(sessionID) => (
        <ul
          class="own-rc"
          aria-label={text("own.review.comments", { count: comments().length })}
          data-testid="review-comment-chips"
        >
          <For each={comments()}>
            {(comment) => (
              <li
                class="own-rc-chip"
                data-testid="review-comment-chip"
                title={`${comment.file}:${commentLines(comment.selection)} · ${comment.comment}`}
              >
                <button
                  type="button"
                  class="own-rc-open"
                  aria-label={text("own.review.comment.open", {
                    file: comment.file,
                    lines: commentLines(comment.selection),
                    comment: comment.comment,
                  })}
                  onClick={() => open(sessionID(), comment)}
                >
                  <svg class="own-rc-icon" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" />
                  </svg>
                  <span class="own-rc-where">
                    {name(comment)}:{commentLines(comment.selection)}
                  </span>
                  <span class="own-rc-text" dir="auto">
                    {comment.comment}
                  </span>
                </button>
                <button
                  type="button"
                  class="own-rc-remove"
                  data-testid="review-comment-remove"
                  aria-label={text("own.review.comment.remove", {
                    file: comment.file,
                    lines: commentLines(comment.selection),
                  })}
                  onClick={() => reviewComments.remove(props.serverKey(), sessionID(), comment.id)}
                >
                  ✕
                </button>
              </li>
            )}
          </For>
        </ul>
      )}
    </Show>
  )
}

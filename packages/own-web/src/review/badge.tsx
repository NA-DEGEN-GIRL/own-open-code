// Light review hooks for the first chunk (no session-ui, no diff engine): the review tab badge and the turn footer
// link of 03 §18.5 ("턴이 끝나고 파일이 바뀌었으면 탭 배지에 파일 수를 보이고, 턴 footer에 `변경 3개 · 리뷰 →`").
// `watchReviewTurns` listens for the shown session's turn ends and asks session.diff once per turn how many files it
// changed; the badge shows that count until the review tab has been seen for the session.
import { createEffect, onCleanup, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { openReview } from "./intents"
import { reviewKey, reviewState } from "./state"
import { useReviewText } from "./strings"

/** Turn-end event ids already counted, so several watchers of one session fetch once. */
const counted = new Set<string>()
const COUNTED_MAX = 256

export function watchReviewTurns(input: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  createEffect(() => {
    const runtime = data.get(input.serverKey())
    const sessionID = input.sessionID()
    if (!runtime || !sessionID) return
    const key = reviewKey(runtime.key, sessionID)
    const count = (event: { readonly id: string; readonly data: { readonly sessionID: string } }) => {
      if (event.data.sessionID !== sessionID || counted.has(event.id)) return
      counted.add(event.id)
      if (counted.size > COUNTED_MAX) counted.delete(counted.values().next().value!)
      void Promise.resolve()
        .then(() => runtime.client().session.diff({ sessionID, context: 0 }))
        .then((files) => reviewState.setLastTurn(key, files.length))
        .catch(() => undefined)
    }
    const offs = [
      runtime.bus.on("session.execution.succeeded", count),
      runtime.bus.on("session.execution.failed", count),
      runtime.bus.on("session.execution.interrupted", count),
    ]
    onCleanup(() => offs.forEach((off) => off()))
  })
}

/** Tab badge (4.7 "리뷰: 변경 파일 수"): files the last turn changed, until the review tab showed this session. */
export function reviewBadgeCount(serverKey: ServerKey, sessionID: string) {
  const lastTurn = reviewState.get(reviewKey(serverKey, sessionID)).lastTurn
  return lastTurn && !lastTurn.seen && lastTurn.count > 0 ? lastTurn.count : undefined
}

/** Files the last finished turn of this session changed (as watched in this window). */
export function lastTurnChanges(serverKey: ServerKey, sessionID: string) {
  const count = reviewState.get(reviewKey(serverKey, sessionID)).lastTurn?.count
  return count && count > 0 ? count : undefined
}

/** `변경 3개 · 리뷰 →` for the footer of the session's last turn; opens the review tab on `마지막 턴`. */
export function ReviewChangesLink(props: { readonly serverKey: ServerKey; readonly sessionID: string }) {
  const text = useReviewText()
  return (
    <Show when={lastTurnChanges(props.serverKey, props.sessionID)}>
      {(count) => (
        <button
          type="button"
          class="border-0 bg-transparent p-0 text-own-accent-text hover:underline"
          data-testid="review-footer-link"
          onClick={() => openReview({ serverKey: props.serverKey, sessionID: props.sessionID, mode: "lastTurn" })}
        >
          {text("own.review.footer", { count: count() })}
        </button>
      )}
    </Show>
  )
}

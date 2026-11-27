// Window-event contract for putting a message back into the composer (03 §18.7 "입력창에는 되감은 메시지의 원문과
// 첨부·코멘트가 돌아온다", 18.9 "편집은 취소 후 다시 넣기다"). Revert and the queue panel live far from the composer
// (transcript rows, the palette's /undo), so they dispatch this event; the composer puts the text back and the
// attachment store of the same draft re-adds the chips (store.ts listens itself).
import type { ReadyAttachment } from "./model"

export const COMPOSER_RESTORE = "own:composer-restore"

export interface ComposerRestoreDetail {
  readonly serverKey: string
  /** `undefined`: the new-session screen's draft (an idea note's `새 대화로 시작`, 03 §4.4.1). */
  readonly sessionID: string | undefined
  readonly text: string
  readonly attachments: readonly ReadyAttachment[]
  /**
   * `replace`: the draft becomes this message (revert, as upstream `restore` does).
   * `fill`: only when the draft is empty, otherwise append after a blank line (queue `편집`).
   */
  readonly mode: "replace" | "fill"
  /**
   * Apply only while the draft still equals this text (`복원 취소` clears the text a revert put back, never a draft the
   * user has changed since). Attachments are left alone in that case.
   */
  readonly ifDraft?: string
}

export function requestComposerRestore(detail: ComposerRestoreDetail) {
  window.dispatchEvent(new CustomEvent<ComposerRestoreDetail>(COMPOSER_RESTORE, { detail }))
}

/** Subscribes to restore requests; returns the unsubscribe function. */
export function onComposerRestore(listener: (detail: ComposerRestoreDetail) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<ComposerRestoreDetail>).detail)
  window.addEventListener(COMPOSER_RESTORE, handler)
  return () => window.removeEventListener(COMPOSER_RESTORE, handler)
}

/** What the composer does with the text (pure; the composer applies it to its textarea and draft store). */
export function restoredText(current: string, detail: Pick<ComposerRestoreDetail, "text" | "mode" | "ifDraft">) {
  if (detail.ifDraft !== undefined) return current === detail.ifDraft ? detail.text : current
  if (detail.mode === "replace" || !current.trim()) return detail.text
  return `${current.replace(/\s+$/, "")}\n\n${detail.text}`
}

/** Restore requests a composer took already (03 §4.1.1 split view: every pane's composer hears each one). */
const taken = new WeakSet<ComposerRestoreDetail>()

/** The composer that shows the request's conversation applies it to its textarea: the others leave it alone. */
export function takeRestore(detail: ComposerRestoreDetail) {
  taken.add(detail)
}

/**
 * A composer that does not show the conversation writes the stored draft through `write`, once per request, so two
 * such panes never append a `fill` twice (2026-10-16: the enable dialog's draft goes to a team main no pane may show
 * yet). The write is synchronous: callers navigate right after the request (`새 대화로 시작`), and the composer loads
 * the stored draft of the conversation it switches to at once. A pane that shows the conversation and hears the
 * request later still computes from its own text and overwrites the stored draft, so the text goes in once.
 */
export function storeRestore(detail: ComposerRestoreDetail, write: () => void) {
  if (taken.has(detail)) return
  taken.add(detail)
  write()
}

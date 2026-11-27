// Revert model (03 §18.7), pure: what a boundary rewinds, whether the range holds an account switch, the /undo and
// /redo targets (upstream `session/revert.ts` semantics, re-written for own-web), which queued messages the stage
// sweeps, and the cold-point estimate input (01 §17.1 #8: the first request after a committed revert is a cold point,
// 02 §4.7.4: `W^lo = 0`, `W^hi` = the old `L`).
import type { FileDiffInfo, SessionInboxInfo, SessionMessageInfo, SessionMessageUser } from "@opencode/client"

/**
 * Delivered user messages in id (= creation) order. The loaded list also holds prompts still waiting in the inbox
 * (createData shows them optimistically; they are not durable messages and cannot be a boundary), and it is not
 * always in creation order (optimistic and paged messages interleave).
 */
export function userMessages(messages: readonly SessionMessageInfo[], pending: readonly SessionInboxInfo[] = []) {
  const waiting = new Set(pending.map((item) => item.id))
  return byId(
    messages.filter((message): message is SessionMessageUser => message.type === "user" && !waiting.has(message.id)),
  )
}

/** Turns after the boundary message (`이 메시지와 그 뒤의 턴 {n}개`, `이 메시지 뒤 턴 {turns}개`). */
export function turnsAfter(
  messages: readonly SessionMessageInfo[],
  messageID: string,
  pending: readonly SessionInboxInfo[] = [],
) {
  return userMessages(messages, pending).filter((message) => message.id > messageID).length
}

/** A prompt still in the inbox is not a message yet: it cannot be a revert boundary. */
export function isPending(pending: readonly SessionInboxInfo[], messageID: string) {
  return pending.some((item) => item.id === messageID)
}

/**
 * 18.7 "이 범위에 계정 전환이 있습니다": the account (providerID) in effect changes somewhere from the boundary on — a
 * `model-switched` message to another provider, or an answer on another provider than the one before the boundary.
 * Variant-only and same-account model changes do not count.
 */
export function switchInRange(messages: readonly SessionMessageInfo[], messageID: string) {
  let provider: string | undefined
  for (const message of byId(messages)) {
    const next =
      message.type === "assistant" || message.type === "model-switched" ? message.model.providerID : undefined
    if (next === undefined) continue
    if (message.id >= messageID && provider !== undefined && next !== provider) return true
    provider = next
  }
  return false
}

export type RedoStep = { readonly kind: "stage"; readonly messageID: string } | { readonly kind: "clear" }

/** `/undo`: one turn further back — the user message before the boundary, the last one when nothing is staged. */
export function undoTarget(users: readonly Pick<SessionMessageUser, "id">[], boundary: string | undefined) {
  const index = boundary ? users.findIndex((message) => message.id === boundary) : users.length
  if (index <= 0) return undefined
  return users[index - 1]?.id
}

/** `/redo`: one turn forward — the next user message after the boundary, or clearing at the end. */
export function redoTarget(
  users: readonly Pick<SessionMessageUser, "id">[],
  boundary: string | undefined,
): RedoStep | undefined {
  if (!boundary) return undefined
  const index = users.findIndex((message) => message.id === boundary)
  if (index < 0) return undefined
  const next = users[index + 1]
  return next ? { kind: "stage", messageID: next.id } : { kind: "clear" }
}

/**
 * Queued user messages to cancel after a stage (upstream sweep): the local snapshot merged with the authoritative
 * inbox, limited to items created up to `cutoff` so a prompt admitted after the revert survives.
 */
export function staleQueue(
  local: readonly SessionInboxInfo[],
  authoritative: readonly SessionInboxInfo[],
  cutoff: number,
) {
  const ids = [
    ...local.filter((item) => item.type === "user").map((item) => item.id),
    ...authoritative.filter((item) => item.type === "user" && item.time.created <= cutoff).map((item) => item.id),
  ]
  return [...new Set(ids)]
}

/** Queued user messages a stage would cancel (dialog note). */
export function queuedUsers(pending: readonly SessionInboxInfo[]) {
  return pending.filter((item) => item.type === "user").length
}

/**
 * Upper bound of the input the first request after the commit rewrites: the context of the first step that ran after
 * the boundary message (input + cache read + cache write, 03 §4.5 footer arithmetic). `undefined` when unknown.
 */
export function boundaryContext(messages: readonly SessionMessageInfo[], messageID: string) {
  const ordered = byId(messages)
  const index = ordered.findIndex((message) => message.id === messageID)
  if (index < 0) return undefined
  for (const message of ordered.slice(index + 1)) {
    if (message.type === "user") return undefined
    if (message.type !== "assistant" || !message.tokens) continue
    return message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
  }
  return undefined
}

export function filesSummary(files: readonly FileDiffInfo[] | undefined) {
  const list = files ?? []
  return {
    count: list.length,
    additions: list.reduce((sum, file) => sum + file.additions, 0),
    deletions: list.reduce((sum, file) => sum + file.deletions, 0),
  }
}

/** Why a revert call failed, for the toast: core's busy error by tag, else the message. */
export function failureReason(error: unknown) {
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : undefined
  if (tag?.includes("Busy")) return "busy" as const
  return error instanceof Error ? error.message : String(error)
}

/** Messages in id (= creation) order; the loaded list can interleave optimistic and paged messages. */
function byId<T extends { readonly id: string }>(messages: readonly T[]) {
  return messages.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

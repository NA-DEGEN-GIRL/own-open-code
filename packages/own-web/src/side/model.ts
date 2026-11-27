// The side panel's state rules (곁질문, 03 §4.4.2), apart from the screen so they are tested alone. The service keeps
// the threads (own.accounts `side.*`, 02 §9.7); the panel shows one and follows its `side.delta` / `side.ended` events.
import type { OwnAccounts } from "@own/protocol"
import type { Locale } from "@/i18n"
import { credits } from "@/limits/format"

export type Thread = OwnAccounts.SideThread
export type Turn = OwnAccounts.SideTurn

/**
 * More text of a running answer. Text already on screen (a delta that crossed `side.get`) is skipped; a delta past
 * the end means one was missed, and the panel reads the thread again (`gap`).
 */
export function applyDelta(
  thread: Thread,
  delta: { readonly turn: number; readonly offset: number; readonly text: string },
): Thread | "gap" {
  const turn = thread.turns[delta.turn]
  if (!turn || turn.status !== "running") return thread
  const have = turn.answer.length
  if (delta.offset > have) return "gap"
  const end = delta.offset + delta.text.length
  if (end <= have) return thread
  const answer = turn.answer + delta.text.slice(have - delta.offset)
  return { ...thread, turns: thread.turns.map((item, index) => (index === delta.turn ? { ...item, answer } : item)) }
}

/** The stored turn of a `side.ended` event; a turn this copy does not have yet means it is behind (`gap`). */
export function applyEnded(thread: Thread, ended: { readonly index: number; readonly turn: Turn }): Thread | "gap" {
  if (ended.index >= thread.turns.length) return "gap"
  return { ...thread, turns: thread.turns.map((item, index) => (index === ended.index ? ended.turn : item)) }
}

export function running(thread: Thread | undefined) {
  return !!thread && thread.turns.some((turn) => turn.status === "running")
}

/** The part of the prompt the provider read from its cache, `read / (input + read + write)`; `undefined` without usage. */
export function cachedShare(tokens: Turn["tokens"]) {
  if (!tokens) return undefined
  const total = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return total > 0 ? tokens.cacheRead / total : undefined
}

/**
 * A side answer's cost as the transcript writes it: dollars, or credits as the same estimate (`≈0.2 cr`, 7.5) instead of
 * the router's unit name (`0.17 credits` once showed in both languages).
 */
export function costText(cost: NonNullable<Turn["cost"]>) {
  if (cost.unit === "credits") return credits(cost.amount)
  return `$${cost.amount.toFixed(cost.amount < 1 ? 3 : 2)}`
}

/**
 * `대화에 넣기`: one question and its answer as a normal message of the conversation, sent only when the user presses
 * it. Plain words in the user's language, so the main agent reads it like anything the user wrote.
 */
export function insertText(turn: Pick<Turn, "question" | "answer">, locale: Locale) {
  return locale === "en"
    ? `Side question I asked: ${turn.question.trim()}\n\nThe answer I got:\n${turn.answer.trim()}`
    : `곁질문으로 물어본 것: ${turn.question.trim()}\n\n받은 답:\n${turn.answer.trim()}`
}

/** The panel's words for a refused `side.ask` (own.accounts errors, a service without `side.*`, a missing scope). */
export function askError(
  error: { readonly type: string; readonly message: string; readonly data?: unknown },
  turnsMax: number,
):
  | { readonly key: "own.side.error.old"; readonly params?: undefined }
  | { readonly key: "own.side.error.scope"; readonly params?: undefined }
  | { readonly key: "own.side.error.busy" | "own.side.error.turns"; readonly params: { readonly max: number } }
  | { readonly key: "own.side.error.session" | "own.side.error.gone"; readonly params?: undefined }
  | { readonly key: "own.side.error.route"; readonly params: { readonly reason: string } }
  | { readonly key: "own.side.error.failed"; readonly params: { readonly reason: string } } {
  if (error.type === "rpc.method_not_found") return { key: "own.side.error.old" }
  if (error.type === "own.scope_denied" || error.type === "rpc.forbidden") return { key: "own.side.error.scope" }
  const data = typeof error.data === "object" && error.data !== null ? (error.data as Record<string, unknown>) : {}
  if (error.type === "side_busy") {
    const max = typeof data.max === "number" ? data.max : 0
    return max === turnsMax ? { key: "own.side.error.turns", params: { max } } : { key: "own.side.error.busy", params: { max } }
  }
  if (error.type === "side_not_found") return { key: "own.side.error.gone" }
  if (error.type === "side_unavailable" && data.reason === "session") return { key: "own.side.error.session" }
  if (error.type === "side_unavailable")
    return { key: "own.side.error.route", params: { reason: typeof data.detail === "string" ? data.detail : error.message } }
  return { key: "own.side.error.failed", params: { reason: error.message } }
}

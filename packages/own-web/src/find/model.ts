// Find in session (03 §19.13), pure part: the searchable documents of a session's loaded messages, needle and text
// normalization, the search itself (run in the worker, or inline without Worker support), and the choice of the
// first match. The transcript is virtualized, so the browser's own find cannot see rows that are not mounted: the
// search runs over the message data and the view jumps to the match's turn, then highlights what is mounted.
import type { SessionMessageInfo } from "@opencode/client"

/** One searchable text: a user message or one assistant text part (the texts session-ui renders as prose). */
export interface FindDoc {
  /**
   * Same id as the row's `data-timeline-part-id` (session-ui `Timeline.contentEntries`: `<message>:text:<n>`; user
   * text is `<message>:text:0`), so highlighting finds the part in the DOM.
   */
  readonly id: string
  /** The turn: the user (or shell) message that starts it, i.e. the rows' `data-message-id`. */
  readonly turn: string
  readonly messageID: string
  readonly text: string
}

export interface FindHit {
  /** Index into the documents the search ran over. */
  readonly doc: number
  /** Occurrence of the needle inside that document (0-based). */
  readonly occurrence: number
}

export interface FindResult {
  readonly hits: readonly FindHit[]
  /** All occurrences, also those past `HIT_LIMIT`. */
  readonly total: number
}

/** Matches kept per query; the count still says how many there are. */
export const HIT_LIMIT = 5_000

export function documentsOf(messages: readonly SessionMessageInfo[]): FindDoc[] {
  const docs: FindDoc[] = []
  let turn = ""
  for (const message of messages) {
    if (message.type === "user" || message.type === "shell") turn = message.id
    if (message.type === "user") {
      if (message.text) docs.push({ id: `${message.id}:text:0`, turn, messageID: message.id, text: message.text })
      continue
    }
    if (message.type !== "assistant") continue
    // Ordinals count per content type, as session-ui numbers them.
    let text = 0
    for (const content of message.content) {
      if (content.type !== "text") continue
      const id = `${message.id}:text:${text++}`
      if (content.text) docs.push({ id, turn: turn || message.id, messageID: message.id, text: content.text })
    }
  }
  return docs
}

/** Turn ids in order (`data-message-id` of the rows), for message navigation and seeking. */
export function turnsOf(messages: readonly SessionMessageInfo[]) {
  return messages.flatMap((message) => (message.type === "user" || message.type === "shell" ? [message.id] : []))
}

/** Case-insensitive, NFC (Hangul typed on one system and pasted from another compares equal). */
export function prepareText(text: string) {
  return text.normalize("NFC").toLowerCase()
}

export function normalizeNeedle(raw: string) {
  return prepareText(raw.trim())
}

export function countIn(prepared: string, needle: string, limit = Number.POSITIVE_INFINITY) {
  if (!needle) return 0
  let count = 0
  for (let at = prepared.indexOf(needle); at !== -1 && count < limit; at = prepared.indexOf(needle, at + needle.length))
    count++
  return count
}

/** Every occurrence in document order; `prepared` are `prepareText` values, `needle` a `normalizeNeedle` value. */
export function searchPrepared(prepared: readonly string[], needle: string, limit = HIT_LIMIT): FindResult {
  const hits: FindHit[] = []
  let total = 0
  if (!needle) return { hits, total }
  prepared.forEach((text, doc) => {
    const count = countIn(text, needle)
    total += count
    for (let occurrence = 0; occurrence < count && hits.length < limit; occurrence++) hits.push({ doc, occurrence })
  })
  return { hits, total }
}

/**
 * The match a new query starts at: the first one at or below the turn at the top of the view (like a browser's find,
 * which starts where the reader is), else the last one above it.
 */
export function startAt(hits: readonly FindHit[], turnOf: (doc: number) => number, fromTurn: number | undefined) {
  if (!hits.length) return -1
  if (fromTurn === undefined) return hits.length - 1
  const index = hits.findIndex((hit) => turnOf(hit.doc) >= fromTurn)
  return index >= 0 ? index : hits.length - 1
}

// ---------------------------------------------------------------------------------------------------------------
// Worker protocol (find.worker.ts). Documents go over once and then only when their text changes (streaming answers
// change the last one); the order list says which documents exist and in what order.

export type FindRequest =
  | {
      readonly type: "docs"
      readonly upsert: readonly (readonly [id: string, text: string])[]
      readonly order: readonly string[]
    }
  | { readonly type: "query"; readonly seq: number; readonly needle: string }

export interface FindResponse extends FindResult {
  readonly type: "result"
  readonly seq: number
}

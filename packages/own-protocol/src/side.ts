export * as Side from "./side.js"

// Side questions (곁질문, `/btw`, 03 §4.4.2, 02 §9.7): a quick question about a conversation, answered from its
// history without tools and kept out of it. Plain constants without the schema graph (the RPC schemas are in rpc.ts),
// so own-web's lazy panel imports them without Effect.

/** A question's length in UTF-16 code units. */
export const QUESTION_MAX = 4_000
/** The longest answer kept in the list; a longer one is stored cut with `…` (the stream showed it whole). */
export const ANSWER_MAX = 24_000
/** Turns of one side thread: the question and up to seven follow-ups. */
export const TURNS_MAX = 8
/** Side threads kept per conversation; the oldest goes when a new one would pass this. */
export const THREADS_MAX = 12
/** Answers one conversation may be waiting for at once. */
export const RUNNING_MAX = 2
/** An answer that has not ended after this is cancelled. */
export const TIMEOUT_MS = 5 * 60_000
/** Side thread ids: `side_` and a ULID, made by the service. */
export const ID_PATTERN = /^side_[0-9A-HJKMNP-TV-Z]{26}$/

/** An answer as the list keeps it: whole up to `ANSWER_MAX`, else cut there with `…`. */
export function cut(text: string) {
  return text.length <= ANSWER_MAX ? text : `${text.slice(0, ANSWER_MAX - 1)}…`
}

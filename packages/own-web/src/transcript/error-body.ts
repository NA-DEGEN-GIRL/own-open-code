// The provider's response body of a failed turn (upstream c14a1f5acf: core keeps it as `error.response.body`), shaped
// for the transcript's `응답 본문 보기` (03 §4.5): JSON pretty-printed, capped so a large HTML error page stays a
// readable block. Pure, for the tests.
import { Option, Schema } from "effect"

/** Characters shown at most; the rest is cut with `…`. */
export const BODY_LIMIT = 8_000

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * The body to show, or `undefined` when there is none or it only repeats the error message the card already shows.
 */
export function responseBody(body: string | undefined, message: string) {
  const text = body?.trim()
  if (!text || text === message.trim()) return undefined
  const shown = Option.match(decodeJson(text), {
    onNone: () => text,
    onSome: (value) => JSON.stringify(value, null, 2),
  })
  return shown.length > BODY_LIMIT ? `${shown.slice(0, BODY_LIMIT)}…` : shown
}

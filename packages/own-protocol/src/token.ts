/**
 * Token estimate of a text: the same rule as core `Token.estimate` (`packages/core/src/util/token.ts`, P-016). own
 * packages never import core, so own.import sizes conversations with this copy (09 §4.3 `E(·)`), and
 * `test/token.test.ts` keeps it equal to core's (IG6).
 */
export * as Token from "./token.js"

const CHARS_PER_TOKEN = 4

// UTF-16 code units (no `u` flag, as in core): Hangul jamo, compatibility and extended jamo, syllables and half-width
// Hangul; other CJK = radicals to unified ideographs (kana, bopomofo and CJK symbols included), compatibility
// ideographs and forms, full-width forms. Astral ideographs and emoji are two units each and stay in the rest.
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿ﾠ-ￜ]+/g
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]+/g

/** 0.65 per Hangul unit + 0.6 per other CJK unit + the rest / 4, rounded; never negative. */
export const estimate = (input: string) => {
  const nonHangul = input.replace(HANGUL, "")
  const rest = nonHangul.replace(CJK, "")
  const dense = (input.length - nonHangul.length) * 0.65 + (nonHangul.length - rest.length) * 0.6
  return Math.max(0, Math.round(dense + rest.length / CHARS_PER_TOKEN))
}

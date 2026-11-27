export * as Token from "./token.js"

const CHARS_PER_TOKEN = 4

// OWN-PATCH(P-016) begin
// Measured 2026-10-07 (own/reports/token-density-2026-10-07.md): Hangul 0.68-0.79 and other CJK 0.62-0.75 tokens per
// character on gpt-6-luna and deepseek-flash, not 1/4. Each weight sits just below the lowest measurement (R8).
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿ﾠ-ￜ]+/g
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]+/g
export const estimate = (input: string) => {
  const nonHangul = input.replace(HANGUL, "")
  const rest = nonHangul.replace(CJK, "")
  const dense = (input.length - nonHangul.length) * 0.65 + (nonHangul.length - rest.length) * 0.6
  return Math.max(0, Math.round(dense + rest.length / CHARS_PER_TOKEN))
}
// OWN-PATCH(P-016) end

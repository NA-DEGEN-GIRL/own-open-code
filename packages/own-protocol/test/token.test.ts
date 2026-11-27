import { describe, expect, test } from "bun:test"
// Core's P-016 function, imported by relative path in this test only: own-protocol has no runtime dependency on core.
import { estimate } from "../../core/src/util/token.js"
import { Token } from "../src/index.js"

const SAMPLES = {
  empty: "",
  ascii: "bun test packages/core && git status --short",
  hangul: "안녕하세요, 제 이름은 GPT-4o입니다.",
  jamo: "ㅋㅋㅋ ᄀᄁᄂ ꥠꥡ ﾡﾢﾣ",
  cjk: "你好世界，こんにちは。カタカナ ㄅㄆ ⺀ 豈 ︰",
  mixed: "가".repeat(10) + "你".repeat(10) + "abc".repeat(7) + "\n```ts\nconst x = 1\n```",
  emoji: "😀🎉👍🏽 done ✅",
  astral: "𠀀".repeat(10),
  cyrillic: "Привет, мир",
  long: "리뷰 지적 고치기 ".repeat(2_000) + "fix the review comments ".repeat(1_000),
}

describe("Token.estimate (09 §4.3 E(·), IG6)", () => {
  test.each(Object.entries(SAMPLES))("%s: equals core Token.estimate", (_, text) => {
    expect(Token.estimate(text)).toBe(estimate(text))
  })

  test("weights: Hangul 0.65, other CJK 0.6, the rest a quarter, rounded", () => {
    expect(Token.estimate("")).toBe(0)
    expect(Token.estimate("a".repeat(400))).toBe(100)
    expect(Token.estimate("가".repeat(100))).toBe(65)
    expect(Token.estimate("你".repeat(100))).toBe(60)
    // 10 × 0.65 + 10 × 0.6 = 12.5
    expect(Token.estimate("가".repeat(10) + "你".repeat(10))).toBe(13)
    // Emoji and astral ideographs are two UTF-16 units of the rest each.
    expect(Token.estimate("😀".repeat(10))).toBe(5)
  })

  test("every UTF-16 code unit falls in the same class as in core", () => {
    // 20 copies tell the classes apart: Hangul 13, other CJK 12, the rest 5.
    const mismatches = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit).repeat(20)).flatMap(
      (text) => (Token.estimate(text) === estimate(text) ? [] : [text.charCodeAt(0).toString(16)]),
    )
    expect(mismatches).toEqual([])
  })

  test("never negative and a whole number", () => {
    for (const text of Object.values(SAMPLES)) {
      expect(Token.estimate(text)).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(Token.estimate(text))).toBe(true)
    }
  })
})

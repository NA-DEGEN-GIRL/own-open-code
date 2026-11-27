// 설정 > 출력 상한 (03 §5.7.4, 02 §4.9): what the page shows for a stored setting, the numbers it takes, the patch it
// sends, how it tells an older service, and its words in both languages.
import { describe, expect, test } from "bun:test"
import { OutputLimit } from "@own/protocol/output-limit"
import { isDefault, NUMBERS, parseLimit, patchOf, shown, stored } from "./output-limit-model"
import { outputLimitEn, outputLimitKo, outputLimitText } from "./output-limit-strings"

describe("the setting on screen", () => {
  test("no stored setting is the default: 이 값을 넘기지 않기 256,000", () => {
    expect(shown(undefined)).toEqual({ mode: "cap", maxTokens: 256_000 })
    expect(shown({})).toEqual(OutputLimit.DEFAULT)
    expect(isDefault(shown({}))).toBe(true)
    expect(shown({ outputLimit: { mode: "omit", maxTokens: 120_000 } })).toEqual({ mode: "omit", maxTokens: 120_000 })
    expect(isDefault({ mode: "omit", maxTokens: 256_000 })).toBe(false)
    expect(isDefault({ mode: "cap", maxTokens: 255_999 })).toBe(false)
  })
})

describe("the number field", () => {
  test("takes grouped digits and k/M, whole numbers from 4,096 to 1,000,000", () => {
    expect(parseLimit("256,000")).toBe(256_000)
    expect(parseLimit(" 393216 ")).toBe(393_216)
    expect(parseLimit("64k")).toBe(64_000)
    expect(parseLimit("1M")).toBe(1_000_000)
    expect(parseLimit("4,096")).toBe(4_096)
    for (const text of ["", "abc", "4,095", "1,000,001", "-5000", "12.5.1", "1.5M"])
      expect(parseLimit(text)).toBeUndefined()
  })
})

describe("the patch", () => {
  test("the default clears the stored setting; anything else is stored whole", () => {
    expect(patchOf(OutputLimit.DEFAULT)).toEqual({ outputLimit: null })
    expect(patchOf({ mode: "cap", maxTokens: 64_000 })).toEqual({ outputLimit: { mode: "cap", maxTokens: 64_000 } })
    expect(patchOf({ mode: "omit", maxTokens: 256_000 })).toEqual({ outputLimit: { mode: "omit", maxTokens: 256_000 } })
  })

  test("an answer without the sent value is an older service", () => {
    const sent = patchOf({ mode: "omit", maxTokens: 256_000 })
    expect(stored(sent, { outputLimit: { mode: "omit", maxTokens: 256_000 } })).toBe(true)
    expect(stored(sent, {})).toBe(false)
    expect(stored(sent, { outputLimit: { mode: "cap", maxTokens: 256_000 } })).toBe(false)
    expect(stored({ outputLimit: null }, {})).toBe(true)
    expect(stored({ outputLimit: null }, { outputLimit: { mode: "cap", maxTokens: 9_000 } })).toBe(false)
  })
})

describe("the words", () => {
  test("the labels the user decided, and the line that sets it apart from the context window", () => {
    expect(outputLimitKo["own.output.cap"]).toBe("이 값을 넘기지 않기")
    expect(outputLimitKo["own.output.omit"]).toBe("출력 상한 보내지 않기")
    expect(outputLimitKo["own.output.reset"]).toBe("기본으로")
    expect(outputLimitKo["own.output.lead"]).toBe(
      "한 번 답할 때 생각과 답을 합쳐 넘지 않을 양이에요. 문맥 창(읽을 수 있는 양)과는 달라요.",
    )
  })

  test("the numbers in the help text are the service's", () => {
    expect(NUMBERS).toEqual({ claude: "32,000", ds: "65,536", min: "4,096", max: "1,000,000", cap: "256,000" })
    expect(outputLimitText("ko", "own.output.omitClaude", NUMBERS)).toContain("32,000을 보내요")
    expect(outputLimitText("ko", "own.output.omitDeepSeek", NUMBERS)).toContain("65,536을 보내요")
    expect(outputLimitText("ko", "own.output.range", NUMBERS)).toBe("4,096에서 1,000,000 사이의 숫자로 넣어 주세요.")
    expect(outputLimitText("ko", "own.output.resetDone", NUMBERS)).toBe("기본값(256,000을 넘기지 않기)으로 되돌렸어요.")
    expect(outputLimitText("en", "own.output.omitClaude", NUMBERS)).toContain("32,000 is sent")
  })

  test("every Korean line has an English one, in the polite style and without leftover placeholders", () => {
    for (const key of Object.keys(outputLimitKo) as Array<keyof typeof outputLimitKo>) {
      expect(outputLimitEn[key]).toBeDefined()
      for (const locale of ["ko", "en"] as const) expect(outputLimitText(locale, key, NUMBERS)).not.toMatch(/\{\w+\}/)
    }
    const sentences = Object.values(outputLimitKo).filter((line) => line.endsWith("."))
    for (const line of sentences) expect(line).toMatch(/요\.$/)
  })
})

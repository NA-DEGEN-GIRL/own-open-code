import { describe, expect, test } from "bun:test"
import { en } from "./en"
import { translate } from "./index"
import { applyJosa, finalSound } from "./josa"
import { ko } from "./ko"

describe("particles (03 §14 조사 처리)", () => {
  test("(으)로 after a vowel, ㄹ, or another final consonant", () => {
    expect(applyJosa("개인 Pro(으)로 전환됨")).toBe("개인 Pro로 전환됨")
    expect(applyJosa("회사(으)로")).toBe("회사로")
    expect(applyJosa("서울(으)로")).toBe("서울로")
    expect(applyJosa("집(으)로")).toBe("집으로")
    expect(applyJosa("모델 3(으)로")).toBe("모델 3으로")
    expect(applyJosa("모델 1(으)로")).toBe("모델 1로")
  })

  test("(이)가 and friends", () => {
    expect(applyJosa("휴대폰(이)가")).toBe("휴대폰이")
    expect(applyJosa("노트북(이)가")).toBe("노트북이")
    expect(applyJosa("태블릿(이)가")).toBe("태블릿이")
    expect(applyJosa("PC(이)가")).toBe("PC가")
    expect(applyJosa("계정(을)를")).toBe("계정을")
    expect(applyJosa("키(을)를")).toBe("키를")
  })

  test("skips closing punctuation before the particle", () => {
    expect(finalSound('"회사"', 4)).toBe("")
    expect(applyJosa('"집"(으)로')).toBe('"집"으로')
    // A name cut short with `…` reads as its last kept sound.
    expect(applyJosa("긴 이름의 집…(으)로")).toBe("긴 이름의 집…으로")
    expect(applyJosa("긴 이름의 회사…(으)로")).toBe("긴 이름의 회사…로")
  })

  test("translate fills params, then resolves particles (Korean only)", () => {
    expect(translate("ko", "own.switch.applied", { to: "회사 · prod" })).toBe("회사 · prod로 전환됨")
    expect(translate("ko", "own.composer.steerNote", { account: "개인 Pro" })).toBe(
      "지금 끼워 넣으면 개인 Pro로 실행돼요",
    )
    expect(translate("en", "own.banner.offline", { n: 3 })).toBe("Disconnected — reconnecting (attempt 3)")
    expect(translate("en", "own.switch.optNow")).toBe("Switch now")
  })

  test("the English catalog only has keys that exist in Korean", () => {
    for (const key of Object.keys(en)) expect(Object.hasOwn(ko, key)).toBe(true)
  })
})

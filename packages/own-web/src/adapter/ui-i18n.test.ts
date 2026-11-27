// session-ui strings follow the own-web locale (03 §14: @opencode/ui/i18n/ko for session-ui areas).
import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { fill, uiI18nSource } from "./ui-i18n"

describe("ui i18n bridge", () => {
  test("Korean with English fallback, {{params}}, plural categories with `.other` fallback", () => {
    const [locale, setLocale] = createSignal<"ko" | "en">("ko")
    const source = uiI18nSource(locale)
    expect(source.locale()).toBe("ko-KR")
    expect(source.t("ui.sessionReview.title")).toBe("세션 변경 사항")
    expect(source.plural("ui.messagePart.context.read", 3)).toBe("3개 읽음")
    setLocale("en")
    expect(source.t("ui.sessionReview.title")).not.toBe("세션 변경 사항")
    expect(source.plural("ui.messagePart.context.read", 1)).toContain("1")
    expect(fill("{{a}} and {{ b }}", { a: 1, b: "x" })).toBe("1 and x")
  })

  test("labels session-ui's Korean lacks come from the own catalog in both locales", () => {
    const [locale, setLocale] = createSignal<"ko" | "en">("ko")
    const source = uiI18nSource(locale)
    expect(source.t("ui.messagePart.compaction.queued")).toBe("문맥 압축 대기 중")
    expect(source.t("ui.message.moreActions")).toBe("메시지 메뉴")
    expect(source.t("ui.message.tokensPerSecond", { value: "42.5" })).toBe("42.5 t/s")
    setLocale("en")
    expect(source.t("ui.messagePart.compaction.queued")).toBe("Context compaction queued")
    expect(source.t("ui.message.moreActions")).toBe("More actions")
    expect(source.t("ui.message.tokensPerSecond", { value: "42.5" })).toBe("42.5 t/s")
  })

  test("18.7: a prompt's menu restores, the newest one's `Undo` too (복원, never 되돌리기)", () => {
    const source = uiI18nSource(() => "ko")
    expect(source.t("ui.message.revertMessage")).toBe("이 지점으로 복원")
    expect(source.t("ui.message.undoMessage")).toBe("이 지점으로 복원")
    expect(source.t("ui.message.moveToQueue")).toBe("대기열로 옮기기")
    expect(source.t("ui.message.deletePending")).toBe("대기 메시지 취소")
  })
})

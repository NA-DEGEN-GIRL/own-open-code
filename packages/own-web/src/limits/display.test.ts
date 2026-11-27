// 설정 > 일반 > 한도 표시 (03 §7.2, §5.7): remaining by default, used on request; the per-surface densities with their
// defaults; one formatter for every surface; colors keyed on what remains; screen-reader text that names the mode.
// Solid components do not render under `bun test` (see accounts/ds-balance.test.tsx), so the surfaces' wiring is
// checked in their source.
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { Limit } from "@own/protocol"
import { createI18n } from "@/i18n"
import {
  DEFAULT_LIMIT_DISPLAY,
  fill,
  LIMIT_DISPLAY_KEY,
  limitDensity,
  limitDisplay,
  limitMode,
  limitNumber,
  limitSpeech,
  limitText,
  parseLimitDisplay,
  remainingOf,
  resetLimitDisplay,
  setLimitDensity,
  setLimitMode,
  shown,
  valueText,
  windowsTitle,
} from "./display"
import { limitSummaryText } from "./summary-strings"
import { tone, view } from "./windows"

const ko = createI18n("ko")
const en = createI18n("en")
const MIN = 60_000
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime()

function window(patch: Partial<Limit.Window> = {}): Limit.Window {
  return {
    id: "codex.primary",
    accountID: "acc_a" as Limit.Window["accountID"],
    providerID: "own-codex-abcd" as Limit.Window["providerID"],
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    usedPercent: 38,
    resetAt: NOW + 2 * 60 * MIN + 14 * MIN,
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: NOW - MIN,
    ...patch,
  }
}

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, "..", file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

afterEach(() => resetLimitDisplay())

describe("the setting (5.7 일반 > 한도 표시)", () => {
  test("defaults: remaining; every surface folded (간단히, LV 2026-10-24)", () => {
    resetLimitDisplay()
    expect(limitDisplay()).toEqual(DEFAULT_LIMIT_DISPLAY)
    expect(limitMode()).toBe("remaining")
    expect(limitDensity("accounts")).toBe("simple")
    expect(limitDensity("lists")).toBe("simple")
  })

  test("a stored value is parsed once; unknown or missing parts take the defaults", () => {
    expect(parseLimitDisplay(null)).toEqual(DEFAULT_LIMIT_DISPLAY)
    expect(parseLimitDisplay("not json")).toEqual(DEFAULT_LIMIT_DISPLAY)
    expect(parseLimitDisplay('{"mode":"used"}')).toEqual({ mode: "used", density: DEFAULT_LIMIT_DISPLAY.density })
    expect(parseLimitDisplay({ mode: "half", density: { accounts: "minimal", lists: "huge" } })).toEqual({
      mode: "remaining",
      density: { accounts: "minimal", lists: "simple" },
    })
  })

  test("changes are kept per viewer in localStorage and reset clears them", () => {
    setLimitMode("used")
    setLimitDensity("lists", "minimal")
    expect(limitMode()).toBe("used")
    expect(limitDensity("lists")).toBe("minimal")
    expect(limitDensity("accounts")).toBe("simple")
    expect(parseLimitDisplay(localStorage.getItem(LIMIT_DISPLAY_KEY))).toEqual({
      mode: "used",
      density: { accounts: "simple", lists: "minimal" },
    })
    resetLimitDisplay()
    expect(localStorage.getItem(LIMIT_DISPLAY_KEY)).toBeNull()
    expect(limitDisplay()).toEqual(DEFAULT_LIMIT_DISPLAY)
  })

  test("another window's change arrives through the storage event", () => {
    const value = JSON.stringify({ mode: "used", density: { accounts: "detailed", lists: "detailed" } })
    window_().dispatchEvent(new StorageEvent("storage", { key: LIMIT_DISPLAY_KEY, newValue: value }))
    expect(limitMode()).toBe("used")
    expect(limitDensity("accounts")).toBe("detailed")
    expect(limitDensity("lists")).toBe("detailed")
  })
})

describe("one formatter for every surface (7.2)", () => {
  test("remaining mode: the bar starts full and shrinks, `남음 62%`", () => {
    expect(remainingOf(38)).toBe(62)
    expect(remainingOf(104)).toBe(0)
    expect(shown(38, "remaining")).toBe(62)
    expect(fill(38, "remaining")).toBe(62)
    expect(fill(0, "remaining")).toBe(100)
    expect(fill(120, "remaining")).toBe(0)
    expect(limitText(ko, 38, "remaining")).toBe("남음 62%")
    expect(limitText(ko, 91.5, "remaining")).toBe("남음 8.5%")
    expect(limitText(en, 38, "remaining")).toBe("62% left")
    expect(limitNumber(38, "remaining")).toBe("62%")
  })

  test("used mode: the bar fills up, `사용 38%`", () => {
    expect(shown(38, "used")).toBe(38)
    expect(fill(38, "used")).toBe(38)
    expect(fill(120, "used")).toBe(100)
    expect(limitText(ko, 38, "used")).toBe("사용 38%")
    expect(limitText(en, 38, "used")).toBe("38% used")
    expect(limitNumber(38, "used")).toBe("38%")
  })

  test("without a mode argument the stored setting decides, remaining by default", () => {
    expect(limitText(ko, 38)).toBe("남음 62%")
    setLimitMode("used")
    expect(limitText(ko, 38)).toBe("사용 38%")
    expect(fill(38)).toBe(38)
  })

  test("colors are keyed on what remains and mean the same in both modes", () => {
    expect(tone(69)).toBe("neutral")
    expect(tone(70)).toBe("warn") // 30 % left
    expect(tone(89)).toBe("warn")
    expect(tone(90)).toBe("danger") // 10 % left
    expect(tone(10, "exhausted")).toBe("danger")
    expect(tone(undefined, "warning")).toBe("warn")
    expect(tone(undefined, "ok")).toBe("neutral")
  })
})

describe("screen readers and hover text name the mode", () => {
  test("the meter sentence says 남음 or 사용 explicitly", () => {
    const item = view(window(), NOW)
    expect(limitSpeech(ko, 38, "remaining")).toBe("62% 남음")
    expect(limitSpeech(ko, 38, "used")).toBe("38% 사용")
    expect(valueText(ko, item, NOW, "remaining")).toBe("5시간 한도 62% 남음, 2시간 14분 후 리셋, 1분 전 관측")
    expect(valueText(ko, item, NOW, "used")).toBe("5시간 한도 38% 사용, 2시간 14분 후 리셋, 1분 전 관측")
    expect(valueText(en, item, NOW, "remaining")).toContain("5시간 limit 62% left")
  })

  test("unknown values stay unknown; an estimated reset reads 리셋됨(추정) from full", () => {
    expect(valueText(ko, view(window({ usedPercent: undefined, confidence: "unknown" }), NOW), NOW)).toContain(
      "알 수 없음",
    )
    const reset = view(window({ resetAt: NOW - MIN, observedAt: NOW - 10 * MIN }), NOW)
    expect(valueText(ko, reset, NOW, "remaining")).toContain("100% 남음, 리셋됨(추정)")
  })

  test("the compact views' hover text lists every primary window", () => {
    const windows = [
      window(),
      window({ id: "codex.secondary", label: "주간", usedPercent: 81, resetAt: undefined }),
      window({ id: "rate", kind: "rate", label: "분당", usedPercent: 5 }),
    ]
    expect(windowsTitle(ko, windows, NOW, "remaining")).toBe("5시간 남음 62% · 2시간 14분 후 리셋\n주간 남음 19%")
    expect(windowsTitle(ko, windows, NOW, "used")).toBe("5시간 사용 38% · 2시간 14분 후 리셋\n주간 사용 81%")
  })
})

describe("strings and wiring", () => {
  test("Korean and English labels of the setting, in the lazy catalog (PF5)", () => {
    const text = limitSummaryText.text
    expect(text("ko", "own.set.limits")).toBe("한도 표시")
    expect(text("ko", "own.set.limits.mode.remaining")).toBe("남은 양")
    expect(text("ko", "own.set.limits.mode.used")).toBe("쓴 양")
    expect(text("ko", "own.set.limits.density.detailed")).toBe("자세히")
    expect(text("ko", "own.set.limits.density.simple")).toBe("간단히")
    expect(text("ko", "own.set.limits.density.minimal")).toBe("아주 간단히")
    expect(text("en", "own.set.limits")).toBe("Limit display")
    expect(text("ko", "own.set.limits.describe.simple")).toBe(
      "가장 빠듯한 한도 둘과 리셋 시각을 한 줄로 보여요. 누르면 모든 한도가 펼쳐져요. 사이드바와 입력창은 막대 하나예요. 입력창에 자리가 모자라면 작은 고리예요.",
    )
  })

  test("설정 > 일반 shows the row with a preview of every density", async () => {
    expect(await code("settings/sections.tsx")).toContain("<LimitDisplaySetting />")
    const setting = await code("limits/display-setting.tsx")
    expect(setting).toContain("<For each={LIMIT_DENSITIES}>")
    expect(setting).toContain("<PreviewCard density={density}")
    // Each density previews the summary (cards, tab, dashboard) and the bar as the sidebar draws it: the windows named
    // at 간단히 too, and at 자세히 one per row under the name (UX 2026-10-26).
    expect(setting).toContain('<AccountLimits windows={props.windows} surface="accounts" density={props.density}')
    expect(setting).toMatch(/<LimitGlance\s+windows=\{props\.windows\}\s+density=\{props\.density\}/)
    expect(setting).toContain('layout={props.density === "detailed" ? "rows" : "inline"}')
    expect(await code("sidebar/accounts-in-use.tsx")).toContain('layout={detailed() ? "rows" : "inline"}')
  })

  test("every limit surface draws through the shared display", async () => {
    expect(await code("accounts/account-card.tsx")).toMatch(/<AccountLimits\s+surface="accounts"/)
    expect(await code("accounts/claude-slot.tsx")).toContain('surface="accounts"')
    expect(await code("limits/index.tsx")).toMatch(/<AccountLimits\s+surface="accounts"/)
    expect(await code("limits/panel-tab.tsx")).toContain('<AccountLimits surface="lists"')
    expect(await code("limits/summary.tsx")).toContain("props.density ?? limitDensity(props.surface)")
    expect(await code("switcher/popover.tsx")).toContain('max={limitDensity("lists") === "minimal" ? 1 : 2}')
    // The composer's button draws one window at every density, the ring at 아주 간단히 (UX 2026-10-26) and where the
    // toolbar folded it for room (UX 2026-10-27, composer/limit-fit.ts).
    expect(await code("composer/binding-button.tsx")).toContain(
      'density={props.fold || limitDensity("lists") === "minimal" ? "minimal" : "simple"}',
    )
    expect(await code("sidebar/accounts-in-use.tsx")).toContain('density={limitDensity("lists")}')
    expect(await code("sidebar/rows.tsx")).toContain("windowValue(i18n, props.item)")
    // No surface writes a used percent by hand any more.
    for (const file of ["composer/binding-button.tsx", "switcher/popover.tsx", "sidebar/accounts-in-use.tsx"])
      expect(await code(file)).not.toMatch(/usedPercent \?\? 0\)\}%|formatPercent\(/)
  })
})

function window_() {
  return globalThis.window
}

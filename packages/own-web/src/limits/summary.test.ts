// The limits summary (03 §7.2, LV 2026-10-24): the folded line and the unfolded rows' words for every kind, from the
// windows the router really sends (Claude's through `Unified.parse` on the header sets users posted). Solid components
// do not render under `bun test` (see accounts/ds-balance.test.tsx): the words come from ./summary-model, which the
// components only lay out, and the wiring of every surface is checked in its source; the browser e2e clicks it open.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Unified, type Limit } from "@own/protocol"
import { createI18n } from "@/i18n"
import { ko } from "@/i18n/ko"
import { stateWord, windowsTitle, windowValue } from "./display"
import { when } from "./format"
import { foldedGroups, foldedParts, reasonText, resetLong, rows, stateTone, windowNote } from "./summary-model"
import { limitSummaryKo, limitSummaryText } from "./summary-strings"
import { ranked, view } from "./windows"

const i18n = createI18n("ko")
const en = createI18n("en")
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = new Date(2026, 9, 24, 15, 26, 0).getTime()
const P = "anthropic-ratelimit-unified-"

const line = (windows: readonly Limit.Window[], max = 2, at = NOW, model?: string) =>
  foldedParts(i18n, windows, at, max, undefined, model)
    .map((part) => part.text)
    .join(" · ")
const claude = (values: Record<string, string>, at: number) =>
  Unified.parse(
    new Headers(Object.fromEntries(Object.entries(values).map(([name, value]) => [`${P}${name}`, value]))),
    at,
  )

function window(patch: Partial<Limit.Window> = {}): Limit.Window {
  return {
    id: "codex.primary",
    accountID: "acc_a" as Limit.Window["accountID"],
    providerID: "own-codex-abcd" as Limit.Window["providerID"],
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    windowMinutes: 300,
    usedPercent: 84,
    resetAt: NOW + HOUR + 5 * MIN,
    status: "warning",
    confidence: "live",
    source: "header",
    observedAt: NOW - MIN,
    ...patch,
  }
}

describe("folded line: the tightest windows, the first one's reset after it", () => {
  test("Claude (#12829): the week, 26 % left, before the 5 hours the claim names; nothing hidden on hover", () => {
    // An hour before the posted 5-hour reset; the weekly reset is 18 hours away.
    const at = Date.UTC(2025, 11, 1, 1, 0, 0)
    const windows = claude(
      {
        status: "allowed",
        "5h-status": "allowed",
        "5h-reset": "1764554400",
        "5h-utilization": "0.018416969696969696",
        "7d-status": "allowed",
        "7d-reset": "1764615600",
        "7d-utilization": "0.7370692663445869",
        "representative-claim": "five_hour",
        reset: "1764554400",
      },
      at - MIN,
    )
    expect(line(windows, 2, at)).toBe("주간 남음 26% · 18시간 후 리셋 · 5시간 남음 98%")
    expect(line(windows, 1, at)).toBe("주간 남음 26% · 18시간 후 리셋")
    expect(windowsTitle(i18n, windows, at)).toBe("5시간 남음 98% · 1시간 후 리셋\n주간 남음 26% · 18시간 후 리셋")
    expect(foldedParts(i18n, windows, at, 2).map((part) => [part.role, part.tone])).toEqual([
      ["window", "warn"],
      ["reset", "neutral"],
      ["window", "neutral"],
    ])
  })

  test("Claude without a five-hour window (verified Ultra, 02 §7.1.2): the week alone, no 5시간 anywhere", () => {
    const at = Date.UTC(2025, 11, 1, 1, 0, 0)
    const windows = claude(
      {
        status: "allowed",
        "7d-status": "allowed",
        "7d-reset": "1764615600",
        "7d-utilization": "0.7370692663445869",
        "representative-claim": "seven_day",
        reset: "1764615600",
      },
      at - MIN,
    )
    expect(line(windows, 2, at)).toBe("주간 남음 26% · 18시간 후 리셋")
    expect(windowsTitle(i18n, windows, at)).toBe("주간 남음 26% · 18시간 후 리셋")
    expect(rows(windows, false, at).map((item) => item.id)).toEqual(["claude.7d"])
    // The same account a moment earlier, with the five hours: both, as before.
    const before = [...claude({ "5h-utilization": "0.02", "5h-reset": "1764554400" }, at - MIN), ...windows]
    expect(rows(before, false, at).map((item) => item.id)).toEqual(["claude.5h", "claude.7d"])
    expect(line(before, 2, at)).toBe("주간 남음 26% · 18시간 후 리셋 · 5시간 남음 98%")
  })

  test("Claude (#5920): the exhausted 주간 · Fable leads a Fable session only, and only there the refused extra usage closes the line", () => {
    const windows = claude(
      {
        status: "rejected",
        "representative-claim": "seven_day_overage_included",
        "5h-status": "allowed",
        "5h-utilization": "0.23",
        "7d-status": "allowed",
        "7d-utilization": "0.73",
        "7d_oi-status": "rejected",
        "7d_oi-utilization": "1.02",
        "overage-status": "rejected",
        "overage-disabled-reason": "org_spend_cap_reached",
      },
      NOW - MIN,
    )
    expect(line(windows, 2, NOW, "claude-fable-5-1")).toBe("주간 · Fable 남음 0% · 주간 남음 27% · 추가 사용량 거절됨")
    expect(foldedParts(i18n, windows, NOW, 2, undefined, "claude-fable-5-1").map((part) => part.tone)).toEqual([
      "danger",
      "warn",
      "danger",
    ])
    // The account and another model: the bucket limits Fable only, so the account-wide windows lead, and extra usage,
    // headroom past the plan, is a quiet note of the unfolded rows: nothing it would cover is used up (LV).
    expect(line(windows)).toBe("주간 남음 27% · 5시간 남음 77%")
    expect(line(windows, 2, NOW, "claude-sonnet-4-5")).toBe("주간 남음 27% · 5시간 남음 77%")
    // Nothing is hidden: the hover names the bucket with its model.
    expect(windowsTitle(i18n, windows, NOW).split("\n")).toEqual([
      "5시간 남음 77%",
      "주간 남음 27%",
      "주간 · Fable 남음 0%",
      "추가 사용량 차단",
    ])
  })

  test("Claude: a claimed 주간 · Opus known only as blocked leads an Opus session, with the top-level reset", () => {
    const windows = claude(
      {
        status: "rejected",
        reset: String(Math.floor((NOW + 2 * 24 * HOUR) / 1000)),
        "representative-claim": "seven_day_opus",
        "5h-utilization": "0.12",
        "7d-utilization": "0.44",
      },
      NOW - MIN,
    )
    expect(ranked(windows, NOW, "claude-opus-5-5").map((item) => item.id)).toEqual([
      "claude.7d_opus",
      "claude.7d",
      "claude.5h",
    ])
    // Two days on, a Monday: the weekday and the clock.
    expect(line(windows, 2, NOW, "claude-opus-5-5")).toBe("주간 · Opus 차단 · 월 오후 3:26 리셋 · 주간 남음 56%")
    expect(line(windows)).toBe("주간 남음 56% · 5시간 남음 88%")
  })

  test("Codex: 5 hours and weekly; credits only past them; per-minute windows never", () => {
    const windows = [
      window(),
      window({ id: "codex.secondary", label: "주간", windowMinutes: 10_080, usedPercent: 61, status: "ok" }),
      window({
        id: "codex.credits",
        kind: "balance",
        label: "크레딧",
        usedPercent: undefined,
        resetAt: undefined,
        remaining: 42.6,
        unit: "credits",
      }),
      window({ id: "oai.requests", kind: "rate", label: "분당 요청", usedPercent: 99, status: "ok" }),
    ]
    expect(line(windows)).toBe("5시간 남음 16% · 1시간 5분 후 리셋 · 주간 남음 39%")
    expect(line(windows, 3)).toBe("5시간 남음 16% · 1시간 5분 후 리셋 · 주간 남음 39% · 크레딧 ≈42.6 cr")
  })

  test("DeepSeek: the balance and a live bonus; an API key: its budget; nothing known: no part at all", () => {
    const balance = (id: string, label: string, remaining: number) =>
      window({ id, kind: "balance", label, usedPercent: undefined, resetAt: undefined, remaining, unit: "CNY" })
    expect(line([balance("ds.balance", "잔액", 12.3), balance("ds.balance.granted", "보너스", 5)])).toBe(
      "잔액 ¥12.30 · 보너스 ¥5.00",
    )
    const budget = window({
      id: "api.budget_month",
      kind: "budget",
      label: "이번 달 예산",
      usedPercent: 23.1,
      remaining: 76.9,
      limit: 100,
      unit: "USD",
      status: "ok",
      source: "ledger",
      resetAt: undefined,
    })
    expect(line([budget, window({ id: "anth.requests", kind: "rate", label: "분당 요청", usedPercent: 2 })])).toBe(
      "이번 달 예산 남음 77%",
    )
    // A DeepSeek key with a budget: the balance first while the budget has room, the budget first once it is tight.
    expect(line([budget, balance("ds.balance", "잔액", 7.42)])).toBe("잔액 ¥7.42 · 이번 달 예산 남음 77%")
    expect(line([{ ...budget, usedPercent: 92, remaining: 8 }, balance("ds.balance", "잔액", 7.42)])).toBe(
      "이번 달 예산 남음 8% · 잔액 ¥7.42",
    )
    expect(foldedParts(i18n, [window({ confidence: "unknown", usedPercent: undefined })], NOW, 2)).toEqual([])
  })

  test("the reset goes with its window, in parentheses and with no separator before it (UX 2026-10-26)", () => {
    const windows = [
      window({ id: "codex.secondary", label: "주간", windowMinutes: 10_080, usedPercent: 80, resetAt: NOW + 3 * HOUR + 45 * MIN }),
      window({ usedPercent: 1, status: "ok", resetAt: NOW + 2 * HOUR }),
    ]
    const groups = foldedGroups(foldedParts(i18n, windows, NOW, 2))
    // Each group is one piece of the line that carries its `·` before it (styles/seps.css `.own-seps`).
    expect(
      groups.map((group) =>
        [group.part.text, group.reset && limitSummaryText.text("ko", "own.lim.sum.reset", { reset: group.reset.text })]
          .filter(Boolean)
          .join(" "),
      ),
    ).toEqual(["주간 남음 20% (3시간 45분 후 리셋)", "5시간 남음 99%"])
    expect(groups.map((group) => group.part.role)).toEqual(["window", "window"])
    expect(limitSummaryText.text("en", "own.lim.sum.reset", { reset: "resets in 2 h" })).toBe("(resets in 2 h)")
    // No reset part stands alone, and a billing verdict is a group of its own.
    expect(foldedGroups([{ key: "billing", role: "billing", text: "추가 사용량 거절됨", tone: "danger" }])).toEqual([
      { part: { key: "billing", role: "billing", text: "추가 사용량 거절됨", tone: "danger" }, reset: undefined },
    ])
  })

  test("the used mode and English follow the shared formatter", () => {
    const windows = [window(), window({ id: "codex.secondary", label: "주간", usedPercent: 61, resetAt: undefined })]
    expect(
      foldedParts(i18n, windows, NOW, 2, "used")
        .map((part) => part.text)
        .join(" · "),
    ).toBe("5시간 사용 84% · 1시간 5분 후 리셋 · 주간 사용 61%")
    expect(
      foldedParts(en, windows, NOW, 2)
        .map((part) => part.text)
        .join(" · "),
    ).toBe("5시간 16% left · resets in 1 h 5 min · 주간 39% left")
  })
})

describe("unfolded rows: the clock time, state words, the response's reasons", () => {
  test("a credits window with nothing known or nothing left stays out unless it leads or warns (UX 2026-10-26)", () => {
    const credits = (patch: Partial<Limit.Window>) =>
      window({
        id: "codex.credits",
        kind: "balance",
        label: "크레딧",
        usedPercent: undefined,
        resetAt: undefined,
        unit: "credits",
        status: "unknown",
        ...patch,
      })
    const plan = [window(), window({ id: "codex.secondary", label: "주간", usedPercent: 61, status: "ok" })]
    const ids = (list: readonly Limit.Window[]) => rows(list, false, NOW).map((item) => item.id)
    // A Plus account without credits (`has-credits: False`): `크레딧 — 알 수 없음` said nothing.
    expect(ids([...plan, credits({ confidence: "unknown" })])).toEqual(["codex.primary", "codex.secondary"])
    expect(ids([...plan, credits({ remaining: 0 })])).toEqual(["codex.primary", "codex.secondary"])
    // An amount, or a state that warns, is shown.
    expect(ids([...plan, credits({ remaining: 42.6, status: "ok" })])).toEqual([
      "codex.primary",
      "codex.secondary",
      "codex.credits",
    ])
    expect(ids([...plan, credits({ remaining: 0, status: "exhausted" })])).toContain("codex.credits")
    // Alone, it leads the account and stays.
    expect(ids([credits({ remaining: 0 })])).toEqual(["codex.credits"])
    // Other balances are never left out.
    expect(ids([window({ id: "ds.balance", kind: "balance", label: "잔액", usedPercent: undefined, remaining: 0, unit: "CNY" })])).toEqual(["ds.balance"])
  })

  test("a reset gives the duration and the clock time; past today the weekday, past 6 days the date", () => {
    expect(resetLong(i18n, NOW, NOW + 2 * HOUR + 14 * MIN)).toBe("2시간 14분 후 리셋 (오후 5:40)")
    expect(when(i18n, NOW, new Date(2026, 9, 25, 9, 0).getTime())).toBe("일 오전 9:00")
    expect(when(i18n, NOW, new Date(2026, 10, 3, 9, 0).getTime())).toBe("11월 3일 오전 9:00")
    expect(resetLong(i18n, NOW, new Date(2026, 9, 27, 9, 0).getTime())).toBe("2일 17시간 후 리셋 (화 오전 9:00)")
    expect(resetLong(en, NOW, NOW + 2 * HOUR + 14 * MIN)).toBe("resets in 2 h 14 min (5:40 PM)")
  })

  test("a window known only by its state reads 허용 / 주의 / 차단 (03 §7.1)", () => {
    expect(stateWord(i18n, "ok")).toBe("허용")
    expect(stateWord(i18n, "warning")).toBe("주의")
    expect(stateWord(i18n, "exhausted")).toBe("차단")
    const overage = claude({ status: "allowed", "overage-status": "rejected" }, NOW - MIN)[0]!
    expect(windowValue(i18n, view(overage, NOW))).toBe("차단")
    // Extra usage switched off is no limit reached: neutral; a refusal only while it goes with a used-up plan limit it
    // would cover (`covering`), else a quiet note (LV).
    expect(stateTone(view(overage, NOW), overage, true)).toBe("neutral")
    const refused = Unified.refused([overage], NOW)[0]!
    expect(stateTone(view(refused, NOW), refused, true)).toBe("danger")
    expect(stateTone(view(refused, NOW), refused, false)).toBe("neutral")
    const opus = claude({ status: "rejected", "representative-claim": "seven_day_opus" }, NOW - MIN)[0]!
    expect(stateTone(view(opus, NOW), opus, false)).toBe("danger")
    expect(windowValue(i18n, view(window({ confidence: "unknown", usedPercent: undefined }), NOW))).toBe("— 알 수 없음")
    // Codex credits that only say they exist have no amount and are no state window.
    const credits = window({
      id: "codex.credits",
      kind: "balance",
      label: "크레딧",
      usedPercent: undefined,
      status: "ok",
    })
    expect(windowValue(i18n, view(credits, NOW))).toBe("— 알 수 없음")
  })

  test("Claude's extra usage row says what the response said: the verdict and the reason, the raw value on hover", () => {
    const [overage] = claude(
      { status: "allowed", "overage-status": "rejected", "overage-disabled-reason": "org_level_disabled" },
      NOW - MIN,
    )
    expect(windowNote(i18n, overage!, true)).toEqual({
      text: "꺼져 있어요",
      tone: "neutral",
      title: "overage-disabled-reason: org_level_disabled",
    })
    const [billed] = claude(
      { status: "rejected", "overage-status": "allowed", "overage-reset": "1793491200" },
      NOW - MIN,
    )
    expect(windowNote(i18n, billed!, true)).toEqual({ text: "추가 사용량으로 청구 중", tone: "warn", title: undefined })
    // Without a used-up plan limit to cover, the verdict is a quiet note.
    expect(windowNote(i18n, billed!, false)).toEqual({ text: "추가 사용량으로 청구 중", tone: "neutral", title: undefined })
    expect(windowNote(i18n, window(), true)).toBeUndefined()
    expect(
      [
        "org_level_disabled_until",
        "member_level_disabled",
        "out_of_credits",
        "seat_tier_zero_credit_limit",
        "org_spend_cap_reached",
        "overage_not_provisioned",
        "fetch_error",
      ].map((reason) => reasonText(i18n, reason)),
    ).toEqual([
      "꺼져 있어요",
      "꺼져 있어요",
      "크레딧이 없어요",
      "크레딧 한도가 0이에요",
      "지출 한도에 닿았어요",
      "이 요금제에는 없어요",
      "fetch_error",
    ])
  })
})

describe("wiring (every surface, PF5)", () => {
  /** Source without comments, so names in comments are not taken for code. */
  const code = async (file: string) =>
    (await Bun.file(path.join(import.meta.dir, "..", file)).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")

  test("the cards, the 계정·한도 tab and the dashboard fold through AccountLimits; the switcher rows show its line", async () => {
    for (const file of [
      "accounts/account-card.tsx",
      "accounts/claude-slot.tsx",
      "accounts/claude-accounts.tsx",
      "limits/index.tsx",
    ])
      expect(await code(file)).toMatch(/<AccountLimits\s+surface="accounts"/)
    expect(await code("limits/panel-tab.tsx")).toContain('<AccountLimits surface="lists"')
    const switcher = await code("switcher/popover.tsx")
    expect(switcher).toContain("<LimitSummaryLine")
    // A listbox option holds no button: the switcher imports the line alone.
    expect(switcher).toContain('import { LimitSummaryLine } from "@/limits/summary-line"')
    expect(switcher).not.toContain("<AccountLimits")
  })

  test("the summary is a button that names its state and starts unfolded only at 자세히", async () => {
    const summary = await code("limits/summary.tsx")
    expect(summary).toContain('createSignal(density() === "detailed")')
    expect(summary).toContain("aria-expanded={open()}")
    expect(summary).toContain("aria-controls={open() ? body : undefined}")
    // Folded, the head's name says it unfolds; unfolded, it keeps the tightest value alone and a visible `한도 접기`.
    expect(summary).toContain('fallback={<span class="sr-only">{t("own.lim.sum.show")}</span>}')
    expect(summary).toContain('<span class="own-lsum-hide">{t("own.lim.sum.hide")}</span>')
    expect(summary).toContain("lead={open()}")
    expect(summary).toContain("clock")
    expect(await code("limits/summary-line.tsx")).toContain('{i18n.t("own.limit.unknown")}')
  })

  test("nothing of the summary is in the first chunk: no first-chunk module imports it, its words are lazy", async () => {
    for (const file of [
      "limits/windows.ts",
      "limits/display.ts",
      "limits/glance.tsx",
      "limits/format.ts",
      "composer/binding-button.tsx",
      "sidebar/accounts-in-use.tsx",
      "switcher/picker.ts",
      "data/own-store.ts",
    ])
      expect(await code(file)).not.toMatch(/limits\/summary|\.\/summary/)
    expect(Object.keys(limitSummaryKo).filter((key) => key in ko)).toEqual([])
  })
})

// Limits presentation rules (03 §7.2 bars, §7.3 confidence, §7.5 rounding, §5.5 trend/ETA) and session totals.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Limit, type Ledger } from "@own/protocol"
import { createI18n } from "@/i18n"
import { ago, budget, duration, parseTokens, percent, resetText, resetTitle, tokens, usd } from "./format"
import { add, merge } from "./totals"
import { buckets, eta } from "./trend"
import { confidence, kept, labelOf, ordered, primary, ranked, tightest, tone, view } from "./windows"

const i18n = createI18n("ko")
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = new Date(2026, 8, 26, 12, 6, 0).getTime()

function window(patch: Partial<Limit.Window> = {}): Limit.Window {
  return {
    id: "codex.primary",
    accountID: "acc_a" as Limit.Window["accountID"],
    providerID: "own-codex-abcd" as Limit.Window["providerID"],
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    usedPercent: 62,
    resetAt: NOW + 2 * HOUR + 14 * MIN,
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: NOW - MIN,
    ...patch,
  }
}

describe("window labels in English", () => {
  test.each([
    ["5시간", "5 hours"],
    ["1시간", "1 hour"],
    ["30일", "30 days"],
    ["주간", "Weekly"],
    ["주간 · Opus", "Weekly · Opus"],
    ["이번 달 예산", "Budget this month"],
    ["잔액", "Balance"],
    ["GPT-5.6 Sol", "GPT-5.6 Sol"],
  ])("%s → %s", (korean, english) => {
    expect(labelOf(korean, "en")).toBe(english)
    expect(labelOf(korean, "ko")).toBe(korean)
  })
})

describe("format (7.5 rounding, 7.2 reset text)", () => {
  test("tokens in 1k steps, M above a million", () => {
    expect(tokens(950)).toBe("950")
    expect(tokens(118_400)).toBe("118k")
    expect(tokens(999_499)).toBe("999k")
    expect(tokens(1_200_000)).toBe("1.2M")
    expect(tokens(1_000_000)).toBe("1M")
  })

  test("money: two decimals below $1, one above; exact keeps two", () => {
    expect(usd(0.423)).toBe("$0.42")
    expect(usd(1.34)).toBe("$1.3")
    expect(usd(23.1, true)).toBe("$23.10")
    expect(usd(1234.5, true)).toBe("$1,234.50")
    expect(budget(100, "USD")).toBe("$100")
    expect(budget(76.9, "USD")).toBe("$76.90")
  })

  test("reset text: within 24 hours relative, within 6 days the weekday and clock, then the date (LV)", () => {
    expect(resetText(i18n, NOW, NOW + 42 * MIN)).toBe("42분 후 리셋")
    expect(resetText(i18n, NOW, NOW + 2 * HOUR + 14 * MIN)).toBe("2시간 14분 후 리셋")
    expect(resetText(i18n, NOW, NOW + 3 * HOUR)).toBe("3시간 후 리셋")
    const monday = new Date(2026, 8, 28, 9, 0).getTime()
    expect(resetText(i18n, NOW, monday)).toBe("월 오전 9:00 리셋")
    // Saturday a week on would read like today: the date instead.
    expect(resetText(i18n, NOW, new Date(2026, 9, 3, 9, 0).getTime())).toBe("10월 3일 오전 9:00 리셋")
    expect(resetTitle(i18n, monday)).toBe("2026-09-28 (월) 오전 9:00 리셋")
  })

  test("ages and durations", () => {
    expect(ago(i18n, NOW, NOW - 10_000)).toBe("방금")
    expect(ago(i18n, NOW, NOW - 40 * MIN)).toBe("40분 전")
    expect(ago(i18n, NOW, NOW - 3 * HOUR)).toBe("3시간 전")
    expect(ago(i18n, NOW, NOW - 50 * HOUR)).toBe("2일 전")
    expect(duration(i18n, 26 * HOUR)).toBe("1일 2시간")
  })

  test("typed token counts accept separators and suffixes", () => {
    expect(parseTokens("200,000")).toBe(200_000)
    expect(parseTokens("245k")).toBe(245_000)
    expect(parseTokens("1.2M")).toBe(1_200_000)
    expect(parseTokens("")).toBeUndefined()
    expect(parseTokens("abc")).toBeUndefined()
    expect(percent(62.4)).toBe("62%")
    expect(percent(8.5)).toBe("8.5%")
  })
})

describe("windows (7.2, 7.3)", () => {
  test("a DeepSeek 보너스 window at 0 (spent or expired) is not kept; the balance and a live bonus are", () => {
    const balance = window({ id: "ds.balance", kind: "balance", label: "잔액", usedPercent: undefined, remaining: 9 })
    const bonus = { ...balance, id: "ds.balance.granted", label: "보너스", remaining: 2 }
    const spent = { ...bonus, remaining: 0 }
    const usd = { ...spent, id: "ds.balance.usd.granted" }
    expect(kept([balance, bonus]).map((item) => item.id)).toEqual(["ds.balance", "ds.balance.granted"])
    expect(kept([balance, spent, usd]).map((item) => item.id)).toEqual(["ds.balance"])
    // A balance at 0 is news (잔액 부족), and so is any other window at 0.
    expect(kept([{ ...balance, remaining: 0 }, window({ remaining: 0 })])).toHaveLength(2)
  })

  test("confidence ages on the clock: live ≤ 2 min, recent ≤ 15 min, then stale", () => {
    expect(confidence(window({ observedAt: NOW - MIN }), NOW)).toBe("live")
    expect(confidence(window({ observedAt: NOW - 10 * MIN }), NOW)).toBe("recent")
    expect(confidence(window({ observedAt: NOW - 40 * MIN }), NOW)).toBe("stale")
    expect(confidence(window({ confidence: "estimated", observedAt: NOW - 40 * MIN }), NOW)).toBe("estimated")
  })

  test("tone: neutral < 70 ≤ warn < 90 ≤ danger; exhausted is danger", () => {
    expect(tone(69, "ok")).toBe("neutral")
    expect(tone(70, "ok")).toBe("warn")
    expect(tone(90, "ok")).toBe("danger")
    expect(tone(10, "exhausted")).toBe("danger")
  })

  test("stale values fade, estimates hatch, unknown values draw no bar", () => {
    expect(view(window({ observedAt: NOW - 40 * MIN }), NOW)).toMatchObject({ faded: true, hatched: false })
    expect(view(window({ confidence: "estimated" }), NOW)).toMatchObject({ hatched: true, faded: false })
    expect(view(window({ confidence: "unknown", usedPercent: undefined }), NOW).unknown).toBe(true)
  })

  test("a passed reset without a new observation reads 리셋됨(추정) from 0 %, hatched", () => {
    const item = view(window({ resetAt: NOW - MIN, observedAt: NOW - HOUR, usedPercent: 84 }), NOW)
    expect(item).toMatchObject({ resetEstimated: true, percent: 0, hatched: true, resetAt: undefined })
  })

  test("key limits and rate windows derive the used share from remaining/limit", () => {
    expect(view(window({ kind: "rate", usedPercent: undefined, remaining: 12, limit: 50 }), NOW).percent).toBe(76)
  })

  test("order: plan windows, budgets, balances, per-minute rates last; rates hidden in compact rows", () => {
    const rate = window({ id: "anth.requests", kind: "rate" })
    const budget = window({ id: "api.budget_month", kind: "budget" })
    const weekly = window({ id: "codex.secondary", windowMinutes: 10_080 })
    const hourly = window({ id: "codex.primary", windowMinutes: 300 })
    expect(ordered([rate, budget, weekly, hourly]).map((item) => item.id)).toEqual([
      "codex.primary",
      "codex.secondary",
      "api.budget_month",
      "anth.requests",
    ])
    expect(primary([rate, budget]).map((item) => item.id)).toEqual(["api.budget_month"])
    expect(primary([rate]).map((item) => item.id)).toEqual(["anth.requests"])
  })

  test("mini bar: the least left wins, whatever the Claude claim names; unknown windows never (LV 2026-10-24)", () => {
    // anthropics/claude-code#12829: the claim names the 5 hours (1.8 % used) while the week is 73.7 % used.
    const fiveHour = window({ id: "claude.5h", usedPercent: 1.84, meta: { representative: "five_hour" } })
    const week = window({ id: "claude.7d", usedPercent: 73.71, meta: { representative: "five_hour" } })
    expect(tightest([fiveHour, week], NOW)?.id).toBe("claude.7d")
    expect(ranked([fiveHour, week], NOW).map((item) => item.id)).toEqual(["claude.7d", "claude.5h"])
    expect(tightest([window({ usedPercent: 30 }), window({ id: "codex.secondary", usedPercent: 81 })], NOW)?.id).toBe(
      "codex.secondary",
    )
    expect(tightest([window({ confidence: "unknown", usedPercent: undefined })], NOW)).toBeUndefined()
  })

  test("mini bar: an exhausted window comes first, the one that frees last before the others", () => {
    const five = window({ id: "claude.5h", usedPercent: 100, status: "exhausted", resetAt: NOW + HOUR })
    const fable = window({
      id: "claude.7d_oi",
      usedPercent: 102,
      status: "exhausted",
      resetAt: NOW + 3 * 24 * HOUR,
      windowMinutes: 10_080,
    })
    const week = window({ id: "claude.7d", usedPercent: 99, status: "warning", windowMinutes: 10_080 })
    expect(ranked([week, five, fable], NOW, "claude-fable-5-1").map((item) => item.id)).toEqual([
      "claude.7d_oi",
      "claude.5h",
      "claude.7d",
    ])
    // Exhausted without a reset: blocked for good, so first.
    const stuck = window({ id: "codex.secondary", usedPercent: 100, status: "exhausted", resetAt: undefined })
    expect(tightest([fable, stuck], NOW, "claude-fable-5-1")?.id).toBe("codex.secondary")
  })

  test("a model weekly bucket leads only for its model; one without a reset stops leading once stale (LV)", () => {
    const five = window({ id: "claude.5h", usedPercent: 23, resetAt: undefined })
    const week = window({ id: "claude.7d", usedPercent: 73, resetAt: undefined, windowMinutes: 10_080 })
    // router-for-me/CLIProxyAPI#5920: the Fable bucket at 102 %, rejected, no reset.
    const fable = window({
      id: "claude.7d_oi",
      label: "주간 · Fable",
      usedPercent: 102,
      status: "exhausted",
      resetAt: undefined,
      windowMinutes: 10_080,
    })
    const ids = (model: string | undefined, at = NOW) => ranked([five, week, fable], at, model).map((item) => item.id)
    expect(ids("claude-fable-5-1")).toEqual(["claude.7d_oi", "claude.7d", "claude.5h"])
    expect(ids("claude-sonnet-4-5")).toEqual(["claude.7d", "claude.5h"])
    expect(ids(undefined)).toEqual(["claude.7d", "claude.5h"])
    // Its last value stays on screen, faded and tagged stale, without its state; it no longer leads.
    const later = NOW + 16 * MIN
    expect(ids("claude-fable-5-1", later)).toEqual(["claude.7d", "claude.5h"])
    expect(view(fable, later)).toMatchObject({ percent: 102, status: "unknown", confidence: "stale", faded: true })
    // A claimed Opus week known only as blocked leads an Opus session like any exhausted window.
    const opus = window({
      id: "claude.7d_opus",
      label: "주간 · Opus",
      usedPercent: undefined,
      status: "exhausted",
      resetAt: NOW + 2 * 24 * HOUR,
    })
    expect(tightest([five, week, opus], NOW, "claude-opus-5-5")?.id).toBe("claude.7d_opus")
    expect(tightest([five, week, opus], NOW, "claude-sonnet-4-5")?.id).toBe("claude.7d")
  })

  test("ETA: slope of the last 30 minutes, hidden under 3 points or when the reset comes first", () => {
    const points = [
      { at: NOW - 20 * MIN, percent: 60 },
      { at: NOW - 10 * MIN, percent: 70 },
      { at: NOW, percent: 80 },
    ]
    expect(eta(points, NOW, NOW + 5 * HOUR)).toBe(20 * MIN)
    expect(eta(points.slice(1), NOW, undefined)).toBeUndefined()
    expect(eta(points, NOW, NOW + 10 * MIN)).toBeUndefined()
    expect(
      eta(
        [...points].reverse().map((point, index) => ({ ...point, at: NOW - (2 - index) * 10 * MIN })),
        NOW,
        undefined,
      ),
    ).toBeUndefined()
  })
})

describe("usage (5.5)", () => {
  test("5 h buckets are the last five UTC hours; 7 d sums hours per local day", () => {
    const top = Math.floor(NOW / HOUR) * HOUR
    const row = (at: number, input: number) => ({
      key: new Date(at).toISOString(),
      tokens: { input, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    })
    const rows = [row(top, 10), row(top - 4 * HOUR, 5), row(top - 5 * HOUR, 99)]
    expect(buckets(rows, "5h", NOW)).toEqual([5, 0, 0, 0, 10])
    const days = buckets(rows, "7d", NOW)
    expect(days).toHaveLength(7)
    expect(days.reduce((sum, value) => sum + value, 0)).toBe(114)
  })

  test("session totals merge accounts and advance with ledger lines", () => {
    const totals = (input: number, amount: number): Ledger.Totals => ({
      requests: 1,
      tokens: { input, cacheRead: 100, cacheWrite: 0, output: 5, reasoning: 0 },
      cost: [{ unit: "credits", amount }],
      hitRate: null,
    })
    const merged = merge([totals(10, 1.5), totals(20, 2)])
    expect(merged.tokens.input).toBe(30)
    expect(merged.cost).toEqual([{ unit: "credits", amount: 3.5 }])
    const next = add(merged, {
      tokens: { input: 1, cacheRead: 2, cacheWrite: 3, cacheWrite1h: null, output: 4, reasoning: 0 },
      cost: { unit: "USD", amount: 0.5, source: "ratecard" },
    } as Ledger.Line)
    expect(next.requests).toBe(3)
    expect(next.tokens.cacheWrite).toBe(3)
    expect(next.cost).toEqual([
      { unit: "credits", amount: 3.5 },
      { unit: "USD", amount: 0.5 },
    ])
  })
})

describe("usage rows by server (04 §16.5 UsageRow.servers)", () => {
  test("a row with one server names it; none or several fall back to the session lookup", async () => {
    const { rowServer } = await import("./usage")
    expect(rowServer({ servers: ["local"] })).toBe("local")
    expect(rowServer({ servers: ["h-abc123"] })).toBe("h-abc123")
    expect(rowServer({})).toBeUndefined()
    expect(rowServer({ servers: ["h-abc123", "local"] })).toBeUndefined()
  })
})

describe("Sign in with ChatGPT without plan limits (02 §7.1)", () => {
  /** Source without comments, so names in comments are not taken for code. */
  const code = async (file: string) =>
    (await Bun.file(path.join(import.meta.dir, file)).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")

  test("a siwc account with no window says none came yet and where to look; others keep 관측된 한도 없음", async () => {
    // What is known, not more: no real token-sharing answer has carried plan limits so far (12장 48).
    expect(i18n.t("own.lim.sharingUnreported")).toBe(
      "아직 받은 한도 정보가 없어요 · 이 로그인 방식(토큰 공유)은 한도를 알려 주지 않는 것으로 보여요 · ChatGPT 설정 > 사용량에서 확인하세요",
    )
    expect(i18n.t("own.lim.noWindows")).toBe("관측된 한도 없음")
    expect(createI18n("en").t("own.lim.sharingUnreported")).not.toBe(i18n.t("own.lim.sharingUnreported"))
    const meter = await code("./meter.tsx")
    expect(meter).toContain('i18n.t(props.kind === "siwc" ? "own.lim.sharingUnreported" : "own.lim.noWindows")')
  })

  test("every account surface passes the account's kind to its limit meters, the 계정·한도 tab rows included", async () => {
    const root = path.join(import.meta.dir, "..")
    const files = (await Array.fromAsync(new Bun.Glob("**/*.tsx").scan({ cwd: root })))
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !file.endsWith(".test.tsx"))
    const uses = (
      await Promise.all(
        files.map(async (file) =>
          [...(await code(path.join("..", file))).matchAll(/<(LimitMeterGroup|AccountLimits)\b([\s\S]*?)\/>/g)].map(
            (match) => ({ file, element: match[1], props: match[2] ?? "" }),
          ),
        ),
      )
    ).flat()
    // The settings preview draws sample windows, not an account's.
    expect(uses.filter((use) => !/\bkind=/.test(use.props)).map((use) => use.file)).toEqual([
      "limits/display-setting.tsx",
    ])
    expect(new Set(uses.map((use) => use.file))).toEqual(
      new Set([
        "accounts/account-card.tsx",
        "accounts/claude-accounts.tsx",
        "accounts/claude-agent.tsx",
        "accounts/claude-slot.tsx",
        "limits/display-setting.tsx",
        "limits/index.tsx",
        "limits/panel-tab.tsx",
        "limits/summary.tsx",
      ]),
    )
    // The tab keys its sections by kind and its rows by account id: keyed by the group objects that the minute clock
    // rebuilds, an opened row closed again within a minute (seen on a slow PC, 2026-10-22).
    const panel = await code("./panel-tab.tsx")
    expect(panel).toContain("<For each={kinds()}>")
    expect(panel).not.toContain("<For each={groups()}>")
    // The tab's row summary and its rate windows (2026-10-22 review; the summary since LV 2026-10-24).
    const tab = uses.filter((use) => use.file === "limits/panel-tab.tsx")
    expect(tab.map((use) => [use.element, use.props.includes("kind={item().kind}")])).toEqual([
      ["AccountLimits", true],
      ["LimitMeterGroup", true],
    ])
    // The summary hands its kind on to the rows it unfolds and to its empty text.
    expect(
      uses.filter((use) => use.file === "limits/summary.tsx").map((use) => use.props.includes("kind={props.kind}")),
    ).toEqual([true, true])
  })

  test("a usage limit whose 429 named its reset shows it in the banner, from the account's siwc.usage window", async () => {
    expect(Limit.WindowIDs).toContain("siwc.usage")
    expect(i18n.t("own.chatgpt.usageLimitReset", { reset: resetText(i18n, NOW, NOW + 3 * HOUR) })).toBe(
      "3시간 후 리셋 · ChatGPT가 응답에 적어 보낸 시각이에요",
    )
    const banner = await code("../accounts/chatgpt-login.tsx")
    expect(banner).toContain('.find((window) => window.id === "siwc.usage")?.resetAt')
    expect(banner).toContain('i18n.t("own.chatgpt.usageLimitReset", { reset: resetText(i18n, minuteNow(), at()) })')
    expect(await code("../shell/session-banners.tsx")).toContain("<UsageLimitBanner accountID={account().id}")
  })
})

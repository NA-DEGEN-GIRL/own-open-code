import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account } from "@own/protocol"
import { Provider } from "@opencode/schema/provider"
import { ResetCredits } from "../../src/telemetry/reset-credits.js"
import { Windows } from "../../src/telemetry/windows.js"
import { Classify } from "../../src/telemetry/classify.js"
import { StreamUsage } from "../../src/telemetry/stream.js"

const subject = {
  accountID: Schema.decodeUnknownSync(Account.ID)("acc_01TESTCODEX00000000000000"),
  providerID: Provider.ID.make("own-codex-tst1"),
}
const NOW = Date.UTC(2026, 8, 27, 3, 0, 0)
const header = { observedAt: NOW, source: "header" as const }

describe("Windows.codexHeaders", () => {
  test("normalizes primary/secondary/credits (02 §7.3)", () => {
    const windows = Windows.codexHeaders(
      {
        "x-codex-primary-used-percent": "42.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(NOW / 1000 + 3600),
        "x-codex-secondary-used-percent": "86",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "7200",
        "x-codex-credits-has-credits": "true",
        "x-codex-credits-unlimited": "false",
        "x-codex-credits-balance": "12.5",
      },
      subject,
      header,
    )
    expect(windows).toEqual([
      expect.objectContaining({
        id: "codex.primary",
        label: "5시간",
        windowMinutes: 300,
        usedPercent: 42.5,
        resetAt: NOW + 3_600_000,
        status: "ok",
        kind: "rolling_quota",
        scope: "account",
        source: "header",
        confidence: "live",
        observedAt: NOW,
      }),
      expect.objectContaining({
        id: "codex.secondary",
        label: "주간",
        usedPercent: 86,
        resetAt: NOW + 7_200_000,
        status: "warning",
      }),
      expect.objectContaining({ id: "codex.credits", kind: "balance", remaining: 12.5, unit: "credits", status: "ok" }),
    ])
  })

  test("reached-type exhausts the full window; other limit families get their own ids", () => {
    const windows = Windows.codexHeaders(
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-used-percent": "40",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-rate-limit-reached-type": "workspace_member_usage_limit_reached",
        "x-codex-other-primary-used-percent": "12",
        "x-codex-other-primary-window-minutes": "60",
      },
      subject,
      { observedAt: NOW, source: "error" },
    )
    expect(windows.map((window) => [window.id, window.status, window.source])).toEqual([
      ["codex.primary", "exhausted", "error"],
      ["codex.secondary", "ok", "error"],
      ["codex.codex_other.primary", "ok", "error"],
    ])
    expect(windows[2].label).toBe("1시간")
  })

  test("returns nothing without codex headers and skips all-zero windows", () => {
    expect(Windows.codexHeaders({ "content-type": "text/event-stream" }, subject, header)).toEqual([])
    expect(Windows.codexHeaders({ "x-codex-primary-used-percent": "0" }, subject, header)).toEqual([])
  })

  test("a live answer (2026-10-18): one weekly window, an empty secondary family, capitalized credit flags", () => {
    // The limit headers of a real `/responses` answer on a plan with one weekly window (values as sent).
    const windows = Windows.codexHeaders(
      {
        "x-codex-active-limit": "premium",
        "x-codex-credits-balance": "21001.0966250000",
        "x-codex-credits-has-credits": "True",
        "x-codex-credits-unlimited": "False",
        "x-codex-plan-type": "promax",
        "x-codex-primary-over-secondary-limit-percent": "0",
        "x-codex-primary-reset-after-seconds": "550666",
        "x-codex-primary-reset-at": "1792876670",
        "x-codex-primary-used-percent": "7",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "0",
        "x-codex-secondary-reset-at": "",
        "x-codex-secondary-used-percent": "0",
        "x-codex-secondary-window-minutes": "0",
      },
      subject,
      header,
    )
    expect(windows).toEqual([
      expect.objectContaining({
        id: "codex.primary",
        label: "주간",
        windowMinutes: 10_080,
        usedPercent: 7,
        resetAt: 1_792_876_670_000,
        status: "ok",
        source: "header",
      }),
      expect.objectContaining({ id: "codex.credits", kind: "balance", remaining: 21001.096625, status: "ok" }),
    ])
  })
})

describe("Windows.codexFrame", () => {
  test("reads codex.rate_limits frames", () => {
    const windows = Windows.codexFrame(
      {
        type: "codex.rate_limits",
        plan_type: "plus",
        rate_limits: {
          primary: { used_percent: 99.5, window_minutes: 300, reset_at: NOW / 1000 + 60 },
          secondary: { used_percent: 10, window_minutes: 10080, reset_at: NOW / 1000 + 600 },
        },
        credits: { has_credits: false, unlimited: false, balance: null },
        metered_limit_name: null,
      },
      subject,
      { observedAt: NOW, source: "ws_event" },
    )
    expect(windows.map((window) => [window.id, window.usedPercent, window.status, window.source])).toEqual([
      ["codex.primary", 99.5, "warning", "ws_event"],
      ["codex.secondary", 10, "ok", "ws_event"],
      ["codex.credits", undefined, "unknown", "ws_event"],
    ])
  })

  test("a live codex.rate_limits frame (2026-10-18): the first frame of a WebSocket answer", () => {
    const frame = {
      type: "codex.rate_limits",
      plan_type: "promax",
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 7, window_minutes: 10080, reset_after_seconds: 550663, reset_at: 1792876670 },
        secondary: null,
      },
      code_review_rate_limits: null,
      additional_rate_limits: null,
      credits: { has_credits: true, unlimited: false, balance: "21001.0966250000" },
      promo: null,
    }
    const windows = Windows.codexFrame(frame, subject, { observedAt: NOW, source: "ws_event" })
    expect(
      windows.map((window) => [window.id, window.label, window.usedPercent, window.remaining, window.source]),
    ).toEqual([
      ["codex.primary", "주간", 7, undefined, "ws_event"],
      ["codex.credits", "크레딧", undefined, 21001.096625, "ws_event"],
    ])
    expect(windows[0]).toMatchObject({ windowMinutes: 10_080, resetAt: 1_792_876_670_000, status: "ok" })
  })

  test("reads x-codex headers wrapped in a WS error frame", () => {
    const windows = Windows.codexFrame(
      {
        type: "error",
        status: 429,
        error: { type: "usage_limit_reached", resets_at: NOW / 1000 + 100 },
        headers: { "x-codex-primary-used-percent": "100.0", "x-codex-primary-window-minutes": 15 },
      },
      subject,
      { observedAt: NOW, source: "ws_event" },
    )
    expect(windows).toEqual([
      expect.objectContaining({ id: "codex.primary", usedPercent: 100, status: "exhausted", source: "error" }),
    ])
  })
})

/** A live `wham/usage` answer (2026-10-18, account 01), values replaced where personal. */
const LIVE_USAGE = {
  user_id: "user-x",
  account_id: "acct-x",
  email: "x@example.test",
  plan_type: "promax",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 604800,
      reset_after_seconds: 548900,
      reset_at: 1792876670,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  model_usage: { "gpt-6-astra": { available: true, available_at: null, credits_would_enable: false } },
  credits: {
    has_credits: true,
    unlimited: false,
    overage_limit_reached: false,
    balance: "21001.0966250000",
    approx_local_messages: [5250, 27301],
    approx_cloud_messages: [840, 5250],
  },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null,
  promo: null,
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
}

describe("Windows.codexUsage", () => {
  const poll = { observedAt: NOW, source: "poll" as const }

  test("a live wham/usage answer (2026-10-18): the weekly window and the credits", () => {
    const body = LIVE_USAGE
    expect(Windows.codexUsage(body, subject, poll)).toEqual([
      expect.objectContaining({
        id: "codex.primary",
        label: "주간",
        windowMinutes: 10_080,
        usedPercent: 10,
        resetAt: 1_792_876_670_000,
        status: "ok",
        source: "poll",
      }),
      expect.objectContaining({ id: "codex.credits", remaining: 21001.096625, status: "ok", source: "poll" }),
    ])
  })

  test("two windows, another limit family, and the reached type (codex-rs rate_limit_snapshots_from_payload)", () => {
    const windows = Windows.codexUsage(
      {
        plan_type: "plus",
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: NOW / 1000 + 600 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86_400 },
        },
        additional_rate_limits: [
          {
            limit_name: "Other",
            metered_feature: "codex_other",
            rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: NOW / 1000 + 60 } },
          },
        ],
        credits: null,
        rate_limit_reached_type: { type: "rate_limit_reached" },
      },
      subject,
      poll,
    )
    expect(windows.map((window) => [window.id, window.label, window.usedPercent, window.status])).toEqual([
      ["codex.primary", "5시간", 100, "exhausted"],
      ["codex.secondary", "주간", 40, "ok"],
      ["codex.codex_other.primary", "5시간", 5, "ok"],
    ])
  })

  test("anything else is no window", () => {
    expect(Windows.codexUsage({ detail: "Unauthorized" }, subject, poll)).toEqual([])
    expect(Windows.codexUsage("nope", subject, poll)).toEqual([])
  })
})

describe("ResetCredits (02 §7.1.1 리셋권)", () => {
  test("the count of the live wham/usage answer; it is never a window", () => {
    expect(ResetCredits.fromUsage(LIVE_USAGE)).toEqual({ availableCount: 2, applicableCount: 0 })
    expect(Windows.codexUsage(LIVE_USAGE, subject, { observedAt: NOW, source: "poll" }).map((w) => w.id)).toEqual([
      "codex.primary",
      "codex.credits",
    ])
    expect(ResetCredits.observed(subject, NOW, { availableCount: 2, applicableCount: 0 })).toEqual({
      accountID: subject.accountID,
      providerID: subject.providerID,
      availableCount: 2,
      applicableCount: 0,
      observedAt: NOW,
      source: "poll",
    })
  })

  test("absent, null, negative and malformed counts are no count; a bad applicable count is left out", () => {
    const usage = (value: unknown) => ({ ...LIVE_USAGE, rate_limit_reset_credits: value })
    const absent = Object.fromEntries(
      Object.entries(LIVE_USAGE).filter((entry) => entry[0] !== "rate_limit_reset_credits"),
    )
    expect(ResetCredits.fromUsage(absent)).toBeUndefined()
    expect(ResetCredits.fromUsage(usage(null))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({}))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({ available_count: -1 }))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({ available_count: 1.5 }))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({ available_count: "2" }))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({ available_count: Number.NaN }))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({ available_count: null }))).toBeUndefined()
    expect(ResetCredits.fromUsage(usage([2]))).toBeUndefined()
    expect(ResetCredits.fromUsage("nope")).toBeUndefined()
    expect(ResetCredits.fromUsage(null)).toBeUndefined()
    expect(ResetCredits.fromUsage(usage({ available_count: 0 }))).toEqual({ availableCount: 0 })
    expect(ResetCredits.fromUsage(usage({ available_count: 3, applicable_available_count: -2 }))).toEqual({
      availableCount: 3,
    })
  })

  test("the details list: RFC 3339 times as ms, null expiry, unknown status and type, broken credits left out", () => {
    // codex-rs `rate_limit_reset_contract_uses_expected_paths_and_payloads`, plus the fields own must survive.
    const details = ResetCredits.fromDetails({
      credits: [
        {
          id: "credit-1",
          reset_type: "codex_rate_limits",
          status: "available",
          granted_at: "2026-06-17T00:00:00Z",
          expires_at: "2026-07-17T00:00:00Z",
          redeem_started_at: null,
          redeemed_at: null,
          profile_image_url: "https://example.test/avatar.png",
          profile_user_id: "@friend",
          title: "Full reset (Weekly + 5 hr)",
          description: "Ready to redeem",
        },
        {
          id: "credit-2",
          reset_type: "codex_rate_limits",
          status: "available",
          granted_at: "2026-06-18T00:00:00Z",
          expires_at: null,
        },
        {
          id: "credit-3",
          reset_type: "future_type",
          status: "paused",
          granted_at: "2026-06-19T09:30:00.250+09:00",
          title: "  ",
        },
        { id: "credit-bad-granted", status: "available", granted_at: "June 17" },
        { id: "credit-bad-expiry", status: "available", granted_at: "2026-06-17T00:00:00Z", expires_at: 1781654400 },
        { id: "", status: "available", granted_at: "2026-06-17T00:00:00Z" },
        "nope",
      ],
      available_count: 2,
      total_earned_count: 4,
    })
    expect(details).toEqual({
      availableCount: 2,
      credits: [
        {
          id: "credit-1",
          type: "codex_rate_limits",
          status: "available",
          grantedAt: Date.UTC(2026, 5, 17),
          expiresAt: Date.UTC(2026, 6, 17),
          title: "Full reset (Weekly + 5 hr)",
          description: "Ready to redeem",
        },
        { id: "credit-2", type: "codex_rate_limits", status: "available", grantedAt: Date.UTC(2026, 5, 18) },
        { id: "credit-3", type: "future_type", status: "unknown", grantedAt: Date.UTC(2026, 5, 19, 0, 30, 0, 250) },
      ],
    })
    expect(ResetCredits.fromDetails({ credits: [], available_count: 0 })).toEqual({ availableCount: 0, credits: [] })
    expect(ResetCredits.fromDetails({ available_count: 2 })).toBeUndefined()
    expect(ResetCredits.fromDetails({ credits: [], available_count: -1 })).toBeUndefined()
    expect(ResetCredits.fromDetails({ detail: "Not Found" })).toBeUndefined()
  })

  test("the consume answer: the four codes, windows_reset defaulting to 0, anything else none", () => {
    expect(ResetCredits.consumed({ code: "reset", credit: { id: "ignored-by-cli" }, windows_reset: 2 })).toEqual({
      outcome: "reset",
      windowsReset: 2,
    })
    expect(ResetCredits.consumed({ code: "nothing_to_reset" })).toEqual({
      outcome: "nothing_to_reset",
      windowsReset: 0,
    })
    expect(ResetCredits.consumed({ code: "no_credit", windows_reset: 0 })).toEqual({
      outcome: "no_credit",
      windowsReset: 0,
    })
    expect(ResetCredits.consumed({ code: "already_redeemed", windows_reset: -1 })).toEqual({
      outcome: "already_redeemed",
      windowsReset: 0,
    })
    expect(ResetCredits.consumed({ code: "pending" })).toBeUndefined()
    expect(ResetCredits.consumed({ detail: "Internal Server Error" })).toBeUndefined()
    expect(ResetCredits.consumed("reset")).toBeUndefined()
  })
})

describe("Windows rate headers", () => {
  test("anthropic-ratelimit-* with RFC 3339 resets", () => {
    const reset = new Date(NOW + 30_000).toISOString()
    const windows = Windows.anthropicHeaders(
      {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "10",
        "anthropic-ratelimit-requests-reset": reset,
        "anthropic-ratelimit-input-tokens-limit": "1000",
        "anthropic-ratelimit-input-tokens-remaining": "0",
        "anthropic-ratelimit-input-tokens-reset": reset,
      },
      subject,
      header,
    )
    expect(windows).toEqual([
      expect.objectContaining({
        id: "anth.requests",
        usedPercent: 90,
        status: "warning",
        resetAt: NOW + 30_000,
        kind: "rate",
        scope: "quota_domain",
      }),
      expect.objectContaining({
        id: "anth.input_tokens",
        usedPercent: 100,
        status: "exhausted",
        remaining: 0,
        limit: 1000,
      }),
    ])
  })

  test("x-ratelimit-* with Go durations, ids by kind", () => {
    const windows = Windows.xRateLimit(
      {
        "x-ratelimit-limit-requests": "500",
        "x-ratelimit-remaining-requests": "499",
        "x-ratelimit-reset-requests": "120ms",
        "x-ratelimit-limit-tokens": "10000",
        "x-ratelimit-remaining-tokens": "2500",
        "x-ratelimit-reset-tokens": "6m0s",
      },
      "oai",
      subject,
      header,
    )
    expect(windows.map((window) => [window.id, window.usedPercent, window.resetAt])).toEqual([
      ["oai.requests", 0.2, NOW + 120],
      ["oai.tokens", 75, NOW + 360_000],
    ])
  })

  test("siwc reads the Codex plan headers and x-ratelimit-*; codex reads only its own (02 §7.1)", () => {
    const siwc = { ...subject, providerID: Provider.ID.make("own-siwc-tst1") }
    const plan = {
      "x-codex-primary-used-percent": "12",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(NOW / 1000 + 3600),
      "x-codex-secondary-used-percent": "40",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "86400",
    }
    const rate = { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "75" }
    const windows = Windows.fromResponse("siwc", { ...plan, ...rate }, siwc, header)
    expect(windows.map((window) => [window.id, window.label, window.usedPercent, window.resetAt])).toEqual([
      ["codex.primary", "5시간", 12, NOW + 3_600_000],
      ["codex.secondary", "주간", 40, NOW + 86_400_000],
      ["siwc.requests", "분당 요청", 25, undefined],
    ])
    expect(
      windows.every((window) => window.accountID === siwc.accountID && window.providerID === siwc.providerID),
    ).toBe(true)
    // A usage-limit error carries them too (source `error`), and a full window is exhausted.
    const limited = Windows.fromResponse(
      "siwc",
      { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300" },
      siwc,
      { observedAt: NOW, source: "error" },
    )
    expect(limited).toEqual([expect.objectContaining({ id: "codex.primary", status: "exhausted", source: "error" })])
    // Nothing carried, nothing made up; other kinds keep their own families.
    expect(
      Windows.fromResponse("siwc", { "content-type": "text/event-stream", "x-request-id": "r" }, siwc, header),
    ).toEqual([])
    expect(Windows.fromResponse("oai", plan, subject, header)).toEqual([])
    expect(Windows.fromResponse("codex", rate, subject, header)).toEqual([])
  })

  test("durations", () => {
    expect(Windows.durationMs("1h2m3.5s")).toBe(3_723_500)
    expect(Windows.durationMs("20ms")).toBe(20)
    expect(Windows.durationMs("7")).toBe(7_000)
    expect(Windows.durationMs("soon")).toBeUndefined()
  })

  test("DeepSeek balance", () => {
    expect(
      Windows.deepseekBalance(
        { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "8.20" }] },
        subject,
        { observedAt: NOW, source: "poll" },
      ),
    ).toEqual([
      expect.objectContaining({ id: "ds.balance", remaining: 8.2, unit: "CNY", status: "ok", source: "poll" }),
    ])
    expect(
      Windows.deepseekBalance(
        { is_available: false, balance_infos: [{ currency: "USD", total_balance: "0" }] },
        subject,
        {
          observedAt: NOW,
          source: "poll",
        },
      )[0].status,
    ).toBe("exhausted")
  })

  const poll = { observedAt: NOW, source: "poll" as const }

  test("DeepSeek bonus: a positive granted balance is its own 보너스 window; the total stays the balance", () => {
    const windows = Windows.deepseekBalance(
      {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
          { currency: "USD", total_balance: "3.00", granted_balance: "0.50", topped_up_balance: "2.50" },
        ],
      },
      subject,
      poll,
    )
    // The total already holds both parts: no topped-up window, nothing added twice.
    expect(windows.map((window) => [window.id, window.label, window.remaining, window.unit, window.status])).toEqual([
      ["ds.balance", "잔액", 110, "CNY", "ok"],
      ["ds.balance.granted", "보너스", 10, "CNY", "ok"],
      ["ds.balance.usd", "잔액", 3, "USD", "ok"],
      ["ds.balance.usd.granted", "보너스", 0.5, "USD", "ok"],
    ])
    expect(windows.every((window) => window.kind === "balance" && window.source === "poll")).toBe(true)
  })

  test("DeepSeek bonus: none without a positive granted balance; only the total decides exhausted", () => {
    const ids = (granted: unknown) =>
      Windows.deepseekBalance(
        { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "5.00", granted_balance: granted }] },
        subject,
        poll,
      ).map((window) => window.id)
    expect(ids("0.00")).toEqual(["ds.balance"])
    expect(ids(undefined)).toEqual(["ds.balance"])
    expect(ids("-1")).toEqual(["ds.balance"])
    expect(ids("soon")).toEqual(["ds.balance"])
    const unavailable = Windows.deepseekBalance(
      { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.40", granted_balance: "0.40" }] },
      subject,
      poll,
    )
    expect(unavailable.map((window) => [window.id, window.status])).toEqual([
      ["ds.balance", "exhausted"],
      ["ds.balance.granted", "ok"],
    ])
  })

  test("DeepSeek bonus: a spent or expired bonus comes back at 0 once, so the last amount does not stay", () => {
    const before = Windows.deepseekBalance(
      { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.00", granted_balance: "2.00" }] },
      subject,
      { observedAt: NOW - 900_000, source: "poll" },
    )
    const after = Windows.deepseekBalance(
      { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.00", granted_balance: "0.00" }] },
      subject,
      poll,
      before,
    )
    expect(after).toEqual([
      expect.objectContaining({ id: "ds.balance", remaining: 9, status: "ok" }),
      expect.objectContaining({
        id: "ds.balance.granted",
        label: "보너스",
        remaining: 0,
        status: "ok",
        observedAt: NOW,
      }),
    ])
    // Already at 0: not published again; other windows of the account are left alone.
    const rate = { ...before[0], id: "ds.requests", kind: "rate" as const }
    expect(
      Windows.deepseekBalance(
        { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.00" }] },
        subject,
        poll,
        [...after, rate],
      ).map((window) => window.id),
    ).toEqual(["ds.balance"])
    // A 402 (the poller's synthetic reply) zeroes the bonus too.
    expect(
      Windows.deepseekBalance({ is_available: false, balance_infos: [{ total_balance: 0 }] }, subject, poll, before),
    ).toEqual([
      expect.objectContaining({ id: "ds.balance", remaining: 0, status: "exhausted" }),
      expect.objectContaining({ id: "ds.balance.granted", remaining: 0, status: "ok" }),
    ])
  })
})

describe("Classify", () => {
  const base = { windows: [], now: NOW }
  const capture = (status: number, bodyHead: string | null, headers: Record<string, string> = {}) => ({
    providerID: "own-codex-tst1",
    status,
    headers,
    bodyHead,
    frame: null,
    authHash8: null,
    at: NOW,
  })

  test("codex usage limit is hard with the body reset; plain 429 and 5xx are transient", () => {
    const hard = Classify.classify({
      ...base,
      kind: "codex",
      error: { type: "provider.rate-limit", message: "limit", status: 429 },
      capture: capture(429, JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } })),
    })
    expect(hard).toMatchObject({ class: "hard", reason: "usage_limit_reached", resetAt: NOW + 60_000 })
    expect(
      Classify.classify({
        ...base,
        kind: "codex",
        error: { type: "provider.rate-limit", message: "slow down", status: 429 },
      }).class,
    ).toBe("transient")
    expect(
      Classify.classify({ ...base, kind: "codex", error: { type: "provider.internal", message: "x", status: 502 } })
        .class,
    ).toBe("transient")
  })

  test("codex: reached-type header or a full recent window is hard", () => {
    expect(
      Classify.classify({
        ...base,
        kind: "codex",
        error: { type: "provider.rate-limit", message: "x", status: 429 },
        capture: capture(429, "{}", { "x-codex-rate-limit-reached-type": "rate_limit_reached" }),
      }),
    ).toMatchObject({ class: "hard", reason: "rate_limit_reached" })
    const full = Windows.codexHeaders(
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(NOW / 1000 + 600),
      },
      subject,
      header,
    )
    expect(
      Classify.classify({
        ...base,
        windows: full,
        kind: "codex",
        error: { type: "provider.transport", message: "closed" },
      }),
    ).toMatchObject({ class: "hard", windowId: "codex.primary", resetAt: NOW + 600_000 })
  })

  test("siwc: a usage limit takes a full plan window's reset, never one made up; the reason stays the code", () => {
    const usage = {
      type: "provider.rate-limit",
      message: "ChatGPT usage limit reached.",
      status: 429,
      response: { body: JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded" } }) },
    }
    const full = Windows.fromResponse(
      "siwc",
      {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(NOW / 1000 + 900),
      },
      subject,
      header,
    )
    expect(Classify.classify({ ...base, windows: full, kind: "siwc", error: usage })).toEqual({
      class: "hard",
      stop: true,
      reason: "subscription_sharing_usage_limit_exceeded",
      windowId: null,
      scope: "account",
      resetAt: NOW + 900_000,
    })
    // An app's own cap: the plan windows are not full, so there is no reset to promise.
    const open = Windows.fromResponse("siwc", { "x-codex-primary-used-percent": "30" }, subject, header)
    const capped = Classify.classify({ ...base, windows: open, kind: "siwc", error: usage })
    expect(capped).toMatchObject({ class: "hard", reason: "subscription_sharing_usage_limit_exceeded", windowId: null })
    expect(capped).not.toHaveProperty("resetAt")
  })

  test("API kinds (02 §5.2 table)", () => {
    const kinds = [
      ["oai", 429, "insufficient_quota", "hard", "quota_domain"],
      ["oai", 429, "rate_limit_exceeded", "transient", "account"],
      ["anth", 429, "enforced_spend_limit_reached", "hard", "quota_domain"],
      ["anth", 400, "You have reached your workspace API usage limits", "hard", "workspace"],
      ["anth", 529, "overloaded_error", "transient", "account"],
      ["ds", 402, "Insufficient Balance", "hard", "account"],
      ["xai", 403, "no credits left", "hard", "account"],
      ["or", 402, "payment required", "hard", "account"],
    ] as const
    for (const [kind, status, body, expected, scope] of kinds)
      expect([
        kind,
        Classify.classify({ ...base, kind, error: { type: "provider.x", message: body, status } }),
      ]).toEqual([kind, expect.objectContaining({ class: expected, scope })])
  })

  test("DeepSeek's 402 names the reason own-web's balance banner and card key on (status_402)", () => {
    expect(
      Classify.classify({
        ...base,
        kind: "ds",
        error: { type: "provider.x", message: "Insufficient Balance", status: 402 },
      }),
    ).toMatchObject({ class: "hard", reason: "status_402", scope: "account" })
  })

  test("OpenRouter's 402 for a max_tokens the balance cannot cover is not exhaustion (02 §5.2)", () => {
    const body = (requested: number, affordable: number) =>
      JSON.stringify({
        error: {
          code: 402,
          message: `This request requires more credits, or fewer max_tokens. You requested up to ${requested} tokens, but can only afford ${affordable}. To increase, visit https://openrouter.ai/settings/credits and add more credits`,
        },
      })
    const classify = (text: string, kind: "or" | "compat" = "or") =>
      Classify.classify({
        ...base,
        kind,
        error: { type: "provider.quota", message: "Payment Required", status: 402 },
        capture: capture(402, text),
      })
    // The balance still pays for an answer: the request asked for too much, the account stays usable.
    expect(classify(body(256_000, 9_861))).toEqual({
      class: "unknown",
      reason: "max_tokens_unaffordable",
      windowId: null,
      scope: "account",
    })
    // The same wording through an OpenRouter-backed compat server, or in the error message alone.
    expect(classify(body(32_000, 4_000), "compat").class).toBe("unknown")
    const message = (text: string) =>
      Classify.classify({ ...base, kind: "or", error: { type: "provider.quota", message: text, status: 402 } })
    expect(
      message(
        "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 2048.",
      ).reason,
    ).toBe("max_tokens_unaffordable")
    // Without the affordable count nothing says an answer still fits: exhausted.
    expect(message("This request requires more credits, or fewer max_tokens.")).toMatchObject({
      class: "hard",
      reason: "status_402",
    })
    // Less than any answer core would ask for (1,024), a negative balance, or plain lack of credits: exhausted.
    expect(classify(body(32_000, 120))).toMatchObject({ class: "hard", reason: "status_402" })
    expect(classify(body(32_000, -5))).toMatchObject({ class: "hard", reason: "status_402" })
    expect(
      classify(
        JSON.stringify({
          error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" },
        }),
      ),
    ).toMatchObject({ class: "hard", reason: "status_402" })
  })

  test("siwc: every token-sharing code, current or legacy, maps to its outcome", () => {
    const expected: Readonly<Record<string, readonly [Classify.Class, boolean, string]>> = {
      subscription_sharing_usage_limit_exceeded: ["hard", true, "subscription_sharing_usage_limit_exceeded"],
      subscription_sharing_user_not_eligible: ["hard", true, "subscription_sharing_user_not_eligible"],
      subscription_sharing_v2_user_not_eligible: ["hard", true, "subscription_sharing_user_not_eligible"],
      subscription_sharing_invalid_user: ["auth", true, "subscription_sharing_invalid_user"],
      subscription_sharing_v2_invalid_user: ["auth", true, "subscription_sharing_invalid_user"],
      chatpass_v2_scope_not_authorized: ["auth", true, "chatpass_v2_scope_not_authorized"],
      chatpass_v2_invalid_authorization_context: ["auth", true, "chatpass_v2_invalid_authorization_context"],
      subscription_sharing_unsupported_capability: ["unknown", true, "subscription_sharing_unsupported_capability"],
      subscription_sharing_route_not_supported: ["unknown", true, "subscription_sharing_route_not_supported"],
      subscription_sharing_v2_route_not_supported: ["unknown", true, "subscription_sharing_route_not_supported"],
      subscription_sharing_v2_client_not_enabled: ["unknown", true, "subscription_sharing_v2_client_not_enabled"],
      subscription_sharing_usage_unavailable: ["transient", false, "subscription_sharing_usage_unavailable"],
      subscription_sharing_user_unavailable: ["transient", false, "subscription_sharing_user_unavailable"],
      subscription_sharing_v2_user_unavailable: ["transient", false, "subscription_sharing_user_unavailable"],
    }
    expect(Classify.SHARING_CODES.map((entry) => entry.code).toSorted()).toEqual(Object.keys(expected).toSorted())
    for (const [code, [kind, stop, reason]] of Object.entries(expected)) {
      // Both shapes reach the classifier: an HTTP error body and a `code: message` stream failure.
      const http = Classify.classify({
        ...base,
        kind: "siwc",
        error: { type: "provider.rate-limit", message: "failed", status: 429 },
        capture: capture(429, JSON.stringify({ error: { code, message: "fake" } })),
      })
      const stream = Classify.classify({
        ...base,
        kind: "siwc",
        error: { type: "provider.invalid-request", message: `${code}: fake` },
      })
      for (const result of [http, stream])
        expect({ code, class: result.class, stop: result.stop === true, reason: result.reason }).toEqual({
          code,
          class: kind,
          stop,
          reason,
        })
    }
    // Other kinds never read the token-sharing table, and a siwc 429 without a code stays transient.
    expect(
      Classify.classify({
        ...base,
        kind: "oai",
        error: { type: "provider.invalid-request", message: "subscription_sharing_unsupported_capability" },
      }),
    ).toMatchObject({ class: "unknown", reason: "provider.invalid-request" })
    expect(
      Classify.classify({ ...base, kind: "siwc", error: { type: "provider.rate-limit", message: "slow", status: 429 } })
        .class,
    ).toBe("transient")
  })

  test("without a capture the session error's response body is read (upstream c14a1f5acf)", () => {
    // Upstream puts a friendly sentence in `message` and keeps the provider's body; the capture may be gone (> 30 s).
    const usage = JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "fake" } })
    expect(
      Classify.classify({
        ...base,
        kind: "siwc",
        error: {
          type: "provider.rate-limit",
          message: "You have reached your ChatGPT usage limit.",
          status: 429,
          response: { body: usage },
        },
      }),
    ).toMatchObject({ class: "hard", stop: true, reason: "subscription_sharing_usage_limit_exceeded" })
    const quota = { type: "provider.rate-limit", message: "Too many requests", status: 429 }
    const insufficient = JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota" } })
    expect(
      Classify.classify({ ...base, kind: "oai", error: { ...quota, response: { body: insufficient } } }),
    ).toMatchObject({ class: "hard", reason: "insufficient_quota", scope: "quota_domain" })
    // The body's reset time counts too, and only its first 2 KB is read, as of a capture.
    const reset = JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 600 } })
    expect(Classify.classify({ ...base, kind: "codex", error: { ...quota, response: { body: reset } } })).toMatchObject(
      { class: "hard", reason: "usage_limit_reached", resetAt: NOW + 600_000 },
    )
    const late = `${" ".repeat(Classify.BODY_HEAD_CHARS)}insufficient_quota`
    expect(Classify.classify({ ...base, kind: "oai", error: { ...quota, response: { body: late } } }).class).toBe(
      "transient",
    )
    // A capture of the same response wins over the error's body.
    expect(
      Classify.classify({
        ...base,
        kind: "oai",
        error: { ...quota, response: { body: insufficient } },
        capture: capture(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })),
      }).class,
    ).toBe("transient")
  })

  test("401/403 are auth; retry-after is read", () => {
    expect(
      Classify.classify({ ...base, kind: "oai", error: { type: "provider.auth", message: "bad key", status: 401 } })
        .class,
    ).toBe("auth")
    expect(
      Classify.classify({ ...base, kind: "codex", error: { type: "provider.x", message: "forbidden", status: 403 } })
        .class,
    ).toBe("auth")
    expect(Classify.retryAfter({ "retry-after": "30" }, NOW)).toBe(NOW + 30_000)
    expect(Classify.retryAfter({ "retry-after-ms": "1500" }, NOW)).toBe(NOW + 1_500)
  })
})

describe("StreamUsage", () => {
  const sse = (events: ReadonlyArray<unknown>) =>
    new Response(events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })

  test("Responses response.completed usage", async () => {
    const usage = await StreamUsage.read(
      sse([
        { type: "response.output_text.delta", delta: "hi" },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 800 },
              output_tokens: 50,
              output_tokens_details: { reasoning_tokens: 20 },
            },
          },
        },
      ]),
    )
    expect(usage).toEqual({ input: 200, cacheRead: 800, cacheWrite: 0, cacheWrite1h: null, output: 30, reasoning: 20 })
  })

  test("Anthropic message_start + message_delta", async () => {
    const usage = await StreamUsage.read(
      sse([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 40,
              output_tokens: 1,
            },
          },
        },
        { type: "message_delta", usage: { output_tokens: 25 } },
      ]),
    )
    expect(usage).toEqual({ input: 10, cacheRead: 500, cacheWrite: 40, cacheWrite1h: null, output: 25, reasoning: 0 })
  })

  test("chat last usage chunk (DeepSeek dialect)", async () => {
    const usage = await StreamUsage.read(
      sse([
        { choices: [{ delta: { content: "x" } }] },
        { choices: [], usage: { prompt_tokens: 640, completion_tokens: 9, prompt_cache_hit_tokens: 576 } },
      ]),
    )
    expect(usage).toEqual({ input: 64, cacheRead: 576, cacheWrite: 0, cacheWrite1h: null, output: 9, reasoning: 0 })
  })

  test("no usage → undefined", async () => {
    expect(await StreamUsage.read(sse([{ type: "response.output_text.delta", delta: "x" }]))).toBeUndefined()
  })
})

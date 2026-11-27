// The Claude subscription windows of a response (02 §7.1, §7.3; LV 2026-10-24): `Unified.parse` (shared by
// own-telemetry and the egress relay of SSH hosts' requests) and the runtime store that keeps them for the screen. The
// header sets are the ones users posted (anthropics/claude-code#12829, router-for-me/CLIProxyAPI#5920) and the names
// Claude Code reads (its `5h`, `7d`, `7d_oi` table with `-utilization`, `-reset`, `-surpassed-threshold`; the
// top-level `status` and `reset` for a claimed `seven_day_opus`/`seven_day_sonnet`). Anthropic documents none of them.
// No request goes anywhere.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Account, ClaudeAgent, Unified } from "@own/protocol"
import { Limits } from "@own/runtime"
import { LEADS, LEADS_AT } from "../../../own-protocol/test/limit-leads.js"
import { Views } from "../../src/slots/views.js"

// An hour before #12829's 5-hour reset, so no reset has passed for the store.
const NOW = Date.UTC(2025, 11, 1, 1, 0, 0)
const P = "anthropic-ratelimit-unified-"

const headers = (values: Record<string, string>) =>
  new Headers(Object.fromEntries(Object.entries(values).map(([name, value]) => [`${P}${name}`, value])))
const summary = (values: Record<string, string>) =>
  Unified.parse(headers(values), NOW).map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: window.usedPercent,
    resetAt: window.resetAt,
    status: window.status,
  }))

/** anthropics/claude-code#12829 (2025-12-01): a Max account early in its 5 hours and late in its week. */
const ISSUE_12829 = {
  status: "allowed",
  "5h-status": "allowed",
  "5h-reset": "1764554400",
  "5h-utilization": "0.018416969696969696",
  "7d-status": "allowed",
  "7d-reset": "1764615600",
  "7d-utilization": "0.7370692663445869",
  "representative-claim": "five_hour",
  "fallback-percentage": "0.2",
  reset: "1764554400",
  "overage-disabled-reason": "org_level_disabled",
}

/** router-for-me/CLIProxyAPI#5920 (2026-09-17, a 429): the per-model weekly bucket ran out, extra usage capped. */
const ISSUE_5920 = {
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
}

describe("Unified.parse: the windows of a real response", () => {
  test("5 h and weekly both kept, the weekly far tighter although the claim names the 5 hours (#12829)", () => {
    expect(summary(ISSUE_12829)).toEqual([
      { id: "claude.5h", label: "5시간", usedPercent: 1.84, resetAt: 1764554400_000, status: "ok" },
      { id: "claude.7d", label: "주간", usedPercent: 73.71, resetAt: 1764615600_000, status: "ok" },
    ])
    expect(Unified.parse(headers(ISSUE_12829), NOW).map((window) => window.meta?.representative)).toEqual([
      "five_hour",
      "five_hour",
    ])
  })

  test("the `7d_oi` family is its own weekly window, 주간 · Fable, exhausted past 100 % (#5920)", () => {
    expect(summary(ISSUE_5920)).toEqual([
      { id: "claude.5h", label: "5시간", usedPercent: 23, resetAt: undefined, status: "ok" },
      { id: "claude.7d", label: "주간", usedPercent: 73, resetAt: undefined, status: "ok" },
      { id: "claude.7d_oi", label: "주간 · Fable", usedPercent: 102, resetAt: undefined, status: "exhausted" },
      { id: "claude.overage", label: "추가 사용량", usedPercent: undefined, resetAt: undefined, status: "exhausted" },
    ])
    expect(Unified.parse(headers(ISSUE_5920), NOW).find((window) => window.id === "claude.7d_oi")).toMatchObject({
      kind: "rolling_quota",
      windowMinutes: 10_080,
      providerID: "anthropic",
      confidence: "live",
      source: "header",
      meta: { representative: "seven_day_overage_included" },
    })
  })

  test("a family without its own status: `surpassed-threshold` warns as Claude Code reads it, else the percent", () => {
    expect(
      summary({
        status: "allowed",
        "5h-utilization": "0.4",
        "5h-reset": "1789614000",
        "7d-utilization": "0.61",
        "7d-reset": "1789905600",
        "7d-surpassed-threshold": "0.5",
        "7d_oi-utilization": "0.9",
        "7d_oi-reset": "1789905600",
        "representative-claim": "five_hour",
      }),
    ).toEqual([
      { id: "claude.5h", label: "5시간", usedPercent: 40, resetAt: 1789614000_000, status: "ok" },
      { id: "claude.7d", label: "주간", usedPercent: 61, resetAt: 1789905600_000, status: "warning" },
      { id: "claude.7d_oi", label: "주간 · Fable", usedPercent: 90, resetAt: 1789905600_000, status: "warning" },
    ])
    // An explicit `allowed` with a passed threshold warns too; `rejected` always wins.
    expect(Unified.statusOf("allowed", 10, true)).toBe("warning")
    expect(Unified.statusOf("rejected", 10, true)).toBe("exhausted")
    expect(Unified.statusOf(undefined, 100, true)).toBe("exhausted")
    expect(Unified.statusOf(undefined, undefined, true)).toBe("warning")
  })

  test("a claimed model week without its own headers takes the top-level status and reset (주간 · Opus/Sonnet)", () => {
    for (const [claim, id, label] of [
      ["seven_day_opus", "claude.7d_opus", "주간 · Opus"],
      ["seven_day_sonnet", "claude.7d_sonnet", "주간 · Sonnet"],
    ] as const)
      expect(
        summary({
          status: "rejected",
          reset: "1789905600",
          "representative-claim": claim,
          "5h-status": "allowed",
          "5h-utilization": "0.12",
          "5h-reset": "1789614000",
          "7d-status": "allowed",
          "7d-utilization": "0.44",
          "7d-reset": "1789905600",
        }),
      ).toEqual([
        { id: "claude.5h", label: "5시간", usedPercent: 12, resetAt: 1789614000_000, status: "ok" },
        { id: "claude.7d", label: "주간", usedPercent: 44, resetAt: 1789905600_000, status: "ok" },
        { id, label, usedPercent: undefined, resetAt: 1789905600_000, status: "exhausted" },
      ])
    // Claims with a family of their own (or none known) add nothing: the top-level status is theirs already.
    expect(summary({ ...ISSUE_12829, "representative-claim": "seven_day" }).map((window) => window.id)).toEqual([
      "claude.5h",
      "claude.7d",
    ])
    expect(summary({ status: "allowed", reset: "1789905600", "representative-claim": "overage" })).toEqual([])
  })
})

describe("the account's state (accounts.list limitsSummary): the window own-web leads with", () => {
  test("#5920 as it came: neither the used-up Fable week nor the refused extra usage names the account (LV)", () => {
    const windows = Unified.parse(headers(ISSUE_5920), NOW)
    expect(windows.find((window) => window.id === "claude.overage")).toMatchObject({
      status: "exhausted",
      meta: { billing: "rejected" },
    })
    expect(Views.summary(windows, NOW).worst).toEqual({
      id: "claude.7d",
      label: "주간",
      usedPercent: 73,
      resetAt: null,
      status: "ok",
    })
    const opus = Unified.parse(
      headers({
        status: "rejected",
        reset: "1789905600",
        "representative-claim": "seven_day_opus",
        "5h-utilization": "0.4",
      }),
      NOW,
    )
    expect(Views.summary(opus, NOW).worst).toMatchObject({ id: "claude.5h", status: "ok" })
  })

  // The fixtures every surface of own-web leads with (own-web src/limits/lead.test.ts): the server names the same
  // window for the cards and the switcher's 추천, without a model.
  for (const fixture of LEADS.filter((item) => item.model === undefined))
    test(`the same lead as the screen: ${fixture.name}`, () => {
      const worst = Views.summary(fixture.windows, LEADS_AT).worst
      expect(worst?.id).toBe(fixture.lead)
      // With its label, so a card names the window before its windows arrive (fifth limits review, finding 6).
      expect(worst?.label).toBe(fixture.windows.find((window) => window.id === fixture.lead)!.label)
    })
})

/**
 * A verified Ultra account (02 §7.1.2, N5H 2026-11-03): Anthropic removed its five-hour limit, so its answers carry the
 * weekly families only. #12829 without its `5h-*` headers, the claim on the week.
 */
const ULTRA = {
  ...Object.fromEntries(Object.entries(ISSUE_12829).filter(([name]) => !name.startsWith("5h-"))),
  "representative-claim": "seven_day",
  reset: "1764615600",
}

describe("an account without a five-hour window (verified Ultra, 02 §7.1.2)", () => {
  test("its answer has the weekly window only, which leads the account", () => {
    const windows = Unified.parse(headers(ULTRA), NOW)
    expect(windows.map((window) => window.id)).toEqual(["claude.7d"])
    expect(Views.summary(windows, NOW).worst).toMatchObject({ id: "claude.7d", label: "주간", usedPercent: 73.71 })
  })

  test("only a success with the weekly family and no five-hour header or claim says so", () => {
    expect(Unified.withoutFiveHour(headers(ULTRA), 200)).toBe(true)
    // Accounts that keep the five hours, as before.
    expect(Unified.withoutFiveHour(headers(ISSUE_12829), 200)).toBe(false)
    expect(Unified.withoutFiveHour(headers({ ...ULTRA, "5h-status": "allowed" }), 200)).toBe(false)
    expect(Unified.withoutFiveHour(headers({ ...ULTRA, "representative-claim": "five_hour" }), 200)).toBe(false)
    // An error answer, an API key or a proxy without unified headers, an empty header: nothing is said.
    expect(Unified.withoutFiveHour(headers(ULTRA), 429)).toBe(false)
    expect(Unified.withoutFiveHour(headers(ISSUE_5920), 429)).toBe(false)
    expect(Unified.withoutFiveHour(new Headers({ "content-type": "text/event-stream" }), 200)).toBe(false)
    expect(Unified.withoutFiveHour(headers({ status: "allowed", "representative-claim": "seven_day" }), 200)).toBe(false)
    expect(Unified.withoutFiveHour(headers({ ...ULTRA, "7d-utilization": "", "7d-reset": "", "7d-status": "" }), 200)).toBe(
      false,
    )
  })

  test("Claude Agent: a usage answer with the week and no five hours says so, as Claude Code's status line reads it", () => {
    const week = { utilization: 21, resets_at: "2026-11-05T00:00:00.000Z" }
    expect(ClaudeAgent.withoutFiveHour({ rate_limits: { seven_day: week } })).toBe(true)
    expect(ClaudeAgent.withoutFiveHour({ rate_limits: { five_hour: null, seven_day: week } })).toBe(true)
    expect(ClaudeAgent.fromUsage({ rate_limits: { seven_day: week } }, NOW, Account.ID.claudeSlot).map((w) => w.id)).toEqual([
      "claude.7d",
    ])
    expect(ClaudeAgent.withoutFiveHour({ rate_limits: { five_hour: week, seven_day: week } })).toBe(false)
    // An API key login, an answer without plan limits or without the week: nothing is said.
    expect(ClaudeAgent.withoutFiveHour({ rate_limits_available: false, rate_limits: { seven_day: week } })).toBe(false)
    expect(ClaudeAgent.withoutFiveHour({ rate_limits: null })).toBe(false)
    expect(ClaudeAgent.withoutFiveHour({ rate_limits: { seven_day_opus: week } })).toBe(false)
  })

  test("the store forgets the five hours it kept, and they come back with an answer that carries them", () => {
    const store = new Limits.Store({ file: path.join(os.tmpdir(), "own-unified-unused.json"), now: () => NOW })
    store.upsert(Unified.parse(headers(ISSUE_12829), NOW - 60_000))
    expect(store.drop("acc_claude_slot", Unified.FIVE_HOUR)).toBe(true)
    store.upsert(Unified.parse(headers(ULTRA), NOW))
    expect(store.list().map((window) => window.id)).toEqual(["claude.7d"])
    store.upsert(Unified.parse(headers(ISSUE_12829), NOW + 1_000))
    expect(store.list().map((window) => window.id)).toEqual(["claude.7d", "claude.5h"])
  })
})

describe("the runtime store keeps every Claude window for the screen", () => {
  test("5 h, weekly and 주간 · Fable survive a save and a reload; a later answer without 7d_oi keeps the last one until it is stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-unified-"))
    try {
      const file = path.join(dir, "limits.json")
      const store = new Limits.Store({ file, now: () => NOW + 60_000 })
      expect(store.upsert(Unified.parse(headers(ISSUE_5920), NOW)).map((window) => window.id)).toEqual([
        "claude.5h",
        "claude.7d",
        "claude.7d_oi",
        "claude.overage",
      ])
      // The next answer (another model) carries no 7d_oi family: the store keeps the bucket's last observation.
      store.upsert(Unified.parse(headers(ISSUE_12829), NOW + 30_000))
      expect(await store.save()).toBe(true)
      const reloaded = new Limits.Store({ file, now: () => NOW + 60_000 })
      expect(await reloaded.load()).toBe(true)
      expect(
        reloaded.list({ accountID: "acc_claude_slot" }).map((window) => [window.id, window.usedPercent, window.status]),
      ).toEqual([
        ["claude.5h", 1.84, "ok"],
        ["claude.7d", 73.71, "ok"],
        ["claude.7d_oi", 102, "exhausted"],
        ["claude.overage", undefined, "exhausted"],
      ])
      // #5920 gave the bucket no reset, and only that model's answers carry it: once its observation is stale (over
      // 15 minutes, 02 §7.4) it keeps its last value but not its state, so it neither leads nor blocks for good
      // (LimitModel.lapsed). The account-wide windows keep theirs, stale.
      const later = new Limits.Store({ file, now: () => NOW + 16 * 60_000 })
      expect(await later.load()).toBe(true)
      expect(
        later
          .list({ accountID: "acc_claude_slot" })
          .map((window) => [window.id, window.usedPercent, window.status, window.confidence]),
      ).toEqual([
        ["claude.5h", 1.84, "ok", "stale"],
        ["claude.7d", 73.71, "ok", "stale"],
        ["claude.7d_oi", 102, "unknown", "stale"],
        ["claude.overage", undefined, "exhausted", "stale"],
      ])
      // A bucket with a reset keeps its state until that reset, like every window.
      const reset = new Limits.Store({ file: path.join(dir, "reset.json"), now: () => NOW + 16 * 60_000 })
      reset.upsert(Unified.parse(headers({ ...ISSUE_5920, "7d_oi-reset": String(NOW / 1000 + 86_400) }), NOW))
      expect(reset.list().find((window) => window.id === "claude.7d_oi")).toMatchObject({
        status: "exhausted",
        confidence: "stale",
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

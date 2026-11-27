// The one ranking of an account's limit windows (03 §7.2, LV 2026-10-24) that own-web leads every surface with and
// own-accounts names the account's state with; the shared fixtures are ./limit-leads.ts.
import { describe, expect, test } from "bun:test"
import { LimitRank, Unified } from "../src/index.js"
import { claude, ISSUE_5920, LEADS, LEADS_AT, reset, window } from "./limit-leads.js"

const MIN = 60_000

describe("LimitRank.ranked", () => {
  for (const fixture of LEADS)
    test(fixture.name, () => {
      expect(LimitRank.ranked(fixture.windows, LEADS_AT, fixture.model)[0]?.id).toBe(fixture.lead)
    })

  test("the exhausted window that frees last leads; then the least left; a roomy budget after the balances", () => {
    const windows = [
      window({ id: "a", usedPercent: 40 }),
      window({ id: "b", status: "exhausted", usedPercent: 100, resetAt: LEADS_AT + 60 * MIN }),
      window({ id: "c", status: "exhausted", usedPercent: 100 }),
      window({ id: "d", usedPercent: 90 }),
      window({ id: "budget", kind: "budget", usedPercent: 10, remaining: 9, limit: 10 }),
      window({ id: "balance", kind: "balance", remaining: 3 }),
    ]
    expect(LimitRank.ranked(windows, LEADS_AT).map((item) => item.id)).toEqual(["c", "b", "d", "a", "balance", "budget"])
  })

  test("Claude's extra usage never ranks, refused or not", () => {
    const windows = claude(ISSUE_5920)
    for (const model of [undefined, "gpt-5.5", "claude-fable-5-1"])
      expect(LimitRank.ranked(windows, LEADS_AT, model).map((item) => item.id)).not.toContain("claude.overage")
    expect(LimitRank.extra("claude.overage")).toBe(true)
    expect(LimitRank.extra("claude.7d")).toBe(false)
  })

  test("a reset that passed unobserved counts 0 % and no state; per-minute windows only when nothing else", () => {
    const passed = window({ usedPercent: 100, status: "exhausted", resetAt: LEADS_AT - MIN, observedAt: LEADS_AT - 2 * MIN })
    expect(LimitRank.facts(passed, LEADS_AT)).toMatchObject({ percent: 0, status: "unknown", resetAt: undefined })
    expect(LimitRank.blocks(passed, LEADS_AT, undefined)).toBe(false)
    const rate = window({ id: "oai.requests", kind: "rate", usedPercent: 99 })
    expect(LimitRank.ranked([rate], LEADS_AT).map((item) => item.id)).toEqual(["oai.requests"])
    expect(LimitRank.ranked([rate, window({ usedPercent: 10 })], LEADS_AT).map((item) => item.id)).toEqual(["codex.primary"])
  })
})

describe("LimitRank.blocks and covering", () => {
  test("a window blocks the models it limits; a bucket only its family; extra usage never alone", () => {
    const windows = claude(ISSUE_5920)
    const byID = (id: string) => windows.find((item) => item.id === id)!
    expect(LimitRank.blocks(byID("claude.7d_oi"), LEADS_AT, "claude-fable-5-1")).toBe(true)
    expect(LimitRank.blocks(byID("claude.7d_oi"), LEADS_AT, "claude-sonnet-4-5")).toBe(false)
    expect(LimitRank.blocks(byID("claude.overage"), LEADS_AT, "claude-fable-5-1")).toBe(false)
    // The bucket came without a reset: stale, it no longer blocks (LimitModel.lapsed).
    expect(LimitRank.blocks(byID("claude.7d_oi"), LEADS_AT + 16 * MIN, "claude-fable-5-1")).toBe(false)
  })

  test("extra usage is in play only where a plan limit it would cover is used up", () => {
    const windows = claude(ISSUE_5920)
    expect(LimitRank.covering(windows, LEADS_AT, "claude-fable-5-1")).toBe(true)
    expect(LimitRank.covering(windows, LEADS_AT, "claude-sonnet-4-5")).toBe(false)
    expect(LimitRank.covering(windows, LEADS_AT, undefined)).toBe(false)
    const fiveHours = claude({ status: "rejected", "5h-status": "rejected", "5h-reset": reset(60), "overage-status": "rejected" })
    expect(LimitRank.covering(fiveHours, LEADS_AT, undefined)).toBe(true)
  })

  test("tones keyed on what remains", () => {
    expect([LimitRank.tone(50), LimitRank.tone(70), LimitRank.tone(90), LimitRank.tone(10, "exhausted")]).toEqual([
      "neutral",
      "warn",
      "danger",
      "danger",
    ])
    expect([LimitRank.tone(undefined, "warning"), LimitRank.tone(undefined, "ok")]).toEqual(["warn", "neutral"])
  })
})

describe("Unified.rejected: the limit that refused a request", () => {
  const headers = (values: Record<string, string>) =>
    new Headers(Object.fromEntries(Object.entries(values).map(([name, value]) => [`${Unified.PREFIX}${name}`, value])))

  test("a family's own status first, account-wide before the Fable week", () => {
    expect(Unified.rejected(headers({ "5h-status": "rejected", "5h-reset": "1789614000" }))).toEqual({
      windowId: "claude.5h",
      reason: "5h_rejected",
      resetAt: 1789614000_000,
    })
    expect(Unified.rejected(headers({ "7d-status": "rejected", "7d_oi-status": "rejected" }))).toEqual({
      windowId: "claude.7d",
      reason: "7d_rejected",
    })
    expect(Unified.rejected(headers(ISSUE_5920))).toEqual({ windowId: "claude.7d_oi", reason: "7d_oi_rejected" })
  })

  test("else the window the claim names, with the top-level reset for the Opus and Sonnet weeks", () => {
    for (const [claim, id] of [
      ["seven_day_opus", "claude.7d_opus"],
      ["seven_day_sonnet", "claude.7d_sonnet"],
      ["seven_day_overage_included", "claude.7d_oi"],
    ] as const)
      expect(
        Unified.rejected(headers({ status: "rejected", reset: "1789905600", "representative-claim": claim })),
      ).toMatchObject({ windowId: id, resetAt: 1789905600_000 })
    expect(Unified.rejected(headers({ status: "rejected", "representative-claim": "overage" }))).toEqual({
      windowId: null,
      reason: "rejected",
    })
    expect(Unified.rejected(headers({ status: "allowed", "5h-status": "allowed" }))).toBeUndefined()
  })
})

describe("LimitRank.claudeFirst (02 §7.1.2)", () => {
  test("the five hours when the account has them; the week of an account without them; nothing without either", () => {
    const five = window({ id: "claude.5h", usedPercent: 60 })
    const week = window({ id: "claude.7d", usedPercent: 30 })
    expect(LimitRank.claudeFirst([week, five])).toBe(five)
    expect(LimitRank.claudeFirst([week])).toBe(week)
    expect(LimitRank.claudeFirst([window({ id: "claude.7d_oi", usedPercent: 10 })])).toBeUndefined()
  })
})

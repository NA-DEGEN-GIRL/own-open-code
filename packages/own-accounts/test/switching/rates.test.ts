// Time-of-day prices (02 §2.4.4, §6.2, §7.5; decision D3): the rate card's peak windows, the estimator rates at a
// request time, and the DeepSeek ledger cost from the rate card at the step's request time. The cards of 2026-10-30
// (RR): Anthropic Sonnet 5.5, Haiku 5.5 and Fable 5.1, catalog cache reads for OpenAI 5.6+ and xAI, and Codex GPT-6
// Astra credits. Every credential is fake.

import { beforeAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Policy, Ratecard, type Estimate } from "@own/protocol"
import { Home } from "@own/runtime"
import { Estimator } from "../../src/switching/estimator.js"
import { Rates } from "../../src/switching/rates.js"
import { ANTH, CODEX, DEFAULT_SEEDS, DS, ok, registry, setup, step } from "../telemetry/support.js"
import { failure, machine } from "./harness.js"
import { K, NOW, PROVIDERS, cache, context, seedCards, side } from "./support.js"

// 2026-10-05 is a Monday, 2026-10-10 a Saturday. KST is UTC+9: 10:00 KST Monday = 01:00 UTC Monday.
const monday = (hour: number, minute = 0, second = 0, ms = 0) => Date.UTC(2026, 9, 5, hour, minute, second, ms)
const friday = (hour: number, minute = 0) => Date.UTC(2026, 9, 9, hour, minute)
const saturday = (hour: number) => Date.UTC(2026, 9, 10, hour)
const sunday = (hour: number) => Date.UTC(2026, 9, 4, hour)

const decodeFile = Schema.decodeUnknownSync(Ratecard.File)
const decodeCard = Schema.decodeUnknownSync(Ratecard.Card)

// No balance poll: the fake DeepSeek key must never reach the real endpoint.
const offline = () => setup({ registry: registry(DEFAULT_SEEDS.map((seed) => ({ ...seed, pollBalance: false }))) })

describe("rate card peak windows (02 §2.4.4, §6.2)", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const card = (model: string) => {
    const found = state.cards?.cards.find((item) => item.match.kind === "ds" && item.match.model === model)
    if (!found) throw new Error(`no ds card for ${model}`)
    return found
  }

  test("the seed's DeepSeek cards are peak-priced on weekdays 01-04 and 06-10 UTC", () => {
    const weekdays = [1, 2, 3, 4, 5]
    for (const model of ["deepseek-v4-pro", "deepseek-flash"])
      expect(card(model)).toMatchObject({
        offPeakMul: 0.5,
        peak: [
          { days: weekdays, from: "01:00", to: "04:00" },
          { days: weekdays, from: "06:00", to: "10:00" },
        ],
      })
    expect(state.cards?.cards.filter((item) => item.peak !== undefined).map((item) => item.match.kind)).toEqual([
      "ds",
      "ds",
    ])
  })

  test.each([
    ["Monday 00:59 UTC (09:59 KST)", monday(0, 59), 0.5],
    ["Monday 01:00 UTC (10:00 KST)", monday(1), 1],
    ["Monday 03:59 UTC", monday(3, 59), 1],
    ["Monday 04:00 UTC (13:00 KST)", monday(4), 0.5],
    ["Monday 05:30 UTC (lunch)", monday(5, 30), 0.5],
    ["Monday 06:00 UTC (15:00 KST)", monday(6), 1],
    ["Friday 09:59 UTC", friday(9, 59), 1],
    ["Friday 10:00 UTC (19:00 KST)", friday(10), 0.5],
    ["Saturday 02:00 UTC", saturday(2), 0.5],
    ["Sunday 07:00 UTC", sunday(7), 0.5],
  ] as const)("%s", (_, at, factor) => {
    expect(Ratecard.multiplier(card("deepseek-v4-pro"), at)).toBe(factor)
  })

  test("a card without windows (a file written before them) or without offPeakMul prices the same at any time", () => {
    const base = {
      match: { kind: "ds", model: "deepseek-v4-pro" },
      unit: "USD",
      in: 1.32,
      ttl: { warmLowerSec: 0, coldUpperSec: 259200 },
    }
    const older = decodeFile({ schemaVersion: 1, updatedAt: "2026-10-05", cards: [{ ...base, offPeakMul: 0.5 }] })
    expect(older.cards[0].peak).toBeUndefined()
    expect(Ratecard.multiplier(older.cards[0], saturday(2))).toBe(1)
    const unpriced = decodeCard({ ...base, peak: [{ days: [1], from: "01:00", to: "04:00" }] })
    expect(Ratecard.multiplier(unpriced, saturday(2))).toBe(1)
  })

  test.each([
    ["from after to", { days: [1], from: "10:00", to: "06:00" }],
    ["an empty window", { days: [1], from: "06:00", to: "06:00" }],
    ["an hour past 24", { days: [1], from: "01:00", to: "25:00" }],
    ["a weekday past Saturday", { days: [7], from: "01:00", to: "04:00" }],
  ])("a window with %s does not decode", (_, window) => {
    expect(() => decodeCard({ ...card("deepseek-flash"), peak: [window] })).toThrow()
  })

  test("a window may end at midnight", () => {
    const late = decodeCard({ ...card("deepseek-flash"), peak: [{ days: [6], from: "22:00", to: "24:00" }] })
    expect(Ratecard.multiplier(late, Date.UTC(2026, 9, 10, 23, 59))).toBe(1)
    expect(Ratecard.multiplier(late, Date.UTC(2026, 9, 11, 0, 0))).toBe(0.5)
  })
})

describe("estimator rates at the request time (02 §6.2)", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const resolve = (kind: "ds" | "anth", model: string, at?: number) => {
    if (!state.cards) throw new Error("cards not loaded")
    return Rates.resolve({ kind, card: Rates.match(state.cards.cards, kind, model), at })
  }

  test("DeepSeek v4-pro: peak rates in the windows, half outside them, peak rates without a time", () => {
    const peak = { unit: "USD", in: 1.32, read: 0.044, cold: 1.32, out: 3.96 }
    expect(resolve("ds", "deepseek-v4-pro", monday(2))).toMatchObject(peak)
    expect(resolve("ds", "deepseek-v4-pro", monday(4, 30))).toMatchObject({
      in: 0.66,
      read: 0.022,
      cold: 0.66,
      out: 1.98,
    })
    expect(resolve("ds", "deepseek-v4-pro")).toMatchObject(peak)
  })

  test("DeepSeek flash off-peak is half its peak price; TTLs do not change with the time", () => {
    expect(resolve("ds", "deepseek-flash", saturday(2))).toMatchObject({
      in: 0.15,
      read: 0.003,
      cold: 0.15,
      out: 0.6,
      ttlLo: 0,
      ttlHi: 259200,
    })
  })

  test("a card without peak windows ignores the time", () => {
    expect(resolve("anth", "claude-opus-5-5", saturday(2))).toMatchObject({ in: 4, read: 0.2, cold: 5, out: 20 })
  })

  test("switch.estimate prices a DeepSeek target at the planner clock's time", async () => {
    const source = { providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "high" }
    const target = { providerID: "deepseek", id: "deepseek-flash" }
    await using m = await machine({ models: { ses_one: source } })
    await m.send("session.created", {
      sessionID: "ses_one",
      model: source,
      projectID: "p",
      slug: "s",
      version: "2",
      location: {},
    })
    await m.turn("ses_one", source, { input: 12_000 })
    const rates = async () => {
      const estimate = await m.rpc("switch.estimate", { sessionID: "ses_one", target })
      if (failure(estimate) || !("inputs" in estimate)) throw new Error("estimate failed")
      return estimate.inputs.rates
    }
    // The manual clock starts on a Sunday (off-peak); 23 hours later it is 02:00 UTC Monday (peak).
    expect(new Date(m.clock.now()).getUTCDay()).toBe(0)
    expect(await rates()).toEqual({ in: 0.15, read: 0.003, cold: 0.15, out: 0.6 })
    m.clock.advance(23 * 3_600_000)
    expect(await rates()).toEqual({ in: 0.3, read: 0.006, cold: 0.3, out: 1.2 })
  })
})

describe("DeepSeek ledger cost from the rate card (02 §7.5, decision D3)", () => {
  const usage = { input: 100_000, read: 900_000, output: 10_000 }

  test("peak and off-peak steps cost the rate card at the step's request time; core's USD is kept beside it", async () => {
    await using t = await offline()
    await ok(t.telemetry.ratecardsSet, { cards: (await seedCards()).cards })
    const directory = t.deps.location.directory
    // Sent at 03:59:59.5 UTC Monday (peak), ended a second later in the off-peak hour: the request time counts.
    const steps = [
      { messageID: "msg_peak", at: monday(3, 59, 59, 500), cost: 0.05 },
      { messageID: "msg_offpeak", at: saturday(2), cost: 0.05 },
    ]
    for (const item of steps)
      for (const event of step({ providerID: DS, modelID: "deepseek-v4-pro", directory, usage, ...item }))
        await t.telemetry.onEvent?.(event, { local: true })
    await t.telemetry.flush()
    await t.deps.runtime.ledger.flush()

    const lines = (await t.deps.runtime.ledger.usageOf(Home.month(monday(0)))).map((entry) => entry.line)
    const costs = lines.map((line) => [line.messageID, line.cost?.unit, line.cost?.source, line.costUSDOpenCode])
    expect(costs).toEqual([
      ["msg_peak", "USD", "ratecard", 0.05],
      ["msg_offpeak", "USD", "ratecard", 0.05],
    ])
    // 100k × 1.32 + 900k × 0.044 + 10k × 3.96 per 1M at peak; half off-peak.
    expect(lines[0].cost?.amount).toBeCloseTo(0.2112, 10)
    expect(lines[1].cost?.amount).toBeCloseTo(0.1056, 10)
  })

  test("a card without peak windows keeps core's USD", async () => {
    await using t = await offline()
    await ok(t.telemetry.ratecardsSet, { cards: (await seedCards()).cards })
    const directory = t.deps.location.directory
    const events = step({
      providerID: ANTH,
      modelID: "claude-opus-5-5",
      messageID: "msg_anth",
      at: saturday(2),
      directory,
      usage,
      cost: 0.07,
    })
    for (const event of events) await t.telemetry.onEvent?.(event, { local: true })
    await t.telemetry.flush()
    await t.deps.runtime.ledger.flush()

    const lines = await t.deps.runtime.ledger.usageOf(Home.month(saturday(2)))
    expect(lines.map((entry) => entry.line.cost)).toEqual([{ unit: "USD", amount: 0.07, source: "opencode" }])
  })
})

describe("rate cards of 2026-10-30 (02 §6.2, RR)", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const cards = () => {
    if (!state.cards) throw new Error("cards not loaded")
    return state.cards
  }
  // The seed as it was before the card for `model` was added.
  const without = (model: string) => ({ ...cards(), cards: cards().cards.filter((card) => card.match.model !== model) })
  const plan = (source: Estimator.Side, target: Estimator.Side) =>
    Estimator.plan({
      source,
      target,
      ctx: context(),
      sourceAvailable: true,
      thresholds: Policy.defaults.thresholds,
      variantOnly: null,
    })
  const option = (result: Estimator.Plan, strategy: Estimate.Strategy) => {
    const found = result.options.find((item) => item.strategy === strategy)
    if (!found) throw new Error(`missing option ${strategy}`)
    return found
  }

  test.each([
    ["claude-sonnet-5-5", { in: 2, read: 0.1, out: 10 }, 2.5, 4],
    ["claude-haiku-5-5", { in: 0.1, read: 0.01, out: 0.5 }, 0.125, 0.2],
    ["claude-fable-5-1", { in: 10, read: 0.25, out: 50 }, 12.5, 20],
  ] as const)("%s (anth) resolves its public rates, 5-minute and 1-hour", (model, rates, write5m, write1h) => {
    const card = Rates.match(cards().cards, "anth", model)
    expect(card?.match.model).toBe(model)
    expect(Rates.resolve({ kind: "anth", card })).toMatchObject({
      unit: "USD",
      ...rates,
      cold: write5m,
      ttlLo: 300,
      ttlHi: 300,
      lookback: { blocks: 20 },
      mode: "breakpoint",
    })
    expect(Rates.resolve({ kind: "anth", card, oneHour: true })).toMatchObject({
      ...rates,
      cold: write1h,
      ttlLo: 3600,
      ttlHi: 3600,
    })
  })

  test("Sonnet 5.5: a warm target reuses its cache at $0.10, a cold one writes everything at $2.50", () => {
    const opus = side(cards(), {
      providerID: "own-anth-aaaa",
      kind: "anth",
      modelID: "claude-opus-5-5",
      cache: cache({ modelID: "claude-opus-5-5" }),
      window: 1_000_000,
    })
    const sonnet = (file: Ratecard.File, idleMs: number) =>
      side(file, {
        providerID: "own-anth-bbbb",
        kind: "anth",
        modelID: "claude-sonnet-5-5",
        cache: cache({ modelID: "claude-sonnet-5-5", lastReqAt: NOW - idleMs }),
        window: 1_000_000,
      })

    // One minute after B's last request: 150k × $0.10 + 3k × $2.50 = $0.0225 against staying on Opus 5.5
    // (150k × $0.20 + 3k × $5 = $0.045).
    const warm = plan(opus, sonnet(cards(), 60_000))
    expect(warm.W).toEqual({ lo: 150 * K, hi: 150 * K })
    expect(warm.predictedCold).toBe(3 * K)
    expect(warm.deltaNow).toEqual({ lo: -0.0225, hi: -0.0225, unit: "USD" })

    // Ten minutes later the 5-minute cache is gone: 153k × $2.50 = $0.3825, $0.3375 over staying.
    const cold = plan(opus, sonnet(cards(), 10 * 60_000))
    expect(cold.W).toEqual({ lo: 0, hi: 0 })
    expect(cold.predictedCold).toBe(153 * K)
    expect(cold.deltaNow).toEqual({ lo: 0.3375, hi: 0.3375, unit: "USD" })

    // Without the card the TTL was unknown (0), so the same warm cache counted as cold.
    expect(plan(opus, sonnet(without("claude-sonnet-5-5"), 60_000)).W).toEqual({ lo: 0, hi: 0 })
  })

  test("Haiku 5.5 in 1-hour mode: still warm after 30 minutes, a cold first request writes at $0.20", () => {
    const haiku = (oneHour: boolean) =>
      side(cards(), {
        providerID: "own-anth-bbbb",
        kind: "anth",
        modelID: "claude-haiku-5-5",
        cache: cache({ modelID: "claude-haiku-5-5", lastReqAt: NOW - 30 * 60_000 }),
        window: 1_000_000,
        oneHour,
      })
    const source = side(cards(), { providerID: "own-anth-aaaa", kind: "anth", modelID: "claude-haiku-5-5" })
    expect(plan(source, haiku(true)).W).toEqual({ lo: 150 * K, hi: 150 * K })
    expect(plan(source, haiku(false)).W).toEqual({ lo: 0, hi: 0 })
    // 153k written at the 1-hour price, against $0.019125 at the 5-minute one.
    expect(Estimator.firstRequest(haiku(true).rates, 0, 153 * K)).toBeCloseTo(0.0306, 10)
    expect(Estimator.firstRequest(haiku(false).rates, 0, 153 * K)).toBeCloseTo(0.019125, 10)
  })

  test("OpenAI API GPT-6.1 takes its 0.05x cache read from the catalog; GPT-5.6 keeps 0.1x", () => {
    const resolve = (model: string, catalog: Rates.CatalogCost) =>
      Rates.resolve({ kind: "oai", card: Rates.match(cards().cards, "oai", model), catalog })
    // models.dev, 2026-10-30: gpt-6.1-sol $2 / $10, cache read $0.10, write $2.50; gpt-5.6-sol $4 / $20, $0.40, $5.
    expect(resolve("gpt-6.1-sol", { input: 2, output: 10, cache: { read: 0.1, write: 2.5 } })).toMatchObject({
      in: 2,
      read: 0.1,
      cold: 2.5,
      out: 10,
      ttlLo: 1800,
      lookback: { messageEnds: 20 },
    })
    expect(resolve("gpt-5.6-sol", { input: 4, output: 20, cache: { read: 0.4, write: 5 } })).toMatchObject({
      in: 4,
      read: 0.4,
      cold: 5,
      out: 20,
    })
  })

  test("xAI cache reads come from the catalog, model by model", () => {
    const resolve = (model: string, catalog: Rates.CatalogCost) =>
      Rates.resolve({ kind: "xai", card: Rates.match(cards().cards, "xai", model), catalog })
    expect(resolve("grok-4.5", { input: 2, output: 6, cache: { read: 0.3, write: 0 } })).toMatchObject({
      in: 2,
      read: 0.3,
      cold: 2,
    })
    expect(resolve("grok-4.3", { input: 1.25, output: 2.5, cache: { read: 0.2, write: 0 } })).toMatchObject({
      read: 0.2,
    })
  })

  test("Codex GPT-6 Astra has credit rates, so every option is priced and rate_unknown is gone", () => {
    const astra = (file: Ratecard.File, providerID: string, warm: boolean) =>
      side(file, {
        providerID,
        kind: "codex",
        modelID: "gpt-6-astra",
        ...(warm ? { cache: cache({ modelID: "gpt-6-astra" }) } : {}),
      })
    expect(astra(cards(), "own-codex-bbbb", false).rates).toMatchObject({
      unit: "credits",
      in: 250,
      read: 25,
      cold: 250,
      out: 1250,
    })

    const priced = plan(astra(cards(), "own-codex-aaaa", true), astra(cards(), "own-codex-bbbb", false))
    expect(priced.warnings).not.toContain("rate_unknown")
    // 153k × 250 cold on B against 150k × 25 + 3k × 250 staying on A: 38.25 − 4.5 = 33.75 cr.
    expect(option(priced, "now")).toMatchObject({ available: true, delta: { lo: 33.75, hi: 33.75, unit: "credits" } })
    expect(option(priced, "compact-then-switch").available).toBe(true)
    expect(option(priced, "new-session").available).toBe(true)

    const before = without("gpt-6-astra")
    const unpriced = plan(astra(before, "own-codex-aaaa", true), astra(before, "own-codex-bbbb", false))
    expect(unpriced.warnings).toContain("rate_unknown")
    expect(option(unpriced, "now").delta).toBeNull()
  })

  // MR8-20: the Codex pricing page (read 2026-10-31) lists GPT-6.1 Sol and Terra, and the outputs and Luna rates the
  // seed lacked; each is priced now, and a switch between them carries no rate_unknown.
  test("Codex GPT-6.1 Sol and Terra, GPT-6 Luna and GPT-5.6 Luna have credit cards; GPT-6 Sol and 5.6 Terra their output", () => {
    const rates = (modelID: string, providerID = "own-codex-bbbb") =>
      side(cards(), { providerID, kind: "codex", modelID }).rates
    expect(rates("gpt-6.1-sol")).toMatchObject({ unit: "credits", in: 50, read: 2.5, cold: 50, out: 250 })
    expect(rates("gpt-6.1-terra")).toMatchObject({ unit: "credits", in: 25, read: 1.25, cold: 25, out: 125 })
    expect(rates("gpt-6-luna")).toMatchObject({ unit: "credits", in: 2.5, read: 0.25, out: 12.5 })
    expect(rates("gpt-5.6-luna")).toMatchObject({ unit: "credits", in: 5, read: 0.5, out: 30 })
    expect(rates("gpt-6-sol")).toMatchObject({ unit: "credits", in: 50, read: 5, out: 250 })
    expect(rates("gpt-5.6-terra")).toMatchObject({ unit: "credits", in: 50, read: 5, out: 300 })
    const sol = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-6.1-sol",
      cache: cache({ modelID: "gpt-6.1-sol" }),
    })
    const terra = side(cards(), { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-6.1-terra" })
    expect(plan(sol, terra).warnings).not.toContain("rate_unknown")
    const before = without("gpt-6.1-terra")
    const unpriced = plan(sol, side(before, { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-6.1-terra" }))
    expect(unpriced.warnings).toContain("rate_unknown")
  })

  test("a Codex GPT-6 Astra step costs rate-card credits in the ledger", async () => {
    await using t = await offline()
    await ok(t.telemetry.ratecardsSet, { cards: cards().cards })
    const events = step({
      providerID: CODEX,
      modelID: "gpt-6-astra",
      messageID: "msg_astra",
      at: monday(2),
      directory: t.deps.location.directory,
      usage: { input: 100_000, read: 900_000, output: 10_000 },
    })
    for (const event of events) await t.telemetry.onEvent?.(event, { local: true })
    await t.telemetry.flush()
    await t.deps.runtime.ledger.flush()

    const lines = await t.deps.runtime.ledger.usageOf(Home.month(monday(2)))
    // 100k × 250 + 900k × 25 + 10k × 1,250 per 1M.
    expect(lines.map((entry) => entry.line.cost)).toEqual([{ unit: "credits", amount: 60, source: "ratecard" }])
  })
})

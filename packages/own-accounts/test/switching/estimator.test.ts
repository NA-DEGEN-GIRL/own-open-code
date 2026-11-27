// Table tests of the pure cost model against the worked examples of 02 §6.4 and the rules of 02 §5.6 / §6.3.

import { beforeAll, describe, expect, test } from "bun:test"
import { Policy, type Estimate, type Ratecard } from "@own/protocol"
import { Estimator } from "../../src/switching/estimator.js"
import { K, NOW, cache, context, seedCards, side } from "./support.js"

const thresholds = Policy.defaults.thresholds

const option = (plan: Estimator.Plan, strategy: Estimate.Strategy) => {
  const found = plan.options.find((item) => item.strategy === strategy)
  if (!found) throw new Error(`missing option ${strategy}`)
  return found
}

const close = (value: number | null | undefined, expected: number, digits = 3) => {
  expect(value).not.toBeNull()
  expect(value).toBeCloseTo(expected, digits)
}

describe("02 §6.4 worked examples", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const cards = () => {
    if (!state.cards) throw new Error("cards not loaded")
    return state.cards
  }

  // Example 1: Codex A→B, GPT-5.6 Sol, both Plus; A's last request one minute ago.
  const codex = () => {
    const source = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const target = side(cards(), { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-5.6-sol" })
    return { source, target }
  }

  test("example 1: now +13.5 cr recommended, compact-then-switch +7.3 cr, cold point +0~1.1, new session +5.0", () => {
    const sides = codex()
    const plan = Estimator.plan({ ...sides, ctx: context(), sourceAvailable: true, thresholds, variantOnly: null })
    expect(plan.units).toEqual({ source: "credits", target: "credits" })
    expect(plan.W).toEqual({ lo: 0, hi: 0 })
    expect(plan.Wcur).toEqual({ lo: 150 * K, hi: 150 * K })
    expect(plan.fits).toBe(true)

    const now = option(plan, "now")
    expect(now).toMatchObject({ available: true, display: "primary", delta: { lo: 13.5, hi: 13.5, unit: "credits" } })
    close(now.perRequestAfter, 1.83)
    expect(now.quota).toEqual({ window: "codex.primary", percent: null, state: "calibrating" })

    const compact = option(plan, "compact-then-switch")
    expect(compact.available).toBe(true)
    // Cost alone never recommends compacting: P_t = 153k stays below 0.8 · T_t (07 §6.2 #11).
    expect(compact.recommended).toBeUndefined()
    close(compact.delta?.lo, 7.28)
    close(compact.delta?.hi, 7.28)
    close(compact.perRequestAfter, 0.67)
    // "이후 요청당 −63%": 0.67 against 1.83 when staying.
    close(1 - (compact.perRequestAfter ?? 0) / (Estimator.perRequest(sides.source.rates, 153 * K, 3 * K) ?? 1), 0.634)

    expect(option(plan, "switch-then-compact")).toMatchObject({ available: false, reason: "source_available" })
    const cold = option(plan, "cold-point")
    expect(cold).toMatchObject({ available: true, trigger: "either", idleMinutes: 60, uncertain: true })
    expect(cold.delta?.lo).toBe(0)
    close(cold.delta?.hi, 1.08)
    expect(option(plan, "new-session")).toMatchObject({
      available: true,
      contextLoss: true,
      delta: { lo: 5, hi: 5, unit: "credits" },
    })
    expect(option(plan, "fork")).toMatchObject({ display: "secondary", delta: { lo: 13.5, hi: 13.5 } })
    expect(plan.recommended).toBe("now")
    expect(plan.options.filter((item) => item.recommended)).toHaveLength(1)
    expect(plan.predictedCold).toBe(153 * K)
    expect(plan.warnings).toEqual([])
  })

  test("example 1: Δ_compact(h_c = 0) is about +19.7 cr (why only the warm prefix source makes it recommended)", () => {
    const rates = codex().source.rates
    const cold = Estimator.compactRequest(rates, 138 * K, 8 * K, 0)
    close((cold ?? 0) + Estimator.cost(37 * K, 100) - 1.8, 19.7)
  })

  test("example 1: switch-then-compact when A is exhausted pays off from H ≥ 7 (the cost of each path)", () => {
    const plan = Estimator.plan({
      ...codex(),
      ctx: context(),
      sourceAvailable: false,
      thresholds,
      variantOnly: null,
    })
    // No stay baseline when the source cannot serve: the options show the switch path's own cost.
    expect(option(plan, "now").delta).toEqual({ lo: 15.3, hi: 15.3, unit: "credits" })
    const switchCompact = option(plan, "switch-then-compact")
    expect(switchCompact.available).toBe(true)
    close(switchCompact.delta?.lo, 21.5)
    close(switchCompact.perRequestAfter, 0.67)
    close(plan.breakeven, 6.345)
    expect(Math.ceil(plan.breakeven ?? 0)).toBe(7)
    // 153k is below 0.6 · 272k: without an absolute size rule (07 §6.2 #10) the switch happens now.
    expect(plan.recommended).toBe("now")
    expect(option(plan, "compact-then-switch")).toMatchObject({ available: false, reason: "source_exhausted" })
    expect(option(plan, "cold-point")).toMatchObject({ available: false, reason: "source_exhausted" })
    // Without a usable source the seed is built without a model call: only the target's cold start remains.
    expect(option(plan, "new-session").delta).toEqual({ lo: 2, hi: 2, unit: "credits" })
  })

  test("example 1: an exhausted source switches then compacts only from 0.6 · ctx_t and H ≥ H*, else switches now", () => {
    const exhausted = (input: { readonly window?: number; readonly horizon?: number }) =>
      Estimator.plan({
        source: codex().source,
        target: side(cards(), {
          providerID: "own-codex-bbbb",
          kind: "codex",
          modelID: "gpt-5.6-sol",
          window: input.window,
        }),
        ctx: context({ horizon: input.horizon ?? 20 }),
        sourceAvailable: false,
        thresholds,
        variantOnly: null,
      })
    // 153k ≥ 0.6 · 250k and H = 20 ≥ H* ≈ 6.3.
    expect(exhausted({ window: 250 * K }).recommended).toBe("switch-then-compact")
    // Below the break-even horizon the switch happens now; a large context alone never hands off to a new session
    // (07 §6.2 #9).
    expect(exhausted({ window: 250 * K, horizon: 5 }).recommended).toBe("now")
    expect(exhausted({ horizon: 5 }).recommended).toBe("now")
  })

  // Example 2: Anthropic, another workspace of the same org, Opus 5.5.
  const anthropic = (oneHour = false) => ({
    source: side(cards(), {
      providerID: "own-anth-aaaa",
      kind: "anth",
      modelID: "claude-opus-5-5",
      quotaDomain: "qd_org",
      cache: cache({ modelID: "claude-opus-5-5" }),
      window: 1_000_000,
    }),
    target: side(cards(), {
      providerID: "own-anth-bbbb",
      kind: "anth",
      modelID: "claude-opus-5-5",
      quotaDomain: "qd_org",
      window: 1_000_000,
      oneHour,
    }),
  })

  test("example 2: now +$0.72, compaction +$0.33~0.99 (unknown h_c), `now` stays recommended", () => {
    const plan = Estimator.plan({
      ...anthropic(),
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(plan.units).toEqual({ source: "USD", target: "USD" })
    close(option(plan, "now").delta?.lo, 0.72)
    const compact = option(plan, "compact-then-switch")
    close(compact.delta?.lo, 0.3276, 4)
    close(compact.delta?.hi, 0.99)
    expect(compact.warnings).toEqual(["anthropic_compaction_may_be_cold"])
    expect(plan.recommended).toBe("now")
    expect(plan.warnings).toContain("anthropic_compaction_may_be_cold")
    expect(plan.warnings).toContain("same_org_no_headroom")
    expect(option(plan, "cold-point")).toMatchObject({ available: true, idleMinutes: 5, uncertain: false })
  })

  test("example 2: the first request in 1h mode writes at $8/1M (153k × 8 = $1.22)", () => {
    const sides = anthropic(true)
    close(Estimator.firstRequest(sides.target.rates, 0, 153 * K), 1.224)
    const plan = Estimator.plan({ ...sides, ctx: context(), sourceAvailable: true, thresholds, variantOnly: null })
    close(option(plan, "now").delta?.lo, 1.224 - 0.045)
  })

  // Example 3: back to A (Anthropic) after three turns on B, four minutes later.
  const back = (entry: Partial<Estimator.SlotCache>) => {
    const target = side(cards(), {
      providerID: "own-anth-aaaa",
      kind: "anth",
      modelID: "claude-opus-5-5",
      window: 1_000_000,
      cache: cache({ modelID: "claude-opus-5-5", lastReqAt: NOW - 4 * 60_000, blocksSince: 12, ...entry }),
    })
    const source = side(cards(), {
      providerID: "own-anth-bbbb",
      kind: "anth",
      modelID: "claude-opus-5-5",
      window: 1_000_000,
      cache: cache({ modelID: "claude-opus-5-5" }),
    })
    const ctx = context({ P: 161 * K })
    const W = Estimator.reuse(target, source, ctx)
    return { W, first: Estimator.firstRequest(target.rates, W.lo, 161 * K) }
  }

  test("example 3: within TTL the return reuses L_A = 150k ($0.085 instead of $0.805)", () => {
    const warm = back({})
    expect(warm.W).toEqual({ lo: 150 * K, hi: 150 * K })
    close(warm.first, 0.085)
  })

  test("example 3: 30 blocks without a watermark fall back to Z (≈ $0.75); a watermark restores $0.085", () => {
    const beyond = back({ blocksSince: 30 })
    expect(beyond.W.lo).toBe(12 * K)
    close(beyond.first, 0.7474)
    close(back({ blocksSince: 30, watermark: true }).first, 0.085)
  })

  test("example 3: seven minutes (past the 5-minute TTL) is cold again ($0.805)", () => {
    const late = back({ lastReqAt: NOW - 7 * 60_000 })
    expect(late.W).toEqual({ lo: 0, hi: 0 })
    close(late.first, 0.805)
  })

  // Example 4: Codex GPT-5.6 Sol → DeepSeek v4-pro (peak), ρ = 1.
  test("example 4: a cross-unit switch reports the target's own cost and recommends nothing", () => {
    const source = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const target = side(cards(), {
      providerID: "own-ds-cccc",
      kind: "ds",
      modelID: "deepseek-v4-pro",
      window: 1_000_000,
      billing: "prepaid",
    })
    const plan = Estimator.plan({
      source,
      target,
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(plan.units).toEqual({ source: "credits", target: "USD" })
    close(option(plan, "now").delta?.lo, 0.202)
    close(plan.perRequest, 0.0107, 4)
    expect(plan.recommended).toBeUndefined()
    expect(plan.options.some((item) => item.recommended)).toBe(false)
    expect(plan.warnings).toContain("cross_provider_reasoning_loss")
  })

  test("example 4: returning to Codex after 40 minutes is cold (15.3 cr); unknown TTL_hi gives no better bound", () => {
    const codexTarget = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol", lastReqAt: NOW - 40 * 60_000 }),
    })
    const deepseek = side(cards(), {
      providerID: "own-ds-cccc",
      kind: "ds",
      modelID: "deepseek-v4-pro",
      cache: cache({ modelID: "deepseek-v4-pro" }),
    })
    const W = Estimator.reuse(codexTarget, deepseek, context())
    expect(W).toEqual({ lo: 0, hi: 0 })
    close(Estimator.firstRequest(codexTarget.rates, W.lo, 153 * K), 15.3)
  })

  test("example 5: quota % range before calibration: switch +12.24%, stay [1.44%, 12.24%], Δ [0%, 10.8%]", () => {
    const ku = 8e-5
    expect(
      Estimator.quotaDelta({ ku, switched: { U: 153 * K, C: 0, O: 0 }, stayed: { U: 153 * K, C: 0, O: 0 } }),
    ).toEqual({
      lo: 0,
      hi: 0,
    })
    const delta = Estimator.quotaDelta({
      ku,
      switched: { U: 153 * K, C: 0, O: 0 },
      stayed: { U: 3 * K, C: 150 * K, O: 0 },
    })
    close(delta.lo, 0)
    close(delta.hi, 10.8)
  })
})

describe("02 §6.3 ① reuse and §5.6 choices", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const cards = () => {
    if (!state.cards) throw new Error("cards not loaded")
    return state.cards
  }

  test("same cache domain across slots counts Z + u_1 in W^hi only, until pooling is verified", () => {
    const source = side(cards(), {
      providerID: "own-oai-aaaa",
      kind: "oai",
      modelID: "gpt-5.5",
      cacheDomain: "cd_org",
      cache: cache({ modelID: "gpt-5.5" }),
      catalog: { input: 1.25, output: 10 },
    })
    const target = side(cards(), {
      providerID: "own-oai-bbbb",
      kind: "oai",
      modelID: "gpt-5.5",
      cacheDomain: "cd_org",
      catalog: { input: 1.25, output: 10 },
    })
    expect(Estimator.reuse(target, source, context())).toEqual({ lo: 0, hi: 14 * K })
    expect(Estimator.reuse({ ...target, poolingVerified: true }, source, context())).toEqual({ lo: 14 * K, hi: 14 * K })
    expect(Estimator.reuse(target, source, context({ d9: false }))).toEqual({ lo: 0, hi: 8 * K })
  })

  test("the slot's own entry needs the same epoch, model and variant", () => {
    const target = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const other = side(cards(), { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-5.6-sol" })
    expect(Estimator.reuse(target, other, context()).lo).toBe(150 * K)
    expect(Estimator.reuse(target, other, context({ epoch: 1 })).lo).toBe(0)
    expect(Estimator.reuse({ ...target, variant: "low" }, other, context()).lo).toBe(0)
    expect(Estimator.reuse({ ...target, modelID: "gpt-5.6-terra" }, other, context()).lo).toBe(0)
  })

  test("OpenAI ≤5.5 stays warm between TTL_lo (30m) and TTL_hi (24h) only in W^hi", () => {
    const target = side(cards(), {
      providerID: "own-oai-aaaa",
      kind: "oai",
      modelID: "gpt-5.5",
      cache: cache({ modelID: "gpt-5.5", lastReqAt: NOW - 2 * 60 * 60_000 }),
      catalog: { input: 1.25, output: 10 },
    })
    const other = side(cards(), { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-5.6-sol" })
    expect(Estimator.reuse(target, other, context())).toEqual({ lo: 0, hi: 150 * K })
  })

  test("a variant change on an effort-update route keeps the cache: `now` costs 0 and is recommended", () => {
    const source = side(cards(), {
      providerID: "own-anth-aaaa",
      kind: "anth",
      modelID: "claude-opus-5-5",
      cache: cache({ modelID: "claude-opus-5-5" }),
      window: 1_000_000,
    })
    const plan = Estimator.plan({
      source,
      target: { ...source, variant: "low", cache: undefined },
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: { preservesCache: true, reason: "message_effort_update" },
    })
    expect(option(plan, "now").delta).toEqual({ lo: 0, hi: 0, unit: "USD" })
    expect(plan.recommended).toBe("now")
  })

  test("a target whose trigger is below P_t forces compact-then-switch and blocks `now`", () => {
    const source = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const target = side(cards(), {
      providerID: "own-codex-bbbb",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      window: 150 * K,
    })
    const plan = Estimator.plan({
      source,
      target,
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(plan.fits).toBe(false)
    expect(option(plan, "now")).toMatchObject({ available: false, reason: "target_context_too_small" })
    expect(plan.recommended).toBe("compact-then-switch")
    expect(plan.warnings).toContain("target_context_too_small")
  })

  test("0.8·T_t ≤ P_t < T_t warns target_compacts_soon (internal until the protocol lists it)", () => {
    const source = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const target = side(cards(), {
      providerID: "own-codex-bbbb",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      window: 200 * K,
    })
    const plan = Estimator.plan({
      source,
      target,
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(plan.warnings).toContain("target_compacts_soon")
    expect(plan.recommended).toBe("compact-then-switch")
  })

  test("an unknown r_out makes the compaction and handoff options unavailable with rate_unknown", () => {
    // Every Codex card has an output rate since MR8-20; this one is taken out, as GPT-5.6 Terra's was before.
    const file = {
      ...cards(),
      cards: cards().cards.map((card) =>
        card.match.kind === "codex" && card.match.model === "gpt-5.6-terra" ? { ...card, out: undefined } : card,
      ),
    }
    const source = side(file, {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-terra",
      cache: cache({ modelID: "gpt-5.6-terra" }),
    })
    const target = side(file, { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-5.6-terra" })
    const plan = Estimator.plan({
      source,
      target,
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(option(plan, "compact-then-switch")).toMatchObject({ available: false, reason: "rate_unknown", delta: null })
    expect(option(plan, "new-session")).toMatchObject({ available: false, reason: "rate_unknown", delta: null })
    expect(option(plan, "now").available).toBe(true)
    expect(plan.warnings).toContain("rate_unknown")
    expect(plan.recommended).toBe("now")
  })

  test("cold point: already cold after TTL_hi, pointless when TTL_hi exceeds a day", () => {
    const anth = side(cards(), {
      providerID: "own-anth-aaaa",
      kind: "anth",
      modelID: "claude-opus-5-5",
      cache: cache({ modelID: "claude-opus-5-5", lastReqAt: NOW - 10 * 60_000 }),
      window: 1_000_000,
    })
    const other = side(cards(), {
      providerID: "own-anth-bbbb",
      kind: "anth",
      modelID: "claude-opus-5-5",
      window: 1_000_000,
    })
    const coldPlan = Estimator.plan({
      source: anth,
      target: other,
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(option(coldPlan, "cold-point")).toMatchObject({ available: false, reason: "source_already_cold" })

    const deepseek = side(cards(), {
      providerID: "own-ds-aaaa",
      kind: "ds",
      modelID: "deepseek-v4-pro",
      cache: cache({ modelID: "deepseek-v4-pro" }),
      window: 1_000_000,
    })
    const longPlan = Estimator.plan({
      source: deepseek,
      target: other,
      ctx: context(),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(option(longPlan, "cold-point")).toMatchObject({ available: false, reason: "ttl_too_long" })
  })

  test("an empty session recommends `now` at no cost", () => {
    const source = side(cards(), { providerID: "own-codex-aaaa", kind: "codex", modelID: "gpt-5.6-sol" })
    const target = side(cards(), { providerID: "own-codex-bbbb", kind: "codex", modelID: "gpt-5.6-sol" })
    const plan = Estimator.plan({
      source,
      target,
      ctx: context({ P: 0 }),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(option(plan, "now").delta).toEqual({ lo: 0, hi: 0, unit: "credits" })
    expect(plan.recommended).toBe("now")
    expect(option(plan, "cold-point")).toMatchObject({ available: false, reason: "source_already_cold" })
  })

  test("an unknown target rate leaves `now` available with delta null", () => {
    const source = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const target = side(cards(), { providerID: "own-compat-cccc", kind: "compat", modelID: "qwen3", window: 128 * K })
    const plan = Estimator.plan({
      source,
      target,
      ctx: context({ P: 20 * K }),
      sourceAvailable: true,
      thresholds,
      variantOnly: null,
    })
    expect(option(plan, "now")).toMatchObject({ available: true, delta: null })
    expect(plan.warnings).toContain("rate_unknown")
  })
})

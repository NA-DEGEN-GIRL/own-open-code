// Table tests of the switching rule helpers: ratecard matching (02 §2.4.4), kind thresholds (02 §4.7.3), variant-only
// switches (02 §5.1), hysteresis and breaker (02 §5.5), target ranking (02 §5.7) and policy rules (02 §5.10).

import { beforeAll, describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Account, Compaction, Policy, Preserve, Registry, type Ratecard } from "@own/protocol"
import { Hysteresis } from "../../src/switching/hysteresis.js"
import { PolicyRules } from "../../src/switching/policy.js"
import { Rates } from "../../src/switching/rates.js"
import { Targets } from "../../src/switching/targets.js"
import { Variant } from "../../src/switching/variant.js"
import { K, NOW, PROVIDERS, cache, context, registry, seedCards, side } from "./support.js"

describe("ratecards (02 §2.4.4, §6.2)", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const cards = () => {
    if (!state.cards) throw new Error("cards not loaded")
    return state.cards.cards
  }

  test.each([
    [
      "codex",
      "gpt-5.6-sol",
      { unit: "credits", in: 100, read: 10, cold: 100, out: 500, ttlLo: 300, ttlHi: null, mode: "prefix" },
    ],
    [
      "codex",
      "gpt-5.5",
      { unit: "credits", in: 125, read: 12.5, cold: 125, out: 750, ttlLo: 300, ttlHi: null, mode: "prefix" },
    ],
    [
      "codex",
      "gpt-5.6-terra",
      { unit: "credits", in: 50, read: 5, cold: 50, out: 300, ttlLo: 300, ttlHi: null, mode: "prefix" },
    ],
    [
      "anth",
      "claude-opus-5-5",
      { unit: "USD", in: 4, read: 0.2, cold: 5, out: 20, ttlLo: 300, ttlHi: 300, mode: "breakpoint" },
    ],
    [
      "ds",
      "deepseek-v4-pro",
      { unit: "USD", in: 1.32, read: 0.044, cold: 1.32, out: 3.96, ttlLo: 0, ttlHi: 259200, mode: "prefix" },
    ],
  ] as const)("%s %s", (kind, model, expected) => {
    expect(Rates.resolve({ kind, card: Rates.match(cards(), kind, model) })).toMatchObject(expected)
  })

  test("OpenAI API cards split at gpt-5.6 and take rates from the catalog", () => {
    const catalog = { input: 2, output: 8, cache: { read: 0.5, write: 2 } }
    // 5.6+ reads the catalog's cache price as it is (GPT-6.1 is 0.05x, 2026-10-30); ≤5.5 keeps readMul 0.1.
    const newer = Rates.resolve({ kind: "oai", card: Rates.match(cards(), "oai", "gpt-5.6"), catalog })
    expect(newer).toMatchObject({ in: 2, read: 0.5, cold: 2.5, out: 8, ttlLo: 1800, ttlHi: 1800, mode: "breakpoint" })
    const older = Rates.resolve({ kind: "oai", card: Rates.match(cards(), "oai", "gpt-5.5"), catalog })
    expect(older).toMatchObject({ in: 2, read: 0.2, cold: 2, out: 8, ttlLo: 1800, ttlHi: 86400, mode: "prefix" })
    expect(Rates.match(cards(), "oai", "gpt-6-sol")?.match.modelGte).toBe("gpt-5.6")
  })

  test("the Anthropic 1h mode writes at write1h with the 60-minute TTL", () => {
    const card = Rates.match(cards(), "anth", "claude-opus-5-5")
    expect(Rates.resolve({ kind: "anth", card, oneHour: true })).toMatchObject({ cold: 8, ttlLo: 3600, ttlHi: 3600 })
  })

  test("the Claude slot has no card: percent unit, 5-minute TTL, 20-block lookback", () => {
    expect(Rates.resolve({ kind: "claude-sub", card: undefined })).toMatchObject({
      unit: "percent",
      in: null,
      ttlLo: 300,
      ttlHi: 300,
      lookback: { blocks: 20 },
      mode: "breakpoint",
    })
  })

  test("Sign in with ChatGPT is plan-billed: credits without a card, never a catalog USD price", () => {
    const catalog = { input: 5, output: 30, cache: { read: 0.5, write: 0 } }
    expect(Rates.resolve({ kind: "siwc", card: undefined, catalog })).toMatchObject({ unit: "credits", in: null })
    // Token sharing refuses the `configuration_update` item (02 §3.2c), so no siwc model keeps the cache on an effort
    // change; the request drops the markers instead.
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.5"]) expect(Variant.supportsEffortUpdates("siwc", id)).toBe(false)
    const sol = { providerID: "own-siwc-ssss", id: "gpt-6.1-sol" }
    expect(Variant.only({ ...sol, variant: "high" }, { ...sol, variant: "max" }, "siwc")).toEqual({
      preservesCache: false,
      reason: "route_unsupported",
    })
  })

  test("effort updates mirror upstream's forward-compatible rules (GPT-6+, Claude Opus 5+ and every Claude 5.1+)", () => {
    for (const id of ["gpt-6", "gpt-6.1-sol", "gpt-6-astra-ultrafast", "openai/gpt-7"])
      expect(Variant.supportsEffortUpdates("codex", id)).toBe(true)
    for (const id of ["gpt-5.6-sol", "gpt-5.5", "gpt-60x"]) expect(Variant.supportsEffortUpdates("oai", id)).toBe(false)
    for (const id of ["claude-opus-5", "claude-sonnet-5-1", "claude-fable-5-1", "claude-haiku-6"])
      expect(Variant.supportsEffortUpdates("anth", id)).toBe(true)
    for (const id of ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-5-20260101"])
      expect(Variant.supportsEffortUpdates("claude-sub", id)).toBe(false)
  })

  test("an exact model beats a range, which beats a kind-only card", () => {
    const base = { unit: "USD" as const, ttl: { warmLowerSec: 0, coldUpperSec: null } }
    const list: Ratecard.Card[] = [
      { ...base, match: { kind: "xai" }, in: 1 },
      { ...base, match: { kind: "xai", modelGte: "grok-4" }, in: 2 },
      { ...base, match: { kind: "xai", model: "grok-4.7" }, in: 3 },
    ]
    expect(Rates.match(list, "xai", "grok-4.7")?.in).toBe(3)
    expect(Rates.match(list, "xai", "grok-4.3")?.in).toBe(2)
    expect(Rates.match(list, "xai", "grok-3")?.in).toBe(1)
    expect(Rates.match(list, "xai", "x-ai/grok-4.7")?.in).toBe(3)
  })

  test.each([
    ["gpt-5.6-sol", "gpt-5.6", 0],
    ["gpt-5.5", "gpt-5.6", -1],
    ["gpt-6-astra", "gpt-5.6", 1],
    ["gpt-5.10", "gpt-5.9", 1],
    ["o3", "gpt-5.6", undefined],
  ] as const)("compareVersion(%s, %s) = %s", (a, b, expected) => {
    expect(Rates.compareVersion(a, b)).toBe(expected)
  })
})

/** The switch planner resolves thresholds with `@own/protocol` `Compaction` (kind constants only here). */
function trigger_(kind: Compaction.ChainInput["kind"], window: number) {
  return Compaction.resolve(Compaction.chain({ kind, modelID: "m" }), { context: window }, undefined, kind)
}

describe("auto-compaction trigger by kind (02 §4.7.3 table)", () => {
  test.each([
    // Core keeps 15% of the window free (upstream v2.1 RESERVE_SHARE; 10% before).
    ["codex", 272_000, 231_200],
    ["anth", 1_000_000, 850_000],
    ["claude-sub", 1_000_000, 850_000],
    ["oai", 922_000, 783_700],
    ["ds", 1_000_000, 850_000],
    ["xai", 500_000, 425_000],
    ["or", 1_000_000, 850_000],
    ["or", 163_840, 139_264],
    ["or", 128_000, 108_800],
    // Below a 106,667 window core keeps 16k free rather than 15% (upstream d9987ef9c8); compat stays at 90%.
    ["or", 100_000, 84_000],
    ["compat", 128_000, 115_200],
    ["compat", 100_000, 90_000],
  ] as const)("%s with a %d window triggers at %d", (kind, window, trigger) => {
    expect(trigger_(kind, window)?.triggerTokens).toBe(trigger)
  })

  test("the floor keeps a small window at the v2 default, and a 0 window never auto-compacts", () => {
    // 64k − 16k = 48k is below K + 48k = 63k.
    expect(trigger_("or", 64_000)).toMatchObject({
      windowTokens: 64_000,
      triggerTokens: 48_000,
      floorTokens: 48_000,
    })
    // compat: 90% of the window, with the same floor below it.
    expect(trigger_("compat", 64_000)).toMatchObject({
      windowTokens: 64_000,
      triggerTokens: 57_600,
      floorTokens: 48_000,
    })
    expect(trigger_("ds", 1_000_000)?.floorTokens).toBe(63_000)
    expect(trigger_("codex", 0)).toBeUndefined()
  })
})

describe("variant-only switches (02 §5.1)", () => {
  const ref = (providerID: string, id: string, variant?: string) => ({
    providerID,
    id,
    ...(variant ? { variant } : {}),
  })

  test.each([
    [
      "anth",
      ref("p", "claude-opus-5-5", "high"),
      ref("p", "claude-opus-5-5", "low"),
      { preservesCache: true, reason: "message_effort_update" },
    ],
    [
      "anth",
      ref("p", "claude-fable-5-1", "high"),
      ref("p", "claude-fable-5-1", "max"),
      { preservesCache: true, reason: "message_effort_update" },
    ],
    [
      "anth",
      ref("p", "claude-sonnet-4-5", "high"),
      ref("p", "claude-sonnet-4-5", "low"),
      { preservesCache: false, reason: "route_unsupported" },
    ],
    [
      "codex",
      ref("p", "gpt-6-sol", "high"),
      ref("p", "gpt-6-sol", "medium"),
      { preservesCache: true, reason: "message_effort_update" },
    ],
    [
      "codex",
      ref("p", "gpt-5.5", "high"),
      ref("p", "gpt-5.5", "medium"),
      { preservesCache: false, reason: "route_unsupported" },
    ],
    [
      "codex",
      ref("p", "gpt-6-sol"),
      ref("p", "gpt-6-sol", "high"),
      { preservesCache: false, reason: "non_effort_variant" },
    ],
    [
      "codex",
      ref("p", "gpt-6-sol", "high"),
      ref("p", "gpt-6-sol", "pro"),
      { preservesCache: false, reason: "non_effort_variant" },
    ],
  ] as const)("%s %j → %j", (kind, current, target, expected) => {
    expect(Variant.only(current, target, kind)).toEqual(expected)
  })

  test("not a variant-only change: another model, provider, or the same Ref", () => {
    expect(Variant.only(ref("p", "a", "high"), ref("p", "b", "low"), "anth")).toBeNull()
    expect(Variant.only(ref("p", "a", "high"), ref("q", "a", "low"), "anth")).toBeNull()
    expect(Variant.only(ref("p", "a"), ref("p", "a", "default"), "anth")).toBeNull()
    expect(Variant.same(ref("p", "a"), ref("p", "a", "default"))).toBe(true)
  })
})

describe("hysteresis and breaker (02 §5.5)", () => {
  const hysteresis = Policy.defaults.hysteresis
  const minute = 60_000

  test("cooldown lasts 30 minutes AND 20 requests", () => {
    const start = Hysteresis.cooldown(hysteresis, NOW)
    expect(start).toEqual({ until: NOW + 30 * minute, requestsLeft: 20 })
    expect(Hysteresis.cooldownDone({ ...start, requestsLeft: 0 }, NOW + 29 * minute)).toBe(false)
    expect(Hysteresis.cooldownDone(start, NOW + 31 * minute)).toBe(false)
    expect(Hysteresis.cooldownDone({ ...start, requestsLeft: 0 }, NOW + 30 * minute)).toBe(true)
  })

  const breaker = (input: Partial<Parameters<typeof Hysteresis.breaker>[0]>) =>
    Hysteresis.breaker({ hysteresis, switches: [], manualAt: undefined, colds: [], P: 100 * K, now: NOW, ...input })

  test("two automatic switches within an hour trip it", () => {
    expect(breaker({ switches: [{ at: NOW - 50 * minute, from: "a", to: "b", auto: true }] })).toBeUndefined()
    expect(
      breaker({
        switches: [
          { at: NOW - 50 * minute, from: "a", to: "b", auto: true },
          { at: NOW - minute, from: "b", to: "c", auto: true },
        ],
      }),
    ).toBe("auto_per_hour")
    expect(
      breaker({
        switches: [
          { at: NOW - 70 * minute, from: "a", to: "b", auto: true },
          { at: NOW - minute, from: "b", to: "c", auto: false },
        ],
      }),
    ).toBeUndefined()
  })

  test("A→B→A within 10 minutes without the user trips it as a flap", () => {
    const flap = [
      { at: NOW - 8 * minute, from: "a", to: "b", auto: true },
      { at: NOW - minute, from: "b", to: "a", auto: true },
    ]
    const relaxed = { ...hysteresis, breakerAutoPerHour: 0 }
    expect(breaker({ hysteresis: relaxed, switches: flap })).toBe("flap")
    expect(breaker({ hysteresis: relaxed, switches: flap, manualAt: NOW - 5 * minute })).toBeUndefined()
    expect(breaker({ hysteresis: relaxed, switches: [{ ...flap[0], at: NOW - 20 * minute }, flap[1]] })).toBeUndefined()
  })

  test("cold tokens of the last 15 minutes above 3·P trip it", () => {
    const colds = [
      { at: NOW - 20 * minute, cold: 500 * K },
      { at: NOW - 5 * minute, cold: 150 * K },
      { at: NOW - minute, cold: 100 * K },
    ]
    expect(breaker({ colds })).toBeUndefined()
    expect(breaker({ colds: [...colds, { at: NOW, cold: 60 * K }] })).toBe("cold_sum")
  })
})

describe("target ranking (02 §5.7)", () => {
  const state: { cards?: Ratecard.File } = {}
  beforeAll(async () => {
    state.cards = await seedCards()
  })
  const cards = () => {
    if (!state.cards) throw new Error("cards not loaded")
    return state.cards
  }
  const target = (providerID: string, id: string) => Variant.ref({ providerID, id })

  test("same unit by score, warm return first, excluded last, headroom breaks ties", () => {
    const source = side(cards(), {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: "gpt-5.6-sol",
      cache: cache({ modelID: "gpt-5.6-sol" }),
    })
    const candidate = (providerID: string, extra: Partial<Targets.Candidate> = {}, warm = false) => ({
      side: side(cards(), {
        providerID,
        kind: "codex",
        modelID: "gpt-5.6-sol",
        ...(warm ? { cache: cache({ modelID: "gpt-5.6-sol", lastReqAt: NOW - 2 * 60_000, L: 140 * K }) } : {}),
      }),
      accountID: null,
      target: target(providerID, "gpt-5.6-sol"),
      headroom: 0.5,
      ...extra,
    })
    const ranked = Targets.rank({
      source,
      candidates: [
        candidate("own-codex-bbbb", { headroom: 0.2 }),
        candidate("own-codex-cccc", { excluded: "exhausted" }),
        candidate("own-codex-dddd", { headroom: 0.9 }),
        candidate("own-codex-eeee", {}, true),
      ],
      ctx: context(),
      thresholds: Policy.defaults.thresholds,
      chain: [],
      sourceAvailable: true,
    })
    expect(ranked.map((item): string => item.providerID)).toEqual([
      "own-codex-eeee",
      "own-codex-dddd",
      "own-codex-bbbb",
      "own-codex-cccc",
    ])
    expect(ranked[3].excludedReason).toBe("exhausted")
    expect(ranked[0].score).toBeLessThan(ranked[1].score ?? 0)
  })

  test("a fallback chain orders billing units; scores order within a unit", () => {
    const source = side(cards(), {
      providerID: "own-oai-aaaa",
      kind: "oai",
      modelID: "gpt-5.5",
      cache: cache({ modelID: "gpt-5.5" }),
      catalog: { input: 1.25, output: 10 },
    })
    const anth = {
      side: side(cards(), { providerID: "own-anth-bbbb", kind: "anth", modelID: "claude-opus-5-5", window: 1_000_000 }),
      accountID: null,
      target: target("own-anth-bbbb", "claude-opus-5-5"),
      headroom: null,
    }
    const codexCandidate = {
      side: side(cards(), { providerID: "own-codex-cccc", kind: "codex", modelID: "gpt-5.6-sol" }),
      accountID: null,
      target: target("own-codex-cccc", "gpt-5.6-sol"),
      headroom: null,
    }
    const ranked = Targets.rank({
      source,
      candidates: [anth, codexCandidate],
      ctx: context(),
      thresholds: Policy.defaults.thresholds,
      chain: ["own-codex-cccc", "own-anth-bbbb"],
      sourceAvailable: true,
    })
    expect(ranked.map((item): string => item.providerID)).toEqual(["own-codex-cccc", "own-anth-bbbb"])
  })

  test("headroom takes the tightest window and credits a reset within the hour", () => {
    expect(Targets.headroom([{ usedPercent: 40 }, { usedPercent: 90 }], NOW)).toBeCloseTo(0.1)
    expect(Targets.headroom([{ usedPercent: 100, resetAt: NOW + 30 * 60_000 }], NOW)).toBeCloseTo(0.5)
    expect(Targets.headroom([], NOW)).toBeNull()
  })
})

describe("policy rules (02 §5.10, §9.2 policy.set)", () => {
  const file = registry()
  const patch = Schema.decodeUnknownSync(Policy.Patch)

  test.each([
    [{ autoSwitch: { subscriptionToApi: "auto" } }, "autoSwitch.subscriptionToApi"],
    [{ autoSwitch: { subscriptionToSubscription: "auto" } }, "autoSwitch.subscriptionToSubscription"],
    [{ autoSwitch: { toClaudeSlot: "ask" } }, "autoSwitch.toClaudeSlot"],
    [{ fallbackChains: { default: [PROVIDERS.codexA, PROVIDERS.codexB] } }, "fallbackChains.default"],
    [{ fallbackChains: { work: [PROVIDERS.codexA, "anthropic"] } }, "fallbackChains.work"],
  ])("%j is denied (%s)", (value, field) => {
    expect(PolicyRules.denied(patch(value), file)).toBe(field)
  })

  test("allowed patches: ask/off, one subscription slot in a chain, API chains", () => {
    expect(
      PolicyRules.denied(patch({ autoSwitch: { subscriptionToApi: "off", apiToApi: "auto" } }), file),
    ).toBeUndefined()
    expect(
      PolicyRules.denied(
        patch({ fallbackChains: { default: [PROVIDERS.oaiA, PROVIDERS.oaiB, PROVIDERS.codexA] } }),
        file,
      ),
    ).toBeUndefined()
  })

  test("02 §8.8 (CAG-5): Claude-to-Claude switching is `off` unless the user sets it, and a stored `auto` stays", () => {
    expect(Policy.defaults.autoSwitch.claudeToClaude).toBe("off")
    expect(PolicyRules.apply(Policy.defaults, patch({})).autoSwitch.claudeToClaude).toBe("off")
    const on = PolicyRules.apply(Policy.defaults, patch({ autoSwitch: { claudeToClaude: "auto" } }))
    expect(on.autoSwitch.claudeToClaude).toBe("auto")
    // No migration: an existing policy.json that says `auto` keeps it through unrelated writes.
    expect(PolicyRules.apply(on, patch({ autoSwitch: { apiToApi: "ask" } })).autoSwitch.claudeToClaude).toBe("auto")
    const off = PolicyRules.apply(on, patch({ autoSwitch: { claudeToClaude: "off" } }))
    expect(off.autoSwitch.claudeToClaude).toBe("off")
    expect(PolicyRules.apply(off, patch({ autoSwitch: { apiToApi: "ask" } })).autoSwitch.claudeToClaude).toBe("off")
    const { claudeToClaude: _absent, ...older } = Policy.defaults.autoSwitch
    expect(PolicyRules.apply({ ...Policy.defaults, autoSwitch: older }, patch({})).autoSwitch.claudeToClaude).toBe(
      "off",
    )
    // API-key switching keeps its own default.
    expect(Policy.defaults.autoSwitch.apiToApi).toBe("auto")
    expect(PolicyRules.denied(patch({ autoSwitch: { claudeToClaude: "auto" } }), registry())).toBeUndefined()
    // Review finding 12 (2026-10-11): there is nothing to ask before a switch that happens before any output.
    expect(PolicyRules.denied(patch({ autoSwitch: { claudeToClaude: "ask" } }), registry())).toBe(
      "autoSwitch.claudeToClaude",
    )
  })

  test("sections merge one level deep and keep what the patch leaves out", () => {
    const next = PolicyRules.apply(
      Policy.defaults,
      patch({
        autoSwitch: { apiToApi: "ask" },
        hysteresis: { cooldownMinutes: 10 },
        thresholds: { unknownTtlIdleMinutes: 45, confirm: { dialogAtUSD: 1 } },
        fallbackChains: { default: [PROVIDERS.oaiA] },
        defaults: { byKind: { codex: Account.ID.make("acc_codexB") } },
      }),
    )
    expect(next.autoSwitch).toEqual({ ...Policy.defaults.autoSwitch, apiToApi: "ask" })
    expect(next.hysteresis).toEqual({ ...Policy.defaults.hysteresis, cooldownMinutes: 10 })
    expect(next.thresholds.unknownTtlIdleMinutes).toBe(45)
    expect(next.thresholds.confirm).toEqual({ ...Policy.defaults.thresholds.confirm, dialogAtUSD: 1 })
    expect(next.thresholds.anthropicWatermarkBlocks).toBe(15)
    expect(next.fallbackChains as unknown).toEqual({ default: [PROVIDERS.oaiA] })
    expect<unknown>(next.defaults).toEqual({ byKind: { codex: "acc_codexB" } })
    expect(next.horizonRequests).toBe(20)
  })

  test("a write drops what an older build stored and nothing reads (PG6, 07 §6.2 #9–#11, §2.2)", () => {
    // Decoded like the store does (`Preserve`): the retired keys survive decoding.
    const old = Option.getOrThrow(Preserve.decode(Policy.File)({
      ...Policy.defaults,
      thresholds: { ...Policy.defaults.thresholds, compactMinTokens: 40_000, newSessionAdviceTokens: 150_000 },
      defaults: { byKind: {}, global: null },
      laterField: 1,
    }))
    const next = PolicyRules.apply(old, patch({ hysteresis: { cooldownMinutes: 10 } }))
    expect(Object.keys(next.thresholds).toSorted()).toEqual(Object.keys(Policy.defaults.thresholds).toSorted())
    expect<unknown>(next.defaults).toEqual({ byKind: {} })
    expect<unknown>(next).toMatchObject({ laterField: 1 })
    const pruned = PolicyRules.prune(old)
    expect(pruned && Object.keys(pruned.thresholds).toSorted()).toEqual(
      Object.keys(Policy.defaults.thresholds).toSorted(),
    )
    expect<unknown>(pruned?.defaults).toEqual({ byKind: {} })
    expect(PolicyRules.prune(Policy.defaults)).toBeUndefined()
  })

  test("CAG-5: a stored automatic Claude-to-Claude switch turns off once; the user's later choice stands", () => {
    const stored: Policy.File = { ...Policy.defaults, autoSwitch: { ...Policy.defaults.autoSwitch, claudeToClaude: "auto" } }
    const migrated = PolicyRules.migrate(stored, 1_000)!
    expect(migrated.autoSwitch.claudeToClaude).toBe("off")
    expect(migrated.migrated).toEqual({ claudeToClaudeOff: { changed: true, at: 1_000 } })
    // Once only: the next start finds the marker.
    expect(PolicyRules.migrate(migrated, 2_000)).toBeUndefined()
    // The user turns it back on: it stays on through every later start.
    const chosen = PolicyRules.apply(migrated, patch({ autoSwitch: { claudeToClaude: "auto" } }))
    expect(chosen.autoSwitch.claudeToClaude).toBe("auto")
    expect(PolicyRules.migrate(chosen, 3_000)).toBeUndefined()
    // The app's one-time notice is marked shown, and an unrelated change keeps the marker.
    const noticed = PolicyRules.apply(chosen, patch({ noticed: "claudeToClaudeOff" }))
    expect(noticed.migrated?.claudeToClaudeOff).toEqual({ changed: true, at: 1_000, noticed: true })
    expect(PolicyRules.apply(noticed, patch({ horizonRequests: 30 })).migrated).toEqual(noticed.migrated)
    // A file without `auto` has nothing to change, and stays untouched.
    expect(PolicyRules.migrate(Policy.defaults, 1_000)).toBeUndefined()
    // A user who picks `auto` before any start ran the change keeps it: their choice is recorded first.
    const fresh = PolicyRules.apply(Policy.defaults, patch({ autoSwitch: { claudeToClaude: "auto" } }))
    expect(fresh.migrated).toEqual({ claudeToClaudeOff: { changed: false } })
    expect(PolicyRules.migrate(fresh, 1_000)).toBeUndefined()
    // Any other change keeps the stored mode as it is and records no choice.
    expect(PolicyRules.apply(stored, patch({ horizonRequests: 30 })).migrated).toBeUndefined()
  })
})

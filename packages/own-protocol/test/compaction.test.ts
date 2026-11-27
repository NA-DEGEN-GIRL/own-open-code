import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Cache, Compaction, Kind } from "../src/index.js"
import { roundTrip } from "./fixtures.js"

/** T_slot of a model of `kind` with only the kind constants (02 §4.7.3 table, "예: 원래 창 → 기준 T"). */
function slot(
  kind: Compaction.ChainInput["kind"],
  limit: Compaction.Limit,
  extra: Partial<Compaction.ChainInput> = {},
) {
  return Compaction.resolve(Compaction.chain({ kind, modelID: "m", ...extra }), limit, undefined, kind)
}

describe("kind defaults (02 §4.7.3)", () => {
  test("the table's examples", () => {
    // Core keeps 15% free since upstream v2.1 (10% before).
    expect(slot("codex", { context: 400_000, input: 272_000 })).toMatchObject({
      windowTokens: 272_000,
      triggerTokens: 231_200,
      source: "v2",
      effectiveInput: null,
    })
    expect(slot("anth", { context: 1_000_000 })).toMatchObject({ triggerTokens: 850_000, source: "v2" })
    expect(slot("claude-sub", { context: 1_000_000 })).toMatchObject({ triggerTokens: 850_000, source: "v2" })
    expect(slot("oai", { context: 922_000 })).toMatchObject({ triggerTokens: 783_700, source: "v2" })
    expect(slot("ds", { context: 1_000_000 })).toMatchObject({
      triggerTokens: 850_000,
      source: "v2",
      effectiveInput: null,
    })
    expect(slot("xai", { context: 500_000 })).toMatchObject({
      triggerTokens: 425_000,
      source: "v2",
      effectiveInput: null,
    })
    expect(slot("or", { context: 163_840 })).toMatchObject({
      triggerTokens: 139_264,
      source: "v2",
      effectiveInput: null,
    })
    // 07 §6.2 #2: compat keeps its whole window too; a server whose overflow core cannot classify gets a warning.
    // Core keeps at least 15% free since upstream v2.1; compat stays at 90% through a larger input at every window.
    expect(slot("compat", { context: 128_000 })).toMatchObject({
      triggerTokens: 115_200,
      ceilingTokens: 115_200,
      source: "v2",
      effectiveInput: 135_529,
    })
    expect(slot("compat", { context: 262_144 })).toMatchObject({
      triggerTokens: 235_929,
      source: "v2",
      effectiveInput: 277_563,
    })
    expect(Object.values(Compaction.defaults).every((setting) => setting === Compaction.V2)).toBe(true)
    expect(Compaction.defaults.siwc).toEqual(Compaction.V2)
    // The tunable kinds: own's slots and the Claude Agent route (CAG-50).
    expect(Object.keys(Compaction.ByKind.fields).sort()).toEqual([...Compaction.tunable].sort())
    expect(Compaction.tunable).toEqual([...Kind.own, "claude-agent"])
  })

  test("the registered window makes core's own formula land on T_slot", () => {
    const resolved = slot("ds", { context: 1_000_000 }, { account: { maxTriggerTokens: 256_000 } })
    expect(resolved?.effectiveInput).toBe(Compaction.windowFor(256_000))
    expect(Compaction.ceiling(resolved?.effectiveInput ?? 0)).toBe(256_000)
    for (const trigger of [
      1, 28_800, 28_801, 63_000, 64_000, 98_304, 99_999, 128_001, 144_000, 144_001, 256_000, 777_777,
    ])
      expect(Compaction.ceiling(Compaction.windowFor(trigger))).toBe(trigger)
    // The smallest such window: 16k above T where core keeps its fixed reserve, else T / 0.85.
    expect([28_800, 100_000, 144_000, 200_000].map(Compaction.windowFor)).toEqual([44_800, 117_646, 169_411, 235_293])
    expect(Compaction.windowFor(100_000) - 1).toSatisfy((window) => Compaction.ceiling(window) < 100_000)
  })

  test("T_floor keeps the threshold above the post-compaction context; small windows stay at v2", () => {
    // 60% of 100k = 60k is below K + 48k = 63k.
    expect(slot("ds", { context: 100_000 }, { account: { triggerPercent: 60 } })).toMatchObject({
      triggerTokens: 63_000,
      floorTokens: 63_000,
      clamped: "floor",
    })
    // 60k − 16k = 44k < 63k: the model cannot move (03 §5.8.4 "창이 작아 …").
    expect(slot("or", { context: 60_000 })).toMatchObject({ triggerTokens: 44_000, floorTokens: 44_000 })
    // A different keep moves the floor.
    expect(
      Compaction.resolve(
        Compaction.chain({ kind: "ds", modelID: "m", account: { triggerPercent: 60 } }),
        { context: 100_000 },
        5_000,
      ),
    ).toMatchObject({ triggerTokens: 60_000, floorTokens: 53_000 })
    expect(slot("ds", { context: 0 })).toBeUndefined()
  })

  test("compat compacts at 90% of its window, above core's 16k reserve below a 160k window (R8)", () => {
    // Core alone: a 32,768 local window at 16,768 (51%), 65,536 at 49,536.
    expect(Compaction.ceiling(32_768)).toBe(16_768)
    expect(Compaction.ceilingOf(32_768)).toBe(16_768)
    expect(Compaction.ceilingOf(32_768, "ds")).toBe(16_768)
    for (const [window, trigger] of [
      [32_768, 29_491],
      [49_152, 44_236],
      [65_536, 58_982],
      [131_072, 117_964],
    ] as const) {
      expect(Compaction.ceilingOf(window, "compat")).toBe(trigger)
      const resolved = slot("compat", { context: window })
      expect(resolved).toMatchObject({ windowTokens: window, triggerTokens: trigger, source: "v2", clamped: null })
      // The registered input lands core's own ceiling on the trigger; it is above the window, which stays the model's.
      expect(resolved?.effectiveInput).toBe(Compaction.windowFor(trigger))
      expect(Compaction.ceiling(resolved?.effectiveInput ?? 0)).toBe(trigger)
      expect(resolved?.effectiveInput).toBeGreaterThan(window)
    }
    // Core's ceiling is below 90% at every window since upstream v2.1 (15%, at least 16k): the input is registered.
    for (const window of [16_384, 31_999, 160_000, 262_144, 1_000_000])
      expect(Compaction.ceiling(slot("compat", { context: window })?.effectiveInput ?? 0)).toBe(
        Math.floor(window * 0.9),
      )
    // Earlier stays possible down to the same floor; nothing is later than 90%.
    expect(slot("compat", { context: 65_536 }, { account: { triggerPercent: 50 } })).toMatchObject({
      triggerTokens: 49_536,
      floorTokens: 49_536,
      clamped: "floor",
      effectiveInput: null,
    })
    expect(slot("compat", { context: 65_536 }, { account: { minReserveTokens: 16_000 } })).toMatchObject({
      triggerTokens: 49_536,
      source: "account",
      effectiveInput: null,
    })
    expect(slot("compat", { context: 65_536 }, { account: { maxTriggerTokens: 55_000 } })).toMatchObject({
      triggerTokens: 55_000,
      effectiveInput: Compaction.windowFor(55_000),
    })
    // Without the kind (an older caller) the ceiling is core's.
    expect(Compaction.resolve(Compaction.chain({ kind: "compat", modelID: "m" }), { context: 65_536 })).toMatchObject({
      triggerTokens: 49_536,
      effectiveInput: null,
    })
  })
})

describe("resolution order (02 §4.7.4)", () => {
  const policy = {
    ds: { triggerPercent: 50, models: { big: { maxTriggerTokens: 300_000 } } },
  }
  test("later layers win per field and name the source", () => {
    expect(slot("ds", { context: 1_000_000 }, { policy })).toMatchObject({ triggerTokens: 500_000, source: "kind" })
    expect(slot("ds", { context: 1_000_000 }, { policy, modelID: "big" })).toMatchObject({
      triggerTokens: 300_000,
      source: "kindModel",
    })
    const account = { maxTriggerTokens: 200_000, models: { big: { triggerPercent: 20 } } }
    expect(slot("ds", { context: 1_000_000 }, { policy, account })).toMatchObject({
      triggerTokens: 200_000,
      source: "account",
    })
    // Field by field: 20% of 1M from the account×model, the 200k cap from the account.
    expect(slot("ds", { context: 1_000_000 }, { policy, account, modelID: "big" })).toMatchObject({
      triggerTokens: 200_000,
      source: "accountModel",
    })
    // An account may go back to the v2 default explicitly; later is never later than v2.
    expect(slot("ds", { context: 1_000_000 }, { account: Compaction.V2 })).toMatchObject({
      triggerTokens: 850_000,
      source: "account",
      effectiveInput: null,
    })
    // claude-sub ignores policy and account settings.
    expect(slot("claude-sub", { context: 1_000_000 }, { account: { triggerPercent: 20 } })).toMatchObject({
      triggerTokens: 850_000,
      source: "v2",
    })
  })

  test("a session value only compacts earlier and is raised to the slot's floor", () => {
    const resolved = slot("codex", { context: 400_000, input: 272_000 })
    if (!resolved) throw new Error("unresolved")
    expect(Compaction.withSession(resolved, null)).toEqual({
      triggerTokens: 231_200,
      source: "v2",
      sessionTriggerTokens: null,
    })
    expect(Compaction.withSession(resolved, 200_000)).toEqual({
      triggerTokens: 200_000,
      source: "session",
      sessionTriggerTokens: 200_000,
    })
    expect(Compaction.withSession(resolved, 30_000)).toMatchObject({ triggerTokens: 63_000, source: "session" })
    // Kept from a larger slot: no later than this slot.
    expect(Compaction.withSession(resolved, 500_000)).toMatchObject({ triggerTokens: 231_200, source: "v2" })
  })
})

describe("validation (setting_out_of_range)", () => {
  const windows = new Map([
    ["big", 1_000_000],
    ["small", 128_000],
  ])
  test("reports the first field outside its range with bounds", () => {
    expect(Compaction.check({ triggerPercent: 95 }, windows, { prefix: "compaction." })).toEqual({
      field: "compaction.triggerPercent",
      min: 10,
      max: 90,
    })
    expect(Compaction.check({ maxTriggerTokens: 50_000 }, windows)).toEqual({
      field: "maxTriggerTokens",
      min: 63_000,
      max: null,
    })
    expect(Compaction.check({ minReserveTokens: 1_000_000 }, windows)).toEqual({
      field: "minReserveTokens",
      min: 0,
      max: 999_999,
    })
    // Top-level: the small model just stays at its floor; per model: its own window.
    expect(Compaction.check({ minReserveTokens: 128_000 }, windows)).toBeUndefined()
    expect(Compaction.check({ models: { small: { minReserveTokens: 128_000 } } }, windows)).toEqual({
      field: "models.small.minReserveTokens",
      min: 0,
      max: 127_999,
    })
    expect(Compaction.check({ models: { big: { minReserveTokens: 500_000 } } }, windows)).toBeUndefined()
    expect(Compaction.check({ models: { small: { triggerPercent: 5 } } }, windows)).toEqual({
      field: "models.small.triggerPercent",
      min: 10,
      max: 90,
    })
    expect(Compaction.check({ triggerPercent: 60, maxTriggerTokens: null, minReserveTokens: 32_000 }, windows)).toBe(
      undefined,
    )
  })

  test("the stored schema enforces ranges; the input schema lets the handler answer", () => {
    expect(() => Schema.decodeUnknownSync(Compaction.Setting)({ triggerPercent: 95 })).toThrow()
    expect(roundTrip(Compaction.SettingInput, { triggerPercent: 95 })).toEqual({ triggerPercent: 95 })
    expect(Compaction.normalize({ triggerPercent: 60, models: { m: { maxTriggerTokens: null } } })).toEqual({
      triggerPercent: 60,
      models: { m: { maxTriggerTokens: null } },
    })
  })
})

describe("cycle cost ⑫ (02 §6.3)", () => {
  const cycle = { Z: 12_000, delta: 3_000, summary: 8_000 }
  test("DeepSeek worst case: lowering T lowers the cost per request", () => {
    const rates = { read: 0.044, cold: 1.32, out: 2.64 }
    const v2 = Compaction.cycleCost({ triggerTokens: 900_000, cycle, rates, readAsCold: true })
    const kind = Compaction.cycleCost({ triggerTokens: 256_000, cycle, rates, readAsCold: true })
    expect(v2).not.toBeNull()
    expect(kind).not.toBeNull()
    expect((kind ?? 0) < (v2 ?? 0)).toBe(true)
    // 145.5k·1.32 + 3k·1.32 + (241k·1.32 + 8k·2.64)/73.7 per 1M ≈ $0.2006
    expect(kind).toBeCloseTo(0.2006, 3)
  })

  test("an unknown output rate is never computed as 0", () => {
    expect(Compaction.cycleCost({ triggerTokens: 256_000, cycle, rates: { read: 1, cold: 1, out: null } })).toBeNull()
  })

  test("truncation: the summary request sends about P − K", () => {
    expect(Compaction.truncates(230_000, 200_000)).toBe(true)
    expect(Compaction.truncates(210_000, 200_000)).toBe(false)
  })
})

describe("Compaction.shownPercent (03 §5.8.4)", () => {
  test("the model limit reads as the kind's ceiling: 85% under core's 15% reserve, 90% for compat", () => {
    expect(Compaction.shownPercent(undefined, "codex")).toBe(85)
    expect(Compaction.shownPercent(Compaction.PERCENT_MAX, "claude-sub")).toBe(85)
    expect(Compaction.shownPercent(undefined, "compat")).toBe(90)
    expect(Compaction.shownPercent(undefined)).toBe(85)
  })

  test("a set percentage shows as set, never past the ceiling", () => {
    expect(Compaction.shownPercent(60, "ds")).toBe(60)
    expect(Compaction.shownPercent(88, "anth")).toBe(85)
    expect(Compaction.shownPercent(88, "compat")).toBe(88)
  })
})

describe("the Claude Agent route (CAG-50, CAG-53)", () => {
  test("takes kind and account layers, unlike the fixed Claude slot", () => {
    const policy = { "claude-agent": { triggerPercent: 60 } }
    const account = { triggerPercent: 40 }
    const agent = Compaction.chain({ kind: "claude-agent", modelID: "opus", policy, account })
    expect(agent.map((layer) => layer.source)).toEqual(["v2", "kind", "kindModel", "account", "accountModel"])
    expect(Compaction.resolve(agent, { context: 1_000_000 }, 15_000, "claude-agent")?.triggerTokens).toBe(400_000)
    const slot = Compaction.chain({ kind: "claude-sub", modelID: "opus", policy, account })
    expect(slot.map((layer) => layer.source)).toEqual(["v2"])
  })

  test("its cache entries are per account, like the Claude slot's", () => {
    expect(Cache.keyAccount("claude-agent", "acc_ca")).toBe("acc_ca")
    expect(Cache.keyAccount("claude-agent", null)).toBeUndefined()
    expect(Cache.keyAccount("own-ds-d1", "acc_ds")).toBeUndefined()
  })
})

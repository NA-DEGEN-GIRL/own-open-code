// Auto-compaction settings model (03 §5.8.4): choices ↔ `Compaction.Setting`, previews with clamps, rate cards and
// the ⑫ cost comparison.
import { describe, expect, test } from "bun:test"
import { Compaction, type Ratecard } from "@own/protocol"
import {
  accountValue,
  costCompare,
  DEFAULT_CYCLE,
  KIND_CHOICES,
  kindChoiceOf,
  kindValue,
  layerChoiceOf,
  matchCard,
  modelValue,
  preview,
  ratesFor,
  withKind,
} from "./compaction-model"

const CARDS: Ratecard.Card[] = [
  {
    match: { kind: "codex", model: "gpt-5.5" },
    unit: "credits",
    in: 125,
    read: 12.5,
    write: null,
    out: 750,
    ttl: { warmLowerSec: 300, coldUpperSec: null },
  },
  {
    match: { kind: "oai", modelGte: "gpt-5.6" },
    unit: "USD",
    inFromCatalog: true,
    readMul: 0.1,
    writeMul: 1.25,
    ttl: { warmLowerSec: 1800, coldUpperSec: 1800 },
  },
  {
    match: { kind: "ds", model: "deepseek-v4-pro" },
    unit: "USD",
    in: 1.32,
    read: 0.044,
    write: null,
    out: 2.2,
    ttl: { warmLowerSec: 0, coldUpperSec: 259200 },
  },
  { match: { kind: "ds" }, unit: "USD", in: 9, ttl: { warmLowerSec: 0, coldUpperSec: null } },
]

describe("choices (5.8.4 shortcuts for Compaction.Setting)", () => {
  test("kind rows offer only the model limit and custom values (07 §6.2 #3)", () => {
    expect(KIND_CHOICES).toEqual(["v2", "custom"])
    expect(kindChoiceOf(undefined)).toBe("v2")
    expect(kindChoiceOf({})).toBe("v2")
    expect(kindChoiceOf(Compaction.V2)).toBe("v2")
    expect(kindChoiceOf({ triggerPercent: 70 })).toBe("custom")
    // A stored former compat constant is a user value now, not a kind default.
    expect(kindChoiceOf({ triggerPercent: 50, maxTriggerTokens: 128_000, minReserveTokens: 32_000 })).toBe("custom")
  })

  test("kind values: the model limit clears the layer for every kind; custom writes the fields", () => {
    expect(kindValue("v2", {})).toBeNull()
    expect(kindValue("custom", { triggerPercent: 50, maxTriggerTokens: undefined })).toEqual({
      triggerPercent: 50,
    })
  })

  test("account and model layers keep each other", () => {
    expect(layerChoiceOf(null)).toBe("inherit")
    expect(layerChoiceOf({ ...Compaction.V2 })).toBe("v2")
    const withModel = modelValue(null, "deepseek-v4-pro", "custom", { triggerPercent: 40 })
    expect(withModel).toEqual({ models: { "deepseek-v4-pro": { triggerPercent: 40 } } })
    const top = accountValue(Compaction.normalize(withModel!), "custom", { triggerPercent: 70 })
    expect(top).toEqual({ triggerPercent: 70, models: { "deepseek-v4-pro": { triggerPercent: 40 } } })
    expect(accountValue(Compaction.normalize(top!), "inherit", {})).toEqual({
      models: { "deepseek-v4-pro": { triggerPercent: 40 } },
    })
    expect(modelValue(Compaction.normalize(withModel!), "deepseek-v4-pro", "inherit", {})).toBeNull()
  })
})

describe("preview (5.8.4, 02 §4.7.3)", () => {
  test("DeepSeek uses the full 1M window with 15% compaction headroom (upstream v2.1)", () => {
    const result = preview({
      kind: "ds",
      modelID: "deepseek-v4-pro",
      windowTokens: 1_000_000,
      byKind: undefined,
      account: null,
      keep: 15_000,
    })
    expect(result?.resolved.triggerTokens).toBe(850_000)
    expect(result?.resolved.source).toBe("v2")
    expect(result?.fixed).toBe(false)
  })

  test("compat uses the model limit like every other kind (07 §6.2 #2), at 90% of its window (07 §6.1 R8)", () => {
    // Core keeps 15% free since upstream v2.1 (108,800 of 128k); a compat slot registers a
    // `limit.input` above its window to stay at 90% (Compaction.ceilingOf), and the preview shows that threshold.
    expect(
      preview({ kind: "compat", modelID: "m", windowTokens: 128_000, byKind: undefined, account: null, keep: 15_000 })
        ?.resolved,
    ).toMatchObject({ triggerTokens: 115_200, ceilingTokens: 115_200, source: "v2", effectiveInput: 135_529 })
    expect(
      preview({ kind: "xai", modelID: "m", windowTokens: 128_000, byKind: undefined, account: null, keep: 15_000 })
        ?.resolved,
    ).toMatchObject({ triggerTokens: 108_800, source: "v2", effectiveInput: null })
  })

  test("v2 default: 272k → 231.2k (15% kept free since upstream v2.1); a draft kind layer applies", () => {
    expect(
      preview({
        kind: "codex",
        modelID: "gpt-5.5",
        windowTokens: 272_000,
        byKind: undefined,
        account: null,
        keep: 15_000,
      })?.resolved.triggerTokens,
    ).toBe(231_200)
    const byKind = withKind(undefined, "codex", { triggerPercent: 50 })
    expect(
      preview({ kind: "codex", modelID: "gpt-5.5", windowTokens: 272_000, byKind, account: null, keep: 15_000 })
        ?.resolved,
    ).toMatchObject({
      triggerTokens: 136_000,
      source: "kind",
    })
  })

  test("below the floor the threshold is raised; tiny windows cannot move", () => {
    const raised = preview({
      kind: "codex",
      modelID: "gpt-5.5",
      windowTokens: 272_000,
      byKind: undefined,
      account: { triggerPercent: 10 },
      keep: 15_000,
    })
    expect(raised?.resolved).toMatchObject({ triggerTokens: 63_000, clamped: "floor" })
    const tiny = preview({
      kind: "compat",
      modelID: "m",
      windowTokens: 64_000,
      byKind: undefined,
      account: null,
      keep: 15_000,
    })
    expect(tiny?.fixed).toBe(true)
  })
})

describe("rate cards and ⑫ cost (5.8.4 cost line)", () => {
  test("the most specific card wins; catalog-priced cards give no rates", () => {
    expect(matchCard(CARDS, "ds", "deepseek-v4-pro")?.in).toBe(1.32)
    expect(matchCard(CARDS, "ds", "deepseek-chat")?.in).toBe(9)
    expect(ratesFor(CARDS, "oai", "gpt-5.6")).toBeUndefined()
    expect(ratesFor(CARDS, "ds", "deepseek-chat")).toBeUndefined()
    // `write: null` (not billed) falls back to the input rate, like the router.
    expect(ratesFor(CARDS, "codex", "gpt-5.5")).toEqual({ unit: "credits", read: 12.5, cold: 125, out: 750 })
  })

  test("a lower threshold costs less per request on a big window", () => {
    const rates = ratesFor(CARDS, "ds", "deepseek-v4-pro")!
    const result = costCompare({
      kind: "ds",
      windowTokens: 1_000_000,
      triggerTokens: 256_000,
      rates,
      cycle: DEFAULT_CYCLE,
      keep: 15_000,
    })
    expect(result.unit).toBe("USD")
    expect(result.v2).not.toBeNull()
    expect(result.chosen!).toBeLessThan(result.v2!)
  })
})

describe("the Claude slot's fixed threshold text", () => {
  test("names core's ceiling of a large window (100% − RESERVE_SHARE, 85% since upstream v2.1)", async () => {
    const { ko } = await import("@/i18n/ko")
    const { en } = await import("@/i18n/en")
    const percent = `${Math.round((1 - Compaction.RESERVE_SHARE) * 100)}%`
    expect(Compaction.ceiling(1_000_000) / 1_000_000).toBe(1 - Compaction.RESERVE_SHARE)
    for (const text of [
      ko["own.set.claudeFixed"],
      ko["own.acct.claudeCompaction"],
      en["own.set.claudeFixed"],
      en["own.acct.claudeCompaction"],
    ])
      expect(text).toContain(percent)
  })
})

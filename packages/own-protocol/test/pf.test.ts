// The protocol rules of the preset fixes of 2026-11-03 (decisions PF): a forced effort fitted to each model's levels
// (`Preset.forcedFit`, clamped to the nearest level the model has and said so), the forced level a call takes (an
// entry's own, else the preset's), the local-server rule for OpenAI-compatible accounts, and hidden models.
import { describe, expect, test } from "bun:test"
import { Policy } from "../src/policy"
import { Preset } from "../src/preset"

describe("Preset.forcedFit (07 §2.3 강도 고정)", () => {
  test("the same level when the model has it; else the next level up, else the highest, marked clamped", () => {
    expect(Preset.forcedFit("high", ["low", "medium", "high", "xhigh"])).toMatchObject({
      variant: "high",
      clamped: false,
    })
    // DeepSeek's low/high/max: medium runs at high, xhigh at max.
    expect(Preset.forcedFit("medium", ["low", "high", "max"])).toMatchObject({ variant: "high", clamped: true })
    expect(Preset.forcedFit("xhigh", ["low", "high", "max"])).toMatchObject({ variant: "max", clamped: true })
    // Above every level: the highest.
    expect(Preset.forcedFit("max", ["low", "medium", "high"])).toMatchObject({ variant: "high", clamped: true })
    // No levels (a compat or local model): sent without an effort, never "clamped".
    expect(Preset.forcedFit("high", [])).toMatchObject({ unplaced: true, clamped: false })
    // Codex's client-only values are never sent.
    expect(Preset.forcedFit("max", ["low", "high", "xhigh", "ultra"])).toMatchObject({ variant: "xhigh" })
  })

  test("an entry's own level wins over the preset's; an unknown stored value forces nothing", () => {
    expect(Preset.forcedFor({ forcedEffort: "low" }, { forcedEffort: "medium" })).toBe("medium")
    expect(Preset.forcedFor({ forcedEffort: "low" }, {})).toBe("low")
    expect(Preset.forcedFor({}, undefined)).toBeUndefined()
    expect(Preset.forcedFor({ forcedEffort: "turbo" })).toBeUndefined()
    expect(Preset.forcedEffortOf("xhigh")).toBe("xhigh")
  })
})

describe("Policy.hidden (07 §7.1 숨긴 모델)", () => {
  test("a model is hidden in its provider group only", () => {
    const policy = { hiddenModels: [{ group: "codex", model: "gpt-5.6-terra" }] }
    expect(Policy.hidden(policy, "codex", "gpt-5.6-terra")).toBe(true)
    expect(Policy.hidden(policy, "oai", "gpt-5.6-terra")).toBe(false)
    expect(Policy.hidden(policy, undefined, "gpt-5.6-terra")).toBe(false)
    expect(Policy.hidden(undefined, "codex", "gpt-5.6-terra")).toBe(false)
  })
})

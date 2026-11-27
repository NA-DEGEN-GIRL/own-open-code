import { describe, expect, test } from "bun:test"
import { Fallback } from "../../src/fallback.js"

const entries = [
  { providerID: "own-codex-a", id: "gpt-6-astra", enabled: true },
  { providerID: "own-codex-b", id: "gpt-6-astra", enabled: true },
  { providerID: "own-codex-c", id: "gpt-6-astra", enabled: false },
  { providerID: "own-codex-a", id: "gpt-6.1-sol", enabled: true },
  { providerID: "own-ds-a", id: "deepseek-v4-pro", enabled: true },
]

describe("Fallback.pick", () => {
  test("automatic: preferred model IDs on enabled accounts, the failing account skipped, at most LIMIT", () => {
    expect(Fallback.pick(entries, undefined, ["gpt-6-astra", "deepseek-v4-pro"], "own-codex-a")).toEqual([
      entries[1],
      entries[4],
    ])
    expect(Fallback.pick(entries, undefined, ["gpt-6-astra", "gpt-6.1-sol", "deepseek-v4-pro"])).toHaveLength(
      Fallback.LIMIT,
    )
  })

  test("the user's list keeps its order and drops models that are gone, disabled or failing", () => {
    const chosen = [
      { providerID: "own-ds-a", modelID: "deepseek-v4-pro" },
      { providerID: "own-codex-c", modelID: "gpt-6-astra" },
      { providerID: "own-gone", modelID: "gpt-6-astra" },
      { providerID: "own-codex-a", modelID: "gpt-6.1-sol" },
    ]
    expect(Fallback.pick(entries, chosen, ["gpt-6-astra"], "own-codex-a")).toEqual([entries[4]])
    expect(Fallback.pick(entries, [], ["gpt-6-astra"], "own-codex-a")).toEqual([])
  })
})

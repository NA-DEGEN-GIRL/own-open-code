// Model pool cards (07 §3.3 모델 묶음, D2): the facts frozen when an entry is added. The Codex rows come from the
// fixture list the backend tests use (made-up text); the catalog rows are the 2026-10-01 fixture. No real account.

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CodexModels } from "@own/protocol"
import { PresetCards } from "../../src/presets/cards.js"
import { ANTHROPIC, OLLAMA, OPENAI } from "./fixtures/catalog-2026-10-01.js"

const SNAPSHOT: CodexModels.Snapshot = {
  source: "backend",
  fetchedAt: 1,
  rows: CodexModels.ROWS,
  models:
    CodexModels.decode(await Bun.file(path.join(import.meta.dir, "../slots/fixture/codex-models.json")).json())
      ?.models ?? [],
}
const NOW = 1_790_000_000_000

const of = (id: string, list = OPENAI) => {
  const found = list.find((model) => model.id === id)
  if (!found) throw new Error(`fixture model ${id} missing`)
  return found
}

describe("PresetCards.of (07 §3.3 D2)", () => {
  test("a codex account's model: name, window (limit.input), levels, image input and Codex's description", () => {
    expect(PresetCards.of(of("gpt-6.1-sol"), "codex", SNAPSHOT, undefined, NOW)).toEqual({
      name: "GPT-6.1-SOL",
      window: 922_000,
      reasoning: true,
      image: true,
      summary: "Fixture row (07 Appendix A, the newer bundle).",
      at: NOW,
    })
    // A row without a description gives none.
    expect(PresetCards.of(of("gpt-6-astra"), "codex", SNAPSHOT, undefined, NOW).summary).toBeUndefined()
  })

  test("a siwc login never reads Codex metadata; other kinds neither", () => {
    expect(PresetCards.of(of("gpt-6.1-sol"), "siwc", SNAPSHOT, undefined, NOW).summary).toBeUndefined()
    expect(PresetCards.of(of("gpt-6.1-sol"), "oai", SNAPSHOT, undefined, NOW).summary).toBeUndefined()
    const claude = PresetCards.of(of("claude-opus-5-5", ANTHROPIC), "claude-sub", undefined, undefined, NOW)
    expect(claude).toMatchObject({ window: 922_000, reasoning: true })
    expect(claude.windowVerified).toBeUndefined()
  })

  test("the window falls back to limit.context; a model without levels has no reasoning", () => {
    const plain = { ...of("gpt-6-luna"), limit: { context: 400_000, output: 1 }, variants: [] }
    expect(PresetCards.of(plain, "codex", undefined, undefined, NOW)).toMatchObject({
      window: 400_000,
      reasoning: false,
    })
  })

  test("a local model: its running window once verified, else no window and windowVerified false", () => {
    expect(PresetCards.of(OLLAMA, undefined, undefined, { verified: true, runtime: 32_768 }, NOW)).toMatchObject({
      window: 32_768,
      windowVerified: true,
    })
    const unverified = PresetCards.of(OLLAMA, undefined, undefined, { verified: false, runtime: 8_192 }, NOW)
    expect(unverified.windowVerified).toBe(false)
    expect(unverified.window).toBeUndefined()
    expect(PresetCards.of(OLLAMA, undefined, undefined, undefined, NOW).windowVerified).toBe(false)
  })
})

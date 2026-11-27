// The protocol rule of the subagent role guide (decisions PE 2026-11-08, 07 §2.4): which roles the main is told it can
// delegate to, the same rule `renderGuidance` writes its role cards and model pool header by.
import { describe, expect, test } from "bun:test"
import { Preset } from "../src/preset"

const CAPS = Preset.caps({ caps: Preset.CAPS, delegation: "when-useful", ultraCaps: null }, false)
const OPUS: Preset.Card = { relation: "stronger", runs: "subscription", company: "anthropic" }

describe("Preset.namedRoles (07 §2.4)", () => {
  test("explore and general always; an own role only when the guidance names it", () => {
    expect(Preset.namedRoles({ delegation: "model", ultra: false, cards: {} })).toEqual(["explore", "general"])
    const cards = { "own-review": OPUS }
    expect(Preset.namedRoles({ delegation: "when-useful", ultra: false, cards })).toEqual([
      "explore",
      "general",
      "own-review",
    ])
    // The same rule as the role cards the guidance writes.
    const text = Preset.renderGuidance({ delegation: "when-useful", ultra: false, caps: CAPS, cards })?.text ?? ""
    expect(text).toContain("- own-review:")
    expect(text).not.toContain("- own-quick:")
  })

  test("a model pool names every role; delegation off names none unless ultra delegates", () => {
    const pool = { entries: [], relation: {}, defaults: {} }
    expect(Preset.namedRoles({ delegation: "model", ultra: false, cards: {}, pool })).toEqual([...Preset.ROLES])
    expect(Preset.namedRoles({ delegation: "off", ultra: false, cards: {}, pool })).toEqual([])
    expect(Preset.namedRoles({ delegation: "off", ultra: true, cards: {} })).toEqual(["explore", "general"])
  })
})

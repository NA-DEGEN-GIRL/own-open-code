// Timeline detail presets (03 §19.14): the three choices map to session-ui presets, `보통` is the transcript's
// existing default, and the stored value survives reloads and bad input.
import { describe, expect, test } from "bun:test"
import { timelineView } from "./detail"
import { DEFAULT_TIMELINE_PRESET, parsePreset, TIMELINE_PRESETS } from "./state"

describe("timeline detail presets", () => {
  test("간단 / 보통 / 자세히 are quiet / compact / detailed; compact is the default", () => {
    expect(TIMELINE_PRESETS).toEqual(["quiet", "compact", "detailed"])
    expect(DEFAULT_TIMELINE_PRESET).toBe("compact")
    expect(parsePreset("detailed")).toBe("detailed")
    expect(parsePreset("everything")).toBe("compact")
    expect(parsePreset(null)).toBe("compact")
  })

  test("each preset opens tool cards further than the one before", () => {
    const quiet = timelineView("quiet")
    const compact = timelineView("compact")
    const detailed = timelineView("detailed")
    expect(quiet.detail.tools.placement).toBe("hidden")
    expect(quiet.reasoningMode).toBe("hidden")
    expect(compact.detail.tools.placement).toBe("grouped")
    expect(compact.shellToolDefaultOpen).toBe(false)
    expect(compact.reasoningMode).toBe("compact")
    expect(detailed.detail.shell.placement).toBe("separate")
    expect(detailed.shellToolDefaultOpen).toBe(true)
    expect(detailed.editToolDefaultOpen).toBe(true)
    expect(new Set([quiet, compact, detailed].map((view) => view.presentationKey)).size).toBe(3)
  })
})

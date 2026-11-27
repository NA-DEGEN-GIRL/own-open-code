import { describe, expect, test } from "bun:test"
import { Clock } from "../../../src/codex/clock.js"

describe("Clock", () => {
  test("sleep completes, or ends early when input arrives", async () => {
    const activity = new Clock.Activity()
    expect(await Clock.sleep(activity, "s", 20)).toMatch(/^Wall time: \d+\.\d{4} seconds\nSleep completed\.$/)
    const pending = Clock.sleep(activity, "s", 60_000)
    setTimeout(() => activity.notify("s"), 20)
    expect(await pending).toMatch(/\nSleep interrupted by new input\.$/)
    expect(await Clock.sleep(activity, "s", 0)).toBe("duration_ms must be between 1 and 43200000")
  })

  // Codex 0.164.0 (#55644): input already pending when the sleep starts interrupts it at once.
  test("input already pending when the sleep starts ends it at once", async () => {
    const activity = new Clock.Activity()
    const started = performance.now()
    expect(await Clock.sleep(activity, "s", 60_000, true)).toMatch(
      /^Wall time: \d+\.\d{4} seconds\nSleep interrupted by new input\.$/,
    )
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(await Clock.sleep(activity, "s", 0, true)).toBe("duration_ms must be between 1 and 43200000")
  })

  test("curr_time answers Codex's reminder", () => {
    expect(Clock.currentTime(new Date(Date.UTC(2026, 9, 11, 3, 4, 5)))).toBe(
      "<current_time_reminder>It is 2026-10-11 03:04:05 UTC.</current_time_reminder>",
    )
  })
})

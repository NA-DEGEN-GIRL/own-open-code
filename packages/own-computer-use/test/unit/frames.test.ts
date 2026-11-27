import { describe, expect, test } from "bun:test"
import { Frames } from "../../src/core/frames.js"
import type { Geometry } from "../../src/core/geometry.js"

const frame = (captureId: string, layoutHash = "layout-a"): Geometry.Frame => ({
  captureId,
  displayId: 0,
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  image: { width: 1429, height: 804 },
  tier: "standard",
  layoutHash,
  at: 0,
})

describe("frame store", () => {
  test("capture ids are unique and carry a per-process prefix", () => {
    const store = Frames.make("p1")
    expect(Frames.nextId(store)).toBe("cap_p11")
    expect(Frames.nextId(store)).toBe("cap_p12")
    const other = Frames.make()
    expect(other.prefix).toMatch(/^[0-9a-f]{6}$/)
    expect(Frames.make().prefix).not.toBe(other.prefix)
  })

  test("the latest frame is the default; older ones resolve by captureId", () => {
    const store = Frames.make("p")
    Frames.remember(store, "ses_a", frame("cap_1"))
    Frames.remember(store, "ses_a", frame("cap_2"))
    Frames.remember(store, "ses_b", frame("cap_3"))
    expect(Frames.lookup(store, "ses_a", { layoutHash: "layout-a" })).toEqual({ _tag: "Found", frame: frame("cap_2") })
    expect(Frames.lookup(store, "ses_a", { captureId: "cap_1", layoutHash: "layout-a" })).toEqual({
      _tag: "Found",
      frame: frame("cap_1"),
    })
    // Sessions never see each other's frames.
    expect(Frames.lookup(store, "ses_a", { captureId: "cap_3", layoutHash: "layout-a" })).toEqual({
      _tag: "Unknown",
      captureId: "cap_3",
    })
    expect(Frames.lookup(store, "ses_c", { layoutHash: "layout-a" })).toEqual({ _tag: "Missing" })
    expect(Frames.latest(store, "ses_b")?.captureId).toBe("cap_3")
  })

  test("frames of another display layout are stale", () => {
    const store = Frames.make("p")
    Frames.remember(store, "ses_a", frame("cap_1", "layout-a"))
    expect(Frames.lookup(store, "ses_a", { layoutHash: "layout-b" })).toEqual({
      _tag: "Stale",
      frame: frame("cap_1", "layout-a"),
    })
  })

  test("only the newest frames per session are kept", () => {
    const store = Frames.make("p")
    Array.from({ length: Frames.CAPACITY + 2 }, (_, index) => Frames.remember(store, "ses_a", frame(`cap_${index}`)))
    expect(Frames.lookup(store, "ses_a", { captureId: "cap_1", layoutHash: "layout-a" })._tag).toBe("Unknown")
    expect(Frames.lookup(store, "ses_a", { captureId: "cap_2", layoutHash: "layout-a" })._tag).toBe("Found")
    expect(store.sessions.get("ses_a")).toHaveLength(Frames.CAPACITY)
    // Re-remembering a frame moves it to the front instead of duplicating it.
    Frames.remember(store, "ses_a", frame("cap_5"))
    expect(store.sessions.get("ses_a")).toHaveLength(Frames.CAPACITY)
    expect(Frames.latest(store, "ses_a")?.captureId).toBe("cap_5")
    Frames.forget(store, "ses_a")
    expect(Frames.lookup(store, "ses_a", { layoutHash: "layout-a" })).toEqual({ _tag: "Missing" })
  })
})

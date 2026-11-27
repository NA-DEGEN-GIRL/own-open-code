// Settings shell layout (03 §5.7): the list beside the page on a wide main column, the list → page drill-down on a
// narrow one, and the roving keys of the section list and the 프리셋 group tabs.
import { describe, expect, test } from "bun:test"
import { navTarget, SETTINGS_SPLIT_MIN, settingsLayout } from "./layout"

describe("layout mode", () => {
  test("a main column of 640 px or more shows the list beside the page", () => {
    expect(settingsLayout(SETTINGS_SPLIT_MIN)).toBe("split")
    // The 1724 px window of the report: sidebar 272 + panel 420 leave 1032 px.
    expect(settingsLayout(1032)).toBe("split")
    expect(settingsLayout(768)).toBe("split")
  })

  test("a narrower main column (a phone, or a squeezed desktop column) drills down", () => {
    expect(settingsLayout(SETTINGS_SPLIT_MIN - 1)).toBe("stacked")
    expect(settingsLayout(375)).toBe("stacked")
    expect(settingsLayout(1)).toBe("stacked")
  })

  test("an unmeasured column keeps the split view", () => {
    expect(settingsLayout(0)).toBe("split")
  })
})

describe("roving keys", () => {
  test("the section list moves with the vertical arrows and wraps", () => {
    expect(navTarget("ArrowDown", 0, 5)).toBe(1)
    expect(navTarget("ArrowDown", 4, 5)).toBe(0)
    expect(navTarget("ArrowUp", 0, 5)).toBe(4)
    expect(navTarget("ArrowUp", 3, 5)).toBe(2)
    expect(navTarget("ArrowRight", 0, 5)).toBeUndefined()
  })

  test("Home and End jump to the ends; focus outside the list starts from the edges", () => {
    expect(navTarget("Home", 3, 5)).toBe(0)
    expect(navTarget("End", 1, 5)).toBe(4)
    expect(navTarget("ArrowDown", -1, 5)).toBe(0)
    expect(navTarget("ArrowUp", -1, 5)).toBe(4)
  })

  test("tabs move with the horizontal arrows", () => {
    expect(navTarget("ArrowRight", 0, 3, "horizontal")).toBe(1)
    expect(navTarget("ArrowLeft", 0, 3, "horizontal")).toBe(2)
    expect(navTarget("ArrowDown", 0, 3, "horizontal")).toBeUndefined()
  })

  test("other keys and empty lists move nothing", () => {
    expect(navTarget("Enter", 1, 5)).toBeUndefined()
    expect(navTarget("Tab", 1, 5)).toBeUndefined()
    expect(navTarget("ArrowDown", 0, 0)).toBeUndefined()
  })
})

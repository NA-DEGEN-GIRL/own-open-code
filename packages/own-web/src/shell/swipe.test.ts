// The swipe recogniser's numbers (./swipe.ts): the axis lock, the finish rule and the release speed. The gestures
// themselves run in the phone suite (e2e/mobile/swipe.spec.ts) with real touch input.
import { describe, expect, test } from "bun:test"
import { axisOf, finishes, SLOP, velocityOf } from "./swipe"

describe("axisOf", () => {
  test("nothing is decided inside the first 10 px", () => {
    expect(SLOP).toBe(10)
    expect(axisOf(9, 0)).toBeUndefined()
    expect(axisOf(-6, 7)).toBeUndefined()
  })
  test("then the larger move wins, either sign", () => {
    expect(axisOf(10, 3)).toBe("x")
    expect(axisOf(-12, 4)).toBe("x")
    expect(axisOf(4, 11)).toBe("y")
    expect(axisOf(3, -10)).toBe("y")
  })
  test("a diagonal is a scroll: sideways must be strictly larger", () => {
    expect(axisOf(10, 10)).toBe("y")
  })
})

describe("finishes", () => {
  test("40 % of the way finishes at any speed", () => {
    expect(finishes(160, 0, 400)).toBe(true)
    expect(finishes(159, 0, 400)).toBe(false)
  })
  test("a flick finishes short of it once it went 24 px", () => {
    expect(finishes(30, 0.5, 400)).toBe(true)
    expect(finishes(23, 2, 400)).toBe(false)
  })
  test("a slow short drag springs back", () => {
    expect(finishes(100, 0.2, 400)).toBe(false)
  })
})

describe("velocityOf", () => {
  test("the speed over the last 100 ms", () => {
    const samples = [
      { t: 0, at: 0 },
      { t: 50, at: 10 },
      { t: 150, at: 40 },
      { t: 200, at: 80 },
    ]
    // From t=150 (the first within 100 ms of t=200): 40 px in 50 ms.
    expect(velocityOf(samples)).toBeCloseTo(0.8)
  })
  test("a hold before letting go reads as still", () => {
    expect(
      velocityOf([
        { t: 0, at: 0 },
        { t: 300, at: 120 },
      ]),
    ).toBe(0)
  })
  test("no samples, or one, read as still", () => {
    expect(velocityOf([])).toBe(0)
    expect(velocityOf([{ t: 5, at: 3 }])).toBe(0)
  })
})

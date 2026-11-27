import { describe, expect, test } from "bun:test"
import { Geometry } from "../../src/core/geometry.js"
import { FakeDriver } from "../../src/driver/fake.js"

const frameOf = (display: Geometry.Display, tier: Geometry.Tier, hash = "h"): Geometry.Frame => {
  const size = Geometry.fitImage(display.bounds.width, display.bounds.height, Geometry.TIERS[tier])
  return {
    captureId: "cap_1",
    displayId: display.id,
    physical: display.bounds,
    image: { width: size.width, height: size.height },
    tier,
    layoutHash: hash,
    at: 0,
  }
}

const allDisplays = [...FakeDriver.DISPLAYS.single, ...FakeDriver.DISPLAYS.dual, ...FakeDriver.DISPLAYS.mixed]

describe("fitImage", () => {
  const sizes = [
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
    [3000, 2000],
    [5120, 1440],
    [1080, 1920],
    [1366, 768],
    [800, 600],
  ] as const

  test.each(sizes)("%dx%d stays inside both tiers with the source aspect ratio", (width, height) => {
    for (const tier of ["standard", "high"] as const) {
      const limits = Geometry.TIERS[tier]
      const fit = Geometry.fitImage(width, height, limits)
      expect(Number.isInteger(fit.width) && Number.isInteger(fit.height)).toBe(true)
      expect(Math.max(fit.width, fit.height)).toBeLessThanOrEqual(limits.maxLongEdge)
      expect(fit.width * fit.height).toBeLessThanOrEqual(limits.maxPixels)
      expect(fit.width).toBeLessThanOrEqual(width)
      expect(fit.height).toBeLessThanOrEqual(height)
      // Within one pixel of the exact aspect ratio on either side.
      expect(Math.abs(fit.width - (fit.height * width) / height)).toBeLessThanOrEqual(1 + width / height)
      expect(Math.abs(fit.height - (fit.width * height) / width)).toBeLessThanOrEqual(1 + height / width)
      expect(Math.abs(fit.width - width * fit.scale)).toBeLessThan(1)
      expect(Math.abs(fit.height - height * fit.scale)).toBeLessThan(1)
    }
  })

  test("exact sizes for common displays", () => {
    expect(Geometry.fitImage(1920, 1080, Geometry.TIERS.standard)).toMatchObject({ width: 1429, height: 804 })
    expect(Geometry.fitImage(5120, 1440, Geometry.TIERS.standard)).toMatchObject({ width: 1568, height: 441 })
    expect(Geometry.fitImage(1920, 1080, Geometry.TIERS.high)).toMatchObject({ width: 1920, height: 1080, scale: 1 })
    expect(Geometry.fitImage(3840, 2160, Geometry.TIERS.high)).toMatchObject({ width: 2000, height: 1125 })
    expect(Geometry.fitImage(800, 600, Geometry.TIERS.standard)).toMatchObject({ width: 800, height: 600, scale: 1 })
  })
})

describe("image ↔ physical mapping", () => {
  test.each(allDisplays.map((display) => [display.id, display.bounds.x, display.bounds.y, display] as const))(
    "display %d at (%d, %d): image → physical → image is exact and stays on the display",
    (_id, _x, _y, display) => {
      for (const tier of ["standard", "high"] as const) {
        const frame = frameOf(display, tier)
        const xs = [0, 1, 2, Math.floor(frame.image.width / 2), frame.image.width - 2, frame.image.width - 1]
        const ys = [0, 1, Math.floor(frame.image.height / 3), frame.image.height - 1]
        for (const x of xs)
          for (const y of ys) {
            const physical = Geometry.toPhysical(frame, { x, y })!
            expect(Geometry.contains(display.bounds, physical)).toBe(true)
            expect(Geometry.toImage(frame, physical)).toEqual({ x, y })
          }
      }
    },
  )

  test("physical → image → physical is off by at most one image pixel's span", () => {
    for (const display of allDisplays) {
      const frame = frameOf(display, "standard")
      const span = Math.ceil(display.bounds.width / frame.image.width)
      const step = Math.max(1, Math.floor(display.bounds.width / 97))
      for (let offset = 0; offset < display.bounds.width; offset += step) {
        const point = {
          x: display.bounds.x + offset,
          y: display.bounds.y + (Math.floor(offset / 3) % display.bounds.height),
        }
        const back = Geometry.toPhysical(frame, Geometry.toImage(frame, point)!)!
        expect(Math.abs(back.x - point.x)).toBeLessThanOrEqual(span)
        expect(Math.abs(back.y - point.y)).toBeLessThanOrEqual(span)
      }
    }
  })

  test("a secondary monitor with a negative origin maps into negative physical coordinates", () => {
    const left = FakeDriver.DISPLAYS.dual[1]
    const frame = frameOf(left, "standard")
    expect(frame.image).toEqual({ width: 1429, height: 804 })
    expect(Geometry.toPhysical(frame, { x: 0, y: 0 })).toEqual({ x: -1920, y: 180 })
    expect(Geometry.toPhysical(frame, { x: 1428, y: 803 })).toEqual({ x: -1, y: 1259 })
    expect(Geometry.toImage(frame, { x: -1920, y: 180 })).toEqual({ x: 0, y: 0 })
    expect(Geometry.toImage(frame, { x: 0, y: 500 })).toBeUndefined()
    const above = frameOf(FakeDriver.DISPLAYS.mixed[2], "standard")
    expect(Geometry.toPhysical(above, { x: 0, y: 0 })).toEqual({ x: 421, y: -1999 })
  })

  test("points outside the image are refused instead of clamped onto a neighbour", () => {
    const frame = frameOf(FakeDriver.DISPLAYS.single[0], "standard")
    expect(Geometry.toPhysical(frame, { x: -1, y: 0 })).toBeUndefined()
    expect(Geometry.toPhysical(frame, { x: 0, y: -1 })).toBeUndefined()
    expect(Geometry.toPhysical(frame, { x: frame.image.width, y: 0 })).toBeUndefined()
    expect(Geometry.toPhysical(frame, { x: 0, y: frame.image.height })).toBeUndefined()
  })

  test("the far edge clamps into the captured rectangle", () => {
    // An odd frame where rounding would land one pixel past the capture.
    const frame: Geometry.Frame = {
      captureId: "cap_1",
      displayId: 0,
      physical: { x: 0, y: 0, width: 10, height: 10 },
      image: { width: 3, height: 3 },
      tier: "standard",
      layoutHash: "h",
      at: 0,
    }
    expect(Geometry.toPhysical(frame, { x: 2, y: 2 })).toEqual({ x: 8, y: 8 })
    for (let x = 0; x < 3; x++) expect(Geometry.toPhysical(frame, { x, y: 0 })!.x).toBeLessThanOrEqual(9)
  })

  test("regions map to covering physical rectangles", () => {
    const display = FakeDriver.DISPLAYS.dual[0]
    const frame = frameOf(display, "standard")
    expect(Geometry.regionToPhysical(frame, [0, 0, frame.image.width, frame.image.height])).toEqual(display.bounds)
    const region = Geometry.regionToPhysical(frame, [100, 50, 200, 150])!
    expect(Geometry.contains(region, Geometry.toPhysical(frame, { x: 100, y: 50 })!)).toBe(true)
    expect(Geometry.contains(region, Geometry.toPhysical(frame, { x: 199, y: 149 })!)).toBe(true)
    expect(Geometry.regionToPhysical(frame, [10, 10, 10, 20])).toBeUndefined()
    expect(Geometry.regionToPhysical(frame, [20, 10, 10, 20])).toBeUndefined()
    expect(Geometry.regionToPhysical(frame, [0, 0, frame.image.width + 1, 10])).toBeUndefined()
    expect(Geometry.regionToPhysical(frame, [-1, 0, 10, 10])).toBeUndefined()
  })
})

describe("layout", () => {
  test("the virtual desktop spans negative origins", () => {
    expect(Geometry.layout(FakeDriver.DISPLAYS.dual).virtual).toEqual({ x: -1920, y: 0, width: 4480, height: 1440 })
    expect(Geometry.layout(FakeDriver.DISPLAYS.mixed).virtual).toEqual({ x: 0, y: -2000, width: 4920, height: 4160 })
    expect(Geometry.primary(Geometry.layout(FakeDriver.DISPLAYS.dual))?.id).toBe(0)
    expect(Geometry.displayAt(Geometry.layout(FakeDriver.DISPLAYS.dual), { x: -5, y: 500 })?.id).toBe(1)
    expect(Geometry.displayAt(Geometry.layout(FakeDriver.DISPLAYS.dual), { x: -5, y: 100 })).toBeUndefined()
  })

  test("the layout hash ignores report order and changes with any monitor change", () => {
    const dual = FakeDriver.DISPLAYS.dual
    const hash = Geometry.layoutHash(dual)
    expect(Geometry.layoutHash([dual[1], dual[0]])).toBe(hash)
    expect(Geometry.layout([dual[1], dual[0]]).hash).toBe(hash)
    expect(Geometry.layoutHash([{ ...dual[0], scale: 1.5 }, dual[1]])).not.toBe(hash)
    expect(Geometry.layoutHash([dual[0], { ...dual[1], bounds: { ...dual[1].bounds, y: 0 } }])).not.toBe(hash)
    expect(Geometry.layoutHash([dual[0]])).not.toBe(hash)
    expect(
      Geometry.layoutHash([
        { ...dual[0], primary: false },
        { ...dual[1], primary: true },
      ]),
    ).not.toBe(hash)
  })
})

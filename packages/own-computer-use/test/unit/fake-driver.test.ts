import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { DriverError } from "../../src/core/errors.js"
import { FakeDriver } from "../../src/driver/fake.js"

const scenario: FakeDriver.Scenario = {
  displays: FakeDriver.DISPLAYS.dual,
  windows: [
    { id: "0x1", exe: "chrome.exe", title: "Docs", bounds: { x: 100, y: 100, width: 800, height: 600 } },
    { id: "0x2", exe: "notepad.exe", bounds: { x: 0, y: 0, width: 1200, height: 900 }, focus: { isPassword: true } },
    { id: "0x3", exe: "hidden.exe", bounds: { x: 0, y: 0, width: 2560, height: 1440 }, minimized: true },
    { id: "0x4", exe: "explorer.exe", bounds: { x: -1920, y: 180, width: 1920, height: 1080 }, elevated: true },
  ],
  foreground: "0x1",
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("FakeDriver", () => {
  test("hit-testing follows z-order and skips minimized windows", async () => {
    const result = await run(
      Effect.gen(function* () {
        const driver = yield* FakeDriver.make(scenario)
        return {
          top: yield* driver.windowAt({ x: 150, y: 150 }),
          below: yield* driver.windowAt({ x: 1000, y: 800 }),
          none: yield* driver.windowAt({ x: 2000, y: 1300 }),
          left: yield* driver.windowAt({ x: -10, y: 500 }),
          list: yield* driver.windows,
        }
      }),
    )
    expect(result.top).toMatchObject({ id: "0x1", exe: "chrome.exe", title: "Docs", displayId: 0, elevated: false })
    expect(result.below?.id).toBe("0x2")
    expect(result.none).toBeUndefined()
    expect(result.left).toMatchObject({ id: "0x4", displayId: 1, elevated: true })
    expect(result.list.map((item) => item.id)).toEqual(["0x1", "0x2", "0x3", "0x4"])
  })

  test("focusing raises the window and changes the focused element", async () => {
    const result = await run(
      Effect.gen(function* () {
        const driver = yield* FakeDriver.make(scenario)
        const before = yield* driver.focused
        yield* driver.focus("0x2")
        return {
          before,
          after: yield* driver.focused,
          foreground: yield* driver.foreground,
          top: yield* driver.windowAt({ x: 150, y: 150 }),
          missing: yield* Effect.flip(driver.focus("0x99")),
        }
      }),
    )
    expect(result.before).toEqual({ pid: 1000, isPassword: false })
    expect(result.after).toEqual({ pid: 1001, isPassword: true })
    expect(result.foreground?.id).toBe("0x2")
    expect(result.top?.id).toBe("0x2")
    expect(result.missing.reason).toBe("unknown_window")
  })

  test("failures are injected after a number of successful calls", async () => {
    const result = await run(
      Effect.gen(function* () {
        const driver = yield* FakeDriver.make(scenario)
        driver.failNext("move", new DriverError("timeout", "slow"), { skip: 1, times: 2 })
        const first = yield* Effect.exit(driver.move({ x: 1, y: 1 }))
        const second = yield* Effect.exit(driver.move({ x: 2, y: 2 }))
        const third = yield* Effect.exit(driver.move({ x: 3, y: 3 }))
        const fourth = yield* Effect.exit(driver.move({ x: 4, y: 4 }))
        return { tags: [first._tag, second._tag, third._tag, fourth._tag], pointer: driver.pointer() }
      }),
    )
    expect(result.tags).toEqual(["Success", "Failure", "Failure", "Success"])
    expect(result.pointer).toEqual({ x: 4, y: 4 })
  })

  test("delays run on the Effect clock", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* FakeDriver.make(scenario)
        driver.delay("cursor", "5 seconds")
        const fiber = yield* Effect.forkChild(driver.cursor)
        yield* TestClock.adjust("4 seconds")
        const pending = fiber.pollUnsafe()
        yield* TestClock.adjust("1 second")
        return { pending, cursor: yield* Fiber.join(fiber) }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result.pending).toBeUndefined()
    expect(result.cursor).toEqual({ x: 1280, y: 720 })
  })

  test("display changes and close are published as events; a closed driver is unavailable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const driver = yield* FakeDriver.make(scenario)
        const events = yield* driver.events.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        yield* driver.setDisplays(FakeDriver.DISPLAYS.single)
        yield* driver.emit({ _tag: "kill_chord" })
        yield* driver.key({ vk: 0x10 }, "down")
        yield* driver.close
        return {
          events: [...(yield* Fiber.join(events))],
          displays: (yield* Effect.flip(driver.displays)).reason,
          ops: driver.ops(),
        }
      }),
    )
    expect(result.events).toEqual([{ _tag: "display_changed" }, { _tag: "kill_chord" }, { _tag: "exited", code: 0 }])
    expect(result.displays).toBe("unavailable")
    expect(result.ops.at(-1)).toEqual({ op: "release_all", keys: [0x10], buttons: [] })
  })

  test("captures validate the display and region", async () => {
    const result = await run(
      Effect.gen(function* () {
        const driver = yield* FakeDriver.make(scenario)
        const base = { width: 10, height: 10, format: "png" as const }
        return {
          missing: (yield* Effect.flip(driver.capture({ ...base, display: 5 }))).detail,
          outside: (yield* Effect.flip(
            driver.capture({ ...base, display: 1, region: { x: 0, y: 0, width: 10, height: 10 } }),
          )).detail,
          jpeg: yield* driver.capture({ ...base, display: 0, format: "jpeg", quality: 60 }),
          sized: yield* (yield* FakeDriver.make({ ...scenario, encodedSize: () => 1234 })).capture({
            ...base,
            display: 0,
          }),
        }
      }),
    )
    expect(result.missing).toContain("does not exist")
    expect(result.outside).toContain("leaves the display")
    expect([...result.jpeg.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect([...result.jpeg.data.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(result.sized.data.byteLength).toBe(1234)
    expect([...result.sized.data.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47])
  })

  test("PNG bytes are deterministic and differ between regions", () => {
    const pixel = (x: number, y: number) => [x & 255, y & 255, 7] as const
    const a = FakeDriver.png(4, 3, pixel)
    expect(FakeDriver.png(4, 3, pixel)).toEqual(a)
    expect(FakeDriver.png(4, 3, (x, y) => [y & 255, x & 255, 7])).not.toEqual(a)
    // IHDR CRC of a 4x3 RGB image, as any PNG decoder checks it.
    expect(Buffer.from(a.subarray(29, 33)).toString("hex")).toBe(crcOf(a.subarray(12, 29)))
  })
})

function crcOf(data: Uint8Array) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0")
}

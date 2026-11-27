import { describe, expect, test } from "bun:test"
import { inflateSync } from "node:zlib"
import { Clock, Effect, Exit, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { Actions } from "../../src/actions.js"
import { ComputerError, DriverError } from "../../src/core/errors.js"
import { Keys } from "../../src/core/keys.js"
import { KillSwitch } from "../../src/core/killswitch.js"
import { FakeDriver } from "../../src/driver/fake.js"

const ZERO: Actions.Timing = {
  pressMs: 0,
  clickGapMs: 0,
  dragSteps: 4,
  dragStepMs: 0,
  wheelGapMs: 0,
  keyGapMs: 0,
  textChunk: 32,
  sliceMs: 100,
  settleMs: 0,
}

const setup = (
  scenario: FakeDriver.Scenario = { displays: FakeDriver.DISPLAYS.single },
  timing: Actions.Timing = ZERO,
) =>
  Effect.gen(function* () {
    const driver = yield* FakeDriver.make(scenario)
    const killSwitch = yield* KillSwitch.make()
    return { driver, killSwitch, ctx: { driver, killSwitch, timing } satisfies Actions.Context }
  })

const live = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const virtual = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))
const chords = (text: string) => Result.getOrThrow(Keys.parse(text))
const settle = Effect.gen(function* () {
  for (const _ of Array.from({ length: 20 })) yield* Effect.yieldNow
})

describe("pointer actions", () => {
  test("a click is move, down, up", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.click(env.ctx, { at: { x: 10, y: 20 }, button: "left", count: 1, modifiers: [] })
        return env.driver.ops()
      }),
    )
    expect(ops).toEqual([
      { op: "move", x: 10, y: 20 },
      { op: "button", button: "left", action: "down" },
      { op: "button", button: "left", action: "up" },
    ])
  })

  test("modifiers wrap the click in canonical order and are released in reverse", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.click(env.ctx, { at: { x: 1, y: 2 }, button: "right", count: 1, modifiers: ["ctrl", "shift"] })
        return env.driver.ops()
      }),
    )
    expect(ops).toEqual([
      { op: "key", vk: 0x11, action: "down" },
      { op: "key", vk: 0x10, action: "down" },
      { op: "move", x: 1, y: 2 },
      { op: "button", button: "right", action: "down" },
      { op: "button", button: "right", action: "up" },
      { op: "key", vk: 0x10, action: "up" },
      { op: "key", vk: 0x11, action: "up" },
    ])
  })

  test("double and triple clicks repeat down/up without moving again; no position clicks in place", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.click(env.ctx, { at: { x: 5, y: 5 }, button: "left", count: 3, modifiers: [] })
        yield* Actions.click(env.ctx, { button: "middle", count: 2, modifiers: [] })
        return env.driver.ops()
      }),
    )
    expect(ops.filter((op) => op.op === "move")).toHaveLength(1)
    expect(ops.filter((op) => op.op === "button" && op.button === "left" && op.action === "down")).toHaveLength(3)
    expect(ops.filter((op) => op.op === "button" && op.button === "middle" && op.action === "up")).toHaveLength(2)
  })

  test("a drag presses at the start, moves through evenly spaced points and releases at the end", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.drag(env.ctx, { from: { x: 0, y: 0 }, to: { x: 100, y: -40 }, modifiers: [] })
        return env.driver.ops()
      }),
    )
    expect(ops).toEqual([
      { op: "move", x: 0, y: 0 },
      { op: "button", button: "left", action: "down" },
      { op: "move", x: 25, y: -10 },
      { op: "move", x: 50, y: -20 },
      { op: "move", x: 75, y: -30 },
      { op: "move", x: 100, y: -40 },
      { op: "button", button: "left", action: "up" },
    ])
  })

  test("scrolling sends one wheel notch per step in the requested direction", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.scroll(env.ctx, { at: { x: 3, y: 3 }, direction: "down", amount: 3, modifiers: [] })
        yield* Actions.scroll(env.ctx, { direction: "left", amount: 1, modifiers: ["shift"] })
        return env.driver.ops()
      }),
    )
    expect(ops).toEqual([
      { op: "move", x: 3, y: 3 },
      { op: "wheel", dx: 0, dy: -1 },
      { op: "wheel", dx: 0, dy: -1 },
      { op: "wheel", dx: 0, dy: -1 },
      { op: "key", vk: 0x10, action: "down" },
      { op: "wheel", dx: -1, dy: 0 },
      { op: "key", vk: 0x10, action: "up" },
    ])
  })

  test("left_mouse_down holds the button until left_mouse_up", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.press(env.ctx, "down")
        const held = env.driver.held()
        yield* Actions.press(env.ctx, "up")
        return { held, after: env.driver.held(), ops: env.driver.ops() }
      }),
    )
    expect(result.held.buttons).toEqual(["left"])
    expect(result.after.buttons).toEqual([])
    expect(result.ops.some((op) => op.op === "release_all")).toBe(false)
  })
})

describe("keyboard actions", () => {
  test("chord sequences repeat in order; characters without a key are typed", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.keys(env.ctx, chords("ctrl+a 가"), 2)
        return env.driver.ops()
      }),
    )
    const once: ReadonlyArray<FakeDriver.Op> = [
      { op: "key", vk: 0x11, action: "down" },
      { op: "key", vk: 0x41, action: "down" },
      { op: "key", vk: 0x41, action: "up" },
      { op: "key", vk: 0x11, action: "up" },
      { op: "text", text: "가" },
    ]
    expect(ops).toEqual([...once, ...once])
  })

  test("a modifier-only chord taps the modifier", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.keys(env.ctx, chords("super"), 1)
        return env.driver.ops()
      }),
    )
    expect(ops).toEqual([
      { op: "key", vk: 0x5b, action: "down" },
      { op: "key", vk: 0x5b, action: "up" },
    ])
  })

  test("typing sends Unicode chunks, Enter for newlines and Tab for tabs, never splitting a character", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup({ displays: FakeDriver.DISPLAYS.single }, { ...ZERO, textChunk: 2 })
        yield* Actions.type(env.ctx, "abcde\n😀😀😀\tx")
        return env.driver.ops()
      }),
    )
    expect(ops).toEqual([
      { op: "text", text: "ab" },
      { op: "text", text: "cd" },
      { op: "text", text: "e" },
      { op: "key", vk: 0x0d, action: "down" },
      { op: "key", vk: 0x0d, action: "up" },
      { op: "text", text: "😀😀" },
      { op: "text", text: "😀" },
      { op: "key", vk: 0x09, action: "down" },
      { op: "key", vk: 0x09, action: "up" },
      { op: "text", text: "x" },
    ])
  })

  test("hold_key keeps the chord down for the duration", async () => {
    const result = await virtual(
      Effect.gen(function* () {
        const env = yield* setup()
        const fiber = yield* Actions.holdKey(env.ctx, Result.getOrThrow(Keys.parseChord("shift+a")), 1_000).pipe(
          Effect.forkChild,
        )
        yield* settle
        const during = env.driver.held()
        yield* TestClock.adjust("999 millis")
        yield* settle
        const almost = env.driver.held()
        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(fiber)
        return { during, almost, after: env.driver.held() }
      }),
    )
    expect(result.during.keys).toEqual([0x10, 0x41])
    expect(result.almost.keys).toEqual([0x10, 0x41])
    expect(result.after.keys).toEqual([])
  })

  test("a character cannot be held", async () => {
    const error = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        return yield* Effect.flip(Actions.holdKey(env.ctx, Result.getOrThrow(Keys.parseChord("가")), 100))
      }),
    )
    expect(error).toBeInstanceOf(ComputerError)
    expect((error as ComputerError).code).toBe("invalid_input")
  })

  test("before runs ahead of every chord, text chunk, Tab and Return with what the step can do", async () => {
    const steps = await live(
      Effect.gen(function* () {
        const env = yield* setup(undefined, { ...ZERO, textChunk: 3 })
        const seen: Array<string> = []
        const ctx: Actions.Context = {
          ...env.ctx,
          before: (kind) =>
            Effect.sync(() => {
              seen.push(`${kind}@${env.driver.ops().length}`)
            }),
        }
        yield* Actions.keys(ctx, chords("Tab ctrl+v"), 1)
        seen.push("|")
        yield* Actions.type(ctx, "abcd\nx")
        seen.push("|")
        yield* Actions.holdKey(ctx, Result.getOrThrow(Keys.parseChord("shift")), 0)
        return seen
      }),
    )
    // The op count shows each check comes before its own step's input.
    expect(steps).toEqual(["keys@0", "text@2", "|", "text@6", "text@7", "keys@8", "text@10", "|", "keys@11"])
  })

  test("the step after a chord that can move focus is checked only once settleMs has passed", async () => {
    const seen = await virtual(
      Effect.gen(function* () {
        const env = yield* setup(undefined, { ...ZERO, settleMs: 100 })
        const at: Array<number> = []
        const ctx: Actions.Context = {
          ...env.ctx,
          before: () => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => at.push(now))),
        }
        const fiber = yield* Actions.keys(ctx, chords("Tab a b"), 1).pipe(Effect.forkChild)
        yield* settle
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)
        return at
      }),
    )
    // Tab can move focus: `a` waits; a character cannot, so `b` follows at once.
    expect(seen).toEqual([0, 100, 100])
  })

  test("a failing before stops the sequence before that step and releases", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        const calls = { count: 0 }
        const ctx: Actions.Context = {
          ...env.ctx,
          before: () =>
            Effect.suspend(() => {
              calls.count += 1
              return calls.count < 3 ? Effect.void : Effect.fail(new ComputerError("target_changed"))
            }),
        }
        const error = yield* Effect.flip(Actions.keys(ctx, chords("a b c d"), 1))
        return { error, ops: env.driver.ops() }
      }),
    )
    expect(result.error).toEqual(new ComputerError("target_changed"))
    expect(result.ops).toEqual([
      { op: "key", vk: 0x41, action: "down" },
      { op: "key", vk: 0x41, action: "up" },
      { op: "key", vk: 0x42, action: "down" },
      { op: "key", vk: 0x42, action: "up" },
      { op: "release_all", keys: [], buttons: [] },
    ])
  })
})

describe("cleanup", () => {
  test("a failure mid-chord releases every held key", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        env.driver.failNext("key", new DriverError("failed", "SendInput returned 0"), { skip: 2 })
        const error = yield* Effect.flip(Actions.keys(env.ctx, chords("ctrl+shift+t"), 1))
        return { error, ops: env.driver.ops(), held: env.driver.held() }
      }),
    )
    expect(result.error).toBeInstanceOf(DriverError)
    expect(result.ops).toEqual([
      { op: "key", vk: 0x11, action: "down" },
      { op: "key", vk: 0x10, action: "down" },
      { op: "release_all", keys: [0x11, 0x10], buttons: [] },
    ])
    expect(result.held).toEqual({ keys: [], buttons: [] })
  })

  test("interrupting a held chord releases it", async () => {
    const result = await virtual(
      Effect.gen(function* () {
        const env = yield* setup()
        const fiber = yield* Actions.holdKey(env.ctx, Result.getOrThrow(Keys.parseChord("shift+a")), 10_000).pipe(
          Effect.forkChild,
        )
        yield* settle
        const during = env.driver.held()
        yield* Fiber.interrupt(fiber)
        return { during, ops: env.driver.ops(), held: env.driver.held() }
      }),
    )
    expect(result.during.keys).toEqual([0x10, 0x41])
    expect(result.ops.at(-1)).toEqual({ op: "release_all", keys: [0x10, 0x41], buttons: [] })
    expect(result.held).toEqual({ keys: [], buttons: [] })
  })

  test("interrupting a drag releases the button", async () => {
    const result = await virtual(
      Effect.gen(function* () {
        const env = yield* setup({ displays: FakeDriver.DISPLAYS.single }, { ...ZERO, dragStepMs: 50 })
        const fiber = yield* Actions.drag(env.ctx, {
          from: { x: 0, y: 0 },
          to: { x: 40, y: 0 },
          modifiers: ["alt"],
        }).pipe(Effect.forkChild)
        yield* settle
        yield* TestClock.adjust("50 millis")
        yield* settle
        yield* Fiber.interrupt(fiber)
        return { ops: env.driver.ops(), held: env.driver.held() }
      }),
    )
    expect(result.ops.filter((op) => op.op === "move")).toEqual([
      { op: "move", x: 0, y: 0 },
      { op: "move", x: 10, y: 0 },
    ])
    expect(result.ops.at(-1)).toEqual({ op: "release_all", keys: [0x12], buttons: ["left"] })
    expect(result.held).toEqual({ keys: [], buttons: [] })
  })

  test("a successful action does not call releaseAll", async () => {
    const ops = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* Actions.keys(env.ctx, chords("ctrl+c"), 1)
        yield* Actions.type(env.ctx, "x")
        return env.driver.ops()
      }),
    )
    expect(ops.some((op) => op.op === "release_all")).toBe(false)
  })
})

describe("kill switch", () => {
  test("an engaged switch refuses the action before any input", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* env.killSwitch.engage("rpc")
        const error = yield* Effect.flip(
          Actions.click(env.ctx, { at: { x: 1, y: 1 }, button: "left", count: 1, modifiers: [] }),
        )
        return { error, ops: env.driver.ops() }
      }),
    )
    expect(result.error).toBeInstanceOf(ComputerError)
    expect((result.error as ComputerError).code).toBe("stopped")
    expect(result.ops.filter((op) => op.op !== "release_all")).toEqual([])
  })

  test("engaging mid-typing stops before the next chunk and releases", async () => {
    const result = await virtual(
      Effect.gen(function* () {
        const env = yield* setup({ displays: FakeDriver.DISPLAYS.single }, { ...ZERO, textChunk: 2, keyGapMs: 100 })
        const fiber = yield* Actions.type(env.ctx, "abcdef").pipe(Effect.forkChild)
        yield* settle
        yield* env.killSwitch.engage("user_chord")
        yield* TestClock.adjust("100 millis")
        const exit = yield* Fiber.await(fiber)
        return { exit, ops: env.driver.ops() }
      }),
    )
    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(JSON.stringify(result.exit)).toContain("stopped")
    expect(result.ops.filter((op) => op.op === "text")).toEqual([{ op: "text", text: "ab" }])
    expect(result.ops.at(-1)?.op).toBe("release_all")
  })

  test("a long hold stops within one slice of the switch engaging", async () => {
    const result = await virtual(
      Effect.gen(function* () {
        const env = yield* setup()
        const fiber = yield* Actions.holdKey(env.ctx, Result.getOrThrow(Keys.parseChord("shift")), 10_000).pipe(
          Effect.forkChild,
        )
        yield* settle
        yield* TestClock.adjust("250 millis")
        yield* env.killSwitch.engage("user_chord")
        yield* TestClock.adjust("100 millis")
        yield* settle
        const exit = yield* Fiber.await(fiber)
        return { exit, held: env.driver.held() }
      }),
    )
    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(result.held.keys).toEqual([])
  })

  test("wait checks the switch", async () => {
    const exit = await live(
      Effect.gen(function* () {
        const env = yield* setup()
        yield* env.killSwitch.engage("rpc")
        return yield* Effect.exit(Actions.wait(env.ctx, 0))
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("screenshots", () => {
  const scenario: FakeDriver.Scenario = {
    displays: FakeDriver.DISPLAYS.dual,
    windows: [{ id: "0x2", exe: "notepad.exe", bounds: { x: -1800, y: 300, width: 800, height: 600 } }],
    foreground: "0x2",
    cursor: { x: -1000, y: 500 },
  }
  const pngSize = (data: Uint8Array) => {
    const view = new DataView(data.buffer, data.byteOffset)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }

  test("defaults to the foreground window's display and describes the frame", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup(scenario)
        return yield* Actions.screenshot(env.ctx, {
          tier: "standard",
          format: "auto",
          maxBase64Bytes: 4_500_000,
          captureId: "cap_t1",
        })
      }),
    )
    expect(result.display.id).toBe(1)
    expect(result.frame).toMatchObject({
      captureId: "cap_t1",
      displayId: 1,
      physical: { x: -1920, y: 180, width: 1920, height: 1080 },
      image: { width: 1429, height: 804 },
      tier: "standard",
      layoutHash: result.layout.hash,
    })
    expect(result.capture.mime).toBe("image/png")
    expect(pngSize(result.capture.data)).toEqual({ width: 1429, height: 804 })
    // The IDAT stream inflates to one filter byte plus RGB per pixel and row.
    const idat = result.capture.data.subarray(33 + 8, result.capture.data.length - 12 - 4)
    expect(inflateSync(idat).length).toBe(804 * (1429 * 3 + 1))
    expect(result.capture.cursor).toEqual({ x: -1000, y: 500 })
  })

  test("an explicit display wins; without a foreground window the primary is used", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup({ displays: FakeDriver.DISPLAYS.mixed })
        const input = { tier: "high" as const, format: "auto" as const, maxBase64Bytes: 4_500_000, captureId: "cap_x" }
        return {
          primary: yield* Actions.screenshot(env.ctx, input),
          portrait: yield* Actions.screenshot(env.ctx, { ...input, display: 1 }),
          missing: yield* Effect.flip(Actions.screenshot(env.ctx, { ...input, display: 7 })),
        }
      }),
    )
    expect(result.primary.frame.displayId).toBe(0)
    expect(result.primary.frame.image).toEqual({ width: 2000, height: 1125 })
    expect(result.primary.capture.cursor).toEqual({ x: 1920, y: 1080 })
    expect(result.portrait.frame.image).toEqual({ width: 1080, height: 1920 })
    expect(result.portrait.capture.cursor).toBeUndefined()
    expect(result.missing).toBeInstanceOf(ComputerError)
    expect(result.missing.message).toContain("Display 7 does not exist; displays are 0, 1, 2")
  })

  test("an oversized PNG falls back to JPEG", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup({
          displays: FakeDriver.DISPLAYS.single,
          encodedSize: (input) => (input.format === "png" ? 4_000_000 : undefined),
        })
        const shot = yield* Actions.screenshot(env.ctx, {
          tier: "standard",
          format: "auto",
          maxBase64Bytes: 4_500_000,
          captureId: "cap_j",
        })
        return { shot, ops: env.driver.ops() }
      }),
    )
    expect(result.shot.capture.mime).toBe("image/jpeg")
    expect(result.ops.map((op) => (op.op === "capture" ? `${op.format}${op.quality ?? ""}` : op.op))).toEqual([
      "png",
      "jpeg85",
    ])
  })

  test("zoom captures a physical region of the frame's display", async () => {
    const result = await live(
      Effect.gen(function* () {
        const env = yield* setup(scenario)
        const shot = yield* Actions.screenshot(env.ctx, {
          tier: "standard",
          format: "png",
          maxBase64Bytes: 4_500_000,
          captureId: "cap_z",
        })
        env.driver.clearOps()
        const region = { x: -1900, y: 200, width: 400, height: 300 }
        const capture = yield* Actions.zoom(env.ctx, {
          frame: shot.frame,
          region,
          tier: "standard",
          format: "png",
          maxBase64Bytes: 4_500_000,
        })
        return { capture, ops: env.driver.ops() }
      }),
    )
    expect(result.ops).toEqual([
      {
        op: "capture",
        display: 1,
        region: { x: -1900, y: 200, width: 400, height: 300 },
        width: 400,
        height: 300,
        format: "png",
      },
    ])
    expect(pngSize(result.capture.data)).toEqual({ width: 400, height: 300 })
  })
})

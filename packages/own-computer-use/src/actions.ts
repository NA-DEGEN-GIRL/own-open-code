export * as Actions from "./actions.js"

import { Clock, Effect, Exit } from "effect"
import { Budget } from "./core/budget.js"
import { ComputerError, type DriverError } from "./core/errors.js"
import { Geometry } from "./core/geometry.js"
import { Keys } from "./core/keys.js"
import { Policy } from "./core/policy.js"
import type { KillSwitch } from "./core/killswitch.js"
import type { Driver } from "./driver/driver.js"

/**
 * Composite input over a `Driver`, in physical pixels. The kill switch is checked before every press, move, wheel
 * notch and text chunk, so a stop lands within one step; releases are never gated. Any failure or interruption after
 * the first press releases everything the driver holds (`releaseAll`), so no key or button stays down. The gate above
 * maps image coordinates, checks policy and holds the desktop lease before calling these; keyboard input also calls
 * `Context.before` ahead of each step, so the gate re-checks the window in front after every chord that moved focus.
 */

export interface Timing {
  /** Button down → up. */
  readonly pressMs: number
  /** Between the clicks of a double or triple click; far below the default 500 ms double-click time. */
  readonly clickGapMs: number
  readonly dragSteps: number
  readonly dragStepMs: number
  readonly wheelGapMs: number
  /** After each chord and text chunk, so the target app keeps up. */
  readonly keyGapMs: number
  /** Code points per `text` call; also the kill-switch granularity while typing. */
  readonly textChunk: number
  /** Kill-switch granularity of `hold_key` and `wait`. */
  readonly sliceMs: number
  /**
   * After a chord that can move focus or switch windows (anything but one character: Tab, Return, alt+Tab, ctrl+Tab)
   * and before the next step is checked, so Windows has made the switch by the time the gate asks what is in front.
   */
  readonly settleMs: number
}

export const TIMING: Timing = {
  pressMs: 15,
  clickGapMs: 40,
  dragSteps: 12,
  dragStepMs: 10,
  wheelGapMs: 30,
  keyGapMs: 10,
  textChunk: 32,
  sliceMs: 100,
  settleMs: 100,
}

export interface Context {
  readonly driver: Driver.Driver
  readonly killSwitch: Pick<KillSwitch.KillSwitch, "check">
  readonly timing?: Timing
  /**
   * Runs before each chord of `keys`, each text chunk and each Tab/Return of `type`, and before `holdKey`, with what
   * that step can do (`text`: enter or insert characters). The gate checks the window in front there again: a step
   * can move focus (alt+Tab, Tab, Return), and the next one must not land in a window that was never checked.
   */
  readonly before?: (kind: "keys" | "text") => Effect.Effect<void, Failure>
}

type Failure = DriverError | ComputerError

export const move = (ctx: Context, to: Geometry.Point) => guarded(ctx, step(ctx, ctx.driver.move(to)))

export const click = (
  ctx: Context,
  input: {
    readonly at?: Geometry.Point
    readonly button: Driver.Button
    readonly count: number
    readonly modifiers: ReadonlyArray<Keys.Modifier>
  },
) =>
  guarded(
    ctx,
    withModifiers(
      ctx,
      input.modifiers,
      Effect.gen(function* () {
        if (input.at !== undefined) yield* step(ctx, ctx.driver.move(input.at))
        for (const index of Array.from({ length: input.count }, (_, at) => at)) {
          if (index > 0) yield* Effect.sleep(timing(ctx).clickGapMs)
          yield* step(ctx, ctx.driver.button(input.button, "down"))
          yield* Effect.sleep(timing(ctx).pressMs)
          yield* ctx.driver.button(input.button, "up")
        }
      }),
    ),
  )

/** Left-button drag through evenly spaced intermediate moves, so apps see a real drag rather than a jump. */
export const drag = (
  ctx: Context,
  input: {
    readonly from: Geometry.Point
    readonly to: Geometry.Point
    readonly modifiers: ReadonlyArray<Keys.Modifier>
  },
) =>
  guarded(
    ctx,
    withModifiers(
      ctx,
      input.modifiers,
      Effect.gen(function* () {
        yield* step(ctx, ctx.driver.move(input.from))
        yield* step(ctx, ctx.driver.button("left", "down"))
        for (const point of path(input.from, input.to, timing(ctx).dragSteps)) {
          yield* Effect.sleep(timing(ctx).dragStepMs)
          yield* step(ctx, ctx.driver.move(point))
        }
        yield* ctx.driver.button("left", "up")
      }),
    ),
  )

/** `left_mouse_down` / `left_mouse_up`: a held button is intentional here and only released on failure. */
export const press = (ctx: Context, action: Driver.Press) =>
  guarded(ctx, action === "down" ? step(ctx, ctx.driver.button("left", "down")) : ctx.driver.button("left", "up"))

export const scroll = (
  ctx: Context,
  input: {
    readonly at?: Geometry.Point
    readonly direction: "up" | "down" | "left" | "right"
    readonly amount: number
    readonly modifiers: ReadonlyArray<Keys.Modifier>
  },
) =>
  guarded(
    ctx,
    withModifiers(
      ctx,
      input.modifiers,
      Effect.gen(function* () {
        if (input.at !== undefined) yield* step(ctx, ctx.driver.move(input.at))
        const notch = WHEEL[input.direction]
        for (const index of Array.from({ length: input.amount }, (_, at) => at)) {
          if (index > 0) yield* Effect.sleep(timing(ctx).wheelGapMs)
          yield* step(ctx, ctx.driver.wheel(notch))
        }
      }),
    ),
  )

/** Presses each chord in order, `repeat` times; each one is checked (`before`) after the previous one settled. */
export const keys = (ctx: Context, chords: ReadonlyArray<Keys.Chord>, repeat: number) => {
  const sequence = Array.from({ length: repeat }, () => chords).flat()
  return guarded(
    ctx,
    Effect.forEach(
      sequence,
      (chord, index) =>
        before(ctx, Keys.navigates(chord) ? "keys" : "text").pipe(
          Effect.andThen(withModifiers(ctx, chord.modifiers, tap(ctx, chord.key))),
          Effect.andThen(
            Effect.sleep(
              index < sequence.length - 1 && !Keys.character(chord) ? timing(ctx).settleMs : timing(ctx).keyGapMs,
            ),
          ),
        ),
      { discard: true },
    ),
  )
}

export const holdKey = (ctx: Context, chord: Keys.Chord, durationMs: number) =>
  guarded(
    ctx,
    Effect.gen(function* () {
      const key = chord.key
      if (key !== undefined && "unicode" in key)
        return yield* new ComputerError("invalid_input", `"${key.unicode}" is a character, not a key that can be held`)
      yield* before(ctx, Keys.navigates(chord) ? "keys" : "text")
      yield* withModifiers(
        ctx,
        chord.modifiers,
        Effect.gen(function* () {
          if (key !== undefined) yield* step(ctx, ctx.driver.key(key, "down"))
          yield* pause(ctx, durationMs)
          if (key !== undefined) yield* ctx.driver.key(key, "up")
        }),
      )
    }),
  )

/**
 * Types text in chunks of Unicode characters; newlines press Enter and tabs press Tab (real keys, for forms). Every
 * chunk and key is checked (`before`), and the step after a Tab or Return only once focus has settled.
 */
export const type = (ctx: Context, text: string) => {
  const parts = text.split(/([\n\t])/).filter((part) => part !== "")
  return guarded(
    ctx,
    Effect.forEach(
      parts,
      (part, index) => {
        if (part === "\n" || part === "\t")
          return before(ctx, "keys").pipe(
            Effect.andThen(tap(ctx, part === "\n" ? RETURN : TAB)),
            Effect.andThen(Effect.sleep(index < parts.length - 1 ? timing(ctx).settleMs : timing(ctx).keyGapMs)),
          )
        return Effect.forEach(
          chunks(part, timing(ctx).textChunk),
          (chunk) =>
            before(ctx, "text").pipe(
              Effect.andThen(step(ctx, ctx.driver.text(chunk))),
              Effect.andThen(Effect.sleep(timing(ctx).keyGapMs)),
            ),
          { discard: true },
        )
      },
      { discard: true },
    ),
  )
}

export const wait = (ctx: Context, durationMs: number) => pause(ctx, durationMs)

export interface ScreenshotInput {
  /** Display id; default: the display of the foreground window, else the primary. */
  readonly display?: number
  readonly tier: Geometry.Tier
  readonly format: "auto" | "png"
  readonly maxBase64Bytes: number
  readonly captureId: string
}

/** Captures a whole display at the tier's size and describes it as a `Frame` for later coordinate mapping. */
export const screenshot = (ctx: Pick<Context, "driver">, input: ScreenshotInput) =>
  Effect.gen(function* () {
    const layout = Geometry.layout(yield* ctx.driver.displays)
    const display =
      input.display === undefined
        ? (Geometry.display(layout, (yield* ctx.driver.foreground)?.displayId ?? -1) ?? Geometry.primary(layout))
        : Geometry.display(layout, input.display)
    if (display === undefined)
      return yield* new ComputerError(
        "invalid_input",
        `Display ${input.display} does not exist; displays are ${layout.monitors.map((item) => item.id).join(", ") || "none"}`,
      )
    const size = Geometry.fitImage(display.bounds.width, display.bounds.height, Geometry.TIERS[input.tier])
    // Listed before the capture: a window that opens in between counts as new, so a later click on it is refused
    // rather than allowed unseen.
    const seen = yield* ctx.driver.windows.pipe(
      Effect.map((windows) => windows.filter(Policy.visible)),
      Effect.map((windows) => ({
        windows: windows.map((window) => window.id),
        apps: [...new Set(windows.map((window) => Policy.appName(window.exe)))],
      })),
      Effect.orElseSucceed(() => undefined),
    )
    const encoded = yield* Budget.encodeWithin(input, (encoding) =>
      ctx.driver.capture({ display: display.id, width: size.width, height: size.height, ...encoding }),
    )
    const frame: Geometry.Frame = {
      captureId: input.captureId,
      displayId: display.id,
      physical: display.bounds,
      image: { width: encoded.capture.width, height: encoded.capture.height },
      tier: input.tier,
      layoutHash: layout.hash,
      at: yield* Clock.currentTimeMillis,
      ...(seen === undefined ? {} : { seen }),
    }
    return { frame, capture: encoded.capture, display, layout }
  })

/** Captures a physical region of `frame`'s display at up to the tier's size; frames are unchanged by a zoom. */
export const zoom = (
  ctx: Pick<Context, "driver">,
  input: {
    readonly frame: Geometry.Frame
    readonly region: Geometry.Rect
    readonly tier: Geometry.Tier
    readonly format: "auto" | "png"
    readonly maxBase64Bytes: number
  },
) =>
  Effect.gen(function* () {
    const size = Geometry.fitImage(input.region.width, input.region.height, Geometry.TIERS[input.tier])
    const encoded = yield* Budget.encodeWithin(input, (encoding) =>
      ctx.driver.capture({
        display: input.frame.displayId,
        region: input.region,
        width: size.width,
        height: size.height,
        ...encoding,
      }),
    )
    return encoded.capture
  })

const RETURN: Keys.Key = { name: "Return", vk: 0x0d, extended: false }
const TAB: Keys.Key = { name: "Tab", vk: 0x09, extended: false }

const WHEEL = {
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
} as const

function timing(ctx: Context) {
  return ctx.timing ?? TIMING
}

function before(ctx: Context, kind: "keys" | "text") {
  return ctx.before?.(kind) ?? Effect.void
}

/** One gated input step: fails with `stopped` instead of running once the kill switch is engaged. */
function step<A>(ctx: Context, effect: Effect.Effect<A, Failure>) {
  return ctx.killSwitch.check.pipe(Effect.andThen(effect))
}

function guarded<A>(ctx: Context, effect: Effect.Effect<A, Failure>) {
  return effect.pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : ctx.driver.releaseAll)))
}

/** Presses modifiers in canonical order, runs `body`, releases them in reverse. */
function withModifiers<A>(ctx: Context, modifiers: ReadonlyArray<Keys.Modifier>, body: Effect.Effect<A, Failure>) {
  return Effect.gen(function* () {
    for (const modifier of modifiers) yield* step(ctx, ctx.driver.key(Keys.MODIFIER_KEYS[modifier], "down"))
    const result = yield* body
    for (const modifier of modifiers.toReversed()) yield* ctx.driver.key(Keys.MODIFIER_KEYS[modifier], "up")
    return result
  })
}

function tap(ctx: Context, key: Keys.Chord["key"]) {
  if (key === undefined) return Effect.void
  if ("unicode" in key) return step(ctx, ctx.driver.text(key.unicode))
  return step(ctx, ctx.driver.key(key, "down")).pipe(Effect.andThen(ctx.driver.key(key, "up")))
}

/** Sleeps `durationMs` in slices, failing with `stopped` as soon as the kill switch engages. */
function pause(ctx: Context, durationMs: number): Effect.Effect<void, Failure> {
  if (durationMs <= 0) return ctx.killSwitch.check
  const slice = Math.min(durationMs, timing(ctx).sliceMs)
  return ctx.killSwitch.check.pipe(
    Effect.andThen(Effect.sleep(slice)),
    Effect.andThen(Effect.suspend(() => pause(ctx, durationMs - slice))),
  )
}

/** `steps` points from just after `from` to exactly `to`. */
function path(from: Geometry.Point, to: Geometry.Point, steps: number) {
  return Array.from({ length: steps }, (_, index) => ({
    x: Math.round(from.x + ((to.x - from.x) * (index + 1)) / steps),
    y: Math.round(from.y + ((to.y - from.y) * (index + 1)) / steps),
  }))
}

function chunks(text: string, size: number) {
  const points = Array.from(text)
  return Array.from({ length: Math.ceil(points.length / size) }, (_, index) =>
    points.slice(index * size, (index + 1) * size).join(""),
  )
}

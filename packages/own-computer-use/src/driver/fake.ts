export * as FakeDriver from "./fake.js"

import { deflateSync } from "node:zlib"
import { type Duration, Effect, PubSub, Stream } from "effect"
import { DriverError } from "../core/errors.js"
import { Geometry } from "../core/geometry.js"
import { Policy } from "../core/policy.js"
import type { Driver } from "./driver.js"

/**
 * An in-memory desktop for tests and for running the plugin without the helper (`driver: "fake"`): monitors with DPI
 * scales and negative origins, a z-ordered window table, an operation log, deterministic capture bytes (real PNGs via
 * node:zlib), and injectable failures, delays and events. It never touches the real desktop.
 */

export interface WindowSpec {
  readonly id: string
  readonly exe: string
  readonly bounds: Geometry.Rect
  readonly title?: string
  readonly className?: string
  readonly pid?: number
  readonly elevated?: boolean
  readonly minimized?: boolean
  readonly cloaked?: boolean
  /** The focused element while this window is in the foreground. */
  readonly focus?: { readonly isPassword: boolean; readonly controlType?: string }
}

export interface Scenario {
  readonly displays: ReadonlyArray<Geometry.Display>
  /** Topmost first. */
  readonly windows?: ReadonlyArray<WindowSpec>
  readonly foreground?: string
  readonly cursor?: Geometry.Point
  /** Forces the encoded size of a capture (e.g. to exercise the JPEG ladder); `undefined` keeps the real encoding. */
  readonly encodedSize?: (input: Driver.CaptureInput) => number | undefined
  readonly info?: Partial<Driver.Info>
}

export type Op =
  | { readonly op: "move"; readonly x: number; readonly y: number }
  | { readonly op: "button"; readonly button: Driver.Button; readonly action: Driver.Press }
  | { readonly op: "wheel"; readonly dx: number; readonly dy: number }
  | { readonly op: "key"; readonly vk: number; readonly action: Driver.Press }
  | { readonly op: "text"; readonly text: string }
  | { readonly op: "focus"; readonly windowId: string }
  | ({ readonly op: "capture" } & Driver.CaptureInput)
  | { readonly op: "release_all"; readonly keys: ReadonlyArray<number>; readonly buttons: ReadonlyArray<Driver.Button> }
  | { readonly op: "indicator"; readonly on: boolean }

export type OpName =
  | "hello"
  | "displays"
  | "capture"
  | "cursor"
  | "move"
  | "button"
  | "wheel"
  | "key"
  | "text"
  | "windowAt"
  | "foreground"
  | "windows"
  | "focus"
  | "focused"

export interface FakeDriver extends Driver.Driver {
  /** Input and capture operations in order. */
  readonly ops: () => ReadonlyArray<Op>
  readonly clearOps: () => void
  /** Keys and buttons currently held down. */
  readonly held: () => { readonly keys: ReadonlyArray<number>; readonly buttons: ReadonlyArray<Driver.Button> }
  readonly pointer: () => Geometry.Point
  /** After `skip` more successful calls (default 0), the next `times` calls (default 1) of `op` fail with `error`. */
  readonly failNext: (
    op: OpName,
    error: DriverError,
    options?: { readonly skip?: number; readonly times?: number },
  ) => void
  /** Every later call of `op` sleeps first (on the Effect clock, so it is interruptible and TestClock-driven). */
  readonly delay: (op: OpName, duration: Duration.Input) => void
  readonly emit: (event: Driver.Event) => Effect.Effect<void>
  /** Replaces the monitors and emits `display_changed`, like a resolution or DPI change. */
  readonly setDisplays: (displays: ReadonlyArray<Geometry.Display>) => Effect.Effect<void>
  readonly setWindows: (windows: ReadonlyArray<WindowSpec>, foreground?: string) => void
  /** Runs `callback` after every recorded input op, like Windows reacting to input (alt+Tab switching windows). */
  readonly react: (callback: (op: Op, driver: FakeDriver) => void) => void
}

export const make = (scenario: Scenario) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<Driver.Event>()
    const state = {
      displays: scenario.displays,
      windows: withPids(scenario.windows ?? []),
      foreground: scenario.foreground,
      cursor: scenario.cursor ?? center(scenario.displays[0]?.bounds),
      keys: new Set<number>(),
      buttons: new Set<Driver.Button>(),
      ops: [] as Array<Op>,
      closed: false,
    }
    const failures = new Map<OpName, { readonly error: DriverError; skip: number; times: number }>()
    const delays = new Map<OpName, Duration.Input>()
    const reactions: Array<(op: Op, driver: FakeDriver) => void> = []

    const run = <A>(name: OpName, body: () => A | DriverError) =>
      Effect.gen(function* () {
        const delay = delays.get(name)
        if (delay !== undefined) yield* Effect.sleep(delay)
        if (state.closed) return yield* new DriverError("unavailable", "fake driver is closed")
        const failure = failures.get(name)
        if (failure !== undefined && failure.skip === 0 && failure.times > 0) {
          failure.times -= 1
          return yield* failure.error
        }
        if (failure !== undefined && failure.skip > 0) failure.skip -= 1
        const result = body()
        if (result instanceof DriverError) return yield* result
        return result
      })
    const record = (op: Op) => {
      state.ops.push(op)
      if (op.op !== "capture") for (const reaction of reactions) reaction(op, driver)
    }
    const windowInfo = (spec: WindowSpec & { readonly pid: number }): Policy.WindowInfo => {
      const display = Geometry.displayAt(Geometry.layout(state.displays), center(spec.bounds))
      return {
        id: spec.id,
        pid: spec.pid,
        exe: spec.exe,
        title: spec.title ?? "",
        className: spec.className ?? "",
        bounds: spec.bounds,
        ...(display === undefined ? {} : { displayId: display.id }),
        elevated: spec.elevated ?? false,
        minimized: spec.minimized ?? false,
        cloaked: spec.cloaked ?? false,
      }
    }
    const foregroundSpec = () => state.windows.find((item) => item.id === state.foreground)

    const driver: FakeDriver = {
      kind: "fake",
      hello: run("hello", () => ({
        version: "fake",
        protocol: 1,
        dpiAwareness: "per_monitor_v2",
        interactive: true,
        inputDesktop: true,
        killChord: true,
        ...scenario.info,
      })),
      displays: run("displays", () => state.displays),
      capture: (input) =>
        run("capture", () => {
          const display = state.displays.find((item) => item.id === input.display)
          if (display === undefined) return new DriverError("failed", `display ${input.display} does not exist`)
          const region = input.region ?? display.bounds
          if (!within(display.bounds, region)) return new DriverError("failed", "capture region leaves the display")
          record({ op: "capture", ...input })
          return {
            mime: input.format === "png" ? ("image/png" as const) : ("image/jpeg" as const),
            data: encode(input, region, scenario.encodedSize?.(input)),
            width: input.width,
            height: input.height,
            ...(Geometry.contains(display.bounds, state.cursor) ? { cursor: state.cursor } : {}),
          }
        }),
      cursor: run("cursor", () => state.cursor),
      move: (point) =>
        run("move", () => {
          record({ op: "move", x: point.x, y: point.y })
          state.cursor = point
        }),
      button: (button, action) =>
        run("button", () => {
          record({ op: "button", button, action })
          if (action === "down") state.buttons.add(button)
          if (action === "up") state.buttons.delete(button)
        }),
      wheel: (input) =>
        run("wheel", () => {
          record({ op: "wheel", dx: input.dx, dy: input.dy })
        }),
      key: (key, action) =>
        run("key", () => {
          record({ op: "key", vk: key.vk, action })
          if (action === "down") state.keys.add(key.vk)
          if (action === "up") state.keys.delete(key.vk)
        }),
      text: (text) =>
        run("text", () => {
          record({ op: "text", text })
        }),
      windowAt: (point) =>
        run("windowAt", () => {
          const window = state.windows.find(
            (item) => !item.minimized && !item.cloaked && Geometry.contains(item.bounds, point),
          )
          return window === undefined ? undefined : windowInfo(window)
        }),
      foreground: run("foreground", () => {
        const window = foregroundSpec()
        return window === undefined ? undefined : windowInfo(window)
      }),
      windows: run("windows", () => state.windows.map((item) => windowInfo(item))),
      focus: (windowId) =>
        run("focus", () => {
          const window = state.windows.find((item) => item.id === windowId)
          if (window === undefined) return new DriverError("unknown_window", `window ${windowId} does not exist`)
          record({ op: "focus", windowId })
          state.foreground = windowId
          state.windows = [window, ...state.windows.filter((item) => item !== window)]
        }),
      focused: run("focused", () => {
        const window = foregroundSpec()
        if (window === undefined) return undefined
        return {
          pid: window.pid,
          isPassword: window.focus?.isPassword ?? false,
          ...(window.focus?.controlType === undefined ? {} : { controlType: window.focus.controlType }),
        }
      }),
      releaseAll: Effect.sync(() => {
        record({ op: "release_all", keys: [...state.keys], buttons: [...state.buttons] })
        state.keys.clear()
        state.buttons.clear()
      }),
      indicator: (input) =>
        Effect.sync(() => {
          record({ op: "indicator", on: input.on })
        }),
      events: Stream.fromPubSub(events),
      close: Effect.gen(function* () {
        if (state.closed) return
        yield* driver.releaseAll
        state.closed = true
        yield* PubSub.publish(events, { _tag: "exited", code: 0 })
      }),
      ops: () => [...state.ops],
      clearOps: () => {
        state.ops = []
      },
      held: () => ({ keys: [...state.keys], buttons: [...state.buttons] }),
      pointer: () => state.cursor,
      failNext: (op, error, options) => {
        failures.set(op, { error, skip: options?.skip ?? 0, times: options?.times ?? 1 })
      },
      delay: (op, duration) => {
        delays.set(op, duration)
      },
      emit: (event) => Effect.asVoid(PubSub.publish(events, event)),
      setDisplays: (displays) =>
        Effect.gen(function* () {
          state.displays = displays
          yield* PubSub.publish(events, { _tag: "display_changed" })
        }),
      setWindows: (windows, foreground) => {
        state.windows = withPids(windows)
        state.foreground = foreground ?? state.foreground
      },
      react: (callback) => {
        reactions.push(callback)
      },
    }
    return driver
  })

/** Monitor presets: physical bounds with negative origins and mixed DPI, as Windows reports them to a PMv2 process. */
export const DISPLAYS = {
  single: [{ id: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1 }],
  /** A 125% 1440p primary with a 100% 1080p monitor to its left, lower by 180 px. */
  dual: [
    { id: 0, primary: true, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scale: 1.25 },
    { id: 1, primary: false, bounds: { x: -1920, y: 180, width: 1920, height: 1080 }, scale: 1 },
  ],
  /** A 150% 4K primary, a portrait 1080p monitor to its right and a 200% 3000x2000 panel above. */
  mixed: [
    { id: 0, primary: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scale: 1.5 },
    { id: 1, primary: false, bounds: { x: 3840, y: 0, width: 1080, height: 1920 }, scale: 1 },
    { id: 2, primary: false, bounds: { x: 420, y: -2000, width: 3000, height: 2000 }, scale: 2 },
  ],
} as const satisfies Record<string, ReadonlyArray<Geometry.Display>>

/** Default pids follow the order the windows were given in, so raising a window keeps its pid. */
function withPids(windows: ReadonlyArray<WindowSpec>) {
  return windows.map((window, index) => ({ ...window, pid: window.pid ?? 1000 + index }))
}

function center(rect: Geometry.Rect | undefined): Geometry.Point {
  if (rect === undefined) return { x: 0, y: 0 }
  return { x: rect.x + Math.floor(rect.width / 2), y: rect.y + Math.floor(rect.height / 2) }
}

function within(outer: Geometry.Rect, inner: Geometry.Rect) {
  return (
    inner.width > 0 &&
    inner.height > 0 &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic image bytes

function encode(input: Driver.CaptureInput, region: Geometry.Rect, size: number | undefined) {
  if (size !== undefined) return sized(input.format, size)
  if (input.format === "jpeg")
    return sized("jpeg", Math.max(64, Math.floor((input.width * input.height * (input.quality ?? 85)) / 400)))
  return png(input.width, input.height, (x, y) => {
    // Each image pixel shows the 4x4 physical tile it samples, so crops and rescales of one desktop differ predictably
    // while the PNG compresses like a real screen (a few hundred KB, within `Budget.imageLimit`), not like noise.
    const px = (region.x + Math.floor(((x + 0.5) * region.width) / input.width)) >> 2
    const py = (region.y + Math.floor(((y + 0.5) * region.height) / input.height)) >> 2
    return [(px * 7) & 255, (py * 5) & 255, (px ^ py) & 255]
  })
}

/** A blob of exactly `size` bytes that starts with the format's signature (and ends with EOI for JPEG). */
function sized(format: "png" | "jpeg", size: number) {
  const data = new Uint8Array(size)
  data.set(format === "png" ? PNG_SIGNATURE : [0xff, 0xd8, 0xff, 0xe0])
  if (format === "jpeg") data.set([0xff, 0xd9], size - 2)
  return data
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function png(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number]) {
  const stride = width * 3 + 1
  const raw = new Uint8Array(stride * height)
  // Plain loops: this runs per pixel of display-sized captures. Each row starts with filter byte 0 (none).
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * stride + 1 + x * 3)
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  return concat([
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ])
}

function chunk(type: string, data: Uint8Array) {
  const body = concat([new TextEncoder().encode(type), data])
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(body, 4)
  view.setUint32(8 + data.length, crc32(body))
  return out
}

function concat(parts: ReadonlyArray<Uint8Array>) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.length
  }, 0)
  return out
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
)

function crc32(data: Uint8Array) {
  return (data.reduce((crc, byte) => CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0
}

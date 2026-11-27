export * as Driver from "./driver.js"

import { Effect, Schema, Stream } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import type { DriverError } from "../core/errors.js"
import { Geometry } from "../core/geometry.js"
import { Policy } from "../core/policy.js"

/**
 * The low-level desktop interface. Every method is one OS-level operation in physical pixels; composition (clicks,
 * chords, typing, the kill-switch checks between steps) lives in `actions.ts`, and policy, frames and leases in the
 * gate above that. Each method maps onto one request of the helper protocol (`own/native/own-cu-helper/README.md`),
 * which both Windows drivers speak (the in-process FFI worker and the helper exe), so they are thin transports; the
 * data schemas below double as that protocol's response decoders.
 */
export interface Driver {
  readonly kind: "windows" | "helper" | "fake"
  /** A fresh `hello` from the helper (cheap; the gate asks it before input to see whether the stop chord works). */
  readonly hello: Effect.Effect<Info, DriverError>
  readonly displays: Effect.Effect<ReadonlyArray<Geometry.Display>, DriverError>
  readonly capture: (input: CaptureInput) => Effect.Effect<Capture, DriverError>
  /** Physical cursor position. */
  readonly cursor: Effect.Effect<Geometry.Point, DriverError>
  readonly move: (point: Geometry.Point) => Effect.Effect<void, DriverError>
  readonly button: (button: Button, action: Press) => Effect.Effect<void, DriverError>
  /** Wheel notches: positive `dy` scrolls up (away from the user), positive `dx` scrolls right. */
  readonly wheel: (input: { readonly dx: number; readonly dy: number }) => Effect.Effect<void, DriverError>
  readonly key: (key: KeyInput, action: Press) => Effect.Effect<void, DriverError>
  /** Types text as KEYEVENTF_UNICODE characters (no IME composition, no layout dependence). */
  readonly text: (text: string) => Effect.Effect<void, DriverError>
  /** Top-level window under a physical point. */
  readonly windowAt: (point: Geometry.Point) => Effect.Effect<Policy.WindowInfo | undefined, DriverError>
  readonly foreground: Effect.Effect<Policy.WindowInfo | undefined, DriverError>
  /** Top-level windows in z-order, topmost first. */
  readonly windows: Effect.Effect<ReadonlyArray<Policy.WindowInfo>, DriverError>
  readonly focus: (windowId: string) => Effect.Effect<void, DriverError>
  /** The focused UI element of the foreground window (UI Automation), if any. */
  readonly focused: Effect.Effect<Policy.FocusInfo | undefined, DriverError>
  /** Releases every key and button this driver pressed. Never fails; called after any failed or interrupted action. */
  readonly releaseAll: Effect.Effect<void>
  /** The on-screen "agent is driving" indicator (excluded from captures by the helper). */
  readonly indicator: (input: { readonly on: boolean; readonly text?: string }) => Effect.Effect<void>
  /** Unsolicited driver events; one subscription per call. */
  readonly events: Stream.Stream<Event>
  /** Stops the driver (helper stdin EOF); releases held input first. */
  readonly close: Effect.Effect<void>
}

export const Button = Schema.Literals(["left", "right", "middle"])
export type Button = typeof Button.Type

export const Press = Schema.Literals(["down", "up"])
export type Press = typeof Press.Type

export const KeyInput = Schema.Struct({
  vk: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 254 })),
  extended: optional(Schema.Boolean),
})
export type KeyInput = typeof KeyInput.Type

export const Info = Schema.Struct({
  version: Schema.String,
  protocol: PositiveInt,
  /** `per_monitor_v2` when coordinates are physical; anything else is refused by the driver. */
  dpiAwareness: Schema.String,
  /** The helper runs on the interactive window station (WinSta0) and can reach the user's desktop. */
  interactive: Schema.Boolean,
  /** The input desktop is the normal desktop (not the lock screen, UAC or Ctrl+Alt+Del). */
  inputDesktop: Schema.Boolean,
  /**
   * The physical stop chord (Ctrl+Alt+Shift+Q) is registered. Another program can hold it; the gate then refuses input,
   * and asking `hello` again retries the registration.
   */
  killChord: Schema.Boolean,
})
export type Info = typeof Info.Type

export const CaptureInput = Schema.Struct({
  display: NonNegativeInt,
  /** Physical rectangle inside the display; default the whole display. */
  region: optional(Geometry.Rect),
  /** Output image size; the helper resizes with high-quality bicubic filtering. */
  width: PositiveInt,
  height: PositiveInt,
  format: Schema.Literals(["png", "jpeg"]),
  quality: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export type CaptureInput = typeof CaptureInput.Type

export interface Capture {
  readonly mime: "image/png" | "image/jpeg"
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  /** Physical cursor position at capture time, when it is on the captured display. */
  readonly cursor?: Geometry.Point
}

export const Event = Schema.Union([
  /** The physical stop chord (ctrl+alt+shift+q) was pressed. */
  Schema.TaggedStruct("kill_chord", {}),
  Schema.TaggedStruct("display_changed", {}),
  Schema.TaggedStruct("exited", { code: Schema.NullOr(Schema.Int) }),
])
export type Event = typeof Event.Type

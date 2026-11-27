export * as HelperProtocol from "./protocol.js"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { Geometry } from "../../core/geometry.js"
import { Policy } from "../../core/policy.js"

/**
 * The JSON-lines wire contract with `own-cu-helper.exe` (own/native/own-cu-helper/README.md §3), framed like
 * own-vault's (own/native/own-vault/README.md §5): one UTF-8 JSON object per line each way, `{op, rid, …args}` in,
 * `{ok, rid, …}` out in request order, and unsolicited event lines `{event}` without `rid`. Coordinates are physical
 * pixels (the helper is Per-Monitor-V2 DPI aware); the data shapes are the Driver schemas. The in-process driver's
 * desktop worker (ffi/desktop.ts) answers the same ops and shapes as `postMessage` objects instead of lines.
 */

export const PROTOCOL = 1

/** The helper's `hello.name`. */
export const NAME = "own-cu-helper"

/** Longest accepted helper line: a capture is at most 4.5 MB of base64, so anything near this is a broken stream. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024

export const Op = Schema.Literals([
  "hello",
  "displays",
  "capture",
  "cursor.get",
  "mouse.move",
  "mouse.button",
  "mouse.wheel",
  "key",
  "text",
  "window.at",
  "window.foreground",
  "windows.list",
  "window.focus",
  "focus.element",
  "release.all",
  "indicator",
])
export type Op = typeof Op.Type

/**
 * `ok:false` codes. `busy`: another helper holds the desktop mutex (`Local\own-open-code-computer-use`), e.g. a dev and
 * a prod service at once. `desktop_unavailable`: the desktop takes no input — the lock screen, UAC or Ctrl+Alt+Del, or
 * a remote-desktop client window showing the session is minimized.
 */
export const ErrorCode = Schema.Literals([
  "bad_request",
  "unknown_op",
  "busy",
  "desktop_unavailable",
  "unknown_window",
  "failed",
])
export type ErrorCode = typeof ErrorCode.Type

export const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  message: optional(Schema.String),
})
export type Failure = typeof Failure.Type

export const Hello = Schema.Struct({
  ok: Schema.Literal(true),
  name: Schema.String,
  version: Schema.String,
  protocol: PositiveInt,
  /** `per_monitor_v2`; anything else means virtualized coordinates and is refused. */
  dpiAwareness: Schema.String,
  interactive: Schema.Boolean,
  inputDesktop: Schema.Boolean,
  pid: optional(NonNegativeInt),
  /** The stop chord is registered (another program may hold it). */
  killChord: optional(Schema.Boolean),
})
export type Hello = typeof Hello.Type

export const Displays = Schema.Struct({ displays: Schema.Array(Geometry.Display) })

export const Capture = Schema.Struct({
  mime: Schema.Literals(["image/png", "image/jpeg"]),
  /** The encoded image: base64 in the helper's JSON line, the bytes themselves from the in-process worker. */
  data: Schema.Union([Schema.String, Schema.Uint8Array]),
  width: PositiveInt,
  height: PositiveInt,
  cursor: optional(Geometry.Point),
})

export const Cursor = Geometry.Point

export const Window = Schema.Struct({ window: Schema.NullOr(Policy.WindowInfo) })

export const Windows = Schema.Struct({ windows: Schema.Array(Policy.WindowInfo) })

export const Focus = Schema.Struct({ focus: Schema.NullOr(Policy.FocusInfo) })

/** Unsolicited lines. `kill_chord`: the physical stop chord (RegisterHotKey); `display_changed`: WM_DISPLAYCHANGE. */
export const Event = Schema.Struct({ event: Schema.Literals(["kill_chord", "display_changed"]) })
export type Event = typeof Event.Type

export * as Native from "./native.js"

/**
 * Pure Win32 data helpers of the in-process driver: struct packing and unpacking for x64 Windows, `SendInput` records,
 * GDI+ encoder parameters, monitor order and layout signatures. The worker sources (desktop.ts, uia.ts) carry every
 * function exported here as text (`String(fn)`), so each one may use only its parameters, JavaScript globals and the
 * other functions of this file: anything else at module level would be undefined inside the worker. Export functions
 * only (the worker sources include every export).
 */

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

/** One `SendInput` event: a virtual key or Unicode unit (`KEYBDINPUT`), or a mouse button or wheel (`MOUSEINPUT`). */
export type InputRecord =
  | { readonly kind: "key"; readonly vk: number; readonly scan: number; readonly flags: number }
  | { readonly kind: "mouse"; readonly flags: number; readonly data: number }

export interface Monitor {
  readonly handle: number
  readonly primary: boolean
  readonly bounds: Rect
  readonly scale: number
  readonly name: string
}

/** A NUL-terminated UTF-16 string for the `W` functions. */
export function wide(text: string) {
  return Uint16Array.from({ length: text.length + 1 }, (_, index) => (index < text.length ? text.charCodeAt(index) : 0))
}

/** A UTF-16 buffer up to its first NUL, or its first `length` units. */
export function unwide(units: Uint16Array, length?: number) {
  const end = length ?? units.indexOf(0)
  return new TextDecoder("utf-16le").decode(units.subarray(0, end < 0 ? units.length : end))
}

/** A GUID (`{8-4-4-4-12}`, braces optional) in memory order: Data1..3 little-endian, Data4 as written. */
export function guid(text: string) {
  const hex = text.replace(/[{}-]/g, "")
  const bytes = new Uint8Array(16)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16), true)
  view.setUint16(4, Number.parseInt(hex.slice(8, 12), 16), true)
  view.setUint16(6, Number.parseInt(hex.slice(12, 16), 16), true)
  bytes.set(
    Array.from({ length: 8 }, (_, index) => Number.parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16)),
    8,
  )
  return bytes
}

/** `RECT` (left, top, right, bottom) as x, y, width, height. */
export function rect(values: Int32Array) {
  return { x: values[0]!, y: values[1]!, width: values[2]! - values[0]!, height: values[3]! - values[1]! }
}

/** A `POINT` passed by value: x64 passes an 8-byte struct in one register, x in the low half. */
export function pointArgument(point: Point) {
  return ((BigInt(point.y) & 0xffffffffn) << 32n) | (BigInt(point.x) & 0xffffffffn)
}

export function contains(outer: Rect, inner: Rect) {
  return (
    inner.width > 0 &&
    inner.height > 0 &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

export function containsPoint(outer: Rect, point: Point) {
  return point.x >= outer.x && point.y >= outer.y && point.x < outer.x + outer.width && point.y < outer.y + outer.height
}

/**
 * `INPUT[]` for `SendInput` on x64: 40 bytes per event, `type` at 0 and the union at 8. `KEYBDINPUT`: wVk, wScan,
 * dwFlags at 8, 10, 12; `MOUSEINPUT`: mouseData and dwFlags at 16 and 20 (dx, dy, time and dwExtraInfo stay 0).
 */
export function inputs(records: ReadonlyArray<InputRecord>) {
  const bytes = new Uint8Array(records.length * 40)
  const view = new DataView(bytes.buffer)
  records.forEach((record, index) => {
    const at = index * 40
    if (record.kind === "mouse") {
      // INPUT_MOUSE
      view.setUint32(at, 0, true)
      view.setInt32(at + 16, record.data, true)
      view.setUint32(at + 20, record.flags, true)
      return
    }
    // INPUT_KEYBOARD
    view.setUint32(at, 1, true)
    view.setUint16(at + 8, record.vk, true)
    view.setUint16(at + 10, record.scan, true)
    view.setUint32(at + 12, record.flags, true)
  })
  return bytes
}

/** A virtual key down or up; `extended` keys carry the E0 prefix (KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP). */
export function keyRecord(vk: number, scan: number, extended: boolean, up: boolean): InputRecord {
  return { kind: "key", vk, scan, flags: (extended ? 0x0001 : 0) | (up ? 0x0002 : 0) }
}

/**
 * Text as KEYEVENTF_UNICODE presses, one down and up per UTF-16 unit (a surrogate pair goes as its two units and the
 * target joins them), so neither the keyboard layout nor an IME changes what arrives. A line break (`\n`, `\r\n` or
 * `\r`) presses Return instead, which apps treat as Enter where U+000A is ignored.
 */
export function textRecords(text: string, returnScan: number): Array<InputRecord> {
  return Array.from({ length: text.length }, (_, index) => index).flatMap((index): Array<InputRecord> => {
    const unit = text.charCodeAt(index)
    if (unit === 13 && text.charCodeAt(index + 1) === 10) return []
    if (unit === 10 || unit === 13)
      return [keyRecord(0x0d, returnScan, false, false), keyRecord(0x0d, returnScan, false, true)]
    return [
      { kind: "key", vk: 0, scan: unit, flags: 0x0004 },
      { kind: "key", vk: 0, scan: unit, flags: 0x0004 | 0x0002 },
    ]
  })
}

/** Wheel notches of 120 (WHEEL_DELTA): positive `dy` scrolls up, positive `dx` right. */
export function wheelRecords(dx: number, dy: number): Array<InputRecord> {
  return [
    ...(dy === 0 ? [] : [{ kind: "mouse" as const, flags: 0x0800, data: dy * 120 }]),
    ...(dx === 0 ? [] : [{ kind: "mouse" as const, flags: 0x1000, data: dx * 120 }]),
  ]
}

/** MOUSEEVENTF_{LEFT,RIGHT,MIDDLE}{DOWN,UP}. */
export function buttonFlags(button: string, up: boolean) {
  if (button === "left") return up ? 0x0004 : 0x0002
  if (button === "right") return up ? 0x0010 : 0x0008
  return up ? 0x0040 : 0x0020
}

/** The tracked id of a pressed key: the virtual key, plus 0x100 when it is extended (as the helper tracks them). */
export function keyId(vk: number, extended: boolean) {
  return vk | (extended ? 0x100 : 0)
}

/** A top-down 24 bpp `BITMAPINFO` (40-byte header and one unused RGBQUAD) for `CreateDIBSection`. */
export function bitmapInfo(width: number, height: number) {
  const bytes = new Uint8Array(44)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 40, true)
  view.setInt32(4, width, true)
  // Negative height: rows top to bottom, so the bits are a GDI+ scan0 with a positive stride.
  view.setInt32(8, -height, true)
  view.setUint16(12, 1, true)
  view.setUint16(14, 24, true)
  return bytes
}

/** Bytes per row of a 24 bpp DIB (rows are padded to 4 bytes). */
export function stride(width: number) {
  return (width * 3 + 3) & ~3
}

/**
 * Fills `bytes` (48) with GDI+ `EncoderParameters` holding one `EncoderQuality` long: Count at 0, the 32-byte
 * `EncoderParameter` at 8 (GUID, NumberOfValues, Type 4 = long, Value pointer), and the quality itself at 40, where
 * Value points (`address` is the address of `bytes`, so the value lives exactly as long as the parameters).
 */
export function qualityParameters(bytes: Uint8Array, address: number, quality: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 48)
  view.setUint32(0, 1, true)
  bytes.set(guid("1D5BE4B5-FA4A-452D-9CDD-5DB35105E7EB"), 8)
  view.setUint32(24, 1, true)
  view.setUint32(28, 4, true)
  view.setBigUint64(32, BigInt(address + 40), true)
  view.setUint32(40, quality, true)
  return bytes
}

/** `MONITORINFOEXW` (104 bytes): rcMonitor at 4, dwFlags at 36 (MONITORINFOF_PRIMARY), szDevice at 40. */
export function monitorInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 104)
  return {
    bounds: rect(Int32Array.from({ length: 4 }, (_, index) => view.getInt32(4 + index * 4, true))),
    primary: (view.getUint32(36, true) & 1) !== 0,
    name: unwide(new Uint16Array(bytes.buffer.slice(bytes.byteOffset + 40, bytes.byteOffset + 104))),
  }
}

/** Display ids 0..n-1: the primary first, then left to right and top to bottom, like the helper. */
export function orderMonitors(monitors: ReadonlyArray<Monitor>) {
  return monitors
    .toSorted((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1
      if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x
      return a.bounds.y - b.bounds.y
    })
    .map((monitor, id) => ({ ...monitor, id }))
}

/** What a display change alters (bounds, DPI scale, primary), independent of enumeration order. */
export function layoutSignature(monitors: ReadonlyArray<Pick<Monitor, "primary" | "bounds" | "scale">>) {
  return monitors
    .map(
      (monitor) =>
        `${monitor.primary ? "*" : ""}${monitor.bounds.x},${monitor.bounds.y},${monitor.bounds.width}x${monitor.bounds.height}@${monitor.scale}`,
    )
    .toSorted()
    .join(";")
}

/** The protocol's window id: the HWND in hex (`0x1a2b`). */
export function windowId(hwnd: number) {
  return `0x${hwnd.toString(16)}`
}

export function parseWindowId(id: string) {
  return /^0x[0-9a-f]{1,16}$/i.test(id) ? Number.parseInt(id.slice(2), 16) : undefined
}

/** The image file name of a full process path. */
export function fileName(path: string) {
  return path.slice(path.lastIndexOf("\\") + 1)
}

/**
 * A UI Automation control type id (`UIA_ButtonControlTypeId` = 50000 …) as the helper named it (managed
 * `ControlType.Edit` → `Edit`); `undefined` for ids it did not know.
 */
export function controlTypeName(id: number) {
  return [
    "Button",
    "Calendar",
    "CheckBox",
    "ComboBox",
    "Edit",
    "Hyperlink",
    "Image",
    "ListItem",
    "List",
    "Menu",
    "MenuBar",
    "MenuItem",
    "ProgressBar",
    "RadioButton",
    "ScrollBar",
    "Slider",
    "Spinner",
    "StatusBar",
    "Tab",
    "TabItem",
    "Text",
    "ToolBar",
    "ToolTip",
    "Tree",
    "TreeItem",
    "Custom",
    "Group",
    "Thumb",
    "DataGrid",
    "DataItem",
    "Document",
    "SplitButton",
    "Window",
    "Pane",
    "Header",
    "HeaderItem",
    "Table",
    "TitleBar",
    "Separator",
    "SemanticZoom",
    "AppBar",
  ][id - 50000]
}

/** A failure the worker answers as `{ok: false, error: code, message}` (protocol error codes). */
export function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}

/** A worker answer for a thrown value: its protocol code, else `failed`. */
export function failed(error: unknown) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "failed"
  return { ok: false, error: code, message: error instanceof Error ? error.message : String(error) }
}

/** `0x80004005`-style text of an HRESULT or Win32 status. */
export function hex(value: number) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`
}

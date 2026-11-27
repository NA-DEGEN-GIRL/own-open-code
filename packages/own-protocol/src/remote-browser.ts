export * as RemoteBrowser from "./remote-browser.js"

/**
 * 휴대폰·다른 PC에서 보는 앱 안 브라우저 (05 §8.10, decisions MBR): the wire contract between a paired device's viewer
 * (own-web), the gateway's hub (own-remote) and the desktop shell that owns the pane (own-desktop main).
 *
 * ```text
 * viewer (own-web on a device) ⇄ WebSocket `/own/browser/<serverKey>/<sessionID>` on the gateway (device auth, scopes)
 *     text: ClientMessage → / ← ServerMessage      binary: ← one frame ({@link encodeFrame})
 * hub (own-remote, in the service) ⇄ desktop shell main: RPC `own.remote` `browser.host.*` (`local`: never a device)
 *     pull → {views, commands}   frame, state, result ←
 * ```
 *
 * Plain TypeScript and hand-written checks, no schema library: the shell's main process and own-web's lazy viewer
 * chunk import it by source. Everything a device sends is checked by {@link parseClientMessage} at the gateway, the
 * boundary that owns it; the hub and the shell get typed values.
 */

export const VERSION = 1

/** The device scope (05 §13.5): view with `read`; input, navigation and asking the PC to attach need `prompt` too. */
export const SCOPE = "browser"

/**
 * `GET /own/browser/<serverKey>/<sessionID>` with `Upgrade: websocket`: `local` for this PC's service, an SSH host's
 * id for a conversation on that host (05 §8.6, §8.10.8: the PC's desktop pane holds both).
 */
export const SOCKET_PATH = "/own/browser"

export function socketPath(serverKey: string, sessionID: string) {
  return `${SOCKET_PATH}/${encodeURIComponent(serverKey)}/${encodeURIComponent(sessionID)}`
}

/** The server key of this PC's own service. */
export const LOCAL = "local"

/**
 * The hub's and the shell's name of one session's pane: the session id for this PC's service (what a shell before
 * SSH panes reported), `<serverKey>/<sessionID>` for an SSH host's. Neither a session id nor a host id holds `/`.
 */
export function paneKey(serverKey: string, sessionID: string) {
  return serverKey === LOCAL ? sessionID : `${serverKey}/${sessionID}`
}

/** {@link paneKey} back into its parts. */
export function paneOf(key: string): { readonly serverKey: string; readonly sessionID: string } {
  const slash = key.indexOf("/")
  return slash < 0 ? { serverKey: LOCAL, sessionID: key } : { serverKey: key.slice(0, slash), sessionID: key.slice(slash + 1) }
}

/** The pane key of a view or a command: `serverKey` absent is this PC's service. */
export function keyOf(item: { readonly serverKey?: string; readonly sessionID: string }) {
  return paneKey(item.serverKey ?? LOCAL, item.sessionID)
}

/** Close codes of the viewer socket. 4401 is the gateway's `device revoked` (every socket of the device). */
export const CLOSE = {
  revoked: 4401,
  /** The device lost the `browser` scope or the server (a scope change closes its sockets, like revocation). */
  scope: 4403,
  /** The first message was not a valid `hello`, or a later one broke the contract. */
  protocol: 4400,
  /** The gateway is closing or the hub was replaced. */
  away: 4410,
  /** Too many viewers (per device or in all): try again later. */
  busy: 1013,
} as const

// ---------------------------------------------------------------------------------------------------------------
// Limits (a device is not trusted: the gateway drops what exceeds them)

/** One text message from a viewer. */
export const MAX_MESSAGE_BYTES = 16 * 1024
export const MAX_EVENTS = 64
export const MAX_TEXT = 2000
export const MAX_URL = 2048
export const MAX_POINTS = 5
/** One JPEG frame from the shell (base64 is a third larger on the RPC). */
export const MAX_FRAME_BYTES = 1536 * 1024
/** Viewer view area in CSS px, each side. */
export const MIN_SIDE = 160
export const MAX_SIDE = 4096
export const MAX_DPR = 4

// ---------------------------------------------------------------------------------------------------------------
// Shared shapes

/**
 * - `pc`: the pane keeps its own size; frames are scaled to the viewer.
 * - `phone` (`휴대폰 크기로 보기`): the shell emulates the viewer's viewport, touch and a mobile user agent in the pane
 *   while a viewer asks for it, and clears the emulation when the last one leaves or goes hidden.
 */
export type Mode = "pc" | "phone"

/** `auto`: quick frames while the page changes, one sharp frame once it rests. `low` (data saver): quick frames only. */
export type Quality = "auto" | "low"

/** The viewer's view area in CSS px and its device pixel ratio. */
export interface Viewport {
  readonly width: number
  readonly height: number
  readonly dpr: number
}

export interface Point {
  readonly id: number
  /** 0..1 of the frame (the page's viewport), left to right and top to bottom. */
  readonly x: number
  readonly y: number
}

export const KEYS = [
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
] as const
export type NamedKey = (typeof KEYS)[number]

/**
 * What a viewer does to the page. Positions are fractions of the frame, so they hold whatever size the frame was
 * scaled to. A phone sends `touch` (the page sees real touches: scrolling, taps, swipes); a PC viewer sends `mouse`
 * and `wheel`. Typing: `compose` while an IME is composing (the page shows it underlined), `text` for committed
 * text (it replaces the composition), `key` for the named keys and for chords with a single character.
 */
export type InputEvent =
  | { readonly k: "touch"; readonly phase: "start" | "move" | "end" | "cancel"; readonly points: ReadonlyArray<Point> }
  | {
      readonly k: "mouse"
      readonly phase: "down" | "up" | "move"
      readonly x: number
      readonly y: number
      readonly button: "left" | "right" | "middle" | "none"
      readonly clicks?: number
    }
  /** `dx`, `dy`: CSS px of the page, positive scrolls right and down. */
  | { readonly k: "wheel"; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | {
      readonly k: "key"
      /** A {@link NamedKey}, or one character for a chord (`a` with `ctrl`). */
      readonly key: string
      readonly shift?: boolean
      readonly ctrl?: boolean
      readonly alt?: boolean
      readonly meta?: boolean
    }
  | { readonly k: "text"; readonly text: string }
  /** The composing text as it is now; empty cancels the composition. */
  | { readonly k: "compose"; readonly text: string }

/** Navigation and tabs, as the desktop pane's own controls send them, on the session's focused tab. */
export type Action =
  /** An http(s) address (the viewer turns search words into one, like the desktop address field). Opens a tab when none. */
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "reload" }
  | { readonly type: "stop" }
  | { readonly type: "tabs.open"; readonly url?: string }
  | { readonly type: "tabs.focus"; readonly tabID: string }
  | { readonly type: "tabs.close"; readonly tabID: string }
  /** Answers the page's open JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`). */
  | { readonly type: "dialog"; readonly accept: boolean; readonly text?: string }

export interface Tab {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly loadError?: string
}

export interface Dialog {
  readonly type: "alert" | "confirm" | "prompt" | "beforeunload"
  readonly message: string
  readonly defaultPrompt: string
}

/** What the shell reports about one session's pane (`browser.host.state`). */
export interface PaneState {
  readonly tabs: ReadonlyArray<Tab>
  readonly focusedTabID: string | null
  /** The focused page's viewport now, in CSS px, and whether the phone emulation is on. */
  readonly page: { readonly mode: Mode; readonly width: number; readonly height: number } | null
  readonly dialog: Dialog | null
}

/**
 * Things that happened in the pane that a device is told about but never handed (05 §8.10 "휴대폰으로 넘기지 않는 것"):
 * a download stays in the PC's temp folder for the agent and `PC에 저장`, a file chooser is cancelled, a page's
 * permission request is refused as always.
 */
export type Notice = "download" | "file_chooser"

/**
 * - `ready`: the desktop shell holds this session's pane and streams it.
 * - `attaching`: the desktop app was asked to attach the session's pane; frames follow.
 * - `absent`: no desktop app is running on the PC (or its window is closed): nothing to show.
 * - `detached`: a desktop app runs but this session has no pane, and this device may not ask for one (no `prompt`).
 */
export type HostState = "ready" | "attaching" | "absent" | "detached"

export interface ViewState extends PaneState {
  readonly host: HostState
}

export const EMPTY_PANE: PaneState = { tabs: [], focusedTabID: null, page: null, dialog: null }

// ---------------------------------------------------------------------------------------------------------------
// Viewer ⇄ gateway

export type ClientMessage =
  /** The first message. `visible: false` opens without frames (the view is behind another screen). */
  | {
      readonly t: "hello"
      readonly v: number
      readonly viewport: Viewport
      readonly mode: Mode
      readonly quality: Quality
      readonly visible: boolean
    }
  /** Any of the view's settings changed. Hidden views get no frames and keep no phone emulation. */
  | {
      readonly t: "view"
      readonly viewport?: Viewport
      readonly mode?: Mode
      readonly quality?: Quality
      readonly visible?: boolean
    }
  /** Frame `seq` was drawn: the shell sends the next one (flow control, so a slow link gets fewer frames). */
  | { readonly t: "ack"; readonly seq: number }
  | { readonly t: "input"; readonly events: ReadonlyArray<InputEvent> }
  /** `id` comes back in the `result`. */
  | { readonly t: "action"; readonly id: number; readonly action: Action }

export type ServerMessage =
  /** After `hello`. `control`: this device may send `input` and `action` (it holds `prompt`). */
  | { readonly t: "ready"; readonly v: number; readonly control: boolean }
  | { readonly t: "state"; readonly state: ViewState }
  | { readonly t: "result"; readonly id: number; readonly ok: boolean; readonly error?: string }
  | { readonly t: "notice"; readonly kind: Notice }

/** `error` of a failed action, besides a refused address's code from the shell (`browser.address.*`). */
export const ACTION_ERROR = {
  /** The device may only watch. */
  readOnly: "read_only",
  /** No desktop shell holds the pane now. */
  noHost: "no_host",
  timeout: "timeout",
  failed: "failed",
} as const

// ---------------------------------------------------------------------------------------------------------------
// Frames (gateway → viewer, binary)

/**
 * One frame on the viewer socket: 16 bytes, then the JPEG.
 *
 * | bytes | value |
 * |---|---|
 * | 0–3 | `OBF1` |
 * | 4–7 | `seq` (uint32, big endian): the viewer acknowledges it |
 * | 8–9, 10–11 | the frame's width and height in px (uint16) |
 * | 12 | flags: bit 0 = sharp (the page rested; no better frame follows until it changes) |
 * | 13–15 | 0 |
 */
export const FRAME_HEADER_BYTES = 16
const MAGIC = [0x4f, 0x42, 0x46, 0x31] as const

export interface FrameHeader {
  readonly seq: number
  readonly width: number
  readonly height: number
  readonly sharp: boolean
}

export function encodeFrame(header: FrameHeader, jpeg: Uint8Array) {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + jpeg.byteLength)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint32(4, header.seq >>> 0)
  view.setUint16(8, clamp(header.width, 0, 0xffff))
  view.setUint16(10, clamp(header.height, 0, 0xffff))
  view.setUint8(12, header.sharp ? 1 : 0)
  bytes.set(jpeg, FRAME_HEADER_BYTES)
  return bytes
}

export function decodeFrame(bytes: Uint8Array): { readonly header: FrameHeader; readonly jpeg: Uint8Array } | undefined {
  if (bytes.byteLength <= FRAME_HEADER_BYTES || MAGIC.some((value, index) => bytes[index] !== value)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    header: {
      seq: view.getUint32(4),
      width: view.getUint16(8),
      height: view.getUint16(10),
      sharp: (view.getUint8(12) & 1) === 1,
    },
    jpeg: bytes.subarray(FRAME_HEADER_BYTES),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hub ⇄ desktop shell (RPC `own.remote` `browser.host.*`; the schemas in rpc-remote.ts mirror these)

/**
 * What the hub wants streamed now: the session's focused tab, for the visible viewers of that session. `serverKey`:
 * the SSH host the session runs on; absent for this PC's service (as every view of a hub before SSH panes).
 */
export interface HostView {
  readonly serverKey?: string
  readonly sessionID: string
  readonly mode: Mode
  readonly quality: Quality
  /** The viewport the phone emulation takes (`mode: "phone"`) and the frame size the viewer can show. */
  readonly viewport: Viewport
}

export type HostCommand =
  | {
      readonly type: "input"
      readonly serverKey?: string
      readonly sessionID: string
      readonly events: ReadonlyArray<InputEvent>
    }
  /** Answered with `browser.host.result{id}`. */
  | {
      readonly type: "action"
      readonly serverKey?: string
      readonly sessionID: string
      readonly id: string
      readonly action: Action
    }

// ---------------------------------------------------------------------------------------------------------------
// Checks

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, Math.round(value)))
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function unit(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1
}

function flag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max
}

export function isMode(value: unknown): value is Mode {
  return value === "pc" || value === "phone"
}

export function isQuality(value: unknown): value is Quality {
  return value === "auto" || value === "low"
}

/** A viewport within the limits, sides and ratio rounded to what the shell emulates. */
export function parseViewport(value: unknown): Viewport | undefined {
  const input = record(value)
  if (!input || !finite(input.width) || !finite(input.height) || !finite(input.dpr)) return undefined
  if (input.width < MIN_SIDE || input.width > MAX_SIDE || input.height < MIN_SIDE || input.height > MAX_SIDE)
    return undefined
  if (input.dpr < 0.5 || input.dpr > MAX_DPR) return undefined
  return { width: Math.round(input.width), height: Math.round(input.height), dpr: Math.round(input.dpr * 10_000) / 10_000 }
}

function parsePoint(value: unknown): Point | undefined {
  const input = record(value)
  if (!input || !Number.isInteger(input.id) || !unit(input.x) || !unit(input.y)) return undefined
  const id = input.id as number
  return id >= 0 && id < 64 ? { id, x: input.x, y: input.y } : undefined
}

export function isKey(value: unknown): value is string {
  if (typeof value !== "string") return false
  return (KEYS as ReadonlyArray<string>).includes(value) || [...value].length === 1
}

export function parseInputEvent(value: unknown): InputEvent | undefined {
  const input = record(value)
  if (!input) return undefined
  if (input.k === "touch") {
    const phase = input.phase
    if (phase !== "start" && phase !== "move" && phase !== "end" && phase !== "cancel") return undefined
    if (!Array.isArray(input.points) || input.points.length > MAX_POINTS) return undefined
    const points = input.points.map(parsePoint)
    if (points.some((point) => point === undefined)) return undefined
    return { k: "touch", phase, points: points as Point[] }
  }
  if (input.k === "mouse") {
    const phase = input.phase
    const button = input.button
    if (phase !== "down" && phase !== "up" && phase !== "move") return undefined
    if (button !== "left" && button !== "right" && button !== "middle" && button !== "none") return undefined
    if (!unit(input.x) || !unit(input.y)) return undefined
    if (input.clicks !== undefined && (!Number.isInteger(input.clicks) || (input.clicks as number) < 1 || (input.clicks as number) > 3))
      return undefined
    return {
      k: "mouse",
      phase,
      x: input.x,
      y: input.y,
      button,
      ...(input.clicks === undefined ? {} : { clicks: input.clicks as number }),
    }
  }
  if (input.k === "wheel") {
    if (!unit(input.x) || !unit(input.y) || !finite(input.dx) || !finite(input.dy)) return undefined
    return { k: "wheel", x: input.x, y: input.y, dx: clamp(input.dx, -10_000, 10_000), dy: clamp(input.dy, -10_000, 10_000) }
  }
  if (input.k === "key") {
    if (!isKey(input.key)) return undefined
    if (!flag(input.shift) || !flag(input.ctrl) || !flag(input.alt) || !flag(input.meta)) return undefined
    return {
      k: "key",
      key: input.key,
      ...(input.shift ? { shift: true } : {}),
      ...(input.ctrl ? { ctrl: true } : {}),
      ...(input.alt ? { alt: true } : {}),
      ...(input.meta ? { meta: true } : {}),
    }
  }
  if (input.k === "text") return text(input.text, MAX_TEXT) && input.text.length > 0 ? { k: "text", text: input.text } : undefined
  if (input.k === "compose") return text(input.text, MAX_TEXT) ? { k: "compose", text: input.text } : undefined
  return undefined
}

/** An http(s) URL a viewer may ask the pane to open; the shell applies the pane's own address rules after it. */
export function isAddress(value: unknown): value is string {
  if (!text(value, MAX_URL)) return false
  const url = URL.parse(value)
  return url !== null && (url.protocol === "http:" || url.protocol === "https:")
}

export function parseAction(value: unknown): Action | undefined {
  const input = record(value)
  if (!input) return undefined
  switch (input.type) {
    case "navigate":
      return isAddress(input.url) ? { type: "navigate", url: input.url } : undefined
    case "back":
    case "forward":
    case "reload":
    case "stop":
      return { type: input.type }
    case "tabs.open":
      if (input.url === undefined) return { type: "tabs.open" }
      return isAddress(input.url) ? { type: "tabs.open", url: input.url } : undefined
    case "tabs.focus":
    case "tabs.close":
      return text(input.tabID, 128) && input.tabID.length > 0 ? { type: input.type, tabID: input.tabID } : undefined
    case "dialog":
      if (typeof input.accept !== "boolean") return undefined
      if (input.text !== undefined && !text(input.text, MAX_TEXT)) return undefined
      return { type: "dialog", accept: input.accept, ...(input.text === undefined ? {} : { text: input.text as string }) }
    default:
      return undefined
  }
}

/** One text message of a viewer, or `undefined` when it is not one (the gateway closes the socket with `protocol`). */
export function parseClientMessage(data: string): ClientMessage | undefined {
  if (data.length > MAX_MESSAGE_BYTES) return undefined
  const input = record(safeJson(data))
  if (!input) return undefined
  if (input.t === "hello") {
    const viewport = parseViewport(input.viewport)
    if (input.v !== VERSION || !viewport || !isMode(input.mode) || !isQuality(input.quality)) return undefined
    if (typeof input.visible !== "boolean") return undefined
    return { t: "hello", v: VERSION, viewport, mode: input.mode, quality: input.quality, visible: input.visible }
  }
  if (input.t === "view") {
    const viewport = input.viewport === undefined ? undefined : parseViewport(input.viewport)
    if (input.viewport !== undefined && !viewport) return undefined
    if (input.mode !== undefined && !isMode(input.mode)) return undefined
    if (input.quality !== undefined && !isQuality(input.quality)) return undefined
    if (!flag(input.visible)) return undefined
    return {
      t: "view",
      ...(viewport ? { viewport } : {}),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.quality === undefined ? {} : { quality: input.quality }),
      ...(input.visible === undefined ? {} : { visible: input.visible }),
    }
  }
  if (input.t === "ack") return Number.isInteger(input.seq) && (input.seq as number) >= 0 ? { t: "ack", seq: input.seq as number } : undefined
  if (input.t === "input") {
    if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > MAX_EVENTS) return undefined
    const events = input.events.map(parseInputEvent)
    if (events.some((event) => event === undefined)) return undefined
    return { t: "input", events: events as InputEvent[] }
  }
  if (input.t === "action") {
    const action = parseAction(input.action)
    if (!action || !Number.isInteger(input.id) || (input.id as number) < 0) return undefined
    return { t: "action", id: input.id as number, action }
  }
  return undefined
}

function safeJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Typing from a soft keyboard (pure; the viewer's hidden field feeds it)

/**
 * The input events for one change of the viewer's hidden text field. A phone keyboard reports no keys (every key is
 * 229, "composing"); it only changes the field. So the viewer keeps the field's last text and sends the difference:
 * backspaces for what went away, then the new text; while an IME is composing, the composing segment goes as
 * `compose` so the page shows the syllable being built (한글 조합), and the committed text follows as `text`.
 *
 * `before`/`after`: the field's text before and after the change, without the composing segment. `composing`: the
 * segment being composed after the change (`""` when none), `composed`: the one before it.
 */
export function typed(input: {
  readonly before: string
  readonly after: string
  readonly composed: string
  readonly composing: string
}): InputEvent[] {
  const before = [...input.before]
  const after = [...input.after]
  let same = 0
  while (same < before.length && same < after.length && before[same] === after[same]) same++
  const removed = before.length - same
  const added = after.slice(same).join("")
  // A backspace must not land in an open composition, and committed text replaces it in the page: either way the
  // page has no composition left before the new segment is set.
  const cancelled = removed > 0 && input.composed !== ""
  const open = cancelled || added !== "" ? "" : input.composed
  const composing = input.composing.slice(0, MAX_TEXT)
  return [
    ...(cancelled ? [{ k: "compose", text: "" } as const] : []),
    ...Array.from({ length: removed }, () => ({ k: "key", key: "Backspace" }) as const),
    ...Array.from({ length: Math.ceil(added.length / MAX_TEXT) }, (_, index) => ({
      k: "text" as const,
      text: added.slice(index * MAX_TEXT, (index + 1) * MAX_TEXT),
    })),
    ...(composing === open ? [] : [{ k: "compose", text: composing } as const]),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Frame pacing (pure; the shell's capture loop follows it)

/** The longest side of a quick frame and of a sharp one, in px, and their JPEG qualities. */
export const FRAME = {
  quick: { side: 720, quality: 55 },
  sharp: { side: 1600, quality: 80 },
  /** Data saver: smaller quick frames, no sharp one. */
  low: { side: 540, quality: 45 },
} as const

/** A frame no viewer acknowledged within this is given up on: the next one is sent (a stalled link, a hidden tab). */
export const ACK_TIMEOUT_MS = 2000
/** The page counts as resting this long after its last change: then one sharp frame (`auto`). */
export const REST_MS = 450
/** The shortest time between two quick frames (about 12 a second on a fast link). */
export const MIN_FRAME_GAP_MS = 80

/**
 * The scale that fits a page of `width`×`height` CSS px at `pageDpr` into what the viewer can show, capped by the
 * quality's longest side: never larger than the viewer's own pixels, never upscaled.
 */
export function frameScale(input: {
  readonly width: number
  readonly height: number
  readonly pageDpr: number
  readonly viewport: Viewport
  readonly side: number
}) {
  const native = Math.max(input.width, input.height) * input.pageDpr
  const shown = Math.max(input.viewport.width, input.viewport.height) * input.viewport.dpr
  const target = Math.min(native, shown, input.side)
  return native <= 0 ? 1 : Math.min(1, target / native)
}

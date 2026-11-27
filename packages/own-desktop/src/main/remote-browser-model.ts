// What the bridge to paired devices decides (05 §8.10), without Electron (test/remote-browser.test.ts): when a frame
// goes out, how a device's input and actions become CDP commands and pane actions, the phone emulation's commands and
// what the pane reports. remote-browser.ts does the I/O. The wire contract is `RemoteBrowser`
// (packages/own-protocol/src/remote-browser.ts; imported by source, own-desktop has no dependency on it).
import { RemoteBrowser } from "../../../own-protocol/src/remote-browser"
import type { Browser } from "../../../plugin-browser/src/rpc"

export interface CdpCommand {
  readonly method: string
  readonly params: Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------------------------
// Pacing

export interface PaceInput {
  readonly now: number
  /** A frame is on its way to the hub (it answers at the first viewer's ack, or after `ACK_TIMEOUT_MS`). */
  readonly sending: boolean
  /** When the last frame started on its way; `-Infinity` before the first. */
  readonly sentAt: number
  /** A frame that differs from the last one sent is waiting. */
  readonly pending: boolean
  /** When the page last changed, or the view asked for a fresh frame. */
  readonly changedAt: number
  /** Nothing is owed for the page as it rests now: the sharp frame went out, or none is due. */
  readonly rested: boolean
  readonly quality: RemoteBrowser.Quality
}

export type PaceStep =
  /** Nothing to do until something happens (a frame arrives, the push is answered). */
  | { readonly do: "idle" }
  | { readonly do: "wait"; readonly ms: number }
  /** Send the waiting frame (`FRAME.quick`, or `FRAME.low` in data saver). */
  | { readonly do: "quick" }
  /** The page rested for `REST_MS`: capture and send one sharp frame (`FRAME.sharp`). */
  | { readonly do: "sharp" }
  /** The page rested and data saver takes no sharp frame: nothing is owed. */
  | { readonly do: "rest" }

/**
 * The next step of one session's stream. One frame is on its way at a time, quick frames keep `MIN_FRAME_GAP_MS`
 * between their starts, and a page that stayed the same for `REST_MS` gets one sharp frame unless the viewer saves data.
 */
export function pace(input: PaceInput): PaceStep {
  if (input.sending) return { do: "idle" }
  if (input.pending) {
    const gate = input.sentAt + RemoteBrowser.MIN_FRAME_GAP_MS
    return input.now < gate ? { do: "wait", ms: gate - input.now } : { do: "quick" }
  }
  if (input.rested) return { do: "idle" }
  const rest = input.changedAt + RemoteBrowser.REST_MS
  if (input.now < rest) return { do: "wait", ms: rest - input.now }
  return input.quality === "low" ? { do: "rest" } : { do: "sharp" }
}

export function quickTier(quality: RemoteBrowser.Quality) {
  return quality === "low" ? RemoteBrowser.FRAME.low : RemoteBrowser.FRAME.quick
}

/** The focused page's viewport in CSS px and how many device px one of them is. */
export interface PageMetrics {
  readonly width: number
  readonly height: number
  readonly dpr: number
  /** The viewport's place in the document, for a screenshot's clip. */
  readonly x: number
  readonly y: number
}

/**
 * Asks the page for its viewport. `Page.getLayoutMetrics` does not serve: its sizes leave the scrollbar out (the
 * frame has it, so every position would be off by its share) and its device px ignore an emulated pixel ratio.
 */
export const METRICS_COMMAND: CdpCommand = {
  method: "Runtime.evaluate",
  params: { expression: "[innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY]", returnByValue: true },
}

/** The answer to {@link METRICS_COMMAND}; undefined when it is not one (a page that replaced the globals, an error). */
export function pageMetrics(answer: unknown): PageMetrics | undefined {
  const value = field(field(answer, "result"), "value")
  if (!Array.isArray(value)) return undefined
  const [width, height, dpr, x, y] = value.map(number)
  if (!width || !height || !dpr || width <= 0 || height <= 0 || dpr <= 0) return undefined
  return { width, height, dpr, x: Math.max(0, x ?? 0), y: Math.max(0, y ?? 0) }
}

/** The frame's size in px for a tier: the page fitted into what the viewer shows, never above the tier's side. */
export function frameSize(
  metrics: PageMetrics,
  viewport: RemoteBrowser.Viewport,
  tier: { readonly side: number },
  shrink = 1,
) {
  const scale =
    shrink *
    RemoteBrowser.frameScale({
      width: metrics.width,
      height: metrics.height,
      pageDpr: metrics.dpr,
      viewport,
      side: tier.side,
    })
  return {
    scale,
    width: Math.max(1, Math.round(metrics.width * metrics.dpr * scale)),
    height: Math.max(1, Math.round(metrics.height * metrics.dpr * scale)),
  }
}

export function screencastCommand(
  metrics: PageMetrics,
  view: Pick<RemoteBrowser.HostView, "viewport" | "quality">,
): CdpCommand {
  const tier = quickTier(view.quality)
  const size = frameSize(metrics, view.viewport, tier)
  return {
    method: "Page.startScreencast",
    params: { format: "jpeg", quality: tier.quality, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 },
  }
}

/** One screenshot of the viewport at a tier; `shrink` < 1 makes a frame that came out too large smaller. */
export function screenshotCommand(
  metrics: PageMetrics,
  viewport: RemoteBrowser.Viewport,
  tier: { readonly side: number; readonly quality: number },
  shrink = 1,
): CdpCommand {
  return {
    method: "Page.captureScreenshot",
    params: {
      format: "jpeg",
      quality: Math.max(20, Math.round(tier.quality * (shrink < 1 ? 0.8 : 1))),
      clip: {
        x: metrics.x,
        y: metrics.y,
        width: metrics.width,
        height: metrics.height,
        scale: frameSize(metrics, viewport, tier, shrink).scale,
      },
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    },
  }
}

/** Width and height of a JPEG from its frame header, given the start of its base64 text. */
export function jpegSize(base64: string) {
  const bytes = Buffer.from(base64.slice(0, 8192), "base64")
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1]!
    // SOF0–SOF15 hold the size; C4 (huffman tables), C8 and CC (arithmetic) share the range and do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return undefined
}

/** Decoded size of base64 text without decoding it. */
export function base64Bytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

// ---------------------------------------------------------------------------------------------------------------
// Input

const NAMED: Readonly<
  Record<RemoteBrowser.NamedKey, { readonly code: string; readonly vk: number; readonly text?: string }>
> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  " ": { code: "Space", vk: 32, text: " " },
}

/**
 * The key down and key up of a named key or a one-character chord. A key that types (no Ctrl, Alt or Meta) carries
 * its text, so Enter submits and a letter is inserted; a chord goes as a raw key, which is what makes Ctrl+A select
 * and Ctrl+Z undo on Windows. Clipboard chords are not sent at all ({@link clipboardChord}).
 */
export function keyCommands(event: Extract<RemoteBrowser.InputEvent, { readonly k: "key" }>): CdpCommand[] {
  const modifiers = (event.alt ? 1 : 0) | (event.ctrl ? 2 : 0) | (event.meta ? 4 : 0) | (event.shift ? 8 : 0)
  const named = Object.hasOwn(NAMED, event.key) ? NAMED[event.key as RemoteBrowser.NamedKey] : undefined
  // Nothing is typed for a chord that would use the PC's clipboard, or for a key name this build does not know.
  if (clipboardChord(event) || (!named && [...event.key].length !== 1)) return []
  const typed = named ? named.text : event.shift ? event.key.toUpperCase() : event.key
  const upper = event.key.toUpperCase()
  const letter = /^[A-Z]$/.test(upper)
  const digit = /^[0-9]$/.test(event.key)
  const text = modifiers & 7 ? undefined : typed
  const key = {
    key: named ? event.key : (typed ?? event.key),
    code: named ? named.code : letter ? `Key${upper}` : digit ? `Digit${event.key}` : "",
    windowsVirtualKeyCode: named ? named.vk : letter || digit ? upper.charCodeAt(0) : 0,
    modifiers,
  }
  return [
    {
      method: "Input.dispatchKeyEvent",
      params:
        text === undefined ? { type: "rawKeyDown", ...key } : { type: "keyDown", ...key, text, unmodifiedText: text },
    },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...key } },
  ]
}

/**
 * A chord that copies to, cuts to or pastes from the clipboard. In the pane that clipboard is the PC's: a device
 * could put a page's text on it or read what the PC user copied (a password, say) into a page it watches. A device
 * pastes its own text as `text` instead. Ctrl+A, Z and Y, which touch no clipboard, stay.
 */
export function clipboardChord(event: Extract<RemoteBrowser.InputEvent, { readonly k: "key" }>) {
  const key = event.key.toLowerCase()
  if ((event.ctrl || event.meta) && (key === "c" || key === "x" || key === "v")) return true
  if (key === "insert") return event.ctrl === true || event.shift === true
  return key === "delete" && event.shift === true
}

const TOUCH = { start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" } as const
const MOUSE = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" } as const
const BUTTONS = { none: 0, left: 1, right: 2, middle: 4 } as const

/** A device's input event as CDP commands for a page whose viewport is `size` CSS px. */
export function inputCommands(
  event: RemoteBrowser.InputEvent,
  size: { readonly width: number; readonly height: number },
): CdpCommand[] {
  const x = (value: number) => Math.round(value * size.width * 100) / 100
  const y = (value: number) => Math.round(value * size.height * 100) / 100
  switch (event.k) {
    case "touch":
      return [
        {
          method: "Input.dispatchTouchEvent",
          params: {
            type: TOUCH[event.phase],
            // Chromium takes the points still down: none for a cancel, the remaining ones when a finger lifts.
            touchPoints:
              event.phase === "cancel"
                ? []
                : event.points.map((point) => ({ id: point.id, x: x(point.x), y: y(point.y) })),
          },
        },
      ]
    case "mouse":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: MOUSE[event.phase],
            x: x(event.x),
            y: y(event.y),
            button: event.button,
            buttons: event.phase === "up" ? 0 : BUTTONS[event.button],
            clickCount: event.phase === "move" ? 0 : (event.clicks ?? 1),
          },
        },
      ]
    case "wheel":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseWheel", x: x(event.x), y: y(event.y), deltaX: event.dx, deltaY: event.dy },
        },
      ]
    case "key":
      return keyCommands(event)
    case "text":
      return [{ method: "Input.insertText", params: { text: event.text } }]
    case "compose": {
      const end = event.text.length
      return [
        { method: "Input.imeSetComposition", params: { text: event.text, selectionStart: end, selectionEnd: end } },
      ]
    }
  }
}

/** Drops a move that the next event replaces (same kind, both moves), so a burst costs one dispatch per frame. */
export function coalesce(events: ReadonlyArray<RemoteBrowser.InputEvent>) {
  return events.filter((event, index) => {
    const next = events[index + 1]
    if (!next || next.k !== event.k) return true
    if (event.k === "touch" && next.k === "touch") return !(event.phase === "move" && next.phase === "move")
    if (event.k === "mouse" && next.k === "mouse")
      return !(event.phase === "move" && next.phase === "move" && event.button === next.button)
    return true
  })
}

/** The hub hands input on as the gateway checked it; a shape this build does not know is dropped here. */
export function inputEvents(values: ReadonlyArray<unknown>) {
  return values.flatMap((value) => {
    const event = RemoteBrowser.parseInputEvent(value)
    return event ? [event] : []
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The hub's answers

export interface Pull {
  readonly views: RemoteBrowser.HostView[]
  readonly commands: RemoteBrowser.HostCommand[]
  readonly idle: boolean
}

/**
 * `browser.host.pull`'s output, checked once here. The hub hands input and actions on as the gateway checked them;
 * an entry this build does not know is left out (an action then answers `timeout` at the hub). `serverKey` (an SSH
 * host's pane, 05 §8.10.8) is kept when it is a string and left out otherwise: this PC's service.
 */
export function parsePull(output: unknown): Pull | undefined {
  const views = field(output, "views")
  const commands = field(output, "commands")
  if (!Array.isArray(views) || !Array.isArray(commands)) return undefined
  return {
    idle: field(output, "idle") === true,
    views: views.flatMap((value: unknown) => {
      const sessionID = field(value, "sessionID")
      const mode = field(value, "mode")
      const quality = field(value, "quality")
      const viewport = RemoteBrowser.parseViewport(field(value, "viewport"))
      if (
        typeof sessionID !== "string" ||
        !RemoteBrowser.isMode(mode) ||
        !RemoteBrowser.isQuality(quality) ||
        !viewport
      )
        return []
      return [{ ...server(value), sessionID, mode, quality, viewport }]
    }),
    commands: commands.flatMap((value: unknown): RemoteBrowser.HostCommand[] => {
      const sessionID = field(value, "sessionID")
      if (typeof sessionID !== "string") return []
      const events = field(value, "events")
      if (field(value, "type") === "input" && Array.isArray(events))
        return [{ type: "input", ...server(value), sessionID, events: inputEvents(events) }]
      const id = field(value, "id")
      const action = RemoteBrowser.parseAction(field(value, "action"))
      if (field(value, "type") === "action" && typeof id === "string" && action)
        return [{ type: "action", ...server(value), sessionID, id, action }]
      return []
    }),
  }
}

function server(value: unknown) {
  const serverKey = field(value, "serverKey")
  return typeof serverKey === "string" ? { serverKey } : {}
}

/** `browser.host.frame`'s output: how many viewers watch, and whether one drew the frame. */
export function parseFrameAnswer(output: unknown) {
  const viewers = number(field(output, "viewers"))
  return viewers === undefined ? undefined : { viewers, acked: field(output, "acked") === true }
}

// ---------------------------------------------------------------------------------------------------------------
// Actions

export type PaneAction =
  | { readonly ok: true; readonly action: Browser.Action; readonly navigates: boolean }
  | { readonly ok: false; readonly error: string }

/**
 * A device's action as the pane's own, on the session's focused tab. `navigate` opens a tab when there is none; the
 * address rules are the pane's (`refusal`), applied where it runs.
 */
export function paneAction(action: RemoteBrowser.Action, state: Browser.State): PaneAction {
  const failed = { ok: false, error: RemoteBrowser.ACTION_ERROR.failed } as const
  const focused = state.tabs.find((tab) => tab.id === state.focusedTabID)?.id
  switch (action.type) {
    case "navigate":
      return {
        ok: true,
        navigates: true,
        action: focused
          ? { type: "navigate", tabID: focused, url: action.url }
          : { type: "tabs.open", url: action.url },
      }
    case "back":
    case "forward":
    case "reload":
    case "stop":
      return focused
        ? { ok: true, navigates: action.type !== "stop", action: { type: action.type, tabID: focused } }
        : failed
    case "tabs.open":
      return {
        ok: true,
        navigates: action.url !== undefined,
        action: action.url === undefined ? { type: "tabs.open" } : { type: "tabs.open", url: action.url },
      }
    case "tabs.focus":
    case "tabs.close": {
      const tabID = state.tabs.find((tab) => tab.id === action.tabID)?.id
      return tabID ? { ok: true, navigates: false, action: { type: action.type, tabID } } : failed
    }
    case "dialog":
      if (!focused) return failed
      return {
        ok: true,
        navigates: false,
        action: {
          type: "dialog",
          tabID: focused,
          action: action.accept ? "accept" : "dismiss",
          ...(action.accept && action.text !== undefined ? { promptText: action.text } : {}),
        },
      }
  }
}

/** A failed action's word for the viewer: the pane's address refusal code, else `failed`. */
export function actionError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : ""
  return /^browser\.address\.[a-z]+$/.test(message) ? message : RemoteBrowser.ACTION_ERROR.failed
}

// ---------------------------------------------------------------------------------------------------------------
// 휴대폰 크기로 보기

/** Android Chrome's user agent for this shell's Chromium (`chrome`: `140.0.7339.80`), in Chrome's own reduced form. */
export function phoneUserAgent(chrome: string) {
  const major = chrome.split(".")[0] || "140"
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
}

/** The device metrics of a phone view: its viewport, at most three device px per CSS px. */
export function phoneMetrics(viewport: RemoteBrowser.Viewport) {
  return {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    deviceScaleFactor: Math.min(Math.max(viewport.dpr, 1), 3),
  }
}

/** Every command of the phone emulation, in order. They are idempotent, so a changed viewport sends them again. */
export function phoneCommands(viewport: RemoteBrowser.Viewport, chrome: string): CdpCommand[] {
  const metrics = phoneMetrics(viewport)
  const major = chrome.split(".")[0] || "140"
  return [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        ...metrics,
        mobile: true,
        screenWidth: metrics.width,
        screenHeight: metrics.height,
        screenOrientation:
          metrics.width > metrics.height
            ? { type: "landscapePrimary", angle: 90 }
            : { type: "portraitPrimary", angle: 0 },
      },
    },
    {
      method: "Emulation.setTouchEmulationEnabled",
      params: { enabled: true, maxTouchPoints: RemoteBrowser.MAX_POINTS },
    },
    {
      method: "Emulation.setUserAgentOverride",
      params: {
        userAgent: phoneUserAgent(chrome),
        platform: "Linux armv81",
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
          ],
          fullVersion: chrome,
          platform: "Android",
          platformVersion: "10.0.0",
          architecture: "",
          model: "K",
          mobile: true,
        },
      },
    },
  ]
}

/** What puts the page back as the PC shows it. An empty user agent is Chromium's "no override". */
export const PHONE_CLEAR: ReadonlyArray<CdpCommand> = [
  { method: "Emulation.clearDeviceMetricsOverride", params: {} },
  { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
  { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
]

// ---------------------------------------------------------------------------------------------------------------
// State

const DIALOGS = ["alert", "confirm", "prompt", "beforeunload"] as const

/**
 * The open JavaScript dialog out of the pane's answer to `dialog get` (`{tab, dialog}`, upstream's own record of the
 * page's `Page.javascriptDialogOpening`), as the viewer shows it; null while none is open.
 */
export function dialogOf(answer: unknown): RemoteBrowser.Dialog | null {
  const dialog = field(field(answer, "value"), "dialog")
  if (typeof dialog !== "object" || dialog === null) return null
  const type = field(dialog, "type")
  const message = field(dialog, "message")
  const preset = field(dialog, "defaultValue")
  return {
    type: DIALOGS.find((item) => item === type) ?? "alert",
    message: typeof message === "string" ? message.slice(0, 4096) : "",
    defaultPrompt: typeof preset === "string" ? preset.slice(0, 4096) : "",
  }
}

/** The pane as a device sees it, within the limits of `browser.host.state`. */
export function paneState(input: {
  readonly state: Browser.State
  readonly mode: RemoteBrowser.Mode
  readonly metrics: PageMetrics | undefined
  readonly dialog: RemoteBrowser.Dialog | null
}): RemoteBrowser.PaneState {
  const tabs = input.state.tabs.slice(0, 64)
  const focused = tabs.find((tab) => tab.id === input.state.focusedTabID)
  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      url: tab.url.slice(0, 8192),
      title: tab.title.slice(0, 1024),
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      ...(tab.loadError === undefined ? {} : { loadError: tab.loadError.slice(0, 1024) }),
    })),
    focusedTabID: focused?.id ?? null,
    page:
      focused && input.metrics
        ? { mode: input.mode, width: Math.round(input.metrics.width), height: Math.round(input.metrics.height) }
        : null,
    dialog: focused ? input.dialog : null,
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>)[name] : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

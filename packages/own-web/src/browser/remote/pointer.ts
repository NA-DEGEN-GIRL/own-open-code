// Fingers and the mouse on the device viewer's frame → `RemoteBrowser.InputEvent`s (05 §8.10.3), without the DOM:
//  - `frameRect` is the one place that says where the frame is drawn inside its area (fit, local zoom and pan, the
//    lift above a soft keyboard); the canvas is placed by it and points are normalized by it, so a tap lands on the
//    page where the finger saw it, letterbox and zoom included.
//  - `createTouchInput`: every finger sequence becomes `touch` events whose `points` are the fingers still down (as
//    CDP's `Input.dispatchTouchEvent` takes them: `end` lists what remains). In `pc` mode a second finger cancels the
//    sequence and zooms and pans the frame on the device only; in `phone` mode everything goes to the page.
//  - `createMouseInput`: down, up, moves while a button is held, and the wheel.
//  - `createInputQueue`: one `input` message per animation frame (at most `MAX_EVENTS` each); a newer move replaces
//    the one still waiting, so a drag sends one move a frame while `start`, `end` and `cancel` always go.
// While the gate is closed (watch-only, or the agent operates the page) nothing is sent and a tap reports `blocked`.
import { RemoteBrowser } from "@own/protocol/remote-browser"

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Spot {
  readonly x: number
  readonly y: number
}

export interface Zoom {
  /** 1 = the frame fitted into its box. */
  readonly scale: number
  /** The frame's centre away from where it rests (the box's middle sideways, against its top), in CSS px. */
  readonly x: number
  readonly y: number
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 }
export const MAX_ZOOM = 5

export interface Geometry {
  /** The frame area as it is on screen now (shorter than `box` while a soft keyboard is up). */
  readonly area: Size
  /** The area the frame is fitted into (model.ts `stableBox`). */
  readonly box: Size
  /** The frame's pixels; only its aspect matters. */
  readonly frame: Size
  readonly zoom: Zoom
  /** Where the user last tapped, as a height in `box`: kept above a soft keyboard. */
  readonly anchor?: number
}

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value))
}

function fitted(geometry: Pick<Geometry, "box" | "frame">) {
  const frame = geometry.frame
  if (!(frame.width > 0) || !(frame.height > 0)) return { width: 0, height: 0 }
  const fit = Math.min(geometry.box.width / frame.width, geometry.box.height / frame.height)
  return { width: frame.width * fit, height: frame.height * fit }
}

/** The zoom inside its limits: 1–5×, and panned no further than the frame's own edges. */
export function clampZoom(zoom: Zoom, geometry: Pick<Geometry, "box" | "frame">): Zoom {
  const scale = clamp(zoom.scale, 1, MAX_ZOOM)
  const base = fitted(geometry)
  const height = base.height * scale
  const reachX = Math.max(0, (base.width * scale - geometry.box.width) / 2)
  // The frame rests against the top of its box (`frameRect`): one shorter than the box stays there and grows
  // downward; a taller one pans between its own top and bottom edges.
  const down = (height - base.height) / 2
  const up = Math.min(down, geometry.box.height - (base.height + height) / 2)
  return { scale, x: clamp(zoom.x, 0 - reachX, reachX), y: clamp(zoom.y, up, down) }
}

/** How far the frame moves up while the area is shorter than its box, so the last tapped point stays in view. */
export function lift(geometry: Pick<Geometry, "area" | "box" | "anchor">) {
  const hidden = geometry.box.height - geometry.area.height
  if (hidden <= 0 || geometry.anchor === undefined) return 0
  return clamp(geometry.area.height * 0.6 - geometry.anchor, -hidden, 0)
}

/**
 * Where the frame is drawn, in CSS px from the area's top left corner: fitted into its box, in the middle sideways
 * and against the top (a wide PC page on a tall phone sits right under the bars, the room it leaves is below it).
 */
export function frameRect(geometry: Geometry): Rect {
  const base = fitted(geometry)
  const zoom = clampZoom(geometry.zoom, geometry)
  const width = base.width * zoom.scale
  const height = base.height * zoom.scale
  return {
    left: (geometry.box.width - width) / 2 + zoom.x,
    top: (base.height - height) / 2 + zoom.y + lift(geometry),
    width,
    height,
  }
}

/** A point of the area as a fraction of the frame (clamped to it), and whether it is on the frame at all. */
export function normalize(geometry: Geometry, spot: Spot) {
  const rect = frameRect(geometry)
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0, inside: false }
  const x = (spot.x - rect.left) / rect.width
  const y = (spot.y - rect.top) / rect.height
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 }
}

/**
 * The zoom after two fingers moved: the frame scales by their spread and the point between them stays under it, as
 * far as the frame's place allows (one that is still shorter than its box stays against the top).
 */
export function pinch(input: {
  readonly geometry: Pick<Geometry, "box" | "frame">
  readonly from: { readonly zoom: Zoom; readonly distance: number; readonly middle: Spot }
  readonly distance: number
  readonly middle: Spot
}): Zoom {
  // The frame's centre at rest: the middle of the box sideways, half its fitted height down from the top.
  const rest = { x: input.geometry.box.width / 2, y: fitted(input.geometry).height / 2 }
  const from = input.from
  const scale = clamp(from.zoom.scale * (from.distance > 0 ? input.distance / from.distance : 1), 1, MAX_ZOOM)
  // The frame's point under the first middle, from the frame's centre in fitted px.
  const held = {
    x: (from.middle.x - rest.x - from.zoom.x) / from.zoom.scale,
    y: (from.middle.y - rest.y - from.zoom.y) / from.zoom.scale,
  }
  return clampZoom(
    { scale, x: input.middle.x - rest.x - held.x * scale, y: input.middle.y - rest.y - held.y * scale },
    input.geometry,
  )
}

// ---------------------------------------------------------------------------------------------------------------

export interface InputGate {
  /** Whether events go to the page now. */
  readonly open: () => boolean
  /** A tap or a click while the gate is closed. */
  readonly blocked: () => void
}

/** A finger that moved less than this (CSS px) and lifted is a tap. */
const TAP_SLOP = 12

export function createTouchInput(input: {
  readonly geometry: () => Geometry
  readonly mode: () => RemoteBrowser.Mode
  readonly send: (event: RemoteBrowser.InputEvent) => void
  readonly gate: InputGate
  readonly zoom: () => Zoom
  readonly setZoom: (zoom: Zoom) => void
  /** A finger landed on the frame at this height of the box (the keyboard lift's anchor). */
  readonly onTouch?: (anchor: number) => void
}) {
  /** Fingers of the sequence being sent, by pointer id, with the `Point.id` each keeps for the page. */
  const sent = new Map<number, { readonly slot: number; x: number; y: number }>()
  /** Fingers that zoom the frame here (`pc` mode), or wait for every finger to lift after that. */
  const local = new Map<number, Spot>()
  /** Fingers down while the gate is closed: where each landed, to tell a tap from a drag. */
  const watched = new Map<number, { readonly from: Spot; moved: boolean }>()
  let gesture: { readonly zoom: Zoom; readonly distance: number; readonly middle: Spot } | undefined
  let zooming = false

  const points = (): RemoteBrowser.Point[] =>
    [...sent.values()].map((finger) => ({ id: finger.slot, x: finger.x, y: finger.y })).sort((a, b) => a.id - b.id)
  const spread = () => {
    const [first, second] = [...local.values()]
    if (!first || !second) return undefined
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      middle: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    }
  }
  const grip = () => {
    const now = spread()
    gesture = now ? { zoom: input.zoom(), ...now } : undefined
  }
  const abandon = () => {
    if (!sent.size) return
    sent.clear()
    input.send({ k: "touch", phase: "cancel", points: [] })
  }

  return {
    down(id: number, spot: Spot) {
      if (zooming) {
        local.set(id, spot)
        return grip()
      }
      if (input.mode() === "pc" && sent.size + watched.size === 1) {
        // The second finger: the page never sees a pinch in `pc` mode; the frame zooms on this device instead.
        const first = [...sent.keys(), ...watched.keys()][0]!
        const at = sent.get(first)
        const rect = frameRect(input.geometry())
        local.set(first, at ? { x: rect.left + at.x * rect.width, y: rect.top + at.y * rect.height } : watched.get(first)!.from)
        local.set(id, spot)
        abandon()
        watched.clear()
        zooming = true
        return grip()
      }
      const geometry = input.geometry()
      const place = normalize(geometry, spot)
      if (!place.inside) return
      if (!input.gate.open()) {
        // A sequence already going to the page ends before the gate's own fingers start.
        abandon()
        return void watched.set(id, { from: spot, moved: false })
      }
      const slot = Array.from({ length: RemoteBrowser.MAX_POINTS }, (_, index) => index).find(
        (free) => ![...sent.values()].some((finger) => finger.slot === free),
      )
      if (slot === undefined) return
      input.onTouch?.(spot.y - lift(geometry))
      sent.set(id, { slot, x: place.x, y: place.y })
      input.send({ k: "touch", phase: "start", points: points() })
    },
    move(id: number, spot: Spot) {
      if (local.has(id)) {
        local.set(id, spot)
        const now = spread()
        if (gesture && now) input.setZoom(pinch({ geometry: input.geometry(), from: gesture, ...now }))
        return
      }
      const seen = watched.get(id)
      if (seen) {
        if (Math.hypot(spot.x - seen.from.x, spot.y - seen.from.y) > TAP_SLOP) seen.moved = true
        return
      }
      const finger = sent.get(id)
      if (!finger) return
      if (!input.gate.open()) return abandon()
      const place = normalize(input.geometry(), spot)
      finger.x = place.x
      finger.y = place.y
      input.send({ k: "touch", phase: "move", points: points() })
    },
    up(id: number) {
      if (local.delete(id)) {
        gesture = undefined
        if (!local.size) zooming = false
        return
      }
      const seen = watched.get(id)
      if (seen) {
        watched.delete(id)
        if (!seen.moved) input.gate.blocked()
        return
      }
      if (!sent.delete(id)) return
      if (!input.gate.open()) {
        sent.clear()
        return input.send({ k: "touch", phase: "cancel", points: [] })
      }
      input.send({ k: "touch", phase: "end", points: points() })
    },
    cancel(id: number) {
      if (local.delete(id)) {
        gesture = undefined
        if (!local.size) zooming = false
        return
      }
      if (watched.delete(id)) return
      if (!sent.has(id)) return
      abandon()
    },
    /** The view went away or lost its frame: nothing stays down on the page. */
    reset() {
      abandon()
      local.clear()
      watched.clear()
      gesture = undefined
      zooming = false
    },
  }
}

export type MouseButton = "left" | "right" | "middle"

/** Two presses of one button within this time and distance count up `clicks` (a double click selects a word). */
const MULTI_CLICK_MS = 500
const MULTI_CLICK_PX = 5

export function createMouseInput(input: {
  readonly geometry: () => Geometry
  readonly send: (event: RemoteBrowser.InputEvent) => void
  readonly gate: InputGate
  readonly now?: () => number
}) {
  const now = input.now ?? Date.now
  let pressed: { readonly button: MouseButton; readonly clicks: number } | undefined
  let last: { readonly button: MouseButton; readonly at: number; readonly spot: Spot; readonly clicks: number } | undefined
  return {
    down(button: MouseButton, spot: Spot) {
      const place = normalize(input.geometry(), spot)
      if (!place.inside) return false
      if (!input.gate.open()) {
        input.gate.blocked()
        return false
      }
      const at = now()
      const again =
        last !== undefined &&
        last.button === button &&
        at - last.at <= MULTI_CLICK_MS &&
        Math.hypot(spot.x - last.spot.x, spot.y - last.spot.y) <= MULTI_CLICK_PX
      const clicks = again ? (last!.clicks % 3) + 1 : 1
      last = { button, at, spot, clicks }
      pressed = { button, clicks }
      input.send({ k: "mouse", phase: "down", x: place.x, y: place.y, button, clicks })
      return true
    },
    move(spot: Spot) {
      if (!pressed) return
      if (!input.gate.open()) return void (pressed = undefined)
      const place = normalize(input.geometry(), spot)
      input.send({ k: "mouse", phase: "move", x: place.x, y: place.y, button: pressed.button })
    },
    up(button: MouseButton, spot: Spot) {
      if (!pressed || pressed.button !== button) return
      const held = pressed
      pressed = undefined
      if (!input.gate.open()) return
      const place = normalize(input.geometry(), spot)
      input.send({ k: "mouse", phase: "up", x: place.x, y: place.y, button, clicks: held.clicks })
    },
    /** `dx`, `dy` in CSS px (a line-mode wheel is converted by the caller). */
    wheel(spot: Spot, dx: number, dy: number) {
      const place = normalize(input.geometry(), spot)
      if (!place.inside || !input.gate.open()) return
      input.send({ k: "wheel", x: place.x, y: place.y, dx, dy })
    },
    reset() {
      pressed = undefined
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** Whether `next` says everything `waiting` did, so `waiting` need not be sent. */
function merge(waiting: RemoteBrowser.InputEvent, next: RemoteBrowser.InputEvent): RemoteBrowser.InputEvent | undefined {
  if (waiting.k === "touch" && next.k === "touch" && waiting.phase === "move" && next.phase === "move") return next
  if (waiting.k === "mouse" && next.k === "mouse" && waiting.phase === "move" && next.phase === "move") return next
  if (waiting.k === "compose" && next.k === "compose") return next
  if (waiting.k === "wheel" && next.k === "wheel")
    return { k: "wheel", x: next.x, y: next.y, dx: waiting.dx + next.dx, dy: waiting.dy + next.dy }
  return undefined
}

export function createInputQueue(input: {
  /** One `input` message. */
  readonly flush: (events: RemoteBrowser.InputEvent[]) => void
  /** `requestAnimationFrame`; answers how to call it off. */
  readonly frame: (run: () => void) => () => void
}) {
  let waiting: RemoteBrowser.InputEvent[] = []
  let cancel: (() => void) | undefined
  const run = () => {
    cancel = undefined
    const events = waiting
    waiting = []
    for (let from = 0; from < events.length; from += RemoteBrowser.MAX_EVENTS)
      input.flush(events.slice(from, from + RemoteBrowser.MAX_EVENTS))
  }
  return {
    push(event: RemoteBrowser.InputEvent) {
      const last = waiting.at(-1)
      const merged = last ? merge(last, event) : undefined
      if (merged) waiting[waiting.length - 1] = merged
      else waiting.push(event)
      cancel ??= input.frame(run)
    },
    /** Drops what waits (the socket went away, the gate closed). */
    clear() {
      waiting = []
      cancel?.()
      cancel = undefined
    },
  }
}

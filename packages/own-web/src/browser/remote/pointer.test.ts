// Fingers and the mouse on the device viewer's frame (05 §8.10.3): where the frame is drawn (letterbox, local zoom,
// the lift above a soft keyboard), the fractions sent to the page, the touch sequences, the local pinch of `pc` mode,
// the gate, and the one-message-a-frame queue.
import { describe, expect, test } from "bun:test"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import {
  clampZoom,
  createInputQueue,
  createMouseInput,
  createTouchInput,
  frameRect,
  lift,
  MAX_ZOOM,
  normalize,
  NO_ZOOM,
  pinch,
  type Geometry,
  type Zoom,
} from "./pointer"

/** A Galaxy S23 Ultra's frame area showing a 1280×800 PC pane: 384×240, 207 px of letterbox above and below. */
const phone: Geometry = {
  area: { width: 384, height: 654 },
  box: { width: 384, height: 654 },
  frame: { width: 720, height: 450 },
  zoom: NO_ZOOM,
}

function rig(input: { mode?: RemoteBrowser.Mode; geometry?: Geometry } = {}) {
  const sent: RemoteBrowser.InputEvent[] = []
  const state = {
    open: true,
    blocked: 0,
    zoom: NO_ZOOM as Zoom,
    geometry: input.geometry ?? phone,
    anchor: undefined as number | undefined,
  }
  const gate = { open: () => state.open, blocked: () => void (state.blocked += 1) }
  const geometry = () => ({ ...state.geometry, zoom: state.zoom })
  const touch = createTouchInput({
    geometry,
    mode: () => input.mode ?? "pc",
    send: (event) => sent.push(event),
    gate,
    zoom: () => state.zoom,
    setZoom: (zoom) => void (state.zoom = zoom),
    onTouch: (anchor) => void (state.anchor = anchor),
  })
  const clock = { now: 1000 }
  const mouse = createMouseInput({ geometry, send: (event) => sent.push(event), gate, now: () => clock.now })
  return { sent, state, touch, mouse, clock, take: () => sent.splice(0) }
}

describe("where the frame is drawn", () => {
  test("fitted into its box, against its top: a wide PC page on a tall phone leaves its room below", () => {
    expect(frameRect(phone)).toEqual({ left: 0, top: 0, width: 384, height: 240 })
    // A tall page in a wide area gets bars at its sides.
    expect(
      frameRect({ ...phone, area: { width: 466, height: 535 }, box: { width: 466, height: 535 }, frame: { width: 384, height: 654 } }),
    ).toEqual({ left: (466 - 535 * (384 / 654)) / 2, top: 0, width: 535 * (384 / 654), height: 535 })
  })

  test("phone size: the frame has the box's shape and fills it", () => {
    expect(frameRect({ ...phone, frame: { width: 720, height: 1226 } }).width).toBeCloseTo(384, 0)
    expect(frameRect({ ...phone, frame: { width: 384, height: 654 } })).toEqual({ left: 0, top: 0, width: 384, height: 654 })
  })

  test("nothing is drawn before the first frame", () => {
    const empty = { ...phone, frame: { width: 0, height: 0 } }
    expect(frameRect(empty)).toMatchObject({ width: 0, height: 0 })
    expect(normalize(empty, { x: 10, y: 10 })).toEqual({ x: 0, y: 0, inside: false })
  })

  test("zoom pans no further than the frame's own edge and keeps a short frame against the top", () => {
    const zoomed = { ...phone, zoom: { scale: 2, x: 0, y: 0 } }
    expect(frameRect(zoomed)).toEqual({ left: -192, top: 0, width: 768, height: 480 })
    // 768 wide in 384: 192 px of reach each way; 480 high in 654: it stays against the top and grows downward.
    expect(clampZoom({ scale: 2, x: 500, y: -90 }, phone)).toEqual({ scale: 2, x: 192, y: 120 })
    expect(clampZoom({ scale: 9, x: 0, y: 0 }, phone).scale).toBe(MAX_ZOOM)
    expect(clampZoom({ scale: 0.4, x: 30, y: 30 }, phone)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  test("a raised keyboard keeps the frame's size and lifts it so the last tapped point stays in view", () => {
    const typing = { ...phone, frame: { width: 384, height: 654 }, area: { width: 384, height: 332 } }
    // Nothing tapped yet: the top of the page stays.
    expect(lift(typing)).toBe(0)
    // A field in the lower half of the page (450 of 654): lifted to 60 % of what is left above the keyboard.
    expect(lift({ ...typing, anchor: 450 })).toBeCloseTo(332 * 0.6 - 450, 5)
    expect(frameRect({ ...typing, anchor: 450 })).toMatchObject({ top: 332 * 0.6 - 450, height: 654 })
    // Never further than the part the keyboard hides, and not at all for a point that is in view anyway.
    expect(lift({ ...typing, anchor: 5000 })).toBe(332 - 654)
    expect(lift({ ...typing, anchor: 100 })).toBe(0)
    expect(lift({ ...phone, anchor: 450 })).toBe(0)
  })
})

describe("fractions of the frame", () => {
  test("the letterbox is not the page", () => {
    expect(normalize(phone, { x: 192, y: 120 })).toEqual({ x: 0.5, y: 0.5, inside: true })
    expect(normalize(phone, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, inside: true })
    expect(normalize(phone, { x: 384, y: 240 })).toEqual({ x: 1, y: 1, inside: true })
    expect(normalize(phone, { x: 192, y: 300 })).toEqual({ x: 0.5, y: 1, inside: false })
    expect(normalize(phone, { x: 500, y: 700 })).toEqual({ x: 1, y: 1, inside: false })
  })

  test("a zoomed and panned frame maps the finger to the page point under it", () => {
    const zoomed = { ...phone, zoom: { scale: 2, x: 96, y: 0 } }
    // The frame spans -96…672 horizontally and 0…480 vertically.
    expect(normalize(zoomed, { x: 96, y: 240 })).toEqual({ x: 0.25, y: 0.5, inside: true })
    expect(normalize(zoomed, { x: 288, y: 120 })).toEqual({ x: 0.5, y: 0.25, inside: true })
  })

  test("under a raised keyboard the lift is taken off", () => {
    const typing = { ...phone, frame: { width: 384, height: 654 }, area: { width: 384, height: 332 }, anchor: 450 }
    const shift = 332 * 0.6 - 450
    const place = normalize(typing, { x: 192, y: 450 + shift })
    expect(place.inside).toBe(true)
    expect(place.y).toBeCloseTo(450 / 654, 5)
  })
})

describe("touch", () => {
  test("a tap: start with the finger, end with none left", () => {
    const r = rig()
    r.touch.down(7, { x: 192, y: 120 })
    r.touch.up(7)
    expect(r.sent).toEqual([
      { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] },
      { k: "touch", phase: "end", points: [] },
    ])
    expect(r.state.anchor).toBe(120)
    for (const event of r.sent) expect(RemoteBrowser.parseInputEvent(event)).toEqual(event)
  })

  test("a drag sends every move, clamped to the frame when the finger leaves it", () => {
    const r = rig()
    r.touch.down(1, { x: 96, y: 60 })
    r.touch.move(1, { x: 96, y: 180 })
    r.touch.move(1, { x: 96, y: 900 })
    r.touch.up(1)
    expect(r.sent.map((event) => (event.k === "touch" ? `${event.phase} ${event.points[0]?.y ?? "-"}` : ""))).toEqual([
      "start 0.25",
      "move 0.75",
      "move 1",
      "end -",
    ])
  })

  test("a touch that starts on the letterbox is not the page's", () => {
    const r = rig()
    r.touch.down(1, { x: 192, y: 400 })
    r.touch.move(1, { x: 192, y: 500 })
    r.touch.up(1)
    expect(r.sent).toEqual([])
    expect(r.state.blocked).toBe(0)
  })

  test("phone size: every finger goes to the page, each with its own id, and `end` lists who stays", () => {
    const r = rig({ mode: "phone", geometry: { ...phone, frame: { width: 384, height: 654 } } })
    r.touch.down(10, { x: 96, y: 327 })
    r.touch.down(11, { x: 288, y: 327 })
    r.touch.move(11, { x: 288, y: 163.5 })
    r.touch.up(10)
    r.touch.down(12, { x: 192, y: 0 })
    r.touch.up(11)
    r.touch.up(12)
    expect(r.sent).toEqual([
      { k: "touch", phase: "start", points: [{ id: 0, x: 0.25, y: 0.5 }] },
      {
        k: "touch",
        phase: "start",
        points: [
          { id: 0, x: 0.25, y: 0.5 },
          { id: 1, x: 0.75, y: 0.5 },
        ],
      },
      {
        k: "touch",
        phase: "move",
        points: [
          { id: 0, x: 0.25, y: 0.5 },
          { id: 1, x: 0.75, y: 0.25 },
        ],
      },
      { k: "touch", phase: "end", points: [{ id: 1, x: 0.75, y: 0.25 }] },
      // The freed id is used again.
      {
        k: "touch",
        phase: "start",
        points: [
          { id: 0, x: 0.5, y: 0 },
          { id: 1, x: 0.75, y: 0.25 },
        ],
      },
      { k: "touch", phase: "end", points: [{ id: 0, x: 0.5, y: 0 }] },
      { k: "touch", phase: "end", points: [] },
    ])
    expect(r.state.zoom).toBe(NO_ZOOM)
  })

  test("no more fingers than the contract takes", () => {
    const r = rig({ mode: "phone", geometry: { ...phone, frame: { width: 384, height: 654 } } })
    for (const id of [1, 2, 3, 4, 5, 6]) r.touch.down(id, { x: 40 * id, y: 300 })
    const last = r.sent.at(-1)
    expect(r.sent).toHaveLength(RemoteBrowser.MAX_POINTS)
    expect(last?.k === "touch" && last.points.length).toBe(RemoteBrowser.MAX_POINTS)
    r.touch.up(6)
    expect(r.sent).toHaveLength(RemoteBrowser.MAX_POINTS)
  })

  test("PC size: a second finger cancels the page's touch and zooms the frame here, nothing more is sent", () => {
    const r = rig()
    r.touch.down(1, { x: 142, y: 120 })
    r.touch.down(2, { x: 242, y: 120 })
    expect(r.take()).toEqual([
      { k: "touch", phase: "start", points: [{ id: 0, x: 142 / 384, y: 0.5 }] },
      { k: "touch", phase: "cancel", points: [] },
    ])
    // The fingers spread to twice the distance around the same middle.
    r.touch.move(1, { x: 92, y: 120 })
    r.touch.move(2, { x: 292, y: 120 })
    expect(r.state.zoom).toEqual({ scale: 2, x: 0, y: 120 })
    // One finger lifts: the other does not become a touch on the page.
    r.touch.up(1)
    r.touch.move(2, { x: 200, y: 400 })
    r.touch.up(2)
    expect(r.take()).toEqual([])
    expect(r.state.zoom.scale).toBe(2)
    // The next finger is the page's again, mapped through the zoom.
    r.touch.down(3, { x: 192, y: 240 })
    r.touch.up(3)
    expect(r.take()).toEqual([
      { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] },
      { k: "touch", phase: "end", points: [] },
    ])
  })

  test("a pinch keeps the page point between the fingers under them, as far as the frame's place allows", () => {
    // A frame that fills its box (phone size, or zoomed past it): the point under the fingers stays.
    const full = { ...phone, frame: { width: 384, height: 654 } }
    const held = { zoom: NO_ZOOM, distance: 100, middle: { x: 96, y: 327 } }
    const wide = pinch({ geometry: full, from: held, distance: 200, middle: { x: 96, y: 327 } })
    expect(wide).toEqual({ scale: 2, x: 96, y: 0 })
    expect(normalize({ ...full, zoom: wide }, { x: 96, y: 327 })).toMatchObject({ x: 0.25, y: 0.5 })
    // A wide PC page still shorter than its box: it stays against the top, so only the sideways place is kept.
    const from = { zoom: NO_ZOOM, distance: 100, middle: { x: 96, y: 120 } }
    const zoomed = pinch({ geometry: phone, from, distance: 200, middle: { x: 96, y: 120 } })
    expect(zoomed).toEqual({ scale: 2, x: 96, y: 120 })
    expect(frameRect({ ...phone, zoom: zoomed })).toEqual({ left: -96, top: 0, width: 768, height: 480 })
    expect(normalize({ ...phone, zoom: zoomed }, { x: 96, y: 120 })).toMatchObject({ x: 0.25, y: 0.25 })
    // Past the box's height it pans between its own top and bottom edges.
    expect(clampZoom({ scale: 4, x: 0, y: -9999 }, phone).y).toBe(654 - (240 + 960) / 2)
    expect(clampZoom({ scale: 4, x: 0, y: 9999 }, phone).y).toBe((960 - 240) / 2)
    expect(frameRect({ ...phone, zoom: { scale: 4, x: 0, y: -9999 } })).toMatchObject({ top: 654 - 960, height: 960 })
    // Pinching in past the fitted size stops at it.
    expect(pinch({ geometry: phone, from, distance: 10, middle: { x: 96, y: 120 } })).toEqual({ scale: 1, x: 0, y: 0 })
  })

  test("a cancelled touch (the system took it) cancels on the page", () => {
    const r = rig()
    r.touch.down(1, { x: 192, y: 120 })
    r.touch.cancel(1)
    r.touch.up(1)
    expect(r.sent.map((event) => event.k === "touch" && event.phase)).toEqual(["start", "cancel"])
  })

  test("gate closed (watch-only, or the agent operates): nothing is sent, a tap is reported, a drag is not", () => {
    const r = rig()
    r.state.open = false
    r.touch.down(1, { x: 192, y: 120 })
    r.touch.move(1, { x: 194, y: 122 })
    r.touch.up(1)
    expect(r.state.blocked).toBe(1)
    r.touch.down(2, { x: 192, y: 120 })
    r.touch.move(2, { x: 192, y: 220 })
    r.touch.up(2)
    expect(r.state.blocked).toBe(1)
    expect(r.sent).toEqual([])
  })

  test("gate closed: the frame still zooms with two fingers", () => {
    const r = rig()
    r.state.open = false
    r.touch.down(1, { x: 142, y: 120 })
    r.touch.down(2, { x: 242, y: 120 })
    r.touch.move(2, { x: 342, y: 120 })
    r.touch.up(1)
    r.touch.up(2)
    expect(r.state.zoom.scale).toBe(2)
    expect(r.sent).toEqual([])
    expect(r.state.blocked).toBe(0)
  })

  test("the gate closing under a finger (the agent starts) ends that touch on the page", () => {
    const r = rig()
    r.touch.down(1, { x: 192, y: 120 })
    r.state.open = false
    r.touch.move(1, { x: 192, y: 400 })
    r.touch.move(1, { x: 192, y: 420 })
    r.touch.up(1)
    expect(r.sent.map((event) => event.k === "touch" && event.phase)).toEqual(["start", "cancel"])
  })

  test("reset lets nothing stay pressed on the page", () => {
    const r = rig()
    r.touch.down(1, { x: 192, y: 120 })
    r.touch.reset()
    r.touch.reset()
    expect(r.sent.map((event) => event.k === "touch" && event.phase)).toEqual(["start", "cancel"])
  })
})

describe("mouse", () => {
  test("down, moves while held, up; moves without a button are not sent", () => {
    const r = rig()
    r.mouse.move({ x: 10, y: 300 })
    expect(r.mouse.down("left", { x: 96, y: 60 })).toBe(true)
    r.mouse.move({ x: 192, y: 120 })
    r.mouse.up("left", { x: 288, y: 180 })
    r.mouse.move({ x: 300, y: 300 })
    expect(r.sent).toEqual([
      { k: "mouse", phase: "down", x: 0.25, y: 0.25, button: "left", clicks: 1 },
      { k: "mouse", phase: "move", x: 0.5, y: 0.5, button: "left" },
      { k: "mouse", phase: "up", x: 0.75, y: 0.75, button: "left", clicks: 1 },
    ])
    for (const event of r.sent) expect(RemoteBrowser.parseInputEvent(event)).toEqual(event)
  })

  test("quick presses in one place count up to a triple click; elsewhere or later they start over", () => {
    const r = rig()
    const clicks = (spot: { x: number; y: number }) => {
      r.mouse.down("left", spot)
      r.mouse.up("left", spot)
      const down = r.take()[0]
      return down?.k === "mouse" ? down.clicks : undefined
    }
    expect(clicks({ x: 100, y: 100 })).toBe(1)
    r.clock.now += 200
    expect(clicks({ x: 101, y: 100 })).toBe(2)
    r.clock.now += 200
    expect(clicks({ x: 101, y: 101 })).toBe(3)
    r.clock.now += 200
    expect(clicks({ x: 101, y: 101 })).toBe(1)
    r.clock.now += 200
    expect(clicks({ x: 200, y: 101 })).toBe(1)
    r.clock.now += 900
    expect(clicks({ x: 200, y: 101 })).toBe(1)
  })

  test("the right button and the wheel; outside the frame nothing", () => {
    const r = rig()
    r.mouse.down("right", { x: 192, y: 120 })
    r.mouse.up("right", { x: 192, y: 120 })
    r.mouse.wheel({ x: 192, y: 120 }, 0, 120)
    r.mouse.wheel({ x: 192, y: 400 }, 0, 120)
    expect(r.mouse.down("left", { x: 192, y: 400 })).toBe(false)
    expect(r.sent).toEqual([
      { k: "mouse", phase: "down", x: 0.5, y: 0.5, button: "right", clicks: 1 },
      { k: "mouse", phase: "up", x: 0.5, y: 0.5, button: "right", clicks: 1 },
      { k: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 120 },
    ])
  })

  test("gate closed: a click is reported and nothing is sent", () => {
    const r = rig()
    r.state.open = false
    expect(r.mouse.down("left", { x: 192, y: 120 })).toBe(false)
    r.mouse.move({ x: 200, y: 120 })
    r.mouse.up("left", { x: 200, y: 120 })
    r.mouse.wheel({ x: 192, y: 120 }, 0, 120)
    expect(r.sent).toEqual([])
    expect(r.state.blocked).toBe(1)
  })
})

describe("one input message a frame", () => {
  function queue() {
    const messages: RemoteBrowser.InputEvent[][] = []
    const frames: Array<() => void> = []
    const cancelled: number[] = []
    const made = createInputQueue({
      flush: (events) => messages.push(events),
      frame(run) {
        const index = frames.push(run) - 1
        return () => cancelled.push(index)
      },
    })
    return { messages, frames, cancelled, queue: made, tick: () => frames.splice(0).forEach((run) => run()) }
  }
  const moveTo = (y: number): RemoteBrowser.InputEvent => ({ k: "touch", phase: "move", points: [{ id: 0, x: 0.5, y }] })

  test("a drag: start, the newest move and end of one frame travel together; moves are one a frame", () => {
    const q = queue()
    q.queue.push({ k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.1 }] })
    q.queue.push(moveTo(0.2))
    q.queue.push(moveTo(0.3))
    q.queue.push(moveTo(0.4))
    expect(q.frames).toHaveLength(1)
    expect(q.messages).toEqual([])
    q.tick()
    q.queue.push(moveTo(0.5))
    q.queue.push(moveTo(0.6))
    q.queue.push({ k: "touch", phase: "end", points: [] })
    q.tick()
    expect(q.messages).toEqual([
      [{ k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.1 }] }, moveTo(0.4)],
      [moveTo(0.6), { k: "touch", phase: "end", points: [] }],
    ])
    for (const events of q.messages)
      expect(RemoteBrowser.parseClientMessage(JSON.stringify({ t: "input", events }))).toBeDefined()
  })

  test("a move is not merged across a start or an end: the order the page sees stays", () => {
    const q = queue()
    q.queue.push(moveTo(0.2))
    q.queue.push({ k: "touch", phase: "end", points: [] })
    q.queue.push({ k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.7 }] })
    q.queue.push(moveTo(0.8))
    q.tick()
    expect(q.messages[0]?.map((event) => event.k === "touch" && event.phase)).toEqual(["move", "end", "start", "move"])
  })

  test("wheel notches add up, mouse moves and composing text keep the newest, text and keys all go", () => {
    const q = queue()
    q.queue.push({ k: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 100 })
    q.queue.push({ k: "wheel", x: 0.5, y: 0.6, dx: 5, dy: 100 })
    q.queue.push({ k: "mouse", phase: "move", x: 0.1, y: 0.1, button: "left" })
    q.queue.push({ k: "mouse", phase: "move", x: 0.2, y: 0.2, button: "left" })
    q.queue.push({ k: "compose", text: "ㅎ" })
    q.queue.push({ k: "compose", text: "하" })
    q.queue.push({ k: "text", text: "한" })
    q.queue.push({ k: "text", text: "글" })
    q.queue.push({ k: "key", key: "Backspace" })
    q.queue.push({ k: "key", key: "Backspace" })
    q.tick()
    expect(q.messages).toEqual([
      [
        { k: "wheel", x: 0.5, y: 0.6, dx: 5, dy: 200 },
        { k: "mouse", phase: "move", x: 0.2, y: 0.2, button: "left" },
        { k: "compose", text: "하" },
        { k: "text", text: "한" },
        { k: "text", text: "글" },
        { k: "key", key: "Backspace" },
        { k: "key", key: "Backspace" },
      ],
    ])
  })

  test("more events than one message takes are split", () => {
    const q = queue()
    for (let index = 0; index < RemoteBrowser.MAX_EVENTS + 6; index++) q.queue.push({ k: "key", key: "Backspace" })
    q.tick()
    expect(q.messages.map((events) => events.length)).toEqual([RemoteBrowser.MAX_EVENTS, 6])
  })

  test("clear drops what waits and calls the frame off", () => {
    const q = queue()
    q.queue.push(moveTo(0.2))
    q.queue.clear()
    expect(q.cancelled).toEqual([0])
    q.queue.push(moveTo(0.3))
    q.frames.at(-1)?.()
    expect(q.messages).toEqual([[moveTo(0.3)]])
  })
})

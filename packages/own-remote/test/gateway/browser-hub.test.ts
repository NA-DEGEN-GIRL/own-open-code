// The browser pane's hub (05 §8.10) on its own: fake viewers and a fake desktop shell around a manual clock, no
// sockets. What the gateway adds (device auth, scopes, the socket and the RPC) is test/gateway/browser.test.ts.
import { describe, expect, test } from "bun:test"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { BrowserHub } from "../../src/gateway/browser-hub.js"

const HOST = "host-0001"
const OTHER_HOST = "host-0002"
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64")
const VIEWPORT = { width: 390, height: 800, dpr: 3 }

/** Lets promise chains that a timer or a message settled run to their end. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup() {
  const clock = { now: 1_000_000, next: 0 }
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  const wanted: string[] = []
  const can = { view: true }
  const hub = new BrowserHub.Hub({
    now: () => clock.now,
    timers: {
      set: (run, ms) => {
        clock.next++
        timers.set(clock.next, { at: clock.now + ms, run })
        return clock.next
      },
      clear: (timer) => void timers.delete(timer as number),
    },
    emitWanted: (sessionID) => wanted.push(sessionID),
    canView: () => can.view,
  })
  /** Moves the clock, running every timer that comes due on the way, in order. */
  const advance = async (ms: number) => {
    const end = clock.now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      timers.delete(due[0])
      clock.now = due[1].at
      due[1].run()
      await settled()
    }
    clock.now = end
    await settled()
  }
  const pull = (input: Partial<BrowserHub.PullInput> = {}) =>
    hub.pull({ host: HOST, windows: 1, hosted: [], waitMs: 0, ...input })
  const frame = (sessionID: string, input: Partial<BrowserHub.FrameInput> = {}) =>
    hub.frame({ host: HOST, sessionID, width: 720, height: 1480, sharp: false, data: JPEG, ...input })
  return { hub, clock, timers, wanted, can, advance, pull, frame }
}

function viewer(
  hub: BrowserHub.Hub,
  input: {
    readonly deviceId?: string
    readonly serverKey?: string
    readonly sessionID?: string
    readonly control?: boolean
  } = {},
) {
  const sent: RemoteBrowser.ServerMessage[] = []
  const frames: Uint8Array[] = []
  const closed: Array<{ readonly code: number; readonly reason: string }> = []
  const device = { alive: true }
  const handle = hub.join({
    deviceId: input.deviceId ?? "dev_a",
    serverKey: input.serverKey ?? "local",
    sessionID: input.sessionID ?? "ses_1",
    control: input.control ?? true,
    send: (text) => sent.push(JSON.parse(text)),
    sendFrame: (bytes) => frames.push(bytes),
    close: (code, reason) => closed.push({ code, reason }),
    alive: () => device.alive,
  })
  const say = (message: RemoteBrowser.ClientMessage) => handle.message(JSON.stringify(message))
  return {
    sent,
    frames,
    closed,
    device,
    handle,
    say,
    hello: (over: Partial<Extract<RemoteBrowser.ClientMessage, { t: "hello" }>> = {}) =>
      say({ t: "hello", v: 1, viewport: VIEWPORT, mode: "pc", quality: "auto", visible: true, ...over }),
    states: () => sent.flatMap((message) => (message.t === "state" ? [message.state] : [])),
    results: () => sent.flatMap((message) => (message.t === "result" ? [message] : [])),
    headers: () => frames.map((bytes) => RemoteBrowser.decodeFrame(bytes)!.header),
    ack: (seq: number) => say({ t: "ack", seq }),
  }
}

const PANE: RemoteBrowser.PaneState = {
  tabs: [{ id: "t1", url: "http://localhost:5173/", title: "앱", loading: false, canGoBack: false, canGoForward: false }],
  focusedTabID: "t1",
  page: { mode: "pc", width: 1280, height: 800 },
  dialog: null,
}
const TAP: RemoteBrowser.InputEvent = { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] }
const MOVE: RemoteBrowser.InputEvent = { k: "touch", phase: "move", points: [{ id: 0, x: 0.5, y: 0.6 }] }
const END: RemoteBrowser.InputEvent = { k: "touch", phase: "end", points: [] }

describe("viewers: hello, ready, state", () => {
  test("hello is answered with ready and the session's state; the host word follows the desktop and the device", async () => {
    const { hub, pull } = setup()
    const absent = viewer(hub)
    absent.hello()
    expect(absent.sent).toEqual([
      { t: "ready", v: 1, control: true },
      { t: "state", state: { ...RemoteBrowser.EMPTY_PANE, host: "absent" } },
    ])
    // A desktop app polls: a control viewer's pane is being attached, a watcher's is not there.
    const watcher = viewer(hub, { deviceId: "dev_b", control: false })
    watcher.hello()
    expect(watcher.sent[0]).toEqual({ t: "ready", v: 1, control: false })
    await pull()
    expect(absent.states().at(-1)?.host).toBe("attaching")
    expect(watcher.states().at(-1)?.host).toBe("detached")
    await pull({ hosted: ["ses_1"] })
    expect(absent.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "ready" })
    expect(watcher.states().at(-1)?.host).toBe("ready")
    // The shell's report of the pane reaches both, with the host word; an unchanged one is not repeated.
    hub.state({ host: HOST, sessionID: "ses_1", state: PANE })
    hub.state({ host: HOST, sessionID: "ses_1", state: PANE })
    expect(absent.states().at(-1)).toEqual({ ...PANE, host: "ready" })
    expect(watcher.states().filter((state) => state.tabs.length === 1)).toHaveLength(1)
    hub.state({ host: HOST, sessionID: "ses_1", notice: "download" })
    expect(watcher.sent.at(-1)).toEqual({ t: "notice", kind: "download" })
    // Another shell's report is not this one's.
    hub.state({ host: OTHER_HOST, sessionID: "ses_1", notice: "file_chooser" })
    expect(watcher.sent.at(-1)).toEqual({ t: "notice", kind: "download" })
    // The pane is gone with its attachment: nothing of it is shown, or kept for the next one.
    await pull({ hosted: [] })
    expect(watcher.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "detached" })
    await pull({ hosted: ["ses_1"] })
    expect(watcher.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "ready" })
  })

  test("anything but a valid hello first, a second hello, garbage or silence closes the socket as a protocol error", async () => {
    const { hub, advance } = setup()
    const early = viewer(hub)
    early.say({ t: "view", visible: true })
    expect(early.closed).toEqual([{ code: RemoteBrowser.CLOSE.protocol, reason: "protocol" }])
    expect(early.sent).toEqual([])
    const twice = viewer(hub)
    twice.hello()
    twice.hello()
    expect(twice.closed).toEqual([{ code: RemoteBrowser.CLOSE.protocol, reason: "protocol" }])
    const garbage = viewer(hub)
    garbage.hello()
    garbage.handle.message("{not json")
    expect(garbage.closed[0]?.code).toBe(RemoteBrowser.CLOSE.protocol)
    const old = viewer(hub)
    old.handle.message(JSON.stringify({ t: "hello", v: 2, viewport: VIEWPORT, mode: "pc", quality: "auto", visible: true }))
    expect(old.closed[0]?.code).toBe(RemoteBrowser.CLOSE.protocol)
    const silent = viewer(hub)
    const polite = viewer(hub)
    polite.hello()
    await advance(BrowserHub.HELLO_TIMEOUT_MS)
    expect(silent.closed).toEqual([{ code: RemoteBrowser.CLOSE.protocol, reason: "no hello" }])
    expect(polite.closed).toEqual([])
    expect(hub.viewers()).toBe(1)
    // A closed viewer's later messages go nowhere.
    early.hello()
    expect(early.sent).toEqual([])
  })

  test("a device that is no longer allowed is closed with the scope code when it speaks or is sent the pane", async () => {
    const { hub, pull, frame } = setup()
    await pull({ hosted: ["ses_1"] })
    const speaking = viewer(hub)
    speaking.hello()
    speaking.device.alive = false
    speaking.say({ t: "input", events: [TAP] })
    expect(speaking.closed).toEqual([{ code: RemoteBrowser.CLOSE.scope, reason: "scope" }])
    expect((await pull({ hosted: ["ses_1"] })).commands).toEqual([])
    const watching = viewer(hub, { deviceId: "dev_b" })
    watching.hello()
    watching.device.alive = false
    expect(await frame("ses_1")).toEqual({ ok: true, viewers: 0, acked: false })
    expect(watching.frames).toEqual([])
    expect(watching.closed).toEqual([{ code: RemoteBrowser.CLOSE.scope, reason: "scope" }])
    const told = viewer(hub, { deviceId: "dev_c" })
    told.hello()
    told.device.alive = false
    const before = told.sent.length
    hub.state({ host: HOST, sessionID: "ses_1", state: PANE })
    expect(told.sent).toHaveLength(before)
    expect(told.closed[0]?.code).toBe(RemoteBrowser.CLOSE.scope)
    expect(hub.viewers()).toBe(0)
  })
})

describe("pull: what the shell streams and does", () => {
  test("views: one per hosted session with a visible viewer; the newest chooser leads, any data saver wins", async () => {
    const { hub, pull } = setup()
    const phone = viewer(hub, { sessionID: "ses_1" })
    const laptop = viewer(hub, { deviceId: "dev_b", sessionID: "ses_1" })
    const elsewhere = viewer(hub, { deviceId: "dev_c", sessionID: "ses_2" })
    const unhosted = viewer(hub, { deviceId: "dev_d", sessionID: "ses_3" })
    phone.hello({ mode: "phone" })
    laptop.hello({ viewport: { width: 1200, height: 700, dpr: 1 } })
    elsewhere.hello({ visible: false })
    unhosted.hello()
    const hosted = ["ses_1", "ses_2"]
    // The laptop joined last: its mode and viewport lead.
    expect((await pull({ hosted })).views).toEqual([
      { sessionID: "ses_1", mode: "pc", quality: "auto", viewport: { width: 1200, height: 700, dpr: 1 } },
    ])
    // The phone chooses again (a rotation): now it leads; the laptop's data saver holds for the session.
    phone.say({ t: "view", viewport: { width: 800, height: 390, dpr: 3 } })
    laptop.say({ t: "view", quality: "low" })
    expect((await pull({ hosted })).views).toEqual([
      { sessionID: "ses_1", mode: "phone", quality: "low", viewport: { width: 800, height: 390, dpr: 3 } },
    ])
    // Hidden: the phone no longer counts, and with nobody visible the session is not streamed at all.
    phone.say({ t: "view", visible: false })
    expect((await pull({ hosted })).views).toEqual([
      { sessionID: "ses_1", mode: "pc", quality: "low", viewport: { width: 1200, height: 700, dpr: 1 } },
    ])
    laptop.handle.leave()
    elsewhere.say({ t: "view", visible: true })
    expect((await pull({ hosted })).views).toEqual([{ sessionID: "ses_2", mode: "pc", quality: "auto", viewport: VIEWPORT }])
    // Visible again without choosing anything: the phone leads its session with what it last chose.
    phone.say({ t: "view", visible: true })
    expect((await pull({ hosted })).views.map((view) => [view.sessionID, view.mode])).toEqual([
      ["ses_1", "phone"],
      ["ses_2", "pc"],
    ])
  })

  test("a pull waits for its time, and wakes on input, an action or a changed view", async () => {
    const { hub, pull, advance } = setup()
    const phone = viewer(hub)
    phone.hello()
    // The first answer is at once: this shell was told nothing yet.
    expect(await pull({ hosted: ["ses_1"], waitMs: 30_000 })).toEqual({
      views: [{ sessionID: "ses_1", mode: "pc", quality: "auto", viewport: VIEWPORT }],
      commands: [],
      idle: false,
    })
    const quiet = { done: false }
    const waiting = pull({ hosted: ["ses_1"], waitMs: 20_000 }).then((output) => {
      quiet.done = true
      return output
    })
    await advance(19_999)
    expect(quiet.done).toBe(false)
    await advance(1)
    expect((await waiting).commands).toEqual([])
    // Input wakes it, in order, merged into one command while it is the same session's.
    const input = pull({ hosted: ["ses_1"], waitMs: 30_000 })
    phone.say({ t: "input", events: [TAP] })
    expect((await input).commands).toEqual([{ type: "input", sessionID: "ses_1", events: [TAP] }])
    phone.say({ t: "input", events: [TAP, MOVE] })
    phone.say({ t: "input", events: [END] })
    phone.say({ t: "action", id: 7, action: { type: "reload" } })
    phone.say({ t: "input", events: [TAP] })
    expect((await pull({ hosted: ["ses_1"], waitMs: 30_000 })).commands).toEqual([
      { type: "input", sessionID: "ses_1", events: [TAP, MOVE, END] },
      { type: "action", sessionID: "ses_1", id: expect.any(String), action: { type: "reload" } },
      { type: "input", sessionID: "ses_1", events: [TAP] },
    ])
    // An action wakes it.
    const action = pull({ hosted: ["ses_1"], waitMs: 30_000 })
    phone.say({ t: "action", id: 8, action: { type: "navigate", url: "https://example.com/" } })
    expect((await action).commands).toHaveLength(1)
    // A changed view wakes it; an unchanged one (a quality it already has) does not.
    const view = { done: false }
    const changed = pull({ hosted: ["ses_1"], waitMs: 30_000 }).then((output) => {
      view.done = true
      return output
    })
    phone.say({ t: "view", quality: "auto" })
    await settled()
    expect(view.done).toBe(false)
    phone.say({ t: "view", mode: "phone" })
    expect((await changed).views).toEqual([{ sessionID: "ses_1", mode: "phone", quality: "auto", viewport: VIEWPORT }])
    // Leaving wakes it too: the shell stops capturing at once.
    const left = pull({ hosted: ["ses_1"], waitMs: 30_000 })
    phone.handle.leave()
    expect(await left).toEqual({ views: [], commands: [], idle: false })
  })

  test("a newer pull of the same shell ends the waiting one without changing what it streams", async () => {
    const { hub, pull } = setup()
    const phone = viewer(hub)
    phone.hello()
    const first = await pull({ hosted: ["ses_1"] })
    const waiting = pull({ hosted: ["ses_1"], waitMs: 30_000 })
    const newer = pull({ hosted: ["ses_1"], waitMs: 30_000 })
    expect(await waiting).toEqual({ views: first.views, commands: [], idle: false })
    phone.say({ t: "input", events: [TAP] })
    expect((await newer).commands).toHaveLength(1)
  })

  test("idle: with no device that could watch, the answer is empty and at once", async () => {
    const { hub, can, pull } = setup()
    can.view = false
    expect(await pull({ hosted: ["ses_1"], waitMs: 30_000 })).toEqual({ views: [], commands: [], idle: true })
    expect(hub.desktop()).toBe(true)
    expect(hub.hosted("ses_1")).toBe(true)
  })

  test("another shell takes over: the old one's wait ends empty, its commands and actions are dropped", async () => {
    const { hub, pull } = setup()
    const other = (input: Partial<BrowserHub.PullInput> = {}) => pull({ host: OTHER_HOST, ...input })
    const phone = viewer(hub)
    phone.hello()
    await pull({ hosted: ["ses_1"] })
    hub.state({ host: HOST, sessionID: "ses_1", state: PANE })
    // The old shell took one action and never answered it; another action and some input wait for its next pull.
    phone.say({ t: "action", id: 1, action: { type: "back" } })
    const [taken] = (await pull({ hosted: ["ses_1"] })).commands
    phone.say({ t: "action", id: 2, action: { type: "forward" } })
    phone.say({ t: "input", events: [TAP] })
    // A restarted shell pulls with a new id: it gets none of that, and the viewer is told for each action.
    expect(await other()).toEqual({ views: [], commands: [], idle: false })
    expect(phone.results().map((result) => [result.id, result.ok, result.error])).toEqual([
      [1, false, "no_host"],
      [2, false, "no_host"],
    ])
    // The pane the old shell reported is not the new one's.
    expect(phone.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "attaching" })
    // The old shell's late answer and frame are refused.
    hub.result({ host: HOST, id: taken?.type === "action" ? taken.id : "", ok: true })
    expect(phone.results()).toHaveLength(2)
    expect(await hub.frame({ host: HOST, sessionID: "ses_1", width: 1, height: 1, sharp: false, data: JPEG })).toEqual({
      ok: false,
      field: "host",
      reason: "not_current",
    })
    expect((await other({ hosted: ["ses_1"] })).commands).toEqual([])
    expect(phone.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "ready" })
    // A shell that is replaced while it waits is answered with nothing to stream.
    const parked = other({ hosted: ["ses_1"], waitMs: 30_000 })
    await pull()
    expect(await parked).toEqual({ views: [], commands: [], idle: false })
  })

  test("a shell that stops pulling is gone after a minute: viewers see absent, and a late pull starts over", async () => {
    const { hub, pull, advance } = setup()
    const phone = viewer(hub)
    phone.hello()
    await pull({ hosted: ["ses_1"] })
    hub.state({ host: HOST, sessionID: "ses_1", state: PANE })
    expect(hub.desktop()).toBe(true)
    await advance(BrowserHub.HOST_TTL_MS - 1)
    expect(hub.desktop()).toBe(true)
    expect(phone.states().at(-1)?.host).toBe("ready")
    phone.say({ t: "action", id: 1, action: { type: "reload" } })
    phone.say({ t: "input", events: [TAP] })
    await advance(1)
    expect(hub.desktop()).toBe(false)
    expect(hub.hosted("ses_1")).toBe(false)
    expect(phone.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "absent" })
    expect(phone.results()).toEqual([{ t: "result", id: 1, ok: false, error: "no_host" }])
    // The same shell again (a PC back from sleep): nothing of before the gap is delivered.
    expect(await pull({ hosted: ["ses_1"] })).toEqual({
      views: [{ sessionID: "ses_1", mode: "pc", quality: "auto", viewport: VIEWPORT }],
      commands: [],
      idle: false,
    })
    expect(phone.states().at(-1)).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "ready" })
    // A shell without a window holds nothing a device could be shown.
    await pull({ windows: 0, hosted: [] })
    expect(hub.desktop()).toBe(false)
    expect(phone.states().at(-1)?.host).toBe("absent")
    // Each pull moves the minute.
    await pull({ hosted: ["ses_1"] })
    await advance(40_000)
    await pull({ hosted: ["ses_1"] })
    await advance(40_000)
    expect(hub.desktop()).toBe(true)
  })
})

describe("frames", () => {
  test("a frame goes to every visible viewer of the session with its header; the first ack answers the shell", async () => {
    const { hub, pull, frame } = setup()
    const phone = viewer(hub)
    const laptop = viewer(hub, { deviceId: "dev_b" })
    const hidden = viewer(hub, { deviceId: "dev_c" })
    const elsewhere = viewer(hub, { deviceId: "dev_d", sessionID: "ses_2" })
    phone.hello()
    laptop.hello()
    hidden.hello({ visible: false })
    elsewhere.hello()
    await pull({ hosted: ["ses_1", "ses_2"] })
    const answer = { value: undefined as BrowserHub.FrameOutput | undefined }
    const pushed = frame("ses_1", { sharp: true }).then((output) => (answer.value = output))
    await settled()
    expect(answer.value).toBeUndefined()
    expect(phone.headers()).toEqual([{ seq: 1, width: 720, height: 1480, sharp: true }])
    expect(laptop.headers()).toEqual(phone.headers())
    expect([...RemoteBrowser.decodeFrame(phone.frames[0]!)!.jpeg]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    expect(hidden.frames).toEqual([])
    expect(elsewhere.frames).toEqual([])
    // An ack of another frame settles nothing.
    phone.ack(99)
    await settled()
    expect(answer.value).toBeUndefined()
    laptop.ack(1)
    expect(await pushed).toEqual({ ok: true, viewers: 2, acked: true })
  })

  test("no ack: the shell is answered after the timeout; nobody watching answers viewers 0 at once", async () => {
    const { hub, pull, frame, advance } = setup()
    const phone = viewer(hub)
    phone.hello()
    await pull({ hosted: ["ses_1"] })
    const answer = { value: undefined as BrowserHub.FrameOutput | undefined }
    void frame("ses_1").then((output) => (answer.value = output))
    await advance(RemoteBrowser.ACK_TIMEOUT_MS - 1)
    expect(answer.value).toBeUndefined()
    await advance(1)
    expect(answer.value).toEqual({ ok: true, viewers: 1, acked: false })
    // A viewer silent for the whole timeout gets the next frame anyway (one every two seconds at most).
    void frame("ses_1")
    expect(phone.headers().map((header) => header.seq)).toEqual([1, 2])
    // Hidden while a frame waits: the wait ends, nobody watches.
    const waiting = frame("ses_1")
    phone.say({ t: "view", visible: false })
    expect(await waiting).toEqual({ ok: true, viewers: 0, acked: false })
    expect(await frame("ses_1")).toEqual({ ok: true, viewers: 0, acked: false })
    // A session the shell does not hold, or one nobody opened.
    expect(await frame("ses_2")).toEqual({ ok: true, viewers: 0, acked: false })
    phone.say({ t: "view", visible: true })
    await pull({ hosted: [] })
    expect(await frame("ses_1")).toEqual({ ok: true, viewers: 0, acked: false })
  })

  test("a viewer still drawing is skipped, and gets the newest frame when it acknowledges; a late viewer gets it too", async () => {
    const { hub, pull, frame } = setup()
    const fast = viewer(hub)
    const slow = viewer(hub, { deviceId: "dev_b" })
    fast.hello()
    slow.hello()
    await pull({ hosted: ["ses_1"] })
    const first = frame("ses_1")
    fast.ack(1)
    expect(await first).toMatchObject({ viewers: 2, acked: true })
    const second = frame("ses_1")
    fast.ack(2)
    await second
    const third = frame("ses_1", { sharp: true })
    fast.ack(3)
    await third
    // The slow one was sent only the first; its ack brings the newest (the sharp one), not the ones in between.
    expect(fast.headers().map((header) => header.seq)).toEqual([1, 2, 3])
    expect(slow.headers().map((header) => header.seq)).toEqual([1])
    slow.ack(1)
    expect(slow.headers()).toEqual([
      { seq: 1, width: 720, height: 1480, sharp: false },
      { seq: 3, width: 720, height: 1480, sharp: true },
    ])
    slow.ack(3)
    expect(slow.frames).toHaveLength(2)
    // Both owe nothing and nobody is behind: a frame every viewer skips waits for the first ack of it.
    const fourth = frame("ses_1")
    const fifth = frame("ses_1")
    expect(fast.headers().map((header) => header.seq)).toEqual([1, 2, 3, 4])
    fast.ack(4)
    expect(await fourth).toMatchObject({ acked: true })
    expect(fast.headers().at(-1)?.seq).toBe(5)
    fast.ack(5)
    expect(await fifth).toMatchObject({ acked: true })
    // A viewer that opens the session now is shown the newest frame without waiting for the page to change.
    const late = viewer(hub, { deviceId: "dev_c" })
    late.hello({ visible: false })
    expect(late.frames).toEqual([])
    late.say({ t: "view", visible: true })
    expect(late.headers().map((header) => header.seq)).toEqual([5])
    // Once nobody looks, the frame is not kept.
    for (const each of [fast, slow, late]) each.say({ t: "view", visible: false })
    late.say({ t: "view", visible: true })
    expect(late.frames).toHaveLength(1)
  })

  test("refused: another host's frame, not base64, not a JPEG, larger than the limit", async () => {
    const { hub, pull, frame } = setup()
    const phone = viewer(hub)
    phone.hello()
    expect(await frame("ses_1")).toEqual({ ok: false, field: "host", reason: "not_current" })
    await pull({ hosted: ["ses_1"] })
    expect(await frame("ses_1", { host: OTHER_HOST })).toEqual({ ok: false, field: "host", reason: "not_current" })
    for (const data of ["%%%%", `${JPEG.slice(0, -4)}*${JPEG.slice(-3)}`, JPEG.slice(0, -1), ` ${JPEG}   `])
      expect({ data, output: await frame("ses_1", { data }) }).toEqual({ data, output: { ok: false, field: "data", reason: "base64" } })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
    expect(await frame("ses_1", { data: png })).toEqual({ ok: false, field: "data", reason: "not_jpeg" })
    expect(await frame("ses_1", { data: "" })).toEqual({ ok: false, field: "data", reason: "not_jpeg" })
    const large = Buffer.alloc(RemoteBrowser.MAX_FRAME_BYTES + 1, 0xff)
    large[1] = 0xd8
    expect(await frame("ses_1", { data: large.toString("base64") })).toEqual({ ok: false, field: "data", reason: "too_large" })
    expect(phone.frames).toEqual([])
    // Exactly the limit passes.
    const exact = Buffer.alloc(RemoteBrowser.MAX_FRAME_BYTES, 0xff)
    exact[1] = 0xd8
    const pushed = frame("ses_1", { data: exact.toString("base64") })
    expect(phone.frames[0]?.byteLength).toBe(RemoteBrowser.FRAME_HEADER_BYTES + RemoteBrowser.MAX_FRAME_BYTES)
    phone.ack(1)
    expect(await pushed).toEqual({ ok: true, viewers: 1, acked: true })
  })
})

describe("input and actions", () => {
  test("a device that may only watch: its input goes nowhere and its action is answered read_only", async () => {
    const { hub, pull } = setup()
    const watcher = viewer(hub, { control: false })
    watcher.hello()
    await pull({ hosted: ["ses_1"] })
    watcher.say({ t: "input", events: [TAP, { k: "text", text: "비밀" }] })
    watcher.say({ t: "action", id: 3, action: { type: "navigate", url: "https://example.com/" } })
    expect(watcher.results()).toEqual([{ t: "result", id: 3, ok: false, error: "read_only" }])
    expect(await pull({ hosted: ["ses_1"] })).toMatchObject({ commands: [] })
    expect(watcher.closed).toEqual([])
  })

  test("no pane: a control viewer's input is dropped and its action answered no_host", async () => {
    const { hub, pull } = setup()
    const phone = viewer(hub)
    phone.hello()
    phone.say({ t: "input", events: [TAP] })
    phone.say({ t: "action", id: 1, action: { type: "reload" } })
    await pull()
    phone.say({ t: "input", events: [TAP] })
    phone.say({ t: "action", id: 2, action: { type: "reload" } })
    expect(phone.results()).toEqual([
      { t: "result", id: 1, ok: false, error: "no_host" },
      { t: "result", id: 2, ok: false, error: "no_host" },
    ])
    expect((await pull({ hosted: ["ses_1"] })).commands).toEqual([])
  })

  test("an action's answer finds its viewer by the hub's id; no answer in 15 s is a timeout", async () => {
    const { hub, pull, advance } = setup()
    const phone = viewer(hub)
    const laptop = viewer(hub, { deviceId: "dev_b" })
    phone.hello()
    laptop.hello()
    await pull({ hosted: ["ses_1"] })
    phone.say({ t: "action", id: 1, action: { type: "back" } })
    laptop.say({ t: "action", id: 1, action: { type: "tabs.open", url: "https://example.com/" } })
    phone.say({ t: "action", id: 2, action: { type: "dialog", accept: true, text: "네" } })
    const commands = (await pull({ hosted: ["ses_1"] })).commands.flatMap((command) => (command.type === "action" ? [command] : []))
    expect(commands.map((command) => command.action.type)).toEqual(["back", "tabs.open", "dialog"])
    expect(new Set(commands.map((command) => command.id)).size).toBe(3)
    hub.result({ host: HOST, id: commands[1]!.id, ok: true })
    hub.result({ host: HOST, id: commands[0]!.id, ok: false, error: "browser.address.blocked" })
    expect(laptop.results()).toEqual([{ t: "result", id: 1, ok: true }])
    expect(phone.results()).toEqual([{ t: "result", id: 1, ok: false, error: "browser.address.blocked" }])
    // Answered once: a second answer and an unknown id change nothing.
    hub.result({ host: HOST, id: commands[1]!.id, ok: false })
    hub.result({ host: HOST, id: "a999", ok: true })
    expect(laptop.results()).toHaveLength(1)
    await advance(BrowserHub.ACTION_TIMEOUT_MS - 1)
    expect(phone.results()).toHaveLength(1)
    await advance(1)
    expect(phone.results().at(-1)).toEqual({ t: "result", id: 2, ok: false, error: "timeout" })
    hub.result({ host: HOST, id: commands[2]!.id, ok: true })
    expect(phone.results()).toHaveLength(2)
    // A failure without a word is `failed`; a viewer that left is not answered.
    laptop.say({ t: "action", id: 9, action: { type: "stop" } })
    phone.say({ t: "action", id: 10, action: { type: "stop" } })
    const [stop, gone] = (await pull({ hosted: ["ses_1"] })).commands.flatMap((command) => (command.type === "action" ? [command] : []))
    phone.handle.leave()
    hub.result({ host: HOST, id: stop!.id, ok: false })
    hub.result({ host: HOST, id: gone!.id, ok: true })
    expect(laptop.results().at(-1)).toEqual({ t: "result", id: 9, ok: false, error: "failed" })
    expect(phone.results()).toHaveLength(2)
  })
})

describe("wanting a pane", () => {
  test("a control viewer on a session without a pane asks for it; a watcher does not; the event repeats every 5 s", async () => {
    const { hub, wanted, pull, advance } = setup()
    await pull()
    const watcher = viewer(hub, { deviceId: "dev_b", control: false, sessionID: "ses_2" })
    watcher.hello()
    const hidden = viewer(hub, { deviceId: "dev_c", sessionID: "ses_3" })
    hidden.hello({ visible: false })
    expect(wanted).toEqual([])
    expect(hub.wanted()).toEqual([])
    const phone = viewer(hub)
    phone.hello()
    expect(wanted).toEqual(["ses_1"])
    expect(hub.wanted()).toEqual(["ses_1"])
    // A second wish within the gap is remembered, not announced again.
    hub.want("ses_1")
    expect(wanted).toEqual(["ses_1"])
    await advance(BrowserHub.WANT_EMIT_GAP_MS - 1)
    expect(wanted).toEqual(["ses_1"])
    await pull()
    await advance(1)
    expect(wanted).toEqual(["ses_1", "ses_1"])
    // Turning visible asks too.
    hidden.say({ t: "view", visible: true })
    expect(wanted).toEqual(["ses_1", "ses_1", "ses_3"])
    // While the viewer stays, the wish outlives its minute.
    for (let step = 0; step < 16; step++) {
      await pull()
      await advance(BrowserHub.WANT_EMIT_GAP_MS)
    }
    expect(hub.wanted().sort()).toEqual(["ses_1", "ses_3"])
    expect(wanted.filter((sessionID) => sessionID === "ses_1").length).toBeGreaterThanOrEqual(17)
    // Hosted: no longer wanted, no more events for it.
    await pull({ hosted: ["ses_1"] })
    expect(hub.wanted()).toEqual(["ses_3"])
    const count = wanted.filter((sessionID) => sessionID === "ses_1").length
    await advance(BrowserHub.WANT_EMIT_GAP_MS)
    expect(wanted.filter((sessionID) => sessionID === "ses_1")).toHaveLength(count)
    // The pane went away under a watching control viewer: asked again.
    await pull({ hosted: [] })
    expect(wanted.at(-1)).toBe("ses_1")
    // The viewers leave: the wishes last a minute more, then end, and so do the events.
    phone.handle.leave()
    hidden.handle.leave()
    for (let step = 0; step < 11; step++) {
      await pull()
      await advance(BrowserHub.WANT_EMIT_GAP_MS)
    }
    expect(hub.wanted().sort()).toEqual(["ses_1", "ses_3"])
    await pull()
    await advance(BrowserHub.WANT_EMIT_GAP_MS)
    expect(hub.wanted()).toEqual([])
    const total = wanted.length
    await pull()
    await advance(60_000)
    expect(wanted).toHaveLength(total)
  })

  test("without a desktop app the wish is kept quietly, and announced when one comes", async () => {
    const { hub, wanted, pull, advance } = setup()
    const phone = viewer(hub)
    phone.hello()
    expect(wanted).toEqual([])
    expect(hub.wanted()).toEqual(["ses_1"])
    await advance(30_000)
    expect(wanted).toEqual([])
    expect(hub.wanted()).toEqual(["ses_1"])
    await pull()
    expect(wanted).toEqual(["ses_1"])
    expect(phone.states().at(-1)?.host).toBe("attaching")
  })

  test("ensure: false without a desktop, true when hosted, else it waits for the shell's report", async () => {
    const { hub, wanted, pull, advance } = setup()
    expect(await hub.ensure("ses_1", 3000)).toBe(false)
    expect(wanted).toEqual([])
    await pull({ hosted: ["ses_2"] })
    expect(await hub.ensure("ses_2", 3000)).toBe(true)
    expect(wanted).toEqual([])
    const answer = { value: undefined as boolean | undefined }
    void hub.ensure("ses_1", 3000).then((hosted) => (answer.value = hosted))
    const second = hub.ensure("ses_1", 3000)
    expect(wanted).toEqual(["ses_1"])
    await advance(2999)
    expect(answer.value).toBeUndefined()
    await pull({ hosted: ["ses_1", "ses_2"] })
    await settled()
    expect(answer.value).toBe(true)
    expect(await second).toBe(true)
    expect(hub.wanted()).toEqual([])
  })

  test("ensure: a pane that does not come in time is not waited for again for five minutes", async () => {
    const { hub, wanted, pull, advance } = setup()
    const keep = async (ms: number) => {
      for (let passed = 0; passed < ms; passed += 30_000) {
        await pull()
        await advance(Math.min(30_000, ms - passed))
      }
      await pull()
    }
    await pull()
    const first = hub.ensure("ses_1", 3000)
    await advance(3000)
    expect(await first).toBe(false)
    const emitted = wanted.length
    // At once, and still asking (the window may attach it for a later step).
    await advance(BrowserHub.WANT_EMIT_GAP_MS)
    await pull()
    const again = { value: undefined as boolean | undefined }
    void hub.ensure("ses_1", 3000).then((hosted) => (again.value = hosted))
    await settled()
    expect(again.value).toBe(false)
    expect(wanted.length).toBeGreaterThan(emitted)
    // Another session is not held back by it.
    const other = hub.ensure("ses_2", 3000)
    await pull({ hosted: ["ses_2"] })
    expect(await other).toBe(true)
    // After five minutes it is worth a wait again; and a pane that came clears the memory at once.
    await keep(BrowserHub.REFUSED_TTL_MS)
    const later = { value: undefined as boolean | undefined }
    void hub.ensure("ses_1", 3000).then((hosted) => (later.value = hosted))
    await settled()
    expect(later.value).toBeUndefined()
    await advance(3000)
    expect(later.value).toBe(false)
    await pull({ hosted: ["ses_1"] })
    await pull({ hosted: [] })
    const cleared = { value: undefined as boolean | undefined }
    void hub.ensure("ses_1", 3000).then((hosted) => (cleared.value = hosted))
    await settled()
    expect(cleared.value).toBeUndefined()
    await pull({ hosted: ["ses_1"] })
    await settled()
    expect(cleared.value).toBe(true)
  })
})

describe("panes of SSH hosts (05 §8.10.8)", () => {
  const SSH = "h-ab12cd"
  const KEY = `${SSH}/ses_1`

  test("a host's session is its own pane: views and commands name the host, a local session of the same id is apart", async () => {
    const { hub, pull, frame, wanted } = setup()
    const remote = viewer(hub, { serverKey: SSH })
    const local = viewer(hub, { deviceId: "dev_b" })
    remote.hello()
    local.hello({ visible: false })
    // Asked for by its key; the window learns the host from the event (gateway `named`).
    await pull()
    expect(wanted).toEqual([KEY])
    expect(BrowserHub.named(KEY)).toEqual({ serverKey: SSH, sessionID: "ses_1" })
    expect(BrowserHub.named("ses_1")).toEqual({ sessionID: "ses_1" })
    expect(hub.wanted()).toEqual([KEY])
    // The shell reports the host's pane by its key; a local `ses_1` is not hosted by that.
    expect((await pull({ hosted: [KEY] })).views).toEqual([
      { serverKey: SSH, sessionID: "ses_1", mode: "pc", quality: "auto", viewport: VIEWPORT },
    ])
    expect(remote.states().at(-1)?.host).toBe("ready")
    expect(local.states().at(-1)?.host).toBe("attaching")
    remote.say({ t: "input", events: [TAP] })
    remote.say({ t: "action", id: 4, action: { type: "reload" } })
    const commands = (await pull({ hosted: [KEY] })).commands
    expect(commands).toEqual([
      { type: "input", serverKey: SSH, sessionID: "ses_1", events: [TAP] },
      { type: "action", serverKey: SSH, sessionID: "ses_1", id: expect.any(String), action: { type: "reload" } },
    ])
    // A frame of the host's pane reaches its viewer only; one named as local reaches nobody (not hosted).
    expect(await frame("ses_1")).toEqual({ ok: true, viewers: 0, acked: false })
    const sent = frame("ses_1", { serverKey: SSH })
    expect(remote.frames).toHaveLength(1)
    expect(local.frames).toHaveLength(0)
    remote.ack(remote.headers()[0]!.seq)
    expect(await sent).toEqual({ ok: true, viewers: 1, acked: true })
    // The pane's state goes to its viewers by the same key.
    hub.state({ host: HOST, serverKey: SSH, sessionID: "ses_1", state: PANE })
    expect(remote.states().at(-1)).toEqual({ ...PANE, host: "ready" })
    expect(local.states().at(-1)?.tabs).toEqual([])
  })

  test("ensure and its refusal are per pane key", async () => {
    const { hub, pull, advance } = setup()
    await pull()
    const waiting = hub.ensure(KEY, 3000)
    await pull({ hosted: [KEY] })
    expect(await waiting).toBe(true)
    await pull({ hosted: [] })
    const late = hub.ensure(KEY, 3000)
    await advance(3000)
    expect(await late).toBe(false)
    // Refused for five minutes: that key only.
    expect(await hub.ensure(KEY, 3000)).toBe(false)
    const local = hub.ensure("ses_1", 3000)
    await pull({ hosted: ["ses_1"] })
    expect(await local).toBe(true)
  })
})

describe("limits", () => {
  test("four viewers a device, sixteen in all: one more is closed with try-again-later", () => {
    const { hub } = setup()
    const mine = [0, 1, 2, 3].map(() => viewer(hub, { deviceId: "dev_a" }))
    const fifth = viewer(hub, { deviceId: "dev_a" })
    expect(fifth.closed).toEqual([{ code: BrowserHub.CLOSE_BUSY, reason: "too many viewers" }])
    expect(mine.every((each) => each.closed.length === 0)).toBe(true)
    // A place freed is a place again.
    mine[0]!.handle.leave()
    expect(viewer(hub, { deviceId: "dev_a" }).closed).toEqual([])
    const others = Array.from({ length: 12 }, (_, index) => viewer(hub, { deviceId: `dev_${index}` }))
    expect(others.every((each) => each.closed.length === 0)).toBe(true)
    expect(hub.viewers()).toBe(BrowserHub.MAX_VIEWERS)
    expect(viewer(hub, { deviceId: "dev_z" }).closed).toEqual([{ code: BrowserHub.CLOSE_BUSY, reason: "too many viewers" }])
    // A refused socket's messages go nowhere.
    fifth.hello()
    expect(fifth.sent).toEqual([])
  })

  test("a viewer's messages have a budget: input past it is dropped until time refills it", async () => {
    const { hub, pull, advance } = setup()
    const phone = viewer(hub)
    phone.hello()
    await pull({ hosted: ["ses_1"] })
    const burst = BrowserHub.MESSAGE_RATE * 2
    for (let index = 0; index < burst + 50; index++) phone.say({ t: "input", events: [TAP] })
    // The hello took one of the burst.
    const [first] = (await pull({ hosted: ["ses_1"] })).commands
    expect(first?.type === "input" ? first.events.length : 0).toBe(burst - 1)
    // Out of budget: an action is refused, a view change waits for the next message, an ack still counts.
    phone.say({ t: "action", id: 1, action: { type: "reload" } })
    expect(phone.results()).toEqual([{ t: "result", id: 1, ok: false, error: "failed" }])
    phone.say({ t: "view", mode: "phone" })
    expect((await pull({ hosted: ["ses_1"] })).views[0]?.mode).toBe("pc")
    const pushed = hub.frame({ host: HOST, sessionID: "ses_1", width: 1, height: 1, sharp: false, data: JPEG })
    phone.ack(1)
    expect(await pushed).toMatchObject({ acked: true })
    expect(phone.closed).toEqual([])
    await advance(1000)
    for (let index = 0; index < burst; index++) phone.say({ t: "input", events: [TAP] })
    const [second] = (await pull({ hosted: ["ses_1"] })).commands
    expect(second?.type === "input" ? second.events.length : 0).toBe(BrowserHub.MESSAGE_RATE)
  })

  test("the input queue is bounded: the oldest moves go first, then the oldest events", async () => {
    const { hub, pull, advance } = setup()
    const phone = viewer(hub)
    const laptop = viewer(hub, { deviceId: "dev_b" })
    phone.hello()
    laptop.hello()
    await pull({ hosted: ["ses_1"] })
    const key = (text: string): RemoteBrowser.InputEvent => ({ k: "key", key: text })
    // 8 messages of 64 events fill the queue: a tap, 62 moves and an end each.
    const stroke = [TAP, ...Array.from({ length: 62 }, () => MOVE), END]
    for (let index = 0; index < 8; index++) phone.say({ t: "input", events: stroke })
    laptop.say({ t: "action", id: 1, action: { type: "reload" } })
    laptop.say({ t: "input", events: Array.from({ length: 64 }, () => key("a")) })
    const commands = (await pull({ hosted: ["ses_1"] })).commands
    expect(commands.map((command) => command.type)).toEqual(["input", "action", "input"])
    const [strokes, , keys] = commands
    const events = strokes?.type === "input" ? strokes.events : []
    // 64 moves gave way, the oldest first: the first stroke lost all 62 of its, the second two.
    expect(events).toHaveLength(BrowserHub.MAX_QUEUED_EVENTS - 64)
    expect(events.slice(0, 3)).toEqual([TAP, END, TAP])
    expect(events.filter((event) => event.k === "touch" && event.phase !== "move")).toHaveLength(16)
    expect(keys?.type === "input" ? keys.events.length : 0).toBe(64)
    // Nothing left to thin out: the oldest events go, whatever they are, and an emptied command with them.
    await advance(10_000)
    for (let index = 0; index < 8; index++) phone.say({ t: "input", events: Array.from({ length: 64 }, () => key("b")) })
    laptop.say({ t: "action", id: 2, action: { type: "reload" } })
    for (let index = 0; index < 8; index++) laptop.say({ t: "input", events: Array.from({ length: 64 }, () => key("c")) })
    const flooded = (await pull({ hosted: ["ses_1"] })).commands
    expect(flooded.map((command) => (command.type === "input" ? command.events.length : command.type))).toEqual(["action", 512])
    expect(flooded.flatMap((command) => (command.type === "input" ? command.events : [])).every((event) => event.k === "key" && event.key === "c")).toBe(true)
  })
})

describe("closing", () => {
  test("closeAll: viewers get the away code, and whoever waits is answered; the hub can be used again", async () => {
    const { hub, pull, frame } = setup()
    const phone = viewer(hub)
    phone.hello()
    await pull({ hosted: ["ses_1"] })
    const waiting = pull({ hosted: ["ses_1"], waitMs: 30_000 })
    const pushed = frame("ses_1")
    const ensured = hub.ensure("ses_2", 3000)
    hub.closeAll()
    expect(phone.closed).toEqual([{ code: RemoteBrowser.CLOSE.away, reason: "gateway closing" }])
    expect(await waiting).toEqual({ views: [], commands: [], idle: false })
    expect(await pushed).toEqual({ ok: true, viewers: 0, acked: false })
    expect(await ensured).toBe(false)
    expect(hub.viewers()).toBe(0)
    expect(hub.wanted()).toEqual([])
    // The shell goes on pulling; a viewer of the reopened gateway is served.
    const back = viewer(hub)
    back.hello()
    expect((await pull({ hosted: ["ses_1"] })).views).toHaveLength(1)
    expect(back.states().at(-1)?.host).toBe("ready")
  })
})

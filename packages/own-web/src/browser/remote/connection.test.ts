// The device viewer's socket (05 §8.10) against a scripted gateway: the greeting, frames acknowledged after they are
// drawn, a hidden view, the reconnect delays, the gateway's close codes, actions and their results, input messages.
import { describe, expect, test } from "bun:test"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { createViewerConnection, HIDDEN_CLOSE_MS, viewerUrl, type Frame, type ViewerSocket } from "./connection"

const VIEWPORT = { width: 384, height: 654, dpr: 2.8125 }

class FakeSocket implements ViewerSocket {
  binaryType = ""
  readyState = 0
  readonly sent: RemoteBrowser.ClientMessage[] = []
  closedWith: number | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number }) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string) {
    const message = RemoteBrowser.parseClientMessage(data)
    if (!message) throw new Error(`the gateway would close the socket for: ${data}`)
    this.sent.push(message)
  }
  close(code?: number) {
    this.closedWith = code
    this.readyState = 3
  }
  /** The upgrade succeeded. */
  accept() {
    this.readyState = 1
    this.onopen?.()
  }
  /** The gateway's `ready` and first `state`, as after a valid `hello`. */
  greet(control = true, host: RemoteBrowser.HostState = "ready") {
    this.server({ t: "ready", v: 1, control })
    this.server({ t: "state", state: { ...RemoteBrowser.EMPTY_PANE, host } })
  }
  server(message: RemoteBrowser.ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  frame(seq: number, sharp = false) {
    const bytes = RemoteBrowser.encodeFrame({ seq, width: 720, height: 450, sharp }, new Uint8Array([0xff, 0xd8, seq]))
    this.onmessage?.({ data: bytes.buffer })
  }
  /** The other side closed it (or the network did: 1006). */
  end(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  of<T extends RemoteBrowser.ClientMessage["t"]>(type: T) {
    return this.sent.filter((message): message is Extract<RemoteBrowser.ClientMessage, { t: T }> => message.t === type)
  }
}

function rig(options: { readonly paint?: (frame: Frame) => Promise<unknown> } = {}) {
  const sockets: FakeSocket[] = []
  const timers: { run: () => void; ms: number; live: boolean }[] = []
  const painted: number[] = []
  const pending: Array<() => void> = []
  const refused: string[] = []
  const notices: string[] = []
  const settings = { viewport: VIEWPORT, mode: "pc" as RemoteBrowser.Mode, quality: "auto" as RemoteBrowser.Quality }
  const connection = createViewerConnection({
    url: "ws://127.0.0.1:6482/own/browser/local/ses_1",
    settings: () => settings,
    paint:
      options.paint ??
      ((frame) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            painted.push(frame.header.seq)
            resolve()
          })
        })),
    onNotice: (kind) => notices.push(kind),
    onRefused: (why) => refused.push(why),
    open(url) {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    timer(run, ms) {
      const entry = { run, ms, live: true }
      timers.push(entry)
      return () => void (entry.live = false)
    },
  })
  return {
    connection,
    sockets,
    timers,
    painted,
    refused,
    notices,
    settings,
    socket: () => sockets.at(-1)!,
    /** Finishes the frame being drawn (and lets its acknowledgement go out). */
    async draw() {
      pending.shift()?.()
      await Bun.sleep(0)
    },
    /** The timers still waiting, as their delays. */
    waiting: () => timers.filter((timer) => timer.live).map((timer) => timer.ms),
    /** Runs the newest waiting timer. */
    fire() {
      const timer = timers.findLast((entry) => entry.live)
      if (!timer) throw new Error("no timer waits")
      timer.live = false
      timer.run()
    },
    /** A connected, greeted viewer. */
    connect(control = true) {
      connection.start()
      sockets.at(-1)!.accept()
      sockets.at(-1)!.greet(control)
    },
  }
}

test("the socket is the page's own origin, as ws, on the viewer path of the session's server", () => {
  expect(viewerUrl("https://pc.tailnet.ts.net/srv/local", "local", "ses_1")).toBe(
    "wss://pc.tailnet.ts.net/own/browser/local/ses_1",
  )
  expect(viewerUrl("http://127.0.0.1:6482/srv/local", "local", "ses a/b")).toBe(
    "ws://127.0.0.1:6482/own/browser/local/ses%20a%2Fb",
  )
  // An SSH host's conversation (05 §8.10.8): the same gateway, the host's key in the path.
  expect(viewerUrl("https://pc.tailnet.ts.net/srv/h-abc123", "h-abc123", "ses_1")).toBe(
    "wss://pc.tailnet.ts.net/own/browser/h-abc123/ses_1",
  )
})

describe("greeting", () => {
  test("hello goes first, with the view's area, mode and quality; ready makes it open", () => {
    const r = rig()
    expect(r.connection.link()).toBe("idle")
    r.connection.start()
    expect(r.connection.link()).toBe("connecting")
    expect(r.socket().url).toBe("ws://127.0.0.1:6482/own/browser/local/ses_1")
    expect(r.socket().sent).toEqual([])
    r.socket().accept()
    expect(r.socket().binaryType).toBe("arraybuffer")
    expect(r.socket().sent).toEqual([
      { t: "hello", v: 1, viewport: VIEWPORT, mode: "pc", quality: "auto", visible: true },
    ])
    expect(r.connection.link()).toBe("connecting")
    r.socket().greet(true, "attaching")
    expect(r.connection.link()).toBe("open")
    expect(r.connection.control()).toBe(true)
    expect(r.connection.state()?.host).toBe("attaching")
  })

  test("a device without prompt is told it only watches; its input is not even sent", () => {
    const r = rig()
    r.connect(false)
    expect(r.connection.control()).toBe(false)
    r.connection.input([{ k: "text", text: "a" }])
    expect(r.socket().of("input")).toEqual([])
  })

  test("settings that change later go as view; notices reach the caller", () => {
    const r = rig()
    r.connect()
    r.connection.view({ mode: "phone", viewport: VIEWPORT })
    r.connection.view({ quality: "low" })
    expect(r.socket().of("view")).toEqual([
      { t: "view", mode: "phone", viewport: VIEWPORT },
      { t: "view", quality: "low" },
    ])
    r.socket().server({ t: "notice", kind: "download" })
    r.socket().server({ t: "notice", kind: "file_chooser" })
    expect(r.notices).toEqual(["download", "file_chooser"])
  })
})

describe("frames", () => {
  test("a frame is acknowledged after it was drawn, not when it arrived", async () => {
    const r = rig()
    r.connect()
    r.socket().frame(11)
    expect(r.socket().of("ack")).toEqual([])
    expect(r.connection.painted()).toBeUndefined()
    await r.draw()
    expect(r.painted).toEqual([11])
    expect(r.socket().of("ack")).toEqual([{ t: "ack", seq: 11 }])
    expect(r.connection.painted()).toEqual({ seq: 11, width: 720, height: 450, sharp: false })
  })

  test("one frame is drawn at a time; of those that arrive meanwhile only the newest is drawn next", async () => {
    const r = rig()
    r.connect()
    r.socket().frame(1)
    r.socket().frame(2)
    r.socket().frame(3, true)
    await r.draw()
    expect(r.painted).toEqual([1])
    await r.draw()
    expect(r.painted).toEqual([1, 3])
    expect(
      r
        .socket()
        .of("ack")
        .map((message) => message.seq),
    ).toEqual([1, 3])
    expect(r.connection.painted()?.sharp).toBe(true)
    await r.draw()
    expect(r.painted).toEqual([1, 3])
  })

  test("a frame that cannot be drawn is acknowledged too, so the next one comes", async () => {
    const r = rig({ paint: () => Promise.reject(new Error("not an image")) })
    r.connect()
    r.socket().frame(5)
    await Bun.sleep(0)
    expect(r.socket().of("ack")).toEqual([{ t: "ack", seq: 5 }])
  })

  test("bytes that are no frame are ignored", async () => {
    const r = rig()
    r.connect()
    r.socket().onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer })
    await r.draw()
    expect(r.painted).toEqual([])
    expect(r.socket().of("ack")).toEqual([])
  })

  test("the acknowledgement of a frame goes only to the socket that sent it", async () => {
    const r = rig()
    r.connect()
    const first = r.socket()
    first.frame(1)
    first.end(1006)
    r.fire()
    r.socket().accept()
    r.socket().greet()
    await r.draw()
    expect(first.of("ack")).toEqual([])
    expect(r.socket().of("ack")).toEqual([])
  })
})

describe("a view that is not on screen", () => {
  test("says so at once, draws nothing, and says when it is back", async () => {
    const r = rig()
    r.connect()
    r.connection.setVisible(false)
    expect(r.socket().of("view")).toEqual([{ t: "view", visible: false }])
    r.socket().frame(4)
    await r.draw()
    expect(r.painted).toEqual([])
    expect(r.socket().of("ack")).toEqual([])
    r.connection.setVisible(true)
    expect(r.socket().of("view")).toEqual([
      { t: "view", visible: false },
      { t: "view", visible: true },
    ])
    expect(r.sockets).toHaveLength(1)
    expect(r.waiting()).toEqual([])
  })

  test("after a minute hidden the socket is let go; back on screen it connects again", () => {
    const r = rig()
    r.connect()
    r.connection.setVisible(false)
    expect(r.waiting()).toEqual([HIDDEN_CLOSE_MS])
    r.fire()
    expect(r.socket().closedWith).toBe(1000)
    expect(r.connection.link()).toBe("idle")
    r.connection.setVisible(true)
    expect(r.sockets).toHaveLength(2)
    r.socket().accept()
    expect(r.socket().of("hello")[0]?.visible).toBe(true)
  })

  test("opened while hidden: hello says so, and nothing is retried until it shows", () => {
    const r = rig()
    r.connection.setVisible(false)
    r.connection.start()
    expect(r.sockets).toEqual([])
    r.connection.setVisible(true)
    r.connection.setVisible(false)
    r.socket().accept()
    expect(r.socket().of("hello")[0]?.visible).toBe(false)
    r.socket().end(1006)
    expect(r.connection.link()).toBe("idle")
    expect(r.waiting().filter((ms) => ms !== HIDDEN_CLOSE_MS)).toEqual([])
    r.connection.setVisible(true)
    expect(r.sockets).toHaveLength(2)
  })

  test("a retry that waits is called off when the view hides", () => {
    const r = rig()
    r.connect()
    r.socket().end(1006)
    expect(r.waiting()).toEqual([1000])
    r.connection.setVisible(false)
    expect(r.waiting()).toEqual([])
    expect(r.connection.link()).toBe("idle")
  })
})

describe("a lost socket", () => {
  test("is opened again after 1, 2, 4, 8, 15, 15 s, and the delay starts over once the gateway greets", () => {
    const r = rig()
    r.connect()
    const delays: number[] = []
    for (let round = 0; round < 6; round++) {
      r.socket().end(1006)
      expect(r.connection.link()).toBe("retrying")
      delays.push(r.waiting()[0]!)
      r.fire()
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000])
    r.socket().accept()
    r.socket().greet()
    expect(r.connection.link()).toBe("open")
    r.socket().end(RemoteBrowser.CLOSE.away)
    expect(r.waiting()).toEqual([1000])
  })

  test("keeps the last state while it reconnects", () => {
    const r = rig()
    r.connect()
    r.socket().end(1006)
    expect(r.connection.state()?.host).toBe("ready")
    expect(r.connection.link()).toBe("retrying")
  })

  test("a socket that never opened may be a refusal the page cannot see: the caller is told", () => {
    const r = rig()
    r.connection.start()
    r.socket().end(1006)
    expect(r.refused).toEqual(["unreachable"])
    expect(r.waiting()).toEqual([1000])
    r.fire()
    r.socket().accept()
    r.socket().greet()
    r.socket().end(1006)
    expect(r.refused).toEqual(["unreachable"])
  })

  test("revoked (4401) and a changed scope (4403) are not retried; the caller reads the device again", () => {
    for (const [code, why] of [
      [RemoteBrowser.CLOSE.revoked, "revoked"],
      [RemoteBrowser.CLOSE.scope, "scope"],
    ] as const) {
      const r = rig()
      r.connect()
      r.socket().end(code)
      expect(r.refused).toEqual([why])
      expect(r.connection.link()).toBe("idle")
      expect(r.waiting()).toEqual([])
      // … and may start it again once the device still holds `browser` (a new `control` comes with `ready`).
      r.connection.start()
      expect(r.sockets).toHaveLength(2)
      r.socket().accept()
      r.socket().greet(false)
      expect(r.connection.control()).toBe(false)
    }
  })

  test("too many viewers (1013) waits for the user", () => {
    const r = rig()
    r.connect()
    r.socket().end(RemoteBrowser.CLOSE.busy)
    expect(r.connection.link()).toBe("busy")
    expect(r.waiting()).toEqual([])
    r.connection.setVisible(false)
    r.connection.setVisible(true)
    expect(r.sockets).toHaveLength(1)
    r.connection.start()
    expect(r.sockets).toHaveLength(2)
  })

  test("closing the view closes the socket and nothing comes back", async () => {
    const r = rig()
    r.connect()
    r.socket().frame(1)
    r.connection.close()
    expect(r.socket().closedWith).toBe(1000)
    expect(r.connection.link()).toBe("idle")
    await r.draw()
    expect(r.socket().of("ack")).toEqual([])
    r.socket().end(1000)
    r.connection.start()
    r.connection.setVisible(false)
    r.connection.setVisible(true)
    expect(r.sockets).toHaveLength(1)
    expect(r.waiting()).toEqual([])
  })
})

describe("actions and input", () => {
  test("an action gets the result with its id", async () => {
    const r = rig()
    r.connect()
    const navigate = r.connection.action({ type: "navigate", url: "https://example.com/" })
    const back = r.connection.action({ type: "back" })
    const [first, second] = r.socket().of("action")
    expect(first).toEqual({ t: "action", id: 1, action: { type: "navigate", url: "https://example.com/" } })
    expect(second?.id).toBe(2)
    r.socket().server({ t: "result", id: 2, ok: false, error: "timeout" })
    r.socket().server({ t: "result", id: 1, ok: true })
    expect(await navigate).toEqual({ ok: true })
    expect(await back).toEqual({ ok: false, error: "timeout" })
  })

  test("a failure without a word is `failed`; one that cannot be sent, or lost its socket, is `no_host`", async () => {
    const r = rig()
    expect(await r.connection.action({ type: "reload" })).toEqual({ ok: false, error: "no_host" })
    r.connect()
    const reload = r.connection.action({ type: "reload" })
    r.socket().server({ t: "result", id: 1, ok: false })
    expect(await reload).toEqual({ ok: false, error: "failed" })
    const stop = r.connection.action({ type: "stop" })
    r.socket().end(1006)
    expect(await stop).toEqual({ ok: false, error: "no_host" })
  })

  test("input goes as it is given; a long paste is split under the gateway's message limit", () => {
    const r = rig()
    r.connect()
    r.connection.input([
      { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] },
      { k: "touch", phase: "end", points: [] },
    ])
    expect(r.socket().of("input")).toHaveLength(1)
    const paste = RemoteBrowser.typed({ before: "", after: "가".repeat(30_000), composed: "", composing: "" })
    r.connection.input(paste)
    const messages = r.socket().of("input").slice(1)
    expect(messages.length).toBeGreaterThan(1)
    expect(messages.flatMap((message) => message.events)).toEqual(paste)
    for (const message of messages)
      expect(JSON.stringify(message).length).toBeLessThanOrEqual(RemoteBrowser.MAX_MESSAGE_BYTES)
  })

  test("nothing is sent before the greeting went out", () => {
    const r = rig()
    r.connection.start()
    r.connection.view({ mode: "phone" })
    r.connection.input([{ k: "text", text: "a" }])
    expect(r.socket().sent).toEqual([])
  })
})

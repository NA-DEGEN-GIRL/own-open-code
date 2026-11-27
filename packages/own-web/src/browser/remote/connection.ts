// The device viewer's socket to the gateway's hub (05 §8.10, `RemoteBrowser`): `/own/browser/local/<sessionID>` on the
// page's own origin (the device cookie authenticates it, like the terminal's socket).
//  - `hello` first, with the view area, mode, quality and whether the view is on screen; then `ready{control}`,
//    `state`, binary frames, `result` and `notice` arrive.
//  - Frames: one is painted at a time and acknowledged once it is drawn (the hub sends the next one after that, so a
//    slow link gets fewer frames); a frame that arrives meanwhile waits, and a newer one replaces it.
//  - Not on screen (`setVisible(false)`: the layer is behind a page, the tab is hidden, the app is in the
//    background): `view{visible:false}` at once, so the PC stops capturing; after a minute the socket closes too.
//    Back on screen it says so, or connects again.
//  - A lost socket is opened again after 1, 2, 4, 8, then 15 s, only while the view is on screen. The gateway's own
//    endings are not retried: 4401 (the device was revoked), 4403 (its scopes changed: the caller reads the device
//    again and decides), 1013 (too many viewers). A socket that never opened may be a refusal before the upgrade,
//    which a page cannot tell from a dead network: the caller is told (`unreachable`) and may read the device again.
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { createSignal } from "solid-js"
import { backoff, type Link } from "./model"

export interface ViewerSocket {
  binaryType: string
  readonly readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number }) => void) | null
}

export interface ViewSettings {
  readonly viewport: RemoteBrowser.Viewport
  readonly mode: RemoteBrowser.Mode
  readonly quality: RemoteBrowser.Quality
}

export interface Frame {
  readonly header: RemoteBrowser.FrameHeader
  readonly jpeg: Uint8Array
}

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** A hidden view keeps its socket this long (the state stays fresh for a quick return), then lets it go. */
export const HIDDEN_CLOSE_MS = 60_000
const OPEN = 1
/** Room under `MAX_MESSAGE_BYTES` for the message's own wrapping. */
const INPUT_BYTES = RemoteBrowser.MAX_MESSAGE_BYTES - 256

/** The gateway's viewer socket of a session of `serverKey` (`local` or an SSH host's id), at the page's own origin. */
export function viewerUrl(baseUrl: string, serverKey: string, sessionID: string) {
  const origin = new URL(baseUrl).origin.replace(/^http/, "ws")
  return `${origin}${RemoteBrowser.socketPath(serverKey, sessionID)}`
}

export function createViewerConnection(input: {
  readonly url: string
  /** Read for `hello`. */
  readonly settings: () => ViewSettings
  /** Draws one frame; the acknowledgement follows it, also when it could not be drawn. */
  readonly paint: (frame: Frame) => Promise<unknown>
  readonly onNotice?: (kind: RemoteBrowser.Notice) => void
  readonly onRefused?: (why: "revoked" | "scope" | "unreachable") => void
  readonly open?: (url: string) => ViewerSocket
  readonly timer?: (run: () => void, ms: number) => () => void
}) {
  const open = input.open ?? ((url: string) => new WebSocket(url) as unknown as ViewerSocket)
  const timer =
    input.timer ??
    ((run, ms) => {
      const id = setTimeout(run, ms)
      return () => clearTimeout(id)
    })
  const [link, setLink] = createSignal<Link>("idle")
  const [control, setControl] = createSignal(false)
  const [state, setState] = createSignal<RemoteBrowser.ViewState>()
  const [painted, setPainted] = createSignal<RemoteBrowser.FrameHeader>()
  const actions = new Map<number, (result: ActionResult) => void>()
  let socket: ViewerSocket | undefined
  /** The socket whose `hello` went out: messages may follow it. */
  let greeted: ViewerSocket | undefined
  let visible = true
  let closed = false
  let attempt = 0
  let actionID = 0
  let stopRetry: (() => void) | undefined
  let stopIdle: (() => void) | undefined
  let painting = false
  let waiting: { readonly frame: Frame; readonly from: ViewerSocket } | undefined

  const live = () => (socket && socket === greeted && socket.readyState === OPEN ? socket : undefined)
  const send = (message: RemoteBrowser.ClientMessage) => live()?.send(JSON.stringify(message))
  const fail = () => {
    const unanswered = [...actions.values()]
    actions.clear()
    unanswered.forEach((answer) => answer({ ok: false, error: RemoteBrowser.ACTION_ERROR.noHost }))
  }
  const pump = () => {
    if (painting || !waiting) return
    const current = waiting
    waiting = undefined
    painting = true
    void input
      .paint(current.frame)
      .catch(() => undefined)
      .then(() => {
        painting = false
        if (closed) return
        setPainted(current.frame.header)
        if (socket === current.from && socket.readyState === OPEN)
          socket.send(JSON.stringify({ t: "ack", seq: current.frame.header.seq } satisfies RemoteBrowser.ClientMessage))
        pump()
      })
  }
  const receive = (from: ViewerSocket, data: unknown) => {
    if (typeof data !== "string") {
      const frame = data instanceof ArrayBuffer ? RemoteBrowser.decodeFrame(new Uint8Array(data)) : undefined
      if (!frame || !visible) return
      waiting = { frame, from }
      return pump()
    }
    const message = parse(data)
    if (!message) return
    if (message.t === "ready") {
      attempt = 0
      setControl(message.control === true)
      return setLink("open")
    }
    if (message.t === "state") return setState(message.state)
    if (message.t === "notice") return input.onNotice?.(message.kind)
    if (message.t !== "result") return
    const answer = actions.get(message.id)
    actions.delete(message.id)
    answer?.(message.ok ? { ok: true } : { ok: false, error: message.error ?? RemoteBrowser.ACTION_ERROR.failed })
  }
  const connect = () => {
    stopRetry?.()
    stopRetry = undefined
    if (closed || socket) return
    setLink(attempt === 0 && !state() ? "connecting" : "retrying")
    const next = open(input.url)
    let opened = false
    socket = next
    next.binaryType = "arraybuffer"
    next.onopen = () => {
      opened = true
      next.send(
        JSON.stringify({
          t: "hello",
          v: RemoteBrowser.VERSION,
          ...input.settings(),
          visible,
        } satisfies RemoteBrowser.ClientMessage),
      )
      greeted = next
      if (!visible) idle()
    }
    next.onmessage = (event) => receive(next, event.data)
    next.onclose = (event) => {
      if (socket !== next) return
      socket = undefined
      fail()
      if (event.code === RemoteBrowser.CLOSE.busy) return setLink("busy")
      if (event.code === RemoteBrowser.CLOSE.revoked || event.code === RemoteBrowser.CLOSE.scope) {
        setLink("idle")
        return input.onRefused?.(event.code === RemoteBrowser.CLOSE.revoked ? "revoked" : "scope")
      }
      if (!opened) input.onRefused?.("unreachable")
      if (closed) return
      if (!visible) return setLink("idle")
      setLink("retrying")
      stopRetry = timer(connect, backoff(attempt))
      attempt += 1
    }
  }
  const drop = () => {
    const current = socket
    socket = undefined
    waiting = undefined
    stopRetry?.()
    stopRetry = undefined
    stopIdle?.()
    stopIdle = undefined
    fail()
    current?.close(1000)
  }
  const idle = () => {
    stopIdle?.()
    stopIdle = timer(() => {
      drop()
      setLink("idle")
    }, HIDDEN_CLOSE_MS)
  }

  return {
    link,
    /** This device may send input and actions (`ready.control`: it holds `prompt`). */
    control,
    /** The pane as last reported; kept while the socket is being opened again. */
    state,
    /** The header of the frame on screen. */
    painted,
    /** Opens the socket (again): the first time, after the device was read again, or by the user's `다시 연결`. */
    start() {
      if (closed) return
      attempt = 0
      if (!visible) return
      if (!socket) connect()
    },
    setVisible(next: boolean) {
      if (closed || next === visible) return
      visible = next
      if (!next) {
        waiting = undefined
        stopRetry?.()
        stopRetry = undefined
        if (!socket) {
          // Too many viewers stays said until the user asks again.
          if (link() !== "busy") setLink("idle")
          return
        }
        if (!live()) return
        send({ t: "view", visible: false })
        return idle()
      }
      stopIdle?.()
      stopIdle = undefined
      if (live()) return void send({ t: "view", visible: true })
      attempt = 0
      if (!socket && link() !== "busy") connect()
    },
    /** The view's settings changed. */
    view(change: Partial<ViewSettings>) {
      send({ t: "view", ...change })
    },
    /** Input events, split so that no message passes the gateway's size limit. */
    input(events: ReadonlyArray<RemoteBrowser.InputEvent>) {
      if (!control() || !live()) return
      const groups = events.reduce<{ readonly events: RemoteBrowser.InputEvent[]; size: number }[]>((all, event) => {
        const size = JSON.stringify(event).length + 1
        const last = all.at(-1)
        if (last && last.size + size <= INPUT_BYTES && last.events.length < RemoteBrowser.MAX_EVENTS) {
          last.events.push(event)
          last.size += size
          return all
        }
        return [...all, { events: [event], size }]
      }, [])
      groups.forEach((group) => send({ t: "input", events: group.events }))
    },
    action(action: RemoteBrowser.Action) {
      return new Promise<ActionResult>((resolve) => {
        if (!live()) return resolve({ ok: false, error: RemoteBrowser.ACTION_ERROR.noHost })
        actionID += 1
        actions.set(actionID, resolve)
        send({ t: "action", id: actionID, action })
      })
    },
    /** The view is gone: the socket closes and nothing is retried. */
    close() {
      closed = true
      drop()
      setLink("idle")
    },
  }
}

export type ViewerConnection = ReturnType<typeof createViewerConnection>

/** A server message; the gateway is trusted for its shape, a broken JSON text is dropped. */
function parse(data: string): RemoteBrowser.ServerMessage | undefined {
  try {
    return JSON.parse(data) as RemoteBrowser.ServerMessage
  } catch {
    return undefined
  }
}

export * as BrowserHub from "./browser-hub.js"

import { RemoteBrowser } from "@own/protocol/remote-browser"
import type { Log } from "../log.js"

/**
 * The browser pane on a device (05 §8.10): the relay between the viewers of paired devices (the gateway's socket
 * `RemoteBrowser.SOCKET_PATH`) and the one desktop shell that owns the panes, which polls with RPC `own.remote`
 * `browser.host.*` (`local`). Process-lifetime like the gateway and in memory only.
 *
 * A pane is named by its `RemoteBrowser.paneKey` (the `key` of the methods below): this PC's sessions by their id, a
 * conversation on an SSH host as `<hostId>/<sessionID>` (05 §8.10.8). Both kinds of pane are the PC desktop shell's;
 * the gateway's route decides which servers a device may name.
 *
 * ```text
 * viewer ── hello · view · ack · input · action ─▶ hub ── pull → {views, commands} ─▶ shell
 * viewer ◀─ ready · state · result · notice · frame ── hub ◀─ frame · state · result ── shell
 * ```
 *
 * The hub hands frames and input on and never reads them: no frame, address, title or typed text reaches the log,
 * only device and session ids and host presence. What a device may do is decided before a viewer joins (the gateway's
 * route) and by `control` here (input and actions need the device's `prompt`).
 */

/** A shell that has not pulled for this long is gone (its long poll waits 30 s at most). */
export const HOST_TTL_MS = 60_000
export const ACTION_TIMEOUT_MS = 15_000
/** How long a wanted pane stays wanted without a watching control viewer, and how often the event repeats. */
export const WANT_TTL_MS = 60_000
export const WANT_EMIT_GAP_MS = 5_000
/** After `ensure` timed out for a session, it answers `false` at once for this long. */
export const REFUSED_TTL_MS = 5 * 60_000
export const MAX_VIEWERS = 16
export const MAX_DEVICE_VIEWERS = 4
/** Input events waiting for the shell's next pull; past it the oldest `move` phases go first. */
export const MAX_QUEUED_EVENTS = 512
export const MAX_PENDING_ACTIONS = 64
/** Messages a viewer may send: this many a second sustained, twice that in a burst. */
export const MESSAGE_RATE = 120
export const MAX_PULL_WAIT_MS = 30_000
/** A socket that has not said `hello` by then is closed. */
export const HELLO_TIMEOUT_MS = 10_000
/** Standard close code "try again later": the viewer limit is reached. */
export const CLOSE_BUSY = RemoteBrowser.CLOSE.busy

const MAX_FRAME_BASE64 = Math.ceil(RemoteBrowser.MAX_FRAME_BYTES / 3) * 4

export interface Timers {
  set(run: () => void, ms: number): unknown
  clear(timer: unknown): void
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => {
    const timer = setTimeout(run, ms)
    // The service and the gateway's listeners keep the process; a hub timer never does.
    timer.unref?.()
    return timer
  },
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export interface Options {
  /** A browser pane is wanted for this pane key (event `browser.pane.wanted`, to the desktop window). */
  readonly emitWanted: (key: string) => void
  /** Whether any device could open a viewer now: a listener is open and an active device holds `browser`. */
  readonly canView: () => boolean
  readonly log?: Log.Logger
  readonly now?: () => number
  readonly timers?: Timers
}

/** One viewer socket, as the gateway hands it over after its checks. */
export interface Viewer {
  readonly deviceId: string
  /** `RemoteBrowser.LOCAL` or the SSH host the session runs on. */
  readonly serverKey: string
  readonly sessionID: string
  /** The device holds `prompt`: it may send input and actions, and ask the PC to attach the pane. */
  readonly control: boolean
  send(text: string): void
  sendFrame(bytes: Uint8Array): void
  close(code: number, reason: string): void
  /** The device is still active and still holds `browser` (memory only); asked before anything is handed over. */
  alive(): boolean
}

export interface ViewerHandle {
  message(text: string): void
  leave(): void
}

export interface PullInput {
  readonly host: string
  readonly windows: number
  readonly hosted: ReadonlyArray<string>
  readonly waitMs: number
}

export interface PullOutput {
  readonly views: ReadonlyArray<RemoteBrowser.HostView>
  readonly commands: ReadonlyArray<RemoteBrowser.HostCommand>
  readonly idle: boolean
}

export interface FrameInput {
  readonly host: string
  readonly serverKey?: string
  readonly sessionID: string
  readonly width: number
  readonly height: number
  readonly sharp: boolean
  /** base64 JPEG. */
  readonly data: string
}

export type FrameOutput =
  | { readonly ok: true; readonly viewers: number; readonly acked: boolean }
  | { readonly ok: false; readonly field: "host" | "data"; readonly reason: "not_current" | "base64" | "too_large" | "not_jpeg" }

interface Entry {
  readonly viewer: Viewer
  /** The pane it watches (`RemoteBrowser.paneKey`). */
  readonly key: string
  greeted: boolean
  visible: boolean
  mode: RemoteBrowser.Mode
  quality: RemoteBrowser.Quality
  viewport: RemoteBrowser.Viewport
  /** When this viewer last chose its mode or viewport (or joined): the newest visible one leads the session's view. */
  led: number
  /** The frame it has not acknowledged yet. */
  owed: { readonly seq: number; readonly at: number } | undefined
  /** The last frame sent to it. */
  sent: number | undefined
  /** The last `state` message sent to it, so an unchanged one is not repeated. */
  state: string | undefined
  tokens: number
  refilledAt: number
  helloTimer: unknown
}

interface Host {
  readonly id: string
  lastPullAt: number
  windows: number
  hosted: ReadonlySet<string>
  /** The `views` of the last answer (and their JSON, to compare); `undefined` until the first one. */
  told: { readonly text: string; readonly views: ReadonlyArray<RemoteBrowser.HostView> } | undefined
  /** The waiting long poll: answers with what is wanted now, or with `output` when something else ends it. */
  waiter: { settle(output?: PullOutput): void } | undefined
}

type Command =
  | { readonly type: "input"; readonly key: string; events: RemoteBrowser.InputEvent[] }
  | { readonly type: "action"; readonly key: string; readonly id: string; readonly action: RemoteBrowser.Action }

interface Presence {
  readonly desktop: boolean
  readonly hosted: ReadonlySet<string>
}

const NO_SESSIONS: ReadonlySet<string> = new Set()
const NOTHING: PullOutput = { views: [], commands: [], idle: false }

export class Hub {
  readonly #options: Options
  readonly #now: () => number
  readonly #timers: Timers
  readonly #viewers = new Set<Entry>()
  #host: Host | undefined
  #hostTimer: unknown
  #queue: Command[] = []
  readonly #actions = new Map<string, { readonly entry: Entry; readonly id: number; readonly timer: unknown }>()
  readonly #panes = new Map<string, RemoteBrowser.PaneState>()
  /** The newest frame of each watched session: a viewer that joins, or acknowledges an older frame, gets it. */
  readonly #frames = new Map<string, { readonly seq: number; readonly bytes: Uint8Array }>()
  readonly #deliveries = new Map<number, { readonly key: string; settle(acked: boolean): void }>()
  readonly #wants = new Map<string, { until: number; emittedAt: number }>()
  #wantTimer: unknown
  readonly #ensures = new Map<string, Set<(hosted: boolean) => void>>()
  readonly #refused = new Map<string, number>()
  #order = 0
  #seq = 0
  #action = 0

  constructor(options: Options) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#timers = options.timers ?? REAL_TIMERS
  }

  // ---- what the desktop is doing

  /** A desktop shell with a window polled lately: panes can be held and attached. */
  desktop() {
    const host = this.#live()
    return host !== undefined && host.windows > 0
  }

  hosted(key: string) {
    return this.#live()?.hosted.has(key) ?? false
  }

  viewers() {
    return this.#viewers.size
  }

  #live() {
    const host = this.#host
    return host && this.#now() - host.lastPullAt < HOST_TTL_MS ? host : undefined
  }

  #presence(): Presence {
    return { desktop: this.desktop(), hosted: this.#live()?.hosted ?? NO_SESSIONS }
  }

  // ---- viewers (the gateway's socket)

  join(viewer: Viewer): ViewerHandle {
    const mine = [...this.#viewers].filter((entry) => entry.viewer.deviceId === viewer.deviceId).length
    if (this.#viewers.size >= MAX_VIEWERS || mine >= MAX_DEVICE_VIEWERS) {
      this.#options.log?.info("browser_view_refused", { deviceId: viewer.deviceId, reason: "limit" })
      viewer.close(CLOSE_BUSY, "too many viewers")
      return { message: () => {}, leave: () => {} }
    }
    const entry: Entry = {
      viewer,
      key: RemoteBrowser.paneKey(viewer.serverKey, viewer.sessionID),
      greeted: false,
      visible: false,
      mode: "pc",
      quality: "auto",
      viewport: { width: RemoteBrowser.MIN_SIDE, height: RemoteBrowser.MIN_SIDE, dpr: 1 },
      led: 0,
      owed: undefined,
      sent: undefined,
      state: undefined,
      tokens: MESSAGE_RATE * 2,
      refilledAt: this.#now(),
      helloTimer: this.#timers.set(() => this.#drop(entry, RemoteBrowser.CLOSE.protocol, "no hello"), HELLO_TIMEOUT_MS),
    }
    this.#viewers.add(entry)
    return {
      message: (text) => this.#message(entry, text),
      leave: () => this.#drop(entry),
    }
  }

  #message(entry: Entry, text: string) {
    if (!this.#viewers.has(entry)) return
    if (!entry.viewer.alive()) return this.#drop(entry, RemoteBrowser.CLOSE.scope, "scope")
    const message = RemoteBrowser.parseClientMessage(text)
    // `hello` comes first and only once.
    if (!message || (message.t === "hello") === entry.greeted) return this.#drop(entry, RemoteBrowser.CLOSE.protocol, "protocol")
    const now = this.#now()
    entry.tokens = Math.min(MESSAGE_RATE * 2, entry.tokens + ((now - entry.refilledAt) / 1000) * MESSAGE_RATE)
    entry.refilledAt = now
    const budget = entry.tokens >= 1
    if (budget) entry.tokens -= 1
    const key = entry.key
    switch (message.t) {
      case "hello": {
        entry.greeted = true
        entry.visible = message.visible
        entry.mode = message.mode
        entry.quality = message.quality
        entry.viewport = message.viewport
        entry.led = ++this.#order
        this.#timers.clear(entry.helloTimer)
        this.#send(entry, { t: "ready", v: RemoteBrowser.VERSION, control: entry.viewer.control })
        this.#sendState(entry)
        this.#shown(entry)
        return this.#changed()
      }
      case "view": {
        if (!budget) return
        const appeared = message.visible === true && !entry.visible
        if (message.viewport) entry.viewport = message.viewport
        if (message.mode) entry.mode = message.mode
        if (message.quality) entry.quality = message.quality
        if (message.visible !== undefined) entry.visible = message.visible
        if (message.viewport || message.mode) entry.led = ++this.#order
        // A hidden view draws nothing: the frame it owes is not waited for.
        if (!entry.visible) entry.owed = undefined
        if (appeared) this.#shown(entry)
        return this.#changed()
      }
      case "ack": {
        if (entry.owed?.seq !== message.seq) return
        entry.owed = undefined
        this.#deliveries.get(message.seq)?.settle(true)
        const latest = this.#frames.get(key)
        if (latest && latest.seq !== entry.sent && entry.visible) this.#sendFrame(entry, latest)
        return
      }
      case "input": {
        if (!budget || !entry.viewer.control || !this.hosted(key)) return
        const last = this.#queue.at(-1)
        if (last?.type === "input" && last.key === key) last.events = [...last.events, ...message.events]
        else this.#queue.push({ type: "input", key, events: [...message.events] })
        this.#bound()
        return this.#wake()
      }
      case "action": {
        const refused = !entry.viewer.control
          ? RemoteBrowser.ACTION_ERROR.readOnly
          : !this.hosted(key)
            ? RemoteBrowser.ACTION_ERROR.noHost
            : !budget || this.#actions.size >= MAX_PENDING_ACTIONS
              ? RemoteBrowser.ACTION_ERROR.failed
              : undefined
        if (refused) return this.#send(entry, { t: "result", id: message.id, ok: false, error: refused })
        const id = `a${++this.#action}`
        const timer = this.#timers.set(
          () => this.#answer(id, { ok: false, error: RemoteBrowser.ACTION_ERROR.timeout }),
          ACTION_TIMEOUT_MS,
        )
        this.#actions.set(id, { entry, id: message.id, timer })
        this.#queue.push({ type: "action", key, id, action: message.action })
        return this.#wake()
      }
    }
  }

  /** A view came on screen: it gets the session's newest frame, and a control viewer asks for a pane that is missing. */
  #shown(entry: Entry) {
    if (!entry.visible) return
    const latest = this.hosted(entry.key) ? this.#frames.get(entry.key) : undefined
    if (latest) this.#sendFrame(entry, latest)
    if (entry.viewer.control && !this.hosted(entry.key)) this.want(entry.key)
  }

  #drop(entry: Entry, code?: number, reason?: string) {
    if (!this.#viewers.delete(entry)) return
    this.#timers.clear(entry.helloTimer)
    for (const [id, pending] of this.#actions) {
      if (pending.entry !== entry) continue
      this.#timers.clear(pending.timer)
      this.#actions.delete(id)
    }
    if (code !== undefined) entry.viewer.close(code, reason ?? "")
    this.#changed()
  }

  #send(entry: Entry, message: RemoteBrowser.ServerMessage) {
    entry.viewer.send(JSON.stringify(message))
  }

  #sendState(entry: Entry) {
    if (!entry.greeted) return
    const hosted = this.hosted(entry.key)
    const host: RemoteBrowser.HostState = !this.desktop()
      ? "absent"
      : hosted
        ? "ready"
        : entry.viewer.control
          ? "attaching"
          : "detached"
    const pane = hosted ? (this.#panes.get(entry.key) ?? RemoteBrowser.EMPTY_PANE) : RemoteBrowser.EMPTY_PANE
    const state: RemoteBrowser.ViewState = { ...pane, host }
    const text = JSON.stringify({ t: "state", state } satisfies RemoteBrowser.ServerMessage)
    if (text === entry.state) return
    entry.state = text
    entry.viewer.send(text)
  }

  #sendFrame(entry: Entry, frame: { readonly seq: number; readonly bytes: Uint8Array }) {
    const now = this.#now()
    // Flow control: a viewer still drawing the previous frame is skipped, unless it has been silent for too long.
    if (entry.owed && now - entry.owed.at < RemoteBrowser.ACK_TIMEOUT_MS) return
    entry.owed = { seq: frame.seq, at: now }
    entry.sent = frame.seq
    entry.viewer.sendFrame(frame.bytes)
  }

  /** The viewers of a session that the pane's content may go to now; one whose device is no longer allowed is closed. */
  #audience(key: string) {
    return [...this.#viewers].filter((entry) => {
      if (!entry.greeted || entry.key !== key) return false
      if (entry.viewer.alive()) return true
      this.#drop(entry, RemoteBrowser.CLOSE.scope, "scope")
      return false
    })
  }

  #watched(key: string) {
    return [...this.#viewers].filter((entry) => entry.greeted && entry.visible && entry.key === key).length
  }

  /** Viewers came, went or changed what they ask for. */
  #changed() {
    for (const key of this.#frames.keys()) if (this.#watched(key) === 0) this.#frames.delete(key)
    for (const delivery of [...this.#deliveries.values()]) if (this.#watched(delivery.key) === 0) delivery.settle(false)
    this.#wake()
  }

  /** Keeps the input queue bounded: the oldest `move` phases go first, then the oldest events of any kind. */
  #bound() {
    const inputs = this.#queue.filter((command) => command.type === "input")
    let excess = inputs.reduce((sum, command) => sum + command.events.length, 0) - MAX_QUEUED_EVENTS
    if (excess <= 0) return
    for (const droppable of [(event: RemoteBrowser.InputEvent) => "phase" in event && event.phase === "move", () => true]) {
      for (const command of inputs) {
        command.events = command.events.filter((event) => {
          if (excess <= 0 || !droppable(event)) return true
          excess--
          return false
        })
      }
    }
    this.#queue = this.#queue.filter((command) => command.type !== "input" || command.events.length > 0)
  }

  // ---- the desktop shell (RPC `browser.host.*`)

  /** `gone`: the caller went away while it waited (its answer would reach nobody, so it must take no commands). */
  pull(input: PullInput, gone?: AbortSignal): Promise<PullOutput> {
    const now = this.#now()
    // A shell back after a long silence starts over, like a new one (its timer may not have run yet).
    if (this.#host && !this.#live()) this.#expire()
    const before = this.#presence()
    if (this.#host?.id !== input.host) this.#replace(input.host)
    const host = this.#host!
    // A newer pull of the same shell takes over: the waiting one answers with nothing new.
    host.waiter?.settle({ views: host.told?.views ?? [], commands: [], idle: false })
    host.lastPullAt = now
    host.windows = input.windows
    host.hosted = new Set(input.hosted)
    this.#timers.clear(this.#hostTimer)
    this.#hostTimer = this.#timers.set(() => this.#expire(), HOST_TTL_MS)
    this.#presenceChanged(before)
    if (!this.#options.canView()) {
      host.told = { text: "[]", views: [] }
      return Promise.resolve({ views: [], commands: [], idle: true })
    }
    const answer = (): PullOutput => {
      const views = this.#views()
      host.told = { text: JSON.stringify(views), views }
      return { views, commands: this.#queue.splice(0).map(outward), idle: false }
    }
    const waitMs = Math.min(Math.max(0, input.waitMs), MAX_PULL_WAIT_MS)
    if (waitMs === 0 || this.#due(host)) return Promise.resolve(answer())
    return new Promise((resolve) => {
      const timer = this.#timers.set(() => waiter.settle(), waitMs)
      const waiter = {
        settle: (output?: PullOutput) => {
          this.#timers.clear(timer)
          host.waiter = undefined
          resolve(output ?? answer())
        },
      }
      host.waiter = waiter
      gone?.addEventListener(
        "abort",
        () => {
          if (host.waiter === waiter) waiter.settle({ views: host.told?.views ?? [], commands: [], idle: false })
        },
        { once: true },
      )
    })
  }

  #due(host: Host) {
    return this.#queue.length > 0 || JSON.stringify(this.#views()) !== host.told?.text
  }

  #wake() {
    const host = this.#host
    if (host?.waiter && this.#due(host)) host.waiter.settle()
  }

  /** What the shell streams now: the hosted sessions someone is looking at. */
  #views(): RemoteBrowser.HostView[] {
    const visible = [...this.#viewers].filter((entry) => entry.greeted && entry.visible && this.hosted(entry.key))
    return [...new Set(visible.map((entry) => entry.key))].sort().map((key) => {
      const watching = visible.filter((entry) => entry.key === key)
      const lead = watching.reduce((newest, entry) => (entry.led > newest.led ? entry : newest))
      return {
        ...named(key),
        mode: lead.mode,
        quality: watching.some((entry) => entry.quality === "low") ? "low" : "auto",
        viewport: lead.viewport,
      }
    })
  }

  /** Another shell took over (a restart): what waited for the old one is answered. */
  #replace(id: string) {
    this.#host?.waiter?.settle(NOTHING)
    if (this.#host) this.#forget()
    this.#options.log?.info("browser_host", { state: this.#host ? "replaced" : "present" })
    this.#host = { id, lastPullAt: this.#now(), windows: 0, hosted: NO_SESSIONS, told: undefined, waiter: undefined }
  }

  /** Nothing of the current shell is kept: its commands, the actions it would answer, its panes and frames. */
  #forget() {
    this.#queue = []
    for (const id of [...this.#actions.keys()]) this.#answer(id, { ok: false, error: RemoteBrowser.ACTION_ERROR.noHost })
    this.#panes.clear()
    this.#frames.clear()
    for (const delivery of [...this.#deliveries.values()]) delivery.settle(false)
  }

  #expire() {
    const host = this.#host
    if (!host) return
    const left = host.lastPullAt + HOST_TTL_MS - this.#now()
    if (left > 0) {
      this.#hostTimer = this.#timers.set(() => this.#expire(), left)
      return
    }
    const before: Presence = { desktop: host.windows > 0, hosted: host.hosted }
    host.waiter?.settle(NOTHING)
    this.#timers.clear(this.#hostTimer)
    this.#forget()
    this.#host = undefined
    this.#options.log?.info("browser_host", { state: "gone" })
    this.#presenceChanged(before)
  }

  /** The shell's report changed what is hosted, or the shell came or went: viewers and waiters learn it. */
  #presenceChanged(before: Presence) {
    const after = this.#presence()
    const lost = [...before.hosted].filter((key) => !after.hosted.has(key))
    const gained = [...after.hosted].filter((key) => !before.hosted.has(key))
    for (const key of lost) {
      this.#panes.delete(key)
      this.#frames.delete(key)
      for (const delivery of [...this.#deliveries.values()]) if (delivery.key === key) delivery.settle(false)
    }
    for (const key of gained) {
      this.#wants.delete(key)
      this.#refused.delete(key)
      for (const resolve of this.#ensures.get(key) ?? []) resolve(true)
    }
    if (before.desktop === after.desktop && lost.length === 0 && gained.length === 0) return
    for (const entry of this.#viewers) this.#sendState(entry)
    this.#askWanted()
  }

  frame(input: FrameInput): Promise<FrameOutput> {
    const host = this.#live()
    if (!host || host.id !== input.host) return Promise.resolve({ ok: false, field: "host", reason: "not_current" })
    if (input.data.length > MAX_FRAME_BASE64) return Promise.resolve({ ok: false, field: "data", reason: "too_large" })
    const jpeg = Buffer.from(input.data, "base64")
    // The decoder skips what is not base64, so a wrong length tells.
    const padding = input.data.endsWith("==") ? 2 : input.data.endsWith("=") ? 1 : 0
    if (input.data.length % 4 !== 0 || jpeg.byteLength !== (input.data.length / 4) * 3 - padding)
      return Promise.resolve({ ok: false, field: "data", reason: "base64" })
    if (jpeg.byteLength > RemoteBrowser.MAX_FRAME_BYTES) return Promise.resolve({ ok: false, field: "data", reason: "too_large" })
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return Promise.resolve({ ok: false, field: "data", reason: "not_jpeg" })
    const key = RemoteBrowser.keyOf(input)
    const watching = host.hosted.has(key) ? this.#audience(key).filter((entry) => entry.visible) : []
    if (watching.length === 0) return Promise.resolve({ ok: true, viewers: 0, acked: false })
    this.#seq = (this.#seq + 1) >>> 0
    const seq = this.#seq
    const frame = {
      seq,
      bytes: RemoteBrowser.encodeFrame({ seq, width: input.width, height: input.height, sharp: input.sharp }, jpeg),
    }
    this.#frames.set(key, frame)
    return new Promise((resolve) => {
      const timer = this.#timers.set(() => delivery.settle(false), RemoteBrowser.ACK_TIMEOUT_MS)
      const delivery = {
        key,
        settle: (acked: boolean) => {
          this.#timers.clear(timer)
          this.#deliveries.delete(seq)
          resolve({ ok: true, viewers: this.#watched(key), acked })
        },
      }
      this.#deliveries.set(seq, delivery)
      for (const entry of watching) this.#sendFrame(entry, frame)
    })
  }

  state(input: {
    readonly host: string
    readonly serverKey?: string
    readonly sessionID: string
    readonly state?: RemoteBrowser.PaneState
    readonly notice?: RemoteBrowser.Notice
  }) {
    if (this.#live()?.id !== input.host) return
    const key = RemoteBrowser.keyOf(input)
    // A shell reports its hosted panes (512 at most); the bound is against one that reports anything else.
    if (input.state && (this.#panes.has(key) || this.#panes.size < 1024)) this.#panes.set(key, input.state)
    for (const entry of this.#audience(key)) {
      if (input.state) this.#sendState(entry)
      if (input.notice) this.#send(entry, { t: "notice", kind: input.notice })
    }
  }

  result(input: { readonly host: string; readonly id: string; readonly ok: boolean; readonly error?: string }) {
    if (this.#live()?.id !== input.host) return
    this.#answer(input.id, input.ok ? { ok: true } : { ok: false, error: input.error ?? RemoteBrowser.ACTION_ERROR.failed })
  }

  #answer(id: string, outcome: { readonly ok: boolean; readonly error?: string }) {
    const pending = this.#actions.get(id)
    if (!pending) return
    this.#actions.delete(id)
    this.#timers.clear(pending.timer)
    this.#send(pending.entry, { t: "result", id: pending.id, ...outcome })
  }

  // ---- wanting a pane (the desktop window attaches it, 05 §8.10.4)

  want(key: string) {
    if (this.hosted(key)) return
    const now = this.#now()
    const current = this.#wants.get(key)
    const emit = this.desktop() && (current === undefined || now - current.emittedAt >= WANT_EMIT_GAP_MS)
    // Sessions come from the service, but the list is still bounded: the oldest wish gives way.
    if (!current && this.#wants.size >= 256) this.#wants.delete(this.#wants.keys().next().value!)
    this.#wants.set(key, { until: now + WANT_TTL_MS, emittedAt: emit ? now : (current?.emittedAt ?? Number.NEGATIVE_INFINITY) })
    if (emit) this.#options.emitWanted(key)
    this.#wantTimer ??= this.#timers.set(() => this.#repeatWanted(), WANT_EMIT_GAP_MS)
  }

  /** The panes wanted now that no shell holds, by key. */
  wanted() {
    const now = this.#now()
    return [...this.#wants].filter(([key, want]) => want.until > now && !this.hosted(key)).map(([key]) => key)
  }

  /**
   * Asks for the session's pane and waits for the shell to report it: `true` once hosted. A session the window did
   * not attach in time answers `false` at once for a while, so it does not hold every prompt up.
   */
  ensure(key: string, waitMs: number): Promise<boolean> {
    if (!this.desktop()) return Promise.resolve(false)
    if (this.hosted(key)) return Promise.resolve(true)
    this.want(key)
    const now = this.#now()
    if ((this.#refused.get(key) ?? 0) > now) return Promise.resolve(false)
    return new Promise((resolve) => {
      const waiters = this.#ensures.get(key) ?? new Set()
      this.#ensures.set(key, waiters)
      const settle = (hosted: boolean) => {
        this.#timers.clear(timer)
        waiters.delete(settle)
        if (waiters.size === 0 && this.#ensures.get(key) === waiters) this.#ensures.delete(key)
        resolve(hosted)
      }
      const timer = this.#timers.set(() => {
        if (this.#refused.size >= 1024) this.#refused.clear()
        this.#refused.set(key, this.#now() + REFUSED_TTL_MS)
        settle(false)
      }, waitMs)
      waiters.add(settle)
    })
  }

  /** A control viewer looking at a session without a pane keeps asking for it. */
  #askWanted() {
    for (const entry of this.#viewers)
      if (entry.greeted && entry.visible && entry.viewer.control) this.want(entry.key)
  }

  #repeatWanted() {
    this.#wantTimer = undefined
    this.#askWanted()
    const now = this.#now()
    const desktop = this.desktop()
    for (const [key, want] of this.#wants) {
      if (want.until <= now || this.hosted(key)) {
        this.#wants.delete(key)
        continue
      }
      if (!desktop || now - want.emittedAt < WANT_EMIT_GAP_MS) continue
      want.emittedAt = now
      this.#options.emitWanted(key)
    }
    if (this.#wants.size > 0) this.#wantTimer ??= this.#timers.set(() => this.#repeatWanted(), WANT_EMIT_GAP_MS)
  }

  // ---- lifecycle

  /** The gateway's listeners are closing: every viewer goes, and whoever waits on the hub is answered. */
  closeAll() {
    for (const entry of [...this.#viewers]) this.#drop(entry, RemoteBrowser.CLOSE.away, "gateway closing")
    const host = this.#host
    host?.waiter?.settle({ views: host.told?.views ?? [], commands: [], idle: false })
    for (const waiters of [...this.#ensures.values()]) for (const resolve of [...waiters]) resolve(false)
    this.#timers.clear(this.#wantTimer)
    this.#wantTimer = undefined
    this.#wants.clear()
  }
}

/** A pane key as views and commands name it: a local pane leaves `serverKey` out, as a shell before SSH panes expects. */
export function named(key: string): { readonly serverKey?: string; readonly sessionID: string } {
  const pane = RemoteBrowser.paneOf(key)
  return pane.serverKey === RemoteBrowser.LOCAL ? { sessionID: pane.sessionID } : pane
}

function outward(command: Command): RemoteBrowser.HostCommand {
  if (command.type === "input") return { type: "input", ...named(command.key), events: command.events }
  return { type: "action", ...named(command.key), id: command.id, action: command.action }
}

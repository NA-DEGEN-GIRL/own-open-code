// The shell's side of the browser pane on a paired device (05 §8.10). The service's hub (own-remote) never reaches
// into this process: the bridge long-polls it (RPC `own.remote` `browser.host.pull`, loopback, the service password)
// and learns which sessions' panes a device watches (`views`) and what the device did (`commands`). For every wanted
// session it streams JPEG frames of the focused tab (`browser.host.frame`), reports the pane (`browser.host.state`),
// injects the device's input through the tab's CDP and runs its navigation through the pane (`browser.host.result`).
// A session of an SSH host is the same to the bridge (05 §8.10.8): its pane is in this shell too, and views, commands,
// frames and states name its host (`serverKey`); streams and panes go by `RemoteBrowser.paneKey`.
//
//  - Capture: `Page.startScreencast` gives a frame whenever the page changes, and while it runs Chromium keeps the
//    page painting although its view is not shown (the window shows another session, is minimized or in the tray;
//    measured on Electron 44, Chromium 152). A tab that never was on screen has nothing to paint on: its screencast
//    sends nothing and says so (`Page.screencastVisibilityChanged`). Then the bridge takes screenshots itself, each
//    after the page's `kick` (upstream's compositor kick; for a tab in a hidden or minimized window a display surface,
//    remote-surface.ts). The first screenshot that answers wakes the screencast, and its first frame ends them.
//  - Pacing (remote-browser-model.ts `pace`): one frame on its way per session, the next after the viewer's ack; a
//    page that rests gets one sharp screenshot.
//  - 휴대폰 크기로 보기: device metrics, touch and a mobile user agent on the focused tab while a view asks for it,
//    cleared when the view changes back, leaves, the hub is lost for 15 s, the tab loses focus or the shell stops.
//  - A device's first input on a page turns that page's file chooser interception on (the PC would get a dialog nobody
//    asked for), which ends with the view. Input never takes the window's or the PC user's keyboard focus: Chromium
//    gives the page its own "page focus" for injected input, nothing native moves.
//  - Fail safe: 15 s without an answer from the hub stops every capture and clears every emulation.
// Nothing here imports Electron (own-browser.ts `wireRemoteBrowser` supplies the windows and the service), and no
// input event or frame is ever logged.
import { randomUUID } from "node:crypto"
import { RemoteBrowser } from "../../../own-protocol/src/remote-browser"
import {
  actionError,
  base64Bytes,
  coalesce,
  dialogOf,
  inputCommands,
  jpegSize,
  METRICS_COMMAND,
  pace,
  pageMetrics,
  paneAction,
  paneState,
  parseFrameAnswer,
  parsePull,
  PHONE_CLEAR,
  phoneCommands,
  quickTier,
  screencastCommand,
  screenshotCommand,
  type PageMetrics,
} from "./remote-browser-model"
import type { RemotePage, RemotePane, RemotePaneRegistry } from "./remote-panes"

/** The local service as the bridge calls it. */
export interface BridgeService {
  readonly url: string
  /** `Basic …` of the service password. */
  readonly authorization: string
  /** The control location the `own.remote` RPC runs at (`OWN_HOME\control`). */
  readonly control: string
}

export const BRIDGE_TIMING = {
  /** The long poll while nothing is streamed, and while something is (the fail safe needs an answer within 15 s). */
  pollMs: 25_000,
  viewPollMs: 10_000,
  /** Between pulls while no device may open a viewer. */
  idleGapMs: 15_000,
  /** No answer from the hub for this long: every capture stops and every emulation is cleared. */
  failSafeMs: 15_000,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 15_000],
  /** How long a call may take beyond what it waits for at the hub. */
  slackMs: 10_000,
  stateDebounceMs: 50,
  /** One CDP command; a page blocked by a JavaScript dialog answers nothing. */
  cdpMs: 2_000,
  /** A navigation still loading after this long is answered as started. */
  actionMs: 8_000,
  /** Between screenshots of a tab that is not shown while its picture changes, and while it does not. */
  hiddenBusyMs: 150,
  hiddenRestMs: 500,
  /** A view that asked for a fresh frame takes a screenshot when the screencast sent none by then. */
  freshMs: 200,
  /** Windows and the fail safe are looked at this often. */
  tickMs: 1_000,
  /** A change that makes the bridge pull again waits this long for the ones that come with it. */
  wakeMs: 25,
}

export interface BridgeInput {
  /** The local service, looked up again after every failure (a restarted service has a new password). */
  readonly service: () => Promise<BridgeService | undefined>
  readonly panes: RemotePaneRegistry
  /** App windows alive, hidden or minimized ones included. */
  readonly windows: () => number
  /** This shell's Chromium version, for the phone mode's user agent. */
  readonly chrome: string
  readonly log?: (level: "info" | "warn", message: string, data?: Readonly<Record<string, unknown>>) => void
  readonly timing?: Partial<typeof BRIDGE_TIMING>
}

export type RemoteBrowserBridge = ReturnType<typeof startRemoteBrowser>

type Answer = { readonly ok: true; readonly output: unknown } | { readonly ok: false }

export function startRemoteBrowser(input: BridgeInput) {
  const timing = { ...BRIDGE_TIMING, ...input.timing }
  /** A new id per shell start: the hub drops what it asked of an older one. */
  const host = `shell-${randomUUID()}`
  const streams = new Map<string, ReturnType<typeof createStream>>()
  const abort = new AbortController()
  let service: BridgeService | undefined
  let stopped = false
  let idle = false
  let failures = 0
  /** After a failure the next pull does not wait: its answer says what is wanted now, changed or not. */
  let resync = false
  let answeredAt = Date.now()
  let sequence = 0
  let wake = Promise.withResolvers<"woken">()
  let windows = input.windows()
  /** The streamed sessions as last logged: ids only, never what they show. */
  let logged = ""

  const poke = () => {
    wake.resolve("woken")
    wake = Promise.withResolvers()
  }

  const call = async (method: string, payload: object, waitMs: number): Promise<Answer> => {
    const target = service
    if (!target) return { ok: false }
    const url = new URL(`/api/rpc/own.remote/${method}`, target.url)
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
    url.searchParams.set("location[directory]", target.control)
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: target.authorization, "content-type": "application/json" },
      body: JSON.stringify({ input: payload }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(waitMs + timing.slackMs)]),
    }).catch(() => undefined)
    if (!response) return { ok: false }
    // A refusal (HTTP 400: this shell is not the hub's current host, a frame it does not take) is no answer to use.
    if (!response.ok) return { ok: false }
    const body: unknown = await response.json().catch(() => undefined)
    answeredAt = Date.now()
    return {
      ok: true,
      output: typeof body === "object" && body !== null ? (body as { readonly output?: unknown }).output : undefined,
    }
  }

  /** One pull. A later one may overtake it (the hub then answers this one at once): its commands still run. */
  const pull = async (): Promise<"again" | "idle" | "failed"> => {
    const mine = ++sequence
    service ??= await input.service().catch(() => undefined)
    if (!service) {
      resync = true
      return "failed"
    }
    windows = input.windows()
    const waitMs = idle || resync ? 0 : streams.size ? timing.viewPollMs : timing.pollMs
    const answer = await call(
      "browser.host.pull",
      { host, windows, hosted: input.panes.sessions().slice(0, 512), waitMs },
      waitMs,
    )
    if (stopped) return "again"
    const result = answer.ok ? parsePull(answer.output) : undefined
    if (!result) {
      if (mine !== sequence) return "again"
      // The service restarts with a new password: look it up again.
      service = undefined
      resync = true
      return "failed"
    }
    resync = false
    for (const command of result.commands) {
      if (command.type === "input") streams.get(RemoteBrowser.keyOf(command))?.inject(command.events)
      else void act(command)
    }
    if (mine !== sequence) return "again"
    idle = result.idle
    apply(result.views)
    return idle ? "idle" : "again"
  }

  /** `views` is everything wanted now: a session that left it stops, and its phone emulation is cleared. */
  const apply = (views: ReadonlyArray<RemoteBrowser.HostView>) => {
    for (const [key, stream] of streams) {
      if (views.some((item) => RemoteBrowser.keyOf(item) === key)) continue
      streams.delete(key)
      void stream.stop()
    }
    for (const item of views) {
      const stream = streams.get(RemoteBrowser.keyOf(item))
      if (stream) stream.update(item)
      else streams.set(RemoteBrowser.keyOf(item), createStream(item))
    }
    const now = [...streams.keys()].join(" ")
    if (now !== logged) input.log?.("info", "remote browser: streaming", { sessions: now })
    logged = now
  }

  /** A device's navigation or tab action, through the pane and with its checks; the hub waits 15 s for the answer. */
  const act = async (command: Extract<RemoteBrowser.HostCommand, { readonly type: "action" }>) => {
    const reply = (outcome: { readonly ok: boolean; readonly error?: string }) =>
      call("browser.host.result", { host, id: command.id, ...outcome }, 0)
    const pane = input.panes.get(RemoteBrowser.keyOf(command))
    if (!pane) return reply({ ok: false, error: RemoteBrowser.ACTION_ERROR.noHost })
    const mapped = paneAction(command.action, pane.state())
    if (!mapped.ok) return reply(mapped)
    return reply(
      await Promise.race([
        pane.run(mapped.action).then(
          () => ({ ok: true }),
          (cause: unknown) => ({ ok: false, error: actionError(cause) }),
        ),
        // A slow page is still a started navigation; its tab shows `loading` in the state.
        sleep(timing.actionMs).then(() =>
          mapped.navigates ? { ok: true } : { ok: false, error: RemoteBrowser.ACTION_ERROR.timeout },
        ),
      ]),
    )
  }

  const createStream = (first: RemoteBrowser.HostView) => {
    const paneKey = RemoteBrowser.keyOf(first)
    /** How the hub's RPC names this pane: `serverKey` only for an SSH host's. */
    const named =
      first.serverKey === undefined
        ? { sessionID: first.sessionID }
        : { serverKey: first.serverKey, sessionID: first.sessionID }
    let current = first
    let closed = false
    let pane: RemotePane | undefined
    let page: RemotePage | undefined
    let off: (() => void) | undefined
    let metrics: PageMetrics | undefined
    /** The view's size as the last screencast frame named it: a change means the PC resized the pane. */
    let sized: string | undefined
    let resized = false
    /** The phone viewport emulated on `page`, the screencast started on it, the page a device's input reached. */
    let phone: string | undefined
    let cast: string | undefined
    let controlled = false
    /** Chromium does not screencast a tab whose view is not shown; the bridge takes screenshots then. */
    let shown = true
    let dialog: RemoteBrowser.Dialog | null = null
    let reported: string | undefined
    let sending = false
    let sentAt = Number.NEGATIVE_INFINITY
    let pending: string | undefined
    /**
     * The page's picture as the screencast (or a quick screenshot) last gave it. Compared with what comes next, not
     * with what was sent: the sharp screenshot makes Chromium draw the page again, and that frame is this one.
     */
    let seen: string | undefined
    let changedAt = Date.now()
    let rested = false
    /** Nobody watched the last frame: nothing more until a pull lists the session again. */
    let parked = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fresh: ReturnType<typeof setTimeout> | undefined
    let hidden: ReturnType<typeof setTimeout> | undefined
    let stating: ReturnType<typeof setTimeout> | undefined
    let restate = false
    let work: Promise<void> = Promise.resolve()
    let typing: Promise<void> = Promise.resolve()
    let wanted = false

    /** One CDP command of the page, given up after `cdpMs`; undefined when it failed or the page is gone. */
    const cdp = (target: RemotePage, method: string, params: object = {}) =>
      target.closed()
        ? Promise.resolve(undefined)
        : Promise.race([target.send(method, params).catch(() => undefined), sleep(timing.cdpMs).then(() => undefined)])

    /** Everything the bridge set on the page is taken back: the PC's pane is its own again. */
    const release = async () => {
      const old = page
      off?.()
      off = undefined
      page = undefined
      metrics = undefined
      sized = undefined
      pending = undefined
      seen = undefined
      dialog = null
      clearTimeout(fresh)
      clearTimeout(hidden)
      if (!old) return
      old.rest()
      const wasCast = cast !== undefined
      const wasPhone = phone !== undefined
      const wasControlled = controlled
      cast = undefined
      phone = undefined
      controlled = false
      shown = true
      if (wasCast) await cdp(old, "Page.stopScreencast")
      if (wasPhone) for (const command of PHONE_CLEAR) await cdp(old, command.method, command.params)
      if (!wasControlled) return
      await cdp(old, "Page.setInterceptFileChooserDialog", { enabled: false })
    }

    /**
     * The page's first load is done. A tab first made while its window sits in the tray may not finish it until it has
     * a display surface (and Chromium then never says it is hidden), so a slow one is kicked: it is lent one.
     */
    const ready = async (target: RemotePage) => {
      const slow = await Promise.race([
        target.ready.then(
          () => false,
          () => false,
        ),
        sleep(timing.cdpMs).then(() => true),
      ])
      if (!slow || closed || target.closed()) return
      input.log?.("info", "remote browser: tab slow to load", { sessionID: paneKey })
      await target.kick().catch(() => undefined)
      await target.ready.catch(() => undefined)
    }

    const measure = async (target: RemotePage) => {
      const next = pageMetrics(await cdp(target, METRICS_COMMAND.method, METRICS_COMMAND.params))
      if (page === target && next) metrics = next
    }

    const receive = (target: RemotePage, method: string, params: unknown) => {
      if (page !== target || closed) return
      const record = typeof params === "object" && params !== null ? (params as Readonly<Record<string, unknown>>) : {}
      if (method === "Page.screencastFrame") {
        // The screencast is alive (again): no more screenshots.
        if (!shown) input.log?.("info", "remote browser: tab view", { sessionID: paneKey, shown: true })
        shown = true
        clearTimeout(hidden)
        // Acknowledged at once: Chromium then always holds the page's newest picture, never an older one.
        void target.send("Page.screencastFrameAck", { sessionId: record.sessionId }).catch(() => undefined)
        const meta =
          typeof record.metadata === "object" && record.metadata !== null
            ? (record.metadata as { readonly deviceWidth?: unknown; readonly deviceHeight?: unknown })
            : {}
        const size = `${String(meta.deviceWidth)}x${String(meta.deviceHeight)}`
        // The pane was resized on the PC: the frame size and the reported viewport follow.
        if (sized !== undefined && sized !== size) {
          resized = true
          sync()
        }
        sized = size
        if (typeof record.data === "string") offer(record.data)
        return
      }
      // Chromium says the page is hidden and sends no frames. Its later "visible" is not taken as word that frames
      // come (for a tab in a hidden window they do not): only a frame ends the screenshots.
      if (method === "Page.screencastVisibilityChanged" && record.visible === false && shown) {
        input.log?.("info", "remote browser: tab view", { sessionID: paneKey, shown: false })
        shown = false
        watch()
        return
      }
      if (method === "Page.fileChooserOpened" && controlled) void notice("file_chooser")
    }
    /** A picture of the page as it is now; one that equals the one before it is not a change. */
    const offer = (data: string) => {
      clearTimeout(fresh)
      if (data === seen) return
      seen = data
      pending = data
      changedAt = Date.now()
      rested = false
      step()
    }

    /** One screenshot at a tier, made smaller until it fits a frame; undefined when the page gives none. */
    const shoot = async (target: RemotePage, tier: { readonly side: number; readonly quality: number }) => {
      if (!shown) await Promise.race([target.kick().catch(() => undefined), sleep(timing.cdpMs)])
      await measure(target)
      for (const shrink of [1, 0.7, 0.5, 0.35]) {
        if (!metrics || page !== target) return undefined
        const command = screenshotCommand(metrics, current.viewport, tier, shrink)
        const answer = await cdp(target, command.method, command.params)
        const data = typeof answer === "object" && answer !== null ? (answer as { data?: unknown }).data : undefined
        if (typeof data !== "string") return undefined
        if (base64Bytes(data) <= RemoteBrowser.MAX_FRAME_BYTES) return data
      }
      return undefined
    }

    /** While the tab's view is not shown: screenshots at a rate that follows whether the picture changes. */
    const watch = () => {
      clearTimeout(hidden)
      if (shown || !page || closed || parked) return
      const target = page
      const round = async () => {
        if (page !== target || shown || closed || parked) return
        if (!sending) {
          const data = await shoot(target, quickTier(current.quality))
          if (page !== target || shown || closed) return
          if (data) offer(data)
        }
        hidden = setTimeout(
          round,
          Date.now() - changedAt < RemoteBrowser.REST_MS * 2 ? timing.hiddenBusyMs : timing.hiddenRestMs,
        )
      }
      hidden = setTimeout(round, 0)
    }

    const step = () => {
      clearTimeout(timer)
      if (!page || closed || parked) return
      const next = pace({
        now: Date.now(),
        sending,
        sentAt,
        pending: pending !== undefined,
        changedAt,
        rested,
        quality: current.quality,
      })
      if (next.do === "wait") timer = setTimeout(step, next.ms)
      if (next.do === "rest") rested = true
      if (next.do === "quick" && pending !== undefined) void send(pending, false)
      if (next.do === "sharp") void sharp(page)
    }

    const sharp = async (target: RemotePage) => {
      sending = true
      const asked = changedAt
      const data = await shoot(target, RemoteBrowser.FRAME.sharp)
      sending = false
      // The page moved on while the screenshot was taken: the quick frames go on, a later rest gets its own.
      if (page !== target || closed || changedAt !== asked || pending !== undefined) return step()
      rested = true
      if (data) return send(data, true)
      step()
    }

    const send = async (data: string, isSharp: boolean) => {
      const size = jpegSize(data)
      pending = isSharp ? pending : undefined
      // A screencast frame above the limit (a huge, noisy page) is taken again as a smaller screenshot, never sent.
      if (!size || base64Bytes(data) > RemoteBrowser.MAX_FRAME_BYTES) {
        const target = page
        sending = true
        const smaller = target && size ? await shoot(target, quickTier(current.quality)) : undefined
        sending = false
        if (!smaller || page !== target) return step()
        return send(smaller, isSharp)
      }
      sending = true
      sentAt = Date.now()
      const answer = await call(
        "browser.host.frame",
        { host, ...named, width: size.width, height: size.height, sharp: isSharp, data },
        RemoteBrowser.ACK_TIMEOUT_MS,
      )
      sending = false
      if (closed) return
      const result = answer.ok ? parseFrameAnswer(answer.output) : undefined
      if (result && result.viewers > 0) return step()
      // Nobody watches, or the hub does not know this shell (it restarted, or forgot a silent host): the next pull says.
      parked = true
      clearTimeout(timer)
      clearTimeout(hidden)
      if (!result) poke()
    }

    /** Asks for a picture now, changed or not: a new view, a new size, a viewer that came back. */
    const refresh = () => {
      seen = undefined
      changedAt = Date.now()
      rested = false
      clearTimeout(fresh)
      const target = page
      if (!target) return
      fresh = setTimeout(async () => {
        if (page !== target || closed || pending !== undefined || sending) return
        const data = await shoot(target, quickTier(current.quality))
        if (page !== target || closed) return
        if (data && pending === undefined) offer(data)
        // Neither a frame nor a screenshot: the tab has no display surface, and Chromium may never say it is hidden
        // (a tab first made in a window in the tray). It is treated as hidden: kicked, then screenshots.
        if (data || !shown || seen !== undefined) return
        input.log?.("info", "remote browser: tab view", { sessionID: paneKey, shown: false, frames: 0 })
        shown = false
        watch()
      }, timing.freshMs)
      watch()
      step()
    }

    /** Brings the page, its emulation and its capture in line with the view and the pane, one change at a time. */
    const reconcile = async () => {
      const found = closed ? undefined : input.panes.get(paneKey)
      if (found !== pane) reported = undefined
      pane = found
      const next = found ? focusedPage(found) : undefined
      if (next !== page) {
        await release()
        if (next) await ready(next)
        if (!next) return report()
        // What a kick lent the page goes back when the stream ended while it loaded.
        if (closed || next.closed()) {
          next.rest()
          return report()
        }
        page = next
        // A blinking caret is a change every half second: the page would never rest. Undone by `rest`.
        next.steady()
        off = next.on((method, params) => receive(next, method, params))
        await cdp(next, "Page.enable")
      }
      const target = page
      if (!target) return report()
      const mode = current.mode === "phone" ? JSON.stringify(current.viewport) : undefined
      if (mode !== phone) {
        // Recorded before the first command, so a half-applied emulation is cleared like a whole one.
        phone = mode
        for (const command of mode ? phoneCommands(current.viewport, input.chrome) : PHONE_CLEAR)
          await cdp(target, command.method, command.params)
        await measure(target)
      }
      if (!metrics || resized) await measure(target)
      resized = false
      if (page !== target || !metrics) return report()
      const command = screencastCommand(metrics, current)
      const key = JSON.stringify(command.params)
      if (key !== cast) {
        if (cast !== undefined) await cdp(target, "Page.stopScreencast")
        cast = key
        await cdp(target, command.method, command.params)
        if (page === target) refresh()
      }
      report()
    }

    const sync = () => {
      if (wanted) return
      wanted = true
      work = work
        .then(() => {
          wanted = false
          return reconcile()
        })
        .catch((error: unknown) =>
          input.log?.("warn", "remote browser: sync failed", { sessionID: paneKey, error: String(error) }),
        )
    }

    /** Tells the hub what the pane is now, a moment after the last change and only when it differs. */
    const report = () => {
      if (closed) return
      if (stating) return void (restate = true)
      stating = setTimeout(async () => {
        restate = false
        const owner = pane
        // Upstream's own record of the page's open dialog; asking touches neither the page nor the pane's state.
        const answer = owner && page ? await owner.dialog().catch(() => undefined) : undefined
        if (!closed && owner && owner === pane) {
          dialog = dialogOf(answer)
          const state = paneState({ state: owner.state(), mode: phone ? "phone" : "pc", metrics, dialog })
          const text = JSON.stringify(state)
          if (text !== reported) {
            reported = text
            await call("browser.host.state", { host, ...named, state }, 0)
          }
        }
        stating = undefined
        if (restate) report()
      }, timing.stateDebounceMs)
    }

    const notice = (kind: RemoteBrowser.Notice) => call("browser.host.state", { host, ...named, notice: kind }, 0)

    sync()

    return {
      update(next: RemoteBrowser.HostView) {
        const same = JSON.stringify(next) === JSON.stringify(current)
        current = next
        if (same && !parked) return
        parked = false
        sync()
        // The same capture settings, another viewport or a viewer that came back: still one fresh frame.
        work = work.then(() => {
          if (!closed && page && !sending && pending === undefined) refresh()
        })
      },
      /** The pane published, or the panes changed: another tab may be focused, the attachment may be a new one. */
      changed: sync,
      download() {
        void notice("download")
      },
      /** Input in order, on the focused page. A page blocked by a dialog takes none. */
      inject(events: ReadonlyArray<RemoteBrowser.InputEvent>) {
        typing = typing
          .then(async () => {
            const target = page
            if (!target || closed || dialog || !metrics) return
            if (!controlled) {
              controlled = true
              await cdp(target, "Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
            }
            const size = metrics
            for (const event of coalesce(events))
              for (const command of inputCommands(event, size))
                if ((await cdp(target, command.method, command.params)) === undefined) return
          })
          .catch(() => undefined)
      },
      async stop() {
        closed = true
        clearTimeout(timer)
        clearTimeout(stating)
        stating = undefined
        work = work.then(release).catch(() => undefined)
        await work
      },
    }
  }

  const stopStreams = () => {
    const all = [...streams.values()]
    streams.clear()
    return Promise.all(all.map((stream) => stream.stop()))
  }

  const unlisten = input.panes.on((event) => {
    if (event.type === "sessions") {
      streams.forEach((stream) => stream.changed())
      // The hub learns what is hosted only from pulls: tell it now, also while it says idle.
      return poke()
    }
    if (event.type === "changed") return streams.get(event.key)?.changed()
    streams.get(event.key)?.download()
  })

  const tick = setInterval(() => {
    if (input.windows() !== windows) poke()
    if (!streams.size || Date.now() - answeredAt < timing.failSafeMs) return
    input.log?.("warn", "remote browser: the hub is silent, captures stopped", { sessions: streams.size })
    logged = ""
    void stopStreams()
  }, timing.tickMs)
  tick.unref?.()

  const run = async () => {
    while (!stopped) {
      const woken = wake.promise
      const outcome = await Promise.race([pull(), woken])
      if (stopped) return
      // Several changes at once (a window attaching its sessions) are told in one pull.
      if (outcome === "woken") await sleep(timing.wakeMs)
      if (outcome === "again" || outcome === "idle") failures = 0
      if (outcome === "again" || outcome === "woken") continue
      const pause =
        outcome === "idle" ? timing.idleGapMs : timing.backoffMs[Math.min(failures++, timing.backoffMs.length - 1)]!
      await Promise.race([sleep(pause), woken])
    }
  }
  void run()

  return {
    host,
    /** Pulls again now: the service came back, or something the hub should hear changed. */
    wake: poke,
    /** What is streamed now (for tests and the log). */
    sessions: () => [...streams.keys()],
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(tick)
      unlisten()
      poke()
      // In-flight calls end first, so no frame is sent while the pages are put back.
      abort.abort()
      await stopStreams()
    },
  }
}

/** The pane's focused page; a pane that is closing has none. */
function focusedPage(pane: RemotePane) {
  try {
    return pane.page()
  } catch {
    return undefined
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

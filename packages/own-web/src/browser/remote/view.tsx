// The device viewer (05 §8.10): a session's browser pane on the PC, live on a paired device (the Android app, another
// PC's `원격 PC` window, a paired browser). Its own lazy chunk, opened from the conversation `⋯` > 브라우저 or the dock's
// hint (dock.tsx), and mounted in the workspace body: a layer over the conversation below 840 px, a column beside it
// from there (remote.css).
//
//   ←  page title                       ▢ 2   ⋯     close, title, tabs, view menu (휴대폰 크기로 보기, 데이터 절약, 새 탭)
//   ‹  ›  ⟳  [ 주소나 검색어 입력       ]             or, while the agent is active: ● 에이전트가 조작 중 · 클릭 [멈추고 직접 조작]
//   ┌ live frame ─────────────────────┐ ⌨           or one sentence saying why there is none (model.ts `screenOf`)
//
//  - The second row never changes height and the agent's line takes the address row's place instead of a row of its
//    own: the frame area is what `휴대폰 크기로 보기` emulates on the PC, so it must not move when the agent starts.
//  - Frames are drawn on a canvas placed by `frameRect` (pointer.ts), which also turns fingers into page positions.
//  - Typing goes through a hidden text field (typing.ts), focused by `⌨` on a touch screen (never by a tap on the
//    frame: the keyboard must not come up on every touch) and by a click on the frame with a mouse.
//  - Watching and controlling (model.ts `gateOf`): a device without `prompt` only watches; while the agent operates
//    the page nothing is sent until `멈추고 직접 조작`, which interrupts the turn as the desktop pane does.
//  - Nothing is sent while the view is not on screen (connection.ts `setVisible`), and closing it closes the socket.
//  - Touches never leave this element (`data-gesture-lock`, and the touch events stop here): the shell's own gestures
//    must not see a drag meant for the page.
import "@/limits/kit.css"
import "./remote.css"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js"
import { useData } from "@/data"
import { useHost, type HostConnection } from "@/host"
import { enableReasonKey, usePolicyText } from "@/policy"
import { browserRemoved } from "@/policy/browser"
import { useRouter } from "@/routing/router"
import { HostMenu, type MenuItem } from "@/servers/menu"
import { BESIDE_MIN } from "@/shell/breakpoints"
import { Icon } from "@/shell/icons"
import type { PanelTabProps } from "@/shell/work-panel"
import { showToast } from "@/switcher/toast"
import type { ActionKey } from "../activity"
import { normalizeAddress } from "../address"
import { createBrowserEnable, createRouterBrowserEnableWriter } from "../enable"
import { windowActivity } from "../registry"
import { useBrowserText } from "../strings"
import { createViewerConnection, viewerUrl, type Frame } from "./connection"
import { focusedTab, gateOf, goAction, screenOf, stableBox, viewportOf } from "./model"
import {
  createInputQueue,
  createMouseInput,
  createTouchInput,
  frameRect,
  NO_ZOOM,
  type Geometry,
  type MouseButton,
  type Size,
  type Zoom,
} from "./pointer"
import { useRemoteText, type RemoteKey } from "./strings"
import { createTyping } from "./typing"

const PHONE_KEY = "own.web.remoteBrowser.phone"
const SAVER_KEY = "own.web.remoteBrowser.saver"
const BUTTONS: Readonly<Record<number, MouseButton>> = { 0: "left", 1: "middle", 2: "right" }
const FAILURES: Readonly<Record<string, RemoteKey>> = {
  [RemoteBrowser.ACTION_ERROR.readOnly]: "own.remoteBrowser.failed.read_only",
  [RemoteBrowser.ACTION_ERROR.noHost]: "own.remoteBrowser.failed.no_host",
  [RemoteBrowser.ACTION_ERROR.timeout]: "own.remoteBrowser.failed.timeout",
}
/** How long the gateway's size for the phone emulation waits for the area to settle (a fold, a rotation, a keyboard). */
const VIEWPORT_SETTLE_MS = 250
const NOTE_MS = 5000

function stored(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0")
  } catch {}
}

/**
 * The view's own marks, drawn like the shell's icons (shell/icons.tsx) so each sits in the middle of its button: a
 * text glyph (`←`, `⟳`) is set where its font puts it, which is not the middle (e2e/mobile/centre.spec.ts).
 * `close` is an arrow, apart from the page's own back chevron beside it.
 */
const MARKS = {
  close: "M19.5 12h-15M10.5 6l-6 6 6 6",
  reload: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2",
  keyboard: "M3.5 6.5h17v11h-17zM7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7 14h10",
} as const

function Mark(props: { readonly name: keyof typeof MARKS }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={MARKS[props.name]} />
    </svg>
  )
}

function hostOf(url: string) {
  return URL.parse(url)?.host ?? ""
}

export default function RemoteBrowserView(props: PanelTabProps & { readonly onClose: () => void }) {
  const router = useRouter()
  const text = useRemoteText()
  // The same width as remote.css: below it the view is a layer over the conversation.
  const layer = createMediaQuery(`(max-width: ${BESIDE_MIN - 0.02}px)`)
  const key = createMemo(() => `${props.serverKey()}\u0000${props.sessionID() ?? ""}`)
  let root!: HTMLElement

  // A layer belongs to the conversation under it: going elsewhere (a notification, a link) closes it. Beside the
  // conversation it stays and follows the conversation on screen.
  createEffect(
    on(
      router.route,
      () => {
        if (layer()) props.onClose()
      },
      { defer: true },
    ),
  )
  onMount(() => {
    // Native listeners: a touch meant for the page must not bubble into the shell's own gesture handlers.
    const stop = (event: Event) => event.stopPropagation()
    const stopTouch = (event: PointerEvent) => {
      if (event.pointerType === "touch") event.stopPropagation()
    }
    const touches = ["touchstart", "touchmove", "touchend", "touchcancel"] as const
    const pointers = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const
    touches.forEach((type) => root.addEventListener(type, stop))
    pointers.forEach((type) => root.addEventListener(type, stopTouch))
    onCleanup(() => {
      touches.forEach((type) => root.removeEventListener(type, stop))
      pointers.forEach((type) => root.removeEventListener(type, stopTouch))
    })
    // The app's back button (host/app-bridge.ts) and Escape close the layer through the focused element.
    if (layer()) root.focus({ preventScroll: true })
  })

  return (
    <aside
      ref={root}
      class="own-rb"
      data-testid="remote-browser"
      data-gesture-lock=""
      data-layout={layer() ? "layer" : "beside"}
      role={layer() ? "dialog" : undefined}
      aria-modal={layer() ? "true" : undefined}
      aria-label={text("own.remoteBrowser.title")}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || !layer()) return
        event.stopPropagation()
        props.onClose()
      }}
    >
      <Show when={key()} keyed>
        {(_key) => (
          <SessionBrowser
            serverKey={untrack(props.serverKey)}
            sessionID={untrack(props.sessionID)}
            visible={props.visible}
            onClose={props.onClose}
          />
        )}
      </Show>
    </aside>
  )
}

function SessionBrowser(props: {
  readonly serverKey: string
  readonly sessionID: string | undefined
  readonly visible: () => boolean
  readonly onClose: () => void
}) {
  const host = useHost()
  const data = useData()
  const text = useRemoteText()
  const pane = useBrowserText()
  const policy = usePolicyText()
  const sessionID = props.sessionID
  const runtime = () => data.get(props.serverKey)
  const info = () => (sessionID ? runtime()?.data.session.get(sessionID) : undefined)
  const removed = createMemo(() => {
    const current = info()
    return !!current && browserRemoved(current.permissions)
  })

  // ---- the device, as the gateway holds it ----
  const [device, setDevice] = createSignal<{ readonly scopes: readonly string[]; readonly pc?: string }>()
  const readDevice = (connection: HostConnection) =>
    setDevice({ scopes: connection.deviceScopes ?? [], ...(connection.pc ? { pc: connection.pc } : {}) })
  let rechecking: Promise<unknown> | undefined
  /** Reads the device again; a revoked one ends in the host's own flow (the pairing screen). */
  const recheck = () =>
    (rechecking ??= host
      .reconnect()
      .then(readDevice, () => undefined)
      .finally(() => {
        rechecking = undefined
      }))
  // The host answers with the device as it was read when the app started. The PC may have turned `브라우저` on since:
  // without it the gateway is asked once more before the view says no.
  void host.connect().then(
    (connection) => {
      if (connection.deviceScopes?.includes(RemoteBrowser.SCOPE)) return void readDevice(connection)
      // Unreachable now: what the host knew stands.
      void recheck().then(() => device() ?? readDevice(connection))
    },
    () => setDevice({ scopes: [] }),
  )

  // ---- view settings ----
  const [phone, setPhone] = createSignal(stored(PHONE_KEY) === "1")
  const [saver, setSaver] = createSignal(
    (stored(SAVER_KEY) ?? ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData ? "1" : "0")) === "1",
  )
  const coarse = createMediaQuery("(pointer: coarse)")
  const [area, setArea] = createSignal<Size>({ width: 0, height: 0 })
  const [box, setBox] = createSignal<Size>()
  /** A text field of the view has the focus: on a touch screen the keyboard is (about to be) up. */
  const [typingFocus, setTypingFocus] = createSignal(false)
  createEffect(() => {
    const current = area()
    const typing = typingFocus() && coarse()
    if (current.width > 0 && current.height > 0) setBox((previous) => stableBox(previous, current, typing))
  })
  const viewport = createMemo(
    () => {
      const current = box()
      return current ? viewportOf({ ...current, dpr: window.devicePixelRatio }) : undefined
    },
    undefined,
    { equals: (a, b) => a?.width === b?.width && a?.height === b?.height && a?.dpr === b?.dpr },
  )
  const mode = (): RemoteBrowser.Mode => (phone() ? "phone" : "pc")
  const quality = (): RemoteBrowser.Quality => (saver() ? "low" : "auto")

  // ---- the frame ----
  let stage!: HTMLDivElement
  let surface!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let keys!: HTMLTextAreaElement
  let addressField: HTMLInputElement | undefined
  const [frameSize, setFrameSize] = createSignal<Size>({ width: 0, height: 0 })
  const [zoom, setZoom] = createSignal<Zoom>(NO_ZOOM)
  const [anchor, setAnchor] = createSignal<number>()
  const geometry = (): Geometry => ({
    area: area(),
    box: box() ?? area(),
    frame: frameSize(),
    zoom: phone() ? NO_ZOOM : zoom(),
    anchor: anchor(),
  })
  const rect = createMemo(() => frameRect(geometry()))
  const paint = async (frame: Frame) => {
    const bitmap = await createImageBitmap(new Blob([frame.jpeg.slice()], { type: "image/jpeg" }))
    // Sizing a canvas clears it; the new frame is drawn in the same task, so nothing blank is ever shown.
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
    const size = frameSize()
    if (size.width !== bitmap.width || size.height !== bitmap.height)
      setFrameSize({ width: bitmap.width, height: bitmap.height })
    bitmap.close()
  }

  // ---- the socket ----
  const [note, setNote] = createSignal<string>()
  createEffect(() => {
    if (!note()) return
    const timer = setTimeout(() => setNote(undefined), NOTE_MS)
    onCleanup(() => clearTimeout(timer))
  })
  const [pageVisible, setPageVisible] = createSignal(document.visibilityState === "visible")
  const visible = () => props.visible() && pageVisible()
  let checked = 0
  const wanted = createMemo(
    () =>
      !!sessionID &&
      !!device()?.scopes.includes(RemoteBrowser.SCOPE) &&
      !!info() &&
      !removed() &&
      !!viewport(),
  )
  const connection = createMemo(() => {
    if (!wanted() || !sessionID) return undefined
    const baseUrl = untrack(() => runtime()?.entry()?.baseUrl)
    if (!baseUrl) return undefined
    const made = createViewerConnection({
      url: viewerUrl(baseUrl, props.serverKey, sessionID),
      settings: () => ({ viewport: untrack(viewport)!, mode: untrack(mode), quality: untrack(quality) }),
      paint,
      onNotice: (kind) =>
        showToast({ message: text(kind === "download" ? "own.remoteBrowser.download" : "own.remoteBrowser.fileChooser") }),
      onRefused(why) {
        // A socket that never opened may be a refusal the page cannot see: ask the gateway, at most every 10 s.
        if (why === "unreachable" && Date.now() - checked < 10_000) return
        checked = Date.now()
        void recheck().then(() => {
          if (why === "scope") made.start()
        })
      },
    })
    // Untracked: opening the socket reads and writes the connection's own signals, which must not rebuild it.
    untrack(() => {
      made.setVisible(visible())
      made.start()
    })
    onCleanup(() => made.close())
    return made
  })
  createEffect(() => connection()?.setVisible(visible()))
  createEffect(
    on([mode, quality], () => connection()?.view({ mode: mode(), quality: quality(), viewport: viewport() }), {
      defer: true,
    }),
  )
  createEffect(
    on(
      viewport,
      (next) => {
        if (!next) return
        const timer = setTimeout(() => connection()?.view({ viewport: next }), VIEWPORT_SETTLE_MS)
        onCleanup(() => clearTimeout(timer))
      },
      { defer: true },
    ),
  )

  // ---- who drives ----
  const tracker = () => windowActivity().get(props.serverKey)
  const phase = () => (sessionID ? (tracker()?.phase(sessionID) ?? "idle") : "idle")
  const agentActive = () => phase() === "operating" || phase() === "recent"
  const lastCall = () => (sessionID ? tracker()?.last(sessionID) : undefined)
  const agentTab = () => (agentActive() && sessionID ? tracker()?.agentTab(sessionID) : undefined)
  const state = () => connection()?.state()
  const link = () => connection()?.link() ?? "idle"
  const control = () => connection()?.control() ?? false
  const gate = () => gateOf({ control: control(), phase: phase() })
  const focused = createMemo(() => focusedTab(state()))
  const screen = createMemo(() => {
    const current = device()
    if (!current && sessionID) return "connecting" as const
    return screenOf({
      sessionID,
      scopes: current?.scopes ?? [],
      removed: removed(),
      link: link(),
      state: info() ? state() : undefined,
    })
  })
  const turnRunning = () => !!sessionID && runtime()?.data.session.status(sessionID) === "running"
  let hinted = 0
  const blocked = () => {
    if (Date.now() - hinted < 2000) return
    hinted = Date.now()
    showToast({ message: text(gate() === "agent" ? "own.remoteBrowser.agentBlocked" : "own.remoteBrowser.watchOnly") })
  }
  const failure = (error: string) => {
    if (error.startsWith("browser.address")) return pane("own.browserPane.address.refused")
    const known = FAILURES[error]
    return known ? text(known) : pane("own.browserPane.failed")
  }
  const act = (action: RemoteBrowser.Action) => {
    if (gate() !== "control") return blocked()
    setNote(undefined)
    if (sessionID) tracker()?.userCommand(sessionID, "tabID" in action ? action.tabID : focused()?.id)
    void connection()
      ?.action(action)
      .then((result) => {
        if (!result.ok) setNote(failure(result.error))
      })
  }
  const [stopping, setStopping] = createSignal(false)
  // `멈추고 직접 조작`, as the desktop pane: stop the turn first (the plugin cancels its pending browser call).
  const takeover = async () => {
    if (stopping() || !sessionID) return
    setStopping(true)
    const stopped = await Promise.resolve()
      .then(() => (turnRunning() ? runtime()?.client().session.interrupt({ sessionID }) : undefined))
      .then(
        () => true,
        () => false,
      )
    setStopping(false)
    if (!stopped) return setNote(pane("own.browserPane.agent.takeoverFailed"))
    tracker()?.takeover(sessionID, focused()?.id)
    showToast({ message: pane("own.browserPane.agent.takeover") })
  }

  // ---- input ----
  const queue = createInputQueue({
    flush: (events) => connection()?.input(events),
    frame(run) {
      const id = requestAnimationFrame(run)
      return () => cancelAnimationFrame(id)
    },
  })
  const inputGate = { open: () => gate() === "control", blocked }
  const touch = createTouchInput({
    geometry,
    mode,
    send: queue.push,
    gate: inputGate,
    zoom,
    setZoom,
    onTouch: setAnchor,
  })
  const mouse = createMouseInput({ geometry, send: queue.push, gate: inputGate })
  const typing = createTyping({
    send(events) {
      if (gate() === "control") events.forEach(queue.push)
    },
  })
  /** The field's `paste` event came: its next change is the device's clipboard text. */
  let pasting = false
  const rest = (value: string | undefined) => {
    if (value === undefined) return
    keys.value = value
    keys.setSelectionRange(value.length, value.length)
  }
  const keyboardUp = () => typingFocus() && area().height < (box()?.height ?? 0)
  // A new mode has a new frame: the zoom of the old one means nothing on it.
  createEffect(on(mode, () => setZoom(NO_ZOOM), { defer: true }))
  // Nothing stays pressed on the page when the frame goes away or the agent takes the page.
  createEffect(
    on(
      () => screen() === "frame" && gate() === "control",
      (live) => {
        if (live) return
        touch.reset()
        mouse.reset()
        queue.clear()
      },
      { defer: true },
    ),
  )

  onMount(() => {
    const observer = new ResizeObserver(() => setArea({ width: stage.clientWidth, height: stage.clientHeight }))
    observer.observe(stage)
    const visibility = () => setPageVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", visibility)
    const spot = (event: MouseEvent) => {
      const bounds = stage.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }
    const framed = () => screen() === "frame"
    const down = (event: PointerEvent) => {
      if (!framed()) return
      // Cancelled, so the tap moves no focus: a raised keyboard stays up, a lowered one stays down.
      event.preventDefault()
      if (event.pointerType === "touch") {
        surface.setPointerCapture(event.pointerId)
        return touch.down(event.pointerId, spot(event))
      }
      const button = BUTTONS[event.button]
      if (!button || !mouse.down(button, spot(event))) return
      surface.setPointerCapture(event.pointerId)
      keys.focus({ preventScroll: true })
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return touch.move(event.pointerId, spot(event))
      mouse.move(spot(event))
    }
    const up = (event: PointerEvent) => {
      if (event.pointerType === "touch") return touch.up(event.pointerId)
      const button = BUTTONS[event.button]
      if (button) mouse.up(button, spot(event))
    }
    const cancel = (event: PointerEvent) => {
      if (event.pointerType === "touch") return touch.cancel(event.pointerId)
      mouse.reset()
    }
    const wheel = (event: WheelEvent) => {
      if (!framed()) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area().height : 1
      mouse.wheel(spot(event), event.deltaX * unit, event.deltaY * unit)
    }
    const menu = (event: Event) => event.preventDefault()
    surface.addEventListener("pointerdown", down)
    surface.addEventListener("pointermove", move)
    surface.addEventListener("pointerup", up)
    surface.addEventListener("pointercancel", cancel)
    surface.addEventListener("wheel", wheel, { passive: false })
    surface.addEventListener("contextmenu", menu)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", visibility)
      queue.clear()
    })
  })

  // ---- the address row ----
  const [address, setAddress] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  createEffect(() => {
    const url = focused()?.url ?? ""
    if (!editing()) setAddress(url === "about:blank" ? "" : url)
  })
  const go = () => {
    const typed = address().trim()
    const url = normalizeAddress(typed)
    if (!url) return typed === "" ? undefined : setNote(pane("own.browserPane.address.refused"))
    addressField?.blur()
    if (url === "about:blank") return act({ type: "tabs.open" })
    if (!RemoteBrowser.isAddress(url)) return setNote(pane("own.browserPane.address.refused"))
    act(goAction(state(), url))
  }
  const title = () => {
    const tab = focused()
    return (screen() === "frame" && tab && (tab.title || hostOf(tab.url))) || text("own.remoteBrowser.title")
  }

  // ---- sheets ----
  const [tabsOpen, setTabsOpen] = createSignal(false)
  const [answer, setAnswer] = createSignal("")
  const dialog = () => (screen() === "frame" ? state()?.dialog : undefined)
  createEffect(on(dialog, (current) => setAnswer(current?.defaultPrompt ?? "")))
  const reply = (accept: boolean) => {
    const current = dialog()
    if (!current) return
    act({ type: "dialog", accept, ...(accept && current.type === "prompt" ? { text: answer() } : {}) })
  }

  // ---- a session without the browser tools (03 §18.15 rule 3) ----
  const writer = createMemo(() => {
    const current = runtime()
    if (!current || screen() !== "removed") return undefined
    const made = createRouterBrowserEnableWriter(current)
    onCleanup(() => made.dispose())
    return made
  })
  const enable = createBrowserEnable({
    writer,
    sessionID: () => sessionID ?? "",
    rules: () => info()?.permissions ?? undefined,
  })

  const marked = (on: boolean, label: string) => (on ? text("own.remoteBrowser.on", { label }) : label)
  const menu = (): MenuItem[] => [
    {
      label: marked(phone(), text("own.remoteBrowser.phone")),
      onSelect() {
        remember(PHONE_KEY, !phone())
        setPhone(!phone())
      },
      testid: "remote-browser-phone",
    },
    {
      label: marked(saver(), text("own.remoteBrowser.saver")),
      onSelect() {
        remember(SAVER_KEY, !saver())
        setSaver(!saver())
      },
      testid: "remote-browser-saver",
    },
    ...(state()?.host === "ready" && control()
      ? [
          {
            label: pane("own.browserPane.newTab"),
            onSelect: () => act({ type: "tabs.open" }),
            testid: "remote-browser-new-tab",
          },
        ]
      : []),
  ]

  return (
    <>
      <div class="own-rb-bars" data-testid="remote-browser-bars">
        <button
          type="button"
          class="own-icon-button own-rb-close"
          aria-label={text("own.remoteBrowser.close")}
          data-testid="remote-browser-close"
          onClick={props.onClose}
        >
          <Mark name="close" />
        </button>
        {/* Where the bars are one row the title is gone; here it also brings the address field up. */}
        <button
          type="button"
          class="own-rb-title"
          data-testid="remote-browser-title"
          title={focused()?.url}
          onClick={() => addressField?.focus()}
        >
          {title()}
        </button>
        <Show when={state()?.host === "ready"}>
          <button
            type="button"
            class="own-rb-tabs-button"
            aria-label={text("own.remoteBrowser.tabs", { n: state()?.tabs.length ?? 0 })}
            aria-haspopup="dialog"
            aria-expanded={tabsOpen()}
            data-testid="remote-browser-tabs"
            onClick={() => setTabsOpen(true)}
          >
            <span aria-hidden="true">{state()?.tabs.length ?? 0}</span>
          </button>
        </Show>
        <HostMenu
          label={text("own.remoteBrowser.menu")}
          items={menu}
          class="own-icon-button own-rb-menu"
          testid="remote-browser-menu"
        />
        {/* Always there for a conversation of this PC, also while nothing can be opened: the frame area below is what
            `휴대폰 크기로 보기` emulates on the PC, so it keeps one size from the first greeting on. */}
        <Show when={sessionID}>
          <div class="own-rb-row" data-testid="remote-browser-row" data-gate={gate()}>
            <Switch>
              <Match when={agentActive()}>
                <div class="own-rb-agent" role="status" data-testid="remote-browser-agent" data-phase={phase()}>
                  <span class="own-rb-agent-dot" aria-hidden="true" />
                  <span class="own-rb-agent-label">{pane("own.browserPane.agent.operating")}</span>
                  <span class="own-rb-agent-action" title={lastCall()?.detail}>
                    <Show when={lastCall()}>
                      {(call) =>
                        `${pane(`own.browserPane.action.${call().action as ActionKey}`)}${call().detail ? ` · ${call().detail}` : ""}`
                      }
                    </Show>
                  </span>
                  <Show when={control() && turnRunning()}>
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      data-testid="remote-browser-takeover"
                      disabled={stopping()}
                      onClick={() => void takeover()}
                    >
                      {pane("own.browserPane.agent.takeoverButton")}
                    </button>
                  </Show>
                </div>
              </Match>
              <Match when={link() === "open" && !control()}>
                <div class="own-rb-agent" data-testid="remote-browser-watch">
                  <span class="own-rb-agent-label">{text("own.remoteBrowser.watchOnly")}</span>
                  <span class="own-rb-agent-action">{focused()?.url}</span>
                </div>
              </Match>
              <Match when={true}>
                <button
                  type="button"
                  class="own-icon-button"
                  aria-label={pane("own.browserPane.back")}
                  disabled={!focused()?.canGoBack}
                  data-testid="remote-browser-back"
                  onClick={() => act({ type: "back" })}
                >
                  <Icon name="left" />
                </button>
                <button
                  type="button"
                  class="own-icon-button"
                  aria-label={pane("own.browserPane.forward")}
                  disabled={!focused()?.canGoForward}
                  data-testid="remote-browser-forward"
                  onClick={() => act({ type: "forward" })}
                >
                  <Icon name="right" />
                </button>
                <button
                  type="button"
                  class="own-icon-button"
                  aria-label={pane(focused()?.loading ? "own.browserPane.stop" : "own.browserPane.reload")}
                  disabled={!focused()}
                  data-testid="remote-browser-reload"
                  onClick={() => act({ type: focused()?.loading ? "stop" : "reload" })}
                >
                  <Show when={focused()?.loading} fallback={<Mark name="reload" />}>
                    <Icon name="x" />
                  </Show>
                </button>
                <input
                  ref={addressField}
                  class="own-rb-address"
                  type="text"
                  inputmode="url"
                  enterkeyhint="go"
                  autocapitalize="off"
                  autocomplete="off"
                  spellcheck={false}
                  aria-label={pane("own.browserPane.address")}
                  data-testid="remote-browser-address"
                  readOnly={state()?.host !== "ready"}
                  placeholder={state()?.host === "ready" ? pane("own.browserPane.address.placeholder") : ""}
                  value={address()}
                  onFocus={() => {
                    setEditing(true)
                    setTypingFocus(true)
                  }}
                  onBlur={() => {
                    setEditing(false)
                    setTypingFocus(false)
                  }}
                  onInput={(event) => setAddress(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    // 03 §12: Enter inside an IME composition only commits it.
                    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
                    event.preventDefault()
                    go()
                  }}
                />
              </Match>
            </Switch>
          </div>
        </Show>
      </div>
      <div
        ref={stage}
        class="own-rb-stage"
        data-testid="remote-browser-stage"
        data-screen={screen()}
        data-link={link()}
        data-mode={mode()}
        data-quality={quality()}
      >
        <div ref={surface} class="own-rb-surface" data-testid="remote-browser-surface">
          <canvas
            ref={canvas}
            class="own-rb-frame"
            role="img"
            aria-label={text("own.remoteBrowser.frame")}
            data-testid="remote-browser-frame"
            data-seq={connection()?.painted()?.seq}
            data-sharp={connection()?.painted()?.sharp ? "" : undefined}
            style={{
              left: `${rect().left}px`,
              top: `${rect().top}px`,
              width: `${rect().width}px`,
              height: `${rect().height}px`,
            }}
          />
        </div>
        <textarea
          ref={keys}
          class="own-rb-keys"
          aria-label={text("own.remoteBrowser.keyboard")}
          data-testid="remote-browser-keys"
          tabIndex={-1}
          rows={1}
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          onFocus={() => {
            rest(typing.reset())
            setTypingFocus(true)
          }}
          onBlur={() => setTypingFocus(false)}
          onCompositionStart={() => typing.compositionStart()}
          onCompositionUpdate={(event) => typing.compositionUpdate(event.data)}
          onCompositionEnd={() => {
            typing.compositionEnd()
            rest(typing.changed(keys.value))
          }}
          onPaste={() => (pasting = true)}
          onInput={() => {
            const pasted = pasting
            pasting = false
            rest(typing.changed(keys.value, pasted))
          }}
          onKeyDown={(event) => {
            // The app's back button arrives as an untrusted Escape: it closes the view, it is not typed.
            if (event.key === "Escape" && !event.isTrusted) return
            if (!typing.key(event)) return
            event.preventDefault()
            event.stopPropagation()
          }}
        />
        <Show when={screen() !== "frame"}>
          <div class="own-rb-message" data-testid="remote-browser-message">
            <Switch>
              <Match when={screen() === "none"}>
                <p>{text("own.remoteBrowser.noSession")}</p>
              </Match>
              <Match when={screen() === "permission"}>
                <p>
                  {device()?.pc
                    ? text("own.remoteBrowser.noPermissionPc", { pc: device()!.pc! })
                    : text("own.remoteBrowser.noPermission")}
                </p>
                <button type="button" class="own-btn" data-testid="remote-browser-recheck" onClick={() => void recheck()}>
                  {text("own.remoteBrowser.recheck")}
                </button>
              </Match>
              <Match when={screen() === "removed"}>
                <p class="own-rb-lead">{pane("own.browserPane.removed")}</p>
                <p>{pane("own.browserPane.removedWhy")}</p>
                <Switch>
                  <Match when={enable.reason() === "scope" || enable.reason() === "elsewhere"}>
                    <p data-testid="remote-browser-enable-pc">{text("own.remoteBrowser.enableOnPc")}</p>
                  </Match>
                  <Match when={enable.reason()}>{(why) => <p role="status">{policy(enableReasonKey(why()))}</p>}</Match>
                  <Match when={enable.view() === "offer"}>
                    <button type="button" class="own-btn" data-testid="remote-browser-enable" onClick={enable.ask}>
                      {pane("own.browserPane.enable")}
                    </button>
                  </Match>
                  <Match when={enable.view() === "confirm" || enable.view() === "busy"}>
                    <p>{pane("own.browserPane.enableConfirm")}</p>
                    <div class="own-rb-actions">
                      <button
                        type="button"
                        class="own-btn"
                        data-variant="primary"
                        data-testid="remote-browser-enable-apply"
                        disabled={enable.view() === "busy"}
                        onClick={() => void enable.apply()}
                      >
                        {pane("own.browserPane.enableApply")}
                      </button>
                      <button
                        type="button"
                        class="own-btn"
                        data-variant="ghost"
                        disabled={enable.view() === "busy"}
                        onClick={enable.cancel}
                      >
                        {pane("own.browserPane.enableCancel")}
                      </button>
                    </div>
                  </Match>
                </Switch>
                <Show when={enable.failed()}>
                  <p role="alert">{pane("own.browserPane.enableFailed")}</p>
                </Show>
              </Match>
              <Match when={screen() === "busy"}>
                <p>{text("own.remoteBrowser.busy")}</p>
                <button
                  type="button"
                  class="own-btn"
                  data-testid="remote-browser-reconnect"
                  onClick={() => connection()?.start()}
                >
                  {pane("own.browserPane.reconnect")}
                </button>
              </Match>
              <Match when={screen() === "absent"}>
                <p>{text("own.remoteBrowser.absent")}</p>
              </Match>
              <Match when={screen() === "detached"}>
                <p>{text("own.remoteBrowser.detached")}</p>
              </Match>
              <Match when={screen() === "empty"}>
                <p class="own-rb-lead">{pane("own.browserPane.empty")}</p>
                <p>{text(control() ? "own.remoteBrowser.emptyHint" : "own.remoteBrowser.emptyWatch")}</p>
              </Match>
              <Match when={true}>
                <p>{pane("own.browserPane.connecting")}</p>
              </Match>
            </Switch>
          </div>
        </Show>
        <Show when={note() ?? (link() === "retrying" && state() ? text("own.remoteBrowser.reconnecting") : undefined)}>
          {(line) => (
            <p class="own-rb-note" role="status" data-testid="remote-browser-note">
              {line()}
            </p>
          )}
        </Show>
        <Show when={screen() === "frame"}>
          <div class="own-rb-float">
            <Show when={!phone() && zoom().scale > 1}>
              <button
                type="button"
                aria-label={text("own.remoteBrowser.fit")}
                data-testid="remote-browser-fit"
                onClick={() => setZoom(NO_ZOOM)}
              >
                1×
              </button>
            </Show>
            <Show when={coarse() && gate() === "control"}>
              <button
                type="button"
                aria-label={text("own.remoteBrowser.keyboard")}
                aria-pressed={keyboardUp()}
                data-testid="remote-browser-keyboard"
                // Kept from taking the focus: the field under an open keyboard must not blur before the click.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (keyboardUp()) return keys.blur()
                  // A field that kept the focus after the keyboard was sent away opens none: focus it afresh.
                  keys.blur()
                  keys.focus({ preventScroll: true })
                }}
              >
                <Mark name="keyboard" />
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={tabsOpen() && state()}>
        {(current) => (
          <div class="own-rb-scrim" onClick={(event) => event.target === event.currentTarget && setTabsOpen(false)}>
            <div
              class="own-rb-sheet"
              role="dialog"
              aria-label={text("own.remoteBrowser.tabsTitle")}
              data-testid="remote-browser-tab-sheet"
              tabIndex={-1}
              ref={(element) => queueMicrotask(() => element.focus({ preventScroll: true }))}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.stopPropagation()
                setTabsOpen(false)
              }}
            >
              <div class="own-rb-sheet-head">
                <span>{text("own.remoteBrowser.tabsTitle")}</span>
                <Show when={control()}>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    data-testid="remote-browser-sheet-new"
                    onClick={() => {
                      setTabsOpen(false)
                      act({ type: "tabs.open" })
                    }}
                  >
                    + {pane("own.browserPane.newTab")}
                  </button>
                </Show>
                <button
                  type="button"
                  class="own-icon-button"
                  aria-label={text("own.remoteBrowser.tabsClose")}
                  onClick={() => setTabsOpen(false)}
                >
                  <Icon name="x" />
                </button>
              </div>
              <ul class="own-rb-tab-list">
                <For each={current().tabs}>
                  {(tab) => (
                    <li
                      class="own-rb-tab"
                      data-testid="remote-browser-tab"
                      data-active={tab.id === focused()?.id ? "" : undefined}
                    >
                      <button
                        type="button"
                        class="own-rb-tab-main"
                        aria-current={tab.id === focused()?.id ? "true" : undefined}
                        onClick={() => {
                          setTabsOpen(false)
                          if (tab.id !== focused()?.id) act({ type: "tabs.focus", tabID: tab.id })
                        }}
                      >
                        <span class="own-rb-tab-title">
                          {tab.title || hostOf(tab.url) || pane("own.browserPane.untitled")}
                          <Show when={agentTab() === tab.id}>
                            <span class="own-rb-tab-mark" role="img" aria-label={pane("own.browserPane.agent.tab")}>
                              ●
                            </span>
                          </Show>
                          <Show when={sessionID && tracker()?.touched(sessionID, tab.id)}>
                            <span class="own-rb-tab-mark" title={pane("own.browserPane.user.tab")}>
                              {pane("own.browserPane.user.mark")}
                            </span>
                          </Show>
                        </span>
                        <span class="own-rb-tab-url">{tab.url}</span>
                      </button>
                      <Show when={control()}>
                        <button
                          type="button"
                          class="own-icon-button"
                          aria-label={pane("own.browserPane.closeTab", { title: tab.title || hostOf(tab.url) })}
                          data-testid="remote-browser-tab-close"
                          onClick={() => act({ type: "tabs.close", tabID: tab.id })}
                        >
                          <Icon name="x" />
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </div>
        )}
      </Show>
      <Show when={dialog()}>
        {(current) => (
          <div class="own-rb-scrim">
            <div
              class="own-rb-sheet"
              role="alertdialog"
              aria-label={text(`own.remoteBrowser.dialog.${current().type}`)}
              data-testid="remote-browser-dialog"
              data-type={current().type}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || gate() !== "control") return
                event.stopPropagation()
                reply(false)
              }}
            >
              <div class="own-rb-sheet-head">
                <span>{text(`own.remoteBrowser.dialog.${current().type}`)}</span>
              </div>
              <div class="own-rb-dialog">
                <p>
                  {current().type === "beforeunload"
                    ? text("own.remoteBrowser.dialog.beforeunloadNote")
                    : current().message}
                </p>
                <Show
                  when={gate() === "control"}
                  fallback={
                    <p role="status" data-testid="remote-browser-dialog-watch">
                      {text(gate() === "agent" ? "own.remoteBrowser.dialog.agent" : "own.remoteBrowser.dialog.watch")}
                    </p>
                  }
                >
                  <Show when={current().type === "prompt"}>
                    <input
                      type="text"
                      aria-label={text("own.remoteBrowser.dialog.field")}
                      data-testid="remote-browser-dialog-text"
                      value={answer()}
                      onInput={(event) => setAnswer(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
                        event.preventDefault()
                        reply(true)
                      }}
                    />
                  </Show>
                  <div class="own-rb-actions">
                    <Show when={current().type !== "alert"}>
                      <button
                        type="button"
                        class="own-btn"
                        data-variant="ghost"
                        data-testid="remote-browser-dialog-cancel"
                        onClick={() => reply(false)}
                      >
                        {text("own.remoteBrowser.dialog.cancel")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="own-btn"
                      data-variant="primary"
                      data-testid="remote-browser-dialog-ok"
                      onClick={() => reply(true)}
                    >
                      {text("own.remoteBrowser.dialog.ok")}
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </>
  )
}

// One terminal (03 §18.6), adapted from upstream packages/app/src/session/terminal/terminal.tsx @ 00d179015f: the
// ghostty-web canvas, its PTY WebSocket (ticket auth), size sync, reconnect with the output cursor and the exit state.
// Differences from upstream: no serialized buffer in storage (the server replays up to 2 MB, and output never goes to
// localStorage, 01 §7); own tokens for colors and font; the rAF loop and resize observer stop while hidden (4.7); the
// cursor blinks (a 530 ms interval) only while focused (PF8); own-web shortcuts that stay live in a terminal (03 §10)
// are handled before ghostty-web sees the key; exit and vanished PTYs keep the tab with `다시 시작`.
import type { FitAddon, Terminal } from "ghostty-web"
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { useShortcuts } from "@/keyboard"
import { markAfterPaint } from "@/perf/marks"
import { controlCursor, isNotFound } from "./api"
import { loadGhostty, pauseRender, resumeRender } from "./ghostty"
import { exitCodeText } from "./label"
import { createSizeSync } from "./size"
import type { TerminalStore } from "./store"
import { useTerminalText } from "./strings"
import { bufferText } from "./text"
import { colorScheme, themeColors } from "./theme"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "./upstream/runtime-adapters"
import { terminalKeyInput } from "./upstream/terminal-key-event"
import { terminalWriter } from "./upstream/writer"

/** `loading` until ghostty-web and the socket are up; `reconnecting` shows the band; `failed` offers a restart. */
export type Connection = "loading" | "ready" | "reconnecting" | "failed"

export interface TerminalHandle {
  text(lines?: number): string
  focus(): void
}

const FONT_SIZE = 13
const SCROLLBACK = 10_000
const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 4_000
/** After this many attempts (~9 s) the view waits for the event stream to come back instead of polling (PF8). */
const RETRY_LIMIT = 6

export function TerminalView(props: {
  readonly store: TerminalStore
  readonly id: string
  readonly label: string
  /** This tab is the active one and its surface is on screen. */
  readonly shown: () => boolean
  readonly onHandle: (id: string, handle: TerminalHandle | undefined) => void
  readonly onConnection?: (id: string, connection: Connection) => void
}) {
  const host = useHost()
  const i18n = useI18n()
  const text = useTerminalText()
  const shortcuts = useShortcuts()
  const api = props.store.api
  const id = props.id
  const item = () => props.store.state.items[id]
  const [connection, setConnection] = createSignal<Connection>("loading")
  const [mounted, setMounted] = createSignal(false)
  createEffect(() => props.onConnection?.(id, connection()))

  let wrapper!: HTMLDivElement
  let container!: HTMLDivElement
  const live: {
    term?: Terminal
    fit?: FitAddon
    socket?: WebSocket
    /** A ticket request is in flight; a second attempt waits for it. */
    connecting: boolean
    cursor?: number
    tries: number
    retry?: ReturnType<typeof setTimeout>
    frame?: number
    observer?: ResizeObserver
    disposed: boolean
  } = { tries: 0, disposed: false, connecting: false }
  const cleanups: VoidFunction[] = []
  const sizes = createSizeSync((size) => api.resize(id, size))
  const decoder = new TextDecoder()

  const writer = terminalWriter((data, done) => {
    if (!live.term) return done?.()
    live.term.write(data, done)
  })

  function fitNow() {
    const term = live.term
    if (!term || !live.fit || live.disposed) return
    if (!container.clientWidth || !container.clientHeight) return
    live.fit.fit()
    sizes.set({ cols: term.cols, rows: term.rows })
  }

  /** At most one fit per frame (03 §18.6 "rAF당 한 번"). */
  function scheduleFit() {
    if (live.frame !== undefined || live.disposed) return
    live.frame = requestAnimationFrame(() => {
      live.frame = undefined
      fitNow()
    })
  }

  function focusTerminal() {
    const term = live.term
    if (!term) return
    if (term.textarea) term.textarea.focus({ preventScroll: true })
    else term.focus()
    props.store.focused(id)
  }

  function clearRetry() {
    if (live.retry === undefined) return
    clearTimeout(live.retry)
    live.retry = undefined
  }

  function scheduleRetry() {
    if (live.disposed || live.retry !== undefined) return
    setConnection("reconnecting")
    if (live.tries >= RETRY_LIMIT) return
    const ms = Math.min(RETRY_BASE_MS * 2 ** Math.min(live.tries, 4), RETRY_MAX_MS)
    live.tries += 1
    live.retry = setTimeout(() => {
      live.retry = undefined
      void connect()
    }, ms)
  }

  /** The socket closed or could not open: exited, vanished, or a transient failure worth another attempt. */
  async function settle() {
    const info = await api.get(id).catch((error: unknown) => (isNotFound(error) ? null : undefined))
    if (live.disposed) return
    if (info === null || info?.status === "exited") {
      // Not a connection problem any more: the band shows the exit or the vanished PTY instead.
      setConnection("ready")
      if (info === null) props.store.gone(id)
      else props.store.exited(id, info.exitCode)
      return
    }
    scheduleRetry()
  }

  async function connect() {
    if (live.disposed || live.socket || live.connecting || item()?.status !== "running") return
    clearRetry()
    live.connecting = true
    const socket = await api.connect(id, live.cursor).catch((error: unknown) => {
      if (isNotFound(error)) void settle()
      else if (error instanceof Error && error.name === "ForbiddenError") setConnection("failed")
      else scheduleRetry()
      return undefined
    })
    live.connecting = false
    if (!socket) return
    if (live.disposed) return socket.close(1000)
    live.socket = socket
    socket.addEventListener("open", () => {
      live.tries = 0
      setConnection("ready")
      const term = live.term
      if (term) sizes.set({ cols: term.cols, rows: term.rows })
    })
    socket.addEventListener("message", (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // One control frame after the replay: the absolute output cursor to resume from on reconnect.
        const cursor = safe(() => controlCursor(event.data, decoder))
        if (cursor !== undefined) live.cursor = cursor
        return
      }
      if (typeof event.data !== "string" || !event.data) return
      writer.push(event.data)
      if (live.cursor !== undefined) live.cursor += event.data.length
    })
    socket.addEventListener("close", () => {
      if (live.socket === socket) live.socket = undefined
      if (live.disposed) return
      setConnection("reconnecting")
      void settle()
    })
  }

  onMount(() => {
    void start().catch(() => {
      if (!live.disposed) setConnection("failed")
    })
  })

  async function start() {
    const runtime = await loadGhostty()
    if (live.disposed) return
    const colors = themeColors(container)
    const term = new runtime.Terminal({
      cursorBlink: false,
      cursorStyle: "bar",
      fontSize: FONT_SIZE,
      fontFamily: getComputedStyle(container).fontFamily,
      allowTransparency: false,
      convertEol: false,
      theme: colors,
      colorScheme: colorScheme(),
      scrollback: SCROLLBACK,
      ghostty: runtime.ghostty,
    })
    live.term = term
    cleanups.push(() => term.dispose())
    const fit = new runtime.FitAddon()
    live.fit = fit
    cleanups.push(() => disposeIfDisposable(fit))
    term.loadAddon(fit)
    term.attachCustomKeyEventHandler((event) => {
      const input = terminalKeyInput(event)
      if (input) {
        term.input(input, true)
        return true
      }
      // Ctrl+Shift+C copies the selection (Ctrl+C stays SIGINT), as upstream.
      if (event.type === "keydown" && event.ctrlKey && event.shiftKey && !event.altKey && event.code === "KeyC") {
        const selection = term.getSelection()
        if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined)
        return true
      }
      return false
    })
    term.open(container)
    // ghostty-web labels its element "Terminal input"; the canvas itself is not readable (03 §11).
    container.setAttribute("aria-label", text("own.terminal.screenLabel", { name: props.label }))
    container.setAttribute("aria-describedby", `own-terminal-note-${id}`)
    if (!props.shown()) pauseRender(term)

    const disposables = [
      term.onData((data) => {
        if (live.socket?.readyState === WebSocket.OPEN) live.socket.send(data)
      }),
      term.onResize((size) => sizes.set(size)),
    ]
    cleanups.push(() => disposables.forEach(disposeIfDisposable))
    bindTextarea(term)
    watchTheme(term)

    if (props.shown()) fitNow()
    setMounted(true)
    props.onHandle(id, {
      text: (lines) => (live.term ? bufferText(live.term.buffer.active, lines) : ""),
      focus: focusTerminal,
    })
    markAfterPaint("own:panel-open:terminal-ready")
    // Nothing to attach to for an exited PTY (the server refuses it); the band offers `다시 시작`.
    if (item()?.status !== "running") setConnection("ready")
    await connect()
  }

  function bindTextarea(term: Terminal) {
    const textarea = term.textarea
    if (!textarea) return
    // The blink interval runs only while the terminal has focus (PF8: no periodic timers when idle).
    const focus = () => setOptionIfSupported(term, "cursorBlink", true)
    const blur = () => setOptionIfSupported(term, "cursorBlink", false)
    textarea.addEventListener("focus", focus)
    textarea.addEventListener("blur", blur)
    cleanups.push(() => {
      textarea.removeEventListener("focus", focus)
      textarea.removeEventListener("blur", blur)
    })
  }

  /** Theme changes set attributes/styles on <html>; recolor on the next frame. */
  function watchTheme(term: Terminal) {
    const pending = { frame: undefined as number | undefined }
    const observer = new MutationObserver(() => {
      if (pending.frame !== undefined) return
      pending.frame = requestAnimationFrame(() => {
        pending.frame = undefined
        setOptionIfSupported(term, "theme", themeColors(container))
        setOptionIfSupported(term, "colorScheme", colorScheme())
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-scheme", "data-theme", "class", "style"],
    })
    cleanups.push(() => {
      observer.disconnect()
      if (pending.frame !== undefined) cancelAnimationFrame(pending.frame)
    })
  }

  // Hidden tabs stop drawing and observing (4.7); showing again resumes, refits and takes a pending focus request.
  createEffect(
    on(
      () => [props.shown(), mounted()] as const,
      ([shown]) => {
        const term = live.term
        if (!term) return
        if (!shown) {
          pauseRender(term)
          live.observer?.disconnect()
          live.observer = undefined
          if (live.frame !== undefined) cancelAnimationFrame(live.frame)
          live.frame = undefined
          return
        }
        resumeRender(term)
        live.observer ??= new ResizeObserver(scheduleFit)
        live.observer.observe(container)
        scheduleFit()
      },
    ),
  )

  createEffect(() => {
    if (mounted() && props.shown() && props.store.state.focus === id) focusTerminal()
  })

  // Event stream back (service restart, network): retry at once, also after the attempts ran out.
  cleanups.push(
    props.store.events.on("server.connected", () => {
      if (connection() !== "reconnecting" || live.socket || live.connecting) return
      clearRetry()
      live.tries = 0
      void connect()
    }),
  )

  // Exit from the event can come before the socket closes; stop reconnect attempts either way.
  createEffect(() => {
    if (item()?.status === "exited") clearRetry()
  })

  onCleanup(() => {
    live.disposed = true
    clearRetry()
    if (live.frame !== undefined) cancelAnimationFrame(live.frame)
    live.observer?.disconnect()
    const socket = live.socket
    live.socket = undefined
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000)
    props.onHandle(id, undefined)
    writer.flush(() =>
      cleanups
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
    )
  })

  onMount(() => {
    // Capture phase above ghostty-web: the own-web shortcuts that stay live in a terminal (palette, panel toggle,
    // panel tab keys, 03 §10) run here and never reach the shell; everything else goes to ghostty-web.
    const keydown = (event: KeyboardEvent) => void shortcuts.handle(event)
    // ghostty-web focuses its contenteditable element on a click; input and IME composition belong in its textarea
    // (as upstream's pointerdown handler does), after ghostty-web's own mousedown work.
    const pointerdown = () => setTimeout(focusTerminal, 0)
    wrapper.addEventListener("keydown", keydown, true)
    wrapper.addEventListener("click", click, true)
    wrapper.addEventListener("pointerdown", pointerdown)
    cleanups.push(() => {
      wrapper.removeEventListener("keydown", keydown, true)
      wrapper.removeEventListener("click", click, true)
      wrapper.removeEventListener("pointerdown", pointerdown)
    })
  })

  function click(event: MouseEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.button !== 0 || !live.term) return
    const link = getHoveredLinkText(live.term)
    if (!link || !/^https?:\/\//i.test(link)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    host.openExternal(link)
  }

  const status = () => {
    const current = item()
    if (current?.gone) return { tone: "danger", message: text("own.terminal.removed"), restart: true }
    if (current?.status === "exited")
      return {
        tone: "muted",
        message:
          current.exitCode === undefined
            ? text("own.terminal.exitedUnknown")
            : i18n.t("own.terminal.exited", { code: exitCodeText(current.exitCode) }),
        restart: true,
      }
    if (connection() === "failed") return { tone: "danger", message: text("own.terminal.connectFailed"), restart: true }
    if (connection() === "reconnecting")
      return { tone: "warn", message: i18n.t("own.terminal.reconnecting"), restart: false }
    return undefined
  }

  return (
    <div
      ref={wrapper}
      class="own-terminal-view"
      data-own-keys="terminal"
      data-testid="terminal-view"
      data-pty={id}
      data-connection={connection()}
      data-status={item()?.gone ? "gone" : item()?.status}
    >
      <div ref={container} class="own-terminal-screen" dir="ltr" />
      <p class="own-sr-only" id={`own-terminal-note-${id}`}>
        {text("own.terminal.screenNote")}
      </p>
      <Show when={status()}>
        {(current) => (
          <div class="own-terminal-band" data-tone={current().tone} role="status" data-testid="terminal-band">
            <span>{current().message}</span>
            <Show when={current().restart}>
              <button
                type="button"
                class="own-terminal-band-action"
                onClick={() => void props.store.restart(id)}
                disabled={props.store.state.creating}
              >
                {text("own.terminal.restart")}
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

function safe<T>(read: () => T) {
  try {
    return read()
  } catch {
    return undefined
  }
}

// Output view of a shell (03 §19.7 "출력 보기(터미널처럼)"), a lazy chunk: the combined stdout/stderr the server
// captured, as a terminal would show it (escape sequences removed, CR-rewritten lines collapsed), following the end.
//
// Data: `shell.output{cursor, limit}` pages the capture file by byte cursor (protocol groups/shell.ts); `shell.get`
// gives the status and exit code. The server has no output stream, so while the view is open, the window is visible
// and the shell still runs, it reads new bytes once a second (the transcript's session-ui shell card does the same,
// `followShellOutput`); it stops on exit, on close and while the page is hidden. Only the last TAIL characters stay in
// memory; a huge capture starts at its tail instead of paging through everything.
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { showToast } from "@/switcher/toast"
import { shellDirectory, stopShell } from "./data"
import type { OutputRequest } from "./host"
import { shortLabel } from "./model"
import { tail, terminalText } from "./terminal-text"
import { useBackgroundViewText } from "./view-strings"
import "./view.css"

const PAGE = 64 * 1024
const TAIL = 256 * 1024
const POLL_MS = 1_000
/** SSH servers (04 §12.5): every read crosses the tunnel, so half as often. */
const POLL_REMOTE_MS = 2_000
/** Pages read per tick while catching up (a fast producer never starves the UI). */
const CATCH_UP = 8

type Status = "running" | "exited" | "timeout" | "killed" | "unknown"

export default function OutputView(props: { readonly request: OutputRequest; readonly onClose: () => void }) {
  const text = useBackgroundViewText()
  const data = useData()
  const runtime = () => data.get(props.request.serverKey)
  const id = props.request.shellID
  const directory = () => {
    const current = runtime()
    return props.request.directory ?? (current ? shellDirectory(current, id, props.request.sessionID) : "")
  }
  /** Running per the event-fed shell list; the list drops a shell when it exits. */
  const live = () => !!runtime()?.data.shell.get(id)
  const [state, setState] = createStore({
    raw: "",
    cut: false,
    missing: false,
    error: undefined as string | undefined,
    status: "unknown" as Status,
    exit: undefined as number | undefined,
    shell: "",
    cwd: "",
    stopping: false,
  })
  const shown = createMemo(() => terminalText(state.raw))
  const [atEnd, setAtEnd] = createSignal(true)
  const running = () => live() || state.status === "running"

  let cursor = 0
  let first = true
  let loading = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let screen: HTMLDivElement | undefined
  let closeButton: HTMLButtonElement | undefined

  async function status() {
    const current = runtime()
    if (!current) return
    const info = await current
      .client()
      .shell.get({ id, location: { directory: directory() } })
      .then((response) => response.data)
      .catch((error: unknown) => {
        if (notFound(error)) setState("missing", true)
        return undefined
      })
    if (!info || disposed) return
    setState({
      status: info.status,
      exit: typeof info.exit === "number" ? info.exit : undefined,
      shell: info.shell,
      cwd: info.cwd,
    })
  }

  async function read() {
    const current = runtime()
    if (loading || disposed || !current || state.missing) return
    loading = true
    try {
      for (let page = 0; page < CATCH_UP; page++) {
        const response = await current
          .client()
          .shell.output({ id, location: { directory: directory() }, cursor, limit: PAGE })
        if (disposed) return
        const chunk = response.data
        // A capture far larger than what we keep: skip to its tail on the first read.
        if (first && chunk.size > TAIL + PAGE) {
          first = false
          cursor = chunk.size - TAIL
          setState("cut", true)
          continue
        }
        first = false
        const advanced = chunk.cursor > cursor
        cursor = Math.max(cursor, chunk.cursor)
        if (chunk.output) {
          const kept = tail(state.raw + chunk.output, TAIL)
          follow(() => setState({ raw: kept.text, cut: state.cut || kept.cut || chunk.truncated, error: undefined }))
        } else if (chunk.truncated && !state.cut) setState("cut", true)
        if (!advanced || cursor >= chunk.size) break
      }
    } catch (error) {
      if (notFound(error)) setState("missing", true)
      else setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      loading = false
      schedule()
    }
  }

  /** One read a second (two on SSH) while the shell runs and the page is visible (no stream exists, see the header). */
  function schedule() {
    clearTimeout(timer)
    if (disposed || !live() || document.visibilityState !== "visible" || state.missing) return
    timer = setTimeout(() => void read(), runtime()?.kind === "ssh" ? POLL_REMOTE_MS : POLL_MS)
  }

  /** Keeps the view at the end when it was there before the update (a terminal's follow mode). */
  function follow(update: () => void) {
    const stick = atEnd()
    update()
    if (stick && screen) requestAnimationFrame(() => screen && (screen.scrollTop = screen.scrollHeight))
  }

  // Exit: one last read for the final bytes and the exit code.
  createEffect(
    on(
      live,
      (now, before) => {
        if (!before || now) return
        void read()
        void status()
      },
      { defer: true },
    ),
  )

  const visibility = () => {
    if (document.visibilityState === "visible") void read()
    else clearTimeout(timer)
  }
  document.addEventListener("visibilitychange", visibility)

  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => {
    closeButton?.focus()
    void status()
    void read()
  })
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
    document.removeEventListener("visibilitychange", visibility)
    if (returnTo?.isConnected) returnTo.focus()
  })

  // Esc closes wherever focus is, never while an IME composes (03 §12 rule 3).
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
    event.stopPropagation()
    props.onClose()
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))

  async function stop() {
    const current = runtime()
    if (!current || state.stopping) return
    setState("stopping", true)
    try {
      await stopShell(current, props.request.serverKey, id, directory())
      setState({ status: "killed" })
    } catch (error) {
      showToast({
        tone: "danger",
        message: text("own.background.stopFailed", { reason: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      setState("stopping", false)
    }
  }

  async function copy() {
    await navigator.clipboard
      .writeText(shown())
      .then(() => showToast({ message: text("own.background.output.copied") }))
      .catch(() => undefined)
  }

  const statusText = () => {
    if (running() && state.status !== "killed") return text("own.background.output.running")
    if (state.status === "killed") return text("own.background.output.killed")
    if (state.status === "timeout") return text("own.background.output.timeout")
    if (state.exit !== undefined) return text("own.background.output.exited", { code: state.exit })
    return text("own.background.output.ended")
  }
  const tone = () =>
    running() && state.status !== "killed"
      ? "running"
      : state.status === "timeout" || (state.exit !== undefined && state.exit !== 0)
        ? "danger"
        : "done"

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Tab") return
    const root = event.currentTarget as HTMLElement
    const items = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']")]
    const firstItem = items[0]
    const last = items.at(-1)
    if (!firstItem || !last) return
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      firstItem.focus()
    }
  }

  return (
    <Portal>
      <div class="own-bj-scrim" onClick={() => props.onClose()} />
      <div
        class="own-bj-view"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-bj-view-title"
        data-testid="background-output"
        data-status={tone()}
        onKeyDown={keydown}
      >
        <header class="own-bj-view-head">
          <div class="own-bj-view-titles">
            <h2 id="own-bj-view-title" class="own-bj-view-title" title={props.request.label}>
              <span class="own-bj-view-kind">{text("own.background.output.title")}</span>{" "}
              <span class="own-bj-view-command">{shortLabel(props.request.label, 80)}</span>
            </h2>
            <p class="own-bj-view-meta">
              <span class="own-bj-view-status" data-tone={tone()} data-testid="background-output-status">
                {statusText()}
              </span>
              <Show when={state.cwd}>
                <span class="own-bj-view-where" title={state.cwd}>
                  {text("own.background.output.where", { shell: state.shell, cwd: state.cwd })}
                </span>
              </Show>
            </p>
          </div>
          <div class="own-bj-view-actions">
            <Show when={running() && state.status !== "killed" && runtime()?.rpc.can("prompt")}>
              <button
                type="button"
                class="own-bj-btn"
                data-tone="danger"
                data-testid="background-output-stop"
                disabled={state.stopping}
                onClick={() => void stop()}
              >
                {state.stopping ? text("own.background.stopping") : text("own.background.stop")}
              </button>
            </Show>
            <button type="button" class="own-bj-btn" disabled={!shown()} onClick={() => void copy()}>
              {text("own.background.output.copy")}
            </button>
            <button
              ref={closeButton}
              type="button"
              class="own-bj-btn"
              data-testid="background-output-close"
              onClick={() => props.onClose()}
            >
              {text("own.background.output.close")}
            </button>
          </div>
        </header>
        <Show when={state.cut}>
          <p class="own-bj-view-note">{text("own.background.output.cut", { size: "256KB" })}</p>
        </Show>
        <div
          ref={screen}
          class="own-bj-screen"
          role="log"
          aria-live="off"
          aria-label={text("own.background.output.region")}
          tabindex="0"
          data-testid="background-output-text"
          onScroll={(event) => {
            const target = event.currentTarget
            setAtEnd(target.scrollHeight - target.scrollTop - target.clientHeight < 24)
          }}
        >
          <Show
            when={shown()}
            fallback={
              <p class="own-bj-screen-empty">
                {state.missing
                  ? text("own.background.output.missing")
                  : state.error
                    ? text("own.background.output.failed", { reason: state.error })
                    : text("own.background.output.empty")}
              </p>
            }
          >
            <pre class="own-bj-pre">{shown()}</pre>
          </Show>
        </div>
        <Show when={!atEnd() && shown()}>
          <button
            type="button"
            class="own-bj-follow"
            onClick={() => {
              if (!screen) return
              screen.scrollTop = screen.scrollHeight
              setAtEnd(true)
            }}
          >
            ↓ {text("own.background.output.follow")}
          </button>
        </Show>
      </div>
    </Portal>
  )
}

function notFound(error: unknown) {
  return error instanceof Error && error.name === "ShellNotFoundError"
}

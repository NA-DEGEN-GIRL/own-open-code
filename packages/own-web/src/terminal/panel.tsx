// Terminal UI shared by the work panel tab and the bottom dock (03 §18.6, §4.7, §4.7.3). Upstream's panel.tsx /
// tab.tsx / surface.tsx (packages/app/src/session/terminal) are the reference; this is an own accessible tablist
// instead of @opencode/ui tabs + dnd-kit (Kobalte unmounts hidden content and needs the ui i18n context, see
// ARCHITECTURE §10). Tab row: `셸 이름 · 폴더` tabs, `+` (새 터미널, Ctrl+Alt+T), shell choice `▾` (19.8 hook point),
// `출력 복사`, `출력을 텍스트로 보기` (11장). Views stay mounted while hidden (scrollback) for the recent locations.
import "./terminal.css"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP, useShortcut } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { Icon } from "@/shell/icons"
import type { ShellOption } from "./api"
import { loadGhostty } from "./ghostty"
import { pendingNewTerminals, requestNewTerminal, setTerminalRunning, takeNewTerminalRequests } from "./intents"
import { tabLabels, type TabLabel } from "./label"
import type { TerminalStore } from "./store"
import { useTerminalText, type TerminalText } from "./strings"
import { TEXT_LINES } from "./text"
import { TerminalView, type TerminalHandle } from "./view"
import { terminalStore } from "./workspaces"

/** Locations whose terminal views stay mounted (hidden) after switching away; older ones reconnect with replay. */
const KEEP_LOCATIONS = 3

interface Surface {
  readonly store: TerminalStore
  readonly id: string
  readonly label: string
}

export interface TerminalPanelProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  /** Location override (harness, a project route the caller already resolved). */
  readonly directory?: () => string | undefined
  /** The tab or dock is on screen. Hidden: no rendering, no observers (4.7). */
  readonly visible: () => boolean
  readonly placement: "tab" | "dock"
  /** Shows the surface this UI lives in (`Ctrl+Alt+T` while the tab or dock is hidden). */
  readonly reveal?: () => void
  /** Extra buttons at the end of the tab row (the dock's collapse button). */
  readonly actions?: JSX.Element
}

export function TerminalPanel(props: TerminalPanelProps) {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  const text = useTerminalText()
  const runtime = createMemo(() => data.get(props.serverKey()))

  /** 18.6: terminals belong to the project location, not the session. */
  const directory = createMemo(() => {
    const explicit = props.directory?.()
    if (explicit) return explicit
    const current = runtime()
    if (!current) return undefined
    const sessionID = props.sessionID()
    if (sessionID)
      return current.data.session.get(sessionID)?.location.directory ?? current.sessions.directory(sessionID)
    const route = router.route()
    return route.name === "project" ? current.sessions.state.projects[route.projectID]?.directory : undefined
  })
  const store = createMemo(() => {
    const current = runtime()
    const dir = directory()
    return current && dir ? terminalStore(current, dir) : undefined
  })

  // T2 (03 §20.1, terminal < 300 ms): fetch the ghostty-web chunk and compile its wasm while the PTY list and create
  // requests are in flight, instead of after the first view mounts.
  createEffect(() => {
    if (props.visible()) void loadGhostty().catch(() => undefined)
  })

  const autoCreated = new WeakSet<TerminalStore>()
  createEffect(() => {
    const current = store()
    if (current && props.visible() && current.state.status === "idle") void current.load()
  })
  // First open of a location with no terminal creates one (upstream does the same); explicit requests always do.
  createEffect(() => {
    const current = store()
    const requested = pendingNewTerminals()
    if (!current || !props.visible() || current.state.status !== "ready") return
    if (requested) {
      takeNewTerminalRequests()
      autoCreated.add(current)
      void current.create()
      return
    }
    if (current.state.order.length || current.state.creating || autoCreated.has(current)) return
    autoCreated.add(current)
    void current.create()
  })
  createEffect(() => setTerminalRunning(store()?.running() ?? 0))
  onCleanup(() => setTerminalRunning(0))

  // Registered while this UI is mounted; the shell registers the same id for the time before (wiring request).
  useShortcut("terminal.new", () => {
    props.reveal?.()
    requestNewTerminal()
  })

  const labels = createMemo(() => labelsOf(store()))
  const labelText = (label: TabLabel | undefined) => formatLabel(text, label)

  // Mounted views: every visited tab of the current location, plus those of the last KEEP_LOCATIONS locations visited.
  const [surfaces, setSurfaces] = createSignal<readonly Surface[]>([])
  const visits: TerminalStore[] = []
  createEffect(
    on(
      () => {
        const current = store()
        return [current, current?.state.active, current?.state.order.join("\0")] as const
      },
      ([current, active]) => {
        if (!current) return
        visits.splice(
          0,
          visits.length,
          ...[current, ...visits.filter((item) => item !== current)].slice(0, KEEP_LOCATIONS),
        )
        const keep = new Set(visits)
        const alive = surfaces().filter((surface) => keep.has(surface.store) && surface.store.state.items[surface.id])
        const added =
          active && !alive.some((surface) => surface.store === current && surface.id === active)
            ? [{ store: current, id: active, label: labelText(labelsOf(current).get(active)) }]
            : []
        setSurfaces([...alive, ...added])
      },
    ),
  )

  const handles = new Map<string, TerminalHandle>()
  const activeHandle = () => {
    const id = store()?.state.active
    return id ? handles.get(id) : undefined
  }
  const [notice, setNotice] = createSignal<string>()
  const [textView, setTextView] = createSignal<string>()
  const noticeTimer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  onCleanup(() => clearTimeout(noticeTimer.current))
  const announce = (message: string) => {
    setNotice(message)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(undefined), 2_000)
  }
  const copyOutput = () => {
    const output = activeHandle()?.text(TEXT_LINES) ?? ""
    const done = navigator.clipboard?.writeText(output)
    if (!done) return announce(text("own.terminal.copyFailed"))
    done.then(
      () => announce(text("own.terminal.copied")),
      () => announce(text("own.terminal.copyFailed")),
    )
  }
  // A different location or tab closes the text view: it showed another terminal's output. The active tab scrolls
  // into the (horizontally scrolling) tab row.
  createEffect(
    on(
      () => store()?.state.active,
      (id) => {
        setTextView(undefined)
        if (id)
          requestAnimationFrame(() =>
            document.getElementById(`own-terminal-tab-${id}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }),
          )
      },
      { defer: true },
    ),
  )

  const selectByKey = (event: KeyboardEvent) => {
    const current = store()
    if (!current || event.isComposing) return
    const delta = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0
    if (!delta) return
    event.preventDefault()
    current.step(delta)
    document.getElementById(`own-terminal-tab-${current.state.active}`)?.focus()
  }

  return (
    <section
      class="own-terminal"
      data-placement={props.placement}
      data-testid="terminal-panel"
      aria-label={i18n.t("own.panel.terminal")}
    >
      <Show when={store()} fallback={<p class="own-terminal-empty">{text("own.terminal.noLocation")}</p>} keyed>
        {(current) => (
          <>
            <div class="own-terminal-head">
              <div
                class="own-terminal-tabs"
                role="tablist"
                aria-label={text("own.terminal.tabs")}
                onKeyDown={selectByKey}
              >
                <For each={current.state.order}>
                  {(id) => {
                    const item = () => current.state.items[id]
                    const label = () => labelText(labels().get(id))
                    const active = () => current.state.active === id
                    return (
                      <div class="own-terminal-tab" data-active={active() ? "" : undefined}>
                        <button
                          type="button"
                          role="tab"
                          id={`own-terminal-tab-${id}`}
                          class="own-terminal-tab-button"
                          aria-selected={active()}
                          aria-controls="own-terminal-surfaces"
                          tabIndex={active() ? 0 : -1}
                          data-testid="terminal-tab"
                          data-status={item()?.gone ? "gone" : item()?.status}
                          title={item()?.cwd}
                          onClick={() => current.select(id)}
                          onAuxClick={(event) => {
                            if (event.button === 1) void current.close(id)
                          }}
                        >
                          <span class="own-terminal-dot" aria-hidden="true" />
                          <span class="own-terminal-tab-label">{label()}</span>
                        </button>
                        <button
                          type="button"
                          class="own-terminal-tab-close"
                          aria-label={`${text("own.terminal.close")}: ${label()}`}
                          data-testid="terminal-close"
                          onClick={() => void current.close(id)}
                        >
                          <Icon name="x" />
                        </button>
                      </div>
                    )
                  }}
                </For>
              </div>
              <div class="own-terminal-actions">
                <button
                  type="button"
                  class="own-icon-button"
                  aria-label={i18n.t("own.terminal.new")}
                  title={`${i18n.t("own.terminal.new")} (${chordLabel(DEFAULT_KEYMAP["terminal.new"].chords[0])})`}
                  data-testid="terminal-new"
                  disabled={current.state.creating}
                  onClick={() => void current.create()}
                >
                  <Icon name="plus" />
                </button>
                <ShellMenu store={current} text={text} />
                <button
                  type="button"
                  class="own-icon-button own-terminal-text-button"
                  aria-label={i18n.t("own.terminal.copyOutput")}
                  title={i18n.t("own.terminal.copyOutput")}
                  data-testid="terminal-copy"
                  disabled={!current.state.active}
                  onClick={copyOutput}
                >
                  <CopyGlyph />
                </button>
                <button
                  type="button"
                  class="own-icon-button own-terminal-text-button"
                  aria-label={text("own.terminal.viewText")}
                  aria-pressed={textView() !== undefined}
                  title={text("own.terminal.viewText")}
                  data-testid="terminal-view-text"
                  disabled={!current.state.active}
                  onClick={() =>
                    setTextView(textView() === undefined ? (activeHandle()?.text(TEXT_LINES) ?? "") : undefined)
                  }
                >
                  <TextGlyph />
                </button>
                {props.actions}
              </div>
            </div>
            <p class="own-sr-only" role="status" aria-live="polite">
              {notice()}
            </p>
            <Show when={notice()}>
              <p class="own-terminal-notice" aria-hidden="true">
                {notice()}
              </p>
            </Show>
            <Show when={current.state.error}>
              {(error) => (
                <p class="own-terminal-error" role="alert">
                  {text("own.terminal.createFailed", { message: error() })}
                </p>
              )}
            </Show>
            <Show when={current.state.status !== "ready" || (!current.state.order.length && current.state.creating)}>
              <p class="own-terminal-empty">{text("own.terminal.loading")}</p>
            </Show>
            <Show when={current.state.status === "ready" && !current.state.order.length && !current.state.creating}>
              <p class="own-terminal-empty">{text("own.terminal.empty")}</p>
            </Show>
          </>
        )}
      </Show>
      <div class="own-terminal-surfaces" id="own-terminal-surfaces" role="tabpanel">
        <For each={surfaces()}>
          {(surface) => {
            const shown = () =>
              props.visible() && store() === surface.store && surface.store.state.active === surface.id
            return (
              <div class="own-terminal-surface" hidden={!shown()} aria-labelledby={`own-terminal-tab-${surface.id}`}>
                <TerminalView
                  store={surface.store}
                  id={surface.id}
                  label={surface.label}
                  shown={shown}
                  onHandle={(id, handle) => (handle ? handles.set(id, handle) : handles.delete(id))}
                />
              </div>
            )
          }}
        </For>
        <Show when={textView() !== undefined}>
          <div
            class="own-terminal-text"
            role="dialog"
            aria-label={text("own.terminal.viewText")}
            data-testid="terminal-text"
          >
            <div class="own-terminal-text-head">
              <h3>{text("own.terminal.textTitle", { n: TEXT_LINES })}</h3>
              <button
                type="button"
                class="own-icon-button"
                aria-label={text("own.terminal.textClose")}
                onClick={() => {
                  setTextView(undefined)
                  activeHandle()?.focus()
                }}
              >
                <Icon name="x" />
              </button>
            </div>
            <pre
              tabIndex={0}
              ref={(element) => requestAnimationFrame(() => element.focus())}
              onKeyDown={(event) => {
                if (event.code !== "Escape" || event.isComposing) return
                event.stopPropagation()
                setTextView(undefined)
                activeHandle()?.focus()
              }}
            >
              {textView() || text("own.terminal.textEmpty")}
            </pre>
          </div>
        </Show>
      </div>
    </section>
  )
}

function labelsOf(store: TerminalStore | undefined) {
  if (!store) return new Map<string, TabLabel>()
  return tabLabels(store.state.order.flatMap((id) => (store.state.items[id] ? [store.state.items[id]] : [])))
}

function formatLabel(text: TerminalText, label: TabLabel | undefined) {
  if (!label) return ""
  if (label.n > 1) return text("own.terminal.labelNumbered", { shell: label.shell, folder: label.folder, n: label.n })
  return text("own.terminal.label", { shell: label.shell, folder: label.folder })
}

/**
 * `▾` shell choice (03 §18.6, 19.8 hook point): shells the server found (`GET /api/config/shell`) for this one
 * terminal. It never changes the configured shell (that is settings > 셸·터미널, item 24), so the agent's tool
 * definitions and caches are untouched.
 */
function ShellMenu(props: { readonly store: TerminalStore; readonly text: TerminalText }) {
  const [open, setOpen] = createSignal(false)
  const [shells, setShells] = createSignal<readonly ShellOption[]>()
  let root!: HTMLDivElement
  const close = (focusButton = false) => {
    setOpen(false)
    if (focusButton) root.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus()
  }
  const toggle = () => {
    if (open()) return close()
    setOpen(true)
    if (!shells()) void props.store.api.shells().then(setShells, () => setShells([]))
  }
  const choose = (command: string | undefined) => {
    close(true)
    void props.store.create({ command })
  }
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && !root.contains(event.target)) close()
  }
  createEffect(() => {
    if (!open()) return
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
    requestAnimationFrame(() => root.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus())
  })
  const move = (event: KeyboardEvent) => {
    if (event.isComposing) return
    if (event.code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close(true)
    }
    const delta = event.code === "ArrowDown" ? 1 : event.code === "ArrowUp" ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const items = [...root.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + delta + items.length) % items.length]?.focus()
  }
  return (
    <div class="own-terminal-shells" ref={root}>
      <button
        type="button"
        class="own-icon-button"
        aria-label={props.text("own.terminal.shellMenu")}
        title={props.text("own.terminal.shellMenu")}
        aria-haspopup="menu"
        aria-expanded={open()}
        data-testid="terminal-shells"
        disabled={props.store.state.creating}
        onClick={toggle}
      >
        <ChevronGlyph />
      </button>
      <Show when={open()}>
        <div class="own-terminal-menu" role="menu" aria-label={props.text("own.terminal.shellMenu")} onKeyDown={move}>
          <button type="button" role="menuitem" class="own-terminal-menu-item" onClick={() => choose(undefined)}>
            {props.text("own.terminal.shellDefault")}
          </button>
          <Show
            when={shells()}
            fallback={<p class="own-terminal-menu-note">{props.text("own.terminal.shellLoading")}</p>}
          >
            {(list) => (
              <Show
                when={list().length}
                fallback={<p class="own-terminal-menu-note">{props.text("own.terminal.shellNone")}</p>}
              >
                <For each={list()}>
                  {(shell) => (
                    <button
                      type="button"
                      role="menuitem"
                      class="own-terminal-menu-item"
                      title={shell.path}
                      data-testid="terminal-shell-option"
                      onClick={() => choose(shell.path)}
                    >
                      <span>{shell.name}</span>
                      <span class="own-terminal-menu-path">{shell.path}</span>
                    </button>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

const glyph = (path: string) => () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
)
const CopyGlyph = glyph("M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4")
const TextGlyph = glyph("M5 6h14M5 10h14M5 14h10M5 18h7")
const ChevronGlyph = glyph("M7 10l5 5 5-5")

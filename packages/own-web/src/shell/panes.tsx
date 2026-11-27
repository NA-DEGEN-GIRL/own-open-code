// Split pane area (03 §4.1.1, 05 §7.2): the window's pane tree (pane-layout.ts) laid out flat. Every leaf is an
// absolutely placed child of one container, so splitting, closing, resizing and switching between `나란히` and tabs
// never re-parent a pane: composers keep focus, drafts and IME state, and native browser views never remount.
//  - `나란히`: each leaf at its rectangle, dividers between them (drag or arrow keys, 20 px a step); while a divider
//    is dragged the browser views stand behind stills and a guide line shows where it will land.
//  - Tabs (`탭으로 보기`, or a width where the tree does not fit): the focused chat pane alone under 채팅; under
//    브라우저 its browser pane, or a panel of its session when it has none.
//  - Panes show a slim bar (title, status, split, `⋯`, close) once there are two; the focused pane is outlined.
//  - A session row dragged from the sidebar onto a pane opens there (centre) or beside it (an edge); a pane's bar
//    dragged onto another pane moves it beside that one (an edge) or trades places (centre).
//  - Browser panes: one visible view per session (05 §8.2): a second pane on the same session offers
//    `여기로 옮기기` instead of a second view. A click inside a native view focuses its pane (host `onViewFocus`).
//  - Keys (keymap `pane.*`): split right/down, close, focus pane 1–4, F6 / Shift+F6 through sidebar → panes → panel.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { LOCAL, useData } from "@/data"
import { useI18n } from "@/i18n"
import { teamTitle } from "@/team/title"
import { useShortcut } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { SessionTitle } from "@/transcript"
import { useShell } from "./context"
import { Icon } from "./icons"
import { SessionPane } from "./pane"
import { PaneProvider } from "./pane-context"
import {
  browserOf,
  browserTarget,
  focusedChat,
  layoutRects,
  leavesOf,
  minWidth,
  minHeight,
  nodeAt,
  moveDivider,
  movePane,
  PANE_DRAG_TYPE,
  sameSession,
  sessionOfRoute,
  pinBrowser,
  SESSION_DRAG_TYPE,
  type DividerRect,
  type PaneDir,
  type PaneLeaf,
  type PaneRect,
  type PaneRoute,
  type PaneSession,
} from "./pane-layout"

const BrowserPanel = lazy(() => import("@/browser"))

const STEP = 20
/** The pane whose bar is being dragged (drag events carry no readable data until the drop). */
const [movingPane, setMovingPane] = createSignal<string>()

type Edge = "left" | "right" | "top" | "bottom" | "center"

export function PaneArea(props: {
  /** The workspace is on screen (no page covers it). */
  readonly visible: () => boolean
  /** Native views must hide (a shell drawer, the notes drag and drop). */
  readonly blocked: () => boolean
  /** Under the panes, across their width (the bottom terminal dock). */
  readonly children?: JSX.Element
}) {
  const shell = useShell()
  const i18n = useI18n()
  const router = useRouter()
  const state = shell.paneState
  const split = shell.splitView
  let area!: HTMLDivElement
  let stopDivider: (() => void) | undefined
  onCleanup(() => stopDivider?.())
  const [dragging, setDragging] = createSignal<{ readonly divider: DividerRect; readonly offset: number }>()
  const [drop, setDrop] = createSignal<{ readonly leaf: string; readonly edge: Edge }>()
  /** `여기로 옮기기`: the browser pane that took a session's view over (cleared when it closes). */
  const [claims, setClaims] = createSignal<Record<string, string>>({})
  const [announcement, setAnnouncement] = createSignal("")

  onMount(() => {
    // Measured a frame later: the split ↔ tabs answer must not change layout inside the observer's own delivery.
    let frame = 0
    const measure = () => {
      frame = 0
      const width = area.clientWidth
      const height = area.clientHeight
      const current = shell.paneArea()
      if (current.width !== width || current.height !== height) shell.setPaneArea({ width, height })
    }
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure)
    })
    observer.observe(area)
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    })
  })

  const ids = createMemo(() => leavesOf(state().tree).map((leaf) => leaf.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
  })
  const shown = createMemo(() => new Set(leavesOf(shell.shownTree()).map((leaf) => leaf.id)))
  const rects = createMemo(() => layoutRects(shell.shownTree()))
  /** Reading order (top to bottom, then left to right): the pane numbers, Ctrl+Alt+1–4 and F6 follow it. */
  const reading = createMemo(() => {
    const boxes = rects().leaves
    const at = (id: string) => boxes.get(id) ?? { x: 0, y: 0 }
    return leavesOf(shell.shownTree()).toSorted(
      (a, b) => Math.round((at(a.id).y - at(b.id).y) * 1000) || Math.round((at(a.id).x - at(b.id).x) * 1000),
    )
  })
  const multiple = () => split() && shown().size > 1
  const focusedChatID = () => focusedChat(state())?.id
  /** Tabs: the leaf on screen under the current tab. */
  const tabsLeaf = () => {
    const chat = focusedChatID()
    if (!chat) return undefined
    if (shell.workspaceTab() === "browser") return browserOf(state(), chat)?.id
    return shell.workspaceTab() === "chat" ? chat : undefined
  }
  const displayed = (id: string) => (split() ? shown().has(id) : tabsLeaf() === id)
  /** Which browser pane shows each session's view: a claim, else the focused pane's own, else the first. */
  const owners = createMemo(() => {
    const result = new Map<string, string>()
    const focusedBrowser = browserOf(state(), focusedChatID() ?? "")?.id
    const candidates = leavesOf(state().tree).filter((leaf) => leaf.view === "browser" && displayed(leaf.id))
    for (const leaf of candidates) {
      const target = browserTarget(state(), leaf)
      if (!target) continue
      const key = sessionKey(target)
      const claimed = claims()[key]
      const current = result.get(key)
      if (claimed && candidates.some((item) => item.id === claimed)) result.set(key, claimed)
      else if (!current || leaf.id === focusedBrowser) result.set(key, leaf.id)
    }
    return result
  })
  /** Tabs mode with no browser pane for the focused session: a panel of its own under 브라우저. */
  const standalone = () =>
    !split() &&
    shell.workspaceTab() === "browser" &&
    shell.browserMounted() &&
    !browserOf(state(), focusedChatID() ?? "")
  const focusedRoute = () => focusedChat(state())?.route

  // Pane focus changes are announced once, in one live region, with the pane's name.
  createEffect(
    on(
      () => state().focused,
      (id) => {
        if (!multiple()) return
        const index = reading().findIndex((leaf) => leaf.id === id)
        const element = area.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)
        if (index >= 0 && element) setAnnouncement(element.getAttribute("aria-label") ?? "")
      },
      { defer: true },
    ),
  )

  // ---- keys ----
  const order = () => (split() ? reading() : leavesOf(state().tree).filter((leaf) => leaf.view === "chat"))
  const focusLeaf = (id: string) => {
    shell.focusPane(id)
    const leaf = shell.paneLeaf(id)
    if (leaf && !split() && leaf.view === "chat") shell.selectWorkspaceTab("chat")
    requestAnimationFrame(() => focusInside(id))
  }
  const focusInside = (id: string) => {
    const element = area.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)
    const target =
      element?.querySelector<HTMLElement>("textarea[data-own-keys='composer']") ??
      element?.querySelector<HTMLElement>("[data-testid='browser-address']") ??
      element
    target?.focus({ preventScroll: true })
  }
  useShortcut("pane.splitRight", () => splitAndFocus("row"), { when: shell.splitCapable })
  useShortcut("pane.splitDown", () => splitAndFocus("column"), { when: shell.splitCapable })
  useShortcut("pane.close", () => {
    if (leavesOf(state().tree).length < 2) return false
    shell.closePane(state().focused)
    requestAnimationFrame(() => focusInside(state().focused))
  })
  for (const n of [1, 2, 3, 4] as const)
    useShortcut(`pane.focus${n}`, () => {
      const leaf = order()[n - 1]
      if (!leaf) return false
      focusLeaf(leaf.id)
    })
  useShortcut("pane.next", () => cycle(1))
  useShortcut("pane.previous", () => cycle(-1))
  function splitAndFocus(dir: PaneDir) {
    shell.splitFocused(dir)
    requestAnimationFrame(() => focusInside(state().focused))
  }
  /** F6 / Shift+F6: sidebar → each pane on screen → work panel (the ones that are open). */
  function cycle(delta: number) {
    const regions: { readonly key: string; readonly focus: () => void }[] = [
      ...(shell.sidebarOpen() ? [{ key: "sidebar", focus: () => focusRegion("[data-testid='sidebar']") }] : []),
      ...(split() ? reading() : [focusedChat(state())!])
        .filter(Boolean)
        .map((leaf) => ({ key: leaf.id, focus: () => focusLeaf(leaf.id) })),
      ...(shell.panelOpen() ? [{ key: "panel", focus: () => focusRegion("[data-testid='panel']") }] : []),
    ]
    if (!regions.length) return
    const active = document.activeElement
    const current = regions.findIndex((region) => {
      if (region.key === "sidebar") return !!active?.closest("[data-testid='sidebar']")
      if (region.key === "panel") return !!active?.closest("[data-testid='panel']")
      return active?.closest("[data-pane-id]")?.getAttribute("data-pane-id") === region.key
    })
    const from = current >= 0 ? current : regions.findIndex((region) => region.key === state().focused)
    regions[(from + delta + regions.length) % regions.length]!.focus()
  }

  // ---- dividers ----
  const beginDivider = (divider: DividerRect, event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    stopDivider?.()
    const origin = divider.dir === "row" ? event.clientX : event.clientY
    const limits = dividerLimits(divider)
    setDragging({ divider, offset: 0 })
    const move = (next: PointerEvent) =>
      setDragging({
        divider,
        offset: clampTo(limits, (divider.dir === "row" ? next.clientX : next.clientY) - origin),
      })
    const stop = () => {
      const current = dragging()
      if (current) commitDivider(current.divider, current.offset)
      setDragging(undefined)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      stopDivider = undefined
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
    window.addEventListener("pointercancel", stop, { once: true })
    stopDivider = stop
  }
  /** Pixels the divider may move: each side keeps its panes' minimum size. */
  const dividerLimits = (divider: DividerRect) => {
    const split = nodeAt(state().tree, divider.path)
    const size = divider.dir === "row" ? area.clientWidth : area.clientHeight
    if (!split || split.kind !== "split") return { min: 0, max: 0 }
    const before = split.children[divider.index]!
    const after = split.children[divider.index + 1]!
    const need = (node: typeof before) =>
      divider.dir === "row" ? minWidth(node, shell.shownView) : minHeight(node, shell.shownView)
    const extent = divider.extent * size
    const beforePx = (split.sizes[divider.index] ?? 0) * extent
    const afterPx = (split.sizes[divider.index + 1] ?? 0) * extent
    return { min: Math.min(0, need(before) - beforePx), max: Math.max(0, afterPx - need(after)) }
  }
  const commitDivider = (divider: DividerRect, offset: number) => {
    const size = divider.dir === "row" ? area.clientWidth : area.clientHeight
    if (!offset || !size) return
    shell.panes.update((current) => moveDivider(current, divider.path, divider.index, offset / (divider.extent * size)))
  }
  const dividerValue = (divider: DividerRect) => {
    const node = nodeAt(state().tree, divider.path)
    return node?.kind === "split" ? Math.round((node.sizes[divider.index] ?? 0) * 100) : 50
  }

  // ---- session rows (and pane bars) dropped on panes ----
  const carriesSession = (event: DragEvent) =>
    !!event.dataTransfer?.types.includes(SESSION_DRAG_TYPE) ||
    (!!movingPane() && !!event.dataTransfer?.types.includes(PANE_DRAG_TYPE))
  const dropAt = (event: DragEvent) => {
    const bounds = area.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height
    const moving = movingPane()
    const candidates = moving
      ? [...rects().leaves].filter(([id]) => id !== moving)
      : split()
        ? [...rects().leaves].filter(([id]) => shell.paneLeaf(id)?.view === "chat")
        : [[focusedChatID() ?? "", { x: 0, y: 0, width: 1, height: 1 }] as const]
    const hit = candidates.find(
      ([, rect]) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height,
    )
    if (!hit) return undefined
    const [leaf, rect] = hit
    if (!shell.splitCapable()) return { leaf, edge: "center" as const }
    const fx = (x - rect.x) / rect.width
    const fy = (y - rect.y) / rect.height
    const edge: Edge = fx < 0.25 ? "left" : fx > 0.75 ? "right" : fy < 0.25 ? "top" : fy > 0.75 ? "bottom" : "center"
    return { leaf, edge }
  }
  const dropRect = (): PaneRect | undefined => {
    const target = drop()
    if (!target) return undefined
    const rect = split() ? rects().leaves.get(target.leaf) : { x: 0, y: 0, width: 1, height: 1 }
    if (!rect) return undefined
    if (target.edge === "left") return { ...rect, width: rect.width / 2 }
    if (target.edge === "right") return { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 }
    if (target.edge === "top") return { ...rect, height: rect.height / 2 }
    if (target.edge === "bottom") return { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 }
    return rect
  }
  const onDrop = (event: DragEvent) => {
    const target = drop()
    setDrop(undefined)
    const moving = movingPane()
    setMovingPane(undefined)
    if (moving && target) {
      event.preventDefault()
      const result = movePane(
        state(),
        moving,
        target.leaf,
        target.edge === "center"
          ? "swap"
          : {
              dir: target.edge === "left" || target.edge === "right" ? "row" : "column",
              before: target.edge === "left" || target.edge === "top",
            },
      )
      if (result.refused === "depth" || result.refused === "limit")
        return void showToast({ message: i18n.t(`own.pane.${result.refused}`), tone: "danger" })
      shell.panes.update(() => result.state)
      return shell.focusPane(result.state.focused)
    }
    const raw = event.dataTransfer?.getData(SESSION_DRAG_TYPE)
    if (!target || !raw) return
    event.preventDefault()
    const session = parseSession(raw)
    if (!session) return
    const route: PaneRoute = { name: "session", ...session }
    if (target.edge === "center") {
      shell.focusPane(target.leaf)
      return router.navigate(route)
    }
    shell.openBeside(route, {
      target: target.leaf,
      dir: target.edge === "left" || target.edge === "right" ? "row" : "column",
      before: target.edge === "left" || target.edge === "top",
    })
  }

  const style = (rect: PaneRect | undefined): JSX.CSSProperties =>
    rect
      ? {
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }
      : {}

  return (
    <div class="own-pane-stack">
      <div
        ref={area}
        class="own-panes"
        data-testid="panes"
        data-mode={split() ? "split" : "tabs"}
        data-count={shown().size}
        data-dragging={dragging() ? dragging()!.divider.dir : undefined}
        onDragOver={(event) => {
          if (!carriesSession(event)) return
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
          const target = dropAt(event)
          const current = drop()
          if (target?.leaf !== current?.leaf || target?.edge !== current?.edge) setDrop(target)
        }}
        onDragLeave={(event) => {
          if (!area.contains(event.relatedTarget as Node | null)) setDrop(undefined)
        }}
        onDrop={onDrop}
      >
        <For each={ids()}>
          {(id) => (
            <PaneLeafView
              id={id}
              style={() => (split() ? style(rects().leaves.get(id)) : {})}
              displayed={() => displayed(id)}
              visible={() => props.visible() && displayed(id)}
              blocked={props.blocked}
              frozen={() => !!dragging()}
              bar={multiple}
              owner={(session) => owners().get(sessionKey(session)) === id}
              claim={(session) => setClaims((current) => ({ ...current, [sessionKey(session)]: id }))}
              index={() => reading().findIndex((leaf) => leaf.id === id) + 1}
              focusedChat={() => focusedChatID() === id}
            />
          )}
        </For>
        <Show when={standalone()}>
          <div class="own-pane own-pane-standalone" data-view="browser">
            <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
              <BrowserPanel
                tab="browser"
                serverKey={() => {
                  return focusedRoute()?.serverKey ?? LOCAL
                }}
                sessionID={() => sessionOfRoute(focusedRoute())?.sessionID}
                visible={() => props.visible() && !props.blocked()}
              />
            </Suspense>
          </div>
        </Show>
        <Show when={multiple()}>
          <For each={rects().dividers}>
            {(divider) => (
              <div
                class="own-pane-divider"
                role="separator"
                tabIndex={0}
                data-dir={divider.dir}
                data-testid="pane-divider"
                aria-orientation={divider.dir === "row" ? "vertical" : "horizontal"}
                aria-label={i18n.t("own.pane.divider")}
                aria-valuenow={dividerValue(divider)}
                aria-valuemin={10}
                aria-valuemax={90}
                style={style(divider)}
                onPointerDown={(event) => beginDivider(divider, event)}
                onKeyDown={(event) => {
                  const forward = divider.dir === "row" ? "ArrowRight" : "ArrowDown"
                  const back = divider.dir === "row" ? "ArrowLeft" : "ArrowUp"
                  if (event.key !== forward && event.key !== back) return
                  event.preventDefault()
                  commitDivider(divider, clampTo(dividerLimits(divider), event.key === forward ? STEP : -STEP))
                }}
              />
            )}
          </For>
        </Show>
        <Show when={dragging()}>
          {(current) => (
            <div
              class="own-pane-guide"
              data-dir={current().divider.dir}
              style={
                current().divider.dir === "row"
                  ? {
                      left: `calc(${current().divider.x * 100}% + ${current().offset}px)`,
                      top: `${current().divider.y * 100}%`,
                      height: `${current().divider.height * 100}%`,
                    }
                  : {
                      top: `calc(${current().divider.y * 100}% + ${current().offset}px)`,
                      left: `${current().divider.x * 100}%`,
                      width: `${current().divider.width * 100}%`,
                    }
              }
            />
          )}
        </Show>
        <Show when={dropRect()}>
          {(rect) => (
            <div
              class="own-pane-drop"
              data-own-overlay
              data-testid="pane-drop"
              data-edge={drop()?.edge}
              style={style(rect())}
            >
              <span>
                {i18n.t(
                  movingPane() && drop()!.edge === "center" ? "own.pane.drop.swap" : `own.pane.drop.${drop()!.edge}`,
                )}
              </span>
            </div>
          )}
        </Show>
      </div>
      {props.children}
      <p class="own-sr-only" role="status" aria-live="polite" data-testid="pane-announcement">
        {announcement()}
      </p>
    </div>
  )
}

function PaneLeafView(props: {
  readonly id: string
  readonly style: () => JSX.CSSProperties
  readonly displayed: () => boolean
  readonly visible: () => boolean
  readonly blocked: () => boolean
  readonly frozen: () => boolean
  readonly bar: () => boolean
  readonly owner: (session: PaneSession) => boolean
  readonly claim: (session: PaneSession) => void
  readonly index: () => number
  readonly focusedChat: () => boolean
}) {
  const shell = useShell()
  const i18n = useI18n()
  const data = useData()
  const leaf = createMemo(() => shell.paneLeaf(props.id))
  // A leaf keeps its kind for its whole life (ids are never reused within a tree).
  const view = untrack(() => leaf()?.view ?? "chat")
  const focused = () => shell.paneState().focused === props.id
  const route = () => leaf()?.route
  const serverKey = () => route()?.serverKey ?? LOCAL
  const sessionID = () => sessionOfRoute(route())?.sessionID
  const target = createMemo(
    () => {
      const current = leaf()
      return current?.view === "browser" ? browserTarget(shell.paneState(), current) : undefined
    },
    undefined,
    { equals: (a, b) => a === b || sameSession(a, b) },
  )
  const shownTitle = (session: PaneSession) => {
    const runtime = data.get(session.serverKey)
    const role = runtime?.team.placeOf(session.sessionID)?.role
    return teamTitle(runtime?.data.session.get(session.sessionID)?.title, role, i18n.locale())
  }
  const titleOf = (session: PaneSession | undefined) =>
    session
      ? (shownTitle(session) ?? i18n.t("own.shell.untitled"))
      : i18n.t("own.pane.newSession")
  const label = () =>
    view === "browser"
      ? i18n.t("own.pane.browserLabel", { n: props.index(), title: titleOf(target()) })
      : i18n.t("own.pane.label", { n: props.index(), title: titleOf(sessionOfRoute(route())) })
  const focus = () => {
    if (!focused()) shell.focusPane(props.id)
  }
  return (
    <section
      class="own-pane"
      role="region"
      aria-label={label()}
      data-pane-id={props.id}
      data-view={view}
      data-testid="pane"
      data-focused={focused() && props.bar() ? "" : undefined}
      // `inFocusedPane` and the composer id look for the chat pane the URL follows.
      data-pane-focused={view === "chat" && props.focusedChat() ? "" : undefined}
      hidden={!props.displayed()}
      style={props.style()}
      onPointerDown={focus}
      onFocusIn={focus}
    >
      <Show when={props.bar()}>
        <PaneBar
          id={props.id}
          view={view}
          index={props.index}
          serverKey={serverKey}
          sessionID={sessionID}
          target={target}
          pinned={() => !!leaf()?.pinned}
        />
      </Show>
      <Switch>
        <Match when={view === "chat"}>
          <PaneProvider value={{ id: props.id, focused: props.focusedChat, visible: props.visible }}>
            <SessionPane serverKey={serverKey} sessionID={sessionID} visible={props.visible} />
          </PaneProvider>
        </Match>
        <Match when={view === "browser"}>
          <Show
            when={target()}
            fallback={
              // The browser module says how to get a browser, under its (read-only) address bar.
              <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
                <BrowserPanel
                  tab="browser"
                  serverKey={serverKey}
                  sessionID={() => undefined}
                  visible={() => props.visible() && !props.blocked()}
                />
              </Suspense>
            }
          >
            {(session) => (
              <Show
                when={props.owner(session())}
                fallback={
                  <div class="own-pane-elsewhere" data-testid="pane-browser-elsewhere">
                    <p class="m-0">{i18n.t("own.pane.elsewhere")}</p>
                    <button type="button" class="own-btn" data-size="sm" onClick={() => props.claim(session())}>
                      {i18n.t("own.pane.moveHere")}
                    </button>
                  </div>
                }
              >
                <Show when={props.displayed()}>
                  <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
                    <BrowserPanel
                      tab="browser"
                      serverKey={() => session().serverKey}
                      sessionID={() => session().sessionID}
                      visible={() => props.visible() && !props.blocked()}
                      frozen={props.frozen}
                      onViewFocus={() => shell.focusPane(props.id)}
                    />
                  </Suspense>
                </Show>
              </Show>
            )}
          </Show>
        </Match>
      </Switch>
    </section>
  )
}

/** The slim bar of a pane once there are two: name, status, split, `⋯` (more), close. */
function PaneBar(props: {
  readonly id: string
  readonly view: PaneLeaf["view"]
  readonly index: () => number
  readonly serverKey: () => string
  readonly sessionID: () => string | undefined
  readonly target: () => PaneSession | undefined
  readonly pinned: () => boolean
}) {
  const shell = useShell()
  const i18n = useI18n()
  const data = useData()
  // The menu mounts in <body> while open: browser panels re-check what covers their native view on <body> changes.
  const [menuAt, setMenuAt] = createSignal<{ readonly left: number; readonly top: number }>()
  const session = () =>
    props.view === "chat"
      ? props.sessionID()
        ? { serverKey: props.serverKey(), sessionID: props.sessionID()! }
        : undefined
      : props.target()
  const running = () => {
    const current = session()
    return !!current && data.get(current.serverKey)?.data.session.status(current.sessionID) === "running"
  }
  const hasBrowser = () => !!browserOf(shell.paneState(), props.id)
  const items = (): { readonly label: string; readonly testid: string; readonly run: () => void }[] => [
    ...(props.view === "chat"
      ? [
          { label: i18n.t("own.pane.splitRight"), testid: "pane-split-right", run: () => split("row") },
          { label: i18n.t("own.pane.splitDown"), testid: "pane-split-down", run: () => split("column") },
        ]
      : []),
    ...(props.view === "chat" && shell.shownView("browser")
      ? [
          {
            label: i18n.t(hasBrowser() ? "own.pane.browserClose" : "own.pane.browserOpen"),
            testid: "pane-browser-toggle",
            run: () => {
              shell.focusPane(props.id)
              shell.toggleBrowserView()
            },
          },
        ]
      : []),
    ...(props.view === "browser" && props.target()
      ? [
          {
            label: i18n.t(props.pinned() ? "own.pane.unpin" : "own.pane.pin"),
            testid: "pane-pin",
            run: () => shell.panes.update((state) => pinBrowser(state, props.id, !props.pinned())),
          },
        ]
      : []),
    { label: i18n.t("own.pane.close"), testid: "pane-close-item", run: () => shell.closePane(props.id) },
  ]
  const split = (dir: PaneDir) => {
    shell.focusPane(props.id)
    shell.splitFocused(dir)
  }
  return (
    <div
      class="own-pane-bar"
      data-testid="pane-bar"
      draggable={true}
      title={i18n.t("own.pane.dragHint")}
      onDragStart={(event) => {
        event.dataTransfer?.setData(PANE_DRAG_TYPE, props.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
        setMovingPane(props.id)
      }}
      onDragEnd={() => setMovingPane(undefined)}
    >
      <span class="own-pane-index" aria-hidden="true">
        {props.index()}
      </span>
      <Show when={props.view === "browser"}>
        <span class="own-pane-kind">
          <Icon name="globe" class="own-pane-icon" />
        </span>
      </Show>
      <span
        class="own-pane-status"
        data-running={running() ? "" : undefined}
        role="img"
        aria-label={running() ? i18n.t("own.pane.running") : i18n.t("own.pane.idle")}
      >
        {running() ? "●" : "○"}
      </span>
      <span class="own-pane-title" data-testid="pane-title">
        <Show when={session()} fallback={i18n.t("own.pane.newSession")}>
          {(current) => <SessionTitle serverKey={() => current().serverKey} sessionID={() => current().sessionID} />}
        </Show>
      </span>
      <Show when={props.view === "browser" && props.pinned()}>
        <span class="own-pane-tag" title={i18n.t("own.pane.pinned")}>
          <Icon name="pin" class="own-pane-icon" />
        </span>
      </Show>
      <Show when={props.view === "chat"}>
        <button
          type="button"
          class="own-icon-button own-pane-button"
          aria-label={i18n.t("own.pane.splitRight")}
          title={i18n.t("own.pane.splitRight")}
          data-testid="pane-split"
          onClick={() => split("row")}
        >
          <Icon name="splitRight" />
        </button>
      </Show>
      <button
        type="button"
        class="own-icon-button own-pane-button"
        aria-label={i18n.t("own.pane.menu")}
        aria-haspopup="menu"
        data-testid="pane-menu-button"
        aria-expanded={!!menuAt()}
        onClick={(event) => {
          if (menuAt()) return setMenuAt(undefined)
          const anchor = event.currentTarget.getBoundingClientRect()
          setMenuAt({ left: Math.max(8, anchor.right - 200), top: anchor.bottom + 4 })
        }}
      >
        <Icon name="dots" data-dots="" />
      </button>
      <button
        type="button"
        class="own-icon-button own-pane-button"
        aria-label={i18n.t("own.pane.close")}
        title={i18n.t("own.pane.close")}
        data-testid="pane-close"
        onClick={() => shell.closePane(props.id)}
      >
        <Icon name="x" />
      </button>
      <Show when={menuAt()}>
        {(at) => (
          <Portal>
            <div
              ref={(element) =>
                queueMicrotask(() => {
                  if (!element.isConnected) return
                  element.showPopover()
                  element.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus()
                })
              }
              popover="auto"
              role="menu"
              class="own-pane-menu"
              aria-label={i18n.t("own.pane.menu")}
              data-testid="pane-menu"
              style={{ position: "fixed", inset: "auto", margin: 0, left: `${at().left}px`, top: `${at().top}px` }}
              onToggle={(event) => {
                if (event.newState === "closed") setMenuAt(undefined)
              }}
              onKeyDown={(event) => {
                const list = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
                const index = list.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.code === "ArrowDown"
                    ? (index + 1) % list.length
                    : event.code === "ArrowUp"
                      ? (index - 1 + list.length) % list.length
                      : -1
                if (next < 0) return
                event.preventDefault()
                list[next]?.focus()
              }}
            >
              <For each={items()}>
                {(item) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="own-pane-menu-item"
                    data-testid={item.testid}
                    onClick={() => {
                      setMenuAt(undefined)
                      item.run()
                    }}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  )
}

function sessionKey(session: PaneSession) {
  return `${session.serverKey}\u0000${session.sessionID}`
}

function parseSession(raw: string): PaneSession | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    return typeof record.serverKey === "string" && typeof record.sessionID === "string" && record.sessionID
      ? { serverKey: record.serverKey, sessionID: record.sessionID }
      : undefined
  } catch {
    return undefined
  }
}

function clampTo(limits: { readonly min: number; readonly max: number }, value: number) {
  return Math.max(limits.min, Math.min(limits.max, value))
}

function focusRegion(selector: string) {
  const region = document.querySelector<HTMLElement>(selector)
  const target =
    region?.querySelector<HTMLElement>("[aria-current='page'], [aria-selected='true'][role='tab'], [tabindex='0']") ??
    region?.querySelector<HTMLElement>("button, a[href], input, textarea, [tabindex]:not([tabindex='-1'])")
  target?.focus({ preventScroll: true })
}

// Shell state shared with modules: tier, panel and sidebar visibility, the panel tab per session (03 §4.2, §4.7).
// Modules open things through these actions (e.g. the sidebar's "사용 중 계정" opens the 계정·한도 tab).
// Split panes (03 §4.1.1, pane-layout.ts): the URL is the focused pane's route; a route change opens in the focused
// pane (or focuses the pane that shows that session), and focusing a pane replaces the URL. `나란히` shows the tree;
// `탭으로 보기`, and every width where the tree does not fit (phone, tablet, below the panes' minimum widths), shows
// the focused pane alone with the 채팅 | 브라우저 | 노트 tabs, without changing the saved mode.
import {
  createComputed,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  useContext,
  type ParentProps,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { LOCAL, useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { activeDirectory } from "@/projects/active"
import { isPage, routePath, routeServer, type Route } from "@/routing/routes"
import { markOnce } from "@/perf/marks"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { BESIDE_MIN, createTier, TABLET_BESIDE, TIER_LAYOUT, type Tier } from "./breakpoints"
import { createLayoutState, type LayoutStore, type PanelTab } from "./layout-state"
import {
  browserOf,
  chatShowing,
  closePane,
  createPaneLayout,
  ensureBrowser,
  findLeaf,
  focusedChat,
  focusPane,
  leavesOf,
  minHeight,
  minWidth,
  openBeside,
  openRoute,
  sessionOfRoute,
  splitPane,
  toggleBrowser,
  visibleTree,
  type PaneDir,
  type PaneMode,
  type PaneRoute,
  type PaneSession,
  type PaneState,
  type PaneView,
  type SplitRefusal,
} from "./pane-layout"
import { createWorkspaceLayout, rememberWorkspace, type NotesPlacement, type WorkspaceTab } from "./workspace-state"

export type { PanelTab } from "./layout-state"

export function createShell(input: { readonly windowKey: string }) {
  const router = useRouter()
  const host = useHost()
  const data = useData()
  const i18n = useI18n()
  const workspaceRoute = createMemo(rememberWorkspace(router.route))
  /** The server and project folder on screen; the folder is unknown until its runtime knows the session or project. */
  const workspacePlace = createMemo(
    () => {
      const route = workspaceRoute()
      const server = routeServer(route)
      const runtime = data.get(server)
      return { server, directory: runtime ? activeDirectory(runtime, route) : undefined }
    },
    undefined,
    { equals: (a, b) => a.server === b.server && a.directory === b.directory },
  )
  /** The key of a route whose folder is not known yet. */
  const routeKey = (route: Route) => JSON.stringify([routeServer(route), routePath(route)])
  const workspaceKey = createMemo(() => {
    const place = workspacePlace()
    return place.directory === undefined ? routeKey(workspaceRoute()) : JSON.stringify([place.server, place.directory])
  })
  const workspaceLayout = createWorkspaceLayout(workspaceKey, input.windowKey)
  // A layout change made before the folder on screen is known (Ctrl+B right after opening a conversation by its
  // address, 03 §4.1.1) went under the route's own key; when the same route's folder becomes known it moves to that
  // folder's layout instead of being lost. A computation, so it moves before anything renders the new key's layout.
  createComputed(
    on(workspaceKey, (key, previous) => {
      if (previous !== undefined && previous !== key && previous === routeKey(workspaceRoute()))
        workspaceLayout.adopt(previous)
    }),
  )
  const [browserMounted, setBrowserMounted] = createSignal(false)
  createEffect(() => {
    if (workspaceLayout.read().tab === "browser") setBrowserMounted(true)
  })
  const tier = createTier()
  const [workspaceWidth, setWorkspaceWidth] = createSignal(0)
  const narrowWorkspace = () =>
    tier() === "phone" || tier() === "tablet" || (workspaceWidth() > 0 && workspaceWidth() < 640)
  const notesPlacement = () => (narrowWorkspace() ? "main" : workspaceLayout.read().notesPlacement)

  const panes = createPaneLayout(input.windowKey)
  const [paneArea, setPaneArea] = createSignal({ width: 0, height: 0 })
  /** Browser panes need the host's pane (05 §8): a web or phone window shows sessions (and notes) only. */
  const shownView = (view: PaneView) => view !== "browser" || host.capabilities.browserPane
  const shownTree = createMemo(() => visibleTree(panes.state().tree, shownView) ?? panes.state().tree)
  /** Split UI at all: not on phone and tablet widths (03 §4.1.1, no split UI at 375 px). */
  const splitCapable = () => tier() !== "phone" && tier() !== "tablet"
  /** `나란히` on screen: the saved mode, a wide enough tier, and the pane area fits every pane's minimum. */
  const splitView = createMemo(() => {
    if (panes.mode() !== "split" || !splitCapable()) return false
    const area = paneArea()
    const tree = shownTree()
    return (area.width === 0 || minWidth(tree) <= area.width) && (area.height === 0 || minHeight(tree) <= area.height)
  })
  const workspaceTab = () => {
    const current = workspaceLayout.read()
    if (current.tab === "browser" && (!host.capabilities.browserPane || splitView())) return "chat"
    if (current.tab === "notes" && (notesPlacement() !== "main" || !current.notesOpen)) return "chat"
    return current.tab
  }

  // URL → panes: the focused pane shows the route, or the pane that already shows that session gets the focus.
  createEffect(on(workspaceRoute, (route) => panes.update((state) => openRoute(state, paneRoute(route)))))

  /** The focused pane's route becomes the URL (replaced, so focus changes do not fill the history). */
  function followFocus() {
    const route = focusedChat(panes.state())?.route
    if (route) router.navigate(route, { replace: !isPage(router.route()) })
  }
  function focusPaneByID(id: string) {
    panes.update((state) => focusPane(state, id))
    followFocus()
  }
  /** Applies a split result; refused splits say why (4 panes at most, 2 levels). */
  function commit(result: { readonly state: PaneState; readonly refused?: SplitRefusal }) {
    if (result.refused === "limit" || result.refused === "depth")
      return void showToast({ message: i18n.t(`own.pane.${result.refused}`), tone: "danger" })
    if (result.refused) return
    panes.update(() => result.state)
    followFocus()
    if (panes.mode() !== "split") panes.setWindowMode("split")
  }
  /** The route a new pane beside the focused one starts on: the new-session screen of the same project. */
  function besideRoute(): PaneRoute {
    const route = focusedChat(panes.state())?.route
    if (!route || route.name !== "session") return route ?? { name: "home" }
    const projectID = data.get(route.serverKey)?.data.session.get(route.sessionID)?.projectID
    if (projectID) return { name: "project", serverKey: route.serverKey, projectID }
    return route.serverKey === LOCAL ? { name: "home" } : { name: "home", serverKey: route.serverKey }
  }
  /**
   * Shows a session's browser (the agent started using it, main focused one of its tabs): its pane beside the pane
   * that shows the session in `나란히`, else the 브라우저 tab of the focused pane.
   */
  function revealBrowser(target?: PaneSession) {
    const state = panes.state()
    const chat = target ? chatShowing(state, target) : focusedChat(state)
    if (!chat) return
    if (panes.mode() === "split" && splitCapable()) {
      const result = ensureBrowser(state, chat.id)
      if (result.refused) return
      // Beside its pane; where the panes do not fit (tabs fallback) the 브라우저 tab badge says so and the tab stays.
      panes.update(() => result.state)
      setBrowserMounted(true)
      return
    }
    if (chat.id === focusedChat(state)?.id) selectWorkspaceTab("browser")
  }
  const layout = createLayoutState(input.windowKey)
  const [overlay, setOverlay] = createSignal<{ sidebar: boolean; panel: boolean }>({ sidebar: false, panel: false })
  const [opened, setOpened] = createSignal<ReadonlySet<PanelTab>>(new Set())
  /** Bottom terminal dock (4.7.3): mounted on first show and then kept (scrollback), `visible` toggles. Per window. */
  const [dock, setDock] = createSignal({ mounted: false, visible: false })
  /**
   * A paired device shows the session's browser pane on the PC (05 §8.10, browser/remote): beside the conversation
   * from 840 px, else as a layer over it. Below the desk tier (where the work panel does not push) the browser takes
   * the conversation list's column, and the list is the drawer its button opens while the browser stays open.
   */
  const [browserView, setBrowserView] = createSignal(false)

  /** A phone, or the tablet tier on a touch screen (an unfolded foldable, breakpoints.ts `TABLET_BESIDE`). */
  const handheld = () => tier() === "phone" || (tier() === "tablet" && host.capabilities.touch)
  const beside = createMediaQuery(`(min-width: ${BESIDE_MIN}px)`)
  const mode = () => {
    const base = tier() === "tablet" && handheld() && beside() ? TABLET_BESIDE : TIER_LAYOUT[tier()]
    return browserView() && base.sidebarMode === "column" && base.panelMode !== "push" && !onPage()
      ? { ...base, sidebarMode: "drawer" as const }
      : base
  }
  const teamConversation = createMemo(() => {
    const route = workspaceRoute()
    if (route.name !== "session") return false
    const place = data.get(route.serverKey)?.team.placeOf(route.sessionID)
    return place !== undefined && !(place.role === "main" && place.previous)
  })
  const sessionKey = createMemo(() => {
    const route = workspaceRoute()
    return route.name === "session" ? `${route.serverKey}/${route.sessionID}` : "home"
  })
  /**
   * Pages (settings, accounts, limits, import) hide the work panel (03 §5.7): it would show another screen's tabs and
   * squeeze the page. Its stored state is kept and shows again back on the conversation.
   */
  const onPage = () => isPage(router.route())
  const panelOpen = () =>
    !onPage() &&
    (mode().panelMode === "push"
      ? (workspaceLayout.read().panelOpen ?? layout.state.panelOpen ?? mode().panelOpenByDefault)
      : overlay().panel)
  const sidebarOpen = () => {
    const sidebarMode = mode().sidebarMode
    if (sidebarMode === "drawer") return overlay().sidebar
    if (sidebarMode === "column") return !(workspaceLayout.read().sidebarCollapsed ?? layout.state.sidebarCollapsed)
    return true
  }

  /**
   * 4.7: browser only with `browserPane`; terminal leaves the tabs when placed under the conversation. 팀 룸 (06 §9.9,
   * 2026-11-27) only on a conversation of a team: its main, an area's owner or a peer (not a replaced main).
   */
  const tabs = createMemo<PanelTab[]>(() =>
    (["review", "files", "terminal", "browser", "accounts", "team"] as const).filter((tab) => {
      if (tab === "browser") return false
      if (tab === "terminal") return layout.state.terminalPlacement === "tab"
      if (tab === "team") return teamConversation()
      return true
    }),
  )
  const tab = createMemo<PanelTab>(() => {
    const remembered = layout.state.panelTab[sessionKey()]
    return remembered && tabs().includes(remembered) ? remembered : "accounts"
  })

  function setPanel(open: boolean) {
    if (mode().panelMode === "push") workspaceLayout.update({ panelOpen: open })
    else setOverlay((current) => ({ ...current, panel: open }))
  }
  /** Opening the panel from a page (Ctrl+P, the palette, a terminal opener) goes back to the conversation first. */
  function showPanel() {
    if (onPage()) returnToWorkspace()
    setPanel(true)
  }

  function mount(next: PanelTab) {
    if (opened().has(next)) return
    setOpened((current) => new Set([...current, next]))
    markOnce(`own:panel-open:${next}`)
  }

  function showTab(next: PanelTab) {
    if (!tabs().includes(next)) return
    layout.setPanelTab(sessionKey(), next)
    mount(next)
  }

  function showDock() {
    selectWorkspaceTab("chat")
    if (!dock().mounted) markOnce("own:panel-open:terminal")
    setDock({ mounted: true, visible: true })
  }
  const hideDock = () => void setDock((current) => ({ ...current, visible: false }))
  const returnToWorkspace = () => router.navigate(workspaceRoute())
  /**
   * 설정, 한도 and 계정 (sidebar, header): open the page, or, when that page is already on screen, close it back to the
   * conversation as it was (the user's 2026-10-18 report; `대화로 돌아가기` stays for every page).
   */
  function togglePage(page: Route) {
    if (router.route().name === page.name || (page.name === "accounts" && router.route().name === "accountsAdd"))
      return returnToWorkspace()
    router.navigate(page)
  }
  /** Ctrl+Shift+B and the 브라우저 button: the focused pane's browser pane on or off (`나란히`), else the tab. */
  function toggleBrowserView() {
    if (!(panes.mode() === "split" && splitCapable()))
      return selectWorkspaceTab(workspaceLayout.read().tab === "browser" ? "chat" : "browser")
    const chat = focusedChat(panes.state())
    if (!chat) return
    returnToWorkspace()
    const result = toggleBrowser(panes.state(), chat.id)
    if (result.refused === "limit" || result.refused === "depth")
      return void showToast({ message: i18n.t(`own.pane.${result.refused}`), tone: "danger" })
    panes.update(() => result.state)
    const open = !!browserOf(result.state, chat.id)
    if (open) setBrowserMounted(true)
    // Where the panes no longer fit (tabs fallback) the browser shows as the 브라우저 tab.
    workspaceLayout.update({ tab: open && !splitView() ? "browser" : "chat" })
  }
  function selectWorkspaceTab(tab: WorkspaceTab) {
    returnToWorkspace()
    if (tab === "browser") setBrowserMounted(true)
    workspaceLayout.update({ tab, ...(tab === "notes" ? { notesOpen: true } : {}) })
  }
  function placeNotes(notesPlacement: NotesPlacement) {
    workspaceLayout.update({ notesPlacement, notesOpen: true, tab: notesPlacement === "main" ? "notes" : "chat" })
  }

  return {
    tier,
    handheld,
    mode,
    layout: layout as LayoutStore,
    workspaceRoute,
    workspacePlace,
    workspaceKey,
    workspaceLayout,
    workspaceWidth,
    setWorkspaceWidth,
    narrowWorkspace,
    notesPlacement,
    workspaceTab,
    browserMounted,
    browserView,
    setBrowserView,
    returnToWorkspace,
    togglePage,
    selectWorkspaceTab,
    placeNotes,
    openNotes() {
      returnToWorkspace()
      workspaceLayout.update({
        notesOpen: true,
        ...(workspaceLayout.read().notesPlacement === "main" ? { tab: "notes" } : {}),
      })
    },
    closeNotes() {
      workspaceLayout.update({ notesOpen: false, ...(workspaceLayout.read().tab === "notes" ? { tab: "chat" } : {}) })
    },
    panes,
    paneState: panes.state,
    /** `나란히` is on screen (else the focused pane alone with tabs). */
    splitView,
    splitCapable,
    shownView,
    shownTree,
    paneArea,
    setPaneArea,
    focusPane: focusPaneByID,
    /** `오른쪽에 분할` / `아래로 분할`: a new chat pane beside the focused one, on the project's new-session screen. */
    splitFocused(dir: PaneDir) {
      if (!splitCapable()) return
      returnToWorkspace()
      const target = focusedChat(panes.state())
      if (!target) return
      const result = splitPane(panes.state(), target.id, dir, { view: "chat", route: besideRoute() })
      commit(result.id ? { state: { ...result.state, focused: result.id } } : result)
    },
    /** `분할해서 열기`: the route in a new pane beside `target` (default the focused pane). */
    openBeside(
      route: PaneRoute,
      options?: { readonly dir?: PaneDir; readonly before?: boolean; readonly target?: string },
    ) {
      if (!splitCapable()) return router.navigate(route)
      returnToWorkspace()
      commit(openBeside(panes.state(), route, options))
    },
    closePane(id: string) {
      const before = panes.state()
      panes.update((state) => closePane(state, id))
      if (panes.state() !== before) followFocus()
    },
    toggleBrowserView,
    revealBrowser,
    /** Sessions the chat panes show (each keeps its browser attachment, 05 §8.2). */
    paneSessions: createMemo(
      () =>
        leavesOf(panes.state().tree).flatMap((leaf) => {
          const session = leaf.view === "chat" ? sessionOfRoute(leaf.route) : undefined
          return session ? [session] : []
        }),
      [],
      { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    ),
    paneLeaf: (id: string) => findLeaf(panes.state(), id),
    setPaneMode(mode: PaneMode, scope: "window" | "device" = "window") {
      if (scope === "device") panes.setDeviceMode(mode)
      else panes.setWindowMode(mode)
      // Tabs start on 채팅 (the browser stays one click away under 브라우저).
      if (mode === "tabs" && workspaceLayout.read().tab === "browser") workspaceLayout.update({ tab: "chat" })
    },
    tabs,
    tab,
    /** Tabs whose content was mounted once; they stay mounted while hidden (4.7 "숨겨도 unmount하지 않는다"). */
    opened,
    panelOpen,
    sidebarOpen,
    sessionKey,
    togglePanel: () => (onPage() ? showPanel() : setPanel(!panelOpen())),
    closePanel: () => {
      if (!onPage()) setPanel(false)
    },
    /** Opens the panel on a tab; pressing the shortcut of the visible tab closes the panel (upstream toggle). */
    openTab(next: PanelTab, toggle = false) {
      if (next === "browser") return toggle ? toggleBrowserView() : revealBrowser()
      if (toggle && panelOpen() && tab() === next) return setPanel(false)
      showTab(next)
      showPanel()
    },
    selectTab: showTab,
    toggleSidebar() {
      const sidebarMode = mode().sidebarMode
      if (sidebarMode === "drawer") setOverlay((current) => ({ ...current, sidebar: !current.sidebar }))
      if (sidebarMode === "column") workspaceLayout.update({ sidebarCollapsed: sidebarOpen() })
    },
    closeOverlays: () => setOverlay({ sidebar: false, panel: false }),
    /** Mounts the visible tab's content the first time the panel shows it (lazy chunk, 20.2 R5). */
    ensureOpened: mount,
    terminalDock: dock,
    showTerminalDock: showDock,
    hideTerminalDock: hideDock,
    toggleTerminalDock: () =>
      dock().visible && workspaceTab() === "chat" && !isPage(router.route()) ? hideDock() : showDock(),
    /** The terminal where Settings > Layout placed it: the 터미널 tab or the bottom dock (4.7.3). */
    openTerminal() {
      if (layout.state.terminalPlacement === "bottom") return showDock()
      showTab("terminal")
      showPanel()
    },
  }
}

/** The pane route of a workspace route (pages never reach the panes, rememberWorkspace). */
function paneRoute(route: Route): PaneRoute {
  if (route.name === "session") return { name: "session", serverKey: route.serverKey, sessionID: route.sessionID }
  if (route.name === "project") return { name: "project", serverKey: route.serverKey, projectID: route.projectID }
  return route.name === "home" && route.serverKey ? { name: "home", serverKey: route.serverKey } : { name: "home" }
}

export type Shell = ReturnType<typeof createShell>
export type { Tier }

const ShellContext = createContext<Shell>()

export function ShellProvider(props: ParentProps<{ value: Shell }>) {
  return <ShellContext.Provider value={props.value}>{props.children}</ShellContext.Provider>
}

export function useShell() {
  const value = useContext(ShellContext)
  if (!value) throw new Error("useShell() needs <ShellProvider>")
  return value
}

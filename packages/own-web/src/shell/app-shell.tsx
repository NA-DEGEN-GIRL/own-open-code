// AppShell (03 §4.1–4.2, 15.3): sidebar | main (header, the workspace's split panes) | work panel. Each pane's session
// view (pane.tsx) is mounted once per pane and only hidden under pages, so the composer, drafts and IME state survive
// route, tier and mode changes. The header and the work panel follow the focused pane (the URL, 03 §4.1.1).
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { createEffect, lazy, Match, on, onCleanup, onMount, Show, Suspense, Switch } from "solid-js"
import { BackgroundHost } from "@/background"
import { BrowseLayer } from "@/browse"
import { ComputerLayer } from "@/computer"
import { CompactionsLayer } from "@/compactions"
import { ForkHost } from "@/forking"
import { prepareExplorer } from "@/explorer"
import { useHost, windowKey } from "@/host"
import { GitInitHost } from "@/discover/git-init"
import { useI18n } from "@/i18n"
import { IdeasLayer } from "@/ideas"
import { ImportLayer, ImportPage } from "@/import"
import { ManualLayer } from "@/manual"
import { McpLayer } from "@/mcp"
import { NotesLayer } from "@/notes"
import { PaletteLayer } from "@/palette"
import { ProjectOpenerLayer } from "@/projects"
import { RequestNotifications } from "@/requests"
import { RevertHost } from "@/revert"
import { reviewMinWidth } from "@/review"
import { useRouter } from "@/routing/router"
import { isPage, routeServer } from "@/routing/routes"
import { RemotePcLayer } from "@/remote-pcs"
import { RemoteLayer } from "@/servers"
import { closeSide, sideTarget } from "@/side"
import { SessionDeleteHost, Sidebar } from "@/sidebar"
import { Toasts } from "@/switcher"
import { WorktreeHost } from "@/worktree"
import { ConnectionBanner, UnmanagedScreen } from "./banners"
import { useShell } from "./context"
import { SessionHeader } from "./header"
import { ShellIntents } from "./intents"
import { TurnNotifications } from "./notifications"
import { PaletteFeatureCommands } from "./palette-commands"
import { ShellShortcuts } from "./shortcuts"
import { TitlebarBand } from "./titlebar"
import { WorkPanel } from "./work-panel"
import { Workspace } from "./workspace"

const AccountsPage = lazy(() => import("@/accounts"))
const LimitsPage = lazy(() => import("@/limits"))
const SettingsPage = lazy(() => import("@/settings"))
// Browser attachments stay registered whether or not the 브라우저 tab was opened (05 §8.2); desktop only, own chunk.
const BrowserAttach = lazy(() => import("@/browser/attach"))
// 03 §4.4.2 곁질문: the side panel, fetched on the first `/btw` or `곁질문…`.
const SidePanel = lazy(() => import("@/side/panel"))
// 4.7.3 `터미널 위치: 대화 아래`: its own chunk, mounted on first show and kept (scrollback) while hidden.
const TerminalDock = lazy(() => import("@/terminal/dock"))
// 05 §7.9: only hosts that zoom their windows (desktop) load the zoom keys and indicator; the web's first chunk has none (PF5).
const ZoomLayer = lazy(() => import("./zoom").then((module) => ({ default: module.ZoomLayer })))
/** Default minimum width of the pushed work panel (drag). */
const PANEL_MIN = 320

export function AppShell() {
  const shell = useShell()
  const router = useRouter()
  const host = useHost()
  const i18n = useI18n()
  const route = router.route
  const serverKey = () => {
    const current = shell.workspaceRoute()
    return routeServer(current)
  }
  const sessionID = () => {
    const current = shell.workspaceRoute()
    return current.name === "session" ? current.sessionID : undefined
  }
  const page = () => isPage(route())
  const settingsRoute = () => {
    const current = route()
    return current.name === "settings" ? current : undefined
  }
  const importRoute = () => {
    const current = route()
    return current.name === "import" ? current : undefined
  }
  const mode = shell.mode
  const sidebarWidth = () => {
    if (mode().sidebarMode !== "column") return `${mode().sidebar}px`
    if (!shell.sidebarOpen()) return "0px"
    return `${shell.workspaceLayout.read().sidebarWidth ?? shell.layout.state.sidebarWidth ?? mode().sidebar}px`
  }
  /** 4.7: choosing the review tab's split view raises the pushed panel's minimum width to 560 px. */
  const panelMin = () =>
    mode().panelMode === "push" && shell.tab() === "review" ? (reviewMinWidth() ?? PANEL_MIN) : PANEL_MIN
  const panelSize = () => {
    const width =
      shell.workspaceLayout.read().panelWidth ?? shell.layout.state.panelWidth ?? mode().panel
    return mode().panelMode === "push" ? Math.max(width, panelMin()) : width
  }
  const panelWidth = () => `${panelSize()}px`
  const terminalBottom = () => shell.layout.state.terminalPlacement === "bottom"
  const overlayOpen = () =>
    (mode().sidebarMode === "drawer" && shell.sidebarOpen()) || (mode().panelMode !== "push" && shell.panelOpen())
  // 4.2: `/` is the phone's conversation list; a server's new-conversation screen (`/srv/<key>/new`) is a screen.
  const phoneView = () => {
    const current = route()
    return current.name === "home" && !current.serverKey ? "list" : "session"
  }

  // Narrow tiers: navigating closes the drawers and sheets (4.2).
  createEffect(on(route, () => shell.closeOverlays(), { defer: true }))

  // Touch screens (./touch.ts): open menus follow their button through a fold, an unfold or the keyboard, and the
  // swipe gestures. Lazy and touch only: a mouse that drags the window's edge closes a menu first (light dismiss), a
  // mouse never swipes, and the first chunk's budget (PF5) is nearly spent.
  onMount(async () => {
    if (!host.capabilities.touch) return
    let stop: (() => void) | undefined
    onCleanup(() => stop?.())
    const { touchShell } = await import("./touch")
    stop = touchShell()
  })
  // 03 §19.5 `탐색기에서 열기`: its entries and strings are a lazy chunk, asked for only in the desktop app.
  onMount(() => prepareExplorer(host, router))
  onMount(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.code !== "Escape" || event.isComposing || event.keyCode === 229 || !overlayOpen()) return
      shell.closeOverlays()
    }
    window.addEventListener("keydown", escape)
    onCleanup(() => window.removeEventListener("keydown", escape))
  })

  return (
    <div
      class="own-app"
      data-testid="app"
      data-tier={shell.tier()}
      data-sidebar-mode={mode().sidebarMode}
      data-panel-mode={mode().panelMode}
      data-sidebar={shell.sidebarOpen() ? "open" : "closed"}
      data-panel={shell.panelOpen() ? "open" : "closed"}
      data-phone-view={phoneView()}
      data-wco={host.capabilities.windowControlsOverlay ? "" : undefined}
      data-touch={host.capabilities.touch ? "" : undefined}
      data-handheld={shell.handheld() ? "" : undefined}
      style={{ "--own-sidebar-w": sidebarWidth(), "--own-panel-w": panelWidth() }}
    >
      <a class="own-skip" href="#own-main">
        {i18n.t("own.shell.skipToMain")}
      </a>
      <ShellShortcuts />
      <ShellIntents />
      {/* Mounted once: OS notifications for requests and turn ends (03 §9), the restore dialog host (18.7), the folder
          flow with Ctrl+O (18.3) and the MCP list with Ctrl+; (18.14). P7: the fork dialog (19.12), background job
          toasts and the output viewer (19.7), the worktree dialogs (19.3), the conversation memo (19.10), the command palette
          with Ctrl+K (19.15) and the palette commands of the feature modules; the session and project delete
          dialogs (19.11a). Each loads its UI chunk on first use. */}
      <RequestNotifications />
      <TurnNotifications />
      <RevertHost />
      <ForkHost />
      <BackgroundHost />
      <WorktreeHost />
      {/* 03 §4.3.1, 06 §3.0: Git 저장소로 만들기 (lazy dialog). */}
      <GitInitHost />
      <SessionDeleteHost />
      <NotesLayer />
      {/* 03 §4.5: 압축 내용 보기, every compaction of a conversation (lazy dialog). */}
      <CompactionsLayer />
      {/* 03 §4.4.1: 아이디어 노트, the quick capture (Ctrl+Alt+I) and the board (lazy). */}
      <IdeasLayer />
      {/* 03 §4.4.2: 곁질문, the side panel of `/btw`, the palette and the composer `⋯` (lazy). */}
      <Show when={sideTarget()} keyed>
        {(target) => (
          <Suspense>
            <SidePanel detail={target} onClose={closeSide} />
          </Suspense>
        )}
      </Show>
      <ProjectOpenerLayer />
      <McpLayer />
      <PaletteLayer />
      <PaletteFeatureCommands />
      {/* 03 §4.3.1: the in-app user manual (lazy viewer). */}
      <ManualLayer />
      {/* 다른 도구의 대화 (09 §6): the open requests of the sidebar row, the project menu and the palette. */}
      <ImportLayer />
      {/* SSH hosts (04 §12, §17): RemoteStore, prompts and the host dialogs (lazy). */}
      <RemoteLayer />
      {/* Computer use (01 §10.2): the ComputerStore (`own.computer`) and the per-session dialog (lazy). */}
      <ComputerLayer />
      <BrowseLayer />
      {/* 원격 PC (08 §4.1): the list store and its dialogs (lazy), desktop hosts with capabilities.remotePcs. */}
      <RemotePcLayer />
      <TitlebarBand />
      <Show when={host.capabilities.browserPane}>
        <Suspense>
          <BrowserAttach />
        </Suspense>
      </Show>
      <aside
        class="own-sidebar"
        data-testid="sidebar"
        inert={!shell.sidebarOpen() || (mode().sidebarMode === "list" && phoneView() === "session")}
      >
        <Sidebar />
        <Show when={mode().sidebarMode === "column" && shell.sidebarOpen()}>
          <ResizeHandle
            direction="horizontal"
            edge="end"
            size={
              shell.workspaceLayout.read().sidebarWidth ??
              shell.layout.state.sidebarWidth ??
              mode().sidebar
            }
            min={220}
            max={400}
            onResize={(width) => shell.workspaceLayout.update({ sidebarWidth: Math.round(width) })}
          />
        </Show>
      </aside>
      <main
        class="own-main"
        id="own-main"
        data-testid="main"
        inert={(mode().sidebarMode === "list" && phoneView() === "list") || undefined}
      >
        <ConnectionBanner />
        <UnmanagedScreen />
        <SessionHeader />
        <Workspace serverKey={serverKey} sessionID={sessionID} visible={() => !page()}>
          {/* 4.7.3 `대화 아래`: one dock per window under the panes, for the focused pane's session. */}
          <Show when={terminalBottom() && shell.terminalDock().mounted}>
            <Suspense>
              <TerminalDock
                serverKey={serverKey}
                sessionID={sessionID}
                visible={() => shell.terminalDock().visible && !page() && shell.workspaceTab() === "chat"}
                onCollapse={() => shell.hideTerminalDock()}
                reveal={() => shell.showTerminalDock()}
                windowKey={windowKey(host)}
              />
            </Suspense>
          </Show>
        </Workspace>
        <Show when={page()}>
          <section class="own-page" data-testid="page-view">
            <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
              <Switch>
                <Match when={route().name === "accounts"}>
                  <AccountsPage mode="list" />
                </Match>
                <Match when={route().name === "accountsAdd"}>
                  <AccountsPage mode="add" kind={(() => {
                    const current = route()
                    return current.name === "accountsAdd" ? current.kind : undefined
                  })()} />
                </Match>
                <Match when={route().name === "limits"}>
                  <LimitsPage />
                </Match>
                <Match when={settingsRoute()}>{(settings) => <SettingsPage section={settings().section} />}</Match>
                {/* 09 §3, §6: the list and the read-only viewer, each a lazy chunk. */}
                <Match when={importRoute()}>
                  {(target) => (
                    <ImportPage
                      serverKey={target().serverKey}
                      projectID={target().projectID}
                      sourceRef={target().ref}
                    />
                  )}
                </Match>
              </Switch>
            </Suspense>
          </section>
        </Show>
        {/* Outside the session view, which pages hide: a toast fired on a page shows too. */}
        <Toasts />
      </main>
      <aside class="own-panel" aria-label={i18n.t("own.panel.label")} data-testid="panel" inert={!shell.panelOpen()}>
        <Show when={mode().panelMode === "push" && shell.panelOpen()}>
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={panelSize()}
            min={panelMin()}
            max={Math.round(window.innerWidth / 2)}
            onResize={(width) => shell.workspaceLayout.update({ panelWidth: Math.round(width) })}
          />
        </Show>
        <WorkPanel />
      </aside>
      {/* 4.2.1, 05 §7.9: the zoom keys and the title bar's zoom indicator (desktop). After the header and the panel:
          the drag area follows document order. */}
      <Show when={host.window?.zoom}>
        <Suspense>
          <ZoomLayer />
        </Suspense>
      </Show>
      <Show when={overlayOpen()}>
        <div class="own-scrim" data-testid="scrim" onClick={() => shell.closeOverlays()} />
      </Show>
    </div>
  )
}

// Sidebar module (03 §4.3, owner: sidebar). Three zones (2026-11-26, the user's report that `원격 호스트 추가` … `설정`
// moved with the folded sections):
//   - fixed at the top: search, `+ 새 세션`;
//   - one scroll area with every server section at its natural height (sections.tsx): `폴더 열기…`, then the server's
//     tree (`고정됨` → project → date group → two-line session rows → subagent rows; or the `보관함` view, 19.11, with
//     its `선택` / `보관함 비우기…` bar, 19.11a) and the `보관함 · n` entry while sessions are archived;
//   - fixed at the bottom: `원격 호스트` / `다른 PC` 추가, "사용 중 계정", footer (`설정` with its name, limits, accounts,
//     archive, server status).
// Order and pins (arrange.ts, project-list.ts, servers/order.ts): dragging, moving by menu or keys and pinning are the
// lazy reorder.ts, loaded once the window is idle.
//
// Contracts:
// - Kept for the shell: `<Sidebar />` fills `.own-sidebar`; rows navigate with the router; the shell closes the
//   drawer on route changes. Test ids kept: `session-list`, `sidebar-cached`, `server-status` (+ `data-status`).
// - For the new-session screen (composer owner): project `+` and `폴더 열기…` (the projects module's opener, 18.3)
//   set `newSessionTarget()` and navigate to `/srv/:serverKey/p/:projectID`; use
//   `targetFor(serverKey, projectID)?.directory` as the new session's `location.directory` (else the project's
//   canonical directory from the session index).
// - For the settings page: `setSidebarDensity("compact" | "comfortable")` (설정 > 일반 > 세션 목록 밀도).
// - Shortcuts owned here: `session.previous/next` (Alt+↑/↓ in the list's visual order) and
//   `session.new` (Alt+N, phone-aware). Registered after the shell's, so these win while the sidebar is mounted.
//
// Data: the SWR session index (IndexedDB snapshot first, server list on every connect; 20.1 PF1), createData for
// running state, permissions/forms and subagents, OwnStore for chips (`session.binding` of the rows on screen,
// batched), `accounts.list` and quota. Nothing polls; the only timer is the shared minute clock (R9).
//
// 다른 도구의 대화 (09 §6 entry 1): an open project ends with `다른 도구의 대화 · 새 N개 ›` (rows.tsx ImportEntryRow).
//
// Team mode (06 §9.2, §9.4): a project with a team on lists its team (controller.ts, rows.tsx). The sidebar answers
// the team screens' requests of this window (team/intents.ts): `openTeamView` reveals the project's team view in its
// server's tree, `openAreaMenu` opens the area menu (team/area-menu.tsx, lazy), `openEnableDialog` the 팀 모드
// 켜기… dialog (team/enable-dialog.tsx, lazy, 2026-10-16) and `openCreateArea` the 영역 만들기 dialog
// (team/create-area.tsx, lazy, 2026-10-26). The area switcher (`모델 바꾸기…`) registers with the
// switcher popover's chunk (switcher/team-flow.ts); the area menu loads that chunk before asking.
import { createEffect, createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { LOCAL, useData, type ServerKey, type ServerRuntime } from "@/data"
import { useDiscoverText } from "@/discover/strings"
import { nextFrame } from "@/data/frame"
import { useHost, windowKey } from "@/host"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP, useShortcut } from "@/keyboard"
import { ServerStatusPopover } from "@/mcp/layer"
import { defaultFolder } from "@/projects/default-folder"
import { useRouter } from "@/routing/router"
import { routePath, routeServer } from "@/routing/routes"
import { openRemotePcDialog, remotePcStore, useRemotePcText } from "@/remote-pcs"
import { NEW_CHAT, newChatHost, openRemoteDialog, remoteStore } from "@/servers/active"
import { serverCollapsed, serverOrder } from "@/servers/order"
import { useServersText } from "@/servers/strings"
import { minuteNow } from "@/shell/clock"
import { relativeTime } from "@/shell/format"
import { useShell } from "@/shell/context"
import { Icon } from "@/shell/icons"
import { showToast } from "@/switcher/toast"
import type { EnableRequest } from "@/team/enable"
import { teamIntents, type AreaTarget, type CreateAreaTarget, type TeamViewTarget } from "@/team/intents"
import { AccountsInUse } from "./accounts-in-use"
import { SidebarContext, useSidebar } from "./context"
import { createSidebarController, type SidebarController } from "./controller"
import { sessionFlags } from "./flags"
import { foldKey, isFocusable, levelOf, parseKey, PINNED_GROUP, rowKey, toBucket } from "./model"
import { setSidebarArchiveView, sidebarArchiveView } from "./local-state"
import { openSessionDelete } from "./manage-host"
import { RowMenu } from "./row-menu"
import {
  ArchiveIcon,
  AreaRow,
  ChildRow,
  DateRow,
  ImportEntryRow,
  MoreRow,
  PinnedGroupRow,
  ProjectRow,
  SessionRow,
  SkeletonRows,
  TeamCreateRow,
  TeamNoticeRow,
  TeamNoticesRow,
  TeamOthersRow,
  TeamOutsideRow,
  TeamRequestRow,
  TeamRequestsRow,
  WorktreeRow,
} from "./rows"
import { createScroller, ScrollerContext, useScroller } from "./scroller"
import { SearchBox } from "./search"
import { ServerSections } from "./sections"
import { useSidebarText, type SidebarText } from "./strings"
import { setNewSessionTarget } from "./target"
import { WindowedTree, type TreeApi } from "./tree"

export { newSessionTarget, setNewSessionTarget, targetFor, type NewSessionTarget } from "./target"
export {
  setSidebarArchiveView,
  setSidebarDensity,
  sidebarArchiveView,
  sidebarDensity,
  type Density,
} from "./local-state"
export { FLAG_KEYS, flagsOf, sessionFlags, withFlag, withoutFlags, type OwnFlags } from "./flags"
export { useSessionFlagActions } from "./flag-actions"
export { openProjectManage, openSessionDelete, SessionDeleteHost, type DeleteRequest } from "./manage-host"

const AreaMenu = lazy(() => import("@/team/area-menu"))
const EnableDialog = lazy(() => import("@/team/enable-dialog"))
const CreateAreaDialog = lazy(() => import("@/team/create-area"))

/** Every server tree of this window, for `openTeamView` and what walks all of them (the local one, each SSH host's). */
const trees = new Map<ServerKey, { readonly ctl: SidebarController; api?: TreeApi }>()

function registerTree(ctl: SidebarController) {
  const entry: { readonly ctl: SidebarController; api?: TreeApi } = { ctl }
  trees.set(ctl.serverKey, entry)
  onCleanup(() => {
    if (trees.get(ctl.serverKey) === entry) trees.delete(ctl.serverKey)
  })
  return entry
}

export interface SidebarProps {}

export function Sidebar(_props: SidebarProps) {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const shell = useShell()
  const i18n = useI18n()
  const text = useSidebarText()
  const runtime = data.local()
  const ctl = createSidebarController({
    serverKey: runtime.key,
    runtime,
    router,
    windowKey: windowKey(host),
    touch: host.capabilities.touch,
  })
  registerTree(ctl)
  const servers = useServersText()
  const pcs = useRemotePcText()
  let search: { focus(): void } | undefined

  /** The trees on screen in the sections' order. */
  const shown = () =>
    serverOrder().flatMap((key) => {
      const entry = trees.get(key)
      return entry && (ctl.searching() || !serverCollapsed(key)) ? [entry] : []
    })

  // 06 §9.4: `팀 보기` and the area menu for every screen of this window (header pill, banners, project menu, rows).
  const [areaMenu, setAreaMenu] = createSignal<AreaTarget>()
  onCleanup(teamIntents.areaMenu.register((target) => setAreaMenu(target)))
  const [enabling, setEnabling] = createSignal<EnableRequest>()
  onCleanup(teamIntents.enableDialog.register((request) => setEnabling(request)))
  const [creating, setCreating] = createSignal<CreateAreaTarget>()
  onCleanup(teamIntents.createArea.register((target) => setCreating(target)))
  onCleanup(teamIntents.teamView.register((target) => showTeam(target)))

  /** The project's team view: the sidebar shows, the project unfolds (out of `보관함`), and its row takes focus. */
  function showTeam(target: TeamViewTarget) {
    const found = trees.get(target.serverKey)
    if (!found) return
    if (!shell.sidebarOpen()) shell.toggleSidebar()
    if (shell.mode().sidebarMode === "list" && routePath(router.route()) !== "/") router.navigate({ name: "home" })
    found.ctl.showProject(target.projectID)
    nextFrame(() => found.api?.focus(rowKey.project(target.projectID)))
  }

  // `폴더 열기…` and Ctrl+O go through the projects module (18.3): the shell mounts its `ProjectOpenerLayer`, which
  // owns the picker and the shortcut.
  useShortcut("session.new", () => newSession())

  const known = (key: ServerKey) => (remoteStore()?.state.hosts[key] ? key : LOCAL)
  /** The server on screen: the open conversation's or project's, or the new-conversation screen's. */
  const current = () => known(routeServer(shell.workspaceRoute()))

  /**
   * `+ 새 세션` / Alt+N, and the `+` of a server section: the new-session screen without a project (5.1: its
   * conversation works in the server's 기본 대화 폴더), with its own project picker. The server is the one on screen; on a
   * screen of no server (the phone's list, the home screen) the one a new conversation was last opened on. On the phone
   * tier `/` is the list screen (4.2), so there it opens this PC's screen by name (`/srv/local/new`), or on an older
   * service without a default folder the most recent project's.
   */
  function newSession(to?: ServerKey) {
    const on = shell.workspaceRoute()
    const target = to ?? (on.name === "home" ? (on.serverKey ?? newChatHost() ?? LOCAL) : current())
    const phone = shell.mode().sidebarMode === "list"
    if (known(target) !== LOCAL)
      return void import("@/servers/new-chat").then((module) =>
        module.openNewChat({ serverKey: target, navigate: (route) => router.navigate(route), phone, local: runtime }),
      )
    setNewSessionTarget(undefined)
    try {
      localStorage.removeItem(NEW_CHAT)
    } catch {}
    if (phone) {
      if (!defaultFolder(runtime).unsupported()) return router.navigate({ name: "home", serverKey: runtime.key })
      const recentProject = ctl.index.state.sessions[ctl.index.state.order[0] ?? ""]?.projectID
      if (recentProject) return ctl.newSessionIn(recentProject)
    }
    router.navigate({ name: "home" })
  }
  useShortcut("session.previous", () => step(-1))
  useShortcut("session.next", () => step(1))

  function step(delta: number) {
    const rows = shown().flatMap((entry) => entry.ctl.sessionKeys().map((key) => ({ ctl: entry.ctl, key })))
    if (!rows.length) return
    const index = rows.findIndex((row) => row.ctl.activeID() === parseKey(row.key).id)
    const next = rows[Math.min(rows.length - 1, Math.max(0, index < 0 && delta < 0 ? 0 : index + delta))]
    if (next) next.ctl.open(parseKey(next.key).id)
  }

  /** Enter in the search box: the first conversation found, whichever server has it. */
  function openFirst() {
    for (const entry of shown()) {
      const first = entry.ctl.keys().find((key) => key.startsWith("s|"))
      if (first) return entry.ctl.open(parseKey(first).id)
    }
  }

  const scroller = createScroller()
  let outer!: HTMLDivElement
  let inner!: HTMLDivElement
  let stop: (() => void) | undefined
  onMount(() => {
    scroller.mount(outer, inner)
    const load = async () => {
      const { mountReorder } = await import("./reorder")
      if (outer.isConnected)
        stop = mountReorder({ scroller: outer, locale: i18n.locale, controller: (key) => trees.get(key)?.ctl })
    }
    // Nothing needs it before the list is painted (PF1, PF5).
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => void load(), { timeout: 2_000 })
    else setTimeout(() => void load(), 500)
  })
  onCleanup(() => stop?.())

  const state = ctl.index.state
  const connection = runtime.connection
  const newSessionKeys = chordLabel(DEFAULT_KEYMAP["session.new"].chords[0])
  const settingsKeys = chordLabel(DEFAULT_KEYMAP["settings.open"].chords[0])
  const discover = useDiscoverText()
  const route = router.route
  const archived = () => serverOrder().reduce((sum, key) => sum + (sessionFlags(key)?.archivedIDs().length ?? 0), 0)
  const canAddHost = () => {
    const store = remoteStore()
    return store?.state.status === "ready" && store.allowed("hosts.add")
  }
  const addButton =
    "own-target flex h-8 min-w-0 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-left text-[12.5px] text-own-muted hover:bg-own-hover hover:text-own-text"

  return (
    <SidebarContext.Provider value={ctl}>
      <ScrollerContext.Provider value={scroller}>
        <nav aria-label={i18n.t("own.nav.label")} class="flex min-h-0 flex-1 flex-col" data-testid="sidebar-nav">
          <Show when={host.capabilities.windowControlsOverlay}>
            {/* 4.2.1: the sidebar column of the desktop title-bar band (drag area; buttons are not). */}
            <div
              class="flex flex-none items-center gap-0.5 border-b border-own-border px-2 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]"
              style={{ height: "var(--own-header-h)" }}
              data-testid="sidebar-band"
            >
              <button
                type="button"
                class="own-icon-button"
                aria-label={i18n.t("own.shell.sidebarToggle")}
                onClick={() => shell.toggleSidebar()}
              >
                <Icon name="sidebar" />
              </button>
              <button
                type="button"
                class="own-icon-button"
                aria-label={i18n.t("own.shell.back")}
                onClick={() => router.back()}
              >
                <Icon name="left" />
              </button>
              <button
                type="button"
                class="own-icon-button"
                aria-label={i18n.t("own.shell.forward")}
                onClick={() => router.forward()}
              >
                <Icon name="right" />
              </button>
              <span class="flex-1" />
              <button
                type="button"
                class="own-icon-button"
                aria-label={i18n.t("own.nav.search")}
                onClick={() => search?.focus()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4" />
                </svg>
              </button>
              <button
                type="button"
                class="own-icon-button"
                aria-label={i18n.t("own.nav.newSession")}
                onClick={() => newSession()}
              >
                <Icon name="plus" />
              </button>
            </div>
          </Show>
          <div class="flex flex-none flex-col gap-1.5 px-3 pt-3 pb-2">
            <SearchBox
              onEnterList={() => shown()[0]?.api?.focusFirst()}
              onSubmit={openFirst}
              ref={(api) => (search = api)}
            />
            <a
              href={routePath({ name: "home" })}
              class="own-target flex h-8 items-center gap-2 rounded-lg px-2 font-medium no-underline text-own-text hover:bg-own-hover"
              classList={{ "bg-own-hover": route().name === "home" }}
              title={text("own.sidebar.newSessionShortcut", { keys: newSessionKeys })}
              data-testid="sidebar-new-session"
              onClick={(event) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
                event.preventDefault()
                newSession()
              }}
            >
              <Icon name="plus" class="size-4 fill-none stroke-current stroke-[1.6]" />
              {i18n.t("own.nav.newSession")}
              <kbd class="ml-auto font-sans text-[11px] font-normal text-own-faint">{newSessionKeys}</kbd>
            </a>
          </div>
          <Show when={ctl.archiveView()}>
            <div
              class="mx-2 mb-1 flex flex-none items-center gap-1.5 rounded-lg bg-own-raised py-1 pr-2 pl-1 text-[12.5px]"
              data-testid="archive-header"
            >
              <button
                type="button"
                class="own-icon-button own-target size-7 [&_svg]:size-3.5"
                aria-label={text("own.sidebar.archiveBack")}
                title={text("own.sidebar.archiveBack")}
                data-testid="archive-back"
                onClick={() => setSidebarArchiveView(false)}
              >
                <Icon name="left" />
              </button>
              <ArchiveIcon class="size-3.5 flex-none text-own-muted" />
              <span class="min-w-0 truncate font-semibold" role="heading" aria-level={2}>
                {text("own.sidebar.archiveTitle", { n: archived() })}
              </span>
            </div>
          </Show>
          {/* Server sections (03 §4.3, 04 §17.2, 08 §4.1): natural heights in one scroll area. */}
          <div
            ref={outer}
            class="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
            data-testid="sidebar-scroll"
          >
            <div ref={inner} class="pb-2">
              <ServerSections
                current={current}
                onNew={newSession}
                list={(remote, top, last) =>
                  remote === runtime ? (
                    <ServerList top={top} last={last} testId="session-list" label={i18n.t("own.nav.label")} />
                  ) : (
                    <ServerSessionTree runtime={remote} top={top} last={last} />
                  )
                }
              />
            </div>
          </div>
          <Show when={areaMenu()} keyed>
            {(target) => (
              <Suspense>
                {/* A menu that closes after another one opened (light dismiss) leaves the new one open. */}
                <AreaMenu
                  target={target}
                  onClose={() => setAreaMenu((current) => (current === target ? undefined : current))}
                />
              </Suspense>
            )}
          </Show>
          <Show when={enabling()} keyed>
            {(request) => (
              <Suspense>
                <EnableDialog request={request} onClose={() => setEnabling(undefined)} />
              </Suspense>
            )}
          </Show>
          <Show when={creating()} keyed>
            {(request) => (
              <Suspense>
                <CreateAreaDialog request={request} onClose={() => setCreating(undefined)} />
              </Suspense>
            )}
          </Show>
          {/* The bottom zone never moves: what adds a server, the accounts in use, the footer. */}
          <Show when={canAddHost() || remotePcStore()}>
            <div
              class="own-side-add flex flex-none items-center border-t border-own-border px-1.5 py-1"
              data-testid="sidebar-add"
            >
              <Show when={canAddHost()}>
                <button
                  type="button"
                  class={addButton}
                  aria-label={servers("own.remote.add")}
                  title={servers("own.remote.add")}
                  data-testid="remote-add"
                  onClick={() => openRemoteDialog({ kind: "add" })}
                >
                  <Icon name="plus" class="size-3.5 flex-none fill-none stroke-current stroke-[1.8]" />
                  {/* Both buttons of a narrow list drop `추가` (shell.css). */}
                  <span class="own-add-long truncate">{servers("own.remote.add")}</span>
                  <Show when={remotePcStore()}>
                    <span class="own-add-short truncate">{servers("own.remote.addShort")}</span>
                  </Show>
                </button>
              </Show>
              {/* 원격 PC (08 §4.1): only in hosts with capabilities.remotePcs. */}
              <Show when={remotePcStore()}>
                <button
                  type="button"
                  class={addButton}
                  aria-label={pcs("own.remotePc.add")}
                  title={pcs("own.remotePc.add")}
                  data-testid="remote-pc-add"
                  onClick={() => openRemotePcDialog({ kind: "add" })}
                >
                  <Icon name="plus" class="size-3.5 flex-none fill-none stroke-current stroke-[1.8]" />
                  <span class="own-add-long truncate">{pcs("own.remotePc.add")}</span>
                  <span class="own-add-short truncate">{pcs("own.remotePc.group")}</span>
                </button>
              </Show>
            </div>
          </Show>
          <AccountsInUse />
          {/* One row that fits the narrowest default column (240 px, the compact tier) without shortening the status
            (the 2026-10-18 layout audit cut `이 PC · 연결됨` at every width). */}
          <div class="flex flex-none items-center gap-0.5 border-t border-own-border px-1.5 py-2 text-[11.5px] text-own-muted">
            {/* 03 §4.3.1: settings with its name and shortcut, not an unlabeled icon among four. 설정, 한도 and 계정
              open their page and close it again (the user's 2026-10-18 report: back to the conversation as it was). */}
            <button
              type="button"
              class="own-target flex h-8 flex-none items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-[12.5px] text-own-muted hover:bg-own-hover hover:text-own-text aria-pressed:bg-own-accent-soft aria-pressed:text-own-accent-text [&_svg]:size-4 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.6]"
              aria-label={i18n.t("own.nav.settings")}
              title={discover("own.discover.settings.open", { keys: settingsKeys })}
              aria-pressed={route().name === "settings"}
              data-testid="sidebar-settings"
              onClick={() => shell.togglePage({ name: "settings", section: "general", list: true })}
            >
              <Icon name="gear" />
              {i18n.t("own.nav.settings")}
            </button>
            <button
              type="button"
              class="own-icon-button own-target"
              aria-label={i18n.t("own.nav.limits")}
              title={i18n.t("own.nav.limits")}
              aria-pressed={route().name === "limits"}
              data-testid="sidebar-limits"
              onClick={() => shell.togglePage({ name: "limits" })}
            >
              <Icon name="gauge" />
            </button>
            <button
              type="button"
              class="own-icon-button own-target"
              aria-label={i18n.t("own.nav.accounts")}
              title={i18n.t("own.nav.accounts")}
              aria-pressed={route().name === "accounts" || route().name === "accountsAdd"}
              data-testid="sidebar-accounts"
              onClick={() => shell.togglePage({ name: "accounts" })}
            >
              <Icon name="user" />
            </button>
            <button
              type="button"
              class="own-icon-button own-target"
              aria-label={text("own.sidebar.archiveOpen")}
              title={text("own.sidebar.archiveView")}
              aria-pressed={sidebarArchiveView()}
              data-testid="archive-toggle"
              onClick={() => setSidebarArchiveView(!sidebarArchiveView())}
            >
              <ArchiveIcon />
            </button>
            {/* 4.3 server status popover (MCP module, 18.14): version, trust mode, guard, MCP summary, browser rule. */}
            {/* The dot and `연결됨`; `이 PC` is read out and in the panel's title (no room for it beside four buttons).
              The row has no room to spare at the default widths: `연결 중…` was cut at 1152 px (layout audit,
              2026-11-21), so the footer says `연결 중` (the amber dot already says it is under way) in a button with
              half the padding. English (`Connected`) has no room at all there: the words wrap below the one line that
              shows, whole or not at all, and the dot stays. */}
            <ServerStatusPopover
              class="own-target ml-auto flex min-w-0 items-center rounded-md border-0 bg-transparent px-0.5 py-1 text-inherit hover:bg-own-hover"
              title={runtime.own.state.health?.version}
              testid="server-status-button"
            >
              <span
                class="flex h-[18px] min-w-0 flex-wrap content-start gap-x-1.5 overflow-hidden leading-[18px]"
                data-testid="server-status"
                data-status={connection.status()}
              >
                <span class="flex h-[18px] flex-none items-center">
                  <span
                    class="size-[7px] rounded-full"
                    classList={{
                      "bg-own-ok": connection.status() === "connected",
                      "bg-own-warn": connection.status() !== "connected",
                    }}
                  />
                </span>
                <span class="own-sr-only">{i18n.t("own.nav.thisPc")} · </span>
                <span class="whitespace-nowrap">
                  {i18n.t(
                    connection.status() === "connected" ? "own.nav.server.connected" : "own.nav.server.connectingShort",
                  )}
                </span>
              </span>
            </ServerStatusPopover>
          </div>
        </nav>
      </ScrollerContext.Provider>
    </SidebarContext.Provider>
  )
}

/**
 * One SSH host's session tree under its group header (04 §12.3, §17.2): the same rows, chips and keys over that
 * host's runtime. Account chips resolve against this PC's accounts (04 §12.6: the remote session's
 * `model.providerID` + the local `accounts.list`).
 */
function ServerSessionTree(props: {
  readonly runtime: ServerRuntime
  readonly top: () => number
  readonly last: () => boolean
}) {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const i18n = useI18n()
  const ctl = createSidebarController({
    serverKey: props.runtime.key,
    runtime: props.runtime,
    router,
    windowKey: windowKey(host),
    touch: host.capabilities.touch,
    accounts: data.local().own,
    query: useSidebar().queryState,
  })
  registerTree(ctl)
  return (
    <SidebarContext.Provider value={ctl}>
      <ServerList
        top={props.top}
        last={props.last}
        testId="host-session-list"
        label={`${i18n.t("own.nav.label")} · ${props.runtime.entry()?.label ?? props.runtime.key}`}
      />
    </SidebarContext.Provider>
  )
}

/** One server's list, the same on this PC and on a host: how old it is, what it has none of, the tree, its archive. */
function ServerList(props: {
  readonly top: () => number
  /** The last list of the sidebar: it loads on as it is scrolled; the others by their `이전 대화 더 보기`. */
  readonly last: () => boolean
  readonly testId: string
  readonly label: string
}) {
  const ctl = useSidebar()
  const i18n = useI18n()
  const text = useSidebarText()
  const scroller = useScroller()
  const state = ctl.index.state
  const registered = trees.get(ctl.serverKey)
  let tree: TreeApi | undefined
  const local = ctl.serverKey === LOCAL
  const activeKey = () => {
    const id = ctl.activeID()
    if (!id) return undefined
    const keys = ctl.keys()
    const root = rowKey.session(id)
    return keys.includes(root) ? root : keys.find((key) => key.startsWith(`c|${id}|`))
  }
  // Keep the open session in view when the route changes from elsewhere (Alt+↑/↓, palette, notifications, a deep
  // link), also once its row appears after the list loads.
  let revealed: string | undefined
  createEffect(() => {
    const id = ctl.activeID()
    if (!id) return void (revealed = undefined)
    const key = rowKey.session(id)
    if (revealed === id || !ctl.keys().includes(key)) return
    revealed = id
    tree?.reveal(key)
  })
  const note = "m-0 py-1.5 pr-3 pl-8 text-[12px] text-own-faint"
  const none = () => ctl.tree().sessions === 0
  return (
    <>
      <Show when={state.source === "cache"}>
        <p
          class="m-0 pr-3 pb-0.5 pl-8 text-[11.5px] text-own-faint"
          data-testid={local ? "sidebar-cached" : "host-cached"}
        >
          <Show when={state.savedAt} fallback={i18n.t("own.nav.cachedList")}>
            {(savedAt) =>
              minuteNow() - savedAt() >= 60_000
                ? text("own.sidebar.cachedAge", { age: relativeTime(i18n, minuteNow(), savedAt()) })
                : i18n.t("own.nav.cachedList")
            }
          </Show>
        </p>
      </Show>
      {/* A host that is away and left no list has nothing on the way. */}
      <Show when={(local || ctl.runtime.entry()) && state.source === "empty" && state.order.length === 0}>
        <SkeletonRows />
      </Show>
      <Show when={ctl.archiveView()}>
        <ArchiveBar ctl={ctl} text={text} />
        <Show when={none() && !ctl.searching()}>
          <p class={note} data-testid="archive-empty">
            {text("own.sidebar.archiveEmpty")}
          </p>
        </Show>
      </Show>
      <Show when={!ctl.archiveView() && state.source !== "empty" && state.order.length === 0 && !ctl.searching()}>
        <p class={note} data-testid={local ? "sidebar-empty" : "host-sessions-empty"}>
          {i18n.t("own.empty.sessions")}
        </p>
      </Show>
      <Show when={ctl.searching() && none()}>
        <p class={note} role="status" data-testid="sidebar-search-empty">
          {ctl.serverSearching()
            ? text("own.sidebar.searchServer")
            : text("own.sidebar.searchEmpty", { query: ctl.query().trim() })}
        </p>
      </Show>
      <WindowedTree
        keys={ctl.keys}
        height={ctl.height}
        virtual={ctl.virtual}
        label={props.label}
        activeKey={activeKey}
        testId={props.testId}
        top={props.top}
        ref={(api) => {
          tree = api
          if (registered) registered.api = api
        }}
        row={(key, api) => renderRow(ctl, key, api)}
        onRendered={(keys) => ctl.setRendered(keys)}
        // Where everything fits on the screen there is nothing to scroll past: every list loads on.
        onNearEnd={() => (props.last() || scroller.content() <= scroller.height()) && ctl.loadMore()}
        onExpand={(key, open) => expand(ctl, key, open)}
        parentOf={(key) => parentOf(ctl, key)}
      />
      {/* 19.11a: the archive is one click away while it holds anything (the footer box is easy to miss). */}
      <Show when={!ctl.archiveView() && !ctl.searching() && ctl.flags.archivedIDs().length > 0}>
        <button
          type="button"
          class="own-target mx-2 mt-1 flex h-7 w-[calc(100%-16px)] items-center gap-[5px] rounded-md pr-2 pl-[5px] text-left text-[12px] text-own-muted hover:bg-own-hover hover:text-own-text"
          aria-label={text("own.sidebar.archiveOpen")}
          data-testid="archive-entry"
          onClick={() => setSidebarArchiveView(true)}
        >
          <ArchiveIcon class="size-3.5 flex-none" />
          <span class="min-w-0 flex-1 truncate">
            {text("own.sidebar.archiveTitle", { n: ctl.flags.archivedIDs().length })}
          </span>
          <span aria-hidden="true">›</span>
        </button>
      </Show>
      <RowMenu />
    </>
  )
}

/**
 * 19.11a: the archive's actions under its header. `선택` (selection mode: rows toggle, `모두 선택` / `선택 해제`,
 * `선택한 n개 보관 해제` with `prompt`, `선택한 n개 삭제…` with `admin`, `완료`) and `보관함 비우기…` (`admin`). Deletes
 * from here touch only what the server still has archived (manage.ts).
 */
function ArchiveBar(props: { readonly ctl: SidebarController; readonly text: SidebarText }) {
  const ctl = props.ctl
  const text = props.text
  const count = () => ctl.flags.archivedIDs().length
  const selected = () => ctl.selected()
  const i18n = useI18n()
  const titled = (ids: readonly string[]) =>
    ids.map((id) => ({ id, title: ctl.row(id)?.title || i18n.t("own.shell.untitled") }))
  const [busy, setBusy] = createSignal(false)

  async function unarchive() {
    const ids = selected()
    if (!ids.length || busy()) return
    setBusy(true)
    const failed = await ctl.flags.setMany(ids, "archived", false)
    setBusy(false)
    if (failed.length)
      showToast({ message: text("own.sidebar.unarchiveManyFailed", { n: failed.length }), tone: "danger" })
    if (ids.length > failed.length)
      showToast({ message: text("own.sidebar.archivedMany", { n: ids.length - failed.length }) })
    ctl.clearSelected()
  }

  const button =
    "own-target flex h-7 flex-none items-center rounded-md px-2 text-[12px] text-own-muted hover:bg-own-hover hover:text-own-text disabled:opacity-50"
  return (
    <Show when={count() > 0 && !ctl.searching() && (ctl.canFlag() || ctl.canDelete())}>
      <div
        class="mx-2 mb-1 flex flex-none flex-wrap items-center gap-x-1 gap-y-0.5"
        role="toolbar"
        aria-label={text("own.sidebar.archiveView")}
        data-testid="archive-bar"
        data-selecting={ctl.selecting() ? "true" : "false"}
      >
        <Show
          when={ctl.selecting()}
          fallback={
            <>
              <button type="button" class={button} data-testid="archive-select" onClick={() => ctl.setSelecting(true)}>
                {text("own.sidebar.select")}
              </button>
              <Show when={ctl.canDelete()}>
                <button
                  type="button"
                  class={`${button} ml-auto text-own-danger hover:text-own-danger`}
                  data-testid="archive-empty-all"
                  onClick={() =>
                    openSessionDelete({
                      serverKey: ctl.serverKey,
                      sessions: titled(ctl.flags.archivedIDs()),
                      emptyArchive: true,
                      archivedOnly: true,
                    })
                  }
                >
                  {text("own.sidebar.emptyArchive")}
                </button>
              </Show>
            </>
          }
        >
          <span class="px-1 text-[12px] font-medium" role="status" data-testid="archive-selected">
            {text("own.sidebar.selected", { n: selected().length })}
          </span>
          <button
            type="button"
            class={button}
            data-testid="archive-select-all"
            onClick={() => (selected().length ? ctl.clearSelected() : ctl.selectAll())}
          >
            {selected().length ? text("own.sidebar.selectNone") : text("own.sidebar.selectAll")}
          </button>
          <button
            type="button"
            class={`${button} ml-auto`}
            data-testid="archive-select-done"
            onClick={() => ctl.setSelecting(false)}
          >
            {text("own.sidebar.selectDone")}
          </button>
          <div class="flex w-full flex-wrap gap-1">
            <Show when={ctl.canFlag()}>
              <button
                type="button"
                class={button}
                disabled={!selected().length || busy()}
                data-testid="archive-unarchive-selected"
                onClick={() => void unarchive()}
              >
                {text("own.sidebar.unarchiveSelected", { n: selected().length })}
              </button>
            </Show>
            <Show when={ctl.canDelete()}>
              <button
                type="button"
                class={`${button} text-own-danger hover:text-own-danger`}
                disabled={!selected().length || busy()}
                data-testid="archive-delete-selected"
                onClick={() =>
                  openSessionDelete({
                    serverKey: ctl.serverKey,
                    sessions: titled(selected()),
                    archivedOnly: true,
                    onDone: () => ctl.clearSelected(),
                  })
                }
              >
                {text("own.sidebar.deleteSelected", { n: selected().length })}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function renderRow(ctl: SidebarController, key: string, tree: TreeApi) {
  const parsed = parseKey(key)
  switch (parsed.kind) {
    case "project":
      return <ProjectRow rowKey={key} projectID={parsed.id} tree={tree} />
    case "pinned":
      return <PinnedGroupRow rowKey={key} tree={tree} />
    case "date":
      return <DateRow rowKey={key} bucket={toBucket(parsed.extra)} />
    case "worktree":
      return <WorktreeRow rowKey={key} projectID={parsed.id} directory={decodeURIComponent(parsed.extra ?? "")} />
    case "session":
      return <SessionRow rowKey={key} sessionID={parsed.id} tree={tree} />
    case "child":
      return <ChildRow rowKey={key} sessionID={parsed.id} tree={tree} />
    case "requests":
      return <TeamRequestsRow rowKey={key} projectID={parsed.id} tree={tree} />
    case "request":
      return <TeamRequestRow rowKey={key} sessionID={parsed.id} requestID={parsed.extra ?? ""} tree={tree} />
    case "notices":
      return <TeamNoticesRow rowKey={key} projectID={parsed.id} tree={tree} />
    case "notice":
      return <TeamNoticeRow rowKey={key} noticeID={parsed.id} tree={tree} />
    case "area":
      return <AreaRow rowKey={key} teamID={parsed.id} areaID={parsed.extra ?? ""} tree={tree} />
    case "others":
      return <TeamOthersRow rowKey={key} teamID={parsed.id} areaID={parsed.extra ?? ""} tree={tree} />
    case "outside":
      return <TeamOutsideRow rowKey={key} projectID={parsed.id} tree={tree} />
    case "import":
      return <ImportEntryRow rowKey={key} projectID={parsed.id} tree={tree} />
    case "create":
      return <TeamCreateRow rowKey={key} teamID={parsed.id} tree={tree} />
    default:
      return <MoreRow rowKey={key} tree={tree} />
  }
}

/**
 * →/←: projects, areas, `허락 기다리는 것 n개` and `팀 알림 n개` fold (open by default); sessions show or hide their subagents; the
 * other team groups (`이 영역의 다른 대화 n`, …) open or close (folded by default).
 */
function expand(ctl: SidebarController, key: string, open: boolean) {
  if (ctl.searching()) return false
  const parsed = parseKey(key)
  const fold = (group: string) => {
    if (ctl.prefs.collapsed(group) !== open) return false
    ctl.prefs.toggleProject(group, !open)
    return true
  }
  const unfold = (group: string) => {
    if (ctl.prefs.expanded(group) === open) return false
    ctl.prefs.toggleChildren(group, open)
    return true
  }
  switch (parsed.kind) {
    case "project":
      return fold(parsed.id)
    case "pinned":
      return fold(PINNED_GROUP)
    case "area":
      return fold(foldKey.area(parsed.id, parsed.extra ?? ""))
    case "requests":
      return fold(foldKey.requests(parsed.id))
    case "notices":
      return fold(foldKey.notices(parsed.id))
    case "others":
      return unfold(foldKey.others(parsed.id, parsed.extra ?? ""))
    case "outside":
      return unfold(foldKey.outside(parsed.id))
    case "session":
      return ctl.childCount(parsed.id) > 0 && unfold(parsed.id)
    default:
      return false
  }
}

/** ←: the nearest row above with a lower level (a session's project or area, a subagent's session, …). */
function parentOf(ctl: SidebarController, key: string) {
  const keys = ctl.keys()
  const levels = ctl.tree().levels
  const level = levelOf(key, levels)
  for (let at = keys.indexOf(key) - 1; at >= 0; at--) {
    const candidate = keys[at]!
    if (isFocusable(candidate) && levelOf(candidate, levels) < level) return candidate
  }
  return undefined
}

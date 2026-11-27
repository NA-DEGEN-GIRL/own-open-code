// Sidebar state for one server (03 §4.3): the session tree derived from the SWR session index, search (local filter
// plus server `search` and session-id lookup), pin/archive flags and the `보관함` view (19.11) with its selection
// (19.11a: `선택` → `보관 해제` / `삭제…`), unread tracking,
// bindings for the rows on screen, and the per-row readers (status, chip, model name, subagents). Rows read their
// own id's slice only (R1); the flattened tree depends on order, project, day bucket, folding, flags and search —
// never on titles (except while searching), status or chips.
//
// Team view (06 §9.4): once this server's own.team registry has a team on, team/view-model.ts loads (team chunk) and
// the team's project lists the team instead of its `⑂` groups. Roles come from the registry (`team.placeOf` without
// hints); team mains and owners older than the loaded pages are looked up by id like pinned rows; the permission
// requests of the team's conversations are read once per connect and then follow events. On this PC the team view
// asks own.computer's `status` once (the lease holder shows as `데스크톱 사용 중`) and then follows its events. The
// team's notices (`팀 알림 n개`) come from the TeamStore, which hears them as events.
//
// 다른 도구의 대화 (09 §6 entry 1): an open project ends with `다른 도구의 대화 · 새 N개 ›` while import/store.ts counts
// conversations not imported yet for it (the project row asks for the count after the list paint).
import type { PermissionReply, SessionInfo } from "@opencode/client"
import {
  batch,
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
  type Signal,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { computerStore } from "@/computer/state"
import { isImportHelper, LOCAL, type ServerKey, type ServerRuntime, type SessionRow } from "@/data"
import { backgroundCount } from "@/background"
import { toRow } from "@/data/session-index"
import { importEntryCount } from "@/import"
import { tightest } from "@/limits/windows"
import { defaultFolder } from "@/projects/default-folder"
import { samePath } from "@/projects/path"
import { rootOf } from "@/requests/notify"
import type { Router } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import type { TeamView } from "@/team/view-model"
import { placeOf, worktreeName } from "@/worktree"
import { projectKey, worktreeList } from "@/worktree/state"
import { createOwnFlags, registerFlagStore, type FlagKey } from "./flags"
import {
  createSidebarPrefs,
  readSavedAccounts,
  saveAccounts,
  setSidebarArchiveView,
  sidebarArchiveView,
  sidebarDensity,
} from "./local-state"
import {
  accountProblem,
  baseName,
  chipView,
  dayMarks,
  firstStatus,
  flattenTree,
  heightOf,
  matchesQuery,
  meterLevel,
  modelLabel,
  normalizeQuery,
  orderFamily,
  parseKey,
  rowHeights,
  sessionIDIn,
  switchHolds,
  type AccountLike,
  type ChipView,
  type RowStatus,
  type TeamProject,
} from "./model"
import { createProjectList } from "./project-list"
import { createReadState } from "./read-state"
import { folding } from "./reorder-api"
import { createSessionSignals } from "./signals"
import { setNewSessionTarget } from "./target"
import { createWatchSet } from "./watch"

/** 03 §20.2 R2: the sidebar virtualizes past 200 session rows. */
export const VIRTUAL_THRESHOLD = 200
const SEARCH_WINDOW = 60
const SEARCH_DELAY = 250
const WATCH_DELAY = 120
const SAVE_ACCOUNTS_DELAY = 1_500
/** Archived rows looked up per step of the `보관함` view (its "more" row asks for the next step). */
const ARCHIVE_PAGE = 60
/** Parallel `session.get` lookups for pinned/archived rows the index has not loaded. */
const LOOKUP_CONCURRENCY = 4
/** Rows whose flags the connect scan reads while the index rows do not carry metadata (see `scanFlags`). */
const SCAN_ROWS = 100

export interface ProjectView {
  readonly id: string
  readonly name: string
  readonly directory?: string
  /** The server's 기본 대화 폴더 (03 §5.1): the row reads `폴더 없는 대화` and is listed first. */
  readonly defaultFolder?: true
}

export function createSidebarController(input: {
  readonly serverKey: ServerKey
  readonly runtime: ServerRuntime
  readonly router: Router
  readonly windowKey: string
  readonly touch: boolean
  /** Where account chips resolve (04 §12.6: an SSH host's rows use this PC's `accounts.list`); default: the runtime's. */
  readonly accounts?: ServerRuntime["own"]
  /** The search box's query, shared by every server's tree; default: its own. */
  readonly query?: Signal<string>
}) {
  const { serverKey, runtime, router } = input
  const index = runtime.sessions
  const data = runtime.data
  const own = runtime.own
  const accounts = input.accounts ?? own
  const prefs = createSidebarPrefs(input.windowKey)
  const signals = createSessionSignals(runtime.bus)
  const read = createReadState({ storageKey: `own.web.sidebar.read.${serverKey}` })
  const flags = createOwnFlags({ serverKey, bus: runtime.bus, client: runtime.client })
  onCleanup(registerFlagStore(serverKey, flags))
  onCleanup(() => {
    signals.dispose()
    read.dispose()
    flags.dispose()
  })

  // ---- accounts: live `accounts.list`, else the list saved on the last run (chips of saved rows, PF1)
  const saved = readSavedAccounts(serverKey)
  const savedById = new Map(saved.map((account) => [account.id, account]))
  const savedByProvider = new Map(saved.map((account) => [account.providerID, account]))
  const live = () => accounts.state.revision !== undefined || accounts.state.accountOrder.length > 0
  const account = (id: string): AccountLike | undefined =>
    accounts.state.accounts[id] ?? (live() ? undefined : savedById.get(id))
  const accountFor = (providerID: string): AccountLike | undefined =>
    accounts.accountFor(providerID) ?? (live() ? undefined : savedByProvider.get(providerID))
  const accountsKnown = () => live() || saved.length > 0

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => accounts.state.revision,
      (revision) => {
        if (revision === undefined) return
        clearTimeout(saveTimer)
        saveTimer = setTimeout(
          () =>
            saveAccounts(
              serverKey,
              accounts.state.accountOrder.flatMap((id) => accounts.state.accounts[id] ?? []),
            ),
          SAVE_ACCOUNTS_DELAY,
        )
      },
    ),
  )
  onCleanup(() => clearTimeout(saveTimer))

  // ---- route
  const activeID = createMemo(() => {
    const route = router.route()
    return route.name === "session" && route.serverKey === serverKey ? route.sessionID : undefined
  })
  const activeProjectID = createMemo(() => {
    const route = router.route()
    return route.name === "project" && route.serverKey === serverKey ? route.projectID : undefined
  })
  const isActive = createSelector(activeID)
  const isActiveProject = createSelector(activeProjectID)

  // ---- search: instant local filter + server `search` (titles beyond the loaded pages) + session-id lookup
  const [query, setQuery] = input.query ?? createSignal("")
  const normalized = createMemo(() => normalizeQuery(query()))
  const [found, setFound] = createStore<{ rows: Record<string, SessionRow>; order: string[] }>({ rows: {}, order: [] })
  const [serverSearching, setServerSearching] = createSignal(false)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchToken = 0
  /** A session id in the query, also inside a pasted link (19.11 "검색창에 세션 ID 붙여넣기"). */
  const lookupID = createMemo(() => sessionIDIn(query()))
  createEffect(
    on(normalized, (value) => {
      clearTimeout(searchTimer)
      const token = ++searchToken
      const raw = untrack(query).trim()
      const lookup = untrack(lookupID)
      if (!value || (value.length < 2 && !lookup)) {
        setServerSearching(false)
        setFound({ rows: {}, order: [] })
        return
      }
      searchTimer = setTimeout(() => void search(raw, lookup, token), SEARCH_DELAY)
    }),
  )
  onCleanup(() => clearTimeout(searchTimer))

  async function search(raw: string, lookup: string | undefined, token: number) {
    setServerSearching(true)
    try {
      const client = runtime.client()
      const [page, exact] = await Promise.all([
        // A pasted link is not a title: only the id lookup runs for it.
        lookup && lookup !== raw
          ? Promise.resolve(undefined)
          : client.session.list({ search: raw, parentID: null, limit: 50, order: "desc" }).catch(() => undefined),
        lookup ? client.session.get({ sessionID: lookup }).catch(() => undefined) : Promise.resolve(undefined),
      ])
      if (token !== searchToken) return
      const all = [...(exact ? [exact] : []), ...(page?.data ?? [])]
      flags.ingestInfos(all)
      const rows = all.filter(visible).map(toRow)
      batch(() => {
        setFound("rows", reconcile(Object.fromEntries(rows.map((row) => [row.id, row]))))
        setFound(
          "order",
          rows.map((row) => row.id),
        )
      })
    } catch {
      // Not connected yet: the local filter still works.
    } finally {
      if (token === searchToken) setServerSearching(false)
    }
  }

  // Rows of pinned and archived sessions the index has not loaded (looked up by id, below).
  const [extra, setExtra] = createStore<{ rows: Record<string, SessionRow> }>({ rows: {} })
  const row = (id: string): SessionRow | undefined => index.state.sessions[id] ?? found.rows[id] ?? extra.rows[id]

  // ---- team view (06 §9.4)
  const team = runtime.team
  const [teamView, setTeamView] = createSignal<TeamView>()
  async function loadTeamView() {
    const { teamView } = await import("@/team/view-model")
    setTeamView(() => teamView)
  }
  createEffect(() => {
    if (Object.keys(team.state.teams).length > 0 && !untrack(teamView)) void loadTeamView().catch(report)
  })
  /**
   * The teams' notices in force (06 §9.7): held updates (`wake.limited`) leave once their time passed, on the minute
   * clock; the tree is built again only when the list changes.
   */
  const teamNotices = createMemo(() => teamView()?.live(team.state.notices, minuteNow()) ?? [], [], {
    equals: (a, b) => a.length === b.length && a.every((item, at) => item === b[at]),
  })
  /** Projects with a team on, as the tree lists them (empty until the team chunk is there). */
  const teamProjects = createMemo(() => {
    const view = teamView()
    if (!view) return new Map<string, TeamProject>()
    const entries = Object.values(team.state.teams)
    const projects = [...new Set(entries.map((entry) => entry.team.projectID))]
    return new Map(
      projects.map((projectID) => [
        projectID,
        view.project({
          entries: entries.filter((entry) => entry.team.projectID === projectID),
          worktrees: worktreeList(projectKey(serverKey, projectID))?.items?.map((item) => item.directory),
          family: (sessionID) => data.session.family(sessionID),
          permissions: (sessionID) => data.session.permission.list(sessionID),
          notices: teamNotices(),
          // 06 §9.4 (2026-10-26): the `영역 만들기…` row where this connection may make areas (an older own.team gets
          // the basic dialog, 2026-10-27).
          creates: team.createForm() !== undefined,
        }),
      ]),
    )
  })
  /**
   * The current team mains, owners and area peers (동료): listed even when older than the loaded pages (looked up like
   * pinned rows), and their permission requests read.
   */
  const teamRoots = createMemo<string[]>(
    () =>
      teamView()
        ? Object.values(team.state.teams).flatMap((entry) => [
            entry.team.main.sessionID,
            ...entry.order.flatMap((id) => entry.areas[id]?.owner.sessionID ?? []),
            ...entry.order.flatMap((id) => (entry.areas[id]?.peers ?? []).map((peer) => peer.sessionID)),
          ])
        : [],
    [],
    { equals: (a, b) => a.length === b.length && a.every((id, at) => id === b[at]) },
  )
  const teamRootSet = createMemo(() => new Set(teamRoots()))
  // Their permission requests, read once per connect (deduplicated by the sync key); events keep them current.
  createEffect(() => {
    if (runtime.connection.status() !== "connected") return
    const roots = teamRoots()
    untrack(() => roots.forEach((sessionID) => void data.session.permission.sync(sessionID).catch(report)))
  })
  // The team main's preset for its row (`프리셋 평소대로`, 9.4); a remote server's from its mirror (07 §8.1 원격).
  const teamMains = createMemo(
    () => (teamView() ? Object.values(team.state.teams).map((entry) => entry.team.main.sessionID) : []),
    [],
    { equals: (a, b) => a.length === b.length && a.every((id, at) => id === b[at]) },
  )
  createEffect(on(teamMains, (ids) => ids.forEach((sessionID) => onCleanup(own.watchPreset(sessionID)))))
  // Computer use runs on this PC only: the team view asks its `status` once, then the store follows its events.
  createEffect(() => {
    if (serverKey === LOCAL && teamRoots().length > 0) untrack(() => computerStore()?.ensure())
  })
  /** The root conversation that holds the desktop lease (own.computer `status.lease.holder`), on this PC. */
  const leaseRoot = createMemo(() => {
    const holder = serverKey === LOCAL ? computerStore()?.state.status?.lease?.holder : undefined
    return holder ? rootOf(holder, (sessionID) => data.session.get(sessionID)?.parentID) : undefined
  })
  const [answering, setAnswering] = createSignal<ReadonlySet<string>>(new Set())

  // ---- tree
  const marks = createMemo(() => dayMarks(minuteNow()), undefined, { equals: (a, b) => a.today === b.today })
  const children = (sessionID: string) =>
    orderFamily(sessionID, data.session.family(sessionID), (id) => {
      const info = data.session.get(id)
      return info ? { parentID: info.parentID, updated: info.time.updated } : undefined
    })
  const childCount = (sessionID: string) => data.session.family(sessionID).filter((id) => id !== sessionID).length

  const archiveView = sidebarArchiveView
  const [archiveLimit, setArchiveLimit] = createSignal(ARCHIVE_PAGE)
  createEffect(on(archiveView, () => setArchiveLimit(ARCHIVE_PAGE), { defer: true }))
  const archivedShown = createMemo(() => flags.archivedIDs().slice(0, archiveLimit()))

  // 19.11a: the archive's selection mode (`선택`). Rows toggle instead of opening; leaving the view ends it, and ids
  // that leave the archive (unarchived, deleted, here or elsewhere) leave the selection.
  const [selecting, setSelecting] = createSignal(false)
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set())
  createEffect(
    on(archiveView, (shown) => {
      if (shown) return
      setSelecting(false)
      setPicked(new Set<string>())
    }),
  )
  const selected = createMemo(() => [...picked()].filter((id) => flags.archived(id)))
  const isSelected = createSelector(selected, (id: string, ids) => ids.includes(id))

  // 19.3 `⑂` groups: a root session whose folder is a worktree of its project — one of the project's worktrees when a
  // view already loaded that list (the new-session selector, the move dialog), else a folder outside the project root
  // (worktree/model.ts `placeOf`). No extra requests for the sidebar.
  const worktreeOf = (sessionID: string) => {
    const current = row(sessionID)
    const root = current ? index.state.projects[current.projectID]?.directory : undefined
    if (!current || !root) return undefined
    const known = worktreeList(projectKey(serverKey, current.projectID))?.items?.map((item) => item.directory)
    const place = placeOf(root, current.directory, known)
    return place.kind === "worktree" ? place.directory : undefined
  }

  // 03 §5.1: the project of the server's default conversation folder, once a conversation started there.
  const folder = defaultFolder(runtime)
  const folderProject = createMemo(() => {
    const path = folder.view()?.path
    if (!path) return undefined
    const known = Object.values(index.state.projects).find((project) => samePath(project.directory, path))
    if (known) return known.id
    const first = index.state.order.find((id) => {
      const directory = index.state.sessions[id]?.directory
      return directory !== undefined && samePath(directory, path)
    })
    return first ? index.state.sessions[first]?.projectID : undefined
  })

  // 03 §4.3 순서와 고정: the service's project order and pins; while one is dragged the projects show as headers only.
  const list = createProjectList(serverKey, runtime)
  const pinnedProjects = createMemo(() => new Set(list.view().pinned))
  const collapsed = (id: string) => folding() === serverKey || prefs.collapsed(id)

  const tree = createMemo(() => {
    const value = normalized()
    const searching = value !== ""
    const lookup = lookupID()
    const match = searching
      ? (id: string) => found.rows[id] !== undefined || id === lookup || matchesQuery(value, row(id)?.title, id)
      : undefined
    const session = (id: string) => {
      const current = row(id)
      return current
        ? { projectID: current.projectID, updated: current.updated, directory: current.directory }
        : undefined
    }
    if (archiveView())
      return flattenTree({
        order: archivedShown(),
        session,
        collapsed: prefs.collapsed,
        expanded: prefs.expanded,
        children,
        match,
        marks: marks(),
        more: flags.archivedIDs().length > archiveLimit(),
        dates: false,
      })
    const known = (id: string) => index.state.sessions[id] !== undefined
    const order = [
      ...index.state.order,
      ...(searching ? found.order.filter((id) => !known(id)) : []),
      ...Object.keys(extra.rows).filter(
        (id) => !known(id) && (searching || flags.pinned(id) || teamRootSet().has(id)) && !found.rows[id],
      ),
    ]
    const projects = teamProjects()
    return flattenTree({
      order,
      session,
      collapsed,
      expanded: prefs.expanded,
      children,
      match,
      marks: marks(),
      more: index.state.next !== null && index.state.source === "server",
      pinned: flags.pinned,
      hidden: flags.archived,
      worktree: worktreeOf,
      team: (projectID) => projects.get(projectID),
      imports: (projectID) => importEntryCount(runtime, projectID) > 0,
      leading: folderProject(),
      list: list.view(),
    })
  })

  // Pinned sessions and team conversations older than the loaded pages, and the archived sessions the `보관함` view
  // shows, are looked up by id once connected. A lookup that finds a subagent or nothing drops the flag (children
  // inherit metadata).
  const tried = new Set<string>()
  const missing = createMemo(() => {
    if (runtime.connection.status() !== "connected") return []
    const wanted = archiveView() ? archivedShown() : [...flags.pinnedIDs(), ...teamRoots()]
    return wanted.filter((id) => !row(id) && !tried.has(id))
  })
  createEffect(on(missing, (ids) => void lookupRows(ids)))
  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        if (status === "connected") tried.clear()
      },
    ),
  )

  async function lookupRows(ids: readonly string[]) {
    if (!ids.length) return
    ids.forEach((id) => tried.add(id))
    const queue = [...ids]
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const info = await runtime
          .client()
          .session.get({ sessionID: id })
          .catch((error: unknown) => (notFound(error) ? null : undefined))
        if (info === undefined) continue
        if (info === null || info.parentID || !visible(info)) {
          flags.forget(id)
          continue
        }
        batch(() => {
          flags.ingest(info.id, info.metadata)
          setExtra("rows", info.id, toRow(info))
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, ids.length) }, worker))
  }

  // Flags of the rows on the first pages. Index rows do not carry session metadata (src/data `toRow`), so once per
  // connect, when the page is idle, the first SCAN_ROWS root sessions are read again for their flags. Rows that
  // carry `metadata` (the data-layer seam asked for in the P7 report) make this unnecessary and skip it.
  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        if (status !== "connected") return
        idle(() => void scanFlags())
      },
    ),
  )
  async function scanFlags() {
    const first = index.state.sessions[index.state.order[0] ?? ""]
    if (first && "metadata" in first) return
    const page = await runtime
      .client()
      .session.list({ parentID: null, limit: SCAN_ROWS, order: "desc" })
      .catch(() => undefined)
    if (page) flags.ingestInfos(page.data)
  }
  // Rows that carry metadata keep the flags current from every server list (the seam above). Only a row whose
  // metadata changed is read again, so a status patch of a row never replays older metadata over a newer event.
  const ingested = new Map<string, unknown>()
  createEffect(() => {
    if (index.state.source !== "server") return
    for (const id of index.state.order) {
      const current = index.state.sessions[id]
      if (!current || !("metadata" in current) || ingested.get(id) === current.metadata) continue
      ingested.set(id, current.metadata)
      const metadata: unknown = current.metadata
      untrack(() => flags.ingest(id, metadata))
    }
  })
  const keys = () => tree().keys
  const heights = createMemo(() => rowHeights(sidebarDensity(), input.touch))
  // R2 asks for windowing past 200 sessions. While searching the list changes on every keystroke, and a drag folds it to
  // its headers at once, so then it windows from SEARCH_WINDOW rows on: each mounts at most a screenful of rows (PF2).
  const virtual = () =>
    tree().sessions > VIRTUAL_THRESHOLD ||
    ((normalized() !== "" || folding() === serverKey) && tree().keys.length > SEARCH_WINDOW)

  function project(projectID: string): ProjectView {
    const known = index.state.projects[projectID]
    if (projectID === folderProject()) {
      const directory = known?.directory ?? folder.view()?.path
      return { id: projectID, name: directory ? baseName(directory) : projectID, directory, defaultFolder: true }
    }
    // A project with a team on is its main folder (06 §9.1): the project's folder may follow an area's worktree.
    const home = teamView() ? team.teamsOfProject(projectID)[0]?.team.home.directory : undefined
    if (home) return { id: projectID, name: known?.name || baseName(home), directory: home }
    if (known) return { id: projectID, name: known.name || baseName(known.directory), directory: known.directory }
    const first = index.state.order.find((id) => index.state.sessions[id]?.projectID === projectID)
    const directory = first ? index.state.sessions[first]?.directory : undefined
    return { id: projectID, name: directory ? baseName(directory) : projectID, directory }
  }

  // ---- bindings for the rows on screen, batched (one `session.binding` per change set)
  const watch = createWatchSet((ids) => own.watchVisible(ids))
  onCleanup(() => watch.dispose())
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  function setRendered(rendered: readonly string[]) {
    clearTimeout(watchTimer)
    watchTimer = setTimeout(() => {
      watch.sync(rendered.flatMap((key) => (key.startsWith("s|") ? [parseKey(key).id] : [])))
    }, WATCH_DELAY)
  }
  onCleanup(() => clearTimeout(watchTimer))

  // ---- unread (7.6 `•`): a turn that ends out of sight marks the root session unread; being in front clears it
  const hidden = createVisibility()
  onCleanup(
    signals.onFinished((sessionID, at) => {
      if (!index.state.sessions[sessionID]) return
      if (activeID() === sessionID && !hidden()) read.markSeen(sessionID, Math.max(at, Date.now()))
      else read.markUnread(sessionID)
    }),
  )
  createEffect(() => {
    const id = activeID()
    if (!id || hidden()) return
    const updated = index.state.sessions[id]?.updated ?? 0
    read.markSeen(id, Math.max(Date.now(), updated))
  })
  // The active session's subagents appear under it (createData family; deduped by the sync key).
  createEffect(
    on(activeID, (id) => {
      if (!id) return
      if (runtime.connection.status() !== "connected") return
      void data.session.sync(id, { children: true }).catch(() => undefined)
    }),
  )
  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        const id = untrack(activeID)
        if (status === "connected" && id) void data.session.sync(id, { children: true }).catch(() => undefined)
      },
    ),
  )
  onCleanup(
    runtime.bus.on("session.deleted", (event) => {
      read.forget(event.data.sessionID)
      if (found.rows[event.data.sessionID])
        setFound("order", (order) => order.filter((id) => id !== event.data.sessionID))
    }),
  )

  // ---- per-row readers
  const switchState = (sessionID: string) => own.state.switchState[sessionID] ?? own.state.binding[sessionID]?.switch

  function accountOf(sessionID: string): AccountLike | undefined {
    const binding = own.state.binding[sessionID]
    if (binding?.accountID) return account(binding.accountID)
    const model = binding?.model ?? row(sessionID)?.model ?? data.session.get(sessionID)?.model
    return model ? accountFor(model.providerID) : undefined
  }

  /**
   * The account a session runs on for `providerID`: `named` (a pending switch's Claude account, SL-17) or its binding's
   * when that is one of the provider's (SL-8: the Claude accounts share `anthropic`, so the provider alone names only
   * the first), else the provider's.
   */
  function accountOn(
    sessionID: string | null | undefined,
    providerID: string,
    named?: string,
  ): AccountLike | undefined {
    const bound = sessionID ? own.state.binding[sessionID]?.accountID : undefined
    const owner = [named, bound]
      .map((id) => (id ? account(id) : undefined))
      .find((item) => item?.providerID === providerID)
    return owner ?? accountFor(providerID)
  }

  function chip(sessionID: string): ChipView {
    const current = row(sessionID)
    const info = current ? undefined : data.session.get(sessionID)
    return chipView({
      binding: own.state.binding[sessionID],
      model: current?.model ?? info?.model,
      known: current !== undefined || info !== undefined,
      account,
      accountFor,
      accountsKnown: accountsKnown(),
    })
  }

  function model(sessionID: string) {
    const binding = own.state.binding[sessionID]
    if (binding) return binding.model ?? undefined
    return row(sessionID)?.model ?? data.session.get(sessionID)?.model
  }

  function modelName(ref: { readonly providerID: string; readonly id: string }, directory?: string) {
    for (const list of [directory ? data.location.model.list({ directory }) : undefined, data.location.model.list()]) {
      const hit = list?.find(
        (item) => item.providerID === ref.providerID && (item.id === ref.id || item.modelID === ref.id),
      )
      if (hit) return modelLabel(ref.id, hit.name)
    }
    return modelLabel(ref.id)
  }

  const asking = (sessionID: string) =>
    (data.session.permission.list(sessionID)?.length ?? 0) > 0 || (data.session.form.list(sessionID)?.length ?? 0) > 0

  function status(sessionID: string): RowStatus {
    const current = () => row(sessionID)
    // A saved snapshot's status is old news; only the live list's is trusted.
    const liveStatus = () => (index.state.source === "server" ? current()?.status : undefined)
    const problem = () => accountProblem(accountOf(sessionID)?.status)
    return firstStatus({
      // 9: a subagent's approval request shows on the parent row too.
      waiting: () => asking(sessionID) || children(sessionID).some((child) => asking(child.id)),
      error: () => signals.state.failed[sessionID] === true || problem() === "error",
      running: () => data.session.status(sessionID) === "running" || liveStatus() === "busy",
      pending: () =>
        signals.state.retry[sessionID] === true ||
        liveStatus() === "retry" ||
        switchHolds(switchState(sessionID)) ||
        problem() === "pending",
      revert: () => data.session.get(sessionID)?.revert !== undefined,
      // 19.7: background shells and subagents of an idle session (own Git write shells are not jobs).
      background: () => backgroundCount(runtime, sessionID) > 0,
      unread: () => read.isUnread(sessionID, current()?.updated),
    })
  }

  function childStatus(sessionID: string): RowStatus {
    return firstStatus({
      waiting: () => asking(sessionID),
      error: () => signals.state.failed[sessionID] === true || data.session.get(sessionID)?.outcome === "failed",
      running: () => data.session.status(sessionID) === "running",
      pending: () => signals.state.retry[sessionID] === true,
    })
  }

  /** Last activity: the index time, or a newer execution event seen live. */
  const updated = (sessionID: string) => Math.max(row(sessionID)?.updated ?? 0, signals.state.activity[sessionID] ?? 0)

  /**
   * A current team main, owner or area peer (06 §9.4: the registry's, never a metadata hint or an earlier
   * conversation, nor an owner whose rotation's new conversation, `owner.pending`, is a row already: the team view
   * lists that one as the owner then, sidebar/model.ts).
   */
  function teamRole(sessionID: string) {
    const place = team.placeOf(sessionID)
    if (!place || place.hint || place.previous) return undefined
    const pending = place.areaID ? team.area(place.teamID, place.areaID)?.owner.pending : undefined
    return place.role === "owner" && pending && pending !== sessionID && row(pending) ? undefined : place
  }

  /** The tightest limit window of the session's account (`quota.snapshot`, 06 §10.3), drawn as `5시간 남음 38%`. */
  function usage(sessionID: string) {
    const account = accountOf(sessionID)
    const item = account
      ? tightest(accounts.state.quota[account.id] ?? [], minuteNow(), model(sessionID)?.id)
      : undefined
    if (!item) return undefined
    return { item, level: meterLevel({ usedPercent: item.percent, status: item.status }) }
  }

  /** A waiting permission request of a team conversation, while it still waits. */
  const request = (sessionID: string, requestID: string) =>
    data.session.permission.list(sessionID)?.find((item) => item.id === requestID)

  /** Answers a request from the team view's `허락 기다리는 것 n개` (06 §10.1); `false` when the reply failed. */
  async function answer(sessionID: string, requestID: string, decision: PermissionReply) {
    if (answering().has(requestID)) return true
    setAnswering((current) => new Set([...current, requestID]))
    try {
      await data.session.permission.reply({ sessionID, requestID, decision })
      return true
    } catch (error) {
      report(error)
      return false
    } finally {
      setAnswering((current) => new Set([...current].filter((id) => id !== requestID)))
    }
  }

  /** `팀 보기` (06 §9.4): the project's team view, unfolded and out of the `보관함` view. */
  function showProject(projectID: string) {
    team.ensure()
    batch(() => {
      setSidebarArchiveView(false)
      prefs.toggleProject(projectID, false)
    })
  }

  // ---- actions
  function newSessionIn(projectID: string) {
    const view = project(projectID)
    if (view.directory) setNewSessionTarget({ serverKey, projectID, directory: view.directory, name: view.name })
    else setNewSessionTarget(undefined)
    router.navigate({ name: "project", serverKey, projectID })
  }

  function loadMore() {
    if (normalized()) return
    if (archiveView()) {
      if (flags.archivedIDs().length > archiveLimit()) setArchiveLimit((limit) => limit + ARCHIVE_PAGE)
      return
    }
    if (index.state.loading || index.state.next === null) return
    void index.loadMore().catch(() => undefined)
  }

  /** A project of the `보관함` view with sessions archived as part of it (`프로젝트 복원`, 19.11a). */
  const projectRestorable = (projectID: string) =>
    flags.archivedIDs().some((id) => flags.projectArchived(id) && row(id)?.projectID === projectID)

  // ---- pin / archive (19.11): the row `⋯` menu, one popover per tree anchored at the row that opened it
  const [menu, setMenu] = createSignal<{ readonly sessionID: string; readonly anchor: HTMLElement }>()
  const setFlag = (sessionID: string, key: FlagKey, on: boolean) => flags.set(sessionID, key, on)

  /** Visual order of session rows (Alt+↑/↓ follow what the list shows, including open subagent rows). */
  const sessionKeys = () => keys().filter((key) => key.startsWith("s|") || key.startsWith("c|"))

  return {
    serverKey,
    runtime,
    touch: input.touch,
    index,
    prefs,
    read,
    signals,
    query,
    setQuery,
    queryState: [query, setQuery] as Signal<string>,
    normalized,
    searching: () => normalized() !== "",
    serverSearching,
    tree,
    keys,
    heights,
    height: (key: string) => heightOf(key, heights()),
    virtual,
    row,
    project,
    activeID,
    isActive,
    isActiveProject,
    account,
    accountFor,
    accountsKnown,
    chip,
    accountOf,
    accountOn,
    model,
    modelName,
    switchState,
    status,
    childStatus,
    children,
    childCount,
    updated,
    setRendered,
    newSessionIn,
    loadMore,
    sessionKeys,
    flags,
    archiveView,
    pinned: flags.pinned,
    archived: flags.archived,
    list,
    collapsed,
    pinnedProject: (projectID: string) => pinnedProjects().has(projectID),
    /** Listed projects in order. */
    projectIDs: () => keys().flatMap((key) => (key.startsWith("p|") ? [parseKey(key).id] : [])),
    setFlag,
    projectRestorable,
    /** Flag writes go through `PATCH /api/session` (`prompt` scope on a gateway device, 02 §9.1). */
    canFlag: () => runtime.rpc.can("prompt"),
    /** `DELETE /api/session/:id` is `admin` on a gateway device (19.11a). */
    canDelete: () => runtime.rpc.can("admin"),
    selecting,
    setSelecting(on: boolean) {
      batch(() => {
        setSelecting(on)
        if (!on) setPicked(new Set<string>())
      })
    },
    /** Selected archived ids, in selection order. */
    selected,
    isSelected,
    toggleSelected(sessionID: string) {
      setPicked((current) => {
        const next = new Set(current)
        if (next.has(sessionID)) next.delete(sessionID)
        else next.add(sessionID)
        return next
      })
    },
    /** `모두 선택`: the archived rows the view lists now. */
    selectAll: () => setPicked(new Set(archivedShown().filter((id) => row(id) !== undefined))),
    clearSelected: () => setPicked(new Set<string>()),
    /** `⑂ name` of a worktree group (19.3): the branch checked out there when known, else the folder name. */
    worktreeLabel: (directory: string) =>
      worktreeName(directory, data.location.vcs.info({ directory })?.branch.current),
    menu,
    openMenu: (sessionID: string, anchor: HTMLElement) => setMenu({ sessionID, anchor }),
    closeMenu: () => setMenu(undefined),
    open(sessionID: string) {
      router.navigate({ name: "session", serverKey, sessionID })
    },
    team,
    /** team/view-model.ts once loaded (the team chunk): area rows' words. */
    teamView,
    teamProject: (projectID: string) => teamProjects().get(projectID),
    teamRole,
    leaseRoot,
    usage,
    request,
    answer,
    answering: (requestID: string) => answering().has(requestID),
    /** The conversation whose dock shows a request: the top of its session tree (03 §18.1). */
    rootOf: (sessionID: string) => rootOf(sessionID, (id) => data.session.get(id)?.parentID),
    showProject,
  }
}

export type SidebarController = ReturnType<typeof createSidebarController>

function report(error: unknown) {
  console.error("[own-web] sidebar team view", error)
}

/** Not archived and not an own.import helper session (09 §6: helpers are hidden on every screen). */
function visible(info: SessionInfo) {
  return typeof info.time.archived !== "number" && !isImportHelper(info.metadata)
}

/** `session.get` of a deleted (or unknown) session: the declared 404 body's tag. */
function notFound(error: unknown) {
  return error instanceof Error && error.name === "SessionNotFoundError"
}

function idle(fn: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2_000 })
  else setTimeout(fn, 0)
}

function createVisibility(): Accessor<boolean> {
  const [hidden, setHidden] = createSignal(typeof document === "object" && document.visibilityState === "hidden")
  if (typeof document !== "object") return hidden
  const listener = () => setHidden(document.visibilityState === "hidden")
  document.addEventListener("visibilitychange", listener)
  onCleanup(() => document.removeEventListener("visibilitychange", listener))
  return hidden
}

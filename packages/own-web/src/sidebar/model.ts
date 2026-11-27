// Pure sidebar logic (03 §4.3, §7.2, §7.6, §19.11): tree flattening with project and date groups (and the team view of
// a project with a team on, 06 §9.4), search matching, status priority, chip resolution, model labels, the tightest
// limit window, row windowing math and path helpers. No Solid, no DOM: unit-tested in model.test.ts and
// team-view.test.ts.
import type { Account, Limit, OwnAccounts, Switch } from "@own/protocol"
import { tone } from "@/limits/windows"
import { arrangeProjects, type ProjectListView } from "./arrange"

// ---------------------------------------------------------------------------------------------------------------
// Row keys. The tree is a flat list of string keys so `<For>` keeps row components by value when the list changes
// (R1): a status, title or chip change never rebuilds the list, and a new session adds exactly one row.

export type RowKind =
  | "project"
  | "pinned"
  | "date"
  | "worktree"
  | "session"
  | "child"
  | "more"
  | "requests"
  | "request"
  | "notices"
  | "notice"
  | "area"
  | "others"
  | "outside"
  | "import"
  | "create"

/** Fold state key of the `고정됨` group (19.11), kept with the project fold states. */
export const PINNED_GROUP = "@pinned"

/** The `others` row of a team's main folder (its id slot holds this instead of an area id). */
export const HOME_GROUP = "@home"

export const rowKey = {
  project: (projectID: string) => `p|${projectID}`,
  /** The `고정됨` group header (19.11): pinned root sessions of every project, above the project groups. */
  pinned: "g|pinned",
  date: (projectID: string, bucket: DateBucket) => `d|${projectID}|${bucket}`,
  /** A `⑂` worktree group inside a project (19.3): the worktree folder, URI-encoded so it never holds a `|`. */
  worktree: (projectID: string, directory: string) => `w|${projectID}|${encodeURIComponent(directory)}`,
  session: (sessionID: string) => `s|${sessionID}`,
  child: (sessionID: string, level: number) => `c|${sessionID}|${level}`,
  more: "m|",
  /** 06 §9.4 `허락 기다리는 것 n개` over a team project's areas. */
  requests: (projectID: string) => `q|${projectID}`,
  /** One waiting permission request of a team conversation (or of one of its subagents). */
  request: (sessionID: string, requestID: string) => `r|${sessionID}|${requestID}`,
  /** 06 §9.4, §9.7 `팀 알림 n개`: the own.team notices of a team project (repairs, folders, moves, rotations). */
  notices: (projectID: string) => `t|${projectID}`,
  /** One notice, by its event id (a ULID). */
  notice: (noticeID: string) => `n|${noticeID}`,
  /** An area row (06 §9.4); area ids are unique within a team only. */
  area: (teamID: string, areaID: string) => `a|${teamID}|${areaID}`,
  /** `이 영역의 다른 대화 n` (or the main folder's, {@link HOME_GROUP}). */
  others: (teamID: string, areaID: string) => `o|${teamID}|${areaID}`,
  /** `팀에 넣지 않은 작업 폴더 n`. */
  outside: (projectID: string) => `x|${projectID}`,
  /** 09 §6 entry 1: `다른 도구의 대화 · 새 N개 ›` at the end of an open project. */
  import: (projectID: string) => `i|${projectID}`,
  /** 06 §9.4 (2026-10-26): `영역 만들기…` after a team's areas. */
  create: (teamID: string) => `k|${teamID}`,
} as const

/** Fold keys of the team view's groups, kept with the project fold states (areas open, the rest folded, 9.4). */
export const foldKey = {
  area: (teamID: string, areaID: string) => `@area|${teamID}|${areaID}`,
  requests: (projectID: string) => `@requests|${projectID}`,
  notices: (projectID: string) => `@notices|${projectID}`,
  others: (teamID: string, areaID: string) => `@others|${teamID}|${areaID}`,
  outside: (projectID: string) => `@outside|${projectID}`,
} as const

const KINDS: Record<string, RowKind> = {
  p: "project",
  g: "pinned",
  d: "date",
  w: "worktree",
  s: "session",
  c: "child",
  m: "more",
  q: "requests",
  r: "request",
  t: "notices",
  n: "notice",
  a: "area",
  o: "others",
  x: "outside",
  i: "import",
  k: "create",
}

export interface ParsedKey {
  readonly kind: RowKind
  /**
   * projectID for project/date/requests/notices/outside/import rows, sessionID for session/child/request rows,
   * teamID for area, others and create rows, the notice id for notice rows, `pinned` for the pinned group.
   */
  readonly id: string
  /** Date bucket, child level, the worktree folder (URI-encoded), the request id, or the area id. */
  readonly extra?: string
}

export function parseKey(key: string): ParsedKey {
  const [kind = "", id = "", extra] = key.split("|")
  return { kind: KINDS[kind] ?? "more", id, extra }
}

export function isFocusable(key: string) {
  return !key.startsWith("d|") && !key.startsWith("w|")
}

// ---------------------------------------------------------------------------------------------------------------
// Date groups (19.11: 오늘 / 어제 / 이번 주 / 이전). Weeks start on Monday (ko-KR).

export type DateBucket = "today" | "yesterday" | "week" | "older"

export interface DayMarks {
  readonly today: number
  readonly yesterday: number
  readonly week: number
}

export function dayMarks(now: number): DayMarks {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const week = new Date(today)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  return { today: today.getTime(), yesterday: yesterday.getTime(), week: week.getTime() }
}

/** The bucket carried in a date row key. */
export function toBucket(value: string | undefined): DateBucket {
  return value === "today" || value === "yesterday" || value === "week" ? value : "older"
}

export function bucketOf(updated: number, marks: DayMarks): DateBucket {
  if (updated >= marks.today) return "today"
  if (updated >= marks.yesterday) return "yesterday"
  if (updated >= marks.week) return "week"
  return "older"
}

// ---------------------------------------------------------------------------------------------------------------
// Tree flattening: server → project → (date header) → session → subagent rows.

export interface TreeSession {
  readonly projectID: string
  readonly updated: number
  /** The session's folder; a team project places its sessions by it (06 §9.4). */
  readonly directory?: string
}

/** Where a root session of a team project goes in the team view (06 §9.4). */
export type TeamSlot =
  /** The team main conversation (`메인` row). */
  | { readonly kind: "main"; readonly teamID: string }
  /**
   * An area's owner conversation, listed under the area row. `replaced`: a rotation made its new conversation
   * (`owner.pending`, 06 §6.2), which is listed as the owner instead once it is a row; until then this one is.
   */
  | { readonly kind: "owner"; readonly teamID: string; readonly areaID: string; readonly replaced?: true }
  /** An area peer (동료, `area.peers`), listed after the owner, wherever its folder is: the registry places it. */
  | { readonly kind: "peer"; readonly teamID: string; readonly areaID: string; readonly key: string }
  /** Another conversation in an area's folder (`이 영역의 다른 대화 n`), earlier owners included. */
  | { readonly kind: "area"; readonly teamID: string; readonly areaID: string }
  /** Another conversation in the main folder, earlier mains included. */
  | { readonly kind: "home"; readonly teamID: string }
  /** A work folder the team leaves out (`팀에 넣지 않은 작업 폴더`). */
  | { readonly kind: "outside"; readonly directory: string }

/** A project with a team on, as the sidebar lists it (built by team/view-model.ts `teamProject`). */
export interface TeamProject {
  /**
   * In registry order: the team main, then its areas (finished ones left out), each shown with or without sessions;
   * `create`: the `영역 만들기…` row follows them (2026-10-26).
   */
  readonly teams: readonly {
    readonly teamID: string
    readonly main: string
    readonly areas: readonly string[]
    readonly create?: boolean
  }[]
  /** Permission requests that wait in the teams' conversations and their subagents (`허락 기다리는 것 n개`). */
  readonly requests: readonly { readonly sessionID: string; readonly requestID: string }[]
  /** The teams' notices that were not closed, newest first (`팀 알림 n개`, 9.7): their event ids. */
  readonly notices: readonly string[]
  /**
   * Work folders a team could take in (`[팀에 넣기]`, 8.8), listed under `팀에 넣지 않은 작업 폴더` even without
   * conversations, before the other folders the team leaves out.
   */
  readonly unadopted: readonly { readonly teamID: string; readonly directory: string }[]
  readonly slot: (sessionID: string, directory: string) => TeamSlot
}

export interface TreeInput {
  /** Root session ids, newest first (the session index order, plus server search hits while searching). */
  readonly order: readonly string[]
  readonly session: (sessionID: string) => TreeSession | undefined
  readonly collapsed: (projectID: string) => boolean
  readonly expanded: (sessionID: string) => boolean
  /** Known descendants of a root in display order, with their depth below it (1 = direct child). */
  readonly children: (sessionID: string) => readonly { readonly id: string; readonly level: number }[]
  /** Present while searching: projects open, no date headers, no subagent rows, no pinned group. */
  readonly match?: (sessionID: string) => boolean
  readonly marks: DayMarks
  /** The server has older sessions (index cursor), or the archive view has rows left to load. */
  readonly more: boolean
  /** 19.11: pinned sessions leave their project for the `고정됨` group at the top (not while searching). */
  readonly pinned?: (sessionID: string) => boolean
  /** 19.11: archived sessions stay out of the list (not while searching, where they are tagged instead). */
  readonly hidden?: (sessionID: string) => boolean
  /** Date headers inside projects (19.11); off in the archive view, which is ordered by archive time. */
  readonly dates?: boolean
  /**
   * 19.3 `⑂` groups: the worktree folder a root session works in (`undefined` = the project folder). Its sessions
   * follow the project's own sessions under a `⑂ name` header, newest group first (not while searching).
   */
  readonly worktree?: (sessionID: string) => string | undefined
  /**
   * 06 §9.4: a project with a team on lists the team instead of its `⑂` groups (not while searching): requests,
   * notices, the team main, the main folder's other conversations, every area with its owner, its peers (동료) and
   * other conversations, then the work folders the team leaves out. Areas, requests and notices are open by default,
   * the other groups folded (`foldKey`).
   */
  readonly team?: (projectID: string) => TeamProject | undefined
  /**
   * 09 §6 entry 1: an open project ends with `다른 도구의 대화 · 새 N개 ›` while this answers true (its N is above 0,
   * import/store.ts). Not while searching.
   */
  readonly imports?: (projectID: string) => boolean
  /** 03 §5.1: the project listed first (after `고정됨`): the server's 기본 대화 폴더, shown as `폴더 없는 대화`. */
  readonly leading?: string
  /** 03 §4.3 순서와 고정: the user's pinned projects and order (./arrange.ts); off in the archive view. */
  readonly list?: ProjectListView
}

export interface TreeOutput {
  readonly keys: readonly string[]
  /** Root session rows in the list (the virtualization threshold counts these, 03 §20.2 R2). */
  readonly sessions: number
  /**
   * projectID (or `PINNED_GROUP`) → root sessions listed under it; a team view's group row key (requests, others,
   * outside) → what it counts.
   */
  readonly counts: Readonly<Record<string, number>>
  /** `aria-posinset` / `aria-setsize` of group and session rows (rows outside the window are not in the DOM). */
  readonly positions: ReadonlyMap<string, readonly [position: number, size: number]>
  /** `aria-level` of rows below the usual depth (the team view's nested groups); absent: the row kind's own. */
  readonly levels: ReadonlyMap<string, number>
}

export function flattenTree(input: TreeInput): TreeOutput {
  const searching = input.match !== undefined
  const groups = new Map<string, string[]>()
  const pinned: string[] = []
  for (const id of input.order) {
    const session = input.session(id)
    if (!session) continue
    if (input.match && !input.match(id)) continue
    if (!searching && input.hidden?.(id)) continue
    if (!searching && input.pinned?.(id)) {
      pinned.push(id)
      continue
    }
    const group = groups.get(session.projectID)
    if (group) group.push(id)
    else groups.set(session.projectID, [id])
  }
  const keys: string[] = []
  const counts: Record<string, number> = {}
  const positions = new Map<string, readonly [number, number]>()
  const levels = new Map<string, number>()
  const size = groups.size + (pinned.length ? 1 : 0)
  let sessions = 0
  let position = 0
  /** Session rows (with their open subagent rows) at `level`; 2 is a project's own level. */
  const list = (ids: readonly string[], level = 2) =>
    ids.forEach((id, index) => {
      const key = rowKey.session(id)
      keys.push(key)
      positions.set(key, [index + 1, ids.length])
      if (level !== 2) levels.set(key, level)
      sessions++
      if (searching || !input.expanded(id)) return
      for (const child of input.children(id)) {
        const childKey = rowKey.child(child.id, child.level)
        keys.push(childKey)
        if (level !== 2) levels.set(childKey, level + child.level)
      }
    })
  /** A folded team group (`이 영역의 다른 대화 n`, …): its row, then its sessions one level deeper while open. */
  const folded = (row: string, fold: string, ids: readonly string[], level: number) => {
    if (!ids.length) return
    keys.push(row)
    counts[row] = ids.length
    if (level !== 2) levels.set(row, level)
    if (input.expanded(fold)) list(ids, level + 1)
  }
  /** A team group that is open by default (`허락 기다리는 것 n개`, `팀 알림 n개`): its row, then its items. */
  const openGroup = (row: string, fold: string, items: readonly string[]) => {
    if (!items.length) return
    keys.push(row)
    counts[row] = items.length
    if (input.collapsed(fold)) return
    items.forEach((key) => {
      keys.push(key)
      levels.set(key, 3)
    })
  }
  /** 06 §9.4: requests, notices, then per team its main, the main folder's other sessions and the areas; the rest. */
  const team = (projectID: string, ids: readonly string[], project: TeamProject) => {
    openGroup(
      rowKey.requests(projectID),
      foldKey.requests(projectID),
      project.requests.map((request) => rowKey.request(request.sessionID, request.requestID)),
    )
    openGroup(
      rowKey.notices(projectID),
      foldKey.notices(projectID),
      project.notices.map((id) => rowKey.notice(id)),
    )
    const slots = ids.map((id) => ({ id, slot: project.slot(id, input.session(id)?.directory ?? "") }))
    const of = (match: (slot: TeamSlot) => boolean) => slots.filter((item) => match(item.slot)).map((item) => item.id)
    const replaced = new Set(of((slot) => slot.kind === "owner" && slot.replaced === true))
    for (const current of project.teams) {
      const teamID = current.teamID
      list(of((slot) => slot.kind === "main" && slot.teamID === teamID))
      folded(
        rowKey.others(teamID, HOME_GROUP),
        foldKey.others(teamID, HOME_GROUP),
        of((slot) => slot.kind === "home" && slot.teamID === teamID),
        2,
      )
      for (const areaID of current.areas) {
        keys.push(rowKey.area(teamID, areaID))
        if (input.collapsed(foldKey.area(teamID, areaID))) continue
        const placed = (kind: "owner" | "peer" | "area") =>
          of(
            (slot) =>
              (slot.kind === "owner" || slot.kind === "peer" || slot.kind === "area") &&
              slot.kind === kind &&
              slot.teamID === teamID &&
              slot.areaID === areaID,
          )
        // The owner, its peers (동료), then the area's other conversations. A rotation's new conversation is the owner
        // once it is listed; the one it replaces then goes with the others (RH-50: both are `<영역> · 담당`).
        const owners = placed("owner")
        const standing = owners.filter((id) => !replaced.has(id))
        const shown = standing.length > 0 ? standing : owners
        list([...shown, ...placed("peer")], 3)
        folded(
          rowKey.others(teamID, areaID),
          foldKey.others(teamID, areaID),
          [...owners.filter((id) => !shown.includes(id)), ...placed("area")],
          3,
        )
      }
      if (current.create) keys.push(rowKey.create(teamID))
    }
    // Folders the team could take in come first, also without conversations (8.8); then the others with conversations.
    const outside = new Map<string, string[]>(project.unadopted.map((item) => [item.directory, []]))
    for (const item of slots) {
      if (item.slot.kind !== "outside") continue
      const directory = item.slot.directory
      const known = [...outside.keys()].find((folder) => samePath(folder, directory)) ?? directory
      outside.set(known, [...(outside.get(known) ?? []), item.id])
    }
    if (!outside.size) return
    const row = rowKey.outside(projectID)
    keys.push(row)
    counts[row] = outside.size
    if (!input.expanded(foldKey.outside(projectID))) return
    for (const [directory, members] of outside) {
      keys.push(rowKey.worktree(projectID, directory))
      list(members, 3)
    }
  }
  if (pinned.length) {
    // Pinned rows come from anywhere in the order (older pinned sessions are fetched on their own): newest first.
    const ids = pinned.toSorted((a, b) => (input.session(b)?.updated ?? 0) - (input.session(a)?.updated ?? 0))
    keys.push(rowKey.pinned)
    positions.set(rowKey.pinned, [++position, size])
    counts[PINNED_GROUP] = ids.length
    if (!input.collapsed(PINNED_GROUP)) list(ids)
  }
  const ordered = arrangeProjects([...groups.keys()], {
    leading: input.leading,
    list: input.list,
    updated: (projectID) => input.session(groups.get(projectID)![0]!)!.updated,
  })
  for (const projectID of ordered) {
    const all = groups.get(projectID)!
    keys.push(rowKey.project(projectID))
    positions.set(rowKey.project(projectID), [++position, size])
    counts[projectID] = all.length
    if (!searching && input.collapsed(projectID)) continue
    const project = searching ? undefined : input.team?.(projectID)
    if (project) {
      team(projectID, all, project)
      if (input.imports?.(projectID)) keys.push(rowKey.import(projectID))
      continue
    }
    // 19.3: sessions in a worktree leave the project's own list for their `⑂` group, listed after it.
    const worktrees = new Map<string, string[]>()
    const ids = searching || !input.worktree ? all : []
    if (ids !== all)
      for (const id of all) {
        const directory = input.worktree!(id)
        if (directory === undefined) ids.push(id)
        else worktrees.set(directory, [...(worktrees.get(directory) ?? []), id])
      }
    const buckets =
      searching || input.dates === false
        ? undefined
        : ids.map((id) => bucketOf(input.session(id)!.updated, input.marks))
    const dated = buckets !== undefined && new Set(buckets).size > 1
    if (!dated) list(ids)
    else {
      let last: DateBucket | undefined
      ids.forEach((id, index) => {
        const bucket = buckets[index]!
        if (bucket !== last) {
          keys.push(rowKey.date(projectID, bucket))
          last = bucket
        }
        keys.push(rowKey.session(id))
        positions.set(rowKey.session(id), [index + 1, ids.length])
        sessions++
        if (!input.expanded(id)) return
        for (const child of input.children(id)) keys.push(rowKey.child(child.id, child.level))
      })
    }
    for (const [directory, members] of worktrees) {
      keys.push(rowKey.worktree(projectID, directory))
      list(members)
    }
    if (!searching && input.imports?.(projectID)) keys.push(rowKey.import(projectID))
  }
  if (input.more && !searching) keys.push(rowKey.more)
  return { keys, sessions, counts, positions, levels }
}

/** A row's `aria-level`: what the tree set for nested team rows, else its kind's own (03 §11). */
export function levelOf(key: string, levels: ReadonlyMap<string, number>) {
  const set = levels.get(key)
  if (set !== undefined) return set
  const parsed = parseKey(key)
  if (parsed.kind === "child") return 2 + Number(parsed.extra ?? 1)
  if (parsed.kind === "project" || parsed.kind === "pinned" || parsed.kind === "more") return 1
  if (parsed.kind === "request") return 3
  return 2
}

/** Descendants of a root from a family list (createData `session.family`), depth-first, newest first per level. */
export function orderFamily(
  rootID: string,
  family: readonly string[],
  info: (sessionID: string) => { readonly parentID?: string; readonly updated: number } | undefined,
  maxLevel = 3,
) {
  const byParent = new Map<string, string[]>()
  for (const id of family) {
    if (id === rootID) continue
    const parent = info(id)?.parentID
    if (!parent) continue
    const list = byParent.get(parent)
    if (list) list.push(id)
    else byParent.set(parent, [id])
  }
  const out: { id: string; level: number }[] = []
  const visit = (parent: string, level: number) => {
    const list = byParent.get(parent)
    if (!list) return
    for (const id of list.toSorted((a, b) => (info(b)?.updated ?? 0) - (info(a)?.updated ?? 0))) {
      out.push({ id, level: Math.min(level, maxLevel) })
      visit(id, level + 1)
    }
  }
  visit(rootID, 1)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Search (03 §4.3 "검색 입력", 19.11 "검색창에 세션 ID 붙여넣기").

export function normalizeQuery(value: string) {
  return value.normalize("NFC").trim().toLocaleLowerCase()
}

/** `query` must already be normalized. Matches the title or the session id. */
export function matchesQuery(query: string, title: string | undefined, sessionID: string) {
  if (!query) return true
  if (sessionID.toLowerCase() === query) return true
  return (title ?? "").normalize("NFC").toLocaleLowerCase().includes(query)
}

/** Same test as upstream `looksLikeSessionID` (packages/app/src/session/search.ts). */
export function looksLikeSessionID(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 20 && trimmed.startsWith("ses_") && !/\s/.test(trimmed)
}

/**
 * The session id in a pasted value (19.11): the id itself, or one inside a copied link or route
 * (`…/srv/local/s/ses_…`, `/s/ses_…`, `?session=ses_…`). `undefined` when the value holds no id.
 */
export function sessionIDIn(value: string) {
  const trimmed = value.trim()
  if (looksLikeSessionID(trimmed)) return trimmed
  if (!trimmed.includes("ses_") || /\s/.test(trimmed)) return undefined
  const found = /(?:^|[/=#?&])(ses_[A-Za-z0-9]+)(?:$|[/?#&])/.exec(trimmed)?.[1]
  return found && looksLikeSessionID(found) ? found : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Status symbol (03 §7.6): one per row, by priority ? > ! > ● > ◐ > ↶ > ⧗ > • > ○.

export type RowStatus = "waiting" | "error" | "running" | "pending" | "revert" | "background" | "unread" | "idle"

export const STATUS_ORDER: readonly RowStatus[] = [
  "waiting",
  "error",
  "running",
  "pending",
  "revert",
  "background",
  "unread",
  "idle",
]

export const STATUS_SYMBOL: Readonly<Record<RowStatus, string>> = {
  waiting: "?",
  error: "!",
  running: "●",
  pending: "◐",
  revert: "↶",
  background: "⧗",
  unread: "•",
  idle: "○",
}

export function pickStatus(flags: Partial<Record<RowStatus, boolean>>): RowStatus {
  return STATUS_ORDER.find((status) => flags[status]) ?? "idle"
}

/**
 * Lazy form of `pickStatus` for reactive rows: checks run in `STATUS_ORDER` and stop at the first hit, so a running
 * row does not subscribe to the sources of lower-priority symbols. Missing checks count as false.
 */
export function firstStatus(checks: Partial<Record<RowStatus, () => boolean>>): RowStatus {
  for (const status of STATUS_ORDER) if (checks[status]?.()) return status
  return "idle"
}

// ---------------------------------------------------------------------------------------------------------------
// Row heights (13.4: 52 / 32 compact; 4.2.2: 44 px targets for coarse pointers). Fixed per kind, set as the row's
// height, so windowing never measures.

export interface RowHeights {
  readonly project: number
  readonly date: number
  readonly session: number
  readonly child: number
  readonly more: number
}

export function rowHeights(density: "comfortable" | "compact", touch: boolean): RowHeights {
  return {
    project: touch ? 44 : 30,
    date: 24,
    session: density === "compact" ? (touch ? 44 : 32) : touch ? 60 : 52,
    child: touch ? 44 : 30,
    more: touch ? 44 : 34,
  }
}

export function heightOf(key: string, heights: RowHeights) {
  switch (key[0]) {
    case "p":
    case "g":
      return heights.project
    case "d":
    case "w":
      return heights.date
    case "s":
    case "a":
    case "r":
    case "n":
      return heights.session
    case "c":
    case "q":
    case "t":
    case "o":
    case "x":
    case "i":
    case "k":
      return heights.child
    default:
      return heights.more
  }
}

/** Switch states that hold the session: waiting for a safe point, compacting first, scheduled, or blocked. */
export function switchHolds(state: Switch.State | undefined) {
  if (!state) return false
  return (
    state.state === "WAIT_SAFE" ||
    state.state === "COMPACTING" ||
    state.state === "SWITCHING" ||
    state.state === "SCHEDULED" ||
    state.state === "BLOCKED"
  )
}

export interface SwitchNote {
  readonly kind: "pending" | "scheduled"
  readonly target: { readonly providerID: string; readonly id: string }
  /** The Claude account the switch lands on, as its record names it (SL-17). */
  readonly accountID?: string
}

/** 4.3: `→ model @ account` while a switch waits, `⇄ 예약 account` while one is scheduled. */
export function switchNote(state: Switch.State | undefined): SwitchNote | undefined {
  if (!state) return undefined
  const named = "accountID" in state && state.accountID ? { accountID: state.accountID } : {}
  if (state.state === "WAIT_SAFE" || state.state === "COMPACTING" || state.state === "SWITCHING")
    return { kind: "pending", target: state.target, ...named }
  if (state.state === "SCHEDULED") return { kind: "scheduled", target: state.target, ...named }
  return undefined
}

/** Account states that show on the row: `!` for broken credentials, `◐` for a used-up limit. */
export function accountProblem(status: Account.Status | undefined): "error" | "pending" | undefined {
  if (status === "auth_failed" || status === "needs_reauth" || status === "misconfigured") return "error"
  if (status === "exhausted") return "pending"
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Account chip (03 §1 "계정 칩", 5.2.1): router account, built-in provider ("전역 계정"), or unpinned.

export interface AccountLike {
  readonly id: string
  readonly providerID: string
  readonly label: string
  readonly shortLabel: string
  readonly color: Account.Color
  readonly thirdParty: boolean
  readonly status: Account.Status
  readonly lastUsedAt?: number | null
}

export type ChipView =
  | { readonly kind: "account"; readonly account: AccountLike; readonly problem: boolean }
  | { readonly kind: "builtin"; readonly provider: string }
  | { readonly kind: "unpinned" }
  /** Accounts are not known yet (first start without a saved account list). */
  | { readonly kind: "loading" }

export interface ChipInput {
  readonly binding?: OwnAccounts.Binding
  /** `SessionInfo.model`; `undefined` means unpinned when `known` (01 §8.5). */
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly known: boolean
  readonly account: (accountID: string) => AccountLike | undefined
  readonly accountFor: (providerID: string) => AccountLike | undefined
  /** An account list (live or saved) is available, so an unmatched provider is a built-in one. */
  readonly accountsKnown: boolean
}

export function chipView(input: ChipInput): ChipView {
  const binding = input.binding
  if (binding) {
    if (!binding.model) return { kind: "unpinned" }
    const account = binding.accountID ? input.account(binding.accountID) : input.accountFor(binding.model.providerID)
    if (account) return { kind: "account", account, problem: accountProblem(account.status) === "error" }
    if (binding.builtin || input.accountsKnown) return { kind: "builtin", provider: binding.model.providerID }
    return { kind: "loading" }
  }
  if (!input.model) return input.known ? { kind: "unpinned" } : { kind: "loading" }
  const account = input.accountFor(input.model.providerID)
  if (account) return { kind: "account", account, problem: accountProblem(account.status) === "error" }
  return input.accountsKnown ? { kind: "builtin", provider: input.model.providerID } : { kind: "loading" }
}

// ---------------------------------------------------------------------------------------------------------------
// Model short name: the catalog name when known, otherwise a readable form of the id ("gpt-5.6-sol" → "GPT-5.6 Sol").

const UPPER = new Set(["gpt", "glm", "qwq"])

export function modelLabel(id: string, name?: string) {
  if (name && name !== id) return name
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id
  const parts = base.split(/[-_\s]+/).filter((part) => part && !/^\d{6,}$/.test(part))
  const words: string[] = []
  for (const part of parts) {
    const previous = words.at(-1)
    if (/^\d{1,2}$/.test(part) && previous && /\d$/.test(previous) && !previous.includes(".")) {
      words[words.length - 1] = `${previous}.${part}`
      continue
    }
    if (/^\d/.test(part) && previous && UPPER.has(previous.toLowerCase()) && !previous.includes("-")) {
      words[words.length - 1] = `${previous.toUpperCase()}-${part}`
      continue
    }
    if (UPPER.has(part.toLowerCase())) words.push(part.toUpperCase())
    else if (/^[a-z]{3,}$/.test(part)) words.push(part[0]!.toUpperCase() + part.slice(1))
    else words.push(part)
  }
  return words.join(" ") || id
}

// ---------------------------------------------------------------------------------------------------------------
// Limits (7.2): the mini meter shows the tightest window (src/limits/windows `tightest`) in these colors.

export type MeterLevel = "ok" | "warn" | "danger"

/** 7.2 colors (src/limits/windows `tone`, keyed on what remains: 30 % left warns, 10 % or exhausted is danger). */
export function meterLevel(window: Pick<Limit.Window, "usedPercent" | "status">): MeterLevel {
  const level = tone(window.usedPercent ?? 0, window.status)
  return level === "neutral" ? "ok" : level
}

/** 4.3 "사용 중 계정": accounts used in the last 24 hours, most recent first, at most three. */
export function accountsInUse<T extends Pick<AccountLike, "lastUsedAt" | "status">>(
  accounts: readonly T[],
  now: number,
  limit = 3,
) {
  return accounts
    .filter((account) => account.status !== "retired" && (account.lastUsedAt ?? 0) >= now - 24 * 60 * 60_000)
    .toSorted((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, limit)
}

// ---------------------------------------------------------------------------------------------------------------
// Row windowing (R2): fixed heights per row kind, so offsets are exact and nothing is measured while scrolling.

export function offsetsOf(heights: readonly number[]) {
  const offsets = new Float64Array(heights.length + 1)
  for (let index = 0; index < heights.length; index++) offsets[index + 1] = offsets[index]! + heights[index]!
  return offsets
}

/** Rows intersecting [top, bottom): `[start, end)`. */
export function rangeOf(offsets: Float64Array, top: number, bottom: number): [number, number] {
  const count = offsets.length - 1
  if (count <= 0) return [0, 0]
  const start = Math.max(0, Math.min(count - 1, upper(offsets, Math.max(0, top)) - 1))
  const end = Math.max(start + 1, Math.min(count, lower(offsets, bottom)))
  return [start, end]
}

/** First index with offsets[i] > value. */
function upper(offsets: Float64Array, value: number) {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid]! <= value) low = mid + 1
    else high = mid
  }
  return low
}

/** First index with offsets[i] >= value. */
function lower(offsets: Float64Array, value: number) {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid]! < value) low = mid + 1
    else high = mid
  }
  return low
}

// ---------------------------------------------------------------------------------------------------------------
// Paths (18.3 folder picker). Server paths may be Windows or POSIX, independent of the browser's platform.

export function pathSep(path: string): "\\" | "/" {
  return /^[A-Za-z]:/.test(path) || path.includes("\\") ? "\\" : "/"
}

export function isAbsolutePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")
}

export function trimSep(path: string) {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return `${path.slice(0, 2)}\\`
  if (path === "/") return path
  return path.replace(/[\\/]+$/, "")
}

export function baseName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export function parentPath(path: string): string | undefined {
  const trimmed = trimSep(path)
  if (/^[A-Za-z]:\\$/.test(trimmed) || trimmed === "/") return undefined
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  if (index < 0) return undefined
  const parent = trimmed.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent || "/"
}

export function joinPath(directory: string, name: string) {
  const sep = pathSep(directory)
  const base = trimSep(directory)
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`
}

/** Drive roots (`C:\`) or `/` of the given absolute paths, in first-seen order. */
export function rootsOf(paths: readonly string[]) {
  const roots: string[] = []
  for (const path of paths) {
    const drive = /^([A-Za-z]):/.exec(path)?.[1]
    const root = drive ? `${drive.toUpperCase()}:\\` : path.startsWith("/") ? "/" : undefined
    if (root && !roots.includes(root)) roots.push(root)
  }
  return roots
}

/** Case-insensitive on Windows paths (drive letters differ in case between sources, 03 §16.3). */
export function samePath(a: string, b: string) {
  const left = trimSep(a)
  const right = trimSep(b)
  return pathSep(left) === "\\" ? left.toLowerCase() === right.toLowerCase() : left === right
}

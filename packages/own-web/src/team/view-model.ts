// The sidebar's team view and the area menu's choices (06 §9.4, §10.1, §10.3; 07 §7.4). Pure; the callers pass store
// values:
// - `teamProject`: where each root conversation of a project with a team on goes (the team main, an area's owner, an
//   area's peer (동료, `area.peers`, under the owner wherever its folder is), another conversation in an area's
//   folder, the main folder, or a work folder the team leaves out) and the permission requests that wait across the
//   team's conversations (`허락 기다리는 것 n개`). Places come from the
//   registry only: session metadata `own.team` is a hint for other screens, never a place in this view (9.4). The
//   teams' notices that were not closed (`팀 알림 n개`, 9.7: repairs, large-file folders, moves, rotations, followed
//   records and folders, stopped areas, waiting integrations) go above the team main, newest first. The work folders
//   the team could take in (`team.external` `left`, 8.8) are listed under `팀에 넣지 않은 작업 폴더` with or without
//   conversations, each with `[팀에 넣기]` (`area.adopt`).
// - `areaRow`: an area row's words: label, short path, `메인: …`, `프리셋: …` and the status word (9.1, 9.4), the
//   retire signal `끝낼 수 있음` (8.1) and, for an area whose folder is gone, its `[다시 만들기] [끝내기]` (8.8).
// - `areaActions`: the area menu's items in order, each only where this build of own.team has its feature
//   (`health.features`) and this connection its scope, so T2 and T3 items stay hidden until a build has them.
// - 영역 만들기 (2026-10-26): `newAreaProposal` with the user's folder and record name, starting point, model,
//   에이전트 방식 and the user-made mark, `adoptAreaProposal` for an existing folder, `createFolders` (the folders it may
//   take), `freeSlug` / `slugValid`, and `teamProject`'s `create` per team (the view's `영역 만들기…` row).
// - `renameProposal`, `newAreaProposal`, `splitProposal`, `mergeProposal`, `retireProposal`, `recreateProposal`,
//   `convertProposal`, `moveProposal`: the user's own reorganizations (이름 바꾸기, 새 영역, 나누기, 영역 묶기, 영역
//   끝내기, 다시 만들기, 파일 모양 바꾸기, 대화 옮기기, 8.2, 8.8), each one op of a `reorg.apply{teamID, proposal}` (2.7,
//   by `user`).
// - `moveCandidates`: the conversations 대화 옮기기 offers for an area.
// - `peerForm`, `peerAddInput`, `peerEditInput`: the peer forms (동료 추가…, 동료로 등록…, 역할 바꾸기…) and the
//   `area.peer.add` / `area.peer.edit` inputs they send (2.7, 2026-10-09).
// - `areaTalkers`, `noteForm`: the area menu's `팀과 이야기하는 대화` group (the owner first, then the peers, each with
//   its note) and the owner note's editor (`area.edit{note}`, 담당 대화 바꾸기, 2026-11-12).
// - `worstWith`: the team's worst case of concurrent runs with one area on another preset (10.3, 07 §7.4).
// Loaded with the team chunk (team/model.ts and its strings): the sidebar imports it once a server has a team on.
import type { PermissionRequest } from "@opencode/client"
import type { Model } from "@opencode/schema/model"
import type { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import type { SessionRow } from "@/data/session-cache"
import type { TeamInput } from "@/data/team-rpc"
import { formatBytes } from "@/files/strings"
import { translate, type Locale } from "@/i18n"
import { coming } from "@/limits/format"
import { baseName, parentPath, pathSep, samePath, trimSep } from "@/projects/path"
import type { TeamProject, TeamSlot } from "@/sidebar/model"
import { isInside } from "@/worktree/model"
import {
  areaStatus,
  mainLine,
  noticeText,
  presetLine,
  worstCase,
  type RunningOn,
  type TeamText,
  type TeamTime,
  type WorstArea,
} from "./model"
import type { SessionPlace, TeamEntry, TeamNotice } from "./store"
import { teamText } from "./strings"

/**
 * The team view of one project (06 §9.4). Clones of one remote share a project id and each has its own team (3.2),
 * so a project may hold several. A folder inside another one (an area under the main folder, a work folder of
 * another tool) belongs to the deepest: areas, the folders the team leaves out (`team.external`, the project's other
 * worktrees), then the main folder. Anything else is a work folder outside the team.
 */
export function teamProject(input: {
  readonly entries: readonly TeamEntry[]
  /** The project's worktrees, when a view loaded them (worktree/state.ts). */
  readonly worktrees?: readonly string[]
  /** Known sessions of a root's tree, the root included (createData `session.family`). */
  readonly family: (sessionID: string) => readonly string[]
  /** Pending permission requests of a session (createData `session.permission.list`). */
  readonly permissions: (sessionID: string) => readonly Pick<PermissionRequest, "id" | "sessionID">[] | undefined
  /** The server's notices that were not closed, newest first (TeamStore `notices`). */
  readonly notices: readonly Pick<TeamNotice, "id" | "teamID">[]
  /** 영역 만들기 (2026-10-26): this build of own.team makes areas and this connection may; absent = no row. */
  readonly creates?: boolean
}): TeamProject {
  const teams = input.entries.map((entry) => ({
    entry,
    areas: entry.order.flatMap((id) => {
      const area = entry.areas[id]
      return area && area.state !== "retired" ? [area] : []
    }),
  }))
  const known = new Map<string, TeamSlot>(
    teams.flatMap(
      ({ entry, areas }): Array<[string, TeamSlot]> => [
        // Peers first, so the main or an owner wins if the registry ever listed one as a peer too.
        ...areas.flatMap((area) =>
          (area.peers ?? []).map((peer): [string, TeamSlot] => [
            peer.sessionID,
            { kind: "peer", teamID: entry.team.id, areaID: area.id, key: peer.key },
          ]),
        ),
        [entry.team.main.sessionID, { kind: "main", teamID: entry.team.id }],
        // The pending owner is the new conversation of a rotation (6.2): it is the area's owner from its creation on.
        // The one it replaces is `replaced` until the swap: the tree lists it with the area's other conversations
        // once the new one is listed (both are titled `<영역> · 담당`, and the area showed two owners, RH-50).
        ...areas.flatMap((area): Array<[string, TeamSlot]> => {
          const owner = (replaced: boolean): TeamSlot => ({
            kind: "owner",
            teamID: entry.team.id,
            areaID: area.id,
            ...(replaced ? { replaced: true } : {}),
          })
          const current = area.owner.sessionID
          const pending = area.owner.pending
          return [
            ...(current ? [[current, owner(!!pending && pending !== current)] satisfies [string, TeamSlot]] : []),
            ...(pending ? [[pending, owner(false)] satisfies [string, TeamSlot]] : []),
          ]
        }),
      ],
    ),
  )
  const homes = teams.map(({ entry }) => entry.team.home.directory)
  const areaFolders = teams.flatMap(({ areas }) => areas.map((area) => area.directory))
  const folders = [
    ...teams.flatMap(({ entry, areas }) =>
      areas.map((area) => ({
        directory: area.directory,
        slot: { kind: "area", teamID: entry.team.id, areaID: area.id } satisfies TeamSlot,
      })),
    ),
    ...[
      ...teams.flatMap(({ entry }) => entry.team.external.map((item) => item.directory)),
      ...(input.worktrees ?? []).filter(
        (directory) => ![...homes, ...areaFolders].some((folder) => samePath(folder, directory)),
      ),
    ].map((directory) => ({ directory, slot: { kind: "outside", directory } satisfies TeamSlot })),
    ...teams.map(({ entry }) => ({
      directory: entry.team.home.directory,
      slot: { kind: "home", teamID: entry.team.id } satisfies TeamSlot,
    })),
  ].toSorted((a, b) => trimSep(b.directory).length - trimSep(a.directory).length)

  const roots = [...known.keys()]
  const requests = roots
    .flatMap((root) => [root, ...input.family(root).filter((id) => id !== root)])
    .flatMap((sessionID) =>
      (input.permissions(sessionID) ?? []).map((request) => ({ sessionID: request.sessionID, requestID: request.id })),
    )
    .filter((item, index, all) => all.findIndex((other) => other.requestID === item.requestID) === index)

  return {
    teams: teams.map(({ entry, areas }) => ({
      teamID: entry.team.id,
      main: entry.team.main.sessionID,
      areas: areas.map((area) => area.id),
      ...(input.creates ? { create: true } : {}),
    })),
    // 8.8: an active folder the judge or reconcile left out is one the team could take in; the others (the primary
    // checkout, other tools' folders, `#` paths, prunable ones) stay outside for good (`path_forbidden`). A folder
    // that is an area now (팀에 넣기 done, `team.external` not yet reconciled) is not offered again.
    unadopted: teams.flatMap(({ entry, areas }) =>
      entry.team.external
        .filter((item) => item.why === "left" && !areas.some((area) => samePath(area.directory, item.directory)))
        .map((item) => ({ teamID: entry.team.id, directory: item.directory })),
    ),
    requests,
    notices: input.notices
      .filter((notice) => teams.some(({ entry }) => entry.team.id === notice.teamID))
      .map((notice) => notice.id),
    slot(sessionID, directory) {
      return (
        known.get(sessionID) ??
        folders.find((folder) => isInside(folder.directory, directory))?.slot ?? { kind: "outside", directory }
      )
    },
  }
}

/** What an area row shows (06 §9.4): `cl-cu · 컴퓨터 사용 · 담당`, `.worktrees\cl-cu`, the main and preset lines. */
export interface AreaRow {
  readonly label: string
  /** The owner seat's alias (별칭, 2026-11-27), shown before the label where it fits. Absent otherwise. */
  readonly alias?: string
  readonly path: string
  readonly main: string
  readonly preset: string
  /** The preset is the group's `평소대로`: the row dims its line (9.4). */
  readonly builtin: boolean
  readonly status: ReturnType<typeof areaStatus>
  /** `끝낼 수 있음` (8.1): the service's retire signal, beside the status word. Absent otherwise. */
  readonly retirable?: string
  /**
   * `[다시 만들기]` of an area whose folder is gone (8.8 `찾을 수 없음 [다시 만들기] [끝내기]`): opens 다시 만들기, a new
   * area from its record. Absent otherwise.
   */
  readonly recreate?: string
  /** `[끝내기]` of an area whose folder is gone (8.8 `찾을 수 없음 [끝내기]`): opens 영역 끝내기. Absent otherwise. */
  readonly finish?: string
  /** `내가 정한 영역` (2026-10-26): the user set the area up. Absent otherwise. */
  readonly userMade?: string
}

/**
 * An area row's words (06 §9.1, §9.4). Adopted areas carry their folder's name and the judge's name as the subtitle
 * (3.7). An area that follows the team says `메인: 팀과 같게` without repeating the team main's model. An active area
 * the service marks retirable says `끝낼 수 있음`; one whose folder is gone (`missing`) offers `[다시 만들기]` where
 * this build makes areas and this connection may (`recreate`, 8.8: a new area from its record) and `[끝내기]` where it
 * retires them (`retire`).
 */
export function areaRow(
  text: TeamText,
  area: Pick<
    OwnTeam.AreaView,
    "name" | "subtitle" | "directory" | "state" | "broken" | "status" | "paused" | "retirable" | "userMade" | "owner"
  >,
  input: {
    /** The team's main folder: area folders inside it show their path from there. */
    readonly home: string
    /** Main requests that wait for the area (its outbox). */
    readonly waiting: number
    /** The area's own main (`area.main`), named; absent: it follows the team. */
    readonly main?: RunningOn
    readonly preset: { readonly name: string; readonly builtin: boolean }
    readonly now?: number
    /** A coming time as the screen words it (the status's `한도 대기 · … 풀림`). */
    readonly time?: TeamTime
    /** This build of own.team retires areas (`reorg.retire`) and this connection may (`reorg.apply`). */
    readonly retire?: boolean
    /** This build of own.team makes areas (`reorg.new`) and this connection may (`reorg.apply`). */
    readonly recreate?: boolean
  },
): AreaRow {
  const missing = isMissing(area)
  return {
    label: [area.name, area.subtitle, text("own.team.role.owner")].filter(Boolean).join(" · "),
    ...(area.owner.alias ? { alias: area.owner.alias } : {}),
    path: shortPath(area.directory, input.home),
    main: mainLine(text, input.main),
    preset: presetLine(text, input.preset.name),
    builtin: input.preset.builtin,
    status: areaStatus(text, area, input.waiting, input.now, input.time),
    ...(area.state === "active" && area.retirable ? { retirable: text("own.team.status.retirable") } : {}),
    ...(missing && input.recreate ? { recreate: text("own.team.action.recreate") } : {}),
    ...(missing && input.retire ? { finish: text("own.team.action.finish") } : {}),
    ...(area.userMade ? { userMade: text("own.team.areaMenu.userMade") } : {}),
  }
}

/** An area whose folder is gone (8.8 `찾을 수 없음`). */
function isMissing(area: Pick<OwnTeam.AreaView, "state" | "broken">) {
  return area.state === "broken" && area.broken?.why === "missing"
}

/** A folder as the team view names it (9.1): its path from the main folder when inside it, else `<parent>\<name>`. */
export function shortPath(directory: string, home: string) {
  const folder = trimSep(directory)
  if (isInside(home, folder) && !samePath(home, folder))
    return folder.slice(trimSep(home).length).replace(/^[\\/]+/, "")
  const parent = parentPath(folder)
  return parent ? `${baseName(parent)}${pathSep(folder)}${baseName(folder)}` : folder
}

/** The area menu's items (06 §9.4); the menu shows them in {@link AREA_GROUPS}. */
export type AreaAction =
  | "open"
  | "discuss"
  | "addPeer"
  | "handBack"
  | "pause"
  | "outbox"
  | "rotate"
  | "main"
  | "preset"
  | "role"
  | "alias"
  | "userMade"
  | "paths"
  | "integrate"
  | "rename"
  | "split"
  | "merge"
  | "convert"
  | "move"
  | "recreate"
  | "retire"
  | "unadopt"
  | "details"

/**
 * The items of an area's menu (06 §9.4, §8.2): each where this build of own.team has its feature and this connection
 * may call the method. `큰 파일 폴더 가져오기…` only for light folders (the others hold every file already), `새 대화로
 * 이어가기` only for an area with a conversation, `이 영역 반영하기` only for an area that is not stopped, `팀에서 빼기`
 * only for an adopted area (also a stopped one, which it releases, 8.8). The T3 reorganizations go through
 * `reorg.apply` with their own feature: 나누기, 영역 묶기 (only while another area is there to join), 파일 모양 바꾸기
 * (an area with large-file folders: light ↔ full) and 대화 옮기기 need the area's folder, so a stopped area has none
 * of them; 다시 만들기… only for an area whose folder is gone (a new area from its record, 8.8, like the row's
 * `[다시 만들기]`); 영역 끝내기 also ends a stopped or finished one (a missing folder retires without a removal, 8.8).
 * `동료 추가…` (a new peer conversation in the area's folder, 2026-10-09) only for an active area, with `peers`.
 * `팀 메인과 상의하기…` (2026-10-16) only for an active area when the team main is known (`discuss`): it fills the team
 * main's composer with a draft about this area. `역할 바꾸기…` and `내가 정한 영역` (2026-10-26, `area.edit`) for an
 * active area; `별칭 바꾸기…` (2026-11-27, `area.edit{alias}`, feature `owner-alias`) for an active area.
 * `메인에게 넘기기` (2026-11-14, feature `direct`) only while the user works with the area directly and Main 멈춤 is
 * off: `area.pause{on: false}` hands it back to the main.
 */
export function areaActions(input: {
  readonly area: Pick<OwnTeam.AreaView, "owner" | "shape" | "state" | "origin" | "broken" | "paused" | "directWork">
  readonly has: (feature: OwnTeam.Feature) => boolean
  readonly allowed: (method: OwnTeam.MethodName) => boolean
  /** Other active areas of the team (영역 묶기 needs one); absent: not counted. */
  readonly peers?: number
  /** The team main is known, so 팀 메인과 상의하기… can fill its composer. */
  readonly discuss?: boolean
}): AreaAction[] {
  const area = input.area
  const can = (feature: OwnTeam.Feature, method: OwnTeam.MethodName) => input.has(feature) && input.allowed(method)
  const live = area.state === "active"
  const rows: ReadonlyArray<readonly [AreaAction, boolean]> = [
    ["open", area.owner.sessionID !== null],
    ["discuss", live && input.discuss === true],
    ["addPeer", live && can("peers", "area.peer.add")],
    ["handBack", area.paused === false && area.directWork !== undefined && can("direct", "area.pause")],
    ["pause", can("pause", "area.pause")],
    ["outbox", can("outbox", "outbox.list")],
    ["rotate", live && area.owner.sessionID !== null && can("rotate", "area.rotate")],
    ["main", live && can("area-main", "area.main")],
    ["preset", live && can("area-preset", "area.preset")],
    ["role", live && can("area-edit", "area.edit")],
    ["alias", live && can("owner-alias", "area.edit")],
    ["userMade", live && can("area-edit", "area.edit")],
    ["paths", live && area.shape === "code" && can("paths", "area.paths")],
    ["integrate", live && can("integrate", "area.integrate")],
    ["rename", can("reorg.rename", "reorg.apply")],
    ["split", live && can("reorg.split", "reorg.apply")],
    ["merge", live && input.peers !== 0 && can("reorg.merge", "reorg.apply")],
    ["convert", live && convertTarget(area.shape) !== undefined && can("reorg.convert", "reorg.apply")],
    ["move", live && can("reorg.move", "reorg.apply")],
    ["recreate", isMissing(area) && can("reorg.new", "reorg.apply")],
    ["retire", can("reorg.retire", "reorg.apply")],
    ["unadopt", area.origin === "adopted" && can("adopt", "area.unadopt")],
    ["details", true],
  ]
  return rows.flatMap(([action, shown]) => (shown ? [action] : []))
}

export type AreaGroup = "talk" | "requests" | "settings" | "work" | "structure" | "danger" | "details"

/**
 * 06 §9.4 (2026-10-16): the area menu's groups in order, each action in exactly one. 대화, 메인 요청, 설정 and 작업 are
 * headed lists; 구성 바꾸기 opens on demand; 끝내기·빼기 come after a separator in danger tone; then the peers and
 * 자세히. 다시 만들기… shows only for an area whose folder is gone, where it is the way back, so it is a 작업 item
 * rather than inside the folded group (ui-ux review).
 */
export const AREA_GROUPS: ReadonlyArray<readonly [AreaGroup, ReadonlyArray<AreaAction>]> = [
  ["talk", ["open", "discuss", "addPeer", "rotate"]],
  ["requests", ["handBack", "pause", "outbox"]],
  ["settings", ["main", "preset", "role", "alias", "userMade"]],
  ["work", ["integrate", "paths", "recreate"]],
  ["structure", ["rename", "split", "merge", "convert", "move"]],
  ["danger", ["retire", "unadopt"]],
  ["details", ["details"]],
]

/** The menu's shown actions by group, in {@link AREA_GROUPS} order; empty groups are left out. */
export function areaGroups(actions: ReadonlyArray<AreaAction>) {
  return AREA_GROUPS.flatMap(([group, members]) => {
    const items = members.filter((action) => actions.includes(action))
    return items.length === 0 ? [] : [{ group, actions: items }]
  })
}

/** 파일 모양 바꾸기 (06 §8.2): a light folder becomes full and a full one light; a plain one has no large files. */
export function convertTarget(shape: OwnTeam.AreaView["shape"]) {
  if (shape === "code") return "full" as const
  if (shape === "full") return "code" as const
  return undefined
}

/** `이름 바꾸기` (06 §8.2): the user's own structural action, through `reorg.apply{teamID, proposal}` (2.7). */
export function renameProposal(areaID: string, name: string, subtitle: string): OwnTeam.Proposal {
  return {
    version: 1,
    ops: [{ op: "rename", area: areaID, name: name.trim(), subtitle: subtitle.trim() || null }],
  }
}

/**
 * `새 영역` / 영역 만들기 (06 §8.2, §8.8, §9.4): where a team is on, a new work folder is a new area, the user's own
 * structural action through `reorg.apply{teamID, proposal}` (2.7). The slug (also the folder and record name) is the
 * one the user wrote, else V6 from the name; a name without Latin letters or digits becomes `area`, and a slug the team
 * uses gets `-2`, `-3`, …. 영역 만들기 (2026-10-26) adds where it starts (`from`: `main` or an area's slug), the area's
 * own model (`main`, absent = 팀과 같게), its first conversation's 에이전트 방식 and the user-made mark.
 */
export function newAreaProposal(
  name: string,
  goal: string,
  taken: readonly string[],
  options: {
    readonly slug?: string
    readonly from?: string
    readonly main?: { readonly providerID: string; readonly id: string; readonly variant?: string }
    readonly harness?: OwnTeam.Harness
    readonly userMade?: boolean
  } = {},
): OwnTeam.Proposal {
  const title = name.trim()
  const purpose = goal.trim()
  const slug = options.slug?.trim() || freeSlug(title, taken)
  const main = options.main
  return {
    version: 1,
    ops: [
      {
        op: "new",
        slug,
        name: title,
        ...(purpose ? { goal: purpose } : {}),
        ...(options.from && options.from !== "main" ? { from: options.from } : {}),
        ...(main ? { main: modelRef(main) } : {}),
        ...(options.harness ? { harness: { id: options.harness.id, prompt: options.harness.prompt } } : {}),
        ...(options.userMade ? { userMade: true as const } : {}),
      },
    ],
  }
}

/**
 * 영역 만들기 with an existing work folder (2026-10-26): the folder joins the team as a user-made area (`areas[].adopt`,
 * 3.7: its conversations and model stay) of the name given here (06 §8.2; own.team does so for the user's own row since
 * 2026-10-27, before it named the area after the folder with this name below it).
 */
export function adoptAreaProposal(
  name: string,
  goal: string,
  worktree: string,
  taken: readonly string[],
): OwnTeam.Proposal {
  const title = name.trim()
  const purpose = goal.trim()
  return {
    version: 1,
    areas: [
      {
        // Its record name follows the folder (3.7); the area is named as typed (06 §8.2).
        slug: freeSlug(baseName(worktree), taken),
        name: title,
        ...(purpose ? { goal: purpose } : {}),
        adopt: { worktree },
        userMade: true,
      },
    ],
  }
}

/**
 * The work folders 영역 만들기 may take (2026-10-26): the ones the team left out that it could take in (`team.external`
 * `left`, 8.8), not already an area.
 */
export function createFolders(entry: Pick<TeamEntry, "team" | "areas" | "order">) {
  const areas = entry.order.flatMap((id) => entry.areas[id] ?? [])
  return entry.team.external
    .filter((item) => item.why === "left" && !areas.some((area) => samePath(area.directory, item.directory)))
    .map((item) => item.directory)
}

/**
 * A model the switcher listed as the proposal carries it. The service decodes the proposal and brands the ids itself
 * (`Model.Ref`); the screen only passes the strings on.
 */
function modelRef(ref: { readonly providerID: string; readonly id: string; readonly variant?: string }) {
  const plain = {
    providerID: ref.providerID,
    id: ref.id,
    ...(ref.variant === undefined ? {} : { variant: ref.variant }),
  }
  // SAFETY: the same three strings `Model.Ref` holds; its brands only mark them, and own.team decodes them again.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return plain as unknown as Model.Ref
}

/** The longest role an area keeps (V12: 1,000 characters, refused above, never cut; 2026-11-14). */
export const ROLE_MAX = 1_000

/** The longest role an own.team without the `direct` feature keeps: it cuts a longer one there without saying so. */
const OLD_ROLE_MAX = 200

/** The longest role the connected own.team keeps (another PC's older server may be reached). */
export function roleMax(has: ((feature: OwnTeam.Feature) => boolean) | undefined) {
  return has?.("direct") === false ? OLD_ROLE_MAX : ROLE_MAX
}

/**
 * The characters a role has left (below 0: how far it is over), counted as the protocol counts them (`String.length`
 * of the trimmed text). The role fields have no native `maxLength`, so a pasted text is not cut silently: the field
 * says how far it is over and its save waits. `max`: {@link roleMax} of the server.
 */
export function roleLeft(role: string, max = ROLE_MAX) {
  return max - role.trim().length
}

/**
 * V6 (06 §3.5): a folder and record name own.team keeps as it is (2026-10-27: V6's own fixed points, so no trailing
 * `-` or `--`, which own.team would change after the dialog showed the name); the dialog checks it before sending.
 */
export function slugValid(slug: string) {
  return slug !== "" && slugOf(slug) === slug
}

/**
 * `나누기…` (06 §8.2 A → A, A2): the new area starts at A's work with A's handoff, area main and preset. Its slug
 * follows the same rules as a new area's.
 */
export function splitProposal(areaID: string, name: string, goal: string, taken: readonly string[]): OwnTeam.Proposal {
  const title = name.trim()
  const purpose = goal.trim()
  return {
    version: 1,
    ops: [
      {
        op: "split",
        area: areaID,
        slug: freeSlug(title, taken),
        name: title,
        ...(purpose ? { goal: purpose } : {}),
      },
    ],
  }
}

/** `영역 묶기…` (06 §8.2 A + B → A): `from`'s work, handoff and waiting requests go into `areaID`; its folder is asked. */
export function mergeProposal(areaID: string, from: string): OwnTeam.Proposal {
  return { version: 1, ops: [{ op: "merge", area: areaID, from }] }
}

/** `영역 끝내기…` (06 §8.2): the area's id, or the slug a suggestion names (the service takes both). */
export function retireProposal(area: string): OwnTeam.Proposal {
  return { version: 1, ops: [{ op: "retire", area }] }
}

/**
 * `다시 만들기` (06 §8.8 a missing folder, §8.2 B after a join that can no longer be undone): a new area from the
 * area's record, with its name and purpose. The service starts the new record at the old one's last save point and
 * names it `<slug>-2` while the old area keeps its slug; the old area stays as it is.
 */
export function recreateProposal(area: Pick<OwnTeam.AreaView, "id" | "name" | "goal">): OwnTeam.Proposal {
  const slug = area.id.slice("ar_".length)
  const goal = area.goal.trim()
  return { version: 1, ops: [{ op: "new", slug, name: area.name, ...(goal ? { goal } : {}), from: slug }] }
}

/** `파일 모양 바꾸기` (06 §8.2): to `code` (light) or `full`. */
export function convertProposal(areaID: string, shape: "code" | "full"): OwnTeam.Proposal {
  return { version: 1, ops: [{ op: "convert", area: areaID, shape }] }
}

/** `대화 옮기기…` (06 §8.2, §4.14): a user action only; the conversation continues in the area's folder. */
export function moveProposal(sessionID: string, areaID: string): OwnTeam.Proposal {
  return { version: 1, ops: [{ op: "move", sessionID, area: areaID }] }
}

/** A conversation 대화 옮기기 offers (06 §8.2). */
export interface MoveCandidate {
  readonly sessionID: string
  readonly title?: string
  readonly directory: string
}

/**
 * The conversations 대화 옮기기 can bring into an area (06 §8.2): root conversations of the team's project outside the
 * area's folder, newest first. The team main and the current owners stay where the team put them (their folders are
 * the registry's); archived conversations and subagents are never offered.
 */
export function moveCandidates(input: {
  readonly area: Pick<OwnTeam.AreaView, "directory">
  readonly projectID: string
  readonly sessions: readonly Pick<
    SessionRow,
    "id" | "title" | "projectID" | "directory" | "parentID" | "archived" | "updated"
  >[]
  /** The session's place in a team (TeamStore `placeOf`). */
  readonly place: (sessionID: string) => Pick<SessionPlace, "previous"> | undefined
}): MoveCandidate[] {
  return input.sessions
    .filter(
      (session) =>
        !session.parentID &&
        !session.archived &&
        session.projectID === input.projectID &&
        !isInside(input.area.directory, session.directory) &&
        input.place(session.id)?.previous !== false,
    )
    .toSorted((a, b) => b.updated - a.updated)
    .map((session) => ({
      sessionID: session.id,
      directory: session.directory,
      ...(session.title ? { title: session.title } : {}),
    }))
}

/**
 * `OwnTeam.PEER_LABEL_MAX`, `OwnTeam.PEER_ROLE_MAX` and `OwnTeam.OWNER_NOTE_MAX` (protocol.test.ts holds them
 * equal): the definition module evaluates its schemas, so screens keep its numbers here. Roles and notes count
 * characters as `String.length` does, like the protocol's `Schema.isMaxLength` (2026-11-14; bytes before).
 */
export const PEER_LABEL_MAX = 40
export const PEER_ROLE_MAX = 1_024
export const OWNER_NOTE_MAX = 1_024
/** `OwnTeam.OWNER_ALIAS_MAX`: the owner alias (별칭, `area.edit{alias}`, 2026-11-27). */
export const OWNER_ALIAS_MAX = 12
/** `OwnTeam.PATHS_MAX`: the folders one `area.paths` call may add (2026-11-14; 8 before). */
export const PATHS_MAX = 64

/**
 * 큰 파일 폴더 가져오기 as its form holds it: one folder per line, trimmed, blank lines and repeats left out. Over
 * {@link PATHS_MAX} the form says so and does not send (nothing is dropped silently).
 */
export function pathsForm(dirs: string) {
  const list = [...new Set(dirs.split(/\r?\n/).map((line) => line.trim()))].filter(Boolean)
  return { dirs: list, ok: list.length > 0 && list.length <= PATHS_MAX }
}

/**
 * A peer's 이름 and 역할 as the form holds them (06 §9.4, 동료): the name is required and at most 40 characters (its
 * whitespace folded, as own.team stores it), the role at most 1,024 characters. `left` below 0 is how far it is over.
 */
export function peerForm(label: string, role: string) {
  const name = label.replace(/\s+/g, " ").trim()
  const text = role.trim()
  const left = PEER_ROLE_MAX - text.length
  return { label: name, role: text, left, ok: name.length > 0 && name.length <= PEER_LABEL_MAX && left >= 0 }
}

/**
 * `area.peer.add` (06 §2.7): with a conversation it is 동료로 등록… (the conversation keeps its model and preset),
 * without one 동료 추가… (`create`: a new conversation in the area's folder on the area main and preset).
 */
export function peerAddInput(
  area: { readonly teamID: string; readonly areaID: string },
  form: { readonly label: string; readonly role: string },
  sessionID?: string,
): TeamInput<"area.peer.add"> {
  const fields = { label: form.label, role: form.role }
  if (sessionID) return { teamID: area.teamID, areaID: area.areaID, sessionID, ...fields }
  return { teamID: area.teamID, areaID: area.areaID, create: fields }
}

/** `area.peer.edit` (역할 바꾸기…): only what changed; `undefined` when nothing did. */
export function peerEditInput(
  area: { readonly teamID: string; readonly areaID: string },
  peer: Pick<OwnTeam.Peer, "key" | "label" | "role">,
  form: { readonly label: string; readonly role: string },
): TeamInput<"area.peer.edit"> | undefined {
  const label = form.label === peer.label ? undefined : form.label
  const role = form.role === peer.role ? undefined : form.role
  if (label === undefined && role === undefined) return undefined
  return {
    teamID: area.teamID,
    areaID: area.areaID,
    key: peer.key,
    ...(label === undefined ? {} : { label }),
    ...(role === undefined ? {} : { role }),
  }
}

/** A conversation of an area that the team talks with: its owner or one of its peers. */
export interface Talker {
  readonly kind: "owner" | "peer"
  readonly sessionID: string
  /** Peers only: the peer's key and name. The owner is named by its conversation's title. */
  readonly key?: string
  readonly label?: string
  /** The owner note or the peer's role; empty when there is none. */
  readonly note: string
}

/**
 * The conversations of an area the team talks with, as the area menu lists them (06 §9.4, 2026-11-12): the owner
 * first with the owner note, then the peers in the registry's order with their roles. An area whose owner
 * conversation does not exist yet lists its peers only.
 */
export function areaTalkers(area: Pick<OwnTeam.AreaView, "owner" | "peers">): Talker[] {
  const owner = area.owner.sessionID
  return [
    ...(owner ? [{ kind: "owner" as const, sessionID: owner, note: area.owner.note ?? "" }] : []),
    ...(area.peers ?? []).map((peer) => ({
      kind: "peer" as const,
      sessionID: peer.sessionID,
      key: peer.key,
      label: peer.label,
      note: peer.role,
    })),
  ]
}

/**
 * The owner note as its editor holds it (담당 메모, `area.edit{note}`): trimmed as own.team stores it, at most 1,024
 * characters; an empty one removes the note. `left` below 0 is how far it is over.
 */
export function noteForm(note: string) {
  const text = note.trim()
  const left = OWNER_NOTE_MAX - text.length
  return { note: text, left, ok: left >= 0 }
}

/**
 * The owner alias as its editor holds it (별칭, `area.edit{alias}`, 2026-11-27): trimmed as own.team stores it, at most
 * {@link OWNER_ALIAS_MAX} characters on one line, not one of `taken` (the team's other active area names, slugs and
 * aliases and every peer's label and key, compared without case: own.team checks the same and refuses with
 * `seat_invalid`). An empty one removes the alias. `left` below 0 is how far it is over.
 */
export function aliasForm(alias: string, taken: readonly string[]) {
  const text = alias.trim()
  const left = OWNER_ALIAS_MAX - text.length
  const line = !/\p{Cc}/u.test(text) && !text.startsWith("ar_")
  const wanted = text.toLowerCase()
  const free = text === "" || !taken.some((name) => name.trim().toLowerCase() === wanted)
  return { alias: text, left, line, free, ok: left >= 0 && line && free }
}

/** The names an alias of `areaID` may not take ({@link aliasForm}): the team's other active areas and every peer. */
export function aliasTaken(entry: Pick<TeamEntry, "areas" | "order">, areaID: string) {
  return entry.order.flatMap((id) => {
    const area = entry.areas[id]
    if (!area || area.state === "retired") return []
    return [
      ...(area.id === areaID ? [] : [area.name, area.id.slice("ar_".length), area.owner.alias ?? ""]),
      ...(area.peers ?? []).flatMap((peer) => [peer.label, peer.key]),
    ].filter(Boolean)
  })
}

/**
 * `민지 · UI`: the alias before the area name when its owner seat has one (별칭), else the name alone. Narrow places
 * show the name alone (the header pill's short form, the room's labels on a phone).
 */
export function aliasLabel(area: Pick<OwnTeam.AreaView, "owner" | "name">) {
  return area.owner.alias ? `${area.owner.alias} · ${area.name}` : area.name
}

/** A slug the team does not use yet: V6 from the name, `area` without Latin letters or digits, then `-2`, `-3`, …. */
export function freeSlug(name: string, taken: readonly string[]) {
  const base = slugOf(name) || "area"
  // Of `base`, `base-2`, …, `base-(n+2)` at least one is free while the team uses n slugs.
  return (
    [base, ...taken.map((_, index) => suffixed(base, index + 2)), suffixed(base, taken.length + 2)].find(
      (candidate) => !taken.includes(candidate),
    ) ?? base
  )
}

/** V6 (06 §3.5): ASCII lower case, digits and hyphens, at most 32, starting with a letter or digit. */
function slugOf(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
}

/** `<base>-<n>`, kept within 32 characters. */
function suffixed(base: string, n: number) {
  const suffix = `-${n}`
  return `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`
}

/**
 * The team's worst case (06 §10.3, 07 §7.4) if `areaID` took `presetID`: the area preset picker shows it under a
 * heavy preset (`적극적으로`, a paid target). `undefined` when nothing heavy is left.
 */
export function worstWith(
  text: TeamText,
  entry: Pick<TeamEntry, "order" | "areas">,
  change: { readonly areaID: string; readonly presetID: string },
  presets: (presetID: string) => Preset.Info | undefined,
  ultraCaps: Preset.UltraCaps,
  limits: Parameters<typeof worstCase>[4],
) {
  const areas = entry.order.flatMap((id): WorstArea[] => {
    const area = entry.areas[id]
    if (!area || area.state === "retired") return []
    return [{ presetID: id === change.areaID ? change.presetID : area.preset }]
  })
  const result = worstCase(text, areas, presets, ultraCaps, limits)
  return result?.heavy ? result.line : undefined
}

/** The team strings in one language (the sidebar binds the window's locale). */
export function teamWords(locale: Locale): TeamText {
  return (key, params) => teamText.text(locale, key, params)
}

/**
 * A notice row's words (06 §9.7) in one language; sizes as the files screens write them, folders by their name (9.1), a
 * coming time as the time left from `now` (the minute clock, so `42분 후까지` ticks down, LV 2026-10-25).
 */
export function noticeLine(
  locale: Locale,
  notice: Pick<TeamNotice, "kind" | "text" | "data">,
  area: string | undefined,
  now: number,
) {
  return noticeText(teamWords(locale), notice, {
    ...(area === undefined ? {} : { area }),
    bytes: (bytes) => formatBytes(locale, bytes),
    folder: baseName,
    time: (at) => coming({ locale: () => locale, t: (key, params) => translate(locale, key, params) }, now, at),
  })
}

/**
 * The notices still in force at `now` (06 §9.7): held team updates (`wake.limited`) leave once their `until` passed, as
 * own.team then sends them again; every other notice stays until it is closed.
 */
export function liveNotices<N extends Pick<TeamNotice, "kind" | "data">>(notices: readonly N[], now: number) {
  return notices.filter((notice) => {
    const until = notice.data?.until
    return notice.kind !== "wake.limited" || typeof until !== "number" || until > now
  })
}

/**
 * `[팀에 넣기]` on a folder row of `팀에 넣지 않은 작업 폴더` (06 §8.8, §9.4): the team that could take the folder in,
 * where this build of own.team adopts (`health.features`) and this connection may (`area.adopt`, admin).
 */
export function adoptTarget(input: {
  readonly project: Pick<TeamProject, "unadopted"> | undefined
  readonly directory: string
  readonly has: (feature: OwnTeam.Feature) => boolean
  readonly allowed: (method: OwnTeam.MethodName) => boolean
}) {
  if (!input.has("adopt") || !input.allowed("area.adopt")) return undefined
  return input.project?.unadopted.find((item) => samePath(item.directory, input.directory))?.teamID
}

/** What the sidebar loads with the team chunk. */
export const teamView = {
  project: teamProject,
  areaRow,
  notice: noticeLine,
  live: liveNotices,
  words: teamWords,
  adopt: adoptTarget,
}

export type TeamView = typeof teamView

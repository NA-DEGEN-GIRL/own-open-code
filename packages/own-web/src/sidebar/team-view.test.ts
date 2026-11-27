// Sidebar team view (06 §9.4, §9.2, §10.1, §10.3, §8.8; 07 §7.4; TG20 team view part, TG15 UI lists). Fixtures go
// through the protocol's schemas, the registry is a real TeamStore over the real event bus and a fake own.team client,
// and the tree is the sidebar's real `flattenTree`. Covered: where each conversation of a team project goes (team main,
// owner, the area's and the main folder's other conversations, work folders the team leaves out), the requests that
// wait across the team and the team's notices; the tree's order (requests → notices → main → areas → 팀 밖), areas
// without conversations, folds, levels and heights; notice words in both languages; T2: the folders the team could
// take in (`[팀에 넣기]` once the build adopts and the connection may), stopped areas' words and menus, and the T2
// notices in `팀 알림 n개`; area row words (label, short path, `모델: …`, `프리셋: …` dimmed for `평소대로`, status
// words); the area menu's items by feature and scope (T3 hidden); the rename and new-area proposals; the worst case of
// a heavy preset; forks lose the team hint, children keep it untouched; team requests merge their notifications per
// team (registry roles only). Area peers (동료): placed by the registry's `peers` under the owner, out of `이 영역의
// 다른 대화`, their requests with the team's, and `동료 추가…` by feature, scope and area state.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client"
import { Preset } from "@own/protocol/preset"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { TEAM_META, TEAM_SCOPE, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import { createI18n } from "@/i18n"
import { coming } from "@/limits/format"
import { teamOf } from "@/requests/notify"
import type { TeamText } from "@/team/model"
import { createTeamStore, type TeamEntry } from "@/team/store"
import { teamText } from "@/team/strings"
import { areaOf, cardDefaults, directWaits, proposalCard, rederive } from "@/team/reorg"
import {
  adoptAreaProposal,
  adoptTarget,
  AREA_GROUPS,
  areaActions,
  areaGroups,
  areaRow,
  areaTalkers,
  createFolders,
  freeSlug,
  newAreaProposal,
  slugValid,
  liveNotices,
  noticeLine,
  renameProposal,
  shortPath,
  teamProject,
  worstWith,
  type AreaAction,
} from "@/team/view-model"
import { createOwnFlags, withoutFlags } from "./flags"
import {
  dayMarks,
  flattenTree,
  foldKey,
  heightOf,
  HOME_GROUP,
  levelOf,
  parseKey,
  rowHeights,
  rowKey,
  type TeamProject,
} from "./model"

const TEAM = "tm_0123456789ab"
const OTHER_TEAM = "tm_ba9876543210"
const CU = "ar_cl-cu"
const PERF = "ar_cl-perf"
const SIWC = "ar_cl-siwc"
const OLD = "ar_old"
const MAIN = "ses_main"
const MAIN_OLD = "ses_main_old"
const OWNER_CU = "ses_owner_cu"
const OWNER_CU_OLD = "ses_owner_cu_old"
const PENDING_PERF = "ses_owner_perf_new"
const HOME = "D:\\own-open-code"
const PROJECT = "prj_own"
/** A work folder with work the judge left out (`team.external` `left`, 8.8): one the team could take in. */
const LEFT = `${HOME}\\.worktrees\\cl-x`
const TOOL = `${HOME}\\.claude\\worktrees\\tool-a`

const decodeTeam = Schema.decodeUnknownSync(OwnTeam.Team)
const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)
const decodeHealth = Schema.decodeUnknownSync(OwnTeam.Health)
const decodeProposal = Schema.decodeUnknownSync(OwnTeam.Proposal)

const ko: TeamText = (key, params) => teamText.text("ko", key, params)

function team(fields: Record<string, unknown> = {}) {
  return decodeTeam({
    id: TEAM,
    projectID: PROJECT,
    commonDir: "D:\\#Projects\\own-open-code\\.git",
    target: "main",
    state: "on",
    rev: 3,
    home: { directory: HOME, linked: true, chosenBy: "session" },
    main: { sessionID: MAIN, previous: [MAIN_OLD] },
    worktreeRoot: `${HOME}\\.worktrees`,
    heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
    shared: [],
    commands: { setup: null, code: [], assets: [] },
    env: { symlinkFix: "none", bunCache: "same-volume", lfs: "unused" },
    external: [
      { directory: "D:\\#Projects\\own-open-code", why: "primary" },
      { directory: `${HOME}\\.claude\\worktrees\\tool-a`, why: "other-tool" },
    ],
    policy: OwnTeam.POLICY,
    patterns: [],
    ...fields,
  })
}

function area(id: string, fields: Record<string, unknown> = {}) {
  const slug = id.slice(3)
  return decodeArea({
    id,
    teamID: TEAM,
    name: slug,
    goal: "",
    origin: "created",
    state: "active",
    branch: slug,
    gitDir: `D:\\#Projects\\own-open-code\\.git\\worktrees\\${slug}`,
    base: { sha: "a".repeat(40), at: 1 },
    directory: `${HOME}\\.worktrees\\${slug}`,
    shape: "code",
    cone: { extra: {}, kept: {} },
    owner: { sessionID: null, previous: [], attached: true },
    preset: "builtin:codex",
    paused: false,
    status: { kind: "idle", at: 1, text: "" },
    handoff: null,
    ...fields,
  })
}

function entry(areas: readonly OwnTeam.AreaView[], fields: Record<string, unknown> = {}): TeamEntry {
  return {
    team: team(fields),
    areas: Object.fromEntries(areas.map((item) => [item.id, item])),
    order: areas.map((item) => item.id),
    waiting: {},
    op: null,
    pending: [],
  }
}

const areas = () => [
  area(CU, {
    subtitle: "컴퓨터 사용",
    owner: {
      sessionID: OWNER_CU,
      previous: [{ sessionID: OWNER_CU_OLD, endedAt: 2, why: "fresh" }],
      attached: true,
    },
  }),
  area(PERF, { owner: { sessionID: null, pending: PENDING_PERF, previous: [], attached: true } }),
  area(SIWC, { directory: "D:\\own-open-code-team\\cl-siwc" }),
  area(OLD, { state: "retired" }),
]

const permissions: Record<string, readonly { readonly id: string; readonly sessionID: string }[]> = {
  [MAIN]: [{ id: "per_main", sessionID: MAIN }],
  ses_child_of_cu: [{ id: "per_child", sessionID: "ses_child_of_cu" }],
  ses_elsewhere: [{ id: "per_other", sessionID: "ses_elsewhere" }],
}

/** The store's notices, newest first: one of a team that is not on in this project. */
const notices = [
  { id: "01JB0000000000000000000003", teamID: TEAM },
  { id: "01JB0000000000000000000002", teamID: OTHER_TEAM },
  { id: "01JB0000000000000000000001", teamID: TEAM },
]

function project(entries: readonly TeamEntry[] = [entry(areas())], worktrees?: readonly string[]) {
  return teamProject({
    entries,
    worktrees,
    family: (sessionID) => (sessionID === OWNER_CU ? [OWNER_CU, "ses_child_of_cu"] : []),
    permissions: (sessionID) => permissions[sessionID],
    notices,
  })
}

/** The team after reconcile found `LEFT` (8.8): beside the primary checkout and another tool's folder. */
const withLeft = () =>
  entry(areas(), {
    external: [
      { directory: "D:\\#Projects\\own-open-code", why: "primary" },
      { directory: TOOL, why: "other-tool" },
      { directory: LEFT, why: "left" },
    ],
  })

describe("where a team project's conversations go (06 §9.4)", () => {
  test("registry roles first, then the deepest folder: areas, folders the team leaves out, the main folder", () => {
    const view = project([entry(areas())], [HOME, `${HOME}\\.worktrees\\cl-x`])
    const slot = (sessionID: string, directory: string) => view.slot(sessionID, directory)
    expect(slot(MAIN, HOME)).toEqual({ kind: "main", teamID: TEAM })
    expect(slot(OWNER_CU, `${HOME}\\.worktrees\\cl-cu`)).toEqual({ kind: "owner", teamID: TEAM, areaID: CU })
    // A rotation's new conversation is the owner from its creation on (6.2).
    expect(slot(PENDING_PERF, `${HOME}\\.worktrees\\cl-perf`)).toEqual({ kind: "owner", teamID: TEAM, areaID: PERF })
    // An earlier owner and a direct conversation stay with the area's other conversations; subfolders count.
    expect(slot(OWNER_CU_OLD, `${HOME}\\.worktrees\\cl-cu`)).toEqual({ kind: "area", teamID: TEAM, areaID: CU })
    expect(slot("ses_direct", `${HOME}\\.worktrees\\cl-cu\\packages\\web`)).toEqual({
      kind: "area",
      teamID: TEAM,
      areaID: CU,
    })
    expect(slot("ses_far", "D:\\own-open-code-team\\cl-siwc")).toEqual({ kind: "area", teamID: TEAM, areaID: SIWC })
    // An earlier main conversation and other conversations of the main folder.
    expect(slot(MAIN_OLD, HOME)).toEqual({ kind: "home", teamID: TEAM })
    expect(slot("ses_home", `${HOME}\\packages\\own-web`)).toEqual({ kind: "home", teamID: TEAM })
    // Inside the main folder, a worktree of another tool or of the project is outside the team.
    expect(slot("ses_tool", `${HOME}\\.claude\\worktrees\\tool-a\\src`)).toEqual({
      kind: "outside",
      directory: `${HOME}\\.claude\\worktrees\\tool-a`,
    })
    expect(slot("ses_x", `${HOME}\\.worktrees\\cl-x`)).toEqual({
      kind: "outside",
      directory: `${HOME}\\.worktrees\\cl-x`,
    })
    expect(slot("ses_primary", "D:\\#Projects\\own-open-code")).toEqual({
      kind: "outside",
      directory: "D:\\#Projects\\own-open-code",
    })
    expect(slot("ses_away", "E:\\scratch\\wt")).toEqual({ kind: "outside", directory: "E:\\scratch\\wt" })
    // A finished area is no place any more.
    expect(slot("ses_retired", `${HOME}\\.worktrees\\old`)).toEqual({ kind: "home", teamID: TEAM })
    expect(view.teams).toEqual([{ teamID: TEAM, main: MAIN, areas: [CU, PERF, SIWC] }])
  })

  test("requests wait across the team main, current owners and their subagents, once each", () => {
    const view = project()
    expect(view.requests).toEqual([
      { sessionID: MAIN, requestID: "per_main" },
      { sessionID: "ses_child_of_cu", requestID: "per_child" },
    ])
  })

  test("notices of the project's teams, newest first", () => {
    expect(project().notices).toEqual(["01JB0000000000000000000003", "01JB0000000000000000000001"])
  })

  test("two clones of one remote: each team keeps its own sessions", () => {
    const other = entry([area("ar_web", { teamID: OTHER_TEAM, directory: "E:\\clone\\.worktrees\\web" })], {
      id: OTHER_TEAM,
      home: { directory: "E:\\clone", linked: false, chosenBy: "canonical" },
      main: { sessionID: "ses_main_2", previous: [] },
      external: [],
    })
    const view = project([entry(areas()), other])
    expect(view.slot("ses_main_2", "E:\\clone")).toEqual({ kind: "main", teamID: OTHER_TEAM })
    expect(view.slot("ses_x", "E:\\clone\\docs")).toEqual({ kind: "home", teamID: OTHER_TEAM })
    expect(view.slot("ses_y", "E:\\clone\\.worktrees\\web")).toEqual({
      kind: "area",
      teamID: OTHER_TEAM,
      areaID: "ar_web",
    })
    expect(view.teams.map((item) => item.teamID)).toEqual([TEAM, OTHER_TEAM])
  })
})

describe("tree of a team project (06 §9.4)", () => {
  const NOW = new Date(2026, 9, 2, 15, 0, 0).getTime()
  const sessions: Record<string, { projectID: string; updated: number; directory: string }> = {
    ses_tool: { projectID: PROJECT, updated: NOW - 1, directory: `${HOME}\\.claude\\worktrees\\tool-a` },
    [OWNER_CU]: { projectID: PROJECT, updated: NOW - 2, directory: `${HOME}\\.worktrees\\cl-cu` },
    [MAIN]: { projectID: PROJECT, updated: NOW - 3, directory: HOME },
    [OWNER_CU_OLD]: { projectID: PROJECT, updated: NOW - 4, directory: `${HOME}\\.worktrees\\cl-cu` },
    [MAIN_OLD]: { projectID: PROJECT, updated: NOW - 5, directory: HOME },
    ses_plain: { projectID: "prj_plain", updated: NOW - 6, directory: "D:\\plain" },
    ses_plain_wt: { projectID: "prj_plain", updated: NOW - 7, directory: "D:\\plain-wt" },
  }
  const order = Object.keys(sessions)
  const tree = (input: { collapsed?: string[]; expanded?: string[]; search?: boolean; view?: TeamProject } = {}) =>
    flattenTree({
      order,
      session: (id) => sessions[id],
      collapsed: (key) => input.collapsed?.includes(key) ?? false,
      expanded: (key) => input.expanded?.includes(key) ?? false,
      children: (id) => (id === OWNER_CU ? [{ id: "ses_child_of_cu", level: 1 }] : []),
      marks: dayMarks(NOW),
      more: false,
      match: input.search ? () => true : undefined,
      worktree: (id) => (id === "ses_plain_wt" ? "D:\\plain-wt" : undefined),
      team: (projectID) => (projectID === PROJECT ? (input.view ?? project()) : undefined),
    })

  test("requests, main, the main folder's others, areas (without conversations too), then 팀 밖; other groups fold", () => {
    const out = tree()
    expect(out.keys).toEqual([
      rowKey.project(PROJECT),
      rowKey.requests(PROJECT),
      rowKey.request(MAIN, "per_main"),
      rowKey.request("ses_child_of_cu", "per_child"),
      rowKey.notices(PROJECT),
      rowKey.notice("01JB0000000000000000000003"),
      rowKey.notice("01JB0000000000000000000001"),
      rowKey.session(MAIN),
      rowKey.others(TEAM, HOME_GROUP),
      rowKey.area(TEAM, CU),
      rowKey.session(OWNER_CU),
      rowKey.others(TEAM, CU),
      rowKey.area(TEAM, PERF),
      rowKey.area(TEAM, SIWC),
      rowKey.outside(PROJECT),
      rowKey.project("prj_plain"),
      rowKey.session("ses_plain"),
      rowKey.worktree("prj_plain", "D:\\plain-wt"),
      rowKey.session("ses_plain_wt"),
    ])
    expect(out.counts[PROJECT]).toBe(5)
    expect(out.counts[rowKey.requests(PROJECT)]).toBe(2)
    expect(out.counts[rowKey.notices(PROJECT)]).toBe(2)
    expect(levelOf(rowKey.notice("01JB0000000000000000000001"), out.levels)).toBe(3)
    expect(out.counts[rowKey.others(TEAM, HOME_GROUP)]).toBe(1)
    expect(out.counts[rowKey.others(TEAM, CU)]).toBe(1)
    expect(out.counts[rowKey.outside(PROJECT)]).toBe(1)
  })

  test("a rotation that made its new conversation lists that one as the area's owner, the one it replaces with the area's others (RH-50)", () => {
    // Between `rotate.owner` (the write-ahead `owner.pending`) and `rotate.swap` the registry holds both; both are
    // titled `<영역> · 담당`, and the team view listed both as the owner.
    const NEW = "ses_owner_cu_new"
    const folder = `${HOME}\\.worktrees\\cl-cu`
    const rotating = [
      area(CU, {
        subtitle: "컴퓨터 사용",
        owner: {
          sessionID: OWNER_CU,
          pending: NEW,
          previous: [{ sessionID: OWNER_CU_OLD, endedAt: 2, why: "fresh" }],
          attached: true,
        },
      }),
      ...areas().filter((item) => item.id !== CU),
    ]
    const view = project([entry(rotating)])
    expect(view.slot(NEW, folder)).toEqual({ kind: "owner", teamID: TEAM, areaID: CU })
    expect(view.slot(OWNER_CU, folder)).toEqual({ kind: "owner", teamID: TEAM, areaID: CU, replaced: true })
    const listed = (order: readonly string[]) => {
      const out = flattenTree({
        order,
        session: () => ({ projectID: PROJECT, updated: NOW, directory: folder }),
        collapsed: () => false,
        expanded: (key) => key === foldKey.others(TEAM, CU),
        children: () => [],
        marks: dayMarks(NOW),
        more: false,
        team: () => view,
      })
      return out.keys.slice(out.keys.indexOf(rowKey.area(TEAM, CU)), out.keys.indexOf(rowKey.area(TEAM, PERF)))
    }
    expect(listed([NEW, OWNER_CU, OWNER_CU_OLD])).toEqual([
      rowKey.area(TEAM, CU),
      rowKey.session(NEW),
      rowKey.others(TEAM, CU),
      rowKey.session(OWNER_CU),
      rowKey.session(OWNER_CU_OLD),
    ])
    // Until the new conversation is a row (its `session.created` comes after the registry), or when the rotation
    // failed before making it, the area keeps its owner on screen.
    expect(listed([OWNER_CU, OWNER_CU_OLD])).toEqual([
      rowKey.area(TEAM, CU),
      rowKey.session(OWNER_CU),
      rowKey.others(TEAM, CU),
      rowKey.session(OWNER_CU_OLD),
    ])
  })

  test("opened groups list their sessions one level deeper; a folded area hides its conversations", () => {
    const out = tree({
      collapsed: [foldKey.requests(PROJECT), foldKey.notices(PROJECT), foldKey.area(TEAM, PERF)],
      expanded: [foldKey.others(TEAM, HOME_GROUP), foldKey.others(TEAM, CU), foldKey.outside(PROJECT), OWNER_CU],
    })
    const team = out.keys.slice(0, out.keys.indexOf(rowKey.project("prj_plain")))
    expect(team).toEqual([
      rowKey.project(PROJECT),
      rowKey.requests(PROJECT),
      rowKey.notices(PROJECT),
      rowKey.session(MAIN),
      rowKey.others(TEAM, HOME_GROUP),
      rowKey.session(MAIN_OLD),
      rowKey.area(TEAM, CU),
      rowKey.session(OWNER_CU),
      rowKey.child("ses_child_of_cu", 1),
      rowKey.others(TEAM, CU),
      rowKey.session(OWNER_CU_OLD),
      rowKey.area(TEAM, PERF),
      rowKey.area(TEAM, SIWC),
      rowKey.outside(PROJECT),
      rowKey.worktree(PROJECT, `${HOME}\\.claude\\worktrees\\tool-a`),
      rowKey.session("ses_tool"),
    ])
    const level = (key: string) => levelOf(key, out.levels)
    expect(team.map(level)).toEqual([1, 2, 2, 2, 2, 3, 2, 3, 4, 3, 4, 2, 2, 2, 2, 3])
    expect(level(rowKey.request(MAIN, "per_main"))).toBe(3)
    expect(level(rowKey.session("ses_plain"))).toBe(2)
  })

  test("팀에 넣지 않은 작업 폴더 lists the folders the team could take in first, with or without conversations", () => {
    const view = project([withLeft()])
    expect(tree({ view }).counts[rowKey.outside(PROJECT)]).toBe(2)
    const out = tree({ view, expanded: [foldKey.outside(PROJECT)] })
    const outside = out.keys.slice(
      out.keys.indexOf(rowKey.outside(PROJECT)),
      out.keys.indexOf(rowKey.project("prj_plain")),
    )
    expect(outside).toEqual([
      rowKey.outside(PROJECT),
      rowKey.worktree(PROJECT, LEFT),
      rowKey.worktree(PROJECT, TOOL),
      rowKey.session("ses_tool"),
    ])
    expect(levelOf(rowKey.session("ses_tool"), out.levels)).toBe(3)
  })

  test("search lists the project's sessions as usual (no team groups)", () => {
    const out = tree({ search: true })
    expect(out.keys.slice(0, 6)).toEqual([
      rowKey.project(PROJECT),
      rowKey.session("ses_tool"),
      rowKey.session(OWNER_CU),
      rowKey.session(MAIN),
      rowKey.session(OWNER_CU_OLD),
      rowKey.session(MAIN_OLD),
    ])
  })

  test("row keys parse back and team rows have fixed heights", () => {
    expect(parseKey(rowKey.area(TEAM, CU))).toEqual({ kind: "area", id: TEAM, extra: CU })
    expect(parseKey(rowKey.request("ses_a", "per_1"))).toEqual({ kind: "request", id: "ses_a", extra: "per_1" })
    expect(parseKey(rowKey.others(TEAM, HOME_GROUP))).toEqual({ kind: "others", id: TEAM, extra: HOME_GROUP })
    expect(parseKey(rowKey.outside(PROJECT)).kind).toBe("outside")
    expect(parseKey(rowKey.requests(PROJECT)).kind).toBe("requests")
    expect(parseKey(rowKey.notices(PROJECT))).toEqual({ kind: "notices", id: PROJECT, extra: undefined })
    expect(parseKey(rowKey.notice("01JB0000000000000000000001"))).toEqual({
      kind: "notice",
      id: "01JB0000000000000000000001",
      extra: undefined,
    })
    const heights = rowHeights("comfortable", false)
    expect(heightOf(rowKey.area(TEAM, CU), heights)).toBe(heights.session)
    expect(heightOf(rowKey.request("s", "r"), heights)).toBe(heights.session)
    expect(heightOf(rowKey.others(TEAM, CU), heights)).toBe(heights.child)
    expect(heightOf(rowKey.outside(PROJECT), heights)).toBe(heights.child)
    expect(heightOf(rowKey.requests(PROJECT), heights)).toBe(heights.child)
    expect(heightOf(rowKey.notices(PROJECT), heights)).toBe(heights.child)
    expect(heightOf(rowKey.notice("01JB0000000000000000000001"), heights)).toBe(heights.session)
  })

  test("notice rows in the window's language: a fetched folder's count and size, the service's words as fallback", () => {
    const fetched = { kind: "paths.added" as const, text: "화면: 서버 문장", data: { count: 1, bytes: 1_200_000 } }
    expect(noticeLine("ko", fetched, "화면", 0)).toBe("화면: 큰 파일 폴더 1개(1.2MB)를 가져왔어요")
    expect(noticeLine("en", fetched, "화면", 0)).toBe("화면: fetched 1 large-file folders (1.2 MB)")
    // The guard's fix names no size: the service's words stand.
    const fixed = { kind: "paths.added" as const, text: "화면: 서버 문장", data: { count: 1, dirs: "media" } }
    expect(noticeLine("ko", fixed, "화면", 0)).toBe("화면: 서버 문장")
    const repair = {
      kind: "preset.repair" as const,
      text: "server",
      data: { presetID: "pre_x", preset: "DeepSeek 기본", accountID: "acc_02", account: "ChatGPT 02", roles: "리뷰" },
    }
    expect(noticeLine("ko", repair, "서버", 0)).toBe(
      "'DeepSeek 기본'이 ChatGPT 02를 써서 서버 리뷰를 서버 모델로 돌려요",
    )
    const moved = { kind: "account.moved" as const, text: "server", data: { account: "ChatGPT 02", n: 2 } }
    expect(noticeLine("ko", moved, undefined, 0)).toBe("팀이 ChatGPT 02로 옮겼어요 · 영역 2개 새 대화")
    // A team main's rotation names no area: the service's words stand.
    expect(noticeLine("ko", { kind: "rotation.done", text: "팀 메인이 새 대화로 이어졌어요." }, undefined, 0)).toBe(
      "팀 메인이 새 대화로 이어졌어요.",
    )
  })
})

describe("area peers (동료) in the team view (06 §9.4, 2026-10-09)", () => {
  const REVIEWER = "ses_peer_reviewer"
  const TESTER = "ses_peer_tester"
  const CU_DIR = `${HOME}\\.worktrees\\cl-cu`
  const peer = (key: string, sessionID: string, label: string) => ({
    key,
    sessionID,
    label,
    role: "바뀐 코드를 읽고 문제를 알려요",
    attached: false,
    origin: "registered",
    at: 1,
  })
  /** cl-cu with its owner, an earlier owner and two peers; the tester works in a folder outside the area. */
  const peered = () =>
    entry([
      area(CU, {
        subtitle: "컴퓨터 사용",
        owner: {
          sessionID: OWNER_CU,
          previous: [{ sessionID: OWNER_CU_OLD, endedAt: 2, why: "fresh" }],
          attached: true,
        },
        peers: [peer("reviewer", REVIEWER, "리뷰어"), peer("tester", TESTER, "테스터")],
      }),
      ...areas().slice(1),
    ])
  const view = (permissions: (sessionID: string) => { id: string; sessionID: string }[] | undefined = () => []) =>
    teamProject({ entries: [peered()], family: (sessionID) => [sessionID], permissions, notices: [] })

  test("the registry's `peers` place a conversation as the area's peer, wherever its folder is", () => {
    const slot = view().slot
    expect(slot(REVIEWER, CU_DIR)).toEqual({ kind: "peer", teamID: TEAM, areaID: CU, key: "reviewer" })
    expect(slot(TESTER, "E:\\scratch\\tester")).toEqual({ kind: "peer", teamID: TEAM, areaID: CU, key: "tester" })
    // Another conversation of the folder, whatever its metadata says, stays with the area's other conversations; the
    // owner and the earlier owner keep their places.
    expect(slot("ses_direct", CU_DIR)).toEqual({ kind: "area", teamID: TEAM, areaID: CU })
    expect(slot(OWNER_CU, CU_DIR)).toEqual({ kind: "owner", teamID: TEAM, areaID: CU })
    expect(slot(OWNER_CU_OLD, CU_DIR)).toEqual({ kind: "area", teamID: TEAM, areaID: CU })
    // A peer's permission requests wait in `승인 기다리는 것 n개` with the team's.
    const asked = view((sessionID) => (sessionID === REVIEWER ? [{ id: "per_peer", sessionID: REVIEWER }] : []))
    expect(asked.requests).toEqual([{ sessionID: REVIEWER, requestID: "per_peer" }])
  })

  test("peers are listed under the owner, before `이 영역의 다른 대화 n`, which no longer counts them", () => {
    const sessions: Record<string, { projectID: string; updated: number; directory: string }> = {
      [TESTER]: { projectID: PROJECT, updated: 9, directory: "E:\\scratch\\tester" },
      ses_direct: { projectID: PROJECT, updated: 8, directory: CU_DIR },
      [REVIEWER]: { projectID: PROJECT, updated: 7, directory: CU_DIR },
      [OWNER_CU]: { projectID: PROJECT, updated: 6, directory: CU_DIR },
      [MAIN]: { projectID: PROJECT, updated: 5, directory: HOME },
    }
    const out = flattenTree({
      order: Object.keys(sessions),
      session: (id) => sessions[id],
      collapsed: () => false,
      expanded: (key) => key === foldKey.others(TEAM, CU),
      children: () => [],
      marks: dayMarks(10),
      more: false,
      team: () => view(),
    })
    const cu = out.keys.slice(out.keys.indexOf(rowKey.area(TEAM, CU)), out.keys.indexOf(rowKey.area(TEAM, PERF)))
    expect(cu).toEqual([
      rowKey.area(TEAM, CU),
      rowKey.session(OWNER_CU),
      rowKey.session(TESTER),
      rowKey.session(REVIEWER),
      rowKey.others(TEAM, CU),
      rowKey.session("ses_direct"),
    ])
    expect(out.counts[rowKey.others(TEAM, CU)]).toBe(1)
    expect(cu.map((key) => levelOf(key, out.levels))).toEqual([2, 3, 3, 3, 3, 4])
    expect(out.positions.get(rowKey.session(REVIEWER))).toEqual([3, 3])
    // A peer row's second line names it.
    expect(ko("own.team.peer.row", { label: "리뷰어" })).toBe("리뷰어 · 동료")
    expect(teamText.text("en", "own.team.peer.row", { label: "Reviewer" })).toBe("Reviewer · Peer")
  })

  test("동료 추가… after 담당과 대화 열기, only with `peers`, the admin scope and an active area", () => {
    const every = (method: TeamMethod) => TEAM_SCOPE[method] !== undefined
    const device = (method: TeamMethod) => TEAM_SCOPE[method] === "read" || TEAM_SCOPE[method] === "prompt"
    const owned = area(CU, { owner: { sessionID: OWNER_CU, previous: [], attached: true } })
    expect(areaActions({ area: owned, has: () => true, allowed: every }).slice(0, 2)).toEqual(["open", "addPeer"])
    expect(areaActions({ area: area(CU), has: () => true, allowed: every })[0]).toBe("addPeer")
    expect(areaActions({ area: owned, has: (feature) => feature !== "peers", allowed: every })).not.toContain("addPeer")
    expect(areaActions({ area: owned, has: () => true, allowed: device })).not.toContain("addPeer")
    expect(
      areaActions({ area: owned, has: () => true, allowed: (method) => method !== "area.peer.add" && every(method) }),
    ).not.toContain("addPeer")
    for (const state of ["broken", "retiring", "retired"])
      expect(areaActions({ area: area(CU, { state }), has: () => true, allowed: every }), state).not.toContain(
        "addPeer",
      )
    expect(ko("own.team.areaMenu.addPeer")).toBe("동료 추가…")
  })

  test("팀과 이야기하는 대화: the owner first with the owner note, then the peers with their roles", () => {
    const cu = peered().areas[CU]!
    const role = "바뀐 코드를 읽고 문제를 알려요"
    expect(areaTalkers(cu)).toEqual([
      { kind: "owner", sessionID: OWNER_CU, note: "" },
      { kind: "peer", sessionID: REVIEWER, key: "reviewer", label: "리뷰어", note: role },
      { kind: "peer", sessionID: TESTER, key: "tester", label: "테스터", note: role },
    ])
    const noted = area(CU, { owner: { sessionID: OWNER_CU, previous: [], attached: true, note: "설계를 맡아요" } })
    // An owner without peers is listed too, so its note can be read and changed.
    expect(areaTalkers(noted)).toEqual([{ kind: "owner", sessionID: OWNER_CU, note: "설계를 맡아요" }])
    // No owner conversation yet: the peers only; an area nobody talks with has no group.
    const waiting = area(CU, {
      owner: { sessionID: null, previous: [], attached: false },
      peers: [peer("reviewer", REVIEWER, "리뷰어")],
    })
    expect(areaTalkers(waiting).map((item) => item.kind)).toEqual(["peer"])
    expect(areaTalkers(area(CU))).toEqual([])
    expect(ko("own.team.talkers.title")).toBe("팀과 이야기하는 대화")
  })
})

describe("area rows (06 §9.1, §9.4, 07 §7.4)", () => {
  test("label, short path, `모델: 팀과 같게`, preset dimmed for 평소대로, status words", () => {
    const row = areaRow(ko, area(CU, { subtitle: "컴퓨터 사용", status: { kind: "busy", at: 1, text: "" } }), {
      home: HOME,
      waiting: 1,
      preset: { name: "평소대로", builtin: true },
    })
    expect(row).toEqual({
      label: "cl-cu · 컴퓨터 사용 · 담당",
      path: ".worktrees\\cl-cu",
      main: "모델: 팀과 같게",
      preset: "프리셋: 평소대로",
      builtin: true,
      status: { word: "작업 중", tone: "working", waiting: "요청 1개 기다림" },
    })
  })

  test("an own main names model, effort and account; Main 멈춤 counts waiting requests; limits show their time", () => {
    const paused = areaRow(ko, area(PERF, { paused: "user" }), {
      home: HOME,
      waiting: 2,
      main: { model: "Claude Opus 5.5", effort: "high", account: "Claude 구독" },
      preset: { name: "다른 회사 리뷰", builtin: false },
    })
    expect(paused.main).toBe("모델: Claude Opus 5.5 · high @ Claude 구독")
    // 직접 작업 (2026-11-14): its own word, with the requests that wait for the hand-back; Main 멈춤 says its own first.
    const direct = (fields: Record<string, unknown>, waiting: number) =>
      areaRow(ko, area(PERF, { directWork: { since: 1, at: 2 }, ...fields }), {
        home: HOME,
        waiting,
        preset: { name: "평소대로", builtin: true },
      }).status
    expect(direct({}, 2)).toEqual({ word: "직접 작업 중 · 요청 2개 기다림", tone: "paused" })
    expect(direct({ status: { kind: "busy", at: 1, text: "" } }, 0)).toEqual({ word: "직접 작업 중", tone: "paused" })
    expect(direct({ paused: "user" }, 1).word).toBe("메인 멈춤 · 요청 1개 기다림")
    expect(paused.status.word).toBe("메인 멈춤 · 요청 2개 기다림")
    expect(paused.builtin).toBe(false)
    const until = new Date(2026, 9, 2, 14, 20).getTime()
    // The coming time in the reset style (`@/limits/format` `coming`, LV): relative within a day.
    const quota = areaRow(ko, area(SIWC, { status: { kind: "waiting-quota", at: 1, text: "", until } }), {
      home: HOME,
      waiting: 0,
      preset: { name: "평소대로", builtin: true },
      now: until - 2 * 3_600_000 - 14 * 60_000,
      time: (at) => coming(createI18n("ko"), until - 2 * 3_600_000 - 14 * 60_000, at),
    })
    expect(quota.status.word).toBe("한도 대기 · 2시간 14분 후에 풀림")
    expect(quota.path).toBe(".worktrees\\cl-siwc")
  })

  test("a folder outside the main folder shows `<parent>\\<name>`", () => {
    expect(shortPath("D:\\own-open-code-team\\cl-siwc", HOME)).toBe("own-open-code-team\\cl-siwc")
    expect(shortPath("/home/me/own-team/web/", "/home/me/own")).toBe("own-team/web")
    expect(shortPath(`${HOME}\\.worktrees\\cl-cu\\`, `${HOME}\\`)).toBe(".worktrees\\cl-cu")
  })
})

describe("팀에 넣기, stopped areas and T2 notices (06 §8.8, §9.4, §9.7)", () => {
  const every = (method: TeamMethod) => TEAM_SCOPE[method] !== undefined
  const device = (method: TeamMethod) => TEAM_SCOPE[method] === "read" || TEAM_SCOPE[method] === "prompt"
  const T2 = (feature: OwnTeam.Feature): boolean => feature === "adopt" || feature === "integrate"

  test("only folders left out with work are offered; others stay outside for good", () => {
    expect(project([withLeft()]).unadopted).toEqual([{ teamID: TEAM, directory: LEFT }])
    expect(project().unadopted).toEqual([])
  })

  test("a folder taken in is an area at once, before reconcile drops it from `team.external`", () => {
    const left = withLeft()
    const taken = area("ar_cl-x", { origin: "adopted", directory: "d:/own-open-code/.worktrees/CL-X/" })
    const view = project([{ ...left, areas: { ...left.areas, [taken.id]: taken }, order: [...left.order, taken.id] }])
    expect(view.unadopted).toEqual([])
    expect(view.slot("ses_x", LEFT)).toEqual({ kind: "area", teamID: TEAM, areaID: taken.id })
  })

  test("[팀에 넣기] on the folder rows once the build adopts and the connection may (area.adopt)", () => {
    const view = project([withLeft()])
    const target = (directory: string, has = T2, allowed = every) =>
      adoptTarget({ project: view, directory, has, allowed })
    // Windows paths compare without case and separators.
    expect(target("d:/own-open-code/.worktrees/CL-X/")).toBe(TEAM)
    expect(target(TOOL)).toBeUndefined()
    expect(target("D:\\#Projects\\own-open-code")).toBeUndefined()
    // A T1 build has no `adopt`; a gateway device has no `admin`.
    expect(target(LEFT, () => false)).toBeUndefined()
    expect(target(LEFT, T2, device)).toBeUndefined()
    expect(adoptTarget({ project: undefined, directory: LEFT, has: T2, allowed: every })).toBeUndefined()
  })

  test("stopped areas say why in both languages; their menu keeps only what does not need the folder", () => {
    const stopped = (why: OwnTeam.BrokenReason) =>
      area(CU, {
        origin: "adopted",
        state: "broken",
        broken: { why, at: 5 },
        status: { kind: "broken", at: 5, text: "" },
        owner: { sessionID: OWNER_CU, previous: [], attached: true },
      })
    const row = (why: OwnTeam.BrokenReason, text = ko) =>
      areaRow(text, stopped(why), { home: HOME, waiting: 2, preset: { name: "평소대로", builtin: true } }).status
    expect(row("missing")).toEqual({ word: "찾을 수 없음", tone: "error" })
    expect(row("identity")).toEqual({ word: "멈춤(폴더 정보 불일치)", tone: "error" })
    expect(row("branch-gone").word).toBe("멈춤(기록이 지워짐)")
    expect(row("missing", (key, params) => teamText.text("en", key, params)).word).toBe("Not found")
    // The registry's status alone (no `broken` record yet) reads as missing.
    expect(
      areaRow(ko, area(PERF, { status: { kind: "broken", at: 5, text: "" } }), {
        home: HOME,
        waiting: 0,
        preset: { name: "평소대로", builtin: true },
      }).status.word,
    ).toBe("찾을 수 없음")
    const menu = areaActions({ area: stopped("missing"), has: () => true, allowed: every })
    expect(menu).toContain("unadopt")
    for (const item of ["rotate", "main", "preset", "paths", "integrate"] as const) expect(menu).not.toContain(item)
    expect(areaActions({ area: area(CU, { state: "broken" }), has: () => true, allowed: every })).not.toContain(
      "unadopt",
    )
  })

  test("T2 notices heard as events are listed in `팀 알림 n개` with their words", async () => {
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const store = createTeamStore({ rpc: fakeRpc(), bus, reloadMs: 1 })
      await store.resync()
      const heard: Array<[string, Record<string, unknown>]> = [
        ["branch.followed", { areaID: CU, data: { from: "cl-cu", branch: "cl-cu-2" } }],
        ["area.broken", { areaID: PERF, data: { why: "missing" } }],
        ["link.copy.dirty", { areaID: CU, data: { count: 1, paths: "tools/run" } }],
        ["drift.repaired", { areaID: CU }],
        ["integration.waiting", { areaID: CU, data: { folder: HOME, why: "dirty", count: 2 } }],
      ]
      heard.forEach(([kind, fields], index) =>
        bus.publish(ownTeamEvent("notice", 10 + index, { teamID: TEAM, kind, text: kind, ...fields })),
      )
      bus.flush()
      const view = teamProject({
        entries: Object.values(store.state.teams),
        family: () => [],
        permissions: () => undefined,
        notices: store.state.notices,
      })
      expect(view.notices).toHaveLength(5)
      const out = flattenTree({
        order: [MAIN],
        session: () => ({ projectID: PROJECT, updated: 1, directory: HOME }),
        collapsed: () => false,
        expanded: () => false,
        children: () => [],
        marks: dayMarks(1),
        more: false,
        team: () => view,
      })
      expect(out.counts[rowKey.notices(PROJECT)]).toBe(5)
      expect(out.keys.slice(1, 7)).toEqual([rowKey.notices(PROJECT), ...view.notices.map((id) => rowKey.notice(id))])
      const words = store.state.notices.map((notice) =>
        noticeLine("ko", notice, notice.areaID ? store.area(notice.teamID, notice.areaID)?.name : undefined, 0),
      )
      expect(words).toEqual([
        "'cl-cu' 반영을 기다려요. own-open-code 폴더의 일이 끝나면 다시 반영하세요",
        "담당이 받지 않은 폴더에 파일을 만들어서 그 폴더를 이 영역에 들였어요",
        "'cl-cu': 고친 바로 가기 파일 사본이 있어 지우기와 내려놓기를 하지 않아요",
        "'cl-perf' 폴더를 찾을 수 없어요",
        "'cl-cu' 영역이 다른 기록으로 바뀌어 따라갔어요",
      ])
      store.dispose()
      bus.dispose()
      dispose()
    })
  })
})

describe("held team updates on the minute clock (06 §9.7, LV 2026-10-25)", () => {
  test("`wake.limited` counts down with the clock it is read at and leaves `팀 알림 n개` once its time passed", async () => {
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const store = createTeamStore({ rpc: fakeRpc(), bus, reloadMs: 1 })
      await store.resync()
      const until = Date.UTC(2026, 9, 2, 5, 30)
      bus.publish(ownTeamEvent("notice", 20, { teamID: TEAM, kind: "wake.limited", text: "server", data: { until } }))
      bus.publish(ownTeamEvent("notice", 21, { teamID: TEAM, kind: "drift.repaired", areaID: CU, text: "server" }))
      bus.flush()
      const held = store.state.notices.find((notice) => notice.kind === "wake.limited")!
      // The fake minute clock: the row reads the time left at each tick, not when the notice came.
      expect(noticeLine("ko", held, undefined, until - 42 * 60_000)).toBe(
        "팀 소식이 한 시간에 12번을 넘어 42분 후까지 모아 둬요",
      )
      expect(noticeLine("ko", held, undefined, until - 5 * 60_000)).toBe(
        "팀 소식이 한 시간에 12번을 넘어 5분 후까지 모아 둬요",
      )
      const listed = (now: number) =>
        teamProject({
          entries: Object.values(store.state.teams),
          family: () => [],
          permissions: () => undefined,
          notices: liveNotices(store.state.notices, now),
        }).notices
      expect(listed(until - 60_000)).toHaveLength(2)
      // Its time passed: own.team sends what it held, the notice goes; the others stay until closed.
      expect(listed(until)).toEqual([store.state.notices.find((notice) => notice.kind === "drift.repaired")!.id])
      store.dispose()
      bus.dispose()
      dispose()
    })
  })

  test("the rows and the tree read it on the shared minute clock", async () => {
    const code = async (file: string) => Bun.file(path.join(import.meta.dir, file)).text()
    expect(await code("rows.tsx")).toContain("view.notice(i18n.locale(), current, area()?.name, minuteNow())")
    expect(await code("controller.ts")).toContain("teamView()?.live(team.state.notices, minuteNow())")
  })
})

describe("area menu groups (06 §9.4, 2026-10-16)", () => {
  const every = (method: TeamMethod) => TEAM_SCOPE[method] !== undefined
  const owned = area(CU, { owner: { sessionID: OWNER_CU, previous: [], attached: true } })

  test("every action is in exactly one group, and groups keep their order and drop when empty", () => {
    const all: readonly AreaAction[] = [
      "open",
      "discuss",
      "addPeer",
      "handBack",
      "pause",
      "outbox",
      "rotate",
      "main",
      "preset",
      "role",
      "alias",
      "userMade",
      "paths",
      "integrate",
      "rename",
      "split",
      "merge",
      "convert",
      "move",
      "recreate",
      "retire",
      "unadopt",
      "details",
    ]
    const grouped = AREA_GROUPS.flatMap(([, actions]) => actions)
    expect(grouped.toSorted()).toEqual([...all].toSorted())
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(areaGroups(["open", "pause", "outbox", "rotate", "main", "preset", "paths", "rename", "details"])).toEqual([
      { group: "talk", actions: ["open", "rotate"] },
      { group: "requests", actions: ["pause", "outbox"] },
      { group: "settings", actions: ["main", "preset"] },
      { group: "work", actions: ["paths"] },
      { group: "structure", actions: ["rename"] },
      { group: "details", actions: ["details"] },
    ])
  })

  test("팀 메인과 상의하기 only with discuss: true and only on an active area, right after 담당과 대화 열기", () => {
    expect(areaActions({ area: owned, has: () => true, allowed: every, discuss: true }).slice(0, 2)).toEqual([
      "open",
      "discuss",
    ])
    expect(areaActions({ area: owned, has: () => true, allowed: every })).not.toContain("discuss")
    expect(
      areaActions({ area: area(CU, { state: "broken" }), has: () => true, allowed: every, discuss: true }),
    ).not.toContain("discuss")
  })

  test("메인에게 넘기기 (2026-11-14) leads 메인 요청, only while the user works there directly and the build and scope allow it", () => {
    const held = area(CU, {
      owner: { sessionID: OWNER_CU, previous: [], attached: true },
      directWork: { since: 1, at: 2 },
    })
    const actions = areaActions({ area: held, has: () => true, allowed: every })
    expect(areaGroups(actions).find((group) => group.group === "requests")).toEqual({
      group: "requests",
      actions: ["handBack", "pause", "outbox"],
    })
    // Not held, held under Main 멈춤 (turning that off ends both), a build without `direct`, a device without the scope.
    expect(areaActions({ area: owned, has: () => true, allowed: every })).not.toContain("handBack")
    for (const paused of ["user", "all"] as const)
      expect(
        areaActions({ area: area(CU, { paused, directWork: { since: 1, at: 2 } }), has: () => true, allowed: every }),
        paused,
      ).not.toContain("handBack")
    expect(areaActions({ area: held, has: (feature) => feature !== "direct", allowed: every })).not.toContain(
      "handBack",
    )
    expect(
      areaActions({ area: held, has: () => true, allowed: (method) => method !== "area.pause" && every(method) }),
    ).not.toContain("handBack")
    expect(ko("own.team.action.handBack")).toBe("메인에게 넘기기")
    expect(ko("own.team.areaMenu.handBackHint")).toBe("기다리던 메인 요청이 들어가고, 그동안의 보고가 메인에게 가요")
  })

  test("a missing area's 다시 만들기 is a 작업 item, not inside the folded 구성 바꾸기", () => {
    expect(areaGroups(["recreate", "rename", "retire"])).toEqual([
      { group: "work", actions: ["recreate"] },
      { group: "structure", actions: ["rename"] },
      { group: "danger", actions: ["retire"] },
    ])
  })
})

describe("area menu items (06 §9.4)", () => {
  const T1: readonly OwnTeam.Feature[] = [
    "enable",
    "pause",
    "outbox",
    "rotate",
    "area-main",
    "area-preset",
    "team-account",
    "paths",
    "reorg.new",
    "reorg.rename",
    "settings",
    "diagnostics",
  ]
  const every = (method: TeamMethod) => TEAM_SCOPE[method] !== undefined
  const owned = area(CU, { owner: { sessionID: OWNER_CU, previous: [], attached: true } })

  test("T1 items in menu order; 반영하기, 영역 끝내기 and 팀에서 빼기 wait for builds that have them", () => {
    expect(areaActions({ area: owned, has: (feature) => T1.includes(feature), allowed: every })).toEqual([
      "open",
      "pause",
      "outbox",
      "rotate",
      "main",
      "preset",
      "paths",
      "rename",
      "details",
    ])
    const later = areaActions({
      area: area(CU, { origin: "adopted", owner: { sessionID: OWNER_CU, previous: [], attached: true } }),
      has: () => true,
      allowed: every,
    })
    expect(later).toEqual(expect.arrayContaining(["integrate", "retire", "unadopt"]))
  })

  test("a build without a feature, a device without the scope, a full folder or no conversation hide items", () => {
    const device = areaActions({
      area: owned,
      has: (feature) => T1.includes(feature),
      allowed: (method) => TEAM_SCOPE[method] === "read" || TEAM_SCOPE[method] === "prompt",
    })
    expect(device).toEqual(["open", "pause", "outbox", "rotate", "paths", "details"])
    expect(areaActions({ area: area(CU, { shape: "plain" }), has: () => true, allowed: every })).not.toContain("paths")
    expect(areaActions({ area: area(CU), has: () => true, allowed: every })).not.toContain("open")
    expect(areaActions({ area: area(CU), has: () => true, allowed: every })).not.toContain("rotate")
    expect(areaActions({ area: owned, has: () => false, allowed: every })).toEqual(["open", "details"])
    expect(areaActions({ area: area(CU, { state: "broken" }), has: () => true, allowed: every })).not.toContain("main")
  })

  test("a T2 build adds 이 영역 반영하기 and, for an adopted area, 팀에서 빼기; 영역 끝내기 waits for T3", () => {
    const T2: readonly OwnTeam.Feature[] = [...T1, "adopt", "integrate", "push", "decisions"]
    const adopted = area(CU, { origin: "adopted", owner: { sessionID: OWNER_CU, previous: [], attached: true } })
    expect(areaActions({ area: adopted, has: (feature) => T2.includes(feature), allowed: every })).toEqual([
      "open",
      "pause",
      "outbox",
      "rotate",
      "main",
      "preset",
      "paths",
      "integrate",
      "rename",
      "unadopt",
      "details",
    ])
    expect(areaActions({ area: owned, has: (feature) => T2.includes(feature), allowed: every })).not.toContain(
      "unadopt",
    )
    // A gateway device sees neither (`admin`).
    const device = areaActions({
      area: adopted,
      has: (feature) => T2.includes(feature),
      allowed: (method) => TEAM_SCOPE[method] === "read" || TEAM_SCOPE[method] === "prompt",
    })
    expect(device).not.toContain("integrate")
    expect(device).not.toContain("unadopt")
  })

  test("이름 바꾸기 is the user's own reorg proposal", () => {
    const proposal = renameProposal(CU, "  컴퓨터 사용 ", " ")
    expect(decodeProposal(proposal)).toEqual(proposal)
    expect(proposal.ops).toEqual([{ op: "rename", area: CU, name: "컴퓨터 사용", subtitle: null }])
  })

  test("새 영역 is the user's own reorg proposal; the slug follows V6 and avoids the team's", () => {
    const latin = newAreaProposal("  Inventory UI ", " 정렬 버그 ", ["cl-cu"])
    expect(decodeProposal(latin)).toEqual(latin)
    expect(latin.ops).toEqual([{ op: "new", slug: "inventory-ui", name: "Inventory UI", goal: "정렬 버그" }])
    expect(newAreaProposal("인벤토리 화면", "", []).ops).toEqual([{ op: "new", slug: "area", name: "인벤토리 화면" }])
    expect(newAreaProposal("결제", "", ["area", "area-2"]).ops?.[0]).toMatchObject({ slug: "area-3" })
    const long = newAreaProposal("a".repeat(40), "", ["a".repeat(32)]).ops?.[0]
    expect(long).toMatchObject({ slug: `${"a".repeat(30)}-2` })
  })
})

describe("사용자가 정하는 영역 (06 §9.4, 2026-10-26)", () => {
  const every = (method: TeamMethod) => TEAM_SCOPE[method] !== undefined
  const owned = area(CU, { owner: { sessionID: OWNER_CU, previous: [], attached: true } })
  const REF = { providerID: "own-claude-1", id: "claude-opus-4-8", variant: "high" }

  test("영역 만들기 carries the folder and record name, the start, the model, the 에이전트 방식 and the mark", () => {
    const made = newAreaProposal(" 몬스터 에셋 ", " 몬스터 그림 ", ["cl-cu"], {
      slug: "monster-assets",
      from: "cl-cu",
      main: REF,
      harness: { id: "codex", prompt: "own" },
      userMade: true,
    })
    expect(decodeProposal(made)).toEqual(made)
    const ops: unknown = made.ops
    expect(ops).toEqual([
      {
        op: "new",
        slug: "monster-assets",
        name: "몬스터 에셋",
        goal: "몬스터 그림",
        from: "cl-cu",
        main: REF,
        harness: { id: "codex", prompt: "own" },
        userMade: true,
      },
    ])
    // `main` as the start and 팀과 같게 add nothing; an empty slug follows the name.
    expect(newAreaProposal("Items", "", [], { slug: " ", from: "main" }).ops).toEqual([
      { op: "new", slug: "items", name: "Items" },
    ])
  })

  test("an existing folder joins as a user-made area of the typed name, its record name after the folder; only folders left out are offered", () => {
    const joined = adoptAreaProposal("시뮬레이션", "시드 비교", LEFT, ["cl-cu"])
    expect(decodeProposal(joined)).toEqual(joined)
    expect(joined.areas).toEqual([
      { slug: "cl-x", name: "시뮬레이션", goal: "시드 비교", adopt: { worktree: LEFT }, userMade: true },
    ])
    expect(createFolders(withLeft())).toEqual([LEFT])
    const taken = entry([...areas(), area("ar_cl-x", { directory: LEFT })], {
      external: [{ directory: LEFT, why: "left" }],
    })
    expect(createFolders(taken)).toEqual([])
  })

  test("the folder and record name follows V6 and is checked before it is sent", () => {
    expect(freeSlug("몬스터", ["area"])).toBe("area-2")
    expect(slugValid("monster-assets")).toBe(true)
    expect(slugValid("a".repeat(32))).toBe(true)
    for (const bad of ["", "-x", "Monster", "a b", "a".repeat(33), "몬스터"]) expect(slugValid(bad), bad).toBe(false)
    // Only what V6 keeps as it is (2026-10-27): own.team would make `monster` of `monster-` and `a-b` of `a--b`.
    for (const bad of ["monster-", "a--b", "x---"]) expect(slugValid(bad), bad).toBe(false)
    expect(freeSlug("Monster Assets!", [])).toBe("monster-assets")
    expect(slugValid(freeSlug("Monster Assets!", []))).toBe(true)
  })

  test("역할 바꾸기… and 내가 정한 영역 in 설정, with `area-edit`, the admin scope and an active area", () => {
    const menu = areaActions({ area: owned, has: () => true, allowed: every })
    expect(menu).toEqual(expect.arrayContaining(["role", "userMade"]))
    expect(areaGroups(menu).find((group) => group.group === "settings")?.actions).toEqual([
      "main",
      "preset",
      "role",
      "alias",
      "userMade",
    ])
    expect(areaActions({ area: owned, has: (feature) => feature !== "area-edit", allowed: every })).not.toContain(
      "role",
    )
    const device = (method: TeamMethod) => TEAM_SCOPE[method] !== "admin" && TEAM_SCOPE[method] !== "local"
    expect(areaActions({ area: owned, has: () => true, allowed: device })).not.toContain("userMade")
    expect(areaActions({ area: area(CU, { state: "broken" }), has: () => true, allowed: every })).not.toContain("role")
  })

  test("the area row names an area the user set up", () => {
    const input = { home: HOME, waiting: 0, preset: { name: "평소대로", builtin: true } }
    expect(areaRow(ko, area(CU, { userMade: { at: 1 } }), input).userMade).toBe("내가 정한 영역")
    expect(areaRow(ko, area(CU), input).userMade).toBeUndefined()
  })

  test("the tree ends each team with `영역 만들기…` where the build makes areas and the connection may", () => {
    const view = (creates: boolean) =>
      teamProject({ entries: [entry(areas())], family: () => [], permissions: () => undefined, notices: [], creates })
    const keys = (creates: boolean) =>
      flattenTree({
        order: [MAIN],
        session: () => ({ projectID: PROJECT, updated: 1, directory: HOME }),
        collapsed: () => false,
        expanded: () => false,
        children: () => [],
        marks: dayMarks(2),
        more: false,
        team: () => view(creates),
      }).keys
    expect(keys(true).at(-1)).toBe(rowKey.create(TEAM))
    expect(keys(true).indexOf(rowKey.create(TEAM))).toBeGreaterThan(keys(true).indexOf(rowKey.area(TEAM, SIWC)))
    expect(keys(false)).not.toContain(rowKey.create(TEAM))
    expect(parseKey(rowKey.create(TEAM))).toEqual({ kind: "create", id: TEAM, extra: undefined })
    expect(heightOf(rowKey.create(TEAM), rowHeights("comfortable", false))).toBe(30)
    // Also a team without areas yet (the empty state).
    const empty = teamProject({
      entries: [entry([])],
      family: () => [],
      permissions: () => undefined,
      notices: [],
      creates: true,
    })
    expect(empty.teams[0]?.create).toBe(true)
  })

  test("팀 구성 다시 보기: a change of an area the user set up starts unchecked and says so", () => {
    const card = proposalCard(ko, {
      proposal: {
        version: 1,
        ops: [
          { op: "merge", area: "cl-cu", from: "cl-perf" },
          { op: "rename", area: "cl-siwc", name: "로그인" },
          { op: "new", slug: "docs", name: "문서" },
        ],
      },
      plan: {
        steps: [
          { item: "ops/0", kind: "merge-begin", mode: "auto" },
          { item: "ops/1", kind: "area-rename", mode: "auto" },
          { item: "ops/2", kind: "branch-create", mode: "auto" },
        ],
        rejected: [],
      },
      name: (value) => value,
      userMade: (value) => value === "cl-perf",
    })
    expect(card.lines.slice(0, 3)).toEqual([
      { text: "'cl-perf'를 'cl-cu'에 묶어요 · 내가 정한 영역", tone: "warn", item: "ops/0", checked: false },
      { text: "'cl-siwc' 영역 이름을 '로그인'으로 바꿔요", item: "ops/1", checked: true },
      { text: "새 영역 '문서'를 만들어요", item: "ops/2", checked: true },
    ])
  })

  test("팀 구성 다시 보기: 다시 만들기 of a stopped area the user set up carries the mark, so it starts unchecked", () => {
    const card = proposalCard(ko, {
      proposal: {
        version: 1,
        ops: [
          { op: "new", slug: "cl-perf", name: "성능", from: "cl-perf" },
          { op: "new", slug: "cl-next", name: "다음", from: "cl-cu" },
        ],
        areas: [{ slug: "cl-perf", name: "성능 둘", create: { from: "cl-perf" } }],
      },
      plan: {
        steps: [
          { item: "areas/0", kind: "branch-create", mode: "auto" },
          { item: "ops/0", kind: "branch-create", mode: "auto" },
          { item: "ops/1", kind: "branch-create", mode: "auto" },
        ],
        rejected: [],
      },
      name: (value) => value,
      // cl-perf is stopped and the user set it up; cl-cu is live and the user set it up too.
      userMade: (value) => value === "cl-perf" || value === "cl-cu",
      again: (value) => value === "cl-perf",
    })
    expect(card.lines).toEqual([
      { text: "새 영역 '성능 둘'을 만들어요 · 내가 정한 영역", tone: "warn", item: "areas/0", checked: false },
      { text: "새 영역 '성능'을 만들어요 · 내가 정한 영역", tone: "warn", item: "ops/0", checked: false },
      // Starting at a live area's work changes nothing of it.
      { text: "새 영역 '다음'을 만들어요", item: "ops/1", checked: true },
    ])
  })

  test("팀 구성 다시 보기: a step skipped for an area the user works with directly waits for the hand-back", () => {
    const plan: OwnTeam.Plan = {
      steps: [],
      rejected: [],
      // The wire keeps `paused` for both holds (`Plan.skipped.why`).
      skipped: [
        { item: "ops/0", areaID: OwnTeam.AreaID.make(PERF), why: "paused" },
        { item: "ops/1", areaID: OwnTeam.AreaID.make(SIWC), why: "paused" },
      ],
    }
    const card = proposalCard(ko, {
      proposal: {
        version: 1,
        ops: [
          { op: "rename", area: PERF, name: "성능" },
          { op: "rename", area: SIWC, name: "로그인" },
        ],
      },
      plan,
      name: (value) => value.replace(/^ar_/, ""),
      direct: (value) => value === PERF,
    })
    expect(card.lines).toEqual([
      {
        text: "'cl-perf' 영역 이름을 '성능'으로 바꿔요 · 'cl-perf'는 내가 직접 작업 중이라 넘길 때까지 기다려요. 고르면 넘긴 뒤 그 대화가 쉴 때 하고, 그 대화에 인계나 정리 요청이 갈 수 있어요",
        tone: "warn",
        item: "ops/0",
        checked: false,
      },
      {
        text: "'cl-siwc' 영역 이름을 '로그인'으로 바꿔요 · 'cl-siwc'는 메인 멈춤 중이에요. 고르면 그 대화가 쉴 때 하고, 그 대화에 인계나 정리 요청이 갈 수 있어요",
        tone: "warn",
        item: "ops/1",
        checked: false,
      },
    ])
  })

  test("팀 구성 다시 보기: under Main 멈춤 or 모두 멈추기 a held area's step waits for the pause, not a hand-back", () => {
    const work = { since: 1, at: 1 }
    const team = entry([
      area(PERF, { paused: "user", directWork: work }),
      area(SIWC, { paused: "all", directWork: work }),
      area(CU, { directWork: work }),
    ])
    expect([PERF, SIWC, CU].map((value) => directWaits(areaOf(team, value)))).toEqual([false, false, true])
    expect(directWaits(undefined)).toBe(false)
    const card = proposalCard(ko, {
      proposal: { version: 1, ops: [{ op: "rename", area: PERF, name: "성능" }] },
      plan: { steps: [], rejected: [], skipped: [{ item: "ops/0", areaID: OwnTeam.AreaID.make(PERF), why: "paused" }] },
      name: (value) => value.replace(/^ar_/, ""),
      direct: (value) => directWaits(areaOf(team, value)),
    })
    expect(card.lines[0]?.text).toBe(
      "'cl-perf' 영역 이름을 '성능'으로 바꿔요 · 'cl-perf'는 메인 멈춤 중이에요. 고르면 그 대화가 쉴 때 하고, 그 대화에 인계나 정리 요청이 갈 수 있어요",
    )
  })

  test("팀 구성 다시 보기: a `from` with spaces names the area as the V-rules read it; blank and main name the main", () => {
    const team = entry(areas())
    // The review's own lookup trims as the V-rules do: id, slug and name alike.
    const named = [" cl-perf ", "ar_cl-perf\n", "\tcl-perf"]
    expect(named.map((value) => areaOf(team, value)?.name)).toEqual(["cl-perf", "cl-perf", "cl-perf"])
    const asked: string[] = []
    const card = proposalCard(ko, {
      proposal: {
        version: 1,
        ops: [
          { op: "new", slug: "cl-perf", name: "성능", from: " cl-perf " },
          { op: "new", slug: "cl-a", name: "에이", from: "  " },
          { op: "new", slug: "cl-b", name: "비", from: " main" },
        ],
      },
      plan: {
        steps: [0, 1, 2].map((index) => ({ item: `ops/${index}`, kind: "branch-create", mode: "auto" as const })),
        rejected: [],
      },
      name: (value) => value,
      again: (value) => {
        asked.push(value)
        return areaOf(team, value)?.id === PERF
      },
    })
    expect(card.lines.map((line) => line.checked)).toEqual([false, true, true])
    expect(asked).toEqual(["cl-perf"])
  })

  test("팀 구성 다시 보기: when an area's mark or state changes while the card is shown, the checkboxes follow", () => {
    const shown = (marked: ReadonlySet<string>) =>
      proposalCard(ko, {
        proposal: {
          version: 1,
          ops: [
            { op: "rename", area: "cl-perf", name: "성능" },
            { op: "rename", area: "cl-cu", name: "컴퓨터" },
            { op: "rename", area: "cl-siwc", name: "로그인" },
          ],
        },
        plan: {
          steps: [0, 1, 2].map((index) => ({ item: `ops/${index}`, kind: "area-rename", mode: "auto" as const })),
          rejected: [],
        },
        name: (value) => value,
        userMade: (value) => marked.has(value),
      })
    const before = cardDefaults(shown(new Set(["cl-cu"])))
    expect([...before]).toEqual([
      ["ops/0", true],
      ["ops/1", false],
      ["ops/2", true],
    ])
    // The user unchecked ops/2. Then cl-perf became the user's and cl-cu not (another window's 내가 정한 영역).
    const chosen = new Set(["ops/0"])
    const after = cardDefaults(shown(new Set(["cl-perf"])))
    expect([...rederive(chosen, before, after)].toSorted()).toEqual(["ops/1"])
    // Nothing changed: the same set, so the signal does not fire.
    expect(rederive(chosen, before, cardDefaults(shown(new Set(["cl-cu"]))))).toBe(chosen)
  })
})

describe("worst case of an area preset (06 §10.3, 07 §7.4)", () => {
  const heavy: Preset.Info = {
    ...Preset.builtin("codex"),
    id: Preset.ID.make("pr_01JB0000000000000000000000"),
    name: "적극적으로",
    delegation: "active",
  }
  const presets = (presetID: string) => (presetID === heavy.id ? heavy : Preset.builtin("codex"))

  test("a heavy preset shows the line with the shared account; light ones show none", () => {
    const team = entry(areas())
    expect(
      worstWith(ko, team, { areaID: CU, presetID: heavy.id }, presets, Preset.ULTRA_LEVEL, { shared: "ChatGPT 01" }),
    ).toBe("영역 3개 × (담당 1 + 하위 에이전트 동시 3) = 최대 12개 동시 실행 · ChatGPT 01 한도를 함께 써요")
    expect(worstWith(ko, team, { areaID: CU, presetID: "builtin:codex" }, presets, Preset.ULTRA_LEVEL, {})).toBe(
      undefined,
    )
  })
})

describe("team hint on forks and children (06 §9.4)", () => {
  const meta = { [TEAM_META.session]: { role: "owner", teamID: TEAM, areaID: CU }, "own.note": "n" }

  test("a fork's metadata loses own.team's hint with the flags; nothing else changes", () => {
    expect(withoutFlags(meta)).toEqual({ "own.note": "n" })
    expect(withoutFlags({ ...meta, "own.pinned": 3 })).toEqual({ "own.note": "n" })
    expect(withoutFlags({ "own.note": "n" })).toBeUndefined()
  })

  test("`session.forked` writes the fork without the hint and leaves a child alone", async () => {
    const infos: Record<string, Pick<SessionInfo, "id" | "parentID" | "metadata">> = {
      ses_fork: { id: "ses_fork", metadata: meta },
      ses_child: { id: "ses_child", parentID: OWNER_CU, metadata: meta },
    }
    const writes: Array<{ sessionID: string; metadata: unknown }> = []
    const client = {
      session: {
        get: async (input: { sessionID: string }) => infos[input.sessionID],
        update: async (input: { sessionID: string; metadata: unknown }) => void writes.push(input),
      },
    }
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      // SAFETY: the flag store calls only `session.get` and `session.update` of the client.
      const flags = createOwnFlags({ serverKey: "team-hint", bus, client: () => client as unknown as OpenCodeClient })
      bus.publish(event("session.forked", { sessionID: "ses_fork" }))
      bus.publish(event("session.forked", { sessionID: "ses_child" }))
      bus.flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(writes).toEqual([{ sessionID: "ses_fork", metadata: { "own.note": "n" } }])
      flags.dispose()
      dispose()
    })
  })
})

describe("team requests in OS notifications (06 §9.4, §10.1)", () => {
  test("registry mains and owners merge per team; hints, earlier conversations and others do not", async () => {
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const infos: Record<string, Pick<SessionInfo, "parentID" | "metadata">> = {
        ses_hinted: { metadata: { [TEAM_META.session]: { role: "main", teamID: OTHER_TEAM } } },
      }
      const store = createTeamStore({ rpc: fakeRpc(), bus, session: (id) => infos[id], reloadMs: 1 })
      await store.resync()
      const expected = { teamID: team().id, projectID: PROJECT }
      expect(teamOf(store, MAIN)).toEqual(expected)
      expect(teamOf(store, OWNER_CU)).toEqual(expected)
      expect(teamOf(store, OWNER_CU_OLD)).toBeUndefined()
      expect(teamOf(store, MAIN_OLD)).toBeUndefined()
      expect(store.placeOf("ses_hinted")?.hint).toBe(true)
      expect(teamOf(store, "ses_hinted")).toBeUndefined()
      expect(teamOf(store, "ses_unrelated")).toBeUndefined()
      store.dispose()
      dispose()
    })
  })
})

function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  // SAFETY: the test builds the event shapes the flag store reads (`type`, `data`); the bus only routes by `type`.
  return { id: `evt_${Math.random()}`, created: Date.now(), type, data } as unknown as OpenCodeEvent
}

/** An own.team event as the server sends it (`rpc.own.team.<name>`, 06 §2.7); `seq` orders ids and times. */
function ownTeamEvent(name: string, seq: number, data: Record<string, unknown>): OpenCodeEvent {
  const eventId = `01JB${String(seq).padStart(22, "0")}`
  // SAFETY: shaped like `V2EventRpc`, the variant the server sends for plugin RPC events.
  return {
    id: `evt_${seq}`,
    created: 1_000 + seq,
    type: `rpc.own.team.${name}`,
    location: { directory: "C:/control" },
    data: { eventId, origin: "global", ...data },
  } as unknown as OpenCodeEvent
}

/** own.team answering `health`, `team.list` and `team.get` for one team that is on. */
function fakeRpc(): TeamRpc {
  const answers: Partial<Record<TeamMethod, unknown>> = {
    health: decodeHealth({ version: "2.0.18-own.6", buildId: "b1", guard: "ok", features: ["enable"] }),
    "team.list": { teams: [{ id: TEAM, projectID: PROJECT, home: HOME, state: "on", areas: 4 }] },
    "team.get": { team: team(), areas: areas(), waiting: {}, op: null, pending: [] },
  }
  return {
    allowed: () => true,
    scope: (method) => TEAM_SCOPE[method],
    // SAFETY: each fixture is the output of the method it answers.
    call: async (method) => answers[method] as never,
  }
}

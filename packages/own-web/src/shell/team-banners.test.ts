// Team session header pill and banners (06 §9.3, §9.5) over a real TeamStore with a fake own.team client; fixtures
// go through the protocol's schemas, so they have the shapes the service sends. Covered: the pill of an owner (with
// Main 멈춤, of a replaced conversation) and of the team main (finished areas not counted), none for a metadata hint,
// a child or a replaced main; the banners of an owner (Main 멈춤 with outbox plus parked requests, the stop button's
// Main 멈춤), of a replaced owner, of another conversation in an area's folder (and the owner on a main request), of
// an older conversation in the main folder (once); none for children, hints or other folders; and the words. An area
// peer (동료): its pill `· 동료(<이름>)` and its banner in place of the same-folder note. A conversation that gave its
// seat away (담당 대화 바꾸기): its own banner with the way to the owner and, where it may, the way back; the one that
// took the seat under Main 멈춤 says so even while nothing waits.
import { afterEach, describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { TEAM_META, TEAM_SCOPE, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import { createTeamStore, type TeamStore } from "@/team/store"
import { teamText } from "@/team/strings"
import { teamPill } from "./header"
import { teamBanners, type TeamFacts } from "./session-banners"

const TEAM = "tm_0123456789ab"
const OTHER_TEAM = "tm_aaaaaaaaaaaa"
const INVENTORY = "ar_inventory-ui"
const SAVE = "ar_save-v3"
const DOCS = "ar_docs"
const MAIN = "ses_main_now"
const MAIN_OLD = "ses_main_old"
const OWNER = "ses_owner_now"
const OWNER_OLD = "ses_owner_old"
const HOME = "D:/own-open-code"
const ROOT = "D:/own-open-code-team"

const decodeTeam = Schema.decodeUnknownSync(OwnTeam.Team)
const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)
const decodeHealth = Schema.decodeUnknownSync(OwnTeam.Health)

function team() {
  return decodeTeam({
    id: TEAM,
    projectID: "prj_own",
    commonDir: "D:/#Projects/own-open-code/.git",
    target: "main",
    state: "on",
    rev: 7,
    home: { directory: HOME, linked: true, chosenBy: "session" },
    main: { sessionID: MAIN, previous: [MAIN_OLD] },
    worktreeRoot: ROOT,
    heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
    shared: [],
    commands: { setup: null, code: [], assets: [] },
    env: { symlinkFix: "none", bunCache: "same-volume", lfs: "unused" },
    external: [],
    policy: OwnTeam.POLICY,
    patterns: [],
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
    gitDir: `D:/#Projects/own-open-code/.git/worktrees/${slug}`,
    base: { sha: "a".repeat(40), at: 1 },
    directory: `${ROOT}/${slug}`,
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

const OWNERS = {
  owner: { sessionID: OWNER, previous: [{ sessionID: OWNER_OLD, endedAt: 2, why: "fresh" }], attached: true },
}

/** An area peer (동료) of inventory-ui, created by own.team. */
const REVIEWER = "ses_reviewer"
const PEERS = {
  peers: [
    { key: "reviewer", sessionID: REVIEWER, label: "리뷰어", role: "", attached: true, origin: "created", at: 1 },
  ],
}

type Hint = Pick<SessionInfo, "parentID" | "metadata">

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

/** A TeamStore that has read one team: inventory-ui (owned, 1 request in the outbox), save-v3, a finished docs area. */
async function loaded(
  input: {
    inventory?: Record<string, unknown>
    hints?: Record<string, Hint>
    waiting?: number
    features?: string[]
    denied?: TeamMethod[]
  } = {},
) {
  const bus = createEventBus()
  const answers: Partial<Record<TeamMethod, () => unknown>> = {
    health: () =>
      decodeHealth({ version: "2.0.18-own.6", buildId: "b1", guard: "ok", features: input.features ?? ["pause"] }),
    "team.list": () => ({ teams: [{ id: TEAM, projectID: "prj_own", home: HOME, state: "on", areas: 3 }] }),
    "team.get": () => ({
      team: team(),
      areas: [
        area(INVENTORY, { ...OWNERS, ...input.inventory }),
        area(SAVE),
        area(DOCS, { state: "retired", status: { kind: "retired", at: 3, text: "" } }),
      ],
      waiting: { [INVENTORY]: input.waiting ?? 1 },
      op: null,
      pending: [],
    }),
  }
  const rpc: TeamRpc = {
    allowed: (method) => !input.denied?.includes(method),
    scope: (method) => TEAM_SCOPE[method],
    // SAFETY: every answer has the output shape of its method.
    call: async (method) => answers[method]?.() as never,
  }
  const root = createRoot((dispose) => ({
    dispose,
    store: createTeamStore({ rpc, bus, session: (sessionID) => input.hints?.[sessionID], reloadMs: 1 }),
  }))
  cleanups.push(() => {
    root.store.dispose()
    root.dispose()
    bus.dispose()
  })
  await root.store.resync()
  expect(root.store.state.load).toBe("ready")
  return root.store
}

const ko = (key: Parameters<typeof teamText.text>[1], params?: Record<string, string | number>) =>
  teamText.text("ko", key, params)

describe("header pill (06 §9.5)", () => {
  test("an owner: `영역: <이름> · 담당`, or `· 메인 멈춤` while Main 멈춤 is on; it opens the area menu", async () => {
    const store = await loaded()
    const pill = teamPill(store, OWNER)
    expect(pill).toEqual({
      kind: "area",
      key: "own.team.pill.owner",
      teamID: TEAM as OwnTeam.TeamID,
      areaID: INVENTORY as OwnTeam.AreaID,
      area: "inventory-ui",
    })
    expect(ko("own.team.pill.owner", { area: "inventory-ui" })).toBe("영역: inventory-ui · 담당")
    for (const paused of ["user", "all"]) {
      const held = teamPill(await loaded({ inventory: { paused } }), OWNER)
      expect(held).toMatchObject({ kind: "area", key: "own.team.pill.paused" })
    }
    expect(ko("own.team.pill.paused", { area: "inventory-ui" })).toBe("영역: inventory-ui · 메인 멈춤")
  })

  test("a replaced owner conversation says so", async () => {
    expect(teamPill(await loaded(), OWNER_OLD)).toMatchObject({ kind: "area", key: "own.team.pill.previous" })
  })

  test("an area peer: `영역: <이름> · 동료(<이름>)`, also under Main 멈춤; it opens the area menu", async () => {
    const pill = teamPill(await loaded({ inventory: PEERS }), REVIEWER)
    expect(pill).toEqual({
      kind: "area",
      key: "own.team.pill.peer",
      teamID: TEAM as OwnTeam.TeamID,
      areaID: INVENTORY as OwnTeam.AreaID,
      area: "inventory-ui",
      peer: "리뷰어",
    })
    expect(ko("own.team.pill.peer", { area: "inventory-ui", label: "리뷰어" })).toBe(
      "영역: inventory-ui · 동료(리뷰어)",
    )
    expect(teamText.text("en", "own.team.pill.peer", { area: "inventory-ui", label: "Reviewer" })).toBe(
      "Area: inventory-ui · Peer (Reviewer)",
    )
    const paused = await loaded({ inventory: { ...PEERS, paused: "user" } })
    expect(teamPill(paused, REVIEWER)).toMatchObject({ key: "own.team.pill.peer", peer: "리뷰어" })
    expect(teamPill(paused, OWNER)).toMatchObject({ key: "own.team.pill.paused" })
    // Removed from the peers: no pill.
    expect(teamPill(await loaded(), REVIEWER)).toBeUndefined()
  })

  test("the team main: `팀 메인 · 영역 n개` without finished areas; it opens the team view of its project", async () => {
    const store = await loaded()
    expect(teamPill(store, MAIN)).toEqual({ kind: "main", projectID: "prj_own", areas: 2 })
    expect(ko("own.team.pill.main", { n: 2 })).toBe("팀 메인 · 영역 2개")
  })

  test("no pill for a replaced main, a session the registry does not know, a metadata hint or a child", async () => {
    const hints: Record<string, Hint> = {
      ses_hinted: { metadata: { [TEAM_META.session]: { role: "owner", teamID: OTHER_TEAM, areaID: "ar_x" } } },
      ses_child: { parentID: OWNER, metadata: { [TEAM_META.session]: { role: "owner", teamID: TEAM } } },
    }
    const store = await loaded({ hints })
    expect(store.placeOf("ses_hinted")?.hint).toBe(true)
    expect(teamPill(store, MAIN_OLD)).toBeUndefined()
    expect(teamPill(store, "ses_hinted")).toBeUndefined()
    expect(teamPill(store, "ses_child")).toBeUndefined()
    expect(teamPill(store, "ses_unknown")).toBeUndefined()
  })
})

describe("banners (06 §9.3, §9.5)", () => {
  /** Facts of the session data: every session idle, nothing parked, no stop, not on a main request, nothing seen. */
  function facts(input: {
    sessions: Record<string, { parentID?: string; directory: string; moved?: boolean }>
    parked?: Record<string, number>
    running?: string[]
    stopped?: string[]
    onMain?: string[]
    seen?: string[]
  }): TeamFacts {
    return {
      session: (sessionID) => input.sessions[sessionID],
      parked: (sessionID) => input.parked?.[sessionID] ?? 0,
      running: (sessionID) => input.running?.includes(sessionID) ?? false,
      stopped: (sessionID) => input.stopped?.includes(sessionID) ?? false,
      onMainRequest: (sessionID) => input.onMain?.includes(sessionID) ?? false,
      homeSeen: (teamID, sessionID) => input.seen?.includes(`${teamID}|${sessionID}`) ?? false,
    }
  }
  const inventoryDir = `${ROOT}/inventory-ui`
  const sessions = {
    [OWNER]: { directory: inventoryDir },
    [OWNER_OLD]: { directory: inventoryDir },
    ses_other: { directory: "D:\\own-open-code-team\\inventory-ui" },
    ses_child: { parentID: "ses_other", directory: inventoryDir },
    [MAIN]: { directory: HOME },
    [MAIN_OLD]: { directory: HOME },
    ses_home: { directory: "D:\\own-open-code" },
    ses_elsewhere: { directory: "D:/elsewhere" },
  }
  const ref = { teamID: TEAM as OwnTeam.TeamID, areaID: INVENTORY as OwnTeam.AreaID }

  test("an owner under Main 멈춤: the requests it holds back are the outbox plus the ones parked in its queue", async () => {
    const store = await loaded({ inventory: { paused: "user" } })
    expect(teamBanners(store, OWNER, facts({ sessions, parked: { [OWNER]: 1 } }))).toEqual([
      { kind: "paused", ...ref, n: 2 },
    ])
    expect(ko("own.team.banner.paused", { n: 2 })).toBe("메인 멈춤 · 요청 2개 기다림")
    const all = await loaded({ inventory: { paused: "all" } })
    expect(teamBanners(all, OWNER, facts({ sessions }))).toEqual([{ kind: "paused", ...ref, n: 1 }])
    // Nothing waits: the pill says Main 멈춤, no banner; Main 멈춤 off: none either.
    const quiet = await loaded({ inventory: { paused: "user" }, waiting: 0 })
    expect(teamBanners(quiet, OWNER, facts({ sessions }))).toEqual([])
    expect(teamBanners(await loaded(), OWNER, facts({ sessions, parked: { [OWNER]: 3 } }))).toEqual([])
  })

  test("a conversation that took the seat by a move says Main 멈춤 is on even while nothing waits", async () => {
    // It did not turn Main 멈춤 on and no request shows it yet: the banner is where it turns it off in one click.
    const moved = {
      owner: { sessionID: OWNER, previous: [{ sessionID: OWNER_OLD, endedAt: 2, why: "seat" }], attached: true },
    }
    for (const paused of ["user", "all"]) {
      const quiet = await loaded({ inventory: { ...moved, paused }, waiting: 0 })
      expect(teamBanners(quiet, OWNER, facts({ sessions })), paused).toEqual([{ kind: "paused", ...ref, n: 0 }])
    }
    // With requests it is the count, as for any owner; without Main 멈춤 there is nothing to say.
    const waiting = await loaded({ inventory: { ...moved, paused: "user" } })
    expect(teamBanners(waiting, OWNER, facts({ sessions }))).toEqual([{ kind: "paused", ...ref, n: 1 }])
    expect(teamBanners(await loaded({ inventory: moved, waiting: 0 }), OWNER, facts({ sessions }))).toEqual([])
    // A seat that an older move gave and a rotation took since is a rotated one: the pill alone.
    const rotated = {
      owner: {
        sessionID: OWNER,
        previous: [
          { sessionID: "ses_owner_first", endedAt: 1, why: "seat" },
          { sessionID: OWNER_OLD, endedAt: 2, why: "fresh" },
        ],
        attached: true,
      },
    }
    const later = await loaded({ inventory: { ...rotated, paused: "user" }, waiting: 0 })
    expect(teamBanners(later, OWNER, facts({ sessions }))).toEqual([])
    expect(ko("own.team.banner.pausedQuiet")).toBe(
      "메인 멈춤이 켜져 있어요. 끄기 전에는 메인의 요청이 이 대화에 오지 않아요",
    )
  })

  test("the seat-move banner is one-way: once the user writes in the new owner conversation it does not come back", async () => {
    const moved = {
      owner: { sessionID: OWNER, previous: [{ sessionID: OWNER_OLD, endedAt: 2, why: "seat" }], attached: true },
    }
    // The direct mark from before the move (or from the old conversation at the same time) keeps the banner.
    for (const at of [1, 2]) {
      const before = await loaded({
        inventory: { ...moved, paused: "user", direct: { at, sessionID: OWNER } },
        waiting: 0,
      })
      expect(teamBanners(before, OWNER, facts({ sessions })), String(at)).toEqual([{ kind: "paused", ...ref, n: 0 }])
    }
    const after = await loaded({
      inventory: { ...moved, paused: "user", direct: { at: 3, sessionID: OWNER } },
      waiting: 0,
    })
    expect(teamBanners(after, OWNER, facts({ sessions }))).toEqual([])
    // Requests that wait still show, whatever the user wrote.
    const waiting = await loaded({ inventory: { ...moved, paused: "user", direct: { at: 3, sessionID: OWNER } } })
    expect(teamBanners(waiting, OWNER, facts({ sessions }))).toEqual([{ kind: "paused", ...ref, n: 1 }])
  })

  test("직접 작업 (2026-11-14): the owner's banner counts what waits and hands the area back; Main 멈춤 comes first", async () => {
    const directWork = { since: 10, at: 20 }
    const held = await loaded({ inventory: { directWork } })
    expect(teamBanners(held, OWNER, facts({ sessions, parked: { [OWNER]: 1 } }))).toEqual([
      { kind: "paused", ...ref, n: 2, direct: true },
    ])
    // Nothing waits: the banner still says the user works here, so the hand-back is one click away.
    const quiet = await loaded({ inventory: { directWork }, waiting: 0 })
    expect(teamBanners(quiet, OWNER, facts({ sessions }))).toEqual([{ kind: "paused", ...ref, n: 0, direct: true }])
    // Under Main 멈춤 (also 모든 영역 멈추기) the banner is Main 멈춤's: turning it off ends both.
    for (const paused of ["user", "all"]) {
      const both = await loaded({ inventory: { directWork, paused } })
      expect(teamBanners(both, OWNER, facts({ sessions })), paused).toEqual([{ kind: "paused", ...ref, n: 1 }])
    }
    // Peers and other conversations of the folder get no direct banner.
    expect(teamBanners(held, "ses_other", facts({ sessions }))).toEqual([{ kind: "sameFolder", ...ref, owner: OWNER }])
    expect(ko("own.team.banner.direct", { n: 2 })).toBe("직접 작업 중 · 메인 요청 2개 기다림")
    expect(ko("own.team.banner.directQuiet")).toBe(
      "이 영역에서 직접 일하는 중이에요. 메인에게 넘기기 전에는 메인의 새 요청이 이 대화에 오지 않아요",
    )
    expect(ko("own.team.action.handBack")).toBe("메인에게 넘기기")
    expect(teamText.text("en", "own.team.action.handBack")).toBe("Hand back to main")
  })

  test("the banner's words and button follow `direct` (its render reads the keys from the kind's flags)", async () => {
    const source = await Bun.file(new URL("./session-banners.tsx", import.meta.url)).text()
    expect(source).toContain(
      '`own.team.banner.${current().direct ? "direct" : "paused"}${current().n > 0 ? "" : "Quiet"}`',
    )
    expect(source).toContain('`own.team.action.${current().direct ? "handBack" : "pauseOff"}`')
    for (const key of ["direct", "directQuiet", "paused", "pausedQuiet"] as const)
      expect(teamText.text("ko", `own.team.banner.${key}`, { n: 1 }), key).not.toMatch(/\{\w+\}/)
  })

  test("the stop button's Main 멈춤 says how to hand the area back; 모든 영역 멈추기 does not", async () => {
    const stopped = facts({ sessions, stopped: [OWNER] })
    expect(teamBanners(await loaded({ inventory: { paused: "user" } }), OWNER, stopped)).toEqual([
      { kind: "pausedByStop", ...ref },
    ])
    expect(teamBanners(await loaded({ inventory: { paused: "all" } }), OWNER, stopped)).toEqual([
      { kind: "paused", ...ref, n: 1 },
    ])
    expect(teamBanners(await loaded(), OWNER, stopped)).toEqual([])
    expect(ko("own.team.banner.pausedByStop")).toBe(
      "멈춰서 이 영역의 메인 멈춤을 켰어요. 메인에게 다시 맡기려면 끄세요",
    )
  })

  test("a replaced owner conversation leads to the conversation the area continues in", async () => {
    expect(teamBanners(await loaded(), OWNER_OLD, facts({ sessions }))).toEqual([
      { kind: "previous", ...ref, owner: OWNER },
    ])
    expect(ko("own.team.banner.previous")).toBe("이 영역은 새 대화로 이어졌어요")
    expect(ko("own.team.action.goToNew")).toBe("새 대화로 가기")
  })

  test("a conversation that gave its seat away says so, leads to the owner and offers the seat back", async () => {
    const left = {
      owner: { sessionID: OWNER, previous: [{ sessionID: OWNER_OLD, endedAt: 2, why: "seat" }], attached: true },
    }
    // This build of own.team cannot move a seat: the banner and the way to the owner only.
    expect(teamBanners(await loaded({ inventory: left }), OWNER_OLD, facts({ sessions }))).toEqual([
      { kind: "seatLeft", ...ref, owner: OWNER, again: false },
    ])
    const features = ["pause", "seat"]
    expect(teamBanners(await loaded({ inventory: left, features }), OWNER_OLD, facts({ sessions }))).toEqual([
      { kind: "seatLeft", ...ref, owner: OWNER, again: true },
    ])
    // A connection that may not move a seat, and an area that is being put away: no way back.
    const denied = await loaded({ inventory: left, features, denied: ["area.seat"] })
    expect(teamBanners(denied, OWNER_OLD, facts({ sessions }))).toEqual([
      { kind: "seatLeft", ...ref, owner: OWNER, again: false },
    ])
    const retiring = await loaded({ inventory: { ...left, state: "retiring" }, features })
    expect(teamBanners(retiring, OWNER_OLD, facts({ sessions }))).toMatchObject([{ kind: "seatLeft", again: false }])
    // The conversation that took the seat is the owner like any other.
    expect(teamBanners(await loaded({ inventory: left, features }), OWNER, facts({ sessions }))).toEqual([])
    // It left the seat twice, last through `새 대화로 이어가기`: the newest reason decides.
    const rotated = {
      owner: {
        sessionID: OWNER,
        previous: [
          { sessionID: OWNER_OLD, endedAt: 2, why: "seat" },
          { sessionID: "ses_between", endedAt: 3, why: "seat" },
          { sessionID: OWNER_OLD, endedAt: 4, why: "fresh" },
        ],
        attached: true,
      },
    }
    expect(teamBanners(await loaded({ inventory: rotated, features }), OWNER_OLD, facts({ sessions }))).toEqual([
      { kind: "previous", ...ref, owner: OWNER },
    ])
    expect(ko("own.team.banner.seatLeft")).toBe("이 대화는 이제 담당이 아니에요")
    expect(ko("own.team.action.goToOwner")).toBe("담당 대화로 가기")
    expect(ko("own.team.action.seatAgain")).toBe("다시 담당으로")
  })

  test("another conversation in the owner's folder; the owner on a main request adds the second banner", async () => {
    const store = await loaded()
    expect(teamBanners(store, "ses_other", facts({ sessions }))).toEqual([{ kind: "sameFolder", ...ref, owner: OWNER }])
    // The owner runs the user's own turn: only the same-folder note.
    expect(teamBanners(store, "ses_other", facts({ sessions, running: [OWNER] }))).toEqual([
      { kind: "sameFolder", ...ref, owner: OWNER },
    ])
    expect(teamBanners(store, "ses_other", facts({ sessions, running: [OWNER], onMain: [OWNER] }))).toEqual([
      { kind: "sameFolder", ...ref, owner: OWNER },
      { kind: "ownerWorking", ...ref, owner: OWNER, paused: false },
    ])
    const paused = await loaded({ inventory: { paused: "user" } })
    expect(teamBanners(paused, "ses_other", facts({ sessions, running: [OWNER], onMain: [OWNER] }))[1]).toEqual({
      kind: "ownerWorking",
      ...ref,
      owner: OWNER,
      paused: true,
    })
    expect(ko("own.team.banner.sameFolder")).toBe(
      "이 대화는 담당과 같은 폴더를 써요. 이 대화가 일하는 동안 메인 요청은 기다려요",
    )
    expect(ko("own.team.banner.ownerWorking")).toBe("담당이 지금 이 폴더에서 메인 요청을 처리 중이에요")
  })

  test("an area peer gets its own words instead of the same-folder note; the owner on a main request still shows", async () => {
    const store = await loaded({ inventory: PEERS })
    const known = { ...sessions, [REVIEWER]: { directory: inventoryDir } }
    const peer = { kind: "peer" as const, ...ref, area: "inventory-ui", label: "리뷰어", owner: OWNER }
    expect(teamBanners(store, REVIEWER, facts({ sessions: known }))).toEqual([peer])
    expect(teamBanners(store, REVIEWER, facts({ sessions: known, running: [OWNER], onMain: [OWNER] }))).toEqual([
      peer,
      { kind: "ownerWorking", ...ref, owner: OWNER, paused: false },
    ])
    // The other conversations of the folder keep the same-folder note; a peer removed since is one of them again.
    expect(teamBanners(store, "ses_other", facts({ sessions: known }))).toEqual([
      { kind: "sameFolder", ...ref, owner: OWNER },
    ])
    expect(teamBanners(await loaded(), REVIEWER, facts({ sessions: known }))).toEqual([
      { kind: "sameFolder", ...ref, owner: OWNER },
    ])
    expect(ko("own.team.banner.peer", { area: "inventory-ui", label: "리뷰어" })).toBe(
      "이 대화는 'inventory-ui' 영역의 동료(리뷰어)예요. 메인이 이 대화에 요청을 보낼 수 있고, 이 폴더에서는 한 번에 한 대화만 메인 요청을 받아요",
    )
  })

  test("an older conversation of the main folder points to 팀 메인 once; the team main itself gets nothing", async () => {
    const store = await loaded()
    const home = { kind: "home" as const, teamID: TEAM as OwnTeam.TeamID, main: MAIN }
    expect(teamBanners(store, "ses_home", facts({ sessions }))).toEqual([home])
    expect(teamBanners(store, MAIN_OLD, facts({ sessions }))).toEqual([home])
    expect(teamBanners(store, "ses_home", facts({ sessions, seen: [`${TEAM}|ses_home`] }))).toEqual([])
    expect(teamBanners(store, MAIN, facts({ sessions }))).toEqual([])
    expect(ko("own.team.banner.home")).toBe("팀 모드가 켜졌어요. 일을 나눠 맡기려면 '팀 메인'에서 말하세요")
  })

  test("a conversation own moved after its folder says it cannot go back past the move, before its role's", async () => {
    const store = await loaded({ inventory: { paused: "user" } })
    const moved = facts({
      sessions: {
        ...sessions,
        [OWNER]: { directory: inventoryDir, moved: true },
        [OWNER_OLD]: { directory: inventoryDir, moved: true },
        ses_elsewhere: { directory: "D:/elsewhere", moved: true },
        ses_child: { parentID: OWNER, directory: inventoryDir, moved: true },
      },
      parked: { [OWNER]: 1 },
    })
    expect(teamBanners(store, OWNER, moved)).toEqual([{ kind: "moved" }, { kind: "paused", ...ref, n: 2 }])
    expect(teamBanners(store, OWNER_OLD, moved)).toEqual([
      { kind: "moved" },
      { kind: "previous", ...ref, owner: OWNER },
    ])
    // Out of the team's folders too (an area taken out later); a child copies its parent's metadata and shows nothing.
    expect(teamBanners(store, "ses_elsewhere", moved)).toEqual([{ kind: "moved" }])
    expect(teamBanners(store, "ses_child", moved)).toEqual([])
    expect(ko("own.team.banner.moved")).toBe("이 대화는 옮기기 전 지점으로 되돌릴 수 없어요")
  })

  test("nothing for a child session, a metadata hint, another folder or a session not loaded yet", async () => {
    const hints: Record<string, Hint> = {
      ses_hinted: { metadata: { [TEAM_META.session]: { role: "owner", teamID: OTHER_TEAM, areaID: "ar_x" } } },
    }
    const store = await loaded({ hints })
    const known = facts({ sessions: { ...sessions, ses_hinted: { directory: inventoryDir } } })
    expect(teamBanners(store, "ses_child", known)).toEqual([])
    expect(teamBanners(store, "ses_hinted", known)).toEqual([])
    expect(teamBanners(store, "ses_elsewhere", known)).toEqual([])
    expect(teamBanners(store, "ses_unloaded", known)).toEqual([])
  })

  test("the actions are named in the team catalog (ko and en)", () => {
    expect(ko("own.team.action.pauseOff")).toBe("메인 멈춤 끄기")
    expect(ko("own.team.action.view")).toBe("보기")
    expect(ko("own.team.action.openOwner")).toBe("담당 대화 열기")
    expect(ko("own.team.action.pauseOn")).toBe("메인 멈춤")
    expect(ko("own.team.action.open")).toBe("열기")
    expect(teamText.text("en", "own.team.pill.main", { n: 3 })).toBe("Team main · 3 areas")
  })

  test("the short forms a crowded header shows drop the first words, nothing else (shell/header-fit.ts)", () => {
    const params = { area: "inventory-ui", label: "리뷰어", n: 3 }
    for (const locale of ["ko", "en"] as const)
      for (const key of ["owner", "paused", "previous", "peer", "main"] as const) {
        const full = teamText.text(locale, `own.team.pill.${key}`, params)
        const short = teamText.text(locale, `own.team.pill.${key}Short`, params)
        expect(full.endsWith(short) && short.length < full.length, `${full} / ${short}`).toBe(true)
      }
    expect(ko("own.team.pill.mainShort", { n: 3 })).toBe("영역 3개")
    expect(ko("own.team.pill.ownerShort", { area: "cl-perf" })).toBe("cl-perf · 담당")
    expect(teamText.text("en", "own.team.pill.mainShort", { n: 3 })).toBe("3 areas")
  })
})

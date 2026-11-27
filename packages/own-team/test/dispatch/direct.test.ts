// 직접 작업 (2026-11-14), the pure rules of `dispatch/direct.ts`: the hold and tell settings with their defaults, when
// an area is held (`live`) and when own's upkeep leaves it alone (`kept`), when the owner serves a main request
// (`serving`: queued, received and not ended nor answered, a request sent but not folded within 60 s), what enters a
// held area (`pass`), how a user message moves `directWork` (`marked`), the user's last input in the area (`touched`),
// the hand-back entry (`handed`), and the process-local memory of the main conversation (`said` / `spoke`).

import { afterEach, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Direct } from "../../src/dispatch/direct.js"
import { Fold } from "../../src/report/fold.js"
import { manual } from "../support/clock.js"
import { OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const HOME = "C:\\fake\\home"
const T0 = new Date(2026, 10, 14, 13, 2).getTime()
const D1 = OwnTeam.DispatchID.make("dp_01JAX0000000000000000000A1")
const D2 = OwnTeam.DispatchID.make("dp_01JAX0000000000000000000A2")
const MSG = SessionMessage.ID.make("msg_01JAX0000000000000000000A1")
const PEER_SESSION = SessionID.make("ses_peer0000000000000000000001")
const base = area({ slug: "hwamyeon", directory: "C:\\fake\\hwamyeon" })
const held: OwnTeam.Area = { ...base, directWork: { since: T0, at: T0 + 60_000 } }
const seat = Direct.owner(base)

const slot = (input: Partial<Fold.AreaFold> = {}): Fold.AreaFold => ({ reports: {}, queued: {}, ...input })

const dispatch = (input: Partial<OwnTeam.Dispatch> = {}): OwnTeam.Dispatch => ({
  id: D1,
  teamID: TEAM_ID,
  areaID: base.id,
  seq: 1,
  from: "main",
  kind: "task",
  text: "x",
  state: "sent",
  sentTo: { sessionID: OWNER_SESSION, msgID: MSG, at: T0 },
  createdAt: T0,
  ...input,
})

describe("settings", () => {
  test("hold is on unless switched off; tell reads judge for anything but none and always", () => {
    const policy = (value: Partial<OwnTeam.Policy>) => ({ policy: { ...OwnTeam.POLICY, ...value } })
    expect(Direct.hold(policy({}))).toBe(true)
    expect(Direct.hold(policy({ directHold: false }))).toBe(false)
    expect(Direct.hold(policy({ directHold: true }))).toBe(true)
    // The shared test team has it off, so only tests that ask for hold get it.
    expect(Direct.hold(team({ home: HOME }))).toBe(false)
    expect(Direct.hold(team({ home: HOME, directHold: true }))).toBe(true)
    expect(Direct.tell(policy({}))).toBe("judge")
    expect(Direct.tell(policy({ directTell: "none" }))).toBe("none")
    expect(Direct.tell(policy({ directTell: "always" }))).toBe("always")
    expect(Direct.tell(policy({ directTell: "judge" }))).toBe("judge")
    expect(Direct.tell(policy({ directTell: "later-value" }))).toBe("judge")
  })
})

describe("held and kept", () => {
  test("live: active, direct work set and Main 멈춤 off", () => {
    expect(Direct.live(base)).toBe(false)
    expect(Direct.live(held)).toBe(true)
    expect(Direct.live({ ...held, paused: "user" })).toBe(false)
    expect(Direct.live({ ...held, paused: "all" })).toBe(false)
    expect(Direct.live({ ...held, state: "retiring" })).toBe(false)
  })

  test("kept: Main 멈춤 or direct work on an active area, also under 모두 멈추기", () => {
    expect(Direct.kept(base)).toBe(false)
    expect(Direct.kept(held)).toBe(true)
    expect(Direct.kept({ ...base, paused: "user" })).toBe(true)
    expect(Direct.kept({ ...held, paused: "all" })).toBe(true)
    expect(Direct.kept({ ...held, state: "broken" })).toBe(false)
  })
})

describe("serving: the owner works on a main request", () => {
  test("a request queued in the owner's inbox", () => {
    expect(Direct.serving(slot(), seat, [], T0)).toBe(false)
    expect(Direct.serving(slot({ queued: { inb_1: D1 } }), seat, [], T0)).toBe(true)
  })

  test("received and not answered, until its run ended (also a failed one, not a limit)", () => {
    const received = slot({ received: { dispatchID: D1, at: T0 } })
    expect(Direct.serving(received, seat, [], T0)).toBe(true)
    expect(Direct.serving({ ...received, ended: D1 }, seat, [], T0)).toBe(false)
    // An older run's end does not end this one.
    expect(Direct.serving({ ...received, ended: D2 }, seat, [], T0)).toBe(true)
    // Answered (done, ready or blocked after it) or already told 끝났지만 보고 없음.
    const answered = { ...received, reports: { done: { text: "끝", at: T0 + 1 } } }
    expect(Direct.serving(answered, seat, [], T0)).toBe(false)
    expect(Direct.serving({ ...received, unreported: D1 }, seat, [], T0)).toBe(false)
  })

  test("a request sent to the owner but not folded yet counts for 60 s", () => {
    const sent = [dispatch()]
    expect(Direct.serving(slot(), seat, sent, T0 + 1_000)).toBe(true)
    expect(Direct.serving(slot(), seat, sent, T0 + Direct.FOLD_LAG_MS - 1)).toBe(true)
    // A cancelled inbox item leaves the request `sent`: it stops counting.
    expect(Direct.serving(slot(), seat, sent, T0 + Direct.FOLD_LAG_MS)).toBe(false)
    // Folded already (queued or received under its id), sent to another conversation, another area, or not sent.
    expect(Direct.serving(slot({ received: { dispatchID: D1, at: T0 }, ended: D1 }), seat, sent, T0 + 1)).toBe(false)
    expect(
      Direct.serving(slot(), seat, [dispatch({ sentTo: { sessionID: PEER_SESSION, msgID: MSG, at: T0 } })], T0 + 1),
    ).toBe(false)
    expect(Direct.serving(slot(), seat, [dispatch({ areaID: OwnTeam.AreaID.make("ar_other") })], T0 + 1)).toBe(false)
    expect(Direct.serving(slot(), seat, [dispatch({ state: "waiting", sentTo: undefined })], T0 + 1)).toBe(false)
    expect(Direct.serving(slot(), seat, [dispatch({ state: "cancelled" })], T0 + 1)).toBe(false)
  })

  test("a notice or an area message sent to the owner does not count: neither is ever folded as a request", () => {
    expect(Direct.serving(slot(), seat, [dispatch({ from: "team", kind: "notice" })], T0 + 5_000)).toBe(false)
    expect(Direct.serving(slot(), seat, [dispatch({ from: "area", kind: "reply" })], T0 + 5_000)).toBe(false)
    expect(Direct.serving(slot(), seat, [dispatch({ from: "area", kind: "ask" })], T0 + 5_000)).toBe(false)
    // A program request (an integration's conflict) still does.
    expect(Direct.serving(slot(), seat, [dispatch({ from: "team", kind: "conflict" })], T0 + 5_000)).toBe(true)
  })

  test("a peer's seat: its own fold and the requests sent to its conversation", () => {
    const peer = { areaID: base.id, sessionID: PEER_SESSION }
    const toPeer = dispatch({ to: "reviewer", sentTo: { sessionID: PEER_SESSION, msgID: MSG, at: T0 } })
    expect(Direct.serving({ reports: {} }, peer, [toPeer], T0 + 1_000)).toBe(true)
    // A request to the owner is not the peer's.
    expect(Direct.serving({ reports: {} }, peer, [dispatch()], T0 + 1_000)).toBe(false)
    expect(Direct.serving({ reports: {}, queued: { inb_1: D1 } }, peer, [], T0)).toBe(true)
    // Received and not answered: a peer's fold has no run end, so it serves until it reports.
    const received = { reports: {}, received: { dispatchID: D1, at: T0 } }
    expect(Direct.serving(received, peer, [], T0)).toBe(true)
    expect(Direct.serving({ ...received, reports: { blocked: { text: "막힘", at: T0 + 1 } } }, peer, [], T0)).toBe(false)
  })
})

describe("what enters a held area", () => {
  const pass = Direct.pass(held)

  test("replies and notices", () => {
    expect(pass(dispatch({ from: "area", kind: "reply" }))).toBe(true)
    expect(pass(dispatch({ from: "team", kind: "notice", createdAt: T0 - 1 }))).toBe(true)
    expect(pass(dispatch({ from: "area", kind: "ask" }))).toBe(false)
  })

  test("program requests of an integration started in the stretch, except a target sync", () => {
    expect(pass(dispatch({ from: "team", kind: "conflict", createdAt: T0 }))).toBe(true)
    expect(pass(dispatch({ from: "team", kind: "task", createdAt: T0 + 5 }))).toBe(true)
    expect(pass(dispatch({ from: "team", kind: "conflict", createdAt: T0 - 1 }))).toBe(false)
    expect(pass(dispatch({ from: "team", kind: "sync", createdAt: T0 + 5 }))).toBe(false)
  })

  test("a program request counts from its integration's or op's start, not from when it was asked", () => {
    // Started before the stretch, asking during it (a conflict after a restart, a large-file request, a merge's).
    expect(pass(dispatch({ from: "team", kind: "conflict", createdAt: T0 + 5, origin: T0 - 1 }))).toBe(false)
    expect(pass(dispatch({ from: "team", kind: "task", createdAt: T0 + 5, origin: T0 - 1 }))).toBe(false)
    // Started in the stretch (only the user starts one then).
    expect(pass(dispatch({ from: "team", kind: "conflict", createdAt: T0 + 5, origin: T0 }))).toBe(true)
  })

  test("the main's requests wait, its answers too; an area that is not held lets everything in", () => {
    expect(pass(dispatch({ from: "main", kind: "task", createdAt: T0 + 5 }))).toBe(false)
    expect(pass(dispatch({ from: "main", kind: "task", createdAt: T0 + 5, fresh: true }))).toBe(false)
    expect(Direct.pass(base)(dispatch({ from: "main", kind: "task" }))).toBe(true)
  })
})

describe("a user message in the owner conversation", () => {
  test("starts a stretch with hold on while the owner does not serve; moves `at` of a running one", () => {
    expect(Direct.marked(base, { hold: true, serving: false, at: T0 })).toEqual({ since: T0, at: T0 })
    expect(Direct.marked(base, { hold: true, serving: true, at: T0 })).toBeUndefined()
    expect(Direct.marked(base, { hold: false, serving: false, at: T0 })).toBeUndefined()
    expect(Direct.marked(held, { hold: true, serving: true, at: T0 + 90_000 })).toEqual({ since: T0, at: T0 + 90_000 })
  })

  test("touched: the newest direct input of the owner conversation or a peer", () => {
    expect(Direct.touched(base)).toBe(0)
    expect(Direct.touched({ ...base, direct: { at: T0, sessionID: OWNER_SESSION } })).toBe(T0)
    const peer = {
      key: "reviewer",
      sessionID: PEER_SESSION,
      label: "리뷰어",
      role: "",
      attached: true,
      origin: "registered" as const,
      at: 0,
    }
    expect(
      Direct.touched({
        ...base,
        direct: { at: T0, sessionID: OWNER_SESSION },
        peers: [peer, { ...peer, key: "sim", direct: { at: T0 + 5 } }],
      }),
    ).toBe(T0 + 5)
  })
})

describe("the hand-back entry", () => {
  const summary: Fold.StretchSummary = {
    since: T0,
    until: new Date(2026, 10, 14, 15, 40).getTime(),
    n: 3,
    kinds: { progress: 2, ready: 1 },
    last: "화면 정리 끝, 반영 준비",
  }

  test("time range, pointer, counts, candidate, program facts and the newest report, in that order", () => {
    expect(Direct.handed(summary, { why: "handed", area: "hwamyeon", candidate: true, ahead: 2, dirty: true })).toBe(
      '사용자가 직접 작업을 마치고 넘김(13:02~15:40) · 전문: team_status{area:"hwamyeon"} · 그동안 보고 3개(반영 준비 1, 진행 2) · 반영 후보 있음 · 본 코드에 없는 저장 지점 2개 · 커밋 안 된 변경 있음 · 마지막 보고: "화면 정리 끝, 반영 준비"',
    )
    expect(Direct.handed(summary, { why: "taken", area: "hwamyeon" })).toBe(
      '메인이 넘겨받음(13:02~15:40) · 전문: team_status{area:"hwamyeon"} · 그동안 보고 3개(반영 준비 1, 진행 2) · 마지막 보고: "화면 정리 끝, 반영 준비"',
    )
  })

  test("without reports it says so, followed by the program facts; zero or unknown facts are left out", () => {
    const empty: Fold.StretchSummary = { since: T0, until: T0 + 60_000, n: 0, kinds: {} }
    expect(Direct.handed(empty, { why: "handed", area: "hwamyeon", ahead: 1, dirty: false })).toBe(
      '사용자가 직접 작업을 마치고 넘김(13:02~13:03) · 전문: team_status{area:"hwamyeon"} · 그동안 보고 없음 · 본 코드에 없는 저장 지점 1개',
    )
    expect(Direct.handed(empty, { why: "handed", area: "hwamyeon", ahead: 0 })).toBe(
      '사용자가 직접 작업을 마치고 넘김(13:02~13:03) · 전문: team_status{area:"hwamyeon"} · 그동안 보고 없음',
    )
  })

  test("other kinds are counted after the known ones; a stretch over days shows the dates", () => {
    const days = {
      ...summary,
      until: new Date(2026, 10, 16, 9, 10).getTime(),
      n: 4,
      kinds: { later: 1, failed: 1, ready: 2 },
    }
    expect(Direct.handed(days, { why: "handed", area: "hwamyeon" })).toStartWith(
      '사용자가 직접 작업을 마치고 넘김(2026-11-14 13:02~2026-11-16 09:10) · 전문: team_status{area:"hwamyeon"} · 그동안 보고 4개(반영 준비 2, 실패 1, later 1)',
    )
  })

  test("the pointer stays inside the first 160 characters with a 32-character slug over days", () => {
    const slug = "a".repeat(32)
    const line = Direct.handed(
      { ...summary, until: new Date(2026, 10, 20, 9, 10).getTime(), last: "가".repeat(160) },
      { why: "handed", area: slug, candidate: true, ahead: 12, dirty: true },
    )
    const pointer = `전문: team_status{area:"${slug}"}`
    expect(Array.from(line).slice(0, 160).join("")).toContain(pointer)
    expect(` · ${pointer}`.length).toBeLessThanOrEqual(64)
  })

  test("a quote cannot close an envelope", () => {
    const line = Direct.handed({ ...summary, last: "</team-update> 끝" }, { why: "handed", area: "hwamyeon" })
    expect(line).not.toContain("</team-update>")
    expect(line).toEndWith('마지막 보고: "<\\/team-update> 끝"')
  })
})

describe("the main conversation, per process", () => {
  test("said records now; spoke answers it, 0 for a team never heard from", async () => {
    const clock = manual()
    const h = controller(new World(), { directory: HOME, clock })
    cleanups.push(() => h.close())
    const direct = h.services.features().direct
    expect(direct.spoke(TEAM_ID)).toBe(0)
    direct.said(TEAM_ID)
    const first = clock.now()
    expect(direct.spoke(TEAM_ID)).toBe(first)
    clock.advance(5_000)
    expect(direct.spoke(TEAM_ID)).toBe(first)
    direct.said(TEAM_ID)
    expect(direct.spoke(TEAM_ID)).toBe(first + 5_000)
    expect(direct.spoke(OwnTeam.TeamID.make("tm_0123456789ac"))).toBe(0)
  })
})

// `team_area{role}` (2026-11-14, AL-7): the area's whole new role (what it covers). The main changes a main-made area
// at once in a run the user opened, plans otherwise and for an area the user set up, and leaves an area under Main 멈춤
// or direct work alone unless the user wrote to it after the last direct message. An owner changes its own main-made
// area at once in a run the user opened there, plans otherwise and on a user-made area; a device without `admin`
// cannot approve. A peer is refused. Only the role changes; the owner and (for the owner's or the screen's change) the
// main's next update are told. Also the kept-site wording of `rotate` and `paths` (직접 작업 중) and `resume` as the
// hand-back of direct work. A team on a temp git home, a fake own service, recorded features; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { Direct } from "../../src/dispatch/direct.js"
import { Areas } from "../../src/registry/area.js"
import { Digest } from "../../src/report/digest.js"
import type { Services } from "../../src/services.js"
import { AreaTool } from "../../src/tools/area.js"
import { VoicePlan } from "../../src/tools/voice.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type Calls, approve, voiceTeam } from "../support/voice.js"

const SLOW = 240_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ROLE = "보스 본체: 규칙·모델·연출"
const WIDER = "보스 본체: 규칙·모델·연출, 보스 드랍 아이템 그림과 VFX"
const PEER = SessionID.make("ses_peer00000000000000000000001")

/** Rotation, Main 멈춤 and the hand-back record what the tool asked for; the hand-back ends a held stretch. */
function recorded(calls: Calls): Partial<Services.Factories> {
  return {
    rotate: () => ({
      request: async (input) => {
        calls.push({ name: "rotate.request", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
      main: async (input) => {
        calls.push({ name: "rotate.main", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
    }),
    pause: (services) => ({
      area: async (input) => {
        calls.push({ name: "pause.area", input })
        const area = await services.registry.areas.get(input.teamID, input.areaID)
        return { ok: true, area: Areas.view(area!) }
      },
      team: async (input) => ({ ok: true, team: (await services.registry.teams.get(input.teamID))! }),
      stopped: async () => {},
    }),
    direct: (services) => ({
      ...Direct.create(services),
      end: async (input) => {
        calls.push({ name: "direct.end", input })
        const area = await services.registry.areas.get(input.teamID, input.areaID)
        if (area?.directWork === undefined) return undefined
        await services.write(input.teamID, () => services.registry.areas.put({ ...area, directWork: undefined }))
        return { line: `넘김 줄(${input.why})`, waiting: 2 }
      },
    }),
  }
}

async function setup() {
  const h = await voiceTeam({ cleanups, features: recorded })
  const boss = await h.makeArea("boss", {
    goal: ROLE,
    peers: [{ key: "rev", sessionID: PEER, label: "리뷰어", role: "", attached: true, origin: "registered", at: 1 }],
  })
  const mine = await h.makeArea("mine", { userMade: true, goal: "내 일" })
  h.backend.add(PEER, boss.directory, "리뷰어")
  return { ...h, boss, mine, owner: boss.owner.sessionID!, area: h.tool(AreaTool.NAME) }
}

type Harness = Awaited<ReturnType<typeof setup>>

/** The `role` entries of the main's next update. */
async function told(h: Harness) {
  return (await Digest.load(h.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "role")
}

/** A run opened by a message of a device with only `scopes` (no `admin`). */
function phone(h: Harness, sessionID: string) {
  h.backend.idle(sessionID)
  h.backend.message(sessionID, "user", { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read"] } })
  h.backend.message(sessionID, "assistant")
}

async function put(h: Harness, area: OwnTeam.Area) {
  await h.services.write(TEAM_ID, () => h.services.registry.areas.put(area))
}

describe("team_area{role} by the main", () => {
  test(
    "at once in a run the user opened, on a main-made area; only the role changes and the main is not told of its own change",
    async () => {
      const h = await setup()
      const before = (await h.areaOf("boss"))!
      h.backend.turn(MAIN_SESSION)
      const done = await h.area(MAIN_SESSION, { action: "role", area: "boss", role: `  ${WIDER}\n` })
      expect(done).toEqual({ ok: true, text: "'boss' 영역의 역할을 바꿨습니다. 담당 대화에 바로 알렸습니다." })
      const after = (await h.areaOf("boss"))!
      expect(after.goal).toBe(WIDER)
      // Status, candidate, outbox, peers, pause and direct work stay as they were.
      expect({ ...after, goal: before.goal }).toEqual(before)
      expect(await h.services.journal.list(TEAM_ID)).toEqual([])
      expect(await told(h)).toEqual([])
    },
    SLOW,
  )

  test(
    "a plan in a run the user did not open, and on a 내가 정한 영역 even when the user opened it; the plan prints both roles whole",
    async () => {
      const h = await setup()
      h.backend.idle(MAIN_SESSION)
      const before = await h.snapshot()
      const plain = await h.area(MAIN_SESSION, { action: "role", area: "boss", role: WIDER })
      expect(plain).toMatchObject({ ok: true, plan: true })
      expect(plain.text).toContain(`지금: "${ROLE}"`)
      expect(plain.text).toContain(`바뀐 뒤: "${WIDER}"`)
      expect(await h.snapshot()).toEqual(before)

      const long = "역".repeat(1_000)
      const { plan, done } = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "role", area: "mine", role: long })
      expect(plan.text).toContain(`'mine' 영역이 맡는 일을 바꿉니다.\n지금: "내 일"\n바뀐 뒤: "${long}"`)
      expect(done).toMatchObject({ ok: true })
      expect((await h.areaOf("mine"))?.goal).toBe(long)
      // The main's change (the user approved it in the main) is the main's: no `role` entry.
      expect(await told(h)).toEqual([])
    },
    SLOW,
  )

  test(
    "an area under Main 멈춤 or direct work is refused unless the user wrote to the main after the last direct message",
    async () => {
      const h = await setup()
      await put(h, { ...h.boss, paused: "user" })
      h.backend.idle(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: WIDER })).toEqual({
        ok: false,
        text: AreaTool.ROLE_HELD("boss"),
      })
      // The user asked in this run: as an unheld main-made area.
      h.backend.turn(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: WIDER })).toMatchObject({ ok: true })
      expect((await h.areaOf("boss"))?.goal).toBe(WIDER)

      // Direct work: a user-opened run is not enough while the user's last direct message is newer.
      const now = h.clock.now()
      await put(h, { ...(await h.areaOf("boss"))!, paused: false, directWork: { since: now, at: now } })
      h.clock.advance(1_000)
      h.backend.turn(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: ROLE })).toEqual({
        ok: false,
        text: AreaTool.ROLE_HELD("boss"),
      })
      // The user wrote to the main after it: done at once.
      h.services.features().direct.said(TEAM_ID)
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: ROLE })).toMatchObject({ ok: true })
      const after = (await h.areaOf("boss"))!
      expect(after.goal).toBe(ROLE)
      expect(after.directWork).toEqual({ since: now, at: now })
    },
    SLOW,
  )

  test(
    "a phone without admin gets a plan it cannot approve; 1,001 characters, an empty and the same role are answered",
    async () => {
      const h = await setup()
      phone(h, MAIN_SESSION)
      const plan = await h.area(MAIN_SESSION, { action: "role", area: "boss", role: WIDER })
      expect(plan).toMatchObject({ ok: true, plan: true })
      h.backend.idle(MAIN_SESSION)
      h.backend.message(MAIN_SESSION, "user", { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read"] } })
      h.backend.message(MAIN_SESSION, "assistant")
      expect(
        await h.area(MAIN_SESSION, { action: "role", area: "boss", role: WIDER, token: plan.token }),
      ).toMatchObject({ ok: false, error: "needs_pc", text: VoicePlan.needsPc("admin") })
      expect((await h.areaOf("boss"))?.goal).toBe(ROLE)

      h.backend.turn(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: "가".repeat(1_001) })).toEqual({
        ok: false,
        text: "역할은 1,000자까지입니다(지금 1,001자). 줄여서 다시 부르세요.",
      })
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: " \n " })).toEqual({
        ok: false,
        text: AreaTool.ROLE_EMPTY,
      })
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss" })).toEqual({
        ok: false,
        text: AreaTool.ROLE_EMPTY,
      })
      expect(await h.area(MAIN_SESSION, { action: "role", area: "boss", role: ROLE })).toEqual({
        ok: true,
        text: AreaTool.ROLE_SAME("boss"),
      })
      expect(await told(h)).toEqual([])
    },
    SLOW,
  )
})

describe("team_area{role} by the owner", () => {
  test(
    "at once in a run the user opened there on a main-made area, also while held; the main's update says so once",
    async () => {
      const h = await setup()
      const now = h.clock.now()
      await put(h, { ...h.boss, directWork: { since: now, at: now } })
      h.backend.turn(h.owner)
      expect(await h.area(h.owner, { action: "role", area: "boss", role: WIDER })).toMatchObject({ ok: true })
      expect((await h.areaOf("boss"))?.goal).toBe(WIDER)
      expect(await told(h)).toMatchObject([{ areaID: h.boss.id, text: "역할이 바뀜(담당이 사용자 말로)", wake: false }])
      // An equal role writes nothing more.
      expect(await h.area(h.owner, { action: "role", area: "boss", role: WIDER })).toMatchObject({ ok: true })
      expect(await told(h)).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "a plan without a user message or on a 내가 정한 영역; a device without admin cannot; another area and a peer are refused",
    async () => {
      const h = await setup()
      h.backend.idle(h.owner)
      const plain = await h.area(h.owner, { action: "role", area: "boss", role: WIDER })
      expect(plain).toMatchObject({ ok: true, plan: true })
      expect((await h.areaOf("boss"))?.goal).toBe(ROLE)
      h.backend.reply(h.owner)
      expect(await h.area(h.owner, { action: "role", area: "boss", role: WIDER, token: plain.token })).toMatchObject({
        ok: true,
      })
      expect((await h.areaOf("boss"))?.goal).toBe(WIDER)
      expect(await told(h)).toHaveLength(1)

      const mineOwner = h.mine.owner.sessionID!
      h.backend.turn(mineOwner)
      expect(await h.area(mineOwner, { action: "role", area: "mine", role: "내 큰 일" })).toMatchObject({
        ok: true,
        plan: true,
      })
      expect((await h.areaOf("mine"))?.goal).toBe("내 일")

      phone(h, h.owner)
      expect(await h.area(h.owner, { action: "role", area: "boss", role: ROLE })).toEqual({
        ok: false,
        text: VoicePlan.needsPc("admin"),
      })
      h.backend.turn(h.owner)
      expect(await h.area(h.owner, { action: "role", area: "mine", role: ROLE })).toEqual({
        ok: false,
        text: AreaTool.OWN_AREA_ONLY,
      })
      expect(await h.area(PEER, { action: "role", area: "boss", role: ROLE })).toEqual({
        ok: false,
        text: AreaTool.PEER,
      })
      expect((await h.areaOf("boss"))?.goal).toBe(WIDER)
    },
    SLOW,
  )
})

describe("kept sites and the hand-back (direct work)", () => {
  test(
    "an owner's own rotate on its held area is at once; the main's is a plan that names direct work, as is paths",
    async () => {
      const h = await setup()
      const now = h.clock.now()
      await put(h, { ...h.boss, directWork: { since: now, at: now } })
      expect(await h.area(h.owner, { action: "rotate", area: "boss" })).toMatchObject({ ok: true })
      expect(h.calls.filter((item) => item.name === "rotate.request").map((item) => item.input)).toEqual([
        // `reason: "user"`: the rotation's own TI-13 check skips an automatic one on a held area (`sessions/rotate.ts`).
        { teamID: TEAM_ID, areaID: h.boss.id, reason: "user", handoff: "warm", by: "auto" },
      ])
      h.backend.turn(MAIN_SESSION)
      const rotate = await h.area(MAIN_SESSION, { action: "rotate", area: "boss" })
      expect(rotate).toMatchObject({ ok: true, plan: true })
      expect(rotate.text).toStartWith("boss은(는) 직접 작업 중입니다. 승인하면")
      const paths = await h.area(MAIN_SESSION, { action: "paths", area: "boss", dirs: ["assets"] })
      expect(paths).toMatchObject({ ok: true, plan: true })
      expect(paths.text).toStartWith("boss은(는) 직접 작업 중입니다. 승인하면")
      // Under Main 멈춤 the owner's rotate plans and the words stay.
      await put(h, { ...(await h.areaOf("boss"))!, paused: "user" })
      h.backend.turn(h.owner)
      const paused = await h.area(h.owner, { action: "rotate", area: "boss" })
      expect(paused).toMatchObject({ ok: true, plan: true })
      expect(paused.text).toStartWith("boss은(는) 메인 멈춤 중입니다.")
      expect(h.calls.filter((item) => item.name === "rotate.request")).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "resume hands back: the owner at once in a user-opened run, the main at once only after the user wrote to it",
    async () => {
      const h = await setup()
      expect(await h.area(MAIN_SESSION, { action: "resume", area: "boss" })).toEqual({
        ok: false,
        text: AreaTool.NOTHING_HELD("boss"),
      })
      const now = h.clock.now()
      await put(h, { ...h.boss, directWork: { since: now, at: now } })
      h.backend.turn(h.owner)
      expect(await h.area(h.owner, { action: "resume", area: "boss" })).toEqual({
        ok: true,
        text: "boss: 메인에게 넘겼습니다. 기다리던 메인 요청 2개가 폴더가 쉴 때 하나씩 들어옵니다.",
      })
      // Without a user message the owner plans first.
      await put(h, { ...(await h.areaOf("boss"))!, directWork: { since: now, at: now } })
      h.backend.idle(h.owner)
      const planned = await h.area(h.owner, { action: "resume", area: "boss" })
      expect(planned).toMatchObject({ ok: true, plan: true })
      expect(planned.text).toStartWith("boss: 직접 작업을 마치고 메인에게 넘깁니다.\n")

      // The main: a plan while the user's direct message is the newer one; at once (taken) after the user wrote to it.
      h.clock.advance(1_000)
      h.backend.turn(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "resume", area: "boss" })).toMatchObject({ ok: true, plan: true })
      h.services.features().direct.said(TEAM_ID)
      expect(await h.area(MAIN_SESSION, { action: "resume", area: "boss" })).toEqual({
        ok: true,
        text: "넘김 줄(taken)",
      })
      expect(h.calls.filter((item) => item.name === "direct.end").map((item) => item.input)).toEqual([
        { teamID: TEAM_ID, areaID: h.boss.id, why: "handed" },
        { teamID: TEAM_ID, areaID: h.boss.id, why: "taken" },
      ])
      expect(h.calls.filter((item) => item.name === "pause.area")).toEqual([])
    },
    SLOW,
  )

  test(
    "the main's approved resume of a held area under Main 멈춤 takes the direct work back too",
    async () => {
      const h = await setup()
      const now = h.clock.now()
      await put(h, { ...h.boss, paused: "user", directWork: { since: now, at: now } })
      const { plan, done } = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "resume", area: "boss" })
      expect(plan.text).toContain("boss의 메인 멈춤을 끕니다.")
      expect(done).toEqual({ ok: true, text: "boss: 메인 멈춤을 껐습니다.\n넘김 줄(taken)" })
      expect(h.calls.map((item) => item.name)).toEqual(["direct.end", "pause.area"])
    },
    SLOW,
  )
})

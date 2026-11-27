// 담당 대화 바꾸기 by voice (`team_control{action: "seat"}`, 2026-11-12): like registering a conversation as a peer, it
// is a plan that names the area, the conversation and its model and starts only with the token after the user's next
// message; a conversation that cannot take the seat is refused when the plan is asked for, with the sentence the
// button's RPC answers; only the team main may ask. A peer is named as `team_status` lists it (`peer`: its key or its
// label), since that line shows no conversation id. A team on a temp git home, a fake own service, a recorded seat
// feature (the op itself is in `test/sessions/seat.test.ts`); fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import type { Services } from "../../src/services.js"
import { Seat } from "../../src/sessions/seat.js"
import { ControlTool } from "../../src/tools/control.js"
import { MainTools } from "../../src/tools/main.js"
import { MAIN_SESSION, MODEL, TEAM_ID } from "../support/context.js"
import { type Calls, type VoiceTeam, approve, voiceTeam } from "../support/voice.js"

const SLOW = 240_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const OP = OwnTeam.OpID.create()

function recorded(calls: Calls): Partial<Services.Factories> {
  return {
    seat: () => ({
      request: async (input) => {
        calls.push({ name: "seat.request", input })
        return { ok: true, opID: OP }
      },
      sweep: async () => {},
    }),
  }
}

/** A root conversation in `directory` that runs on the team's model (the fake service's views carry none). */
function conversation(h: VoiceTeam, directory: string, title: string) {
  const id = SessionID.create()
  h.backend.add(id, directory, title)
  const key = `GET /api/session/${id}`
  const plain = h.backend.service.routes.get(key)!
  h.backend.service.routes.set(key, async (request) => {
    const answer = (await (await plain(request)).json()) as { readonly data: object }
    return Response.json({ data: { ...answer.data, model: MODEL } })
  })
  return id
}

describe("the owner seat by voice", () => {
  test(
    "a plan that names the area, the conversation and its model; it starts after the user's answer, as the user's action",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      const memo = conversation(h, ui.directory, "정렬 메모")
      const control = h.tool(ControlTool.NAME)

      h.backend.turn(MAIN_SESSION)
      const before = await h.snapshot()
      const plan = await control(MAIN_SESSION, { action: "seat", area: "ui", session: "정렬 메모" })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(plan.text).toContain(
        `'${ui.name}' 영역의 담당을 "정렬 메모" 대화(${MODEL.providerID}/${MODEL.id})로 바꿉니다.`,
      )
      expect(plan.text).toContain("지금 하는 일이 끝난 뒤에 바뀝니다.")
      // Asking for the plan changes nothing and starts nothing.
      expect(await h.snapshot()).toEqual(before)
      expect(h.calls).toEqual([])

      h.backend.reply(MAIN_SESSION)
      expect(
        await control(MAIN_SESSION, { action: "seat", area: "ui", session: "정렬 메모", token: plan.token }),
      ).toEqual({
        ok: true,
        text: "담당 바꾸기를 시작했습니다.",
        opID: OP,
      })
      // By id as well.
      const again = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "seat", area: "ui", session: memo })
      expect(again.done).toMatchObject({ ok: true, opID: OP })
      const request = { teamID: TEAM_ID, areaID: ui.id, sessionID: memo, by: "user" }
      expect(h.calls.map((item) => [item.name, item.input])).toEqual([
        ["seat.request", request],
        ["seat.request", request],
      ])
    },
    SLOW,
  )

  test(
    "a peer is named by its key or its label, as team_status lists it; the plan says it leaves the peers",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const made = await h.makeArea("ui")
      const reviewer = conversation(h, made.directory, "읽는 대화")
      const peer: OwnTeam.Peer = {
        key: "reviewer",
        sessionID: reviewer,
        label: "리뷰어",
        role: "변경을 읽는다",
        attached: true,
        origin: "registered",
        at: 1,
      }
      const ui = { ...made, peers: [peer] }
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put(ui))
      const control = h.tool(ControlTool.NAME)

      const byKey = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "seat", area: "ui", peer: "reviewer" })
      expect(byKey.plan.text).toContain(
        `'${ui.name}' 영역의 담당을 동료 "리뷰어"의 "읽는 대화" 대화(${MODEL.providerID}/${MODEL.id})로 바꿉니다.`,
      )
      expect(byKey.plan.text).toContain("그 대화는 담당이 되고 동료에서는 빠집니다.")
      expect(byKey.done).toEqual({ ok: true, text: "담당 바꾸기를 시작했습니다.", opID: OP })
      const byLabel = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "seat", area: "ui", peer: "리뷰어" })
      expect(byLabel.done).toMatchObject({ ok: true, opID: OP })
      const request = { teamID: TEAM_ID, areaID: ui.id, sessionID: reviewer, by: "user" }
      expect(h.calls.map((item) => [item.name, item.input])).toEqual([
        ["seat.request", request],
        ["seat.request", request],
      ])
      // Named as a conversation (its title or its id), a peer's plan says the same.
      h.calls.splice(0)
      h.backend.turn(MAIN_SESSION)
      for (const session of ["읽는 대화", reviewer]) {
        const plan = await control(MAIN_SESSION, { action: "seat", area: "ui", session })
        expect(plan.text).toContain(`'${ui.name}' 영역의 담당을 동료 "리뷰어"의 "읽는 대화" 대화(`)
        expect(plan.text).toContain("그 대화는 담당이 되고 동료에서는 빠집니다.")
      }
      expect(h.calls).toEqual([])
      // A name that is no peer of the area lists the ones it has; neither input says what is missing.
      h.backend.turn(MAIN_SESSION)
      expect(await control(MAIN_SESSION, { action: "seat", area: "ui", peer: "없는 동료" })).toEqual({
        ok: false,
        text: `${ui.name}에 그런 동료가 없습니다. 동료: 리뷰어(reviewer)`,
      })
      expect(await control(MAIN_SESSION, { action: "seat", area: "ui" })).toEqual({
        ok: false,
        text: "session이나 peer가 필요합니다(담당으로 삼을 대화의 id나 제목, 또는 동료의 key나 이름).",
      })
      expect(h.calls).toEqual([])
    },
    SLOW,
  )

  test(
    "before the user's answer the token is refused and nothing starts",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      const memo = conversation(h, ui.directory, "정렬 메모")
      const control = h.tool(ControlTool.NAME)
      h.backend.turn(MAIN_SESSION)
      const plan = await control(MAIN_SESSION, { action: "seat", area: "ui", session: memo })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(await control(MAIN_SESSION, { action: "seat", token: plan.token })).toMatchObject({
        ok: false,
        error: "needs_user",
      })
      expect(h.calls).toEqual([])
    },
    SLOW,
  )

  test(
    "a conversation that cannot take the seat is refused with the reason when the plan is asked for",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      const docs = await h.makeArea("docs")
      const elsewhere = conversation(h, docs.directory, "문서 메모")
      const home = conversation(h, h.home, "홈 메모")
      const control = h.tool(ControlTool.NAME)
      h.backend.turn(MAIN_SESSION)

      expect(await control(MAIN_SESSION, { action: "seat", area: "ui" })).toMatchObject({ ok: false })
      expect(await control(MAIN_SESSION, { action: "seat", session: elsewhere })).toEqual({
        ok: false,
        text: "area가 필요합니다.",
      })
      expect(await control(MAIN_SESSION, { action: "seat", area: "없는영역", session: elsewhere })).toEqual({
        ok: false,
        text: MainTools.NO_AREA,
      })
      const unknown = await control(MAIN_SESSION, { action: "seat", area: "ui", session: "없는 대화" })
      expect(unknown).toMatchObject({ ok: false })
      expect(unknown.text).toContain("그런 대화를 찾지 못했습니다")
      for (const sessionID of [elsewhere, home])
        expect(await control(MAIN_SESSION, { action: "seat", area: "ui", session: sessionID })).toEqual({
          ok: false,
          text: Seat.INVALID.elsewhere,
          error: "seat_invalid",
        })
      expect(await control(MAIN_SESSION, { action: "seat", area: "ui", session: ui.owner.sessionID })).toEqual({
        ok: false,
        text: Seat.INVALID.owner,
        error: "seat_invalid",
      })
      expect(await control(MAIN_SESSION, { action: "seat", area: "ui", session: MAIN_SESSION })).toEqual({
        ok: false,
        text: Seat.INVALID.main,
        error: "seat_invalid",
      })
      // Only the team main may ask.
      expect(await control(ui.owner.sessionID!, { action: "seat", area: "ui", session: elsewhere })).toEqual({
        ok: false,
        text: MainTools.MAIN_ONLY,
      })
      expect(h.calls).toEqual([])
    },
    SLOW,
  )
})

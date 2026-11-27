// 직접 작업 and the team tools (2026-11-14): `team_integrate` on an area the user works with directly goes in only when
// the user says so. Its owner integrates at once in a run the user opened in that conversation, is told so from a
// device without the admin scope, and otherwise answers a plan approved in the area folder (`action: "tip"`, with the
// owner's `token`); the main always answers a plan, also right after the user's own message. The plan runs by the
// user. `team_area resume` hands a held area back: the owner at once in a run the user opened there, else a plan; the
// main takes it back at once only in a run the user opened after the user's last direct message (`spoke`), else a
// plan; nothing held is said so. A team on a temp git home, a fake own service, a manual clock; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import type { Services } from "../../src/services.js"
import { AreaTool } from "../../src/tools/area.js"
import { IntegrateTool } from "../../src/tools/integrate.js"
import { VoicePlan } from "../../src/tools/voice.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type Calls, type VoiceTeam, voiceTeam } from "../support/voice.js"

const SLOW = 240_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Integrations record who started them; nothing runs. */
function recorded(calls: Calls): Partial<Services.Factories> {
  return {
    integrate: () => ({
      start: async (input) => {
        calls.push({ name: "integrate.start", input })
        return { ok: true, opID: OwnTeam.OpID.create(), integrationID: OwnTeam.IntegrationID.create() }
      },
      retry: async () => {},
      undo: async () => ({ ok: true, opID: OwnTeam.OpID.create() }),
      undoCancel: async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }),
      plan: async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }),
      push: async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }),
      register: () => {},
    }),
  }
}

/** A team with the hold on and a code area `ui` the user works with directly since now. */
async function held() {
  const h = await voiceTeam({ cleanups, policy: { directHold: true }, features: recorded })
  const made = await h.makeArea("ui", { commit: true })
  const since = h.clock.now()
  await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...made, directWork: { since, at: since } }))
  const owner = made.owner.sessionID!
  const starts = () => h.calls.filter((call) => call.name === "integrate.start").map((call) => call.input)
  return { ...h, area: made, owner, since, starts }
}

const stamp = (scopes: ReadonlyArray<string>) => ({ [OwnRemote.DEVICE_META]: { scopes } })

describe("team_integrate on a held area", () => {
  test(
    "the owner integrates at once in a run the user opened there, by the user",
    async () => {
      const h = await held()
      h.backend.turn(h.owner)
      const done = await h.tool(IntegrateTool.NAME)(h.owner, { area: "ui" })
      expect(done).toMatchObject({ ok: true })
      expect(done.plan).toBeUndefined()
      expect(h.starts()).toEqual([{ teamID: TEAM_ID, areaID: h.area.id, by: "user" }])
    },
    SLOW,
  )

  test(
    "the owner is told when the device lacks the admin scope; nothing starts",
    async () => {
      const h = await held()
      h.backend.message(h.owner, "user", stamp(["prompt", "read"]))
      h.backend.message(h.owner, "assistant")
      expect(await h.tool(IntegrateTool.NAME)(h.owner, { area: "ui" })).toEqual({
        ok: false,
        error: "needs_pc",
        text: `${VoicePlan.needsPc("admin")} 메인에게 넘기기는 그 기기에서도 할 수 있습니다.`,
      })
      expect(h.starts()).toEqual([])
    },
    SLOW,
  )

  test(
    "without the user's message the owner gets a plan, redeemed with its token in the area folder",
    async () => {
      const h = await held()
      // A run the main's request opened: no user message in it.
      h.backend.message(h.owner, "user", { [OwnTeam.DISPATCH_META]: { id: "dp_x" } })
      h.backend.message(h.owner, "assistant")
      const plan = await h.tool(IntegrateTool.NAME)(h.owner, { area: "ui" })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(plan.text).toStartWith("ui: 직접 작업한 변경을 프로젝트 본 코드에 반영할까요?")
      expect(h.starts()).toEqual([])
      h.backend.reply(h.owner)
      expect(await h.tool(IntegrateTool.NAME)(h.owner, { area: "ui", token: plan.token })).toMatchObject({ ok: true })
      expect(h.starts()).toEqual([{ teamID: TEAM_ID, areaID: h.area.id, by: "user" }])
      // `tip` stays the main's.
      expect(await h.tool(IntegrateTool.NAME)(h.owner, { area: "ui", tip: true })).toEqual({
        ok: false,
        text: IntegrateTool.TIP_MAIN_ONLY,
      })
    },
    SLOW,
  )

  test(
    "the main always gets a plan, also right after the user's own message; approved, it runs by the user",
    async () => {
      const h = await held()
      h.backend.turn(MAIN_SESSION)
      const plan = await h.tool(IntegrateTool.NAME)(MAIN_SESSION, { area: "ui" })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(plan.text).toStartWith("ui: 직접 작업한 변경을 프로젝트 본 코드에 반영할까요?")
      expect(h.starts()).toEqual([])
      h.backend.reply(MAIN_SESSION)
      const done = await h.tool(IntegrateTool.NAME)(MAIN_SESSION, { area: "ui", token: plan.token })
      expect(done).toMatchObject({ ok: true })
      expect(done.text).toContain("턴을 끝내세요")
      expect(h.starts()).toEqual([{ teamID: TEAM_ID, areaID: h.area.id, by: "user" }])
    },
    SLOW,
  )

  test(
    "an area that is not held integrates as before (the main's run by main)",
    async () => {
      const h = await voiceTeam({ cleanups, policy: { directHold: true }, features: recorded })
      const made = await h.makeArea("ui", { commit: true })
      h.backend.turn(MAIN_SESSION)
      expect(await h.tool(IntegrateTool.NAME)(MAIN_SESSION, { area: "ui" })).toMatchObject({ ok: true })
      expect(h.calls.map((call) => call.input)).toEqual([{ teamID: TEAM_ID, areaID: made.id, by: "main" }])
    },
    SLOW,
  )
})

describe("team_area resume on a held area", () => {
  const resume = (h: VoiceTeam, sessionID: string, token?: string) =>
    h.tool(AreaTool.NAME)(sessionID, { action: "resume", area: "ui", ...(token === undefined ? {} : { token }) })
  const directWork = async (h: VoiceTeam) => (await h.areaOf("ui"))?.directWork

  test(
    "the owner hands it back at once in a run the user opened there",
    async () => {
      const h = await held()
      h.backend.turn(h.owner)
      const done = await resume(h, h.owner)
      expect(done).toMatchObject({
        ok: true,
        text: "ui: 메인에게 넘겼습니다. 기다리던 메인 요청 0개가 폴더가 쉴 때 하나씩 들어옵니다.",
      })
      expect(await directWork(h)).toBeUndefined()
    },
    SLOW,
  )

  test(
    "the owner without the user's message, or from a device without the scope, gets a plan",
    async () => {
      const h = await held()
      h.backend.message(h.owner, "user", { [OwnTeam.DISPATCH_META]: { id: "dp_x" } })
      h.backend.message(h.owner, "assistant")
      const none = await resume(h, h.owner)
      expect(none).toMatchObject({ ok: true, plan: true })
      expect(none.text).toStartWith("ui: 직접 작업을 마치고 메인에게 넘깁니다.")
      h.backend.idle(h.owner)
      h.backend.message(h.owner, "user", stamp(["read"]))
      h.backend.message(h.owner, "assistant")
      expect(await resume(h, h.owner)).toMatchObject({ ok: true, plan: true })
      expect(await directWork(h)).toBeDefined()
    },
    SLOW,
  )

  test(
    "the main takes it back at once only in a run the user opened after the last direct message",
    async () => {
      const h = await held()
      // The user wrote to the main before the last direct message: a plan.
      h.services.features().direct.said(TEAM_ID)
      h.clock.advance(1_000)
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.areas.get(TEAM_ID, h.area.id)
        if (current)
          await h.services.registry.areas.put({ ...current, directWork: { since: h.since, at: h.clock.now() } })
      })
      h.backend.turn(MAIN_SESSION)
      expect(await resume(h, MAIN_SESSION)).toMatchObject({ ok: true, plan: true })
      expect(await directWork(h)).toBeDefined()
      // Now the user writes to the main.
      h.clock.advance(1_000)
      h.services.features().direct.said(TEAM_ID)
      h.backend.reply(MAIN_SESSION)
      const taken = await resume(h, MAIN_SESSION)
      expect(taken.ok).toBe(true)
      expect(taken.plan).toBeUndefined()
      expect(taken.text).toStartWith("메인이 넘겨받음(")
      expect(taken.text).toContain('전문: team_status{area:"ui"}')
      expect(await directWork(h)).toBeUndefined()
    },
    SLOW,
  )

  test(
    "the main's resume of an area neither paused nor held says so",
    async () => {
      const h = await voiceTeam({ cleanups, policy: { directHold: true }, features: recorded })
      await h.makeArea("ui")
      h.backend.turn(MAIN_SESSION)
      expect(await resume(h, MAIN_SESSION)).toMatchObject({
        ok: false,
        text: "ui: 메인 멈춤이 꺼져 있고 직접 작업 중도 아닙니다.",
      })
    },
    SLOW,
  )
})

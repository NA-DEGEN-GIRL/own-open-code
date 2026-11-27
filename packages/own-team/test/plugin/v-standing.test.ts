// Standing areas the team already has (2026-11-17, live case L12): "맵 공방, …, 보스 담당을 계속 두고 싶어" on a team
// that has 보스, 화면 and 서버. The main marks an area it keeps as it is with `team_area{keep}` (내가 정한 영역, the area
// menu's toggle), at once in a run the user opened and a plan otherwise; `unkeep` is always a plan. An owner keeps its
// own area. A `rename` that reuses an area carries its whole new role (`goal`) and the mark (`userMade: true`): the
// main's applies at once, the plan of a big proposal counts the reused areas apart from the new ones, a role on an area
// held by direct work waits, the judge's role and mark are dropped, and 되돌리기 puts name, role and mark back. A team on
// a temp git home, a fake own service, a manual clock; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { JudgeValidate } from "../../src/judge/validate.js"
import { Retire } from "../../src/reorg/retire.js"
import { OwnerSession } from "../../src/sessions/owner.js"
import { AreaTool } from "../../src/tools/area.js"
import { ReorganizeTool } from "../../src/tools/reorganize.js"
import { VoicePlan } from "../../src/tools/voice.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type VoiceTeam, approve, voiceTeam } from "../support/voice.js"

const SLOW = 600_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SHAPES = "형상공방: 몬스터·NPC의 형상(모델, 스프라이트)과 그 시험"

/** The real owner feature, with each role refresh recorded. */
async function setup() {
  const refreshed: Array<{ readonly areaID: string }> = []
  const h = await voiceTeam({
    cleanups,
    features: () => ({
      owner: (services) => {
        const real = OwnerSession.create(services)
        return {
          ...real,
          refresh: async (input) => {
            refreshed.push({ areaID: input.areaID })
            return real.refresh ? real.refresh(input) : { ok: true }
          },
        }
      },
    }),
  })
  const boss = await h.makeArea("boss", { goal: "보스 본체: 규칙·모델·연출" })
  const hwamyeon = await h.makeArea("hwamyeon", { goal: "src/ui의 화면 코드와 테스트" })
  return { ...h, boss, hwamyeon, refreshed, area: h.tool(AreaTool.NAME), reorganize: h.tool(ReorganizeTool.NAME) }
}

/** A run opened by a message of a device with only `prompt` and `read`. */
function phone(h: VoiceTeam, sessionID: string) {
  h.backend.idle(sessionID)
  h.backend.message(sessionID, "user", { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read"] } })
  h.backend.message(sessionID, "assistant")
}

describe("team_area{keep, unkeep}", () => {
  test(
    "the main keeps an area at once in a run the user opened; the mark is the toggle's and only it changes",
    async () => {
      const h = await setup()
      const before = (await h.areaOf("boss"))!
      h.backend.turn(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "keep", area: "boss" })).toEqual({
        ok: true,
        text: AreaTool.KEPT("boss"),
      })
      const after = (await h.areaOf("boss"))!
      expect(after.userMade).toEqual({ at: expect.any(Number) })
      expect({ ...after, userMade: undefined }).toEqual({ ...before, userMade: undefined })
      expect(await h.services.journal.list(TEAM_ID)).toEqual([])
      // Kept: never offered for ending, whatever its branch looks like.
      const quiet = { commits: 3, unapplied: 0, clean: true, changedAt: 0, now: 30 * 86_400_000 }
      expect(Retire.retirable({ ...before, status: { ...before.status, at: 0 } }, quiet)).toBe(true)
      expect(Retire.retirable({ ...after, status: { ...after.status, at: 0 } }, quiet)).toBe(false)
      expect(await h.area(MAIN_SESSION, { action: "keep", area: "boss" })).toEqual({
        ok: true,
        text: AreaTool.KEPT_ALREADY("boss"),
      })
    },
    SLOW,
  )

  test(
    "a plan in a run the user did not open; unkeep is always a plan, and the user's yes removes the mark",
    async () => {
      const h = await setup()
      h.backend.idle(MAIN_SESSION)
      const before = await h.snapshot()
      const planned = await h.area(MAIN_SESSION, { action: "keep", area: "boss" })
      expect(planned).toMatchObject({ ok: true, plan: true })
      expect(planned.text).toContain("'boss'을(를) 사용자가 정한 영역으로 표시합니다.")
      expect(await h.snapshot()).toEqual(before)

      h.backend.reply(MAIN_SESSION)
      const kept = await h.area(MAIN_SESSION, { action: "keep", area: "boss", token: planned.token })
      expect(kept).toEqual({ ok: true, text: AreaTool.KEPT("boss") })
      expect((await h.areaOf("boss"))?.userMade).toBeDefined()

      h.backend.turn(MAIN_SESSION)
      const asked = await h.area(MAIN_SESSION, { action: "unkeep", area: "boss" })
      expect(asked).toMatchObject({ ok: true, plan: true })
      expect(asked.text).toContain("끝내자는 제안이 붙을 수 있습니다")
      expect((await h.areaOf("boss"))?.userMade).toBeDefined()
      const removed = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "unkeep", area: "boss" })
      expect(removed.done).toEqual({ ok: true, text: AreaTool.UNKEPT("boss") })
      expect((await h.areaOf("boss"))?.userMade).toBeUndefined()
      h.backend.turn(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "unkeep", area: "boss" })).toEqual({
        ok: true,
        text: AreaTool.UNKEPT_ALREADY("boss"),
      })
    },
    SLOW,
  )

  test(
    "an owner keeps its own area at once in a run the user opened there; a phone without admin is sent to the PC",
    async () => {
      const h = await setup()
      const owner = h.boss.owner.sessionID!
      phone(h, owner)
      expect(await h.area(owner, { action: "keep", area: "boss" })).toEqual({
        ok: false,
        text: VoicePlan.needsPc("admin"),
      })
      expect((await h.areaOf("boss"))?.userMade).toBeUndefined()
      h.backend.idle(owner)
      h.backend.turn(owner)
      expect(await h.area(owner, { action: "keep", area: "hwamyeon" })).toEqual({
        ok: false,
        text: AreaTool.OWN_AREA_ONLY,
      })
      expect(await h.area(owner, { action: "keep", area: "boss" })).toEqual({ ok: true, text: AreaTool.KEPT("boss") })
      expect((await h.areaOf("boss"))?.userMade).toBeDefined()
      expect(await h.area(owner, { action: "unkeep", area: "boss" })).toMatchObject({ ok: true, plan: true })
    },
    SLOW,
  )
})

describe("team_reorganize rename with a role and the mark", () => {
  test(
    "the main's rename that reuses an area applies at once: name, whole new role and mark; the owner hears the role; 되돌리기 puts all back",
    async () => {
      const h = await setup()
      h.backend.turn(MAIN_SESSION)
      const answer = await h.reorganize(MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [{ op: "rename", area: "hwamyeon", name: "형상공방", goal: `  ${SHAPES}\n`, userMade: true }],
        },
      })
      expect(answer).toMatchObject({ ok: true })
      expect(answer.plan).toBeUndefined()
      const op = await h.settled(String(answer.opID))
      expect(op).toMatchObject({ kind: "reorg", by: "main", state: "done" })
      const renamed = (await h.areaOf("hwamyeon"))!
      expect(renamed.name).toBe("형상공방")
      expect(renamed.goal).toBe(SHAPES)
      expect(renamed.userMade).toBeDefined()
      expect(h.refreshed).toContainEqual({ areaID: h.hwamyeon.id })

      const undo = (await h.rpc("op.undo", { opID: op.id })) as { readonly opID: string }
      const undone = await h.finish(undo.opID)
      expect(undone).toMatchObject({ kind: "undo", state: "done" })
      const back = (await h.areaOf("hwamyeon"))!
      expect(back.name).toBe("hwamyeon")
      expect(back.goal).toBe("src/ui의 화면 코드와 테스트")
      expect(back.userMade).toBeUndefined()
    },
    SLOW,
  )

  test(
    "a big proposal's plan counts the reused areas apart from the new ones, and their lines carry role and mark",
    async () => {
      const h = await setup()
      const news = ["map", "items", "monsters", "npc-audio", "mud"].map((slug) => ({
        op: "new",
        slug,
        name: slug,
        userMade: true,
      }))
      h.backend.turn(MAIN_SESSION)
      const planned = await h.reorganize(MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [...news, { op: "rename", area: "hwamyeon", name: "형상공방", goal: SHAPES, userMade: true }],
        },
      })
      expect(planned).toMatchObject({ ok: true, plan: true })
      const lines = planned.text.split("\n")
      expect(lines[0]).toBe(ReorganizeTool.PLAN_MANY(["map", "items", "monsters", "npc-audio", "mud"], 5, ["형상공방"]))
      expect(lines[0]).toContain("그중 5개는 사용자가 정한 영역이 됩니다. 이름을 바꿔 다시 쓰는 영역 '형상공방'도")
      expect(lines).toContain(
        `- 'hwamyeon' 영역 이름을 '형상공방'(으)로 바꿉니다${ReorganizeTool.ROLE(SHAPES)}${ReorganizeTool.MINE}`,
      )
    },
    SLOW,
  )

  test(
    "a new role on an area held by direct work is skipped for the main; a plain rename there goes on",
    async () => {
      const h = await setup()
      await h.makeArea("held", { direct: true, goal: "옛 역할" })
      h.backend.turn(MAIN_SESSION)
      const answer = await h.reorganize(MAIN_SESSION, {
        proposal: { version: 1, ops: [{ op: "rename", area: "held", name: "새 이름", goal: "새 역할" }] },
      })
      expect(answer).toMatchObject({ ok: false, skipped: [{ item: "ops/0", area: "held" }] })
      expect((await h.areaOf("held"))?.goal).toBe("옛 역할")
      const plain = await h.reorganize(MAIN_SESSION, {
        proposal: { version: 1, ops: [{ op: "rename", area: "held", name: "새 이름" }] },
      })
      await h.settled(String(plain.opID))
      expect(await h.areaOf("held")).toMatchObject({ name: "새 이름", goal: "옛 역할" })
    },
    SLOW,
  )
})

describe("V-rules of a rename's role and mark", () => {
  test("kept for the user's and the main's, dropped for the judge's; a role over 1,000 characters is refused", async () => {
    const h = await setup()
    const facts = { target: "main", areas: await h.services.registry.areas.list(TEAM_ID), heavy: [] }
    const proposal: OwnTeam.Proposal = {
      version: 1,
      ops: [{ op: "rename", area: "hwamyeon", name: "형상공방", goal: SHAPES, userMade: true }],
    }
    const main = JudgeValidate.reorganize(proposal, facts, "main").actions[0]
    expect(main).toMatchObject({ action: "rename", goal: SHAPES, userMade: true })
    expect(main).toMatchObject({ previous: { goal: "src/ui의 화면 코드와 테스트", userMade: false } })
    const judge = JudgeValidate.reorganize(proposal, facts, "auto").actions[0]
    expect(judge).toMatchObject({ action: "rename", name: "형상공방" })
    expect(judge).not.toHaveProperty("goal")
    expect(judge).not.toHaveProperty("userMade")
    const long = JudgeValidate.reorganize(
      { version: 1, ops: [{ op: "rename", area: "hwamyeon", name: "x", goal: "역".repeat(1_001) }] },
      facts,
      "main",
    )
    expect(long.actions).toHaveLength(0)
    expect(long.rejected).toEqual([{ item: "ops/0", why: JudgeValidate.ROLE_LONG(1_001) }])
  })
})

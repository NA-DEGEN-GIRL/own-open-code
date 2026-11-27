// 사용자가 정하는 영역 (06 §2.4, §2.7, §2.9 V-b (5), 2026-10-26): the team main's structural changes of an area the
// user set up (`Area.userMade`) are a plan its next message approves, the whole proposal run by the user; a rename, a
// split, a merge on either side, a conversion and a retire of such an area all plan, a change of the other areas runs
// by main at once, and a preview says a plan comes first. A new peer of such an area is a plan too. Since 2026-10-27
// the plan lists every item, the user's run of it keeps the main's proposal the main's (no model, 에이전트 방식 or mark
// of the user's, conversation moves as suggestions), and the main's 다시 만들기 of a stopped user-made area (an `ops`
// or an `areas` item) is a plan that carries the mark. 팀 구성 다시 보기 runs the chosen items of the judge's stored
// proposal by id, as the judge's. `area.edit` writes the role (the attached owner's entry at once) and the mark, with no
// op; `area.create.check` names the folder V6 gives a new area. The team update and the main's area view name the role,
// the mark and the peers' roles. A team on a temp git home, a fake own service, a manual clock; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { ReorgOps } from "../../src/ops/reorg.js"
import { Areas } from "../../src/registry/area.js"
import { Keys } from "../../src/registry/keys.js"
import { ReorgPlan } from "../../src/reorg/plan.js"
import { Digest } from "../../src/report/digest.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import type { Services } from "../../src/services.js"
import { ControlTool } from "../../src/tools/control.js"
import { ReorganizeTool } from "../../src/tools/reorganize.js"
import { StatusTool } from "../../src/tools/status.js"
import { MAIN_SESSION, MODEL, TEAM_ID } from "../support/context.js"
import { type Calls, type VoiceTeam, approve, voiceTeam } from "../support/voice.js"

const SLOW = 600_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Peers recorded instead of made (the voice backend has no session creation). */
function peers(calls: Calls): Partial<Services.Factories> {
  const failed = async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }) as const
  return {
    peers: (services) => ({
      add: async (input) => {
        calls.push({ name: "peers.add", input })
        const area = await services.registry.areas.get(input.teamID, input.areaID)
        if (!area) throw new Error("no area")
        const peer: OwnTeam.Peer = {
          key: "sim",
          sessionID: SessionID.make("ses_peer0000000000000000000001"),
          label: "label" in input ? input.label : input.create.label,
          role: "",
          attached: true,
          origin: "created",
          at: 1,
        }
        return { ok: true, area: Areas.view(area), peer }
      },
      edit: failed,
      remove: failed,
      attach: async () => ({ ok: true }),
      detach: async () => ({ ok: true }),
    }),
  }
}

/**
 * core's `session.create` of the owner a new area gets, and own.accounts' approval mode, so a new area completes; the
 * bodies posted.
 */
function creates(h: VoiceTeam) {
  const posted: Array<{ readonly id: string; readonly metadata?: Readonly<Record<string, unknown>> }> = []
  h.world.accounts.set("session.approval.set", (call) => ({ mode: (call as { mode: string }).mode, patched: [] }))
  h.backend.service.routes.set("POST /api/session", (request) => {
    const body = request.body as {
      readonly id: string
      readonly location: { readonly directory: string }
      readonly metadata?: Readonly<Record<string, unknown>>
    }
    posted.push(body)
    h.backend.add(body.id, body.location.directory, "담당")
    return Response.json({
      data: {
        id: body.id,
        projectID: "prj_test",
        title: "담당",
        location: { directory: body.location.directory },
        time: { created: 1, updated: 1 },
        metadata: body.metadata ?? {},
      },
    })
  })
  return posted
}

describe("team_reorganize on an area the user set up (V-b (5))", () => {
  test(
    "rename, split, merge (either side), conversion and retire of a user-made area plan; others run by main",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters", { userMade: true, goal: "몬스터 그림" })
      await h.makeArea("items", { commit: true })
      await h.makeArea("sim")
      const reorganize = h.tool(ReorganizeTool.NAME)
      const before = await h.snapshot()
      const proposals = [
        { op: "rename", area: "monsters", name: "몬스터 에셋" },
        { op: "split", area: "monsters", slug: "bosses", name: "보스" },
        { op: "merge", area: "monsters", from: "items" },
        { op: "merge", area: "items", from: "monsters" },
        { op: "convert", area: "monsters", shape: "full" },
        { op: "retire", area: "monsters" },
      ]
      for (const op of proposals) {
        h.backend.turn(MAIN_SESSION)
        const plan = await reorganize(MAIN_SESSION, { proposal: { version: 1, ops: [op] } })
        expect(plan, op.op).toMatchObject({ ok: true, plan: true })
        if (op.op !== "retire") expect(plan.text, op.op).toContain(ReorganizeTool.PLAN_USER_MADE(["monsters"]))
        expect(await h.snapshot(), op.op).toEqual(before)
      }
      // The plan words each change as a preview does.
      h.backend.turn(MAIN_SESSION)
      const merge = await reorganize(MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [
            { op: "merge", area: "monsters", from: "items" },
            { op: "rename", area: "sim", name: "시뮬레이션" },
          ],
        },
      })
      expect(merge.text).toContain("- 'items'을(를) 'monsters'에 묶습니다")
      // 2026-10-27: every item the user's yes runs is listed, the other area's rename too.
      expect(merge.text).toContain(`${ReorganizeTool.PLAN_ITEMS}\n- 'items'을(를) 'monsters'에 묶습니다`)
      expect(merge.text).toContain("- 'sim' 영역 이름을 '시뮬레이션'(으)로 바꿉니다")
      expect(await h.snapshot()).toEqual(before)

      // An area nobody marked changes at once, by main.
      const plain = await reorganize(MAIN_SESSION, {
        proposal: { version: 1, ops: [{ op: "rename", area: "sim", name: "시뮬레이션" }] },
      })
      expect(plain).toMatchObject({ ok: true })
      expect(plain.plan).toBeUndefined()
      expect(await h.settled(String(plain.opID))).toMatchObject({ kind: "reorg", by: "main", state: "done" })
      expect((await h.areaOf("sim"))?.name).toBe("시뮬레이션")
    },
    SLOW,
  )

  test(
    "the user's next message runs the planned proposal by the user; a preview says a plan comes first",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters", { userMade: true })
      const input = { proposal: { version: 1, ops: [{ op: "rename", area: "monsters", name: "몬스터 에셋" }] } }
      const preview = await h.tool(ReorganizeTool.NAME)(MAIN_SESSION, { ...input, preview: true })
      expect(preview).toMatchObject({ ok: true, preview: true })
      expect(preview.text).toContain(ReorganizeTool.PREVIEW_USER_MADE(["monsters"]))
      expect(preview.text).not.toContain(ReorganizeTool.PREVIEW_RETIRE)
      expect("token" in preview).toBe(false)
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, input)
      expect(plan.text).toContain("- 'monsters' 영역 이름을 '몬스터 에셋'(으)로 바꿉니다")
      expect(done).toMatchObject({ ok: true })
      expect(await h.settled(String(done.opID))).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      const renamed = await h.areaOf("monsters")
      expect(renamed?.name).toBe("몬스터 에셋")
      // The mark stays with the area.
      expect(renamed?.userMade).toEqual({ at: 1 })
    },
    SLOW,
  )

  test(
    "the user's run of the main's planned proposal keeps out what only the user sets (the mark of a standing role stays, 2026-11-14) and moves nothing; the plan lists every item",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters", { userMade: true })
      // A conversation of the main folder that is no team session. (An adopt row's mark: test/reorg/plan.test.ts.)
      const user = SessionID.make("ses_user0000000000000000000001")
      h.backend.add(user, h.home, "내 대화")
      const posted = creates(h)
      const input = {
        proposal: {
          version: 1,
          ops: [
            { op: "rename", area: "monsters", name: "몬스터 에셋" },
            {
              op: "new",
              slug: "bosses",
              name: "보스",
              main: { providerID: MODEL.providerID, id: MODEL.id },
              harness: { id: "codex", prompt: "own" },
              userMade: true,
            },
            { op: "move", sessionID: user, area: "monsters" },
          ],
        },
      }
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, input)
      const lines = plan.text.split("\n")
      expect(lines.slice(0, 2)).toEqual([ReorganizeTool.PLAN_USER_MADE(["monsters"]), ReorganizeTool.PLAN_ITEMS])
      expect(lines).toContain("- 'monsters' 영역 이름을 '몬스터 에셋'(으)로 바꿉니다")
      // The main may mark a new area as a standing role the user asked to keep (AL-9): that mark is kept.
      expect(lines).toContain(
        `- 새 영역 '보스'을(를) 만듭니다 · 새 작업 폴더${ReorganizeTool.MINE}${ReorganizeTool.DROPPED(["모델", "에이전트 방식"])}`,
      )
      expect(lines).toContain(`- 대화 하나를 'monsters' 영역 폴더로 옮깁니다${ReorganizeTool.PLAN_MOVE}`)
      expect(done).toMatchObject({ ok: true })
      const op = await h.settled(String(done.opID))
      expect(op).toMatchObject({ kind: "reorg", by: "user" })
      const args = (kind: string) => op.steps.filter((step) => step.kind === kind).map((step) => step.args)
      // The new area has no model or 에이전트 방식 of the user's; the main's standing-role mark makes it the user's.
      const record = args("area-record").find((item) => item.areaID === "ar_bosses")
      expect(record).toMatchObject({ userMade: true })
      expect(record && "main" in record).toBe(false)
      expect(args("owner-create").every((item) => !("harness" in item))).toBe(true)
      expect(posted.map((body) => Object.keys(body.metadata ?? {}))).toEqual([["own.team"]])
      // V11: the move is the card's suggestion, never a step.
      expect(op.steps.map((step) => step.kind)).not.toContain("session-move")
      expect(op.summary?.lines).toContainEqual(
        expect.objectContaining({ kind: "suggest", suggestion: expect.objectContaining({ kind: "move" }) }),
      )
      expect(h.backend.moves).toEqual([])
      expect((await h.areaOf("bosses"))?.userMade).toEqual({ at: h.clock.now() })
      expect((await h.areaOf("monsters"))?.name).toBe("몬스터 에셋")
    },
    SLOW,
  )

  test(
    "the main's 다시 만들기 of a stopped area the user set up is a plan that carries the mark; never in a run by main",
    async () => {
      const h = await voiceTeam({ cleanups })
      const stopped = await h.makeArea("monsters", { userMade: true })
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...stopped, state: "broken", broken: { why: "missing", at: 1 } }),
      )
      const before = await h.snapshot()
      creates(h)
      const proposal: OwnTeam.Proposal = {
        version: 1,
        ops: [{ op: "new", slug: "monsters", name: "몬스터", from: "monsters" }],
      }
      const input = { proposal }
      h.backend.turn(MAIN_SESSION)
      const preview = await h.tool(ReorganizeTool.NAME)(MAIN_SESSION, { ...input, preview: true })
      expect(preview.text).toContain(ReorganizeTool.PREVIEW_USER_MADE(["monsters"]))
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, input)
      expect(plan.text).toContain(`- 새 영역 '몬스터'을(를) 만듭니다 · 새 작업 폴더${ReorganizeTool.CARRIED}`)
      expect(done).toMatchObject({ ok: true })
      const op = await h.settled(String(done.opID))
      expect(op).toMatchObject({ kind: "reorg", by: "user" })
      expect(op.steps.find((step) => step.kind === "area-record")?.args).toMatchObject({
        areaID: "ar_monsters-2",
        userMade: true,
      })
      // Planned as the main's own run, the mark does not come along.
      const team = before.team
      if (!team) throw new Error("no team")
      const own = await ReorgPlan.build(h.services, { team, proposal, by: "main" })
      if (!own.ok) throw new Error(own.message)
      const record = own.steps.find((step) => step.kind === "area-record")
      expect(record?.args).toBeDefined()
      expect(record?.args && "userMade" in record.args).toBe(false)
    },
    SLOW,
  )

  test(
    "a mark the main wrote on its 다시 만들기 is carried, not also said to be left out",
    async () => {
      const h = await voiceTeam({ cleanups })
      const stopped = await h.makeArea("monsters", { userMade: true })
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...stopped, state: "broken", broken: { why: "missing", at: 1 } }),
      )
      const before = await h.snapshot()
      // The main's own model and mark on an `ops` and an `areas` 다시 만들기: the model is left out, the mark carried.
      h.backend.turn(MAIN_SESSION)
      const plan = await h.tool(ReorganizeTool.NAME)(MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [
            {
              op: "new",
              slug: "monsters",
              name: "몬스터",
              from: "monsters",
              main: { providerID: MODEL.providerID, id: MODEL.id },
              userMade: true,
            },
          ],
          areas: [{ slug: "bosses", name: "보스", create: { from: "monsters" }, userMade: true }],
        },
      })
      expect(plan).toMatchObject({ ok: true, plan: true })
      const lines = plan.text.split("\n")
      expect(lines).toContain(
        `- 새 영역 '몬스터'을(를) 만듭니다 · 새 작업 폴더${ReorganizeTool.CARRIED}${ReorganizeTool.DROPPED(["모델"])}`,
      )
      expect(lines).toContain(`- 새 영역 '보스'을(를) 만듭니다 · 새 작업 폴더${ReorganizeTool.CARRIED}`)
      expect(await h.snapshot()).toEqual(before)
    },
    SLOW,
  )

  test(
    "a `from` naming a new area of the same proposal that starts at main is no 다시 만들기: main runs it at once",
    async () => {
      const h = await voiceTeam({ cleanups })
      const stopped = await h.makeArea("monsters", { userMade: true })
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...stopped, state: "broken", broken: { why: "missing", at: 1 } }),
      )
      creates(h)
      // bosses starts at the new monsters, which starts at main: neither is the stopped monsters made again.
      const input = {
        proposal: {
          version: 1,
          ops: [
            { op: "new", slug: "monsters", name: "몬스터", from: "main" },
            { op: "new", slug: "bosses", name: "보스", from: "monsters" },
          ],
        },
      }
      h.backend.turn(MAIN_SESSION)
      const preview = await h.tool(ReorganizeTool.NAME)(MAIN_SESSION, { ...input, preview: true })
      expect(preview.text).not.toContain(ReorganizeTool.PREVIEW_USER_MADE(["monsters"]))
      const done = await h.tool(ReorganizeTool.NAME)(MAIN_SESSION, input)
      expect(done).toMatchObject({ ok: true })
      expect(done.plan).toBeUndefined()
      const op = await h.settled(String(done.opID))
      expect(op).toMatchObject({ kind: "reorg", by: "main" })
      expect(
        op.steps
          .filter((step) => step.kind === "area-record")
          .map((step) => [step.args?.areaID, step.args !== undefined && "userMade" in step.args]),
      ).toEqual([
        ["ar_monsters-2", false],
        ["ar_bosses", false],
      ])
    },
    SLOW,
  )

  test(
    "다시 만들기 through `areas[].create` of a stopped area the user set up is a plan too, which carries the mark",
    async () => {
      const h = await voiceTeam({ cleanups })
      const stopped = await h.makeArea("monsters", { userMade: true })
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...stopped, state: "broken", broken: { why: "missing", at: 1 } }),
      )
      creates(h)
      // A plan, not the main's run at once.
      const input = {
        proposal: { version: 1, areas: [{ slug: "monsters", name: "몬스터", create: { from: "monsters" } }] },
      }
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, input)
      expect(plan.text.split("\n").slice(0, 3)).toEqual([
        ReorganizeTool.PLAN_USER_MADE(["monsters"]),
        ReorganizeTool.PLAN_ITEMS,
        `- 새 영역 '몬스터'을(를) 만듭니다 · 새 작업 폴더${ReorganizeTool.CARRIED}`,
      ])
      expect(done).toMatchObject({ ok: true })
      const ran = await h.settled(String(done.opID))
      expect(ran).toMatchObject({ kind: "reorg", by: "user" })
      expect(ran.steps.find((step) => step.kind === "area-record")?.args).toMatchObject({
        areaID: "ar_monsters-2",
        userMade: true,
      })
    },
    SLOW,
  )

  test(
    "a new peer of a user-made or directly worked area is a plan; elsewhere it is made at once",
    async () => {
      const h = await voiceTeam({ cleanups, features: peers })
      await h.makeArea("monsters", { userMade: true })
      await h.makeArea("sim")
      const control = h.tool(ControlTool.NAME)
      const at = await control(MAIN_SESSION, { action: "peer_add", area: "sim", label: "리뷰어" })
      expect(at).toMatchObject({ ok: true, peer: "sim" })
      expect(at.plan).toBeUndefined()
      expect(h.calls).toHaveLength(1)
      const { plan, done } = await approve(h, MAIN_SESSION, ControlTool.NAME, {
        action: "peer_add",
        area: "monsters",
        label: "리뷰어",
      })
      expect(plan.text).toContain("사용자가 정한 영역 'monsters'에 새 동료")
      expect(done).toMatchObject({ ok: true })
      expect(h.calls.map((item) => item.name)).toEqual(["peers.add", "peers.add"])
      // An area the user works in directly is not reshaped by the main at once either (2026-11-15).
      await h.makeArea("held", { direct: true })
      const held = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "peer_add", area: "held", label: "리뷰어" })
      expect(held.plan.text).toContain("사용자가 직접 작업 중인 영역 'held'에 새 동료")
      expect(held.done).toMatchObject({ ok: true })
      expect(h.calls.map((item) => item.name)).toEqual(["peers.add", "peers.add", "peers.add"])
    },
    SLOW,
  )
})

describe("팀 구성 다시 보기's chosen items (reorg.apply{proposalID, items}, 2026-10-27)", () => {
  test(
    "only the chosen items run, by the user and as the judge wrote them: its model, 에이전트 방식 and mark stay out",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters", { userMade: true })
      const posted = creates(h)
      // The judge's answer as `reorg.propose` stored it (lenient: whatever the judge wrote).
      const proposalID = OwnTeam.ProposalID.create()
      const proposal: OwnTeam.Proposal = {
        version: 1,
        ops: [
          { op: "rename", area: "monsters", name: "몬스터 에셋" },
          {
            op: "new",
            slug: "bosses",
            name: "보스",
            main: { providerID: MODEL.providerID, id: MODEL.id },
            harness: { id: "codex", prompt: "own" },
            userMade: true,
          },
        ],
        notes: "보스를 따로 두면 좋아요",
      }
      await h.services.kv.set(
        Keys.proposal(TEAM_ID, proposalID),
        Keys.toJson(Schema.encodeSync(ReorgOps.Stored)({ proposal, createdAt: h.clock.now() })),
      )
      const answer = (await h.rpc("reorg.apply", { teamID: TEAM_ID, proposalID, items: ["ops/1"] })) as {
        readonly opID: string
      }
      const op = await h.settled(answer.opID)
      expect(op).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      const record = op.steps.find((step) => step.kind === "area-record")?.args
      expect(record).toMatchObject({ areaID: "ar_bosses" })
      expect(record && ("main" in record || "userMade" in record)).toBe(false)
      expect(op.steps.filter((step) => step.kind === "owner-create").every((step) => !("harness" in step.args))).toBe(
        true,
      )
      expect(posted.map((body) => Object.keys(body.metadata ?? {}))).toEqual([["own.team"]])
      const bosses = await h.areaOf("bosses")
      expect(bosses?.userMade).toBeUndefined()
      expect(bosses?.main).toBeUndefined()
      // What the user did not choose did not run.
      expect(op.steps.map((step) => step.kind)).not.toContain("area-rename")
      expect((await h.areaOf("monsters"))?.name).toBe("monsters")

      // A proposal the user wrote (영역 만들기) keeps what the user set.
      const own = (await h.rpc("reorg.apply", {
        teamID: TEAM_ID,
        proposal: { version: 1, ops: [{ op: "new", slug: "sim", name: "시뮬레이션", userMade: true }] },
      })) as { readonly opID: string }
      expect(await h.settled(own.opID)).toMatchObject({ by: "user", state: "done" })
      expect((await h.areaOf("sim"))?.userMade).toEqual({ at: h.clock.now() })
    },
    SLOW,
  )
})

describe("area.edit (역할 바꾸기…, 내가 정한 영역)", () => {
  test(
    "the role (up to 1,000, on one line) reaches the attached owner at once and tells the main; the mark goes on and off; no op",
    async () => {
      const h = await voiceTeam({ cleanups })
      const made = await h.makeArea("monsters")
      const owner = made.owner.sessionID
      const published: string[] = []
      cleanups.push(h.controller.hub.subscribe((event) => published.push(event.name)))
      const goal = `${"몬스터 그림과 스프라이트".repeat(20)}\n끝`
      const edited = (await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, goal, userMade: true })) as {
        readonly area: OwnTeam.AreaView
      }
      expect(edited.area.goal).toBe(`${"몬스터 그림과 스프라이트".repeat(20)} 끝`)
      expect(edited.area.userMade).toEqual({ at: h.clock.now() })
      // The screen's change tells the main in its next update, without waking it (2026-11-14).
      const told = (await Digest.load(h.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "role")
      expect(told).toMatchObject([{ areaID: made.id, text: "역할이 바뀜(사용자가 화면에서)", wake: false }])
      const put = h.backend.service.requests.filter(
        (request) =>
          request.method === "PUT" &&
          request.path === `/api/experimental/session/${owner}/instructions/entries/${RoleInstructions.OWNER}`,
      )
      expect(put).toHaveLength(1)
      expect(JSON.stringify(put[0]?.body)).toContain(`역할: ${edited.area.goal}`)
      // The mark again keeps its first time; `false` removes it; a role left as it is writes no entry.
      h.clock.advance(1_000)
      const again = (await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, userMade: true })) as {
        readonly area: OwnTeam.AreaView
      }
      expect(again.area.userMade).toEqual(edited.area.userMade)
      const off = (await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, userMade: false })) as {
        readonly area: OwnTeam.AreaView
      }
      expect("userMade" in off.area).toBe(false)
      expect((await h.areaOf("monsters"))?.userMade).toBeUndefined()
      expect(
        h.backend.service.requests.filter(
          (request) => request.method === "PUT" && request.path.endsWith(RoleInstructions.OWNER),
        ),
      ).toHaveLength(1)
      expect(await h.services.journal.list(TEAM_ID)).toEqual([])
      expect(published).toContain("area.changed")
      // Only a role change writes the entry: the mark alone did not.
      expect(
        (await Digest.load(h.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "role"),
      ).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "a note of 1,024 characters is kept, a longer one refused in characters (2026-11-14)",
    async () => {
      const h = await voiceTeam({ cleanups })
      const made = await h.makeArea("monsters")
      const kept = (await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, note: "가".repeat(1_024) })) as {
        readonly area: OwnTeam.AreaView
      }
      expect(kept.area.owner.note).toBe("가".repeat(1_024))
      expect(await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, note: "가".repeat(1_025) })).toMatchObject({
        type: "seat_invalid",
        message: "담당 메모는 1,024자 이하로 적어요",
      })
    },
    SLOW,
  )

  test(
    "a retire of a 내가 정한 영역 the user asked the main for is a plan, and the user's yes ends it (V-b (5))",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters", { userMade: true })
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, {
        proposal: { version: 1, ops: [{ op: "retire", area: "monsters" }] },
      })
      expect(plan.text).toContain("영역 monsters을(를) 끝냅니다")
      expect(done).toMatchObject({ ok: true })
      // The folder removal waits for its own confirm; the area is retired before it.
      expect(await h.finish(String(done.opID), "skip")).toMatchObject({ kind: "reorg", by: "user" })
      expect((await h.areaOf("monsters"))?.state).toBe("retired")
    },
    SLOW,
  )

  test(
    "an unknown or finished area, a stopped one and a team that is off are refused",
    async () => {
      const h = await voiceTeam({ cleanups })
      const made = await h.makeArea("monsters")
      expect(await h.rpc("area.edit", { teamID: TEAM_ID, areaID: "ar_nope", goal: "x" })).toMatchObject({
        type: "not_found",
      })
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...made, state: "broken", broken: { why: "missing", at: 1 } }),
      )
      expect(await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, goal: "x" })).toMatchObject({
        type: "broken",
      })
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...made, state: "retired" }))
      expect(await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, goal: "x" })).toMatchObject({
        type: "not_found",
      })
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.teams.get(TEAM_ID)
        if (current) await h.services.registry.teams.put({ ...current, state: "off" })
      })
      expect(await h.rpc("area.edit", { teamID: TEAM_ID, areaID: made.id, goal: "x" })).toMatchObject({
        type: "team_off",
      })
    },
    SLOW,
  )
})

describe("area.create.check (영역 만들기's 만들 곳, 2026-10-27)", () => {
  test(
    "the name V6 gives now: `-2` for an area, a branch or a non-empty folder of the name; a free one as typed",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters")
      fs.mkdirSync(path.join(h.record.worktreeRoot, "assets", "old"), { recursive: true })
      fs.mkdirSync(path.join(h.record.worktreeRoot, "empty"), { recursive: true })
      const check = (slug: string) => h.rpc("area.create.check", { teamID: TEAM_ID, slug })
      const at = (slug: string) => path.join(h.record.worktreeRoot, slug)
      expect(await check("main")).toEqual({ slug: "main-2", directory: at("main-2"), taken: "branch" })
      expect(await check("monsters")).toEqual({ slug: "monsters-2", directory: at("monsters-2"), taken: "area" })
      expect(await check("assets")).toEqual({ slug: "assets-2", directory: at("assets-2"), taken: "folder" })
      expect(await check("empty")).toEqual({ slug: "empty", directory: at("empty") })
      expect(await check("fresh")).toEqual({ slug: "fresh", directory: at("fresh") })
      // The name the V-rules give the proposal's slug (V6), not the one typed: a trailing `-` or `--` goes.
      expect(await check("fresh-")).toEqual({ slug: "fresh", directory: at("fresh") })
      expect(await check("a--b")).toEqual({ slug: "a-b", directory: at("a-b") })
      expect(await check("monsters-")).toEqual({ slug: "monsters-2", directory: at("monsters-2"), taken: "area" })
      // It reads only.
      expect(await h.services.journal.list(TEAM_ID)).toEqual([])
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.teams.get(TEAM_ID)
        if (current) await h.services.registry.teams.put({ ...current, state: "off" })
      })
      expect(await check("fresh")).toMatchObject({ type: "team_off" })
      expect(await h.rpc("area.create.check", { teamID: "tm_ffffffffffff", slug: "x" })).toMatchObject({
        type: "not_found",
      })
    },
    SLOW,
  )
})

describe("what the main reads", () => {
  test(
    "the team update names an area's role and mark after its status word; the area view lists its peers' roles",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("monsters", {
        userMade: true,
        goal: "몬스터 그림과 스프라이트를 만든다",
        peers: [
          {
            key: "reviewer",
            sessionID: SessionID.make("ses_review000000000000000000001"),
            label: "리뷰어",
            role: "바뀐 그림을 읽고 짚는다",
            attached: false,
            origin: "registered",
            at: 1,
          },
        ],
      })
      await h.makeArea("sim")
      const text = await h.services.features().digest.render({ teamID: TEAM_ID })
      const line = text.split("\n").find((item) => item.startsWith("- monsters:"))
      expect(line).toBe(`- monsters: 쉬는 중 · 역할 "몬스터 그림과 스프라이트를 만든다" · ${Digest.USER_MADE}`)
      expect(OwnTeamText.countOf(line ?? "")).toBe("done")
      expect(text.split("\n").find((item) => item.startsWith("- sim:"))).toBe("- sim: 쉬는 중")
      const view = await h.tool(StatusTool.NAME)(MAIN_SESSION, { area: "monsters" })
      expect(view.text).toContain('대화: 담당, 리뷰어(reviewer) 역할 "바뀐 그림을 읽고 짚는다"')
    },
    SLOW,
  )
})

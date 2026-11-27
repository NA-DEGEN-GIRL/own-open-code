// `team_control` part 2 and the extended tools (06 §2.9): 되돌리기 (an op, an area's integration, or the last op that
// can be undone), 원격에 올리기 (a plan wrapping the push nonce, ending no later than it), 팀 계정 (the dry run's plan,
// then after-idle), confirm answers (a numbered list; 두기 at once; 하기 a plan wrapping the step nonce, a re-asked
// confirm answered with a re-plan), `team_integrate{tip}` (an owner is refused; the main's plan is bound to the tip's
// SHA, a moved tip starts nothing, the op keeps every integrate step, and `mergeLocal: "ask"` leads to an answer plan),
// `team_reorganize` (a proposal with `retire` is a plan, a rename runs by main) and `team_status{detail}`. No answer
// ever holds an inner nonce. A team on a temp git home, a fake own service, a manual clock; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { IntegrateOp } from "../../src/integrate/op.js"
import { Confirm } from "../../src/ops/confirm.js"
import type { Steps } from "../../src/ops/steps.js"
import { Keys } from "../../src/registry/keys.js"
import type { Services } from "../../src/services.js"
import { ControlTool } from "../../src/tools/control.js"
import { IntegrateTool } from "../../src/tools/integrate.js"
import { ReorganizeTool } from "../../src/tools/reorganize.js"
import { StatusTool } from "../../src/tools/status.js"
import { git, write } from "../fixtures/repo.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type Calls, type VoiceTeam, approve, voiceTeam } from "../support/voice.js"

const SLOW = 600_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The push nonce the recorded integrate feature hands out: never in an answer. */
const PUSH_NONCE = "PUSHNONCE0123456789ABCDEFGHJK"

function recorded(calls: Calls): Partial<Services.Factories> {
  return {
    undo: () => ({
      start: async (input) => {
        calls.push({ name: "undo.start", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
    }),
    areaMain: () => ({
      set: async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }),
      preset: async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }),
      account: async (input) => {
        calls.push({ name: "areaMain.account", input })
        if (input.dryRun)
          return {
            ok: true,
            plan: {
              areas: [{ areaID: OwnTeam.AreaID.make("ar_ui"), rotate: true, busy: false }],
              busy: { sessions: 0, children: 0 },
              estimate: null,
              r4: [],
            },
          }
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
    }),
    integrate: (services) => ({
      start: async () => ({ ok: false, error: "unsupported", message: "x", data: { feature: "x" } }),
      retry: async () => {},
      undo: async (input) => {
        calls.push({ name: "integrate.undo", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
      plan: async (input) => {
        calls.push({ name: "integrate.plan", input })
        return {
          ok: true,
          nonce: PUSH_NONCE,
          expiresAt: services.clock.now() + 2 * 60_000,
          remote: "origin",
          ref: "main",
          commands: ["git push origin main"],
        }
      },
      push: async (input) => {
        calls.push({ name: "integrate.push", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
      undoCancel: async (input) => {
        calls.push({ name: "integrate.undoCancel", input })
        const found = await IntegrateOp.get(services, TEAM_ID, input.integrationID)
        if (!found) throw new Error("no integration")
        return { ok: true, integration: found }
      },
      register: () => {},
    }),
  }
}

/** A done integration of `areaID` that moved the target (what 되돌리기 and 올리기 take); `undoing`: its undo waits. */
async function integrated(h: VoiceTeam, areaID: OwnTeam.AreaID, undoing?: OwnTeam.Integration["undoing"]) {
  const record: OwnTeam.Integration = {
    ...(undoing === undefined ? {} : { undoing }),
    id: OwnTeam.IntegrationID.create(),
    teamID: TEAM_ID,
    areaID,
    state: "done",
    target: "main",
    source: h.base,
    candidate: h.base,
    verify: {},
    advanced: { how: "update-ref", at: 1 },
    createdAt: 1,
  }
  await h.services.write(TEAM_ID, () =>
    h.services.kv.set(
      Keys.integration(TEAM_ID, record.id),
      Keys.toJson(Schema.encodeSync(OwnTeam.Integration)(record)),
    ),
  )
  return record
}

/** A step kind that asks (`prepare`) and then does nothing. */
const ASKING: Steps.Kind = {
  kind: "voice-test-ask",
  prepare: async (input) => ({ text: `확인 ${input.step.id}`, bytes: 1024 * 1024, files: [{ path: "a", bytes: 1 }] }),
  observe: async () => ({ state: "pending" }),
  act: async () => ({ ok: true }),
  verify: async () => ({ ok: true }),
}

describe("되돌리기, 올리기, 팀 계정", () => {
  test(
    "undo of an op, of the last op, of an area's integration; push wraps its nonce; account plans the dry run",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      const control = h.tool(ControlTool.NAME)
      expect(await control(MAIN_SESSION, { action: "undo" })).toMatchObject({ ok: false })

      const home: OwnTeam.Op = {
        id: OwnTeam.OpID.create(),
        teamID: TEAM_ID,
        kind: "home",
        by: "user",
        state: "done",
        createdAt: 1,
        undo: { available: true },
        steps: [],
      }
      await h.services.write(TEAM_ID, () => h.services.journal.put(home))
      const last = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "undo" })
      expect(last.plan.text).toContain("메인 폴더 바꾸기")
      expect(last.done).toMatchObject({ ok: true })
      const named = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "undo", op: home.id })
      expect(named.done).toMatchObject({ ok: true })
      expect(await control(MAIN_SESSION, { action: "undo", op: "op_nope" })).toMatchObject({ ok: false })
      expect(await control(MAIN_SESSION, { action: "undo", area: "ui" })).toMatchObject({ ok: false })

      const ig = await integrated(h, ui.id)
      const area = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "undo", area: "ui" })
      expect(area.plan.text).toContain(h.base.slice(0, 8))
      expect(area.done).toMatchObject({ ok: true })

      const push = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "push" })
      expect(push.plan.expiresAt).toBe(h.clock.now() + 2 * 60_000)
      expect(push.plan.text).toContain("git push origin main")
      expect(push.done).toMatchObject({ ok: true })

      const account = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "account", model: "openai/gpt-x" })
      expect(account.plan.text).toContain("새 대화로 이어 가는 영역: ui")
      expect(account.done).toMatchObject({ ok: true })
      expect(await control(MAIN_SESSION, { action: "account", model: "nope" })).toMatchObject({ ok: false })

      expect(h.calls.map((item) => [item.name, item.input])).toEqual([
        ["undo.start", { opID: home.id, by: "user" }],
        ["undo.start", { opID: home.id, by: "user" }],
        ["integrate.undo", { integrationID: ig.id, by: "user" }],
        ["integrate.plan", { integrationID: ig.id }],
        ["integrate.push", { nonce: PUSH_NONCE }],
        ["areaMain.account", { teamID: TEAM_ID, target: { providerID: "openai", id: "gpt-x" }, dryRun: true }],
        ["areaMain.account", { teamID: TEAM_ID, target: { providerID: "openai", id: "gpt-x" }, mode: "after-idle" }],
      ])
      for (const answer of [push.plan, push.done]) expect(JSON.stringify(answer)).not.toContain(PUSH_NONCE)
    },
    SLOW,
  )

  test(
    "a push plan ends with the push nonce: past it the token is expired",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      await integrated(h, ui.id)
      const control = h.tool(ControlTool.NAME)
      h.backend.turn(MAIN_SESSION)
      const plan = await control(MAIN_SESSION, { action: "push", area: "ui", pr: true })
      expect(plan.text).toContain("검토 요청을 올립니다")
      h.backend.reply(MAIN_SESSION)
      h.clock.advance(2 * 60_000)
      expect(await control(MAIN_SESSION, { action: "push", token: plan.token })).toMatchObject({
        ok: false,
        error: "plan_expired",
      })
      expect(h.calls.filter((item) => item.name === "integrate.push")).toEqual([])
    },
    SLOW,
  )
})

describe("되돌리기 취소 (RH-42)", () => {
  test(
    "cancel{area} plans dropping that area's undo that waits; with no op running, cancel finds it too",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      await h.makeArea("api")
      const control = h.tool(ControlTool.NAME)
      const ig = await integrated(h, ui.id, { since: 1, by: "user", why: "in-use", directory: h.home })
      expect(await control(MAIN_SESSION, { action: "cancel", area: "api" })).toMatchObject({ ok: false })
      const named = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "cancel", area: "ui" })
      expect(named.plan.text).toContain("ui의 기다리는 반영 되돌리기를 취소합니다")
      expect(named.done).toMatchObject({ ok: true, text: "ui의 반영 되돌리기를 취소했습니다." })
      const only = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "cancel" })
      expect(only.plan.text).toContain("되돌리기를 취소합니다")
      expect(h.calls.map((item) => [item.name, item.input])).toEqual([
        ["integrate.undoCancel", { integrationID: ig.id }],
        ["integrate.undoCancel", { integrationID: ig.id }],
      ])
    },
    SLOW,
  )
})

describe("confirm answers", () => {
  test(
    "several confirms are listed by number; 두기 runs at once; 하기 is a plan wrapping the step nonce",
    async () => {
      const h = await voiceTeam({ cleanups })
      h.services.steps.register(ASKING)
      const control = h.tool(ControlTool.NAME)
      expect(await control(MAIN_SESSION, { action: "answer", choice: "do" })).toMatchObject({ ok: false })
      const started = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "paths",
        by: "user",
        steps: [
          { id: "one", kind: ASKING.kind, mode: "confirm" },
          { id: "two", kind: ASKING.kind, mode: "confirm" },
        ],
      })
      if (!started.ok) throw new Error("busy")
      const op = await h.settled(started.op.id)
      const nonces = op.steps.map((step) => step.confirm?.nonce ?? "")
      expect(nonces.every((nonce) => nonce.length > 0)).toBe(true)

      const listed = await control(MAIN_SESSION, { action: "answer", choice: "do" })
      expect(listed.ok).toBe(false)
      expect(listed.text).toContain("1. 확인 one (1 MB, 파일 1개)")
      expect(listed.text).toContain("2. 확인 two")
      const status = await h.tool(StatusTool.NAME)(MAIN_SESSION, { detail: true })
      expect(status.text).toContain("1. 확인 one")
      expect(await control(MAIN_SESSION, { action: "answer", choice: "skip", step: 1 })).toMatchObject({ ok: true })
      expect((await h.services.journal.find(op.id))?.steps[0]?.state).toBe("skipped")

      const done = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "answer", choice: "do" })
      expect(done.plan.text).toContain('확인 "확인 two"')
      expect(done.plan.expiresAt).toBeLessThanOrEqual(op.steps[1]!.confirm!.expiresAt)
      expect(done.done).toMatchObject({ ok: true })
      expect((await h.services.journal.find(op.id))?.state).toBe("done")
      for (const answer of [listed, status, done.plan, done.done])
        for (const nonce of nonces) expect(JSON.stringify(answer)).not.toContain(nonce)
    },
    SLOW,
  )

  test(
    "a confirm asked again with a new nonce before the answer: the plan answers with a re-plan",
    async () => {
      const h = await voiceTeam({ cleanups })
      h.services.steps.register(ASKING)
      const started = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "paths",
        by: "user",
        steps: [{ id: "one", kind: ASKING.kind, mode: "confirm" }],
      })
      if (!started.ok) throw new Error("busy")
      const op = await h.settled(started.op.id)
      const control = h.tool(ControlTool.NAME)
      h.backend.turn(MAIN_SESSION)
      const plan = await control(MAIN_SESSION, { action: "answer", choice: "do" })
      // The step is asked again meanwhile (its list changed): the wrapped nonce is no longer the step's.
      await h.services.write(TEAM_ID, () =>
        h.services.journal.put({
          ...op,
          steps: op.steps.map((step) => ({
            ...step,
            confirm: Confirm.issue({ text: "다시" }, h.clock.now()),
          })),
        }),
      )
      h.backend.reply(MAIN_SESSION)
      const answered = await control(MAIN_SESSION, { action: "answer", choice: "do", token: plan.token })
      expect(answered).toMatchObject({ ok: false, error: "nonce_invalid" })
      expect(answered.text).toContain("다시 계획하세요")
    },
    SLOW,
  )
})

describe("team_integrate{tip}", () => {
  test(
    "an owner is refused; the main's plan binds the tip, a moved tip starts nothing, and the op keeps every step",
    async () => {
      const h = await voiceTeam({ cleanups, policy: { mergeLocal: "ask" } })
      const ui = await h.makeArea("ui")
      const integrate = h.tool(IntegrateTool.NAME)
      expect(await integrate(ui.owner.sessionID!, { area: "ui", tip: true })).toEqual({
        ok: false,
        text: IntegrateTool.TIP_MAIN_ONLY,
      })
      write(ui.directory, { "src/ui.ts": "export const ui = 1\n" })
      git(ui.directory, ["add", "-A"])
      git(ui.directory, ["commit", "-q", "-m", "화면 고침"])

      // Shown, then the area moves on: the approved plan starts nothing and says to plan again.
      h.backend.turn(MAIN_SESSION)
      const moved = await integrate(MAIN_SESSION, { area: "ui", tip: true })
      expect(moved).toMatchObject({ ok: true, plan: true })
      expect(moved.text).toContain('"화면 고침"')
      write(ui.directory, { "src/ui.ts": "export const ui = 2\n" })
      git(ui.directory, ["commit", "-q", "-am", "또 고침"])
      h.backend.reply(MAIN_SESSION)
      expect(await integrate(MAIN_SESSION, { area: "ui", token: moved.token })).toMatchObject({
        ok: false,
        error: "conflict",
      })
      expect(await h.services.journal.list(TEAM_ID)).toEqual([])

      const { done } = await approve(h, MAIN_SESSION, IntegrateTool.NAME, { area: "ui", tip: true })
      expect(done).toMatchObject({ ok: true })
      const op = await h.settled(String(done.opID))
      expect(op).toMatchObject({ kind: "integrate", by: "user", state: "waiting" })
      const kinds = op.steps.map((step) => step.kind)
      for (const kind of Object.values(IntegrateOp.KIND)) expect(kinds).toContain(kind)
      expect(await IntegrateOp.get(h.services, TEAM_ID, String(done.integrationID))).toMatchObject({
        source: git(ui.directory, ["rev-parse", "HEAD"]).trim(),
      })

      // mergeLocal ask: the advance waits for a confirm, which the main answers through a plan.
      const answer = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "answer", choice: "do" })
      expect(answer.plan.text).toContain("하기로 답합니다")
      expect(answer.done).toMatchObject({ ok: true })
      const ended = await h.settled(op.id)
      expect(ended.state).toBe("done")
      expect(git(h.home, ["rev-parse", "main"]).trim()).toBe(git(ui.directory, ["rev-parse", "HEAD"]).trim())
    },
    SLOW,
  )

  test(
    "with a candidate the call runs by main without a plan, as without tip",
    async () => {
      const h = await voiceTeam({ cleanups, policy: { mergeLocal: "ask" } })
      const ui = await h.makeArea("ui", { commit: true })
      const sha = git(ui.directory, ["rev-parse", "HEAD"]).trim()
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...ui, candidate: { sha, at: 1, text: "준비" } }),
      )
      const started = await h.tool(IntegrateTool.NAME)(MAIN_SESSION, { area: "ui", tip: true })
      expect(started).toMatchObject({ ok: true })
      expect(started.plan).toBeUndefined()
      expect(await h.settled(String(started.opID))).toMatchObject({ kind: "integrate", by: "main" })
    },
    SLOW,
  )
})

describe("team_reorganize and team_status", () => {
  test(
    "a proposal that ends an area is a plan run by the user; a rename runs by main at once",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("ui")
      const old = await h.makeArea("old", { commit: true, merged: true, owner: false })
      const reorganize = h.tool(ReorganizeTool.NAME)
      const renamed = await reorganize(MAIN_SESSION, {
        proposal: { version: 1, ops: [{ op: "rename", area: "ui", name: "화면" }] },
      })
      expect(renamed).toMatchObject({ ok: true })
      expect((await h.services.journal.list(TEAM_ID)).at(-1)).toMatchObject({ kind: "reorg", by: "main" })
      await h.settled(String(renamed.opID))

      const before = await h.snapshot()
      const proposal = { version: 1, ops: [{ op: "retire", area: "old" }] }
      h.backend.turn(MAIN_SESSION)
      const plan = await reorganize(MAIN_SESSION, { proposal })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(plan.text).toContain("영역 old을(를) 끝냅니다")
      expect(await h.snapshot()).toEqual(before)
      h.backend.reply(MAIN_SESSION)
      const retired = await reorganize(MAIN_SESSION, { proposal, token: plan.token })
      const op = await h.finish(String(retired.opID))
      expect(op).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      expect((await h.areaOf("old"))?.state).toBe("retired")
      expect(old.directory).toBeDefined()
    },
    SLOW,
  )

  test(
    "preview: a new area and a split of a Main 멈춤 area are described, nothing changes, no token (2026-10-16)",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("ui")
      await h.makeArea("api", { paused: "user" })
      const reorganize = h.tool(ReorganizeTool.NAME)
      const before = await h.snapshot()
      const answer = await reorganize(MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [
            { op: "new", slug: "lobby", name: "로비" },
            { op: "split", area: "api", slug: "api-two", name: "둘" },
          ],
        },
        preview: true,
      })
      expect(answer).toMatchObject({ ok: true, preview: true })
      expect(answer.text.startsWith(ReorganizeTool.PREVIEW_HEAD)).toBe(true)
      expect(answer.text).toContain("- 새 영역 '로비'을(를) 만듭니다 · 새 작업 폴더")
      expect(answer.text).toContain("- 지금 하면 건너뜀: 'api'(메인 멈춤)")
      expect(answer.text).toContain(ReorganizeTool.PREVIEW_NEXT)
      expect(answer.text).not.toContain(ReorganizeTool.PREVIEW_RETIRE)
      expect(answer.planned).toEqual([{ item: "ops/0", action: "new", area: "lobby", confirm: false, folder: true }])
      expect(answer.skipped).toEqual([{ item: "ops/1", area: "api", why: "메인 멈춤" }])
      expect("token" in answer).toBe(false)
      expect(await h.snapshot()).toEqual(before)
    },
    SLOW,
  )

  test(
    "preview of a proposal that ends an area plans it as the user's run and says a plan comes first",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("ui", { paused: "user" })
      await h.makeArea("old", { commit: true, merged: true, owner: false })
      const reorganize = h.tool(ReorganizeTool.NAME)
      const before = await h.snapshot()
      const answer = await reorganize(MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [
            { op: "retire", area: "old" },
            { op: "rename", area: "ui", name: "화면" },
          ],
        },
        preview: true,
      })
      expect(answer).toMatchObject({ ok: true, preview: true, skipped: [] })
      expect(answer.text).toContain("- 'old' 영역을 끝냅니다(되돌릴 수 없음)")
      expect(answer.text).toContain("- 'ui' 영역 이름을 '화면'(으)로 바꿉니다")
      expect(answer.text).toContain(ReorganizeTool.PREVIEW_RETIRE)
      expect("token" in answer).toBe(false)
      expect(await h.snapshot()).toEqual(before)
    },
    SLOW,
  )

  test(
    "applied with a Main 멈춤 area: the answer names the skip and tells the main to tell the user; the card line carries the op",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("ui")
      await h.makeArea("api", { paused: "user" })
      const reorganize = h.tool(ReorganizeTool.NAME)
      const split = { op: "split" as const, area: "api", slug: "api-two", name: "둘" }
      const answer = await reorganize(MAIN_SESSION, {
        proposal: { version: 1, ops: [split, { op: "rename", area: "ui", name: "화면" }] },
      })
      expect(answer.text).toContain("건너뜀 1개('api' 메인 멈춤)")
      expect(answer.text).toContain(ReorganizeTool.SKIPPED_NEXT)
      const op = await h.settled(String(answer.opID))
      expect(op.summary?.lines).toContainEqual({
        kind: "skipped",
        item: "ops/0",
        areaID: OwnTeam.AreaID.make("ar_api"),
        why: "paused",
        op: split,
      })
    },
    SLOW,
  )

  test(
    "an area that starts working between the plan and the run: the skip has a Korean reason and no [다시 하기]",
    async () => {
      // Review (2026-10-16): only a skip planned away carries its action on the card; a skip when the item ran does not.
      const h = await voiceTeam({
        cleanups,
        features: () => ({
          // Resting while the plan is made, working once the op runs.
          safePoint: (services) => ({
            check: async (input) =>
              input.areaID === "ar_lab" && (await services.journal.active(TEAM_ID)) !== undefined
                ? { ok: false, why: "session", sessionIDs: [] }
                : { ok: true },
          }),
        }),
      })
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.teams.get(TEAM_ID)
        if (current)
          await h.services.registry.teams.put({
            ...current,
            heavy: { dirs: ["assets"], measuredAt: h.base, forcedBytes: 0 },
          })
      })
      await h.makeArea("lab")
      const answer = await h.tool(ReorganizeTool.NAME)(MAIN_SESSION, {
        proposal: { version: 1, ops: [{ op: "convert", area: "lab", shape: "code" }] },
      })
      expect(answer.text).toContain("건너뜀 1개('lab' 일하는 중)")
      expect(answer.text).toContain(ReorganizeTool.SKIPPED_LATER)
      expect(answer.text).not.toContain("[다시 하기]")
      expect(answer.skipped).toEqual([{ item: "ops/0", area: "lab", why: "일하는 중" }])
      const op = await h.settled(String(answer.opID))
      const line = op.summary?.lines.find((item) => item.kind === "skipped")
      expect(line).toEqual({ kind: "skipped", item: "ops/0", areaID: OwnTeam.AreaID.make("ar_lab"), why: "busy" })
    },
    SLOW,
  )

  test(
    "preview of the user's run names the items that wait for a working area or go on in a Main 멈춤 one",
    async () => {
      // Review (2026-10-16): a proposal with a retire runs by the user, which waits for a working area and holds the
      // team's one op slot meanwhile (TC-D3); the preview says so before the user agrees.
      const h = await voiceTeam({
        cleanups,
        features: () => ({
          safePoint: () => ({
            check: async (input) =>
              input.areaID === "ar_api" ? { ok: false, why: "session", sessionIDs: [] } : { ok: true },
          }),
        }),
      })
      await h.makeArea("api")
      await h.makeArea("ui", { paused: "user" })
      await h.makeArea("old", { commit: true, merged: true, owner: false })
      const before = await h.snapshot()
      const reorganize = h.tool(ReorganizeTool.NAME)
      // One split each: the team's area limit leaves room for one new area.
      const preview = (area: string) =>
        reorganize(MAIN_SESSION, {
          proposal: {
            version: 1,
            ops: [
              { op: "retire", area: "old" },
              { op: "split", area, slug: `${area}-two`, name: "둘" },
            ],
          },
          preview: true,
        })
      const working = await preview("api")
      expect(working).toMatchObject({ ok: true, preview: true, skipped: [] })
      expect(working.text).toContain(ReorganizeTool.PREVIEW_WAITS("api"))
      expect(working.text).toContain(ReorganizeTool.PREVIEW_RETIRE)
      expect(working.text).not.toContain("지금 하면 건너뜀")
      const paused = await preview("ui")
      expect(paused.text).toContain(ReorganizeTool.PREVIEW_PAUSED("ui"))
      expect(paused.text).not.toContain(ReorganizeTool.PREVIEW_WAITS("ui"))
      expect(await h.snapshot()).toEqual(before)
    },
    SLOW,
  )

  test(
    "a user's split of a busy area waits for it and holds the team meanwhile: main requests wait, integrations are busy",
    async () => {
      // 06 §8.1 (TC-D3, review): what choosing a busy item in 팀 구성 다시 보기 or pressing [다시 하기] costs.
      const busy = new Set<string>(["ar_api"])
      const h = await voiceTeam({
        cleanups,
        features: () => ({
          safePoint: () => ({
            check: async (input) =>
              input.areaID !== undefined && busy.has(input.areaID)
                ? { ok: false, why: "session", sessionIDs: [] }
                : { ok: true },
          }),
        }),
      })
      await h.makeArea("ui")
      await h.makeArea("api")
      const started = (await h.rpc("reorg.apply", {
        teamID: TEAM_ID,
        // Two chosen items in two areas, as a review may send: the op names no single area.
        proposal: {
          version: 1,
          ops: [
            { op: "split", area: "api", slug: "api-two", name: "둘" },
            { op: "rename", area: "ui", name: "화면" },
          ],
        },
      })) as { readonly opID: string }
      const waiting = async () => {
        for (let tries = 0; tries < 400; tries++) {
          const op = await h.services.journal.find(started.opID)
          const rename = op?.steps.find((step) => step.kind === "area-rename")
          const begin = op?.steps.find((step) => step.kind === "split-begin")
          if (op && rename?.state === "done" && begin?.state === "pending") return op
          await Bun.sleep(25)
        }
        throw new Error(`the split never waited: ${JSON.stringify(await h.services.journal.find(started.opID))}`)
      }
      const op = await waiting()
      expect(op).toMatchObject({ kind: "reorg", by: "user", state: "running" })
      expect(op.areaID).toBeUndefined()
      // The other area's main request waits as maintaining, and its integration answers busy.
      const sent = await h.tool("dispatch")(MAIN_SESSION, { area: "ui", text: "버그 고치기" })
      expect(sent).toMatchObject({ ok: true, state: "waiting", why: "maintaining" })
      const integrate = await h.rpc("area.integrate", { teamID: TEAM_ID, areaID: "ar_ui" }).then(
        (output) => output,
        (error: unknown) => error,
      )
      expect(integrate).toMatchObject({ type: "busy" })
      // Once the area rests, the split goes on.
      busy.delete("ar_api")
      h.clock.advance(30_000)
      const ended = await h.settled(started.opID)
      expect(ended.state).not.toBe("running")
      expect(ended.steps.find((step) => step.kind === "split-begin")?.state).toBe("done")
    },
    SLOW,
  )

  test(
    "the main's team_status lists the work folders outside the team, with their changes under detail; an owner's does not",
    async () => {
      const h = await voiceTeam({ cleanups })
      const ui = await h.makeArea("ui")
      const feat = path.join(path.dirname(h.home), "feat")
      git(h.home, ["worktree", "add", "-q", "-b", "feat", feat])
      write(feat, { "src/feat.ts": "export const feat = 1\n" })
      git(feat, ["add", "-A"])
      git(feat, ["commit", "-q", "-m", "feat"])
      write(feat, { "src/more.ts": "export const more = 1\n" })
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.teams.get(TEAM_ID)
        if (current) await h.services.registry.teams.put({ ...current, external: [{ directory: feat, why: "left" }] })
      })
      const status = h.tool(StatusTool.NAME)
      const plain = await status(MAIN_SESSION, {})
      expect(plain.text).toContain(
        `팀 밖 작업 폴더 1개(팀에 넣으려면 team_reorganize의 areas[{slug, name, adopt: {worktree}}]): ${feat}`,
      )
      const detail = await status(MAIN_SESSION, { detail: true })
      expect(detail.text).toContain(`- 팀 밖 작업 폴더 ${feat}: 줄기 feat · 변경 1 · 대상에 없는 커밋 1`)
      const owner = await status(ui.owner.sessionID!, { detail: true })
      expect(owner.text).not.toContain("팀 밖 작업 폴더")
      const one = await status(MAIN_SESSION, { area: "ui" })
      expect(one.text).not.toContain("팀 밖 작업 폴더")
    },
    SLOW,
  )

  test(
    "detail: the main sees ops, the last integration with its log end and the accounts; an owner only its area",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      await h.makeArea("api")
      await integrated(h, ui.id)
      const status = h.tool(StatusTool.NAME)
      const main = await status(MAIN_SESSION, { area: "ui", detail: true })
      expect(main.text).toContain("자세히:")
      expect(main.text).toContain("- 지금 도는 작업: 없음")
      expect(main.text).toContain("ui의 마지막 반영: 반영됨")
      expect(main.text).toContain("- 계정: ChatGPT(openai, subscription)")
      expect(main.text).toContain("- 팀이 쓰는 모델: openai/gpt-test")
      const owner = await status(ui.owner.sessionID!, { detail: true })
      expect(owner.text).toContain("ui의 마지막 반영")
      expect(owner.text).not.toContain("- 계정:")
      const plain = await status(MAIN_SESSION, {})
      expect(plain.text).not.toContain("자세히:")
    },
    SLOW,
  )
})

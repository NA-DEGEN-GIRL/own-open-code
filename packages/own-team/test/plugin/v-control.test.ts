// `team_control` part 1 (06 §2.9): team main only; 모두 멈추기 and 메인 새 대화 at once (by main); 다시 시작, 팀에서 빼기,
// 팀 모드 끄기 (with 끝난 영역 정리: only the areas the plan named), 메인 폴더, 대화 옮기기 and 팀 설정 as plans that
// change nothing (team record, areas, journal, policy) until the user's next message and then run by the user; a
// device's answer never approves a `local` action such as the team settings. A team on a temp git home, a fake own
// service, recorded features where the real one would need more than this test; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { Areas } from "../../src/registry/area.js"
import type { Services } from "../../src/services.js"
import { ControlTool } from "../../src/tools/control.js"
import { MainTools } from "../../src/tools/main.js"
import { VoicePlan } from "../../src/tools/voice.js"
import { git } from "../fixtures/repo.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type Calls, approve, voiceTeam } from "../support/voice.js"

const SLOW = 600_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function recorded(calls: Calls): Partial<Services.Factories> {
  return {
    pause: (services) => ({
      area: async (input) => {
        calls.push({ name: "pause.area", input })
        return { ok: true, area: Areas.view((await services.registry.areas.get(input.teamID, input.areaID))!) }
      },
      team: async (input) => {
        calls.push({ name: "pause.team", input })
        return { ok: true, team: (await services.registry.teams.get(input.teamID))! }
      },
      stopped: async () => {},
    }),
    rotate: () => ({
      request: async () => ({ ok: true, opID: OwnTeam.OpID.create() }),
      main: async (input) => {
        calls.push({ name: "rotate.main", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
    }),
    adopt: () => ({
      adopt: async () => ({ ok: true, opID: OwnTeam.OpID.create() }),
      unadopt: async (input) => {
        calls.push({ name: "adopt.unadopt", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
    }),
  }
}

async function setup() {
  const h = await voiceTeam({ cleanups, features: recorded })
  return { ...h, control: h.tool(ControlTool.NAME) }
}

describe("who may call team_control", () => {
  test(
    "an owner and a child are refused with a sentence",
    async () => {
      const h = await setup()
      const ui = await h.makeArea("ui")
      expect(await h.control(ui.owner.sessionID!, { action: "pause_all" })).toEqual({
        ok: false,
        text: MainTools.MAIN_ONLY,
      })
      expect(await h.control("ses_child000000000000000000001", { action: "pause_all" })).toEqual({
        ok: false,
        text: MainTools.NOT_TEAM,
      })
      expect(h.calls).toEqual([])
    },
    SLOW,
  )
})

describe("direct actions", () => {
  test(
    "모두 멈추기 and 메인 새 대화 run at once by main",
    async () => {
      const h = await setup()
      expect(await h.control(MAIN_SESSION, { action: "pause_all" })).toMatchObject({ ok: true })
      const rotated = await h.control(MAIN_SESSION, { action: "main_rotate" })
      expect(rotated).toMatchObject({ ok: true })
      expect(String(rotated.opID)).toMatch(/^op_/)
      expect(h.calls).toEqual([
        { name: "pause.team", input: { teamID: TEAM_ID, on: true } },
        { name: "rotate.main", input: { teamID: TEAM_ID, by: "main" } },
      ])
    },
    SLOW,
  )
})

describe("plans", () => {
  test(
    "다시 시작 and 팀에서 빼기: refused where there is nothing to do; plans change nothing until the user answers",
    async () => {
      const h = await setup()
      const ui = await h.makeArea("ui", { paused: "all" })
      const made = await h.makeArea("made")
      const adopted = await h.makeArea("adopted", { origin: "adopted" })
      expect(await h.control(MAIN_SESSION, { action: "unadopt", area: made.id })).toMatchObject({ ok: false })

      h.backend.turn(MAIN_SESSION)
      const before = await h.snapshot()
      const resume = await h.control(MAIN_SESSION, { action: "resume_all" })
      expect(resume).toMatchObject({ ok: true, plan: true })
      expect(resume.text).toContain(ui.name)
      expect(await h.control(MAIN_SESSION, { action: "resume_all", token: resume.token })).toMatchObject({
        error: "needs_user",
      })
      expect(await h.snapshot()).toEqual(before)
      h.backend.reply(MAIN_SESSION)
      expect(await h.control(MAIN_SESSION, { action: "resume_all", token: resume.token })).toMatchObject({ ok: true })
      expect(h.calls).toEqual([{ name: "pause.team", input: { teamID: TEAM_ID, on: false } }])

      const unadopt = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "unadopt", area: "adopted" })
      expect(unadopt.plan.text).toContain("팀에서 뺍니다")
      expect(unadopt.done).toMatchObject({ ok: true })
      expect(h.calls.at(-1)).toEqual({ name: "adopt.unadopt", input: { teamID: TEAM_ID, areaID: adopted.id } })

      // With nothing paused by 모두 멈추기 there is nothing to resume.
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...ui, paused: false }))
      expect(await h.control(MAIN_SESSION, { action: "resume_all" })).toMatchObject({ ok: false })
    },
    SLOW,
  )

  test(
    "팀 모드 끄기: the plan changes nothing; before the user's answer it is refused; after it the disable op runs by user",
    async () => {
      const h = await setup()
      await h.makeArea("ui")
      h.backend.turn(MAIN_SESSION)
      const before = await h.snapshot()
      const plan = await h.control(MAIN_SESSION, { action: "disable" })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(plan.text).toContain("팀 모드를 끕니다")
      expect(plan.text).toContain(VoicePlan.ASK)
      expect(await h.control(MAIN_SESSION, { action: "disable", token: plan.token })).toMatchObject({
        ok: false,
        error: "needs_user",
      })
      expect(await h.snapshot()).toEqual(before)

      // A phone's answer (read, prompt, switch) cannot approve an admin action; the plan is gone.
      h.backend.reply(MAIN_SESSION, { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read", "switch"] } })
      expect(await h.control(MAIN_SESSION, { action: "disable", token: plan.token })).toMatchObject({
        ok: false,
        error: "needs_pc",
      })
      expect(await h.snapshot()).toEqual(before)

      const { done } = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "disable" })
      expect(done).toMatchObject({ ok: true })
      const op = await h.settled(String(done.opID))
      expect(op).toMatchObject({ kind: "disable", by: "user" })
      expect((await h.services.registry.teams.get(TEAM_ID))?.state).toBe("off")
    },
    SLOW,
  )

  test(
    "팀 모드 끄기 with 끝난 영역 정리: only the areas the plan named are retired, not one that finished afterwards",
    async () => {
      const h = await setup()
      const done = await h.makeArea("done", { commit: true, merged: true })
      const shipped = await h.makeArea("shipped", { commit: true, merged: true, owner: false })
      const late = await h.makeArea("late", { commit: true })
      h.backend.turn(MAIN_SESSION)
      const plan = await h.control(MAIN_SESSION, { action: "disable", cleanup: true })
      expect(plan.text).toContain(`${done.name}, ${shipped.name}`)
      expect(plan.text).not.toContain(late.name)
      // `late` finishes after the plan was shown.
      git(h.home, ["merge", "-q", "--no-ff", "--no-edit", "late"])
      h.backend.reply(MAIN_SESSION)
      const started = await h.control(MAIN_SESSION, { action: "disable", cleanup: true, token: plan.token })
      expect(started).toMatchObject({ ok: true })
      const waiting = await h.finish(String(started.opID), "none")
      expect(waiting.steps[0]).toMatchObject({ kind: "disable.cleanup", args: { areaIDs: [done.id, shipped.id] } })
      expect((await h.finish(String(started.opID))).state).toBe("done")
      expect((await h.areaOf("done"))?.state).toBe("retired")
      expect((await h.areaOf("late"))?.state).toBe("active")
      expect(fs.existsSync(late.directory)).toBe(true)
    },
    SLOW,
  )

  test(
    "메인 폴더 and 대화 옮기기: plans that run by the user; a conversation is found by title or id, several are listed",
    async () => {
      const h = await setup()
      const docs = await h.makeArea("docs")
      const memo = SessionID.create()
      h.backend.add(memo, h.home, "회의 메모")
      h.backend.add(SessionID.create(), h.home, "메모 둘")
      const ambiguous = await h.control(MAIN_SESSION, { action: "move", session: "메모", area: "docs" })
      expect(ambiguous.ok).toBe(false)
      expect(ambiguous.text).toContain("여럿")
      expect(await h.snapshot()).toMatchObject({ ops: [] })

      const moved = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "move", session: "회의", area: "docs" })
      expect(moved.plan.text).toContain(memo)
      expect(moved.done).toMatchObject({ ok: true })
      const op = await h.finish(String(moved.done.opID))
      expect(op).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      expect(h.backend.moves).toEqual([{ sessionID: memo, directory: docs.directory }])

      // 메인 폴더: a linked worktree of the same repository outside the team's folders.
      const other = path.join(path.dirname(h.home), "home-2")
      git(h.home, ["worktree", "add", "-q", "-b", "home-2", other])
      const home = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "home", directory: other })
      expect(home.plan.text).toContain("되돌리기로 되돌릴 수 있습니다")
      expect(home.done).toMatchObject({ ok: true })
      expect(await h.settled(String(home.done.opID))).toMatchObject({ kind: "home", by: "user" })
    },
    SLOW,
  )

  test(
    "팀 설정: old → new per key; a patch that does not decode or changes nothing is refused; only the PC answers it",
    async () => {
      const h = await setup()
      expect(
        await h.control(MAIN_SESSION, { action: "settings", settings: { policy: { askDiskBytes: -1 } } }),
      ).toMatchObject({ ok: false, text: expect.stringContaining("설정을 읽지 못했습니다") })
      const none =
        "바뀌는 설정이 없습니다. 쓸 수 있는 키: askDownloadBytes, askDiskBytes, mergeLocal(auto|ask), commitDecisions, autoAllow, directHold(true|false), directTell(none|judge|always)."
      expect(
        await h.control(MAIN_SESSION, { action: "settings", settings: { policy: { askDiskBytes: OwnTeam.POLICY.askDiskBytes } } }),
      ).toMatchObject({ ok: false, text: none })
      // An older client's area limit is no key any more (no area limit, 2026-11-14): it changes nothing.
      expect(await h.control(MAIN_SESSION, { action: "settings", settings: { policy: { maxAreas: 99 } } })).toEqual({
        ok: false,
        text: none,
      })
      // Before = what own reads: the fixture stores directHold off; directTell is absent, read as judge.
      expect(
        await h.control(MAIN_SESSION, { action: "settings", settings: { policy: { directHold: false, directTell: "judge" } } }),
      ).toEqual({ ok: false, text: none })
      // 팀 지시문 is edited on its own screen only.
      expect(
        await h.control(MAIN_SESSION, { action: "settings", settings: { instructions: { main: "보고는 영어로" } } }),
      ).toEqual({ ok: false, text: "지시문은 설정의 '팀 지시문' 화면에서만 고칩니다." })
      const device = await approve(
        h,
        MAIN_SESSION,
        ControlTool.NAME,
        { action: "settings", settings: { policy: { mergeLocal: "ask" } } },
        { [OwnRemote.DEVICE_META]: { scopes: ["admin", "prompt", "read", "switch"] } },
      )
      expect(device.done).toEqual({ ok: false, error: "needs_pc", text: VoicePlan.needsPc("local") })
      expect((await h.services.registry.teams.get(TEAM_ID))?.policy.mergeLocal).toBe("auto")

      const pc = await approve(h, MAIN_SESSION, ControlTool.NAME, {
        action: "settings",
        settings: { policy: { mergeLocal: "ask", askDiskBytes: 1 } },
      })
      expect(pc.plan.text).toContain("mergeLocal: auto → ask")
      expect(pc.plan.text).toContain(`askDiskBytes: ${OwnTeam.POLICY.askDiskBytes} → 1`)
      const direct = await h.control(MAIN_SESSION, {
        action: "settings",
        settings: { policy: { directHold: true, directTell: "always" } },
      })
      expect(direct.text).toContain("directHold: false → true")
      expect(direct.text).toContain("directTell: judge → always")
      expect(pc.done).toMatchObject({ ok: true })
      expect((await h.services.registry.teams.get(TEAM_ID))?.policy).toMatchObject({ mergeLocal: "ask", askDiskBytes: 1 })
    },
    SLOW,
  )
})

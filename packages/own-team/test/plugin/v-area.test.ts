// `team_area` (06 §2.9): who may call it (the main on any area; an owner on its own area, without paths and cancel; a
// peer, a child and a previous owner are refused with a sentence); the direct actions and who they run as (pause;
// rotate by main, or by auto for an owner; paths by main; cancel of a waiting request or of every one of the area with
// the main requests still in the owner's queue); the plans (resume, model and preset always, rotate and paths under
// Main 멈춤) change nothing until the user's next message and then run by the user; a model string that is no
// `provider/model` is refused without throwing, a preset is found by name. A team on a temp git home, a fake own
// service, recorded features; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { Areas } from "../../src/registry/area.js"
import type { Services } from "../../src/services.js"
import { AreaTool } from "../../src/tools/area.js"
import { MainTools } from "../../src/tools/main.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { VoicePlan } from "../../src/tools/voice.js"
import { MAIN_SESSION, MODEL, TEAM_ID } from "../support/context.js"
import { type Calls, STAR, approve, voiceTeam } from "../support/voice.js"

const SLOW = 240_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const REVIEW = Preset.ID.create()
const ACTIVE = Preset.ID.create()
const OTHER = Preset.ID.create()

/** Pause, rotation, area main and the outbox record what the tool asked for. */
function recorded(calls: Calls): Partial<Services.Factories> {
  return {
    pause: (services) => ({
      area: async (input) => {
        calls.push({ name: "pause.area", input })
        const area = await services.registry.areas.get(input.teamID, input.areaID)
        return { ok: true, area: Areas.view(area!) }
      },
      team: async (input) => {
        calls.push({ name: "pause.team", input })
        return { ok: true, team: (await services.registry.teams.get(input.teamID))! }
      },
      stopped: async () => {},
    }),
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
    areaMain: (services) => ({
      set: async (input) => {
        calls.push({ name: "areaMain.set", input })
        return { ok: true, area: Areas.view((await services.registry.areas.get(input.teamID, input.areaID))!) }
      },
      preset: async (input) => {
        calls.push({ name: "areaMain.preset", input })
        return { ok: true, area: Areas.view((await services.registry.areas.get(input.teamID, input.areaID))!) }
      },
      account: async (input) => {
        calls.push({ name: "areaMain.account", input })
        return { ok: true, opID: OwnTeam.OpID.create() }
      },
    }),
    admit: () => ({
      dispatch: async () => ({ ok: true, dispatchID: OwnTeam.DispatchID.create(), state: "queued" }),
      message: async () => ({ ok: true, guard: "limit" }),
      drain: async () => {},
      list: async () => ({ ok: true, items: [] }),
      cancel: async (input) => {
        calls.push({ name: "admit.cancel", input })
        return { ok: true }
      },
      cancelAll: async (input) => {
        calls.push({ name: "admit.cancelAll", input })
        return [{ areaID: input.areaID!, dispatchID: OwnTeam.DispatchID.create() }]
      },
    }),
  }
}

async function setup() {
  const h = await voiceTeam({ cleanups, features: recorded })
  const ui = await h.makeArea("ui")
  const api = await h.makeArea("api")
  h.world.accounts.set("presets.list", () => ({
    groups: [
      {
        group: "codex",
        defaultModel: null,
        star: STAR,
        presets: [
          preset(STAR, "평소대로", "model"),
          preset(REVIEW, "Review", "model"),
          preset(ACTIVE, "적극", "active"),
          preset(OTHER, "review", "model"),
        ],
      },
    ],
  }))
  h.world.accounts.set("switch.estimate", (input) => {
    const target = (input as { readonly target: { readonly id: string } }).target
    if (target.id === "gone") throw { type: "no_eligible_target", message: "no such model" }
    return { options: [{ strategy: "now", available: true, display: "primary", delta: { lo: 0.1, hi: 0.3, unit: "USD" } }] }
  })
  const area = h.tool(AreaTool.NAME)
  return { ...h, ui, api, area, owner: ui.owner.sessionID! }
}

function preset(id: Preset.ID, name: string, delegation: Preset.Delegation) {
  return {
    ...Preset.builtin("codex"),
    id,
    name,
    delegation,
    status: "ok",
  }
}

describe("who may call team_area", () => {
  test(
    "the main on any area; an owner on its own area only, without paths and cancel; a peer, a child and an old owner never",
    async () => {
      const h = await setup()
      const peer = SessionID.make("ses_peer00000000000000000000001")
      await h.services.write(TEAM_ID, async () =>
        h.services.registry.areas.put({
          ...h.ui,
          owner: { ...h.ui.owner, previous: [{ sessionID: SessionID.make("ses_old000000000000000000000001"), endedAt: 0, why: "user" }] },
          peers: [{ key: "peer", sessionID: peer, label: "리뷰어", role: "", attached: true, origin: "registered", at: 1 }],
        }),
      )
      expect(await h.area(MAIN_SESSION, { action: "pause", area: "api" })).toMatchObject({ ok: true })
      expect(await h.area(h.owner, { action: "pause", area: "api" })).toEqual({
        ok: false,
        text: AreaTool.OWN_AREA_ONLY,
      })
      expect(await h.area(h.owner, { action: "paths", area: "ui", dirs: ["assets"] })).toEqual({
        ok: false,
        text: AreaTool.OWNER_PATHS,
      })
      expect(await h.area(h.owner, { action: "cancel", area: "ui" })).toEqual({ ok: false, text: AreaTool.OWNER_CANCEL })
      expect(await h.area(peer, { action: "pause", area: "ui" })).toEqual({ ok: false, text: AreaTool.PEER })
      expect(await h.area("ses_child000000000000000000001", { action: "pause", area: "ui" })).toEqual({
        ok: false,
        text: MainTools.NOT_TEAM,
      })
      expect(await h.area("ses_old000000000000000000000001", { action: "pause", area: "ui" })).toEqual({
        ok: false,
        text: OwnerTools.PREVIOUS_OWNER,
      })
      expect(await h.area(MAIN_SESSION, { action: "pause", area: "nope" })).toEqual({
        ok: false,
        text: MainTools.NO_AREA,
      })
      expect(h.calls.filter((item) => item.name === "pause.area")).toEqual([
        { name: "pause.area", input: { teamID: TEAM_ID, areaID: h.api.id, on: true } },
      ])
    },
    SLOW,
  )
})

describe("direct actions", () => {
  test(
    "pause, rotate (by main, or auto for an owner), cancel; nothing waits for the user",
    async () => {
      const h = await setup()
      expect(await h.area(h.owner, { action: "pause", area: "ui" })).toMatchObject({ ok: true })
      expect(await h.area(MAIN_SESSION, { action: "rotate", area: "api" })).toMatchObject({ ok: true })
      expect(await h.area(h.owner, { action: "rotate", area: "ui" })).toMatchObject({ ok: true })
      const rotations = h.calls.filter((item) => item.name === "rotate.request").map((item) => item.input)
      expect(rotations).toEqual([
        { teamID: TEAM_ID, areaID: h.api.id, reason: "fresh", handoff: "warm", by: "main" },
        { teamID: TEAM_ID, areaID: h.ui.id, reason: "fresh", handoff: "warm", by: "auto" },
      ])

      // One waiting request by its id; or every one of the area and the main requests still in the owner's queue.
      const dispatchID = OwnTeam.DispatchID.create()
      expect(await h.area(MAIN_SESSION, { action: "cancel", area: "ui", request: dispatchID })).toMatchObject({ ok: true })
      expect(await h.area(MAIN_SESSION, { action: "cancel", area: "ui", request: "not-an-id" })).toMatchObject({
        ok: false,
      })
      h.backend.queue(h.owner, "메인 요청", { [OwnTeam.DISPATCH_META]: { id: "dp_x" } })
      h.backend.queue(h.owner, "사용자가 쓴 글")
      const all = await h.area(MAIN_SESSION, { action: "cancel", area: "ui" })
      expect(all).toMatchObject({ ok: true, cancelled: 1, queued: 1 })
      expect(h.backend.conversations.get(h.owner)?.inbox.map((item) => item.payload.text)).toEqual(["사용자가 쓴 글"])
      expect(h.calls.filter((item) => item.name.startsWith("admit.")).map((item) => [item.name, item.input])).toEqual([
        ["admit.cancel", { teamID: TEAM_ID, areaID: h.ui.id, dispatchID }],
        ["admit.cancelAll", { teamID: TEAM_ID, areaID: h.ui.id }],
      ])
    },
    SLOW,
  )

  test(
    "paths by the main starts the paths op by main; under Main 멈춤 it is a plan run by the user",
    async () => {
      const h = await setup()
      const started = await h.area(MAIN_SESSION, { action: "paths", area: "ui", dirs: ["assets"], reason: "텍스처" })
      expect(started).toMatchObject({ ok: true })
      const first = await h.settled(String(started.opID))
      expect(first).toMatchObject({ kind: "paths", by: "main", areaID: h.ui.id })

      await h.services.write(TEAM_ID, async () =>
        h.services.registry.areas.put({ ...(await h.areaOf("api"))!, paused: "user" }),
      )
      const before = await h.snapshot()
      const { plan, done } = await approve(h, MAIN_SESSION, AreaTool.NAME, {
        action: "paths",
        area: "api",
        dirs: ["assets"],
      })
      expect(plan.text).toContain("메인 멈춤 중")
      expect(done).toMatchObject({ ok: true })
      const second = await h.settled(String(done.opID))
      expect(second).toMatchObject({ kind: "paths", by: "user", areaID: h.api.id })
      expect(before.ops.map((op) => op.id)).toEqual([first.id])
    },
    SLOW,
  )
})

describe("plans", () => {
  test(
    "resume, and rotate under Main 멈춤: nothing changes until the user's next message, then they run by the user",
    async () => {
      const h = await setup()
      await h.services.write(TEAM_ID, async () => h.services.registry.areas.put({ ...h.ui, paused: "user" }))
      expect(await h.area(MAIN_SESSION, { action: "resume", area: "api" })).toMatchObject({ ok: false })

      h.backend.turn(MAIN_SESSION)
      const before = await h.snapshot()
      const resume = await h.area(MAIN_SESSION, { action: "resume", area: "ui" })
      expect(resume).toMatchObject({ ok: true, plan: true })
      expect(resume.text).toContain("메인 멈춤을 끕니다")
      // Called again in the same turn: refused, and still nothing changed.
      expect(await h.area(MAIN_SESSION, { action: "resume", area: "ui", token: resume.token })).toMatchObject({
        ok: false,
        error: "needs_user",
      })
      expect(await h.snapshot()).toEqual(before)
      expect(h.calls).toEqual([])
      h.backend.reply(MAIN_SESSION)
      expect(await h.area(MAIN_SESSION, { action: "resume", area: "ui", token: resume.token })).toMatchObject({
        ok: true,
      })
      expect(h.calls).toEqual([{ name: "pause.area", input: { teamID: TEAM_ID, areaID: h.ui.id, on: false } }])

      // The owner's own rotation under Main 멈춤 is a plan too; approved, it is the user's (reason user).
      h.calls.splice(0)
      const rotated = await approve(h, h.owner, AreaTool.NAME, { action: "rotate", area: "ui" })
      expect(rotated.done).toMatchObject({ ok: true })
      expect(h.calls.map((item) => item.input)).toEqual([
        { teamID: TEAM_ID, areaID: h.ui.id, reason: "user", handoff: "warm", by: "user" },
      ])
    },
    SLOW,
  )

  test(
    "model is always a plan with its cost; a malformed or unknown model is refused without throwing; team means null",
    async () => {
      const h = await setup()
      for (const model of ["gpt-5", "openai/", "a#b/c"]) {
        const refused = await h.area(MAIN_SESSION, { action: "model", area: "ui", model })
        expect(refused.ok).toBe(false)
        expect(refused.text).toContain("팀이 쓰는 모델: openai/gpt-test")
      }
      expect(await h.area(MAIN_SESSION, { action: "model", area: "ui", model: "openai/gone" })).toMatchObject({
        ok: false,
      })
      expect(h.calls).toEqual([])

      const { plan, done } = await approve(h, MAIN_SESSION, AreaTool.NAME, {
        action: "model",
        area: "ui",
        model: "openai/gpt-next#high",
        now: true,
      })
      expect(plan.text).toContain("openai/gpt-next#high")
      expect(plan.text).toContain("+0.10~0.30 USD")
      expect(done).toMatchObject({ ok: true })
      expect(h.calls).toEqual([
        {
          name: "areaMain.set",
          input: {
            teamID: TEAM_ID,
            areaID: h.ui.id,
            model: { providerID: "openai", id: "gpt-next", variant: "high" },
            by: "user",
            now: true,
          },
        },
      ])
      // 팀과 같게, asked by the owner for its own area.
      const same = await approve(h, h.owner, AreaTool.NAME, { action: "model", area: "ui", model: "team" })
      expect(same.plan.text).toContain(`팀과 같게(openai/${MODEL.id})`)
      expect(h.calls.at(-1)).toMatchObject({ name: "areaMain.set", input: { model: null, by: "user" } })
    },
    SLOW,
  )

  test(
    "preset is always a plan: found by name, an ambiguous name lists the candidates, a heavy one is said",
    async () => {
      const h = await setup()
      const ambiguous = await h.area(MAIN_SESSION, { action: "preset", area: "ui", preset: "REVIEW" })
      expect(ambiguous.ok).toBe(false)
      expect(ambiguous.text).toContain(REVIEW)
      expect(ambiguous.text).toContain(OTHER)
      expect(await h.area(MAIN_SESSION, { action: "preset", area: "ui", preset: "없는 것" })).toMatchObject({
        ok: false,
      })
      const heavy = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "preset", area: "ui", preset: "적극" })
      expect(heavy.plan.text).toContain("돈이 드는 대상이나 적극적 위임이 있는 프리셋")
      expect(heavy.done).toMatchObject({ ok: true })
      const plain = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "preset", area: "ui", preset: REVIEW })
      expect(plain.plan.text).not.toContain("돈이 드는")
      expect(h.calls.map((item) => item.input)).toEqual([
        { teamID: TEAM_ID, areaID: h.ui.id, presetID: ACTIVE },
        { teamID: TEAM_ID, areaID: h.ui.id, presetID: REVIEW },
      ])
    },
    SLOW,
  )

  test(
    "a phone's answer runs what its button scope allows (prompt, switch) and not more; the plan is then gone",
    async () => {
      const h = await setup()
      const phone = { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read", "switch"] } }
      const preset = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "preset", area: "ui", preset: REVIEW }, phone)
      expect(preset.done).toMatchObject({ ok: true })
      const reader = { [OwnRemote.DEVICE_META]: { scopes: ["read"] } }
      const denied = await approve(h, MAIN_SESSION, AreaTool.NAME, { action: "preset", area: "ui", preset: REVIEW }, reader)
      expect(denied.done).toEqual({ ok: false, error: "needs_pc", text: VoicePlan.needsPc("switch") })
      expect(h.calls.filter((item) => item.name === "areaMain.preset")).toHaveLength(1)
    },
    SLOW,
  )
})

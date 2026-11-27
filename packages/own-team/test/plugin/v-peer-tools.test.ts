// Area peers through the voice tools (동료, 06 §2.9; user decision 2026-10-09): a new peer is made at once, while
// registering an existing conversation, editing and removing a peer are plans that run only after the user's next
// message; a peer's session reaches `team_status` (its area's view) and is refused by `team_integrate`, `team_area`
// and the main's tools with a sentence; a peer carries exactly the owner's allows, so its catalog is the owner's;
// `team_dispatch` never sends `fresh` with `member`. A team on a temp git home, a fake own service, a recorded peers
// feature; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Areas } from "../../src/registry/area.js"
import type { Services } from "../../src/services.js"
import { AreaTool } from "../../src/tools/area.js"
import { ControlTool } from "../../src/tools/control.js"
import { Tools } from "../../src/tools/index.js"
import { IntegrateTool } from "../../src/tools/integrate.js"
import { MainTools } from "../../src/tools/main.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { Permissions } from "../../src/tools/permissions.js"
import { StatusTool } from "../../src/tools/status.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type Calls, approve, voiceTeam } from "../support/voice.js"

const SLOW = 240_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PEER: OwnTeam.Peer = {
  key: "reviewer",
  sessionID: SessionID.make("ses_peer00000000000000000000001"),
  label: "리뷰어",
  role: "변경을 읽는다",
  attached: true,
  origin: "registered",
  at: 1,
}

function recorded(calls: Calls): Partial<Services.Factories> {
  const view = async (services: Services.Context, teamID: string, areaID: string) =>
    Areas.view((await services.registry.areas.get(teamID, areaID))!)
  return {
    peers: (services) => ({
      add: async (input) => {
        calls.push({ name: "peers.add", input })
        return { ok: true, area: await view(services, input.teamID, input.areaID), peer: { ...PEER, key: "new" } }
      },
      edit: async (input) => {
        calls.push({ name: "peers.edit", input })
        return { ok: true, area: await view(services, input.teamID, input.areaID) }
      },
      remove: async (input) => {
        calls.push({ name: "peers.remove", input })
        return { ok: true, area: await view(services, input.teamID, input.areaID) }
      },
      attach: async () => ({ ok: true }),
      detach: async () => ({ ok: true }),
    }),
  }
}

describe("peers by voice", () => {
  test(
    "a new peer at once; registering a conversation, editing and removing are plans run after the user's answer",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui", { peers: [PEER] })
      const memo = SessionID.create()
      h.backend.add(memo, ui.directory, "시뮬레이션 대화")
      const control = h.tool(ControlTool.NAME)

      expect(await control(MAIN_SESSION, { action: "peer_add", area: "ui", label: "시뮬", role: "돌려 본다" })).toMatchObject(
        { ok: true, peer: "new" },
      )
      const registered = await approve(h, MAIN_SESSION, ControlTool.NAME, {
        action: "peer_add",
        area: "ui",
        session: "시뮬레이션",
        label: "시뮬 둘",
      })
      expect(registered.plan.text).toContain(memo)
      expect(registered.done).toMatchObject({ ok: true })
      const edited = await approve(h, MAIN_SESSION, ControlTool.NAME, {
        action: "peer_edit",
        area: "ui",
        peer: "리뷰어",
        role: "보안만 본다",
      })
      expect(edited.plan.text).toContain('역할 "변경을 읽는다" → "보안만 본다"')
      const removed = await approve(h, MAIN_SESSION, ControlTool.NAME, { action: "peer_remove", area: "ui", peer: "reviewer" })
      expect(removed.plan.text).toContain("동료 \"리뷰어\"을(를) 뺍니다")
      const unknown = await control(MAIN_SESSION, { action: "peer_remove", area: "ui", peer: "없음" })
      expect(unknown).toMatchObject({ ok: false })
      expect(unknown.text).toContain("리뷰어(reviewer)")

      expect(h.calls.map((item) => [item.name, item.input])).toEqual([
        ["peers.add", { teamID: TEAM_ID, areaID: ui.id, create: { label: "시뮬", role: "돌려 본다" } }],
        ["peers.add", { teamID: TEAM_ID, areaID: ui.id, sessionID: memo, label: "시뮬 둘", role: "" }],
        ["peers.edit", { teamID: TEAM_ID, areaID: ui.id, key: "reviewer", role: "보안만 본다" }],
        ["peers.remove", { teamID: TEAM_ID, areaID: ui.id, key: "reviewer" }],
      ])
    },
    SLOW,
  )

  test(
    "registering before the user's answer is refused and writes nothing",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      const ui = await h.makeArea("ui")
      const memo = SessionID.create()
      h.backend.add(memo, ui.directory, "메모")
      const control = h.tool(ControlTool.NAME)
      h.backend.turn(MAIN_SESSION)
      const plan = await control(MAIN_SESSION, { action: "peer_add", area: "ui", session: memo, label: "메모" })
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(await control(MAIN_SESSION, { action: "peer_add", token: plan.token })).toMatchObject({
        ok: false,
        error: "needs_user",
      })
      expect(h.calls).toEqual([])
    },
    SLOW,
  )
})

describe("a peer's session and catalog", () => {
  test(
    "team_status answers its area; team_integrate, team_area and the main's tools refuse it with a sentence",
    async () => {
      const h = await voiceTeam({ cleanups, features: recorded })
      await h.makeArea("ui", { peers: [PEER] })
      expect(await h.tool(StatusTool.NAME)(PEER.sessionID, {})).toMatchObject({ ok: true })
      expect(await h.tool(IntegrateTool.NAME)(PEER.sessionID, { area: "ui" })).toEqual({
        ok: false,
        text: OwnerTools.PEER_REFUSED,
      })
      expect(await h.tool(AreaTool.NAME)(PEER.sessionID, { action: "pause", area: "ui" })).toEqual({
        ok: false,
        text: AreaTool.PEER,
      })
      expect(await h.tool(ControlTool.NAME)(PEER.sessionID, { action: "pause_all" })).toEqual({
        ok: false,
        text: MainTools.MAIN_ONLY,
      })
      expect(
        await h.tool("dispatch")(MAIN_SESSION, { area: "ui", text: "일", member: "리뷰어", fresh: true }),
      ).toMatchObject({ ok: false })
    },
    SLOW,
  )

  test("a peer carries the owner's allows: the same tools, team_area among them and team_control not", () => {
    const visible = (rules: ReadonlyArray<Permissions.Rule>) =>
      Tools.DEFINITIONS.filter((definition) =>
        rules.some((rule) => rule.action === Permissions.ACTIONS[definition.who] && rule.effect === "allow"),
      ).map((definition) => definition.name)
    // A created peer's session gets `Permissions.rules("owner")` (`sessions/main.ts` open), a registered one at attach.
    const owner = visible(Permissions.rules("owner"))
    expect(owner.toSorted()).toEqual(["area", "handoff", "integrate", "message", "need_paths", "report", "status"])
    expect(visible(Permissions.rules("main")).toSorted()).toEqual([
      "area",
      "control",
      "decide",
      "dispatch",
      "integrate",
      "reorganize",
      "status",
    ])
  })
})

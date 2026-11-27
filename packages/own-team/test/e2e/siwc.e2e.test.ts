// One ChatGPT login's two accounts in a team on a real server (07 §5.4 R4, 06 §10.1; T1.20, T1.25): ChatGPT 01 (a
// linked codex profile, whose login is its guard fingerprint) and a Sign in with ChatGPT account of the same login
// (registry only, see the harness), ChatGPT 02 of another login. A team of two areas on F1, enabled from ChatGPT 01.
//
// - own.accounts' list carries the same login on both views, which is all own.team and own-web read R4 from.
// - An area main on the same login's siwc account is accepted; ChatGPT 02 stays refused (`same_company_subscription`).
// - The team account from codex 01 to siwc 01 is one subscription: while an owner works on 01 the plan waits for
//   nothing and has no R4 lines, the move tells no `account.waiting`, and the team main ends on the siwc slot (its
//   switch passes own.accounts' check of own.team's running team account operation).
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnTeam, Preset } from "@own/protocol"
import {
  ACCOUNT,
  BOOT_TIMEOUT,
  MODEL,
  active,
  enableTeam,
  opEnd,
  siwcModel,
  sessionRows,
  startTeamFakes,
  startTeamServer,
  until,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"

const STEP_TIMEOUT = 300_000
const SIWC = { slug: "tms1", account: "acc_tms1", model: siwcModel("tms1") } as const
const AREA = { 1: OwnTeam.AreaID.make("ar_area-1"), 2: OwnTeam.AreaID.make("ar_area-2") }

interface Team {
  readonly server: TeamServer
  readonly fakes: TeamFakes
  readonly teamID: OwnTeam.TeamID
  readonly main: string
}

describe("one ChatGPT login in a team: codex 01 and its siwc account are one subscription", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const fakes = startTeamFakes()
    const server = await startTeamServer({ name: "siwc", fakes, siwc: [{ slug: SIWC.slug, of: "01" }] })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = { server, fakes, teamID: team.id, main: team.main.sessionID }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
    await state.team?.fakes.stop()
  }, 120_000)

  test("the account views carry one login for codex 01 and its siwc account, another for ChatGPT 02", async () => {
    const team = required(state.team)
    const listed = await team.server.accounts("accounts.list")
    const views = Array.isArray(listed.accounts) ? (listed.accounts as Array<Record<string, unknown>>) : []
    const login = (id: string) => {
      const identity = views.find((view) => view.id === id)?.identity
      return typeof identity === "object" && identity !== null && "login" in identity ? identity.login : undefined
    }
    expect(login(ACCOUNT["01"])).toBeString()
    expect(login(SIWC.account)).toBe(login(ACCOUNT["01"]))
    expect(login(ACCOUNT["02"])).not.toBe(login(ACCOUNT["01"]))
    expect(JSON.stringify(views)).not.toContain("fingerprint")
  })

  test(
    "an area main on the same login's siwc account is accepted; ChatGPT 02 is not",
    async () => {
      const team = required(state.team)
      const refused = await team.server.rpc(OwnTeam.ID, "area.main", {
        teamID: team.teamID,
        areaID: AREA[1],
        model: MODEL["02"],
      })
      expect(refused).toMatchObject({
        status: 400,
        type: "same_company_subscription",
        data: { accountID: ACCOUNT["02"] },
      })
      const moved = await team.server.team("area.main", { teamID: team.teamID, areaID: AREA[1], model: SIWC.model })
      expect((await opEnd(team.server, required(moved.opID))).state).toBe("done")
      const area = await areaOf(team, AREA[1])
      expect(area.main).toMatchObject({ model: SIWC.model, chosenBy: "user" })
      expect(rowOf(team, required(area.owner.sessionID ?? undefined)).model).toMatchObject(SIWC.model)
      // The team holds one OpenAI subscription: the area's preset in its group, no repair.
      expect(area.preset).toBe(Preset.builtinID("siwc"))
      expect(team.server.events.events.filter((event) => event.type === "rpc.own.team.notice")).not.toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ kind: "preset.repair" }) }),
      )
    },
    STEP_TIMEOUT,
  )

  test(
    "team account codex 01 → siwc 01: no wait for 01's work, no R4 lines, the team main on the siwc slot",
    async () => {
      const team = required(state.team)
      const busy = await areaOf(team, AREA[2])
      const owner = required(busy.owner.sessionID ?? undefined)
      await team.server.server.prompt(owner, "[slow 6000] [report progress 일하는 중]")
      await until(async () => (await active(team.server)).has(owner), "the owner never started")
      const planned = await team.server.team("team.account", { teamID: team.teamID, target: SIWC.model, dryRun: true })
      const plan = "plan" in planned ? planned.plan : undefined
      // Another subscription of the company would make the move wait for the owner's run on 01; this one does not.
      expect(plan?.busy).toEqual({ sessions: 0, children: 0 })
      expect(plan?.r4).toEqual([])
      await until(async () => !(await active(team.server)).has(owner), "the owner never finished", 120_000)

      const started = await team.server.team("team.account", {
        teamID: team.teamID,
        target: SIWC.model,
        mode: "after-idle",
      })
      if (!("opID" in started)) throw new Error("team.account answered a plan")
      const op = await opEnd(team.server, started.opID, { timeoutMs: 200_000 })
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(rowOf(team, team.main).model).toMatchObject({ providerID: SIWC.model.providerID })
      const notices = team.server.events.events.filter((event) => event.type === "rpc.own.team.notice")
      expect(notices.map((event) => event.data.kind)).not.toContain("account.waiting")
      expect(notices.map((event) => event.data.kind)).toContain("account.moved")
    },
    STEP_TIMEOUT,
  )
})

function rowOf(team: Team, sessionID: string) {
  return required(sessionRows(team.server.server.paths.database).find((row) => row.id === sessionID))
}

async function areaOf(team: Team, areaID: OwnTeam.AreaID) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return required(view.areas.find((area) => area.id === areaID))
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

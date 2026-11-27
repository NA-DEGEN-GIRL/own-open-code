// TG9 대화 교체 after a harness switch (RH-15, the 2.0.32-own.7 real-host phase E stall): own.harness records a harness
// switch as a notice in the owner's queue that starts no run (`resume: false`) and goes with the next prompt. A `fresh`
// first request rotates the owner first, so the rotation's safe point (06 §8.4) must not wait for that notice: nothing
// else delivers it, and the request that would waits for the rotation. As in real-host phase E, both owners are pinned
// (area main and harness, full approval) before their first turn, and the main sends both requests with `fresh`.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  BOOT_TIMEOUT,
  MODEL,
  TEAM_PACKAGE,
  dispatches,
  enableTeam,
  mainRequests,
  ops,
  sessionRows,
  startTeamFakes,
  startTeamServer,
  until,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"

const STEP_TIMEOUT = 300_000
/**
 * Area 1 moves to another account now (its owner gets a model switch message, so a handoff turn delivers the notice
 * with the request); area 2 keeps the team's model (an owner without a message: the program writes the handoff and the
 * notice stays in the old conversation).
 */
const PINS = [
  { areaID: OwnTeam.AreaID.make("ar_area-1"), model: MODEL.anthropic, harness: "pi", notices: 0, by: "담당이" },
  { areaID: OwnTeam.AreaID.make("ar_area-2"), model: MODEL["01"], harness: "opencode", notices: 1, by: "이 앱이" },
] as const

describe("TG9 a fresh first request to owners whose harness was switched (RH-15)", () => {
  const state: { server?: TeamServer; fakes?: TeamFakes; teamID?: OwnTeam.TeamID; main?: string } = {}

  beforeAll(async () => {
    state.fakes = startTeamFakes()
    state.server = await startTeamServer({
      name: "rotate-pinned",
      fakes: state.fakes,
      plugins: [{ package: path.join(TEAM_PACKAGE, "..", "own-harness"), options: {} }],
    })
    const viewed = await state.server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(state.server, { hint: "[propose-areas 2]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.teamID = team.id
    state.main = team.main.sessionID
    // The main runs core's harness: own.harness' default (codex) gives gpt-5.6-sol Codex Code Mode only (`exec`, no
    // `execute`), and the scripted main calls the team tools through `execute`. Only the owners' harnesses matter here.
    const pinned = await state.server.rpc(
      OwnHarness.ID,
      "session.set",
      { sessionID: team.main.sessionID, harness: "opencode" },
      required(state.server.project),
    )
    expect(pinned.status).toBe(200)
  }, BOOT_TIMEOUT * 2)

  afterAll(async () => {
    await state.server?.stop()
    await state.fakes?.stop()
  }, 120_000)

  test(
    "both rotations end and the requests go to the new owners; a notice stays where no handoff turn ran",
    async () => {
      const server = required(state.server)
      const teamID = required(state.teamID)
      const old = new Map<OwnTeam.AreaID, string>()
      await until(
        async () =>
          (await Promise.all(PINS.map((pin) => areaOf(server, pin.areaID)))).every((area) => area.owner.sessionID),
        "the new areas have no owner conversations",
        120_000,
      )
      for (const pin of PINS) {
        await server.team("area.main", { teamID, areaID: pin.areaID, model: pin.model, now: true })
        const area = await areaOf(server, pin.areaID)
        const owner = required(area.owner.sessionID ?? undefined)
        old.set(pin.areaID, owner)
        const bound = await server.rpc(
          OwnHarness.ID,
          "session.set",
          { sessionID: owner, harness: pin.harness },
          area.directory,
        )
        expect(bound.status).toBe(200)
        await server.accounts("session.approval.set", { sessionID: owner, mode: "full" }, area.directory)
        // The precondition: a notice in the queue of an owner that never ran, and no run that would take it.
        expect(await notices(server, owner, area.directory)).toHaveLength(1)
      }

      await server.turn(
        required(state.main),
        "[dispatch area-1 +fresh [report ready 하나]] [dispatch area-2 +fresh [report ready 둘]]",
      )
      const database = server.server.paths.database
      await until(
        async () => {
          const items = dispatches(database, teamID)
          return items.length === PINS.length && items.every((item) => item.state === "sent")
        },
        "the fresh requests were not sent",
        STEP_TIMEOUT - 60_000,
      ).catch((error: unknown) => {
        const rotations = ops(database, teamID).filter((op) => op.kind === "rotate")
        const steps = rotations.map((op) => op.steps.map((step) => `${step.kind}:${step.state}`).join(", "))
        throw new Error(`${error instanceof Error ? error.message : String(error)}; rotations: ${steps.join(" | ")}`)
      })

      const rotations = ops(database, teamID).filter((op) => op.kind === "rotate")
      expect(rotations.map((op) => `${op.areaID} ${op.state}`).toSorted()).toEqual(
        PINS.map((pin) => `${pin.areaID} done`).toSorted(),
      )
      const rows = sessionRows(database)
      for (const pin of PINS) {
        const area = await areaOf(server, pin.areaID)
        const next = required(area.owner.sessionID ?? undefined)
        const before = required(old.get(pin.areaID))
        expect(area.owner.previous).toMatchObject([{ sessionID: before, why: "fresh" }])
        // The new owner keeps the old one's harness (2026-10-26) and got the request.
        expect(OwnHarness.bound(required(rows.find((row) => row.id === next)).metadata)).toBe(pin.harness)
        expect(await mainRequests(server, next)).toHaveLength(1)
        expect(await mainRequests(server, before)).toEqual([])
        const handoff = rotations
          .find((op) => op.areaID === pin.areaID)
          ?.steps.find((step) => step.kind === "rotate.handoff")
        expect(handoff?.note).toBe(`${pin.by} 인계 메모를 썼어요`)
        expect(await notices(server, before, area.directory)).toHaveLength(pin.notices)
      }
    },
    STEP_TIMEOUT,
  )
})

async function areaOf(server: TeamServer, areaID: OwnTeam.AreaID) {
  const view = await server.team("team.get", { directory: required(server.project) })
  return required(view.areas.find((area) => area.id === areaID))
}

/** own.harness' harness switch notices (metadata `own.harness.switch`) still waiting in the session's queue. */
async function notices(server: TeamServer, sessionID: string, directory: string) {
  const listed = (await server.server.call("GET", `/api/session/${sessionID}/inbox`, { directory })) as {
    readonly data: ReadonlyArray<{
      readonly type: string
      readonly payload: { readonly metadata?: Readonly<Record<string, { readonly switch?: unknown } | undefined>> }
    }>
  }
  return listed.data.filter(
    (item) => item.type === "synthetic" && item.payload.metadata?.[OwnHarness.META_KEY]?.switch !== undefined,
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

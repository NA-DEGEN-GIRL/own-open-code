// RH-20 (06 §6.2): a rotation passes a safe point where the user's own input waits parked in the old owner's queue (a
// prompt queued during a run the user then stopped: core keeps it parked, nothing will run it). A warm handoff turn
// would make core run that prompt first, in the conversation that is about to be replaced; the rotation hands over by
// the program instead, the prompt stays in the old conversation, and the rotation's notice counts it. On main the
// rotation ran the warm turn and the scripted model saw the parked prompt.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import {
  BOOT_TIMEOUT,
  MODEL,
  active,
  enableTeam,
  interrupt,
  notices,
  opEnd,
  startTeamFakes,
  startTeamServer,
  until,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"

const STEP_TIMEOUT = 300_000
const AREA = OwnTeam.AreaID.make("ar_area-1")
/** What the user typed into the owner while it ran; it must never reach a model after the stop. */
const PARKED = "PARKED-RH20 정렬 마저 해 줘"

describe("RH-20 a rotation passes the user's parked prompt by the program's handoff", () => {
  const state: { server?: TeamServer; fakes?: TeamFakes; teamID?: OwnTeam.TeamID; main?: string } = {}

  beforeAll(async () => {
    state.fakes = startTeamFakes()
    state.server = await startTeamServer({ name: "rotate-parked", fakes: state.fakes })
    const viewed = await state.server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(state.server, { hint: "[propose-areas 1]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.teamID = team.id
    state.main = team.main.sessionID
  }, BOOT_TIMEOUT * 2)

  afterAll(async () => {
    await state.server?.stop()
    await state.fakes?.stop()
  }, 120_000)

  test(
    "the stopped prompt stays parked in the old conversation and never reaches a model",
    async () => {
      const server = required(state.server)
      const fakes = required(state.fakes)
      const teamID = required(state.teamID)
      const area = await until(
        async () => (await areaOf(server, AREA))?.owner.sessionID !== null,
        "the area has no owner conversation",
        120_000,
      ).then(async () => required(await areaOf(server, AREA)))
      const owner = required(area.owner.sessionID ?? undefined)

      // The owner works on a slow main request; the user queues a prompt to it and then presses stop.
      await server.turn(required(state.main), "[dispatch area-1 [slow 60000] 천천히 일하기]")
      await until(async () => (await active(server)).has(owner), "the owner did not start", 120_000)
      await server.server.call("POST", `/api/session/${owner}/prompt`, {
        directory: area.directory,
        body: { text: PARKED, delivery: "queue" },
      })
      await interrupt(server, owner)
      await until(async () => !(await active(server)).has(owner), "the owner did not stop", 120_000)
      expect((await inbox(server, owner, area.directory)).map((item) => item.payload?.text)).toEqual([PARKED])
      // Past 10 s it is parked input, not work (06 §8.4): the safe point passes.
      await Bun.sleep(12_000)
      const seen = requestCount(fakes)

      const rotated = await server.team("area.rotate", { teamID, areaID: AREA })
      const op = await opEnd(server, rotated.opID, { timeoutMs: STEP_TIMEOUT - 60_000 })
      expect(op.state).toBe("done")
      expect(op.steps.find((step) => step.kind === "rotate.handoff")?.note).toBe("이 앱이 인계 메모를 썼어요")
      // The prompt stays with the old conversation (6.2) and never reached a model after the stop.
      expect((await inbox(server, owner, area.directory)).map((item) => item.payload?.text)).toEqual([PARKED])
      expect(bodiesSince(fakes, seen).some((body) => body.includes("PARKED-RH20"))).toBe(false)
      const next = await areaOf(server, AREA)
      expect(next?.owner.previous.at(-1)).toMatchObject({ sessionID: owner, why: "user" })
      expect(notices(server, "rotation.done").at(-1)).toMatchObject({ data: { parked: 1 } })
    },
    STEP_TIMEOUT,
  )
})

async function areaOf(server: TeamServer, areaID: OwnTeam.AreaID) {
  const view = await server.team("team.get", { directory: required(server.project) })
  return view.areas.find((area) => area.id === areaID)
}

async function inbox(server: TeamServer, sessionID: string, directory: string) {
  const listed = (await server.server.call("GET", `/api/session/${sessionID}/inbox`, { directory })) as {
    readonly data: ReadonlyArray<{ readonly payload?: { readonly text?: string } }>
  }
  return listed.data
}

/** Every model request the fakes saw so far. */
function requestCount(fakes: TeamFakes) {
  return {
    codex: fakes.codex.requests.length,
    deepseek: fakes.deepseek.requests.length,
    anthropic: fakes.anthropic.requests.length,
  }
}

/** The bodies of the model requests after `seen`. */
function bodiesSince(fakes: TeamFakes, seen: ReturnType<typeof requestCount>) {
  return [
    ...fakes.codex.requests.slice(seen.codex),
    ...fakes.deepseek.requests.slice(seen.deepseek),
    ...fakes.anthropic.requests.slice(seen.anthropic),
  ].map((request) => String(request.body ?? ""))
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

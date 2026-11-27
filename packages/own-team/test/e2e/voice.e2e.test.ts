// A risky team action told in plain language (06 §2.9, user decision V-D1) on a real server: a team of one area on
// F1; the scripted main plans 팀 모드 끄기 (`team_control{action:"disable"}`) and calls it with the plan's token.
//
// 1. The plan and the token call in the same turn: the token is refused (`needs_user`); the team stays on.
// 2. After that turn, a synthetic message carrying the token call: refused (no user reply).
// 3. A user prompt marked as a machine's (`metadata.source: "own.team"`): refused.
// 4. The first real reply comes from a phone (the gateway's `own.device` stamp with read, prompt, switch): refused
//    (`needs_pc`, the button needs admin) and the plan is gone; the team stays on.
// 5. A new plan in its own turn, then the user's unstamped reply `응 …` with the token call: the disable op runs by the
//    user and the team ends off.
//
// Verdicts come from durable state: the execute tool parts of the main conversation, `team.get` and the op journal.
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { toolParts } from "../../../own-accounts/test/e2e-kit"
import { VoicePlan } from "../../src/tools/voice.js"
import { BOOT_TIMEOUT, MODEL, enableTeam, opEnd, ops, startTeamServer, type TeamServer } from "./harness.js"

const STEP_TIMEOUT = 240_000
const PLAN = '[voice control {"action":"disable"}]'
const CALL = '[voice control {"action":"disable"} +token=last]'

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
}

describe("a risky voice action waits for the user's next message (F1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "voice" })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 1]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = { server, teamID: team.id, main: team.main.sessionID }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "1: the plan and its token in the same turn: refused, the team stays on and no disable op exists",
    async () => {
      const team = required(state.team)
      const before = (await outputs(team)).length
      await team.server.turn(team.main, `${PLAN} ${CALL}`)
      const [plan, call] = (await outputs(team)).slice(before)
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(plan?.text).toContain("팀 모드를 끕니다")
      expect(call).toMatchObject({ ok: false, error: "needs_user", text: VoicePlan.TEXT.needs_user })
      expect(await stateOf(team)).toBe("on")
      expect(disables(team)).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "2: a synthetic message carrying the token call after that turn: refused",
    async () => {
      const team = required(state.team)
      const before = (await outputs(team)).length
      await team.server.server.call("POST", `/api/session/${team.main}/synthetic`, { body: { text: CALL } })
      await team.server.server.waitIdle(team.main)
      expect((await outputs(team)).slice(before)).toEqual([expect.objectContaining({ ok: false, error: "needs_user" })])
      expect(await stateOf(team)).toBe("on")
    },
    STEP_TIMEOUT,
  )

  test(
    "3: a user prompt from a machine source (own.team): refused",
    async () => {
      const team = required(state.team)
      const before = (await outputs(team)).length
      await prompt(team, CALL, { source: OwnTeam.PROMPT_SOURCE })
      expect((await outputs(team)).slice(before)).toEqual([expect.objectContaining({ ok: false, error: "needs_user" })])
      expect(await stateOf(team)).toBe("on")
    },
    STEP_TIMEOUT,
  )

  test(
    "4: the first real reply from a phone (read, prompt, switch): needs_pc, the plan is gone, the team stays on",
    async () => {
      const team = required(state.team)
      const before = (await outputs(team)).length
      await prompt(team, `응 ${CALL}`, { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read", "switch"] } })
      expect((await outputs(team)).slice(before)).toEqual([
        expect.objectContaining({ ok: false, error: "needs_pc", text: VoicePlan.needsPc("admin") }),
      ])
      await team.server.turn(team.main, CALL)
      expect((await outputs(team)).at(-1)).toMatchObject({ ok: false, error: "plan_unknown" })
      expect(await stateOf(team)).toBe("on")
      expect(disables(team)).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "5: a new plan in its own turn, then the user's reply: the disable op runs by the user and the team ends off",
    async () => {
      const team = required(state.team)
      await team.server.turn(team.main, PLAN)
      expect((await outputs(team)).at(-1)).toMatchObject({ ok: true, plan: true })
      expect(disables(team)).toEqual([])
      await team.server.turn(team.main, `응 ${CALL}`)
      const done = (await outputs(team)).at(-1)
      expect(done).toMatchObject({ ok: true })
      const [op] = disables(team)
      expect(op).toMatchObject({ kind: "disable", by: "user" })
      expect((await opEnd(team.server, required(op).id)).state).toBe("done")
      expect(await stateOf(team)).toBe("off")
    },
    STEP_TIMEOUT,
  )
})

/** The team tools' answers in the main conversation, oldest first (the JSON text of each execute call's result). */
async function outputs(team: Team): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  const parts = await toolParts(team.server.server, team.main, "execute")
  return parts.flatMap((part) => {
    const state: Readonly<Record<string, unknown>> = { ...part.state }
    const content = Array.isArray(state.content) ? state.content : []
    return content.flatMap((item: unknown) => {
      const value = isRecord(item) && typeof item.text === "string" ? parse(item.text) : undefined
      return isRecord(value) && "ok" in value ? [value] : []
    })
  })
}

/** `text` as JSON, or `undefined` when it is not JSON. */
function parse(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A user prompt with `metadata`, as a client (or the gateway) sends it; waits until the main is idle again. */
async function prompt(team: Team, text: string, metadata: Readonly<Record<string, unknown>>) {
  await team.server.server.call("POST", `/api/session/${team.main}/prompt`, { body: { text, metadata } })
  await team.server.server.waitIdle(team.main)
}

async function stateOf(team: Team) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return view.team?.state
}

function disables(team: Team) {
  return ops(team.server.server.paths.database, team.teamID).filter((op) => op.kind === "disable")
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

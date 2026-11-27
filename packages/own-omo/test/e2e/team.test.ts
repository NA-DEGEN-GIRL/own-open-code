// own-omo in team mode (15 §3.10, 06): the team main and an area owner on the `omo` harness, on own-team's e2e harness
// (own-accounts and own-team, then own-harness and own-omo with the built omo runtime; every model call goes to the
// fake DeepSeek, answered by own-team's directive responder). Verdicts:
// - Pinning the owner to omo before its first turn parks own.harness' switch notice (`resume: false`) as for any
//   harness, and a `fresh` first request's rotation still ends (RH-15): the program writes the handoff, the notice stays
//   in the old conversation, the new owner keeps omo and gets the request.
// - The owner and the main leave open todos (omo's `todowrite`, `[omo-todo]` below). A second `fresh` request rotates
//   that owner through a warm handoff turn on omo, and its request reaches the next owner, again on omo.
// - omo runs in both (Sisyphus's prompt, with own.team's role text in the same request), but never continues a team
//   session's todos: no TODO CONTINUATION goes, before or after the handoff turn or the team's updates to the main.
//
// Fake credentials only; every listener binds 127.0.0.1. Build the runtime first (`bun script/bundle.ts`). Run from a
// path without '#'.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { responder, turn } from "../../../own-team/test/e2e/directives.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  TEAM_PACKAGE,
  active,
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
} from "../../../own-team/test/e2e/harness.js"

const STEP_TIMEOUT = 300_000
const AREA = OwnTeam.AreaID.make("ar_area-1")
/** Not a directive of the responder: the first model request of that turn calls omo's `todowrite` instead. */
const TODO = "[omo-todo]"
const SISYPHUS = 'Your designated identity for this session is "Sisyphus"'
/** omo's continuation prompt (Sisyphus's prompt names "TODO CONTINUATION" in every omo request). */
const CONTINUATION = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]"
/** omo's countdown is 2 s after an idle; this is well past it. */
const QUIET_MS = 12_000

describe("omo (원본) in team mode (15 §3.10)", () => {
  const state: { server?: TeamServer; fakes?: TeamFakes; teamID?: OwnTeam.TeamID; main?: string; todos: number } = {
    todos: 0,
  }

  beforeAll(async () => {
    state.fakes = startTeamFakes({
      responder: responder({
        before: (request) => {
          const current = turn(request)
          if (!current.user.includes(TODO) || current.done > 0 || !current.tools.includes("todowrite")) return undefined
          state.todos += 1
          return {
            type: "tool-call",
            id: `call_omo_todo_${state.todos}`,
            name: "todowrite",
            input: { todos: [{ content: `omo-team-open-${state.todos}`, status: "pending", priority: "high" }] },
          }
        },
      }),
    })
    state.server = await startTeamServer({
      name: "omo-team",
      fakes: state.fakes,
      plugins: [
        { package: path.join(TEAM_PACKAGE, "..", "own-harness"), options: {} },
        { package: path.join(TEAM_PACKAGE, "..", "own-omo"), options: {} },
      ],
    })
    const viewed = await state.server.createSession({ model: MODEL.deepseek, title: "켠 대화" })
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
    "pinned to omo: both rotations end, the requests reach omo owners, and omo continues no team session",
    async () => {
      const server = required(state.server)
      const teamID = required(state.teamID)
      const main = required(state.main)
      const project = required(server.project)
      const database = server.server.paths.database
      await until(async () => (await areaOf(server)).owner.sessionID !== null, "the area has no owner", 120_000)

      // The main and the owner on omo; the owner's switch notice waits for its first prompt (RH-15).
      expect(
        (await server.rpc(OwnHarness.ID, "session.set", { sessionID: main, harness: "omo" }, project)).status,
      ).toBe(200)
      const area = await areaOf(server)
      const first = required(area.owner.sessionID ?? undefined)
      const bound = await server.rpc(OwnHarness.ID, "session.set", { sessionID: first, harness: "omo" }, area.directory)
      expect(bound.status).toBe(200)
      await server.accounts("session.approval.set", { sessionID: first, mode: "full" }, area.directory)
      expect(await notices(server, first, area.directory)).toHaveLength(1)

      // Round 1: a fresh first request; the main writes a todo first, the new owner too.
      await server.turn(main, `[status] [dispatch area-1 +fresh [status] [report progress 하나] ${TODO}] ${TODO}`)
      await settled(server, teamID, 1)
      const second = required((await areaOf(server)).owner.sessionID ?? undefined)
      expect(second).not.toBe(first)
      const one = rotations(database, teamID)
      expect(one.map((op) => op.state)).toEqual(["done"])
      expect(handoffNote(one[0]!)).toBe("이 앱이 인계 메모를 썼어요")
      expect(await notices(server, first, area.directory)).toHaveLength(1)
      expect(await mainRequests(server, first)).toEqual([])
      expect(await mainRequests(server, second)).toHaveLength(1)
      expect(OwnHarness.bound(required(sessionRows(database).find((row) => row.id === second)).metadata)).toBe("omo")

      // Round 2: the owner that ran (an open todo) writes the handoff in a warm turn on omo.
      await server.turn(main, "[dispatch area-1 +fresh [report done 둘]]")
      await settled(server, teamID, 2)
      const third = required((await areaOf(server)).owner.sessionID ?? undefined)
      expect(third).not.toBe(second)
      const two = rotations(database, teamID)
      expect(two.map((op) => op.state)).toEqual(["done", "done"])
      expect(handoffNote(two[1]!)).toBe("담당이 인계 메모를 썼어요")
      expect(await mainRequests(server, third)).toHaveLength(1)
      expect(OwnHarness.bound(required(sessionRows(database).find((row) => row.id === third)).metadata)).toBe("omo")

      // Both left a todo open, and omo ran in both: Sisyphus with own.team's role text in one request.
      expect(state.todos).toBe(2)
      const systems = state
        .fakes!.deepseek.requests.filter((request) => request.method === "POST")
        .map((request) => turn(request).system)
      expect(systems.some((text) => text.includes(SISYPHUS) && text.includes("# 팀 메인 역할 (own.team)"))).toBe(true)
      expect(systems.some((text) => text.includes(SISYPHUS) && text.includes("# 영역 담당 역할 (own.team)"))).toBe(true)

      // Nothing runs on, and omo never continued a team session's todos.
      await until(async () => (await active(server)).size === 0, "a session still runs", STEP_TIMEOUT)
      await Bun.sleep(QUIET_MS)
      expect((await active(server)).size).toBe(0)
      const continued = state.fakes!.deepseek.requests.filter((request) => request.body.includes(CONTINUATION))
      expect(continued.map((request) => turn(request).user.slice(0, 120))).toEqual([])
    },
    STEP_TIMEOUT * 3,
  )
})

async function areaOf(server: TeamServer) {
  const view = await server.team("team.get", { directory: required(server.project) })
  return required(view.areas.find((area) => area.id === AREA))
}

function rotations(database: string, teamID: OwnTeam.TeamID) {
  return ops(database, teamID).filter((op) => op.kind === "rotate")
}

function handoffNote(op: OwnTeam.Op) {
  return op.steps.find((step) => step.kind === "rotate.handoff")?.note
}

/** The area's requests went (`count` of them), and its owner and the main are idle. */
async function settled(server: TeamServer, teamID: OwnTeam.TeamID, count: number) {
  await until(
    async () => {
      const items = dispatches(server.server.paths.database, teamID).filter((item) => item.areaID === AREA)
      const owner = (await areaOf(server)).owner.sessionID
      return (
        items.filter((item) => item.state === "sent").length >= count &&
        items.every((item) => item.state !== "waiting") &&
        owner !== null &&
        !(await active(server)).has(owner) &&
        (await server.server.messages(owner)).at(0)?.type === "idle"
      )
    },
    `the area did not settle with ${count} requests sent`,
    STEP_TIMEOUT,
  )
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

// 담당 대화 바꾸기 (`area.seat`, 2026-11-12) on a real server: a team of two areas on F1. The user opens a second
// conversation in area-1's folder on another company's model and moves the owner seat onto it, and back, with the
// button's RPC. Verdicts come from the op records, the registry (`team.get`), the dispatch records, the digest and the
// talk state in KV, the session rows, the conversations' messages, instruction entries, preset bindings and the inbox
// events on the event stream.
//
// - A move asked for while the owner works waits for its turn and then swaps: no step is forced. The next main request
//   goes to the chosen conversation, which keeps its own model and preset (the area shows them); the old conversation
//   stays an ordinary one, not archived, and has no team tool any more. The main reads one line in its next team
//   update and is not woken by the move.
// - A conversation on another subscription of the team main's company, one of another folder and the current owner are
//   refused with their reasons.
// - An ask the old seat took and never answered: the asking area gets the notice and no ask stays open. Stopping the
//   seat while the move waits for it does not turn Main 멈춤 on.
// - A `fresh` main request that waits during the move goes to the chosen conversation as a plain one: no rotation.
// - The round trip A→B→A with a request that was sent to A and not taken: it is taken back at each move, sent on, and
//   delivered once after the trip under the inbox id whose first row was cancelled (core admits it again).
//
// A request a seat has not taken needs a seat that is busy with something else when the request arrives: a prompt the
// user queued in that conversation during a run and then stopped stays parked, and core runs it first when the next
// input wakes the conversation. It is parked while the conversation is not the seat (stopping a conversation that is
// neither owner nor peer never turns Main 멈춤 on).
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { instructionEntries, toolParts } from "../../../own-accounts/test/e2e-kit"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Seat } from "../../src/sessions/seat.js"
import { Permissions } from "../../src/tools/permissions.js"
import {
  ACCOUNT,
  BOOT_TIMEOUT,
  MODEL,
  active,
  dispatchOf,
  dispatches,
  enableTeam,
  enqueued,
  interrupt,
  mainRequests,
  messages,
  notices,
  opEnd,
  ops,
  presetOf,
  sessionRows,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const AREA_2 = OwnTeam.AreaID.make("ar_area-2")
const STEPS = Object.values(Seat.KIND)
/** The line the main reads about a move in its next team update (`sessions/seat.ts`). */
const SEATED = "담당이 사용자가 고른 다른 대화로 바뀌었습니다"
const NOTICE = '<dispatch from="team" kind="notice"'

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  /** area-1's first owner conversation (A) and its folder. */
  readonly first: string
  readonly folder: string
  /** area-2's owner: the area that asks. */
  readonly asker: string
}

describe("the area seat moves onto an existing conversation (담당 대화 바꾸기; two areas, F1)", () => {
  const state: { team?: Team; chosen?: string } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "seat" })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    const one = required(enabled.view.areas.find((item) => item.id === AREA_1))
    const two = required(enabled.view.areas.find((item) => item.id === AREA_2))
    state.team = {
      server,
      teamID: team.id,
      main: team.main.sessionID,
      first: required(one.owner.sessionID ?? undefined),
      folder: one.directory,
      asker: required(two.owner.sessionID ?? undefined),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "a move asked for while the owner works waits, then swaps; the chosen conversation keeps its model and preset",
    async () => {
      const team = required(state.team)
      await team.server.turn(team.main, "[dispatch area-1 [report progress 첫 일]]")
      await sentTo(team, "[report progress 첫 일]", team.first)
      await team.server.server.waitIdle(team.first)

      // The user's own conversation in the area's folder, on another company's model, with its own history.
      const chosen = await team.server.createSession({
        directory: team.folder,
        title: "정렬 메모",
        model: MODEL.deepseek,
      })
      state.chosen = chosen
      await team.server.turn(chosen, "정렬 기준을 적어 둡니다")
      const before = {
        row: row(team, chosen),
        bound: await presetOf(team.server, chosen, team.folder),
        updates: await updates(team),
      }
      expect(before.row.permission.filter((rule) => String(rule.action).startsWith("team."))).toEqual([])

      await team.server.server.prompt(team.first, "[slow 8000] [report progress 바꾸기 전 보고]")
      await until(async () => (await active(team.server)).has(team.first), "the owner never started the user's turn")
      const started = await seat(team, chosen)
      // It waits for the owner's turn: nothing is swapped and nothing is stopped.
      const waiting = (await team.server.team("op.get", { opID: started.opID })).op
      expect(waiting).toMatchObject({ kind: "seat", state: "running", areaID: AREA_1, by: "user" })
      expect(waiting.steps.map((step) => step.kind)).toEqual(STEPS)
      expect(waiting.steps[0]?.wait).toMatchObject({ why: "safe-point" })
      expect<unknown>((await areaOf(team, AREA_1)).owner.sessionID).toBe(team.first)
      const op = await opEnd(team.server, started.opID)
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual(STEPS.map((kind) => [kind, "done"]))
      // The owner's turn ran to its end, and its report in the window counted.
      const reported = (await toolParts(team.server.server, team.first, "execute")).find((part) =>
        JSON.stringify(part.state.input).includes("바꾸기 전 보고"),
      )
      expect(JSON.stringify(reported)).toContain("팀 소식에 적었습니다.")

      const area = await areaOf(team, AREA_1)
      expect(area.owner).toMatchObject({
        sessionID: chosen,
        attached: true,
        previous: [{ sessionID: team.first, why: "seat" }],
      })
      expect(area.owner.pending).toBeUndefined()
      expect(area.owner.release).toBeUndefined()
      expect(area.paused).toBe(false)
      expect(notices(team.server, "seat.moved").at(-1)).toMatchObject({
        areaID: AREA_1,
        data: { sessionID: chosen, previous: team.first },
      })

      // The chosen conversation keeps its own model and preset; the area follows it. Nothing archived, no new one.
      const after = row(team, chosen)
      expect(after.model).toEqual(before.row.model)
      expect(after.model).toMatchObject({ providerID: MODEL.deepseek.providerID, id: MODEL.deepseek.id })
      expect(after.metadata["own.archived"]).toBeUndefined()
      const bound = await presetOf(team.server, chosen, team.folder)
      expect(bound.preset?.id).toBe(before.bound.preset?.id)
      expect(bound.binding?.presetID).toBe(before.bound.binding?.presetID)
      expect(area.main).toMatchObject({ model: MODEL.deepseek, chosenBy: "adopted" })
      expect(ops(db(team), team.teamID).filter((item) => item.kind === "rotate")).toEqual([])
      // It holds the owner's allows, the owner role and the program's handoff note.
      expect(after.permission.filter((rule) => String(rule.action).startsWith("team."))).toEqual(
        Permissions.rules("owner").map((rule) => ({ ...rule })),
      )
      const entries = (await instructionEntries(team.server.server, chosen)).map((entry) => entry.key)
      expect(entries).toContain(RoleInstructions.OWNER)
      expect(entries).toContain(RoleInstructions.HANDOFF)

      // The old conversation is an ordinary one again: not archived, no owner things, no team tool to call.
      const old = row(team, team.first)
      expect(old.metadata["own.archived"]).toBeUndefined()
      expect(old.permission.filter((rule) => String(rule.action).startsWith("team."))).toEqual([])
      const left = (await instructionEntries(team.server.server, team.first)).map((entry) => entry.key)
      expect(left).not.toContain(RoleInstructions.OWNER)
      expect((await presetOf(team.server, team.first, team.folder)).binding?.team).toBeUndefined()
      const reports = (await toolParts(team.server.server, team.first, "execute")).length
      await team.server.turn(team.first, "[report progress 옛 담당의 보고]")
      const gone = JSON.stringify((await toolParts(team.server.server, team.first, "execute")).slice(reports))
      expect(gone).toContain("Unknown tool 'team.report'")
      expect(gone).not.toContain("팀 소식에 적었습니다.")

      // The main was not woken by the move; the line waits in the digest for its next update.
      expect(await updates(team)).toBe(before.updates)
      expect(digest(team).entries.filter((entry) => entry.reason === "seated")).toMatchObject([
        { areaID: AREA_1, wake: false },
      ])

      // The next main request goes to the chosen conversation, and its report wakes the main with the line.
      await team.server.turn(team.main, "[dispatch area-1 [report blocked 새 담당이 결정을 기다립니다]]")
      await sentTo(team, "[report blocked 새 담당이 결정을 기다립니다]", chosen)
      const requests = await waitValue(async () => {
        const got = await mainRequests(team.server, chosen)
        return got.length === 0 ? undefined : got
      }, "the chosen conversation got no request")
      expect(requests.map(body)).toEqual(["[report blocked 새 담당이 결정을 기다립니다]"])
      // With it comes the team's one note: this conversation took the seat over, so replies it never asked for may come.
      const held = OwnTeamText.notes(String(requests[0]?.text))
      expect(held).toHaveLength(1)
      expect(held[0]).toStartWith(`${OwnTeamText.TEAM}(`)
      expect(held[0]).toContain(`이 대화가 '${area.name}' 영역의 담당을 다른 대화에서 넘겨받았다.`)
      expect((await mainRequests(team.server, team.first)).map(body)).toEqual(["[report progress 첫 일]"])
      const update = await waitValue(
        async () => (await updateTexts(team)).slice(before.updates).find((text) => text.includes(SEATED)),
        "no team update carried the seat line",
      )
      expect(update).toContain(`'${area.name}' 영역의 ${SEATED}`)
      expect(update).not.toContain("옛 담당의 보고")
      expect(digest(team).entries.filter((entry) => entry.reason === "seated")).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a conversation on another subscription of the main's company, one of another folder and the owner are refused",
    async () => {
      const team = required(state.team)
      const chosen = required(state.chosen)
      const before = await areaOf(team, AREA_1)
      const journal = ops(db(team), team.teamID).length
      const rival = await team.server.createSession({ directory: team.folder, title: "다른 구독", model: MODEL["02"] })
      const other = (await areaOf(team, AREA_2)).directory
      const elsewhere = await team.server.createSession({ directory: other, title: "다른 영역", model: MODEL["01"] })
      const ask = (sessionID: string) =>
        team.server.rpc(OwnTeam.ID, "area.seat", { teamID: team.teamID, areaID: AREA_1, sessionID })
      expect(await ask(rival)).toMatchObject({
        status: 400,
        type: "same_company_subscription",
        data: { accountID: ACCOUNT["02"] },
      })
      expect(await ask(elsewhere)).toMatchObject({
        type: "seat_invalid",
        message: Seat.INVALID.elsewhere,
        data: { why: "elsewhere" },
      })
      expect(await ask(chosen)).toMatchObject({
        type: "seat_invalid",
        message: Seat.INVALID.owner,
        data: { why: "owner" },
      })
      expect(await ask(team.main)).toMatchObject({
        type: "seat_invalid",
        message: Seat.INVALID.main,
        data: { why: "main" },
      })
      // Nothing started and nothing was written to the refused conversations.
      expect(ops(db(team), team.teamID).length).toBe(journal)
      expect((await areaOf(team, AREA_1)).owner).toEqual(before.owner)
      expect(row(team, rival).permission.filter((rule) => String(rule.action).startsWith("team."))).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "an ask the seat took and did not answer: the asking area gets the notice, no ask stays open, no Main 멈춤",
    async () => {
      const team = required(state.team)
      const chosen = required(state.chosen)
      const seen = (await texts(team, team.asker)).filter((text) => text.startsWith(NOTICE)).length
      // area-2 asks area-1; the seat takes the ask in a turn that never gets to answer.
      await team.server.turn(team.main, "[dispatch area-2 [message ask area-1 [slow 60000] 필드 이름을 바꾸나요?]]")
      await until(
        async () => (await texts(team, chosen)).some((text) => text.includes('kind="ask"')),
        "the seat did not take the ask",
      )
      await until(async () => (await active(team.server)).has(chosen), "the seat does not run the ask")
      expect(talk(team).open).toHaveLength(1)

      // Back onto the first conversation, a previous owner; the user stops the seat while the move waits for it.
      const started = await seat(team, team.first)
      await until(
        async () => (await team.server.team("op.get", { opID: started.opID })).op.steps[0]?.wait !== undefined,
        "the move does not wait",
      )
      await interrupt(team.server, chosen)
      const op = await opEnd(team.server, started.opID)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual(STEPS.map((kind) => [kind, "done"]))

      const notice = await waitValue(
        async () => (await texts(team, team.asker)).filter((text) => text.startsWith(NOTICE)).at(seen),
        "the asking area got no notice",
      )
      expect(notice).toContain("물음에 답하지 않고 차례를 마쳤습니다")
      expect(notice).toContain("필드 이름을 바꾸나요?")
      await team.server.server.waitIdle(team.asker)
      expect((await texts(team, team.asker)).filter((text) => text.startsWith(NOTICE))).toHaveLength(seen + 1)
      expect(talk(team).open).toEqual([])

      const area = await areaOf(team, AREA_1)
      // The first conversation is the owner again and no longer a previous one; the stop paused nothing.
      expect<unknown>(area.owner.sessionID).toBe(team.first)
      expect(area.owner.previous).toMatchObject([{ sessionID: chosen, why: "seat" }])
      expect(area.paused).toBe(false)
      expect(area.main).toMatchObject({ model: MODEL["01"], chosenBy: "adopted" })
      expect(row(team, team.first).permission.filter((rule) => String(rule.action).startsWith("team."))).toEqual(
        Permissions.rules("owner").map((rule) => ({ ...rule })),
      )
      expect(row(team, chosen).permission.filter((rule) => String(rule.action).startsWith("team."))).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a fresh main request that waits during the move goes to the chosen conversation as a plain one: no rotation",
    async () => {
      const team = required(state.team)
      const chosen = required(state.chosen)
      const text = "[report progress 새로 시작할 일]"
      await team.server.server.prompt(team.first, "[slow 60000] 천천히 하는 일")
      await until(async () => (await active(team.server)).has(team.first), "the owner never started the user's turn")
      const started = await seat(team, chosen)
      await team.server.turn(team.main, `[dispatch area-1 +fresh ${text}]`)
      expect(dispatches(db(team), team.teamID).find((item) => item.text === text)).toMatchObject({
        state: "waiting",
        fresh: true,
      })
      expect((await team.server.team("op.get", { opID: started.opID })).op.state).toBe("running")
      await interrupt(team.server, team.first)
      const op = await opEnd(team.server, started.opID)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual(STEPS.map((kind) => [kind, "done"]))

      const sent = await sentTo(team, text, chosen)
      expect(sent.fresh).toBeUndefined()
      await until(
        async () => (await mainRequests(team.server, chosen)).map(body).at(-1) === text,
        "the chosen conversation got no request",
      )
      await team.server.server.waitIdle(chosen)
      const area = await areaOf(team, AREA_1)
      expect<unknown>(area.owner.sessionID).toBe(chosen)
      expect(area.owner.previous).toMatchObject([{ sessionID: team.first, why: "seat" }])
      expect(area.paused).toBe(false)
      expect(ops(db(team), team.teamID).filter((item) => item.kind === "rotate")).toEqual([])
      expect(row(team, chosen).metadata["own.archived"]).toBeUndefined()
      expect(digest(team).entries.filter((entry) => entry.reason === "request-plain")).toMatchObject([
        { areaID: AREA_1, wake: false },
      ])
    },
    STEP_TIMEOUT,
  )

  test(
    "the round trip A→B→A with a request sent to A and not taken: taken back at each move, delivered once at the end",
    async () => {
      const team = required(state.team)
      const a = team.first
      const b = required(state.chosen)
      const text = "[report progress 왕복한 요청]"
      // A takes the seat with the user's prompt parked in its queue; then B, a previous owner again, gets one too.
      await park(team, a, "PARKED-A 하던 일 마저")
      expect((await opEnd(team.server, (await seat(team, a)).opID)).state).toBe("done")
      await park(team, b, "PARKED-B 하던 일 마저")
      expect<unknown>((await areaOf(team, AREA_1)).owner.sessionID).toBe(a)

      // The request goes to A, which runs the parked prompt first: sent, not taken.
      await team.server.turn(team.main, `[dispatch area-1 ${text}]`)
      const request = await sentTo(team, text, a)
      const atA = String(MsgID.dispatch(request.id, a))
      const atB = String(MsgID.dispatch(request.id, b))
      await untaken(team, a, atA)

      // A→B: the move waits for A, the user stops A, and the request is taken back and sent on to B.
      const forth = await moved(team, { from: a, to: b })
      expect(forth.steps.find((step) => step.kind === Seat.KIND.requeue)?.note).toBe(
        "요청 1개는 바꾼 뒤 새 담당에게 보내요",
      )
      await sentTo(team, text, b)
      await untaken(team, b, atB)
      expect(await queued(team, a)).toEqual([])

      // B→A: the same; the request is admitted at A again under the id whose first row was cancelled.
      const back = await moved(team, { from: b, to: a })
      expect(back.steps.find((step) => step.kind === Seat.KIND.requeue)?.note).toBe(
        "요청 1개는 바꾼 뒤 새 담당에게 보내요",
      )
      await sentTo(team, text, a)
      await until(
        async () => (await mainRequests(team.server, a)).some((message) => dispatchOf(message) === request.id),
        "the request never reached A",
      )
      await team.server.server.waitIdle(a)

      // Delivered once, to A only, and A did the work as the owner.
      const delivered = (await mainRequests(team.server, a)).filter((message) => dispatchOf(message) === request.id)
      expect(delivered.map(body)).toEqual([text])
      expect((await mainRequests(team.server, b)).filter((message) => dispatchOf(message) === request.id)).toEqual([])
      expect(await queued(team, a)).toEqual([])
      expect(await queued(team, b)).toEqual([])
      expect(enqueued(team.server, a).filter((item) => item.inboxID === atA)).toHaveLength(2)
      expect(enqueued(team.server, b).filter((item) => item.inboxID === atB)).toHaveLength(1)
      expect(JSON.stringify((await toolParts(team.server.server, a, "execute")).at(-1))).toContain(
        "팀 소식에 적었습니다.",
      )
      const records = dispatches(db(team), team.teamID).filter((item) => item.text === text)
      expect(records).toMatchObject([{ id: request.id, state: "sent", sentTo: { sessionID: a } }])
      const area = await areaOf(team, AREA_1)
      expect(area.owner).toMatchObject({ sessionID: a, attached: true, previous: [{ sessionID: b, why: "seat" }] })
      expect(area.owner.release).toBeUndefined()
      expect(area.paused).toBe(false)
      expect(ops(db(team), team.teamID).filter((item) => item.kind === "seat" && item.state !== "done")).toEqual([])
    },
    STEP_TIMEOUT + 120_000,
  )
})

// ---------------------------------------------------------------------------------------------------------------

function db(team: Team) {
  return team.server.server.paths.database
}

async function areaOf(team: Team, areaID: OwnTeam.AreaID) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return required(view.areas.find((area) => area.id === areaID))
}

function row(team: Team, sessionID: string) {
  return required(sessionRows(db(team)).find((item) => item.id === sessionID))
}

/** `area.seat` on area-1, as the button calls it. */
function seat(team: Team, sessionID: string) {
  return team.server.team("area.seat", {
    teamID: team.teamID,
    areaID: AREA_1,
    sessionID: SessionID.make(sessionID),
  })
}

/**
 * A move that has to wait for the seat `from`, which runs the user's parked prompt with a main request behind it: the
 * request is old enough to be parked input, the move waits, the user stops the seat, and the move ends.
 */
async function moved(team: Team, input: { readonly from: string; readonly to: string }) {
  // Past 10 s an item in a queue is parked input, not work that is about to start (06 §8.4).
  await Bun.sleep(11_000)
  const started = await seat(team, input.to)
  await until(
    async () => (await team.server.team("op.get", { opID: started.opID })).op.steps[0]?.wait !== undefined,
    "the move does not wait",
  )
  expect<unknown>((await areaOf(team, AREA_1)).owner.sessionID).toBe(input.from)
  await interrupt(team.server, input.from)
  const op = await opEnd(team.server, started.opID)
  expect(op.steps.map((step) => [step.kind, step.state])).toEqual(STEPS.map((kind) => [kind, "done"]))
  // The stop came while the move held the area: Main 멈춤 stays off.
  expect((await areaOf(team, AREA_1)).paused).toBe(false)
  return op
}

/**
 * Leaves `text` parked in the queue of a conversation of area-1's folder that is not the seat: the user queues it
 * during a run and then stops the run. Core keeps it; the next input that wakes the conversation runs it first.
 */
async function park(team: Team, sessionID: string, text: string) {
  await team.server.server.prompt(sessionID, "[slow 60000] 먼저 하던 일")
  await until(async () => (await active(team.server)).has(sessionID), "the conversation never started")
  await team.server.server.call("POST", `/api/session/${sessionID}/prompt`, {
    directory: team.folder,
    body: { text: `[slow 60000] ${text}`, delivery: "queue" },
  })
  await interrupt(team.server, sessionID)
  await until(async () => !(await active(team.server)).has(sessionID), "the conversation did not stop")
  expect((await inbox(team, sessionID)).map((item) => item.payload?.text)).toEqual([`[slow 60000] ${text}`])
  expect((await areaOf(team, AREA_1)).paused).toBe(false)
}

async function inbox(team: Team, sessionID: string) {
  const listed = (await team.server.server.call("GET", `/api/session/${sessionID}/inbox`, {
    directory: team.folder,
  })) as {
    readonly data: ReadonlyArray<{
      readonly id: string
      readonly payload?: { readonly text?: string; readonly metadata?: Readonly<Record<string, unknown>> }
    }>
  }
  return listed.data
}

/** The inbox ids of the main requests a conversation has not taken. */
async function queued(team: Team, sessionID: string) {
  return (await inbox(team, sessionID)).flatMap((item) =>
    item.payload?.metadata?.[OwnTeam.DISPATCH_META] === undefined ? [] : [item.id],
  )
}

/** The conversation runs something else while the request `inboxID` sits in its queue: sent, not taken. */
async function untaken(team: Team, sessionID: string, inboxID: string) {
  await until(async () => (await active(team.server)).has(sessionID), "the seat did not start its parked prompt")
  expect(await queued(team, sessionID)).toEqual([inboxID])
  expect((await mainRequests(team.server, sessionID)).map(dispatchOf)).not.toContain(inboxID)
}

/** The request `text` once it is `sent` to `sessionID`. */
function sentTo(team: Team, text: string, sessionID: string) {
  return waitValue(
    async () =>
      dispatches(db(team), team.teamID).find(
        (item) => item.text === text && item.state === "sent" && item.sentTo?.sessionID === sessionID,
      ),
    `the request "${text}" was not sent to ${sessionID}`,
    120_000,
  )
}

/** The user texts of a conversation, oldest first. */
async function texts(team: Team, sessionID: string) {
  return (await messages(team.server, sessionID)).flatMap((message) =>
    message.type === "user" && typeof message.text === "string" ? [message.text] : [],
  )
}

/** The team updates the main got, oldest first. */
async function updateTexts(team: Team) {
  return (await messages(team.server, team.main)).flatMap((message) =>
    message.type === "synthetic" && isRecord(message.metadata) && OwnTeam.UPDATE_META in message.metadata
      ? [String(message.text)]
      : [],
  )
}

async function updates(team: Team) {
  return (await updateTexts(team)).length
}

/** The team's digest record in KV (06 §5.6). */
function digest(team: Team) {
  // SAFETY (test): the digest record's shape (`report/fold.ts` State), read only for the fields checked.
  return kv(db(team))[`digest:${team.teamID}`] as {
    readonly entries: ReadonlyArray<{ readonly reason: string; readonly areaID?: string; readonly wake: boolean }>
  }
}

/** The team's talk state in KV (`dispatch/talk.ts` State). */
function talk(team: Team) {
  // SAFETY (test): read only for the open asks.
  return kv(db(team))[`talk:${team.teamID}`] as { readonly open: ReadonlyArray<unknown> }
}

/** The request text inside a main request's envelope. */
function body(message: Readonly<Record<string, unknown>>) {
  return OwnTeamText.unwrap(typeof message.text === "string" ? message.text : "").split("\n")[0]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

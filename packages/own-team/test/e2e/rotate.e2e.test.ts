// TG9 대화 교체(의미 경계만) on a real server (06 §11.3, §6.1–6.2, §10.1): a team of two areas on F1. Owner
// conversations are replaced only at semantic boundaries (a `fresh` main request, 새 대화로 이어가기, an area account
// change from the area menu), never by size, `done`, `ready` or a model, effort or preset change, and never while Main
// 멈춤 holds an automatic one back. Verdicts come from the op records, the registry, the session rows, instruction
// entries, preset bindings, the handoff document in the team records folder, the fakes' recorded requests and the
// self-HTTP calls own.team made (it never calls `session.compact`).
//
// - A warm handoff: the old owner gets `<team-request kind="handoff">` and writes the document with `team_handoff`; the
//   new owner (the write-ahead id) starts with the role and handoff entries only, on the area main (팀과 같게: the team
//   main's Ref) with the area preset bound and ultra off; the old one is archived and leaves the team's binding.
// - Without `team_handoff` the program writes the document; a kill at every step of a rotation converges.
// - The new owner's first request is no bigger than the old one's plus the handoff and the request.
// - Reports in the rotation window count; after the swap the old owner's team tools are refused.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { OwnTeam } from "@own/protocol"
import { instructionEntries, toolParts } from "../../../own-accounts/test/e2e-kit"
import { HANDOFF_REQUEST, HANDOFF_TEXT, IDLE, responder, turn } from "./directives.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  SLOT,
  active,
  dispatches,
  enableTeam,
  killEachStep,
  mainRequests,
  messages,
  opEnd,
  ops,
  presetOf,
  savePreset,
  sessionRows,
  startTeamFakes,
  startTeamServer,
  teamMeta,
  until,
  waitValue,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"
import { ofSession, toolBytes, toolsHash } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const AREA_2 = OwnTeam.AreaID.make("ar_area-2")
/** The owner's refusal after the swap (`tools/owner.ts` PREVIOUS_OWNER). */
const PREVIOUS_OWNER = "이 대화는 더 이상 이 영역의 담당이 아닙니다"

interface Team {
  readonly server: TeamServer
  readonly fakes: TeamFakes
  readonly teamID: OwnTeam.TeamID
  readonly main: string
}

/** `false`: the scripted owner answers a handoff request with a plain text (no `team_handoff`). */
const handoff = { answer: true }

describe("TG9 owner rotation at semantic boundaries only (two areas, F1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const fakes = startTeamFakes({
      responder: responder({
        before: (request) =>
          !handoff.answer && turn(request).user.includes(HANDOFF_REQUEST) ? { type: "text", text: IDLE } : undefined,
      }),
    })
    const server = await startTeamServer({ name: "rotate", fakes })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = { server, fakes, teamID: team.id, main: team.main.sessionID }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
    await state.team?.fakes.stop()
  }, 120_000)

  test(
    "fresh: a warm handoff, a new owner with the role and handoff only, the area main and preset, no ultra",
    async () => {
      const team = required(state.team)
      await team.server.turn(team.main, "[dispatch area-1 [report progress 첫 일]]")
      await settled(team, AREA_1, 1)
      const before = await areaOf(team, AREA_1)
      const old = required(before.owner.sessionID ?? undefined)

      await team.server.turn(team.main, "[dispatch area-1 +fresh [report done 새 일]]")
      const rotation = required(ops(db(team), team.teamID).findLast((op) => op.kind === "rotate"))
      expect(rotation).toMatchObject({ by: "main", areaID: AREA_1 })
      const op = await opEnd(team.server, rotation.id)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["rotate.begin", "done"],
        ["rotate.handoff", "done"],
        ["rotate.owner", "done"],
        ["rotate.swap", "done"],
        ["rotate.archive", "done"],
      ])
      expect(op.steps[1]?.note).toBe("담당이 인계 메모를 썼어요")
      await settled(team, AREA_1, 2)

      const area = await areaOf(team, AREA_1)
      const next = required(area.owner.sessionID ?? undefined)
      // The new id is the one written ahead (`owner.pending`), and the registry swap moved the old one to `previous`.
      expect(op.steps[2]?.note).toBe(next)
      expect(area.owner).toMatchObject({ previous: [{ sessionID: old, why: "fresh" }], attached: true })
      expect(area.owner.pending).toBeUndefined()
      // The warm turn wrote the document with team_handoff.
      expect(fs.readFileSync(required(area.handoff?.file), "utf8")).toBe(HANDOFF_TEXT)
      const handed = (await messages(team.server, old)).filter((message) => message.type === "synthetic")
      expect(handed.map((message) => String(message.text).startsWith(HANDOFF_REQUEST))).toEqual([true])

      // The new owner: the role and handoff entries, the team main's Ref (팀과 같게), the area preset, no ultra.
      const rows = sessionRows(db(team))
      const row = required(rows.find((item) => item.id === next))
      expect(teamMeta(row)).toEqual({ role: "owner", teamID: team.teamID, areaID: AREA_1 })
      expect(row.model).toMatchObject({ providerID: MODEL["01"].providerID, id: MODEL["01"].id })
      const entries = await instructionEntries(team.server.server, next)
      expect(entries.find((entry) => entry.key === "own.team.handoff")?.value).toBe(HANDOFF_TEXT)
      expect(entries.map((entry) => entry.key)).toContain("own.team.role")
      const bound = await presetOf(team.server, next, area.directory)
      expect(bound.binding).toMatchObject({ presetID: area.preset, team: { teamID: team.teamID, role: "owner" } })
      expect(bound.binding?.ultra).toBeUndefined()
      // The old conversation is archived and leaves the team's binding.
      expect(required(rows.find((item) => item.id === old)).metadata["own.archived"]).toBe(true)
      expect((await presetOf(team.server, old, area.directory)).binding?.team).toBeUndefined()

      // The fresh request went to the new owner only.
      expect((await mainRequests(team.server, next)).map(body)).toEqual(["[report done 새 일]"])
      expect((await mainRequests(team.server, old)).map(body)).toEqual(["[report progress 첫 일]"])

      // The new owner's first input: no bigger than the old owner's first, plus the handoff and the request.
      const first = (id: string) => required(ofSession(team.fakes.codex.requests, id)[0]?.cache)
      const grown = first(next).promptTokens - first(old).promptTokens
      expect(grown).toBeLessThanOrEqual(Math.ceil((HANDOFF_TEXT.length + "[report done 새 일]".length) / 2) + 200)
    },
    STEP_TIMEOUT,
  )

  test(
    "no rotation from size, done or ready; own.team never compacts",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, AREA_2)
      const owner = required(area.owner.sessionID ?? undefined)
      const rotations = rotationsOf(team, AREA_2)
      // A long conversation (the fake counts four characters a token): about 60k tokens of the user's own text.
      await team.server.turn(owner, `긴 자료입니다. ${"가나다라마바사아자차카타파하 ".repeat(16_000)}`)
      await team.server.turn(team.main, "[dispatch area-2 [report done 큰 대화 뒤]]")
      await settled(team, AREA_2, 1)
      await team.server.turn(team.main, "[dispatch area-2 [report ready 반영 준비]]")
      await settled(team, AREA_2, 2)
      expect(rotationsOf(team, AREA_2)).toEqual(rotations)
      expect((await areaOf(team, AREA_2)).owner.sessionID).toBe(owner)
      expect((await areaOf(team, AREA_2)).status.kind).toBe("ready")
      expect(compactions(team)).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a report in the rotation window counts; after the swap the old owner's team tools are refused",
    async () => {
      const team = required(state.team)
      const old = required((await areaOf(team, AREA_2)).owner.sessionID ?? undefined)
      await team.server.server.prompt(old, "[slow 6000] [report progress 교체 창 보고]")
      await until(async () => (await active(team.server)).has(old), "the owner never started the user's turn")
      const started = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_2 })
      const op = await opEnd(team.server, started.opID)
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      // The report was taken while the rotation waited for the owner (6.2: 교체 창 안의 보고는 받아들임).
      const reported = (await toolParts(team.server.server, old, "execute")).find((part) =>
        JSON.stringify(part.state.input).includes("교체 창 보고"),
      )
      expect(JSON.stringify(reported)).toContain("팀 소식에 적었습니다.")

      await team.server.turn(old, "[report progress 옛 담당의 보고]")
      const refused = (await toolParts(team.server.server, old, "execute")).at(-1)
      expect(JSON.stringify(refused)).toContain(PREVIOUS_OWNER)
      expect(JSON.stringify(refused)).toContain('"status":"completed"')
    },
    STEP_TIMEOUT,
  )

  test(
    "without team_handoff the program writes the handoff document",
    async () => {
      const team = required(state.team)
      handoff.answer = false
      const started = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_2 })
      const op = await opEnd(team.server, started.opID)
      handoff.answer = true
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(op.steps.find((step) => step.kind === "rotate.handoff")?.note).toBe("이 앱이 인계 메모를 썼어요")
      const area = await areaOf(team, AREA_2)
      const text = fs.readFileSync(required(area.handoff?.file), "utf8")
      expect(text).toStartWith("# 인계: 영역 2")
      expect(text).toContain("## 남은 것")
    },
    STEP_TIMEOUT,
  )

  test(
    "an area account change from the area menu continues in a new conversation; model, effort and `now` switch in place",
    async () => {
      const team = required(state.team)
      const before = await areaOf(team, AREA_2)
      const old = required(before.owner.sessionID ?? undefined)
      const changed = await team.server.team("area.main", {
        teamID: team.teamID,
        areaID: AREA_2,
        model: MODEL.deepseek,
      })
      const opID = required(changed.opID)
      const op = await opEnd(team.server, opID)
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      const moved = await areaOf(team, AREA_2)
      const next = required(moved.owner.sessionID ?? undefined)
      expect(next).not.toBe(old)
      expect(moved.owner.previous.at(-1)).toMatchObject({ sessionID: old, why: "account" })
      expect(moved.main?.model).toMatchObject({ providerID: SLOT.deepseek })
      expect(required(sessionRows(db(team)).find((row) => row.id === next)).model).toMatchObject({
        providerID: SLOT.deepseek,
      })
      // The handoff turn ran on the old conversation's account (ChatGPT 01), never on the new one.
      expect(ofSession(team.fakes.deepseek.requests, old)).toEqual([])

      // Only the effort: no rotation, the owner conversation switches now (02 switch).
      const rotations = rotationsOf(team, AREA_1)
      const owner1 = required((await areaOf(team, AREA_1)).owner.sessionID ?? undefined)
      const high = { ...MODEL["01"], variant: "high" }
      const effort = await team.server.team("area.main", { teamID: team.teamID, areaID: AREA_1, model: high })
      expect(effort.opID).toBeUndefined()
      await until(
        async () => required(sessionRows(db(team)).find((row) => row.id === owner1)).model?.variant === "high",
        "the effort change did not reach the owner conversation",
      )
      expect(rotationsOf(team, AREA_1)).toEqual(rotations)
      expect((await areaOf(team, AREA_1)).owner.sessionID).toBe(owner1)

      // `now` (the owner's composer): another account in the same conversation, no rotation.
      const now = await team.server.team("area.main", {
        teamID: team.teamID,
        areaID: AREA_2,
        model: MODEL.anthropic,
        now: true,
      })
      expect(now.opID).toBeUndefined()
      await until(
        async () => required(sessionRows(db(team)).find((row) => row.id === next)).model?.providerID === SLOT.anthropic,
        "the `now` change did not switch the owner conversation",
      )
      expect((await areaOf(team, AREA_2)).owner.sessionID).toBe(next)
    },
    STEP_TIMEOUT,
  )

  test(
    "an area preset change: no rotation, no model switch, the same tool definitions",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, AREA_1)
      const owner = required(area.owner.sessionID ?? undefined)
      const presetID = await savePreset(team.server, "검토는 메인과 같게", "codex", { "own-review": [{ rel: "main" }] })
      const rotations = rotationsOf(team, AREA_1)
      const selected = modelSelected(team, owner)
      const lastBefore = required(ofSession(team.fakes.codex.requests, owner).at(-1))
      const changed = await team.server.team("area.preset", { teamID: team.teamID, areaID: AREA_1, presetID })
      expect(changed.area.preset).toBe(presetID)
      expect((await presetOf(team.server, owner, area.directory)).binding?.presetID).toBe(presetID)
      await team.server.turn(team.main, "[dispatch area-1 [report progress 프리셋 뒤]]")
      await settled(team, AREA_1, dispatchCount(team, AREA_1))
      const after = ofSession(team.fakes.codex.requests, owner).filter((request) => request.seq > lastBefore.seq)
      expect(after.length).toBeGreaterThan(0)
      expect(toolsHash(required(after[0]))).toBe(toolsHash(lastBefore))
      expect(toolBytes(required(after[0]))).toBe(toolBytes(lastBefore))
      expect(rotationsOf(team, AREA_1)).toEqual(rotations)
      expect(modelSelected(team, owner)).toBe(selected)
      expect((await areaOf(team, AREA_1)).owner.sessionID).toBe(owner)
    },
    STEP_TIMEOUT,
  )

  test(
    "Main 멈춤 holds an automatic `fresh` rotation back; off, it runs and the request goes to the new owner",
    async () => {
      const team = required(state.team)
      const owner = required((await areaOf(team, AREA_1)).owner.sessionID ?? undefined)
      const rotations = rotationsOf(team, AREA_1)
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: true })
      await team.server.turn(team.main, "[dispatch area-1 +fresh [report done 멈춤 뒤 새 일]]")
      await Bun.sleep(3_000)
      expect(rotationsOf(team, AREA_1)).toEqual(rotations)
      expect((await areaOf(team, AREA_1)).owner.sessionID).toBe(owner)
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: false })
      const sent = await waitValue(
        async () =>
          dispatches(db(team), team.teamID).find(
            (item) => item.text === "[report done 멈춤 뒤 새 일]" && item.state === "sent",
          ),
        "the fresh request was never sent",
        STEP_TIMEOUT,
      )
      expect(sent.sentTo?.sessionID).not.toBe(owner)
      expect(rotationsOf(team, AREA_1).length).toBe(rotations.length + 1)
    },
    STEP_TIMEOUT,
  )

  test(
    "a kill after every step of a rotation converges on one new owner",
    async () => {
      const team = required(state.team)
      await settled(team, AREA_1, dispatchCount(team, AREA_1))
      const old = required((await areaOf(team, AREA_1)).owner.sessionID ?? undefined)
      const started = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_1 })
      const kills = await killEachStep(team.server, started.opID, new Set(["rotate.owner", "rotate.swap"]))
      const op = await opEnd(team.server, started.opID)
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(kills).toBeGreaterThan(0)
      const area = await areaOf(team, AREA_1)
      expect(area.owner.previous.at(-1)).toMatchObject({ sessionID: old, why: "user" })
      const owners = sessionRows(db(team)).filter(
        (row) => teamMeta(row)?.role === "owner" && teamMeta(row)?.areaID === AREA_1,
      )
      // One conversation per owner the area ever had: no session made twice across the restarts.
      expect(owners.map((row) => row.id).toSorted()).toEqual(
        [...area.owner.previous.map((item) => item.sessionID), required(area.owner.sessionID ?? undefined)].toSorted(),
      )
      expect(required(owners.find((row) => row.id === old)).metadata["own.archived"]).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "a long idle main stays: no 메인 새 대화, no compaction call by own.team",
    async () => {
      const team = required(state.team)
      await team.server.turn(team.main, `긴 메인 대화입니다. ${"가나다라마바사아자차카타파하 ".repeat(16_000)}`)
      await Bun.sleep(2_000)
      const view = await team.server.team("team.get", { directory: required(team.server.project) })
      expect<unknown>(view.team?.main.sessionID).toBe(team.main)
      expect(view.team?.main.previous).toEqual([])
      expect(ops(db(team), team.teamID).filter((op) => op.kind === "rotate" && op.areaID === undefined)).toEqual([])
      expect(compactions(team)).toEqual([])
    },
    STEP_TIMEOUT,
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

/** The area's rotation ops (ids), oldest first. */
function rotationsOf(team: Team, areaID: OwnTeam.AreaID) {
  return ops(db(team), team.teamID)
    .filter((op) => op.kind === "rotate" && op.areaID === areaID)
    .map((op) => op.id)
}

function dispatchCount(team: Team, areaID: OwnTeam.AreaID) {
  return dispatches(db(team), team.teamID).filter((item) => item.areaID === areaID && item.state === "sent").length
}

/** `session.model.selected` events of a session on the recorded stream. */
function modelSelected(team: Team, sessionID: string) {
  return team.server.events.events.filter(
    (event) => event.type === "session.model.selected" && event.data.sessionID === sessionID,
  ).length
}

/** Self-HTTP calls own.team made to core's compaction (06 §6.5, U6: never). */
function compactions(team: Team) {
  return team.server.service.calls
    .filter((call) => call.caller === "own.team" && call.path.includes("compact"))
    .map((call) => call.path)
}

/** Waits until the area has `count` sent requests, nothing waits, and its owner is idle with an empty inbox. */
async function settled(team: Team, areaID: OwnTeam.AreaID, count: number) {
  await until(
    async () => {
      const items = dispatches(db(team), team.teamID).filter((item) => item.areaID === areaID)
      const area = await areaOf(team, areaID)
      const sessionID = area.owner.sessionID
      return (
        items.filter((item) => item.state === "sent").length >= count &&
        items.every((item) => item.state !== "waiting") &&
        sessionID !== null &&
        !(await active(team.server)).has(sessionID) &&
        (await team.server.server.messages(sessionID)).at(0)?.type === "idle"
      )
    },
    `area ${areaID} did not settle with ${count} requests sent`,
    STEP_TIMEOUT,
  )
}

/** The request text inside a main request's envelope. */
function body(message: Readonly<Record<string, unknown>>) {
  const text = typeof message.text === "string" ? message.text : ""
  return /^<dispatch[^>]*>\n([\s\S]*?)\n(?:[^\n]*\n)?<\/dispatch>$/.exec(text)?.[1] ?? text
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

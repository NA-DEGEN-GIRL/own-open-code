// 직접 작업 (2026-11-14, design 2.1, 8.2) on a real server: a team of two areas on F1 with the hold on (the team's
// default; the other suites switch it off right after enable). The scripted model stands for the owners and the main,
// so what is checked is the program's part: the hold, what waits, what wakes, what the hand-back carries.
//
// 1. The user's message in an owner conversation holds the area (`directWork`); the role texts say how; the main's
//    request waits with the direct cause and its answer says so.
// 2. While held: progress, blocked (6,000 characters), ready and a failed run are stored and wake nobody; 다시 시작 and
//    모두 멈추기 leave the hold and the waiting request; the main's `team_integrate` on the held area is a plan.
// 3. 메인에게 넘기기 (the button): one update carries the stretch (`handed`), the ready made before the waiting request
//    went in among it; the request goes in after; `team_status{area}` lists the stretch and the whole texts.
// 4. A stretch without reports: the owner's `team_area resume` in a run the user opened hands it back at once, and the
//    update says `그동안 보고 없음` with the program facts. In the next stretch the owner integrates at once, by the user.
// 5. An integration the main started before the stretch waits until the hand-back, then goes in.
// 6. A restart mid-stretch keeps the hold and the waiting request; a take-back in the main's run that the restart cut
//    is a plan (the user's last word to the main is not remembered across it); the user's yes takes it back (`taken`,
//    no wake) and the request goes in.
// 7. A user message while the owner serves the main's request steers that work: no hold, only the `direct` mark, and
//    the owner's blocked report wakes the main as before.
//
// Verdicts: `team.get`, `outbox.list`, the dispatch, op and integration records, the conversations' tool answers, the
// team updates in the main conversation and the main's model calls on the fake. Fake credentials only; every listener
// binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { instructionEntries, toolParts } from "../../../own-accounts/test/e2e-kit"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { commit, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  active,
  dispatchOf,
  dispatches,
  enableTeam,
  integrations,
  mainRequests,
  ops,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { ofSession } from "./inspect.js"

const STEP_TIMEOUT = 300_000
/** The wake debounce (06 §5.6: 30 s) and a margin. */
const SETTLE = 38_000
/** `controller.ts` `RECHECK_MS` (30 s) and a margin. */
const RECHECK = 40_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const AREA_2 = OwnTeam.AreaID.make("ar_area-2")
/** A blocked report of 6,000 characters: stored whole, quoted short. */
const LONG = `막힌 일 전문 시작 ${"가나다라마바사아자차카타파하 ".repeat(400)}`.slice(0, 5_990) + " 막힌 일 끝."

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly owners: Readonly<Record<string, string>>
  readonly folders: Readonly<Record<string, string>>
}

describe("직접 작업: the hold, what waits and the hand-back (two areas, F1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "direct" })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed, directHold: true })
    const team = required(enabled.view.team ?? undefined)
    state.team = {
      server,
      teamID: team.id,
      main: team.main.sessionID,
      owners: Object.fromEntries(enabled.view.areas.map((area) => [area.id, required(area.owner.sessionID ?? undefined)])),
      folders: Object.fromEntries(enabled.view.areas.map((area) => [area.id, area.directory])),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "the user's message in the owner conversation holds the area; the main's request waits with the direct cause",
    async () => {
      const team = required(state.team)
      const settings = await team.server.team("settings.get", { teamID: team.teamID })
      expect(settings.policy).toMatchObject({ directHold: true, directTell: "judge" })
      const owner = required(team.owners[AREA_1])
      await team.server.turn(owner, "버튼 색 바꿔 줘")
      const held = await directWorkOf(team, AREA_1)
      expect(held.since).toBeLessThanOrEqual(held.at)
      expect(await areaOf(team, AREA_2)).not.toHaveProperty("directWork")
      // The role texts tell the main and the owner what the hold means.
      expect(await entry(team, team.main, RoleInstructions.MAIN)).toContain("팀 소식에 '직접 작업 중'인 영역은")
      expect(await entry(team, owner, RoleInstructions.OWNER)).toContain(
        "사용자가 이 대화에 말하면 이 영역은 '직접 작업'이 된다.",
      )
      const before = ofSession(team.server.fakes.codex.requests, owner).length
      await team.server.turn(team.main, "[dispatch area-1 [report done 메인 요청 끝]]")
      expect(lastText(await outputs(team, team.main))).toContain(
        "사용자가 이 영역 담당과 직접 작업 중이라 대기함에서 기다립니다.",
      )
      const outbox = await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA_1 })
      expect(outbox.items.map((item) => item.state)).toEqual(["waiting"])
      expect(outbox).toMatchObject({ why: "paused", cause: { direct: true } })
      await Bun.sleep(3_000)
      expect(ofSession(team.server.fakes.codex.requests, owner)).toHaveLength(before)
    },
    STEP_TIMEOUT,
  )

  test(
    "reports and a failed run while held wake nobody; 다시 시작 and 모두 멈추기 leave the hold; the main's integrate is a plan",
    async () => {
      const team = required(state.team)
      const owner = required(team.owners[AREA_1])
      const seen = (await updates(team)).length
      const calls = mainCalls(team)
      write(required(team.folders[AREA_1]), { "src/direct.ts": "export const direct = 1\n" })
      const source = commit(required(team.folders[AREA_1]), "the user's direct work")
      await team.server.turn(owner, "[report progress 버튼 색을 바꾸는 중]")
      await team.server.turn(owner, `[report blocked ${LONG}]`)
      await team.server.turn(owner, "[report ready 버튼 색 바꾸기 끝, 반영할 수 있음]")
      await team.server.turn(owner, "[fail]")
      const answers = (await outputs(team, owner)).map((item) => String(item.text))
      expect(answers.some((text) => text.includes("막힌 일로 적었습니다. 직접 작업 중이라 메인을 깨우지 않았고"))).toBe(true)
      expect(answers.some((text) => text.includes("반영 후보로 적었습니다. 직접 작업 중이라 메인을 깨우지 않았고"))).toBe(
        true,
      )
      expect((await areaOf(team, AREA_1)).candidate?.sha).toBe(source)
      // 모두 멈추기, then 다시 시작: the hold and the waiting request stay.
      await team.server.team("team.pause", { teamID: team.teamID, on: true })
      await team.server.team("team.pause", { teamID: team.teamID, on: false })
      expect(await areaOf(team, AREA_1)).toMatchObject({ paused: false, directWork: expect.any(Object) })
      // The main asked to integrate the held area: a plan, nothing starts.
      const integrates = integrateOps(team, AREA_1).length
      await team.server.turn(team.main, "[integrate area-1]")
      const plan = (await outputs(team, team.main)).at(-1)
      expect(plan).toMatchObject({ ok: true, plan: true })
      expect(String(plan?.text)).toContain("직접 작업한 변경을 프로젝트 본 코드에 반영할까요?")
      expect(integrateOps(team, AREA_1)).toHaveLength(integrates)
      const callsNow = mainCalls(team)
      await Bun.sleep(SETTLE)
      expect((await updates(team)).length).toBe(seen)
      // Only the main's own integrate turn ran: no woken turn.
      expect(mainCalls(team)).toBe(callsNow)
      expect(callsNow).toBeGreaterThan(calls)
      expect(waitingOf(team, AREA_1)).toHaveLength(1)
    },
    STEP_TIMEOUT,
  )

  test(
    "메인에게 넘기기: one update carries the stretch, the waiting request goes in after, team_status lists it whole",
    async () => {
      const team = required(state.team)
      const owner = required(team.owners[AREA_1])
      const seen = (await updates(team)).length
      const waiting = required(waitingOf(team, AREA_1)[0])
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: false })
      expect(await areaOf(team, AREA_1)).not.toHaveProperty("directWork")
      const update = await nextUpdate(team, seen)
      expect(update.reasons).toContain("handed")
      expect(update.text).toContain("사용자가 직접 작업을 마치고 넘김(")
      expect(update.text).toContain('전문: team_status{area:"area-1"}')
      expect(update.text).toContain("그동안 보고 4개(")
      // The waiting request goes in after the hand-back, and the owner runs it.
      await until(
        async () =>
          (await mainRequests(team.server, owner)).some((message) => dispatchOf(message) === waiting.id),
        "the waiting request never went in",
        STEP_TIMEOUT,
      )
      await until(async () => !(await active(team.server)).has(owner), "the owner did not finish the request")
      // The main reads the whole stretch.
      await team.server.turn(team.main, "[status area-1]")
      const status = lastText(await outputs(team, team.main))
      expect(status).toContain("지난 직접 작업(")
      expect(status).toContain(LONG.slice(-500))
      expect(status).toContain("버튼 색 바꾸기 끝, 반영할 수 있음")
    },
    STEP_TIMEOUT,
  )

  test(
    "a stretch without reports: the owner hands it back at once and the update says so; the next stretch integrates by the user",
    async () => {
      const team = required(state.team)
      const owner = required(team.owners[AREA_1])
      await until(async () => !(await active(team.server)).has(team.main), "the main did not go idle")
      await team.server.turn(owner, "이번엔 내가 직접 고칠게")
      await directWorkOf(team, AREA_1)
      write(required(team.folders[AREA_1]), { "src/quiet.ts": "export const quiet = 1\n" })
      commit(required(team.folders[AREA_1]), "quiet direct work")
      const seen = (await updates(team)).length
      await team.server.turn(owner, '[voice area {"action":"resume","area":"area-1"}]')
      const handed = (await outputs(team, owner)).at(-1)
      expect(handed).toMatchObject({ ok: true })
      expect(String(handed?.text)).toContain("메인에게 넘겼습니다. 기다리던 메인 요청 0개가")
      await until(
        async () => (await areaOf(team, AREA_1)).directWork === undefined,
        "the owner's hand-back did not end the hold",
      )
      const update = await nextUpdate(team, seen)
      expect(update.reasons).toContain("handed")
      expect(update.text).toContain("그동안 보고 없음")
      expect(update.text).toContain("본 코드에 없는 저장 지점")
      // The next stretch: the owner integrates at once in the run the user opened there, by the user.
      await until(async () => !(await active(team.server)).has(team.main), "the main did not go idle")
      await team.server.turn(owner, "다시 직접 할게")
      await directWorkOf(team, AREA_1)
      const before = new Set(integrateOps(team, AREA_1).map((op) => op.id))
      await team.server.turn(owner, "[integrate area-1]")
      const started = (await outputs(team, owner)).at(-1)
      expect(started).toMatchObject({ ok: true })
      expect(started?.plan).toBeUndefined()
      const op = required(integrateOps(team, AREA_1).find((item) => !before.has(item.id)))
      expect(op.by).toBe("user")
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: false })
      await until(
        async () => (await areaOf(team, AREA_1)).directWork === undefined,
        "the button did not end the hold",
      )
    },
    STEP_TIMEOUT,
  )

  test(
    "an integration the main started before the stretch waits until the hand-back, then goes in",
    async () => {
      const team = required(state.team)
      const owner = required(team.owners[AREA_2])
      // The integration before and its team update settle first: a user message to a busy main steers its run.
      await quiet(team)
      write(required(team.folders[AREA_2]), { "src/two.ts": "export const two = 2\n" })
      const source = commit(required(team.folders[AREA_2]), "area 2 work")
      const seen = (await updates(team)).length
      await team.server.turn(team.main, "[dispatch area-2 [report ready 둘째 영역 준비됨]]")
      await until(
        async () => (await areaOf(team, AREA_2)).candidate?.sha === source && !(await active(team.server)).has(owner),
        "area 2 never reported ready",
        STEP_TIMEOUT,
      )
      // The ready wakes the main; its woken turn ends before the user writes to it.
      await waitValue(
        async () => ((await updates(team)).slice(seen).some((update) => update.reasons.includes("ready")) ? true : undefined),
        "the ready never reached the main",
        SETTLE * 3,
      )
      await quiet(team)
      const latest = () => integrations(db(team), team.teamID).findLast((item) => item.areaID === AREA_2)
      // A sub-agent that answers late keeps the main running, so the integration meets the home in use and waits.
      await team.server.server.prompt(team.main, "[integrate area-2] [subagent general [slow 25000]]")
      const waiting = await waitValue(
        async () => {
          const found = latest()
          return found?.state === "waiting" && found.waiting?.why === "in-use" ? found : undefined
        },
        "the integration never waited for the home",
        STEP_TIMEOUT,
      )
      await team.server.turn(owner, "여기서 잠깐 직접 볼게")
      const held = await directWorkOf(team, AREA_2)
      expect(held.since).toBeGreaterThan(waiting.createdAt)
      await team.server.server.waitIdle(team.main)
      // The home is free now; the recheck leaves the held area's integration waiting.
      await Bun.sleep(RECHECK)
      expect(latest()).toMatchObject({ id: waiting.id, state: "waiting" })
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_2, on: false })
      await until(async () => latest()?.state === "done", "the integration never went in after the hand-back", STEP_TIMEOUT)
      expect(latest()?.id).toBe(waiting.id)
    },
    STEP_TIMEOUT,
  )

  test(
    "a restart mid-stretch keeps the hold; the main's take-back in a run the restart cut is a plan; yes takes it back",
    async () => {
      const team = required(state.team)
      const owner = required(team.owners[AREA_1])
      await quiet(team)
      await team.server.turn(owner, "한 번 더 직접 작업")
      await directWorkOf(team, AREA_1)
      await team.server.turn(team.main, "[dispatch area-1 [report done 재시작 뒤의 요청]]")
      const waiting = required(waitingOf(team, AREA_1)[0])
      // The user writes to the main; the server restarts while that run waits for the model, so no idle mark follows
      // the user's message.
      await team.server.server.prompt(team.main, "[slow 20000] 화면 영역을 이제 메인이 맡아 줘")
      await until(async () => (await active(team.server)).has(team.main), "the main never started")
      await team.server.restart()
      expect(await areaOf(team, AREA_1)).toHaveProperty("directWork")
      expect(waitingOf(team, AREA_1).map((item) => item.id)).toEqual([waiting.id])
      // Core's restart recovery runs only in the managed service; this server is `serve --stdio`, so a synthetic notice
      // continues the cut run (as own-omo's restart test does). Its take-back is still in the run the user opened, but
      // the user's word to the main before the restart is not remembered: a plan.
      await team.server.server.call("POST", `/api/session/${team.main}/synthetic`, {
        body: {
          text: '서버가 다시 켜졌습니다. [voice area {"action":"resume","area":"area-1"}]',
          description: "Continuing after restart",
          resume: true,
        },
      })
      await until(
        async () => (await outputs(team, team.main)).at(-1)?.plan === true,
        "the resumed run never answered the take-back",
        STEP_TIMEOUT,
      )
      await team.server.server.waitIdle(team.main)
      expect(lastText(await outputs(team, team.main))).toContain("사용자가 직접 작업 중인 영역을 메인이 넘겨받습니다.")
      expect(await areaOf(team, AREA_1)).toHaveProperty("directWork")
      const seen = (await updates(team)).length
      await team.server.turn(team.main, '응 넘겨받아 [voice area {"action":"resume","area":"area-1"} +token=last]')
      expect(lastText(await outputs(team, team.main))).toStartWith("메인이 넘겨받음(")
      expect(await areaOf(team, AREA_1)).not.toHaveProperty("directWork")
      await until(
        async () => dispatches(db(team), team.teamID).find((item) => item.id === waiting.id)?.state === "sent",
        "the waiting request never went in after the take-back",
        STEP_TIMEOUT,
      )
      // `taken` wakes nobody: the main took it back itself.
      await Bun.sleep(SETTLE)
      expect((await updates(team)).slice(seen).filter((update) => update.reasons.includes("taken"))).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a message while the owner serves the main's request steers it: no hold, and its blocked report wakes the main",
    async () => {
      const team = required(state.team)
      const owner = required(team.owners[AREA_2])
      await quiet(team)
      const seen = (await updates(team)).length
      // The owner's first reply waits, so the user's message arrives while it serves the request.
      await team.server.server.prompt(team.main, "[dispatch area-2 [slow 15000] [report blocked 메인의 결정이 필요합니다]]")
      await until(async () => (await active(team.server)).has(owner), "the owner never started the request")
      await team.server.server.prompt(owner, "버튼은 파란색으로 해 줘")
      await team.server.server.waitIdle(owner)
      expect(await areaOf(team, AREA_2)).not.toHaveProperty("directWork")
      expect(String((await areaOf(team, AREA_2)).direct?.sessionID)).toBe(owner)
      const update = await waitValue(
        async () => (await updates(team)).slice(seen).find((item) => item.reasons.includes("blocked")),
        "the blocked report never woke the main",
        SETTLE * 3,
      )
      expect(update.text).toContain("메인의 결정이 필요합니다")
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

/** The area's `directWork` once the prompt hook (detached) wrote it. */
async function directWorkOf(team: Team, areaID: OwnTeam.AreaID) {
  return waitValue(async () => (await areaOf(team, areaID)).directWork, `${areaID} was never held`)
}

/** No conversation runs, and none starts again within the wake debounce (a pending team update went in). */
async function quiet(team: Team) {
  await until(async () => (await active(team.server)).size === 0, "the team did not go idle", STEP_TIMEOUT)
  await Bun.sleep(SETTLE)
  await until(async () => (await active(team.server)).size === 0, "the team did not go idle", STEP_TIMEOUT)
}

function waitingOf(team: Team, areaID: OwnTeam.AreaID) {
  return dispatches(db(team), team.teamID).filter((item) => item.areaID === areaID && item.state === "waiting")
}

function integrateOps(team: Team, areaID: OwnTeam.AreaID) {
  return ops(db(team), team.teamID).filter((op) => op.kind === "integrate" && op.areaID === areaID)
}

async function entry(team: Team, sessionID: string, key: string) {
  const found = (await instructionEntries(team.server.server, sessionID)).find((item) => item.key === key)
  return typeof found?.value === "string" ? found.value : JSON.stringify(found?.value ?? "")
}

/** The main's LLM calls so far. */
function mainCalls(team: Team) {
  return ofSession(team.server.fakes.codex.requests, team.main).length
}

/** The team tools' answers in a conversation, oldest first (the JSON text of each execute call's result). */
async function outputs(team: Team, sessionID: string): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  const parts = await toolParts(team.server.server, sessionID, "execute")
  return parts.flatMap((part) => {
    const state: Readonly<Record<string, unknown>> = { ...part.state }
    const content = Array.isArray(state.content) ? state.content : []
    return content.flatMap((item: unknown) => {
      const value = isRecord(item) && typeof item.text === "string" ? parse(item.text) : undefined
      return isRecord(value) && "ok" in value ? [value] : []
    })
  })
}

function lastText(list: ReadonlyArray<Readonly<Record<string, unknown>>>) {
  return String(list.at(-1)?.text ?? "")
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parse(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

/** The team updates in the main's conversation, oldest first. */
/**
 * The main's team updates, oldest first, over its whole history. Not the message list's first page: it holds the
 * newest 50, so once the main had more, an older update leaving the page hid a new one from the `slice(seen)` counts
 * (the blocked-report test failed so in `test:e2e:full`, 2026-11-19).
 */
async function updates(team: Team) {
  return (await everyMessage(team, team.main)).flatMap((message) => {
    const update = isRecord(message.metadata) ? message.metadata[OwnTeam.UPDATE_META] : undefined
    if (message.type !== "synthetic" || !isRecord(update)) return []
    const reasons = Array.isArray(update.reasons) ? update.reasons.map(String) : []
    return [{ text: String(message.text), reasons }]
  })
}

async function everyMessage(team: Team, sessionID: string): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  const read = async (cursor: string | undefined): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> => {
    const page = await team.server.server.call("GET", `/api/session/${sessionID}/message`, {
      query: cursor === undefined ? { limit: "200", order: "asc" } : { limit: "200", cursor },
    })
    const data = isRecord(page) && Array.isArray(page.data) ? page.data.filter(isRecord) : []
    const next = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined
    return data.length > 0 && typeof next === "string" ? [...data, ...(await read(next))] : data
  }
  return read(undefined)
}

async function nextUpdate(team: Team, seen: number) {
  return waitValue(async () => (await updates(team))[seen], `team update #${seen + 1} never came`, SETTLE * 3)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

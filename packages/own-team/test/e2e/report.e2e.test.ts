// TG8 보고와 메인 깨우기 on a real server (06 §11.3, §5.5–5.7, §2.6 (c)): a team of three areas on F1, six main requests
// with ten progress reports, then done, ready, blocked, a failed run and a question waiting. The team main is woken
// only by the "yes" events of the §5.6 table, at most one team update waits in its inbox, events that arrive meanwhile
// go into the next update, and the wake timer survives every Location (and own.team's controller) going away: it is
// computed again from KV when the next instance starts, without waking idle owner Locations.
//
// Verdicts: the main's model requests on the fake (its LLM calls), the team updates in its conversation (metadata
// `own.team.update {seq, reasons}`), its inbox rows, the loaded Locations (`GET /api/debug/location`).
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import {
  BOOT_TIMEOUT,
  MODEL,
  active,
  dispatches,
  enableTeam,
  evict,
  locations,
  messages,
  permissions,
  reply,
  same,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { inbox, ofSession } from "./inspect.js"

const STEP_TIMEOUT = 300_000
/** The wake debounce (06 §5.6 묶기: 30 s) and a margin. */
const DEBOUNCE = 30_000
const SETTLE = DEBOUNCE + 8_000
const AREA = ["ar_area-1", "ar_area-2", "ar_area-3"].map((id) => OwnTeam.AreaID.make(id))

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly owners: ReadonlyArray<string>
  readonly folders: ReadonlyArray<string>
}

describe("TG8 reports and waking the main (three areas, F1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    // A short linger: once every Location is gone, the controller closes (06 §2.6) within the test's time.
    const server = await startTeamServer({ name: "report", teamOptions: { lingerSeconds: 1 } })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 3]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = {
      server,
      teamID: team.id,
      main: team.main.sessionID,
      owners: enabled.view.areas.map((area) => required(area.owner.sessionID ?? undefined)),
      folders: enabled.view.areas.map((area) => area.directory),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "six requests and ten progress reports: no team update, no main call",
    async () => {
      const team = required(state.team)
      await team.server.turn(
        team.main,
        [
          "[dispatch area-1 [report progress 1-1] [report progress 1-2]]",
          "[dispatch area-1 [report progress 1-3] [report progress 1-4]]",
          "[dispatch area-2 [report progress 2-1] [report progress 2-2]]",
          "[dispatch area-2 [report progress 2-3]]",
          "[dispatch area-3 [report progress 3-1] [report progress 3-2]]",
          "[dispatch area-3 [report progress 3-3]]",
        ].join(" "),
      )
      const calls = mainCalls(team)
      await until(
        async () => {
          const items = dispatches(db(team), team.teamID)
          return items.length === 6 && items.every((item) => item.state === "sent") && (await idle(team))
        },
        "the six requests did not finish",
        STEP_TIMEOUT,
      )
      await Bun.sleep(SETTLE)
      expect(updates(await messages(team.server, team.main))).toEqual([])
      expect(mainCalls(team)).toBe(calls)
    },
    STEP_TIMEOUT,
  )

  test(
    "the last open request reported done: one update (모두 끝남) within 2k tokens, one main call",
    async () => {
      const team = required(state.team)
      await team.server.turn(
        team.main,
        "[dispatch area-1 [report done 1 끝]] [dispatch area-2 [report done 2 끝]] [dispatch area-3 [report done 3 끝]]",
      )
      const calls = mainCalls(team)
      const update = await nextUpdate(team, 0)
      expect(update.reasons).toContain("all-done")
      // 2k tokens at most (06 §5.6); the fake counts four characters a token, Korean is denser, so two.
      expect(update.text.length / 2).toBeLessThanOrEqual(2_000)
      for (const name of ["영역 1", "영역 2", "영역 3"]) expect(update.text).toContain(name)
      await until(async () => !(await active(team.server)).has(team.main), "the main never took the update")
      await Bun.sleep(3_000)
      expect(mainCalls(team)).toBe(calls + 1)
      expect(updates(await messages(team.server, team.main))).toHaveLength(1)
    },
    STEP_TIMEOUT,
  )

  test(
    "ready while an update waits in the busy main's inbox: one undelivered at most; blocked goes into the next one",
    async () => {
      const team = required(state.team)
      const seen = updates(await messages(team.server, team.main)).length
      // The user keeps the main busy, so the next update stays in its inbox.
      await team.server.server.prompt(team.main, "[slow 90000] 사용자와 메인의 긴 대화")
      await until(async () => (await active(team.server)).has(team.main), "the main never started")
      await team.server.turn(required(team.owners[0]), "[report ready 반영 준비됨]")
      const queued = await waitValue(
        async () => {
          const rows = inbox(db(team), team.main).filter((row) => hasUpdate(row.payload))
          return rows.length > 0 ? rows : undefined
        },
        "the ready update never reached the main's inbox",
        SETTLE * 2,
      )
      expect(queued).toHaveLength(1)
      await team.server.turn(required(team.owners[1]), "[report blocked 다른 영역의 결정이 필요합니다]")
      await Bun.sleep(SETTLE)
      // Still only one undelivered update while the main works.
      expect(inbox(db(team), team.main).filter((row) => hasUpdate(row.payload))).toHaveLength(1)
      const first = await nextUpdate(team, seen)
      expect(first.reasons).toContain("ready")
      const second = await nextUpdate(team, seen + 1)
      expect(second.reasons).toContain("blocked")
      expect(second.text).toContain("다른 영역의 결정이 필요합니다")
    },
    STEP_TIMEOUT * 2,
  )

  test(
    "a failed run wakes the main; a question waiting does not",
    async () => {
      const team = required(state.team)
      const seen = updates(await messages(team.server, team.main)).length
      // A question: the owner asks before a shell command (approval mode 묻기); nothing wakes the main for it.
      const asking = required(team.owners[1])
      await team.server.server.prompt(asking, "[shell echo e2e-질문]")
      const request = await waitValue(
        async () => (await permissions(team.server, asking))[0],
        "the owner never asked",
        60_000,
      )
      await Bun.sleep(SETTLE)
      expect(updates(await messages(team.server, team.main))).toHaveLength(seen)
      await reply(team.server, asking, String(request.id), "reject")
      await team.server.server.waitIdle(asking)
      // A failed run of an owner wakes it.
      await team.server.turn(required(team.owners[2]), "[fail]")
      const update = await nextUpdate(team, seen)
      expect(update.reasons).toContain("failed")
    },
    STEP_TIMEOUT,
  )

  test(
    "every Location gone with a wake pending: the next instance computes the timer again and sends it; idle owners stay down",
    async () => {
      const team = required(state.team)
      await until(async () => (await active(team.server)).size === 0, "the team did not go idle", STEP_TIMEOUT)
      const seen = updates(await messages(team.server, team.main)).length
      await team.server.turn(required(team.owners[0]), "[report ready 두 번째 반영 준비]")
      // Every Location goes; own.team's instances end and, after the linger, its controller closes. A request still in
      // flight from the owner's turn (own.team reading the main's folder) can load a folder again right after its
      // eviction on a loaded PC (2.2.6-own.6 release run): evict until none is loaded and none comes back for a second.
      const gone = async () => {
        for (const directory of await locations(team.server)) await evict(team.server, directory)
        if ((await locations(team.server)).length > 0) return false
        await Bun.sleep(1_000)
        return (await locations(team.server)).length === 0
      }
      await until(gone, "a Location stayed loaded", STEP_TIMEOUT)
      await Bun.sleep(SETTLE)
      // Nothing listened while the timer was due: no update yet.
      expect(updates(await messages(team.server, team.main))).toHaveLength(seen)
      // A Location starts again (any own.team call at the control location): the controller resumes the timer.
      expect((await team.server.team("health", {})).guard).toBe("ok")
      const update = await nextUpdate(team, seen)
      expect(update.reasons).toContain("ready")
      await until(async () => !(await active(team.server)).has(team.main), "the main never took the update")
      await Bun.sleep(5_000)
      // own.team's reads (logs, inboxes, active sessions) never started an idle owner's Location.
      const now = await locations(team.server)
      for (const folder of team.folders) expect(now.some((item) => same(item, folder))).toBe(false)
    },
    STEP_TIMEOUT * 2,
  )
})

// ---------------------------------------------------------------------------------------------------------------

function db(team: Team) {
  return team.server.server.paths.database
}

/** The main's LLM calls so far ({@link ofSession}). */
function mainCalls(team: Team) {
  return ofSession(team.server.fakes.codex.requests, team.main).length
}

async function idle(team: Team) {
  const running = await active(team.server)
  return (
    team.owners.every((owner) => !running.has(owner)) &&
    team.owners.every((owner) => inbox(db(team), owner).length === 0)
  )
}

function hasUpdate(payload: unknown) {
  return isRecord(payload) && isRecord(payload.metadata) && OwnTeam.UPDATE_META in payload.metadata
}

/** The team updates in the main's conversation, oldest first. */
function updates(list: ReadonlyArray<Readonly<Record<string, unknown>>>) {
  return list.flatMap((message) => {
    const update = isRecord(message.metadata) ? message.metadata[OwnTeam.UPDATE_META] : undefined
    if (message.type !== "synthetic" || !isRecord(update)) return []
    const reasons = Array.isArray(update.reasons) ? update.reasons.map(String) : []
    return [{ text: String(message.text), reasons }]
  })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The update after the first `seen` ones, once the main's conversation has it. */
async function nextUpdate(team: Team, seen: number) {
  return waitValue(
    async () => updates(await messages(team.server, team.main))[seen],
    `team update #${seen + 1} never came`,
    SETTLE * 3,
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

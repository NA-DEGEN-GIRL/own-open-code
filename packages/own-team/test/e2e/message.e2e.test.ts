// Area-to-area messages (06 §5.8, 2026-10-16) on a real server: a team of two areas on F1; the scripted main sends
// area-1 a request whose owner asks area-2 with `team_message`, area-2's owner replies by the ask's id, and the reply
// comes back to area-1's owner as a turn of its own, all without waking the main. Then a note for area-2 waits for the
// next main request to it and goes after its envelope, and a watch of area-1 on area-2's ready report brings area-1 one
// notice turn. Verdicts come from durable state: the dispatch records and the talk state in KV, and the conversations'
// messages.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import {
  BOOT_TIMEOUT,
  MODEL,
  dispatches,
  enableTeam,
  messages,
  startTeamServer,
  until,
  type TeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"

/** Each step runs several scripted turns; set here, not by a preload. */
const STEP_TIMEOUT = 300_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const AREA_2 = OwnTeam.AreaID.make("ar_area-2")

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly one: string
  readonly two: string
}

describe("area messages on a real server (two areas, F1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "message" })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    const owner = (areaID: OwnTeam.AreaID) =>
      required(enabled.view.areas.find((item) => item.id === areaID)?.owner.sessionID ?? undefined)
    state.team = { server, teamID: team.id, main: team.main.sessionID, one: owner(AREA_1), two: owner(AREA_2) }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "an ask from area-1 reaches area-2 as an area envelope, the reply comes back to area-1 as a turn, the main sleeps",
    async () => {
      const team = required(state.team)
      const updates = async () => (await messages(team.server, team.main)).filter(isUpdate).length
      const before = await updates()
      await team.server.turn(
        team.main,
        "[dispatch area-1 [message ask area-2 [message reply +id=last count는 그대로 둡니다] 필드 이름을 바꾸나요?]]",
      )
      // area-1 asked, area-2 answered, the answer came back to area-1.
      await until(async () => (await texts(team, team.one)).some((text) => text.includes('kind="reply"')), "no reply")
      const asked = (await texts(team, team.two)).find((text) => text.startsWith('<dispatch from="area"'))
      expect(required(asked).split("\n")[0]).toMatch(
        /^<dispatch from="area" sender="[^"]+" kind="ask" id="dp_[^"]+" area="/,
      )
      const reply = required((await texts(team, team.one)).find((text) => text.includes('kind="reply"')))
      expect(OwnTeamText.unwrap(reply)).toBe("count는 그대로 둡니다")
      const records = dispatches(team.server.server.paths.database, team.teamID)
      expect(
        records
          .filter((item) => item.from === "area")
          .map((item) => item.kind)
          .toSorted(),
      ).toEqual(["ask", "reply"])
      // Nothing of it woke the main: no new team update while the areas talked.
      await team.server.server.waitIdle(team.one)
      expect(await updates()).toBe(before)

      // A waking report carries the audit lines in the main's next update.
      await team.server.turn(team.main, "[dispatch area-2 [report blocked 메인의 결정이 필요합니다]]")
      await until(async () => (await updates()) > before, "no team update")
      const update = (await messages(team.server, team.main)).filter(isUpdate).at(-1)
      expect(String(update?.text)).toContain("영역 메시지 2건:")
    },
    STEP_TIMEOUT,
  )

  test(
    "a note to area-2 wakes nothing and goes with the next main request after its envelope",
    async () => {
      const team = required(state.team)
      const before = (await texts(team, team.two)).length
      await team.server.turn(team.main, "[dispatch area-1 [message note area-2 가격 표시는 내일 바뀝니다]]")
      await until(async () => talkNotes(team).length === 1, "the note was not held")
      await team.server.server.waitIdle(team.one)
      expect((await texts(team, team.two)).length).toBe(before)
      await team.server.turn(team.main, "[dispatch area-2 [report progress 쪽지를 읽었습니다]]")
      await until(
        async () => (await texts(team, team.two)).some((text) => OwnTeamText.notes(text).length > 0),
        "the note did not go with the request",
      )
      const sent = required((await texts(team, team.two)).find((text) => OwnTeamText.notes(text).length > 0))
      expect(OwnTeamText.notes(sent)[0]).toContain("가격 표시는 내일 바뀝니다")
      expect(talkNotes(team)).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a ready watch of area-1 on area-2 brings one notice turn when area-2 reports ready",
    async () => {
      const team = required(state.team)
      await team.server.turn(team.main, "[dispatch area-1 [message watch area-2 +on=ready 그때 저장 형식을 맞춘다]]")
      await until(async () => watches(team) === 1, "no watch")
      await team.server.server.waitIdle(team.one)
      await team.server.turn(team.main, "[dispatch area-2 [report ready 준비됐습니다]]")
      await until(
        async () => (await texts(team, team.one)).some((text) => text.includes('<dispatch from="team" kind="notice"')),
        "no notice",
      )
      const notice = required(
        (await texts(team, team.one)).find((text) => text.includes('<dispatch from="team" kind="notice"')),
      )
      expect(OwnTeamText.unwrap(notice)).toContain("반영 준비를 마쳤습니다")
      expect(watches(team)).toBe(0)
    },
    STEP_TIMEOUT,
  )
})

/** The user texts of a conversation, oldest first. */
async function texts(team: Team, sessionID: string) {
  return (await messages(team.server, sessionID)).flatMap((message) =>
    message.type === "user" && typeof message.text === "string" ? [message.text] : [],
  )
}

function talk(team: Team) {
  const value = kv(team.server.server.paths.database)[`talk:${team.teamID}`]
  return isRecord(value) ? value : {}
}

function talkNotes(team: Team) {
  const notes = talk(team).notes
  return Array.isArray(notes) ? notes : []
}

function watches(team: Team) {
  const items = talk(team).watches
  return Array.isArray(items) ? items.length : 0
}

function isUpdate(message: Readonly<Record<string, unknown>>) {
  return message.type === "synthetic" && isRecord(message.metadata) && OwnTeam.UPDATE_META in message.metadata
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing")
  return value
}

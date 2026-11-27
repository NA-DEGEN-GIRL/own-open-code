// Area peers (동료, 06 §1.2, §2.4, §2.7, §5.1, §5.4–5.6; approved 2026-10-09) on a real server: a team of one area on
// F1; the user opens a second conversation in the area's folder and registers it as a peer (`area.peer.add`); the
// scripted main sends a request to the peer (`team_dispatch{member}`), the peer reports `done` with its team tools
// (attached at that first request), then the main sends a request to the owner. Verdicts come from durable state: the
// dispatch records and the digest in KV, the conversations' messages, the inbox events on the event stream, the
// registry and the session rows.
//
// - Registering writes nothing to the conversation; the first main request to it attaches the owner's allows and the
//   peer role, then goes in with `to` in the envelope.
// - Typing in the peer conversation is recorded for the peer: the team update's area line does not say the user drives
//   the owner's area (the mislabel this feature fixes), the peer's line does.
// - One request at a time for the whole folder: a request to the owner sent while the peer works on its own waits and
//   goes in only after the peer's run ended (no second main request in the folder).
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { instructionEntries, toolParts } from "../../../own-accounts/test/e2e-kit"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Permissions } from "../../src/tools/permissions.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  active,
  dispatches,
  enableTeam,
  enqueued,
  mainRequests,
  sessionRows,
  startTeamServer,
  until,
  type TeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"

const STEP_TIMEOUT = 240_000
const AREA = OwnTeam.AreaID.make("ar_area-1")

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly owner: string
  readonly folder: string
}

describe("area peers (동료) on a real server (one area, F1)", () => {
  const state: { team?: Team; peer?: string } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "peers" })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 1]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    const area = required(enabled.view.areas.find((item) => item.id === AREA))
    state.team = {
      server,
      teamID: team.id,
      main: team.main.sessionID,
      owner: required(area.owner.sessionID ?? undefined),
      folder: area.directory,
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "registering a conversation of the area's folder writes nothing to it",
    async () => {
      const team = required(state.team)
      const peer = await team.server.createSession({ directory: team.folder, title: "리뷰 대화", model: MODEL["01"] })
      state.peer = peer
      const before = row(team, peer)
      const added = await team.server.team("area.peer.add", {
        teamID: team.teamID,
        areaID: AREA,
        sessionID: OwnTeam.Peer.fields.sessionID.make(peer),
        label: "리뷰어",
        role: "변경을 읽고 위험한 곳을 짚는다",
      })
      expect(added.peer).toMatchObject({ key: "peer", label: "리뷰어", attached: false, origin: "registered" })
      expect(added.area.peers?.map((item) => String(item.sessionID))).toEqual([peer])
      expect(row(team, peer).permission).toEqual(before.permission)
      // The owner is no peer, and a conversation is registered once.
      await expect(
        team.server.team("area.peer.add", {
          teamID: team.teamID,
          areaID: AREA,
          sessionID: OwnTeam.Peer.fields.sessionID.make(team.owner),
          label: "x",
          role: "",
        }),
      ).rejects.toThrow("peer_invalid")
    },
    STEP_TIMEOUT,
  )

  test(
    "typing in the peer conversation is the peer's direct talk, not the owner's area driven by the user",
    async () => {
      const team = required(state.team)
      const peer = required(state.peer)
      await team.server.turn(peer, "사용자가 동료에게 직접: 이 부분을 봐 주세요")
      const view = await team.server.team("team.get", { directory: required(team.server.project) })
      const area = required(view.areas.find((item) => item.id === AREA))
      expect(area.direct).toBeUndefined()
      expect(area.peers?.[0]?.direct?.at).toBeGreaterThan(0)

      await team.server.turn(team.main, "[status area-1]")
      const status = JSON.stringify((await toolParts(team.server.server, team.main, "execute")).at(-1))
      // The direct talk is on the peer's line under the area's, never on the area's own line (newlines are escaped in
      // the JSON text, so the area line ends at the next backslash).
      expect(status).toMatch(/· 동료 리뷰어: 쉬는 중 · 사용자가 직접 대화함/)
      const start = status.indexOf(`- ${area.name}: `)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(status.slice(start).split("\\")[0]).not.toContain("사용자가 직접 대화함")
    },
    STEP_TIMEOUT,
  )

  test(
    "the main's request to the peer attaches it and goes in with `to`; the peer reports done; then the owner's goes",
    async () => {
      const team = required(state.team)
      const peer = required(state.peer)
      await team.server.turn(team.main, "[dispatch area-1 +member=리뷰어 [report done 다 읽었습니다]]")
      await until(async () => (await mainRequests(team.server, peer)).length === 1, "the peer got no main request")
      await team.server.server.waitIdle(peer)
      const [request] = await mainRequests(team.server, peer)
      expect(String(required(request).text).split("\n")[0]).toMatch(
        /^<dispatch from="main" to="peer" id="dp_[^"]+" area="/,
      )
      // Attached at that first request: the owner's allows and the peer role.
      const rules = row(team, peer).permission.filter((rule) => String(rule.action).startsWith("team."))
      expect(rules).toEqual(Permissions.rules("owner").map((rule) => ({ ...rule })))
      expect((await instructionEntries(team.server.server, peer)).map((entry) => entry.key)).toContain(
        RoleInstructions.PEER,
      )
      // Its `done` is folded under it; the owner's side of the area got nothing.
      await until(async () => digestOf(team).areas[AREA]?.peers?.peer?.reports.done !== undefined, "no peer report")
      expect(digestOf(team).areas[AREA]?.reports.done).toBeUndefined()

      const before = (await mainRequests(team.server, team.owner)).length
      await team.server.turn(team.main, "[dispatch area-1 [report progress 담당이 이어 받음]]")
      await until(
        async () => (await mainRequests(team.server, team.owner)).length === before + 1,
        "the owner got no main request",
      )
      await team.server.server.waitIdle(team.owner)
      const sent = dispatches(team.server.server.paths.database, team.teamID)
      expect(sent.filter((item) => item.to === "peer").map((item) => item.state)).toEqual(["sent"])
      expect(sent.filter((item) => item.to === undefined).map((item) => item.state)).toEqual(["sent"])
    },
    STEP_TIMEOUT,
  )

  test(
    "one at a time for the whole folder: the owner's request waits while the peer works and goes in after it",
    async () => {
      const team = required(state.team)
      const peer = required(state.peer)
      const owner = (await mainRequests(team.server, team.owner)).length
      await team.server.server.prompt(
        team.main,
        "[dispatch area-1 +member=peer [slow 6000] [report done 두 번째]] [dispatch area-1 [report progress 기다린 일]]",
      )
      await until(
        async () =>
          (await active(team.server)).has(peer) &&
          dispatches(team.server.server.paths.database, team.teamID).some(
            (item) => item.text === "[report progress 기다린 일]" && item.state === "waiting",
          ),
        "the peer never started, or the owner's request did not wait",
      )
      const outbox = await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA })
      expect(outbox.items.map((item) => item.text)).toEqual(["[report progress 기다린 일]"])
      expect(outbox.why).toBe("busy")
      expect(await mainRequests(team.server, team.owner)).toHaveLength(owner)

      await team.server.server.waitIdle(team.main)
      await team.server.server.waitIdle(peer)
      await until(
        async () => (await mainRequests(team.server, team.owner)).length === owner + 1,
        "the owner's request never went in",
      )
      // Never a second main request in the folder: the owner's went in after the peer's run ended.
      const events = team.server.events.events
      const ended = events.findLastIndex(
        (event) => event.type === "session.execution.succeeded" && event.data.sessionID === peer,
      )
      const sentToOwner = enqueued(team.server, team.owner).findLast((item) => OwnTeam.DISPATCH_META in item.metadata)
      expect(required(sentToOwner).index).toBeGreaterThan(ended)
      const peerRequests = enqueued(team.server, peer).filter((item) => OwnTeam.DISPATCH_META in item.metadata)
      expect(peerRequests.map((item) => item.delivery)).toEqual(["queue", "queue"])
    },
    STEP_TIMEOUT,
  )
})

/** A session's row in core's database. */
function row(team: Team, sessionID: string) {
  return required(sessionRows(team.server.server.paths.database).find((item) => item.id === sessionID))
}

/** The team's digest record in KV (06 §5.6). */
function digestOf(team: Team) {
  // SAFETY (test): the digest record's shape (`report/fold.ts` State), read only for the fields checked.
  return kv(team.server.server.paths.database)[`digest:${team.teamID}`] as {
    readonly areas: Readonly<
      Record<
        string,
        {
          readonly reports: { readonly done?: unknown }
          readonly peers?: Readonly<Record<string, { readonly reports: { readonly done?: unknown } }>>
        }
      >
    >
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

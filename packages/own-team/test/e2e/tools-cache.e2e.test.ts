// TG16 도구 목록과 캐시 (sessions that were not adopted; 06 §11.3, §2.8; 07 PG4) on real servers: one with own-accounts
// and own-team (a team of two areas on F1) and one with own-accounts only, on one set of fakes. Team tools are Code
// Mode tools behind the fixed `execute`, so the request's tool definitions never change, and the catalog lists them
// only for the team main and the owners, from their first request on (delta 0).
//
// - A session that is not a team session, even in the team's own folder, sends the same tool definitions and Code Mode
//   catalog as on a server without own-team.
// - The main's and an owner's tool definitions and catalog stay the same over all their requests; the owner's later
//   steps read their prefix from the prompt cache (≥ 0.9 of the prompt from the second step).
// - A child of an owner that calls a team tool reads a refusal, never an error.
// - Re-sending the team context to the bindings (an area preset with a pinned paid target) leaves an owner's guidance
//   entry unchanged; own-accounts records no `toolset_changed` (its D10 detector compares every own slot primary
//   request's tool definitions and system; own-accounts PG4 has the positive control); every team session keeps its
//   approval bundle last.
// - Adopted sessions (T2, TG16 full): a conversation taken in with 팀에 넣기 while the user changes its approval mode,
//   attached by the first main request, taken out (빼기) and taken in again then undone keeps the mode the user chose
//   with its bundle and protected-path denies last; the team allows sit in front only while it is attached; the attach
//   reaches the model once (core's catalog update), never as a tool definition or system change (no
//   `toolset_changed`), and the steps after the first read the prompt cache. Delta 0 at enable and 1 at the first
//   request on F4 is `adopt.e2e.test.ts`.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { childOf, instructionEntries, toolParts } from "../../../own-accounts/test/e2e-kit"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { commit, f1, git, write } from "../fixtures/repo.js"
import {
  ACCOUNT,
  BOOT_TIMEOUT,
  MODEL,
  alerts,
  catalogUpdates,
  enableTeam,
  opEnd,
  pin,
  presetOf,
  same,
  savePreset,
  sessionRows,
  startTeamFakes,
  startTeamServer,
  until,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"
import {
  cache,
  catalog,
  catalogHashes,
  catalogMissing,
  chained,
  ofSession,
  toolBytes,
  toolNames,
  toolsHash,
  worktrees,
} from "./inspect.js"

const STEP_TIMEOUT = 240_000
const NOT_TEAM = "팀 도구는 메인·담당 대화에서만 씁니다"
const AREA_2 = OwnTeam.AreaID.make("ar_area-2")

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly areas: ReadonlyArray<OwnTeam.AreaView>
}

describe("TG16 tool lists and the prompt cache (two areas, F1)", () => {
  const state: { fakes?: TeamFakes; team?: Team; plain?: TeamServer } = {}

  beforeAll(async () => {
    const fakes = startTeamFakes()
    state.fakes = fakes
    const [server, plain] = await Promise.all([
      startTeamServer({ name: "tools", fakes }),
      startTeamServer({ name: "tools-plain", fakes, team: false }),
    ])
    state.plain = plain
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    // The team keeps its default hold (on): the instruction counts below start at the team's creation.
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed, directHold: true })
    const team = required(enabled.view.team ?? undefined)
    state.team = { server, teamID: team.id, main: team.main.sessionID, areas: enabled.view.areas }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await Promise.all([state.team?.server.stop(), state.plain?.stop()])
    await state.fakes?.stop()
  }, 120_000)

  test(
    "a session that is not a team session, in the team's own folder, sends what it sends without own-team",
    async () => {
      const team = required(state.team)
      const fakes = required(state.fakes)
      const inTeam = await team.server.createSession({ title: "팀 폴더의 다른 대화" })
      const outside = await required(state.plain).createSession({ title: "own-team 없는 서버" })
      await Promise.all([team.server.turn(inTeam, "도구 비교 1"), required(state.plain).turn(outside, "도구 비교 2")])
      const [a, b] = [inTeam, outside].map((id) => required(ofSession(fakes.codex.requests, id)[0]))
      expect(toolNames(required(a))).toEqual(toolNames(required(b)))
      expect(toolsHash(required(a))).toBe(toolsHash(required(b)))
      expect(toolBytes(required(a))).toBe(toolBytes(required(b)))
      // Every conversation has the worktree conversation tools (06 §13.3); apart from them nothing changes.
      expect(catalog(required(a))).toContain("tools.worktree.start(")
      expect(catalog(required(a))).toContain("The catalog is complete.")
      expect(catalogMissing(required(a), required(b))).toEqual([])
      expect(catalog(required(a))).not.toContain("tools.team.")
    },
    STEP_TIMEOUT,
  )

  test(
    "the main and an owner: the same tools and catalog in every request, team tools from the first one, cached steps",
    async () => {
      const team = required(state.team)
      const fakes = required(state.fakes)
      await team.server.turn(
        team.main,
        "[status] [dispatch area-1 [report progress 하나] [report progress 둘] [report progress 셋] [status]]",
      )
      const owner = required(team.areas[0]?.owner.sessionID ?? undefined)
      await until(
        async () => ofSession(fakes.codex.requests, owner).length >= 5 && (await idle(team, owner)),
        "the owner did not finish its request",
        STEP_TIMEOUT,
      )
      for (const [id, tool] of [
        [team.main, "tools.team.dispatch("],
        [owner, "tools.team.report("],
      ] as const) {
        // A chained request (WebSocket) carries no catalog since v2.3.2: the full ones share one, the rest chain on them.
        const all = ofSession(fakes.codex.requests, id)
        const requests = all.filter((request) => catalog(request) !== undefined)
        expect(all.length).toBeGreaterThan(1)
        expect(requests.length).toBeGreaterThan(0)
        expect(all.filter((request) => catalog(request) === undefined).every(chained)).toBe(true)
        expect(new Set(all.map(toolsHash)).size).toBe(1)
        expect(catalogHashes(all).size).toBe(1)
        expect(catalog(required(requests[0]))).toContain(tool)
      }
      // The owner's steps after the first read their prefix from the cache (estimates: the ratio, not the numbers).
      const steps = ofSession(fakes.codex.requests, owner).slice(1)
      for (const request of steps) expect(cache([request]).ratio).toBeGreaterThanOrEqual(0.9)
    },
    STEP_TIMEOUT,
  )

  test(
    "an owner's child calling a team tool reads the refusal as a result",
    async () => {
      const team = required(state.team)
      const owner = required(team.areas[1]?.owner.sessionID ?? undefined)
      await team.server.turn(owner, "[subagent general [status]]")
      const call = required((await toolParts(team.server.server, owner, "subagent")).at(-1))
      const child = await childOf(team.server.server, call)
      const parts = await toolParts(team.server.server, child.id, "execute")
      expect(parts.map((part) => part.state.status)).toEqual(["completed"])
      expect(JSON.stringify(parts[0])).toContain(NOT_TEAM)
    },
    STEP_TIMEOUT,
  )

  test(
    "a new team context for every binding leaves the owners' guidance entries; no toolset change; bundles stay last",
    async () => {
      const team = required(state.team)
      const area1 = required(team.areas[0])
      const owner1 = required(area1.owner.sessionID ?? undefined)
      const before = await presetOf(team.server, owner1, area1.directory)
      const entry = (await instructionEntries(team.server.server, owner1)).find((item) => item.key === "own.preset")
      // Area 2 takes a preset that pins a paid target: the team's pinned set changes for every binding.
      const paid = await savePreset(team.server, "검토는 DeepSeek", "codex", {
        "own-review": [pin(ACCOUNT.deepseek, MODEL.deepseek.id)],
      })
      await team.server.team("area.preset", { teamID: team.teamID, areaID: AREA_2, presetID: paid })
      await until(
        async () =>
          JSON.stringify((await presetOf(team.server, owner1, area1.directory)).binding?.team?.pinned ?? []).includes(
            ACCOUNT.deepseek,
          ),
        "the owner's binding never got the new team context",
      )
      const after = await presetOf(team.server, owner1, area1.directory)
      expect(after.binding?.entryHash).toBe(before.binding?.entryHash ?? null)
      expect((await instructionEntries(team.server.server, owner1)).find((item) => item.key === "own.preset")).toEqual(
        entry,
      )
      expect(await alerts(team.server.ownHome, "toolset_changed")).toEqual([])
      for (const [sessionID, directory] of [
        [team.main, required(team.server.project)],
        ...team.areas.map((area) => [required(area.owner.sessionID ?? undefined), area.directory] as const),
      ] as const) {
        const approval = await team.server.accounts("session.approval.get", { sessionID }, directory)
        expect(approval.mode).not.toBe("custom")
      }
    },
    STEP_TIMEOUT,
  )
  test(
    "직접 작업 hold off and on again: one more instruction update in each team conversation per change, no catalog delta",
    async () => {
      const team = required(state.team)
      const fakes = required(state.fakes)
      const sessions = [team.main, ...team.areas.map((area) => required(area.owner.sessionID ?? undefined))]
      // Every request since the team's creation carried no catalog delta (the catalog is there from the first one).
      for (const id of sessions) expect(ofSession(fakes.codex.requests, id).flatMap(catalogUpdates)).toEqual([])
      for (const hold of [false, true]) {
        const before = await Promise.all(sessions.map((id) => roleUpdates(team.server, id)))
        const seen = sessions.map((id) => ofSession(fakes.codex.requests, id).length)
        await team.server.team("settings.set", { teamID: team.teamID, patch: { policy: { directHold: hold } } })
        // The main's entry is rewritten at once; an owner's before its next request. A turn of each brings them in.
        await team.server.turn(
          team.main,
          `[dispatch area-1 [report progress hold ${hold}]] [dispatch area-2 [report progress hold ${hold}]]`,
        )
        await until(
          async () =>
            (
              await Promise.all(
                sessions.map(
                  async (id, index) =>
                    ofSession(fakes.codex.requests, id).length > required(seen[index]) && (await idle(team, id)),
                ),
              )
            ).every(Boolean),
          `the team's conversations did not run after directHold ${hold}`,
          STEP_TIMEOUT,
        )
        const after = await Promise.all(sessions.map((id) => roleUpdates(team.server, id)))
        expect(after).toEqual(before.map((count) => count + 1))
        for (const [index, id] of sessions.entries())
          expect(ofSession(fakes.codex.requests, id).slice(required(seen[index])).flatMap(catalogUpdates)).toEqual([])
      }
      expect(await alerts(team.server.ownHome, "toolset_changed")).toEqual([])
    },
    STEP_TIMEOUT * 2,
  )
})

describe("TG16 adopted sessions: the approval bundle stays last through 팀에 넣기, the attach, 빼기 and 되돌리기", () => {
  const state: {
    server?: TeamServer
    teamID?: OwnTeam.TeamID
    main?: string
    feature?: string
    session?: string
  } = {}

  beforeAll(async () => {
    const layout: { feature?: string } = {}
    const server = await startTeamServer({
      name: "tools-adopt",
      project: (root) => {
        const home = f1(root).home
        layout.feature = path.join(root, "feature")
        git(home, ["worktree", "add", "-q", "-b", "feature", layout.feature])
        write(layout.feature, { "src/feature.ts": "export const feature = 1\n" })
        commit(layout.feature, "feature work")
        return home
      },
    })
    const feature = required(layout.feature)
    const session = await server.createSession({ title: "기능 대화", directory: feature, model: MODEL["01"] })
    await server.turn(session, "받아들이기 전 대화")
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 0]", sessionID: viewed, directHold: true })
    expect(enabled.view.areas).toEqual([])
    const team = required(enabled.view.team ?? undefined)
    Object.assign(state, { server, teamID: team.id, main: team.main.sessionID, feature, session })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "팀에 넣기 while the user changes the approval mode: the mode the user chose, its bundle and denies last",
    async () => {
      const server = required(state.server)
      const session = required(state.session)
      const feature = required(state.feature)
      await approval(server, session, feature, "full")
      const started = await server.team("area.adopt", { teamID: required(state.teamID), directory: feature })
      await approval(server, session, feature, "ask")
      expect((await opEnd(server, started.opID)).state).toBe("done")
      const area = await featureArea(server)
      expect(area.owner).toMatchObject({ sessionID: session, attached: false })
      expect(await approvalMode(server, session, feature)).toBe("ask")
      expect(teamRules(server, session)).toEqual([])
      expect(lastRule(server, session)).toMatchObject({ effect: "deny" })
    },
    STEP_TIMEOUT,
  )

  test(
    "the attach adds the team allows in front; the bundle stays last; the owner's later steps read the cache",
    async () => {
      const server = required(state.server)
      const session = required(state.session)
      const feature = required(state.feature)
      const seen = ofSession(server.fakes.codex.requests, session).length
      await server.turn(
        required(state.main),
        "[dispatch feature [report progress 하나] [report progress 둘] [report progress 셋]]",
      )
      await until(
        async () =>
          ofSession(server.fakes.codex.requests, session).length >= seen + 4 && (await idleOf(server, session)),
        "the adopted owner did not finish its request",
        STEP_TIMEOUT,
      )
      expect((await featureArea(server)).owner.attached).toBe(true)
      expect(teamRules(server, session)).toEqual(["team.owner", "team.member"])
      expect(
        rulesOf(server, session)
          .slice(0, 2)
          .map((rule) => rule.action),
      ).toEqual(["team.owner", "team.member"])
      expect(await approvalMode(server, session, feature)).toBe("ask")
      expect(lastRule(server, session)).toMatchObject({ effect: "deny" })
      const steps = ofSession(server.fakes.codex.requests, session).slice(seen)
      expect(steps.flatMap(catalogUpdates)).toHaveLength(1)
      for (const request of steps.slice(1)) expect(cache([request]).ratio).toBeGreaterThanOrEqual(0.9)
    },
    STEP_TIMEOUT,
  )

  test(
    "빼기 takes the team allows away and keeps the bundle last",
    async () => {
      const server = required(state.server)
      const session = required(state.session)
      const feature = required(state.feature)
      const area = await featureArea(server)
      const started = await server.team("area.unadopt", { teamID: required(state.teamID), areaID: area.id })
      expect((await opEnd(server, started.opID)).state).toBe("done")
      const view = await server.team("team.get", { directory: required(server.project) })
      expect(view.areas).toEqual([])
      expect(teamRules(server, session)).toEqual([])
      expect(await approvalMode(server, session, feature)).toBe("ask")
      expect(lastRule(server, session)).toMatchObject({ effect: "deny" })
    },
    STEP_TIMEOUT,
  )

  test(
    "되돌리기 of a 팀에 넣기 after the attach: no team allow left, the bundle last, the folder outside the team again",
    async () => {
      const server = required(state.server)
      const session = required(state.session)
      const feature = required(state.feature)
      const adopted = await server.team("area.adopt", { teamID: required(state.teamID), directory: feature })
      expect((await opEnd(server, adopted.opID)).state).toBe("done")
      const seen = ofSession(server.fakes.codex.requests, session).length
      await server.turn(required(state.main), "[dispatch feature [report progress 다시 넣었습니다]]")
      await until(
        async () => ofSession(server.fakes.codex.requests, session).length > seen && (await idleOf(server, session)),
        "the adopted owner did not run its request",
        STEP_TIMEOUT,
      )
      expect(teamRules(server, session)).toEqual(["team.owner", "team.member"])
      const undone = await server.team("op.undo", { opID: adopted.opID })
      expect((await opEnd(server, undone.opID)).state).toBe("done")
      expect((await server.team("team.get", { directory: required(server.project) })).areas).toEqual([])
      expect(teamRules(server, session)).toEqual([])
      expect(await approvalMode(server, session, feature)).toBe("ask")
      expect(lastRule(server, session)).toMatchObject({ effect: "deny" })
      expect(worktrees(feature).find((entry) => same(entry.path, feature))?.locked).toBeUndefined()
      // 팀에 넣기, the attach, 빼기 and 되돌리기 reach the model as catalog updates only.
      expect(await alerts(server.ownHome, "toolset_changed")).toEqual([])
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** The instruction updates of own.team's role entries (main or owner) in a conversation (core's `system` messages). */
async function roleUpdates(server: TeamServer, sessionID: string) {
  const list = await server.server.messages(sessionID)
  return list.filter((message) => {
    const sources = message.type === "system" && isRecord(message.metadata) ? message.metadata.instructionSources : []
    // Core names an entry put through its API `api/<key>`.
    return (
      Array.isArray(sources) &&
      sources.some((key) => key === `api/${RoleInstructions.MAIN}` || key === `api/${RoleInstructions.OWNER}`)
    )
  }).length
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function featureArea(server: TeamServer) {
  const view = await server.team("team.get", { directory: required(server.project) })
  return required(view.areas[0])
}

async function approval(server: TeamServer, sessionID: string, directory: string, mode: "ask" | "full") {
  await server.accounts("session.approval.set", { sessionID, mode }, directory)
}

async function approvalMode(server: TeamServer, sessionID: string, directory: string) {
  return (await server.accounts("session.approval.get", { sessionID }, directory)).mode
}

function rulesOf(server: TeamServer, sessionID: string) {
  return required(sessionRows(server.server.paths.database).find((row) => row.id === sessionID)).permission
}

/** The session's own.team rule actions, in order. */
function teamRules(server: TeamServer, sessionID: string) {
  return rulesOf(server, sessionID).flatMap((rule) =>
    typeof rule.action === "string" && rule.action.startsWith("team.") ? [rule.action] : [],
  )
}

/** The session's last rule: one of the protected-path denies that close own-accounts' bundle. */
function lastRule(server: TeamServer, sessionID: string) {
  return rulesOf(server, sessionID).at(-1)
}

async function idleOf(server: TeamServer, sessionID: string) {
  const messages = await server.server.messages(sessionID)
  return messages.at(0)?.type === "idle"
}

async function idle(team: Team, sessionID: string) {
  const messages = await team.server.server.messages(sessionID)
  return messages.at(0)?.type === "idle"
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

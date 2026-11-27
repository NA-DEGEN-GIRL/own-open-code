// TG1 배치와 릴리스, development path (06 §11.3, §2.6): own-team from source third in the plugin order, several
// Locations of one project (the main folder, the user's own linked worktree, the area folders and own.team's control
// location), the leader's Location going away in the middle of an op, every Location going away, and the Claude
// subscription slot (fourth) removed and put back through the config file while own.team works. The release build
// part of TG1 (compiled `opencode.exe`, release-smoke) is T1.32's.
//
// - The op keeps going on the other instances: no git step is interrupted, every own.team event is published once
//   (by whichever instance leads), and the control location leads again once it is back.
// - With every Location gone, the next instance's controller resumes the running op.
// - Changing the slot after own.team reloads only the plugins after it: own.team is not set up again (one `ready` per
//   Location) and its running op ends normally.
//
// Fake credentials only; every listener binds 127.0.0.1; the claude-auth shim is a fake local package. Run from a path
// without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { git } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  TEAM_PACKAGE,
  evict,
  holdOff,
  locations,
  opEnd,
  record,
  same,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { worktrees } from "./inspect.js"

const STEP_TIMEOUT = 300_000

describe("TG1 dev path: Locations, the leader's handover, the Claude slot", () => {
  const state: { team?: TeamServer; teamID?: OwnTeam.TeamID } = {}

  beforeAll(async () => {
    state.team = await startTeamServer({
      name: "leader",
      claude: true,
      watchConfig: true,
      teamOptions: { lingerSeconds: 1 },
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.stop()
  }, 120_000)

  test(
    "the leader's Location goes away during enable: no interrupted git step, every event once, the control leads again",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      // A second Location of the project: the user's own linked worktree with a conversation in it.
      const other = path.join(path.dirname(project), "other")
      git(project, ["worktree", "add", "-q", "-b", "other", other])
      await team.createSession({ directory: other, title: "다른 작업 폴더의 대화" })
      const viewed = await team.createSession({ model: MODEL["01"], title: "켠 대화" })
      expect((await team.team("health", {})).leader).toBe(true)

      const started = await team.team("enable", {
        directory: project,
        sessionID: SessionID.make(viewed),
        hint: "[propose-areas 3]",
      })
      const first = await team.events.waitFor(
        (event) =>
          event.type === "rpc.own.team.op.progress" &&
          event.data.opID === started.opID &&
          event.data.stepID === "judge",
        120_000,
      )
      const teamID = OwnTeam.TeamID.make(String(first.data.teamID))
      state.teamID = teamID
      // The control location leads; it goes away while the areas are made.
      await evict(team, team.control)
      const op = await waitValue(
        async () => {
          const found = record(team.server.paths.database, `op:${teamID}:${started.opID}`, OwnTeam.Op)
          return found && found.state !== "running" ? found : undefined
        },
        "the enable op did not end without the control location",
        STEP_TIMEOUT,
      )
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(op.state).toBe("done")
      const listed = worktrees(project)
      for (const slug of ["area-1", "area-2", "area-3"]) {
        const entry = listed.find((item) => item.branch === slug)
        expect(entry?.locked).toBe(`own.team area:ar_${slug}`)
      }
      // The op record is written before its last steps are announced: wait for the announced end first.
      await team.events.waitFor(
        (event) => event.type === "rpc.own.team.op.done" && event.data.opID === started.opID,
        60_000,
      )
      // Steps that ended after the handover were still announced, and nothing twice.
      const events = team.events.events.filter((event) => event.type.startsWith("rpc.own.team."))
      const ids = events.map((event) => String(event.data.eventId))
      expect(new Set(ids).size).toBe(ids.length)
      const progress = events
        .filter((event) => event.type === "rpc.own.team.op.progress" && event.data.opID === started.opID)
        .map((event) => `${String(event.data.stepID)}:${String(event.data.state)}`)
      expect(new Set(progress).size).toBe(progress.length)
      expect(progress).toContain("finish:done")
      // The control location is back with the next call, and leads again.
      expect((await team.team("health", {})).leader).toBe(true)
      expect(await team.team("op.get", { opID: started.opID })).toMatchObject({ op: { state: "done" } })
      await holdOff(team, teamID)
    },
    STEP_TIMEOUT,
  )

  test(
    "every Location gone during a rotation: the next instance resumes the op",
    async () => {
      const team = required(state.team)
      const teamID = required(state.teamID)
      const area = OwnTeam.AreaID.make("ar_area-1")
      const started = await team.team("area.rotate", { teamID, areaID: area })
      for (const directory of await locations(team)) await evict(team, directory)
      await Bun.sleep(3_000)
      // Any own.team call starts the control location again; its controller resumes what still runs.
      const op = await opEnd(team, started.opID)
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      const view = await team.team("team.get", { directory: required(team.project) })
      expect(view.areas.find((item) => item.id === area)?.owner.previous).toHaveLength(1)
    },
    STEP_TIMEOUT,
  )

  test(
    "the Claude slot removed and put back: own.team is not set up again and its running op ends normally",
    async () => {
      const team = required(state.team)
      const teamID = required(state.teamID)
      const area = OwnTeam.AreaID.make("ar_area-2")
      const view = await team.team("team.get", { directory: required(team.project) })
      const owner = required(view.areas.find((item) => item.id === area)?.owner.sessionID ?? undefined)
      // The area folder's Location is up (a turn of its owner), so the rotation's handoff turn runs there.
      await team.turn(owner, "슬롯을 바꾸기 전에 확인합니다")
      const started = await team.team("area.rotate", { teamID, areaID: area })
      // The Locations up now, each with own.team set up (earlier tests let some go: their setups are history).
      const before = await waitValue(async () => {
        const loaded = await locations(team)
        const up = [...setups(team)].filter(([location]) => loaded.some((item) => same(item, location)))
        return up.every(([, count]) => count >= 0) && up.some(([location]) => location.endsWith("area-2"))
          ? up
          : undefined
      }, "the Locations never settled")

      // Taken out of the config file (the plugin ships with the app, 02 §8.2: no uninstall); the config watcher
      // reloads the plugins after the change.
      const config = await Bun.file(team.configFile).json()
      const plugins: unknown[] = Array.isArray(config.plugins) ? config.plugins : []
      await Bun.write(
        team.configFile,
        JSON.stringify({ ...config, plugins: plugins.filter((entry) => entry !== team.claudeBundle) }, null, 2),
      )
      await until(
        async () => (await team.accounts("plugin.claudeAuth.status")).order === "missing",
        "the slot was not removed",
      )
      const op = await opEnd(team, started.opID)
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])

      // Put back: its entry right after own.team in the config file again.
      const at = plugins.findIndex(
        (entry) => typeof entry === "object" && entry !== null && "package" in entry && entry.package === TEAM_PACKAGE,
      )
      const kept = plugins.filter((entry) => entry !== team.claudeBundle)
      await Bun.write(
        team.configFile,
        JSON.stringify(
          { ...config, plugins: [...kept.slice(0, at + 1), team.claudeBundle, ...kept.slice(at + 1)] },
          null,
          2,
        ),
      )
      await until(
        async () => (await team.accounts("plugin.claudeAuth.status")).order === "ok",
        "the slot did not come back",
      )
      // own.team was not set up again in a Location that stayed up (a Location core built again sets it up anew).
      const after = setups(team)
      for (const [location, count] of before) expect([location, after.get(location)]).toEqual([location, count])
      expect((await team.team("health", {})).guard).toBe("ok")
      expect(team.server.logs()).not.toMatch(/"scope":"own\.team[^"]*","msg":"(setup_failed|guard_failed)"/)
    },
    STEP_TIMEOUT,
  )
})

/**
 * Per Location folder: own.team's setups (its `ready` log line) beyond the Location's own boots (core's `location
 * services booted`). A Location core builds again sets every plugin up again (net 0); a reload of own.team inside a
 * running Location is one setup more.
 */
function setups(team: TeamServer) {
  const counts = new Map<string, number>()
  const add = (directory: string, count: number) => {
    const key = path.resolve(directory).toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + count)
  }
  for (const line of team.server.logs().split("\n")) {
    const ready = Option.getOrUndefined(decodeReady(line))
    if (ready?.scope === "own.team" && ready.msg === "ready") add(ready.location, 1)
    const booted = /message="location services booted" directory="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
    if (booted !== undefined) add(booted.replaceAll("\\\\", "\\"), -1)
  }
  return counts
}

const decodeReady = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ scope: Schema.String, msg: Schema.String, location: Schema.String })),
)

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

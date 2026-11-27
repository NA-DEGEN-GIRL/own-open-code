// TG6 새는 것 막기 and 07 PG10 (team variant) on a real server (06 §11.3, §4.9, §10.1; 07 §2.4, §8.4), and computer use
// in team mode (the T1.31 spec addition; own-computer-use with its in-memory desktop). Verdicts: the tool calls'
// results as the model saw them, the files on disk, the area's cone, permission requests, the session rules.
//
// - Code-only area (F2 heavy folders): a write into a heavy folder outside the cone is refused with a reason the model
//   reads; a write into a new folder adds the folder (`cone.extra` auto); a shell command that creates files in a heavy
//   folder has the folder brought in afterwards (nothing deleted).
// - Dangerous commands ask (`git lfs pull`, `git lfs fetch --all`, the main's `git push` and `git merge`) or are refused
//   (`git sparse-checkout disable`) also in `full`; the team's commands and read-only git run without a question in
//   `ask`; a protected path stays denied.
// - PG10: in a `full` owner, its `explore` child's `bun run typecheck` (a command that needs no question for the owner)
//   and its edit are denied without asking; the owner's mode reads `full` still. The evaluate hook stays within 50 ms
//   at p95.
// - T2 (TG6 full): the owner's own `git merge main` (7.3) runs without a question, and the after-tool check sees the
//   HEAD change and takes the target's new top-level folder into the cone (4.8); unfetched heavy folders stay out.
// - Computer use: own.team never turns it on; a turn own.team started cannot drive the desktop, a direct turn can; a
//   rotation's new owner starts without it and the old one keeps it; children follow `allowSubagents`.
//
// Fake credentials only; every listener binds 127.0.0.1; the desktop is the in-memory fake. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { assistantMessages, childOf, toolError, toolParts, type ToolPart } from "../../../own-accounts/test/e2e-kit"
import { F2_HEAVY, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { commit, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  enableTeam,
  opEnd,
  permissions,
  reply,
  sessionRows,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { catalog, ofSession } from "./inspect.js"

const STEP_TIMEOUT = 240_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly owner: string
  readonly folder: string
}

/** F2 with a `typecheck` script and a Bun lock file: `bun run typecheck` is a V10 command that needs no question. */
function project(root: string) {
  const repo = f2(root)
  write(repo.home, {
    "package.json": JSON.stringify({ name: "f2", scripts: { typecheck: "bun -e 0" } }, null, 2),
    "bun.lock": "{}\n",
  })
  commit(repo.home, "scripts")
  return repo.home
}

describe.skipIf(!lfsAvailable)("TG6 leak guards and PG10 in a code-only area (F2)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "guard", project })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, {
      hint: `[propose-areas 1 +heavy=${F2_HEAVY.join(",")}]`,
      sessionID: viewed,
    })
    const team = required(enabled.view.team ?? undefined)
    const area = required(enabled.view.areas[0])
    expect(area.shape).toBe("code")
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
    "a write into a heavy folder is refused with the reason; a write into a new folder adds that folder",
    async () => {
      const team = required(state.team)
      // `full`: writes run without a question, so only own.team's guard decides (in `ask` the user is asked first).
      await setMode(team, team.owner, "full")
      await team.server.turn(team.owner, "[write Assets/Textures/new.txt 무거운 폴더에 쓰기]")
      const refused = await lastWrite(team, team.owner)
      expect(refused.state.status).toBe("error")
      expect(toolError(refused)).toContain("team_need_paths")
      expect(fs.existsSync(path.join(team.folder, "Assets", "Textures", "new.txt"))).toBe(false)

      await team.server.turn(team.owner, "[write notes/new.md 새 폴더에 쓰기]")
      const written = await lastWrite(team, team.owner)
      expect(written.state.status).toBe("completed")
      expect(fs.existsSync(path.join(team.folder, "notes", "new.md"))).toBe(true)
      expect((await areaOf(team)).cone.extra.notes).toMatchObject({ reason: "auto" })
    },
    STEP_TIMEOUT,
  )

  test(
    "full mode: a shell command that writes into a heavy folder has the folder brought in, nothing deleted",
    async () => {
      const team = required(state.team)
      await setMode(team, team.owner, "full")
      const script =
        "require('fs').mkdirSync('Assets/Audio/made',{recursive:true});require('fs').writeFileSync('Assets/Audio/made/a.txt','x')"
      await team.server.turn(team.owner, `[shell bun -e "${script}"]`)
      expect(fs.readFileSync(path.join(team.folder, "Assets", "Audio", "made", "a.txt"), "utf8")).toBe("x")
      await until(
        async () => Object.keys((await areaOf(team)).cone.extra).some((dir) => dir.startsWith("Assets/Audio")),
        "the folder the command wrote into was not brought into the cone",
      )
      expect(fs.existsSync(path.join(team.folder, "Assets", "Audio", "made", "a.txt"))).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "dangerous commands ask or are refused in full mode; the main's push and merge ask",
    async () => {
      const team = required(state.team)
      for (const command of ["git lfs pull", "git lfs fetch --all"]) {
        const asked = await shellAsks(team, team.owner, command)
        expect(asked).toContain("team_need_paths")
      }
      await team.server.turn(team.owner, "[shell git sparse-checkout disable]")
      const refused = last(await toolParts(team.server.server, team.owner, "shell"))
      expect(refused.state.status).toBe("error")
      expect(toolError(refused)).toContain("team_need_paths")
      expect(await permissions(team.server, team.owner)).toEqual([])

      await setMode(team, team.main, "full")
      for (const command of ["git push", "git merge area-1"])
        expect(await shellAsks(team, team.main, command)).not.toBe("")
    },
    STEP_TIMEOUT,
  )

  test(
    "ask mode: the team's commands and read-only git run without a question; a protected path stays denied",
    async () => {
      const team = required(state.team)
      await setMode(team, team.owner, "ask")
      const from = team.server.events.events.length
      for (const command of ["bun run typecheck", "git status"]) {
        await team.server.turn(team.owner, `[shell ${command}]`)
        expect(last(await toolParts(team.server.server, team.owner, "shell")).state.status).toBe("completed")
      }
      expect(
        team.server.events.events
          .slice(from)
          .filter((event) => event.type === "permission.asked" && event.data.sessionID === team.owner),
      ).toEqual([])
      await setMode(team, team.owner, "full")
      // A protected path (OWN_HOME `*.json`, 03 P10) lies outside the folder: the user lets the write leave the folder
      // once, and the bundle's deny still stops it (no hook lifts a rule's deny).
      const protectedFile = path.join(team.server.ownHome, "e2e-protected.json").replaceAll("\\", "/")
      await team.server.server.prompt(team.owner, `[write ${protectedFile} 보호 경로]`)
      await until(async () => {
        for (const request of await permissions(team.server, team.owner))
          await reply(team.server, team.owner, String(request.id), "once")
        const part = (await writeParts(team, team.owner)).at(-1)
        return (
          part !== undefined &&
          JSON.stringify(part.state.input).includes("보호 경로") &&
          (part.state.status === "completed" || part.state.status === "error")
        )
      }, "the protected write neither ran nor ended")
      await team.server.server.waitIdle(team.owner)
      expect((await lastWrite(team, team.owner)).state.status).toBe("error")
      expect(fs.existsSync(protectedFile)).toBe(false)
      const approval = await team.server.accounts("session.approval.get", { sessionID: team.owner }, team.folder)
      expect(approval.mode).toBe("full")
    },
    STEP_TIMEOUT,
  )

  test(
    "PG10 team: a full owner's explore child is denied `bun run typecheck` and edits without a question",
    async () => {
      const team = required(state.team)
      await setMode(team, team.owner, "full")
      await team.server.turn(team.owner, "[subagent explore [shell bun run typecheck] [write src/child.txt 자식 편집]]")
      const call = last(await toolParts(team.server.server, team.owner, "subagent"))
      const child = await childOf(team.server.server, call)
      // Subagents run in the background since upstream v2.3.0 (#63382): the owner's turn ends before the child's.
      await team.server.server.waitIdle(child.id)
      await team.server.server.waitIdle(team.owner)
      const shell = last(await toolParts(team.server.server, child.id, "shell"))
      expect(shell.state.status).toBe("error")
      const edit = await lastWrite(team, child.id)
      expect(edit.state.status).toBe("error")
      expect(fs.existsSync(path.join(team.folder, "src", "child.txt"))).toBe(false)
      expect(
        team.server.events.events.filter(
          (event) => event.type === "permission.asked" && event.data.sessionID === child.id,
        ),
      ).toEqual([])
      // The parent's own command still runs, and its mode reads `full`.
      await team.server.turn(team.owner, "[shell bun run typecheck]")
      expect(last(await toolParts(team.server.server, team.owner, "shell")).state.status).toBe("completed")
      const approval = await team.server.accounts("session.approval.get", { sessionID: team.owner }, team.folder)
      expect(approval.mode).toBe("full")
    },
    STEP_TIMEOUT,
  )

  test(
    "T2: the owner's own `git merge main` runs in full mode and the cone follows the new HEAD (4.8)",
    async () => {
      const team = required(state.team)
      await setMode(team, team.owner, "full")
      const home = required(team.server.project)
      write(home, { "tools2/new.ts": "export const tools2 = 1\n" })
      commit(home, "a new top-level folder on main")
      // 7.3: an owner merging the target in its own area needs no question (only the main's merge asks).
      expect(await shellAsks(team, team.owner, "git merge main")).toBe("")
      expect(last(await toolParts(team.server.server, team.owner, "shell")).state.status).toBe("completed")
      // The shell changed HEAD: the after-tool check takes the new non-heavy top-level folder into the cone.
      await until(
        async () => (await areaOf(team)).cone.extra.tools2?.reason === "auto",
        "the new top-level folder never came into the cone",
      )
      expect(fs.readFileSync(path.join(team.folder, "tools2", "new.ts"), "utf8")).toBe("export const tools2 = 1\n")
      // Heavy folders nobody fetched stay out.
      for (const heavy of ["Assets/Textures", "Content"])
        expect(fs.existsSync(path.join(team.folder, ...heavy.split("/")))).toBe(false)
    },
    STEP_TIMEOUT,
  )

  // A wall-clock check that a loaded PC can fail (2.2.6-own.17's release tier: p95 75 ms with three files at once,
  // 12/12 alone): opt-in like the unit tier's p95 checks (`bun run test:perf`, OWN_TEAM_PERF=1).
  test.skipIf(process.env.OWN_TEAM_PERF !== "1")(
    "the evaluate hook stays within 50 ms at p95 (twenty writes inside the cone)",
    async () => {
      const team = required(state.team)
      await setMode(team, team.owner, "full")
      const writes = Array.from({ length: 20 }, (_, index) => `[write src/p95/f${index}.txt 내용${index}]`).join(" ")
      await team.server.turn(team.owner, writes)
      const parts = (await writeParts(team, team.owner)).slice(-20)
      expect(parts.every((part) => part.state.status === "completed")).toBe(true)
      // From the call to its run: the permission evaluation (own.team's hook among them) and the before hooks.
      const waits = parts.map((part) => (part.time?.ran ?? 0) - (part.time?.created ?? 0)).toSorted((a, b) => a - b)
      const p95 = required(waits[Math.ceil(waits.length * 0.95) - 1])
      expect(p95).toBeLessThanOrEqual(50)
    },
    STEP_TIMEOUT,
  )
})

describe("computer use in team mode (own-computer-use, in-memory desktop)", () => {
  const state: { off?: Team; on?: Team } = {}

  beforeAll(async () => {
    const boot = async (name: string, allowSubagents: boolean): Promise<Team> => {
      const server = await startTeamServer({
        name,
        computerUse: true,
        computerOptions: { policy: { allowSubagents } },
      })
      const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
      const enabled = await enableTeam(server, { hint: "[propose-areas 1]", sessionID: viewed })
      const team = required(enabled.view.team ?? undefined)
      const area = required(enabled.view.areas[0])
      return {
        server,
        teamID: team.id,
        main: team.main.sessionID,
        owner: required(area.owner.sessionID ?? undefined),
        folder: area.directory,
      }
    }
    const [off, on] = await Promise.all([boot("computer-off", false), boot("computer-on", true)])
    Object.assign(state, { off, on })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await Promise.all([state.off?.server.stop(), state.on?.server.stop()])
  }, 120_000)

  test(
    "own.team never turns computer use on: the main and the owner start without the allow",
    async () => {
      const team = required(state.off)
      for (const id of [team.main, team.owner]) {
        const rules = required(sessionRows(team.server.server.paths.database).find((row) => row.id === id)).permission
        expect(rules.filter((rule) => rule.action === "computer" && rule.effect === "allow")).toEqual([])
      }
    },
    STEP_TIMEOUT,
  )

  test(
    "with computer use on, a turn own.team started is refused `team_turn`; the user's own turn drives the desktop",
    async () => {
      const team = required(state.off)
      await computer(team, team.owner, "on")
      await team.server.turn(team.main, "[dispatch area-1 [computer screenshot]]")
      await until(async () => (await toolParts(team.server.server, team.owner, "execute")).length > 0, "no owner call")
      await team.server.server.waitIdle(team.owner)
      const dispatched = last(await toolParts(team.server.server, team.owner, "execute"))
      expect(JSON.stringify(dispatched)).toContain("team_turn")

      await team.server.turn(team.owner, "[computer screenshot]")
      const direct = last(await toolParts(team.server.server, team.owner, "execute"))
      expect(direct.state.status).toBe("completed")
      expect(JSON.stringify(direct)).not.toContain("team_turn")
    },
    STEP_TIMEOUT,
  )

  test(
    "allowSubagents off: a child made after computer use was turned on lists no computer tools",
    async () => {
      const team = required(state.off)
      await team.server.turn(team.owner, "[subagent general 자식 작업]")
      const child = await childOf(team.server.server, last(await toolParts(team.server.server, team.owner, "subagent")))
      const first = required(ofSession(team.server.fakes.codex.requests, child.id)[0])
      expect(catalog(first) ?? "").not.toContain("tools.computer.")
    },
    STEP_TIMEOUT,
  )

  test(
    "a rotation keeps the old owner's allow and starts the new owner without it",
    async () => {
      const team = required(state.off)
      const started = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_1 })
      expect((await opEnd(team.server, started.opID)).state).toBe("done")
      const view = await team.server.team("team.get", { directory: required(team.server.project) })
      const next = required(view.areas[0]?.owner.sessionID ?? undefined)
      expect(next).not.toBe(team.owner)
      expect(await computerState(team, team.owner)).toBe("on")
      expect(await computerState(team, next)).toBe("off")
    },
    STEP_TIMEOUT,
  )

  test(
    "allowSubagents on: a child on the main model inside a turn own.team started is refused `team_turn` too",
    async () => {
      const team = required(state.on)
      await computer(team, team.owner, "on")
      await team.server.turn(team.main, "[dispatch area-1 [subagent general [computer screenshot]]]")
      // The subagent call once it finished (its child is in its metadata then).
      const call = await waitValue(
        async () => {
          const part = (await toolParts(team.server.server, team.owner, "subagent")).at(-1)
          // Not just "not running": a call whose input is still streaming has no child yet (2026-10-17, loaded PC).
          return part && (part.state.status === "completed" || part.state.status === "error") ? part : undefined
        },
        "the owner never ran its subagent",
        STEP_TIMEOUT,
      )
      const child = await childOf(team.server.server, call)
      await team.server.server.waitIdle(child.id)
      expect(child.model).toMatchObject({ providerID: MODEL["01"].providerID })
      const refused = last(await toolParts(team.server.server, child.id, "execute"))
      expect(JSON.stringify(refused)).toContain("team_turn")
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

async function areaOf(team: Team) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return required(view.areas.find((area) => area.id === AREA_1))
}

async function setMode(team: Team, sessionID: string, mode: "ask" | "full") {
  const directory = sessionID === team.main ? required(team.server.project) : team.folder
  await team.server.accounts("session.approval.set", { sessionID, mode }, directory)
}

async function computer(team: Team, sessionID: string, on: "on" | "off") {
  const directory = sessionID === team.main ? required(team.server.project) : team.folder
  const current = await team.server.accounts("session.approval.get", { sessionID }, directory)
  const mode = current.mode === "custom" ? "ask" : current.mode
  await team.server.accounts("session.approval.set", { sessionID, mode, computerUse: on }, directory)
}

async function computerState(team: Team, sessionID: string) {
  const state = await team.server.accounts("session.approval.get", { sessionID }, team.folder)
  return state.computerUse
}

/**
 * Sends `[shell <command>]` and returns the message of the permission request it raised (refused right away), or ""
 * when the command ran without one.
 */
async function shellAsks(team: Team, sessionID: string, command: string) {
  await team.server.server.prompt(sessionID, `[shell ${command}]`)
  const request = await waitValue(
    async () => {
      const pending = await permissions(team.server, sessionID)
      if (pending[0]) return pending[0]
      const parts = await toolParts(team.server.server, sessionID, "shell")
      const done = parts.find(
        (part) =>
          JSON.stringify(part.state.input).includes(command) &&
          (part.state.status === "completed" || part.state.status === "error"),
      )
      return done ? { id: "", message: "" } : undefined
    },
    `\`${command}\` neither asked nor ran`,
    60_000,
  )
  if (request.id !== "") await reply(team.server, sessionID, String(request.id), "reject")
  await team.server.server.waitIdle(sessionID)
  return typeof request.message === "string" ? request.message : ""
}

/** The newest call of a tool. */
function last(parts: ReadonlyArray<ToolPart>): ToolPart {
  return required(parts.at(-1))
}

/** The session's file writes, oldest first: `[write]` is `patch` for GPT models and `write` where that is offered. */
async function writeParts(team: Team, sessionID: string): Promise<ReadonlyArray<ToolPart & { readonly time?: Time }>> {
  return (await assistantMessages(team.server.server, sessionID))
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter(
      (part): part is ToolPart & { readonly time?: Time } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "tool" &&
        "name" in part &&
        (part.name === "patch" || part.name === "write"),
    )
}

interface Time {
  readonly created?: number
  readonly ran?: number
}

async function lastWrite(team: Team, sessionID: string) {
  return required((await writeParts(team, sessionID)).at(-1))
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

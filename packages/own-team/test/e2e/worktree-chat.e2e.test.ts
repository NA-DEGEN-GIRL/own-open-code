// Worktrees outside team mode (06 §4.12a, §13, 2026-11-24) on a real server with own-accounts and own-team, F1:
// - core's `POST /api/worktree` puts a new worktree in `<project>/.worktrees/<name>` (own's `git` strategy) with own's
//   `.gitignore` and the `info/exclude` line, the main folder stays clean, and git's refusal of a dirty worktree keeps
//   `forceRequired` (core P-062); a project config `worktree.directory` still wins;
// - a conversation's `worktree_start` (the scripted model's `tools.worktree.start`) starts two conversations in parallel,
//   each in its own worktree and branch with the parent's model; each one's end wakes the parent with a note; the
//   parent integrates both (a fast-forward, then a merge commit) after the user approves, undoes and redoes one, and
//   removes a worktree while a dirty one is refused.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { git } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  enableTeam,
  messages,
  opEnd,
  permissions,
  reply,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"
import { sessionInfo } from "../../../own-accounts/test/e2e-kit"

const STEP_TIMEOUT = 300_000

describe("worktrees outside team mode (F1)", () => {
  const state: { team?: TeamServer } = {}

  beforeAll(async () => {
    state.team = await startTeamServer({ name: "wtchat" })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.stop()
  }, 120_000)

  test(
    "core's worktree.create defaults to <project>/.worktrees with own's .gitignore; a dirty remove keeps forceRequired",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const projectID = await projectOf(team)
      const created = record(await team.server.call("POST", "/api/worktree", { body: { projectID, name: "side" } }))
      expect(same(String(created.directory), path.join(project, ".worktrees", "side"))).toBe(true)
      expect(fs.readFileSync(path.join(project, ".worktrees", ".gitignore"), "utf8")).toContain("*")
      expect(fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf8")).toContain("/.worktrees/")
      expect(git(project, ["status", "--porcelain"]).trim()).toBe("")
      // The main folder's own listing never shows the worktree's files.
      fs.writeFileSync(path.join(String(created.directory), "dirty.txt"), "x")
      const refused = await team.server.request("DELETE", "/api/worktree", {
        body: { projectID, directory: created.directory, force: false },
      })
      const failure = record(await refused.json())
      expect(refused.status).toBe(400)
      expect(record(failure.data).forceRequired).toBe(true)
      const forced = await team.server.request("DELETE", "/api/worktree", {
        body: { projectID, directory: created.directory, force: true },
      })
      expect(forced.ok).toBe(true)
      expect(fs.existsSync(String(created.directory))).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "worktree_start runs two conversations in parallel; notes wake the parent; integrate, undo and cleanup",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const parent = await team.createSession({ model: MODEL["01"], title: "원래 대화" })
      // Full approval: the started conversations copy it, so their writes and commits do not ask; integrating asks.
      await team.accounts("session.approval.set", { sessionID: parent, mode: "full" }, project)
      const task = (name: string) =>
        `{"name":"${name}","title":"${name} 일","task":"[write ${name}.txt ${name}] [shell git add -A] [shell git commit -q -m ${name}]"}`
      await team.turn(parent, `[tool worktree.start {"tasks":[${task("alpha")},${task("beta")}]}]`)
      const records = () =>
        Object.entries(kv(team.server.paths.database))
          .filter(([key]) => key.startsWith(`wtchat:${parent}:`))
          .map(([, value]) => record(value))
      expect(records()).toHaveLength(2)
      const children = records().map((item) => ({
        sessionID: String(item.sessionID),
        name: String(item.name),
        directory: String(item.directory),
      }))
      for (const child of children) {
        expect(same(child.directory, path.join(project, ".worktrees", child.name))).toBe(true)
        const session = await sessionInfo(team.server, child.sessionID)
        expect(session.parentID).toBeUndefined()
        expect(record(session.model).id).toBe(record(MODEL["01"]).id)
        expect(record(record(session.metadata)[OWN_META])).toMatchObject({ role: "child", parentID: parent })
      }
      // Both run and end; the parent is woken with one note per batch and answers it.
      await until(
        async () => records().every((item) => item.state === "done"),
        "the worktree conversations did not end",
        STEP_TIMEOUT,
      )
      await until(
        async () =>
          (await texts(team, parent)).filter((text) => text.includes("<worktree-chat")).join("\n").split("<worktree-chat").length - 1 >= 2,
        "the parent was not told of both",
        STEP_TIMEOUT,
      )
      for (const child of children)
        expect(git(child.directory, ["log", "-1", "--format=%s"]).trim()).toBe(child.name)
      const listed = record(
        (await team.rpc(OwnTeam.ID, "worktreeChat.list", { sessionID: parent }, project)).output,
      )
      expect((listed.items as ReadonlyArray<unknown>).map((item) => record(item).state)).toEqual(["done", "done"])
      const childList = record(
        (await team.rpc(OwnTeam.ID, "worktreeChat.list", { sessionID: required(children[0]).sessionID }, project))
          .output,
      )
      expect(record(childList.parent).sessionID).toBe(parent)

      // Integrate alpha (a fast-forward) after the user approves, then beta (a merge commit: main moved).
      const before = git(project, ["rev-parse", "main"]).trim()
      const alpha = required(children.find((item) => item.name === "alpha"))
      const beta = required(children.find((item) => item.name === "beta"))
      await approved(team, parent, `[tool worktree.integrate {"session":"${alpha.sessionID}"}]`)
      expect(git(project, ["log", "-1", "--format=%s", "main"]).trim()).toBe("alpha")
      expect(fs.existsSync(path.join(project, "alpha.txt"))).toBe(true)
      await approved(team, parent, `[tool worktree.integrate {"session":"${beta.sessionID}"}]`)
      expect(git(project, ["log", "-1", "--format=%P", "main"]).trim().split(" ")).toHaveLength(2)
      expect(fs.existsSync(path.join(project, "beta.txt"))).toBe(true)
      // Undo beta: main goes back to alpha's commit; redo it.
      await approved(team, parent, `[tool worktree.integrate {"session":"${beta.sessionID}","undo":true}]`)
      expect(git(project, ["log", "-1", "--format=%s", "main"]).trim()).toBe("alpha")
      expect(fs.existsSync(path.join(project, "beta.txt"))).toBe(false)
      await approved(team, parent, `[tool worktree.integrate {"session":"${beta.sessionID}"}]`)
      expect(fs.existsSync(path.join(project, "beta.txt"))).toBe(true)
      expect(git(project, ["merge-base", "--is-ancestor", before, "main"]).trim()).toBe("")

      // Cleanup: a dirty worktree is refused, a clean one goes with its merged branch; the conversations stay.
      fs.writeFileSync(path.join(beta.directory, "left.txt"), "x")
      await team.turn(parent, `[tool worktree.cleanup {"session":"${beta.sessionID}"}]`)
      expect(fs.existsSync(beta.directory)).toBe(true)
      await team.turn(parent, `[tool worktree.cleanup {"session":"${alpha.sessionID}","delete_branch":true}]`)
      expect(fs.existsSync(alpha.directory)).toBe(false)
      expect(git(project, ["branch", "--list", "alpha"]).trim()).toBe("")
      const states = Object.fromEntries(records().map((item) => [String(item.name), item.state]))
      expect(states).toEqual({ alpha: "removed", beta: "integrated" })
      const alive = await sessionInfo(team.server, alpha.sessionID)
      expect(alive.id).toBe(alpha.sessionID)
    },
    STEP_TIMEOUT * 3,
  )
})

describe("team mode beside a worktree made outside it (F1)", () => {
  test(
    "enable keeps it out of the team (left), the new area sits beside it in .worktrees, undo leaves it and own's .gitignore",
    async () => {
      const team = await startTeamServer({ name: "wtteam" })
      try {
        const project = required(team.project)
        const projectID = await projectOf(team)
        const side = record(await team.server.call("POST", "/api/worktree", { body: { projectID, name: "side" } }))
        const viewed = await team.createSession({ model: MODEL["01"], title: "켠 대화" })
        const enabled = await enableTeam(team, { hint: "[propose-areas 1]", sessionID: viewed })
        const view = required(enabled.view.team ?? undefined)
        expect(same(view.worktreeRoot, path.join(project, ".worktrees"))).toBe(true)
        expect(enabled.view.areas.map((area) => area.directory).some((item) => same(item, String(side.directory)))).toBe(
          false,
        )
        expect(enabled.view.areas.every((area) => same(path.dirname(area.directory), path.join(project, ".worktrees")))).toBe(
          true,
        )
        expect(view.external.find((item) => same(item.directory, String(side.directory)))?.why).toBe("left")
        const undone = await team.team("op.undo", { opID: OwnTeam.OpID.make(enabled.opID) })
        const op = await opEnd(team, undone.opID)
        expect(op.state).toBe("done")
        expect(fs.existsSync(String(side.directory))).toBe(true)
        expect(fs.readFileSync(path.join(project, ".worktrees", ".gitignore"), "utf8")).toContain("*")
        expect(git(project, ["status", "--porcelain"]).trim()).toBe("")
      } finally {
        await team.stop()
      }
    },
    BOOT_TIMEOUT + STEP_TIMEOUT * 2,
  )
})

describe("a project config worktree.directory still wins", () => {
  test(
    "the configured folder, not .worktrees",
    async () => {
      const team = await startTeamServer({
        name: "wtconf",
        config: { worktree: { directory: "../configured-trees" } },
      })
      try {
        const project = required(team.project)
        const projectID = await projectOf(team)
        const created = record(await team.server.call("POST", "/api/worktree", { body: { projectID, name: "side" } }))
        expect(same(String(created.directory), path.join(path.dirname(project), "configured-trees", "side"))).toBe(true)
        expect(fs.existsSync(path.join(project, ".worktrees"))).toBe(false)
      } finally {
        await team.stop()
      }
    },
    BOOT_TIMEOUT + STEP_TIMEOUT,
  )
})

const OWN_META = OwnTeam.WORKTREE_CHAT_META

/** Sends `text`, approves the one permission it asks (`worktree_integrate`) and waits until the turn ends. */
async function approved(team: TeamServer, sessionID: string, text: string) {
  await team.server.prompt(sessionID, text)
  const asked = await waitValue(async () => {
    const list = await permissions(team, sessionID)
    return list.find((item) => item.action === "worktree_integrate")
  }, "no worktree_integrate permission was asked").catch(async (error: unknown) => {
    // What the tool answered instead (its refusal names the reason).
    const last = (await messages(team, sessionID)).slice(-3)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(last).slice(0, 4000)}`)
  })
  await reply(team, sessionID, String(asked.id), "once")
  await team.server.waitIdle(sessionID)
}

async function projectOf(team: TeamServer) {
  const session = await team.createSession({ model: MODEL["01"], title: "프로젝트" })
  return String((await sessionInfo(team.server, session)).projectID)
}

async function texts(team: TeamServer, sessionID: string) {
  return (await messages(team, sessionID)).flatMap((message) => {
    const content = Array.isArray(message.content) ? message.content : []
    const parts = content.flatMap((part) => {
      const value = record(part)
      return typeof value.text === "string" ? [value.text] : []
    })
    return typeof message.text === "string" ? [message.text, ...parts] : parts
  })
}

function same(a: string, b: string) {
  const norm = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase()
  return norm(fs.existsSync(a) ? fs.realpathSync(a) : a) === norm(fs.existsSync(b) ? fs.realpathSync(b) : b)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {}
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing value")
  return value
}

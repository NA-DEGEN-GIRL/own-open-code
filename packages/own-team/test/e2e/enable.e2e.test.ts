// TG2 켜기(새 프로젝트) on a real server (06 §11.3, §3.1–3.8): enabling from a conversation with the judge's answer
// `[propose-areas 0]` and `[propose-areas 2]`, on F1 (code) and F2 (LFS, heavy folders, code-only areas). Verdicts come
// from durable state: the op record, the registry, `git worktree list`, locks, sparse patterns, the session rows and
// the fakes' recorded model requests.
//
// - No question is asked (no permission or form request), the result card lists what was made once, and there is
//   exactly one team main: the session own-web opens after the op (`team.get` → `team.main.sessionID`).
// - The judge runs on the team main through `session.generate` (06 §3.4), so it carries the main's account: no 401.
// - The process is killed after every step of an enable that makes two areas; each restart resumes the op, which
//   converges on the same result as a run without kills (TI-11): no duplicate area, worktree, branch or session.
// - Enabling twice converges (3.8 다시 켜기): no second judge, no new session or area.
// - Undo removes only what the enable made (3.8 켜기 되돌리기): the new worktrees and branches go, the sessions it made
//   are archived (never deleted, TI-5), the team records go; the main folder, its branch and the user's conversation
//   are untouched.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Worktree } from "../../src/git/worktree.js"
import { F2_HEAVY, lfsAvailable } from "../fixtures/lfs-repo.js"
import { f1, git, status, temp } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  codexIdentity,
  enableTeam,
  holdOff,
  killEachStep,
  opEnd,
  same,
  sessionRows,
  startTeamServer,
  teamMeta,
  type SessionRow,
  type TeamServer,
} from "./harness.js"
import { files, kv, ofSession, sparse, worktrees } from "./inspect.js"

/** An enable that makes two areas: every step, and the restarts between them, may take a while. */
const ENABLE_TIMEOUT = 900_000

describe("a kill inside `worktree add` (fixture, no server)", () => {
  test("the half-made worktree is cleared and made again; undo clears it too", async () => {
    const box = temp("own-team-half-")
    const home = f1(box.root).home
    const head = git(home, ["rev-parse", "HEAD"]).trim()
    const plan = (name: string): Worktree.Plan => ({
      home,
      directory: path.join(box.root, "home-team", name),
      branch: name,
      base: head,
      areaID: `ar_${name}`,
      shape: "plain",
      cone: [],
      heavy: [],
    })
    // What a kill between `worktree add`'s writes leaves: the branch, a locked admin folder whose `commondir` is
    // still empty and no HEAD, and the new folder with only its `.git` file: `worktree list` fails for the repository.
    const half = (name: string) => {
      const item = plan(name)
      const admin = path.join(home, ".git", "worktrees", name)
      git(home, ["branch", name, head])
      fs.mkdirSync(admin, { recursive: true })
      fs.mkdirSync(item.directory, { recursive: true })
      fs.writeFileSync(path.join(admin, "locked"), Worktree.lockReason(item.areaID))
      fs.writeFileSync(path.join(admin, "gitdir"), `${path.join(item.directory, ".git")}\n`)
      fs.writeFileSync(path.join(item.directory, ".git"), `gitdir: ${admin}\n`)
      fs.writeFileSync(path.join(admin, "commondir"), "")
      return item
    }
    const created = half("area-1")
    expect(Bun.spawnSync(["git", "-C", home, "worktree", "list"]).exitCode).not.toBe(0)
    const made = await Worktree.create(created, { askDownloadBytes: Number.POSITIVE_INFINITY })
    expect(made).toMatchObject({ ok: true, state: "ready" })
    expect(worktrees(home).find((entry) => same(entry.path, created.directory))).toMatchObject({
      branch: "area-1",
      head,
      locked: "own.team area:ar_area-1",
    })
    expect(status(created.directory)).toBe("")

    // Undo of an enable that was killed there: `clear` lets `worktree list` work again; the user's files stay.
    const undone = half("area-2")
    expect(await Worktree.clear({ home, directory: undone.directory, areaID: undone.areaID })).toBe(true)
    expect(fs.existsSync(undone.directory)).toBe(false)
    expect(worktrees(home)).toHaveLength(2)
    // Someone else's folder (another lock reason, or more than the `.git` file) is never cleared.
    const other = half("area-3")
    fs.writeFileSync(path.join(other.directory, "notes.md"), "user file\n")
    expect(await Worktree.clear({ home, directory: other.directory, areaID: other.areaID })).toBe(false)
    expect(fs.existsSync(path.join(other.directory, "notes.md"))).toBe(true)
    box.dispose()
  })
})

describe("F1, [propose-areas 0]: enable from a conversation, enable again, undo", () => {
  const state: { team?: TeamServer; viewed?: string; opID?: string; main?: string; requests?: number } = {}

  beforeAll(async () => {
    state.team = await startTeamServer({ name: "enable-f1-zero" })
    state.viewed = await state.team.createSession({ model: MODEL["01"], title: "켠 대화" })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.stop()
  }, 120_000)

  test(
    "no question, no area, one main on the conversation's model; the judge ran on it without a 401",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const before = { head: git(project, ["rev-parse", "HEAD"]).trim(), files: files(project) }
      const enabled = await enableTeam(team, { hint: "[propose-areas 0]", sessionID: required(state.viewed) })
      state.opID = enabled.opID
      expect(enabled.op.state).toBe("done")
      expect(enabled.op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(enabled.op.undo).toMatchObject({ available: true })
      expect(enabled.op.summary?.lines).toEqual([
        { kind: "notes", text: "진행 중인 일이 보이지 않아 영역을 만들지 않습니다." },
      ])

      const view = enabled.view
      const teamRecord = required(view.team ?? undefined)
      expect(teamRecord).toMatchObject({ state: "on", target: "main", home: { linked: false, chosenBy: "session" } })
      expect(same(teamRecord.home.directory, project)).toBe(true)
      expect(view.areas).toEqual([])
      expect(view.op).toBeNull()

      // Exactly one main: the session own-web opens once the op is done.
      const main = teamRecord.main.sessionID
      state.main = main
      const mains = sessionRows(team.server.paths.database).filter((row) => teamMeta(row)?.role === "main")
      expect(mains.map((row) => row.id)).toEqual([main])
      const row = required(mains[0])
      expect(row.parentID).toBeNull()
      expect(same(row.directory, project)).toBe(true)
      expect(row.model).toMatchObject({ providerID: MODEL["01"].providerID, id: MODEL["01"].id })
      expect(row.metadata[OwnTeam.SESSION_META]).toEqual({ role: "main", teamID: teamRecord.id })

      // The judge: `session.generate` on the main, on the main's account; no request anywhere was refused.
      const judged = ofSession(team.fakes.codex.requests, main)
      expect(judged.length).toBeGreaterThanOrEqual(1)
      expect(judged.map((request) => [request.identity, request.status])).toContainEqual([codexIdentity("01"), 200])
      expect(refused(team)).toEqual([])
      state.requests = judged.length

      // No question: nothing asked the user while enabling.
      expect(asked(team)).toEqual([])
      // The repository is as it was: one checkout, same HEAD, same files, clean.
      expect(worktrees(project).map((entry) => same(entry.path, project))).toEqual([true])
      expect(git(project, ["rev-parse", "HEAD"]).trim()).toBe(before.head)
      expect(files(project)).toEqual(before.files)
      expect(status(project)).toBe("")
    },
    ENABLE_TIMEOUT,
  )

  test(
    "enabling again converges: the same team and main, no second judge, no new session",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const sessions = sessionRows(team.server.paths.database).length
      const again = await enableTeam(team, { hint: "[propose-areas 2]", sessionID: required(state.viewed) })
      expect(again.op.state).toBe("done")
      expect(again.op.steps.map((step) => step.kind)).not.toContain("enable.judge")
      expect<unknown>(again.view.team?.main.sessionID).toBe(required(state.main))
      expect(again.view.areas).toEqual([])
      expect((await team.team("team.list", {})).teams).toHaveLength(1)
      expect(sessionRows(team.server.paths.database)).toHaveLength(sessions)
      expect(ofSession(team.fakes.codex.requests, required(state.main))).toHaveLength(required(state.requests))
      expect(Object.keys(kv(team.server.paths.database)).filter((key) => key.startsWith("team:"))).toHaveLength(1)
      expect(worktrees(project)).toHaveLength(1)
    },
    ENABLE_TIMEOUT,
  )

  test(
    "undo removes what the enable made: the team records go, the main is archived, the conversation stays",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const undone = await team.team("op.undo", { opID: OwnTeam.OpID.make(required(state.opID)) })
      const op = await opEnd(team, undone.opID)
      expect(op.steps.filter((step) => step.state === "failed")).toEqual([])
      expect(op.state).toBe("done")
      expect(await team.team("team.get", { directory: project })).toMatchObject({ team: null, areas: [] })
      expect(Object.keys(kv(team.server.paths.database)).filter((key) => key.startsWith("team:"))).toEqual([])
      const rows = sessionRows(team.server.paths.database)
      expect(rowOf(rows, required(state.main)).metadata["own.archived"]).toBe(true)
      expect(rowOf(rows, required(state.viewed)).metadata["own.archived"]).toBeUndefined()
      expect(worktrees(project)).toHaveLength(1)
      expect(status(project)).toBe("")
    },
    ENABLE_TIMEOUT,
  )
})

describe("F1, [propose-areas 2]: a kill after every step converges, enable again, undo", () => {
  const state: {
    team?: TeamServer
    viewed?: string
    opID?: string
    kills?: number
    areas?: ReadonlyArray<OwnTeam.AreaView>
    main?: string
  } = {}

  beforeAll(async () => {
    state.team = await startTeamServer({ name: "enable-f1-two" })
    state.viewed = await state.team.createSession({ model: MODEL["01"], title: "켠 대화" })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.stop()
  }, 120_000)

  test(
    "killed after each step and restarted, the op resumes to two areas, one main and one owner each",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const head = git(project, ["rev-parse", "HEAD"]).trim()
      const started = await team.team("enable", {
        directory: project,
        sessionID: SessionID.make(required(state.viewed)),
        hint: "[propose-areas 2]",
      })
      state.opID = started.opID
      state.kills = await killEachStep(team, started.opID, new Set(["worktree-create", "owner-create"]))
      const op = await opEnd(team, started.opID)
      expect(op.state).toBe("done")
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      // At least one kill landed while the op ran (the op may finish before the last restart).
      expect(state.kills).toBeGreaterThan(0)

      // The card lists each new area once.
      expect<unknown>(op.summary?.lines.filter((line) => line.kind === "area")).toEqual([
        { kind: "area", areaID: "ar_area-1", change: "created" },
        { kind: "area", areaID: "ar_area-2", change: "created" },
      ])

      const view = await team.team("team.get", { directory: project })
      const teamRecord = required(view.team ?? undefined)
      state.main = teamRecord.main.sessionID
      await holdOff(team, teamRecord.id)
      state.areas = view.areas
      expect<unknown>(
        view.areas.map((area) => [area.id, area.branch, area.shape, area.state, area.status.kind]),
      ).toEqual([
        ["ar_area-1", "area-1", "plain", "active", "idle"],
        ["ar_area-2", "area-2", "plain", "active", "idle"],
      ])

      // git: the home plus one locked worktree per area, on its branch at the base, clean.
      const listed = worktrees(project)
      expect(listed).toHaveLength(3)
      for (const area of view.areas) {
        const entry = required(listed.find((item) => same(item.path, area.directory)))
        expect(entry).toMatchObject({ branch: area.branch, head, locked: `own.team area:${area.id}` })
        expect(same(path.dirname(area.directory), teamRecord.worktreeRoot)).toBe(true)
        expect(area.base.sha).toBe(head)
        expect(status(area.directory)).toBe("")
      }
      expect(git(project, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).trim().split("\n")).toEqual([
        "area-1",
        "area-2",
        "main",
      ])

      // Sessions: one main, one owner per area, each where it belongs; nothing made twice.
      const rows = sessionRows(team.server.paths.database)
      const roles = rows.flatMap((row) => {
        const meta = teamMeta(row)
        return meta ? [{ row, role: meta.role, areaID: meta.areaID }] : []
      })
      expect(roles.filter((item) => item.role === "main").map((item) => item.row.id)).toEqual([
        teamRecord.main.sessionID,
      ])
      for (const area of view.areas) {
        const owners = roles.filter((item) => item.role === "owner" && item.areaID === area.id)
        expect(owners.map((item) => item.row.id)).toEqual([required(area.owner.sessionID ?? undefined)])
        expect(same(required(owners[0]).row.directory, area.directory)).toBe(true)
        expect(area.owner).toMatchObject({ previous: [], attached: true })
        expect(area.owner.pending).toBeUndefined()
      }
      expect(rows.filter((row) => row.parentID !== null)).toEqual([])
      expect(refused(team)).toEqual([])
      expect(asked(team)).toEqual([])
    },
    ENABLE_TIMEOUT,
  )

  test(
    "enabling again converges on the same areas, owners and locks",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const sessions = sessionRows(team.server.paths.database).length
      const again = await enableTeam(team, { hint: "[propose-areas 2]" })
      expect(again.op.state).toBe("done")
      expect(again.view.areas.map((area) => [area.id, area.owner.sessionID])).toEqual(
        required(state.areas).map((area) => [area.id, area.owner.sessionID]),
      )
      expect<unknown>(again.view.team?.main.sessionID).toBe(required(state.main))
      expect(sessionRows(team.server.paths.database)).toHaveLength(sessions)
      expect(worktrees(project).map((entry) => entry.locked ?? null)).toEqual([
        null,
        "own.team area:ar_area-1",
        "own.team area:ar_area-2",
      ])
    },
    ENABLE_TIMEOUT,
  )

  test(
    "undo removes the new worktrees and branches and archives the sessions it made; nothing else changes",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const head = git(project, ["rev-parse", "HEAD"]).trim()
      // The project's own files: the areas are inside its `.worktrees` (06 §4.12), and nothing of them may be left.
      const before = files(project).filter((file) => !file.startsWith(".worktrees/"))
      const undone = await team.team("op.undo", { opID: OwnTeam.OpID.make(required(state.opID)) })
      const op = await opEnd(team, undone.opID)
      expect(op.steps.filter((step) => step.state === "failed")).toEqual([])
      expect(op.state).toBe("done")
      expect(op.summary?.lines ?? []).not.toContainEqual(expect.objectContaining({ change: "touched" }))
      expect(await team.team("team.get", { directory: project })).toMatchObject({ team: null })
      expect(worktrees(project).map((entry) => same(entry.path, project))).toEqual([true])
      expect(git(project, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).trim()).toBe("main")
      expect(git(project, ["rev-parse", "HEAD"]).trim()).toBe(head)
      expect(files(project)).toEqual(before)
      for (const area of required(state.areas)) expect(await exists(area.directory)).toBe(false)
      const rows = sessionRows(team.server.paths.database)
      const made = [
        required(state.main),
        ...required(state.areas).map((area) => required(area.owner.sessionID ?? undefined)),
      ]
      for (const id of made) expect(rowOf(rows, id).metadata["own.archived"]).toBe(true)
      expect(rowOf(rows, required(state.viewed)).metadata["own.archived"]).toBeUndefined()
      expect(Object.keys(kv(team.server.paths.database)).filter((key) => key.startsWith("area:"))).toEqual([])
    },
    ENABLE_TIMEOUT,
  )
})

describe.skipIf(!lfsAvailable)("F2 (LFS): [propose-areas 0], undo, then [propose-areas 2 +heavy] and undo", () => {
  const state: { team?: TeamServer; opID?: string; areas?: ReadonlyArray<OwnTeam.AreaView> } = {}

  beforeAll(async () => {
    state.team = await startTeamServer({ name: "enable-f2", project: "f2" })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.stop()
  }, 120_000)

  test(
    "no area: one main, no question, no 401, the repository unchanged; undo leaves no team",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const head = git(project, ["rev-parse", "HEAD"]).trim()
      const viewed = await team.createSession({ model: MODEL["01"], title: "켠 대화" })
      const enabled = await enableTeam(team, { hint: "[propose-areas 0]", sessionID: viewed })
      expect(enabled.op.state).toBe("done")
      expect(enabled.view.areas).toEqual([])
      expect(enabled.view.team?.env.lfs).toBe("system")
      const mains = sessionRows(team.server.paths.database).filter((row) => teamMeta(row)?.role === "main")
      expect(mains.map((row) => row.id)).toEqual([required(enabled.view.team?.main.sessionID)])
      expect(refused(team)).toEqual([])
      expect(asked(team)).toEqual([])
      expect(worktrees(project)).toHaveLength(1)
      expect(git(project, ["rev-parse", "HEAD"]).trim()).toBe(head)
      const undone = await team.team("op.undo", { opID: OwnTeam.OpID.make(enabled.opID) })
      expect((await opEnd(team, undone.opID)).state).toBe("done")
      expect(await team.team("team.get", { directory: project })).toMatchObject({ team: null })
    },
    ENABLE_TIMEOUT,
  )

  test(
    "two code areas: the cone leaves the heavy folders out, the folders are clean and locked",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const viewed = await team.createSession({ model: MODEL["01"], title: "켠 대화" })
      const enabled = await enableTeam(team, {
        hint: `[propose-areas 2 +heavy=${F2_HEAVY.join(",")}]`,
        sessionID: viewed,
      })
      state.opID = enabled.opID
      expect(enabled.op.state).toBe("done")
      expect(enabled.op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(enabled.view.team?.heavy.dirs.toSorted()).toEqual([...F2_HEAVY].toSorted())
      expect(enabled.view.team?.env.lfs).toBe("system")
      state.areas = enabled.view.areas
      expect<unknown>(enabled.view.areas.map((area) => [area.id, area.shape])).toEqual([
        ["ar_area-1", "code"],
        ["ar_area-2", "code"],
      ])
      for (const area of enabled.view.areas) {
        const cone = sparse(area.directory)
        expect(cone).toMatchObject({ enabled: true, cone: true })
        const present = files(area.directory)
        for (const heavy of F2_HEAVY) expect(present.filter((file) => file.startsWith(`${heavy}/`))).toEqual([])
        expect(present).toContain("src/app/main.ts")
        expect(status(area.directory)).toBe("")
        expect(worktrees(project).find((entry) => same(entry.path, area.directory))?.locked).toBe(
          `own.team area:${area.id}`,
        )
      }
      expect(refused(team)).toEqual([])
      expect(asked(team)).toEqual([])
    },
    ENABLE_TIMEOUT,
  )

  test(
    "undo removes both code areas and their branches",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const undone = await team.team("op.undo", { opID: OwnTeam.OpID.make(required(state.opID)) })
      const op = await opEnd(team, undone.opID)
      expect(op.steps.filter((step) => step.state === "failed")).toEqual([])
      expect(op.state).toBe("done")
      expect(worktrees(project)).toHaveLength(1)
      for (const area of required(state.areas)) expect(await exists(area.directory)).toBe(false)
      expect(git(project, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).trim()).toBe("main")
    },
    ENABLE_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** Model requests any fake refused with 401 (the judge must carry the main's slot auth, 06 §3.4). */
function refused(team: TeamServer) {
  return [...team.fakes.codex.requests, ...team.fakes.deepseek.requests, ...team.fakes.anthropic.requests]
    .filter((request) => request.status === 401)
    .map((request) => [request.fake, request.path, request.identity])
}

/** Permission and question requests seen on the event stream (06 TG2: 질문 0). */
function asked(team: TeamServer) {
  return team.events.events
    .filter((event) => event.type === "permission.asked" || event.type === "form.created")
    .map((event) => event.type)
}

function rowOf(rows: ReadonlyArray<SessionRow>, id: string) {
  return required(rows.find((row) => row.id === id))
}

/** A worktree folder is still there (its `.git` file). */
async function exists(directory: string) {
  return Bun.file(path.join(directory, ".git")).exists()
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

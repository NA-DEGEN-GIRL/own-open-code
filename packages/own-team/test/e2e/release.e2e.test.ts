// TG5 내려놓기 안전 (06 §4.7, §8.4, TI-13, §11.3): releasing large-file folders on a real server, and what git itself
// does to a folder that leaves the cone, on this host's git.
//
// - Server (F2 with five heavy folders, two code-only areas): the five states of 4.7 in five fetched folders released
//   at once (only the clean one goes; modified, untracked, ignored and staged work stays as it was, recorded in
//   `cone.kept`); a release asked while the owner works keeps the folder (`busy`); a `done` report in the middle of a
//   turn releases nothing until the turn ended (extended safe point), then the fetched folder goes; under Main 멈춤 the
//   automatic release after `done` does not run.
// - Git procedure (also on dev-host through `test/real-host/run.sh`, 06 §11.2): the status check own runs before a
//   release prints nothing only for a clean folder, and `sparse-checkout set` keeps modified and untracked files but
//   silently deletes ignored ones and the disk copy of a staged new file, which is why own checks first.
//
// The race "an ignored file appears between the check and `set`" cannot be timed from outside the controller; it is
// covered by `test/assets/release.test.ts` (the check runs again right before `set`). Verdicts come from git, the
// files on disk and the area records. Fake credentials only; every listener binds 127.0.0.1. Run from a path without
// '#'. On the real host (`OWN_REAL_HOST_RUN=1`) only the git procedure runs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import type { toolParts } from "../../../own-accounts/test/e2e-kit"
import { commit, git, init, temp, write } from "../fixtures/repo.js"
import type { active, enableTeam, notices, opEnd, ops, startTeamServer, TeamServer, until } from "./harness.js"
import type { sparse } from "./inspect.js"
import { BOOT_TIMEOUT } from "./timeouts.js"

/** On the real host (06 §11.2) only the git procedure runs. */
const HOST = process.env.OWN_REAL_HOST_RUN === "1"
const STEP_TIMEOUT = 300_000

/** The heavy folders of the server's project: F2's three and two more (4.7 needs five fetched folders). */
const HEAVY = ["Assets/Textures", "Assets/Audio", "Content", "Assets/Models", "Assets/Video"] as const

describe("TG5 git procedure: the release check and what `sparse-checkout set` does (06 §4.7)", () => {
  test("the status check prints nothing only for the clean folder; `set` releases it and keeps the others", () => {
    const box = temp("own-team-release-git-")
    try {
      const folder = states(box.root)
      for (const dir of ["d1", "d2", "d3", "d4", "d5"]) expect(check(folder, dir) === "").toBe(dir === "d1")
      git(folder, ["sparse-checkout", "set", "--cone", "src", "d2", "d3", "d4", "d5"])
      expect(fs.existsSync(path.join(folder, "d1"))).toBe(false)
      expect(fs.readFileSync(path.join(folder, "d2", "a.txt"), "utf8")).toBe("modified\n")
      expect(fs.readFileSync(path.join(folder, "d3", "new.txt"), "utf8")).toBe("untracked\n")
      expect(fs.readFileSync(path.join(folder, "d4", "cache.log"), "utf8")).toBe("ignored\n")
      expect(fs.readFileSync(path.join(folder, "d5", "staged.txt"), "utf8")).toBe("staged\n")
    } finally {
      box.dispose()
    }
  })

  test("leaving the cone: modified and untracked files stay, ignored ones and a staged new file's copy go", () => {
    const box = temp("own-team-release-git-")
    try {
      const folder = states(box.root)
      const result = Bun.spawnSync(["git", "-C", folder, "sparse-checkout", "set", "--cone", "src"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
      expect(result.exitCode).toBe(0)
      expect(fs.existsSync(path.join(folder, "d1"))).toBe(false)
      expect(fs.readFileSync(path.join(folder, "d2", "a.txt"), "utf8")).toBe("modified\n")
      expect(fs.readFileSync(path.join(folder, "d3", "new.txt"), "utf8")).toBe("untracked\n")
      // Ignored files are deleted without a word (exit 0): own never releases a folder that holds any.
      expect(fs.existsSync(path.join(folder, "d4", "cache.log"))).toBe(false)
      // The staged new file leaves the disk but stays in the index: status still shows it added.
      expect(fs.existsSync(path.join(folder, "d5", "staged.txt"))).toBe(false)
      expect(git(folder, ["status", "--porcelain=v1"])).toContain("A  d5/staged.txt")
    } finally {
      box.dispose()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Server

interface Kit {
  readonly active: typeof active
  readonly enableTeam: typeof enableTeam
  readonly notices: typeof notices
  readonly opEnd: typeof opEnd
  readonly ops: typeof ops
  readonly sparse: typeof sparse
  readonly startTeamServer: typeof startTeamServer
  readonly toolParts: typeof toolParts
  readonly until: typeof until
}

/** The server side of this file, loaded only off the real host (it needs this workspace's packages). */
async function kit(): Promise<Kit> {
  const { active, enableTeam, notices, opEnd, ops, startTeamServer, until } = await import("./harness.js")
  const { sparse } = await import("./inspect.js")
  const { toolParts } = await import("../../../own-accounts/test/e2e-kit")
  return { active, enableTeam, notices, opEnd, ops, sparse, startTeamServer, toolParts, until }
}

interface Team {
  readonly kit: Kit
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly home: string
  readonly areas: ReadonlyArray<OwnTeam.AreaID>
}

describe.skipIf(HOST || !lfs())("TG5 releases on a real server (F2 with five heavy folders, two code areas)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const tools = await kit()
    const { f2 } = await import("../fixtures/lfs-repo.js")
    const server = await tools.startTeamServer({
      name: "release",
      project: (root) => {
        const home = f2(root).home
        write(home, {
          "Assets/Models/model.bin": crypto.getRandomValues(new Uint8Array(20_000)),
          "Assets/Video/clip.bin": crypto.getRandomValues(new Uint8Array(20_000)),
          ".gitignore": "*.log\n",
        })
        commit(home, "two more heavy folders")
        return home
      },
    })
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await tools.enableTeam(server, {
      hint: `[propose-areas 2 +heavy=${HEAVY.join(",")}]`,
      sessionID: viewed,
    })
    const team = required(enabled.view.team ?? undefined)
    expect(team.heavy.dirs.toSorted()).toEqual([...HEAVY].toSorted())
    state.team = {
      kit: tools,
      server,
      teamID: team.id,
      home: required(server.project),
      areas: enabled.view.areas.map((area) => area.id),
    }
    for (const area of enabled.view.areas)
      await server.accounts(
        "session.approval.set",
        { sessionID: required(area.owner.sessionID ?? undefined), mode: "full" },
        area.directory,
      )
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "the five states released at once: only the clean folder goes; the others stay as they were, recorded as kept",
    async () => {
      const team = required(state.team)
      const area = await fetched(team, 0, HEAVY)
      const folder = area.directory
      const audio = path.join(folder, "Assets", "Audio", "music.wav")
      write(folder, {
        "Assets/Audio/music.wav": crypto.getRandomValues(new Uint8Array(4_000)),
        "Content/new.txt": "untracked\n",
        "Assets/Models/cache.log": "ignored\n",
        "Assets/Video/staged.txt": "staged\n",
      })
      git(folder, ["add", "--", "Assets/Video/staged.txt"])
      const modified = fs.readFileSync(audio)
      const status = git(folder, ["status", "--porcelain=v1", "--untracked-files=all"])

      const started = await team.server.team("area.paths", {
        teamID: team.teamID,
        areaID: area.id,
        release: [...HEAVY],
      })
      expect((await team.kit.opEnd(team.server, started.opID)).state).toBe("done")
      const after = await areaOf(team, 0)
      const cone = team.kit.sparse(folder).list
      expect(cone).not.toContain("Assets/Textures")
      expect(fs.existsSync(path.join(folder, "Assets", "Textures"))).toBe(false)
      for (const dir of ["Assets/Audio", "Content", "Assets/Models", "Assets/Video"]) expect(cone).toContain(dir)
      expect(Object.keys(after.cone.extra).toSorted()).toEqual([
        "Assets/Audio",
        "Assets/Models",
        "Assets/Video",
        "Content",
      ])
      expect(Object.keys(after.cone.kept).toSorted()).toEqual([
        "Assets/Audio",
        "Assets/Models",
        "Assets/Video",
        "Content",
      ])
      // Nothing of the work changed: the modified, untracked, ignored and staged files are as they were.
      expect(fs.readFileSync(audio).equals(modified)).toBe(true)
      expect(fs.readFileSync(path.join(folder, "Content", "new.txt"), "utf8")).toBe("untracked\n")
      expect(fs.readFileSync(path.join(folder, "Assets", "Models", "cache.log"), "utf8")).toBe("ignored\n")
      expect(fs.readFileSync(path.join(folder, "Assets", "Video", "staged.txt"), "utf8")).toBe("staged\n")
      expect(git(folder, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(status)
      expect(team.kit.notices(team.server, "paths.kept").length).toBeGreaterThan(0)
    },
    STEP_TIMEOUT,
  )

  test(
    "a release asked while the owner works is not done: the folder stays, kept as busy",
    async () => {
      const team = required(state.team)
      const area = await fetched(team, 0, ["Assets/Textures"])
      const owner = required(area.owner.sessionID ?? undefined)
      await team.server.server.prompt(owner, "[slow 6000]")
      await team.kit.until(async () => (await team.kit.active(team.server)).has(owner), "the owner never started")
      const started = await team.server.team("area.paths", {
        teamID: team.teamID,
        areaID: area.id,
        release: ["Assets/Textures"],
      })
      await team.kit.opEnd(team.server, started.opID)
      expect(team.kit.sparse(area.directory).list).toContain("Assets/Textures")
      expect(fs.existsSync(path.join(area.directory, "Assets", "Textures", "rock.png"))).toBe(true)
      expect((await areaOf(team, 0)).cone.kept["Assets/Textures"]).toBe("busy")
      await team.server.server.waitIdle(owner)
    },
    STEP_TIMEOUT,
  )

  test(
    "`done` in the middle of a turn: nothing is released while the turn runs; the fetched folder goes after it",
    async () => {
      const team = required(state.team)
      const area = await fetched(team, 1, ["Assets/Textures"])
      const owner = required(area.owner.sessionID ?? undefined)
      await team.server.server.prompt(owner, '[report done 끝냈습니다] [shell bun -e "await Bun.sleep(5000)"]')
      await team.kit.until(
        async () =>
          (await team.kit.toolParts(team.server.server, owner, "shell")).some(
            (part) => part.state.status === "running",
          ),
        "the shell step never ran",
        STEP_TIMEOUT,
      )
      // The report is in, the run goes on: not an extended safe point.
      expect(team.kit.sparse(area.directory).list).toContain("Assets/Textures")
      expect(fs.existsSync(path.join(area.directory, "Assets", "Textures", "rock.png"))).toBe(true)
      await team.server.server.waitIdle(owner)
      await team.kit.until(
        async () => !team.kit.sparse(area.directory).list.includes("Assets/Textures"),
        "the fetched folder was never released after the turn",
        STEP_TIMEOUT,
      )
      expect(fs.existsSync(path.join(area.directory, "Assets", "Textures"))).toBe(false)
      expect((await areaOf(team, 1)).cone.extra["Assets/Textures"]).toBeUndefined()
      const release = team.kit
        .ops(db(team), team.teamID)
        .findLast((op) => op.kind === "paths" && op.areaID === area.id && op.by === "auto")
      expect(release?.state).toBe("done")
    },
    STEP_TIMEOUT,
  )

  test(
    "under Main 멈춤 the automatic release after `done` does not run",
    async () => {
      const team = required(state.team)
      const areaID = required(team.areas[1])
      await team.server.team("area.pause", { teamID: team.teamID, areaID, on: true })
      const releases = () =>
        team.kit
          .ops(db(team), team.teamID)
          .filter(
            (op) =>
              op.kind === "paths" &&
              op.areaID === areaID &&
              op.by === "auto" &&
              op.steps.some((step) => step.kind === "release"),
          ).length
      const before = releases()
      const area = await fetched(team, 1, ["Assets/Audio"])
      const owner = required(area.owner.sessionID ?? undefined)
      await team.server.turn(owner, "[report done 멈춤 중에 끝냈습니다]")
      await Bun.sleep(5_000)
      expect(team.kit.sparse(area.directory).list).toContain("Assets/Audio")
      expect(fs.existsSync(path.join(area.directory, "Assets", "Audio", "music.wav"))).toBe(true)
      expect(releases()).toBe(before)
      await team.server.team("area.pause", { teamID: team.teamID, areaID, on: false })
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** The owner fetches `dirs` with `team_need_paths` (4.6); returns the area once they are in its cone and on disk. */
async function fetched(team: Team, index: number, dirs: ReadonlyArray<string>) {
  const area = await areaOf(team, index)
  await team.server.turn(required(area.owner.sessionID ?? undefined), `[need-paths ${dirs.join(" ")}]`)
  await team.kit.until(
    async () => {
      const now = await areaOf(team, index)
      return dirs.every((dir) => now.cone.extra[dir] !== undefined && fs.existsSync(path.join(now.directory, dir)))
    },
    `${dirs.join(", ")} never came in`,
    STEP_TIMEOUT,
  )
  return areaOf(team, index)
}

async function areaOf(team: Team, index: number) {
  const view = await team.server.team("team.get", { directory: team.home })
  return required(view.areas.find((area) => area.id === team.areas[index]))
}

function db(team: Team) {
  return team.server.server.paths.database
}

/**
 * A code-only folder (cone `src` and `d1`–`d5`) with the five states of 4.7: `d1` clean, `d2` a modified tracked file,
 * `d3` an untracked file, `d4` an ignored file only, `d5` a staged new file.
 */
function states(root: string) {
  const home = init(path.join(root, "home"))
  write(home, {
    ".gitignore": "*.log\n",
    "src/app.ts": "export const app = 1\n",
    ...Object.fromEntries(["d1", "d2", "d3", "d4", "d5"].map((dir) => [`${dir}/a.txt`, `${dir}\n`])),
  })
  const start = commit(home, "five folders")
  const folder = path.join(root, "team", "area")
  git(home, ["worktree", "add", "-q", "--no-checkout", "-b", "area", folder, start])
  git(folder, ["sparse-checkout", "set", "--cone", "src", "d1", "d2", "d3", "d4", "d5"])
  git(folder, ["reset", "-q", "--hard"])
  write(folder, {
    "d2/a.txt": "modified\n",
    "d3/new.txt": "untracked\n",
    "d4/cache.log": "ignored\n",
    "d5/staged.txt": "staged\n",
  })
  git(folder, ["add", "--", "d5/staged.txt"])
  return folder
}

/** The 4.7 check of one leaving folder: prints nothing only when nothing at all is in it. */
function check(folder: string, dir: string) {
  return git(folder, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--", `${dir}/`])
}

/** git-lfs is installed (F2 needs it; dev-host has none, 06 §4.13). */
function lfs() {
  return Bun.spawnSync(["git", "lfs", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

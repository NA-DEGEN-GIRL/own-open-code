// The heavy-folder list follows the project on a real server (06 §4.4, §4.11, user decision 2026-10-09: heavy assets
// are never copied into every worktree, also when the LLM builds the project and the assets come later). A game project
// starts as code only (no heavy folders, so its areas are `plain`), with Unity's ignore rules and LFS globs of the F5
// fixture; thresholds are lowered through the team settings (`askDiskBytes` 30 kB):
//
// (a) an owner commits LFS textures (F5's `Assets/Textures`, `.meta` files, a script beside them) and it is
//     integrated: the integration measures K (`integrate-heavy`), and the `heavy` op after the advance grows the list,
//     turns the other plain area code-only without a new conversation (nothing leaves its folder), records the area
//     that made the assets `full` with a suggestion, and the other area's merge of the target leaves the textures out
//     while the script comes in; its undo puts everything back after the download confirm.
// (b) committed non-LFS simulation output on the target (a main folder commit and the main's run end): the list grows by
//     `sim/output` at its own depth; an area's merge brings `sim/src` but never the output.
// (c) an ignored engine cache in an area (`Library/`): one `disk.ignored` notice after the owner's run; nothing is
//     shared or deleted.
//
// Verdicts come from the op and team records, git and the folders. Fake credentials only; every listener binds
// 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Heavy } from "../../src/assets/heavy.js"
import { F5_IGNORE, meta } from "../fixtures/f5-unity.js"
import { lfsAvailable } from "../fixtures/lfs-repo.js"
import { commit, git, init, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  answer,
  confirmOf,
  enableTeam,
  notices,
  opEnd,
  ops,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { sparse } from "./inspect.js"

const STEP_TIMEOUT = 420_000

/** F5's textures, smaller and committed later by an owner (LFS through the local clean filter). */
const TEXTURES = { "Assets/Textures/rock.png": 40_000, "Assets/Textures/tree.png": 30_000 } as const

interface Setup {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly home: string
  readonly main: string
  readonly art: OwnTeam.AreaView
  readonly ui: OwnTeam.AreaView
}

describe.skipIf(!lfsAvailable)("the heavy list follows the project on a real server (06 §4.4)", () => {
  const state: { setup?: Setup; server?: TeamServer; grewOp?: string } = {}

  beforeAll(async () => {
    const server = await startTeamServer({
      name: "heavy",
      project: (root) => {
        const home = init(path.join(root, "home"))
        git(home, ["lfs", "install", "--local", "--skip-repo"])
        write(home, {
          ".gitattributes": ["*.png", "*.fbx", "*.wav"]
            .map((glob) => `${glob} filter=lfs diff=lfs merge=lfs -text\n`)
            .join(""),
          ".gitignore": F5_IGNORE,
          "README.md": "# game\n",
          "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
          "Assets/Scripts.meta": meta("a1"),
          "Assets/Scripts/Main.cs": "public class Main {}\n",
        })
        commit(home, "a new game, code only")
        return home
      },
    })
    state.server = server
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2 art ui]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    expect(team.heavy.dirs).toEqual([])
    const art = required(enabled.view.areas.find((area) => area.id === "ar_art"))
    const ui = required(enabled.view.areas.find((area) => area.id === "ar_ui"))
    expect([art.shape, ui.shape]).toEqual(["plain", "plain"])
    await server.team("settings.set", { teamID: team.id, patch: { policy: { askDiskBytes: 30_000 } } })
    state.setup = { server, teamID: team.id, home: required(server.project), main: team.main.sessionID, art, ui }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "(a) LFS textures integrated: the list grows, the other area turns code-only quietly, its merge leaves them out",
    async () => {
      const setup = required(state.setup)
      write(setup.art.directory, {
        "Assets/Textures.meta": meta("b1"),
        "Assets/Textures/rock.png.meta": meta("b2"),
        "Assets/Textures/tree.png.meta": meta("b3"),
        "Assets/Scripts/Player.cs": "public class Player {}\n",
        ...Object.fromEntries(Object.entries(TEXTURES).map(([file, size]) => [file, crypto.randomBytes(size)])),
      })
      const source = commit(setup.art.directory, "textures")
      expect(git(setup.art.directory, ["lfs", "ls-files", "-n"])).toContain("Assets/Textures/rock.png")
      await setup.server.turn(owner(setup.art), "[report ready 텍스처를 넣었습니다]")
      await quiet(setup)
      const before = new Set(ops(db(setup), setup.teamID).map((op) => op.id))
      const started = await setup.server.team("area.integrate", { teamID: setup.teamID, areaID: setup.art.id })
      const integrated = await opEnd(setup.server, started.opID, { timeoutMs: STEP_TIMEOUT })
      expect(integrated.state).toBe("done")
      // Step 5½ measured K for the list (cached for the op after the advance).
      const measured = integrated.steps.find((step) => step.kind === "integrate-heavy")
      expect(measured).toMatchObject({ state: "done" })
      expect(measured?.note).toContain("Assets/Textures")
      const integration = await advanced(setup, started.integrationID)
      expect(integration).toMatchObject({ state: "done", source })

      // The `heavy` op after the advance.
      const grew = await waitValue(
        async () => ops(db(setup), setup.teamID).find((op) => op.kind === "heavy" && !before.has(op.id)),
        "no heavy op after the integration",
        STEP_TIMEOUT,
      )
      state.grewOp = grew.id
      const done = await opEnd(setup.server, grew.id, { timeoutMs: STEP_TIMEOUT })
      expect(done).toMatchObject({ state: "done", by: "auto", undo: { available: true } })
      const view = await setup.server.team("team.get", { directory: setup.home })
      const team = required(view.team ?? undefined)
      expect(team.heavy.dirs).toEqual(["Assets/Textures"])
      const art = required(view.areas.find((area) => area.id === setup.art.id))
      const ui = required(view.areas.find((area) => area.id === setup.ui.id))
      expect(art.shape).toBe("full")
      expect(ui.shape).toBe("code")
      // No new conversation for the quiet conversion; the maker keeps its files.
      expect(ui.owner.sessionID).toBe(setup.ui.owner.sessionID)
      expect(fs.existsSync(path.join(setup.art.directory, "Assets", "Textures", "rock.png"))).toBe(true)
      expect(done.summary?.lines).toContainEqual(expect.objectContaining({ kind: "heavy", dirs: ["Assets/Textures"] }))
      expect(done.summary?.lines).toContainEqual(
        expect.objectContaining({
          kind: "suggest",
          suggestion: expect.objectContaining({ kind: "convert", area: "art" }),
        }),
      )
      expect(notices(setup.server, "heavy.grew").length).toBeGreaterThanOrEqual(1)

      // ui merges the target (in a terminal) and its owner runs once: the script comes in, the textures stay out.
      git(setup.ui.directory, ["merge", "-q", "--ff-only", "main"])
      await setup.server.turn(owner(setup.ui), "합쳤습니다")
      await until(
        async () => fs.existsSync(path.join(setup.ui.directory, "Assets", "Scripts", "Player.cs")),
        "the script never came into ui",
        STEP_TIMEOUT,
      )
      expect(fs.existsSync(path.join(setup.ui.directory, "Assets", "Textures"))).toBe(false)
      expect(sparse(setup.ui.directory).enabled).toBe(true)
      expect(git(setup.ui.directory, ["status", "--porcelain"])).toBe("")
    },
    STEP_TIMEOUT,
  )

  test(
    "(a) undo: the list back after the download confirm, the folder kept out of later growths, ui full again",
    async () => {
      const setup = required(state.setup)
      await quiet(setup)
      const undone = await setup.server.team("op.undo", { opID: OwnTeam.OpID.make(required(state.grewOp)) })
      const asked = await confirmOf(setup.server, undone.opID, "convert-confirm", STEP_TIMEOUT)
      expect(asked.confirm.text).toContain("전체 폴더")
      expect((await answer(setup.server, asked.op.id, asked.step, "do")).status).toBe(200)
      expect((await opEnd(setup.server, undone.opID, { timeoutMs: STEP_TIMEOUT })).state).toBe("done")
      const view = await setup.server.team("team.get", { directory: setup.home })
      const team = required(view.team ?? undefined)
      expect(team.heavy.dirs).toEqual([])
      expect(team.heavy.light).toEqual(["Assets/Textures"])
      expect(view.areas.find((area) => area.id === setup.ui.id)?.shape).toBe("plain")
      expect(view.areas.find((area) => area.id === setup.art.id)?.shape).toBe("plain")
      expect(fs.existsSync(path.join(setup.ui.directory, "Assets", "Textures", "rock.png"))).toBe(true)
      expect(sparse(setup.ui.directory).enabled).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "(b) committed non-LFS output on the target: the list grows by `sim/output`; an area's merge never brings it",
    async () => {
      const setup = required(state.setup)
      await quiet(setup)
      const before = new Set(ops(db(setup), setup.teamID).map((op) => op.id))
      write(setup.home, {
        "sim/src/run.py": "print('run')\n",
        "sim/output/run1.csv": "1,".repeat(8_000),
        "sim/output/run2.csv": "2,".repeat(8_000),
      })
      const tip = commit(setup.home, "simulation output")
      // The main's next run end looks at the target (no timer).
      await setup.server.turn(setup.main, "확인해 주세요")
      const grew = await waitValue(
        async () => ops(db(setup), setup.teamID).find((op) => op.kind === "heavy" && !before.has(op.id)),
        "no heavy op after the main's run",
        STEP_TIMEOUT,
      )
      expect((await opEnd(setup.server, grew.id, { timeoutMs: STEP_TIMEOUT })).state).toBe("done")
      const view = await setup.server.team("team.get", { directory: setup.home })
      expect(view.team?.heavy).toMatchObject({ dirs: ["sim/output"], measuredAt: tip })
      // Both plain areas had none of it in their HEAD: code-only now, nothing left their folders.
      expect(view.areas.map((area) => area.shape).toSorted()).toEqual(["code", "code"])
      expect(fs.existsSync(Heavy.cacheFile(required(view.team ?? undefined), tip))).toBe(true)
      git(setup.ui.directory, ["merge", "-q", "--ff-only", "main"])
      await setup.server.turn(owner(setup.ui), "합쳤습니다")
      await until(
        async () => fs.existsSync(path.join(setup.ui.directory, "sim", "src", "run.py")),
        "sim/src never came into ui",
        STEP_TIMEOUT,
      )
      expect(fs.existsSync(path.join(setup.ui.directory, "sim", "output"))).toBe(false)
      expect(git(setup.ui.directory, ["status", "--porcelain"])).toBe("")
    },
    STEP_TIMEOUT,
  )

  test(
    "(c) an ignored engine cache over the disk limit is named once after the owner's run; nothing is touched",
    async () => {
      const setup = required(state.setup)
      write(setup.ui.directory, {
        "Library/ArtifactDB": crypto.randomBytes(20_000),
        "Library/SourceAssetDB": crypto.randomBytes(20_000),
      })
      await setup.server.turn(owner(setup.ui), "캐시를 만들었습니다")
      const named = await waitValue(
        async () => notices(setup.server, "disk.ignored").find((item) => libraryOf(item)),
        "no disk.ignored notice",
        STEP_TIMEOUT,
      )
      expect(named).toMatchObject({ areaID: setup.ui.id, data: { dir: "Library", bytes: 40_000 } })
      await setup.server.turn(owner(setup.ui), "다시 확인")
      await Bun.sleep(2_000)
      expect(notices(setup.server, "disk.ignored").filter((item) => libraryOf(item))).toHaveLength(1)
      expect(fs.existsSync(path.join(setup.ui.directory, "Library", "ArtifactDB"))).toBe(true)
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

function owner(area: OwnTeam.AreaView) {
  return required(area.owner.sessionID ?? undefined)
}

/**
 * The integration once it no longer runs. A `ready` report wakes the main, and while that turn runs the home (it has
 * the target checked out) is not at its safe point: an advance that came then waits (`in-use`); it is tried again once
 * the main is idle, as the user's 다시 반영 (7.6).
 */
async function advanced(setup: Setup, integrationID: OwnTeam.IntegrationID) {
  const finished = () =>
    waitValue(
      async () => {
        const found = (await setup.server.team("integration.get", { integrationID })).integration
        return found.state === "running" ? undefined : found
      },
      `integration ${integrationID} never ended`,
      STEP_TIMEOUT,
    )
  const found = await finished()
  if (found.state !== "waiting" || found.waiting?.why !== "in-use") return found
  await setup.server.server.waitIdle(setup.main)
  await quiet(setup)
  const again = await setup.server.team("area.integrate", { teamID: setup.teamID, areaID: found.areaID })
  await opEnd(setup.server, again.opID, { waiting: true, timeoutMs: STEP_TIMEOUT })
  return finished()
}

/** The team is quiet: no op runs or waits, also a moment later (a release op may follow another op). */
async function quiet(setup: Setup) {
  const idle = async () => (await setup.server.team("team.get", { directory: setup.home })).op === null
  await until(idle, "a team op never ended", STEP_TIMEOUT)
  await Bun.sleep(3_000)
  await until(idle, "a team op never ended", STEP_TIMEOUT)
}

function db(setup: Setup) {
  return setup.server.server.paths.database
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

/** A `disk.ignored` notice about the `Library` folder. */
function libraryOf(notice: { readonly data?: unknown }) {
  return JSON.stringify(notice.data ?? {}).includes('"dir":"Library"')
}

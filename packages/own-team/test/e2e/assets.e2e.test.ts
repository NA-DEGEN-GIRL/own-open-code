// TG11 합치기, the `.assets` items (06 §4.10, §7.2 step 7, §11.3) on a real server: F5 (a Unity-shaped LFS repository
// with a bare `file://` remote) with a code check (`bun run typecheck`) and an asset check (`bun run build`, an
// "engine import" that rewrites a `.meta`, `[propose-areas 1 +heavy=… +check +assets]`), one code-only area that fetched
// `Assets/Textures`.
//
// - A candidate that changes no heavy folder and asks for no engine run: step 7 records `skipped`, `.assets` is not made.
// - The first `.assets` asks when making it reaches `askDiskBytes` (0.3): steps 0-6 end in an op of their own and step 7
//   waits as a confirm in the next; 두기 ends the integration `failed` (`assets`) with nothing made and the target where
//   it was; asked again and answered, `.assets` is made: a full worktree with a detached HEAD at K, locked
//   `own.team assets`, LFS files smudged from the shared store, never the home or an area folder; the check passes and
//   the target moves.
// - `[report ready assets]` (`team_report{assets}`, Area.candidate.assets) runs the check without a heavy change; the
//   `.meta` the previous check left in `.assets` goes to the run's hold ref `refs/own/hold/assets/<op>` first (TI-1).
// - A commit the user made in `.assets` (the engine opened there) goes to `refs/own/keep/<sha>` before the folder moves
//   (TI-8, `detached.kept`).
// - A candidate that deletes a file of a heavy folder stops the integration (`heavy`, the 4.10 candidate check).
// - The server is killed while the asset check runs: the restart resumes the op, the check runs again in the folder
//   still prepared for K (no second reset or hold), and the integration ends `done`.
//
// Verdicts come from the integration records, git (refs, `worktree list`, the folder's HEAD and files) and the asset
// check's own run log. Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { AssetsVerify } from "../../src/assets/verify.js"
import { lfsAvailable } from "../fixtures/lfs-repo.js"
import { F5_HEAVY, f5 } from "../fixtures/f5-unity.js"
import { commit, git, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  answer,
  confirmOf,
  enableTeam,
  integrations,
  notices,
  opEnd,
  ops,
  same,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { sparse, worktrees } from "./inspect.js"

const STEP_TIMEOUT = 420_000
/** The `.meta` the asset check rewrites (an engine import), in a heavy folder. */
const META = "Assets/Textures/rock.png.meta"
/** The asset check's run log, beside `.assets` in the team's worktree root (one `start`/`end` line per run). */
const RUNS = "e2e-assets-runs.log"

/** The code check (`bun run typecheck`). */
const CHECK_SOURCE = 'console.log("e2e check passed")\n'

/** While this file exists in the worktree root, an asset check on a commit with `slow.txt` waits. */
const HOLD = "assets.hold"

/**
 * The asset check (`bun run build`) as an engine import: it logs where and on which commit it runs, waits while the
 * commit has `slow.txt` and the test holds {@link HOLD} beside the worktrees, then rewrites {@link META} the way an
 * import changes a `.meta`. (An epoch deadline in `slow.txt` ran out under load before the kill came, MR13.)
 */
const ASSETS_SOURCE = [
  'import fs from "node:fs"',
  'import path from "node:path"',
  `const log = path.join(process.cwd(), "..", "${RUNS}")`,
  'const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim()',
  "fs.appendFileSync(log, `start ${head} ${process.cwd()}\\n`)",
  `const hold = path.join(process.cwd(), "..", "${HOLD}")`,
  'while (fs.existsSync("slow.txt") && fs.existsSync(hold)) await Bun.sleep(100)',
  `fs.appendFileSync("${META}", \`imported: \${head}\\n\`)`,
  "fs.appendFileSync(log, `end ${head}\\n`)",
  'console.log("e2e assets passed")',
  "",
].join("\n")

interface Setup {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly home: string
  readonly worktreeRoot: string
  /** The team main session (its folder, the home, has the target checked out). */
  readonly main: string
  readonly area: OwnTeam.AreaView
}

describe.skipIf(!lfsAvailable)("TG11 `.assets` on a real server (F5, LFS, one code-only area)", () => {
  const state: { setup?: Setup; server?: TeamServer } = {}

  beforeAll(async () => {
    const server = await startTeamServer({
      name: "assets",
      project: (root) => {
        const home = f5(root).home
        write(home, {
          "package.json": `${JSON.stringify({ name: "f5", scripts: { typecheck: "bun check.ts", build: "bun assets.ts" } }, null, 2)}\n`,
          "bun.lock": "{}\n",
          "check.ts": CHECK_SOURCE,
          "assets.ts": ASSETS_SOURCE,
        })
        commit(home, "checks")
        return home
      },
    })
    state.server = server
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await enableTeam(server, {
      hint: `[propose-areas 1 +heavy=${F5_HEAVY.join(",")} +check +assets]`,
      sessionID: viewed,
    })
    const team = required(enabled.view.team ?? undefined)
    expect(team.commands.assets).toHaveLength(1)
    expect(team.commands.code).toHaveLength(1)
    const area = required(enabled.view.areas[0])
    expect(area.shape).toBe("code")
    // The owner works on textures: the heavy folder comes in (no confirm under the default limits).
    const fetched = await server.team("area.paths", { teamID: team.id, areaID: area.id, add: ["Assets/Textures"] })
    expect((await opEnd(server, fetched.opID)).state).toBe("done")
    expect(fs.existsSync(path.join(area.directory, META))).toBe(true)
    state.setup = {
      server,
      teamID: team.id,
      home: required(server.project),
      worktreeRoot: team.worktreeRoot,
      main: team.main.sessionID,
      area,
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    // The server goes even when the setup failed half way (its temp root with it).
    await state.server?.stop()
  }, 120_000)

  test(
    "no heavy change and no engine run asked: step 7 records `skipped` and `.assets` is not made",
    async () => {
      const setup = required(state.setup)
      write(setup.area.directory, { "Assets/Scripts/Enemy.cs": "public class Enemy {}\n" })
      const source = await commitAndReady(setup, "enemy script")
      const done = await integrate(setup)
      expect(done.integration).toMatchObject({ state: "done", source, verify: { assets: "skipped" } })
      expect(fs.existsSync(assets(setup))).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "the first `.assets` asks: 두기 stops the integration with nothing made; answered, the folder is made at K",
    async () => {
      const setup = required(state.setup)
      await fetched(setup)
      await setup.server.team("settings.set", { teamID: setup.teamID, patch: { policy: { askDiskBytes: 1 } } })
      write(setup.area.directory, { [META]: `${read(setup.area.directory, META)}tuned: 1\n` })
      const source = await commitAndReady(setup, "tune the rock texture")
      const before = tip(setup.home)

      const declined = await asked(setup)
      expect(declined.confirm.text).toContain(".assets")
      expect(declined.confirm.bytes ?? 0).toBeGreaterThan(0)
      expect((await answer(setup.server, declined.op.id, declined.step, "skip")).status).toBe(200)
      const failed = await waitValue(async () => {
        const found = integrations(db(setup), setup.teamID).findLast((item) => item.source === source)
        return found?.state === "failed" ? found : undefined
      }, "the declined integration never failed")
      expect(failed.failure).toBe("assets")
      expect(fs.existsSync(assets(setup))).toBe(false)
      expect(tip(setup.home)).toBe(before)
      expect(markers(setup.home, failed.id)).toEqual([])

      const confirmed = await asked(setup)
      expect((await answer(setup.server, confirmed.op.id, confirmed.step, "do")).status).toBe(200)
      expect((await opEnd(setup.server, confirmed.op.id, { timeoutMs: STEP_TIMEOUT })).state).toBe("done")
      // Steps 8-9 follow in an op of their own once the confirmed check passed.
      const integration = await ended(setup, confirmed.integrationID)
      expect(integration).toMatchObject({ state: "done", source })
      const candidate = required(integration.candidate)
      expect(integration.verify.assets).toMatchObject({ ok: true, sha: candidate })
      expect(tip(setup.home)).toBe(candidate)

      const folder = assets(setup)
      const entry = required(worktrees(setup.home).find((item) => same(item.path, folder)))
      expect(entry).toMatchObject({ detached: true, head: candidate, locked: AssetsVerify.LOCK_REASON })
      // A full folder: every heavy folder is there, LFS files smudged (no pointer text).
      expect(sparse(folder).enabled).toBe(false)
      for (const dir of F5_HEAVY) expect(fs.existsSync(path.join(folder, ...dir.split("/")))).toBe(true)
      expect(fs.statSync(path.join(folder, "Assets", "Textures", "rock.png")).size).toBe(40_000)
      // The check ran there, never in the home or the area folder, and its import changed the `.meta`.
      const ran = runs(setup).filter((line) => line.kind === "start" && line.sha === candidate)
      expect(ran.map((line) => same(line.cwd, folder))).toEqual([true])
      expect(read(folder, META)).toContain(`imported: ${candidate}`)
      expect(git(folder, ["status", "--porcelain"])).toContain(META)
      expect(read(setup.home, META)).not.toContain("imported:")
      await setup.server.team("settings.set", {
        teamID: setup.teamID,
        patch: { policy: { askDiskBytes: OwnTeam.POLICY.askDiskBytes } },
      })
    },
    STEP_TIMEOUT,
  )

  test(
    "`[report ready assets]` runs the check without a heavy change; the last check's `.meta` goes to a hold ref",
    async () => {
      const setup = required(state.setup)
      const previous = read(assets(setup), META)
      await quiet(setup)
      write(setup.area.directory, { "Assets/Scripts/Spawner.cs": "public class Spawner {}\n" })
      const source = await commitAndReady(setup, "spawner", "[report ready assets 엔진에서 다시 가져와야 합니다]")
      expect((await areaOf(setup)).candidate).toMatchObject({ sha: source, assets: true })
      const done = await integrate(setup)
      expect(done.integration.state).toBe("done")
      const result = done.integration.verify.assets
      if (result === undefined || result === "skipped") throw new Error(`step 7 did not run: ${result}`)
      expect(result).toMatchObject({ ok: true, sha: done.integration.candidate })
      const held = required(result.heldRef)
      expect(held).toBe(`refs/own/hold/assets/${done.op.id}`)
      expect(git(setup.home, ["show", `${held}:${META}`])).toBe(previous)
      expect(done.op.summary?.lines).toContainEqual(expect.objectContaining({ kind: "ref", ref: held }))
    },
    STEP_TIMEOUT,
  )

  test(
    "a commit the user made in `.assets` goes to a keep ref before the folder moves (TI-8)",
    async () => {
      const setup = required(state.setup)
      const folder = assets(setup)
      git(folder, ["commit", "-q", "-am", "engine tweak in .assets"])
      const made = git(folder, ["rev-parse", "HEAD"]).trim()
      await fetched(setup)
      write(setup.area.directory, { [META]: `${read(setup.area.directory, META)}tuned: 2\n` })
      await commitAndReady(setup, "tune again")
      const done = await integrate(setup)
      expect(done.integration.state).toBe("done")
      const result = done.integration.verify.assets
      if (result === undefined || result === "skipped") throw new Error(`step 7 did not run: ${result}`)
      expect(result.keptRefs).toEqual([`refs/own/keep/${made}`])
      expect(git(setup.home, ["rev-parse", `refs/own/keep/${made}`]).trim()).toBe(made)
      expect(notices(setup.server, "detached.kept").map((item) => JSON.stringify(item))).toContainEqual(
        expect.stringContaining(`refs/own/keep/${made}`),
      )
      expect(git(folder, ["rev-parse", "HEAD"]).trim()).toBe(required(done.integration.candidate))
    },
    STEP_TIMEOUT,
  )

  test(
    "a candidate that deletes a file of a heavy folder stops the integration (`heavy`)",
    async () => {
      const setup = required(state.setup)
      await fetched(setup)
      const before = tip(setup.home)
      git(setup.area.directory, ["rm", "-q", "--", "Assets/Textures/tree.png.meta"])
      await commitAndReady(setup, "drop a meta")
      const done = await integrate(setup)
      expect(done.integration).toMatchObject({ state: "failed", failure: "heavy" })
      expect(tip(setup.home)).toBe(before)
      // The owner puts it back; the next candidate deletes nothing.
      git(setup.area.directory, ["revert", "--no-edit", "HEAD"])
    },
    STEP_TIMEOUT,
  )

  test(
    "killed while the asset check runs: the restart resumes it in the folder prepared for K and the integration ends",
    async () => {
      const setup = required(state.setup)
      await fetched(setup)
      const holds = refs(setup.home, "refs/own/hold/assets/")
      const hold = path.join(setup.worktreeRoot, HOLD)
      fs.writeFileSync(hold, "")
      write(setup.area.directory, {
        [META]: `${read(setup.area.directory, META)}tuned: 3\n`,
        "slow.txt": "held\n",
      })
      const source = await commitAndReady(setup, "tune slowly")
      const started = await integrateNow(setup)
      const integrationID = started.integrationID
      const candidate = await waitValue(
        async () => {
          const found = integrations(db(setup), setup.teamID).find((item) => item.id === integrationID)
          const sha = found?.candidate
          return sha && runs(setup).some((line) => line.kind === "start" && line.sha === sha) ? sha : undefined
        },
        "the asset check never started",
        STEP_TIMEOUT,
      )
      await setup.server.restart({ kill: true })
      // The restart starts the check again in the same folder; only then may it finish.
      await waitValue(
        async () =>
          runs(setup).filter((line) => line.kind === "start" && line.sha === candidate).length >= 2 ? true : undefined,
        "the asset check was not resumed after the restart",
        STEP_TIMEOUT,
      )
      fs.rmSync(hold, { force: true })
      const integration = await ended(setup, integrationID)
      expect(integration).toMatchObject({ state: "done", source, candidate })
      expect(integration.verify.assets).toMatchObject({ ok: true, sha: candidate })
      const lines = runs(setup).filter((line) => line.sha === candidate)
      console.log(
        `[TG11 record] .assets check killed and resumed: ${lines.filter((line) => line.kind === "start").length} starts, ${lines.filter((line) => line.kind === "end").length} ends`,
      )
      expect(lines.filter((line) => line.kind === "start").length).toBeGreaterThanOrEqual(2)
      expect(lines.some((line) => line.kind === "end")).toBe(true)
      // One `.assets` worktree; the resumed run made no second hold ref.
      expect(worktrees(setup.home).filter((item) => same(item.path, assets(setup)))).toHaveLength(1)
      expect(refs(setup.home, "refs/own/hold/assets/").length - holds.length).toBeLessThanOrEqual(1)
      expect(tip(setup.home)).toBe(candidate)
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

async function areaOf(setup: Setup) {
  const view = await setup.server.team("team.get", { directory: setup.home })
  return required(view.areas.find((area) => area.id === setup.area.id))
}

/** Commits everything in the area folder and lets the owner report it (`[report ready]` by default). */
async function commitAndReady(setup: Setup, message: string, report = "[report ready 합칠 준비가 됐습니다]") {
  const source = commit(setup.area.directory, message)
  await setup.server.turn(owner(setup), report)
  expect((await areaOf(setup)).candidate?.sha).toBe(source)
  return source
}

/**
 * The team is quiet: no op runs or waits, also a moment later. An integration that ended releases the fetched heavy
 * folders in an op of its own at the area's next safe point (06 §4.7), which starts right after it.
 */
async function quiet(setup: Setup) {
  const idle = async () => (await setup.server.team("team.get", { directory: setup.home })).op === null
  await until(idle, "a team op never ended", STEP_TIMEOUT)
  await Bun.sleep(3_000)
  await until(idle, "a team op never ended", STEP_TIMEOUT)
}

/** `Assets/Textures` is in the area (`area.paths{add}` once the team is quiet; its confirm answered when asked). */
async function fetched(setup: Setup) {
  await quiet(setup)
  if (fs.existsSync(path.join(setup.area.directory, META))) return
  const started = await setup.server.team("area.paths", {
    teamID: setup.teamID,
    areaID: setup.area.id,
    add: ["Assets/Textures"],
  })
  const op = await opEnd(setup.server, started.opID, { waiting: true })
  const step = op.steps.find((item) => item.state === "needs_confirm")
  if (step) {
    expect((await answer(setup.server, op.id, step, "do")).status).toBe(200)
    await opEnd(setup.server, op.id)
  }
  expect(fs.existsSync(path.join(setup.area.directory, META))).toBe(true)
}

/** The user's `area.integrate` once the team is quiet. */
async function integrateNow(setup: Setup) {
  await quiet(setup)
  return setup.server.team("area.integrate", { teamID: setup.teamID, areaID: setup.area.id })
}

/** The user's `area.integrate` and its op once it ended; then the integration. */
async function integrate(setup: Setup) {
  const started = await integrateNow(setup)
  const op = await opEnd(setup.server, started.opID, { waiting: true, timeoutMs: STEP_TIMEOUT })
  return { op, integration: await ended(setup, started.integrationID) }
}

/**
 * The user's `area.integrate` when making `.assets` has to ask: steps 0-6 end in their op, then the next op asks
 * step 7 as a confirm (06 §4.10, 0.3).
 */
async function asked(setup: Setup) {
  const before = new Set(ops(db(setup), setup.teamID).map((op) => op.id))
  const started = await integrateNow(setup)
  expect((await opEnd(setup.server, started.opID, { timeoutMs: STEP_TIMEOUT })).state).toBe("done")
  const next = await waitValue(
    async () =>
      ops(db(setup), setup.teamID).find(
        (op) =>
          !before.has(op.id) &&
          op.id !== started.opID &&
          op.steps.some((step) => step.args?.integrationID === started.integrationID),
      ),
    "step 7 never got an op of its own",
    STEP_TIMEOUT,
  )
  return { ...(await confirmOf(setup.server, next.id, "integrate-assets")), integrationID: started.integrationID }
}

/**
 * The integration once it no longer runs. A `ready` report wakes the main, and while that turn runs the home (it has
 * the target checked out) is not at its safe point: an advance that came then waits (`in-use`) for a retry. Such an
 * integration is retried once the main is idle, as the user's 다시 반영 (`area.integrate` runs steps 8-9 again, 7.6).
 */
async function ended(setup: Setup, integrationID: OwnTeam.IntegrationID) {
  const found = await finished(setup, integrationID)
  if (found.state !== "waiting" || found.waiting?.why !== "in-use") return found
  console.log(
    `[TG11 record] integration ${integrationID} waited (in-use: ${found.waiting.directory}); 다시 반영 once the main is idle`,
  )
  await setup.server.server.waitIdle(setup.main)
  const started = await integrateNow(setup)
  expect(started.integrationID).toBe(integrationID)
  await opEnd(setup.server, started.opID, { waiting: true, timeoutMs: STEP_TIMEOUT })
  return finished(setup, integrationID)
}

function finished(setup: Setup, integrationID: OwnTeam.IntegrationID) {
  return waitValue(
    async () => {
      const found = (await setup.server.team("integration.get", { integrationID })).integration
      return found.state === "running" ? undefined : found
    },
    `integration ${integrationID} never ended`,
    STEP_TIMEOUT,
  )
}

function owner(setup: Setup) {
  return required(setup.area.owner.sessionID ?? undefined)
}

function assets(setup: Setup) {
  return path.join(setup.worktreeRoot, AssetsVerify.DIRECTORY)
}

/** The asset check's runs: `start <sha> <cwd>` and `end <sha>`, oldest first. */
function runs(setup: Setup) {
  const file = path.join(setup.worktreeRoot, RUNS)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [kind = "", sha = "", ...cwd] = line.split(" ")
      return { kind, sha, cwd: cwd.join(" ") }
    })
}

function read(directory: string, file: string) {
  return fs.readFileSync(path.join(directory, ...file.split("/")), "utf8")
}

function tip(directory: string) {
  return git(directory, ["rev-parse", "refs/heads/main"]).trim()
}

function refs(directory: string, prefix: string) {
  return git(directory, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean)
}

function markers(directory: string, integrationID: string) {
  return refs(directory, `refs/own/integrate/${integrationID}/`)
}

function db(setup: Setup) {
  return setup.server.server.paths.database
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

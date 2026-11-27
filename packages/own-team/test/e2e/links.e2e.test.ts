// TG14 링크 사본 보정 (06 §4.12, §8.7, §11.3) on a real server, on temp clones of this repository (its mode-120000
// links, 43 since upstream v2.0.32 removed packages/enterprise (9e68770074), checked out with `core.symlinks=false`). Each clone's main folder is prepared as this user's checkout is
// (FORK §11): every link a copy of its target marked `--skip-worktree`, a folder link's copy excluded. Two teams: one
// with a plain area (copies with `--skip-worktree`, like the home) and one with a code-only area (`packages/web/public`
// heavy: copies with `--assume-unchanged`, the links in the heavy folder stay git's link files until it comes in).
//
// - Both areas: status clean, `git add -A` stages no type change, every copy holds its target and is recorded.
// - Sync (plain area): a target changed and integrated; the area's copy follows it after the integration.
// - A copy changed by hand (code-only area): status stays blind, `ready` refuses, fetching the heavy folder applies
//   its links' copies but never overwrites the changed one, and the hold ref of the next main request after direct
//   talk carries the changed content.
// - Opt-in (`OWN_E2E_BUN_INSTALL=1`, a real `bun install` of this repository into a new same-volume cache, about
//   2.5 GB and package downloads; the user confirms before it runs): the setup command installs with own's Bun cache
//   (`node_modules` hard-linked to `<worktreeRoot>/.own-bun-cache`) and `packages/app` typechecks in the area.
//
// The clones read this repository (never lock, adopt or change it). Fake credentials only; every listener binds
// 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OwnTeam } from "@own/protocol"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit"
import { commit, configure, git, status } from "../fixtures/repo.js"
import { BOOT_TIMEOUT, MODEL, active, enableTeam, opEnd, startTeamServer, until, type TeamServer } from "./harness.js"

const STEP_TIMEOUT = 600_000
/**
 * The heavy folder of the code-only team: some of the links are in it. packages/web/public until upstream v2.4.1 removed
 * its links (the web app's icons are packages/app/public's links now).
 */
const HEAVY = "packages/app/public"
/** A file link whose target the plain area changes (`../../ui/src/custom-elements.d.ts`). */
const SYNCED = "packages/app/src/custom-elements.d.ts"
/**
 * A file link whose copy the user changes by hand in the code-only area (outside the heavy folder). Upstream v2.2.6
 * (3efbdad965) moved the old site's links from packages/console/app/public to services/site/public.
 */
const EDITED = "services/site/public/favicon.svg"
const INSTALL = process.env.OWN_E2E_BUN_INSTALL === "1"

interface Team {
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly home: string
  readonly area: OwnTeam.AreaID
}

describe("TG14 link copies on temp clones of this repository (plain and code-only areas)", () => {
  const state: { server?: TeamServer; plain?: Team; code?: Team; links?: ReadonlyArray<Link> } = {}

  beforeAll(async () => {
    const server = await startTeamServer({
      name: "links",
      project: (root) => checkout(root, "own-open-code"),
    })
    state.server = server
    const home = required(server.project)
    state.links = links(home)
    const second = path.join(path.dirname(home), "own-open-code-2")
    git(path.dirname(home), ["clone", "-q", "-c", "core.symlinks=false", "-c", "core.autocrlf=false", home, second])
    configure(second)
    copies(second)
    const enable = async (directory: string, hint: string): Promise<Team> => {
      const viewed = await server.createSession({ title: "켠 대화", directory, model: MODEL["01"] })
      const enabled = await enableTeam(server, { hint, sessionID: viewed, directory })
      expect(enabled.op.state).toBe("done")
      const team = required(enabled.view.team ?? undefined)
      return { teamID: team.id, main: team.main.sessionID, home: directory, area: required(enabled.view.areas[0]).id }
    }
    state.plain = await enable(home, "[propose-areas 1]")
    state.code = await enable(second, `[propose-areas 1 +heavy=${HEAVY}]`)
  }, BOOT_TIMEOUT + STEP_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "both areas: status clean, no type change staged, every copy holds its target with the right flag",
    async () => {
      const server = required(state.server)
      const all = required(state.links)
      // Upstream adds and removes links (58 until b9ca4d21b4 removed packages/console/app/public/email, 43 since
      // 9e68770074 removed packages/enterprise in v2.0.32): the links the later steps change and some inside the heavy
      // folder must be there, whatever the count.
      expect(all.map((link) => link.path)).toEqual(expect.arrayContaining([SYNCED, EDITED]))
      expect(all.some((link) => inside(link.path, HEAVY))).toBe(true)
      for (const [team, shape, flag] of [
        [required(state.plain), "plain", "S"],
        [required(state.code), "code", "h"],
      ] as const) {
        const view = await server.team("team.get", { directory: team.home })
        expect(view.team?.env.symlinkFix).toBe("skip-worktree")
        const area = await areaOf(server, team)
        expect(area.shape).toBe(shape)
        const expected = all.filter((link) => shape === "plain" || !inside(link.path, HEAVY))
        expect(Object.keys(area.linkCopies ?? {}).toSorted()).toEqual(expected.map((link) => link.path).toSorted())
        expect(status(area.directory)).toBe("")
        expect(git(area.directory, ["add", "-A", "--dry-run"])).toBe("")
        for (const link of expected) {
          expect(sameCopy(area.directory, link)).toBe(true)
          expect(git(area.directory, ["ls-files", "-v", "--", link.path]).slice(0, 1)).toBe(flag)
        }
        // The links in the heavy folder are not on disk in the code-only area.
        if (shape === "code") expect(fs.existsSync(path.join(area.directory, HEAVY))).toBe(false)
      }
    },
    STEP_TIMEOUT,
  )

  test(
    "sync: a link target changed in the plain area and integrated; the area's copy follows it",
    async () => {
      const server = required(state.server)
      const team = required(state.plain)
      const link = required(required(state.links).find((item) => item.path === SYNCED))
      const area = await areaOf(server, team)
      const target = path.join(area.directory, path.dirname(SYNCED), link.target)
      fs.appendFileSync(target, "// changed in the area\n")
      const source = commit(area.directory, "a link target changes")
      await server.turn(required(area.owner.sessionID ?? undefined), "[report ready 링크 대상을 바꿨습니다]")
      expect((await areaOf(server, team)).candidate?.sha).toBe(source)
      const started = await server.team("area.integrate", { teamID: team.teamID, areaID: team.area })
      expect((await opEnd(server, started.opID, { timeoutMs: STEP_TIMEOUT })).state).toBe("done")
      // The op can end while the target advance still waits for the main folder (`in-use`: the main's turn on the
      // ready report's update); on a loaded PC that outlived the op (2.2.6-own.5 `test:e2e:full`).
      await until(
        async () =>
          (await server.team("integration.get", { integrationID: started.integrationID })).integration.state === "done",
        "the integration never ended",
        STEP_TIMEOUT,
      )
      await until(
        async () => sameCopy(area.directory, link),
        "the area's copy never followed its changed target",
        STEP_TIMEOUT,
      )
      const after = await areaOf(server, team)
      expect(after.linkCopies?.[SYNCED]).toBe(blob(area.directory, path.join(area.directory, SYNCED)))
      expect(status(area.directory)).toBe("")
    },
    STEP_TIMEOUT,
  )

  test(
    "a copy changed by hand: status is blind, `ready` refuses, fetching the heavy folder never overwrites it",
    async () => {
      const server = required(state.server)
      const team = required(state.code)
      const area = await areaOf(server, team)
      const owner = required(area.owner.sessionID ?? undefined)
      const edited = path.join(area.directory, EDITED)
      fs.writeFileSync(edited, "// the user's own edit of the copy\n")
      expect(status(area.directory)).toBe("")
      await server.turn(owner, "[report ready 준비됐습니다]")
      expect((await areaOf(server, team)).candidate).toBeUndefined()

      await server.turn(owner, `[need-paths ${HEAVY}]`)
      await until(
        async () => (await areaOf(server, team)).cone.extra[HEAVY] !== undefined,
        "the heavy folder never came in",
        STEP_TIMEOUT,
      )
      await until(async () => !(await active(server)).has(owner), "the owner never finished")
      expect(fs.readFileSync(edited, "utf8")).toBe("// the user's own edit of the copy\n")
      const now = await areaOf(server, team)
      expect(now.linkCopies?.[EDITED]).toBe(area.linkCopies?.[EDITED])
      expect(status(area.directory)).toBe("")
      expect(git(area.directory, ["add", "-A", "--dry-run"])).toBe("")
      // The heavy folder's links are copies now (applied again after the cone change), each with its target.
      const heavy = required(state.links).filter((link) => inside(link.path, HEAVY))
      for (const link of heavy) expect(sameCopy(area.directory, link)).toBe(true)
      expect(Object.keys(now.linkCopies ?? {})).toEqual(expect.arrayContaining(heavy.map((link) => link.path)))
    },
    STEP_TIMEOUT,
  )

  test(
    "the hold ref of the next main request after direct talk carries the changed copy's content",
    async () => {
      const server = required(state.server)
      const team = required(state.code)
      const area = await areaOf(server, team)
      const owner = required(area.owner.sessionID ?? undefined)
      await server.turn(owner, "사용자가 직접 한 말")
      await server.turn(team.main, `[dispatch ${team.area.slice("ar_".length)} [report progress 이어서]]`)
      const ref = await waitHold(team, area.id)
      expect(git(team.home, ["show", `${ref}:${EDITED}`])).toBe("// the user's own edit of the copy\n")
      expect(fs.readFileSync(path.join(area.directory, EDITED), "utf8")).toBe("// the user's own edit of the copy\n")
      await until(async () => !(await active(server)).has(owner), "the owner never finished")
    },
    STEP_TIMEOUT,
  )
})

describe.skipIf(!INSTALL)("TG14 opt-in: own's Bun cache and a typecheck in the area (real bun install)", () => {
  const state: { server?: TeamServer; team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({
      name: "links-install",
      project: (root) => checkout(root, "own-open-code"),
    })
    state.server = server
    const home = required(server.project)
    const viewed = await server.createSession({ title: "켠 대화", directory: home, model: MODEL["01"] })
    const enabled = await enableTeam(server, { hint: "[propose-areas 1 +setup]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = { teamID: team.id, main: team.main.sessionID, home, area: required(enabled.view.areas[0]).id }
  }, BOOT_TIMEOUT + STEP_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "node_modules is hard-linked to the same-volume cache, and packages/app typechecks with the copies",
    async () => {
      const server = required(state.server)
      const team = required(state.team)
      const view = await server.team("team.get", { directory: team.home })
      const record = required(view.team ?? undefined)
      expect(record.env.bunCache).toBe("same-volume")
      await until(
        async () => (await areaOf(server, team)).status.kind !== "preparing",
        "the setup never ended",
        STEP_TIMEOUT,
      )
      const area = await areaOf(server, team)
      const cache = path.join(record.worktreeRoot, ".own-bun-cache")
      const installed = path.join(area.directory, "node_modules", "effect", "package.json")
      const stat = fs.statSync(installed)
      expect(stat.nlink).toBeGreaterThan(1)
      expect(cached(cache, stat.ino)).toBe(true)
      const checked = Bun.spawnSync(["bun", "run", "typecheck"], {
        cwd: path.join(area.directory, "packages", "app"),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(checked.exitCode).toBe(0)
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

interface Link {
  /** Repository path of the link. */
  readonly path: string
  /** The link text: its target relative to the link's folder. */
  readonly target: string
}

/**
 * A shallow clone of this repository's HEAD at `<root>/<name>` with `core.symlinks=false`, prepared as this user's
 * checkout: each link a copy of its target, `--skip-worktree`, a folder copy excluded (FORK §11).
 */
function checkout(root: string, name: string) {
  const home = path.join(root, name)
  git(root, [
    "clone",
    "-q",
    "--depth",
    "1",
    "--no-local",
    "-c",
    "core.symlinks=false",
    "-c",
    "core.autocrlf=false",
    pathToFileURL(REPO_ROOT).href,
    home,
  ])
  configure(home)
  copies(home)
  return home
}

/** The mode-120000 entries of a checkout and their link texts. */
function links(home: string): ReadonlyArray<Link> {
  return git(home, ["ls-files", "-s", "-z"])
    .split("\0")
    .filter((line) => line.startsWith("120000 "))
    .map((line) => {
      const [info, file = ""] = line.split("\t")
      const oid = (info ?? "").split(" ")[1] ?? ""
      return { path: file, target: git(home, ["cat-file", "blob", oid]).trim() }
    })
}

/** Writes each link's target over git's link file and marks it `--skip-worktree` (FORK §11). */
function copies(home: string) {
  const exclude = path.join(home, ".git", "info", "exclude")
  for (const link of links(home)) {
    const file = path.join(home, link.path)
    const target = path.resolve(path.dirname(file), link.target)
    fs.rmSync(file, { force: true })
    fs.cpSync(target, file, { recursive: true })
    if (fs.statSync(target).isDirectory()) fs.appendFileSync(exclude, `/${link.path}/\n`)
    git(home, ["update-index", "--skip-worktree", "--", link.path])
  }
  expect(status(home)).toBe("")
}

/** A link's copy in `directory` holds what its target holds (a folder copy: its files). */
function sameCopy(directory: string, link: Link) {
  const copy = path.join(directory, link.path)
  const target = path.resolve(path.dirname(copy), link.target)
  if (!fs.existsSync(copy) || !fs.existsSync(target)) return false
  if (!fs.statSync(target).isDirectory()) return fs.readFileSync(copy).equals(fs.readFileSync(target))
  const listed = (dir: string) =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
      .toSorted()
  const names = listed(target)
  return (
    JSON.stringify(listed(copy)) === JSON.stringify(names) &&
    names.every((name) => fs.readFileSync(path.join(copy, name)).equals(fs.readFileSync(path.join(target, name))))
  )
}

function inside(file: string, dir: string) {
  return file === dir || file.startsWith(`${dir}/`)
}

function blob(directory: string, file: string) {
  return git(directory, ["hash-object", "--", file]).trim()
}

async function areaOf(server: TeamServer, team: Team) {
  const view = await server.team("team.get", { directory: team.home })
  return required(view.areas.find((area) => area.id === team.area))
}

/** The hold ref own made for the area's main request (`refs/own/hold/<areaID>/<dispatchID>`). */
async function waitHold(team: Team, areaID: OwnTeam.AreaID) {
  const found: { ref?: string } = {}
  await until(
    async () => {
      const refs = git(team.home, ["for-each-ref", "--format=%(refname)", `refs/own/hold/${areaID}/`])
        .split("\n")
        .filter(Boolean)
      found.ref = refs[0]
      return found.ref !== undefined
    },
    "no hold ref was made",
    STEP_TIMEOUT,
  )
  return required(found.ref)
}

/** A file with inode `ino` is in the Bun cache (a hard link of the installed file). */
function cached(cache: string, ino: number) {
  return fs
    .readdirSync(cache, { recursive: true, withFileTypes: true })
    .some((entry) => entry.isFile() && fs.statSync(path.join(entry.parentPath, entry.name)).ino === ino)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

// TG18 공유 폴더 (should, the Windows half; 06 §4.11, §11.3) on a real server: an ignored, untracked data folder of the
// main folder that the judge picked (`[propose-areas 2 +shared=data]`) is shared read-only with every area.
//
// - The enable asks first (`protect-shared`, a confirm: the original's permissions change). Before the answer nothing
//   is protected, recorded or linked; after it the original carries the user's deny ACE (Windows; `chmod -R a-w`
//   elsewhere), `Team.shared` records it, `<common dir>/info/exclude` has `/data`, and each area has a junction to it.
// - `git clean -fdx` in an area deletes the link and leaves the original; the link comes back at the area's next safe
//   point after a run ends.
// - `rm -rf data/` (trailing slash: it follows the link) cannot delete the original's content: the deny ACE stops it.
// - A real folder at the link path is never touched: it stays as it is and `link.blocked` is open until it is gone.
// - 끝내기 removes an area folder without following the link: the original survives and no link is left.
// - The enable's undo takes the protection off (no ACE left), the links out and the `/data` line away.
//
// The ACE goes only on this suite's temp fixture folder and comes off before the temp root is removed (the teardown
// takes it off again in any case). Verdicts come from the filesystem (lstat, the files' hashes), the deny ACE as
// `icacls /save` reports it (`Shared.protection`), git and the team records. Fake credentials only; every listener
// binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Shared } from "../../src/assets/shared.js"
import { commit, f1, git, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  answer,
  confirmOf,
  holdOff,
  opEnd,
  reorganize,
  same,
  startTeamServer,
  until,
  type TeamServer,
} from "./harness.js"

const STEP_TIMEOUT = 300_000
const NAME = "data"
/** The data folder's files (fake content). */
const DATA: Readonly<Record<string, string | Uint8Array>> = {
  "data/weights.bin": crypto.getRandomValues(new Uint8Array(16_384)),
  "data/sets/train.csv": "a,b\n1,2\n",
  "data/sets/test.csv": "a,b\n3,4\n",
}

interface Setup {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly enableID: OwnTeam.OpID
  readonly home: string
  readonly target: string
  readonly areas: ReadonlyArray<OwnTeam.AreaView>
  /** The original's files and their hashes before anything ran. */
  readonly original: Readonly<Record<string, string>>
}

describe("TG18 shared folders on a real server (F1 with an ignored `data/`, two areas)", () => {
  const state: { setup?: Setup; target?: string; server?: TeamServer } = {}

  beforeAll(async () => {
    const server = await startTeamServer({
      name: "shared",
      project: (root) => {
        const home = f1(root).home
        write(home, { ".gitignore": `${NAME}/\n` })
        commit(home, "ignore the data folder")
        write(home, DATA)
        return home
      },
    })
    state.server = server
    const home = required(server.project)
    const target = path.join(home, NAME)
    state.target = target
    const viewed = await server.createSession({ title: "켠 대화" })
    const started = await server.team("enable", {
      directory: home,
      hint: `[propose-areas 2 +shared=${NAME}]`,
      sessionID: SessionID.make(viewed),
    })
    // The protect confirm holds the op: it ends `waiting` once every auto step ran.
    const waiting = await opEnd(server, started.opID, { waiting: true })
    expect(waiting.state).toBe("waiting")
    const view = await server.team("team.get", { directory: home })
    await holdOff(server, required(view.team ?? undefined).id)
    state.setup = {
      server,
      teamID: required(view.team ?? undefined).id,
      enableID: started.opID,
      home,
      target,
      areas: view.areas,
      original: hashes(target),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    // Never leave the deny ACE behind: the temp root could not be removed with it.
    if (state.target && fs.existsSync(state.target)) await Shared.unprotect(state.target, Shared.PROTECT)
    const root = state.server?.root
    await state.server?.stop()
    if (root) expect(fs.existsSync(root)).toBe(false)
  }, 120_000)

  test(
    "the confirm protects the original, records it and links every area; nothing before the answer",
    async () => {
      const setup = required(state.setup)
      const asked = await confirmOf(setup.server, setup.enableID, Shared.KIND.protect)
      expect(asked.step.args).toEqual({ name: NAME })
      expect(asked.confirm.text).toContain(`'${NAME}'`)
      // Before the answer: no protection, no record, no link, no line.
      expect(await protectedNow(setup.target)).toBe(false)
      expect((await teamOf(setup)).shared).toEqual([])
      for (const area of setup.areas) expect(lstat(path.join(area.directory, NAME))).toBeUndefined()
      expect(excluded(setup.home)).not.toContain(`/${NAME}`)

      const answered = await answer(setup.server, setup.enableID, asked.step, "do")
      expect(answered.status).toBe(200)
      const op = await opEnd(setup.server, setup.enableID)
      expect(op.state).toBe("done")
      expect((await teamOf(setup)).shared).toEqual([{ name: NAME, target: setup.target, protect: Shared.PROTECT }])
      expect(await protectedNow(setup.target)).toBe(true)
      expect(excluded(setup.home)).toContain(`/${NAME}`)
      for (const area of setup.areas) {
        expect(linked(area.directory, setup.target)).toBe(true)
        // The link is ignored (`/data` in info/exclude): the area's status stays clean.
        expect(git(area.directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
        expect(fs.readFileSync(path.join(area.directory, NAME, "sets", "train.csv"), "utf8")).toBe("a,b\n1,2\n")
      }
      expect(hashes(setup.target)).toEqual(setup.original)
    },
    STEP_TIMEOUT,
  )

  test(
    "`git clean -fdx` deletes the link and leaves the original; the next safe point links it again",
    async () => {
      const setup = required(state.setup)
      const area = required(setup.areas[0])
      git(area.directory, ["clean", "-fdx"])
      expect(lstat(path.join(area.directory, NAME))).toBeUndefined()
      expect(hashes(setup.target)).toEqual(setup.original)
      await relinked(setup, area)
      expect(linked(area.directory, setup.target)).toBe(true)
      expect(hashes(setup.target)).toEqual(setup.original)
    },
    STEP_TIMEOUT,
  )

  test(
    "`rm -rf data/` follows the link, but the deny ACE keeps every file of the original",
    async () => {
      const setup = required(state.setup)
      const area = required(setup.areas[1])
      const removed = Bun.spawnSync([rm(), "-rf", `${NAME}/`], {
        cwd: area.directory,
        stdout: "pipe",
        stderr: "pipe",
      })
      console.log(
        `[TG18 record] rm -rf ${NAME}/ through the link: exit ${removed.exitCode}; link left ${lstat(path.join(area.directory, NAME))?.isSymbolicLink() === true}`,
      )
      expect(hashes(setup.target)).toEqual(setup.original)
      // What rm left at the link path is linked again (or still is).
      await relinked(setup, area)
      expect(hashes(setup.target)).toEqual(setup.original)
    },
    STEP_TIMEOUT,
  )

  test(
    "a real folder at the link path is left alone and `link.blocked` stays open until it is gone",
    async () => {
      const setup = required(state.setup)
      const area = required(setup.areas[0])
      const at = path.join(area.directory, NAME)
      fs.unlinkSync(at)
      write(area.directory, { [`${NAME}/mine.txt`]: "the user's own folder\n" })
      await until(
        async () => {
          await setup.server.turn(owner(area), "확인")
          return (await blocked(setup, area.id)).length > 0
        },
        "link.blocked never opened",
        STEP_TIMEOUT,
      )
      expect(lstat(at)?.isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(path.join(at, "mine.txt"), "utf8")).toBe("the user's own folder\n")
      expect(hashes(setup.target)).toEqual(setup.original)

      fs.rmSync(at, { recursive: true })
      await relinked(setup, area)
      await until(async () => (await blocked(setup, area.id)).length === 0, "link.blocked stayed open", STEP_TIMEOUT)
    },
    STEP_TIMEOUT,
  )

  test(
    "끝내기 removes the area folder without following the link: the original survives, no link is left",
    async () => {
      const setup = required(state.setup)
      const area = required(setup.areas[1])
      const opID = await reorganize(setup.server, setup.teamID, [{ op: "retire", area: slug(area.id) }])
      const asked = await confirmOf(setup.server, opID, "retire-remove")
      // own's link is not the user's file: the removal list holds nothing of the original.
      expect((asked.confirm.files ?? []).filter((file) => file.path.startsWith(NAME))).toEqual([])
      expect((await answer(setup.server, opID, asked.step, "do")).status).toBe(200)
      expect((await opEnd(setup.server, opID)).state).toBe("done")
      expect(fs.existsSync(area.directory)).toBe(false)
      expect(hashes(setup.target)).toEqual(setup.original)
      const team = await teamOf(setup)
      const left = fs
        .readdirSync(team.worktreeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(team.worktreeRoot, entry.name))
        .filter((folder) => linked(folder, setup.target))
      expect(left.map((folder) => same(folder, required(setup.areas[0]).directory))).toEqual([true])
    },
    STEP_TIMEOUT,
  )

  test(
    "the enable's undo takes the deny ACE off, the links out and the `/data` line away",
    async () => {
      const setup = required(state.setup)
      const started = await setup.server.team("op.undo", { opID: setup.enableID })
      expect((await opEnd(setup.server, started.opID)).state).toBe("done")
      expect(await protectedNow(setup.target)).toBe(false)
      expect(excluded(setup.home)).not.toContain(`/${NAME}`)
      for (const area of setup.areas) expect(linked(area.directory, setup.target)).toBe(false)
      expect(hashes(setup.target)).toEqual(setup.original)
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

async function teamOf(setup: Setup) {
  return required((await setup.server.team("team.get", { directory: setup.home })).team ?? undefined)
}

/** The deny ACE (or `chmod a-w`) is on the original (`icacls /save`, never localized). */
async function protectedNow(target: string) {
  const observed = await Shared.protection(target, Shared.PROTECT)
  if (!observed.ok) throw new Error(observed.message)
  return observed.on
}

/** The open `link.blocked` notices of an area (`team.get` `notices`). */
async function blocked(setup: Setup, areaID: OwnTeam.AreaID) {
  const view = await setup.server.team("team.get", { directory: setup.home })
  return (view.notices ?? []).filter((item) => item.kind === "link.blocked" && item.areaID === areaID)
}

/**
 * The link is back: own relinks at the area's safe point after a run ends (06 §4.11), so the owner runs a turn until
 * it is (the safe point may still be busy right at the run's end).
 */
async function relinked(setup: Setup, area: OwnTeam.AreaView) {
  await until(
    async () => {
      if (linked(area.directory, setup.target)) return true
      await setup.server.turn(owner(area), "확인")
      return linked(area.directory, setup.target)
    },
    `the link in ${area.directory} never came back`,
    STEP_TIMEOUT,
  )
}

/** `<folder>/data` is a link (junction or symlink) to the original. */
function linked(folder: string, target: string) {
  const at = path.join(folder, NAME)
  if (lstat(at)?.isSymbolicLink() !== true) return false
  return same(fs.realpathSync.native(at), fs.realpathSync.native(target))
}

/** What is at `at` without following a link; `undefined` when nothing is (or its folder is gone). */
function lstat(at: string) {
  return fs.lstatSync(at, { throwIfNoEntry: false })
}

/** Every file of a folder (relative, `/`) and the sha-256 of its content. */
function hashes(folder: string) {
  return Object.fromEntries(
    fs
      .readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name)
        return [
          path.relative(folder, file).replaceAll("\\", "/"),
          createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ]
      })
      .toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")),
  )
}

/** `<common dir>/info/exclude`. */
function excluded(home: string) {
  const file = path.resolve(home, git(home, ["rev-parse", "--git-common-dir"]).trim(), "info", "exclude")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : []
}

/** GNU rm: Git for Windows' copy next to git (`usr/bin/rm.exe`), `rm` elsewhere. */
function rm() {
  if (process.platform !== "win32") return "rm"
  const found = path.resolve(git(process.cwd(), ["--exec-path"]).trim(), "..", "..", "..", "usr", "bin", "rm.exe")
  if (!fs.existsSync(found)) throw new Error(`GNU rm not found at ${found}`)
  return found
}

function owner(area: OwnTeam.AreaView) {
  return required(area.owner.sessionID ?? undefined)
}

function slug(areaID: OwnTeam.AreaID) {
  return areaID.slice("ar_".length)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

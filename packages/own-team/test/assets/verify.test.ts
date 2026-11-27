// The asset check folder `.assets` (06 §4.10, §7.2 step 7, §8.7, TI-1, TI-8, TI-14; TG11 asset items): one own-only
// full worktree under the worktree root, detached and locked `own.team assets`, made on first need and only after a
// confirm when it is large (nothing fetched before the answer); objects in the shared LFS store need no network; each
// run keeps commits made in the folder (keep ref) and holds changes left there (hold ref) before reset --hard K and
// clean -fd, which keeps the ignored engine cache; a stopped run continues without running a finished command again;
// runs take turns through the folder's lease. Through the op, step 7 runs when K changes a heavy folder or the owner
// asked for an engine run, and records `skipped` otherwise. F2 and F5 need git-lfs (Git for Windows has it); the
// other cases use the T2 integrate fixture. Fixtures in temp folders, `file://` remotes, fake features, no network.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { AssetsVerify } from "../../src/assets/verify.js"
import { Porcelain } from "../../src/git/porcelain.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import type { Services } from "../../src/services.js"
import { f5, F5_HEAVY, F5_LFS } from "../fixtures/f5-unity.js"
import { integrate, save } from "../fixtures/integrate.js"
import { F2_HEAVY, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { git, head, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller, team } from "../support/context.js"

const SLOW = 240_000

const box = temp("own-team-assets-")
afterAll(() => box.dispose())

/**
 * The asset commands' script (a stand-in for an engine run), run in `.assets`: `exists <file>`, `size <file> <bytes>`,
 * `count <file>`, `cache` (the ignored engine cache), `meta <file>` (edits a tracked file), `stray` (an untracked
 * file), `fail <code>`, `gate <counter> <flag>` (counts only once the flag exists, else waits), `block <marks> <name>
 * <release>` (waits for the release file) and `mark <marks> <name>`.
 */
const TOOL = path.join(box.root, "engine.js")
fs.writeFileSync(
  TOOL,
  [
    `const fs = require("node:fs")`,
    `const path = require("node:path")`,
    `const [mode, ...args] = process.argv.slice(2)`,
    `const append = (file, line) => {`,
    `  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })`,
    `  fs.appendFileSync(file, line + "\\n")`,
    `}`,
    `if (mode === "exists") process.exit(fs.existsSync(args[0]) ? 0 : 1)`,
    `if (mode === "size") process.exit(fs.existsSync(args[0]) && fs.statSync(args[0]).size === Number(args[1]) ? 0 : 1)`,
    `if (mode === "count") { append(args[0], "x"); process.exit(0) }`,
    `if (mode === "cache") { append("Library/cache.txt", "imported"); process.exit(0) }`,
    `if (mode === "meta") { append(args[0], "edited by the engine"); process.exit(0) }`,
    `if (mode === "stray") { fs.writeFileSync("stray.txt", "stray"); process.exit(0) }`,
    `if (mode === "fail") { console.log("asset check failing"); process.exit(Number(args[0])) }`,
    `if (mode === "gate") {`,
    `  if (fs.existsSync(args[1])) { append(args[0], "x"); process.exit(0) }`,
    `  setTimeout(() => process.exit(0), 60_000)`,
    `}`,
    `if (mode === "block") {`,
    `  append(args[0], "start " + args[1])`,
    `  const wait = () => {`,
    `    if (!fs.existsSync(args[2])) return setTimeout(wait, 50)`,
    `    append(args[0], "end " + args[1])`,
    `    process.exit(0)`,
    `  }`,
    `  wait()`,
    `}`,
    `if (mode === "mark") { append(args[0], args[1]); process.exit(0) }`,
  ].join("\n"),
)

function tool(...args: string[]): OwnTeam.Command {
  return { argv: [process.execPath, TOOL, ...args] }
}

const fixtures = { next: 0 }

/** The T2 integrate fixture with `assets` as the heavy folder, the given asset commands and policy. */
function setup(commands: ReadonlyArray<OwnTeam.Command> = [], policy: Partial<OwnTeam.Policy> = {}) {
  const fx = integrate(path.join(box.root, `f${fixtures.next++}`))
  const team: OwnTeam.Team = {
    ...fx.team,
    heavy: { dirs: ["assets"], measuredAt: fx.base, forcedBytes: 0 },
    commands: { setup: null, code: [], assets: [...commands] },
    policy: { ...fx.team.policy, ...policy },
  }
  // An engine-like project: the editor's cache is ignored, assets have their `.meta`.
  const first = save(fx.home, {
    ".gitignore": "dist/\n*.tsbuildinfo\nLibrary/\n",
    "assets/textures/rock.bin.meta": "guid: rock\n",
  })
  return { fx, team, dir: AssetsVerify.directory(team), first }
}

/** A team over an LFS fixture's home with its heavy folders and asset commands. */
function lfsTeam(home: string, heavy: ReadonlyArray<string>, measured: string, commands: OwnTeam.Command[]) {
  const base = team({ home })
  return {
    ...base,
    heavy: { dirs: [...heavy], measuredAt: measured, forcedBytes: 0 },
    commands: { setup: null, code: [], assets: commands },
  } satisfies OwnTeam.Team
}

/** One holder of the lease queue for the file, as the controller is for a process. */
const HOLDER = {}

function run(team: OwnTeam.Team, candidate: string, extra: Partial<AssetsVerify.Input> = {}) {
  return AssetsVerify.run({ team, integrationID: "ig_a", candidate, hold: "op_a", at: 0, ...extra }, HOLDER)
}

/** The `worktree list` entry of `dir` in the repository at `home`. */
function entry(home: string, dir: string) {
  return Porcelain.worktrees(git(home, ["worktree", "list", "--porcelain", "-z"])).find(
    (item) => path.resolve(item.path) === path.resolve(dir),
  )
}

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [])

async function until(check: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(50)
  }
}

describe("AssetsVerify: the asset check folder (06 §4.10)", () => {
  test.skipIf(!lfsAvailable)(
    "F5: made on first need as a detached full worktree locked 'own.team assets'; the home stays as it was",
    async () => {
      const f = f5(path.join(box.root, "f5-made"))
      const team = lfsTeam(f.home, F5_HEAVY, f.head, [
        tool("size", "Assets/Textures/rock.png", String(F5_LFS["Assets/Textures/rock.png"])),
        tool("exists", "Assets/Scripts/Player.cs"),
        tool("cache"),
      ])
      const outcome = await run(team, f.head)
      expect(outcome).toMatchObject({ state: "done", reused: false, result: { ok: true, sha: f.head }, kept: [] })
      expect(outcome.state === "done" && outcome.result.heldRef).toBeUndefined()

      const dir = AssetsVerify.directory(team)
      expect(dir).toBe(path.join(team.worktreeRoot, ".assets"))
      expect(entry(f.home, dir)).toMatchObject({ detached: true, head: f.head, locked: AssetsVerify.LOCK_REASON })
      // A full folder: no sparse-checkout, the LFS files at their real size from the shared store.
      expect(() => git(dir, ["config", "--worktree", "--get", "index.sparse"])).toThrow()
      expect(fs.statSync(path.join(dir, "Assets", "Models", "tree.fbx")).size).toBe(F5_LFS["Assets/Models/tree.fbx"])
      expect(f.objects()).toBe(Object.keys(F5_LFS).length)
      expect(lines(path.join(dir, "Library", "cache.txt"))).toEqual(["imported"])
      const log = fs.readFileSync(AssetsVerify.files(team, "ig_a", f.head).log, "utf8")
      expect(log).toContain("[exit 0")
      // The home keeps its pointers and its state; no area folder or home is borrowed.
      expect(git(f.home, ["status", "--porcelain"])).toBe("")
      expect(fs.statSync(path.join(f.home, "Assets", "Models", "tree.fbx")).size).toBeLessThan(1024)
      expect(head(f.home)).toBe(f.head)
    },
    SLOW,
  )

  test.skipIf(!lfsAvailable)(
    "F5: a first creation over askDownloadBytes or askDiskBytes asks; nothing is added or fetched before the answer",
    async () => {
      const f = f5(path.join(box.root, "f5-confirm"))
      const team = lfsTeam(f.home, F5_HEAVY, f.head, [tool("exists", "Assets/Scripts/Player.cs")])
      const dir = AssetsVerify.directory(team)
      const lfsBytes = Object.values(F5_LFS).reduce((sum, size) => sum + size, 0)

      const download = await run({ ...team, policy: { ...team.policy, askDownloadBytes: lfsBytes } }, f.head)
      expect(download).toMatchObject({ state: "confirm", download: lfsBytes, confirm: true })
      // The heavy folders hold the LFS files and their `.meta` files.
      expect(download.state === "confirm" && download.disk).toBeGreaterThan(lfsBytes)
      expect(download.state === "confirm" && download.disk).toBeLessThan(lfsBytes + 1024)

      const disk = await run({ ...team, policy: { ...team.policy, askDiskBytes: lfsBytes } }, f.head)
      expect(disk).toMatchObject({ state: "confirm", download: lfsBytes })
      expect(f.objects()).toBe(0)
      expect(fs.existsSync(dir)).toBe(false)
      expect(entry(f.home, dir)).toBeUndefined()

      const answered = await run(
        { ...team, policy: { ...team.policy, askDiskBytes: 1, askDownloadBytes: 1 } },
        f.head,
        { confirmed: true },
      )
      expect(answered).toMatchObject({ state: "done", result: { ok: true, sha: f.head } })
      expect(f.objects()).toBe(Object.keys(F5_LFS).length)
      // Once the folder exists, a later run does not ask again.
      const next = save(f.home, { "Assets/Textures/rock.png.meta": "fileFormatVersion: 2\nguid: changed\n" })
      expect(
        await run({ ...team, policy: { ...team.policy, askDiskBytes: 1, askDownloadBytes: 1 } }, next, {
          integrationID: "ig_b",
          hold: "op_b",
        }),
      ).toMatchObject({ state: "done", result: { ok: true, sha: next } })
    },
    SLOW,
  )

  test.skipIf(!lfsAvailable)(
    "F2: with the remote renamed (offline), objects in the shared store need no network",
    async () => {
      const f = f2(path.join(box.root, "f2-offline"))
      const copy = "Assets/Textures/rock2.png"
      const team = lfsTeam(f.home, F2_HEAVY, f.head, [tool("exists", "src/app/main.ts")])
      expect(await run(team, f.head)).toMatchObject({ state: "done", result: { ok: true } })
      const fetched = f.objects()

      // K: a new heavy file whose object the shared store has (a copy of the pointer), and a changed one removed.
      write(f.home, { [copy]: fs.readFileSync(path.join(f.home, "Assets", "Textures", "rock.png")) })
      fs.rmSync(path.join(f.home, "Assets", "Audio", "music.wav"))
      const next = save(f.home, {})
      f.offline()
      const outcome = await run(
        { ...team, commands: { ...team.commands, assets: [tool("size", copy, "50000")] } },
        next,
        { integrationID: "ig_b", hold: "op_b" },
      ).finally(() => f.online())
      expect(outcome).toMatchObject({ state: "done", result: { ok: true, sha: next } })
      expect(f.objects()).toBe(fetched)
      expect(fs.existsSync(path.join(AssetsVerify.directory(team), "Assets", "Audio", "music.wav"))).toBe(false)
    },
    SLOW,
  )

  test.skipIf(!lfsAvailable)(
    "F5: an object missing from the shared store is fetched before the reset; offline the folder stays where it was",
    async () => {
      const f = f5(path.join(box.root, "f5-fetch"))
      const team = lfsTeam(f.home, F5_HEAVY, f.head, [tool("size", "Assets/Textures/new.png", "7000")])
      expect(await run({ ...team, commands: { ...team.commands, assets: [tool("cache")] } }, f.head)).toMatchObject({
        state: "done",
      })
      // A commit made elsewhere: the home has its git objects but not its LFS object.
      write(f.seed, { "Assets/Textures/new.png": Buffer.alloc(7000, 7) })
      const made = save(f.seed, {})
      git(f.seed, ["lfs", "push", "origin", "main"])
      git(f.seed, ["push", "-q", "origin", "main"])
      git(f.home, ["fetch", "-q", "origin"])
      expect(git(f.home, ["rev-parse", "origin/main"]).trim()).toBe(made)
      const before = f.objects()

      f.offline()
      const offline = await run(team, made, { integrationID: "ig_b", hold: "op_b" }).finally(() => f.online())
      expect(offline.state).toBe("failed")
      const dir = AssetsVerify.directory(team)
      expect(head(dir)).toBe(f.head)
      expect(git(dir, ["status", "--porcelain"])).toBe("")

      const online = await run(team, made, { integrationID: "ig_b", hold: "op_b" })
      expect(online).toMatchObject({ state: "done", result: { ok: true, sha: made } })
      expect(f.objects()).toBe(before + 1)
      expect(lines(path.join(dir, "Library", "cache.txt"))).toEqual(["imported"])
    },
    SLOW,
  )

  test(
    "a .meta the last check edited goes to refs/own/hold/assets/<op> before the next reset (TI-1)",
    async () => {
      const { fx, team, dir, first } = setup([tool("meta", "assets/textures/rock.bin.meta"), tool("stray")])
      expect(await run(team, first, { hold: "op_1" })).toMatchObject({ state: "done", result: { ok: true } })
      expect(lines(path.join(dir, "assets", "textures", "rock.bin.meta"))).toEqual([
        "guid: rock",
        "edited by the engine",
      ])

      const next = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      const outcome = await run(team, next, { integrationID: "ig_b", hold: "op_2", at: 1_700_000_000_000 })
      if (outcome.state !== "done") throw new Error(JSON.stringify(outcome))
      const ref = "refs/own/hold/assets/op_2"
      expect(outcome.result).toMatchObject({ ok: true, sha: next, heldRef: ref })
      expect(outcome.held).toMatchObject({ ref, created: true })
      expect(outcome.held?.bytes).toBeGreaterThan(0)
      // The hold commit has the edit and the untracked file on top of the K the folder was at.
      expect(git(fx.home, ["show", `${ref}:assets/textures/rock.bin.meta`])).toContain("edited by the engine")
      expect(git(fx.home, ["show", `${ref}:stray.txt`])).toBe("stray")
      expect(git(fx.home, ["rev-parse", `${ref}^`]).trim()).toBe(first)
      // The folder is at the new K; this run's command edited the reset file once.
      expect(head(dir)).toBe(next)
      expect(lines(path.join(dir, "assets", "textures", "rock.bin.meta"))).toEqual([
        "guid: rock",
        "edited by the engine",
      ])
    },
    SLOW,
  )

  test(
    "a commit made in .assets goes to refs/own/keep/<sha> before the folder moves (TI-8); own's own K does not",
    async () => {
      const { fx, team, dir, first } = setup([tool("exists", "src/app.ts")])
      expect(await run(team, first)).toMatchObject({ state: "done" })
      write(dir, { "assets/textures/user.bin": "made in the engine\n" })
      git(dir, ["add", "-A"])
      git(dir, ["commit", "-q", "-m", "user work in .assets"])
      const user = head(dir)

      const next = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      const outcome = await run(team, next, { integrationID: "ig_b", hold: "op_b" })
      if (outcome.state !== "done") throw new Error(JSON.stringify(outcome))
      const ref = `refs/own/keep/${user}`
      expect(outcome.result).toMatchObject({ ok: true, sha: next, keptRefs: [ref] })
      expect(outcome.result.heldRef).toBeUndefined()
      expect(outcome.kept).toEqual([{ ref, sha: user, created: true }])
      expect(git(fx.home, ["rev-parse", ref]).trim()).toBe(user)
      expect(head(dir)).toBe(next)

      const later = save(fx.home, { "assets/audio/music.bin": "music 2\n" })
      const again = await run(team, later, { integrationID: "ig_c", hold: "op_c" })
      expect(again).toMatchObject({ state: "done", kept: [] })
      expect(again.state === "done" && again.result.keptRefs).toBeUndefined()
    },
    SLOW,
  )

  test(
    "stopped after the reset to K, the next run continues and runs the command once; a finished result answers",
    async () => {
      const counter = path.join(box.root, "gate-counter.txt")
      const flag = path.join(box.root, "gate-flag.txt")
      const { fx, team, dir } = setup([tool("gate", counter, flag)])
      const next = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      const stop = new AbortController()
      const stopped = await run(team, next, {
        signal: stop.signal,
        progress: async (checks) => {
          if (checks.current === 1) setTimeout(() => stop.abort(), 500)
        },
      })
      expect(stopped).toEqual({ state: "stopped" })
      expect(head(dir)).toBe(next)
      expect(lines(counter)).toEqual([])

      fs.writeFileSync(flag, "go")
      expect(await run(team, next)).toMatchObject({ state: "done", reused: false, result: { ok: true, sha: next } })
      expect(lines(counter)).toEqual(["x"])
      // Killed after the command ended: its result answers, for this integration and for another one.
      expect(await run(team, next)).toMatchObject({ state: "done", reused: true, result: { ok: true } })
      expect(await run(team, next, { integrationID: "ig_other", hold: "op_other" })).toMatchObject({
        state: "done",
        reused: true,
      })
      expect(lines(counter)).toEqual(["x"])
    },
    SLOW,
  )

  test(
    "clean -fd keeps the ignored engine cache; a failed check fails with its log",
    async () => {
      const { fx, team, dir, first } = setup([tool("cache"), tool("stray")])
      expect(await run(team, first, { hold: "op_1" })).toMatchObject({ state: "done" })
      const next = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      const failing: OwnTeam.Team = {
        ...team,
        commands: { ...team.commands, assets: [tool("cache"), tool("fail", "4")] },
      }
      const outcome = await run(failing, next, { integrationID: "ig_b", hold: "op_2" })
      if (outcome.state !== "done") throw new Error(JSON.stringify(outcome))
      const where = AssetsVerify.files(team, "ig_b", next)
      expect(outcome.result).toMatchObject({
        ok: false,
        failed: `${process.execPath} ${TOOL} fail 4`,
        log: where.log,
        sha: next,
        heldRef: "refs/own/hold/assets/op_2",
      })
      expect(lines(path.join(dir, "Library", "cache.txt"))).toEqual(["imported", "imported"])
      expect(fs.existsSync(path.join(dir, "stray.txt"))).toBe(false)
      expect(fs.readFileSync(where.log, "utf8")).toContain("asset check failing")
      // A failed result answers only its own integration again.
      expect(await run(failing, next, { integrationID: "ig_b", hold: "op_2" })).toMatchObject({
        reused: true,
        result: { ok: false },
      })
    },
    SLOW,
  )

  test(
    "runs take turns through the folder's lease; a run stopped while it waits ends without touching the folder",
    async () => {
      const marks = path.join(box.root, "lease-marks.txt")
      const release = path.join(box.root, "lease-release.txt")
      const { fx, team, dir, first } = setup([tool("block", marks, "a", release)])
      const next = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      const second: OwnTeam.Team = { ...team, commands: { ...team.commands, assets: [tool("mark", marks, "b")] } }

      const a = run(team, first, { integrationID: "ig_1", hold: "op_1" })
      await until(() => lines(marks).includes("start a"))
      const b = run(second, next, { integrationID: "ig_2", hold: "op_2" })
      const stop = new AbortController()
      const c = run(second, next, { integrationID: "ig_3", hold: "op_3", signal: stop.signal })
      stop.abort()
      expect(await c).toEqual({ state: "stopped" })
      await Bun.sleep(1_000)
      expect(lines(marks)).toEqual(["start a"])
      expect(head(dir)).toBe(first)

      fs.writeFileSync(release, "go")
      expect(await a).toMatchObject({ state: "done", result: { ok: true, sha: first } })
      expect(await b).toMatchObject({ state: "done", result: { ok: true, sha: next } })
      expect(lines(marks)).toEqual(["start a", "end a", "b"])
      expect(head(dir)).toBe(next)
    },
    SLOW,
  )

  test(
    "a folder that is not the recorded one is broken and left as it is (TI-14)",
    async () => {
      const { fx, team, dir, first } = setup([tool("exists", "src/app.ts")])
      expect(await run(team, first)).toMatchObject({ state: "done" })
      fs.writeFileSync(path.join(dir, "keep-me.txt"), "keep me")
      const record = AssetsVerify.files(team, "ig_a", first).folder
      const stored = JSON.parse(fs.readFileSync(record, "utf8"))
      fs.writeFileSync(record, JSON.stringify({ ...stored, gitDir: path.join(fx.home, ".git", "worktrees", "other") }))
      const next = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      expect(await run(team, next, { integrationID: "ig_b", hold: "op_b" })).toMatchObject({ state: "broken" })
      expect(fs.readFileSync(path.join(dir, "keep-me.txt"), "utf8")).toBe("keep me")
      expect(head(dir)).toBe(first)

      // A branch checked out in the folder is not the asset check folder either.
      fs.writeFileSync(record, JSON.stringify(stored))
      git(dir, ["switch", "-q", "-c", "someone"])
      expect(await run(team, next, { integrationID: "ig_b", hold: "op_b" })).toMatchObject({ state: "broken" })
      expect(git(fx.home, ["rev-parse", "someone"]).trim()).toBe(first)
      expect(git(fx.home, ["for-each-ref", "refs/own/hold"])).toBe("")
    },
    SLOW,
  )

  test(
    "needed: a heavy change or the owner's engine-run request with this candidate, and asset commands",
    async () => {
      const { fx, team, first } = setup([tool("exists", "src/app.ts")])
      const heavy = save(fx.home, { "assets/textures/tree.bin": "tree\n" })
      const code = save(fx.home, { "src/other.ts": "other\n" })
      const ask = (input: {
        base: string
        candidate: string
        area?: Pick<OwnTeam.Area, "candidate">
        team?: OwnTeam.Team
      }) =>
        AssetsVerify.needed({
          team: input.team ?? team,
          area: input.area ?? {},
          source: input.candidate,
          base: input.base,
          candidate: input.candidate,
        })
      expect(await ask({ base: first, candidate: heavy })).toEqual({
        ok: true,
        needed: true,
        paths: ["assets/textures/tree.bin"],
        requested: false,
      })
      expect(await ask({ base: heavy, candidate: code })).toEqual({ ok: true, needed: false })
      expect(
        await ask({ base: heavy, candidate: code, area: { candidate: { sha: code, at: 0, text: "", assets: true } } }),
      ).toEqual({ ok: true, needed: true, paths: [], requested: true })
      // A request made with another candidate does not carry over.
      expect(
        await ask({ base: heavy, candidate: code, area: { candidate: { sha: heavy, at: 0, text: "", assets: true } } }),
      ).toEqual({ ok: true, needed: false })
      // Without asset commands or heavy folders there is nothing to run.
      expect(
        await ask({ base: first, candidate: heavy, team: { ...team, commands: { ...team.commands, assets: [] } } }),
      ).toEqual({ ok: true, needed: false })
      expect(
        await ask({ base: first, candidate: heavy, team: { ...team, heavy: { ...team.heavy, dirs: [] } } }),
      ).toEqual({ ok: true, needed: false })
    },
    SLOW,
  )
})

describe("IntegrateOp: the asset check step (06 §7.2 step 7)", () => {
  const world = new World()
  const entries: Services.DigestEntry[] = []
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    features: {
      admit: () => ({
        dispatch: async () => ({ ok: true, dispatchID: OwnTeam.DispatchID.create(), state: "queued" }),
        message: async () => ({ ok: true, guard: "limit" }),
        drain: async () => {},
        list: async () => ({ ok: true, items: [] }),
        cancel: async () => ({ ok: true }),
        cancelAll: async () => [],
      }),
      digest: () => ({
        add: async (_teamID, entry) => {
          entries.push(entry)
        },
        render: async () => "",
      }),
    },
  })
  IntegrateOp.register(h.services)
  afterAll(() => h.close())

  /** Steps 0-7 of an integration of the area's commit of `files` (a fast-forward, so K = C). */
  async function integrateWith(input: {
    readonly files: Readonly<Record<string, string>>
    readonly commands: ReadonlyArray<OwnTeam.Command>
    readonly requested?: boolean
    readonly policy?: Partial<OwnTeam.Policy>
    readonly confirm?: boolean
  }) {
    const { fx, team, dir } = setup(input.commands, input.policy)
    entries.splice(0)
    git(fx.area.directory, ["merge", "-q", "--ff-only", "main"])
    const source = save(fx.area.directory, input.files)
    const area = {
      ...fx.area,
      candidate: { sha: source, at: 0, text: "ready", ...(input.requested ? { assets: true } : {}) },
    }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team)
      await h.services.registry.areas.put(area)
    })
    const planned = await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })
    if (!planned.ok) throw new Error(planned.message)
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "integrate",
      by: "main",
      areaID: area.id,
      steps: planned.steps.map((step) =>
        input.confirm && step.kind === IntegrateOp.KIND.assets ? { ...step, mode: "confirm" as const } : step,
      ),
    })
    if (!started.ok) throw new Error("busy")
    await h.services.runner.settled(started.op.id)
    const read = async () => ({
      op: (await h.services.journal.get(TEAM_ID, started.op.id))!,
      record: (await IntegrateOp.get(h.services, TEAM_ID, planned.integrationID))!,
    })
    return { fx, dir, source, ...(await read()), read }
  }

  test(
    "K changes a heavy folder: .assets runs the asset commands and verify.assets records the result",
    async () => {
      const { op, record, source, dir } = await integrateWith({
        files: { "assets/textures/rock.bin": "rock 2\n" },
        commands: [tool("exists", "assets/textures/rock.bin")],
      })
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "skipped", "done"])
      expect(op.steps[5]?.note).toMatch(/^큰 파일 검사 통과 \d+초$/)
      expect(record).toMatchObject({
        state: "running",
        candidate: source,
        verify: { assets: { ok: true, sha: source } },
      })
      expect(record.checks).toBeUndefined()
      expect(head(dir)).toBe(source)
      expect(entries).toEqual([])
    },
    SLOW,
  )

  test(
    "no heavy change and no engine-run request: 'skipped', and no .assets is made",
    async () => {
      const { op, record, dir } = await integrateWith({
        files: { "src/area.ts": "area\n" },
        commands: [tool("exists", "src/area.ts")],
      })
      expect(op.state).toBe("done")
      expect(op.steps[5]).toMatchObject({ state: "done", note: "큰 파일 검사는 건너뜀" })
      expect(record.verify.assets).toBe("skipped")
      expect(fs.existsSync(dir)).toBe(false)
    },
    SLOW,
  )

  test(
    "the owner's engine-run request (Area.candidate.assets) runs .assets without a heavy change",
    async () => {
      const { record, source, dir } = await integrateWith({
        files: { "src/area.ts": "area\n" },
        commands: [tool("exists", "src/area.ts")],
        requested: true,
      })
      expect(record.verify.assets).toMatchObject({ ok: true, sha: source })
      expect(head(dir)).toBe(source)
    },
    SLOW,
  )

  test(
    "a failed asset check fails the integration (failure assets) and wakes the main",
    async () => {
      const { op, record } = await integrateWith({
        files: { "assets/textures/rock.bin": "rock 2\n" },
        commands: [tool("fail", "3")],
      })
      expect(op.state).toBe("failed")
      expect(record).toMatchObject({ state: "failed", failure: "assets", verify: { assets: { ok: false } } })
      expect(entries).toEqual([expect.objectContaining({ reason: "integration-failed", wake: true })])
      expect(entries[0]?.text).toContain("큰 파일 검사 실패")
    },
    SLOW,
  )

  test(
    "a first creation that needs a confirm: an auto step stops the integration; a confirm step answered do makes it",
    async () => {
      const auto = await integrateWith({
        files: { "assets/textures/rock.bin": "rock 2\n" },
        commands: [tool("exists", "assets/textures/rock.bin")],
        policy: { askDiskBytes: 1 },
      })
      expect(auto.op.state).toBe("failed")
      expect(auto.record).toMatchObject({ state: "failed", failure: "assets" })
      expect(entries[0]?.text).toContain("확인이 필요해요")
      expect(fs.existsSync(auto.dir)).toBe(false)

      const asked = await integrateWith({
        files: { "assets/textures/rock.bin": "rock 2\n" },
        commands: [tool("exists", "assets/textures/rock.bin")],
        policy: { askDiskBytes: 1 },
        confirm: true,
      })
      expect(asked.op.state).toBe("waiting")
      const step = asked.op.steps[5]
      expect(step).toMatchObject({ kind: IntegrateOp.KIND.assets, state: "needs_confirm" })
      expect(step?.confirm?.text).toContain("처음 만들까요")
      expect(step?.confirm?.bytes).toBeGreaterThan(0)
      expect(asked.record.state).toBe("running")
      expect(fs.existsSync(asked.dir)).toBe(false)
      const answered = await h.services.runner.confirm({
        opID: asked.op.id,
        stepID: step?.id ?? "",
        choice: "do",
        nonce: step?.confirm?.nonce ?? "",
      })
      expect(answered).toMatchObject({ ok: true })
      const after = await asked.read()
      expect(after.op.state).toBe("done")
      expect(after.record.verify.assets).toMatchObject({ ok: true, sha: asked.source })
      expect(head(asked.dir)).toBe(asked.source)
    },
    SLOW,
  )
})

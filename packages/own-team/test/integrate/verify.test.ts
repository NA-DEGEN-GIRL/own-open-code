// The code verify folder (06 §7.2 step 6, §2.6 (d), §4.12 Bun cache, §6.6 integration logs; TG11 verify items):
// `.verify` is a detached, code-only worktree locked `own.team verify`; a new top-level folder of K is measured and in
// the cone before any command runs; clean -fdx keeps node_modules and .own-bun-cache; the setup runs again only when
// the lockfiles change, with own's Bun cache variable; the code checks run in order with exit code, duration and the
// last 64 KB of output; a result for the same K answers without running anything, a stopped run continues with the
// commands that have no result; the time limit or a stop ends a command's whole process tree, and only the time limit
// is a (failed) run with a note in the log; a folder that is not the recorded one is broken and left alone. Through
// the op, the verify step records the result and a failed check fails the integration and wakes the main. Fixtures in
// temp folders; the commands are a small script run by this Bun.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { BunCache } from "../../src/assets/bun-cache.js"
import { Cone } from "../../src/git/cone.js"
import { Porcelain } from "../../src/git/porcelain.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import { Verify } from "../../src/integrate/verify.js"
import type { Services } from "../../src/services.js"
import { integrate, save } from "../fixtures/integrate.js"
import { git, head, temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller } from "../support/context.js"

const SLOW = 240_000

const box = temp("own-team-verify-")
afterAll(() => box.dispose())

/**
 * The commands' script: `exists <file>`, `count <file>`, `setup <file>`, `big`, `fail <code>`, `wait <release>`,
 * `sleep <pid file>` (writes its pid, then runs for a minute).
 */
const TOOL = path.join(box.root, "tool.js")
fs.writeFileSync(
  TOOL,
  [
    `const fs = require("node:fs")`,
    `const [mode, arg] = process.argv.slice(2)`,
    `if (mode === "exists") process.exit(fs.existsSync(arg) ? 0 : 1)`,
    `if (mode === "count") { fs.appendFileSync(arg, "x\\n"); process.exit(0) }`,
    `if (mode === "setup") {`,
    `  fs.appendFileSync(arg, (process.env.${BunCache.VARIABLE} ?? "-") + "\\n")`,
    `  fs.mkdirSync("node_modules/pkg", { recursive: true })`,
    `  fs.writeFileSync("node_modules/pkg/index.js", "installed")`,
    `  process.exit(0)`,
    `}`,
    `if (mode === "big") { process.stdout.write("a".repeat(100 * 1024) + "\\nlast line of big\\n"); process.exit(0) }`,
    `if (mode === "fail") { console.log("failing now"); process.exit(Number(arg)) }`,
    `if (mode === "wait") { if (fs.existsSync(arg)) process.exit(0); setTimeout(() => process.exit(0), 60_000) }`,
    `if (mode === "sleep") {`,
    `  fs.writeFileSync(arg + ".tmp", String(process.pid))`,
    `  fs.renameSync(arg + ".tmp", arg)`,
    `  setTimeout(() => process.exit(0), 60_000)`,
    `}`,
  ].join("\n"),
)

function tool(...args: string[]): OwnTeam.Command {
  return { argv: [process.execPath, TOOL, ...args] }
}

const fixtures = { next: 0 }

/** A fixture whose team has `assets` as its heavy folder (code-only) and the given commands. */
function setup(commands: Partial<OwnTeam.Commands> = {}, env: Partial<OwnTeam.Team["env"]> = {}) {
  const fx = integrate(path.join(box.root, `f${fixtures.next++}`))
  const team: OwnTeam.Team = {
    ...fx.team,
    heavy: { dirs: ["assets"], measuredAt: fx.base, forcedBytes: 0 },
    commands: { setup: null, code: [], assets: [], ...commands },
    env: { ...fx.team.env, ...env },
  }
  const counter = path.join(box.root, `counter-${fixtures.next}.txt`)
  return { fx, team, dir: Verify.directory(team), counter }
}

const runs = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [])

/** A shell string (`cmd.exe` stays between it and the script on Windows) running `tool sleep <pid file>`. */
const sleeper = (file: string) => ({ shell: `"${process.execPath}" "${TOOL}" sleep "${file}"` })

async function until<T>(read: () => T | undefined, deadline = Date.now() + 15_000): Promise<T> {
  const value = read()
  if (value !== undefined) return value
  if (Date.now() > deadline) throw new Error("not seen in time")
  await Bun.sleep(50)
  return until(read, deadline)
}

const pidIn = (file: string) => until(() => (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : undefined))

/** Waits until `pid` no longer runs (a killed POSIX process stays a zombie until it is reaped). */
const gone = (pid: number) =>
  until(() => {
    try {
      process.kill(pid, 0)
      return undefined
    } catch {
      return true
    }
  }, Date.now() + 5_000)

describe("Verify: the code verify folder (06 §7.2 step 6)", () => {
  test(
    "detached, code-only, locked 'own.team verify'; a new top-level folder of K is in the cone before the commands",
    async () => {
      const { fx, team, dir } = setup({ code: [tool("exists", "tools2/check.txt"), tool("exists", "src/app.ts")] })
      const k1 = save(fx.home, { "tools2/check.txt": "new top-level folder\n" })
      const first = await Verify.run({ team, integrationID: "ig_a", candidate: k1 })
      expect(first).toMatchObject({ state: "done", reused: false, cone: { ok: true, missing: [] }, code: { ok: true } })

      const entry = Porcelain.worktrees(git(fx.home, ["worktree", "list", "--porcelain", "-z"])).find(
        (item) => path.resolve(item.path) === path.resolve(dir),
      )
      expect(entry).toMatchObject({ detached: true, head: k1, locked: Verify.LOCK_REASON })
      expect(git(dir, ["config", "--worktree", "--get", "index.sparse"]).trim()).toBe("true")
      expect(Porcelain.sparseDirectories(git(dir, ["ls-files", "--sparse", "-z"]))).toEqual(["assets"])
      expect(fs.existsSync(path.join(dir, "assets", "textures"))).toBe(false)

      // The folder stays; the next K brings another new top-level folder into its cone ([R-review] e10).
      const k2 = save(fx.home, { "newtop/x.txt": "x\n", "tools2/check.txt": "still here\n" })
      const second = await Verify.run({
        team: { ...team, commands: { ...team.commands, code: [tool("exists", "newtop/x.txt")] } },
        integrationID: "ig_b",
        candidate: k2,
      })
      expect(second).toMatchObject({ state: "done", cone: { ok: true }, code: { ok: true } })
      const listed = await Cone.list(dir)
      expect(listed.ok && listed.dirs).toEqual(expect.arrayContaining(["newtop", "tools2", "src", "docs"]))
      expect(head(dir)).toBe(k2)
      // The home and the target were not touched.
      expect(git(fx.home, ["status", "--porcelain"])).toBe("")
      expect(head(fx.home)).toBe(k2)
    },
    SLOW,
  )

  test(
    "06 §4.4 G5: the list as it is at K folds a new heavy folder at its own depth; the code beside it stays in",
    async () => {
      const { fx, team, dir } = setup({ code: [tool("exists", "game/scripts/player.ts")] })
      const plain: OwnTeam.Team = { ...team, heavy: { dirs: [], measuredAt: fx.base, forcedBytes: 0 } }
      // A team without heavy folders makes a full verify folder.
      const k1 = save(fx.home, { "game/scripts/player.ts": "export const player = 1\n" })
      expect(await Verify.run({ team: plain, integrationID: "ig_g1", candidate: k1 })).toMatchObject({
        state: "done",
        code: { ok: true },
      })
      expect(Bun.spawnSync(["git", "-C", dir, "config", "--get", "core.sparseCheckout"]).exitCode).not.toBe(0)
      // K brings art beside the scripts; the integration's measurement says `game/art` is heavy.
      const k2 = save(fx.home, { "game/art/hero.bin": "\u0000".repeat(20_000), "game/scripts/enemy.ts": "e\n" })
      const second = await Verify.run({ team: plain, integrationID: "ig_g2", candidate: k2, heavy: ["game/art"] })
      expect(second).toMatchObject({ state: "done", cone: { ok: true, missing: [] }, code: { ok: true } })
      expect(git(dir, ["config", "--get", "core.sparseCheckout"]).trim()).toBe("true")
      expect(fs.existsSync(path.join(dir, "game", "art"))).toBe(false)
      // Not the whole top-level folder: the scripts beside the art are there (the old rule dropped `game/` whole).
      expect(fs.existsSync(path.join(dir, "game", "scripts", "enemy.ts"))).toBe(true)
      expect(fs.existsSync(path.join(dir, "src", "app.ts"))).toBe(true)
    },
    SLOW,
  )

  test(
    "clean -fdx before the checks keeps node_modules and .own-bun-cache, removes build output and stray files",
    async () => {
      const { fx, team, dir } = setup({ code: [tool("exists", "src/app.ts")] })
      const k1 = save(fx.home, { "src/one.ts": "1\n" })
      expect(await Verify.run({ team, integrationID: "ig_c", candidate: k1 })).toMatchObject({ state: "done" })
      const put = (file: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        fs.writeFileSync(path.join(dir, file), "x")
      }
      ;["node_modules/pkg/index.js", "src/node_modules/inner/index.js", ".own-bun-cache/blob", "dist/out.js"].forEach(
        put,
      )
      put("src/app.tsbuildinfo")
      put("stray.txt")
      const k2 = save(fx.home, { "src/two.ts": "2\n" })
      expect(await Verify.run({ team, integrationID: "ig_d", candidate: k2 })).toMatchObject({
        state: "done",
        code: { ok: true },
      })
      const exists = (file: string) => fs.existsSync(path.join(dir, file))
      expect(exists("node_modules/pkg/index.js")).toBe(true)
      expect(exists("src/node_modules/inner/index.js")).toBe(true)
      expect(exists(".own-bun-cache/blob")).toBe(true)
      expect(exists("dist/out.js")).toBe(false)
      expect(exists("src/app.tsbuildinfo")).toBe(false)
      expect(exists("stray.txt")).toBe(false)
      expect(exists("src/two.ts")).toBe(true)
    },
    SLOW,
  )

  test(
    "the setup runs again only when the lockfiles change, with BUN_INSTALL_CACHE_DIR of own's cache",
    async () => {
      const counter = path.join(box.root, "setup-runs.txt")
      const { fx, team } = setup(
        { setup: tool("setup", counter), code: [tool("exists", "node_modules/pkg/index.js")] },
        { bunCache: "other-volume" },
      )
      const before = process.env[BunCache.VARIABLE]
      const k1 = save(fx.home, { "src/one.ts": "1\n" })
      expect(await Verify.run({ team, integrationID: "ig_e", candidate: k1 })).toMatchObject({ code: { ok: true } })
      expect(runs(counter)).toEqual([BunCache.folder(team.worktreeRoot)])

      const k2 = save(fx.home, { "src/two.ts": "2\n" })
      expect(await Verify.run({ team, integrationID: "ig_f", candidate: k2 })).toMatchObject({ code: { ok: true } })
      expect(runs(counter)).toHaveLength(1)

      const k3 = save(fx.home, { "bun.lock": '{ "lockfileVersion": 1 }\n' })
      expect(await Verify.run({ team, integrationID: "ig_g", candidate: k3 })).toMatchObject({ code: { ok: true } })
      expect(runs(counter)).toHaveLength(2)
      expect(process.env[BunCache.VARIABLE]).toBe(before)
    },
    SLOW,
  )

  test(
    "commands.code run in order until one fails: exit code, duration, and the last 64 KB in integrations/<ig>.log",
    async () => {
      const { fx, team, counter } = setup()
      const failing: OwnTeam.Team = {
        ...team,
        commands: { ...team.commands, code: [tool("big"), tool("fail", "3"), tool("count", counter)] },
      }
      const k1 = save(fx.home, { "src/one.ts": "1\n" })
      const progress: number[] = []
      const outcome = await Verify.run({
        team: failing,
        integrationID: "ig_h",
        candidate: k1,
        progress: async (checks) => {
          progress.push(checks.current)
          expect(checks.total).toBe(3)
        },
      })
      if (outcome.state !== "done") throw new Error(JSON.stringify(outcome))
      const where = Verify.files(team, "ig_h", k1)
      expect(outcome.code).toMatchObject({ ok: false, failed: `${process.execPath} ${TOOL} fail 3`, log: where.log })
      expect(progress).toEqual([1, 2])
      expect(runs(counter)).toEqual([])
      const results = JSON.parse(fs.readFileSync(where.results, "utf8"))
      expect(results.runs.map((item: { code: number }) => item.code)).toEqual([0, 3])
      expect(results.runs.every((item: { ms: number }) => Number.isInteger(item.ms) && item.ms >= 0)).toBe(true)
      expect(outcome.code.ms).toBe(results.runs[0].ms + results.runs[1].ms)
      const log = fs.readFileSync(where.log, "utf8")
      expect(Buffer.byteLength(log)).toBeLessThanOrEqual(Verify.TAIL_BYTES)
      expect(log).toContain("last line of big")
      expect(log).toContain("failing now")
      expect(log).toContain("[exit 3")
    },
    SLOW,
  )

  test(
    "a stopped run continues with the commands left; a result for the same K answers without running",
    async () => {
      const { fx, team, counter } = setup()
      const release = path.join(box.root, "release-wait.txt")
      const counted: OwnTeam.Team = {
        ...team,
        commands: { ...team.commands, code: [tool("count", counter), tool("wait", release), tool("count", counter)] },
      }
      const k1 = save(fx.home, { "src/one.ts": "1\n" })
      const stop = new AbortController()
      const stopped = await Verify.run({
        team: counted,
        integrationID: "ig_i",
        candidate: k1,
        signal: stop.signal,
        progress: async (checks) => {
          if (checks.current === 2) setTimeout(() => stop.abort(), 500)
        },
      })
      expect(stopped).toEqual({ state: "stopped" })
      expect(runs(counter)).toHaveLength(1)

      // The next controller: the first command keeps its result; the stopped one and the last one run.
      fs.writeFileSync(release, "go")
      const resumed = await Verify.run({ team: counted, integrationID: "ig_i", candidate: k1 })
      expect(resumed).toMatchObject({ state: "done", reused: false, code: { ok: true } })
      expect(runs(counter)).toHaveLength(2)

      // The same K again, from this integration or another: answered from the result file.
      expect(await Verify.run({ team: counted, integrationID: "ig_i", candidate: k1 })).toMatchObject({
        state: "done",
        reused: true,
        code: { ok: true },
      })
      expect(await Verify.run({ team: counted, integrationID: "ig_other", candidate: k1 })).toMatchObject({
        reused: true,
      })
      expect(runs(counter)).toHaveLength(2)

      // A failed result answers only the integration that ran it; another integration runs the failed check again (the
      // folder is still prepared for K, so the check that passed keeps its result).
      const failing: OwnTeam.Team = {
        ...team,
        commands: { ...team.commands, code: [tool("count", counter), tool("fail", "1")] },
      }
      expect(await Verify.run({ team: failing, integrationID: "ig_x", candidate: k1 })).toMatchObject({
        reused: false,
        code: { ok: false },
      })
      expect(await Verify.run({ team: failing, integrationID: "ig_x", candidate: k1 })).toMatchObject({
        reused: true,
        code: { ok: false },
      })
      expect(runs(counter)).toHaveLength(3)
      expect(await Verify.run({ team: failing, integrationID: "ig_y", candidate: k1 })).toMatchObject({
        reused: false,
        code: { ok: false, log: Verify.files(team, "ig_y", k1).log },
      })
      expect(runs(counter)).toHaveLength(3)
      const log = fs.readFileSync(Verify.files(team, "ig_y", k1).log, "utf8")
      expect(log).toContain("failing now")
      expect(log).not.toContain(" count ")
    },
    SLOW,
  )

  test(
    "the time limit and a stop end the command's whole process tree; only the time limit is a run, noted in the log",
    async () => {
      // The time limit: a failed run, `[timed out after N min]` in the log, and the script under the shell is gone.
      const timedLog = path.join(box.root, "tree-timed.log")
      const timedPid = path.join(box.root, "tree-timed.pid")
      const timed = await Verify.execute(sleeper(timedPid), { cwd: box.root, log: timedLog, timeoutMs: 3_000 })
      expect(timed).toMatchObject({ label: sleeper(timedPid).shell })
      expect(timed?.code).not.toBe(0)
      expect(await gone(await pidIn(timedPid))).toBe(true)
      expect(fs.readFileSync(timedLog, "utf8")).toMatch(/\n\[timed out after [\d.]+ min\]\n\[exit /)

      // A stop by the caller: no run (it runs again later), no time-limit note, and nothing left running.
      const stoppedLog = path.join(box.root, "tree-stopped.log")
      const stoppedPid = path.join(box.root, "tree-stopped.pid")
      const stop = new AbortController()
      const stopped = Verify.execute(sleeper(stoppedPid), { cwd: box.root, log: stoppedLog, signal: stop.signal })
      const pid = await pidIn(stoppedPid)
      stop.abort()
      expect(await stopped).toBeUndefined()
      expect(await gone(pid)).toBe(true)
      expect(fs.readFileSync(stoppedLog, "utf8")).not.toContain("[timed out")
    },
    SLOW,
  )

  test(
    "the cone changes only when Cone.endangered finds nothing: ignored files the clean keeps stop it (T1 review #12)",
    async () => {
      const { fx, team, dir } = setup({ code: [tool("exists", "src/app.ts")] })
      const k1 = save(fx.home, { "src/one.ts": "1\n" })
      expect(await Verify.run({ team, integrationID: "ig_l", candidate: k1 })).toMatchObject({ state: "done" })
      // An install the clean keeps, ignored by the shared exclude file, in a folder the next cone collapses.
      fs.appendFileSync(path.join(fx.home, ".git", "info", "exclude"), "\nnode_modules/\n")
      fs.mkdirSync(path.join(dir, "src", "node_modules", "pkg"), { recursive: true })
      fs.writeFileSync(path.join(dir, "src", "node_modules", "pkg", "index.js"), "installed")
      const heavier: OwnTeam.Team = { ...team, heavy: { ...team.heavy, dirs: ["assets", "src"] } }
      const k2 = save(fx.home, { "docs/two.md": "2\n" })
      const outcome = await Verify.run({ team: heavier, integrationID: "ig_m", candidate: k2 })
      expect(outcome).toMatchObject({ state: "cone", cone: { ok: false } })
      expect(outcome.state === "cone" && outcome.message).toContain("src/node_modules")
      expect(fs.readFileSync(path.join(dir, "src", "node_modules", "pkg", "index.js"), "utf8")).toBe("installed")
      const listed = await Cone.list(dir)
      expect(listed.ok && listed.dirs).toContain("src")
    },
    SLOW,
  )

  test(
    "a folder that is not the recorded verify worktree is broken and left as it is",
    async () => {
      const { fx, team, dir } = setup({ code: [tool("exists", "src/app.ts")] })
      const k1 = save(fx.home, { "src/one.ts": "1\n" })
      expect(await Verify.run({ team, integrationID: "ig_j", candidate: k1 })).toMatchObject({ state: "done" })
      fs.writeFileSync(path.join(dir, "stray.txt"), "keep me")
      const record = Verify.files(team, "ig_k", k1).folder
      const stored = JSON.parse(fs.readFileSync(record, "utf8"))
      fs.writeFileSync(record, JSON.stringify({ ...stored, gitDir: path.join(fx.home, ".git", "worktrees", "other") }))
      const k2 = save(fx.home, { "src/two.ts": "2\n" })
      expect(await Verify.run({ team, integrationID: "ig_k", candidate: k2 })).toMatchObject({ state: "broken" })
      expect(fs.readFileSync(path.join(dir, "stray.txt"), "utf8")).toBe("keep me")
      expect(head(dir)).toBe(k1)

      // A branch checked out in the folder is not the verify worktree either.
      fs.writeFileSync(record, JSON.stringify(stored))
      git(dir, ["switch", "-q", "-c", "someone"])
      expect(await Verify.run({ team, integrationID: "ig_k", candidate: k2 })).toMatchObject({ state: "broken" })
      expect(git(fx.home, ["rev-parse", "someone"]).trim()).toBe(k1)
    },
    SLOW,
  )
})

describe("IntegrateOp: the verify step (06 §7.2 step 6)", () => {
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

  async function integrateWith(code: ReadonlyArray<OwnTeam.Command>) {
    const { fx, team } = setup({ code: [...code] })
    entries.splice(0)
    const source = save(fx.area.directory, { "src/area.ts": "area\n" })
    const area = { ...fx.area, candidate: { sha: source, at: 0, text: "ready" } }
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
      steps: planned.steps,
    })
    if (!started.ok) throw new Error("busy")
    await h.services.runner.settled(started.op.id)
    return {
      fx,
      source,
      op: (await h.services.journal.get(TEAM_ID, started.op.id))!,
      record: (await IntegrateOp.get(h.services, TEAM_ID, planned.integrationID))!,
    }
  }

  test(
    "passing checks: verify.code and verify.cone recorded, the progress cleared, the integration goes on",
    async () => {
      const { op, record, source } = await integrateWith([
        tool("exists", "src/area.ts"),
        tool("exists", "docs/guide.md"),
      ])
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "done"])
      expect(record).toMatchObject({
        state: "running",
        candidate: source,
        verify: { code: { ok: true }, cone: { ok: true, missing: [] }, assets: "skipped" },
      })
      expect(record.checks).toBeUndefined()
      expect(op.steps[4]?.note).toMatch(/^코드 검사 통과 \d+초$/)
      expect(entries).toEqual([])
    },
    SLOW,
  )

  test(
    "a failed check fails the integration (failure verify) and its line wakes the main",
    async () => {
      const { op, record } = await integrateWith([tool("exists", "src/area.ts"), tool("fail", "2")])
      expect(op.state).toBe("failed")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "failed", "pending"])
      expect(record).toMatchObject({ state: "failed", failure: "verify", verify: { code: { ok: false } } })
      expect(entries).toEqual([expect.objectContaining({ reason: "integration-failed", wake: true })])
      expect(entries[0]?.text).toContain("코드 검사 실패")
    },
    SLOW,
  )
})

// Removing an area's work folder (06 §8.6, TI-1–TI-3, TI-8, TI-12, TI-14; TG12 removal items, TG18 links removed
// without following): the scan refuses nested worktrees and independent repositories in ignored folders, uncommitted
// work and edited link copies, and a walk that ran out of budget; the dialog lists only what can be made again and its
// nonce is bound to that list; small irreplaceable files go to the team records; detached commits get a keep ref; own's
// links go first without following them; `git worktree remove` runs without --force after the identity check; a folder
// a process holds is cleared later only from the confirmed list. Real git fixtures (F1), a fake service on 127.0.0.1,
// fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Refs } from "../../src/git/refs.js"
import { Git } from "../../src/git/run.js"
import { Worktree } from "../../src/git/worktree.js"
import type { Steps } from "../../src/ops/steps.js"
import { Remove } from "../../src/reorg/remove.js"
import { Areas } from "../../src/registry/area.js"
import type { Services } from "../../src/services.js"
import { commit, f1, files, git, head, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { start, type FakeService } from "../support/service.js"

/** Git process starts are slow on Windows. */
const SLOW = 180_000
const NOW = Date.UTC(2026, 9, 4, 3, 0, 0)
const WINDOWS = process.platform === "win32"

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
}, SLOW)

/** The own service: `session.active` (nothing runs) and `worktree.refresh` calls. */
class Backend {
  readonly service: FakeService = start()
  refreshes = 0

  constructor() {
    this.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    this.service.routes.set("POST /api/worktree/refresh", () => {
      this.refreshes++
      return new Response(null, { status: 204 })
    })
  }
}

interface Setup {
  readonly options?: Remove.Options
  readonly shared?: OwnTeam.Team["shared"]
}

/** F1 with an exclude file for the ignored entries the tests make, and a controller whose kinds use a git spy. */
async function setup(input: Setup = {}) {
  const root = temp("own-team-remove-")
  cleanups.push(() => root.dispose())
  const repo = f1(root.root)
  const commonDir = path.join(repo.home, ".git")
  fs.appendFileSync(
    path.join(commonDir, "info", "exclude"),
    ["node_modules/", ".env", "vendor/", ".worktrees/", "/weights", "dist/", ""].join("\n"),
  )
  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const backend = new Backend()
  cleanups.push(() => backend.service.stop())
  const world = new World()
  const safe: { value: Services.Safe } = { value: { ok: true } }
  const harness = controller(world, {
    directory: ownHome.root,
    clock: manual(NOW),
    home: ownHome.root,
    source: backend.service.source,
    features: { safePoint: () => ({ check: async () => safe.value }) },
  })
  cleanups.push(() => harness.close())
  const record: OwnTeam.Team = {
    ...team({ home: repo.home }),
    env: { symlinkFix: "skip-worktree", bunCache: "unused", lfs: "unused" },
    shared: input.shared ?? [],
  }
  await harness.services.write(TEAM_ID, () => harness.services.registry.teams.put(record))
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly cwd?: string }> = []
  const spy: Remove.Runner = (args, options) => {
    calls.push({ args: [...args], ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
    return Git.run(args, options)
  }
  Remove.register(harness.services, { git: spy, ...input.options })
  return { ...harness, repo, commonDir, backend, safe, calls, team: record }
}

type Harness = Awaited<ReturnType<typeof setup>>

/** A plain area worktree beside the home, locked as own locks it, and its record (no owner conversation). */
async function makeArea(h: Harness, slug: string) {
  const areaID = Areas.id(slug)
  const directory = path.join(`${h.repo.home}-team`, slug)
  git(h.repo.home, ["worktree", "add", "-q", "--lock", "--reason", Worktree.lockReason(areaID), "-b", slug, directory])
  const record: OwnTeam.Area = {
    ...area({ slug, directory }),
    gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim(),
    base: { sha: h.repo.head, at: 0 },
    owner: { sessionID: null, previous: [], attached: false },
  }
  await save(h, record)
  return record
}

async function save(h: Harness, record: OwnTeam.Area) {
  await h.services.write(TEAM_ID, () => h.services.registry.areas.put(record))
}

async function read(h: Harness, areaID: OwnTeam.AreaID) {
  const found = await h.services.registry.areas.get(TEAM_ID, areaID)
  if (!found) throw new Error(`${areaID} is gone`)
  return found
}

async function settle(h: Harness, opID: OwnTeam.OpID) {
  const deadline = Date.now() + 120_000
  const get = () => h.services.journal.get(TEAM_ID, opID)
  while ((await get())?.state === "running") {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
  return (await get())!
}

/** One op of `retire-remove` steps (the confirm by default), run until it waits or ends. */
async function removal(h: Harness, steps: ReadonlyArray<Steps.Spec>) {
  const started = await h.services.runner.start({ teamID: TEAM_ID, kind: "retire", by: "user", steps })
  if (!started.ok) throw new Error("busy")
  return settle(h, started.op.id)
}

function waiting(op: OwnTeam.Op, areaID: OwnTeam.AreaID) {
  const step = op.steps.find((item) => item.kind === Remove.KIND && item.args.areaID === areaID)
  if (step?.state !== "needs_confirm" || !step.confirm) throw new Error(`no confirm for ${areaID}: ${step?.state}`)
  return { step, confirm: step.confirm }
}

async function answer(h: Harness, op: OwnTeam.Op, areaID: OwnTeam.AreaID) {
  const asked = waiting(op, areaID)
  return h.services.runner.confirm({ opID: op.id, stepID: asked.step.id, choice: "do", nonce: asked.confirm.nonce })
}

function listed(h: Harness, directory: string) {
  return git(h.repo.home, ["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line.startsWith("worktree ") && path.resolve(line.slice(9)) === path.resolve(directory))
}

function lockOf(h: Harness, directory: string) {
  const records = git(h.repo.home, ["worktree", "list", "--porcelain"]).split("\n\n")
  const record = records.find((item) => path.resolve(item.split("\n")[0]?.slice(9) ?? "") === path.resolve(directory))
  return (
    record
      ?.split("\n")
      .find((line) => line.startsWith("locked"))
      ?.slice("locked ".length) ?? null
  )
}

describe("Remove.scan refusals (TI-3 (a), (b); TG12 nested and other repositories)", () => {
  test(
    "a nested worktree in an ignored folder and an independent repository in ignored vendor/lib: refused, nothing removed",
    async () => {
      const h = await setup()
      const nested = await makeArea(h, "nest")
      const inner = path.join(nested.directory, ".worktrees", "inner")
      git(h.repo.home, ["worktree", "add", "-q", "-b", "inner-work", inner])
      write(inner, { "src/app/wip.ts": "export const wip = 1\n" })
      const vendored = await makeArea(h, "vend")
      const lib = path.join(vendored.directory, "vendor", "lib")
      fs.mkdirSync(lib, { recursive: true })
      git(lib, ["init", "-q", "-b", "main"])
      write(lib, { "a.txt": "one\n" })
      const local = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
      git(lib, [...local, "add", "-A"])
      git(lib, [...local, "commit", "-q", "-m", "local"])
      write(lib, { "a.txt": "changed\n" })
      // `status` shows only `! vendor/`: the nested repository is invisible to git (06 §8.6 [R-review] e7).
      expect(git(vendored.directory, ["status", "--porcelain", "--ignored"])).toContain("!! vendor/")
      const before = [files(nested.directory), files(vendored.directory)]

      for (const record of [nested, vendored]) {
        const scanned = await Remove.scan({ team: h.team, area: record })
        expect(scanned).toMatchObject({ kind: "refused", why: "nested" })
        if (scanned.kind === "refused") expect(scanned.message).toStartWith(Remove.NESTED)
      }
      const op = await removal(h, [Remove.spec(nested.id, "auto"), Remove.spec(vendored.id, "auto")])
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => [step.state, step.note?.startsWith(Remove.NESTED)])).toEqual([
        ["skipped", true],
        ["skipped", true],
      ])
      expect(op.summary?.lines).toEqual([
        { kind: "area", areaID: nested.id, change: "touched" },
        { kind: "area", areaID: vendored.id, change: "touched" },
      ])
      expect([files(nested.directory), files(vendored.directory)]).toEqual(before)
      expect(fs.readFileSync(path.join(inner, "src", "app", "wip.ts"), "utf8")).toBe("export const wip = 1\n")
      expect(listed(h, nested.directory) && listed(h, vendored.directory) && listed(h, inner)).toBe(true)
      expect(lockOf(h, nested.directory)).toBe(Worktree.lockReason(nested.id))
      // Nothing ran that changes a folder.
      expect(h.calls.some((call) => call.args[0] === "worktree" && call.args[1] !== "list")).toBe(false)
    },
    SLOW,
  )

  test(
    "uncommitted work and a walk past its budget refuse; an edited link copy is dirty with a lasting notice",
    async () => {
      const h = await setup()
      const work = await makeArea(h, "work")
      write(work.directory, { "src/app/main.ts": "export const main = 2\n" })
      expect(await Remove.scan({ team: h.team, area: work })).toMatchObject({ kind: "refused", why: "dirty" })

      const big = await makeArea(h, "big")
      expect(await Remove.scan({ team: h.team, area: big, options: { limits: { entries: 3 } } })).toMatchObject({
        kind: "refused",
        why: "partial",
      })

      // Link copies as the home keeps them (FORK §11); the folder copy shows as `!` and is own's, not the user's.
      const copies = await makeArea(h, "copies")
      const applied = await Symlinks.apply({ area: copies, fix: "skip-worktree" })
      if (!applied.ok) throw new Error(applied.message)
      const recorded = { ...copies, linkCopies: applied.linkCopies }
      await save(h, recorded)
      expect(fs.existsSync(path.join(copies.directory, "src", "app", "lib", "util.ts"))).toBe(true)
      const clean = await Remove.scan({ team: h.team, area: recorded })
      expect(clean).toMatchObject({ kind: "ready", remove: [], keep: [] })
      expect(clean.kind === "ready" && clean.covered).toContain("src/app/lib")
      // The copies go first, before git sees the folder (06 §8.6 step 4).
      expect(clean.kind === "ready" && [...clean.copies].toSorted()).toEqual([
        "README-link.md",
        "docs/guide-link.md",
        "src/app/lib",
      ])

      write(copies.directory, { "README-link.md": "edited through the copy\n" })
      // The flag hides the edit from status; the record does not.
      expect(git(copies.directory, ["status", "--porcelain"])).toBe("")
      const dirty = await Remove.scan({ team: h.team, area: recorded })
      expect(dirty).toMatchObject({ kind: "refused", why: "dirty", copies: [{ path: "README-link.md" }] })
      const op = await removal(h, [Remove.spec(copies.id, "auto")])
      expect(op.steps[0]?.state).toBe("skipped")
      const notices = await h.services.notices.open(TEAM_ID)
      expect(notices).toEqual([
        expect.objectContaining({ id: `link.copy.dirty:${copies.id}`, kind: "link.copy.dirty", areaID: copies.id }),
      ])
      expect(fs.readFileSync(path.join(copies.directory, "README-link.md"), "utf8")).toBe("edited through the copy\n")
      expect(listed(h, copies.directory)).toBe(true)
    },
    SLOW,
  )
})

describe("retire-remove (06 §8.6)", () => {
  test(
    "lists node_modules only, keeps .env in the team records, removes without --force after the identity check",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "deps")
      write(record.directory, {
        "node_modules/pkg/index.js": "x".repeat(4096),
        "node_modules/pkg/package.json": "{}\n",
        ".env": "TOKEN=fake-test-value\n",
      })
      const op = await removal(h, [Remove.spec(record.id)])
      expect(op.state).toBe("waiting")
      const asked = waiting(op, record.id).confirm
      expect(asked.files).toEqual([{ path: path.join(record.directory, "node_modules"), bytes: 4099 }])
      expect(asked.bytes).toBe(4099)
      expect(asked.text).toContain("설정 파일 1개는 팀 기록에 옮겨 둬요")
      expect(asked.text).toContain("다시 만들 수 있는 파일 4 KB를 지워요")
      expect(asked.text).not.toContain("반영하지 않은")
      const scanned = await Remove.scan({ team: h.team, area: record })
      expect(scanned.kind === "ready" && scanned.manifest).toBe(asked.manifest as string)
      // Nothing moved or removed before the answer (`두기` leaves the folder whole).
      expect(fs.existsSync(path.join(record.directory, ".env"))).toBe(true)
      expect(fs.existsSync(Remove.retiredFolder(h.team, record.id))).toBe(false)

      const answered = await answer(h, op, record.id)
      expect(answered).toMatchObject({ ok: true, op: { state: "done" } })
      expect(fs.existsSync(record.directory)).toBe(false)
      expect(listed(h, record.directory)).toBe(false)
      expect(fs.readFileSync(path.join(Remove.retiredFolder(h.team, record.id), ".env"), "utf8")).toBe(
        "TOKEN=fake-test-value\n",
      )
      // The branch stays (TI-4); the registry says retired after core's list was refreshed.
      expect(await Refs.read(h.commonDir, "refs/heads/deps")).toBe(h.repo.head)
      expect((await read(h, record.id)).state).toBe("retired")
      expect(h.backend.refreshes).toBe(1)
      expect(fs.readdirSync(path.join(path.dirname(Remove.retiredFolder(h.team, record.id))))).toEqual(["deps"])

      // TI-14 right before the folder changes: the identity check, then only the unlock, then the removal.
      const removed = h.calls.findIndex((call) => call.args[0] === "worktree" && call.args[1] === "remove")
      const identity = h.calls.findLastIndex(
        (call, index) =>
          index < removed &&
          call.args.join(" ") === "rev-parse --absolute-git-dir --show-toplevel" &&
          path.resolve(call.cwd ?? "") === path.resolve(record.directory),
      )
      expect(identity).toBeGreaterThanOrEqual(0)
      expect(h.calls.slice(identity + 1, removed).map((call) => call.args.slice(0, 2).join(" "))).toEqual([
        "worktree unlock",
      ])
      expect(h.calls[removed]?.args).toEqual(["worktree", "remove", record.directory])
      expect(h.calls.some((call) => call.args.includes("--force") || call.args.includes("-f"))).toBe(false)
    },
    SLOW,
  )

  test(
    "an irreplaceable ignored folder too large to keep is named apart and flagged in the list (8.6 step 2)",
    async () => {
      const h = await setup({ options: { limits: { keepBytes: 64 } } })
      const record = await makeArea(h, "data")
      write(record.directory, {
        "node_modules/pkg/index.js": "x".repeat(2048),
        ".env": "TOKEN=fake-test-value\n",
        "data/set.csv": "d".repeat(4096),
      })
      fs.appendFileSync(path.join(h.commonDir, "info", "exclude"), "/data\n")
      const scanned = await Remove.scan({ team: h.team, area: record, options: { limits: { keepBytes: 64 } } })
      expect(scanned.kind === "ready" && scanned.lost.map((item) => item.path)).toEqual(["data/"])
      const op = await removal(h, [Remove.spec(record.id)])
      const asked = waiting(op, record.id).confirm
      // The small .env still goes to the team records; the dataset is not called rebuildable.
      expect(asked.text).toContain("설정 파일 1개는 팀 기록에 옮겨 둬요")
      expect(asked.text).toContain("다시 만들 수 있는 파일 2 KB를 지워요")
      expect(asked.text).toContain("다시 만들 수 없는 파일 1개(4 KB)도 지워요: data")
      expect(asked.files).toEqual([
        { path: path.join(record.directory, "data"), bytes: 4096, irreplaceable: true },
        { path: path.join(record.directory, "node_modules"), bytes: 2048 },
      ])
      expect(fs.existsSync(path.join(record.directory, "data", "set.csv"))).toBe(true)
    },
    SLOW,
  )

  test(
    "a folder refused when its confirm is reached (a merge's B is planned without a scan): skipped with the reason, not failed",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "late-dirty")
      write(record.directory, { "src/app/main.ts": "export const changed = 1\n" })
      const op = await removal(h, [Remove.spec(record.id)])
      expect(op.state).toBe("done")
      expect(op.steps[0]).toMatchObject({
        state: "skipped",
        note: expect.stringContaining("아직 저장 지점에 넣지 않은 변경 1개"),
      })
      expect(op.summary?.lines).toContainEqual({ kind: "area", areaID: record.id, change: "touched" })
      expect(fs.existsSync(record.directory)).toBe(true)
    },
    SLOW,
  )

  test(
    "a new ignored file after the confirm: asked again with a new list, nothing deleted",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "late")
      write(record.directory, { "dist/app.js": "built\n" })
      const op = await removal(h, [Remove.spec(record.id)])
      const first = waiting(op, record.id).confirm
      write(record.directory, { "node_modules/late/index.js": "late\n" })
      const refused = await answer(h, op, record.id)
      expect(refused).toMatchObject({ ok: false, error: "nonce_invalid" })
      const again = await h.services.journal.get(TEAM_ID, op.id)
      const second = waiting(again!, record.id).confirm
      expect(second.manifest).not.toBe(first.manifest)
      expect(second.nonce).not.toBe(first.nonce)
      expect(second.files?.map((file) => path.basename(file.path)).toSorted()).toEqual(["dist", "node_modules"])
      expect(fs.existsSync(path.join(record.directory, "node_modules", "late", "index.js"))).toBe(true)
      expect(listed(h, record.directory)).toBe(true)
      expect(h.calls.some((call) => call.args[1] === "remove")).toBe(false)

      expect(await answer(h, again!, record.id)).toMatchObject({ ok: true, op: { state: "done" } })
      expect(fs.existsSync(record.directory)).toBe(false)
    },
    SLOW,
  )

  test(
    "a detached commit is keep-ref'd before the removal: no unreachable commit; an unmerged branch's count is asked",
    async () => {
      const h = await setup()
      const detached = await makeArea(h, "det")
      git(detached.directory, ["checkout", "-q", "--detach"])
      write(detached.directory, { "src/app/det.ts": "export const det = 1\n" })
      const sha = commit(detached.directory, "detached work")
      const ahead = await makeArea(h, "ahead")
      write(ahead.directory, { "src/app/a.ts": "1\n" })
      commit(ahead.directory, "one")
      write(ahead.directory, { "src/app/b.ts": "2\n" })
      const tip = commit(ahead.directory, "two")

      // The count of save points the target lacks is the step's (own-web's 남는 것 line, 8.2), as Retire plans it.
      const count = await Remove.unapplied(h.team, ahead, undefined)
      expect(count).toBe(2)
      const op = await removal(h, [Remove.spec(detached.id), Remove.spec(ahead.id, "confirm", count)])
      expect(waiting(op, detached.id).step.args).toEqual({ areaID: detached.id })
      expect(waiting(op, ahead.id).step.args).toEqual({ areaID: ahead.id, unapplied: 2 })
      for (const id of [detached.id, ahead.id]) expect(waiting(op, id).confirm.text).not.toContain("반영하지 않은")
      const first = await answer(h, op, detached.id)
      if (!first.ok) throw new Error(first.message)
      expect(await Refs.read(h.commonDir, `refs/own/keep/${sha}`)).toBe(sha)
      expect(first.op.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${sha}`, sha })
      const second = await answer(h, first.op, ahead.id)
      expect(second).toMatchObject({ ok: true, op: { state: "done" } })

      expect(fs.existsSync(detached.directory) || fs.existsSync(ahead.directory)).toBe(false)
      // The branch keeps the unapplied save points (TI-4); fsck finds no commit of the fixture unreachable.
      expect(await Refs.read(h.commonDir, "refs/heads/ahead")).toBe(tip)
      const unreachable = git(h.repo.home, ["fsck", "--unreachable", "--no-reflogs"])
      expect(unreachable).not.toContain(sha)
      expect(unreachable).not.toContain(tip)
      expect(unreachable.split("\n").filter((line) => line.startsWith("unreachable commit"))).toEqual([])
    },
    SLOW,
  )

  test(
    "bundled confirms of several areas, each bound to its own list; info/exclude keeps a copy's line while another folder holds it",
    async () => {
      const h = await setup()
      const exclude = path.join(h.commonDir, "info", "exclude")
      const made = await Promise.all(["one", "two"].map((slug) => makeArea(h, slug)))
      const records = await Promise.all(
        made.map(async (item, index) => {
          const applied = await Symlinks.apply({ area: item, fix: "skip-worktree" })
          if (!applied.ok) throw new Error(applied.message)
          write(item.directory, { [`node_modules/m${index}/index.js`]: "m".repeat(100 * (index + 1)) })
          const record = { ...item, linkCopies: applied.linkCopies }
          await save(h, record)
          return record
        }),
      )
      expect(fs.readFileSync(exclude, "utf8")).toContain("/src/app/lib/")
      const [one, two] = records as [OwnTeam.Area, OwnTeam.Area]

      const op = await removal(h, [Remove.spec(one.id), Remove.spec(two.id)])
      expect(op.state).toBe("waiting")
      const asked = [waiting(op, one.id).confirm, waiting(op, two.id).confirm]
      expect(asked.map((item) => item.files?.map((file) => file.bytes))).toEqual([[100], [200]])
      expect(asked[0]?.manifest).not.toBe(asked[1]?.manifest)

      const first = await answer(h, op, one.id)
      if (!first.ok) throw new Error(first.message)
      expect(fs.existsSync(one.directory)).toBe(false)
      // `two` still holds a folder copy at src/app/lib: its line stays.
      expect(fs.readFileSync(exclude, "utf8")).toContain("/src/app/lib/")
      expect(await answer(h, first.op, two.id)).toMatchObject({ ok: true, op: { state: "done" } })
      expect(fs.existsSync(two.directory)).toBe(false)
      const left = fs.readFileSync(exclude, "utf8")
      expect(left).not.toContain("/src/app/lib/")
      expect(left).not.toContain(Symlinks.EXCLUDE_HEADER)
      expect(left).toContain("node_modules/")
    },
    SLOW,
  )

  test(
    "shared-folder links go first without following them; the default unlink and an injected one",
    async () => {
      const target = (h: Harness) => {
        const folder = path.join(h.repo.home, "weights")
        write(folder, { "model.bin": "weights\n" })
        return folder
      }
      const link = (folder: string, directory: string) =>
        fs.symlinkSync(folder, path.join(directory, "weights"), WINDOWS ? "junction" : "dir")

      const plain = await setup({ shared: [{ name: "weights", target: "weights", protect: "none" }] })
      const folder = target(plain)
      const record = await makeArea(plain, "linked")
      link(folder, record.directory)
      write(record.directory, { "node_modules/inner/index.js": "i\n" })
      // A link inside an ignored entry (bun's workspace links) is not followed either.
      fs.symlinkSync(folder, path.join(record.directory, "node_modules", "workspace"), WINDOWS ? "junction" : "dir")
      const scanned = await Remove.scan({ team: plain.team, area: record })
      expect(scanned).toMatchObject({ kind: "ready", shared: ["weights"], links: ["node_modules/workspace"] })
      expect(scanned.kind === "ready" && scanned.remove.map((item) => item.path)).toEqual(["node_modules/"])
      const op = await removal(plain, [Remove.spec(record.id)])
      expect(await answer(plain, op, record.id)).toMatchObject({ ok: true, op: { state: "done" } })
      expect(fs.existsSync(record.directory)).toBe(false)
      expect(fs.readFileSync(path.join(folder, "model.bin"), "utf8")).toBe("weights\n")

      const unlinked: Array<{ readonly directory: string; readonly name: string }> = []
      const injected = await setup({
        shared: [{ name: "weights", target: "weights", protect: "none" }],
        options: {
          unlink: async (item) => {
            unlinked.push(item)
            fs.rmSync(path.join(item.directory, item.name))
          },
        },
      })
      const other = target(injected)
      const second = await makeArea(injected, "spied")
      link(other, second.directory)
      const asked = await removal(injected, [Remove.spec(second.id)])
      expect(await answer(injected, asked, second.id)).toMatchObject({ ok: true, op: { state: "done" } })
      expect(unlinked).toEqual([{ directory: second.directory, name: "weights" }])
      expect(fs.readFileSync(path.join(other, "model.bin"), "utf8")).toBe("weights\n")
    },
    SLOW,
  )

  test.skipIf(!WINDOWS)(
    "a process with its current folder inside: the failure is told, a later run clears only the confirmed list",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "busy")
      write(record.directory, { "node_modules/held/index.js": "h\n" })
      const holder = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"], {
        cwd: path.join(record.directory, "src", "lib"),
        stdout: "ignore",
        stderr: "ignore",
      })
      cleanups.push(async () => {
        holder.kill()
        await holder.exited
      })
      await Bun.sleep(300)
      const op = await removal(h, [Remove.spec(record.id)])
      const failed = await answer(h, op, record.id)
      if (!failed.ok) throw new Error(failed.message)
      expect(failed.op.state).toBe("failed")
      expect(failed.op.steps[0]?.note).toBe(Remove.IN_USE)
      // Git deleted what it could and dropped the registration; the folders the process holds are left.
      expect(fs.existsSync(path.join(record.directory, "src", "lib"))).toBe(true)
      expect(listed(h, record.directory)).toBe(false)
      expect((await read(h, record.id)).state).toBe("active")
      holder.kill()
      await holder.exited

      // Something that was not on the confirmed list: nothing is cleared without asking.
      write(record.directory, { "src/extra.txt": "new\n" })
      const unconfirmed = await removal(h, [Remove.spec(record.id, "auto")])
      expect(unconfirmed.steps[0]?.state).toBe("skipped")
      expect(fs.readFileSync(path.join(record.directory, "src", "extra.txt"), "utf8")).toBe("new\n")

      fs.rmSync(path.join(record.directory, "src", "extra.txt"))
      const refreshes = h.backend.refreshes
      const resumed = await removal(h, [Remove.spec(record.id, "auto")])
      expect(resumed.state).toBe("done")
      expect(fs.existsSync(record.directory)).toBe(false)
      expect(h.backend.refreshes).toBe(refreshes + 1)
      expect((await read(h, record.id)).state).toBe("retired")
    },
    SLOW,
  )

  test(
    "a folder that is working is not removed (TI-3 (c)): the safe point or a session running inside",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "talk")
      const op = await removal(h, [Remove.spec(record.id)])
      h.safe.value = { ok: false, why: "pty", sessionIDs: [] }
      const refused = await answer(h, op, record.id)
      if (!refused.ok) throw new Error(refused.message)
      expect(refused.op.state).toBe("failed")
      expect(fs.existsSync(record.directory)).toBe(true)
      expect(listed(h, record.directory)).toBe(true)

      h.safe.value = { ok: true }
      const running = SessionID.make("ses_running000000000000000001")
      h.backend.service.routes.set("GET /api/session/active", () => Response.json({ data: { [running]: {} } }))
      h.backend.service.routes.set(`GET /api/session/${running}`, () =>
        Response.json({
          data: {
            id: running,
            projectID: "prj_test",
            location: { directory: path.join(record.directory, "src") },
            time: { created: 1, updated: 1 },
          },
        }),
      )
      const again = await removal(h, [Remove.spec(record.id)])
      const second = await answer(h, again, record.id)
      if (!second.ok) throw new Error(second.message)
      expect(second.op.state).toBe("failed")
      expect(fs.existsSync(record.directory)).toBe(true)
      expect(head(record.directory)).toBe(h.repo.head)
    },
    SLOW,
  )
})

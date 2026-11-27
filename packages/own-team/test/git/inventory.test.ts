import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Activity } from "../../src/git/activity.js"
import { Classify } from "../../src/git/classify.js"
import { Home } from "../../src/git/home.js"
import { Inventory } from "../../src/git/inventory.js"
import { Measure } from "../../src/git/measure.js"
import { F4_NOW, f4 } from "../fixtures/f4-layout.js"
import { commit, git, init, temp, write } from "../fixtures/repo.js"

const SLOW = 180_000
const DAY = 24 * 60 * 60 * 1000

describe("Activity (06 §3.4)", () => {
  const quiet = { ahead: 0, changes: null, sessions: [] }

  test("unique commits, uncommitted work, or a root session within 14 days", () => {
    expect(Activity.isActive(quiet, F4_NOW)).toBe(false)
    expect(Activity.isActive({ ...quiet, ahead: 1 }, F4_NOW)).toBe(true)
    expect(Activity.isActive({ ...quiet, ahead: null }, F4_NOW)).toBe(false)
    const changes = { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, ignored: 7, uncommitted: 0 }
    expect(Activity.isActive({ ...quiet, changes }, F4_NOW)).toBe(false)
    expect(Activity.isActive({ ...quiet, changes: { ...changes, untracked: 1, uncommitted: 1 } }, F4_NOW)).toBe(true)
    const at = (age: number) => ({ ...quiet, sessions: [{ id: "s", directory: "D:/x", updated: F4_NOW - age }] })
    expect(Activity.isActive(at(14 * DAY), F4_NOW)).toBe(true)
    expect(Activity.isActive(at(14 * DAY + 1), F4_NOW)).toBe(false)
    expect(Activity.signals({ ahead: 3, changes: { ...changes, uncommitted: 4 }, sessions: [] }, F4_NOW)).toEqual({
      unique: 3,
      uncommitted: 4,
      recent: false,
    })
  })
})

describe("F4: this repository's layout (06 §0.5, TG10 observation)", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const repo = f4(box.root)
  const sessions = Object.values(repo.sessions)

  async function inventory(target = "main") {
    const result = await Inventory.collect(repo.commonDir, target, sessions)
    if (!result.ok) throw new Error(result.message)
    return result
  }

  function entry(result: Inventory.Result, directory: string) {
    const found = result.worktrees.find((item) => Classify.same(item.path, directory))
    if (!found) throw new Error(`no worktree ${directory}`)
    return found
  }

  test(
    "locate from a subfolder of a nested worktree",
    async () => {
      const located = await Inventory.locate(path.join(repo.nested["cl-perf"], "packages", "own-web"))
      if (!located.ok) throw new Error(located.message)
      expect(Classify.same(located.commonDir, repo.commonDir)).toBe(true)
      expect(Classify.same(located.toplevel, repo.nested["cl-perf"])).toBe(true)
    },
    SLOW,
  )

  test(
    "worktrees: HEAD, branch or detached, lock, prunable, identity, counts against main",
    async () => {
      const result = await inventory()
      expect(result.errors).toEqual([])
      expect(result.worktrees).toHaveLength(14)
      expect(Classify.same(result.worktrees[0].path, repo.primary)).toBe(true)
      expect(result.worktrees[0]).toMatchObject({ primary: true, branch: "computer-use", detached: false })
      expect(result.target).toEqual({ name: "main", oid: repo.base })

      const home = entry(result, repo.home)
      expect(home).toMatchObject({ branch: "main", ahead: 0, behind: 0, locked: null, operations: [] })
      // node_modules/ and .worktrees/ are ignored entries, not uncommitted work.
      expect(home.changes).toMatchObject({ ignored: 2, uncommitted: 0 })
      expect(home.identity).toMatchObject({ ok: true })
      if (home.identity?.ok)
        expect(Classify.same(home.identity.gitDir, path.join(repo.commonDir, "worktrees", "own-open-code"))).toBe(true)

      expect(entry(result, repo.nested["cl-cu"])).toMatchObject({
        branch: "own-computer-use",
        ahead: 5,
        behind: 0,
        changes: { staged: 2, unstaged: 3, untracked: 4, unmerged: 0, uncommitted: 9 },
      })
      expect(entry(result, repo.nested["cl-perf"])).toMatchObject({ ahead: 10, changes: { uncommitted: 0 } })
      expect(entry(result, repo.nested["cl-siwc"])).toMatchObject({ ahead: 6, changes: { uncommitted: 0 } })
      expect(entry(result, repo.nested["computer-use"])).toMatchObject({ ahead: 0, changes: { uncommitted: 0 } })

      expect(entry(result, repo.codex)).toMatchObject({ branch: null, detached: true, ahead: 0, detachedOnly: [] })
      const detached = entry(result, repo.detached)
      expect(detached).toMatchObject({ detached: true, ahead: 2, operations: ["merge"] })
      expect(detached.detachedOnly).toHaveLength(2)
      expect(entry(result, repo.locked).locked).toBe("kept by the user")
      const gone = entry(result, repo.gone)
      expect(gone.prunable).not.toBeNull()
      expect(gone).toMatchObject({ real: null, changes: null, identity: { ok: false, why: "missing" } })
    },
    SLOW,
  )

  test(
    "branches: worktree path, upstream track, ahead/behind; stash entries with their folder",
    async () => {
      const result = await inventory()
      const named = (name: string) => result.branches.find((item) => item.name === name)
      expect(named("own-computer-use")).toMatchObject({ ahead: 5, behind: 0, upstream: null })
      expect(Classify.same(named("own-computer-use")?.worktree ?? "", repo.nested["cl-cu"])).toBe(true)
      expect(named("siwc-login")?.upstream).toEqual({ name: "main", ahead: 6, behind: 0, gone: false })
      expect(named("main")).toMatchObject({ ahead: 0, behind: 0 })
      expect(result.branches).toHaveLength(12)

      expect(result.stash.map((item) => [item.ref, item.subject.split(":")[0]])).toEqual([
        ["stash@{0}", "WIP on siwc-login"],
        ["stash@{1}", "On main"],
      ])
      expect(Classify.same(result.stash[0].worktree ?? "", repo.nested["cl-siwc"])).toBe(true)
      expect(Classify.same(result.stash[1].worktree ?? "", repo.home)).toBe(true)
      expect(result.stash[1].parents[0]).toBe(repo.base)
    },
    SLOW,
  )

  test(
    "sessions by the longest prefix; gone folders are orphans; another clone is outside",
    async () => {
      const result = await inventory()
      const ids = (directory: string) => entry(result, directory).sessions.map((item) => item.id)
      expect(ids(repo.home)).toEqual(["ses_home"])
      expect(ids(repo.nested["cl-perf"])).toEqual(["ses_perf"])
      expect(ids(repo.nested["cl-cu"])).toEqual(["ses_cu"])
      expect(ids(repo.primary)).toEqual(["ses_primary"])
      expect(ids(repo.claude[0])).toEqual(["ses_claude"])
      expect(result.orphans.map((item) => item.id)).toEqual(["ses_orphan"])
      expect(result.outside.map((item) => item.id)).toEqual(["ses_other"])
      expect(await Classify.clone(repo.commonDir, repo.sessions.other.directory)).toBe("other")
      expect(await Classify.clone(repo.commonDir, repo.sessions.perf.directory)).toBe("same")
    },
    SLOW,
  )

  test(
    "06 §0.5: home, outside the team, area candidates and their activity",
    async () => {
      const result = await inventory()
      const home = Home.pick({ worktrees: result.worktrees, target: "main" })
      expect(home?.chosenBy).toBe("target-checkout")
      expect(home?.linked).toBe(true)
      expect(Classify.same(home?.directory ?? "", repo.home)).toBe(true)

      const classes = Classify.classify(result.worktrees, { home: home?.directory ?? null })
      const of = (directory: string) => classes.find((item) => Classify.same(item.path, directory))
      expect(of(repo.primary)?.class).toBe("primary")
      expect(repo.claude.map((directory) => of(directory))).toEqual(
        repo.claude.map((directory) =>
          expect.objectContaining({ class: "other-tool", nested: true, outer: entry(result, repo.primary).path }),
        ),
      )
      expect(of(repo.codex)?.class).toBe("other-tool")
      expect(of(repo.home)).toMatchObject({ class: "home", nested: false })
      for (const directory of Object.values(repo.nested))
        expect(of(directory)).toMatchObject({ class: "candidate", nested: true, outer: entry(result, repo.home).path })
      expect(of(repo.detached)?.class).toBe("candidate")
      expect(of(repo.hash)?.class).toBe("hash-path")
      expect(of(repo.locked)?.class).toBe("other-tool")
      expect(of(repo.gone)?.class).toBe("prunable")

      const active = Object.fromEntries(
        Object.entries(repo.nested).map(([name, directory]) => [
          name,
          Activity.isActive(entry(result, directory), F4_NOW),
        ]),
      )
      expect(active).toEqual({
        "cl-cu": true,
        "cl-perf": true,
        "cl-siwc": true,
        "computer-use": false,
        "local-model": false,
      })
      expect(Activity.signals(entry(result, repo.nested["cl-cu"]), F4_NOW)).toEqual({
        unique: 5,
        uncommitted: 9,
        recent: true,
      })
      expect(Activity.signals(entry(result, repo.nested["cl-siwc"]), F4_NOW)).toEqual({
        unique: 6,
        uncommitted: 0,
        recent: false,
      })
      expect(Activity.isActive(entry(result, repo.detached), F4_NOW)).toBe(true)
    },
    SLOW,
  )

  test(
    "home picking from a conversation, and where new areas go",
    async () => {
      const result = await inventory()
      const pick = (session?: string) => Home.pick({ worktrees: result.worktrees, target: "main", session })
      expect(pick(repo.sessions.home.directory)?.chosenBy).toBe("session")
      expect(pick(repo.sessions.claude.directory)?.chosenBy).toBe("target-checkout")
      const primary = pick(repo.sessions.primary.directory)
      expect(primary).toMatchObject({ chosenBy: "session", linked: false })
      const all = result.worktrees.map((item) => item.path)
      const drive = path.parse(box.root).root.slice(0, 1)
      expect(Home.worktreeRoot(primary?.directory ?? "", repo.commonDir, all, "inside")).toEqual({
        ok: true,
        directory: `${drive}:/own-team/own-open-code`,
      })
      const beside = Home.worktreeRoot(entry(result, repo.home).path, repo.commonDir, all, "beside")
      if (!beside.ok) throw new Error(beside.why)
      expect(Classify.same(beside.directory, path.join(box.root, "own-open-code-team"))).toBe(true)
      // 프로젝트 안 (2026-10-27): the home's `.worktrees`, next to the user's nested worktrees already there.
      const inside = Home.worktreeRoot(entry(result, repo.home).path, repo.commonDir, all, "inside")
      if (!inside.ok) throw new Error(inside.why)
      expect(Classify.same(inside.directory, path.join(repo.home, ".worktrees"))).toBe(true)
      for (const layout of ["inside", "beside"] as const)
        expect(Home.worktreeRoot(entry(result, repo.nested["cl-cu"]).path, repo.commonDir, all, layout)).toMatchObject({
          ok: false,
          why: "nested",
        })
      // A target checked out only in the `#` main worktree: the most recent usable root session decides.
      const recent = Home.pick({ worktrees: result.worktrees, target: "computer-use" })
      expect(recent?.chosenBy).toBe("recent")
      expect(Classify.same(recent?.directory ?? "", repo.nested["cl-cu"])).toBe(true)
    },
    SLOW,
  )

  test(
    "weight of the home: no heavy folders, ignored folders sized, nested worktrees not weighed",
    async () => {
      const result = await Measure.measure(repo.home, repo.base)
      if (!result.ok) throw new Error(result.message)
      expect(Measure.ruleBasedHeavy(result.rows)).toEqual([])
      expect(result.ignored).toEqual([
        { dir: "node_modules", files: 2, bytes: 6_000, complete: true, repos: 0 },
        { dir: ".worktrees", files: 0, bytes: 0, complete: true, repos: 5 },
      ])
    },
    SLOW,
  )

  test(
    "reads take no optional locks: a status that would refresh the index leaves it as it was",
    async () => {
      const directory = repo.nested["computer-use"]
      const index = path.join(repo.commonDir, "worktrees", "computer-use", "index")
      const later = new Date(Date.now() + 60_000)
      fs.utimesSync(path.join(directory, "README.md"), later, later)
      const before = fs.readFileSync(index)
      await inventory()
      expect(fs.readFileSync(index).equals(before)).toBe(true)
      // Plain `git status` takes the optional lock and writes the refreshed stat data.
      git(directory, ["status", "--porcelain"])
      expect(fs.readFileSync(index).equals(before)).toBe(false)
    },
    SLOW,
  )

  test(
    "no target branch: no counts; unknown common dir: an error",
    async () => {
      const result = await inventory("no-such-branch")
      expect(result.target).toEqual({ name: "no-such-branch", oid: null })
      expect(result.worktrees.every((item) => item.ahead === null && item.behind === null)).toBe(true)
      expect(result.branches.every((item) => item.ahead === null)).toBe(true)
      expect(await Inventory.collect(path.join(box.root, "missing", ".git"), "main", [])).toMatchObject({ ok: false })
    },
    SLOW,
  )

  test(
    "a nested worktree without its .git file is reported, not resolved to the home (06 §4.3)",
    async () => {
      fs.rmSync(path.join(repo.nested["local-model"], ".git"))
      const result = await inventory()
      const broken = entry(result, repo.nested["local-model"])
      // git now calls it prunable, but the folder is there: its identity fails instead of finding the home.
      expect(broken.prunable).not.toBeNull()
      expect(broken).toMatchObject({ identity: { ok: false, why: "identity" }, changes: null })
      expect(result.errors.map((item) => item.directory && Classify.same(item.directory, broken.path))).toEqual([true])
      expect(entry(result, repo.home).changes).toMatchObject({ uncommitted: 0 })
    },
    SLOW,
  )
})

describe("stopped operations and branches in use (06 §3.2, §7.2 step 8)", () => {
  const box = temp("own-team-inuse-")
  afterAll(() => box.dispose())

  /** A home on `main` with one commit; `add` makes a linked worktree on a new branch next to it. */
  function repository(name: string) {
    const home = init(path.join(box.root, name, "home"))
    write(home, { "a.txt": "base\n" })
    commit(home, "base")
    const add = (folder: string, branch: string) => {
      const directory = path.join(box.root, name, folder)
      git(home, ["worktree", "add", "-q", "-b", branch, directory, "main"])
      return directory
    }
    return { home, commonDir: path.join(home, ".git"), add }
  }

  test(
    "the per-worktree reader sees rebase-merge, rebase-apply, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, BISECT_START",
    () => {
      const repo = repository("ops")
      const gitDir = git(repo.add("wt", "topic"), ["rev-parse", "--absolute-git-dir"]).trim()
      expect(Inventory.operations(gitDir)).toEqual([])
      const markers = [
        ["rebase-merge", "rebase", "dir"],
        ["rebase-apply", "rebase", "dir"],
        ["MERGE_HEAD", "merge", "file"],
        ["CHERRY_PICK_HEAD", "cherry-pick", "file"],
        ["REVERT_HEAD", "revert", "file"],
        ["BISECT_START", "bisect", "file"],
      ] as const
      for (const [name, kind, shape] of markers) {
        const marker = path.join(gitDir, name)
        if (shape === "dir") fs.mkdirSync(marker)
        if (shape === "file") fs.writeFileSync(marker, "main\n")
        expect(Inventory.operations(gitDir)).toEqual([kind])
        // Only that worktree: the main worktree's git dir is unaffected.
        expect(Inventory.operations(repo.commonDir)).toEqual([])
        fs.rmSync(marker, { recursive: true })
      }
      fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), "x\n")
      fs.mkdirSync(path.join(gitDir, "rebase-merge"))
      expect(Inventory.operations(gitDir).toSorted()).toEqual(["merge", "rebase"])
    },
    SLOW,
  )

  test(
    "branchInUse: a checkout, a stopped rebase and a bisect hold a branch, inside the team or outside it, as for git",
    async () => {
      const repo = repository("use")
      const feature = repo.add("wt-feature", "feature")
      const bisecting = repo.add("wt-bis", "bis")
      const outside = repo.add(path.join("home", ".claude", "worktrees", "x"), "outside")
      const gone = repo.add("wt-gone", "gone")
      const rebasing = repo.add("wt-topic", "topic")
      write(rebasing, { "a.txt": "topic\n" })
      commit(rebasing, "topic change")
      write(repo.home, { "a.txt": "main\n" })
      commit(repo.home, "main change")
      expect(() => git(rebasing, ["rebase", "main"])).toThrow()
      git(bisecting, ["bisect", "start"])
      fs.rmSync(gone, { recursive: true, force: true })
      // `git am` stopped half way does not hold its branch.
      const am = repo.add("wt-am", "am-branch")
      const amDir = git(am, ["rev-parse", "--absolute-git-dir"]).trim()
      fs.mkdirSync(path.join(amDir, "rebase-apply"))
      fs.writeFileSync(path.join(amDir, "rebase-apply", "applying"), "")
      fs.writeFileSync(path.join(amDir, "rebase-apply", "head-name"), "refs/heads/other\n")

      const users = async (target: string) => {
        const found = await Inventory.branchInUse(repo.commonDir, target)
        if (!found.ok) throw new Error(found.message)
        return found.users
      }
      const at = (folder: string) => path.join(repo.commonDir, "worktrees", folder)

      const main = await users("main")
      expect(main).toMatchObject([{ primary: true, how: "checkout", gitDir: repo.commonDir }])
      expect(Classify.same(main[0]!.path, repo.home)).toBe(true)
      const checkout = await users("feature")
      expect(checkout).toMatchObject([{ primary: false, how: "checkout" }])
      expect(Classify.same(checkout[0]!.path, feature)).toBe(true)
      expect(Classify.same(checkout[0]!.gitDir!, at("wt-feature"))).toBe(true)
      const rebase = await users("topic")
      expect(rebase).toMatchObject([{ how: "rebase" }])
      expect(Classify.same(rebase[0]!.path, rebasing)).toBe(true)
      expect((await users("bis")).map((item) => item.how)).toEqual(["checkout", "bisect"])
      // Another tool's worktree is reported like any other; the caller sees it is outside the team (TI-6).
      const foreign = await users("outside")
      expect(foreign).toMatchObject([{ how: "checkout" }])
      expect(Classify.otherTool({ path: foreign[0]!.path, real: null, locked: null })).toBe(true)
      // A worktree whose folder is gone holds its branch until `worktree prune`.
      const pruned = await users("gone")
      expect(pruned).toMatchObject([{ how: "checkout" }])
      expect(Classify.same(pruned[0]!.path, gone)).toBe(true)
      expect(await users("other")).toEqual([])
      expect(await users("nobody")).toEqual([])
      // git's own rule agrees: it refuses to move each held branch.
      for (const held of ["feature", "topic", "bis", "outside", "gone"])
        expect(() => git(repo.home, ["branch", "-f", held, "main"])).toThrow()
      git(repo.home, ["branch", "-q", "free", "main"])
      expect(await users("free")).toEqual([])
    },
    SLOW,
  )

  test(
    "an unknown common dir is an error",
    async () => {
      expect(await Inventory.branchInUse(path.join(box.root, "missing", ".git"), "main")).toMatchObject({ ok: false })
    },
    SLOW,
  )
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Cone } from "../../src/git/cone.js"
import { Identity } from "../../src/git/identity.js"
import { Porcelain } from "../../src/git/porcelain.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { F2_HEAVY, F2_IN_CONE, F2_LFS, f2, lfsAvailable, type F2 } from "../fixtures/lfs-repo.js"
import { F1_LINKS, commit, f1, files, git, temp, write } from "../fixtures/repo.js"
import { F3_CONE, F3_HEAVY, synthetic } from "../fixtures/synthetic.js"

/** Git-heavy tests: Windows process starts and LFS transfers are slow on a busy machine. */
const SLOW = 180_000
const ALWAYS = { askDownloadBytes: Number.POSITIVE_INFINITY }

const box = temp()
afterAll(() => box.dispose())

function plan(home: string, base: string, name: string, extra: Partial<Worktree.Plan> = {}): Worktree.Plan {
  return {
    home,
    directory: path.join(box.root, "team", name),
    branch: name.replace(/^-+/, ""),
    base,
    areaID: `ar_${name.replace(/^-+/, "")}`,
    shape: "plain",
    cone: [],
    heavy: [],
    ...extra,
  }
}

function lockOf(home: string, directory: string) {
  return Porcelain.worktrees(git(home, ["worktree", "list", "--porcelain", "-z"])).find((item) =>
    Identity.same(item.path, directory),
  )?.locked
}

describe("Porcelain (resume detection)", () => {
  test("only staged deletions = unpopulated; anything else is not", () => {
    const deleted = (file: string) => `1 D. N... 100644 000000 000000 ${"a".repeat(40)} ${"0".repeat(40)} ${file}`
    const z = (...fields: string[]) => fields.map((field) => `${field}\0`).join("")
    expect(Porcelain.onlyStagedDeletions(Porcelain.status(z(deleted("a b.txt"), deleted("-x/y"))))).toBe(true)
    expect(Porcelain.onlyStagedDeletions(Porcelain.status(z(deleted("a"), "? stray.txt")))).toBe(false)
    expect(Porcelain.onlyStagedDeletions(Porcelain.status(""))).toBe(false)
    const renamed = Porcelain.status(
      z(
        `2 R. N... 100644 100644 100644 ${"a".repeat(40)} ${"a".repeat(40)} R100 new name.ts`,
        "2 old.ts",
        "! ignored/",
      ),
    )
    expect(renamed.entries).toEqual([
      { kind: "renamed", xy: "R.", path: "new name.ts", from: "2 old.ts" },
      { kind: "ignored", path: "ignored/" },
    ])
  })
})

describe("F1: plain worktree (code repository, mode-120000 links, core.symlinks=false)", () => {
  const repo = f1(path.join(box.root, "f1"))

  test(
    "steps 1-6: locked, populated, clean, identity recorded",
    async () => {
      const item = plan(repo.home, repo.head, "plain-ui")
      const created = await Worktree.create(item, ALWAYS)
      if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
      expect(created.resumed).toBe(false)
      expect(created.fetched).toEqual({ count: 0, bytes: 0 })
      expect(Identity.same(created.gitDir, path.join(repo.home, ".git", "worktrees", "plain-ui"))).toBe(true)
      expect(lockOf(repo.home, item.directory)).toBe("own.team area:ar_plain-ui")
      expect(git(item.directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
      expect(git(item.directory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("plain-ui")
      expect(files(item.directory)).toEqual(files(repo.home))
      for (const [link, target] of Object.entries(F1_LINKS))
        expect(fs.readFileSync(path.join(item.directory, ...link.split("/")), "utf8")).toBe(target)
      expect(() => git(item.directory, ["config", "--worktree", "--get", "core.sparseCheckout"])).toThrow()
      // Observing again changes nothing and reports the finished worktree.
      const again = await Worktree.create({ ...item, gitDir: created.gitDir }, ALWAYS)
      expect(again).toMatchObject({ ok: true, state: "ready", resumed: true, gitDir: created.gitDir })
      // A recorded identity that is not this folder's stops before any step.
      const crossed = await Worktree.create({ ...item, gitDir: path.join(repo.home, ".git") }, ALWAYS)
      expect(crossed).toMatchObject({ ok: false, step: 1, error: "broken", broken: "identity" })
    },
    SLOW,
  )

  test(
    "locked from the first command; an empty index resumes with steps 2-4",
    async () => {
      const item = plan(repo.home, repo.head, "half-made")
      const added = await Worktree.add(item)
      if (!added.ok) throw new Error(added.message)
      expect(lockOf(repo.home, item.directory)).toBe("own.team area:ar_half-made")
      // Right after --no-checkout: every file of HEAD is a staged deletion.
      expect(
        Porcelain.onlyStagedDeletions(Porcelain.status(git(item.directory, ["status", "--porcelain=v2", "-z"]))),
      ).toBe(true)
      expect(await Worktree.observe(item)).toEqual({ ok: true, state: "unpopulated", gitDir: added.gitDir })
      const resumed = await Worktree.create(item, ALWAYS)
      expect(resumed).toMatchObject({ ok: true, state: "ready", resumed: true })
      expect(git(item.directory, ["status", "--porcelain"])).toBe("")
    },
    SLOW,
  )

  test(
    "a lost lock is put back; a lock with another reason is not ours",
    async () => {
      const item = plan(repo.home, repo.head, "relock")
      expect((await Worktree.create(item, ALWAYS)).ok).toBe(true)
      git(repo.home, ["worktree", "unlock", item.directory])
      expect(await Worktree.create(item, ALWAYS)).toMatchObject({ ok: true, state: "ready" })
      expect(lockOf(repo.home, item.directory)).toBe("own.team area:ar_relock")
      git(repo.home, ["worktree", "unlock", item.directory])
      git(repo.home, ["worktree", "lock", "--reason", "someone else", item.directory])
      expect(await Worktree.create(item, ALWAYS)).toMatchObject({ ok: false, error: "path_forbidden" })
    },
    SLOW,
  )

  test(
    "a branch left at the base by a failed add is reused; one at another commit is refused",
    async () => {
      const item = plan(repo.home, repo.head, "left-over")
      await Refs.create(repo.home, { ref: "refs/heads/left-over", oid: repo.head })
      expect(await Worktree.create(item, ALWAYS)).toMatchObject({ ok: true, state: "ready" })

      write(repo.home, { "src/app/later.ts": "later\n" })
      const later = commit(repo.home, "later")
      await Refs.create(repo.home, { ref: "refs/heads/moved-on", oid: later })
      const moved = await Worktree.create(plan(repo.home, repo.head, "moved-on"), ALWAYS)
      expect(moved).toMatchObject({ ok: false, step: 1, error: "branch_exists" })
      git(repo.home, ["reset", "-q", "--hard", repo.head])
    },
    SLOW,
  )

  test("paths own does not create in", async () => {
    const occupied = plan(repo.home, repo.head, "occupied")
    write(occupied.directory, { "mine.txt": "user data\n" })
    expect(await Worktree.create(occupied, ALWAYS)).toMatchObject({ ok: false, error: "path_forbidden" })
    expect(fs.readFileSync(path.join(occupied.directory, "mine.txt"), "utf8")).toBe("user data\n")

    const hash = { ...plan(repo.home, repo.head, "hash"), directory: path.join(box.root, "a#b", "hash") }
    expect(await Worktree.create(hash, ALWAYS)).toMatchObject({ ok: false, error: "path_forbidden" })
    expect(fs.existsSync(hash.directory)).toBe(false)
    if (process.platform === "win32") {
      const msys = { ...plan(repo.home, repo.head, "msys"), directory: "/c/Users/x/msys" }
      expect(await Worktree.create(msys, ALWAYS)).toMatchObject({ ok: false, error: "path_forbidden" })
    }
    const badBase = plan(repo.home, "", "bad-base")
    expect(await Worktree.create(badBase, ALWAYS)).toMatchObject({ ok: false, error: "path_forbidden" })
  })

  test(
    "undo of an untouched worktree: unlock, read-tree -mu HEAD, remove without --force; the branch stays",
    async () => {
      const ready = plan(repo.home, repo.head, "undo-ready")
      const created = await Worktree.create(ready, ALWAYS)
      if (!created.ok) throw new Error(created.message)
      expect(await Worktree.undo({ home: repo.home, directory: ready.directory, gitDir: created.gitDir })).toEqual({
        ok: true,
      })
      expect(fs.existsSync(ready.directory)).toBe(false)
      expect(lockOf(repo.home, ready.directory)).toBeUndefined()
      expect(await Refs.read(repo.home, "refs/heads/undo-ready")).toBe(repo.head)

      // Half made (step 1 only): the empty index would block a plain remove; read-tree makes it clean first.
      const half = plan(repo.home, repo.head, "undo-half")
      const added = await Worktree.add(half)
      if (!added.ok) throw new Error(added.message)
      expect(await Worktree.undo({ home: repo.home, directory: half.directory, gitDir: added.gitDir })).toEqual({
        ok: true,
      })
      expect(fs.existsSync(half.directory)).toBe(false)
    },
    SLOW,
  )

  test.skipIf(process.platform !== "win32")(
    "undo finishes a removal a program working in the folder held up (Windows): only empty folders were left",
    async () => {
      const item = plan(repo.home, repo.head, "undo-held")
      const created = await Worktree.create(item, ALWAYS)
      if (!created.ok) throw new Error(created.message)
      // A native program whose working folder is the worktree: git deletes the files and the registration, then
      // fails on the folder. It lets go once git got that far.
      const holder = Bun.spawn(["git", "hash-object", "--stdin"], {
        cwd: item.directory,
        stdin: "pipe",
        stdout: "ignore",
      })
      const undone = Worktree.undo({ home: repo.home, directory: item.directory, gitDir: created.gitDir })
      while (fs.existsSync(path.join(item.directory, ".git"))) await Bun.sleep(50)
      await Bun.sleep(1_000)
      expect(fs.existsSync(item.directory)).toBe(true)
      holder.stdin.end()
      await holder.exited
      expect(await undone).toEqual({ ok: true })
      expect(fs.existsSync(item.directory)).toBe(false)
      expect(lockOf(repo.home, item.directory)).toBeUndefined()
      expect(await Refs.read(repo.home, "refs/heads/undo-held")).toBe(repo.head)
    },
    SLOW,
  )

  test(
    "undo never forces: a touched worktree stays, locked as before",
    async () => {
      const item = plan(repo.home, repo.head, "undo-touched")
      const created = await Worktree.create(item, ALWAYS)
      if (!created.ok) throw new Error(created.message)
      write(item.directory, { "src/app/main.ts": "export const main = 2\n", "notes.txt": "new\n" })
      const undone = await Worktree.undo({ home: repo.home, directory: item.directory, gitDir: created.gitDir })
      expect(undone).toMatchObject({ ok: false, error: "git" })
      expect(fs.readFileSync(path.join(item.directory, "src", "app", "main.ts"), "utf8")).toBe(
        "export const main = 2\n",
      )
      expect(fs.existsSync(path.join(item.directory, "notes.txt"))).toBe(true)
      expect(lockOf(repo.home, item.directory)).toBe("own.team area:ar_undo-touched")

      // Staged work (a new file and a change) is never reset away before git refuses the removal.
      const staged = plan(repo.home, repo.head, "undo-staged")
      const made = await Worktree.create(staged, ALWAYS)
      if (!made.ok) throw new Error(made.message)
      write(staged.directory, { "src/app/main.ts": "export const main = 3\n", "added.txt": "staged\n" })
      git(staged.directory, ["add", "-A"])
      expect(await Worktree.undo({ home: repo.home, directory: staged.directory, gitDir: made.gitDir })).toMatchObject({
        ok: false,
        error: "git",
      })
      expect(fs.readFileSync(path.join(staged.directory, "added.txt"), "utf8")).toBe("staged\n")
      expect(fs.readFileSync(path.join(staged.directory, "src", "app", "main.ts"), "utf8")).toBe(
        "export const main = 3\n",
      )
      expect(git(staged.directory, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).toSorted()).toEqual(
        ["added.txt", "src/app/main.ts"],
      )
    },
    SLOW,
  )
})

describe.skipIf(!lfsAvailable)("F2: code-only worktree with LFS (TG3)", () => {
  // Bun runs a skipped describe's body while it collects tests, so the fixture (it needs git-lfs) is made in beforeAll.
  let repo: F2
  beforeAll(() => {
    repo = f2(path.join(box.root, "f2"))
  }, SLOW)
  const code = (name: string) => plan(repo.home, repo.head, name, { shape: "code", cone: CONE, heavy: [...F2_HEAVY] })
  const CONE = ["-dash", "Assets/Scripts", "docs", "src"]
  const inConeBytes = F2_IN_CONE.reduce((total, file) => total + F2_LFS[file], 0)

  test(
    "the complement cone of the heavy folders",
    async () => {
      const cone = await Cone.compute(repo.home, repo.head, [...F2_HEAVY])
      expect(cone.ok && cone.dirs).toEqual(CONE)
    },
    SLOW,
  )

  test(
    "offline: step 3 fails before anything is checked out, and nothing is stored",
    async () => {
      const before = repo.objects()
      repo.offline()
      const failed = await Worktree.create(code("-offline-area"), ALWAYS)
      repo.online()
      expect(failed).toMatchObject({ ok: false, step: 3, error: "git" })
      expect(repo.objects()).toBe(before)
      expect(lockOf(repo.home, code("-offline-area").directory)).toBe("own.team area:ar_offline-area")
    },
    SLOW,
  )

  test(
    "over the threshold: stop for a confirmation without downloading; confirmed: only the cone's missing objects",
    async () => {
      const item = code("inventory-ui")
      const before = repo.objects()
      const waiting = await Worktree.create(item, { askDownloadBytes: 1 })
      if (!waiting.ok || waiting.state !== "confirm") throw new Error(JSON.stringify(waiting))
      expect(repo.objects()).toBe(before)
      expect(lockOf(repo.home, item.directory)).toBe("own.team area:ar_inventory-ui")
      expect(await Worktree.observe(item)).toMatchObject({ state: "unpopulated" })

      const confirmed = await Worktree.create(item, { askDownloadBytes: 1, confirmed: true })
      if (!confirmed.ok || confirmed.state !== "ready") throw new Error(JSON.stringify(confirmed))
      // Exactly the cone's objects that were missing: the heavy folders' objects stay on the remote.
      expect(waiting.missing.count).toBe(F2_IN_CONE.length)
      expect(waiting.missing.bytes).toBe(inConeBytes)
      expect(repo.objects() - before).toBe(F2_IN_CONE.length)
    },
    SLOW,
  )

  test(
    "the code-only worktree: heavy folders collapsed, sparse index, LFS files in the cone smudged",
    async () => {
      const item = code("inventory-ui")
      const result = await Worktree.create(item, ALWAYS)
      expect(result).toMatchObject({ ok: true, state: "ready" })
      expect(Porcelain.sparseDirectories(git(item.directory, ["ls-files", "--sparse", "-z"])).toSorted()).toEqual(
        [...F2_HEAVY].toSorted(),
      )
      expect(git(item.directory, ["config", "--worktree", "--get", "index.sparse"]).trim()).toBe("true")
      const onDisk = files(item.directory)
      expect(onDisk.filter((file) => F2_HEAVY.some((dir) => file.startsWith(`${dir}/`)))).toEqual([])
      expect(onDisk).toContain("Assets/Textures.meta")
      for (const file of F2_IN_CONE)
        expect(fs.statSync(path.join(item.directory, ...file.split("/"))).size).toBe(F2_LFS[file])
      expect(git(item.directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
    },
    SLOW,
  )

  test(
    "the offline area resumes once online; nothing more is downloaded for the same cone",
    async () => {
      const before = repo.objects()
      const result = await Worktree.create(code("-offline-area"), ALWAYS)
      expect(result).toMatchObject({ ok: true, state: "ready", resumed: true, fetched: { count: 0, bytes: 0 } })
      expect(repo.objects()).toBe(before)
      expect(files(code("-offline-area").directory)).toContain("-dash/icon.png")
    },
    SLOW,
  )

  test(
    "a full (plain) worktree of the same repository fetches the rest by top-level folder",
    async () => {
      const item = plan(repo.home, repo.head, "full-area")
      const result = await Worktree.create(item, ALWAYS)
      expect(result).toMatchObject({
        ok: true,
        state: "ready",
        fetched: { count: Object.keys(F2_LFS).length - F2_IN_CONE.length },
      })
      expect(repo.objects()).toBe(Object.keys(F2_LFS).length)
      expect(fs.statSync(path.join(item.directory, "Content", "map.bin")).size).toBe(F2_LFS["Content/map.bin"])
    },
    SLOW,
  )

  test(
    "offline with an empty store: a failed step 4 leaves an empty index; online, the same call resumes clean",
    async () => {
      repo.clear()
      const item = code("step-four")
      const added = await Worktree.add(item)
      if (!added.ok) throw new Error(added.message)
      const target = { directory: item.directory, gitDir: added.gitDir }
      expect(await Cone.set(target, item.cone)).toEqual({ ok: true })
      repo.offline()
      // As if the prefetch had been skipped: read-tree must smudge objects the store does not have.
      const populated = await Worktree.populate(target)
      repo.online()
      expect(populated).toMatchObject({ ok: false, step: 4, error: "git" })
      expect(git(item.directory, ["ls-files", "--sparse"])).toBe("")
      expect(await Worktree.observe(item)).toMatchObject({ ok: true, state: "unpopulated" })

      const resumed = await Worktree.create(item, ALWAYS)
      expect(resumed).toMatchObject({ ok: true, state: "ready", resumed: true, fetched: { count: F2_IN_CONE.length } })
      expect(repo.objects()).toBe(F2_IN_CONE.length)
      expect(git(item.directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
    },
    SLOW,
  )
})

describe("F3: synthetic repository", () => {
  test(
    "a code-only worktree writes only the code files",
    async () => {
      const f3 = synthetic(path.join(box.root, "f3"), 3_000)
      const cone = await Cone.compute(f3.home, f3.head, [...F3_HEAVY])
      if (!cone.ok) throw new Error(cone.message)
      expect(cone.dirs).toEqual([...F3_CONE])
      const item = plan(f3.home, f3.head, "f3-code", { shape: "code", cone: cone.dirs, heavy: [...F3_HEAVY] })
      const result = await Worktree.create(item, ALWAYS)
      expect(result).toMatchObject({ ok: true, state: "ready", fetched: { count: 0 } })
      expect(files(item.directory)).toEqual([...f3.code])
    },
    SLOW,
  )

  // 06 §4.5: 1.8 s for 1,500 files out of 100k on NTFS. Opt-in: OWN_TEAM_F3=1.
  test.skipIf(process.env.OWN_TEAM_F3 !== "1")(
    "100k entries: complement and code-only worktree timing",
    async () => {
      const started = Date.now()
      const f3 = synthetic(path.join(box.root, "f3-100k"), 100_000)
      const built = Date.now()
      const cone = await Cone.compute(f3.home, f3.head, [...F3_HEAVY])
      if (!cone.ok) throw new Error(cone.message)
      const computed = Date.now()
      const item = plan(f3.home, f3.head, "f3-100k", { shape: "code", cone: cone.dirs, heavy: [...F3_HEAVY] })
      const result = await Worktree.create(item, ALWAYS)
      const created = Date.now()
      console.log(
        `F3 ${f3.entries} entries: fixture ${built - started} ms, cone ${computed - built} ms, worktree ${created - computed} ms`,
      )
      expect(result).toMatchObject({ ok: true, state: "ready" })
      expect(files(item.directory).length).toBe(f3.code.length)
      expect(computed - built).toBeLessThan(5_000)
      expect(created - computed).toBeLessThan(30_000)
    },
    600_000,
  )
})

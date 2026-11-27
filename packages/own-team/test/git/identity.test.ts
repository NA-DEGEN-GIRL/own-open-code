import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Cone } from "../../src/git/cone.js"
import { Identity } from "../../src/git/identity.js"
import { Worktree } from "../../src/git/worktree.js"
import { f1, files, git, status, temp } from "../fixtures/repo.js"

const box = temp()
afterAll(() => box.dispose())
const repo = f1(box.root)
// A nested area inside the home's ignored `.worktrees\` (the layout of this user's home, 06 §4.3, [R-review] e3).
fs.appendFileSync(path.join(repo.home, ".git", "info", "exclude"), "/.worktrees/\n")
const nested = path.join(repo.home, ".worktrees", "nested")
git(repo.home, ["worktree", "add", "-q", "-b", "nested", nested, repo.head])
const sibling = path.join(box.root, "sibling")
git(repo.home, ["worktree", "add", "-q", "-b", "sibling", sibling, repo.head])

describe("Identity", () => {
  test("observe returns the worktree's own git dir and top level", async () => {
    const observed = await Identity.observe(nested)
    expect(observed.ok).toBe(true)
    if (!observed.ok) return
    expect(Identity.same(observed.toplevel, nested)).toBe(true)
    expect(Identity.same(observed.gitDir, path.join(repo.home, ".git", "worktrees", "nested"))).toBe(true)
    expect((await Identity.check({ directory: nested, gitDir: observed.gitDir })).ok).toBe(true)
  })

  test("another worktree's record does not match", async () => {
    const observed = await Identity.observe(sibling)
    if (!observed.ok) throw new Error(observed.message)
    const crossed = await Identity.check({ directory: nested, gitDir: observed.gitDir })
    expect(crossed).toMatchObject({ ok: false, broken: "identity" })
  })

  test("a missing folder is `missing`", async () => {
    const result = await Identity.check({ directory: path.join(box.root, "gone"), gitDir: path.join(box.root, "x") })
    expect(result).toMatchObject({ ok: false, broken: "missing" })
  })

  test("same() ignores separators, and case on Windows", () => {
    expect(Identity.same(repo.home.replaceAll("\\", "/"), repo.home)).toBe(true)
    if (process.platform === "win32") expect(Identity.same(repo.home.toUpperCase(), repo.home)).toBe(true)
    expect(Identity.inside(repo.home, nested)).toBe(true)
    expect(Identity.inside(nested, repo.home)).toBe(false)
  })

  test("a nested worktree without its .git file is broken(identity) and the home is never touched", async () => {
    const observed = await Identity.observe(nested)
    if (!observed.ok) throw new Error(observed.message)
    const record = { directory: nested, gitDir: observed.gitDir }
    const homeFiles = files(repo.home).filter((file) => !file.startsWith(".worktrees/"))
    const homeIndex = fs.readFileSync(path.join(repo.home, ".git", "index"))
    fs.rmSync(path.join(nested, ".git"))

    expect(await Identity.check(record)).toMatchObject({ ok: false, broken: "identity" })
    // Plain git without the ceiling would have found the home: that is the accident the check prevents.
    expect(Identity.same(git(nested, ["rev-parse", "--show-toplevel"]).trim(), repo.home)).toBe(true)

    expect(await Cone.set(record, ["src"])).toMatchObject({ ok: false, error: "broken", broken: "identity" })
    expect(await Cone.add(record, ["docs"])).toMatchObject({ ok: false, error: "broken" })
    expect(await Cone.reapply(record)).toMatchObject({ ok: false, error: "broken" })
    expect(await Worktree.populate(record)).toMatchObject({ ok: false, error: "broken", broken: "identity" })
    expect(await Worktree.undo({ ...record, home: repo.home })).toMatchObject({ ok: false, error: "broken" })

    expect(files(repo.home).filter((file) => !file.startsWith(".worktrees/"))).toEqual(homeFiles)
    expect(fs.readFileSync(path.join(repo.home, ".git", "index")).equals(homeIndex)).toBe(true)
    expect(() => git(repo.home, ["config", "--get", "core.sparseCheckout"])).toThrow()
    expect(status(repo.home)).toBe("")
  })
})

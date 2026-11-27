// Hold refs (06 §8.7) on git fixtures: a copy of uncommitted work through a temporary index, the working files and the
// real index untouched, `add -A --sparse` in a sparse folder, the path check, create-only resume, fixed dates, changed
// link copies (Symlinks.dirtyCopies, file and folder copies) and the identity check.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Hold } from "../../src/dispatch/hold.js"
import { f1, git, temp, write } from "../fixtures/repo.js"

const box = temp("own-team-hold-")
afterAll(() => box.dispose())

let count = 0
/** A fresh F1 checkout and its identity record. */
function repo() {
  const made = f1(path.join(box.root, `r${++count}`))
  const gitDir = git(made.home, ["rev-parse", "--absolute-git-dir"]).trim()
  return { ...made, target: { directory: made.home, gitDir } }
}

const AT = Date.UTC(2026, 9, 2, 3, 4, 5)
/** Git process starts are slow on Windows. */
const SLOW = 120_000

function show(directory: string, spec: string) {
  return git(directory, ["show", spec])
}

describe("Hold.create", () => {
  test(
    "copies modified, staged, untracked and deleted work; the files and the real index stay as they were",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 2\n", "notes/new file.md": "새 메모\n" })
      write(r.home, { "docs/guide.md": "staged guide\n" })
      git(r.home, ["add", "docs/guide.md"])
      fs.rmSync(path.join(r.home, "tools", "build.ts"))
      const statusBefore = git(r.home, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])
      const indexBefore = fs.readFileSync(path.join(r.target.gitDir, "index"))

      const held = await Hold.create({ target: r.target, scope: "ar_ui", id: "op_one", at: AT })

      expect(held).toMatchObject({ ok: true, ref: "refs/own/hold/ar_ui/op_one", created: true })
      if (!held.ok) return
      expect(held.bytes).toBeGreaterThan(0)
      expect(git(r.home, ["rev-parse", "refs/own/hold/ar_ui/op_one"]).trim()).toBe(held.sha)
      expect(show(r.home, `${held.sha}:src/app/main.ts`)).toBe("export const main = 2\n")
      expect(show(r.home, `${held.sha}:notes/new file.md`)).toBe("새 메모\n")
      expect(show(r.home, `${held.sha}:docs/guide.md`)).toBe("staged guide\n")
      expect(() => git(r.home, ["cat-file", "-e", `${held.sha}:tools/build.ts`])).toThrow()
      expect(git(r.home, ["rev-parse", `${held.sha}^`]).trim()).toBe(r.head)
      expect(git(r.home, ["log", "-1", "--format=%s", held.sha]).trim()).toBe("own hold ar_ui op_one")
      // Nothing else moved: same status, same index bytes, the temp index removed.
      expect(git(r.home, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(statusBefore)
      expect(fs.readFileSync(path.join(r.target.gitDir, "index")).equals(indexBefore)).toBe(true)
      expect(fs.readdirSync(r.target.gitDir).filter((name) => name.startsWith("own-hold-index"))).toEqual([])
    },
    SLOW,
  )

  test(
    "an existing hold ref is done, whatever its value; the dates are fixed, so the same work gives the same commit",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 3\n" })
      const first = await Hold.create({ target: r.target, scope: "ar_ui", id: "op_two", at: AT })
      if (!first.ok) throw new Error(first.message)
      expect(git(r.home, ["log", "-1", "--format=%at %ct %an", first.sha]).trim()).toBe(
        `${AT / 1000} ${AT / 1000} own.team`,
      )
      write(r.home, { "src/app/main.ts": "export const main = 4\n" })
      expect(await Hold.create({ target: r.target, scope: "ar_ui", id: "op_two", at: AT })).toEqual({
        ok: true,
        ref: "refs/own/hold/ar_ui/op_two",
        sha: first.sha,
        created: false,
        bytes: 0,
      })
      write(r.home, { "src/app/main.ts": "export const main = 3\n" })
      git(r.home, ["update-ref", "-d", "refs/own/hold/ar_ui/op_two"])
      const again = await Hold.create({ target: r.target, scope: "ar_ui", id: "op_two", at: AT })
      expect(again).toMatchObject({ ok: true, created: true, sha: first.sha })
    },
    SLOW,
  )

  test(
    "a sparse folder: untracked work outside the cone is in the copy (add -A --sparse)",
    async () => {
      const r = repo()
      git(r.home, ["sparse-checkout", "set", "--cone", "src"])
      expect(fs.existsSync(path.join(r.home, "docs"))).toBe(false)
      write(r.home, { "docs/outside.md": "outside the cone\n", "src/inside.ts": "inside\n" })

      const held = await Hold.create({ target: r.target, scope: "ar_code", id: "op_sparse", at: AT })

      expect(held.ok).toBe(true)
      if (!held.ok) return
      expect(show(r.home, `${held.sha}:docs/outside.md`)).toBe("outside the cone\n")
      expect(show(r.home, `${held.sha}:src/inside.ts`)).toBe("inside\n")
      // Folders outside the cone keep their committed content.
      expect(show(r.home, `${held.sha}:tools/build.ts`)).toBe("export {}\n")
      expect(fs.existsSync(path.join(r.home, "tools"))).toBe(false)
    },
    SLOW,
  )

  test(
    "a link copy hidden by --assume-unchanged goes in through the link-copy hook point",
    async () => {
      const r = repo()
      const recorded = git(r.home, ["rev-parse", "HEAD:README-link.md"]).trim()
      git(r.home, ["update-index", "--assume-unchanged", "README-link.md"])
      write(r.home, { "README-link.md": "edited copy\n" })
      expect(git(r.home, ["status", "--porcelain"])).toBe("")

      const links = await Hold.dirtyLinks({
        directory: r.home,
        linkCopies: {
          "README-link.md": recorded,
          "docs/guide-link.md": git(r.home, ["rev-parse", "HEAD:docs/guide-link.md"]).trim(),
        },
      })
      expect(links).toEqual(["README-link.md"])
      const held = await Hold.create({ target: r.target, scope: "ar_ui", id: "op_link", at: AT, links })

      expect(held.ok).toBe(true)
      if (!held.ok) return
      expect(show(r.home, `${held.sha}:README-link.md`)).toBe("edited copy\n")
      expect(git(r.home, ["ls-tree", held.sha, "README-link.md"]).split(" ")[0]).toBe("100644")
    },
    SLOW,
  )

  test(
    "changed link copies written by Symlinks.apply go in with their disk content through Symlinks.dirtyCopies",
    async () => {
      const r = repo()
      const applied = await Symlinks.apply({ area: { ...r.target, shape: "plain" }, fix: "skip-worktree" })
      if (!applied.ok) throw new Error(applied.message)
      write(r.home, { "README-link.md": "edited copy\n", "src/app/lib/util.ts": "edited folder copy\n" })
      expect(git(r.home, ["status", "--porcelain"])).toBe("")
      const indexBefore = fs.readFileSync(path.join(r.target.gitDir, "index"))

      const links = await Hold.dirtyLinks({ directory: r.home, linkCopies: applied.linkCopies })
      expect(links).toEqual(["README-link.md", "src/app/lib"])
      const held = await Hold.create({ target: r.target, scope: "ar_ui", id: "op_links", at: AT, links })

      expect(held.ok).toBe(true)
      if (!held.ok) return
      expect(show(r.home, `${held.sha}:README-link.md`)).toBe("edited copy\n")
      expect(show(r.home, `${held.sha}:src/app/lib/util.ts`)).toBe("edited folder copy\n")
      expect(git(r.home, ["ls-tree", held.sha, "README-link.md"]).split(" ")[0]).toBe("100644")
      // The unchanged copy keeps the committed link.
      expect(git(r.home, ["ls-tree", held.sha, "docs/guide-link.md"]).split(" ")[0]).toBe("120000")
      expect(fs.readFileSync(path.join(r.target.gitDir, "index")).equals(indexBefore)).toBe(true)
      expect(fs.readFileSync(path.join(r.home, "README-link.md"), "utf8")).toBe("edited copy\n")
    },
    SLOW,
  )

  test(
    "a folder that is not the recorded worktree is refused before git writes anything",
    async () => {
      const r = repo()
      const other = repo()
      write(r.home, { "src/app/main.ts": "changed\n" })
      const held = await Hold.create({
        target: { directory: r.home, gitDir: other.target.gitDir },
        scope: "ar_ui",
        id: "op_identity",
        at: AT,
      })
      expect(held).toMatchObject({ ok: false, error: "identity" })
      expect(git(r.home, ["for-each-ref", "refs/own"]).trim()).toBe("")
    },
    SLOW,
  )

  test(
    "an id that cannot name a ref is refused",
    async () => {
      const r = repo()
      expect(await Hold.create({ target: r.target, scope: "ar_ui", id: "op x", at: AT })).toMatchObject({
        ok: false,
        error: "git",
      })
    },
    SLOW,
  )
})

describe("Hold.changes", () => {
  test(
    "lists uncommitted paths (renames with both names), never ignored ones",
    async () => {
      const r = repo()
      expect(await Hold.changes(r.home)).toEqual({ ok: true, paths: [] })
      write(r.home, { ".gitignore": "*.log\n", "debug.log": "ignored\n", "src/new.ts": "x\n" })
      git(r.home, ["mv", "docs/guide.md", "docs/moved.md"])
      const changes = await Hold.changes(r.home)
      expect(changes.ok).toBe(true)
      if (!changes.ok) return
      expect(changes.paths.toSorted()).toEqual([".gitignore", "docs/guide.md", "docs/moved.md", "src/new.ts"])
    },
    SLOW,
  )
})

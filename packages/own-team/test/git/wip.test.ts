// WIP commits (06 §8.7, TG12 WIP item) on git fixtures: the hold ref's temporary index, `commit-tree`, the
// compare-and-swap `update-ref` and `reset --mixed`; the working files keep their hashes, no commit hook runs, a CAS
// that fails leaves the branch where it is, and link copies (4.12) are never committed. Temp repositories only.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Hold } from "../../src/dispatch/hold.js"
import { Wip } from "../../src/git/wip.js"
import { f1, files, git, head, temp, write } from "../fixtures/repo.js"
import { removeTree } from "../support/remove.js"

const box = temp("own-team-wip-")
// Removing many fixture repositories takes a while on Windows, and a git process that just ended may still hold one.
afterAll(() => removeTree(box.root, 20, 250), 120_000)

const AT = Date.UTC(2026, 9, 4, 5, 6, 7)
/** Git process starts are slow on Windows. */
const SLOW = 120_000
const MESSAGE = "팀: 'ui'의 커밋 안 된 변경 저장 (op_wip)"

let count = 0
/** A fresh F1 checkout on `main` and its identity record; `hooks` is the fixture's (empty) hooks folder. */
function repo() {
  const made = f1(path.join(box.root, `r${++count}`))
  const gitDir = git(made.home, ["rev-parse", "--absolute-git-dir"]).trim()
  return {
    ...made,
    target: { directory: made.home, gitDir },
    hooks: path.join(path.dirname(made.home), ".no-hooks"),
  }
}

function input(r: ReturnType<typeof repo>, id = "op_wip", message = MESSAGE): Wip.Input {
  return { target: r.target, branch: "main", scope: "ar_ui", id, at: AT, message }
}

/** The blob id of every file on disk (what `git hash-object` makes of it), by path. */
function hashes(dir: string) {
  return Object.fromEntries(
    files(dir).map((file) => [file, git(dir, ["hash-object", "--no-filters", "--", file]).trim()] as const),
  )
}

/** Hooks that would leave a mark if any commit hook ran. */
function hooks(folder: string) {
  fs.mkdirSync(folder, { recursive: true })
  const marker = path.join(folder, "ran.txt").replaceAll("\\", "/")
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
    const file = path.join(folder, name)
    fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> "${marker}"\n`)
    fs.chmodSync(file, 0o755)
  }
  return path.join(folder, "ran.txt")
}

describe("Wip.commit (06 §8.7)", () => {
  test(
    "puts modified, staged, untracked and deleted work on the branch; files untouched, no hook, index = W",
    async () => {
      const r = repo()
      const ran = hooks(r.hooks)
      // The hooks do run for a porcelain commit (so their silence below means something).
      const control = repo()
      const controlRan = hooks(control.hooks)
      git(control.home, ["commit", "-q", "--allow-empty", "-m", "control"])
      expect(fs.existsSync(controlRan)).toBe(true)

      write(r.home, { "src/app/main.ts": "export const main = 2\n", "notes/new file.md": "새 메모\n" })
      write(r.home, { "docs/guide.md": "staged guide\n" })
      git(r.home, ["add", "docs/guide.md"])
      fs.rmSync(path.join(r.home, "tools", "build.ts"))
      const before = hashes(r.home)

      const made = await Wip.commit(input(r))

      if (!made.ok || made.state !== "committed") throw new Error(JSON.stringify(made))
      expect(made).toMatchObject({ parent: r.head, created: true, hold: { ref: "refs/own/hold/ar_ui/op_wip" } })
      expect(git(r.home, ["rev-parse", "refs/heads/main"]).trim()).toBe(made.sha)
      expect(git(r.home, ["rev-parse", `${made.sha}^`]).trim()).toBe(r.head)
      expect(git(r.home, ["show", `${made.sha}:src/app/main.ts`])).toBe("export const main = 2\n")
      expect(git(r.home, ["show", `${made.sha}:notes/new file.md`])).toBe("새 메모\n")
      expect(git(r.home, ["show", `${made.sha}:docs/guide.md`])).toBe("staged guide\n")
      expect(() => git(r.home, ["cat-file", "-e", `${made.sha}:tools/build.ts`])).toThrow()
      expect(git(r.home, ["log", "-1", "--format=%an|%at|%ct|%B", made.sha]).trim()).toBe(
        `own.team|${AT / 1000}|${AT / 1000}|${MESSAGE}`,
      )
      // The copy of TI-1 is there too, and it holds the same tree.
      expect(git(r.home, ["rev-parse", `${made.hold.sha}^{tree}`]).trim()).toBe(
        git(r.home, ["rev-parse", `${made.sha}^{tree}`]).trim(),
      )
      // Nothing on disk changed, the folder is clean, the index is W's tree, and no hook ran.
      expect(hashes(r.home)).toEqual(before)
      expect(git(r.home, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("")
      expect(git(r.home, ["diff-index", "--cached", "--name-only", made.sha])).toBe("")
      expect(fs.existsSync(ran)).toBe(false)
    },
    SLOW,
  )

  test(
    "a retry observes the commit it made (same W, created false); a clean folder makes nothing",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 5\n" })
      const first = await Wip.commit(input(r))
      if (!first.ok || first.state !== "committed") throw new Error(JSON.stringify(first))

      const again = await Wip.commit(input(r))
      expect(again).toMatchObject({ ok: true, state: "committed", sha: first.sha, created: false })
      expect(git(r.home, ["rev-parse", "refs/heads/main"]).trim()).toBe(first.sha)

      const clean = repo()
      expect(await Wip.commit(input(clean))).toEqual({ ok: true, state: "clean", parent: clean.head })
      expect(git(clean.home, ["for-each-ref", "refs/own"]).trim()).toBe("")
      expect(head(clean.home)).toBe(clean.head)
    },
    SLOW,
  )

  test(
    "a compare-and-swap that fails leaves the branch untouched (moved between the copy and the update)",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 6\n" })
      const before = hashes(r.home)
      // Someone moves `main` right after own's copy is made: the reference-transaction hook of the hold ref does it.
      const other = git(r.home, ["commit-tree", `${r.head}^{tree}`, "-p", r.head, "-m", "someone else"]).trim()
      fs.mkdirSync(r.hooks, { recursive: true })
      const hook = path.join(r.hooks, "reference-transaction")
      fs.writeFileSync(
        hook,
        [
          "#!/bin/sh",
          '[ "$1" = committed ] || exit 0',
          "while read old new ref; do",
          `  case "$ref" in refs/own/hold/*) git update-ref refs/heads/main ${other} ;; esac`,
          "done",
          "",
        ].join("\n"),
      )
      fs.chmodSync(hook, 0o755)

      const made = await Wip.commit(input(r))

      expect(made).toMatchObject({ ok: false, error: "conflict" })
      expect(git(r.home, ["rev-parse", "refs/heads/main"]).trim()).toBe(other)
      expect(hashes(r.home)).toEqual(before)
      // The index was not reset either: the change is still where it was (now seen against the moved branch).
      expect(git(r.home, ["diff", "--name-only"]).trim()).toBe("src/app/main.ts")
    },
    SLOW,
  )

  test(
    "a copy left by an earlier attempt that no longer sits on the branch is not used (moved)",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 7\n" })
      const held = await Hold.create({ target: r.target, scope: "ar_ui", id: "op_wip", at: AT })
      if (!held.ok) throw new Error(held.message)
      write(r.home, { "docs/later.md": "later\n" })
      git(r.home, ["add", "docs/later.md"])
      git(r.home, ["commit", "-q", "-m", "a commit after the copy"])
      const tip = head(r.home)

      expect(await Wip.commit(input(r))).toMatchObject({ ok: false, error: "moved" })
      expect(head(r.home)).toBe(tip)
    },
    SLOW,
  )

  test(
    "link copies written by Symlinks.apply are never committed; they keep their flags and content",
    async () => {
      const r = repo()
      const applied = await Symlinks.apply({ area: { ...r.target, shape: "plain" }, fix: "skip-worktree" })
      if (!applied.ok) throw new Error(applied.message)
      write(r.home, {
        "README-link.md": "edited copy\n",
        "src/app/lib/util.ts": "edited folder copy\n",
        "src/app/main.ts": "export const main = 8\n",
      })
      const links = ["README-link.md", "docs/guide-link.md", "src/app/lib"]
      const tree = (rev: string) => links.map((link) => git(r.home, ["ls-tree", rev, link]).trim())
      const before = tree("HEAD")

      const made = await Wip.commit(input(r))

      if (!made.ok || made.state !== "committed") throw new Error(JSON.stringify(made))
      expect(tree(made.sha)).toEqual(before)
      expect(before.every((line) => line.startsWith("120000 "))).toBe(true)
      expect(git(r.home, ["show", `${made.sha}:src/app/main.ts`])).toBe("export const main = 8\n")
      expect(() => git(r.home, ["cat-file", "-e", `${made.sha}:src/app/lib/util.ts`])).toThrow()
      // The copies are still flagged (`S`) and hold what the user wrote.
      const flags = git(r.home, ["ls-files", "-v", "--", "README-link.md", "docs/guide-link.md"]).trim().split("\n")
      expect(flags.every((line) => line.startsWith("S "))).toBe(true)
      expect(fs.readFileSync(path.join(r.home, "README-link.md"), "utf8")).toBe("edited copy\n")
      expect(fs.readFileSync(path.join(r.home, "src/app/lib/util.ts"), "utf8")).toBe("edited folder copy\n")
      expect((await Hold.dirtyLinks({ directory: r.home, linkCopies: applied.linkCopies })).toSorted()).toEqual([
        "README-link.md",
        "src/app/lib",
      ])
    },
    SLOW,
  )

  test(
    "refused without the branch checked out (detached HEAD) or in a folder that is not the recorded one",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 9\n" })
      git(r.home, ["switch", "-q", "--detach"])
      expect(await Wip.commit(input(r))).toMatchObject({ ok: false, error: "branch" })

      const other = repo()
      const s = repo()
      write(s.home, { "src/app/main.ts": "changed\n" })
      expect(
        await Wip.commit({ ...input(s), target: { directory: s.home, gitDir: other.target.gitDir } }),
      ).toMatchObject({ ok: false, error: "identity" })
      expect(git(s.home, ["for-each-ref", "refs/own"]).trim()).toBe("")
      expect(head(s.home)).toBe(s.head)
    },
    SLOW,
  )
})

describe("Wip.undo (06 §8.7 되돌리기)", () => {
  test(
    "takes W back while the branch is still W; refuses once it moved on",
    async () => {
      const r = repo()
      write(r.home, { "src/app/main.ts": "export const main = 10\n" })
      const before = hashes(r.home)
      const made = await Wip.commit(input(r))
      if (!made.ok || made.state !== "committed") throw new Error(JSON.stringify(made))

      expect(await Wip.undo({ target: r.target, branch: "main", sha: made.sha, parent: made.parent })).toEqual({
        ok: true,
        state: "undone",
      })
      expect(head(r.home)).toBe(r.head)
      expect(hashes(r.home)).toEqual(before)
      expect(git(r.home, ["diff", "--name-only"]).trim()).toBe("src/app/main.ts")

      const again = await Wip.commit(input(r, "op_wip2", "팀: again (op_wip2)"))
      if (!again.ok || again.state !== "committed") throw new Error(JSON.stringify(again))
      write(r.home, { "docs/after.md": "after\n" })
      git(r.home, ["add", "docs/after.md"])
      git(r.home, ["commit", "-q", "-m", "after the WIP"])
      const tip = head(r.home)
      expect(await Wip.undo({ target: r.target, branch: "main", sha: again.sha, parent: again.parent })).toMatchObject({
        ok: false,
        error: "moved",
      })
      expect(head(r.home)).toBe(tip)
    },
    SLOW,
  )
})

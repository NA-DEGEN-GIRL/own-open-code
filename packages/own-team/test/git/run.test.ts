import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Git } from "../../src/git/run.js"
import { GitVersion } from "../../src/git/version.js"
import { Porcelain } from "../../src/git/porcelain.js"
import { commit, f1, git, init, temp, write } from "../fixtures/repo.js"

/** Git-heavy tests: Windows process starts are slow on a busy machine. */
const SLOW = 180_000

const box = temp()
afterAll(() => box.dispose())
const repo = f1(box.root)

describe("Git.run", () => {
  test("every call carries core.quotepath=false and advice.sparseIndexExpanded=false", async () => {
    const quote = await Git.run(["config", "--get", "core.quotepath"], { cwd: repo.home })
    const advice = await Git.run(["config", "--get", "advice.sparseIndexExpanded"], { cwd: repo.home })
    expect(quote.ok && quote.stdout.trim()).toBe("false")
    expect(advice.ok && advice.stdout.trim()).toBe("false")
  })

  test("non-ASCII paths come back unquoted", async () => {
    write(repo.home, { "docs/한글 노트.md": "x\n" })
    const result = await Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: repo.home })
    expect(result.ok && Porcelain.status(result.stdout).entries).toEqual([
      { kind: "untracked", path: "docs/한글 노트.md" },
    ])
    fs.rmSync(path.join(repo.home, "docs", "한글 노트.md"))
  })

  test("environment: no prompts, optional locks off for reads only, ceiling for worktree calls", () => {
    const read = Git.environment({ cwd: repo.home, worktree: true })
    expect(read.GIT_TERMINAL_PROMPT).toBe("0")
    expect(read.GCM_INTERACTIVE).toBe("never")
    expect(read.GIT_OPTIONAL_LOCKS).toBe("0")
    expect(read.GIT_CEILING_DIRECTORIES).toBe(path.dirname(repo.home))
    const write = Git.environment({ cwd: repo.home, write: true })
    expect(write.GIT_OPTIONAL_LOCKS).toBeUndefined()
    expect(write.GIT_CEILING_DIRECTORIES).toBeUndefined()
    expect(Git.environment({ env: { GIT_INDEX_FILE: "x" } }).GIT_INDEX_FILE).toBe("x")
  })

  test("a read never rewrites the index; a write may", async () => {
    const index = path.join(repo.home, ".git", "index")
    const file = path.join(repo.home, "README.md")
    const touch = () => fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    touch()
    const before = fs.statSync(index).mtimeMs
    await Git.run(["status", "--porcelain=v2", "-z"], { cwd: repo.home })
    expect(fs.statSync(index).mtimeMs).toBe(before)
    await Git.run(["status", "--porcelain=v2", "-z"], { cwd: repo.home, write: true })
    expect(fs.statSync(index).mtimeMs).not.toBe(before)
  })

  test("the ceiling stops a worktree call at the folder", async () => {
    const inner = path.join(repo.home, "docs")
    const plain = await Git.run(["rev-parse", "--show-toplevel"], { cwd: inner })
    expect(plain.ok).toBe(true)
    const fenced = await Git.run(["rev-parse", "--show-toplevel"], { cwd: inner, worktree: true })
    expect(fenced.ok).toBe(false)
    expect(fenced.ok || fenced.reason).toBe("exit")
  })

  test("stdin lists keep names that start with '-'", async () => {
    const result = await Git.run(["hash-object", "--stdin-paths"], {
      cwd: repo.home,
      stdin: Git.lines(["-dash/notes.md"]),
    })
    expect(result.ok && result.stdout.trim()).toBe(git(repo.home, ["rev-parse", "HEAD:-dash/notes.md"]).trim())
  })

  test("non-native and relative folders are refused before git starts", async () => {
    const bad = process.platform === "win32" ? ["/d/own-open-code", "\\\\server\\share", "relative"] : ["relative"]
    for (const cwd of bad) {
      const result = await Git.run(["status"], { cwd })
      expect(result.ok || result.reason).toBe("refused")
    }
    expect(Git.isNative(repo.home)).toBe(true)
  })

  test("update-ref OIDs must be full hex names, in arguments and in --stdin lines", async () => {
    const head = repo.head
    const zero = "0".repeat(40)
    const cases: Array<readonly string[]> = [
      ["update-ref", "refs/own/keep/x", "", head],
      ["update-ref", "refs/own/keep/x", head.slice(0, 12), zero],
      ["update-ref", "refs/own/keep/x", "HEAD", zero],
      ["update-ref", "-m", "why", "refs/own/keep/x", head, "main"],
      ["update-ref", "-d", "refs/own/keep/x", "main"],
      ["update-ref", "refs/own/keep/x"],
      ["-c", "core.logAllRefUpdates=true", "update-ref", "refs/own/keep/x", "", head],
    ]
    for (const args of cases) {
      const result = await Git.run(args, { cwd: repo.home, write: true })
      expect(result.ok || result.reason).toBe("refused")
    }
    const badStdin = await Git.run(["update-ref", "--stdin"], {
      cwd: repo.home,
      write: true,
      stdin: Git.lines(["start", `create refs/own/keep/y ${head.toUpperCase()}`, "prepare", "commit"]),
    })
    expect(badStdin.ok || badStdin.reason).toBe("refused")
    const z = await Git.run(["update-ref", "--stdin", "-z"], { cwd: repo.home, write: true, stdin: "" })
    expect(z.ok || z.reason).toBe("refused")
    expect(git(repo.home, ["for-each-ref", "refs/own"])).toBe("")

    const good = await Git.run(["update-ref", "-m", "own.team", "refs/own/keep/ok", head, zero], {
      cwd: repo.home,
      write: true,
    })
    expect(good.ok).toBe(true)
    expect(Git.isOid(head)).toBe(true)
    expect(Git.isOid("a".repeat(64))).toBe(true)
    expect(Git.isOid("A".repeat(40))).toBe(false)
  })

  test("a call past its time limit is killed and reported as a timeout", async () => {
    const started = Date.now()
    // Test-only shell alias: a git call that does not finish on its own. It runs in the OS temp folder, which
    // outlives the orphaned `sleep` (a process inside the fixture would block its removal on Windows).
    const result = await Git.run(["-c", "alias.wait=!sleep 5", "wait"], { cwd: os.tmpdir(), timeout: 500 })
    expect(result.ok || result.reason).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("bytes() returns stdout as bytes", async () => {
    const result = await Git.bytes(["cat-file", "blob", `${repo.head}:README.md`], { cwd: repo.home })
    expect(result.ok && new TextDecoder().decode(result.stdout)).toBe("# F1\n")
  })
})

describe("GitVersion", () => {
  test("parse and the 06 §4.2 gates", () => {
    const windows = GitVersion.parse("git version 2.55.0.windows.3\n")
    expect(windows).toEqual({ major: 2, minor: 55, patch: 0, text: "2.55.0.windows.3" })
    const ubuntu = GitVersion.parse("git version 2.43.0")
    expect(ubuntu && GitVersion.shape(ubuntu)).toEqual({ ok: true, shape: "code" })
    const old = GitVersion.parse("git version 2.41.2")
    expect(old && GitVersion.shape(old)).toEqual({
      ok: true,
      shape: "plain",
      reason: "old_git",
      text: GitVersion.OLD_GIT_TEXT,
    })
    expect(GitVersion.shape(GitVersion.parse("git version 2.40.0")!).ok).toBe(true)
    const ancient = GitVersion.shape(GitVersion.parse("git version 2.39.5")!)
    expect(ancient.ok || ancient.error).toBe("git_too_old")
    expect(GitVersion.parseLfs("git-lfs/3.7.1 (GitHub; windows amd64; go 1.25.1; git b84b3384)")).toBe("3.7.1")
    expect(GitVersion.parseLfs("git: 'lfs' is not a git command")).toBeUndefined()
  })

  test("probe reports the installed git", async () => {
    const probe = await GitVersion.probe()
    expect(probe.git.ok).toBe(true)
    expect(probe.git.version).toMatch(/^\d+\.\d+/)
    expect(probe.git.path).not.toBeNull()
  })

  test(
    "LFS is required only when ls-files ':(attr:filter=lfs)' lists something",
    async () => {
      const plain = await GitVersion.usesLfs(repo.home)
      expect(plain.ok && plain.used).toBe(false)
      const checked = await GitVersion.check(repo.home)
      expect(checked.ok && checked.lfs.used).toBe(false)

      const lfs = init(path.join(box.root, "uses-lfs"))
      write(lfs, { ".gitattributes": "*.png filter=lfs diff=lfs merge=lfs -text\n", "a.txt": "a\n" })
      commit(lfs)
      const none = await GitVersion.usesLfs(lfs)
      expect(none.ok && none.used).toBe(false)
      // A pointer committed without git-lfs still counts: the attribute is what matters.
      write(lfs, {
        "img/x.png": "version https://git-lfs.github.com/spec/v1\noid sha256:" + "1".repeat(64) + "\nsize 3\n",
      })
      git(lfs, [
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.clean=cat",
        "-c",
        "filter.lfs.required=false",
        "add",
        "-A",
      ])
      git(lfs, ["commit", "-q", "-m", "pointer"])
      const some = await GitVersion.usesLfs(lfs)
      expect(some.ok && some.used).toBe(true)
    },
    SLOW,
  )
})

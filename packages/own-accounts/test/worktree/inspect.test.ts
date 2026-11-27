// worktree.inspect (06 §10.4 #5, §8.6 step 1, TI-3 (b), TG13) on temporary Git repositories: nested worktrees and
// repositories (breadth-first), own and foreign locks, ignored files and their sizes, the root, unlisted, UNC and
// non-project folders refused, Windows spellings, and links never followed. Every repository lives in a temp folder;
// Git gets its identity per command.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorktreeRpc } from "../../src/rpc/worktree.js"
import { WorktreeInspect } from "../../src/worktree/inspect.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
import { failure, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

// Each case runs Git a dozen times or more (worktree add, lock, status, the inspection's own calls). A Git process takes
// about 0.05 s on an idle Windows PC (the lock case 1.1 s in all) but several times that late in a full own-accounts
// run, where the lock case passed 5 s, Bun's default: the budget is per file, as the e2e-kit README asks.
setDefaultTimeout(30_000)

const GIT = Bun.which("git")
const WINDOWS = process.platform === "win32"
const IDENTITY = ["-c", "user.email=inspect@example.test", "-c", "user.name=inspect", "-c", "core.autocrlf=false"]

let tmp = ""
let root = ""

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString()
}

/** A linked worktree of `root` at `<tmp>/<name>` (detached at main). */
function worktree(name: string, ...options: string[]) {
  const directory = path.join(tmp, name)
  git(root, "worktree", "add", "--detach", ...options, directory, "main")
  return directory
}

async function write(file: string, bytes: number) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, "x".repeat(bytes))
}

async function inspected(directory: string, limits?: Partial<WorktreeInspect.Limits>) {
  const result = await WorktreeInspect.inspect({ root, directory }, { limits })
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`)
  return result.inspection
}

describe.skipIf(!GIT)("worktree.inspect on temp repositories (needs git on PATH)", () => {
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-wt-inspect-")))
    root = path.join(tmp, "repo")
    await fs.mkdir(root)
    git(root, "init", "-q", "-b", "main")
    await Bun.write(path.join(root, ".gitignore"), ".worktrees/\nvendor/\nbuild/\n*.log\nlink\n")
    await Bun.write(path.join(root, "README.md"), "# inspect\n")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
  })

  afterAll(async () => {
    if (!tmp) return
    // Every link points inside `tmp`, so removing the folder cannot reach anything else.
    await removeTree(tmp)
  })

  test("a clean linked worktree: nothing nested, no lock, no ignored files", async () => {
    const directory = worktree("clean")
    await Bun.write(path.join(directory, "notes.txt"), "untracked, not ignored\n")
    expect(await inspected(directory)).toEqual({
      nested: [],
      scan: "complete",
      lock: null,
      ownLock: false,
      ignored: { entries: [], count: 0, bytes: 0, truncated: false },
    })
  })

  test("a linked worktree inside it (an ignored .worktrees folder) is listed as a nested worktree", async () => {
    const outer = worktree("outer")
    const inner = path.join(outer, ".worktrees", "inner")
    git(root, "worktree", "add", "--detach", inner, "main")
    await write(path.join(inner, "work.txt"), 10)
    const result = await inspected(outer)
    expect(result.nested).toEqual([{ path: inner, kind: "worktree" }])
    expect(result.ignored.entries.map((entry) => entry.path)).toEqual([".worktrees/"])
    // The inner worktree itself is fine to inspect, and has nothing inside.
    expect((await inspected(inner)).nested).toEqual([])
  })

  test("an independent repository in an ignored folder is listed as a repository (status shows only `!! vendor/`)", async () => {
    const directory = worktree("vendored")
    const lib = path.join(directory, "vendor", "lib")
    await fs.mkdir(lib, { recursive: true })
    git(lib, "init", "-q", "-b", "main")
    await write(path.join(lib, "local.c"), 5)
    git(lib, "add", ".")
    git(lib, "commit", "-q", "-m", "local work")
    const result = await inspected(directory)
    expect(result.nested).toEqual([{ path: lib, kind: "repository" }])
    expect(result.ignored.entries.map((entry) => entry.path)).toEqual(["vendor/"])
  })

  test("own locks (own.team …, own: …) versus foreign locks and a lock without a reason", async () => {
    const cases = [
      ["own-area", "own.team area:ar_x", true],
      ["own-nested", "own: nested worktrees inside", true],
      ["foreign", "used by another tool", false],
    ] as const
    for (const [name, reason, own] of cases) {
      const directory = worktree(name, "--lock", "--reason", reason)
      const result = await inspected(directory)
      expect({ name, lock: result.lock, ownLock: result.ownLock }).toEqual({ name, lock: { reason }, ownLock: own })
    }
    // `worktree add --lock` without a reason records "added with --lock"; `worktree lock` records none.
    const bare = worktree("bare-lock")
    git(root, "worktree", "lock", bare)
    expect(await inspected(bare)).toMatchObject({ lock: { reason: "" }, ownLock: false })
  })

  test("ignored entries: sizes from the walk, biggest first, top 20 of the count, total bytes", async () => {
    const directory = worktree("ignored")
    await write(path.join(directory, "build", "app.bin"), 3000)
    await write(path.join(directory, "build", "deep", "chunk.bin"), 2000)
    for (let index = 1; index <= 21; index++) await write(path.join(directory, `run-${index}.log`), index)
    await write(path.join(directory, "kept.txt"), 999)
    const result = await inspected(directory)
    expect(result.ignored.count).toBe(22)
    expect(result.ignored.bytes).toBe(5000 + (21 * 22) / 2)
    expect(result.ignored.truncated).toBe(true)
    expect(result.ignored.entries).toHaveLength(20)
    expect(result.ignored.entries.slice(0, 3)).toEqual([
      { path: "build/", bytes: 5000 },
      { path: "run-21.log", bytes: 21 },
      { path: "run-20.log", bytes: 20 },
    ])
    expect(result.ignored.entries.at(-1)).toEqual({ path: "run-3.log", bytes: 3 })
    const fewer = await inspected(directory, { top: 30 })
    expect([fewer.ignored.entries.length, fewer.ignored.truncated]).toEqual([22, false])
  })

  test("a walk that runs out of budget says partial", async () => {
    const directory = worktree("budget")
    await write(path.join(directory, "build", "a", "b", "c.bin"), 7)
    const result = await inspected(directory, { entries: 1 })
    expect(result.scan).toBe("partial")
    expect((await inspected(directory)).scan).toBe("complete")
  })

  test("breadth-first: a shallow repository is found before the budget goes into a deep ignored tree", async () => {
    const directory = worktree("breadth")
    // 40 ignored chains six folders deep (240 entries) next to a repository two levels down.
    for (let chain = 0; chain < 40; chain++)
      await fs.mkdir(path.join(directory, "build", `d${chain}`, "a", "b", "c", "d", "e"), { recursive: true })
    const lib = path.join(directory, "a-lib", "lib")
    await fs.mkdir(lib, { recursive: true })
    git(lib, "init", "-q", "-b", "main")
    const result = await inspected(directory, { entries: 100 })
    expect({ nested: result.nested, scan: result.scan }).toEqual({
      nested: [{ path: lib, kind: "repository" }],
      scan: "partial",
    })
  })

  test("refused: the root, an unlisted folder, a relative path; a root outside Git is not_git", async () => {
    const plain = path.join(tmp, "plain")
    await fs.mkdir(plain, { recursive: true })
    for (const directory of [root, path.join(root, "."), plain, "repo", path.join(tmp, "missing")]) {
      const result = await WorktreeInspect.inspect({ root, directory })
      expect({ directory, result }).toMatchObject({ directory, result: { ok: false, error: "not_found" } })
    }
    const outside = await WorktreeInspect.inspect({ root: plain, directory: path.join(tmp, "clean") })
    expect(outside).toMatchObject({ ok: false, error: "not_git", directory: plain })
    const relative = await WorktreeInspect.inspect({ root: "repo", directory: path.join(tmp, "clean") })
    expect(relative).toMatchObject({ ok: false, error: "not_git", directory: "repo" })
  })

  test("UNC and device paths are refused before Git or the file system is asked", async () => {
    const remote = ["\\\\host\\share\\repo", "//host/share/repo", "\\\\?\\D:\\repo", "\\\\.\\pipe\\x"]
    for (const value of remote) {
      expect(await WorktreeInspect.inspect({ root: value, directory: path.join(tmp, "clean") })).toMatchObject({
        ok: false,
        error: "not_found",
        directory: value,
      })
      expect(await WorktreeInspect.inspect({ root, directory: value })).toMatchObject({
        ok: false,
        error: "not_found",
        directory: value,
      })
    }
  })

  test("a listed worktree inside the root without its .git file is not_git, never the root's status", async () => {
    const directory = path.join(root, ".worktrees", "broken")
    git(root, "worktree", "add", "--detach", directory, "main")
    await fs.rm(path.join(directory, ".git"))
    const result = await WorktreeInspect.inspect({ root, directory })
    expect(result).toMatchObject({ ok: false, error: "not_git", directory })
  })

  test("the RPC handler reads only the project's worktree table folders and answers declared errors", async () => {
    const plain = path.join(tmp, "plain")
    const clean = path.join(tmp, "clean")
    const projects: Record<string, string[]> = { prj_1: [root, clean, plain], prj_2: [plain] }
    const listed: string[] = []
    await using t = await testDeps({
      ctx: {
        worktree: {
          list: async (input: { readonly projectID: string }) => {
            listed.push(input.projectID)
            const rows = projects[input.projectID]
            if (!rows) throw new Error("Project not found")
            return rows.map((directory) => ({ directory }))
          },
        },
      },
    })
    const inspect = WorktreeRpc.handlers(t.deps)["worktree.inspect"]
    const call = (projectID: string, rootFolder: string, directory: string) =>
      inspect({ projectID, root: rootFolder, directory }, rpcContext<"worktree.inspect">())

    // Folders outside the table, an unknown project and another project's table never reach Git.
    const outer = path.join(tmp, "outer")
    expect(failure(await call("prj_1", root, outer))).toMatchObject({ type: "not_found", data: { directory: outer } })
    expect(failure(await call("prj_x", root, clean))).toMatchObject({ type: "not_found", data: { directory: root } })
    expect(failure(await call("prj_2", root, clean))).toMatchObject({ type: "not_found", data: { directory: root } })
    expect(listed).toEqual(["prj_1", "prj_x", "prj_2"])

    expect(failure(await call("prj_1", root, root))).toMatchObject({ type: "not_found", data: { directory: root } })
    expect(failure(await call("prj_2", plain, plain))).toMatchObject({ type: "not_git", data: { directory: plain } })
    // The table's spelling and the caller's may differ in case and slashes on Windows.
    const answer = await call("prj_1", root, WINDOWS ? clean.toUpperCase().replaceAll("\\", "/") : clean)
    expect(failure(answer)).toBeUndefined()
    expect(answer).toMatchObject({ nested: [], scan: "complete", lock: null })
  })

  test.skipIf(!WINDOWS)("Windows: case and slash spellings of the root and the worktree match", async () => {
    const directory = path.join(tmp, "clean")
    const spelled = directory.toUpperCase().replaceAll("\\", "/")
    const result = await WorktreeInspect.inspect({ root: root.toLowerCase(), directory: spelled })
    expect(result).toMatchObject({ ok: true, inspection: { nested: [], scan: "complete" } })
    const rootSpelled = await WorktreeInspect.inspect({ root, directory: `${root.toUpperCase()}\\` })
    expect(rootSpelled).toMatchObject({ ok: false, error: "not_found" })
  })

  test("junctions are not followed: a link to another repository is neither nested nor sized", async () => {
    const directory = worktree("linked")
    const other = path.join(tmp, "other")
    await fs.mkdir(other, { recursive: true })
    git(other, "init", "-q", "-b", "main")
    await write(path.join(other, "big.bin"), 4096)
    // A junction needs no Developer Mode or admin rights on Windows; elsewhere this is a plain directory symlink.
    await fs.symlink(other, path.join(directory, "link"), "junction")
    const result = await inspected(directory)
    expect(result.nested).toEqual([])
    // Git names a junction `link/` and a symlink `link`; either way nothing behind it is counted.
    expect(result.ignored).toMatchObject({ count: 1, bytes: 0 })
    expect(result.scan).toBe("complete")
  })

  test("symlinks are not followed either (skipped when the OS refuses to create one)", async () => {
    const directory = worktree("symlinked")
    const created = await fs.symlink(root, path.join(directory, "link"), "dir").then(
      () => true,
      () => false,
    )
    if (!created) return
    const result = await inspected(directory)
    expect(result.nested).toEqual([])
    expect(result.ignored).toMatchObject({ count: 1, bytes: 0 })
  })
})

describe("parseList (git worktree list --porcelain -z)", () => {
  test("main first, lock reasons may hold newlines, prunable entries are marked", () => {
    const stdout = [
      "worktree D:/repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0",
      "worktree D:/repo/.worktrees/a\0HEAD 2222222222222222222222222222222222222222\0detached\0locked own.team area:ar_x\nsecond line\0\0",
      "worktree D:/gone\0HEAD 3333333333333333333333333333333333333333\0detached\0locked\0prunable gitdir file points to non-existent location\0\0",
    ].join("")
    expect(WorktreeInspect.parseList(stdout)).toEqual([
      { path: "D:/repo", locked: undefined, prunable: false },
      { path: "D:/repo/.worktrees/a", locked: "own.team area:ar_x\nsecond line", prunable: false },
      { path: "D:/gone", locked: "", prunable: true },
    ])
  })
})

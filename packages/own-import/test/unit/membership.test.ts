import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SelfHttp } from "../../src/http.js"
import { Scan } from "../../src/index/scan.js"
import { Paths } from "../../src/sources/paths.js"
import { removeTree } from "../support/remove.js"

/**
 * Project folders and membership (IM-D3, 09 §2.2, IG3): the folders core recorded for a project plus the linked
 * worktrees `git worktree list` reports in each of them, so two clones of one root commit (one Project ID) and both
 * clones' worktrees count; a conversation belongs when one of its cwds equals or lies below one of them, by real path
 * when both exist and by normalized string otherwise. Real repositories are made in a temp folder with `git -c …`
 * only (nothing in the user's git configuration is read or changed for the commits).
 */

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => removeTree(dir)))
})

async function temp(name = "own-import-git-한글 #") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), name))
  temps.push(dir)
  return dir
}

function project(id: string, canonical: string, sandboxes: ReadonlyArray<string> = []): SelfHttp.ProjectView {
  return { id, canonical, sandboxes: [...sandboxes] }
}

describe("git worktree list", () => {
  test("the porcelain -z output gives every checkout, prunable ones too", () => {
    const stdout = [
      "worktree C:/work/proj",
      "HEAD 0000000000000000000000000000000000000000",
      "branch refs/heads/main",
      "",
      "worktree C:/work/proj/.worktrees/cl-perf",
      "HEAD 1111111111111111111111111111111111111111",
      "detached",
      "locked own: busy",
      "",
      "worktree D:/gone",
      "prunable gitdir file points to non-existent location",
      "",
      "",
    ].join("\0")
    expect(Scan.parseWorktrees(stdout)).toEqual(["C:\\work\\proj", "C:\\work\\proj\\.worktrees\\cl-perf", "D:\\gone"])
  })

  test("a folder that is not a repository, or a missing one, gives none", async () => {
    const dir = await temp()
    expect(await Scan.gitWorktrees(dir)).toEqual([])
    expect(await Scan.gitWorktrees(path.join(dir, "missing"))).toEqual([])
  })
})

describe("project folders", () => {
  const base = {
    git: async (folder: string) =>
      Paths.key(folder) === Paths.key("C:\\work\\proj") ? ["C:/work/proj", "C:/work/proj/.worktrees/cl-perf"] : [],
    resolve: () => undefined,
  }

  test("recorded folders, sandboxes and each folder's git worktrees; subfolders of any of them resolve", async () => {
    const finder = Scan.projects({
      ...base,
      list: async () => [project("prj_a", "C:\\work\\proj", ["E:\\sandbox\\proj"]), project("prj_b", "C:\\other")],
      worktrees: async (id) => (id === "prj_a" ? ["C:\\work\\proj", "D:\\#Projects\\proj"] : []),
    })
    const resolved = await finder.resolve("D:/#Projects/proj/packages/core")
    expect(resolved).toEqual({
      ok: true,
      project: {
        id: "prj_a",
        root: "C:\\work\\proj",
        folders: [
          "C:\\work\\proj",
          "E:\\sandbox\\proj",
          "D:\\#Projects\\proj",
          "C:\\work\\proj\\.worktrees\\cl-perf",
        ],
      },
    })
    expect(await finder.resolve("c:\\WORK\\proj\\")).toMatchObject({ ok: true, project: { id: "prj_a" } })
    expect(await finder.resolve("\\\\?\\C:\\other\\x")).toMatchObject({ ok: true, project: { id: "prj_b" } })
  })

  test("a linked worktree core never recorded is found through git; other folders are directory_unknown", async () => {
    const finder = Scan.projects({
      ...base,
      list: async () => [project("prj_a", "C:\\work\\proj")],
      worktrees: async () => ["C:\\work\\proj"],
    })
    expect(await finder.resolve("C:\\work\\proj\\.worktrees\\cl-perf\\src")).toMatchObject({
      ok: true,
      project: { id: "prj_a" },
    })
    expect(await finder.resolve("C:\\work\\proj2")).toEqual({ ok: false, reason: "directory_unknown" })
    expect(await finder.resolve("C:\\work")).toEqual({ ok: false, reason: "directory_unknown" })
  })

  test("a repository nested in another is its own project", async () => {
    const finder = Scan.projects({
      ...base,
      list: async () => [project("prj_outer", "C:\\work"), project("prj_inner", "C:\\work\\proj\\vendor\\lib")],
      worktrees: async () => [],
    })
    expect(await finder.resolve("C:\\work\\proj\\vendor\\lib\\src")).toMatchObject({ project: { id: "prj_inner" } })
    expect(await finder.resolve("C:\\work\\proj\\src")).toMatchObject({ project: { id: "prj_outer" } })
  })

  test("a service that did not answer is unavailable and asked again; answers are kept for a while", async () => {
    const calls = { list: 0 }
    const answers: Array<ReadonlyArray<SelfHttp.ProjectView> | undefined> = [undefined, [project("prj_a", "C:\\p")]]
    const finder = Scan.projects({
      ...base,
      list: async () => answers[calls.list++],
      worktrees: async () => [],
    })
    expect(await finder.resolve("C:\\p")).toEqual({ ok: false, reason: "unavailable" })
    expect(await finder.resolve("C:\\p")).toMatchObject({ ok: true })
    expect(await finder.resolve("C:\\p")).toMatchObject({ ok: true })
    expect(calls.list).toBe(2)
  })
})

describe("membership (09 §2.2 속함)", () => {
  const folders = ["C:\\work\\proj", "C:\\work\\proj\\.worktrees\\cl-perf", "D:\\#Projects\\한글 프로젝트"]
  const none: Paths.Realpath = () => undefined

  test("strings: \\\\?\\ and UNC prefixes, case, separators, trailing separators, subfolders, Hangul and #", () => {
    for (const cwd of [
      "\\\\?\\C:\\work\\proj",
      "C:/work/proj/",
      "c:\\WORK\\Proj\\packages\\core",
      "C:\\work\\proj\\.worktrees\\cl-perf\\x",
      "file:///D:/%23Projects/%ED%95%9C%EA%B8%80%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/src",
      "D:\\#Projects\\한글 프로젝트",
    ])
      expect([cwd, Scan.belongs([cwd], folders, none)]).toEqual([cwd, true])
    for (const cwd of ["C:\\work\\proj2", "C:\\work", "C:\\other\\work\\proj", "\\\\?\\UNC\\server\\share\\proj", ""])
      expect([cwd, Scan.belongs([cwd], folders, none)]).toEqual([cwd, false])
    expect(Scan.belongs(["\\\\?\\UNC\\server\\share\\proj\\a"], ["\\\\server\\share\\proj"], none)).toBe(true)
  })

  test("any of a conversation's cwds is enough (Claude Code moves between folders)", () => {
    expect(Scan.belongs(["E:\\elsewhere", "C:\\work\\proj\\.worktrees\\cl-perf"], folders, none)).toBe(true)
    expect(Scan.belongs([], folders, none)).toBe(false)
  })

  test("real paths when both exist: a junction into the project, and a subst drive (injected)", async () => {
    const dir = await temp()
    const real = path.join(dir, "한글 #proj")
    await fsp.mkdir(path.join(real, "src"), { recursive: true })
    const link = path.join(dir, "link")
    fs.symlinkSync(real, link, "junction")
    expect(Scan.belongs([path.join(link, "src")], [real], Paths.realpath)).toBe(true)
    expect(Scan.belongs([path.join(link, "src")], [real], none)).toBe(false)
    // A folder that is gone is matched by its string.
    expect(Scan.belongs([path.join(real, "deleted", "x")], [real], Paths.realpath)).toBe(true)
    const subst: Paths.Realpath = (input) =>
      Paths.key(input).startsWith("s:") ? Paths.norm(input).replace(/^S:/i, "C:\\work") : Paths.norm(input)
    expect(Scan.belongs(["S:\\proj\\src"], ["C:\\work\\proj"], subst)).toBe(true)
  })

  test("remembered real paths: one lookup per path for a whole pass", () => {
    const seen: string[] = []
    const memo = Scan.remember((input) => {
      seen.push(input)
      return undefined
    })
    for (let index = 0; index < 50; index++) Scan.belongs(["C:\\x", "C:\\work\\proj\\a"], folders, memo)
    expect(seen.toSorted()).toEqual(["C:\\work\\proj\\a", "C:\\x", ...folders].toSorted())
  })
})

describe("two clones of one root commit (IG3, real git)", () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=own-import fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        "-c",
        `core.hooksPath=${path.join(cwd, ".no-hooks")}`,
        ...args,
      ],
      { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  }

  test("both clones and each clone's worktrees are one project's folders", async () => {
    const dir = await temp()
    const first = path.join(dir, "own-open-code")
    const second = path.join(dir, "#Projects", "own-open-code")
    await fsp.mkdir(first, { recursive: true })
    await fsp.mkdir(path.dirname(second), { recursive: true })
    git(first, "init", "-q")
    await fsp.writeFile(path.join(first, "README.md"), "fixture\n")
    git(first, "add", "README.md")
    git(first, "commit", "-q", "-m", "root")
    git(dir, "clone", "-q", first, second)
    git(first, "worktree", "add", "-q", "-b", "wt-first", path.join(first, ".worktrees", "first-wt"))
    git(second, "worktree", "add", "-q", "-b", "wt-second", path.join(second, ".worktrees", "cl-perf"))

    // Core gives both clones one Project ID and records both checkouts (the worktree table), not their worktrees.
    const finder = Scan.projects({
      list: async () => [project("prj_root_commit", first)],
      worktrees: async () => [first, second],
    })
    const resolved = await finder.resolve(path.join(second, ".worktrees", "cl-perf"))
    if (!resolved.ok) throw new Error(resolved.reason)
    const keys = resolved.project.folders.map((folder) => Paths.key(fs.realpathSync.native(folder)))
    expect(keys.toSorted()).toEqual(
      [first, second, path.join(first, ".worktrees", "first-wt"), path.join(second, ".worktrees", "cl-perf")]
        .map((folder) => Paths.key(fs.realpathSync.native(folder)))
        .toSorted(),
    )
    const memo = Scan.remember()
    expect(Scan.belongs([path.join(second, ".worktrees", "cl-perf", "src")], resolved.project.folders, memo)).toBe(true)
    expect(Scan.belongs([path.join(first, ".worktrees", "first-wt")], resolved.project.folders, memo)).toBe(true)
    expect(Scan.belongs([path.join(dir, "elsewhere")], resolved.project.folders, memo)).toBe(false)
    // The git calls changed nothing in the repositories.
    expect(await Scan.gitWorktrees(first)).toHaveLength(2)
    // Real git runs (a repository, a clone, two worktrees, the scan's own): about 3 s alone, near bun's 5 s default.
  }, 30_000)
})

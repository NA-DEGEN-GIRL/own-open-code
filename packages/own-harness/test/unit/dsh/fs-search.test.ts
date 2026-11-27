// dsh's search fixes of upstream f3803c9697 (src/dsh/search.ts): `glob` prunes unrelated folders when the pattern's
// folders are plain names (ef284800b9, e8bdbbe823, b1c8c9bbbc, f9ef03834a) and `grep` takes an empty `include` as none
// (080a2c60b3, 4e4badb8f3). Cases follow packages/fs/tool-fs-search/tests/{integration,tools}.spec.ts; with real
// ripgrep, every pruned search must list exactly what the unpruned one lists.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ f3803c9697; see dsh-data/NOTICE.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DshSearch } from "../../../src/dsh/search.js"

const VCS = DshSearch.GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`])

describe("glob argv", () => {
  test("a plain folder prefix adds !** and the folder names, before the pattern", () => {
    expect(DshSearch.globCommand({ pattern: "packages/core/src/*.ts" })).toEqual([
      "--files",
      "--glob=!**",
      "--glob={packages,core,src}/",
      "--glob=packages/core/src/*.ts",
      "--sort=modified",
      "--no-ignore",
      "--hidden",
      ...VCS,
    ])
    // Repeated names are listed once; a dash, a dot inside a name and a space are plain.
    expect(DshSearch.globCommand({ pattern: "a/b/a/*.ts" }).slice(1, 3)).toEqual(["--glob=!**", "--glob={a,b}/"])
    expect(DshSearch.globCommand({ pattern: "-/*.ts" }).slice(1, 3)).toEqual(["--glob=!**", "--glob={-}/"])
    expect(DshSearch.globCommand({ pattern: "notes.md/*.ts" })).toContain("--glob={notes.md}/")
    expect(DshSearch.globCommand({ pattern: "spaced dir/*.ts" })).toContain("--glob={spaced dir}/")
    // Case is kept: ripgrep's globs stay case-sensitive.
    expect(DshSearch.globCommand({ pattern: "SRC/*.ts" })).toContain("--glob={SRC}/")
  })

  test.each([
    "*.ts",
    "**/*.ts",
    "src/**/*.ts",
    "!src/*.ts",
    "./src/*.ts",
    "src/../src/*.ts",
    ".git/*.ts",
    "a/.jj/*.ts",
  ])("%s keeps the whole traversal", (pattern) => {
    expect(DshSearch.globCommand({ pattern })).toEqual([
      "--files",
      `--glob=${pattern}`,
      "--sort=modified",
      "--no-ignore",
      "--hidden",
      ...VCS,
    ])
  })

  test("an explicit path stays the only search root, without pruning", () => {
    expect(DshSearch.globCommand({ pattern: "src/*.ts", path: "." })).toEqual([
      "--files",
      "--glob=src/*.ts",
      "--sort=modified",
      "--no-ignore",
      "--hidden",
      ...VCS,
      "--",
      ".",
    ])
  })

  // [folders, name length, argv bytes the pruning adds]: 8 KiB is the budget; past it the traversal is the original.
  test.each([
    [1, 8170, 8192],
    [1, 8171, 0],
    [1500, 1, 23],
    [16, 240, 262],
  ])("%i folders of length %i add %i argv bytes", (depth, length, bytes) => {
    const pattern = `${Array.from({ length: depth }, () => "a".repeat(length)).join("/")}/*.ts`
    const argv = DshSearch.globCommand({ pattern })
    const pruning = argv.slice(1, argv.indexOf(`--glob=${pattern}`))
    expect(pruning.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0)).toBe(bytes)
  })
})

describe("grep include", () => {
  test("an exact empty include is no filter; whitespace alone still fails", () => {
    expect(DshSearch.grepArgs({ pattern: "alpha", include: "" })).toBeUndefined()
    expect(DshSearch.grepCommand({ pattern: "alpha", path: ".", include: "" })).toEqual([
      "--json",
      "--regexp=alpha",
      "--",
      ".",
    ])
    expect(DshSearch.grepCommand({ pattern: "alpha", include: "" })).toEqual(
      DshSearch.grepCommand({ pattern: "alpha" }),
    )
    expect(DshSearch.grepArgs({ pattern: "alpha", include: "  " })).toBe("include must be a non-empty glob when given")
    expect(DshSearch.grepArgs({ pattern: "", include: "" })).toBe("pattern must be a non-empty string")
    expect(DshSearch.grepArgs({ pattern: "x", path: "  ", include: "" })).toBe(
      "path must be a non-empty string when given",
    )
  })
})

describe.skipIf(DshSearch.ripgrep() === undefined)("pruned glob over real ripgrep", () => {
  const state = { dir: "" }

  beforeEach(() => {
    state.dir = mkdtempSync(path.join(tmpdir(), "own-dsh-search-"))
    const write = (file: string, text = "") => {
      mkdirSync(path.dirname(path.join(state.dir, file)), { recursive: true })
      writeFileSync(path.join(state.dir, file), text)
    }
    write("src/alpha.ts", "export const alpha = 1\n")
    write("src/beta.ts", "export const beta = 2\n")
    write("notes.md", "alpha appears here too\n")
    write(".hidden.ts")
    write(".git/config.ts", "never listed\n")
    write("spaced dir/wei'rd name.ts")
    write("packages/core/src/old.ts")
    write("packages/core/src/.hidden.ts")
    write("packages/core/src/nested/other.ts")
    write("packages/src/core/other.ts")
    write("-/file.ts")
    write(".gitignore", "packages/\n")
    utimesSync(path.join(state.dir, "src", "alpha.ts"), new Date(2000, 0, 1), new Date(2000, 0, 1))
    utimesSync(path.join(state.dir, "src", "beta.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1))
    utimesSync(path.join(state.dir, "packages", "core", "src", "old.ts"), new Date(2000, 0, 1), new Date(2000, 0, 1))
  })

  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true })
  })

  async function listed(argv: ReadonlyArray<string>) {
    const ran = await DshSearch.run("glob", argv, state.dir)
    if (!ran.ok) throw new Error(ran.message)
    return ran.noMatches ? [] : DshSearch.globPaths(ran.stdout, state.dir)
  }

  /** The pruned search and the same search without the two pruning arguments. */
  async function both(pattern: string) {
    const argv = DshSearch.globCommand({ pattern })
    expect(argv[1]).toBe("--glob=!**")
    return { pruned: await listed(argv), whole: await listed([argv[0]!, ...argv.slice(3)]) }
  }

  test("a literal prefix lists the same files, ignored and hidden ones included, in modification order", async () => {
    const result = await both("packages/core/src/*.ts")
    expect(result.pruned).toEqual([
      path.join("packages", "core", "src", "old.ts"),
      path.join("packages", "core", "src", ".hidden.ts"),
    ])
    expect(result.pruned).toEqual(result.whole)
    const src = await both("src/*.ts")
    expect(src.pruned).toEqual([path.join("src", "alpha.ts"), path.join("src", "beta.ts")])
    expect(src.pruned).toEqual(src.whole)
  }, 60_000)

  test("a folder named - and a spaced folder are searched; missing folders and files find nothing", async () => {
    for (const pattern of ["-/*.ts", "spaced dir/*.ts", "missing/*.ts", "notes.md/*.ts", "src/alpha.ts/*.ts"]) {
      const result = await both(pattern)
      expect(result.pruned).toEqual(result.whole)
    }
    expect((await both("-/*.ts")).pruned).toEqual([path.join("-", "file.ts")])
    expect((await both("spaced dir/*.ts")).pruned).toEqual([path.join("spaced dir", "wei'rd name.ts")])
    expect((await both("missing/*.ts")).pruned).toEqual([])
  }, 60_000)

  test("case stays significant; a deeper literal prefix lists the same files", async () => {
    expect((await both("SRC/*.ts")).pruned).toEqual((await both("SRC/*.ts")).whole)
    const nested = await both("packages/core/src/nested/*.ts")
    expect(nested.pruned).toEqual([path.join("packages", "core", "src", "nested", "other.ts")])
    expect(nested.pruned).toEqual(nested.whole)
  }, 60_000)

  test("pruning adds no search root and follows no folder link", async () => {
    mkdirSync(path.join(state.dir, "src", "nested"))
    writeFileSync(path.join(state.dir, "src", "nested", "file.ts"), "")
    symlinkSync(path.join(state.dir, "src"), path.join(state.dir, "linked"), "junction")
    const argv = DshSearch.globCommand({ pattern: "linked/nested/*.ts" })
    expect(argv).not.toContain("--")
    const result = await both("linked/nested/*.ts")
    expect(result.pruned).toEqual([])
    expect(result.pruned).toEqual(result.whole)
  }, 60_000)

  test("a large unrelated node_modules is skipped and the result is the same", async () => {
    Array.from({ length: 100 }, (_, index) => {
      const folder = path.join(state.dir, "node_modules", `dep-${index}`, "src")
      mkdirSync(folder, { recursive: true })
      Array.from({ length: 10 }, (_, file) => writeFileSync(path.join(folder, `file-${file}.ts`), ""))
    })
    const result = await both("packages/core/src/*.ts")
    expect(result.pruned).toEqual(result.whole)
    expect(result.pruned).toHaveLength(2)
  }, 60_000)
})

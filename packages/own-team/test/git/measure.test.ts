import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Cone } from "../../src/git/cone.js"
import { Lfs } from "../../src/git/lfs.js"
import { Measure } from "../../src/git/measure.js"
import { F2_HEAVY, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { f1, git, init, temp, write } from "../fixtures/repo.js"
import { F3_HEAVY, synthetic } from "../fixtures/synthetic.js"

const SLOW = 180_000
const MiB = 1024 ** 2

const box = temp()
afterAll(() => box.dispose())

function row(dir: string, extra: Partial<Measure.Row> = {}): Measure.Row {
  return {
    dir,
    depth: dir.split("/").length,
    files: 1,
    gitBytes: 0,
    lfsBytes: 0,
    lfsMissing: 0,
    bytes: 0,
    bigFiles: 0,
    binaryRatio: null,
    extensions: [],
    ...extra,
  }
}

async function measured(
  directory: string,
  rev: string,
  options?: { readonly ignoredMs?: number; readonly expandBytes?: number },
) {
  const result = await Measure.measure(directory, rev, options)
  if (!result.ok) throw new Error(result.message)
  return result
}

function find(result: Measure.Result, dir: string) {
  const found = result.rows.find((item) => item.dir === dir)
  if (!found) throw new Error(`no row ${dir}: ${result.rows.map((item) => item.dir).join(", ")}`)
  return found
}

describe("ruleBasedHeavy (06 §3.4)", () => {
  const lfs = (dir: string, bytes: number) => row(dir, { bytes, lfsBytes: bytes, binaryRatio: 1 })
  const code = (dir: string, bytes: number) => row(dir, { bytes, binaryRatio: 0 })

  test("at least 50 MB and (binary ratio >= 0.8 or LFS >= half)", () => {
    expect(Measure.qualifies(row("a", { bytes: 60 * MiB, binaryRatio: 0.85 }))).toBe(true)
    expect(Measure.qualifies(row("a", { bytes: 60 * MiB, binaryRatio: 0.5, lfsBytes: 30 * MiB }))).toBe(true)
    expect(Measure.qualifies(row("a", { bytes: 60 * MiB, binaryRatio: 0.79, lfsBytes: 29 * MiB }))).toBe(false)
    expect(Measure.qualifies(row("a", { bytes: 60 * MiB, binaryRatio: null }))).toBe(false)
    expect(Measure.qualifies(row("a", { bytes: 49 * MiB, binaryRatio: 1, lfsBytes: 49 * MiB }))).toBe(false)
  })

  test("06 §0.4: Unity folders under Assets, Scripts left in", () => {
    const rows = [
      row("Assets", { bytes: 14_700 * MiB, lfsBytes: 14_660 * MiB, binaryRatio: 0.99 }),
      lfs("Assets/Textures", 9_200 * MiB),
      lfs("Assets/Audio", 3_100 * MiB),
      lfs("Assets/Models", 2_400 * MiB),
      code("Assets/Scripts", 40 * MiB),
      lfs("Assets/Textures/UI", 120 * MiB),
      code("src", 2 * MiB),
    ]
    expect(Measure.ruleBasedHeavy(rows)).toEqual(["Assets/Audio", "Assets/Models", "Assets/Textures"])
  })

  test("a folder whose listed subfolders are all binary is taken whole; empty ones do not split it", () => {
    const rows = [
      lfs("Content", 900 * MiB),
      lfs("Content/d0", 300 * MiB),
      lfs("Content/d1", 300 * MiB),
      row("Content/empty", { bytes: 0 }),
      lfs("Content/small", 1 * MiB),
    ]
    expect(Measure.ruleBasedHeavy(rows)).toEqual(["Content"])
  })

  test("a folder with code files of its own is never taken whole (06 §4.4, 2026-10-09)", () => {
    const direct = (bytes: number, binaryRatio: number | null, lfsBytes = 0) => ({
      files: 2,
      bytes,
      lfsBytes,
      binaryRatio,
    })
    const rows = [
      // Art holds 2 MB of scripts directly beside its LFS subfolders: the walk goes in.
      { ...lfs("Art", 900 * MiB), direct: direct(2 * MiB, 0) },
      { ...lfs("Art/Models", 600 * MiB), direct: direct(600 * MiB, 1, 600 * MiB) },
      { ...lfs("Art/Sounds", 298 * MiB), direct: direct(298 * MiB, 1, 298 * MiB) },
      // A Unity folder's own `.meta` files are text but tiny next to its LFS files: still binary.
      { ...lfs("Textures", 400 * MiB), direct: direct(400 * MiB, null, 399 * MiB) },
      // Rows made by hand (no `direct`) keep the old answer.
      lfs("Content", 300 * MiB),
    ]
    expect(Measure.ruleBasedHeavy(rows)).toEqual(["Art/Models", "Art/Sounds", "Content", "Textures"])
  })

  test("mostly binary non-LFS folders by ratio; never the root", () => {
    const rows = [
      row("", { depth: 0, bytes: 900 * MiB, binaryRatio: 1 }),
      row("data", { bytes: 300 * MiB, binaryRatio: 0.9 }),
      row("logs", { bytes: 300 * MiB, binaryRatio: 0.1 }),
      row("logs/raw", { bytes: 200 * MiB, binaryRatio: 0.95 }),
      row("unknown", { bytes: 300 * MiB, binaryRatio: null }),
    ]
    expect(Measure.ruleBasedHeavy(rows)).toEqual(["data", "logs/raw"])
  })
})

describe("forced (06 §4.4 강제 포함)", () => {
  test("root files and the files directly inside folders around cone folders", () => {
    const direct = {
      "": { files: 2, bytes: 10 },
      Assets: { files: 1, bytes: 5 },
      "Assets/Textures": { files: 9, bytes: 9_000 },
      "Assets/Scripts": { files: 3, bytes: 30 },
      Content: { files: 4, bytes: 400 },
      "Content/Only": { files: 1, bytes: 100 },
      src: { files: 7, bytes: 70 },
    }
    // Content's only subfolder is heavy, so no cone folder is inside Content and its own files stay out.
    expect(Measure.forced({ direct }, ["Assets/Textures", "Content/Only"])).toEqual({ files: 3, bytes: 15 })
    expect(Measure.forced({ direct }, [])).toEqual({ files: 2, bytes: 10 })
  })
})

describe("F1: code repository (TG2 observation)", () => {
  const repo = f1(path.join(box.root, "f1"))
  fs.appendFileSync(path.join(repo.home, ".git", "info", "exclude"), "/node_modules/\n/.worktrees/\n/vendor/\n")
  write(repo.home, {
    "node_modules/a/index.js": "a".repeat(1_000),
    "node_modules/a/lib/b.js": "b".repeat(2_000),
    "vendor/lib/x.c": "c".repeat(500),
  })
  // An independent repository inside an ignored folder, a nested worktree, and a junction: none are weighed.
  git(path.join(repo.home, "vendor", "lib"), ["init", "-q"])
  git(repo.home, ["worktree", "add", "-q", "-b", "nested", path.join(repo.home, ".worktrees", "nested"), repo.head])
  const outside = path.join(box.root, "f1-outside")
  write(outside, { "big.bin": "z".repeat(50_000) })
  fs.symlinkSync(outside, path.join(repo.home, "node_modules", "linked"), "junction")

  test(
    "table, totals and the ignored folders on disk",
    async () => {
      const result = await measured(repo.home, repo.head)
      expect(result.total).toMatchObject({ dir: "", files: 10, lfsBytes: 0, lfsMissing: 0, bigFiles: 0 })
      expect(result.total.bytes).toBe(result.total.gitBytes)
      expect(result.rows.map((item) => item.dir).toSorted()).toEqual([
        "-dash",
        "docs",
        "src",
        "src/app",
        "src/lib",
        "tools",
      ])
      expect(find(result, "src")).toMatchObject({ depth: 1, files: 3, extensions: ["ts"] })
      expect(result.binary).toBe("not-needed")
      expect(find(result, "src").binaryRatio).toBeNull()
      // README.md, package.json and the README-link.md link.
      expect(result.direct[""].files).toBe(3)
      expect(Measure.ruleBasedHeavy(result.rows)).toEqual([])
      expect(Measure.forced(result, [])).toEqual(result.direct[""])
      // The junction to f1-outside (50 kB) is not followed; vendor/lib is a repository of its own.
      expect(result.ignored).toEqual([
        { dir: "node_modules", files: 2, bytes: 3_000, complete: true, repos: 0 },
        { dir: ".worktrees", files: 0, bytes: 0, complete: true, repos: 1 },
        { dir: "vendor", files: 0, bytes: 0, complete: true, repos: 1 },
      ])
    },
    SLOW,
  )

  test(
    "ignored folders past the time limit are lower bounds",
    async () => {
      const result = await measured(repo.home, repo.head, { ignoredMs: 0 })
      expect(result.ignored.map((item) => item.complete)).toEqual([false, false, false])
    },
    SLOW,
  )

  test(
    "an unknown revision is an error, not a throw",
    async () => {
      expect(await Measure.measure(repo.home, "no-such-rev")).toMatchObject({ ok: false })
    },
    SLOW,
  )
})

describe("deeper rows below large folders and the files directly inside (06 §4.4, 2026-10-09)", () => {
  const home = init(path.join(box.root, "deep"))
  // A NUL byte first: git calls a blob binary when one is in its first 8000 bytes.
  const noise = (bytes: number, seed: number) =>
    Uint8Array.from({ length: bytes }, (_, index) => (index === 0 ? 0 : (index * 7919 + seed * 104729) % 256))
  write(home, {
    "src/main.ts": "export const main = 1\n",
    // Four levels down, under a parent that is far below 5% of all bytes once `big/` is there.
    "game/levels/forest/textures/bark.bin": noise(30_000, 1),
    "game/levels/forest/textures/leaf.bin": noise(30_000, 2),
    "game/levels/forest/textures/deeper/moss.bin": noise(30_000, 3),
    "game/levels/forest/level.json": '{ "name": "forest" }\n',
    "big/blob.bin": noise(3_000_000, 4),
  })
  git(home, ["add", "-A"])
  git(home, ["commit", "-q", "-m", "deep"])
  const rev = git(home, ["rev-parse", "HEAD"]).trim()

  test(
    "children of a folder of at least `expandBytes` are listed down to four levels, with their own files' share",
    async () => {
      const plain = await measured(home, rev, { ignoredMs: 0 })
      expect(plain.rows.some((item) => item.dir === "game/levels/forest")).toBe(false)
      const deep = await measured(home, rev, { ignoredMs: 0, expandBytes: 50_000 })
      expect(find(deep, "game/levels/forest").depth).toBe(3)
      const textures = find(deep, "game/levels/forest/textures")
      expect(textures.depth).toBe(Measure.DEEP_DEPTH)
      expect(textures.direct).toMatchObject({ files: 2, bytes: 60_000, binaryRatio: 1 })
      // The fifth level is not listed: only folders down to DEEP_DEPTH.
      expect(deep.rows.some((item) => item.dir === "game/levels/forest/textures/deeper")).toBe(false)
      // `forest` has a JSON file of its own: text, so it would never be taken whole.
      expect(find(deep, "game/levels/forest").direct).toMatchObject({ files: 1, binaryRatio: 0 })
    },
    SLOW,
  )
})

describe.skipIf(!lfsAvailable)("F2: LFS repository", () => {
  test(
    "LFS bytes from pointers, every object missing locally until fetched",
    async () => {
      // Built in the test: a describe that is skipped (no git-lfs, dev-host) still runs its body.
      const repo = f2(path.join(box.root, "f2"))
      const result = await measured(repo.home, repo.head)
      const all = Object.values(F2_LFS).reduce((sum, size) => sum + size, 0)
      expect(result.total).toMatchObject({ files: 14, lfsBytes: all, lfsMissing: all })
      expect(find(result, "Assets/Textures")).toMatchObject({
        depth: 2,
        files: 2,
        lfsBytes: 110_000,
        lfsMissing: 110_000,
        bytes: 110_000,
        binaryRatio: 1,
        extensions: ["png"],
      })
      expect(find(result, "Assets/Textures").gitBytes).toBeLessThan(2 * Lfs.POINTER_MAX_BYTES)
      expect(find(result, "Content/src")).toMatchObject({ lfsBytes: 10_000, extensions: ["bin"] })
      // Assets also holds a script and a .meta file that step 6 did not need to read: no ratio.
      expect(find(result, "Assets").binaryRatio).toBeNull()
      expect(Measure.ruleBasedHeavy(result.rows)).toEqual([])
      // Root files (README.md, .gitattributes) and the files directly inside Assets (Textures.meta, banner.png).
      expect(Measure.forced(result, [...F2_HEAVY]).files).toBe(4)
      expect(Measure.forced(result, [...F2_HEAVY]).bytes).toBe(result.direct[""].bytes + result.direct.Assets.bytes)
      expect(result.direct.Assets.bytes).toBe(2_000 + "meta\n".length)

      const fetched = await Lfs.fetch(repo.home, ["src/**"])
      expect(fetched.ok).toBe(true)
      const after = await measured(repo.home, repo.head)
      expect(find(after, "src")).toMatchObject({ lfsBytes: 3_000, lfsMissing: 0 })
      expect(after.total.lfsMissing).toBe(all - 3_000)
    },
    SLOW,
  )
})

describe("F3: synthetic repository with heavy LFS folders", () => {
  const f3 = synthetic(path.join(box.root, "f3"), 3_000)

  test(
    "the rule-based fallback finds exactly the heavy folders; step 6 reads only Assets",
    async () => {
      const result = await measured(f3.home, f3.head)
      expect(result.total.files).toBe(f3.entries)
      expect(result.binary).toBe("measured")
      expect(Measure.ruleBasedHeavy(result.rows)).toEqual([...F3_HEAVY].toSorted())
      const textures = find(result, "Assets/Textures")
      expect(textures.lfsBytes).toBe(textures.files * 2_000_000)
      expect(textures.lfsMissing).toBe(textures.lfsBytes)
      expect(textures.bigFiles).toBe(textures.files)
      expect(textures.extensions).toEqual(["png"])
      expect(find(result, "Assets/Scripts")).toMatchObject({ binaryRatio: 0, lfsBytes: 0, extensions: ["ts"] })
      expect(find(result, "Assets").binaryRatio).toBeGreaterThan(0.99)
      // Folders deeper than two levels appear only below a parent with more than 5% of all bytes.
      const deeper = result.rows.filter((item) => item.depth > Measure.TABLE_DEPTH)
      expect(deeper.some((item) => item.dir.startsWith("Assets/Textures/d"))).toBe(true)
      for (const item of deeper)
        expect(find(result, item.dir.slice(0, item.dir.lastIndexOf("/"))).bytes).toBeGreaterThan(
          result.total.bytes * Measure.DEEPER_SHARE,
        )
      // Forced: the root files and Assets/Textures.meta, the code-only cone of 06 §4.5.
      expect(Measure.forced(result, [...F3_HEAVY]).files).toBe(3)
      expect(Cone.complement(Object.keys(result.direct), [...F3_HEAVY])).toEqual([
        "Assets/Scripts",
        "docs",
        "src",
        "tools",
      ])
    },
    SLOW,
  )

  // 06 §3.1: ls-tree 239 ms, check-attr 1158 ms, cat-file 431 ms for 100k entries. Opt-in: OWN_TEAM_F3=1.
  test.skipIf(process.env.OWN_TEAM_F3 !== "1")(
    "100k entries are measured within a few seconds",
    async () => {
      const big = synthetic(path.join(box.root, "f3-100k"), 100_000)
      const started = performance.now()
      const result = await measured(big.home, big.head)
      const elapsed = performance.now() - started
      console.log(`measure 100k: ${Math.round(elapsed)} ms, ${result.rows.length} rows`)
      expect(Measure.ruleBasedHeavy(result.rows)).toEqual([...F3_HEAVY].toSorted())
      expect(elapsed).toBeLessThan(15_000)
    },
    SLOW,
  )
})

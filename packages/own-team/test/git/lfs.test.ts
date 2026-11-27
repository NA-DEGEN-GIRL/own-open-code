import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Cone } from "../../src/git/cone.js"
import { Lfs } from "../../src/git/lfs.js"
import { F2_HEAVY, F2_IN_CONE, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { git, temp } from "../fixtures/repo.js"

/** Git and LFS transfers: Windows process starts are slow on a busy machine. */
const SLOW = 180_000

describe("Lfs pure parts", () => {
  test("parsePointer", () => {
    const oid = "a".repeat(64)
    expect(Lfs.parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`)).toEqual({
      oid,
      size: 12345,
    })
    expect(Lfs.parsePointer("export const x = 1\n")).toBeUndefined()
    expect(
      Lfs.parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.slice(1)}\nsize 1\n`),
    ).toBeUndefined()
    expect(Lfs.parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize -1\n`)).toBeUndefined()
  })

  test("includes: the cone folder that holds each object, exact paths for forced files, nothing at the root", () => {
    const item = (...paths: string[]) => ({ oid: "b".repeat(64), size: 1, paths })
    const cone = ["-dash", "Assets/Scripts", "docs", "src"]
    expect(
      Lfs.includes(cone, [
        item("src/icons/logo.png", "src/deep/x/other.png"),
        item("-dash/icon.png"),
        item("Assets/banner.png"),
        item("logo.png"),
        item("src,odd/x.png"),
        item("Assets/wild*card.png"),
      ]),
    ).toEqual(["-dash/**", "Assets/banner.png", "src/**"])
    expect(Lfs.includes(null, [item("Assets/Textures/rock.png"), item("Content/map.bin"), item("top.png")])).toEqual([
      "Assets/**",
      "Content/**",
    ])
    expect(Lfs.includes(cone, [])).toEqual([])
  })
})

describe.skipIf(!lfsAvailable)("Lfs against F2 (bare file:// remote)", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const repo = f2(box.root)
  const cone = Cone.complement(
    [
      "-dash",
      "Assets",
      "Assets/Audio",
      "Assets/Scripts",
      "Assets/Textures",
      "Content",
      "docs",
      "src",
      "src/app",
      "src/icons",
    ],
    [...F2_HEAVY],
  )

  test(
    "the store is <common dir>/lfs unless lfs.storage says otherwise",
    async () => {
      const store = await Lfs.storage(repo.home)
      expect(store.ok && store.dir).toBe(path.join(repo.home, ".git", "lfs"))
      git(repo.home, ["config", "lfs.storage", "elsewhere"])
      const moved = await Lfs.storage(repo.home)
      expect(moved.ok && moved.dir).toBe(path.join(repo.home, ".git", "elsewhere"))
      git(repo.home, ["config", "--unset", "lfs.storage"])
    },
    SLOW,
  )

  test(
    "missing counts the cone's objects only; a full worktree counts all",
    async () => {
      expect(cone).toEqual(["-dash", "Assets/Scripts", "docs", "src"])
      const inCone = await Lfs.missing(repo.home, "HEAD", Cone.matcher(cone))
      if (!inCone.ok) throw new Error(inCone.message)
      expect(inCone.objects.flatMap((item) => item.paths).toSorted()).toEqual([...F2_IN_CONE].toSorted())
      expect(inCone.count).toBe(3)
      expect(inCone.bytes).toBe(F2_IN_CONE.reduce((total, file) => total + F2_LFS[file], 0))
      const all = await Lfs.missing(repo.home, "HEAD", () => true)
      expect(all.ok && all.count).toBe(Object.keys(F2_LFS).length)
    },
    SLOW,
  )

  test(
    "offline: fetch fails and nothing is stored",
    async () => {
      const before = repo.objects()
      repo.offline()
      const result = await Lfs.fetch(repo.home, ["src"])
      repo.online()
      expect(result.ok).toBe(false)
      expect(repo.objects()).toBe(before)
    },
    SLOW,
  )

  test(
    "fetch -I downloads exactly the missing objects of the list",
    async () => {
      const before = repo.objects()
      const missing = await Lfs.missing(repo.home, "HEAD", Cone.matcher(cone))
      if (!missing.ok) throw new Error(missing.message)
      const fetched = await Lfs.fetch(repo.home, Lfs.includes(cone, missing.objects))
      expect(fetched).toEqual({ ok: true, runs: 1 })
      // `Assets/banner.png` is reached by its exact path; the heavy folders stay out.
      expect(repo.objects() - before).toBe(missing.count)
      const after = await Lfs.missing(repo.home, "HEAD", Cone.matcher(cone))
      expect(after.ok && after.count).toBe(0)
      const all = await Lfs.missing(repo.home, "HEAD", () => true)
      expect(all.ok && all.count).toBe(Object.keys(F2_LFS).length - F2_IN_CONE.length)
    },
    SLOW,
  )

  test(
    "an empty list runs nothing (lfs fetch without -I is never called)",
    async () => {
      repo.offline()
      const result = await Lfs.fetch(repo.home, [])
      repo.online()
      expect(result).toEqual({ ok: true, runs: 0 })
    },
    SLOW,
  )
})

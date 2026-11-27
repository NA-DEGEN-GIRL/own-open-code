// The Bun install cache of own's own installs (06 §4.12, TG14 part): the volume of the user's cache against the
// worktree root (same / other / unused), Bun's order for finding the user's cache, and the environment own adds to its
// own installs: only BUN_INSTALL_CACHE_DIR=<worktreeRoot>/.own-bun-cache, and only for another volume. Nothing touches
// process.env or a user setting; the user's folders are replaced by temp folders through the env argument.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BunCache } from "../../src/assets/bun-cache.js"
import { temp, write } from "../fixtures/repo.js"
import { team } from "../support/context.js"

const box = temp("own-team-bun-")
afterAll(() => box.dispose())

/** A user folder of its own, so no real bunfig or cache of this PC is read. */
const user = path.join(box.root, "user")
fs.mkdirSync(user)
const USER_ENV = { HOME: user, USERPROFILE: user }

const home = path.join(box.root, "repo")
write(home, { "bun.lock": "{}\n", "package.json": "{}\n" })
const worktreeRoot = path.join(box.root, "repo-team")

/** A path on another volume than the temp folder, if this machine has one (nothing is written there). */
const elsewhere = (() => {
  const here = BunCache.volume(os.tmpdir())
  const candidates =
    process.platform === "win32"
      ? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`).filter((root) => fs.existsSync(root))
      : ["/proc", "/sys", "/dev", "/run", "/"]
  const root = candidates.find((item) => fs.existsSync(item) && BunCache.volume(item) !== here)
  return root === undefined ? undefined : path.join(root, "own-team-test-not-created", "cache")
})()

describe("BunCache (06 §4.12)", () => {
  test("no Bun lockfile in the home: unused", () => {
    const plain = path.join(box.root, "plain")
    write(plain, { "package.json": "{}\n" })
    expect(BunCache.detect({ home: plain, worktreeRoot, env: USER_ENV })).toBe("unused")
    write(plain, { "bun.lockb": "binary" })
    expect(BunCache.detect({ home: plain, worktreeRoot, env: USER_ENV })).toBe("same-volume")
  })

  test("the user's cache on the worktrees' volume: same-volume, even before it exists", () => {
    expect(BunCache.detect({ home, worktreeRoot, env: USER_ENV })).toBe("same-volume")
    expect(
      BunCache.detect({ home, worktreeRoot, env: { ...USER_ENV, BUN_INSTALL_CACHE_DIR: path.join(box.root, "c") } }),
    ).toBe("same-volume")
  })

  test.skipIf(elsewhere === undefined)("the user's cache on another volume: other-volume", () => {
    expect(BunCache.detect({ home, worktreeRoot, env: { ...USER_ENV, BUN_INSTALL_CACHE_DIR: elsewhere! } })).toBe(
      "other-volume",
    )
    expect(BunCache.detect({ home, worktreeRoot: elsewhere!, env: USER_ENV })).toBe("other-volume")
  })

  test("the user's cache in Bun's order: variable, project bunfig, global bunfig, BUN_INSTALL, XDG, home", () => {
    const project = path.join(box.root, "order")
    fs.mkdirSync(project)
    const env = { ...USER_ENV, BUN_INSTALL: path.join(box.root, "bun"), XDG_CACHE_HOME: path.join(box.root, "xdg") }
    expect(BunCache.userCache(project, { ...env, BUN_INSTALL_CACHE_DIR: path.join(box.root, "var") })).toBe(
      path.join(box.root, "var"),
    )
    expect(BunCache.userCache(project, env)).toBe(path.join(box.root, "bun", "install", "cache"))
    expect(BunCache.userCache(project, USER_ENV)).toBe(path.join(user, ".bun", "install", "cache"))
    expect(BunCache.userCache(project, { ...USER_ENV, XDG_CACHE_HOME: path.join(box.root, "xdg") })).toBe(
      path.join(box.root, "xdg", ".bun", "install", "cache"),
    )
    write(user, { ".bunfig.toml": '[install.cache]\ndir = "~/global-cache"\n' })
    expect(BunCache.userCache(project, env)).toBe(path.join(user, "global-cache"))
    write(project, { "bunfig.toml": '[install]\ncache = "local-cache"\n' })
    expect(BunCache.userCache(project, env)).toBe(path.join(project, "local-cache"))
    // A bunfig Bun cannot read sets nothing.
    write(project, { "bunfig.toml": "[install\n" })
    expect(BunCache.userCache(project, env)).toBe(path.join(user, "global-cache"))
    fs.rmSync(path.join(user, ".bunfig.toml"))
  })

  test("the env map carries only BUN_INSTALL_CACHE_DIR=<worktreeRoot>/.own-bun-cache, only for another volume", () => {
    const base = team({ home })
    const other = { ...base, env: { ...base.env, bunCache: "other-volume" as const } }
    expect(BunCache.env(other)).toEqual({ BUN_INSTALL_CACHE_DIR: path.join(base.worktreeRoot, ".own-bun-cache") })
    expect(Object.keys(BunCache.env(other))).toEqual([BunCache.VARIABLE])
    expect(BunCache.env({ ...base, env: { ...base.env, bunCache: "same-volume" } })).toEqual({})
    expect(BunCache.env({ ...base, env: { ...base.env, bunCache: "unused" } })).toEqual({})
    expect(BunCache.folder(worktreeRoot)).toBe(path.join(worktreeRoot, BunCache.FOLDER))
  })

  test("process.env and the user's variables are untouched", () => {
    const before = JSON.stringify(process.env)
    BunCache.detect({ home, worktreeRoot, env: USER_ENV })
    BunCache.userCache(home, USER_ENV)
    const added = BunCache.env({
      ...team({ home }),
      env: { symlinkFix: "none", bunCache: "other-volume", lfs: "unused" },
    })
    expect(JSON.stringify(process.env)).toBe(before)
    expect(process.env[BunCache.VARIABLE]).not.toBe(added[BunCache.VARIABLE])
    // Nothing is created ahead: Bun makes the folder on the first install.
    expect(fs.existsSync(BunCache.folder(worktreeRoot))).toBe(false)
  })
})

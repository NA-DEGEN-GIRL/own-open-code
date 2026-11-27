import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Home } from "../../src/git/home.js"
import { WorktreeHome } from "../../src/worktree-home/strategy.js"
import { f1, git, temp } from "../fixtures/repo.js"

// 06 §4.12a: where a worktree made outside team mode goes.
describe("WorktreeHome", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const home = f1(path.join(box.root, "a")).home
  const projectID = "0123456789abcdef"
  const env = { XDG_DATA_HOME: path.join(box.root, "data") }
  const suggested = (name: string) => path.join(WorktreeHome.coreDefault(projectID, env), name)

  test("core's default parent moves to <main worktree>/.worktrees, a free name keeps its suffix", async () => {
    const placed = await WorktreeHome.place({ projectID, sourceDirectory: home, suggested: suggested("side"), env })
    expect(placed).toEqual({ directory: path.join(home, ".worktrees", "side"), root: path.join(home, ".worktrees") })
    fs.mkdirSync(path.join(home, ".worktrees", "side"), { recursive: true })
    const next = await WorktreeHome.place({ projectID, sourceDirectory: home, suggested: suggested("side"), env })
    expect(next.directory).toBe(path.join(home, ".worktrees", "side-2"))
  })

  test("a configured or explicit parent stays as core suggested it", async () => {
    const elsewhere = path.join(box.root, "configured", "side")
    expect(await WorktreeHome.place({ projectID, sourceDirectory: home, suggested: elsewhere, env })).toEqual({
      directory: elsewhere,
    })
  })

  test("a linked worktree's source still uses the main worktree's folder", async () => {
    const linked = path.join(box.root, "a", "linked")
    git(home, ["worktree", "add", "-q", "--detach", linked])
    const placed = await WorktreeHome.place({ projectID, sourceDirectory: linked, suggested: suggested("x"), env })
    expect(placed.root).toBe(path.join(home, ".worktrees"))
  })

  test("prepare writes own's .gitignore and the info/exclude line once, and keeps a user's .gitignore", async () => {
    const root = path.join(home, ".worktrees")
    const found = await WorktreeHome.rootOf(home)
    if (!found) throw new Error("no root")
    await WorktreeHome.prepare(root, found.commonDir)
    await WorktreeHome.prepare(root, found.commonDir)
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(Home.IGNORE_ALL)
    const exclude = fs.readFileSync(path.join(found.commonDir, "info", "exclude"), "utf8")
    expect(exclude.split("\n").filter((line) => line === Home.EXCLUDE_LINE)).toHaveLength(1)
    fs.writeFileSync(path.join(root, ".gitignore"), "mine\n")
    await WorktreeHome.prepare(root, found.commonDir)
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("mine\n")
    expect(git(home, ["status", "--porcelain"]).trim()).toBe("")
  })

  test("core's default path follows XDG_DATA_HOME like @opencode/util/global-roots", () => {
    expect(WorktreeHome.coreDefault("abcdef123", { XDG_DATA_HOME: "/x" })).toBe(
      path.join("/x", "opencode", "worktree", "abcdef"),
    )
  })
})

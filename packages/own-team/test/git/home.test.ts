import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Classify } from "../../src/git/classify.js"
import { Home } from "../../src/git/home.js"
import { Inventory } from "../../src/git/inventory.js"
import { f1, temp } from "../fixtures/repo.js"

const NOW = Date.UTC(2026, 9, 1, 12)

function worktree(itemPath: string, extra: Partial<Home.Worktree> = {}): Home.Worktree {
  return {
    path: itemPath,
    real: itemPath,
    primary: false,
    bare: false,
    branch: null,
    locked: null,
    prunable: null,
    sessions: [],
    ...extra,
  }
}

function session(id: string, directory: string, age: number) {
  return { id, directory, updated: NOW - age }
}

/** The layout of 06 §0.5 as inventory rows. */
const layout = [
  worktree("D:/#Projects/own-open-code", {
    primary: true,
    branch: "computer-use",
    sessions: [session("primary", "D:/#Projects/own-open-code", 1_000)],
  }),
  worktree("D:/#Projects/own-open-code/.claude/worktrees/computer-use-login-features-67022a", {
    branch: "claude/x",
    sessions: [
      session("claude", "D:/#Projects/own-open-code/.claude/worktrees/computer-use-login-features-67022a", 1),
    ],
  }),
  worktree("D:/own-open-code", { branch: "main", sessions: [session("home", "D:/own-open-code", 60_000)] }),
  worktree("D:/own-open-code/.worktrees/cl-cu", {
    branch: "own-computer-use",
    sessions: [session("cu", "D:/own-open-code/.worktrees/cl-cu", 10_000)],
  }),
  worktree("D:/own-open-code/.worktrees/cl-perf", { branch: "cl-integration" }),
  worktree("D:/own-gone", { branch: "gone-work", prunable: "gitdir file points to non-existent location" }),
]

describe("Home.pick (06 §3.2 홈 고르기)", () => {
  test("1: the folder of the viewed conversation, a subfolder placed by the longest prefix", () => {
    expect(
      Home.pick({ worktrees: layout, target: "main", session: "D:\\own-open-code\\.worktrees\\cl-cu\\src" }),
    ).toEqual({ directory: "D:/own-open-code/.worktrees/cl-cu", linked: true, chosenBy: "session" })
    expect(Home.pick({ worktrees: layout, target: "main", session: "d:/own-open-code/packages" })).toEqual({
      directory: "D:/own-open-code",
      linked: true,
      chosenBy: "session",
    })
  })

  test("1: a `#` main worktree is accepted when it is the conversation's folder", () => {
    expect(Home.pick({ worktrees: layout, target: "main", session: "D:/#Projects/own-open-code" })).toEqual({
      directory: "D:/#Projects/own-open-code",
      linked: false,
      chosenBy: "session",
    })
  })

  test("1 is skipped for another tool's worktree, a gone one, or a folder of another repository", () => {
    for (const folder of [
      "D:/#Projects/own-open-code/.claude/worktrees/computer-use-login-features-67022a/packages",
      "D:/own-gone/src",
      "C:/elsewhere",
    ])
      expect(Home.pick({ worktrees: layout, target: "main", session: folder })?.chosenBy).toBe("target-checkout")
  })

  test("2: the target checkout, not the `#` canonical one (06 §0.5 step 1, project header)", () => {
    expect(Home.pick({ worktrees: layout, target: "main" })).toEqual({
      directory: "D:/own-open-code",
      linked: true,
      chosenBy: "target-checkout",
    })
  })

  test("2 passes over `#` paths and other tools' worktrees; 3 then takes the most recent root session", () => {
    // `computer-use` is checked out only in the `#` main worktree; the Claude session is newer but not usable.
    expect(Home.pick({ worktrees: layout, target: "computer-use" })).toEqual({
      directory: "D:/own-open-code/.worktrees/cl-cu",
      linked: true,
      chosenBy: "recent",
    })
    expect(Home.pick({ worktrees: layout, target: "claude/x" })?.chosenBy).toBe("recent")
  })

  test("4: canonical (the main worktree) when nothing else applies; a bare one is skipped", () => {
    const quiet = layout.map((item) => ({ ...item, sessions: [] }))
    expect(Home.pick({ worktrees: quiet, target: "nope" })).toEqual({
      directory: "D:/#Projects/own-open-code",
      linked: false,
      chosenBy: "canonical",
    })
    const bare = [worktree("D:/repo.git", { primary: true, bare: true }), worktree("D:/repo-wt", { branch: "x" })]
    expect(Home.pick({ worktrees: bare, target: "nope" })).toEqual({
      directory: "D:/repo-wt",
      linked: true,
      chosenBy: "canonical",
    })
    expect(Home.pick({ worktrees: [bare[0]], target: "nope" })).toBeUndefined()
  })

  test("configured patterns exclude a checkout from steps 1-3", () => {
    expect(Home.pick({ worktrees: layout, target: "main", patterns: ["/own-open-code/"] })?.chosenBy).toBe("canonical")
  })
})

describe("Home.worktreeRoot (06 §4.12)", () => {
  const all = layout.map((item) => item.path)
  const common = "D:/#Projects/own-open-code/.git"

  test("inside the home (프로젝트 안, the default since 2026-10-27): <home>/.worktrees, beside the user's own", () => {
    // The home of 06 §0.5 already holds the user's nested worktrees there; the root is the folder, not one of them.
    expect(Home.worktreeRoot("D:\\own-open-code", common, all, "inside")).toEqual({
      ok: true,
      directory: "D:/own-open-code/.worktrees",
    })
    expect(Home.worktreeRoot("/srv/work/game/", "/srv/work/game/.git", ["/srv/work/game"], "inside")).toEqual({
      ok: true,
      directory: "/srv/work/game/.worktrees",
    })
    // A home at a drive root has no parent, but a folder inside it.
    expect(Home.worktreeRoot("F:\\", "F:/.git", ["F:/"], "inside")).toEqual({ ok: true, directory: "F:/.worktrees" })
    expect(Home.holder("D:/own-open-code/.worktrees")).toBe("D:/own-open-code")
    expect(Home.holder("D:\\own-open-code\\.worktrees\\")).toBe("D:/own-open-code")
    expect(Home.holder("D:/own-open-code-team")).toBeUndefined()
  })

  test("beside the home (프로젝트 옆 폴더): <parent>/<name>-team", () => {
    expect(Home.worktreeRoot("D:\\own-open-code", common, all, "beside")).toEqual({
      ok: true,
      directory: "D:/own-open-code-team",
    })
    expect(Home.worktreeRoot("/srv/work/game/", "/srv/work/game/.git", ["/srv/work/game"], "beside")).toEqual({
      ok: true,
      directory: "/srv/work/game-team",
    })
    expect(Home.worktreeRoot("/game", "/game/.git", ["/game"], "beside")).toEqual({ ok: true, directory: "/game-team" })
  })

  test("a `#` home moves to <drive>:/own-team/<repository> either way", () => {
    for (const layout of ["inside", "beside"] as const) {
      expect(Home.worktreeRoot("D:/#Projects/own-open-code", common, all, layout)).toEqual({
        ok: true,
        directory: "D:/own-team/own-open-code",
      })
      expect(Home.worktreeRoot("E:\\#x\\wt", "E:/#x/repo.git", [], layout)).toEqual({
        ok: true,
        directory: "E:/own-team/repo",
      })
    }
    // A home at a drive root has no parent folder to sit beside.
    expect(Home.worktreeRoot("F:\\", "F:/.git", [], "beside")).toEqual({ ok: true, directory: "F:/own-team/F" })
  })

  test("path_forbidden: `#` in the result, a POSIX `#` home, a folder inside another worktree", () => {
    expect(Home.worktreeRoot("D:/#Projects/game#2", "D:/#Projects/game#2/.git", [], "inside")).toEqual({
      ok: false,
      error: "path_forbidden",
      path: "D:/own-team/game#2",
      why: "hash",
    })
    expect(Home.worktreeRoot("/home/u/#x/repo", "/home/u/#x/repo/.git", [], "inside")).toEqual({
      ok: false,
      error: "path_forbidden",
      path: "/home/u/#x/repo",
      why: "hash",
    })
    expect(Home.worktreeRoot("D:/own-open-code/.worktrees/cl-cu", common, all, "beside")).toEqual({
      ok: false,
      error: "path_forbidden",
      path: "D:/own-open-code/.worktrees/cl-cu-team",
      why: "nested",
    })
    // A home nested in another worktree: its own `.worktrees` is inside that one too.
    expect(Home.worktreeRoot("D:/own-open-code/.worktrees/cl-cu", common, all, "inside")).toEqual({
      ok: false,
      error: "path_forbidden",
      path: "D:/own-open-code/.worktrees/cl-cu/.worktrees",
      why: "nested",
    })
  })

  test("info/exclude gets `/.worktrees/` once, after the user's lines; a line of the user's for it counts", () => {
    expect(Home.excluded("")).toBe("# own.team area folders (06 §4.12)\n/.worktrees/\n")
    expect(Home.excluded("# user\n*.log")).toBe("# user\n*.log\n# own.team area folders (06 §4.12)\n/.worktrees/\n")
    for (const line of ["/.worktrees/", ".worktrees/", "/.worktrees"])
      expect(Home.excluded(`# user\r\n${line}\r\n`)).toBeUndefined()
    expect(Home.excluded(Home.excluded("x\n")!)).toBeUndefined()
  })

  test("own's `.gitignore` in an inside root (2026-10-27): written once, the user's kept, gone with own's last folder", async () => {
    const box = temp()
    try {
      const root = path.join(box.root, "home", ".worktrees")
      const file = path.join(root, ".gitignore")
      await Home.ignore(root)
      expect(fs.readFileSync(file, "utf8")).toBe(Home.IGNORE_ALL)
      // Something else still there (an area kept as touched, the user's worktree, the Bun cache): it stays.
      fs.mkdirSync(path.join(root, "kept"))
      await Home.unignore(root)
      expect(fs.existsSync(file)).toBe(true)
      fs.rmdirSync(path.join(root, "kept"))
      await Home.unignore(root)
      expect(fs.existsSync(file)).toBe(false)
      // A file of the user's is neither replaced nor removed.
      fs.writeFileSync(file, "# mine\n")
      await Home.ignore(root)
      await Home.unignore(root)
      expect(fs.readFileSync(file, "utf8")).toBe("# mine\n")
      // A root beside the project gets none.
      const beside = path.join(box.root, "home-team")
      await Home.ignore(beside)
      expect(fs.existsSync(beside)).toBe(false)
    } finally {
      box.dispose()
    }
  })
})

describe("F1: a new project (06 TG2, observation)", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const repo = f1(path.join(box.root, "f1"))

  test("one checkout on main: home by target checkout, not linked, areas inside it or beside it", async () => {
    const located = await Inventory.locate(path.join(repo.home, "src", "app"))
    if (!located.ok) throw new Error(located.message)
    expect(Classify.same(located.toplevel, repo.home)).toBe(true)
    const inventory = await Inventory.collect(located.commonDir, "main", [])
    if (!inventory.ok) throw new Error(inventory.message)
    const home = Home.pick({ worktrees: inventory.worktrees, target: "main" })
    expect(home?.chosenBy).toBe("target-checkout")
    expect(home?.linked).toBe(false)
    expect(Classify.same(home?.directory ?? "", repo.home)).toBe(true)
    const root = (layout: "inside" | "beside") => {
      const found = Home.worktreeRoot(
        home?.directory ?? "",
        inventory.commonDir,
        inventory.worktrees.map((item) => item.path),
        layout,
      )
      if (!found.ok) throw new Error(found.why)
      return found.directory
    }
    expect(Classify.same(root("beside"), path.join(box.root, "f1", "home-team"))).toBe(true)
    expect(Classify.same(root("inside"), path.join(box.root, "f1", "home", ".worktrees"))).toBe(true)
  }, 60_000)
})

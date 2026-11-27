import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Classify } from "../../src/git/classify.js"
import { f1, git, init, temp } from "../fixtures/repo.js"

type Item = Parameters<typeof Classify.classify>[0][number]

function item(itemPath: string, extra: Partial<Item> = {}): Item {
  return { path: itemPath, real: itemPath, primary: false, locked: null, prunable: null, ...extra }
}

function classes(items: readonly Item[], options: Classify.Options) {
  return Object.fromEntries(Classify.classify(items, options).map((entry) => [entry.path, entry.class]))
}

describe("Classify paths (own-web worktree/model.ts rules)", () => {
  test("separators, trailing separators and case on Windows paths", () => {
    expect(Classify.same("D:\\own-open-code\\", "d:/OWN-OPEN-CODE")).toBe(true)
    expect(Classify.same("\\\\server\\share\\x", "\\\\SERVER\\share\\x\\")).toBe(true)
    expect(Classify.key("D:\\")).toBe("d:/")
    expect(Classify.key("D:")).toBe("d:/")
    expect(Classify.key("/")).toBe("/")
  })

  test("POSIX paths keep their case", () => {
    expect(Classify.same("/home/u/Repo", "/home/u/repo")).toBe(false)
    expect(Classify.same("/home/u/repo/", "/home/u/repo")).toBe(true)
  })

  test("inside: a folder and its subfolders only, not a sibling sharing the prefix", () => {
    expect(Classify.inside("D:/own-open-code", "d:\\own-open-code\\.worktrees\\cl-cu")).toBe(true)
    expect(Classify.inside("D:/own-open-code", "D:/own-open-code")).toBe(true)
    expect(Classify.inside("D:/own-open-code", "D:/own-open-code-team/x")).toBe(false)
    expect(Classify.inside("D:/", "D:/anything")).toBe(true)
    expect(Classify.inside("/srv/repo", "/srv/Repo/x")).toBe(false)
  })
})

describe("placeSessions", () => {
  const worktrees = ["D:/own-open-code", "D:/own-open-code/.worktrees/cl-cu", "D:/#Projects/own-open-code"]

  test("longest prefix, case and separators ignored on Windows; sessions outside every worktree are unplaced", () => {
    const sessions = [
      { id: "home", directory: "D:\\own-open-code" },
      { id: "home-sub", directory: "d:\\Own-Open-Code\\packages\\own-web" },
      { id: "nested", directory: "D:\\own-open-code\\.worktrees\\cl-cu\\packages" },
      { id: "primary", directory: "D:/#Projects/own-open-code/" },
      { id: "sibling", directory: "D:\\own-open-code-team\\x" },
      { id: "elsewhere", directory: "C:\\work" },
    ]
    const result = Classify.placeSessions(worktrees, sessions)
    const ids = (key: string) => result.placed.get(key)?.map((session) => session.id)
    expect(ids("D:/own-open-code")).toEqual(["home", "home-sub"])
    expect(ids("D:/own-open-code/.worktrees/cl-cu")).toEqual(["nested"])
    expect(ids("D:/#Projects/own-open-code")).toEqual(["primary"])
    expect(result.unplaced.map((session) => session.id)).toEqual(["sibling", "elsewhere"])
  })

  test("every worktree has an entry; extra fields come back unchanged", () => {
    const result = Classify.placeSessions(worktrees, [{ directory: "D:/own-open-code", model: "gpt" }])
    expect([...result.placed.keys()]).toEqual(worktrees)
    expect(result.placed.get("D:/#Projects/own-open-code")).toEqual([])
    expect(result.placed.get("D:/own-open-code")).toEqual([{ directory: "D:/own-open-code", model: "gpt" }])
  })
})

describe("classify (06 §3.2 table)", () => {
  test("default other-tool patterns: Claude Code, the codex app, Codex, Cursor", () => {
    const items = [
      item("D:/#Projects/own-open-code/.claude/worktrees/computer-use-login-features-67022a"),
      item(
        "D:/#Projects/codex-multi-provider/work/control-center/profiles/1a2b3c4d/codex/worktrees/c39b/own-open-code",
      ),
      item("C:/Users/u/.codex/worktrees/abc/repo"),
      item("D:\\work\\.Cursor\\wt\\repo"),
      item("/home/u/.claude/worktrees/x"),
    ]
    expect(Object.values(classes(items, { home: null }))).toEqual(Array(5).fill("other-tool"))
  })

  test("configured patterns add to the defaults; * stays in one folder, ** spans folders", () => {
    const items = [item("D:/tools/agent-x/wt/repo"), item("D:/tools/agent-y/deep/wt/repo"), item("D:/work/repo")]
    expect(classes(items, { home: null, patterns: ["/agent-*/wt/"] })).toEqual({
      "D:/tools/agent-x/wt/repo": "other-tool",
      "D:/tools/agent-y/deep/wt/repo": "candidate",
      "D:/work/repo": "candidate",
    })
    expect(classes(items, { home: null, patterns: ["/agent-*/**/wt/"] })["D:/tools/agent-y/deep/wt/repo"]).toBe(
      "other-tool",
    )
  })

  test("a lock that is not own's makes another tool's worktree; own's locks do not", () => {
    const items = [
      item("D:/a", { locked: "own.team area:ar_x" }),
      item("D:/b", { locked: "own: nested worktrees inside" }),
      item("D:/c", { locked: "kept by the user" }),
      item("D:/d", { locked: "" }),
    ]
    expect(classes(items, { home: null })).toEqual({
      "D:/a": "candidate",
      "D:/b": "candidate",
      "D:/c": "other-tool",
      "D:/d": "other-tool",
    })
  })

  test("table order: home, primary, other-tool, prunable, # path, candidate", () => {
    const items = [
      item("D:/#Projects/own-open-code", { primary: true }),
      item("D:/own-open-code"),
      item("D:/gone", { prunable: "gitdir file points to non-existent location" }),
      item("D:/#Projects/.claude/worktrees/x", { prunable: "gone" }),
      item("D:/#Projects/own-hash"),
      item("D:/link-without-hash", { real: "E:/#real/target" }),
      item("D:/own-open-code/.worktrees/cl-cu"),
    ]
    expect(classes(items, { home: "d:\\own-open-code\\" })).toEqual({
      "D:/#Projects/own-open-code": "primary",
      "D:/own-open-code": "home",
      "D:/gone": "prunable",
      "D:/#Projects/.claude/worktrees/x": "other-tool",
      "D:/#Projects/own-hash": "hash-path",
      "D:/link-without-hash": "hash-path",
      "D:/own-open-code/.worktrees/cl-cu": "candidate",
    })
    // The primary is the home when it is chosen.
    expect(classes(items, { home: "D:/#Projects/own-open-code" })["D:/#Projects/own-open-code"]).toBe("home")
  })

  test("nested is a flag with the innermost outer worktree", () => {
    const items = [
      item("D:/repo", { primary: true }),
      item("D:/repo/.worktrees/a"),
      item("D:/repo/.worktrees/a/inner"),
      item("D:/repo-team/b"),
    ]
    const result = Classify.classify(items, { home: null })
    expect(result.map((entry) => [entry.nested, entry.outer])).toEqual([
      [false, null],
      [true, "D:/repo"],
      [true, "D:/repo/.worktrees/a"],
      [false, null],
    ])
  })
})

describe("clone (06 §3.2 다른 클론)", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const repo = f1(path.join(box.root, "f1"))
  const other = init(path.join(box.root, "other"))
  git(repo.home, ["worktree", "add", "-q", "-b", "side", path.join(box.root, "side"), repo.head])

  test("same common dir (any worktree, any subfolder), another one, or none", async () => {
    const common = path.join(repo.home, ".git")
    expect(await Classify.clone(common, path.join(repo.home, "src", "app"))).toBe("same")
    expect(await Classify.clone(common, path.join(box.root, "side"))).toBe("same")
    expect(await Classify.clone(common, other)).toBe("other")
    expect(await Classify.clone(common, path.join(box.root, "missing"))).toBe("none")
  }, 60_000)
})

// Worktree flow, pure part (03 §19.3): groups, places, move destinations, saved choice, the cleanup guard (06 §10.4
// #5), server errors.
import { describe, expect, test } from "bun:test"
import {
  baseOptions,
  effectiveChoice,
  groupSessions,
  isInside,
  moveTargets,
  placeOf,
  removeCommand,
  removeGuard,
  sameInspection,
  shownPath,
  worktreeFailure,
  worktreeName,
  type WorktreeInspection,
} from "./model"

const ROOT = "D:\\work\\repo"
const WT_A = "C:\\Users\\me\\.local\\share\\opencode\\worktree\\abc123\\calm-otter"
const WT_B = "C:\\Users\\me\\.local\\share\\opencode\\worktree\\abc123\\brave-fox"

describe("paths", () => {
  test("isInside: itself, children, case and separators on Windows; not siblings with a common prefix", () => {
    expect(isInside(ROOT, "d:/work/repo")).toBe(true)
    expect(isInside(ROOT, "D:\\work\\repo\\packages\\web")).toBe(true)
    expect(isInside(ROOT, "D:\\work\\repo-2")).toBe(false)
    expect(isInside("/home/me/repo", "/home/me/repo/src")).toBe(true)
    expect(isInside("/home/me/repo", "/home/me/Repo/src")).toBe(false)
  })

  test("worktreeName: branch when known, else the folder", () => {
    expect(worktreeName(WT_A)).toBe("calm-otter")
    expect(worktreeName(WT_A, "feature/x")).toBe("feature/x")
    expect(worktreeName("/srv/wt/brave-fox/")).toBe("brave-fox")
  })
})

describe("groupSessions (sidebar ⑂ groups)", () => {
  const rows = [
    { id: "s1", directory: ROOT },
    { id: "s2", directory: `${ROOT}\\packages\\web` },
    { id: "s3", directory: WT_A },
    { id: "s4", directory: WT_A.toLowerCase() },
    { id: "s5", directory: `${ROOT}\\.worktrees\\inner` },
  ]

  test("without the list: folders outside the root are worktrees", () => {
    const groups = groupSessions(ROOT, rows)
    expect(groups.local.map((row) => row.id)).toEqual(["s1", "s2", "s5"])
    expect(groups.worktrees.map((group) => group.rows.map((row) => row.id))).toEqual([["s3", "s4"]])
  })

  test("with the list: a worktree inside the project still groups", () => {
    const groups = groupSessions(ROOT, rows, [ROOT, WT_A, `${ROOT}\\.worktrees\\inner`])
    expect(groups.local.map((row) => row.id)).toEqual(["s1", "s2"])
    expect(groups.worktrees.map((group) => [group.directory, group.rows.map((row) => row.id)])).toEqual([
      [WT_A, ["s3", "s4"]],
      [`${ROOT}\\.worktrees\\inner`, ["s5"]],
    ])
  })
})

describe("placeOf and moveTargets", () => {
  const list = [{ directory: ROOT }, { directory: WT_A, strategy: "git" }, { directory: WT_B, strategy: "git" }]

  test("placeOf", () => {
    expect(placeOf(ROOT, `${ROOT}\\src`)).toEqual({ kind: "local" })
    expect(placeOf(ROOT, WT_A)).toEqual({ kind: "worktree", directory: WT_A })
    expect(placeOf(ROOT, `${WT_A}\\sub`, [WT_A])).toEqual({ kind: "worktree", directory: WT_A })
    expect(placeOf(undefined, WT_A)).toEqual({ kind: "local" })
  })

  test("a local session can go to either worktree", () => {
    expect(moveTargets(ROOT, list, `${ROOT}\\src`)).toEqual([
      { directory: WT_A, kind: "worktree" },
      { directory: WT_B, kind: "worktree" },
    ])
  })

  test("a worktree session can go home or to the other worktree", () => {
    expect(moveTargets(ROOT, list, WT_A.toUpperCase())).toEqual([
      { directory: ROOT, kind: "local" },
      { directory: WT_B, kind: "worktree" },
    ])
  })
})

describe("choice", () => {
  test("an existing worktree that left the list falls back to local; unknown list keeps it", () => {
    const choice = { mode: "existing" as const, existing: WT_A }
    expect(effectiveChoice(choice, undefined)).toBe(choice)
    expect(effectiveChoice(choice, [{ directory: WT_A.toLowerCase() }])).toBe(choice)
    expect(effectiveChoice(choice, [{ directory: WT_B }])).toEqual({ mode: "local" })
    expect(effectiveChoice(undefined, [])).toEqual({ mode: "local" })
    expect(effectiveChoice({ mode: "new", base: "main" }, [])).toEqual({ mode: "new", base: "main" })
  })

  test("baseOptions: current branch first, deduplicated, filtered", () => {
    expect(baseOptions(["dev", "main", "feature/x"], "main", "")).toEqual(["main", "dev", "feature/x"])
    expect(baseOptions(["dev", "main", "feature/x"], "main", "FEA")).toEqual(["feature/x"])
    expect(baseOptions([], undefined, "")).toEqual([])
  })
})

describe("server errors", () => {
  test("WorktreeError with forceRequired", () => {
    const error = Object.assign(new Error("has changes"), {
      name: "WorktreeError",
      data: { message: "contains modified or untracked files", forceRequired: true },
    })
    expect(worktreeFailure(error)).toEqual({ message: "contains modified or untracked files", forceRequired: true })
    expect(worktreeFailure(new Error("network"))).toEqual({ message: "network", forceRequired: false })
    expect(worktreeFailure("x")).toEqual({ message: "x", forceRequired: false })
  })

  test("removeCommand shows the force flag", () => {
    expect(removeCommand(WT_A, false)).toBe(`git worktree remove "${WT_A}"`)
    expect(removeCommand(WT_A, true)).toBe(`git worktree remove --force "${WT_A}"`)
  })
})

describe("removeGuard (06 §10.4 #5, TG13)", () => {
  const clean: WorktreeInspection = {
    nested: [],
    scan: "complete",
    lock: null,
    ownLock: false,
    ignored: { entries: [], count: 0, bytes: 0, truncated: false },
  }
  const nested = { ...clean, nested: [{ path: `${WT_A}\.worktrees\inner`, kind: "worktree" as const }] }
  const ownLock = { ...clean, lock: { reason: "own.team area:ar_x" }, ownLock: true }
  const ignored = {
    ...clean,
    ignored: {
      entries: [{ path: "node_modules/", bytes: 2_500_000_000 }],
      count: 1,
      bytes: 2_500_000_000,
      truncated: false,
    },
  }

  test("no inspection (loading or failed) fails closed", () => {
    expect(removeGuard(undefined)).toBe("unknown")
  })

  test("precedence: nested > own lock > partial scan > ignored > ok", () => {
    expect(removeGuard({ ...ignored, nested: nested.nested, lock: ownLock.lock, ownLock: true })).toBe("refuse-nested")
    expect(removeGuard({ ...ignored, lock: ownLock.lock, ownLock: true, scan: "partial" })).toBe("own-lock")
    expect(removeGuard({ ...ignored, scan: "partial" })).toBe("refuse-partial")
    expect(removeGuard(ignored)).toBe("confirm-ignored")
    expect(removeGuard(clean)).toBe("ok")
  })

  test("a foreign lock does not change the guard (git refuses on its own)", () => {
    expect(removeGuard({ ...clean, lock: { reason: "used by another tool" } })).toBe("ok")
    expect(removeGuard({ ...ignored, lock: { reason: "" } })).toBe("confirm-ignored")
  })

  test("a partial scan refuses: it cannot rule out a repository inside (TI-3 (b)); one with a hit names it", () => {
    expect(removeGuard({ ...clean, scan: "partial" })).toBe("refuse-partial")
    expect(removeGuard({ ...nested, scan: "partial" })).toBe("refuse-nested")
  })

  test("sameInspection: the removal goes ahead only when what was confirmed still holds (TI-3 (e))", () => {
    expect(sameInspection(ignored, { ...ignored, ignored: { ...ignored.ignored, bytes: 2_600_000_000 } })).toBe(true)
    const inner = nested.nested[0]!
    expect(sameInspection(nested, { ...nested, nested: [{ ...inner, path: inner.path.toUpperCase() }] })).toBe(true)
    expect(sameInspection(clean, ignored)).toBe(false)
    expect(sameInspection(ignored, { ...ignored, ignored: { ...ignored.ignored, count: 2 } })).toBe(false)
    expect(sameInspection(clean, nested)).toBe(false)
    expect(sameInspection(nested, { ...nested, nested: [{ ...inner, kind: "repository" }] })).toBe(false)
    expect(sameInspection(clean, { ...clean, lock: { reason: "used by another tool" } })).toBe(false)
    expect(sameInspection(clean, { ...clean, scan: "partial" })).toBe(false)
  })

  test("shownPath: nested paths relative to the worktree, whatever the server's spelling; others in full", () => {
    expect(shownPath(WT_A, `${WT_A.toLowerCase()}\\.worktrees\\inner`)).toBe(".worktrees\\inner")
    expect(shownPath(`${WT_A}\\`, `${WT_A}/vendor/lib`)).toBe("vendor/lib")
    expect(shownPath("/srv/wt/a", "/srv/wt/a/vendor/lib")).toBe("vendor/lib")
    expect(shownPath(WT_A, WT_B)).toBe(WT_B)
    expect(shownPath(WT_A, WT_A)).toBe(WT_A)
  })
})

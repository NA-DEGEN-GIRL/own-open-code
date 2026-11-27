// Review units (03 §18.5, §4.7, §20.2 R4): patch trimming (ranges checked by applying the hunks), modes and the
// default mode, split width, list keyboard moves, summaries, size thresholds, strings.
import { describe, expect, test } from "bun:test"
import type { FileDiffInfo } from "@opencode/client"
import {
  activeFile,
  availableModes,
  branchModeAvailable,
  defaultMode,
  effectiveStyle,
  isLarge,
  LARGE_PATCH_CHARS,
  MAX_CHANGED_LINES,
  moveFile,
  needsLoad,
  RECENT_TURN_MS,
  sortDiffs,
  splitPath,
  statusCode,
  summarize,
  tooLarge,
} from "./model"
import { prepareDiff } from "./prepare"
import { reviewEn, reviewKo, reviewText } from "./strings"
import { trimPatch } from "./trim"
import { summarizeStatus } from "./vcs-status"

/** A git-style full-context patch (what vcs.diff / session.diff return without `context`). */
function fullPatch(file: string, before: string[], after: string[], replaced: ReadonlyMap<number, string>) {
  const body = before.flatMap((line, index) => {
    const next = replaced.get(index)
    return next === undefined ? [` ${line}`] : [`-${line}`, `+${next}`]
  })
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...body,
    "",
  ].join("\n")
}

/** Applies unified hunks to `before` (lines) and returns the new lines; throws when a context/removed line differs. */
function apply(before: readonly string[], patch: string) {
  const lines = patch.split("\n")
  const out: string[] = []
  const cursor = { old: 0 }
  for (const [index, line] of lines.entries()) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line)
    if (!header) continue
    const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1
    out.push(...before.slice(cursor.old, start))
    cursor.old = start
    for (const body of lines.slice(index + 1)) {
      if (body.startsWith("@@") || body === "") break
      if (body.startsWith("\\")) continue
      if (body[0] === "+") out.push(body.slice(1))
      if (body[0] === " " || body[0] === "-") {
        if (before[cursor.old] !== body.slice(1)) throw new Error(`mismatch at old line ${cursor.old + 1}`)
        if (body[0] === " ") out.push(body.slice(1))
        cursor.old += 1
      }
    }
  }
  return [...out, ...before.slice(cursor.old)]
}

function diff(input: Partial<FileDiffInfo> & { readonly file: string }): FileDiffInfo {
  return { patch: "@@ -1,1 +1,1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified", ...input }
}

describe("trimPatch", () => {
  const before = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)
  const changes = new Map([
    [9, "changed 10"],
    [100, "changed 101"],
    [197, "changed 198"],
  ])
  const after = before.map((line, index) => changes.get(index) ?? line)
  const patch = fullPatch("src/a.ts", before, after, changes)

  test("keeps 3 lines of context around each change in separate hunks", () => {
    const result = trimPatch("src/a.ts", patch)
    expect(result.trimmed).toBe(true)
    const headers = result.patch.split("\n").filter((line) => line.startsWith("@@"))
    expect(headers).toEqual(["@@ -7,7 +7,7 @@", "@@ -98,7 +98,7 @@", "@@ -195,6 +195,6 @@"])
    expect(result.lines).toBe(7 + 1 + 7 + 1 + 6 + 1)
  })

  test("the trimmed hunks still turn the old file into the new one", () => {
    expect(apply(before, trimPatch("src/a.ts", patch).patch)).toEqual(after)
  })

  test("drops the git header so the viewer treats it as a partial patch", () => {
    const text = trimPatch("src/a.ts", patch).patch
    expect(text.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@")).toBe(true)
    expect(text).not.toContain("diff --git")
    expect(text).not.toMatch(/^--- [^\n]*\t/m)
  })

  test("merges changes whose context windows touch", () => {
    const near = new Map([
      [50, "x"],
      [55, "y"],
    ])
    const result = trimPatch(
      "a",
      fullPatch(
        "a",
        before,
        before.map((line, index) => near.get(index) ?? line),
        near,
      ),
    )
    expect(result.patch.split("\n").filter((line) => line.startsWith("@@"))).toEqual(["@@ -48,12 +48,12 @@"])
  })

  test("keeps the no-newline marker with its line and counts insertions and deletions", () => {
    const text = [
      "--- a/b",
      "+++ b/b",
      "@@ -1,10 +1,11 @@",
      ...Array.from({ length: 8 }, (_, index) => ` k${index + 1}`),
      "+inserted",
      " k9",
      "-k10",
      "\\ No newline at end of file",
      "+k10!",
      "\\ No newline at end of file",
      "",
    ].join("\n")
    const result = trimPatch("b", text, 1)
    expect(result.patch).toBe(
      [
        "--- a/b",
        "+++ b/b",
        "@@ -8,3 +8,4 @@",
        " k8",
        "+inserted",
        " k9",
        "-k10",
        "\\ No newline at end of file",
        "+k10!",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    )
  })

  test("returns the patch unchanged when nothing can be dropped (new file, already small)", () => {
    const added = "--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n"
    expect(trimPatch("n", added)).toEqual({ patch: added, trimmed: false, lines: 2 })
  })

  test("separate input hunks never merge across their gap", () => {
    const text = "--- a/c\n+++ b/c\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -10,2 +10,2 @@\n c\n-d\n+D\n"
    const headers = trimPatch("c", text, 0)
      .patch.split("\n")
      .filter((line) => line.startsWith("@@"))
    expect(headers).toEqual(["@@ -1,1 +1,1 @@", "@@ -11,1 +11,1 @@"])
  })
})

describe("prepareDiff", () => {
  test("small patches pass through synchronously", () => {
    const small = diff({ file: "a" })
    expect(prepareDiff(small)).toEqual({ diff: small, trimmed: false })
  })

  test("large patches are trimmed (inline when no Worker is available)", async () => {
    const before = Array.from({ length: 12_000 }, (_, index) => `const value${index} = "${"x".repeat(20)}"`)
    const changes = new Map([[6_000, "changed"]])
    const patch = fullPatch(
      "big.ts",
      before,
      before.map((line, index) => changes.get(index) ?? line),
      changes,
    )
    const large = diff({ file: "big.ts", patch })
    expect(isLarge(large)).toBe(true)
    const prepared = await prepareDiff(large)
    expect(prepared.trimmed).toBe(true)
    expect(prepared.diff.patch.length).toBeLessThan(1_000)
    expect(prepared.diff.additions).toBe(large.additions)
    expect(prepareDiff(large)).toBe(prepareDiff(large))
  })
})

describe("modes", () => {
  test("a folder without git offers only the session modes (18.5)", () => {
    expect(availableModes({ vcs: false, branch: true, reverted: false })).toEqual(["lastTurn", "session"])
    expect(availableModes({ vcs: true, branch: true, reverted: true })).toEqual([
      "working",
      "branch",
      "lastTurn",
      "session",
      "reverted",
    ])
    expect(availableModes({ vcs: true, branch: false, reverted: false })).toEqual(["working", "lastTurn", "session"])
  })

  test("branch mode is hidden only on the default branch itself", () => {
    expect(branchModeAvailable("main", { name: "main", ref: "refs/heads/main", source: "default" })).toBe(false)
    expect(branchModeAvailable("feature", { name: "main", ref: "refs/heads/main", source: "reflog" })).toBe(true)
    expect(branchModeAvailable("feature", null)).toBe(true)
    expect(branchModeAvailable(undefined, undefined)).toBe(true)
  })

  test("default: last turn right after a turn, otherwise uncommitted changes", () => {
    const now = 1_000_000_000
    expect(defaultMode({ vcs: true, running: false, idleAt: now - 1_000, now })).toBe("lastTurn")
    expect(defaultMode({ vcs: true, running: false, idleAt: now - RECENT_TURN_MS - 1, now })).toBe("working")
    expect(defaultMode({ vcs: true, running: true, idleAt: now - 1_000, now })).toBe("working")
    expect(defaultMode({ vcs: true, running: false, idleAt: undefined, now })).toBe("working")
    expect(defaultMode({ vcs: false, running: false, idleAt: undefined, now })).toBe("lastTurn")
  })
})

describe("view rules", () => {
  test("split needs 560 px (4.7)", () => {
    expect(effectiveStyle("split", 559)).toBe("unified")
    expect(effectiveStyle("split", 560)).toBe("split")
    expect(effectiveStyle("split", undefined)).toBe("split")
    expect(effectiveStyle("unified", 900)).toBe("unified")
  })

  test("file list keys move within the list", () => {
    const files = ["a", "b", "c"]
    expect(moveFile(files, "a", "ArrowDown")).toBe("b")
    expect(moveFile(files, "c", "ArrowDown")).toBe("c")
    expect(moveFile(files, "a", "ArrowUp")).toBe("a")
    expect(moveFile(files, undefined, "ArrowDown")).toBe("a")
    expect(moveFile(files, "b", "End")).toBe("c")
    expect(moveFile(files, "b", "Home")).toBe("a")
    expect(moveFile(files, "b", "Enter")).toBeUndefined()
    expect(moveFile([], "b", "ArrowDown")).toBeUndefined()
  })

  test("active file: the remembered one while listed, else the first", () => {
    expect(activeFile(["a", "b"], "b")).toBe("b")
    expect(activeFile(["a", "b"], "gone")).toBe("a")
    expect(activeFile([], "gone")).toBeUndefined()
  })

  test("summary, order, status letters and paths", () => {
    const list = [
      diff({ file: "src/z.ts", additions: 3, deletions: 1 }),
      diff({ file: "README.md", additions: 1, deletions: 0, status: "added" }),
    ]
    expect(summarize(list)).toEqual({ count: 2, additions: 4, deletions: 1 })
    expect(sortDiffs(list).map((item) => item.file)).toEqual(["README.md", "src/z.ts"])
    expect([statusCode("added"), statusCode("deleted"), statusCode("modified")]).toEqual(["A", "D", "M"])
    expect(splitPath("src/review/model.ts")).toEqual({ name: "model.ts", directory: "src/review" })
    expect(splitPath("README.md")).toEqual({ name: "README.md", directory: "" })
  })

  test("size thresholds: capped patches, worker trimming, draw on request", () => {
    expect(needsLoad(diff({ file: "a", patch: "Index: a\n===\n--- a\n+++ a\n", additions: 5 }))).toBe(true)
    expect(needsLoad(diff({ file: "a", patch: "", additions: 0, deletions: 0 }))).toBe(false)
    expect(needsLoad(diff({ file: "a" }))).toBe(false)
    expect(isLarge(diff({ file: "a", patch: "x".repeat(LARGE_PATCH_CHARS + 1) }))).toBe(true)
    expect(tooLarge(diff({ file: "a", additions: MAX_CHANGED_LINES, deletions: 1 }))).toBe(true)
    expect(tooLarge(diff({ file: "a", additions: MAX_CHANGED_LINES, deletions: 0 }))).toBe(false)
  })

  test("git status chip summary (19.15 hook)", () => {
    expect(
      summarizeStatus([
        { file: "a", additions: 2, deletions: 1, status: "modified" },
        { file: "b", additions: 0, deletions: 4, status: "deleted" },
      ]),
    ).toEqual({ files: 2, additions: 2, deletions: 5 })
  })
})

describe("strings", () => {
  test("every review key has an English fallback and the same placeholders", () => {
    const keys = Object.keys(reviewKo) as (keyof typeof reviewKo)[]
    for (const key of keys) {
      const english = reviewEn[key]
      expect(english, key).toBeDefined()
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()
      expect(names(english!), key).toEqual(names(reviewKo[key]))
    }
  })

  test("Korean particles and params", () => {
    expect(reviewText("ko", "own.review.files", { count: 3 })).toBe("변경 파일 3")
    expect(reviewText("en", "own.review.footer", { count: 3 })).toBe("3 changes · Review →")
    expect(reviewText("ko", "own.review.empty.branch", { base: "main" })).toBe("main 이후 바뀐 파일이 없어요")
  })
})

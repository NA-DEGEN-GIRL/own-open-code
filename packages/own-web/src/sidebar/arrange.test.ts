// 03 §4.3 순서와 고정: the order projects and server sections are listed in (./arrange.ts).
import { describe, expect, test } from "bun:test"
import { arrangeKeys, arrangeProjects, placed, type ProjectListView } from "./arrange"
import { flattenTree, type TreeInput } from "./model"

const list = (input: Partial<ProjectListView>): ProjectListView => ({
  pinned: [],
  order: null,
  orderedAt: null,
  ...input,
})
/** a newest … e oldest; their newest conversations at 500 … 100. */
const UPDATED: Record<string, number> = { a: 500, b: 400, c: 300, d: 200, e: 100 }
const arrange = (input: { leading?: string; list?: ProjectListView }, ids = ["a", "b", "c", "d", "e"]) =>
  arrangeProjects(ids, { ...input, updated: (id) => UPDATED[id] ?? 0 }).join("")

describe("arrangeProjects", () => {
  test("the default order is the order they came in, the default conversation folder first", () => {
    expect(arrange({})).toBe("abcde")
    expect(arrange({ list: list({}) })).toBe("abcde")
    expect(arrange({ leading: "d" })).toBe("dabce")
    expect(arrange({ leading: "gone" })).toBe("abcde")
  })

  test("pinned projects come first in the user's order; the rest keeps the default", () => {
    expect(arrange({ list: list({ pinned: ["d", "b"] }) })).toBe("dbace")
    // The default conversation folder can be pinned like any other.
    expect(arrange({ leading: "e", list: list({ pinned: ["d"] }) })).toBe("deabc")
    expect(arrange({ leading: "e", list: list({ pinned: ["c", "e"] }) })).toBe("ceabd")
  })

  test("once arranged: new since then on top, the placed ones, older ones that were not loaded last", () => {
    const order = ["c", "b", "d"]
    expect(arrange({ list: list({ order, orderedAt: 450 }) })).toBe("acbde")
    expect(arrange({ list: list({ order, orderedAt: 600 }) })).toBe("cbdae")
    expect(arrange({ list: list({ order, orderedAt: 50 }) })).toBe("aecbd")
    // Placed, the default conversation folder stays where the user put it.
    expect(arrange({ leading: "d", list: list({ order: ["c", "b", "d", "a", "e"], orderedAt: 600 }) })).toBe("cbdae")
  })

  test("a pinned project is not listed again, and projects that are not here are skipped", () => {
    expect(arrange({ list: list({ pinned: ["c", "gone"], order: ["e", "c", "gone", "a"], orderedAt: 600 }) })).toBe(
      "ceabd",
    )
    expect(arrange({ list: list({ pinned: ["c"], order: ["b"] }) }, ["a"])).toBe("a")
  })
})

describe("arrangeKeys", () => {
  test("the stored order, then whatever is new in its own order", () => {
    expect(arrangeKeys(["local", "h1", "h2"], [])).toEqual(["local", "h1", "h2"])
    expect(arrangeKeys(["local", "h1", "h2"], ["h1", "local"])).toEqual(["h1", "local", "h2"])
    expect(arrangeKeys(["local", "h2"], ["h1", "h2", "local"])).toEqual(["h2", "local"])
  })
})

describe("placed", () => {
  test("moves one, up or down or nowhere", () => {
    const shown = ["a", "b", "c", "d"]
    expect(placed(shown, [], "c", 0)).toEqual(["c", "a", "b", "d"])
    expect(placed(shown, [], "a", 3)).toEqual(["b", "c", "d", "a"])
    expect(placed(shown, [], "b", 1)).toEqual(shown)
  })

  test("what the list does not show now stays after what came before it", () => {
    expect(placed(["a", "b", "c"], ["a", "x", "b", "c", "y"], "c", 0)).toEqual(["c", "y", "a", "x", "b"])
    expect(placed(["a", "b"], ["x", "y", "a", "b"], "b", 0)).toEqual(["x", "y", "b", "a"])
  })
})

test("flattenTree lists the projects that way, with their counts and positions", () => {
  const rows: Record<string, { projectID: string; updated: number }> = {
    s1: { projectID: "a", updated: 500 },
    s2: { projectID: "b", updated: 400 },
    s3: { projectID: "c", updated: 300 },
    s4: { projectID: "a", updated: 200 },
  }
  const input: TreeInput = {
    order: Object.keys(rows),
    session: (id) => rows[id],
    collapsed: (id) => id === "b",
    expanded: () => false,
    children: () => [],
    marks: { today: 0, yesterday: 0, week: 0 },
    more: false,
    list: list({ pinned: ["c"], order: ["b", "a"], orderedAt: 1_000 }),
  }
  const tree = flattenTree(input)
  expect(tree.keys).toEqual(["p|c", "s|s3", "p|b", "p|a", "s|s1", "s|s4"])
  expect(tree.counts).toEqual({ c: 1, b: 1, a: 2 })
  expect(tree.positions.get("p|b")).toEqual([2, 3])
  // Pinned conversations stay above pinned projects.
  expect(flattenTree({ ...input, pinned: (id) => id === "s2" }).keys.slice(0, 3)).toEqual(["g|pinned", "s|s2", "p|c"])
})

test("hundreds of projects are arranged at once", () => {
  const ids = Array.from({ length: 500 }, (_, at) => `p${at}`)
  const started = performance.now()
  const result = arrangeProjects(ids, {
    list: list({ pinned: ids.slice(400, 450), order: ids.toReversed(), orderedAt: 1 }),
    updated: () => 0,
  })
  expect(result).toHaveLength(500)
  expect(new Set(result).size).toBe(500)
  expect(performance.now() - started).toBeLessThan(200)
})

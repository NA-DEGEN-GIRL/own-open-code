import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  browserOf,
  browserTarget,
  chatOf,
  closePane,
  createPaneLayout,
  ensureBrowser,
  focusedChat,
  initialPanes,
  layoutRects,
  leavesOf,
  minHeight,
  minWidth,
  moveDivider,
  movePane,
  normalize,
  openBeside,
  openRoute,
  parsePanes,
  pinBrowser,
  splitPane,
  toggleBrowser,
  visibleTree,
  type PaneRoute,
  type PaneState,
} from "./pane-layout"

const session = (sessionID: string, serverKey = "local"): PaneRoute => ({ name: "session", serverKey, sessionID })
const ids = (state: PaneState) => leavesOf(state.tree).map((leaf) => leaf.id)
const sum = (sizes: readonly number[]) => sizes.reduce((total, size) => total + size, 0)
const sizesOf = (state: PaneState) => (state.tree.kind === "split" ? state.tree.sizes : [])

describe("pane tree reducer", () => {
  test("a route opens in the focused chat pane; a session already in a pane focuses that pane", () => {
    const first = openRoute(initialPanes(), session("a"))
    expect(focusedChat(first)?.route).toEqual(session("a"))
    const two = openBeside(first, session("b")).state
    expect(ids(two)).toEqual(["p1", "p2"])
    expect(two.focused).toBe("p2")
    // Back to "a" through the sidebar or history: the pane that shows it gets the focus, nothing else changes.
    const back = openRoute(two, session("a"))
    expect(back.focused).toBe("p1")
    expect(back.tree).toBe(two.tree)
    // A new route replaces what the focused chat pane shows.
    const home = openRoute(back, { name: "home" })
    expect(chatOf(home, "p1")?.route).toEqual({ name: "home" })
    expect(chatOf(home, "p2")?.route).toEqual(session("b"))
    // Opening beside a session that is already shown only focuses it.
    expect(openBeside(two, session("a")).state.focused).toBe("p1")
  })

  test("split right then down: siblings for the same direction, a new level otherwise, at most 2 levels", () => {
    const row = splitPane(initialPanes(session("a")), "p1", "row", { view: "chat", route: session("b") })
    expect(row.id).toBe("p2")
    expect(row.state.tree).toMatchObject({ kind: "split", dir: "row", sizes: [0.5, 0.5] })
    // Same direction again: a third sibling taking half of its target's space.
    const three = splitPane(row.state, "p2", "row", { view: "chat", route: session("c") })
    expect(three.state.tree).toMatchObject({ kind: "split", dir: "row", sizes: [0.5, 0.25, 0.25] })
    // Down from p1: p1 becomes a column split inside the row (level 2).
    const down = splitPane(row.state, "p1", "column", { view: "chat", route: session("d") })
    expect(down.state.tree).toMatchObject({
      kind: "split",
      dir: "row",
      children: [{ kind: "split", dir: "column", children: [{ id: "p1" }, { id: "p3" }] }, { id: "p2" }],
    })
    // A third level is refused; the same direction inside the column is fine.
    expect(splitPane(down.state, "p3", "row", { view: "chat" }).refused).toBe("depth")
    expect(splitPane(down.state, "p3", "column", { view: "chat" }).id).toBe("p4")
  })

  test("never more than 4 leaves", () => {
    let state = initialPanes(session("a"))
    for (const id of ["b", "c", "d"]) state = openBeside(state, session(id)).state
    expect(ids(state)).toHaveLength(4)
    const refused = openBeside(state, session("e"))
    expect(refused.refused).toBe("limit")
    expect(refused.state).toBe(state)
    expect(ensureBrowser(state, "p1").refused).toBe("limit")
  })

  test("closing gives the space to the neighbour, collapses single-child splits and moves the focus", () => {
    const two = openBeside(initialPanes(session("a")), session("b")).state
    const closed = closePane(two, "p2")
    expect(closed.tree).toMatchObject({ kind: "leaf", id: "p1" })
    expect(closed.focused).toBe("p1")
    // Three in a row: the middle one's space goes to the one before it.
    const three = openBeside(two, session("c")).state
    expect(three.tree).toMatchObject({ sizes: [0.5, 0.25, 0.25] })
    const middle = closePane(three, "p2")
    expect(middle.tree).toMatchObject({ kind: "split", children: [{ id: "p1" }, { id: "p3" }] })
    expect(sum(sizesOf(middle))).toBeCloseTo(1)
    expect(sizesOf(middle)[0]).toBeCloseTo(0.75)
    // The last chat pane stays.
    expect(closePane(initialPanes(), "p1")).toEqual(initialPanes())
  })

  test("a chat pane's browser opens beside it, follows its session, and closes with it", () => {
    const one = initialPanes(session("a"))
    const opened = toggleBrowser(one, "p1")
    expect(opened.id).toBe("p2")
    const browser = browserOf(opened.state, "p1")!
    expect(browser).toMatchObject({ view: "browser", follows: "p1" })
    expect(opened.state.tree).toMatchObject({ dir: "row", sizes: [0.55, 0.45] })
    expect(browserTarget(opened.state, browser)).toEqual({ serverKey: "local", sessionID: "a" })
    // The chat pane moves to another session: its browser follows.
    const moved = openRoute(opened.state, session("z"))
    expect(browserTarget(moved, browserOf(moved, "p1")!)).toEqual({ serverKey: "local", sessionID: "z" })
    // Ensure is idempotent; toggling again closes it.
    expect(ensureBrowser(opened.state, "p1").state).toBe(opened.state)
    expect(toggleBrowser(opened.state, "p1").state.tree).toMatchObject({ kind: "leaf", id: "p1" })
    // Two chat panes, each with its browser; closing a chat pane closes its browser too.
    const second = openBeside(opened.state, session("b"), { target: "p2" }).state
    const both = ensureBrowser(second, "p3").state
    expect(leavesOf(both.tree).map((leaf) => leaf.view)).toEqual(["chat", "browser", "chat", "browser"])
    const closed = closePane(both, "p3")
    expect(leavesOf(closed.tree).map((leaf) => leaf.id)).toEqual(["p1", "p2"])
    // A focused browser pane's chat pane is the one the URL follows.
    expect(focusedChat({ ...opened.state, focused: "p2" })?.id).toBe("p1")
  })

  test("a chat pane and its browser move as one group when a new chat pane is placed", () => {
    const pair = toggleBrowser(initialPanes(session("a")), "p1").state
    // Split down: below the pair, then the new pane gets its own browser beside it (2 × 2 of chat + browser).
    const down = splitPane(pair, "p1", "column", { view: "chat", route: session("b") })
    expect(down.state.tree).toMatchObject({
      kind: "split",
      dir: "column",
      children: [{ kind: "split", dir: "row", children: [{ id: "p1" }, { id: "p2" }] }, { id: "p3" }],
    })
    const grid = ensureBrowser(down.state, "p3").state
    expect(grid.tree).toMatchObject({
      dir: "column",
      children: [
        { dir: "row", children: [{ id: "p1" }, { id: "p2", follows: "p1" }] },
        { dir: "row", children: [{ id: "p3" }, { id: "p4", follows: "p3" }] },
      ],
    })
    expect(minWidth(grid.tree)).toBe(780)
    // Three pairs would be 6 panes: the limit says no before any shape question.
    expect(splitPane(grid, "p3", "column", { view: "chat" }).refused).toBe("limit")
    // The pair inside a column: a new pane below it goes into the column.
    const third = splitPane(down.state, "p1", "column", { view: "chat", route: session("d") })
    expect(third.state.tree).toMatchObject({
      dir: "column",
      children: [{ dir: "row", children: [{ id: "p1" }, { id: "p2" }] }, { id: "p4" }, { id: "p3" }],
    })
    // Split right: after the browser, taking half of the pair's space.
    const right = splitPane(pair, "p1", "row", { view: "chat", route: session("c") })
    expect(leavesOf(right.state.tree).map((leaf) => leaf.id)).toEqual(["p1", "p2", "p3"])
    expect(sizesOf(right.state)).toEqual([0.275, 0.225, 0.5])
  })

  test("a pane dragged onto another moves beside it (edge) or trades places (middle)", () => {
    const three = openBeside(openBeside(initialPanes(session("a")), session("b")).state, session("c")).state
    expect(ids(three)).toEqual(["p1", "p2", "p3"])
    // p3 onto p1's bottom edge: a column with p1 above p3, p2 stays on the right.
    const moved = movePane(three, "p3", "p1", { dir: "column", before: false })
    expect(moved.state.tree).toMatchObject({
      dir: "row",
      children: [{ dir: "column", children: [{ id: "p1" }, { id: "p3" }] }, { id: "p2" }],
    })
    expect(moved.state.focused).toBe("p3")
    // Middle: trade places.
    const swapped = movePane(three, "p1", "p3", "swap")
    expect(ids(swapped.state)).toEqual(["p3", "p2", "p1"])
    expect(sizesOf(swapped.state)).toEqual(sizesOf(three))
    // Onto itself, or an unknown pane: nothing.
    expect(movePane(three, "p1", "p1", "swap").refused).toBe("missing")
  })

  test("a pinned browser keeps its session while the chat pane moves on", () => {
    const opened = toggleBrowser(initialPanes(session("a")), "p1").state
    const pinned = pinBrowser(opened, "p2", true)
    const moved = openRoute(pinned, session("b"))
    expect(browserTarget(moved, leavesOf(moved.tree)[1]!)).toEqual({ serverKey: "local", sessionID: "a" })
    // A pinned browser is not the chat pane's follower: Ctrl+Shift+B opens another one.
    expect(browserOf(moved, "p1")).toBeUndefined()
    const unpinned = pinBrowser(moved, "p2", false)
    expect(browserTarget(unpinned, leavesOf(unpinned.tree)[1]!)).toEqual({ serverKey: "local", sessionID: "b" })
  })

  test("normalize folds same-direction splits and drops single children", () => {
    expect(
      normalize({
        kind: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { kind: "leaf", id: "p1", view: "chat" },
          {
            kind: "split",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { kind: "leaf", id: "p2", view: "chat" },
              { kind: "split", dir: "column", sizes: [1], children: [{ kind: "leaf", id: "p3", view: "chat" }] },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.25, 0.25],
      children: [
        { kind: "leaf", id: "p1", view: "chat" },
        { kind: "leaf", id: "p2", view: "chat" },
        { kind: "leaf", id: "p3", view: "chat" },
      ],
    })
  })

  test("dividers move within the minimum fraction", () => {
    const two = openBeside(initialPanes(session("a")), session("b")).state
    const moved = moveDivider(two, [], 0, 0.2)
    const sizes = sizesOf(moved)
    expect(sizes[0]).toBeCloseTo(0.7)
    expect(sizes[1]).toBeCloseTo(0.3)
    const far = moveDivider(two, [], 0, 2)
    expect(sizesOf(far)[1]).toBeCloseTo(0.1)
  })

  test("minimum sizes decide the tabs fallback; browser panes do not count where there is no pane", () => {
    const chat = initialPanes(session("a"))
    expect(minWidth(chat.tree)).toBe(420)
    const withBrowser = toggleBrowser(chat, "p1").state
    expect(minWidth(withBrowser.tree)).toBe(780)
    expect(minWidth(withBrowser.tree, (view) => view !== "browser")).toBe(420)
    expect(visibleTree(withBrowser.tree, (view) => view !== "browser")).toMatchObject({ kind: "leaf", id: "p1" })
    const grid = splitPane(withBrowser, "p1", "column", { view: "chat", route: session("b") }).state
    expect(minWidth(grid.tree)).toBe(780)
    expect(minHeight(grid.tree)).toBe(440)
  })

  test("layout rectangles tile the area and name each divider", () => {
    const two = openBeside(initialPanes(session("a")), session("b")).state
    const down = splitPane(two, "p2", "column", { view: "chat", route: session("c") }, { share: 0.5 }).state
    const rects = layoutRects(down.tree)
    expect(rects.leaves.get("p1")).toEqual({ x: 0, y: 0, width: 0.5, height: 1 })
    expect(rects.leaves.get("p2")).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 })
    expect(rects.leaves.get("p3")).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
    expect(rects.dividers).toEqual([
      { x: 0.5, y: 0, width: 0, height: 1, path: [], index: 0, dir: "row", extent: 1 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0, path: [1], index: 0, dir: "column", extent: 1 },
    ])
  })

  test("stored state is validated like load(): bad trees, unknown views, too many leaves, deep splits", () => {
    const good = toggleBrowser(openRoute(initialPanes(), session("a")), "p1").state
    expect(parsePanes(JSON.parse(JSON.stringify(good)))).toEqual(good)
    // 03 §5.1: a server's folderless new-conversation screen keeps its server.
    const host = openRoute(initialPanes(), { name: "home", serverKey: "lab" })
    expect(parsePanes(JSON.parse(JSON.stringify(host)))).toEqual(host)
    expect(chatOf(host, "p1")?.route).toEqual({ name: "home", serverKey: "lab" })
    expect(parsePanes(null)).toBeUndefined()
    expect(parsePanes({ tree: { kind: "leaf", id: "x1", view: "chat" }, focused: "x1" })).toBeUndefined()
    expect(parsePanes({ tree: { kind: "leaf", id: "p1", view: "terminal" }, focused: "p1" })).toBeUndefined()
    // No chat pane at all.
    expect(parsePanes({ tree: { kind: "leaf", id: "p1", view: "browser" }, focused: "p1" })).toBeUndefined()
    const leaf = (id: string) => ({ kind: "leaf", id, view: "chat" })
    expect(
      parsePanes({
        tree: { kind: "split", dir: "row", sizes: [1, 1, 1, 1, 1], children: ["p1", "p2", "p3", "p4", "p5"].map(leaf) },
        focused: "p1",
      }),
    ).toBeUndefined()
    // Three levels.
    const deep = {
      kind: "split",
      dir: "row",
      sizes: [1, 1],
      children: [
        leaf("p1"),
        {
          kind: "split",
          dir: "column",
          sizes: [1, 1],
          children: [leaf("p2"), { kind: "split", dir: "row", sizes: [1, 1], children: [leaf("p3"), leaf("p4")] }],
        },
      ],
    }
    expect(parsePanes({ tree: deep, focused: "p1" })).toBeUndefined()
    // Duplicate ids, wrong sizes.
    expect(
      parsePanes({
        tree: { kind: "split", dir: "row", sizes: [1, 1], children: [leaf("p1"), leaf("p1")] },
        focused: "p1",
      }),
    ).toBeUndefined()
    expect(
      parsePanes({
        tree: { kind: "split", dir: "row", sizes: [1], children: [leaf("p1"), leaf("p2")] },
        focused: "p1",
      }),
    ).toBeUndefined()
    // An unknown focus falls back to the first chat pane; a follower of a missing pane follows the first chat pane;
    // a bad route becomes the new-session screen; sizes are normalized.
    const fixed = parsePanes({
      tree: {
        kind: "split",
        dir: "row",
        sizes: [3, 1],
        children: [
          { kind: "leaf", id: "p1", view: "chat", route: { name: "session", serverKey: 1 } },
          { kind: "leaf", id: "p2", view: "browser", follows: "p9" },
        ],
      },
      focused: "p7",
      mode: "sideways",
    })
    expect(fixed).toEqual({
      tree: {
        kind: "split",
        dir: "row",
        sizes: [0.75, 0.25],
        children: [
          { kind: "leaf", id: "p1", view: "chat", route: { name: "home" } },
          { kind: "leaf", id: "p2", view: "browser", follows: "p1" },
        ],
      },
      focused: "p1",
    })
  })
})

describe("pane layout store", () => {
  test("per window, restored after reload; the device default applies until a window picks its own mode", () => {
    const windowKey = `test-${crypto.randomUUID()}`
    localStorage.removeItem("own.web.panes.default")
    createRoot((dispose) => {
      const panes = createPaneLayout(windowKey)
      expect(panes.mode()).toBe("split")
      panes.update((state) => openBeside(openRoute(state, session("a")), session("b")).state)
      panes.setWindowMode("tabs")
      expect(panes.mode()).toBe("tabs")
      panes.flush()
      dispose()
    })
    createRoot((dispose) => {
      const panes = createPaneLayout(windowKey)
      expect(ids(panes.state())).toEqual(["p1", "p2"])
      expect(panes.state().focused).toBe("p2")
      expect(panes.mode()).toBe("tabs")
      // Settings: the device default; this window follows it again.
      panes.setDeviceMode("split")
      expect(panes.mode()).toBe("split")
      panes.setDeviceMode("tabs")
      expect(panes.mode()).toBe("tabs")
      dispose()
    })
    createRoot((dispose) => {
      expect(createPaneLayout(`other-${crypto.randomUUID()}`).mode()).toBe("tabs")
      dispose()
    })
    localStorage.removeItem("own.web.panes.default")
  })
})

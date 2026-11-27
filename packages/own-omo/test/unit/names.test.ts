import { describe, expect, test } from "bun:test"
import { Names } from "../../src/host/names.js"

// omo's `getAgentConfigKey` for the names these tests use (display names and config keys, any case).
const KEYS: Record<string, string> = {
  "sisyphus - ultraworker": "sisyphus",
  sisyphus: "sisyphus",
  explore: "explore",
  oracle: "oracle",
  librarian: "librarian",
  "sisyphus-junior": "sisyphus-junior",
}
const keyOf = (name: string) => KEYS[name.trim().toLowerCase()] ?? name.trim().toLowerCase()

const agents = Names.agents({
  registered: new Map([
    ["explore", "explore"],
    ["oracle", "oracle"],
    ["librarian", "librarian"],
    ["sisyphus-junior", "Sisyphus-Junior"],
  ]),
  keyOf,
})

describe("agent names (15 §3.1)", () => {
  test("OpenCode 2 → OpenCode 1: build is Sisyphus, omo's agents their display names, core explore apart", () => {
    expect(agents.toV1("build")).toBe(Names.SISYPHUS)
    expect(agents.toV1("omo-explore")).toBe("explore")
    expect(agents.toV1("omo-sisyphus-junior")).toBe("Sisyphus-Junior")
    expect(agents.toV1("explore")).toBe(Names.CORE_EXPLORE)
    expect(agents.toV1("plan")).toBe("plan")
    expect(agents.toV1("general")).toBe("general")
  })

  test("OpenCode 1 → OpenCode 2: display names and config keys, any case; unknown names pass through", () => {
    expect(agents.toV2(Names.SISYPHUS)).toBe("build")
    expect(agents.toV2("sisyphus")).toBe("build")
    expect(agents.toV2("explore")).toBe("omo-explore")
    expect(agents.toV2("Explore")).toBe("omo-explore")
    expect(agents.toV2("Sisyphus-Junior")).toBe("omo-sisyphus-junior")
    expect(agents.toV2("sisyphus-junior")).toBe("omo-sisyphus-junior")
    expect(agents.toV2(Names.CORE_EXPLORE)).toBe("explore")
    expect(agents.toV2("plan")).toBe("plan")
    expect(agents.toV2("custom-agent")).toBe("custom-agent")
  })

  test("before the config ran nothing is registered: names pass through, build is still Sisyphus", () => {
    const empty = Names.agents({ registered: new Map(), keyOf })
    expect(empty.toV2("explore")).toBe("explore")
    expect(empty.toV1("omo-explore")).toBe("omo-explore")
    expect(empty.toV2(Names.SISYPHUS)).toBe("build")
  })
})

describe("tool names and inputs (15 §3.5)", () => {
  test("core tools as OpenCode 1 named them, and back", () => {
    expect(Names.toolToV1("shell", { command: "ls", workdir: "src", timeout: 1000 })).toEqual({
      tool: "bash",
      args: { command: "ls", workdir: "src", timeout: 1000 },
    })
    expect(Names.toolToV1("read", { path: "a.ts", offset: 1 })).toEqual({ tool: "read", args: { filePath: "a.ts", offset: 1 } })
    expect(Names.toolToV1("write", { path: "a.ts", content: "x" })).toEqual({
      tool: "write",
      args: { filePath: "a.ts", content: "x" },
    })
    expect(Names.toolToV1("edit", { path: "a.ts", oldString: "a", newString: "b" })).toEqual({
      tool: "edit",
      args: { filePath: "a.ts", oldString: "a", newString: "b" },
    })
    expect(Names.toolToV1("patch", { patchText: "*** Begin Patch" })).toEqual({
      tool: "apply_patch",
      args: { patchText: "*** Begin Patch" },
    })
    for (const name of ["grep", "glob", "webfetch", "question", "skill"])
      expect(Names.toolToV1(name, { pattern: "x" })).toEqual({ tool: name, args: { pattern: "x" } })
    expect(Names.argsToV2("read", { filePath: "a.ts", offset: 1 })).toEqual({ path: "a.ts", offset: 1 })
    expect(Names.argsToV2("edit", { filePath: "a.ts", oldString: "a", newString: "b" })).toEqual({
      path: "a.ts",
      oldString: "a",
      newString: "b",
    })
    expect(Names.argsToV2("shell", { command: "ls" })).toEqual({ command: "ls" })
  })

  test("omo's tools drop their prefix, by the registered name when the call used an alias", () => {
    expect(Names.toolToV1("omo_task", { prompt: "p" })).toEqual({ tool: "task", args: { prompt: "p" } })
    expect(Names.toolToV1("task", { prompt: "p" }, "omo_task")).toEqual({ tool: "task", args: { prompt: "p" } })
    expect(Names.toolToV1("todowrite", { todos: [] }, "omo_todowrite")).toEqual({ tool: "todowrite", args: { todos: [] } })
    expect(Names.toolToV1("mystery", "not an object")).toEqual({ tool: "mystery", args: {} })
  })

  test("OpenCode 1 names a request lists (overlays, restrictions)", () => {
    expect(Names.toolToV2("bash")).toBe("shell")
    expect(Names.toolToV2("apply_patch")).toBe("patch")
    expect(Names.toolToV2("write")).toBe("write")
    expect(Names.toolToV2("task")).toBe("task")
  })
})

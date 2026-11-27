// 내 브라우저 사용 (BRW): OpenCode's Browse as the MCP server `browse` on this PC. The approval modes' decision per call,
// finding the `browse` program, the fold, the agent-wide deny, the `evaluate` hook on a fake context and `browse.set`.
// No real `browse` program runs and no browser is touched: the "program" is an empty file in the test's home.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { Mcp } from "@opencode/schema/mcp"
import type { Permission } from "@opencode/schema/permission"
import { OwnBrowse } from "@own/protocol"
import { Browse } from "../../src/browse/browse.js"
import { BrowseRpc } from "../../src/rpc/browse.js"
import { SessionApproval } from "../../src/switching/approval.js"
import { testDeps } from "../support/deps.js"

const ON = (mode: "read-only" | "ask" | "full") =>
  SessionApproval.withBrowse(SessionApproval.bundle(mode, []), "on", [])

describe("decide", () => {
  const act = { kind: "act" as const, effect: "allow" as const, saved: [] }

  test("full runs, ask asks, read-only refuses an action; a read is never changed", () => {
    expect(Browse.decide({ ...act, mode: "full" })).toBeUndefined()
    expect(Browse.decide({ ...act, mode: "ask" })).toEqual({ effect: "ask", message: Browse.MESSAGE.ask })
    expect(Browse.decide({ ...act, mode: "read-only" })).toEqual({ effect: "deny", message: Browse.MESSAGE.readOnly })
    for (const mode of ["full", "ask", "read-only", "custom"] as const)
      expect(Browse.decide({ ...act, kind: "read", mode })).toBeUndefined()
  })

  test("tighten only: a deny stays, a custom conversation keeps core's answer, a saved 항상 허용 counts in ask", () => {
    expect(Browse.decide({ ...act, mode: "ask", effect: "deny" })).toBeUndefined()
    expect(Browse.decide({ ...act, mode: "read-only", effect: "deny" })).toBeUndefined()
    expect(Browse.decide({ ...act, mode: "custom" })).toBeUndefined()
    // Core already asks: nothing to change.
    expect(Browse.decide({ ...act, mode: "ask", effect: "ask" })).toBeUndefined()
    // Core saves an MCP tool's 항상 허용 for every resource.
    expect(Browse.decide({ ...act, mode: "ask", saved: ["*"] })).toBeUndefined()
    // A saved approval does not lift read-only.
    expect(Browse.decide({ ...act, mode: "read-only", saved: ["*"] })?.effect).toBe("deny")
  })
})

describe("locate", () => {
  test("the given path only, else the install script's place, else an .exe on PATH (Windows)", async () => {
    await using t = await testDeps()
    const install = path.join(t.home, ".local", "bin", "browse.exe")
    const given = path.join(t.home, "tools", "browse.exe")
    const where = { home: t.home, platform: "win32" as const, which: () => path.join(t.home, "npm", "browse.cmd") }
    // Nothing yet: a package manager's .cmd shim on PATH does not count on Windows.
    expect(await Browse.locate({}, where)).toEqual({ source: "missing" })
    await fs.mkdir(path.dirname(install), { recursive: true })
    await fs.writeFile(install, "")
    expect(await Browse.locate({}, where)).toEqual({ source: "install", command: install })
    // A given path wins, and only that one counts: missing, relative or a folder is missing.
    expect(await Browse.locate({ command: given }, where)).toEqual({ source: "missing" })
    await fs.mkdir(path.dirname(given), { recursive: true })
    await fs.writeFile(given, "")
    expect(await Browse.locate({ command: ` ${given} ` }, where)).toEqual({ source: "setting", command: given })
    expect(await Browse.locate({ command: "browse.exe" }, where)).toEqual({ source: "missing" })
    expect(await Browse.locate({ command: path.dirname(given) }, where)).toEqual({ source: "missing" })
  })

  test("PATH: any program elsewhere, an .exe on Windows", async () => {
    await using t = await testDeps()
    const found = path.join(t.home, "bin", "browse")
    expect(await Browse.locate({}, { home: t.home, platform: "linux", which: () => found })).toEqual({
      source: "path",
      command: found,
    })
    const exe = path.join(t.home, "bin", "browse.EXE")
    expect(await Browse.locate({}, { home: t.home, platform: "win32", which: () => exe })).toEqual({
      source: "path",
      command: exe,
    })
  })
})

describe("fold and agents", () => {
  test("the server `browse mcp` with the plain tools, in every Location but the control one", () => {
    const set: Array<[string, Mcp.ServerConfig]> = []
    const editor = { set: (name: string, config: Mcp.ServerConfig) => void set.push([name, config]) } as never
    Browse.fold(editor, undefined, { directory: "D:/work", control: false })
    Browse.fold(editor, "C:/b/browse.exe", { directory: "D:/work", control: true })
    expect(set).toEqual([])
    Browse.fold(editor, "C:/b/browse.exe", { directory: "D:/work", control: false })
    expect(set).toEqual([
      [
        "browse",
        { type: "local", command: ["C:/b/browse.exe", "mcp"], environment: { OPENCODE_BROWSER_TOOLS: "plain" } },
      ],
    ])
  })

  test("every agent ends with the deny once, however often the transform runs", () => {
    const agents = new Map([
      ["build", { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] as Permission.Rule[] }],
      [
        "explore",
        { id: "explore", permissions: [{ action: "*", resource: "*", effect: "deny" }] as Permission.Rule[] },
      ],
    ])
    const editor = {
      list: () => [...agents.values()],
      update: (id: string, change: (info: { permissions: Permission.Rule[] }) => void) => change(agents.get(id)!),
    } as never
    Browse.deny(editor)
    agents.get("build")!.permissions.push({ action: "read", resource: "*", effect: "allow" })
    Browse.deny(editor)
    expect(agents.get("build")!.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "allow" },
      OwnBrowse.DENY,
    ])
    expect(agents.get("explore")!.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }, OwnBrowse.DENY])
  })
})

/** The plugin context parts the module uses; `session.get` answers the given rules. */
function fakeContext(sessions: ReadonlyMap<string, ReadonlyArray<Permission.Rule>>) {
  const folds: Array<(editor: never) => void> = []
  const agents: Array<{ callback: (editor: never) => void; disposed: boolean }> = []
  const hooks: Array<(event: PermissionEvaluation) => unknown> = []
  const state = { reloads: 0 }
  const ctx = {
    mcp: {
      transform: async (callback: (editor: never) => void) => {
        folds.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {
        state.reloads += 1
      },
    },
    agent: {
      transform: async (callback: (editor: never) => void) => {
        const registration = { callback, disposed: false }
        agents.push(registration)
        return {
          dispose: async () => {
            registration.disposed = true
          },
        }
      },
    },
    permission: {
      hook: async (_name: string, callback: (event: PermissionEvaluation) => unknown) => {
        hooks.push(callback)
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async (input: { sessionID: string }) => {
        const rules = sessions.get(input.sessionID)
        if (!rules) throw new Error(`session not found: ${input.sessionID}`)
        return { id: input.sessionID, permissions: rules }
      },
    },
  }
  const servers = () => {
    const set: string[][] = []
    const editor = { set: (name: string, config: { command: string[] }) => void set.push([name, ...config.command]) }
    for (const fold of folds) fold(editor as never)
    return set
  }
  const evaluate = async (sessionID: string, action: string, input?: unknown, effect: Permission.Effect = "allow") => {
    // SAFETY: ids are branded strings in the plugin types; the hook reads them as strings.
    const event = {
      sessionID,
      action,
      resources: ["*"],
      saved: [],
      effect,
      ...(input === undefined ? {} : { metadata: { input } }),
    } as unknown as PermissionEvaluation
    for (const hook of hooks) await hook(event)
    return event.effect
  }
  return { ctx, state, servers, evaluate, agents, folds }
}

async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

describe("register", () => {
  const sessions = new Map<string, ReadonlyArray<Permission.Rule>>([
    ["ses_full", ON("full")],
    ["ses_ask", ON("ask")],
    ["ses_read", ON("read-only")],
    ["ses_custom", [{ ...OwnBrowse.ALLOW }]],
  ])

  test("each approval mode decides each call by its kind; other actions are untouched", async () => {
    const fake = fakeContext(sessions)
    await using t = await testDeps({ ctx: fake.ctx })
    const browse = await Browse.register(t.deps)
    try {
      const judged = await Promise.all([
        fake.evaluate("ses_full", "browse_click"),
        fake.evaluate("ses_full", "browse_eval"),
        fake.evaluate("ses_ask", "browse_click"),
        fake.evaluate("ses_ask", "browse_navigate"),
        fake.evaluate("ses_ask", "browse_snapshot"),
        fake.evaluate("ses_ask", "browse_screenshot"),
        fake.evaluate("ses_ask", "browse_tabs", { action: "list" }),
        fake.evaluate("ses_ask", "browse_tabs", { action: "new", id: "work-mail" }),
        fake.evaluate("ses_ask", "browse_a_new_tool"),
        fake.evaluate("ses_read", "browse_fill"),
        fake.evaluate("ses_read", "browse_snapshot"),
        fake.evaluate("ses_custom", "browse_click"),
        // A conversation that cannot be read asks before an action (fail closed).
        fake.evaluate("ses_gone", "browse_click"),
        fake.evaluate("ses_ask", "browse_click", undefined, "deny"),
        fake.evaluate("ses_ask", "webfetch"),
        fake.evaluate("ses_ask", "browser"),
      ])
      expect(judged).toEqual([
        "allow",
        "allow",
        "ask",
        "ask",
        "allow",
        "allow",
        "allow",
        "ask",
        "ask",
        "deny",
        "allow",
        "allow",
        "ask",
        "deny",
        "allow",
        "allow",
      ])
    } finally {
      await browse.stop()
    }
  })

  test("off: no server; browse.set on with a program folds `browse mcp` and reloads; off again removes it", async () => {
    const fake = fakeContext(sessions)
    await using t = await testDeps({ ctx: fake.ctx })
    const browse = await Browse.register(t.deps)
    const rpc = BrowseRpc.handlers(t.deps)
    try {
      expect(fake.servers()).toEqual([])
      // On, but no program anywhere this test looks: still no server, and the page says so.
      const program = path.join(t.home, "programs", "browse.exe")
      const missing = await rpc["browse.set"]({ enabled: true, command: program }, {} as never)
      expect(missing).toEqual({ enabled: true, source: "missing", given: true, active: false })
      await fs.mkdir(path.dirname(program), { recursive: true })
      await fs.writeFile(program, "")
      expect(await rpc["browse.status"]({}, {} as never)).toEqual({
        enabled: true,
        source: "setting",
        command: program,
        given: true,
        active: true,
      })
      // The status read changed nothing; the next write tells every Location.
      await rpc["browse.set"]({ command: program }, {} as never)
      await until(() => fake.state.reloads === 1)
      expect(fake.servers()).toEqual([["browse", program, "mcp"]])
      expect(await Bun.file(t.deps.runtime.layout.browse).json()).toEqual({
        version: 1,
        enabled: true,
        command: program,
      })
      await rpc["browse.set"]({ enabled: false }, {} as never)
      await until(() => fake.state.reloads === 2)
      expect(fake.servers()).toEqual([])
    } finally {
      await browse.stop()
    }
  })

  test("the agent deny registers again after a local plugin.updated, dropping the earlier one", async () => {
    const fake = fakeContext(sessions)
    await using t = await testDeps({ ctx: fake.ctx })
    const browse = await Browse.register(t.deps)
    try {
      expect(fake.agents.map((item) => item.disposed)).toEqual([false])
      browse.onEvent({ type: "plugin.updated" }, { local: false })
      browse.onEvent({ type: "session.created" }, { local: true })
      browse.onEvent({ type: "plugin.updated" }, { local: true })
      await until(() => fake.agents.length === 2 && fake.agents[0]!.disposed)
      expect(fake.agents.map((item) => item.disposed)).toEqual([true, false])
    } finally {
      await browse.stop()
    }
    expect(fake.agents.every((item) => item.disposed)).toBe(true)
  })

  test("an SSH host's service never folds the server (no `mcp` in its context) but gates the tools", async () => {
    const fake = fakeContext(sessions)
    const { mcp: _mcp, ...rest } = fake.ctx
    await using t = await testDeps({ ctx: rest, remote: {} as never })
    const browse = await Browse.register(t.deps)
    try {
      expect(fake.folds).toEqual([])
      expect(fake.agents).toHaveLength(1)
      expect(await fake.evaluate("ses_ask", "browse_click")).toBe("ask")
      // A given path, so the lookup never reaches the real home folder or PATH; present and on, still not active.
      const program = path.join(t.home, "browse.exe")
      await fs.writeFile(program, "")
      await Browse.file(t.deps).write({ version: 1, enabled: true, command: program })
      expect(await BrowseRpc.handlers(t.deps)["browse.status"]({}, {} as never)).toEqual({
        enabled: true,
        source: "setting",
        command: program,
        given: true,
        active: false,
      })
    } finally {
      await browse.stop()
    }
  })
})

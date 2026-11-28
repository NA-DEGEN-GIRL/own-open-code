// MCP servers of this PC on an SSH host (04 §13 "MCP", MH 2026-11-26), over temp OWN_HOMEs and the in-memory vault:
// the host's `mcp.host.*` (its own list, `~` made absolute, the probe in its environment, the connection test with the
// values the PC sent, the pre-fetch plan), its fold (a server off until its values came), the PC's `mcp.hosts.*` (the
// explicit send step: a copy in the vault, names only in files and answers, `differs`, the withdrawal), the broker's
// answer for that host only, and the install tool of `AI에게 설치 맡기기` (only in a job's conversation, the approval
// mode, never a PC value in `fixed`). Fake values only.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import os from "node:os"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { Mcp } from "@opencode/schema/mcp"
import { Broker, McpHost, OwnMcp } from "@own/protocol"
import { McpHostService } from "../../src/mcp/host.js"
import { McpHostTool } from "../../src/mcp/host-tool.js"
import { McpServers } from "../../src/mcp/register.js"
import { McpSends } from "../../src/mcp/sends.js"
import { McpStore } from "../../src/mcp/store.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { McpRpc } from "../../src/rpc/mcp.js"
import { Register } from "../../src/rpc/register.js"
import { FAKE_MCP_STDIO } from "../e2e-kit/fakes/mcp-stdio.js"
import { call, ok, recordEvents, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

setDefaultTimeout(30_000)

const TOKEN = "ghp_fakeOwnMcpHostToken000000000Hs7q"
const HOST = "h-build01"

/** The host's view of the PC: what it sent, by server id; `on` fires as the broker's `mcp.changed` would. */
function fakePc(initial: Record<string, Broker.McpValues> = {}) {
  const sent = new Map(Object.entries(initial))
  const listeners = new Set<() => void>()
  const asked: string[] = []
  const state = { reachable: true }
  const mcp: RemoteHost.Mcp = {
    values: async (server) => {
      asked.push(server)
      if (!state.reachable) return undefined
      return sent.get(server) ?? { sent: false, env: {}, headers: {} }
    },
    on: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  return {
    mcp,
    asked,
    state,
    send(server: string, values: Partial<Broker.McpValues>) {
      sent.set(server, { sent: true, env: {}, headers: {}, ...values })
      for (const listener of listeners) listener()
    },
    withdraw(server: string) {
      sent.delete(server)
      for (const listener of listeners) listener()
    },
  }
}

function editor() {
  const servers = new Map<string, Mcp.ServerConfig>()
  const edit: MCPEditor = {
    list: () => [...servers] as never,
    get: (name) => servers.get(name) as never,
    set: (name, config) => void servers.set(name, structuredClone(config)),
    update: (name, update) => {
      const current = servers.get(name)
      if (current) update(current as never)
    },
    remove: (name) => void servers.delete(name),
  }
  return { edit, servers }
}

async function hostRig(pc = fakePc()) {
  const t = await testDeps({ control: true, remote: { mcp: pc.mcp } as unknown as RemoteHost.Api })
  return {
    t,
    pc,
    rpc: Register.remoteHandlers(McpRpc.handlers(t.deps) as never) as unknown as ReturnType<typeof McpRpc.handlers>,
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

const tiny = (env: string[] = []): McpHost.Local => ({
  type: "local",
  command: process.execPath,
  args: [FAKE_MCP_STDIO, "search_docs"],
  env,
})
const PC = { key: "own:mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6Y", hash: "0123456789abcdef", at: 1 }

describe("the host's own list (mcp.host.*)", () => {
  test("save makes `~` absolute, keeps the PC's key, refuses a taken name and a reference without a value", async () => {
    await using rig = await hostRig()
    const view = await ok(rig.rpc["mcp.host.save"], {
      name: "docs",
      transport: {
        type: "local",
        command: "~/bin/docs-mcp",
        args: ["--root=~/notes", "~/data:/data"],
        cwd: "~",
        env: [],
      },
      pc: PC,
    })
    const home = os.homedir().replace(/\/+$/, "")
    expect(view.servers[0]).toMatchObject({
      name: "docs",
      pc: PC,
      values: "none",
      transport: { command: `${home}/bin/docs-mcp`, args: [`--root=${home}/notes`, `${home}/data:/data`], cwd: home },
    })
    expect(view.home).toBe(os.homedir())
    const taken = await call(rig.rpc["mcp.host.save"], { name: "DOCS", transport: tiny() })
    expect(taken).toMatchObject({ ok: false, type: "mcp_name_taken" })
    const reference = await call(rig.rpc["mcp.host.save"], {
      name: "other",
      transport: { ...tiny(), args: ["--token", "${TOKEN}"] } as McpHost.Transport,
    })
    expect(reference).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "args" } })
    // No value is ever in the host's file.
    expect(await Bun.file(rig.t.deps.runtime.layout.mcp).text()).not.toContain("ghp_")
  })

  test("a server with values is `missing` until the PC sent them; the test runs with them, and never without", async () => {
    const pc = fakePc()
    await using rig = await hostRig(pc)
    const saved = await ok(rig.rpc["mcp.host.save"], {
      name: "github",
      transport: { ...tiny(["GITHUB_TOKEN"]), fixed: { MODE: "plain" } } as McpHost.Transport,
      pc: PC,
    })
    const id = saved.servers[0]!.id
    expect(saved.servers[0]!.values).toBe("missing")
    // FAKE_MCP_REQUIRE: the fake server exits without the value, as a real one would without its token.
    await ok(rig.rpc["mcp.host.save"], {
      id,
      name: "github",
      transport: { ...tiny(["GITHUB_TOKEN"]), fixed: { FAKE_MCP_REQUIRE: "GITHUB_TOKEN" } } as McpHost.Transport,
    })
    // The host keeps it off without its value, so the test starts nothing either.
    const without = await call(rig.rpc["mcp.host.test"], { id })
    expect(without).toMatchObject({ ok: false, type: "mcp_secret_missing", data: { name: "GITHUB_TOKEN" } })
    expect((await ok(rig.rpc["mcp.host.view"], {})).servers[0]).not.toHaveProperty("check")
    // The test takes what the fold gives core: only the names the host waits for. A copy the PC holds of another name
    // (one the host set itself since) stays out of it, as it stays out of the server the host's conversations start.
    pc.send(id, { env: { GITHUB_TOKEN: TOKEN, FAKE_MCP_FAIL: "a name the host does not take reached the test" } })
    const withValues = await ok(rig.rpc["mcp.host.test"], { id })
    expect(withValues).toMatchObject({ ok: true, tools: [{ name: "search_docs" }] })
    const view = await ok(rig.rpc["mcp.host.view"], {})
    expect(view.servers[0]).toMatchObject({ values: "ready", check: { ok: true }, pc: PC })
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(await Bun.file(rig.t.deps.runtime.layout.mcp).text()).not.toContain(TOKEN)
    // Withdrawn: off again, and the passed test no longer stands for it.
    pc.withdraw(id)
    expect(await call(rig.rpc["mcp.host.test"], { id })).toMatchObject({ ok: false, type: "mcp_secret_missing" })
    expect((await ok(rig.rpc["mcp.host.view"], {})).servers[0]).toMatchObject({ values: "missing" })
    expect((await ok(rig.rpc["mcp.host.view"], {})).servers[0]).not.toHaveProperty("check")
  })

  test("a server that does not need its value from the PC is not tested as if it did (2.4.1-own.5's llm-router)", async () => {
    // The report's shape: a script that runs without LLM_ROUTER_MCP_STATE_DIR (it has a default), registered on the host
    // waiting for the PC's copy. The test once ran it without the value (12 tools) while the fold kept it off.
    const pc = fakePc()
    await using rig = await hostRig(pc)
    const waiting = await ok(rig.rpc["mcp.host.save"], {
      name: "llm-router",
      transport: { ...tiny(["LLM_ROUTER_MCP_STATE_DIR"]) } as McpHost.Transport,
      pc: PC,
    })
    const id = waiting.servers[0]!.id
    expect(waiting.servers[0]!.values).toBe("missing")
    expect(await call(rig.rpc["mcp.host.test"], { id })).toMatchObject({ ok: false, type: "mcp_secret_missing" })
    // Set on the host instead (not a secret): no longer waiting, and the test is what runs.
    const own = await ok(rig.rpc["mcp.host.save"], {
      id,
      name: "llm-router",
      transport: {
        ...tiny(),
        fixed: { LLM_ROUTER_MCP_STATE_DIR: "~/.local/state/llm-router", FAKE_MCP_REQUIRE: "LLM_ROUTER_MCP_STATE_DIR" },
      } as McpHost.Transport,
    })
    const home = os.homedir().replace(/\/+$/, "")
    expect(own.servers[0]).toMatchObject({
      values: "none",
      transport: { env: [], fixed: { LLM_ROUTER_MCP_STATE_DIR: `${home}/.local/state/llm-router` } },
    })
    expect(await ok(rig.rpc["mcp.host.test"], { id })).toMatchObject({ ok: true, tools: [{ name: "search_docs" }] })
  })

  test("the probe reads the service's environment, read only, and names programs asked for", async () => {
    await using rig = await hostRig()
    const probe = await ok(rig.rpc["mcp.host.probe"], { binaries: ["bun", "surely-not-installed-xyz"] })
    expect(probe.home).toBe(os.homedir())
    expect(probe.arch).toBe(os.arch())
    expect(probe.binaries).toEqual({ bun: true, "surely-not-installed-xyz": false })
    // Run from source the service's program is bun itself: it runs as bun.
    expect(probe.ownBun?.command).toBe(process.execPath)
  })

  test("remove; an unknown id; the pre-fetch plan per launcher", async () => {
    await using rig = await hostRig()
    const saved = await ok(rig.rpc["mcp.host.save"], { name: "plain", transport: tiny() })
    expect(await ok(rig.rpc["mcp.host.prefetch"], { id: saved.servers[0]!.id })).toEqual({ ok: true, kind: "none" })
    expect((await ok(rig.rpc["mcp.host.remove"], { id: saved.servers[0]!.id })).servers).toEqual([])
    expect(await call(rig.rpc["mcp.host.test"], { id: saved.servers[0]!.id })).toMatchObject({
      ok: false,
      type: "mcp_not_found",
    })
    expect(
      McpHostService.prefetchPlan({ type: "local", command: "npx", args: ["-y", "@scope/x@1.2.0"], env: [] }),
    ).toEqual({
      kind: "npm",
      argv: ["npm", "exec", "--yes", "--package=@scope/x@1.2.0", "--", "true"],
    })
    expect(
      McpHostService.prefetchPlan({ type: "local", command: "uvx", args: ["mcp-server-fetch==2025.1.17"], env: [] }),
    ).toEqual({
      kind: "uv",
      argv: ["uv", "tool", "install", "mcp-server-fetch==2025.1.17"],
    })
    expect(
      McpHostService.prefetchPlan({ type: "local", command: "docker", args: ["run", "-i", "mcp/time"], env: [] }),
    ).toBeUndefined()
  })

  test("this PC's service answers mcp_host_only; a host refuses the PC's records (remote_managed)", async () => {
    await using pcRig = await testDeps({ control: true })
    const pcRpc = McpRpc.handlers(pcRig.deps)
    expect(await call(pcRpc["mcp.host.view"], {})).toMatchObject({ ok: false, type: "mcp_host_only" })
    expect(await call(pcRpc["mcp.host.save"], { name: "x", transport: tiny() })).toMatchObject({
      ok: false,
      type: "mcp_host_only",
    })
    await using rig = await hostRig()
    expect(await call(rig.rpc["mcp.hosts.view"], {})).toMatchObject({ ok: false, type: "remote_managed" })
  })
})

describe("the host's fold", () => {
  test("a server stays off until the PC's values came, and goes off again when they are withdrawn", async () => {
    const pc = fakePc()
    const state: { run?: (editor: MCPEditor) => void; folded: Map<string, Mcp.ServerConfig>; reloads: number } = {
      folded: new Map(),
      reloads: 0,
    }
    const fold = () => {
      const next = editor()
      state.run?.(next.edit)
      state.folded = next.servers
    }
    await using t = await testDeps({
      directory: os.tmpdir(),
      remote: { mcp: pc.mcp } as unknown as RemoteHost.Api,
      ctx: {
        mcp: {
          transform: async (run: (editor: MCPEditor) => void) => {
            state.run = run
            fold()
            return { dispose: async () => {} }
          },
          // Core folds again on a reload.
          reload: async () => {
            state.reloads += 1
            fold()
          },
        },
      },
    })
    const service = McpHostService.create(t.deps, pc.mcp)
    const saved = await service.save({ name: "github", transport: tiny(["GITHUB_TOKEN"]) })
    if (!saved.ok) throw new Error(saved.error.type)
    await service.save({ name: "plain", transport: { ...tiny(), fixed: { BUN_BE_BUN: "1" } } })
    const id = saved.value.servers.find((item) => item.name === "github")!.id
    const stop = await McpServers.register(t.deps, McpHostService.source(pc.mcp))
    await until(() => state.folded.has("github") && state.folded.has("plain"))
    expect(state.folded.get("github")).toMatchObject({ disabled: true })
    expect(state.folded.get("plain")).toMatchObject({ environment: { BUN_BE_BUN: "1" } })
    expect(state.folded.get("plain")).not.toHaveProperty("disabled")
    pc.send(id, { env: { GITHUB_TOKEN: TOKEN } })
    await until(() => state.folded.get("github")?.disabled !== true)
    expect(state.folded.get("github")).toMatchObject({ type: "local", environment: { GITHUB_TOKEN: TOKEN } })
    pc.withdraw(id)
    await until(() => state.folded.get("github")?.disabled === true)
    stop()
  })
})

describe("the PC's records of values sent to hosts (mcp.hosts.*)", () => {
  async function pcRig() {
    const t = await testDeps({ control: true })
    const events = recordEvents(t.deps)
    const broadcast: string[] = []
    t.deps.runtime.broadcast.on("mcp.hosts.changed", (change) => void broadcast.push(change.hostId))
    return {
      t,
      events,
      broadcast,
      rpc: McpRpc.handlers(t.deps),
      [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
    }
  }

  test("sending own's server's values: a copy in the vault, names only on disk and in answers, that host only", async () => {
    await using rig = await pcRig()
    const view = await ok(rig.rpc["mcp.save"], {
      name: "github",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: "npx",
        args: ["-y", "@example/github-mcp"],
        env: [
          { name: "GITHUB_TOKEN", value: TOKEN },
          { name: "MODE", value: "production" },
        ],
      },
    })
    const id = view.servers[0]!.id
    const server = OwnMcp.ID.create()
    // Nothing goes before the user's step.
    expect(await McpSends.values(rig.t.deps, HOST, server)).toEqual({ sent: false, env: {}, headers: {} })
    const sent = await ok(rig.rpc["mcp.hosts.send"], {
      hostId: HOST,
      server,
      source: { type: "own", id },
      names: ["GITHUB_TOKEN"],
    })
    expect(sent.sends).toEqual([
      { hostId: HOST, server, names: ["GITHUB_TOKEN"], source: { type: "own", id }, at: expect.any(Number) },
    ])
    expect(rig.broadcast).toEqual([HOST])
    expect(await McpSends.values(rig.t.deps, HOST, server)).toEqual({
      sent: true,
      env: { GITHUB_TOKEN: TOKEN },
      headers: {},
    })
    // Another host asking for the same server id gets nothing.
    expect(await McpSends.values(rig.t.deps, "h-other01", server)).toEqual({ sent: false, env: {}, headers: {} })
    const file = await Bun.file(rig.t.deps.runtime.layout.mcpHosts).text()
    expect(file).toContain("GITHUB_TOKEN")
    expect(file).not.toContain(TOKEN)
    expect(JSON.stringify(sent)).not.toContain(TOKEN)
    expect(rig.events.some((event) => event.name === "mcp.changed")).toBe(true)
  })

  test("`differs` after the PC's value changed; sending again replaces the copy; a missing name is refused", async () => {
    await using rig = await pcRig()
    const view = await ok(rig.rpc["mcp.save"], {
      name: "github",
      scope: { type: "global" },
      transport: { type: "local", command: "npx", args: ["-y", "x"], env: [{ name: "GITHUB_TOKEN", value: TOKEN }] },
    })
    const id = view.servers[0]!.id
    const server = OwnMcp.ID.create()
    await ok(rig.rpc["mcp.hosts.send"], { hostId: HOST, server, source: { type: "own", id }, names: ["GITHUB_TOKEN"] })
    expect((await ok(rig.rpc["mcp.hosts.view"], { hostId: HOST })).sends[0]!.differs).toBeUndefined()
    const rotated = `${TOKEN.slice(0, -4)}Rt9z`
    await ok(rig.rpc["mcp.save"], {
      id,
      name: "github",
      scope: { type: "global" },
      transport: { type: "local", command: "npx", args: ["-y", "x"], env: [{ name: "GITHUB_TOKEN", value: rotated }] },
    })
    expect((await ok(rig.rpc["mcp.hosts.view"], {})).sends[0]!.differs).toBe(true)
    // The host keeps what was sent until the user sends again.
    expect((await McpSends.values(rig.t.deps, HOST, server)).env).toEqual({ GITHUB_TOKEN: TOKEN })
    await ok(rig.rpc["mcp.hosts.send"], { hostId: HOST, server, source: { type: "own", id }, names: ["GITHUB_TOKEN"] })
    expect((await McpSends.values(rig.t.deps, HOST, server)).env).toEqual({ GITHUB_TOKEN: rotated })
    expect((await ok(rig.rpc["mcp.hosts.view"], {})).sends).toHaveLength(1)
    expect(
      await call(rig.rpc["mcp.hosts.send"], { hostId: HOST, server, source: { type: "own", id }, names: ["NOPE"] }),
    ).toMatchObject({ ok: false, type: "mcp_secret_missing", data: { name: "NOPE" } })
  })

  test("a config file's server: the page passes its values once; the address's parts go as URL; withdrawal", async () => {
    await using rig = await pcRig()
    const server = OwnMcp.ID.create()
    await ok(rig.rpc["mcp.hosts.send"], {
      hostId: HOST,
      server,
      source: {
        type: "file",
        name: "ctx",
        transport: {
          type: "remote",
          url: "https://mcp.example.test/mcp?key=fake-query-key-0000",
          headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
          oauth: false,
        },
      },
      names: ["Authorization", McpHost.ADDRESS],
    })
    expect(await McpSends.values(rig.t.deps, HOST, server)).toEqual({
      sent: true,
      env: {},
      headers: { Authorization: `Bearer ${TOKEN}` },
      search: "?key=fake-query-key-0000",
    })
    const after = await ok(rig.rpc["mcp.hosts.unsend"], { hostId: HOST, server })
    expect(after.sends).toEqual([])
    expect(await McpSends.values(rig.t.deps, HOST, server)).toEqual({ sent: false, env: {}, headers: {} })
    expect(rig.broadcast).toEqual([HOST, HOST])
  })
})

describe("the install tool (AI에게 설치 맡기기)", () => {
  const job: McpHost.Job = { key: PC.key, hash: PC.hash, name: "tiny", env: ["API_KEY"] }

  test("the job is read from the conversation's metadata; anything else is none", () => {
    expect(McpHostTool.jobOf({ own: { mcpInstall: job } })).toEqual(job)
    expect(McpHostTool.jobOf({ own: { mcpInstall: { ...job, name: "bad name!" } } })).toBeUndefined()
    expect(McpHostTool.jobOf({})).toBeUndefined()
  })

  test("the approval mode decides the write, tighten only", () => {
    expect(McpHostTool.decide("full", "allow")).toBeUndefined()
    expect(McpHostTool.decide("ask", "allow")).toEqual({ effect: "ask", message: McpHostTool.MESSAGE.ask })
    expect(McpHostTool.decide("read-only", "allow")?.effect).toBe("deny")
    expect(McpHostTool.decide("ask", "deny")).toBeUndefined()
  })

  test("only a job's conversation registers; `fixed` never takes a PC secret's name; the result carries the test", async () => {
    const pc = fakePc()
    const added: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }> =
      []
    const agents: Array<(editor: unknown) => void> = []
    const asserted: unknown[] = []
    const sessions: Record<string, unknown> = {
      job: { id: "job", permissions: [], metadata: { own: { mcpInstall: { ...job, env: [] } } } },
      leak: { id: "leak", permissions: [], metadata: { own: { mcpInstall: job } } },
      marked: {
        id: "marked",
        permissions: [],
        metadata: { own: { mcpInstall: { ...job, env: ["ROUTER_DSN"], secrets: ["ROUTER_DSN"] } } },
      },
      router: {
        id: "router",
        permissions: [],
        metadata: { own: { mcpInstall: { ...job, key: "own:router", name: "llm-router", env: ["LLM_ROUTER_MCP_STATE_DIR"] } } },
      },
      plain: { id: "plain", permissions: [], metadata: {} },
    }
    await using t = await testDeps({
      directory: os.tmpdir(),
      remote: { mcp: pc.mcp } as unknown as RemoteHost.Api,
      ctx: {
        tool: {
          transform: async (run: (editor: unknown) => void) => {
            run({ add: (tool: (typeof added)[number]) => void added.push(tool) })
            return { dispose: async () => {} }
          },
        },
        agent: {
          transform: async (run: (editor: unknown) => void) => {
            agents.push(run)
            return { dispose: async () => {} }
          },
        },
        permission: {
          hook: async () => ({ dispose: async () => {} }),
          assert: async (input: unknown) => void asserted.push(input),
        },
        session: { get: async (input: { sessionID: string }) => sessions[input.sessionID] },
      },
    })
    const tool = await McpHostTool.register(t.deps, pc.mcp)
    const service = () => McpHostService.create(t.deps, pc.mcp)
    expect(added.map((item) => item.name)).toEqual([McpHost.TOOL])
    const context = (sessionID: string) => ({
      sessionID,
      agent: "build",
      messageID: "m1",
      id: "c1",
      signal: new AbortController().signal,
    })
    const execute = added[0]!.execute
    await expect(execute({ command: "x", args: [] }, context("plain"))).rejects.toThrow(McpHostTool.MESSAGE.noJob)
    await expect(execute({ command: "x", args: [], fixed: { API_KEY: "a" } }, context("leak"))).rejects.toThrow(
      "API_KEY",
    )
    // A name the PC's analysis took for a secret, whatever it looks like.
    await expect(execute({ command: "x", args: [], fixed: { ROUTER_DSN: "a" } }, context("marked"))).rejects.toThrow(
      "ROUTER_DSN",
    )
    // The secret waits for the PC: registered off, no test run, and the AI is told why.
    const off = await execute({ command: process.execPath, args: [FAKE_MCP_STDIO, "lookup"] }, context("leak"))
    expect(off.content).toContain("have not been sent yet")
    expect(off.content).not.toContain("Connection test")
    await service().remove((await service().view()).servers[0]!.id)
    const result = await execute({ command: process.execPath, args: [FAKE_MCP_STDIO, "lookup"] }, context("job"))
    expect(result.content).toContain('Registered "tiny"')
    expect(result.content).toContain("Connection test: OK")
    // Every write asked the approval first (the off one above and this one).
    expect(asserted).toHaveLength(2)
    expect((await service().view()).servers).toMatchObject([
      { name: "tiny", pc: { key: PC.key, hash: PC.hash }, check: { ok: true } },
    ])
    // A value that is not a secret (2.4.1-own.5's LLM_ROUTER_MCP_STATE_DIR): the AI sets it for this host, and the
    // server runs without waiting for the PC's copy (this PC's path).
    const router = await execute(
      {
        command: process.execPath,
        args: [FAKE_MCP_STDIO, "lookup"],
        fixed: { LLM_ROUTER_MCP_STATE_DIR: "~/.local/state/llm-router", FAKE_MCP_REQUIRE: "LLM_ROUTER_MCP_STATE_DIR" },
      },
      context("router"),
    )
    expect(router.content).toContain("Set on this host: LLM_ROUTER_MCP_STATE_DIR.")
    expect(router.content).toContain("Connection test: OK")
    expect((await service().view()).servers.find((server) => server.name === "llm-router")).toMatchObject({
      values: "none",
      check: { ok: true },
      transport: { env: [], fixed: { LLM_ROUTER_MCP_STATE_DIR: expect.stringContaining(".local/state/llm-router") } },
    })
    // Every agent denies the tool (the job's conversation allows it in its own rules).
    const list = [{ id: "build", permissions: [] as unknown[] }]
    agents[0]!({
      list: () => list,
      update: (_id: string, update: (info: { permissions: unknown[] }) => void) => update(list[0]!),
    })
    expect(list[0]!.permissions).toEqual([McpHostTool.DENY])
    await tool.stop()
  })
})

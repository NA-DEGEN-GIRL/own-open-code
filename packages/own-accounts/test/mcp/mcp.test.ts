// MCP servers own adds (03 §18.14, SM 2026-10-24): the fold core runs in every Location, the `mcp.*` methods over a
// temp OWN_HOME and the in-memory vault (values never in the file or an answer, kept values, name clashes, switches,
// removal), the connection test against the e2e kit's fake stdio server and a fake HTTP server, the import from fake
// Codex and Claude Code homes, and 찾아서 설치 against a fake MCP Registry. Fake values only; nothing reaches the
// real registry.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { Mcp } from "@opencode/schema/mcp"
import { McpSecrets, OwnMcp } from "@own/protocol"
import { Vault } from "@own/runtime"
import { McpFold } from "../../src/mcp/fold.js"
import { McpProbe } from "../../src/mcp/probe.js"
import { McpServers } from "../../src/mcp/register.js"
import { McpRegistry } from "../../src/mcp/registry.js"
import { McpSources } from "../../src/mcp/sources.js"
import { McpStore } from "../../src/mcp/store.js"
import { McpRpc } from "../../src/rpc/mcp.js"
import { Register } from "../../src/rpc/register.js"
import { FAKE_MCP_STDIO } from "../e2e-kit/fakes/mcp-stdio.js"
import { call, ok, recordEvents, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

// The connection tests start a Bun process each: on a busy PC that alone can take longer than bun's 5 s default.
setDefaultTimeout(30_000)

const TOKEN = "ghp_fakeOwnMcpToken0000000000Wx9z"
const KEY = "fake-search-key-0000-Kq2m"
/** A fake random key for an address's path: there a value that reads as words (`fake-search-key-…`) is a name (SM-28). */
const PATH_KEY = "fakeQz8wXk3Rt5yHn7Lm2Pk9Vb"

/** A fake MCP editor over a plain map, as core's state gives the transforms. */
function editor(initial: Record<string, Mcp.ServerConfig> = {}) {
  const servers = new Map<string, Mcp.ServerConfig>(
    Object.entries(initial).map(([name, config]) => [name, { ...config }]),
  )
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

async function rig(options: Record<string, unknown> = {}) {
  const t = await testDeps({ control: true, ...(Object.keys(options).length ? { options: options as never } : {}) })
  return {
    t,
    events: recordEvents(t.deps),
    rpc: McpRpc.handlers(t.deps),
    file: () => Bun.file(t.deps.runtime.layout.mcp).text(),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

const local = (env: { name: string; value?: string }[] = []): OwnMcp.TransportInput => ({
  type: "local",
  command: process.execPath,
  args: [FAKE_MCP_STDIO],
  env,
})

describe("fold", () => {
  const entry = (name: string, scope: OwnMcp.Scope, transport: McpStore.Entry["transport"]): McpStore.Entry => ({
    id: OwnMcp.ID.create(),
    name,
    scope,
    transport,
    createdAt: 0,
    updatedAt: 0,
  })
  const cmd = (env: string[] = []): McpStore.Entry["transport"] => ({
    type: "local",
    command: "node",
    args: ["server.js"],
    env,
  })

  test("own's servers where their scope reaches, with their values; never in the control Location", () => {
    const project = path.resolve("/work/game")
    const snapshot: McpFold.Snapshot = {
      servers: [
        { entry: entry("everywhere", { type: "global" }, cmd(["TOKEN"])), values: { env: { TOKEN }, headers: {} } },
        { entry: entry("game-only", { type: "project", directory: project }, cmd()), values: McpStore.NO_VALUES },
        {
          entry: entry(
            "api",
            { type: "global" },
            {
              type: "remote",
              url: "https://mcp.example.test/mcp",
              query: true,
              headers: ["Authorization"],
              oauth: false,
            },
          ),
          values: { env: {}, headers: { Authorization: `Bearer ${TOKEN}` }, search: `?key=${KEY}` },
        },
      ],
      overrides: [],
    }
    const inside = editor()
    McpFold.fold(inside.edit, snapshot, { directory: path.join(project, "src"), control: false })
    expect(Object.fromEntries(inside.servers)).toEqual({
      everywhere: { type: "local", command: ["node", "server.js"], environment: { TOKEN } },
      "game-only": { type: "local", command: ["node", "server.js"] },
      api: {
        type: "remote",
        url: `https://mcp.example.test/mcp?key=${KEY}`,
        headers: { Authorization: `Bearer ${TOKEN}` },
        oauth: false,
      },
    })
    const elsewhere = editor()
    McpFold.fold(elsewhere.edit, snapshot, { directory: path.resolve("/work/other"), control: false })
    expect([...elsewhere.servers.keys()].sort()).toEqual(["api", "everywhere"])
    const control = editor()
    McpFold.fold(control.edit, snapshot, { directory: path.resolve("/own/control"), control: true })
    expect(control.servers.size).toBe(0)
  })

  test("a server whose values the vault did not give stays off", () => {
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry: entry("x", { type: "global" }, cmd(["TOKEN"])), values: undefined }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("x")).toEqual({ type: "local", command: ["node", "server.js"], disabled: true })
  })

  test("a server whose values are missing stays off whatever a kept switch says", () => {
    const project = path.resolve("/work/game")
    const fold = editor()
    McpFold.fold(
      fold.edit,
      {
        servers: [
          { entry: entry("locked", { type: "global" }, cmd(["TOKEN"])), values: undefined },
          { entry: entry("plain", { type: "global" }, cmd()), values: McpStore.NO_VALUES },
        ],
        overrides: [
          { directory: project, name: "locked", enabled: true },
          { directory: project, name: "plain", enabled: false },
        ],
      },
      { directory: project, control: false },
    )
    expect(fold.servers.get("locked")?.disabled).toBe(true)
    expect(fold.servers.get("plain")?.disabled).toBe(true)
  })

  test("`${NAME}` in the command and arguments gets the stored value; a hidden address comes from the vault", () => {
    const fold = editor()
    McpFold.fold(
      fold.edit,
      {
        servers: [
          {
            entry: entry(
              "gh",
              { type: "global" },
              { type: "local", command: "gh-mcp", args: ["--token", "${GH}", "--x=${GH}", "${OTHER}"], env: ["GH"] },
            ),
            values: { env: { GH: TOKEN }, headers: {} },
          },
          {
            entry: entry(
              "zap",
              { type: "global" },
              {
                type: "remote",
                url: "https://mcp.example.test/s/••••/mcp",
                query: false,
                hidden: true,
                headers: [],
                oauth: true,
              },
            ),
            values: { env: {}, headers: {}, url: `https://mcp.example.test/s/${KEY}/mcp` },
          },
        ],
        overrides: [],
      },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("gh")).toEqual({
      type: "local",
      command: ["gh-mcp", "--token", TOKEN, `--x=${TOKEN}`, "${OTHER}"],
      environment: { GH: TOKEN },
    })
    expect(fold.servers.get("zap")).toEqual({ type: "remote", url: `https://mcp.example.test/s/${KEY}/mcp` })
  })

  test("core's pre-plugin defaults: the global timeout, Code Mode off for Code Mode servers, PostHog's tools mode", () => {
    const fold = editor()
    const remote = (url: string, codemode?: boolean): McpStore.Entry["transport"] => ({
      type: "remote",
      url,
      query: false,
      headers: [],
      oauth: true,
      ...(codemode === undefined ? {} : { codemode }),
    })
    McpFold.fold(
      fold.edit,
      {
        servers: [
          {
            entry: entry("exec", { type: "global" }, { type: "local", command: "executor", args: ["mcp"], env: [] }),
            values: McpStore.NO_VALUES,
          },
          {
            entry: entry("exe", { type: "global" }, remote("https://executor.sh/team/mcp/")),
            values: McpStore.NO_VALUES,
          },
          { entry: entry("ph", { type: "global" }, remote("https://mcp.posthog.com/mcp")), values: McpStore.NO_VALUES },
          {
            entry: entry("mine", { type: "global" }, remote("https://executor.sh/team/mcp", true)),
            values: McpStore.NO_VALUES,
          },
          { entry: entry("plain", { type: "global" }, cmd()), values: McpStore.NO_VALUES },
        ],
        overrides: [],
        timeout: { startup: 45_000 },
      },
      { directory: path.resolve("/p"), control: false },
    )
    const timeout = { startup: 45_000 }
    expect(fold.servers.get("exec")).toEqual({ type: "local", command: ["executor", "mcp"], codemode: false, timeout })
    expect(fold.servers.get("exe")).toMatchObject({ codemode: false, timeout })
    expect(fold.servers.get("ph")).toEqual({
      type: "remote",
      url: "https://mcp.posthog.com/mcp",
      headers: { "x-posthog-mcp-mode": "tools" },
      timeout,
    })
    expect(fold.servers.get("mine")).toMatchObject({ codemode: true })
    expect(fold.servers.get("plain")).toEqual({ type: "local", command: ["node", "server.js"], timeout })
  })

  test("kept switches turn own's and a config file's servers on or off; the deepest project folder wins", () => {
    const root = path.resolve("/work")
    const game = path.join(root, "game")
    const fold = editor({
      docs: { type: "remote", url: "https://docs.example.test/mcp" } as Mcp.ServerConfig,
      off: { type: "remote", url: "https://off.example.test/mcp", disabled: true } as Mcp.ServerConfig,
    })
    McpFold.fold(
      fold.edit,
      {
        servers: [{ entry: entry("mine", { type: "global" }, cmd()), values: McpStore.NO_VALUES }],
        overrides: [
          { directory: game, name: "docs", enabled: true },
          { directory: root, name: "docs", enabled: false },
          { directory: game, name: "off", enabled: true },
          { directory: game, name: "mine", enabled: false },
          { directory: path.resolve("/elsewhere"), name: "mine", enabled: true },
        ],
      },
      { directory: game, control: false },
    )
    expect(fold.servers.get("docs")?.disabled).toBe(false)
    expect(fold.servers.get("off")?.disabled).toBe(false)
    expect(fold.servers.get("mine")?.disabled).toBe(true)
  })
})

describe("global first (SG 2026-10-26)", () => {
  const entry = (name: string, scope: OwnMcp.Scope): McpStore.Entry => ({
    id: OwnMcp.ID.create(),
    name,
    scope,
    transport: { type: "local", command: "node", args: ["server.js"], env: [] },
    createdAt: 0,
    updatedAt: 0,
  })

  test("fold: the global switch first, then the project folders shallow to deep", () => {
    const root = path.resolve("/work")
    const game = path.join(root, "game")
    const snapshot: McpFold.Snapshot = {
      servers: [
        { entry: entry("mine", { type: "global" }), values: McpStore.NO_VALUES },
        { entry: entry("other", { type: "global" }), values: McpStore.NO_VALUES },
      ],
      overrides: [
        // Listed deepest first: the order of the file is not the order they apply in.
        { directory: game, name: "mine", enabled: true },
        { name: "mine", enabled: false },
        { name: "docs", enabled: false },
        { directory: root, name: "other", enabled: false },
        { name: "other", enabled: true },
      ],
    }
    const inGame = editor({ docs: { type: "remote", url: "https://docs.example.test/mcp" } as Mcp.ServerConfig })
    McpFold.fold(inGame.edit, snapshot, { directory: game, control: false })
    expect(inGame.servers.get("mine")?.disabled).toBe(false)
    expect(inGame.servers.get("docs")?.disabled).toBe(true)
    expect(inGame.servers.get("other")?.disabled).toBe(true)
    const elsewhere = editor()
    McpFold.fold(elsewhere.edit, snapshot, { directory: path.resolve("/else"), control: false })
    expect(elsewhere.servers.get("mine")?.disabled).toBe(true)
    expect(elsewhere.servers.get("other")?.disabled).toBe(false)
  })

  test("the global switch; null deletes exactly one switch; a value own's server inherits is not stored", async () => {
    await using r = await rig()
    const a = path.resolve("/work/a")
    const sub = path.join(a, "sub")
    await ok(r.rpc["mcp.save"], { name: "files", scope: { type: "global" }, transport: local() })
    // On where it is on anyway: nothing is stored (own's servers start on).
    expect((await ok(r.rpc["mcp.enable"], { name: "files", enabled: true })).overrides).toEqual([])
    expect((await ok(r.rpc["mcp.enable"], { directory: a, name: "files", enabled: true })).overrides).toEqual([])
    // Off everywhere, on only in A; A's sub folder inherits A's on, so its on is not stored either.
    await ok(r.rpc["mcp.enable"], { name: "files", enabled: false })
    await ok(r.rpc["mcp.enable"], { directory: a, name: "files", enabled: true })
    const kept = await ok(r.rpc["mcp.enable"], { directory: sub, name: "files", enabled: true })
    expect(kept.overrides).toEqual([
      { name: "files", enabled: false },
      { directory: a, name: "files", enabled: true },
    ])
    // Off in the sub folder again is an exception of its own; null takes it away, then A's, then the global one.
    expect((await ok(r.rpc["mcp.enable"], { directory: sub, name: "files", enabled: false })).overrides).toContainEqual(
      {
        directory: sub,
        name: "files",
        enabled: false,
      },
    )
    await ok(r.rpc["mcp.enable"], { directory: sub, name: "files", enabled: null })
    const reset = await ok(r.rpc["mcp.enable"], { directory: a, name: "files", enabled: null })
    expect(reset.overrides).toEqual([{ name: "files", enabled: false }])
    expect((await ok(r.rpc["mcp.enable"], { name: "files", enabled: null })).overrides).toEqual([])
    // A config file's name is stored as given: its own file may have turned it off.
    expect((await ok(r.rpc["mcp.enable"], { directory: a, name: "docs", enabled: true })).overrides).toEqual([
      { directory: a, name: "docs", enabled: true },
    ])
    expect((await ok(r.rpc["mcp.enable"], { name: "docs", enabled: true })).overrides).toContainEqual({
      name: "docs",
      enabled: true,
    })
    expect(await call(r.rpc["mcp.enable"], { directory: "relative", name: "x", enabled: false })).toMatchObject({
      ok: false,
      type: "mcp_invalid",
      data: { field: "directory" },
    })
    // Every change tells the open pages (and every Location through the runtime broadcast).
    expect(r.events.filter((event) => event.name === "mcp.changed").length).toBeGreaterThanOrEqual(11)
  })

  test("a version 1 file reads as version 2: its no-op ons of own's servers go; the first write writes version 2", async () => {
    await using r = await rig()
    const a = path.resolve("/work/a")
    const b = path.resolve("/work/b")
    const c = path.resolve("/work/c")
    const d = path.resolve("/work/d")
    const v1 = {
      version: 1,
      servers: [entry("files", { type: "global" }), entry("game", { type: "project", directory: c })],
      overrides: [
        // Own's server switched off and on again in A: a no-op, it goes.
        { directory: a, name: "files", enabled: true },
        { directory: b, name: "files", enabled: false },
        // Off in C, on again in C's sub folder: not a no-op, it stays.
        { directory: c, name: "files", enabled: false },
        { directory: path.join(c, "sub"), name: "files", enabled: true },
        // The project server's on in C goes; its on in B, where it never runs, is a config file's name there.
        { directory: c, name: "game", enabled: true },
        { directory: b, name: "game", enabled: true },
        // A config file's server: kept as written.
        { directory: a, name: "docs", enabled: true },
      ],
    }
    await Bun.write(r.t.deps.runtime.layout.mcp, JSON.stringify(v1))
    // Read as version 2 (it folds the same: own's servers start on); the file stays version 1 until a write.
    expect((await ok(r.rpc["mcp.list"], {})).overrides).toHaveLength(5)
    expect(JSON.parse(await r.file()).version).toBe(1)
    await ok(r.rpc["mcp.enable"], { directory: d, name: "docs", enabled: false })
    const written = JSON.parse(await r.file()) as McpStore.File
    expect(written.version).toBe(2)
    expect(written.overrides).toEqual([
      { directory: b, name: "files", enabled: false },
      { directory: c, name: "files", enabled: false },
      { directory: path.join(c, "sub"), name: "files", enabled: true },
      { directory: b, name: "game", enabled: true },
      { directory: a, name: "docs", enabled: true },
      { directory: d, name: "docs", enabled: false },
    ])
    // A version 2 file is not upgraded again, and the servers stay as they were.
    expect(McpStore.upgrade(written)).toEqual(written)
    expect((await ok(r.rpc["mcp.list"], {})).servers.map((server) => server.name)).toEqual(["files", "game"])
  })

  // Review finding (2026-10-26): the upgrade ran before the write, over a value that already held the change, so it
  // judged A's no-op on against the new global off and kept it: A stayed on.
  test("a version 1 file's first write is the global off: the no-op on in A goes, so A is off too", async () => {
    await using r = await rig()
    const a = path.resolve("/work/a")
    const files = entry("files", { type: "global" })
    await Bun.write(
      r.t.deps.runtime.layout.mcp,
      JSON.stringify({ version: 1, servers: [files], overrides: [{ directory: a, name: "files", enabled: true }] }),
    )
    await ok(r.rpc["mcp.enable"], { name: "files", enabled: false })
    const written = JSON.parse(await r.file()) as McpStore.File
    expect(written.version).toBe(2)
    expect(written.overrides).toEqual([{ name: "files", enabled: false }])
    const inA = editor()
    McpFold.fold(
      inA.edit,
      { servers: [{ entry: files, values: McpStore.NO_VALUES }], overrides: written.overrides },
      { directory: a, control: false },
    )
    expect(inA.servers.get("files")?.disabled).toBe(true)
  })

  test("the global switch follows a rename and goes with the server, unless another server keeps the name", async () => {
    await using r = await rig()
    const a = path.resolve("/work/a")
    const b = path.resolve("/work/b")
    const first = await ok(r.rpc["mcp.save"], { name: "files", scope: { type: "global" }, transport: local() })
    const id = first.servers[0]!.id
    await ok(r.rpc["mcp.enable"], { name: "files", enabled: false })
    await ok(r.rpc["mcp.enable"], { directory: a, name: "files", enabled: true })
    const renamed = await ok(r.rpc["mcp.save"], { id, name: "files2", scope: { type: "global" }, transport: local() })
    expect(renamed.overrides).toEqual([
      { name: "files2", enabled: false },
      { directory: a, name: "files2", enabled: true },
    ])
    expect((await ok(r.rpc["mcp.remove"], { id })).overrides).toEqual([])
    // Two of own's servers of one name in folders that never meet share the global switch of that name.
    const inA = await ok(r.rpc["mcp.save"], { name: "x", scope: { type: "project", directory: a }, transport: local() })
    await ok(r.rpc["mcp.save"], { name: "x", scope: { type: "project", directory: b }, transport: local() })
    await ok(r.rpc["mcp.enable"], { name: "x", enabled: false })
    const aID = inA.servers.find((server) => server.name === "x")!.id
    const moved = await ok(r.rpc["mcp.save"], {
      id: aID,
      name: "y",
      scope: { type: "project", directory: a },
      transport: local(),
    })
    expect(moved.overrides).toEqual([
      { name: "x", enabled: false },
      { name: "y", enabled: false },
    ])
    expect((await ok(r.rpc["mcp.remove"], { id: aID })).overrides).toEqual([{ name: "x", enabled: false }])
  })

  test("the summary carries the kept switches", async () => {
    await using r = await rig()
    await ok(r.rpc["mcp.save"], { name: "files", scope: { type: "global" }, transport: local() })
    await ok(r.rpc["mcp.enable"], { name: "files", enabled: false })
    expect((await ok(r.rpc["mcp.summary"], {})).overrides).toEqual([{ name: "files", enabled: false }])
  })
})

describe("mcp.* methods", () => {
  test("a command server: values go to the vault, the file and answers name them only", async () => {
    await using r = await rig()
    const view = await ok(r.rpc["mcp.save"], {
      name: "github",
      scope: { type: "global" },
      transport: local([
        { name: "GITHUB_TOKEN", value: TOKEN },
        { name: "MODE", value: "ro" },
      ]),
    })
    expect(view.vault).toBe("ok")
    expect(view.servers).toHaveLength(1)
    const server = view.servers[0]!
    expect(server.transport).toEqual({
      type: "local",
      command: process.execPath,
      args: [FAKE_MCP_STDIO],
      env: [{ name: "GITHUB_TOKEN", hint: `…${TOKEN.slice(-4)}` }, { name: "MODE" }],
    })
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    const file = await r.file()
    expect(file).toContain("GITHUB_TOKEN")
    expect(file).not.toContain(TOKEN)
    expect(file).not.toContain('"ro"')
    const stored = await r.t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(server.id))
    expect(stored.ok && JSON.parse(stored.text)).toEqual({ env: { GITHUB_TOKEN: TOKEN, MODE: "ro" }, headers: {} })
    expect(r.events.map((event) => event.name)).toEqual(["mcp.changed"])
  })

  test("a value typed into the arguments or the address goes to the vault; `${NAME}` must name a value", async () => {
    await using r = await rig()
    const view = await ok(r.rpc["mcp.save"], {
      name: "gh",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: "gh-mcp",
        args: ["--api-key", TOKEN, `--secret=${KEY}`, "--mode", "ro"],
        env: [],
        codemode: false,
      },
    })
    expect(view.servers[0]!.transport).toEqual({
      type: "local",
      command: "gh-mcp",
      args: ["--api-key", "${API_KEY}", "--secret=${SECRET}", "--mode", "ro"],
      env: [
        { name: "API_KEY", hint: `…${TOKEN.slice(-4)}` },
        { name: "SECRET", hint: `…${KEY.slice(-4)}` },
      ],
      codemode: false,
    })
    const remote = await ok(r.rpc["mcp.save"], {
      name: "zap",
      scope: { type: "global" },
      transport: { type: "remote", url: `https://mcp.example.test/s/${PATH_KEY}/mcp?x=1`, headers: [], oauth: true },
    })
    expect(remote.servers.find((server) => server.name === "zap")!.transport).toMatchObject({
      url: "https://mcp.example.test/s/••••/mcp",
      query: true,
      hidden: true,
    })
    for (const text of [await r.file(), JSON.stringify(remote)]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(KEY)
      expect(text).not.toContain(PATH_KEY)
    }
    // An edit without an address keeps the hidden one.
    const id = remote.servers.find((server) => server.name === "zap")!.id
    await ok(r.rpc["mcp.save"], {
      id,
      name: "zap",
      scope: { type: "global" },
      transport: { type: "remote", headers: [], oauth: true },
    })
    const stored = await r.t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(id))
    expect(stored.ok && JSON.parse(stored.text)).toEqual({
      env: {},
      headers: {},
      search: "?x=1",
      url: `https://mcp.example.test/s/${PATH_KEY}/mcp`,
    })
    expect(
      await call(r.rpc["mcp.save"], {
        name: "ref",
        scope: { type: "global" },
        transport: { type: "local", command: "x", args: ["${NOT_STORED}"], env: [] },
      }),
    ).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "args" } })
  })

  test("a server whose values cannot be read is `missing` in the list and the summary", async () => {
    await using r = await rig()
    const saved = await ok(r.rpc["mcp.save"], {
      name: "github",
      scope: { type: "global" },
      transport: local([{ name: "GITHUB_TOKEN", value: TOKEN }]),
    })
    await r.t.deps.runtime.credentials.storeFeatureKey(McpStore.vaultID(saved.servers[0]!.id), "not json")
    const view = await ok(r.rpc["mcp.list"], {})
    expect(view.servers[0]).toMatchObject({ name: "github", missing: true })
    expect(view.vault).toBe("unavailable")
    expect(await ok(r.rpc["mcp.summary"], {})).toEqual({
      servers: [{ name: "github", scope: { type: "global" }, missing: true }],
      overrides: [],
    })
  })

  test("the summary names own's servers, where they are used and come from, and nothing of their definition", async () => {
    await using r = await rig()
    const project = path.resolve("/work/game")
    await ok(r.rpc["mcp.save"], {
      name: "files",
      scope: { type: "project", directory: project },
      transport: local([{ name: "FAKE_TOKEN", value: TOKEN }]),
      registry: { name: "io.github.example/files", version: "1.2.0" },
    })
    const summary = await ok(r.rpc["mcp.summary"], {})
    expect(summary).toEqual({
      servers: [{ name: "files", scope: { type: "project", directory: project }, from: "registry" }],
      overrides: [],
    })
    expect(JSON.stringify(summary)).not.toContain(FAKE_MCP_STDIO)
    expect((await ok(r.rpc["mcp.list"], {})).servers[0]).toMatchObject({
      from: "registry",
      registry: { name: "io.github.example/files", version: "1.2.0" },
    })
  })

  test("an edit keeps a value it leaves out, drops a name it leaves out, and refuses a name nothing is stored for", async () => {
    await using r = await rig()
    const first = await ok(r.rpc["mcp.save"], {
      name: "github",
      scope: { type: "global" },
      transport: local([
        { name: "GITHUB_TOKEN", value: TOKEN },
        { name: "MODE", value: "ro" },
      ]),
    })
    const id = first.servers[0]!.id
    await ok(r.rpc["mcp.save"], {
      id,
      name: "gh",
      scope: { type: "global" },
      transport: local([{ name: "GITHUB_TOKEN" }]),
    })
    const stored = await r.t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(id))
    expect(stored.ok && JSON.parse(stored.text)).toEqual({ env: { GITHUB_TOKEN: TOKEN }, headers: {} })
    const missing = await call(r.rpc["mcp.save"], {
      id,
      name: "gh",
      scope: { type: "global" },
      transport: local([{ name: "MODE" }]),
    })
    expect(missing).toMatchObject({ ok: false, type: "mcp_secret_missing", data: { name: "MODE" } })
    expect(
      await call(r.rpc["mcp.save"], {
        id: OwnMcp.ID.create(),
        name: "x",
        scope: { type: "global" },
        transport: local(),
      }),
    ).toMatchObject({
      ok: false,
      type: "mcp_not_found",
    })
  })

  test("names clash where both servers would run, and may repeat in folders that never meet", async () => {
    await using r = await rig()
    const a = path.resolve("/work/a")
    const b = path.resolve("/work/b")
    await ok(r.rpc["mcp.save"], { name: "files", scope: { type: "project", directory: a }, transport: local() })
    await ok(r.rpc["mcp.save"], { name: "files", scope: { type: "project", directory: b }, transport: local() })
    for (const scope of [{ type: "global" as const }, { type: "project" as const, directory: path.join(a, "sub") }])
      expect(await call(r.rpc["mcp.save"], { name: "FILES", scope, transport: local() })).toMatchObject({
        ok: false,
        type: "mcp_name_taken",
      })
    expect(
      await call(r.rpc["mcp.save"], { name: "rel", scope: { type: "project", directory: "work" }, transport: local() }),
    ).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "directory" } })
  })

  test("a URL server keeps its `?` part and headers in the vault; an edit without a URL keeps the address", async () => {
    await using r = await rig()
    const view = await ok(r.rpc["mcp.save"], {
      name: "search",
      scope: { type: "global" },
      transport: {
        type: "remote",
        url: `https://mcp.example.test/mcp?exaApiKey=${KEY}#top`,
        headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
        oauth: false,
      },
    })
    const server = view.servers[0]!
    expect(server.transport).toEqual({
      type: "remote",
      url: "https://mcp.example.test/mcp",
      query: true,
      headers: [{ name: "Authorization", hint: `…${TOKEN.slice(-4)}` }],
      oauth: false,
    })
    expect(await r.file()).not.toContain(KEY)
    await ok(r.rpc["mcp.save"], {
      id: server.id,
      name: "search",
      scope: { type: "global" },
      transport: { type: "remote", headers: [{ name: "Authorization" }], oauth: true },
    })
    const stored = await r.t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(server.id))
    expect(stored.ok && JSON.parse(stored.text)).toEqual({
      env: {},
      headers: { Authorization: `Bearer ${TOKEN}` },
      search: `?exaApiKey=${KEY}`,
    })
    expect(
      await call(r.rpc["mcp.save"], {
        name: "bad",
        scope: { type: "global" },
        transport: { type: "remote", url: "file:///etc/passwd", headers: [], oauth: true },
      }),
    ).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "url" } })
    expect(
      await call(r.rpc["mcp.save"], {
        name: "none",
        scope: { type: "global" },
        transport: { type: "remote", headers: [], oauth: true },
      }),
    ).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "url" } })
  })

  test("switches are kept per project and name, follow a rename and go with the server", async () => {
    await using r = await rig()
    const project = path.resolve("/work/game")
    const saved = await ok(r.rpc["mcp.save"], { name: "files", scope: { type: "global" }, transport: local() })
    const id = saved.servers[0]!.id
    await ok(r.rpc["mcp.enable"], { directory: project, name: "files", enabled: false })
    await ok(r.rpc["mcp.enable"], { directory: project, name: "docs", enabled: false })
    const twice = await ok(r.rpc["mcp.enable"], { directory: project, name: "docs", enabled: true })
    expect(twice.overrides).toEqual([
      { directory: project, name: "files", enabled: false },
      { directory: project, name: "docs", enabled: true },
    ])
    const renamed = await ok(r.rpc["mcp.save"], { id, name: "files2", scope: { type: "global" }, transport: local() })
    expect(renamed.overrides).toContainEqual({ directory: project, name: "files2", enabled: false })
    const removed = await ok(r.rpc["mcp.remove"], { id })
    expect(removed.servers).toEqual([])
    expect(removed.overrides).toEqual([{ directory: project, name: "docs", enabled: true }])
    expect(await call(r.rpc["mcp.remove"], { id })).toMatchObject({ ok: false, type: "mcp_not_found" })
  })

  test("removing a server deletes its vault item", async () => {
    await using r = await rig()
    const saved = await ok(r.rpc["mcp.save"], {
      name: "github",
      scope: { type: "global" },
      transport: local([{ name: "GITHUB_TOKEN", value: TOKEN }]),
    })
    const id = saved.servers[0]!.id
    await ok(r.rpc["mcp.remove"], { id })
    expect(await r.t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(id))).toMatchObject({
      ok: false,
      problem: "not_found",
    })
  })

  test("a remote service refuses them", () => {
    for (const method of [
      "mcp.list",
      "mcp.summary",
      "mcp.save",
      "mcp.remove",
      "mcp.enable",
      "mcp.test",
      "mcp.import.scan",
      "mcp.import.apply",
      "mcp.registry.search",
    ] as const)
      expect(Register.REMOTE_MANAGED).toContain(method)
  })
})

describe("connection test", () => {
  test("a saved command server lists its tools across pages; the result is kept for the list", async () => {
    await using r = await rig()
    const saved = await ok(r.rpc["mcp.save"], {
      name: "fake",
      scope: { type: "global" },
      transport: { ...local(), args: [FAKE_MCP_STDIO, "alpha", "beta", "gamma"] } as OwnMcp.TransportInput,
    })
    const id = saved.servers[0]!.id
    const check = await ok(r.rpc["mcp.test"], { id, directory: r.t.home })
    expect(check).toMatchObject({ ok: true, server: "own-fake-mcp 1.0.0" })
    expect(check.tools.map((tool) => tool.name)).toEqual(["alpha", "beta", "gamma"])
    const listed = await ok(r.rpc["mcp.list"], {})
    expect(listed.servers[0]!.check?.tools).toHaveLength(3)
  })

  test("a form's test uses the stored values it leaves out and is not kept", async () => {
    await using r = await rig()
    const saved = await ok(r.rpc["mcp.save"], {
      name: "fake",
      scope: { type: "global" },
      transport: local([{ name: "FAKE_TOKEN", value: TOKEN }]),
    })
    const id = saved.servers[0]!.id
    const required = (env: { name: string; value?: string }[]) =>
      ({ ...local(env), env: [...env, { name: "FAKE_MCP_REQUIRE", value: "FAKE_TOKEN" }] }) as OwnMcp.TransportInput
    expect(await ok(r.rpc["mcp.test"], { id, transport: required([{ name: "FAKE_TOKEN" }]) })).toMatchObject({
      ok: true,
    })
    const listed = await ok(r.rpc["mcp.list"], {})
    expect(listed.servers[0]!.check).toBeUndefined()
    expect(await call(r.rpc["mcp.test"], {})).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "test" } })
  })

  test("a server that ends early reports its exit and error output, with stored values cut out", async () => {
    const check = await McpProbe.probe(
      {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        cwd: process.cwd(),
        env: { FAKE_MCP_FAIL: `bad token ${TOKEN}` },
      },
      { secrets: [TOKEN] },
    )
    expect(check).toMatchObject({ ok: false, failure: "exited" })
    expect(check.error).toContain("exit 3")
    expect(check.error).toContain("bad token ••••")
    expect(check.error).not.toContain(TOKEN)
  })

  test("masking: the token of `Bearer <token>`, and any 8 or more characters a stored value holds", () => {
    const text = `401: token ${TOKEN.slice(4)} rejected; prefix ${TOKEN.slice(0, 12)}…; header Bearer ok; ${KEY}`
    const masked = McpProbe.mask(text, [`Bearer ${TOKEN}`, `?key=${KEY}`])
    expect(masked).not.toContain(TOKEN.slice(4))
    expect(masked).not.toContain(TOKEN.slice(0, 12))
    expect(masked).not.toContain(KEY)
    expect(masked).toContain("header Bearer ok")
    expect(masked).toBe("401: token •••• rejected; prefix ••••…; header Bearer ok; ••••")
  })

  test("SM-24: only secret parts are masked; words, `https://` and query names stay readable", () => {
    const secrets = [
      "production",
      "production-eu-west",
      `?mode=production&apikey=${KEY}`,
      `https://user:${TOKEN}@mcp.example.test/s/${KEY.replaceAll("-", "")}AAAA/mcp?region=eu`,
      `Bearer ${TOKEN}`,
    ]
    const text = [
      "Runs in production mode against production-eu-west",
      "set apikey= and mode= at https://mcp.example.test/s/ for region eu",
      `echoed ${KEY} and ${TOKEN.slice(3, 20)} and ${KEY.replaceAll("-", "")}AAAA`,
    ].join("; ")
    const masked = McpProbe.mask(text, secrets)
    expect(masked).toStartWith(
      "Runs in production mode against ••••; set apikey= and mode= at https://mcp.example.test/s/",
    )
    for (const value of [KEY, TOKEN.slice(3, 20), `${KEY.replaceAll("-", "")}AAAA`]) expect(masked).not.toContain(value)
    // A short stored value is never masked: it would hide ordinary text.
    expect(McpProbe.mask("mode ro, region eu", ["ro", "eu", "?k=abc"])).toBe("mode ro, region eu")
  })

  test("SM-24: masked before it is cut, so a cut never leaves part of a value", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id?: number; method?: string }
        if (body.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "cut", version: "1" } },
          })
        if (body.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "t", description: `${"x".repeat(295)}${TOKEN}` }] },
          })
        return new Response(null, { status: 202 })
      },
    })
    const failing = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(`${"y".repeat(495)}${TOKEN}`, { status: 500 }),
    })
    try {
      const listed = await McpProbe.probe(
        { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, headers: {} },
        { secrets: [TOKEN] },
      )
      expect(listed.tools[0]!.description).toBe(`${"x".repeat(295)}••••`)
      const refused = await McpProbe.probe(
        { type: "remote", url: `http://127.0.0.1:${failing.port}/mcp`, headers: {} },
        { secrets: [TOKEN] },
      )
      expect(refused).toMatchObject({ ok: false, failure: "http", status: 500 })
      expect(refused.error).toBe(`${"y".repeat(495)}••••`)
    } finally {
      void server.stop(true)
      void failing.stop(true)
    }
    // The stderr tail: the last 1,500 characters once masked, not the end of a value cut off at its start.
    const exited = await McpProbe.probe(
      {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        cwd: process.cwd(),
        env: { FAKE_MCP_FAIL: `${TOKEN}${"z".repeat(1_494)}` },
      },
      { secrets: [TOKEN] },
    )
    expect(exited).toMatchObject({ ok: false, failure: "exited" })
    expect(exited.error).toEndWith("z".repeat(1_494))
    expect(exited.error).not.toContain("Wx9z")
  })

  test("a command that does not exist is `spawn`", async () => {
    const check = await McpProbe.probe({
      type: "local",
      command: "own-no-such-command-3f9a",
      args: [],
      cwd: process.cwd(),
      env: {},
    })
    expect(check).toMatchObject({ ok: false, failure: "spawn" })
  })

  test("Streamable HTTP: JSON and event-stream answers, the session id, and 401 as a sign-in", async () => {
    const seen: { session?: string | null; auth?: string | null } = {}
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/locked") return new Response("no", { status: 401 })
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        const message = (await request.json()) as { id?: number; method: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (message.method === "initialize") {
          seen.auth = request.headers.get("authorization")
          return Response.json(
            { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "web" } } },
            { headers: { "mcp-session-id": "s-1" } },
          )
        }
        seen.session = request.headers.get("mcp-session-id")
        const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search" }] } })}\n\n`
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const check = await McpProbe.probe({
        type: "remote",
        url: `${origin}/mcp`,
        headers: { authorization: "Bearer x" },
      })
      expect(check).toMatchObject({ ok: true, server: "web", tools: [{ name: "search" }] })
      expect(seen).toEqual({ auth: "Bearer x", session: "s-1" })
      expect(await McpProbe.probe({ type: "remote", url: `${origin}/locked`, headers: {} })).toMatchObject({
        ok: false,
        failure: "auth",
        status: 401,
      })
    } finally {
      void server.stop(true)
    }
  })
})

describe("import from other tools", () => {
  const env = { HOME_TOKEN: TOKEN, BEARER: "fake-bearer-0000000000-Ab1c" }

  test("Codex: commands, URLs with headers from the environment, off servers and dropped settings", () => {
    const found = McpSources.codexServers(
      [
        "[mcp_servers.docs]",
        'command = "npx"',
        'args = ["-y", "docs-mcp"]',
        'env_vars = ["NOT_SET_ANYWHERE"]',
        "startup_timeout_sec = 30",
        "[mcp_servers.docs.env]",
        'API_KEY = "abc123"',
        "[mcp_servers.web]",
        'url = "https://web.example.test/mcp"',
        'bearer_token_env_var = "BEARER"',
        "enabled = false",
        'enabled_tools = ["search"]',
        "[mcp_servers.web.http_headers]",
        'X-Team = "own"',
      ].join("\n"),
      env,
    )!
    expect(found).toEqual([
      {
        source: "codex",
        name: "docs",
        enabled: true,
        draft: { type: "local", command: "npx", args: ["-y", "docs-mcp"], env: { API_KEY: "abc123" } },
        notes: ["settings_dropped", "env_missing"],
      },
      {
        source: "codex",
        name: "web",
        enabled: false,
        draft: {
          type: "remote",
          url: "https://web.example.test/mcp",
          headers: { "X-Team": "own", Authorization: `Bearer ${env.BEARER}` },
          oauth: true,
        },
        notes: ["disabled", "tool_filter", "env_read"],
      },
    ])
    expect(McpSources.codexServers("not = [toml", env)).toBeUndefined()
  })

  test("Claude Code: `${VAR}` stays a reference to a stored value, http servers and the old SSE transport", () => {
    const found = McpSources.servers(
      {
        gh: {
          command: "gh-mcp",
          args: ["--token", "${HOME_TOKEN}", "--bearer", "${BEARER}", "${NOPE:-plain}"],
          env: { TOKEN: "${HOME_TOKEN}", GONE: "${NOPE}" },
        },
        remote: { type: "http", url: "https://r.example.test/mcp", headers: { "X-Key": "${NOPE:-fallback}" } },
        keyed: { type: "http", url: "https://k.example.test/${BEARER}/mcp?key=${HOME_TOKEN}" },
        old: { type: "sse", url: "https://old.example.test/sse" },
        broken: { command: 3 },
      },
      "claude-user",
      env,
    )
    expect(found).toEqual([
      {
        source: "claude-user",
        name: "gh",
        enabled: true,
        draft: {
          type: "local",
          command: "gh-mcp",
          // The value read for ${HOME_TOKEN} is TOKEN's already; ${BEARER} becomes a value of its own.
          args: ["--token", "${TOKEN}", "--bearer", "${BEARER}", "plain"],
          env: { TOKEN, BEARER: env.BEARER },
        },
        notes: ["env_read", "env_missing", "values_moved"],
      },
      {
        source: "claude-user",
        name: "remote",
        enabled: true,
        draft: { type: "remote", url: "https://r.example.test/mcp", headers: { "X-Key": "fallback" }, oauth: true },
        notes: [],
      },
      {
        source: "claude-user",
        name: "keyed",
        enabled: true,
        draft: {
          type: "remote",
          url: `https://k.example.test/${env.BEARER}/mcp?key=${TOKEN}`,
          written: "https://k.example.test/${BEARER}/mcp?key=${HOME_TOKEN}",
          headers: {},
          oauth: true,
        },
        notes: ["env_read", "values_moved"],
      },
      { source: "claude-user", name: "old", enabled: true, notes: [], problem: "sse" },
      { source: "claude-user", name: "broken", enabled: true, notes: [], problem: "invalid" },
    ])
  })

  test("scan reads the fake homes and the project; apply adds the picks with their values and the nonce once", async () => {
    await using r = await rig()
    const codexHome = path.join(r.t.home, "codex-fixture")
    const claudeHome = path.join(r.t.home, "claude-fixture")
    const project = path.join(r.t.home, "work", "game")
    await fs.mkdir(codexHome, { recursive: true })
    await fs.mkdir(claudeHome, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await Bun.write(
      path.join(codexHome, "config.toml"),
      `[mcp_servers.github]\ncommand = "gh-mcp"\n[mcp_servers.github.env]\nGITHUB_TOKEN = "${TOKEN}"\n`,
    )
    await Bun.write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "someone@example.test" },
        mcpServers: {
          github: { command: "gh-mcp" },
          "my tools!": { type: "http", url: `https://t.example.test/mcp?k=${KEY}` },
        },
        projects: { [project.replaceAll("\\", "/")]: { mcpServers: { local: { command: "local-mcp" } } } },
      }),
    )
    await Bun.write(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "shared-mcp" } } }),
    )
    const t = await testDeps({ control: true, options: { home: r.t.home, codexHome, claudeHome } as never })
    const rpc = McpRpc.handlers(t.deps)
    const scan = await ok(rpc["mcp.import.scan"], { directory: project })
    expect(scan.files.map((file) => [file.source, file.state, file.count])).toEqual([
      ["codex", "found", 1],
      ["claude-user", "found", 2],
      ["claude-project", "found", 1],
      ["project-file", "found", 1],
    ])
    expect(
      scan.candidates.map((item) => [item.source, item.name, item.suggested, item.scope.type, item.imported]),
    ).toEqual([
      ["codex", "github", "github", "global", false],
      ["claude-user", "github", "github-2", "global", false],
      ["claude-user", "my tools!", "my-tools", "global", false],
      ["claude-project", "local", "local", "project", false],
      ["project-file", "shared", "shared", "project", false],
    ])
    expect(JSON.stringify(scan)).not.toContain(TOKEN)
    expect(JSON.stringify(scan)).not.toContain(KEY)
    expect(JSON.stringify(scan)).not.toContain("someone@example.test")
    const github = scan.candidates[0]!
    const tools = scan.candidates[2]!
    expect(tools.transport).toMatchObject({ type: "remote", url: "https://t.example.test/mcp", query: true })
    const applied = await ok(rpc["mcp.import.apply"], {
      nonce: scan.nonce,
      picks: [
        { key: github.key, name: github.suggested, scope: github.scope },
        { key: tools.key, name: tools.suggested, scope: tools.scope },
      ],
    })
    expect(applied.imported.map((item) => item.name)).toEqual(["github", "my-tools"])
    expect(applied.view.servers.map((server) => [server.name, server.from])).toEqual([
      ["github", "codex"],
      ["my-tools", "claude-code"],
    ])
    const stored = await t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(applied.imported[0]!.id))
    expect(stored.ok && JSON.parse(stored.text)).toEqual({ env: { GITHUB_TOKEN: TOKEN }, headers: {} })
    expect(
      await call(rpc["mcp.import.apply"], {
        nonce: scan.nonce,
        picks: [{ key: "c4", name: "local", scope: { type: "global" } }],
      }),
    ).toMatchObject({ ok: false, type: "nonce_invalid" })
    const again = await ok(rpc["mcp.import.scan"], { directory: project })
    expect(again.candidates.filter((item) => item.imported).map((item) => item.name)).toEqual(["github", "my tools!"])
    expect(again.candidates[0]!.suggested).toBe("github-2")
    await t[Symbol.asyncDispose]()
  })

  test("no value reaches the scan, the file or the list as plain text: `${VAR}`, flags and keys in addresses", async () => {
    await using r = await rig()
    const codexHome = path.join(r.t.home, "codex-secrets")
    const claudeHome = path.join(r.t.home, "claude-secrets")
    await fs.mkdir(codexHome, { recursive: true })
    await fs.mkdir(claudeHome, { recursive: true })
    await Bun.write(
      path.join(codexHome, "config.toml"),
      [
        "[mcp_servers.search]",
        'command = "search-mcp"',
        `args = ["--api-key", "${KEY}", "--github-token=${TOKEN}"]`,
        "[mcp_servers.zap]",
        `url = "https://mcp.example.test/api/s/${PATH_KEY}/mcp"`,
      ].join("\n"),
    )
    const secret = "fake-env-secret-0000-zz11"
    await Bun.write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          gh: { command: "${OWN_TEST_BIN}/gh-mcp", args: ["--token", "${OWN_TEST_SECRET}"] },
          web: { type: "http", url: "https://${OWN_TEST_SECRET}.example.test/mcp" },
        },
      }),
    )
    process.env.OWN_TEST_SECRET = secret
    process.env.OWN_TEST_BIN = "/opt/fake-bin"
    try {
      const t = await testDeps({ control: true, options: { home: r.t.home, codexHome, claudeHome } as never })
      const rpc = McpRpc.handlers(t.deps)
      const scan = await ok(rpc["mcp.import.scan"], {})
      expect(scan.candidates.map((item) => [item.name, item.transport])).toEqual([
        [
          "search",
          {
            type: "local",
            command: "search-mcp",
            args: ["--api-key", "${API_KEY}", "--github-token=${GITHUB_TOKEN}"],
            env: [
              { name: "API_KEY", hint: `…${KEY.slice(-4)}` },
              { name: "GITHUB_TOKEN", hint: `…${TOKEN.slice(-4)}` },
            ],
          },
        ],
        [
          "zap",
          {
            type: "remote",
            url: "https://mcp.example.test/api/s/••••/mcp",
            query: false,
            hidden: true,
            headers: [],
            oauth: true,
          },
        ],
        [
          "gh",
          {
            type: "local",
            command: "${OWN_TEST_BIN}/gh-mcp",
            args: ["--token", "${OWN_TEST_SECRET}"],
            env: [
              { name: "OWN_TEST_BIN", hint: "…-bin" },
              { name: "OWN_TEST_SECRET", hint: `…${secret.slice(-4)}` },
            ],
          },
        ],
        [
          "web",
          {
            type: "remote",
            url: "https://${OWN_TEST_SECRET}.example.test/mcp",
            query: false,
            hidden: true,
            headers: [],
            oauth: true,
          },
        ],
      ])
      expect(scan.candidates.every((item) => item.notes.includes("values_moved"))).toBe(true)
      const applied = await ok(rpc["mcp.import.apply"], {
        nonce: scan.nonce,
        picks: scan.candidates.map((item) => ({ key: item.key, name: item.suggested, scope: item.scope })),
      })
      for (const text of [
        JSON.stringify(scan),
        JSON.stringify(applied),
        await Bun.file(t.deps.runtime.layout.mcp).text(),
      ])
        for (const value of [KEY, PATH_KEY, TOKEN, secret]) expect(text).not.toContain(value)
      const web = applied.view.servers.find((server) => server.name === "web")!
      const stored = await t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(web.id))
      expect(stored.ok && JSON.parse(stored.text)).toEqual({
        env: {},
        headers: {},
        url: `https://${secret}.example.test/mcp`,
      })
      await t[Symbol.asyncDispose]()
    } finally {
      delete process.env.OWN_TEST_SECRET
      delete process.env.OWN_TEST_BIN
    }
  })

  test("the same server in Codex and Claude Code is one row; a definition own has from any place is `이미 있음`", async () => {
    await using r = await rig()
    const codexHome = path.join(r.t.home, "codex-twice")
    const claudeHome = path.join(r.t.home, "claude-twice")
    await fs.mkdir(codexHome, { recursive: true })
    await fs.mkdir(claudeHome, { recursive: true })
    await Bun.write(
      path.join(codexHome, "config.toml"),
      `[mcp_servers.github]\ncommand = "gh-mcp"\nargs = ["stdio"]\n[mcp_servers.github.env]\nGITHUB_TOKEN = "${TOKEN}"\n`,
    )
    await Bun.write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          gh: { command: "gh-mcp", args: ["stdio"], env: { GITHUB_TOKEN: "another-fake-token-0000-Aa1" } },
          docs: { type: "http", url: "https://docs.example.test/mcp", headers: { "X-Key": "k1" } },
        },
      }),
    )
    const t = await testDeps({ control: true, options: { home: r.t.home, codexHome, claudeHome } as never })
    const rpc = McpRpc.handlers(t.deps)
    // The docs server was added by hand before, with another key value.
    await ok(rpc["mcp.save"], {
      name: "my-docs",
      scope: { type: "global" },
      transport: {
        type: "remote",
        url: "https://docs.example.test/mcp",
        headers: [{ name: "x-key", value: "k2" }],
        oauth: true,
      },
    })
    const scan = await ok(rpc["mcp.import.scan"], {})
    // The same definition with another token: one row that says its values differ, named by their hints.
    expect(scan.candidates.map((item) => [item.source, item.name, item.also, item.imported])).toEqual([
      [
        "codex",
        "github",
        [{ source: "claude-user", name: "gh", differs: true, values: [{ name: "GITHUB_TOKEN", hint: "…-Aa1" }] }],
        false,
      ],
      ["claude-user", "docs", [], true],
    ])
    const applied = await ok(rpc["mcp.import.apply"], {
      nonce: scan.nonce,
      picks: [{ key: "c1", name: "github", scope: { type: "global" } }],
    })
    // The first place's values.
    const stored = await t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(applied.imported[0]!.id))
    expect(stored.ok && JSON.parse(stored.text)).toEqual({ env: { GITHUB_TOKEN: TOKEN }, headers: {} })
    const again = await ok(rpc["mcp.import.scan"], {})
    expect(again.candidates.map((item) => item.imported)).toEqual([true, true])
    await t[Symbol.asyncDispose]()
  })

  test("McpSecrets: flags, known key prefixes and keys in addresses; plain arguments and addresses stay", () => {
    expect(McpSecrets.lift("x", ["--port", "8080", "--token", "abc", "-t", "v", TOKEN, "--auth=", "a b"], {})).toEqual({
      command: "x",
      args: ["--port", "8080", "--token", "${TOKEN}", "-t", "v", "${SECRET}", "--auth=", "a b"],
      env: { TOKEN: "abc", SECRET: TOKEN },
      moved: true,
    })
    expect(
      McpSecrets.lift(
        "x",
        ["--root", "C:/work", "--no-auth", "server.js", "--key-file", "k.pem", "sk-learn-tools-mcp"],
        {
          A: "1",
        },
      ),
    ).toEqual({
      command: "x",
      args: ["--root", "C:/work", "--no-auth", "server.js", "--key-file", "k.pem", "sk-learn-tools-mcp"],
      env: { A: "1" },
      moved: false,
    })
    expect(McpSecrets.address("https://mcp.example.test/v1/mcp?k=1")).toEqual({
      base: "https://mcp.example.test/v1/mcp",
      search: "?k=1",
      hidden: false,
      shown: "https://mcp.example.test/v1/mcp",
    })
    expect(McpSecrets.address("https://user:pw@mcp.example.test/mcp").shown).toBe("https://••••@mcp.example.test/mcp")
  })

  test("missing files are listed as missing and give no candidates", async () => {
    await using r = await rig()
    const scan = await ok(r.rpc["mcp.import.scan"], {})
    expect(scan.candidates).toEqual([])
    expect(scan.files.every((file) => file.state === "missing")).toBe(true)
  })
})

describe("찾아서 설치 (MCP Registry)", () => {
  const SERVERS = [
    {
      server: {
        name: "io.github.example/github",
        title: "GitHub",
        description: "Issues and pull requests",
        version: "1.4.0",
        repository: { url: "https://github.com/example/github-mcp", source: "github" },
        packages: [
          {
            registryType: "npm",
            identifier: "@example/github-mcp",
            version: "1.4.0",
            transport: { type: "stdio" },
            runtimeArguments: [{ type: "positional", value: "-y" }],
            packageArguments: [
              { type: "named", name: "--api-key", isSecret: true, isRequired: true, description: "Your key" },
              { type: "named", name: "--mode", default: "ro" },
              { type: "positional", valueHint: "repo", isRequired: true },
            ],
            environmentVariables: [
              { name: "GITHUB_TOKEN", isRequired: true, isSecret: true, description: "A token" },
              { name: "GITHUB_HOST", default: "github.com" },
            ],
          },
          { registryType: "pypi", identifier: "github-mcp", version: "1.4.0", transport: { type: "stdio" } },
          {
            registryType: "oci",
            identifier: "docker.io/example/github-mcp",
            version: "1.4.0",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "GITHUB_TOKEN", isSecret: true }],
          },
          { registryType: "cargo", identifier: "github-mcp", version: "1.4.0", transport: { type: "stdio" } },
        ],
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.example.test/{tenant}/mcp",
            variables: { tenant: { description: "Your tenant", isRequired: true } },
            headers: [{ name: "Authorization", value: "Bearer {api_key}", isSecret: true }],
          },
          { type: "sse", url: "https://mcp.example.test/sse" },
        ],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    },
    { server: { name: "broken" } },
    {
      server: { name: "io.example/gone", version: "1.0.0", packages: [{ registryType: "npm", identifier: "gone" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
    },
  ]

  async function fakeRegistry(answer: (url: URL) => Response) {
    const seen: URL[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        seen.push(url)
        return answer(url)
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, seen, [Symbol.dispose]: () => void server.stop(true) }
  }

  test("a page of servers as the add form takes them: commands, values to fill, publisher and version", async () => {
    using fake = await fakeRegistry(() =>
      Response.json({ servers: SERVERS, metadata: { nextCursor: "io.github.example/github:1.4.0", count: 3 } }),
    )
    await using r = await rig({ endpoints: { mcpRegistry: fake.url } })
    await ok(r.rpc["mcp.save"], { name: "github", scope: { type: "global" }, transport: local() })
    const page = await ok(r.rpc["mcp.registry.search"], { query: " git ", cursor: "c-1" })
    expect(fake.seen[0]!.pathname).toBe("/v0.1/servers")
    expect(Object.fromEntries(fake.seen[0]!.searchParams)).toEqual({
      limit: "20",
      version: "latest",
      search: "git",
      cursor: "c-1",
    })
    expect(page.registry).toBe(fake.url)
    expect(page.nextCursor).toBe("io.github.example/github:1.4.0")
    expect(page.entries).toHaveLength(1)
    const entry = page.entries[0]!
    expect(entry).toMatchObject({
      name: "io.github.example/github",
      title: "GitHub",
      version: "1.4.0",
      publisher: "io.github.example",
      repository: "https://github.com/example/github-mcp",
      status: "active",
      suggested: "github-2",
    })
    expect(entry.options).toEqual([
      {
        type: "package",
        registryType: "npm",
        identifier: "@example/github-mcp",
        version: "1.4.0",
        command: "npx",
        args: ["-y", "@example/github-mcp@1.4.0", "--api-key", "${API_KEY}", "--mode", "ro", "{repo}"],
        env: [
          { name: "GITHUB_TOKEN", description: "A token", required: true, secret: true },
          { name: "GITHUB_HOST", required: false, secret: false, value: "github.com" },
          { name: "API_KEY", description: "Your key", required: true, secret: true },
        ],
        fill: ["repo"],
      },
      {
        type: "package",
        registryType: "pypi",
        identifier: "github-mcp",
        version: "1.4.0",
        command: "uvx",
        args: ["github-mcp==1.4.0"],
        env: [],
        fill: [],
      },
      {
        type: "package",
        registryType: "oci",
        identifier: "docker.io/example/github-mcp",
        version: "1.4.0",
        command: "docker",
        args: ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "docker.io/example/github-mcp:1.4.0"],
        env: [{ name: "GITHUB_TOKEN", required: false, secret: true }],
        fill: [],
      },
      {
        type: "package",
        registryType: "cargo",
        identifier: "github-mcp",
        version: "1.4.0",
        args: [],
        env: [],
        fill: [],
        problem: "runtime",
      },
      {
        type: "remote",
        transport: "streamable-http",
        url: "https://mcp.example.test/{tenant}/mcp",
        headers: [{ name: "Authorization", required: false, secret: true, template: "Bearer {api_key}" }],
        variables: [{ name: "tenant", description: "Your tenant", required: true, secret: false }],
        fill: ["tenant"],
      },
      {
        type: "remote",
        transport: "sse",
        url: "https://mcp.example.test/sse",
        headers: [],
        variables: [],
        fill: [],
        problem: "sse",
      },
    ])
    // Nothing was saved: own's list is as it was.
    expect((await ok(r.rpc["mcp.list"], {})).servers.map((server) => server.name)).toEqual(["github"])
  })

  test("offline, an error status and an answer that is not a list are `mcp_registry_unavailable`", async () => {
    {
      await using r = await rig({ endpoints: { mcpRegistry: "http://127.0.0.1:9" } })
      expect(await call(r.rpc["mcp.registry.search"], {})).toMatchObject({
        ok: false,
        type: "mcp_registry_unavailable",
        data: { reason: "offline" },
      })
    }
    {
      using fake = await fakeRegistry(() => new Response("busy", { status: 503 }))
      await using r = await rig({ endpoints: { mcpRegistry: fake.url } })
      expect(await call(r.rpc["mcp.registry.search"], {})).toMatchObject({
        ok: false,
        type: "mcp_registry_unavailable",
        data: { reason: "status", status: 503 },
      })
    }
    {
      using fake = await fakeRegistry(() => new Response("<html>", { headers: { "content-type": "text/html" } }))
      await using r = await rig({ endpoints: { mcpRegistry: fake.url } })
      expect(await call(r.rpc["mcp.registry.search"], {})).toMatchObject({
        ok: false,
        type: "mcp_registry_unavailable",
        data: { reason: "invalid" },
      })
    }
  })

  test("a service given other endpoints but no registry never asks the real one", async () => {
    await using r = await rig()
    expect(await call(r.rpc["mcp.registry.search"], { query: "github" })).toMatchObject({
      ok: false,
      type: "mcp_registry_unavailable",
      data: { reason: "disabled" },
    })
  })
})

describe("transform registration", () => {
  test("mcp.json is read before the first fold: a kept off switch holds a config file's server back from its start", async () => {
    await using r = await rig()
    const project = path.join(r.t.home, "project")
    await ok(r.rpc["mcp.enable"], { directory: project, name: "docs", enabled: false })
    await ok(r.rpc["mcp.save"], {
      name: "files",
      scope: { type: "global" },
      transport: local([{ name: "FAKE_TOKEN", value: TOKEN }]),
    })
    const configDir = path.join(r.t.home, "config")
    await fs.mkdir(configDir, { recursive: true })
    await Bun.write(
      path.join(configDir, "opencode.jsonc"),
      '{ // own\n "mcp": { "timeout": { "startup": 30000, "x": 1 } } }',
    )
    // Core folds as soon as a transform is registered, and on every reload: each fold's servers, as core would start them.
    const folds: Array<Record<string, Mcp.ServerConfig>> = []
    const transforms: Array<(editor: MCPEditor) => void> = []
    const run = () => {
      const fold = editor({ docs: { type: "remote", url: "https://docs.example.test/mcp" } as Mcp.ServerConfig })
      for (const transform of transforms) transform(fold.edit)
      folds.push(Object.fromEntries(fold.servers))
    }
    const t = await testDeps({
      directory: project,
      configDir,
      options: { home: r.t.home } as never,
      ctx: {
        mcp: {
          transform: async (callback: (editor: MCPEditor) => void) => {
            transforms.push(callback)
            run()
          },
          reload: async () => run(),
        },
      },
    })
    const stop = await McpServers.register({ ...t.deps, runtime: r.t.deps.runtime })
    expect(folds[0]).toEqual({
      docs: { type: "remote", url: "https://docs.example.test/mcp", disabled: true },
      files: {
        type: "local",
        command: [process.execPath, FAKE_MCP_STDIO],
        timeout: { startup: 30000 },
        disabled: true,
      },
    })
    await until(() => folds.some((fold) => fold.files?.disabled === undefined))
    expect(folds.every((fold) => fold.docs?.disabled === true)).toBe(true)
    expect(folds.at(-1)!.files).toEqual({
      type: "local",
      command: [process.execPath, FAKE_MCP_STDIO],
      environment: { FAKE_TOKEN: TOKEN },
      timeout: { startup: 30000 },
    })
    stop()
    await t[Symbol.asyncDispose]()
  })

  test("folds the stored servers after setup and again on every change", async () => {
    await using r = await rig()
    const folds: Array<(editor: MCPEditor) => void> = []
    const reloads = { count: 0 }
    const t = await testDeps({
      directory: path.join(r.t.home, "project"),
      options: { home: r.t.home } as never,
      ctx: {
        mcp: {
          transform: async (callback: (editor: MCPEditor) => void) => void folds.push(callback),
          reload: async () => void reloads.count++,
        },
      },
    })
    // The same OWN_HOME, so the instance reads what the control instance wrote.
    const stop = await McpServers.register({ ...t.deps, runtime: r.t.deps.runtime })
    expect(folds).toHaveLength(1)
    await ok(r.rpc["mcp.save"], {
      name: "files",
      scope: { type: "global" },
      transport: local([{ name: "FAKE_TOKEN", value: TOKEN }]),
    })
    await until(() => reloads.count >= 1)
    const fold = editor()
    folds[0]!(fold.edit)
    expect(fold.servers.get("files")).toEqual({
      type: "local",
      command: [process.execPath, FAKE_MCP_STDIO],
      environment: { FAKE_TOKEN: TOKEN },
    })
    stop()
    await t[Symbol.asyncDispose]()
  })
})

// The round-2 MCP review (SM-22): each test failed on the code before it.
describe("review round 2", () => {
  const BEARER = "fakeBearerValue0000aaaa1111bbbb"
  const OPENAI = "sk-fakeOwnMcpKey0000aaaa1111bbbb"

  /** The values a test planted must be in none of these texts. */
  const free = (texts: ReadonlyArray<string>, values: ReadonlyArray<string>) => {
    for (const text of texts) for (const value of values) expect(text).not.toContain(value)
  }

  test("values inside arguments go to the vault: env pairs, headers, addresses and keys inside an argument", async () => {
    await using r = await rig()
    const view = await ok(r.rpc["mcp.save"], {
      name: "bridge",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "-e",
          `GITHUB_PERSONAL_ACCESS_TOKEN=${TOKEN}`,
          "ghcr.io/github/github-mcp-server",
          "--header",
          `Authorization: Bearer ${BEARER}`,
          `https://x.example.test/s/mcp?key=${KEY}`,
          `--config={"openai":"${OPENAI}"}`,
        ],
        env: [],
      },
    })
    const server = view.servers[0]!
    expect(server.transport).toMatchObject({
      args: [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "ghcr.io/github/github-mcp-server",
        "--header",
        "Authorization: Bearer ${AUTHORIZATION}",
        "https://x.example.test/s/mcp?key=${URL_KEY}",
        '--config={"openai":"${SECRET}"}',
      ],
    })
    free(
      [JSON.stringify(view), await r.file(), JSON.stringify(await ok(r.rpc["mcp.list"], {}))],
      [TOKEN, BEARER, KEY, OPENAI],
    )
    // The server still starts with every value as it was written.
    const stored = await McpStore.values(r.t.deps, (await McpStore.file(r.t.deps).read()).servers[0]!)
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry: (await McpStore.file(r.t.deps).read()).servers[0]!, values: stored }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("bridge")).toMatchObject({
      command: [
        "docker",
        "run",
        "-i",
        "--rm",
        "-e",
        `GITHUB_PERSONAL_ACCESS_TOKEN=${TOKEN}`,
        "ghcr.io/github/github-mcp-server",
        "--header",
        `Authorization: Bearer ${BEARER}`,
        `https://x.example.test/s/mcp?key=${KEY}`,
        `--config={"openai":"${OPENAI}"}`,
      ],
    })
  })

  test("Claude Code: a header argument, user info beside `${VAR}` and a key-like `${UNSET:-default}` stay hidden", async () => {
    await using r = await rig()
    const claudeHome = path.join(r.t.home, "claude-r2")
    await fs.mkdir(claudeHome, { recursive: true })
    await Bun.write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          a: { type: "http", url: `https://h.example.test/\${OWN_R2_UNSET:-${TOKEN}}/mcp` },
          b: { type: "http", url: "https://user:hunter2pass@h.example.test/${OWN_R2_SET}/mcp" },
          c: {
            command: "npx",
            args: ["mcp-remote", "https://x.example.test/mcp", "--header", `Authorization: Bearer ${BEARER}`],
          },
        },
      }),
    )
    process.env.OWN_R2_SET = "fake-path-part-0000"
    try {
      await using t = await testDeps({ control: true, options: { home: r.t.home, claudeHome } as never })
      const rpc = McpRpc.handlers(t.deps)
      const scan = await ok(rpc["mcp.import.scan"], {})
      expect(scan.candidates.map((item) => item.transport && transportLineOf(item.transport))).toEqual([
        "https://h.example.test/${OWN_R2_UNSET:-••••}/mcp",
        "https://••••@h.example.test/${OWN_R2_SET}/mcp",
        "npx mcp-remote https://x.example.test/mcp --header Authorization: Bearer ${AUTHORIZATION}",
      ])
      const applied = await ok(rpc["mcp.import.apply"], {
        nonce: scan.nonce,
        picks: scan.candidates.map((item) => ({ key: item.key, name: item.suggested, scope: item.scope })),
      })
      free(
        [JSON.stringify(scan), JSON.stringify(applied), await Bun.file(t.deps.runtime.layout.mcp).text()],
        [TOKEN, "hunter2pass", BEARER],
      )
    } finally {
      delete process.env.OWN_R2_SET
    }
  })

  test("a server comes back on when the vault answers again; the list's missing notice agrees", async () => {
    const memory = Vault.memory()
    const vault = { down: false }
    const transport: Vault.Transport = {
      request: (message) => (vault.down ? Promise.reject(new Error("pipe gone")) : memory.request(message)),
      close: () => memory.close(),
    }
    await using control = await testDeps({ control: true, vault: transport })
    await ok(McpRpc.handlers(control.deps)["mcp.save"], {
      name: "keyed",
      scope: { type: "global" },
      transport: local([{ name: "FAKE_TOKEN", value: TOKEN }]),
    })
    vault.down = true
    const folds: Array<Record<string, Mcp.ServerConfig>> = []
    const transforms: Array<(editor: MCPEditor) => void> = []
    const run = () => {
      const fold = editor()
      for (const transform of transforms) transform(fold.edit)
      folds.push(Object.fromEntries(fold.servers))
    }
    // Another runtime, as after a restart: nothing of the vault is cached there.
    await using location = await testDeps({
      vault: transport,
      ctx: {
        mcp: {
          transform: async (callback: (editor: MCPEditor) => void) => {
            transforms.push(callback)
            run()
          },
          reload: async () => run(),
        },
      },
    })
    await Bun.write(location.deps.runtime.layout.mcp, await Bun.file(control.deps.runtime.layout.mcp).text())
    const events = recordEvents(location.deps)
    // The page's list, answered from the same runtime as the Location's servers.
    const page = McpRpc.handlers({ ...control.deps, runtime: location.deps.runtime })
    const stop = await McpServers.register({ ...location.deps, location: { directory: location.home, control: false } })
    // The first read found the vault down: the server stays off and a read again is due.
    await until(() => location.clock.pending() > 0)
    expect(folds.at(-1)!.keyed?.disabled).toBe(true)
    expect((await ok(page["mcp.list"], {})).servers[0]).toMatchObject({ name: "keyed", missing: true })
    // Still down at the first retry: the next waits twice as long.
    location.clock.advance(McpServers.RETRY_MS)
    await until(() => location.clock.pending() > 0)
    vault.down = false
    location.clock.advance(McpServers.RETRY_MS)
    expect(folds.at(-1)!.keyed?.disabled).toBe(true)
    location.clock.advance(McpServers.RETRY_MS)
    // No `mcp.changed` came: the retry folds it on and tells the open pages.
    await until(() => folds.at(-1)!.keyed?.disabled === undefined)
    expect(folds.at(-1)!.keyed).toMatchObject({ environment: { FAKE_TOKEN: TOKEN } })
    await until(() => events.some((event) => event.name === "mcp.changed"))
    expect((await ok(page["mcp.list"], {})).servers[0]!.missing).toBeUndefined()
    expect(location.clock.pending()).toBe(0)
    stop()
  })

  test("removing or renaming a project's server leaves another project's switch of that name alone", async () => {
    await using r = await rig()
    const a = path.resolve("/work/a")
    const b = path.resolve("/work/b")
    const saved = await ok(r.rpc["mcp.save"], {
      name: "github",
      scope: { type: "project", directory: a },
      transport: local(),
    })
    // In project A it is own's server; in B, "github" is a config file's server the user switched off.
    await ok(r.rpc["mcp.enable"], { directory: path.join(a, "sub"), name: "github", enabled: false })
    await ok(r.rpc["mcp.enable"], { directory: b, name: "github", enabled: false })
    const id = saved.servers[0]!.id
    const renamed = await ok(r.rpc["mcp.save"], {
      id,
      name: "gh2",
      scope: { type: "project", directory: a },
      transport: local(),
    })
    expect(renamed.overrides).toEqual([
      { directory: path.join(a, "sub"), name: "gh2", enabled: false },
      { directory: b, name: "github", enabled: false },
    ])
    const removed = await ok(r.rpc["mcp.remove"], { id })
    expect(removed.overrides).toEqual([{ directory: b, name: "github", enabled: false }])
  })

  test("the connection test masks a server that echoes its key in its name and tool descriptions", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const auth = request.headers.get("authorization") ?? ""
        const body = (await request.json()) as { id?: number; method?: string }
        if (body.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: `echo ${auth}`, version: BEARER },
            },
          })
        if (body.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: `t-${BEARER}`, description: `you sent ${auth}` }] },
          })
        return new Response(null, { status: 202 })
      },
    })
    try {
      const check = await McpProbe.probe(
        { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${BEARER}` } },
        { secrets: [`Bearer ${BEARER}`] },
      )
      // The scheme word is no secret (SM-24): only the token is masked.
      expect(check).toMatchObject({
        ok: true,
        server: "echo Bearer •••• ••••",
        tools: [{ name: "t-••••", description: "you sent Bearer ••••" }],
      })
      free([JSON.stringify(check)], [BEARER])
    } finally {
      void server.stop(true)
    }
  })

  test("core's error text of own's servers comes from the list for a project, its values cut out", async () => {
    await using r = await rig()
    const project = path.resolve("/work/game")
    await ok(r.rpc["mcp.save"], {
      name: "keyed",
      scope: { type: "global" },
      transport: local([{ name: "FAKE_TOKEN", value: TOKEN }]),
    })
    await ok(r.rpc["mcp.save"], {
      name: "elsewhere",
      scope: { type: "project", directory: path.resolve("/other") },
      transport: local(),
    })
    const asked: unknown[] = []
    await using t = await testDeps({
      control: true,
      ctx: {
        mcp: {
          list: async (input: unknown) => {
            asked.push(input)
            return {
              location: { directory: project },
              data: [
                { name: "keyed", status: { status: "failed", error: `exit 3: fake mcp: bad token ${TOKEN}` } },
                { name: "docs", status: { status: "failed", error: "a config file's server" } },
                { name: "elsewhere", status: { status: "failed", error: "not here" } },
              ],
            }
          },
        },
      },
    })
    const rpc = McpRpc.handlers({ ...t.deps, runtime: r.t.deps.runtime })
    const view = await ok(rpc["mcp.list"], { directory: project })
    expect(view.errors).toEqual({ keyed: "exit 3: fake mcp: bad token ••••" })
    expect(asked).toEqual([{ location: { directory: project } }])
    expect((await ok(rpc["mcp.list"], {})).errors).toBeUndefined()
  })

  test("the same definition with other values: the row says so and the pick chooses whose values to take", async () => {
    await using r = await rig()
    const codexHome = path.join(r.t.home, "codex-r2")
    const claudeHome = path.join(r.t.home, "claude-r2")
    await fs.mkdir(codexHome, { recursive: true })
    await fs.mkdir(claudeHome, { recursive: true })
    await Bun.write(
      path.join(codexHome, "config.toml"),
      [
        "[mcp_servers.github]",
        'command = "gh-mcp"',
        "[mcp_servers.github.env]",
        'GITHUB_TOKEN = "codex-value-0000000000000"',
        "[mcp_servers.zap]",
        `url = "https://mcp.example.test/s/${BEARER}/mcp"`,
      ].join("\n"),
    )
    const other = "fakeOtherPathValue0000cccc2222dddd"
    await Bun.write(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "gh-mcp", env: { GITHUB_TOKEN: "claude-value-111111111111" } },
          // Shown the same as Codex's zap (`https://mcp.example.test/s/••••/mcp`), but another address.
          zap2: { type: "http", url: `https://mcp.example.test/s/${other}/mcp` },
        },
      }),
    )
    await using t = await testDeps({ control: true, options: { home: r.t.home, codexHome, claudeHome } as never })
    const rpc = McpRpc.handlers(t.deps)
    const scan = await ok(rpc["mcp.import.scan"], {})
    expect(scan.candidates.map((item) => [item.source, item.name, item.also])).toEqual([
      [
        "codex",
        "github",
        [{ source: "claude-user", name: "github", differs: true, values: [{ name: "GITHUB_TOKEN", hint: "…1111" }] }],
      ],
      ["codex", "zap", []],
      ["claude-user", "zap2", []],
    ])
    expect(scan.candidates[0]!.transport).toMatchObject({ env: [{ name: "GITHUB_TOKEN", hint: "…0000" }] })
    const applied = await ok(rpc["mcp.import.apply"], {
      nonce: scan.nonce,
      picks: [
        { key: "c1", name: "github", scope: { type: "global" }, place: 1 },
        { key: "c2", name: "zap", scope: { type: "global" } },
      ],
    })
    const github = await t.deps.runtime.credentials.mcpSecrets(McpStore.vaultID(applied.imported[0]!.id))
    expect(github.ok && JSON.parse(github.text)).toEqual({
      env: { GITHUB_TOKEN: "claude-value-111111111111" },
      headers: {},
    })
    expect(applied.view.servers.find((server) => server.name === "github")).toMatchObject({ from: "claude-code" })
    // A second look: own has Codex's zap, not Claude Code's other address that shows the same.
    const again = await ok(rpc["mcp.import.scan"], {})
    expect(again.candidates.map((item) => [item.name, item.imported])).toEqual([
      ["github", true],
      ["zap", true],
      ["zap2", false],
    ])
    expect(
      await call(rpc["mcp.import.apply"], {
        nonce: again.nonce,
        picks: [{ key: "c3", name: "zap2", scope: { type: "global" }, place: 1 }],
      }),
    ).toMatchObject({ ok: false, type: "mcp_invalid", data: { field: "pick" } })
  })

  test("apply stores every value before the list; a vault that stops half way leaves no item and keeps the nonce", async () => {
    const memory = Vault.memory()
    const vault = { puts: 0, refuse: true }
    const transport: Vault.Transport = {
      request: (message) => {
        const put = message.op === "put" && String(message.id).startsWith("mcp-")
        if (put && vault.refuse && ++vault.puts === 2) return Promise.reject(new Error("pipe gone"))
        return memory.request(message)
      },
      close: () => memory.close(),
    }
    await using r = await rig()
    const codexHome = path.join(r.t.home, "codex-r2-apply")
    await fs.mkdir(codexHome, { recursive: true })
    await Bun.write(
      path.join(codexHome, "config.toml"),
      [
        "[mcp_servers.one]",
        'command = "one-mcp"',
        "[mcp_servers.one.env]",
        'ONE_TOKEN = "fake-one-token-000000000"',
        "[mcp_servers.two]",
        'command = "two-mcp"',
        "[mcp_servers.two.env]",
        'TWO_TOKEN = "fake-two-token-000000000"',
      ].join("\n"),
    )
    await using t = await testDeps({ control: true, vault: transport, options: { home: r.t.home, codexHome } as never })
    const rpc = McpRpc.handlers(t.deps)
    const scan = await ok(rpc["mcp.import.scan"], {})
    const picks = scan.candidates.map((item) => ({ key: item.key, name: item.suggested, scope: item.scope }))
    expect(await call(rpc["mcp.import.apply"], { nonce: scan.nonce, picks })).toMatchObject({
      ok: false,
      type: "vault_unavailable",
    })
    expect(memory.snapshot().ids.filter((id) => id.startsWith("mcp-"))).toEqual([])
    expect((await ok(rpc["mcp.list"], {})).servers).toEqual([])
    // The vault answers again: the same scan imports both.
    vault.refuse = false
    const applied = await ok(rpc["mcp.import.apply"], { nonce: scan.nonce, picks })
    expect(applied.imported.map((item) => item.name)).toEqual(["one", "two"])
    expect(memory.snapshot().ids.filter((id) => id.startsWith("mcp-"))).toHaveLength(2)
    expect(await call(rpc["mcp.import.apply"], { nonce: scan.nonce, picks })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })
  })

  describe("hostile registry data", () => {
    async function fake(fetch: () => Response) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
      return { url: `http://127.0.0.1:${server.port}`, [Symbol.dispose]: () => void server.stop(true) }
    }

    test("a body past 4 MiB is dropped while it streams, not read to its end", async () => {
      const chunk = new TextEncoder().encode(`{"servers":[${" ".repeat(64 * 1024)}`)
      const sent = { bytes: 0 }
      // A body that never ends: reading it whole would wait for the timeout.
      using registry = await fake(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                sent.bytes += chunk.byteLength
                controller.enqueue(chunk)
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      )
      const started = performance.now()
      const result = await McpRegistry.search({ base: registry.url, taken: [], timeoutMs: 10_000 })
      expect(result).toEqual({ ok: false, error: { reason: "invalid" } })
      expect(performance.now() - started).toBeLessThan(8_000)
      expect(sent.bytes).toBeLessThan(McpRegistry.MAX_BODY + 16 * 1024 * 1024)
    })

    test("long fields are clipped or left out, counts are capped, a long cursor ends the list, an empty version is kept", async () => {
      const huge = "x".repeat(200_000)
      const entry = (name: string, extra: Record<string, unknown> = {}) => ({
        server: {
          name,
          version: "1.0.0",
          packages: [{ registryType: "npm", identifier: "@x/fine", version: "1.0.0" }],
          ...extra,
        },
      })
      using registry = await fake(() =>
        Response.json({
          servers: [
            entry(`io.github.${huge}/evil`, {
              title: huge,
              description: huge,
              version: "",
              repository: { url: `https://example.test/${huge}` },
              websiteUrl: `https://example.test/${huge}`,
              packages: [
                { registryType: "npm", identifier: `@x/${huge}`, version: "1" },
                {
                  registryType: "npm",
                  identifier: "@x/named",
                  packageArguments: [{ type: "named", name: `--${huge}`, value: "1" }],
                },
                {
                  registryType: "npm",
                  identifier: "@x/fill",
                  packageArguments: [{ type: "positional", valueHint: huge, isRequired: true }],
                },
                {
                  registryType: "npm",
                  identifier: "@x/word",
                  packageArguments: [{ type: "named", name: "--mode", value: huge.slice(0, 2_000) }],
                },
                { registryType: huge, identifier: "@x/odd" },
                {
                  registryType: "npm",
                  identifier: "@x/ok",
                  environmentVariables: [
                    { name: "OK_TOKEN", isSecret: true, description: huge },
                    { name: "OK_MODE", default: huge },
                  ],
                },
              ],
              remotes: [
                { type: huge, url: "https://example.test/mcp" },
                { type: "streamable-http", url: `https://example.test/${huge}` },
              ],
            }),
            ...Array.from({ length: 40 }, (_, index) => entry(`io.github.demo/s${index}`)),
          ],
          metadata: { nextCursor: huge.slice(0, 501) },
        }),
      )
      const result = await McpRegistry.search({ base: registry.url, taken: [] })
      if (!result.ok) throw new Error(result.error.reason)
      const page = result.value
      expect(page.entries).toHaveLength(OwnMcp.REGISTRY_PAGE)
      expect(page.nextCursor).toBeUndefined()
      const evil = page.entries[0]!
      expect(evil.publisher.length).toBeLessThanOrEqual(200)
      expect(evil.name.length).toBeLessThanOrEqual(200)
      expect(evil.title!.length).toBeLessThanOrEqual(200)
      expect(evil.description!.length).toBeLessThanOrEqual(500)
      expect(evil.version).toBe("")
      expect(evil.repository).toBeUndefined()
      expect(evil.website).toBeUndefined()
      // What the form would take cut (an identifier, an argument, a `{part}`, an address) leaves its option out.
      expect(evil.options.map((option) => (option.type === "package" ? option.identifier : option.url))).toEqual([
        "@x/odd",
        "@x/ok",
        "https://example.test/mcp",
      ])
      const [odd, fine, remote] = evil.options
      expect(odd).toMatchObject({ problem: "runtime" })
      expect(odd!.type === "package" && odd!.registryType.length).toBeLessThanOrEqual(32)
      expect(
        fine!.type === "package" && fine!.env.map((value) => [value.name, value.description?.length, value.value]),
      ).toEqual([
        ["OK_TOKEN", 500, undefined],
        ["OK_MODE", undefined, undefined],
      ])
      expect(remote).toMatchObject({ problem: "transport" })
      expect(remote!.type === "remote" && remote!.transport.length).toBeLessThanOrEqual(32)
      const longest = Math.max(
        ...JSON.stringify(page)
          .match(/"(?:[^"\\]|\\.)*"/g)!
          .map((text) => text.length),
      )
      expect(longest).toBeLessThan(600)
    })
  })
})

describe("review round 3 (SM-25)", () => {
  /** Ten characters: masked whole only (no 8-character runs below 12), so a cut part of it is not recognized. */
  const SHORT = "Fake0Pw!X9"
  const MASKED = "••••"

  /**
   * Three whole occurrences, then one starting 5 characters past `limit`: a cut at `limit` plus the value's length
   * before masking keeps its first five characters, and the three `••••` before it pull them inside the limit.
   */
  const acrossHead = (limit: number, fill: string) => {
    const before = `${SHORT} `.repeat(3)
    return {
      text: `${before}${fill.repeat(limit + 5 - before.length)}${SHORT} end`,
      shown: `${`${MASKED} `.repeat(3)}${fill.repeat(limit + 5 - before.length)}${MASKED} end`,
    }
  }
  /** The last `limit` + 10 characters start 5 characters into an occurrence, two whole ones follow. */
  const acrossTail = (limit: number) => {
    const body = ` ${SHORT} ${SHORT} `
    const filler = "z".repeat(limit + 5 - body.length)
    return {
      text: `${"y".repeat(40)}${SHORT}${body}${filler}`,
      shown: `${"y".repeat(40)}${MASKED} ${MASKED} ${MASKED} ${filler}`,
    }
  }

  test("masked whole, then cut: repeated values across the cut stay masked at the head and the tail", async () => {
    const masker = McpProbe.masker([SHORT])
    const head = acrossHead(300, "x")
    expect(masker.head(head.text, 300)).toBe(head.shown)
    const tail = acrossTail(1_500)
    expect(masker.tail(tail.text, 1_500)).toBe(tail.shown.slice(-1_500))
    for (const text of [masker.head(head.text, 300), masker.tail(tail.text, 1_500)])
      for (const part of ["Fake0", "0Pw!X", "Pw!X9"]) expect(text).not.toContain(part)

    const name = acrossHead(300, "n")
    const description = acrossHead(300, "d")
    const error = acrossHead(2_000, "e")
    const body = acrossHead(500, "b")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/http") return new Response(body.text, { status: 500 })
        const message = (await request.json()) as { id?: number; method?: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: name.text } },
          })
        if (path === "/error")
          return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.text } })
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "t", description: description.text }] },
        })
      },
    })
    try {
      const at = (path: string) =>
        McpProbe.probe(
          { type: "remote", url: `http://127.0.0.1:${server.port}${path}`, headers: {} },
          { secrets: [SHORT] },
        )
      expect(await at("/mcp")).toMatchObject({
        ok: true,
        server: name.shown,
        tools: [{ name: "t", description: description.shown }],
      })
      expect(await at("/error")).toMatchObject({ ok: false, failure: "protocol", error: error.shown })
      expect(await at("/http")).toMatchObject({ ok: false, failure: "http", status: 500, error: body.shown })
    } finally {
      void server.stop(true)
    }
    const stderr = acrossTail(1_500)
    const exited = await McpProbe.probe(
      {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        cwd: process.cwd(),
        env: { FAKE_MCP_FAIL: stderr.text },
      },
      { secrets: [SHORT] },
    )
    expect(exited).toMatchObject({ ok: false, failure: "exited" })
    expect(exited.error).toBe(`exit 3: ${`fake mcp: ${stderr.shown}`.slice(-1_500)}`)
  })

  test("only secret values are masked: moved arguments, secret names and keys; a region, a format and a folder stay", async () => {
    await using r = await rig()
    const KEYED = "sk-fakeOwnMcpKey0000aaaa1111cccc"
    const said = [
      "region us-east-1 dir C:\\work\\own-data",
      `token ${TOKEN} key ${KEYED}`,
      "header FAKE-VALUE-0002-header default FAKE-VALUE-0003-moved",
      "cluster FAKE-VALUE-0004-cluster user fakeuser:FAKE-VALUE-0005-user",
    ].join(" ")
    const local = await ok(r.rpc["mcp.test"], {
      transport: {
        type: "local",
        command: process.execPath,
        args: [
          FAKE_MCP_STDIO,
          "--headers",
          "Authorization",
          "Bearer FAKE-VALUE-0002-header",
          "--api-key",
          "${FAKE_DEFAULT:-FAKE-VALUE-0003-moved}",
          "-e",
          "CLUSTER=FAKE-VALUE-0004-cluster",
          "https://fakeuser:FAKE-VALUE-0005-user@h.example.test/mcp",
        ],
        env: [
          { name: "GITHUB_TOKEN", value: TOKEN },
          { name: "OPENAI", value: KEYED },
          { name: "REGION", value: "us-east-1" },
          { name: "WORK_DIR", value: "C:\\work\\own-data" },
          { name: "FAKE_MCP_FAIL", value: said },
        ],
      },
    })
    expect(local).toMatchObject({ ok: false, failure: "exited" })
    expect(local.error).toBe(
      "exit 3: fake mcp: region us-east-1 dir C:\\work\\own-data token •••• key •••• header •••• default •••• cluster •••• user ••••",
    )

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `format application/json region us-east-1 auth Bearer ${TOKEN} key ${KEYED} team FAKE-VALUE-0006-query`,
          { status: 500 },
        ),
    })
    try {
      const remote = await ok(r.rpc["mcp.test"], {
        transport: {
          type: "remote",
          url: `http://127.0.0.1:${server.port}/mcp?team=FAKE-VALUE-0006-query`,
          headers: [
            { name: "X-Format", value: "application/json" },
            { name: "X-Region", value: "us-east-1" },
            { name: "Authorization", value: `Bearer ${TOKEN}` },
            { name: "X-Plain", value: KEYED },
          ],
          oauth: false,
        },
      })
      expect(remote).toMatchObject({ ok: false, failure: "http", status: 500 })
      expect(remote.error).toBe("format application/json region us-east-1 auth Bearer •••• key •••• team ••••")
    } finally {
      void server.stop(true)
    }
  })

  test("mcp-proxy's two-argument header and a JSON argument go to the vault; the server gets them back", async () => {
    await using r = await rig()
    const saved = await ok(r.rpc["mcp.save"], {
      name: "proxy",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: "uvx",
        args: [
          "mcp-proxy",
          "--headers",
          "Authorization",
          "Bearer FAKE-VALUE-0007-header",
          "--config",
          '{"apiKey":"FAKE-VALUE-0008-json","region":"eu"}',
          "--region",
          "${REGION:-eu}",
          "https://h.example.test/mcp",
        ],
        env: [],
      },
    })
    const transport = saved.servers[0]!.transport
    expect(transport.type === "local" && transport.args).toEqual([
      "mcp-proxy",
      "--headers",
      "Authorization",
      "Bearer ${AUTHORIZATION}",
      "--config",
      '{"apiKey":"${API_KEY}","region":"eu"}',
      "--region",
      "${REGION:-eu}",
      "https://h.example.test/mcp",
    ])
    expect(await r.file()).not.toContain("FAKE-VALUE-000")
    // The fold puts every value back, and `${REGION:-eu}` with no stored REGION becomes its default.
    const entry = (await McpStore.file(r.t.deps).read()).servers[0]!
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry, values: await McpStore.values(r.t.deps, entry) }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("proxy")).toMatchObject({
      command: [
        "uvx",
        "mcp-proxy",
        "--headers",
        "Authorization",
        "Bearer FAKE-VALUE-0007-header",
        "--config",
        '{"apiKey":"FAKE-VALUE-0008-json","region":"eu"}',
        "--region",
        "eu",
        "https://h.example.test/mcp",
      ],
    })
  })
})

describe("review round 4 (SM-26)", () => {
  test("values under plain names: addresses, a webhook, a DSN, a connection string and plural keys are masked", async () => {
    await using r = await rig()
    const values = {
      db: "postgres://fakeuser:FAKE-VALUE-0009-pw@db.test/x",
      redis: "redis://:FAKE-VALUE-0010-pw@cache.test:6379",
      mongo: "mongodb+srv://fakeuser:FAKE-VALUE-0014-pw@cl.test/db",
      keys: "FAKE-VALUE-0011-plural",
      connection: "Server=db.test;User=fake;Password=FAKE-VALUE-0013-cs;",
      dsn: "https://FAKEVALUE0012abcdef@o1.ingest.test/1",
      hook: "https://hooks.example.test/services/T0000/B0000/FAKEVALUE0051abcdefghijklmn",
      api: "https://api.example.test/v1",
    }
    const said = Object.entries(values)
      .map(([name, value]) => `${name} ${value}`)
      .join(", ")
    const saved = await ok(r.rpc["mcp.save"], {
      name: "plain",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        env: [
          { name: "DATABASE_URL", value: values.db },
          { name: "REDIS_URL", value: values.redis },
          { name: "MONGODB_URI", value: values.mongo },
          { name: "API_KEYS", value: values.keys },
          { name: "CONNECTION_STRING", value: values.connection },
          { name: "SENTRY_DSN", value: values.dsn },
          { name: "SLACK_WEBHOOK_URL", value: values.hook },
          { name: "API_URL", value: values.api },
          { name: "REGION", value: "us-east-1" },
          { name: "FAKE_MCP_FAIL", value: `${said}, region us-east-1` },
        ],
      },
    })
    const check = await ok(r.rpc["mcp.test"], { id: saved.servers[0]!.id })
    expect(check).toMatchObject({ ok: false, failure: "exited" })
    expect(check.error).toBe(
      [
        "exit 3: fake mcp: db postgres://••••@db.test/x",
        "redis redis://••••@cache.test:6379",
        "mongo mongodb+srv://••••@cl.test/db",
        "keys ••••",
        "connection Server=db.test;User=fake;Password=••••;",
        "dsn https://••••@o1.ingest.test/1",
        "hook https://hooks.example.test/services/T0000/B0000/••••",
        "api https://api.example.test/v1",
        "region us-east-1",
      ].join(", "),
    )
    // The saved server's own test is kept in mcp.json: no value there either.
    expect(await r.file()).not.toMatch(/FAKE-?VALUE/)
  })

  test("a JSON value is stored as itself and comes back as the same JSON; its echo is masked raw and escaped", async () => {
    await using r = await rig()
    const tricky = 'FAKE-VALUE-0031-"quoted"\\tail'
    const config = `{"password":${JSON.stringify(tricky)},"id":12345678901234567890}`
    const saved = await ok(r.rpc["mcp.save"], {
      name: "json",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: process.execPath,
        args: [
          FAKE_MCP_STDIO,
          "--config",
          config,
          "--api-key",
          "${K:-FAKE-VALUE-0032-first}",
          "--token",
          "${K:-FAKE-VALUE-0033-second}",
        ],
        env: [{ name: "FAKE_MCP_FAIL", value: `raw ${tricky} escaped ${JSON.stringify(tricky).slice(1, -1)} end` }],
      },
    })
    const transport = saved.servers[0]!.transport
    expect(transport.type === "local" && transport.args).toEqual([
      FAKE_MCP_STDIO,
      "--config",
      '{"password":"${PASSWORD}","id":12345678901234567890}',
      "--api-key",
      "${K}",
      "--token",
      "${K_2}",
    ])
    const entry = (await McpStore.file(r.t.deps).read()).servers[0]!
    const stored = await McpStore.values(r.t.deps, entry)
    expect(stored?.env).toMatchObject({ PASSWORD: tricky, K: "FAKE-VALUE-0032-first", K_2: "FAKE-VALUE-0033-second" })
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry, values: stored }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("json")).toMatchObject({
      command: [
        process.execPath,
        FAKE_MCP_STDIO,
        "--config",
        config,
        "--api-key",
        "FAKE-VALUE-0032-first",
        "--token",
        "FAKE-VALUE-0033-second",
      ],
    })
    const check = await ok(r.rpc["mcp.test"], { id: entry.id })
    expect(check.error).toBe("exit 3: fake mcp: raw •••• escaped •••• end")
  })

  test("masked whole up to RAW, then cut: copies of one value, and a value cut where the text was cut", async () => {
    /** Ten characters, masked whole only: a cut part of it is too short to be recognized as a part. */
    const SHORT = "Fake0Pw!X9"
    const masker = McpProbe.masker([SHORT])
    // Cut before the masker saw it (SM-27: a real cut, here the server's mark or the stderr's dropped start): the start
    // of the value at a head's end, its end at a tail's start, from 4 characters.
    expect(masker.head(`ok ${SHORT} then Fake0Pw…`, 300)).toBe("ok •••• then ••••…")
    expect(masker.tail(`w!X9 then ${SHORT} ok`, 300, true)).toBe("•••• then •••• ok")
    // Fewer than four, or a plain word, stays: it would hide ordinary text.
    expect(masker.head("ok Fak…", 300)).toBe("ok Fak…")
    expect(masker.head("ok Fake…", 300)).toBe("ok Fake…")
    expect(masker.text(`ok ${SHORT} then Fake0Pw`)).toBe("ok •••• then Fake0Pw")

    // A description of 4,000 copies (more than SM-25's 32 KiB cap), and one longer than RAW whose cut leaves 7
    // characters of the value at its end.
    const copies = SHORT.repeat(4_000)
    const pad = (McpProbe.RAW - 7) % SHORT.length
    const long = `${"x".repeat(pad)}${SHORT.repeat(Math.ceil(McpProbe.RAW / SHORT.length) + 10)}`
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as { id?: number; method?: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: copies } },
          })
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              { name: copies, description: copies },
              { name: "long", description: long },
            ],
          },
        })
      },
    })
    try {
      const check = await McpProbe.probe(
        { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, headers: {} },
        { secrets: [SHORT] },
      )
      expect(check).toMatchObject({
        ok: true,
        server: "••••",
        tools: [
          { name: "••••", description: "••••" },
          { name: "long", description: `${"x".repeat(pad)}••••` },
        ],
      })
    } finally {
      void server.stop(true)
    }
  })
})

describe("review round 5 (SM-27)", () => {
  test("names of a key's length stay readable in addresses and server texts; a split key is still masked", async () => {
    await using r = await rig()
    const SPLIT_32 = "RkFLRS1WQUxVRS0wMDI5LWs/eS1mYWtlLWtleS0zMmI="
    const urls = {
      DOCS_URL: "https://gitmcp.io/PaddlePaddle/Paddle2ONNX",
      REPO_URL: "https://h.example.test/JohnSmith42/MyRepo2024",
      TENANT_URL: "https://h.example.test/Tenant01/Workspace2025",
      GROUP_URL: "https://h.example.test/MyGroup1%2FMyProject2024",
      HOME_URL: "file:///Users/JaneDoe42/Projects2025",
      BOARD_URL: "https://h.example.test/mcp/MyProjectDashboard2025/sse",
      HOOK_URL: `https://h.example.test/mcp/${SPLIT_32}/sse`,
    }
    const said = [
      "fetch_Paddle2ONNX_documentation for PaddlePaddle/Paddle2ONNX",
      "JohnSmith42/MyRepo2024",
      "Tenant01/Workspace2025",
      "MyGroup1%2FMyProject2024",
      "JaneDoe42/Projects2025",
      "MyProjectDashboard2025",
      `hook ${urls.HOOK_URL}`,
    ].join(", ")
    const saved = await ok(r.rpc["mcp.save"], {
      name: "paths",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        env: [
          ...Object.entries(urls).map(([name, value]) => ({ name, value })),
          { name: "FAKE_MCP_FAIL", value: said },
        ],
      },
    })
    const check = await ok(r.rpc["mcp.test"], { id: saved.servers[0]!.id })
    expect(check.error).toBe(`exit 3: fake mcp: ${said.replace(SPLIT_32, "••••")}`)
    expect(await r.file()).not.toContain("RkFLRS1WQUxVRS0wMDI5")
    // A tool's name and description that quote the address of a gitmcp server stay as written.
    const masker = McpProbe.masker([urls.DOCS_URL])
    for (const text of ["fetch_Paddle2ONNX_documentation", "Search the Paddle2ONNX docs of PaddlePaddle/Paddle2ONNX"])
      expect(masker.head(text, 300)).toBe(text)
    // The remote server is saved as written, not as a hidden address.
    const remote = await ok(r.rpc["mcp.save"], {
      name: "gitmcp",
      scope: { type: "global" },
      transport: { type: "remote", url: urls.DOCS_URL, headers: [], oauth: false },
    })
    expect(remote.servers.find((server) => server.name === "gitmcp")!.transport).toMatchObject({
      type: "remote",
      url: urls.DOCS_URL,
    })
    expect(await r.file()).toContain("PaddlePaddle/Paddle2ONNX")
  })

  test("DSN forms under plain names are masked to their password; in arguments they move and come back", async () => {
    await using r = await rig()
    const values = {
      JDBC_URL: "jdbc:postgresql://db.example.test:5432/app?user=fake&password=FAKE-VALUE-0061-jdbc",
      MYSQL_DSN: "fake:FAKE-VALUE-0062-go@tcp(db.example.test:3306)/app",
      PG_CONNECTION: "host=db.example.test dbname=app user=fake password=FAKE-VALUE-0063-pg",
      ORACLE_CONNECTION: "fake/FAKE-VALUE-0064-ora@db.example.test:1521/XEPDB1",
      SQL_CONNECTION: 'Server=db.example.test;User Id=fake;Password="FAKE;VALUE-0066"',
      AZURE_STORAGE:
        "BlobEndpoint=https://acct.blob.example.test/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=FAKEVALUE0068sig",
      MSSQL_URL: "jdbc:sqlserver://db.example.test:1433;databaseName=app;password=FAKE-VALUE-0067",
    }
    // Each after its name, as SM-26's test: a text that starts with an address would be one value of its own.
    const said = Object.entries(values)
      .map(([name, value]) => `${name} ${value}`)
      .join(", ")
    const saved = await ok(r.rpc["mcp.save"], {
      name: "dsn",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        env: [
          ...Object.entries(values).map(([name, value]) => ({ name, value })),
          { name: "FAKE_MCP_FAIL", value: said },
        ],
      },
    })
    const check = await ok(r.rpc["mcp.test"], { id: saved.servers[0]!.id })
    expect(check.error).toBe(
      [
        "exit 3: fake mcp: JDBC_URL jdbc:postgresql://db.example.test:5432/app?user=fake&password=••••",
        "MYSQL_DSN fake:••••@tcp(db.example.test:3306)/app",
        "PG_CONNECTION host=db.example.test dbname=app user=fake password=••••",
        "ORACLE_CONNECTION fake/••••@db.example.test:1521/XEPDB1",
        'SQL_CONNECTION Server=db.example.test;User Id=fake;Password="••••"',
        "AZURE_STORAGE BlobEndpoint=https://acct.blob.example.test/;SharedAccessSignature=sv=2022-11-02&ss=b&sig=••••",
        "MSSQL_URL jdbc:sqlserver://db.example.test:1433;databaseName=app;password=••••",
      ].join(", "),
    )
    expect(await r.file()).not.toMatch(/FAKE-?VALUE/)

    const args = [
      FAKE_MCP_STDIO,
      "--dsn",
      values.MYSQL_DSN,
      "host=db.example.test password='FAKE VALUE-0069'",
      values.ORACLE_CONNECTION,
      `--connection=${values.SQL_CONNECTION}`,
    ]
    const lifted = await ok(r.rpc["mcp.save"], {
      name: "dsn-args",
      scope: { type: "global" },
      transport: { type: "local", command: process.execPath, args, env: [] },
    })
    const transport = lifted.servers.find((server) => server.name === "dsn-args")!.transport
    expect(transport.type === "local" && transport.args).toEqual([
      FAKE_MCP_STDIO,
      "--dsn",
      "fake:${PASSWORD}@tcp(db.example.test:3306)/app",
      "host=db.example.test password='${PASSWORD_2}'",
      "fake/${PASSWORD_3}@db.example.test:1521/XEPDB1",
      '--connection=Server=db.example.test;User Id=fake;Password="${PASSWORD_4}"',
    ])
    expect(await r.file()).not.toMatch(/FAKE-?VALUE/)
    const entry = (await McpStore.file(r.t.deps).read()).servers.find((server) => server.name === "dsn-args")!
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry, values: await McpStore.values(r.t.deps, entry) }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("dsn-args")).toMatchObject({ command: [process.execPath, ...args] })
  })

  test("edges are masked only at a real cut: the masker's own, the stderr's dropped start, a server's mark", async () => {
    const VALUE = "2024-FAKE-VALUE-0071"
    const masker = McpProbe.masker([VALUE])
    // Never cut: a name that ends with the start of a value, or a text that starts with the end of one, stays.
    expect(masker.head("Example Server 2024", 300)).toBe("Example Server 2024")
    expect(masker.tail("0071 started", 300)).toBe("0071 started")
    // A server's mark (an ellipsis right at the cut, `[truncated]`), and a tail whose start was dropped. SM-28: at an
    // ellipsis alone a plain number stays (`Example Server 2024…`, `…0071 started`), as SM-27 masked it.
    expect(masker.head("Example Server 2024-FA…", 300)).toBe("Example Server ••••…")
    expect(masker.head("Example Server 2024 [truncated]", 300)).toBe("Example Server •••• [truncated]")
    expect(masker.tail("…E-0071 started", 300)).toBe("…•••• started")
    expect(masker.tail("0071 started", 300, true)).toBe("•••• started")
    // An ellipsis after a space is no cut of the value; the masker's own cut past RAW is one.
    expect(masker.head("Example Server 2024 ...", 300)).toBe("Example Server 2024 ...")
    const long = `${"x".repeat(McpProbe.RAW - 4)}2024 and more`
    expect(masker.head(long, McpProbe.RAW)).toBe(`${"x".repeat(McpProbe.RAW - 4)}••••`)

    // Through the test: a server's name and a description never cut, one the server cut with `…`.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as { id?: number; method?: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "Example Server 2024" } },
          })
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              { name: "plain", description: "Example Server 2024" },
              { name: "cut", description: "Uses 2024-FAKE…" },
            ],
          },
        })
      },
    })
    try {
      const check = await McpProbe.probe(
        { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, headers: {} },
        { secrets: [VALUE] },
      )
      expect(check).toMatchObject({
        ok: true,
        server: "Example Server 2024",
        tools: [
          { name: "plain", description: "Example Server 2024" },
          { name: "cut", description: "Uses ••••…" },
        ],
      })
    } finally {
      void server.stop(true)
    }

    // A stderr longer than RAW: its kept start is the end of a value, masked; the rest is copies of the value.
    const copies = Math.floor((McpProbe.RAW - 8) / VALUE.length)
    const fill = McpProbe.RAW - 8 - copies * VALUE.length
    const script = [
      `const text = "y".repeat(50) + "0071" + ${JSON.stringify(VALUE)}.repeat(${copies}) + "x".repeat(${fill}) + " end"`,
      "process.stderr.write(text, () => process.exit(3))",
    ].join("\n")
    const exited = await McpProbe.probe(
      { type: "local", command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {} },
      { secrets: [VALUE] },
    )
    expect(exited).toMatchObject({ ok: false, failure: "exited", error: `exit 3: ••••${"x".repeat(fill)} end` })
  })

  test("a stored value's echo in Python's `json.dumps` form (`\\u00e9`) is masked; a JSON argument keeps its escapes", async () => {
    // Built from parts, so the source holds no escape: a backslash and `u00e9`.
    const escaped = "\\" + "u00e9"
    const VALUE = "FAKE-VALUE-0072-café"
    expect(McpProbe.mask(`echo {"password": "FAKE-VALUE-0072-caf${escaped}"} end`, [VALUE])).toBe(
      'echo {"password": "••••"} end',
    )
    await using r = await rig()
    const config = `{"endpoint":"https:\\/\\/h.example.test\\/caf${escaped}?key=FAKE-VALUE-0073"}`
    const saved = await ok(r.rpc["mcp.save"], {
      name: "escapes",
      scope: { type: "global" },
      transport: { type: "local", command: process.execPath, args: [FAKE_MCP_STDIO, "--config", config], env: [] },
    })
    const transport = saved.servers[0]!.transport
    expect(transport.type === "local" && transport.args).toEqual([
      FAKE_MCP_STDIO,
      "--config",
      `{"endpoint":"https:\\/\\/h.example.test\\/caf${escaped}?key=\${URL_KEY}"}`,
    ])
    const entry = (await McpStore.file(r.t.deps).read()).servers[0]!
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry, values: await McpStore.values(r.t.deps, entry) }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("escapes")).toMatchObject({
      command: [process.execPath, FAKE_MCP_STDIO, "--config", config],
    })
  })
})

describe("review round 6 (SM-28)", () => {
  test("one long name in a path and a model id stay readable in server texts; a random key is still masked", async () => {
    await using r = await rig()
    /** A fake random key of small letters and digits, as some webhooks have. */
    const HOOK = "fakek3jx9qmz7tw2vb8nr4hy6cp1ds5g"
    const values = {
      ANTHROPIC_MODEL: "claude-3-5-sonnet-20241022",
      HF_MODEL_URL: "https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct",
      DOCS_URL: "https://gitmcp.io/amusi/CVPR2024-Papers-with-Code",
      BOARD_URL: "https://dev.azure.com/Contoso/Q4PlanningWorkspace2025Final/_git/app",
      HOOK_URL: `https://hooks.example.test/hook/${HOOK}`,
    }
    const said = [
      "Using claude-3-5-sonnet-20241022 for meta-llama/Meta-Llama-3-8B-Instruct",
      "fetch_CVPR2024-Papers-with-Code_documentation",
      "Q4PlanningWorkspace2025Final",
      `hook ${values.HOOK_URL}`,
    ].join(", ")
    const saved = await ok(r.rpc["mcp.save"], {
      name: "names",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO],
        env: [
          ...Object.entries(values).map(([name, value]) => ({ name, value })),
          { name: "FAKE_MCP_FAIL", value: said },
        ],
      },
    })
    const check = await ok(r.rpc["mcp.test"], { id: saved.servers[0]!.id })
    expect(check.error).toBe(`exit 3: fake mcp: ${said.replace(HOOK, "••••")}`)
    expect(await r.file()).not.toContain(HOOK)
    // A remote server at such an address is saved as written, not as a hidden address.
    const remote = await ok(r.rpc["mcp.save"], {
      name: "cvpr",
      scope: { type: "global" },
      transport: { type: "remote", url: values.DOCS_URL, headers: [], oauth: false },
    })
    const transport = remote.servers.find((server) => server.name === "cvpr")!.transport
    expect(transport).toMatchObject({ type: "remote", url: values.DOCS_URL })
    expect(transport.type === "remote" && transport.hidden).toBeFalsy()
    expect(await r.file()).toContain("amusi/CVPR2024-Papers-with-Code")
  })

  test("a hex or GUID key behind a word-like prefix is moved out of an address and masked under a plain name", async () => {
    await using r = await rig()
    /** Fake keys whose hex letters spell words (`dapi…`, `shpat_…`, `key_<GUID>`): only the hex run marks them. */
    const HEX = "deadbeef0facade1decade2deadbeef3"
    const GUID = "deadbeef-0fad-4ace-bead-0decade0face"
    const hook = `https://hooks.example.test/hook/key_${GUID}`
    const values = { SHOP: `shpat_${HEX}`, WORKSPACE: `dapi${HEX}` }
    const said = `hook ${hook}, shop ${values.SHOP}, workspace ${values.WORKSPACE}`
    const saved = await ok(r.rpc["mcp.save"], {
      name: "prefixed",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: process.execPath,
        args: [FAKE_MCP_STDIO, hook],
        env: [
          ...Object.entries(values).map(([name, value]) => ({ name, value })),
          { name: "FAKE_MCP_FAIL", value: said },
        ],
      },
    })
    const transport = saved.servers[0]!.transport
    expect(transport.type === "local" && transport.args).toEqual([
      FAKE_MCP_STDIO,
      "https://hooks.example.test/hook/${URL_KEY}",
    ])
    expect(await r.file()).not.toMatch(/deadbeef/)
    const check = await ok(r.rpc["mcp.test"], { id: saved.servers[0]!.id })
    expect(check.error).toBe("exit 3: fake mcp: hook https://hooks.example.test/hook/••••, shop ••••, workspace ••••")
  })

  test("a server's other cut marks are cuts; at an ellipsis alone a plain number stays", () => {
    const masker = McpProbe.masker(["2024Fake0Pw-0108"])
    for (const mark of [
      "...(truncated)",
      "… [truncated]",
      "[truncated 12 chars]",
      "... (12 more characters)",
      "<truncated>",
      " (output truncated)",
      "…",
    ])
      expect(masker.head(`Example Server 2024Fa${mark}`, 300)).toBe(`Example Server ••••${mark}`)
    expect(masker.tail("[truncated]…w-0108 started", 300)).toBe("[truncated]…•••• started")
    expect(masker.tail("(output truncated) Pw-0108 started", 300)).toBe("(output truncated) •••• started")
    // A sentence may end with a number and an ellipsis; a mark that says it was cut still masks it.
    expect(masker.head("Loading 2024...", 300)).toBe("Loading 2024...")
    expect(masker.tail("…0108 started", 300)).toBe("…0108 started")
    expect(masker.head("Loading 2024 [truncated]", 300)).toBe("Loading •••• [truncated]")
    // Only a text's end is searched for the mark: a long run of spaces before it costs nothing.
    const spaced = `${"x ".repeat(50_000)}2024Fa${" ".repeat(100_000)}[TRUNCATED]`
    expect(masker.head(spaced, McpProbe.RAW).endsWith(`x ••••${" ".repeat(100_000)}[TRUNCATED]`)).toBe(true)
  })

  test("a quoted password moved out of the arguments is masked as read and as written; the server gets it as written", async () => {
    await using r = await rig()
    const args = [
      FAKE_MCP_STDIO,
      'Server=db.example.test;Password="Pa""ss-0109";User ID=fake',
      "Driver={ODBC Driver 18};Pwd={Pa}}ss-0110}",
      "host=db.example.test password='Pa\\'ss-0111'",
    ]
    const said = 'login failed: Pa"ss-0109, Pa""ss-0109, Pa}ss-0110, Pa}}ss-0110, Pa\'ss-0111, Pa\\\'ss-0111'
    const saved = await ok(r.rpc["mcp.save"], {
      name: "quoted",
      scope: { type: "global" },
      transport: { type: "local", command: process.execPath, args, env: [{ name: "FAKE_MCP_FAIL", value: said }] },
    })
    const transport = saved.servers[0]!.transport
    expect(transport.type === "local" && transport.args).toEqual([
      FAKE_MCP_STDIO,
      'Server=db.example.test;Password="${PASSWORD}";User ID=fake',
      "Driver={ODBC Driver 18};Pwd={${PWD}}",
      "host=db.example.test password='${PASSWORD_2}'",
    ])
    expect(await r.file()).not.toMatch(/ss-01(09|10|11)/)
    const check = await ok(r.rpc["mcp.test"], { id: saved.servers[0]!.id })
    expect(check.error).toBe("exit 3: fake mcp: login failed: ••••, ••••, ••••, ••••, ••••, ••••")
    const entry = (await McpStore.file(r.t.deps).read()).servers[0]!
    const fold = editor()
    McpFold.fold(
      fold.edit,
      { servers: [{ entry, values: await McpStore.values(r.t.deps, entry) }], overrides: [] },
      { directory: path.resolve("/p"), control: false },
    )
    expect(fold.servers.get("quoted")).toMatchObject({ command: [process.execPath, ...args] })
  })
})

/** A candidate's definition as the page shows it (own-web's `transportLine`). */
function transportLineOf(transport: OwnMcp.Transport) {
  if (transport.type === "local") return [transport.command, ...transport.args].join(" ")
  return transport.query ? `${transport.url}?…` : transport.url
}

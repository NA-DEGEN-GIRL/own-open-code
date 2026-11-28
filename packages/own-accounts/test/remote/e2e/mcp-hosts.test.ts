// MCP servers of this PC on an SSH host (04 §13 "MCP", MH 2026-11-26), end to end over the fake-SSH harness (no real
// host, no real package registry):
//
//   test → local OpenCode server L (own-accounts local with the broker and a memory vault; own-remote local)
//        → own.remote connect → fake ssh (Git bash plays the host)
//        → the remote service R: a real OpenCode server from source with own-accounts mode:"remote" and a fake chat
//          model of its own
//
// The PC adds a server that needs a value (a fake stdio MCP server that exits without it). The host probes what it has,
// gets the server installed without the value (off, and its test starts nothing), the user's explicit send makes the
// PC hand the value to that host over the broker (on; the test passes; the host's Location connects it), a withdrawal
// turns it off again,
// a rotated value on the PC shows as `differs` and never reaches the host by itself; the AI-assisted install runs in a
// new host conversation that alone sees the install tool, asks before it writes (묻기) and registers the server with the
// PC's key and hash, setting a value that is not a secret (a state folder) for the host itself, so it runs without the
// PC's copy. No value ever lands in the host's files, R's logs, an answer or a chat request.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { McpHost, McpHostRules, OwnAccounts } from "@own/protocol"
import * as Harness from "../../../../own-remote/test/harness/remote.js"
import {
  afterToolResult,
  deepseekProvider,
  E2E_TRANSPILER_CACHE,
  lastUserText,
  REPO_ROOT,
  opencodeConfig,
  removeTree,
  startFakeOpenAIChat,
  startOpencodeServer,
  toolOutputs,
  type FakeOpenAIChat,
  type OpencodeServer,
  type RecordedRequest,
  type Reply,
} from "../../e2e-kit"
import { FAKE_MCP_STDIO } from "../../e2e-kit/fakes/mcp-stdio"
import { recordServerEvents } from "../../e2e-kit/harness/events"

setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const SECRET = "fake-mcp-host-key-0000000000Qx7wZ"
const ROTATED = "fake-mcp-host-key-1111111111Rt9yA"
const CHAT_KEY = "fake-mcp-hosts-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")
/** The fake host is this PC: its bun and the fixture run there as they would from the host's own paths. */
const BUN = process.execPath

type Json = Record<string, any>

async function until<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs: number,
  stepMs = 250,
) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`timeout${last ? `: ${String(last)}` : ""}`)
    await Bun.sleep(stepMs)
  }
}

/** The host's chat model: `[MCP 서버 설치]` registers the fixture through the install tool, then reports one line. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "결과: 설치됨 — tiny" }
  if (lastUserText(request).includes("[MCP 서버 설치]"))
    return {
      type: "tool-call",
      name: McpHost.TOOL,
      // A value that is not a secret (a state folder), set for this host as the brief allows; the fixture needs it.
      input: {
        command: BUN,
        args: [FAKE_MCP_STDIO, "lookup", "summarize"],
        fixed: { TINY_STATE_DIR: "~/.local/state/tiny", FAKE_MCP_REQUIRE: "TINY_STATE_DIR" },
      },
    }
  return { type: "text", text: "답변" }
}

run("MCP servers of this PC on a host (fake SSH, 04 §13)", () => {
  const state = {} as {
    harness: Harness.Harness
    chat: FakeOpenAIChat
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    scratch: string
    pcServer: string
    hostServer: string
    outputs: string[]
  }
  state.outputs = []

  async function localOk(id: string, method: string, input: unknown = {}) {
    const response = await state.local.request("POST", `/api/rpc/${id}/${method}`, {
      body: { input },
      query: { "location[directory]": state.control },
      directory: state.control,
    })
    const text = await response.text()
    state.outputs.push(text)
    if (response.status !== 200) throw new Error(`${id}/${method}: ${response.status} ${text}`)
    return (JSON.parse(text) as Json).output as Json
  }
  const pc = (method: string, input: unknown = {}) => localOk(OwnAccounts.ID, method, input)
  async function remote(method: string, route: string, options: { body?: unknown; directory?: string } = {}) {
    const deadline = Date.now() + 60_000
    while (true) {
      const url = new URL(route, state.remote.url)
      const directory = options.directory ?? state.workspace
      if (route.startsWith("/api/rpc/") || route.startsWith("/api/mcp"))
        url.searchParams.set("location[directory]", directory)
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Basic ${btoa(`opencode:${state.remote.token}`)}`,
          "x-opencode-directory": encodeURIComponent(directory),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const text = await response.text()
      state.outputs.push(text)
      const body = (text ? JSON.parse(text) : undefined) as Json
      if (!route.startsWith("/api/rpc/") || body?.type !== "rpc.unavailable" || Date.now() > deadline)
        return { status: response.status, body }
      await Bun.sleep(200)
    }
  }
  /** One `own.accounts` method of the host's service, at its control Location. */
  async function host(method: string, input: unknown = {}) {
    const result = await remote("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      directory: state.remote.controlDir,
    })
    return result
  }
  async function hostOk(method: string, input: unknown = {}) {
    const result = await host(method, input)
    if (result.status !== 200) throw new Error(`host ${method}: ${result.status} ${JSON.stringify(result.body)}`)
    return result.body.output as Json
  }
  const hostServer = async () =>
    ((await hostOk("mcp.host.view")).servers as Json[]).find((item) => item.id === state.hostServer)!
  async function connect() {
    await localOk("own.remote", "connect", { hostId: state.hostId, clientId: "e2e-tab" })
    return until(
      async () => {
        const listed = await localOk("own.remote", "hosts.list")
        const view = (listed.hosts as Json[]).find((item) => item.id === state.hostId)!
        if (view.stage === "ready" || view.stage === "needs_install" || view.paused) return view
        return undefined
      },
      240_000,
      500,
    )
  }
  /** The status core gives the workspace Location's server `name` on the host. */
  async function status(name: string) {
    const listed = await remote("GET", "/api/mcp")
    const servers = (listed.body?.data ?? listed.body ?? []) as Json[]
    const found = Array.isArray(servers) ? servers.find((item) => item.name === name) : undefined
    return found?.status?.status as string | undefined
  }

  beforeAll(async () => {
    state.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
    const buildId = `e2e-mcp-hosts-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-mcp-hosts-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        hm: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(import.meta.dir, "real-service.ts")),
            OWN_E2E_CONFIG: Harness.toPosix(configFile),
          },
        },
      },
    })
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        repo: REPO_ROOT,
        buildId,
        endpoints: {},
        logs: path.join(state.harness.testRoot, "e2e-logs"),
        transpilerCache: E2E_TRANSPILER_CACHE,
        providers: { [CHAT.providerID]: deepseekProvider(state.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
      }),
    )
    state.local = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: {
                home: paths.ownHome,
                buildId,
                vault: "memory",
                endpoints: {},
                broker: { brokerWaitMs: 1_500 },
              },
            },
            {
              package: REMOTE,
              options: {
                home: paths.ownHome,
                buildId,
                version: VERSION,
                sshCommand: state.harness.sshCommand,
                askpassHelper: state.harness.askpassHelper,
                remoteBundles: state.harness.bundles,
                sshDir: state.harness.sshDir,
                keepIntervalSeconds: 1,
                readyTimeoutMs: 120_000,
                backoffMs: [60_000],
                lingerSeconds: 0,
              },
            },
          ],
        }),
    })
    state.control = path.join(state.local.paths.ownHome, "control")
    fs.mkdirSync(state.control, { recursive: true })
  }, 240_000)

  afterAll(async () => {
    const debug = process.env.OWN_E2E_DEBUG_DIR
    if (debug && state.harness) {
      fs.mkdirSync(debug, { recursive: true })
      fs.writeFileSync(path.join(debug, "local-server.log"), state.local?.logs() ?? "")
      const logs = path.join(state.harness.testRoot, "e2e-logs")
      if (fs.existsSync(logs)) fs.cpSync(logs, path.join(debug, "remote"), { recursive: true })
    }
    await state.local?.stop()
    await state.harness?.cleanup()
    await state.chat?.stop()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("the host is ready and probes what it has; the PC's records are refused there", async () => {
    // The PC's server: the fixture, which exits unless its value is set.
    const saved = await pc("mcp.save", {
      name: "tiny",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: BUN,
        args: [FAKE_MCP_STDIO, "lookup"],
        env: [{ name: "API_KEY", value: SECRET }],
      },
    })
    state.pcServer = (saved.servers as Json[])[0]!.id
    const added = await localOk("own.remote", "hosts.add", { alias: "hm" })
    state.hostId = added.host.id
    expect((await connect()).stage).toBe("needs_install")
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("hm"), "work")
    fs.mkdirSync(state.workspace, { recursive: true })
    await until(
      async () => {
        const listed = await localOk("own.remote", "hosts.list")
        return (listed.hosts as Json[]).find((item) => item.id === state.hostId)?.broker?.state === "connected"
      },
      120_000,
      500,
    )

    const probe = await hostOk("mcp.host.probe", { binaries: ["bun", "surely-not-here-xyz"] })
    expect(probe.home).toBeTruthy()
    expect(probe.binaries).toEqual({ bun: true, "surely-not-here-xyz": false })
    expect(probe.ownBun?.command).toBeTruthy()
    expect(JSON.stringify((await host("mcp.hosts.view")).body)).toContain("remote_managed")
    expect(JSON.stringify(await pc("mcp.hosts.view"))).toBe('{"sends":[]}')
  }, 600_000)

  test("auto install: off without its value; the user's send makes it run; a withdrawal turns it off", async () => {
    const source: McpHostRules.Source = {
      key: `own:${state.pcServer}`,
      name: "tiny",
      origin: "own",
      transport: { type: "local", command: BUN, args: [FAKE_MCP_STDIO, "lookup"], env: ["API_KEY"] },
    }
    const installed = await hostOk("mcp.host.save", {
      name: "tiny",
      transport: {
        type: "local",
        command: BUN,
        args: [FAKE_MCP_STDIO, "lookup"],
        env: ["API_KEY"],
        fixed: { FAKE_MCP_REQUIRE: "API_KEY" },
      },
      pc: { key: source.key, hash: McpHostRules.hash(source), at: Date.now() },
    })
    state.hostServer = (installed.servers as Json[]).find((item) => item.name === "tiny")!.id
    expect((await hostServer()).values).toBe("missing")
    // The host keeps it off, so its connection test starts nothing either (it once ran it without the value).
    const without = await host("mcp.host.test", { id: state.hostServer })
    expect(without.status).not.toBe(200)
    expect(JSON.stringify(without.body)).toContain("mcp_secret_missing")
    // Off in the host's Locations until the value comes.
    await until(async () => (await status("tiny")) === "disabled", 120_000, 500)

    await pc("mcp.hosts.send", {
      hostId: state.hostId,
      server: state.hostServer,
      source: { type: "own", id: state.pcServer },
      names: ["API_KEY"],
    })
    await until(async () => (await hostServer()).values === "ready", 60_000, 500)
    // RL34: the host tells its open pages (own-web's host card reads `mcp.host.view` again on it), also for a test run
    // in a conversation's Location, as `AI에게 설치 맡기기`'s tool runs it: a remote service dropped this global event
    // like the PC's copies, and only the leader sends one, so a card read before such a test kept `아직 … 시험을 하지
    // 않았어요`.
    const events = await recordServerEvents({
      url: state.remote.url,
      authorization: `Basic ${btoa(`opencode:${state.remote.token}`)}`,
    })
    try {
      fs.mkdirSync(state.workspace, { recursive: true })
      const tested = await remote("POST", `/api/rpc/${OwnAccounts.ID}/mcp.host.test`, {
        body: { input: { id: state.hostServer } },
        directory: state.workspace,
      })
      expect(tested.status).toBe(200)
      expect(tested.body.output).toMatchObject({ ok: true, tools: [{ name: "lookup" }] })
      await events.waitFor((event) => event.type === "rpc.own.accounts.mcp.changed", 30_000)
    } finally {
      await events.close()
    }
    await until(async () => (await status("tiny")) === "connected", 120_000, 500)

    await pc("mcp.hosts.unsend", { hostId: state.hostId, server: state.hostServer })
    await until(async () => (await hostServer()).values === "missing", 60_000, 500)
    await until(async () => (await status("tiny")) === "disabled", 120_000, 500)
  }, 600_000)

  test("sync: a PC change shows on the PC, and the host keeps what it was given until the user updates it", async () => {
    await pc("mcp.hosts.send", {
      hostId: state.hostId,
      server: state.hostServer,
      source: { type: "own", id: state.pcServer },
      names: ["API_KEY"],
    })
    await until(async () => (await hostServer()).values === "ready", 60_000, 500)
    const before = (await hostServer()).pc.hash as string
    await pc("mcp.save", {
      id: state.pcServer,
      name: "tiny",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: BUN,
        args: [FAKE_MCP_STDIO, "lookup", "summarize"],
        env: [{ name: "API_KEY", value: ROTATED }],
      },
    })
    const now = McpHostRules.hash({
      name: "tiny",
      transport: { type: "local", command: BUN, args: [FAKE_MCP_STDIO, "lookup", "summarize"], env: ["API_KEY"] },
    })
    expect(now).not.toBe(before)
    expect((await hostServer()).pc.hash).toBe(before)
    expect(((await pc("mcp.hosts.view", { hostId: state.hostId })).sends as Json[])[0]).toMatchObject({ differs: true })
    // The host still runs with what was sent.
    expect(await hostOk("mcp.host.test", { id: state.hostServer })).toMatchObject({ ok: true })
    // One click: the definition and the value again.
    await hostOk("mcp.host.save", {
      id: state.hostServer,
      name: "tiny",
      transport: {
        type: "local",
        command: BUN,
        args: [FAKE_MCP_STDIO, "lookup", "summarize"],
        env: ["API_KEY"],
        fixed: { FAKE_MCP_REQUIRE: "API_KEY" },
      },
      pc: { key: `own:${state.pcServer}`, hash: now, at: Date.now() },
    })
    await pc("mcp.hosts.send", {
      hostId: state.hostId,
      server: state.hostServer,
      source: { type: "own", id: state.pcServer },
      names: ["API_KEY"],
    })
    expect(((await pc("mcp.hosts.view", { hostId: state.hostId })).sends as Json[])[0]!.differs).toBeUndefined()
    expect((await hostServer()).pc.hash).toBe(now)
    expect((await hostOk("mcp.host.test", { id: state.hostServer })).tools).toHaveLength(2)
    expect(await hostOk("mcp.host.remove", { id: state.hostServer })).toMatchObject({ servers: [] })
  }, 600_000)

  test("AI-assisted install: a new conversation alone sees the tool, asks first, and registers with the PC's key", async () => {
    const source: McpHostRules.Source = {
      key: `own:${state.pcServer}`,
      name: "tiny",
      origin: "own",
      transport: { type: "local", command: "bun", args: ["C:\\work\\tiny-mcp.ts"], env: ["TINY_STATE_DIR"] },
    }
    const probe = (await hostOk("mcp.host.probe", {})) as McpHostRules.Probe
    const analysis = McpHostRules.analyze(source, { home: "C:\\Users\\demo", probe })
    expect(analysis.result).toBe("assist")
    const brief = McpHostRules.brief({
      locale: "ko",
      host: "hm",
      source,
      analysis,
      probe,
      shown: "bun C:\\work\\tiny-mcp.ts",
      tool: McpHost.TOOL,
    })
    const job: McpHost.Job = { key: source.key, hash: McpHostRules.hash(source), name: "tiny", env: ["TINY_STATE_DIR"] }
    expect(brief).toContain("TINY_STATE_DIR (비밀 아님: 이 호스트에 맞게 정해도 됨)")

    // An ordinary conversation never sees the tool.
    const plain = await remote("POST", "/api/session", {
      body: { title: "plain", model: CHAT, location: { directory: state.workspace } },
    })
    const fromPlain = state.chat.requests.length
    await remote("POST", `/api/session/${plain.body.data.id}/prompt`, { body: { text: "안녕" } })
    await remote("POST", `/api/experimental/session/${plain.body.data.id}/wait`)
    expect(
      state.chat.requests
        .slice(fromPlain)
        .map((request) => request.body)
        .join("\n"),
    ).not.toContain(McpHost.TOOL)

    const created = await remote("POST", "/api/session", {
      body: {
        title: "MCP 설치",
        model: CHAT,
        location: { directory: state.workspace },
        metadata: { own: { mcpInstall: job } },
        permissions: [{ action: McpHost.TOOL, resource: "*", effect: "allow" }],
      },
    })
    expect(created.status).toBe(200)
    const sessionID = created.body.data.id as string
    // 묻기: the write asks the user first.
    const approval = await host("session.approval.set", { sessionID, mode: "ask" })
    expect(approval.status).toBe(200)
    const from = state.chat.requests.length
    await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text: brief } })
    const asked = await until(
      async () => {
        const listed = await remote("GET", `/api/session/${sessionID}/permission`)
        return ((listed.body?.data ?? []) as Json[]).find((item) => item.action === McpHost.TOOL)
      },
      120_000,
      250,
    )
    expect(asked.resources).toEqual(["tiny"])
    expect(((await hostOk("mcp.host.view")).servers as Json[]).some((item) => item.name === "tiny")).toBe(false)
    await remote("POST", `/api/session/${sessionID}/permission/${String(asked.id)}/reply`, {
      body: { decision: "once" },
    })
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const requests = state.chat.requests.slice(from)
    expect(requests[0]!.body).toContain(McpHost.TOOL)
    expect(toolOutputs(requests.at(-1)!).join("\n")).toContain('Registered "tiny"')
    const registered = ((await hostOk("mcp.host.view")).servers as Json[]).find((item) => item.name === "tiny")!
    // Set on the host, not waiting for the PC: on, and its test is of what the host runs.
    expect(registered).toMatchObject({
      pc: { key: job.key, hash: job.hash },
      check: { ok: true },
      values: "none",
      transport: { env: [], fixed: { TINY_STATE_DIR: expect.stringContaining(".local/state/tiny") } },
    })
    expect(registered.transport.fixed.TINY_STATE_DIR).not.toStartWith("~")
    // The card names where it is registered: the host's own list, not an OpenCode config file.
    expect((await hostOk("mcp.host.view")).file).toEndWith("mcp.json")

    // What a host conversation loads (2.4.1-own.5: the card said connected while a host conversation's catalog had no
    // llm-router): the folder's Location, open since the first test, connects it, and a conversation created after the
    // install offers its tools to the model.
    await until(async () => (await status("tiny")) === "connected", 120_000, 500)
    const after = await remote("POST", "/api/session", {
      body: { title: "after", model: CHAT, location: { directory: state.workspace } },
    })
    const fromAfter = state.chat.requests.length
    await remote("POST", `/api/session/${after.body.data.id}/prompt`, { body: { text: "안녕" } })
    await remote("POST", `/api/experimental/session/${after.body.data.id}/wait`)
    const offered = state.chat.requests
      .slice(fromAfter)
      .map((request) => request.body)
      .join("\n")
    expect(offered).toContain("summarize")
    expect(offered).not.toContain(McpHost.TOOL)
  }, 600_000)

  test("secret hygiene: no value on the host, in any answer, in R's logs or a chat request", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile() && !file.endsWith(".db-shm") && entry.name !== "service.lock") {
          const bytes = fs.readFileSync(file)
          if (bytes.includes(SECRET) || bytes.includes(ROTATED)) hits.push(file)
        }
      }
    }
    walk(state.harness.hostHome("hm"))
    walk(path.join(state.harness.testRoot, "e2e-logs"))
    expect(hits).toEqual([])
    for (const output of state.outputs) for (const value of [SECRET, ROTATED]) expect(output).not.toContain(value)
    for (const value of [SECRET, ROTATED]) expect(state.local.logs()).not.toContain(value)
    for (const request of state.chat.requests)
      for (const value of [SECRET, ROTATED]) expect(request.body).not.toContain(value)
  }, 60_000)
})

// The Claude Agent route on SSH hosts (02 §8.10.13, CAG-R): the host's side of own-accounts (the mirror's accounts by
// relay token, the fold, bindings and the host's own default, the requests' folder token) and the broker's stream
// pieces on both sides (the PC's account check and session drop, the host's transport). Fake peers and a fake core
// server; the end-to-end path is test/remote/e2e/claude-agent-relay.test.ts.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Account, Broker, ClaudeAgent as Route, Kv, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { BrokerClaudeAgent } from "../../src/broker/claude-agent.js"
import { ClaudeAgent } from "../../src/claude-agent/agent.js"
import type { Modules } from "../../src/modules.js"
import type { Module } from "../../src/module.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { RemoteClaudeAgent } from "../../src/remote/claude-agent.js"
import { Logger } from "../../src/logger.js"
import { testDeps } from "../support/deps.js"
import { ok } from "../plugins/support.js"

const ONE = Account.ID.make("acc_01JRELAYUNITONE0000000000")
const TWO = Account.ID.make("acc_01JRELAYUNITTWO0000000000")
const sid = (id: string) => SessionID.make(id)

function offer(accounts: ReadonlyArray<{ accountID: Account.ID; default: boolean }>): Broker.ClaudeAgentRemote {
  return {
    accounts: accounts.map((item, index) => ({
      accountID: item.accountID,
      label: `PC ${index + 1}`,
      shortLabel: `CA${index + 1}`,
      color: "orange",
      default: item.default,
      loggedIn: true,
    })),
  }
}

async function host(mirrored: { value: Broker.ClaudeAgentRemote | undefined }) {
  const storage = new Map<string, unknown>()
  const connects: unknown[] = []
  const test = await testDeps({
    control: true,
    ctx: {
      integration: {
        connection: { active: async () => (connects.length > 0 ? { id: "c1" } : undefined) },
        connect: { external: async (input: unknown) => void connects.push(input) },
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => void storage.set(key, value),
        scan: async (input: { readonly prefix: string }) => ({
          entries: [...storage.entries()]
            .filter((item) => item[0].startsWith(input.prefix))
            .map((item) => ({ key: item[0], value: item[1] })),
        }),
      },
      session: { get: async () => undefined },
    },
  })
  const remote = { claudeAgent: () => mirrored.value } as unknown as RemoteHost.Api
  const deps = { ...test.deps, remote }
  const registry = Store.emptyRegistry() as Registry.File
  const peers: Module.Peers = () =>
    ({
      slots: {
        snapshot: () => registry,
        mutate: async () => {
          throw new Error("a host never writes the PC's registry")
        },
        reload: async () => {},
      },
      telemetry: { alert: () => {} },
    }) as unknown as Modules.All
  const channel: ClaudeAgent.Channel = { version: 1, listeners: new Set() }
  const agent = ClaudeAgent.make(deps, peers, { channel: () => channel })
  return {
    agent,
    storage,
    connects,
    async [Symbol.asyncDispose]() {
      await agent.stop()
      await test[Symbol.asyncDispose]()
    },
  }
}

function fold(agent: ClaudeAgent.Api) {
  const provider: { activation?: string; settings?: Record<string, unknown> } = {
    activation: "auto",
    settings: { configDir: "C:/by/hand" },
  }
  const editor = {
    get: () => ({ models: new Map() }),
    update: (_id: string, change: (value: typeof provider) => void) => change(provider),
  } as unknown as ProviderEditor
  agent.fold(editor)
  return provider
}

describe("a host's Claude Agent accounts are the PC's, named by relay tokens (02 §8.10.13)", () => {
  test("the relay token is core's", async () => {
    const { ClaudeRelay } = await import("../../../core/src/plugin/provider/claude-agent/claude/relay.ts")
    expect(Route.RELAY_PREFIX).toBe(ClaudeRelay.TOKEN_PREFIX)
    expect(Route.relayToken(ONE)).toBe(ClaudeRelay.token(ONE))
    expect(Route.relayAccount(ClaudeRelay.token(ONE))).toBe(ONE)
  })

  test("without the mirror's accounts the route is off; with them the provider runs on the default's token", async () => {
    const mirrored = { value: undefined as Broker.ClaudeAgentRemote | undefined }
    await using w = await host(mirrored)
    await w.agent.start()
    expect(fold(w.agent)).toEqual({ activation: "disabled", settings: {} })
    expect(w.connects).toEqual([])
    mirrored.value = offer([
      { accountID: ONE, default: false },
      { accountID: TWO, default: true },
    ])
    expect(fold(w.agent)).toEqual({ activation: "enabled", settings: { configDir: Route.relayToken(TWO) } })
    // A request names the tree's account by its token, never a folder of either machine.
    const event = { sessionID: "ses_a", model: { providerID: "claude-agent" }, options: {} as Record<string, unknown> }
    await w.agent.onRequest(event)
    expect(event.options.configDir).toBe(Route.relayToken(TWO))
    expect(w.storage.get(Kv.claudeAgentSession("ses_a"))).toMatchObject({ accountID: TWO })
    // The host's own views stay empty: own-web lists this PC's accounts for a host (04 §12.6).
    expect(w.agent.views({ windows: () => [], summary: () => ({ state: "unknown" }) as never })).toEqual([])
  })

  test("an account's own auto-compaction setting reaches the host with the mirror (CAG-50, merge round 11)", async () => {
    const offered = offer([
      { accountID: ONE, default: true },
      { accountID: TWO, default: false },
    ])
    const mirrored = {
      value: {
        accounts: offered.accounts.map((item) =>
          item.accountID === TWO ? { ...item, compaction: { triggerPercent: 40 } } : item,
        ),
      } as Broker.ClaudeAgentRemote | undefined,
    }
    await using w = await host(mirrored)
    await w.agent.start()
    // slots.ts reads the account's setting through `entry`, the mirror's here; without one the kind default applies.
    expect(w.agent.entry(TWO)?.compaction).toEqual({ triggerPercent: 40 })
    expect(w.agent.entry(ONE)?.compaction).toBeUndefined()
    expect(w.agent.entry(TWO)?.label).toBe("PC 2")
  })

  test("this PC offers an account's own auto-compaction setting to a host (CAG-50, merge round 11)", async () => {
    await using t = await testDeps({ control: true })
    const registry = {
      ...(Store.emptyRegistry() as Registry.File),
      claudeAgents: [
        { accountID: ONE, configDir: "C:/a/one", label: null, shortLabel: "CA1", color: "orange" as const, addedAt: "2026-11-01T00:00:00.000Z" },
        {
          accountID: TWO,
          configDir: "C:/a/two",
          label: "둘",
          shortLabel: "CA2",
          color: "orange" as const,
          addedAt: "2026-11-01T00:00:00.000Z",
          compaction: { triggerPercent: 40 },
        },
      ],
    }
    const peers: Module.Peers = () =>
      ({ slots: { snapshot: () => registry }, telemetry: { alert: () => {} } }) as unknown as Modules.All
    const agent = ClaudeAgent.make(t.deps, peers, { channel: () => ({ version: 1, listeners: new Set() }) })
    const offered = agent.offer({ mode: "all" })?.accounts ?? []
    expect(offered.map((item) => [item.accountID, item.compaction])).toEqual([
      [ONE, undefined],
      [TWO, { triggerPercent: 40 }],
    ])
    // The mirror's schema keeps it.
    expect(Schema.decodeUnknownSync(Broker.ClaudeAgentRemote)({ accounts: offered }).accounts[1]?.compaction).toEqual({
      triggerPercent: 40,
    })
  })

  test("the host's switcher moves a tree and sets the host's own default; a gone account refuses", async () => {
    const mirrored = { value: offer([{ accountID: ONE, default: true }, { accountID: TWO, default: false }]) as Broker.ClaudeAgentRemote | undefined }
    await using w = await host(mirrored)
    await w.agent.start()
    const event = { sessionID: "ses_b", model: { providerID: "claude-agent" }, options: {} as Record<string, unknown> }
    await w.agent.onRequest(event)
    expect(event.options.configDir).toBe(Route.relayToken(ONE))
    expect(await ok(w.agent.sessionSet, { sessionID: sid("ses_b"), accountID: TWO })).toMatchObject({ accountID: TWO })
    expect(w.storage.get(Kv.CLAUDE_AGENT_HOST_DEFAULT)).toBe(TWO)
    expect(await ok(w.agent.sessionGet, { sessionID: sid("ses_b") })).toEqual({ accountID: TWO, bound: true })
    // A new tree starts on the host's default now.
    const fresh = { sessionID: "ses_c", model: { providerID: "claude-agent" }, options: {} as Record<string, unknown> }
    w.agent.onEvent?.({ type: "session.execution.succeeded", data: { sessionID: "ses_b" } } as never, { local: true })
    await w.agent.onRequest(fresh)
    expect(fresh.options.configDir).toBe(Route.relayToken(TWO))
    // The PC took TWO out of the host's scope: its tree is refused, never moved to another account here.
    mirrored.value = offer([{ accountID: ONE, default: true }])
    const refused = { sessionID: "ses_b", model: { providerID: "claude-agent" }, options: {} as Record<string, unknown> }
    w.agent.onEvent?.({ type: "session.execution.succeeded", data: { sessionID: "ses_b" } } as never, { local: true })
    await expect(w.agent.onRequest(refused)).rejects.toThrow("원격 호스트에서 쓸 수 없어요")
  })
})

describe("the PC's side of the streams (BrokerClaudeAgent)", () => {
  function fakeServer() {
    const opened: Array<{ input: unknown; closed: boolean }> = []
    const server: Route.HostServer = {
      open: async (input) => {
        const entry = { input, closed: false }
        opened.push(entry)
        const listeners = { data: [] as Array<(data: string) => void>, exit: [] as Array<(code: number | null) => void> }
        return {
          start: () => {},
          write: (data) => listeners.data.forEach((listener) => listener(`echo:${data}`)),
          end: () => {},
          close: () => {
            entry.closed = true
            listeners.exit.forEach((listener) => listener(null))
          },
          onData: (listener) => void listeners.data.push(listener),
          onExit: (listener) => void listeners.exit.push(listener),
        }
      },
      callStream: () => {
        throw new Error("no calls here")
      },
    }
    return { server, opened }
  }

  test("an account outside the host's scope is refused; a stream's text goes back; a dropped session closes them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-ca-relay-pc-"))
    const fake = fakeServer()
    const relay = BrokerClaudeAgent.make({
      log: Logger.silent,
      server: () => fake.server,
      folder: async (accountID, scope) => {
        if (scope.mode === "only" && !scope.ids.includes(accountID)) throw new Error("범위 밖이에요")
        return path.join(root, "accounts", accountID)
      },
      root: path.join(root, "hosts"),
    })
    const pushes: Array<{ event: string; data: any }> = []
    const push = (event: Broker.PushEvent, data: unknown) => void pushes.push({ event, data })
    const refused = await relay.open(
      "h1",
      { mode: "only", ids: [] },
      { stream: "s0", kind: "process", accountID: ONE, directory: "/home/u/p", side: false },
      push,
    )
    expect(refused).toEqual({ refused: "account", message: "범위 밖이에요" })
    const opened = await relay.open(
      "h1",
      { mode: "all" },
      { stream: "s1", kind: "process", accountID: ONE, directory: "/home/u/p", sessionID: "ses_x", side: false },
      push,
    )
    expect(opened).toEqual({ opened: true })
    expect(fake.opened[0]!.input).toMatchObject({
      configDir: path.join(root, "accounts", ONE),
      member: { sessionID: "ses_x", side: false },
    })
    // The PC's working folder for this host folder, under the hosts root, never the host's path.
    const directory = (fake.opened[0]!.input as { directory: string }).directory
    expect(directory.startsWith(path.join(root, "hosts", "h1"))).toBe(true)
    expect(fs.existsSync(directory)).toBe(true)
    expect(relay.write("h1", { stream: "s1", data: "hello" })).toBe(true)
    expect(pushes).toContainEqual({ event: "claudeAgent.data", data: { stream: "s1", data: "echo:hello" } })
    expect(relay.write("h2", { stream: "s1", data: "other host" })).toBe(false)
    relay.drop("h1")
    expect(fake.opened[0]!.closed).toBe(true)
    expect(pushes.at(-1)).toEqual({ event: "claudeAgent.exit", data: { stream: "s1", code: null } })
    expect(relay.count("h1")).toBe(0)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe("the host's side of the streams (RemoteClaudeAgent)", () => {
  function fakeBroker(answers: Record<string, unknown>) {
    const requests: Array<{ method: string; params: any }> = []
    const state = { normal: true }
    const relay = RemoteClaudeAgent.make({
      request: async (method, params) => {
        requests.push({ method, params })
        const answer = answers[method]
        return answer === undefined ? { ok: true, result: { ok: true } } : { ok: true, result: answer }
      },
      normal: () => state.normal,
      wait: async () => state.normal,
      log: Logger.silent,
    })
    return { relay, requests, state }
  }

  test("a stream opens with the account of the token, keeps text that came early, and ends with the session", async () => {
    const broker = fakeBroker({ "claudeAgent.open": { opened: true } })
    const stream = await broker.relay.transport.open({
      kind: "process",
      configDir: Route.relayToken(ONE),
      directory: "/home/u/p",
      member: { sessionID: "ses_y", side: false },
    })
    const id = broker.requests[0]!.params.stream as string
    expect(broker.requests[0]).toMatchObject({
      method: "claudeAgent.open",
      params: { kind: "process", accountID: ONE, directory: "/home/u/p", sessionID: "ses_y", side: false },
    })
    broker.relay.push({ type: "push", event: "claudeAgent.data", data: { stream: id, data: "early" } })
    const seen: string[] = []
    stream.onData((data) => seen.push(data))
    expect(seen).toEqual(["early"])
    stream.start({ args: ["--verbose"], env: {} })
    stream.write("x".repeat(Broker.CLAUDE_AGENT_CHUNK + 5))
    await Bun.sleep(0)
    const writes = broker.requests.filter((item) => item.method === "claudeAgent.write")
    expect(writes.map((item) => item.params.data.length)).toEqual([Broker.CLAUDE_AGENT_CHUNK, 5])
    const exits: Array<number | null> = []
    stream.onExit((code) => exits.push(code))
    broker.relay.drop()
    expect(exits).toEqual([1])
    // A listener that comes after the end still hears it.
    stream.onExit((code) => exits.push(code))
    expect(exits).toEqual([1, 1])
  })

  test("a refused open fails with the PC's message; no broker session fails at once", async () => {
    const broker = fakeBroker({ "claudeAgent.open": { refused: "account", message: "이 호스트가 쓸 수 있는 계정이 아니에요" } })
    await expect(
      broker.relay.transport.open({ kind: "call", configDir: Route.relayToken(ONE), directory: "", op: "list" }),
    ).rejects.toThrow("이 호스트가 쓸 수 있는 계정이 아니에요")
    broker.state.normal = false
    await expect(
      broker.relay.transport.open({ kind: "call", configDir: Route.relayToken(ONE), directory: "", op: "list" }),
    ).rejects.toThrow("PC에 연결되어 있지 않아")
  })
})

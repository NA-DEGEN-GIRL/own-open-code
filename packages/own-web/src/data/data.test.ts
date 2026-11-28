// Data layer units with an in-memory transport: RPC routing and scopes (own.accounts, own.import), event parsing and
// de-duplication, own.import session metadata, coalescing, SWR session index. The real-server path is covered by
// data.e2e.test.ts.
import { describe, expect, test } from "bun:test"
import type { JsonValue, OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { Account, OwnAccounts } from "@own/protocol"
import { OwnImport } from "@own/protocol/rpc-import"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { createData } from "@opencode/client/solid"
import { createRoot, createSignal } from "solid-js"
import type { OwnHost } from "@/host"
import { createEventBus } from "./events"
import { createFrameBatcher, createKeyedCoalescer } from "./frame"
import {
  createImportRpc,
  IMPORT_EVENT_PREFIX,
  IMPORT_ID,
  IMPORT_META,
  IMPORT_SCOPE,
  importEvent,
  importOrigin,
  isImportHelper,
  type ImportMethod,
} from "./import-rpc"
import { createDataLayer } from "./index"
import { createOwnStore } from "./own-store"
import { ALL_SCOPES, createOwnRpc, ownEvent, OwnRpcError, type OwnScope } from "./rpc"
import { staleSkillsOnSwitch } from "./server"
import { createMemoryCache } from "./session-cache"
import { createSessionIndex } from "./session-index"

interface Call {
  readonly rpcID: string
  readonly method: string
  readonly directory: string | undefined
  readonly input: unknown
}

/**
 * Records RPC calls and answers from a table (a function answers when its promise settles); session and project APIs
 * return fixed data.
 */
function transport(answers: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const client = {
    rpc: {
      call: async (input: { rpcID: string; method: string; location?: { directory?: string }; input?: unknown }) => {
        calls.push({
          rpcID: input.rpcID,
          method: input.method,
          directory: input.location?.directory,
          input: input.input,
        })
        const entry = answers[input.method]
        const answer = typeof entry === "function" ? await entry() : entry
        if (answer instanceof Error) throw answer
        return { output: answer ?? {} }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => session(sessionID, "D:\\work\\a"),
      list: async () => ({
        data: [session("ses_b", "D:\\work\\a", 200), session("ses_a", "D:\\work\\a", 100)],
        cursor: {},
      }),
      compact: async () => ({}),
    },
    project: { list: async () => [{ id: "prj_a", canonical: "D:\\work\\a", time: {}, sandboxes: [] }] },
  }
  // SAFETY: the tests only reach the members defined above.
  return { calls, client: client as unknown as OpenCodeClient }
}

function session(id: string, directory: string, updated = 1) {
  return {
    id,
    projectID: "prj_a",
    title: `title ${id}`,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated },
    location: { directory },
  }
}

function ownFrame(name: string, data: Record<string, unknown>, directory = "D:\\ctl"): OpenCodeEvent {
  // SAFETY: shaped like `V2EventRpc`, the variant the server sends for plugin RPC events.
  return {
    id: `evt_${Math.random()}`,
    created: Date.now(),
    type: `rpc.own.accounts.${name}`,
    location: { directory },
    data,
  } as OpenCodeEvent
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 80))

describe("own.accounts RPC routing (02 §9.1)", () => {
  test("global methods go to the control location, session methods to the session's directory", async () => {
    const { calls, client } = transport()
    const rpc = createOwnRpc({
      client: () => client,
      routing: {
        control: async () => "C:\\own\\control",
        sessionDirectory: (id) => (id === "ses_1" ? "D:\\p" : undefined),
      },
      scopes: () => ALL_SCOPES,
    })
    await rpc.call("accounts.list", {})
    await rpc.call("cache.state", { sessionID: "ses_1" })
    await rpc.call("session.binding", { sessionIDs: ["ses_1"] }, { directory: "D:\\p" })
    expect(calls.map((call) => [call.method, call.directory])).toEqual([
      ["accounts.list", "C:\\own\\control"],
      ["cache.state", "D:\\p"],
      ["session.binding", "D:\\p"],
    ])
    await expect(rpc.call("switch.state", { sessionID: "ses_unknown" })).rejects.toMatchObject({
      type: "own.location_unknown",
    })
  })

  test("a gateway device without `local` cannot call local methods; the gate uses MethodScope", async () => {
    const { calls, client } = transport()
    const scopes: ReadonlySet<OwnScope> = new Set(["read", "switch"])
    const rpc = createOwnRpc({
      client: () => client,
      routing: { control: async () => "C:\\ctl", sessionDirectory: () => "D:\\p" },
      scopes: () => scopes,
    })
    expect(rpc.allowed("accounts.list")).toBe(true)
    expect(rpc.allowed("accounts.add.key")).toBe(false)
    expect(rpc.allowed("policy.set")).toBe(false)
    expect(rpc.can("prompt")).toBe(false)
    await expect(rpc.call("accounts.add.key", { kind: "oai", label: "x", key: "fake" })).rejects.toBeInstanceOf(
      OwnRpcError,
    )
    expect(calls).toEqual([])
    const scoped = Object.keys(OwnAccounts.MethodScope) as OwnAccounts.MethodName[]
    expect(scoped.every((method) => rpc.scope(method) === OwnAccounts.MethodScope[method])).toBe(true)
  })

  test("server RPC errors become OwnRpcError with type and data", async () => {
    const error = Object.assign(new Error("slot"), { _tag: "RpcError", type: "slot_misconfigured", data: { x: 1 } })
    const { client } = transport({ "switch.apply": error })
    const rpc = createOwnRpc({
      client: () => client,
      routing: { control: async () => "C:\\ctl", sessionDirectory: () => "D:\\p" },
      scopes: () => ALL_SCOPES,
    })
    const call = rpc.call("switch.apply", {
      sessionID: "ses_1",
      target: { providerID: "own-oai-abcd", id: "m" },
      strategy: "now",
      reason: "manual",
    })
    await expect(call).rejects.toMatchObject({ type: "slot_misconfigured", data: { x: 1 } })
  })

  test("a session Location still loading own.accounts is asked again; a global method is not (upstream #63814)", async () => {
    const unavailable = () =>
      Object.assign(new Error("RPC is unavailable"), { _tag: "RpcError", type: "rpc.unavailable" })
    const left = { approval: 2 }
    const { calls, client } = transport({
      "session.approval.set": async () => (left.approval-- > 0 ? unavailable() : { mode: "ask" }),
      "accounts.list": unavailable(),
    })
    const rpc = createOwnRpc({
      client: () => client,
      routing: { control: async () => "C:/ctl", sessionDirectory: () => "D:/p" },
      scopes: () => ALL_SCOPES,
    })
    await rpc.call("session.approval.set", { sessionID: "ses_1", mode: "ask" })
    expect(calls.filter((call) => call.method === "session.approval.set")).toHaveLength(3)
    await expect(rpc.call("accounts.list", {})).rejects.toMatchObject({ type: "rpc.unavailable" })
    expect(calls.filter((call) => call.method === "accounts.list")).toHaveLength(1)
    // A Location that never registers it fails once its time is up.
    const never = createOwnRpc({
      client: () => transport({ "session.approval.set": unavailable() }).client,
      routing: { control: async () => "C:/ctl", sessionDirectory: () => "D:/p" },
      scopes: () => ALL_SCOPES,
      bootingMs: 300,
    })
    await expect(never.call("session.approval.set", { sessionID: "ses_1", mode: "ask" })).rejects.toMatchObject({
      type: "rpc.unavailable",
    })
  })

  test("ownEvent parses declared events only", () => {
    expect(ownEvent(ownFrame("quota.updated", { eventId: "e1" }))).toMatchObject({
      name: "quota.updated",
      directory: "D:\\ctl",
    })
    expect(ownEvent(ownFrame("not.declared", {}))).toBeUndefined()
  })
})

describe("own.import client (09 §5)", () => {
  const methods = Object.keys(OwnImportRouting.MethodScope) as ImportMethod[]
  const ref = { kind: "codex", rootID: "codex-default", id: "t1" }

  test("the id, the scope table, the method list and the metadata key are the protocol's", () => {
    expect(IMPORT_ID).toBe(OwnImport.ID)
    expect(IMPORT_SCOPE).toEqual(OwnImport.MethodScope)
    expect<string[]>([...methods].sort()).toEqual(Object.keys(OwnImport.Definition.methods).sort())
    expect(IMPORT_META).toEqual({ session: OwnImport.META_KEY })
  })

  test("every method goes to the control location under own.import; RPC errors become OwnRpcError", async () => {
    const fail = Object.assign(new Error("gone"), { _tag: "RpcError", type: "source_not_found", data: { ref } })
    const { calls, client } = transport({ "sessions.read": fail })
    const rpc = createImportRpc({
      client: () => client,
      control: async () => "C:\\own\\control",
      scopes: () => ALL_SCOPES,
    })
    const others = methods.filter((method) => method !== "sessions.read")
    expect(methods.every((method) => OwnImportRouting.MethodLocation[method] === "control")).toBe(true)
    // SAFETY: the fake transport ignores the input; only routing is checked here.
    for (const method of others) await rpc.call(method, {} as never)
    expect(calls.map((call) => call.method)).toEqual(others)
    expect(calls.every((call) => call.rpcID === "own.import" && call.directory === "C:\\own\\control")).toBe(true)

    // SAFETY: the fake transport does not decode the ref.
    const read = rpc.call("sessions.read", { ref: ref as never, directory: "C:\\own\\app" })
    await expect(read).rejects.toBeInstanceOf(OwnRpcError)
    await expect(read).rejects.toMatchObject({ type: "source_not_found", data: { ref } })
    const offline = transport({ health: new TypeError("Failed to fetch") })
    const unreachable = createImportRpc({
      client: () => offline.client,
      control: async () => "C:\\ctl",
      scopes: () => ALL_SCOPES,
    })
    await expect(unreachable.call("health", {})).rejects.toBeInstanceOf(TypeError)
  })

  test("a gateway device without `local` sees only the methods its scopes cover; refused calls send nothing", async () => {
    const { calls, client } = transport()
    const scopes: ReadonlySet<OwnScope> = new Set(["read", "prompt"])
    const rpc = createImportRpc({ client: () => client, control: async () => "C:\\ctl", scopes: () => scopes })
    // Table-driven: I2 opens more methods to devices (09 §5.5), so no method list is spelled here.
    for (const method of methods) {
      expect(rpc.scope(method)).toBe(OwnImportRouting.MethodScope[method])
      expect(rpc.allowed(method)).toBe(scopes.has(OwnImportRouting.MethodScope[method]))
    }
    expect(rpc.allowed("health")).toBe(true)
    expect(rpc.allowed("sources.configure")).toBe(false)
    await expect(rpc.call("sources.configure", { extraRoots: [] })).rejects.toMatchObject({ type: "own.scope_denied" })
    // Every conversation on the PC (`모든 폴더`) and an import that keeps secrets are this PC's windows' (09 §5.5).
    const folder = { directory: "C:\\work\\app" }
    expect(rpc.allowed("sessions.list", folder)).toBe(true)
    expect(rpc.allowed("sessions.list", { ...folder, scope: "all" })).toBe(false)
    expect(rpc.allowed("migrate.plan", { redact: false })).toBe(false)
    await expect(rpc.call("sessions.list", { ...folder, scope: "all" })).rejects.toMatchObject({
      type: "own.scope_denied",
    })
    // SAFETY: the fake transport does not decode the ref.
    await expect(rpc.call("sessions.read", { ref: ref as never, ...folder, scope: "all" })).rejects.toMatchObject({
      type: "own.scope_denied",
    })
    expect(calls).toEqual([])
    const windows = createImportRpc({ client: () => client, control: async () => "C:\\ctl", scopes: () => ALL_SCOPES })
    expect(windows.allowed("sessions.list", { ...folder, scope: "all" })).toBe(true)
    expect(windows.allowed("migrate.plan", { redact: false })).toBe(true)
  })

  test("events: every declared name parses; other names, other ids and frames without data are ignored", () => {
    const frame = (type: string, data?: object) =>
      // SAFETY: shaped like `V2EventRpc`, the variant the server sends for plugin RPC events.
      ({ id: "evt_1", type, created: 7, location: { directory: "C:\\ctl" }, data }) as unknown as OpenCodeEvent
    for (const name of Object.keys(OwnImport.Events)) {
      const event = importEvent(frame(`${IMPORT_EVENT_PREFIX}${name}`, { eventId: "01J0000000000000000000000A" }))
      expect(event).toMatchObject({ name, created: 7, data: { eventId: "01J0000000000000000000000A" } })
    }
    expect(importEvent(frame("rpc.own.import.index.changed", { directories: ["D:\\work\\a"] }))).toMatchObject({
      name: "index.changed",
      data: { directories: ["D:\\work\\a"] },
    })
    expect(importEvent(frame("rpc.own.import.not.declared", {}))).toBeUndefined()
    expect(importEvent(frame("rpc.own.import.index.changed"))).toBeUndefined()
    expect(importEvent(frame("rpc.own.team.index.changed", {}))).toBeUndefined()
    expect(importEvent(frame("rpc.own.accounts.alert", {}))).toBeUndefined()
  })

  test("metadata: helpers are recognized, imported conversations give their origin, anything else neither", () => {
    // Fixture values only: the path is never read and the ids are made up.
    const imported = {
      v: 1,
      kind: "codex",
      sourceID: "019a0000-0000-7000-8000-000000000001",
      root: "codex-default",
      path: "C:\\fixture\\sessions\\rollout.jsonl",
      title: "설치기 정리",
      cwd: "D:\\work\\a",
      models: [{ id: "gpt-5.5-codex" }],
      versions: ["0.50.0"],
      sourceUpdatedAt: 1_700_000_000_000,
      sourceBytes: 1024,
      turns: 41,
      contentHash: "00",
      mode: "summary",
      checkpoint: "llm",
      summarizer: { providerID: "own-oai-abcd", id: "gpt-6" },
      storedFull: true,
      redactions: 3,
      dropped: { image: 1 },
      importedAt: 1_700_000_100_000,
    }
    const meta = (value: JsonValue) => ({ "own.pinned": 1, [IMPORT_META.session]: value })
    expect<unknown>(importOrigin(meta(imported))).toEqual({
      kind: "codex",
      ref: { kind: "codex", rootID: "codex-default", id: "019a0000-0000-7000-8000-000000000001" },
      title: "설치기 정리",
      turns: 41,
      mode: "summary",
      checkpoint: "llm",
      summarizer: { providerID: "own-oai-abcd", id: "gpt-6" },
      redactions: 3,
      importedAt: 1_700_000_100_000,
    })
    expect(isImportHelper(meta(imported))).toBe(false)
    expect(importOrigin(meta({ ...imported, kind: "claude-code", mode: "full", checkpoint: null }))).toMatchObject({
      kind: "claude-code",
      mode: "full",
      checkpoint: null,
    })
    // A root that is not a `sources.list` token gives no `원본 보기` ref; the origin itself stays.
    expect(importOrigin(meta({ ...imported, root: "C:\\fixture\\.codex" }))?.ref).toBeUndefined()

    const helper = meta({ v: 1, helper: true, jobID: "job_1" })
    expect(isImportHelper(helper)).toBe(true)
    expect(importOrigin(helper)).toBeUndefined()

    expect(importOrigin(undefined)).toBeUndefined()
    expect(isImportHelper(undefined)).toBe(false)
    expect(importOrigin({ "own.team": { role: "main" } })).toBeUndefined()
    expect(importOrigin(meta({ ...imported, v: 2 }))).toBeUndefined()
    expect(importOrigin(meta({ ...imported, kind: "gemini" }))).toBeUndefined()
    expect(importOrigin(meta({ ...imported, checkpoint: "other" }))).toBeUndefined()
    expect(importOrigin(meta({ ...imported, turns: "41" }))).toBeUndefined()
    expect(importOrigin(meta({ ...imported, redactions: null }))).toBeUndefined()
    expect(importOrigin(meta("summary"))).toBeUndefined()
  })

  test("every server runtime carries one import client, made on first use, with the connection's scopes", () => {
    createRoot((dispose) => {
      // SAFETY: the layer only calls `connect`, which never settles here, so no runtime attaches a client.
      const host = { connect: () => new Promise<never>(() => {}) } as unknown as OwnHost
      const data = createDataLayer({ host, cache: createMemoryCache() })
      const local = data.local()
      expect(local.imports).toBe(local.imports)
      // A PC window before the host answered holds every scope.
      expect(local.imports.allowed("sources.configure")).toBe(true)
      expect(data.ensure("ssh-host").imports).not.toBe(local.imports)
      dispose()
    })
  })
})

describe("frame batching and coalescing (03 §20.2 R3)", () => {
  test("items pushed in one frame arrive together, in order", async () => {
    const batches: number[][] = []
    const batcher = createFrameBatcher<number>((items) => batches.push(items))
    batcher.push(1)
    batcher.push(2)
    batcher.push(3)
    await tick()
    batcher.push(4)
    await tick()
    expect(batches).toEqual([[1, 2, 3], [4]])
  })

  test("the keyed coalescer keeps the last value per key", async () => {
    const out: string[][] = []
    const coalescer = createKeyedCoalescer<string>(20, (items) => out.push(items))
    coalescer.push("a", "a1")
    coalescer.push("b", "b1")
    coalescer.push("a", "a2")
    await tick()
    expect(out).toEqual([["b1", "a2"]])
  })
})

describe("OwnStore", () => {
  function setup(
    answers: Record<string, unknown> = {},
    sessionDirectory: (sessionID: string) => string | undefined = () => "D:\\p",
    startingMs?: number,
  ) {
    const { calls, client } = transport({
      health: { version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" },
      "accounts.list": {
        revision: 3,
        accounts: [{ id: "acc_1", providerID: "own-oai-aaaa", label: "Alpha" }],
      },
      "quota.snapshot": { windows: [{ id: "w1", accountID: "acc_1", usedPercent: 10 }] },
      "session.binding": { bindings: [{ sessionID: "ses_1", model: { providerID: "own-oai-aaaa", id: "m" } }] },
      "presets.list": {
        groups: [
          { group: "codex", defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto" } },
          { group: "ds", defaultModel: null },
        ],
      },
      "policy.get": { policy: { defaults: { byKind: { oai: "acc_1" } } } },
      ...answers,
    })
    return createRoot((dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        client: () => client,
        // As server.ts wires them: the RPC routing and the store know the same session directories.
        routing: { control: async () => "C:\\ctl", sessionDirectory },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({ rpc, bus, client: () => client, sessionDirectory, startingMs })
      return { own, bus, calls, dispose }
    })
  }

  // Bug of 2026-10-18: AC-02 chosen in the switcher showed (and the switcher assumed) AC-01, the first account on
  // `anthropic`. A conversation's pill names the account of its binding.
  test("several Claude accounts on `anthropic`: a conversation names its own bound account, not the first", async () => {
    const claude = (id: string, label: string) => ({ id, providerID: "anthropic", kind: "claude-sub", label })
    const { own, bus, dispose } = setup({
      "accounts.list": { revision: 5, accounts: [claude("acc_claude_slot", "AC-01"), claude("acc_cl2", "AC-02")] },
      "session.binding": {
        bindings: [
          { sessionID: "ses_1", accountID: "acc_cl2", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
          {
            sessionID: "ses_2",
            accountID: "acc_claude_slot",
            model: { providerID: "anthropic", id: "claude-opus-5-5" },
          },
          { sessionID: "ses_3", accountID: null, model: { providerID: "anthropic", id: "claude-opus-5-5" } },
        ],
      },
    })
    own.watchVisible(["ses_1", "ses_2", "ses_3"])
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.accountFor("anthropic")?.label).toBe("AC-01")
    expect(own.accountOfSession("ses_1", "anthropic")?.label).toBe("AC-02")
    expect(own.accountOfSession("ses_2", "anthropic")?.label).toBe("AC-01")
    // No account in the binding, a binding not read yet, or another provider than the account's: the provider's.
    expect(own.accountOfSession("ses_3", "anthropic")?.label).toBe("AC-01")
    expect(own.accountOfSession("ses_unknown", "anthropic")?.label).toBe("AC-01")
    expect(own.accountOfSession("ses_1", "own-oai-aaaa")).toBeUndefined()
    dispose()
  })

  // MR8-10 (3e575f4e93): leaving the page cancels its pending reads, which fail as "Failed to fetch"; they are not
  // reported then, and a page the back-forward cache shows again reports again.
  test("a read that fails after pagehide is not reported; after pageshow it is", async () => {
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      const failing = { "presets.list": () => new Error("Transport: Failed to fetch") }
      const reported = () => errors.filter((args) => args[0] === "[own-web] own.accounts request failed")
      window.dispatchEvent(new Event("pagehide"))
      const left = setup(failing)
      left.bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      await tick()
      expect(left.calls.some((call) => call.method === "presets.list")).toBe(true)
      expect(reported()).toEqual([])
      left.dispose()

      window.dispatchEvent(new Event("pageshow"))
      const shown = setup(failing)
      shown.bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      await tick()
      expect(reported().length).toBeGreaterThan(0)
      expect(String(reported()[0]![1])).toContain("Failed to fetch")
      shown.dispose()
    } finally {
      console.error = original
      window.dispatchEvent(new Event("pageshow"))
    }
  })

  test("server.connected resyncs health, accounts, quota, visible bindings and new-session defaults", async () => {
    const { own, bus, calls, dispose } = setup()
    own.watchVisible(["ses_1"])
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.status).toBe("ready")
    expect(own.accountFor("own-oai-aaaa")?.label).toBe("Alpha")
    expect(own.state.quota.acc_1?.map((window) => window.id)).toEqual(["w1"])
    expect(String(own.state.binding.ses_1?.model?.id)).toBe("m")
    expect(calls.map((call) => call.method)).toEqual([
      "health",
      "accounts.list",
      "quota.snapshot",
      "session.binding",
      "presets.list",
      "policy.get",
    ])
    // 07 §2.2: groups without a default yet are left out; the default account per kind comes from the policy.
    expect<unknown>(own.state.groupDefaults).toEqual({ codex: { id: "gpt-6-astra", variant: "high", source: "auto" } })
    expect<unknown>(own.state.defaultAccounts).toEqual({ oai: "acc_1" })
    expect(own.state.defaultsLoaded).toBe(true)
    dispose()
  })

  test("presets.changed reads the group defaults again, not the policy", async () => {
    const { own, bus, calls, dispose } = setup()
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    const count = (method: string) => calls.filter((call) => call.method === method).length
    const before = { presets: count("presets.list"), policy: count("policy.get") }
    bus.publish(ownFrame("presets.changed", { eventId: "01JAXPRESETS0000000000000A", origin: "global" }))
    bus.flush()
    await tick()
    expect(count("presets.list")).toBe(before.presets + 1)
    expect(count("policy.get")).toBe(before.policy)
    expect<string | undefined>(own.state.groupDefaults.codex?.id).toBe("gpt-6-astra")
    dispose()
  })

  test("claudeAgent.pool keeps the Claude Agent process pool, so a waiting conversation can show its line", async () => {
    const { own, bus, dispose } = setup()
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.claudeAgentPool).toBeUndefined()
    const pool = { live: 4, cap: 4, over: 0, spares: 0, waiting: [{ sessionID: "ses_waiting", since: 1 }] }
    bus.publish(ownFrame("claudeAgent.pool", { eventId: "01JAXPOOL000000000000000AA", origin: "global", pool }))
    bus.flush()
    await tick()
    expect<unknown>(own.state.claudeAgentPool).toEqual(pool)
    bus.publish(
      ownFrame("claudeAgent.pool", {
        eventId: "01JAXPOOL000000000000000AB",
        origin: "global",
        pool: { ...pool, live: 3, waiting: [] },
      }),
    )
    bus.flush()
    await tick()
    expect(own.state.claudeAgentPool?.waiting).toEqual([])
    dispose()
  })

  test("a window that opens while a Claude Agent start waits reads the pool at once (CAG-39)", async () => {
    const pool = { live: 4, cap: 4, over: 0, spares: 0, waiting: [{ sessionID: "ses_waiting", since: 1 }] }
    const agent = { id: "acc_ca", providerID: "claude-agent", kind: "claude-agent", label: "Claude Agent" }
    const opened = setup({
      "accounts.list": { revision: 4, accounts: [agent] },
      "claudeAgent.status": { accounts: [], cli: null, login: "idle", pool },
    })
    opened.bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect<unknown>(opened.own.state.claudeAgentPool).toEqual(pool)
    // The cap set on the accounts page shows at once, before its event.
    opened.own.setClaudeAgentPool({ ...pool, cap: 2 })
    expect(opened.own.state.claudeAgentPool?.cap).toBe(2)
    opened.dispose()
    // Without a Claude Agent account nothing is asked.
    const plain = setup({ "claudeAgent.status": new Error("not expected") })
    plain.bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(plain.calls.some((call) => call.method === "claudeAgent.status")).toBe(false)
    expect(plain.own.state.claudeAgentPool).toBeUndefined()
    plain.dispose()
  })

  test("the accounts page's pool read loses to a pool event that arrived while it was out (CAG-47)", async () => {
    const pool = { live: 4, cap: 4, over: 0, spares: 0, waiting: [{ sessionID: "ses_waiting", since: 1 }] }
    const agent = { id: "acc_ca", providerID: "claude-agent", kind: "claude-agent", label: "Claude Agent" }
    const answer = Promise.withResolvers<unknown>()
    const opened = setup({
      "accounts.list": { revision: 4, accounts: [agent] },
      "claudeAgent.status": () => answer.promise,
    })
    opened.bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    const read = opened.own.readClaudeAgentPool()
    opened.bus.publish(ownFrame("claudeAgent.pool", { eventId: "01JAXPOOL000000000000000AC", origin: "global", pool }))
    opened.bus.flush()
    answer.resolve({ accounts: [], cli: null, login: "idle", pool: { ...pool, live: 1, waiting: [] } })
    await read
    await tick()
    expect<unknown>(opened.own.state.claudeAgentPool).toEqual(pool)
    opened.dispose()
  })

  test("a server without presets.list still has the default accounts, and new sessions stop waiting", async () => {
    const { own, bus, dispose } = setup({ "presets.list": new Error("rpc.method_not_found") })
    expect(own.state.defaultsLoaded).toBe(false)
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.status).toBe("ready")
    expect<unknown>(own.state.groupDefaults).toEqual({})
    expect<unknown>(own.state.defaultAccounts).toEqual({ oai: "acc_1" })
    expect(own.state.defaultsLoaded).toBe(true)
    // A `policy.set` answer is the only other writer of the default accounts (07 §2.2 rule 3).
    own.setDefaultAccounts({ codex: Account.ID.make("acc_2") })
    expect<unknown>(own.state.defaultAccounts).toEqual({ codex: "acc_2" })
    dispose()
  })

  test("a visible session's binding is read again when the server announces the session (optimistic create)", async () => {
    const { own, bus, calls, dispose } = setup()
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    own.watchVisible(["ses_1"])
    await tick()
    const before = calls.filter((call) => call.method === "session.binding").length
    bus.publish({ type: "session.created", id: "c1", data: { sessionID: "ses_1" } } as unknown as OpenCodeEvent)
    bus.publish({ type: "session.created", id: "c2", data: { sessionID: "ses_other" } } as unknown as OpenCodeEvent)
    bus.flush()
    await tick()
    expect(calls.filter((call) => call.method === "session.binding").length).toBe(before + 1)
    dispose()
  })

  test("a visible session whose directory is not known yet gets its binding once the directory arrives", async () => {
    // A conversation opened by its link: the header asks for its binding before the session's info has arrived.
    const [directory, setDirectory] = createSignal<string>()
    const { own, bus, calls, dispose } = setup({}, (sessionID) => (sessionID === "ses_1" ? directory() : "D:\\p"))
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    own.watchVisible(["ses_1"])
    await tick()
    const asked = () => calls.filter((call) => call.method === "session.binding").length
    expect(asked()).toBe(0)
    expect(own.state.binding.ses_1).toBeUndefined()
    setDirectory("D:\\p")
    await tick()
    expect(asked()).toBe(1)
    expect(String(own.state.binding.ses_1?.model?.id)).toBe("m")
    dispose()
  })

  test("an open session's cache, switch, preset and speed views wait for its directory too", async () => {
    // The composer of a conversation opened by its link watches them before the session's info has arrived. Read
    // then, the session methods failed with own.location_unknown and were never read again (composer e2e).
    const [directory, setDirectory] = createSignal<string>()
    const { own, bus, calls, dispose } = setup(
      {
        "cache.state": { sessionID: "ses_1" },
        "switch.state": { sessionID: "ses_1" },
        "session.preset.get": { sessionID: "ses_1", none: "session" },
        "session.speed.get": { sessionID: "ses_1" },
      },
      (sessionID) => (sessionID === "ses_unknown" ? undefined : sessionID === "ses_1" ? directory() : "D:\\p"),
    )
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    own.watchOpen("ses_1")
    own.watchPreset("ses_1")
    own.watchSpeed("ses_1")
    // A view released before its directory arrives is not read.
    own.watchPreset("ses_unknown")()
    await tick()
    const methods = ["cache.state", "session.preset.get", "session.speed.get", "switch.state"]
    const asked = () =>
      calls.flatMap((call) => (methods.includes(call.method) ? [`${call.method} ${String(call.directory)}`] : []))
    expect(asked()).toEqual([])
    setDirectory("D:\\p")
    await tick()
    expect(asked().toSorted()).toEqual(methods.map((method) => `${method} D:\\p`))
    expect<unknown>(own.state.sessionPreset.ses_1).toEqual({ sessionID: "ses_1", none: "session" })
    expect<unknown>(own.state.sessionSpeed.ses_1).toEqual({ sessionID: "ses_1" })
    expect<unknown>(own.state.cache.ses_1).toEqual({ sessionID: "ses_1" })
    expect<unknown>(own.state.switchState.ses_1).toEqual({ sessionID: "ses_1" })
    dispose()
  })

  test("an SSH server's store takes accounts and limits from this PC's store and never asks the host (04 §12.6)", async () => {
    const local = setup()
    await local.own.resync()
    const remote = transport({
      health: { version: "local", buildId: "b", guard: "ok", controlDir: "/home/u/ctl" },
      "session.binding": { bindings: [] },
    })
    const ssh = createRoot((dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        client: () => remote.client,
        routing: { control: async () => "/home/u/ctl", sessionDirectory: () => "/home/u/p" },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({
        rpc,
        bus,
        client: () => remote.client,
        sessionDirectory: () => "/home/u/p",
        registry: () => local.own,
      })
      return { own, dispose }
    })
    await ssh.own.resync()
    await tick()
    expect(ssh.own.state.status).toBe("ready")
    expect(ssh.own.accountFor("own-oai-aaaa")?.label).toBe("Alpha")
    expect(ssh.own.state.quota.acc_1?.map((window) => window.id)).toEqual(["w1"])
    expect<string | undefined>(ssh.own.state.groupDefaults.codex?.id).toBe("gpt-6-astra")
    expect(remote.calls.map((call) => call.method)).toEqual(["health"])
    // 02 §8.10.13: a host conversation's claude runs in this PC's pool, so the host store shows this PC's pool.
    const pool = { live: 2, cap: 2, over: 0, spares: 0, waiting: [{ sessionID: "ses_host", since: 1 }] }
    local.own.setClaudeAgentPool(pool)
    await tick()
    expect<unknown>(ssh.own.state.claudeAgentPool).toEqual(pool)
    expect(remote.calls.map((call) => call.method)).toEqual(["health"])
    ssh.dispose()
    local.dispose()
  })

  test("a failed guard or a missing RPC id shows the unmanaged state (03 §8)", async () => {
    const skew = setup({ health: { version: "x", buildId: "b", guard: "skew" } })
    await skew.own.resync()
    expect(skew.own.state).toMatchObject({ status: "unmanaged", reason: "skew" })
    skew.dispose()
    // Past the start-up window (none here): a missing own.accounts is an unmanaged instance.
    const missing = setup(
      { health: Object.assign(new Error("no"), { _tag: "RpcError", type: "rpc.unavailable" }) },
      undefined,
      0,
    )
    await missing.own.resync()
    expect(missing.own.state).toMatchObject({ status: "unmanaged", reason: "rpc.unavailable" })
    missing.dispose()
  })

  // Upstream v2.4.0 (#63814) loads plugins in the background: right after a service start own.accounts is not there yet.
  test("own.accounts not registered yet keeps loading and recovers by itself, at once on plugin.updated", async () => {
    let registered = false
    const unavailable = () => Object.assign(new Error("no"), { _tag: "RpcError", type: "rpc.unavailable" })
    const answer = (value: unknown) => async () => {
      if (!registered) throw unavailable()
      return value
    }
    const starting = setup({
      health: answer({ version: "local", buildId: "b", guard: "ok", controlDir: "ctl" }),
      "accounts.list": answer({ revision: 1, accounts: [{ id: "acc_1", providerID: "own-oai-aaaa", label: "Alpha" }] }),
      "quota.snapshot": answer({ windows: [] }),
    })
    await starting.own.resync()
    expect(starting.own.state.status).toBe("loading")
    expect(starting.own.state.reason).toBeUndefined()
    // The backoff asks again by itself.
    const asked = starting.calls.filter((call) => call.method === "health").length
    await Bun.sleep(400)
    expect(starting.calls.filter((call) => call.method === "health").length).toBeGreaterThan(asked)
    expect(starting.own.state.status).toBe("loading")
    registered = true
    starting.bus.publish({ type: "plugin.updated", id: "p", data: {} } as OpenCodeEvent)
    for (let i = 0; i < 50 && starting.own.state.status !== "ready"; i++) await tick()
    expect(starting.own.state).toMatchObject({ status: "ready" })
    expect(starting.own.state.accountOrder).toEqual(["acc_1"])
    starting.dispose()
  })

  test("accounts and quota load alongside a slow health, which still decides", async () => {
    const gate = Promise.withResolvers<void>()
    const slow = setup({
      health: async () => {
        await gate.promise
        return { version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" }
      },
    })
    const resync = slow.own.resync()
    await tick()
    expect(slow.calls.map((call) => call.method)).toEqual(["health", "accounts.list", "quota.snapshot"])
    expect(slow.own.state.status).toBe("loading")
    expect(slow.own.state.accountOrder).toEqual([])
    gate.resolve()
    await resync
    expect(slow.own.state.status).toBe("ready")
    expect(slow.own.accountFor("own-oai-aaaa")?.label).toBe("Alpha")
    expect(slow.own.state.quota.acc_1?.map((window) => window.id)).toEqual(["w1"])
    slow.dispose()
  })

  test("changes announced while a slow health is pending are not undone by the early answers", async () => {
    const gate = Promise.withResolvers<void>()
    const server = { revision: 3, label: "Alpha", usedPercent: 10 }
    const slow = setup({
      health: async () => {
        await gate.promise
        return { version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" }
      },
      "accounts.list": () => ({
        revision: server.revision,
        accounts: [{ id: "acc_1", providerID: "own-oai-aaaa", label: server.label }],
      }),
      "quota.snapshot": () => ({
        windows: [{ id: "w1", accountID: "acc_1", usedPercent: server.usedPercent }],
      }),
    })
    const resync = slow.own.resync()
    await tick()
    Object.assign(server, { revision: 4, label: "Beta", usedPercent: 90 })
    slow.bus.publish(ownFrame("accounts.changed", { eventId: "c1", origin: "global", revision: 4 }))
    slow.bus.publish(
      ownFrame("quota.updated", {
        eventId: "q1",
        origin: "global",
        accountID: "acc_1",
        windows: [{ id: "w1", accountID: "acc_1", usedPercent: 90 }],
      }),
    )
    slow.bus.flush()
    slow.own.flush()
    await tick()
    expect([slow.own.state.revision, slow.own.accountFor("own-oai-aaaa")?.label]).toEqual([4, "Beta"])
    gate.resolve()
    await resync
    expect(slow.own.state.status).toBe("ready")
    expect([slow.own.state.revision, slow.own.accountFor("own-oai-aaaa")?.label]).toEqual([4, "Beta"])
    expect(slow.own.state.quota.acc_1?.[0]?.usedPercent).toBe(90)
    // The quota snapshot is asked for again after health; the accounts list is not.
    expect(slow.calls.map((call) => call.method)).toEqual([
      "health",
      "accounts.list",
      "quota.snapshot",
      "accounts.list",
      "quota.snapshot",
      "presets.list",
      "policy.get",
    ])
    slow.dispose()
  })

  test("an unmanaged health wins over the accounts and quota answers", async () => {
    const notFound = () => Object.assign(new Error("no"), { _tag: "RpcError", type: "rpc.method_not_found" })
    const guarded = setup({
      health: { version: "x", buildId: "b", guard: "skew" },
      "quota.snapshot": notFound(),
    })
    await guarded.own.resync()
    expect(guarded.own.state).toMatchObject({ status: "unmanaged", reason: "skew" })
    expect([...guarded.own.state.accountOrder, ...Object.keys(guarded.own.state.quota)]).toEqual([])
    guarded.dispose()
    const missing = setup(
      {
        health: Object.assign(new Error("no"), { _tag: "RpcError", type: "rpc.unavailable" }),
        "accounts.list": Object.assign(new Error("down"), { _tag: "RpcError", type: "internal_error" }),
        "quota.snapshot": notFound(),
      },
      undefined,
      0,
    )
    await missing.own.resync()
    expect(missing.own.state).toMatchObject({ status: "unmanaged", reason: "rpc.unavailable" })
    missing.dispose()
  })

  test("a failed accounts or quota call maps to unavailable; accounts that loaded are kept", async () => {
    const quotaDown = setup({
      "quota.snapshot": Object.assign(new Error("down"), { _tag: "RpcError", type: "internal_error" }),
    })
    await quotaDown.own.resync()
    expect(quotaDown.own.state).toMatchObject({ status: "unavailable", reason: "internal_error" })
    expect(quotaDown.own.accountFor("own-oai-aaaa")?.label).toBe("Alpha")
    quotaDown.dispose()
    const accountsDown = setup({ "accounts.list": new Error("offline") })
    await accountsDown.own.resync()
    expect(accountsDown.own.state).toMatchObject({ status: "unavailable", reason: "network" })
    expect(Object.keys(accountsDown.own.state.quota)).toEqual([])
    accountsDown.dispose()
  })

  test("events are de-duplicated by eventId and quota updates coalesce to the last one", async () => {
    const { own, bus, dispose } = setup()
    const seen: string[] = []
    own.on("alert", (event) => seen.push(event.data.eventId))
    const alert = { eventId: "a1", origin: "global", code: "flap", severity: "warning", message: "m" }
    bus.publish(ownFrame("alert", alert))
    bus.publish(ownFrame("alert", alert))
    bus.publish(
      ownFrame("quota.updated", {
        eventId: "q1",
        origin: "global",
        accountID: "acc_1",
        windows: [{ id: "w1", usedPercent: 20 }],
      }),
    )
    bus.publish(
      ownFrame("quota.updated", {
        eventId: "q2",
        origin: "global",
        accountID: "acc_1",
        windows: [{ id: "w1", usedPercent: 30 }],
      }),
    )
    bus.flush()
    own.flush()
    expect(seen).toEqual(["a1"])
    expect(own.state.alerts.map((item) => item.id)).toEqual(["a1"])
    expect(own.state.quota.acc_1?.[0]?.usedPercent).toBe(30)
    dispose()
  })

  test("a spent DeepSeek 보너스 (its window back at 0) leaves the account's windows, from the snapshot and events", async () => {
    const balance = { id: "ds.balance", accountID: "acc_1", kind: "balance", label: "잔액", remaining: 9 }
    const bonus = { ...balance, id: "ds.balance.granted", label: "보너스", remaining: 2 }
    const { own, bus, dispose } = setup({ "quota.snapshot": { windows: [balance, { ...bonus, remaining: 0 }] } })
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.quota.acc_1?.map((window) => window.id)).toEqual(["ds.balance"])
    const update = (eventId: string, windows: unknown[]) =>
      bus.publish(ownFrame("quota.updated", { eventId, origin: "global", accountID: "acc_1", windows }))
    update("q1", [balance, bonus])
    bus.flush()
    own.flush()
    expect(own.state.quota.acc_1?.map((window) => window.id)).toEqual(["ds.balance", "ds.balance.granted"])
    update("q2", [balance, { ...bonus, remaining: 0 }])
    bus.flush()
    own.flush()
    expect(own.state.quota.acc_1?.map((window) => window.id)).toEqual(["ds.balance"])
    dispose()
  })

  test("reset credit counts (02 §7.1.1) come from the snapshot and quota.updated; a count-less update keeps the last", async () => {
    const credits = { accountID: "acc_1", providerID: "own-codex-a", availableCount: 2, observedAt: 1, source: "poll" }
    const { own, bus, dispose } = setup({ "quota.snapshot": { windows: [], resetCredits: [credits] } })
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.resetCredits.acc_1?.availableCount).toBe(2)
    const update = (eventId: string, extra: Record<string, unknown>) =>
      bus.publish(ownFrame("quota.updated", { eventId, origin: "global", accountID: "acc_1", windows: [], ...extra }))
    update("q1", { resetCredits: { ...credits, availableCount: 1, observedAt: 2 } })
    bus.flush()
    own.flush()
    expect(own.state.resetCredits.acc_1).toMatchObject({ availableCount: 1, observedAt: 2 })
    update("q2", {})
    bus.flush()
    own.flush()
    expect(own.state.resetCredits.acc_1?.availableCount).toBe(1)
    // A list or redeem answer lands at once, before its quota.updated.
    own.setResetCredits({ ...credits, availableCount: 0, observedAt: 3 } as Parameters<typeof own.setResetCredits>[0])
    expect(own.state.resetCredits.acc_1?.availableCount).toBe(0)
    // Never a window.
    expect(own.state.quota.acc_1).toEqual([])
    // The windows a redeem read again show at once.
    const refilled = {
      id: "codex.primary",
      accountID: "acc_1",
      providerID: "own-codex-a",
      scope: "account",
      kind: "rolling_quota",
      label: "5시간",
      usedPercent: 0,
      status: "ok",
      confidence: "live",
      source: "poll",
      observedAt: 4,
    } as const
    own.setWindows("acc_1", [refilled as Parameters<typeof own.setWindows>[1][number]])
    expect(own.state.quota.acc_1?.map((window) => [window.id, window.usedPercent])).toEqual([["codex.primary", 0]])
    dispose()
  })

  test("a reset credit count the service no longer knows is forgotten: quota.updated null, a redeem, a resync", async () => {
    const credits = { accountID: "acc_1", providerID: "own-codex-a", availableCount: 2, observedAt: 1, source: "poll" }
    const snapshot = { value: { windows: [], resetCredits: [credits] } as Record<string, unknown> }
    const { own, bus, dispose } = setup({ "quota.snapshot": () => snapshot.value })
    const connect = async () => {
      bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      await tick()
    }
    await connect()
    expect(own.state.resetCredits.acc_1?.availableCount).toBe(2)
    // A redeem whose read after it reported no count: unknown, not the 2 from before.
    bus.publish(
      ownFrame("quota.updated", {
        eventId: "q1",
        origin: "global",
        accountID: "acc_1",
        windows: [],
        resetCredits: null,
      }),
    )
    bus.flush()
    own.flush()
    expect(own.state.resetCredits.acc_1).toBeUndefined()
    // The redeem's own answer says so at once.
    own.setResetCredits(credits as Parameters<typeof own.setResetCredits>[0])
    own.forgetResetCredits("acc_1")
    expect(own.state.resetCredits.acc_1).toBeUndefined()
    // A resync takes the snapshot's set as a whole: a count missed while away is dropped too.
    own.setResetCredits(credits as Parameters<typeof own.setResetCredits>[0])
    snapshot.value = { windows: [] }
    await connect()
    expect(own.state.resetCredits).toEqual({})
    dispose()
  })

  test("account.status keeps why an account is out of service until it is ready again (02 §3.2c usage limit)", () => {
    const { own, bus, dispose } = setup()
    const status = (eventId: string, data: Record<string, unknown>) =>
      bus.publish(ownFrame("account.status", { eventId, origin: "global", ...data }))
    status("s1", { accountID: "acc_1", status: "exhausted", reason: "subscription_sharing_usage_limit_exceeded" })
    // Login progress names no account.
    status("s2", { accountID: null, attemptID: "att_1", phase: "authorized" })
    bus.flush()
    expect(own.state.statusReason).toEqual({ acc_1: "subscription_sharing_usage_limit_exceeded" })
    status("s3", { accountID: "acc_1", status: "ready", reason: "exhaustion_expired" })
    bus.flush()
    expect(own.state.statusReason).toEqual({})
    dispose()
  })

  // 02 §8.7 (CS): Claude Code's own login going stale (or being refreshed by Claude Code) changes the Claude card
  // without a registry change, so no `accounts.changed` names a new revision.
  test("account.status of a Claude account whose listed status differs reads the list again; others do not", async () => {
    const server = { status: "ready" }
    const { own, bus, calls, dispose } = setup({
      "accounts.list": () => ({
        revision: 3,
        accounts: [
          { id: "acc_claude_slot", providerID: "anthropic", kind: "claude-sub", label: "AC-01", status: server.status },
          { id: "acc_1", providerID: "own-oai-aaaa", kind: "oai", label: "Alpha", status: "ready" },
        ],
      }),
    })
    await own.resync()
    const lists = () => calls.filter((call) => call.method === "accounts.list").length
    const before = lists()
    const status = (eventId: string, data: Record<string, unknown>) =>
      bus.publish(ownFrame("account.status", { eventId, origin: "global", ...data }))
    server.status = "needs_reauth"
    status("s1", { accountID: "acc_claude_slot", status: "needs_reauth", reason: "claude_shared_stale" })
    bus.flush()
    await tick()
    expect(lists()).toBe(before + 1)
    expect(own.state.accounts["acc_claude_slot"]?.status).toBe("needs_reauth")
    // The list already says so, and another kind's status is not a Claude card's: nothing more is read.
    status("s2", { accountID: "acc_claude_slot", status: "needs_reauth", reason: "claude_shared_stale" })
    status("s3", { accountID: "acc_1", status: "exhausted", reason: "status_429" })
    bus.flush()
    await tick()
    expect(lists()).toBe(before + 1)
    // CR: its refresh line changed (a passing failure keeps `ready`): the card is read again all the same.
    status("s4", { accountID: "acc_claude_slot", status: "needs_reauth", reason: "claude_refresh" })
    bus.flush()
    await tick()
    expect(lists()).toBe(before + 2)
    dispose()
  })

  // CL (2026-11-27): the list read before claude-auth's first detection had no Claude account, and the slot's arrival
  // moves no registry revision; `plugin.status` says it came, so the list is read again.
  test("plugin.status reads the list again: Claude accounts listed after the slot was detected show", async () => {
    const server = { detected: false }
    const claude = (id: string, label: string) => ({ id, providerID: "anthropic", kind: "claude-sub", label })
    const { own, bus, calls, dispose } = setup({
      "accounts.list": () => ({
        revision: 3,
        accounts: [
          { id: "acc_1", providerID: "own-oai-aaaa", kind: "oai", label: "Alpha" },
          ...(server.detected ? [claude("acc_claude_slot", "AC-01"), claude("acc_cl2", "AC-02")] : []),
        ],
      }),
    })
    await own.resync()
    expect(own.state.accountOrder).toEqual(["acc_1"])
    const lists = () => calls.filter((call) => call.method === "accounts.list").length
    const before = lists()
    server.detected = true
    const event = { eventId: "p1", origin: "global", plugin: "claudeAuth", phase: "installed" }
    bus.publish(ownFrame("plugin.status", event))
    bus.flush()
    await tick()
    expect(lists()).toBe(before + 1)
    expect(own.state.accountOrder).toEqual(["acc_1", "acc_claude_slot", "acc_cl2"])
    dispose()
  })

  // RS (2026-11-28): AC-01's `다시 로그인` wrote a new login but no registry revision moved, so the card kept the expired
  // line. The service announces such a card change as `accounts.changed` of the revision the window already holds (as
  // Claude Agent's login check does): the list is read again. An older revision (out of order) is not.
  test("accounts.changed of the held revision reads the list again: a login written again shows at once", async () => {
    const server = { refresh: { state: "due" } as { state: string } | undefined }
    const { own, bus, calls, dispose } = setup({
      "accounts.list": () => ({
        revision: 7,
        accounts: [
          {
            id: "acc_claude_slot",
            providerID: "anthropic",
            kind: "claude-sub",
            label: "AC-01",
            status: "ready",
            claude: {
              managed: true,
              default: true,
              folder: "C:\\fake",
              loaded: true,
              ...(server.refresh ? { refresh: server.refresh } : {}),
            },
          },
        ],
      }),
    })
    await own.resync()
    expect(own.state.accounts["acc_claude_slot"]?.claude?.refresh?.state).toBe("due")
    const lists = () => calls.filter((call) => call.method === "accounts.list").length
    const before = lists()
    server.refresh = undefined
    bus.publish(ownFrame("accounts.changed", { eventId: "a1", origin: "global", revision: 7 }))
    bus.flush()
    await tick()
    expect(lists()).toBe(before + 1)
    expect(own.state.accounts["acc_claude_slot"]?.claude?.refresh).toBeUndefined()
    bus.publish(ownFrame("accounts.changed", { eventId: "a2", origin: "global", revision: 6 }))
    bus.flush()
    await tick()
    expect(lists()).toBe(before + 1)
    dispose()
  })

  test("a resync takes exhaustion reasons from the snapshot; login problems the list still shows stay", async () => {
    const usage = "subscription_sharing_usage_limit_exceeded"
    const server: { exhausted: unknown[] } = { exhausted: [] }
    const { own, bus, dispose } = setup({
      "accounts.list": {
        revision: 3,
        accounts: [
          { id: "acc_1", providerID: "own-siwc-aaaa", label: "Alpha", status: "ready" },
          { id: "acc_2", providerID: "own-siwc-bbbb", label: "Beta", status: "needs_reauth" },
        ],
      },
      "quota.snapshot": () => ({ windows: [], exhausted: server.exhausted }),
    })
    const status = (eventId: string, data: Record<string, unknown>) =>
      bus.publish(ownFrame("account.status", { eventId, origin: "global", ...data }))
    status("s1", { accountID: "acc_1", status: "exhausted", reason: usage })
    status("s2", { accountID: "acc_2", status: "needs_reauth", reason: "subscription_sharing_invalid_user" })
    bus.flush()
    // The service restarted, or its `ready` arrived while the stream was down: it holds no exhaustion now.
    await own.resync()
    expect(own.state.statusReason).toEqual({ acc_2: "subscription_sharing_invalid_user" })
    // An exhaustion announced while this window was disconnected.
    server.exhausted = [{ accountID: "acc_1", reason: usage, until: Date.now() + 60_000 }]
    await own.resync()
    expect(own.state.statusReason).toEqual({ acc_1: usage, acc_2: "subscription_sharing_invalid_user" })
    dispose()

    // A service older than the field reports nothing: the reasons events gave stay.
    const older = setup()
    older.bus.publish(
      ownFrame("account.status", {
        eventId: "s1",
        origin: "global",
        accountID: "acc_1",
        status: "exhausted",
        reason: usage,
      }),
    )
    older.bus.flush()
    await older.own.resync()
    expect(older.own.state.statusReason).toEqual({ acc_1: usage })
    older.dispose()
  })

  test("an account.status announced while a resync waits is not undone by its early snapshot", async () => {
    const usage = "subscription_sharing_usage_limit_exceeded"
    const gate = Promise.withResolvers<void>()
    const server: { exhausted: unknown[] } = { exhausted: [] }
    const slow = setup({
      health: async () => {
        await gate.promise
        return { version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" }
      },
      "quota.snapshot": () => ({ windows: [], exhausted: server.exhausted }),
    })
    const resync = slow.own.resync()
    await tick()
    server.exhausted = [{ accountID: "acc_1", reason: usage, until: Date.now() + 60_000 }]
    slow.bus.publish(
      ownFrame("account.status", {
        eventId: "s1",
        origin: "global",
        accountID: "acc_1",
        status: "exhausted",
        reason: usage,
      }),
    )
    slow.bus.flush()
    gate.resolve()
    await resync
    expect(slow.own.state.statusReason).toEqual({ acc_1: usage })
    expect(slow.calls.map((call) => call.method)).toEqual([
      "health",
      "accounts.list",
      "quota.snapshot",
      "quota.snapshot",
      "presets.list",
      "policy.get",
    ])
    slow.dispose()
  })

  test("compaction.due admits the compaction under the event's inputID unless a revert is staged", async () => {
    const { own, bus, dispose } = setup()
    bus.publish(
      ownFrame("compaction.due", {
        eventId: "d1",
        origin: "session",
        sessionID: "ses_1",
        inputID: "msg_1",
        P: 10,
        triggerTokens: 64_000,
        epoch: 0,
      }),
    )
    bus.flush()
    await tick()
    expect(own.state.compactionRequested.ses_1).toMatchObject({ inputID: "msg_1", triggerTokens: 64_000 })
    dispose()
  })
})

// Review finding (2026-10-26): after a skill switch only the open settings page's project and the open popover's
// folder were read again; every other skill list this window had read (the `@` list's) kept the switched-off skill.
describe("skill lists after a skill switch (SG-18)", () => {
  test("skillset.changed marks every skill list read so far as stale; the next read of each asks again", async () => {
    const A = "D:\\work\\a"
    const B = "D:\\work\\b"
    const served: Record<string, string[]> = { [A]: ["glossary", "translate"], [B]: ["glossary"] }
    const reads: string[] = []
    const base = transport().client
    // SAFETY: the data layer only reads skill lists here; the own store only listens to the bus.
    const client = {
      ...base,
      skill: {
        list: async (input: { location: { directory: string } }) => {
          const directory = input.location.directory
          reads.push(directory)
          return {
            location: { directory },
            data: served[directory]!.map((id) => ({
              id,
              name: id,
              path: `${directory}\\${id}\\SKILL.md`,
              content: "",
            })),
          }
        },
      },
    } as unknown as OpenCodeClient
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        client: () => client,
        routing: { control: async () => "C:\\ctl", sessionDirectory: () => undefined },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({ rpc, bus, client: () => client, sessionDirectory: () => undefined })
      const data = createData({
        api: () => client,
        directory: "",
        event: {
          on: bus.on,
          listen: (handler) => bus.listen((event) => handler({ name: event.type, details: event })),
        },
        connection: { status: () => "connected" },
      })
      const stop = staleSkillsOnSwitch(data, own)
      const ids = (directory: string) => data.location.skill.list({ directory })?.map((skill) => skill.id)
      await data.location.skill.sync({ directory: A })
      await data.location.skill.sync({ directory: B })
      await data.location.skill.sync({ directory: A })
      expect(reads).toEqual([A, B])
      // A global off of glossary, switched from another window: no list is read at once, both are stale.
      served[A] = ["translate"]
      served[B] = []
      bus.publish(ownFrame("skillset.changed", { eventId: "evt_skills_1", origin: "local" }))
      bus.flush()
      await tick()
      expect(reads).toEqual([A, B])
      await data.location.skill.sync({ directory: B })
      expect(ids(B)).toEqual([])
      await data.location.skill.sync({ directory: A })
      expect(ids(A)).toEqual(["translate"])
      expect(reads).toEqual([A, B, B, A])
      // On again: offered again on the next read.
      served[A] = ["glossary", "translate"]
      bus.publish(ownFrame("skillset.changed", { eventId: "evt_skills_2", origin: "local" }))
      bus.flush()
      await tick()
      await data.location.skill.sync({ directory: A })
      expect(ids(A)).toEqual(["glossary", "translate"])
      stop()
      own.dispose()
      dispose()
    })
  })
})

describe("SessionIndex (stale-while-revalidate)", () => {
  test("paints the cached list first, then replaces it with the server list and persists it", async () => {
    const cache = createMemoryCache()
    const saved = Promise.withResolvers<void>()
    await cache.write({
      serverKey: "local",
      savedAt: 5,
      sessions: [
        { id: "ses_old", title: "cached", created: 1, updated: 1, projectID: "prj_a", directory: "D:\\work\\a" },
      ],
      projects: [{ id: "prj_a", directory: "D:\\work\\a" }],
    })
    const { client } = transport()
    const sources: string[] = []
    const { index, bus, dispose } = createRoot((dispose) => {
      const bus = createEventBus()
      const index = createSessionIndex({
        serverKey: "local",
        client: () => client,
        bus,
        cache: {
          read: cache.read,
          async write(list) {
            await cache.write(list)
            saved.resolve()
          },
        },
        onRows: (source) => sources.push(source),
      })
      return { index, bus, dispose }
    })
    await index.ready
    expect(index.state.source).toBe("cache")
    expect(index.state.order).toEqual(["ses_old"])
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    bus.flush()
    await index.fresh
    expect(index.state.source).toBe("server")
    expect(index.state.order).toEqual(["ses_b", "ses_a"])
    expect(index.state.sessions.ses_old).toBeUndefined()
    expect(sources).toEqual(["cache", "server"])

    // Events keep it current without a refetch: rename, busy moves to the top, delete.
    bus.publish({
      type: "session.renamed",
      id: "e1",
      created: 300,
      data: { sessionID: "ses_a", title: "renamed" },
    } as OpenCodeEvent)
    bus.publish({ type: "session.deleted", id: "e2", created: 301, data: { sessionID: "ses_b" } } as OpenCodeEvent)
    bus.flush()
    expect(index.state.sessions.ses_a?.title).toBe("renamed")
    expect(index.state.order).toEqual(["ses_a"])
    await saved.promise
    expect(cache.entries.get("local")?.sessions.map((row) => row.id)).toEqual(["ses_a"])
    dispose()
  })
})

describe("SessionIndex events (sidebar order and cached rows)", () => {
  test("archived rows stay out of the list; a turn start moves its row up; the end records the outcome", async () => {
    const cache = createMemoryCache()
    const base = transport().client
    const archived = { ...session("ses_z", "D:\work\a", 300), time: { created: 1, updated: 300, archived: 250 } }
    // SAFETY: the index only calls `session.list`, `session.get` and `project.list`.
    const client = {
      ...base,
      session: {
        ...base.session,
        list: async () => ({
          data: [archived, session("ses_b", "D:\work\a", 200), session("ses_a", "D:\work\a", 100)],
          cursor: {},
        }),
      },
    } as unknown as OpenCodeClient
    const { index, bus, dispose } = createRoot((dispose) => {
      const bus = createEventBus()
      return { index: createSessionIndex({ serverKey: "local", client: () => client, bus, cache }), bus, dispose }
    })
    await index.ready
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    bus.flush()
    await index.fresh
    expect(index.state.order).toEqual(["ses_b", "ses_a"])
    expect(index.state.sessions.ses_z?.archived).toBe(250)

    bus.publish({
      type: "session.execution.started",
      id: "e1",
      created: 400,
      data: { sessionID: "ses_a" },
    } as OpenCodeEvent)
    bus.flush()
    expect(index.state.order).toEqual(["ses_a", "ses_b"])
    expect(index.state.sessions.ses_a).toMatchObject({ status: "busy", updated: 400 })

    bus.publish({
      type: "session.execution.failed",
      id: "e2",
      created: 410,
      data: { sessionID: "ses_a" },
    } as OpenCodeEvent)
    bus.flush()
    expect(index.state.sessions.ses_a).toMatchObject({ status: "idle", outcome: "failed", updated: 400 })
    dispose()
  })
})

describe("SessionIndex own flags (19.11)", () => {
  test("rows carry only own.pinned/own.archived; metadata events patch them; a fork's row is fetched", async () => {
    const cache = createMemoryCache()
    const base = transport().client
    const flagged = {
      ...session("ses_a", "D:\work\a", 100),
      metadata: { "own.pinned": 5, "other.host": { keep: true }, "own.note": "private" },
    }
    const fetched: string[] = []
    // SAFETY: the index only calls `session.list`, `session.get` and `project.list`.
    const client = {
      ...base,
      session: {
        ...base.session,
        list: async () => ({ data: [flagged, session("ses_b", "D:\work\a", 50)], cursor: {} }),
        get: async ({ sessionID }: { sessionID: string }) => {
          fetched.push(sessionID)
          return session(sessionID, "D:\work\a", 500)
        },
      },
    } as unknown as OpenCodeClient
    const { index, bus, dispose } = createRoot((dispose) => {
      const bus = createEventBus()
      return { index: createSessionIndex({ serverKey: "local", client: () => client, bus, cache }), bus, dispose }
    })
    await index.ready
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    bus.flush()
    await index.fresh
    expect(index.state.sessions.ses_a?.metadata).toEqual({ "own.pinned": 5 })
    expect(index.state.sessions.ses_b?.metadata).toEqual({})

    // SAFETY: the index reads only `type` and `data` of these events (no durable envelope in a unit test).
    bus.publish({
      type: "session.metadata.updated",
      id: "e1",
      created: 200,
      data: { sessionID: "ses_b", metadata: { "own.archived": 7, "own.note": "x" } },
    } as unknown as OpenCodeEvent)
    bus.publish({
      type: "session.forked",
      id: "e2",
      created: 210,
      data: { sessionID: "ses_fork", parentID: "ses_a", boundary: {} },
    } as unknown as OpenCodeEvent)
    bus.flush()
    await tick()
    expect(index.state.sessions.ses_b?.metadata).toEqual({ "own.archived": 7 })
    expect(fetched).toEqual(["ses_fork"])
    expect(index.state.order[0]).toBe("ses_fork")
    dispose()
  })
})

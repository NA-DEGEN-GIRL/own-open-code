// RemoteStore against a fake local runtime (event bus + own.remote calls) and fake SSH runtimes: host list, resolve →
// attach with the token only in the header holder, events (de-duplicated), the reconnect hook, prompts, heartbeat,
// catalog-backed snapshots and forgetting a host.
import { afterEach, describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createRoot, createSignal } from "solid-js"
import type { CachedSessionList, HostView, ServerEntry, SessionListCache } from "@/data"
import { createEventBus } from "@/data/events"
import { OwnRpcError } from "@/data/rpc"
import type { HostConnection } from "@/host"
import { createRemoteStore, type RemoteStore } from "./store"

const TOKEN = "1790000000.c2VjcmV0LXRva2VuLXZhbHVlLWZvci10ZXN0"

function hostView(id: string, patch: Partial<HostView> = {}): HostView {
  return {
    id,
    alias: id.slice(2),
    name: id.slice(2),
    target: id.slice(2),
    stage: "disconnected",
    paused: true,
    error: null,
    detail: "",
    platform: null,
    hostIdentity: null,
    identityChanged: false,
    versions: { local: "2.0.18-own.9", remoteRunning: null, remoteStaged: [], skew: false },
    autoConnect: false,
    loopback: "127.0.3.2",
    localPort: 24_817,
    epoch: 1,
    accounts: { mode: "all" },
    leaseSeconds: 900,
    failClosedGraceSeconds: 300,
    tokenTtlHours: 12,
    projectConfig: "disabled",
    shellEnv: "login",
    warnings: [],
    broker: {
      state: "unavailable",
      mode: null,
      proto: 1,
      leasesActive: 0,
      lastPushAt: null,
      spoolBacklog: 0,
      gaps: 0,
      clockSkewMs: null,
      sourceStale: [],
    },
    sessions: { active: null },
    events: { state: "off", catalogEpoch: 0, catalogFetchedAt: null },
    pendingSettings: false,
    owner: { clientId: null },
    upstreamOpencodeDetected: false,
    ...patch,
  } as HostView
}

interface Attach {
  readonly entry: ServerEntry
  readonly reconnect: (() => Promise<HostConnection>) | undefined
}

function harness(input: { hosts: HostView[]; listFails?: string }) {
  const bus = createEventBus()
  const calls: Array<{ method: string; input: unknown }> = []
  const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>()
  const dropped: string[] = []
  const upserts: ServerEntry[] = []
  const state = {
    hosts: input.hosts,
    ready: new Set<string>(input.hosts.filter((host) => host.stage === "ready").map((host) => host.id)),
    catalog: { epoch: 0, fetchedAt: null as number | null, projects: [] as unknown[], sessions: [] as unknown[] },
  }
  const [localStatus] = createSignal<"connected" | "connecting">("connecting")
  function fakeRuntime(key: string, cache: SessionListCache | undefined) {
    const [entry, setEntry] = createSignal<ServerEntry>()
    const attaches: Attach[] = []
    return {
      key,
      kind: "ssh" as const,
      cache,
      entry,
      attaches,
      attach(next: ServerEntry, reconnect?: () => Promise<HostConnection>) {
        setEntry(next)
        attaches.push({ entry: next, reconnect })
      },
      connection: { status: () => (entry() ? "connected" : "connecting") },
      sessions: { state: { sessions: {}, projects: {}, order: [], source: "empty" } },
      data: { session: { get: () => undefined } },
      client: () => {
        throw new Error("not used")
      },
    }
  }
  const remote = {
    allowed: () => true,
    async call(method: string, payload: unknown) {
      calls.push({ method, input: payload })
      switch (method) {
        case "hosts.list":
          if (input.listFails) throw new OwnRpcError(input.listFails, "no")
          return { revision: 1, hosts: state.hosts }
        case "resolve": {
          const hostId = (payload as { hostId: string }).hostId
          if (!state.ready.has(hostId)) return { url: null, stage: "disconnected" }
          return {
            url: `http://127.0.3.2:24817`,
            token: TOKEN,
            tokenExpiresAt: Date.now() + 12 * 3_600_000,
            epoch: 7,
            controlDir: "/home/me/.local/share/own-open-code/control",
            home: "/home/me",
          }
        }
        case "catalog.get":
          return state.catalog
        case "connect":
          return { stage: "connecting" }
        case "respond":
        case "heartbeat":
        case "cancel":
          return {}
        case "hosts.add":
          return { host: hostView("h-added1", { alias: "added" }) }
        default:
          return {}
      }
    },
  }
  const data = {
    remote,
    local: () => ({
      key: "local",
      bus,
      connection: { status: localStatus },
      entry: () =>
        ({
          key: "local",
          kind: "local",
          label: "local",
          baseUrl: "http://127.0.0.1:1",
          auth: "injected",
        }) as ServerEntry,
    }),
    ensure: (key: string, _kind: string, options?: { cache?: SessionListCache }) => {
      const created = fakeRuntime(key, options?.cache)
      runtimes.set(key, created)
      return created
    },
    get: (key: string) => runtimes.get(key),
    drop: (key: string) => {
      dropped.push(key)
      runtimes.delete(key)
    },
    servers: { upsert: (entry: ServerEntry) => upserts.push(entry) },
  }
  const memory = new Map<string, CachedSessionList>()
  const cache: SessionListCache = {
    read: async (key) => memory.get(key),
    write: async (list) => void memory.set(list.serverKey, list),
  }
  let store!: RemoteStore
  const dispose = createRoot((dispose) => {
    store = createRemoteStore({ data: data as never, clientId: "c-test-client", cache, resolveInterval: 20 })
    return dispose
  })
  const emit = (name: string, payload: Record<string, unknown>) => {
    bus.publish({ type: `rpc.own.remote.${name}`, data: payload } as unknown as OpenCodeEvent)
    bus.flush()
  }
  const connected = () => {
    bus.publish({ type: "server.connected", data: {} } as unknown as OpenCodeEvent)
    bus.flush()
  }
  return {
    store,
    state,
    calls,
    runtimes,
    dropped,
    upserts,
    memory,
    emit,
    connected,
    cleanup() {
      store.dispose()
      dispose()
      bus.dispose()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
let current: ReturnType<typeof harness> | undefined
afterEach(() => {
  current?.cleanup()
  current = undefined
})

describe("RemoteStore", () => {
  test("hosts.list on server.connected; a ready host is resolved and attached with the token in the header only", async () => {
    current = harness({ hosts: [hostView("h-ready01", { stage: "ready", paused: false }), hostView("h-idle001")] })
    current.connected()
    await settle()
    const { store, runtimes, upserts } = current
    expect(store.state.status).toBe("ready")
    expect(store.state.order).toEqual(["h-ready01", "h-idle001"])
    // Every host gets a runtime (its snapshot list paints before SSH), only the ready one is attached.
    expect([...runtimes.keys()].sort()).toEqual(["h-idle001", "h-ready01"])
    const ready = runtimes.get("h-ready01")!
    expect(ready.attaches).toHaveLength(1)
    const entry = ready.attaches[0]!.entry
    expect(entry).toMatchObject({ key: "h-ready01", kind: "ssh", baseUrl: "http://127.0.3.2:24817", auth: "injected" })
    expect(entry.controlDir).toBe("/home/me/.local/share/own-open-code/control")
    expect(atob(entry.headers!().authorization!.slice(6))).toBe(`opencode:${TOKEN}`)
    expect(upserts.map((item) => item.key)).toEqual(["h-ready01"])
    expect(runtimes.get("h-idle001")!.attaches).toHaveLength(0)
    // The token never enters the store (state is what devtools, snapshots and components see).
    expect(JSON.stringify(store.state)).not.toContain(TOKEN)
    expect(store.state.endpoints["h-ready01"]).toMatchObject({ epoch: 7, home: "/home/me" })
  })

  test("own-remote missing → unavailable", async () => {
    current = harness({ hosts: [], listFails: "rpc.method_not_found" })
    current.connected()
    await settle()
    expect(current.store.state.status).toBe("unavailable")
  })

  test("events are applied once per eventId; ready attaches; leaving authentication clears the prompt", async () => {
    current = harness({ hosts: [hostView("h-host001")] })
    current.connected()
    await settle()
    const { store, emit, state, runtimes } = current
    emit("host.prompt", {
      eventId: "e1",
      hostId: "h-host001",
      promptId: "p1",
      kind: "hostKey",
      text: "The authenticity of host 'lab' can't be established.",
      fingerprint: "SHA256:abc",
      keyType: "ED25519",
      ownerClientId: "c-test-client",
    })
    emit("host.state", { eventId: "e2", hostId: "h-host001", stage: "authentication", paused: false })
    expect(store.state.prompts["h-host001"]?.fingerprint).toBe("SHA256:abc")
    expect(store.state.hosts["h-host001"]!.owner.clientId).toBe("c-test-client")
    emit("host.state", { eventId: "e3", hostId: "h-host001", stage: "starting", paused: false })
    expect(store.state.prompts["h-host001"]).toBeUndefined()
    state.ready.add("h-host001")
    emit("host.state", { eventId: "e4", hostId: "h-host001", stage: "ready", paused: false, epoch: 9 })
    // The same event again changes nothing.
    emit("host.state", { eventId: "e4", hostId: "h-host001", stage: "ready", paused: false, epoch: 9 })
    await settle()
    expect(store.state.hosts["h-host001"]).toMatchObject({ stage: "ready", epoch: 9, owner: { clientId: null } })
    expect(runtimes.get("h-host001")!.attaches).toHaveLength(1)
  })

  test("the reconnect hook waits while the host is paused and returns once it is ready again (04 §12.2)", async () => {
    current = harness({ hosts: [hostView("h-host002", { stage: "ready", paused: false })] })
    current.connected()
    await settle()
    const { emit, state, runtimes, calls } = current
    const reconnect = runtimes.get("h-host002")!.attaches[0]!.reconnect!
    state.ready.delete("h-host002")
    emit("host.state", { eventId: "d1", hostId: "h-host002", stage: "disconnected", paused: true })
    let result: HostConnection | undefined
    void reconnect().then((value) => (result = value))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(result).toBeUndefined()
    // Paused: no resolve polling at all.
    const resolvesWhilePaused = calls.filter((call) => call.method === "resolve").length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls.filter((call) => call.method === "resolve").length).toBe(resolvesWhilePaused)
    state.ready.add("h-host002")
    emit("host.state", { eventId: "d2", hostId: "h-host002", stage: "ready", paused: false })
    await settle()
    await settle()
    expect(result).toEqual({
      baseUrl: "http://127.0.3.2:24817",
      auth: "injected",
      controlDir: "/home/me/.local/share/own-open-code/control",
    })
    // Same URL: the existing client keeps working, no second attach.
    expect(runtimes.get("h-host002")!.attaches).toHaveLength(1)
  })

  test("not paused: resolve is retried on its interval until the host is ready", async () => {
    current = harness({ hosts: [hostView("h-host003", { stage: "ready", paused: false })] })
    current.connected()
    await settle()
    const { emit, state, runtimes, calls } = current
    const reconnect = runtimes.get("h-host003")!.attaches[0]!.reconnect!
    state.ready.delete("h-host003")
    emit("host.state", { eventId: "r1", hostId: "h-host003", stage: "connecting", paused: false })
    const before = calls.filter((call) => call.method === "resolve").length
    let done = false
    void reconnect().then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(calls.filter((call) => call.method === "resolve").length).toBeGreaterThan(before + 1)
    state.ready.add("h-host003")
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(done).toBe(true)
  })

  test("respond sends the value once and clears the prompt; heartbeat runs while this tab owns a prompt", async () => {
    current = harness({ hosts: [hostView("h-host004")] })
    current.connected()
    await settle()
    const { store, emit, calls } = current
    emit("host.prompt", {
      eventId: "q1",
      hostId: "h-host004",
      promptId: "p9",
      kind: "password",
      text: "tester@lab's password: ",
      ownerClientId: "c-test-client",
    })
    await settle()
    // After the list load: one replay request (a reloaded owner tab gets its prompt back, RG5).
    expect(calls.filter((call) => call.method === "heartbeat" && isReplay(call.input))).toHaveLength(1)
    expect(calls.some((call) => call.method === "heartbeat" && !isReplay(call.input))).toBe(true)
    await store.respond("h-host004", "p9", "pw-secret")
    expect(calls.find((call) => call.method === "respond")?.input).toEqual({
      hostId: "h-host004",
      promptId: "p9",
      clientId: "c-test-client",
      value: "pw-secret",
    })
    expect(store.state.prompts["h-host004"]).toBeUndefined()
    expect(JSON.stringify(store.state)).not.toContain("pw-secret")
  })

  test("connect carries this tab's clientId and hostKeyPrompt only when asked", async () => {
    current = harness({ hosts: [hostView("h-host005")] })
    current.connected()
    await settle()
    await current.store.connect("h-host005")
    await current.store.connect("h-host005", { hostKeyPrompt: true })
    const connects = current.calls.filter((call) => call.method === "connect").map((call) => call.input)
    expect(connects).toEqual([
      { hostId: "h-host005", clientId: "c-test-client" },
      { hostId: "h-host005", clientId: "c-test-client", hostKeyPrompt: true },
    ])
  })

  test("the session snapshot is the newer of the browser cache and the catalog (04 §12.3)", async () => {
    current = harness({ hosts: [hostView("h-host006")] })
    current.state.catalog = {
      epoch: 2,
      fetchedAt: 5_000,
      projects: [],
      sessions: [{ id: "s1", directory: "/home/me/app", title: "원격 세션", updatedAt: 4_000, model: null }],
    }
    current.connected()
    await settle()
    const runtime = current.runtimes.get("h-host006")!
    const fromCatalog = await runtime.cache!.read("h-host006")
    expect(fromCatalog?.sessions.map((row) => row.title)).toEqual(["원격 세션"])
    current.memory.set("h-host006", { serverKey: "h-host006", savedAt: 9_000, sessions: [], projects: [] })
    expect((await runtime.cache!.read("h-host006"))?.savedAt).toBe(9_000)
  })

  test("broker.status carries the PC's Claude relay verdict (04 §8.11); without it the host has none", async () => {
    current = harness({ hosts: [hostView("h-host008")] })
    current.connected()
    await settle()
    const { store, emit } = current
    const claude = { state: "consent", lastError: null, holdUntil: null }
    emit("broker.status", { eventId: "b1", hostId: "h-host008", state: "connected", leasesActive: 0, spoolBacklog: 0, claude })
    expect(store.state.hosts["h-host008"]!.broker).toMatchObject({ state: "connected", claude: { ...claude, inflight: 0 } })
    emit("broker.status", { eventId: "b2", hostId: "h-host008", state: "disconnected", leasesActive: 0, spoolBacklog: 0 })
    expect(store.state.hosts["h-host008"]!.broker.state).toBe("disconnected")
    expect(store.state.hosts["h-host008"]!.broker.claude).toBeUndefined()
  })

  test("a host that disappears from hosts.list is dropped with its runtime", async () => {
    current = harness({ hosts: [hostView("h-host007", { stage: "ready", paused: false })] })
    current.connected()
    await settle()
    current.state.hosts = []
    current.emit("hosts.changed", { eventId: "c1", revision: 2 })
    await settle()
    expect(current.store.state.order).toEqual([])
    expect(current.dropped).toContain("h-host007")
  })
})

function isReplay(input: unknown) {
  return typeof input === "object" && input !== null && (input as { replay?: unknown }).replay === true
}

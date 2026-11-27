// RemoteStore (03 §16.3, 04 §12): the one screen-side adapter of `own.remote`, like OwnStore is for `own.accounts`.
// - Host list from `hosts.list` on every local `server.connected`, kept current from `rpc.own.remote.*` events
//   (de-duplicated by `eventId`).
// - One server runtime per host (`data.ensure(hostId, "ssh")`): its session list paints from the browser snapshot or
//   the own-remote catalog first (04 §12.3), then from the live server once the host is `ready`.
// - `ready` → `resolve` → `attach` with the token as a Basic header. The token lives in one closure object per host
//   (tab memory only, never in the store, storage, URLs or logs, 04 §12.1); refreshed in place when less than an hour
//   is left, so the event stream is not torn down for it. An endpoint change (new URL) attaches again without touching
//   routes, drafts or the composer (04 §12.1 "끝점 변경").
// - A dropped stream waits in the client's reconnect hook: `resolve` every 3 s while the host is not paused, else
//   silently until a `host.state` event (04 §12.2).
// - Interactive attempts are owned by this tab's clientId (sessionStorage); `heartbeat` every 10 s while it owns one,
//   and `heartbeat{replay}` after every host list load, so a reloaded owner tab gets its pending prompt back.
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import {
  callAgent,
  OwnRpcError,
  remoteEvent,
  tokenHeader,
  type DataLayer,
  type HostView,
  type RemoteCatalog,
  type RemoteEvent,
  type RemoteEventData,
  type RemoteInput,
  type RemoteMethod,
  type RemoteOutput,
  type ServerEntry,
  type ServerRuntime,
  type SessionListCache,
} from "@/data"
import { createIndexedDbCache } from "@/data/session-cache"
import type { HostConnection } from "@/host"
import { minuteNow } from "@/shell/clock"
import { remoteClientId } from "./client-id"
import { catalogList, newerList } from "./state"

/** 04 §12.2: `resolve` interval while a stream is down and the host is not paused. */
export const RESOLVE_INTERVAL_MS = 3_000
/** 04 §6.3: heartbeat while this tab owns an interactive attempt (own-remote drops owners silent for 30 s). */
export const HEARTBEAT_MS = 10_000
/** 04 §12.1: ask again when less than an hour of the token is left (own-remote re-signs then). */
export const TOKEN_REFRESH_MS = 60 * 60 * 1000
const SEEN_LIMIT = 1024
const PROGRESS_LIMIT = 50
/** Stages of a running connection attempt (it has an owner while one of these). */
const ATTEMPT_STAGES: ReadonlySet<string> = new Set([
  "connecting",
  "checking",
  "authentication",
  "uploading",
  "starting",
])

export type PromptData = RemoteEventData<"host.prompt">
export type ProgressData = RemoteEventData<"host.progress">

/** Where a host's server answers (no token: that stays in the closure). */
export interface HostEndpoint {
  readonly url: string
  readonly epoch: number
  readonly controlDir: string
  readonly home: string
  readonly tokenExpiresAt: number
}

export interface RemoteState {
  /** `unavailable`: own-remote is not loaded (guard 1 failed, old service) or this connection may not list hosts. */
  status: "loading" | "ready" | "unavailable"
  revision: number
  order: string[]
  hosts: Record<string, HostView>
  endpoints: Record<string, HostEndpoint | undefined>
  /** The latest prompt per host (text and fingerprint only, never an answer). */
  prompts: Record<string, PromptData | undefined>
  progress: Record<string, ProgressData[]>
  catalogs: Record<string, RemoteCatalog>
  /** Runtime generation per host (created, then every attach): makes runtime lookups reactive. */
  runtimes: Record<string, number>
}

type LocalMethod = Exclude<RemoteMethod, `agent.${string}`>

export interface RemoteStoreInput {
  readonly data: Pick<DataLayer, "remote" | "local" | "ensure" | "get" | "drop" | "servers">
  readonly clientId?: string
  /** Base snapshot store of SSH session lists (default: the IndexedDB one of 01 §6.3). */
  readonly cache?: SessionListCache
  /** Test seams. */
  readonly now?: () => number
  readonly resolveInterval?: number
}

export function createRemoteStore(input: RemoteStoreInput) {
  const data = input.data
  const clientId = input.clientId ?? remoteClientId()
  const now = input.now ?? Date.now
  const base = input.cache ?? createIndexedDbCache()
  const [state, setState] = createStore<RemoteState>({
    status: "loading",
    revision: -1,
    order: [],
    hosts: {},
    endpoints: {},
    prompts: {},
    progress: {},
    catalogs: {},
    runtimes: {},
  })
  let disposed = false
  const seen = new Set<string>()
  /** Per-host `Authorization` holder: the client copies its headers on every request, so updating it rotates the token. */
  const tokens = new Map<string, { authorization: string }>()
  const generations = new Map<string, number>()
  const attached = new Set<string>()
  /** Hosts this store created a runtime for (dropped when they leave `hosts.list`). */
  const ensured = new Set<string>()
  const inflight = new Map<string, Promise<HostEndpoint | undefined>>()
  const waiters = new Map<string, Set<() => void>>()
  const details = new Map<string, Promise<RemoteOutput<"hosts.detail"> | undefined>>()
  const catalogLoads = new Map<string, Promise<RemoteCatalog | undefined>>()

  const local = data.local()

  function wake(hostId: string) {
    const set = waiters.get(hostId)
    if (!set) return
    waiters.delete(hostId)
    set.forEach((resolve) => resolve())
  }

  /** Resolves on the next state change of the host, or after `timeoutMs`. */
  function nextChange(hostId: string, timeoutMs: number | undefined) {
    return new Promise<void>((resolve) => {
      const set = waiters.get(hostId) ?? new Set()
      waiters.set(hostId, set)
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        resolve()
      }
      const timer = timeoutMs === undefined ? undefined : setTimeout(done, timeoutMs)
      set.add(done)
    })
  }

  // ---- runtimes

  function sessionCache(hostId: string): SessionListCache {
    return {
      read: async (serverKey) => {
        const [cached, catalog] = await Promise.all([
          base.read(serverKey).catch(() => undefined),
          loadCatalog(hostId).catch(() => undefined),
        ])
        return newerList(cached, catalog ? catalogList(serverKey, catalog) : undefined)
      },
      write: (list) => base.write(list),
    }
  }

  function ensureRuntime(hostId: string): ServerRuntime {
    ensured.add(hostId)
    const existing = data.get(hostId)
    if (existing) return existing
    const created = data.ensure(hostId, "ssh", { cache: sessionCache(hostId) })
    setState("runtimes", hostId, 1)
    return created
  }

  function entryFor(hostId: string, endpoint: HostEndpoint): ServerEntry {
    const holder = tokens.get(hostId)
    const device = local.entry()?.auth === "device"
    return {
      key: hostId,
      kind: "ssh",
      label: state.hosts[hostId]?.name ?? hostId,
      baseUrl: endpoint.url,
      // The same trust boundary as the local connection of this window (04 §12.1).
      auth: local.entry()?.auth ?? "injected",
      controlDir: endpoint.controlDir,
      scopes: device ? local.entry()?.scopes : undefined,
      // A gateway device sends no token: its cookie authenticates at the gateway, which adds the host token (04 §12.7).
      headers: device || !holder ? undefined : () => holder,
    }
  }

  /**
   * A gateway device (05 §13.4, 04 §12.7) cannot call `resolve` (`local`): the host is `<origin>/srv/<hostId>` and its
   * control location comes from `GET /own/servers`; no token ever reaches this tab.
   */
  async function deviceEndpoint(hostId: string): Promise<HostEndpoint | undefined> {
    const { gatewayServers } = await import("@/pwa/gateway")
    const server = (await gatewayServers().catch(() => [])).find((item) => item.serverKey === hostId)
    if (!server || server.state !== "ready" || !server.controlDir) return undefined
    return {
      url: new URL(server.baseUrl, location.origin).href.replace(/\/$/, ""),
      epoch: state.hosts[hostId]?.epoch ?? 0,
      controlDir: server.controlDir,
      home: "",
      tokenExpiresAt: Number.MAX_SAFE_INTEGER,
    }
  }

  /** `resolve` (single flight per host). Updates the token holder and the endpoint; `undefined` when not ready. */
  function resolveEndpoint(hostId: string): Promise<HostEndpoint | undefined> {
    const running = inflight.get(hostId)
    if (running) return running
    const job = (async () => {
      if (local.entry()?.auth === "device") {
        const endpoint = await deviceEndpoint(hostId)
        if (!disposed) setState("endpoints", hostId, endpoint)
        return endpoint
      }
      const resolved = await data.remote.call("resolve", { hostId }).catch(() => undefined)
      if (disposed || !resolved || resolved.url === null) {
        if (!disposed) setState("endpoints", hostId, undefined)
        return undefined
      }
      const holder = tokens.get(hostId) ?? { authorization: "" }
      holder.authorization = tokenHeader(resolved.token)
      tokens.set(hostId, holder)
      const endpoint: HostEndpoint = {
        url: resolved.url,
        epoch: resolved.epoch,
        controlDir: resolved.controlDir,
        home: resolved.home,
        tokenExpiresAt: resolved.tokenExpiresAt,
      }
      setState("endpoints", hostId, endpoint)
      return endpoint
    })().finally(() => inflight.delete(hostId))
    inflight.set(hostId, job)
    return job
  }

  /** Attaches the host's runtime to its endpoint (again only when the URL changed). */
  async function connectRuntime(hostId: string) {
    const endpoint = await resolveEndpoint(hostId)
    if (!endpoint || disposed) return
    const runtime = ensureRuntime(hostId)
    const current = runtime.entry()
    if (attached.has(hostId) && current?.baseUrl === endpoint.url) {
      // Same endpoint: a stream waiting in `reconnect` picks it up from the wake-up.
      wake(hostId)
      return
    }
    const generation = (generations.get(hostId) ?? 0) + 1
    generations.set(hostId, generation)
    const entry = entryFor(hostId, endpoint)
    data.servers.upsert(entry)
    attached.add(hostId)
    runtime.attach(entry, () => waitReady(hostId, generation))
    setState("runtimes", hostId, (value) => (value ?? 0) + 1)
  }

  /** Reconnect hook of a host's event stream (04 §12.2). */
  async function waitReady(hostId: string, generation: number): Promise<HostConnection> {
    for (;;) {
      if (disposed || generations.get(hostId) !== generation) throw new Error(`stream of ${hostId} was replaced`)
      const host = state.hosts[hostId]
      if (host && (host.stage === "ready" || !host.paused)) {
        const endpoint = await resolveEndpoint(hostId)
        if (endpoint)
          return {
            baseUrl: endpoint.url,
            auth: local.entry()?.auth ?? "injected",
            controlDir: endpoint.controlDir,
            scopes: local.entry()?.auth === "device" ? local.entry()?.scopes : undefined,
          }
      }
      await nextChange(hostId, host && !host.paused ? (input.resolveInterval ?? RESOLVE_INTERVAL_MS) : undefined)
    }
  }

  // ---- reads

  async function refresh() {
    try {
      const list = await data.remote.call("hosts.list", {})
      if (disposed) return
      // Runtimes first: a group that renders from the list finds its host's session snapshot at once.
      for (const host of list.hosts) ensureRuntime(host.id)
      batch(() => {
        setState("hosts", reconcile(Object.fromEntries(list.hosts.map((host) => [host.id, host]))))
        setState("order", reconcile(list.hosts.map((host) => host.id)))
        setState({ status: "ready", revision: list.revision })
      })
      // A reload (same sessionStorage client id) or a dropped stream may have missed a prompt this tab still owns:
      // own-remote sends those again as `host.prompt` (04 §6.3, RG5 "새로 고침 뒤에도 같은 탭").
      void data.remote.call("heartbeat", { clientId, replay: true }).catch(() => undefined)
      const listed = new Set(list.hosts.map((host) => host.id))
      for (const key of [...ensured]) if (!listed.has(key)) forgotten(key)
      for (const host of list.hosts) {
        if (host.stage === "ready") void connectRuntime(host.id)
        wake(host.id)
      }
    } catch (error) {
      if (disposed) return
      if (
        error instanceof OwnRpcError &&
        /^(rpc\.method_not_found|rpc\.unavailable|own\.scope_denied)$/.test(error.type)
      )
        setState("status", "unavailable")
      else console.warn("[own-web] own.remote hosts.list failed", error instanceof Error ? error.message : error)
    }
  }

  /**
   * 04 §8.11: each host's broker view, `broker.claude` included (this PC's Claude relay verdict), changes without an
   * own.remote event (the switch lives in accounts.json). Reads the list again and takes only the broker views: no
   * reconnect, no heartbeat. Nothing to ask without hosts.
   */
  async function refreshBroker() {
    if (!state.order.length) return
    const list = await data.remote.call("hosts.list", {}).catch(() => undefined)
    if (!list || disposed) return
    batch(() => {
      for (const host of list.hosts)
        if (state.hosts[host.id]) setState("hosts", host.id, (current) => ({ ...current, broker: host.broker }))
    })
  }

  function loadCatalog(hostId: string): Promise<RemoteCatalog | undefined> {
    const running = catalogLoads.get(hostId)
    if (running) return running
    const job = data.remote
      .call("catalog.get", { hostId })
      .then((catalog) => {
        if (!disposed) setState("catalogs", hostId, catalog)
        return catalog
      })
      .catch(() => undefined)
      .finally(() => catalogLoads.delete(hostId))
    catalogLoads.set(hostId, job)
    return job
  }

  function forgotten(hostId: string) {
    ensured.delete(hostId)
    generations.set(hostId, (generations.get(hostId) ?? 0) + 1)
    attached.delete(hostId)
    tokens.delete(hostId)
    details.delete(hostId)
    wake(hostId)
    // Screens let go of the host first (its group unmounts), then its runtime is disposed.
    batch(() => {
      setState("order", (order) => order.filter((id) => id !== hostId))
      setState(
        produce((draft) => {
          delete draft.hosts[hostId]
          delete draft.endpoints[hostId]
          delete draft.prompts[hostId]
          delete draft.progress[hostId]
          delete draft.catalogs[hostId]
          delete draft.runtimes[hostId]
        }),
      )
    })
    data.drop(hostId)
  }

  // ---- events

  function apply(event: RemoteEvent) {
    switch (event.name) {
      case "hosts.changed":
        if (event.data.revision !== state.revision) void refresh()
        return
      case "host.state": {
        const { hostId, stage, paused, error, detail, epoch, versions } = event.data
        if (!state.hosts[hostId]) return void refresh()
        batch(() => {
          setState("hosts", hostId, (host) => ({
            ...host,
            stage,
            paused,
            ...(error !== undefined ? { error } : {}),
            ...(detail !== undefined ? { detail } : {}),
            ...(epoch !== undefined ? { epoch } : {}),
            ...(versions !== undefined ? { versions } : {}),
            // The owner leaves with the attempt (`hosts.list` is the source; events do not carry it).
            owner: ATTEMPT_STAGES.has(stage) ? host.owner : { clientId: null },
          }))
          if (stage !== "authentication") setState("prompts", hostId, undefined)
          if (stage !== "ready") setState("endpoints", hostId, undefined)
        })
        if (stage === "ready") void connectRuntime(hostId)
        wake(hostId)
        return
      }
      case "host.prompt":
        batch(() => {
          setState("prompts", event.data.hostId, event.data)
          if (state.hosts[event.data.hostId])
            setState("hosts", event.data.hostId, (host) => ({ ...host, owner: { clientId: event.data.ownerClientId } }))
        })
        return
      case "host.progress":
        setState("progress", event.data.hostId, (list) => [...(list ?? []), event.data].slice(-PROGRESS_LIMIT))
        return
      case "catalog.changed":
        void loadCatalog(event.data.hostId)
        return
      case "broker.status": {
        const { hostId, state: broker, leasesActive, spoolBacklog, claude } = event.data
        if (!state.hosts[hostId]) return
        setState("hosts", hostId, (host) => {
          const { claude: _previous, ...rest } = host.broker
          return {
            ...host,
            broker: {
              ...rest,
              state: broker,
              leasesActive,
              spoolBacklog,
              // 04 §8.11: the PC's Claude relay verdict travels on the event (absent: this PC has no slot); requests
              // in flight are read with `hosts.list`.
              ...(claude ? { claude: { ...claude, inflight: host.broker.claude?.inflight ?? 0 } } : {}),
            },
          }
        })
        return
      }
    }
  }

  const stopListening = local.bus.listen((raw) => {
    if (raw.type === "server.connected") return void refresh()
    const event = remoteEvent(raw)
    if (!event) return
    const id = event.data.eventId
    if (seen.has(id)) return
    seen.add(id)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
    apply(event)
  })

  const owner = createRoot((dispose) => {
    // Heartbeat while this tab owns an attempt (04 §6.3).
    const owning = createMemo(
      () =>
        state.order.some((id) => state.hosts[id]?.owner.clientId === clientId) ||
        Object.values(state.prompts).some((prompt) => prompt?.ownerClientId === clientId),
    )
    createEffect(() => {
      if (!owning()) return
      const beat = () => void data.remote.call("heartbeat", { clientId }).catch(() => undefined)
      beat()
      const timer = setInterval(beat, HEARTBEAT_MS)
      onCleanup(() => clearInterval(timer))
    })
    // Token lifetime (04 §12.1): on the shared minute clock, never a timer of its own.
    createEffect(
      on(minuteNow, () => {
        const at = now()
        for (const [hostId, endpoint] of Object.entries(state.endpoints))
          if (endpoint && endpoint.tokenExpiresAt - at < TOKEN_REFRESH_MS) void resolveEndpoint(hostId)
      }),
    )
    return dispose
  })

  // The local stream may already be up when the store is created (HMR, a late mount).
  if (local.connection.status() === "connected") void refresh()

  const call = <M extends LocalMethod>(method: M, payload: RemoteInput<M>) => data.remote.call(method, payload)

  async function connect(hostId: string, options?: { readonly hostKeyPrompt?: boolean }) {
    const result = await call("connect", {
      hostId,
      clientId,
      ...(options?.hostKeyPrompt ? { hostKeyPrompt: true } : {}),
    })
    // Only the owner: the stage comes from events, which may already be ahead of this response.
    if (ATTEMPT_STAGES.has(result.stage) && ATTEMPT_STAGES.has(state.hosts[hostId]?.stage ?? ""))
      setState("hosts", hostId, (host) => ({ ...host, owner: { clientId } }))
    return result
  }

  return {
    state,
    clientId,
    call,
    allowed: <M extends RemoteMethod>(method: M, payload?: RemoteInput<M>) => data.remote.allowed(method, payload),
    refresh,
    refreshBroker,
    loadCatalog,
    /** Reactive: re-evaluates when the host's runtime is created or attached again. */
    runtime: (hostId: string) => (state.runtimes[hostId] ? data.get(hostId) : undefined),
    host: (hostId: string): HostView | undefined => state.hosts[hostId],
    isHost: (serverKey: string) => serverKey in state.hosts,
    /** Owns an interactive attempt (`connect` with this tab as the prompt owner). */
    connect,
    /** A prompt this tab owned before a reload is not replayed: cancel the attempt and start a new one. */
    async retry(hostId: string, options?: { readonly hostKeyPrompt?: boolean }) {
      await call("cancel", { hostId, clientId }).catch(() => undefined)
      return connect(hostId, options)
    },
    /** `value` is never stored or logged; `hostKey`/`confirm` prompts take `"trust"` only (04 §14.2). */
    async respond(hostId: string, promptId: string, value: string | null) {
      await call("respond", { hostId, promptId, clientId, value })
      if (state.prompts[hostId]?.promptId === promptId) setState("prompts", hostId, undefined)
    },
    async cancel(hostId: string) {
      setState("prompts", hostId, undefined)
      return call("cancel", { hostId, clientId })
    },
    disconnect: (hostId: string) => call("disconnect", { hostId }),
    async add(payload: RemoteInput<"hosts.add">) {
      const { host } = await call("hosts.add", payload)
      ensureRuntime(host.id)
      batch(() => {
        setState("hosts", host.id, host)
        if (!state.order.includes(host.id)) setState("order", (order) => [...order, host.id])
      })
      return host
    },
    async update(payload: RemoteInput<"hosts.update">) {
      const result = await call("hosts.update", payload)
      setState("hosts", result.host.id, result.host)
      return result
    },
    discover: () => call("hosts.discover", {}),
    /** `user@host:port` (04 §7.5): memory only, asked when a panel or the badge needs it. */
    detail(hostId: string) {
      const cached = details.get(hostId)
      if (cached) return cached
      const job = call("hosts.detail", { hostId }).catch(() => undefined)
      details.set(hostId, job)
      return job
    },
    diagnostics: (hostId: string) => call("diagnostics", { hostId }),
    /** `agent.realpath` on the host's own server, at its control location (04 §12.4, §16.6). */
    async realpath(hostId: string, path: string) {
      const runtime = data.get(hostId)
      const endpoint = state.endpoints[hostId]
      if (!runtime || !endpoint) throw new OwnRpcError("own.location_unknown", `${hostId} is not connected`)
      return callAgent(runtime.client, endpoint.controlDir, "agent.realpath", { path })
    },
    /** After `forget.execute`: the runtime, token and state of the host go away. */
    forgotten,
    dispose() {
      disposed = true
      stopListening()
      owner()
      for (const hostId of [...waiters.keys()]) wake(hostId)
      tokens.clear()
    },
  }
}

export type RemoteStore = ReturnType<typeof createRemoteStore>

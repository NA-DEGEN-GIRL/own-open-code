// Data layer entry (03 §16.3). Screens use `useData()`; only src/data talks to @opencode/client and knows the own RPC
// ids (own.accounts, own.remote, own.computer, own.team, own.import, own.harness); each server runtime carries its
// TeamStore (`runtime.team`), its own.import client (`runtime.imports`) and its own.harness client (`runtime.harness`).
import { createContext, createRoot, createSignal, getOwner, onCleanup, useContext, type ParentProps } from "solid-js"
import type { OwnHost } from "@/host"
import { markAfterPaint, markOnce } from "@/perf/marks"
import { createComputerRpc } from "./computer-rpc"
import { createRemoteRpc } from "./remote-rpc"
import { ALL_SCOPES, type OwnScope } from "./rpc"
import { createServerRuntime, type ServerRuntime } from "./server"
import { createIndexedDbCache, type SessionListCache } from "./session-cache"
import { createServerRegistry, LOCAL, localEntry, type ServerEntry, type ServerKey } from "./servers"

export { RemoteHistoryError, type ServerRuntime } from "./server"
export type { ServerEntry, ServerKey } from "./servers"
export { LOCAL } from "./servers"
export type { OwnState, OwnStore } from "./own-store"
export type { CachedSessionList, SessionListCache, SessionRow, ProjectRow } from "./session-cache"
export type { SessionIndex, SessionIndexState } from "./session-index"
export { OwnRpcError, type OwnMethod, type OwnScope } from "./rpc"
export { isLocationMissing } from "./errors"
export {
  computerEvent,
  type ComputerAction,
  type ComputerAuditEntry,
  type ComputerEvent,
  type ComputerInput,
  type ComputerMethod,
  type ComputerOutput,
  type ComputerRpc,
  type ComputerStatus,
} from "./computer-rpc"
export {
  TEAM_META,
  teamEvent,
  type TeamEvent,
  type TeamEventData,
  type TeamEventName,
  type TeamInput,
  type TeamMethod,
  type TeamOutput,
  type TeamRpc,
  type TeamScope,
} from "./team-rpc"
export {
  IMPORT_META,
  importEvent,
  importOrigin,
  isImportHelper,
  type ImportEvent,
  type ImportEventData,
  type ImportEventName,
  type ImportInput,
  type ImportKind,
  type ImportMethod,
  type ImportOrigin,
  type ImportOutput,
  type ImportRpc,
  type ImportScope,
  type ImportSourceRef,
  type ImportSummary,
} from "./import-rpc"
export type { SessionPlace, TeamEntry, TeamLoad, TeamNotice, TeamState, TeamStore } from "@/team/store"
export {
  callAgent,
  remoteEvent,
  tokenHeader,
  type AgentMethod,
  type HostError,
  type HostStage,
  type HostView,
  type PromptKind,
  type RemoteCatalog,
  type RemoteEvent,
  type RemoteEventData,
  type RemoteEventName,
  type RemoteInput,
  type RemoteMethod,
  type RemoteOutput,
  type RemoteResolved,
  type RemoteRpc,
  type GatewayView,
  type DeviceView,
  type PairingView,
  type DeviceScope,
  type ServerScope,
  type FeedItem,
} from "./remote-rpc"

export function createDataLayer(input: { readonly host: OwnHost; readonly cache?: SessionListCache }) {
  const owner = getOwner()
  const registry = createServerRegistry()
  const cache = input.cache ?? createIndexedDbCache()
  const runtimes = new Map<ServerKey, { runtime: ServerRuntime; dispose: () => void }>()
  // Makes `get` reactive: a view opened on `/srv/<hostId>/…` before the host's runtime exists (a reload, a direct link
  // on a phone) picks the runtime up when it is created.
  const [generation, setGeneration] = createSignal(0)

  function runtime(
    key: ServerKey,
    kind: "local" | "ssh" = "ssh",
    /** SSH hosts: the session list cache backed by the own-remote catalog (04 §12.3). */
    options?: { readonly cache?: SessionListCache },
  ) {
    const existing = runtimes.get(key)
    if (existing) return existing.runtime
    const created = createRoot(
      (dispose) => ({
        runtime: createServerRuntime({
          key,
          kind,
          cache: options?.cache ?? cache,
          onRows: key === LOCAL ? rowsLanded : undefined,
          // 04 §12.6: an SSH server's accounts and limits are this PC's.
          registry: kind === "ssh" ? () => runtimes.get(LOCAL)?.runtime.own : undefined,
        }),
        dispose,
      }),
      owner,
    )
    runtimes.set(key, created)
    setGeneration((value) => value + 1)
    return created.runtime
  }

  // The local runtime exists before the host resolves the service, so the cached list paints first (05 T0-2).
  const local = runtime(LOCAL, "local")
  const [hostError, setHostError] = createSignal<string>()
  const connecting = input.host.connect().then((connection) => {
    const entry = localEntry(connection)
    registry.upsert(entry)
    local.attach(entry, () => input.host.reconnect())
    return connection
  })
  // Desktop: the shell could not start or find the service (03 §8 "서비스를 시작하지 못했어요."); its message is the reason.
  connecting.catch((error: unknown) => setHostError(error instanceof Error ? error.message : String(error)))

  onCleanup(() => runtimes.forEach((item) => item.dispose()))

  // `own.remote` of the local service (04 §16): at the local control location, scopes of the local connection.
  const remote = createRemoteRpc({
    client: local.client,
    control: local.control,
    scopes: () => connectionScopes(local.entry()),
  })
  // `own.computer` of the local service (01 §10.2). The phone gateway passes only `status` and `killswitch.engage` to
  // a device that can prompt or switch (05 §13.4); the phone UI does not use them yet, so a device asks for nothing.
  const computer = createComputerRpc({
    client: local.client,
    control: local.control,
    scopes: () => (local.entry()?.auth === "device" ? NO_SCOPES : connectionScopes(local.entry())),
  })

  return {
    servers: registry,
    /** Resolves with the host connection of the local server (T0-1). */
    connecting,
    /** Set when `host.connect()` failed; the cached list stays on screen. */
    hostError,
    local: () => local,
    get: (key: ServerKey) => {
      generation()
      return runtimes.get(key)?.runtime
    },
    ensure: runtime,
    /** Removes a server's runtime (a forgotten SSH host, 04 §6.7); `local` stays. */
    drop(key: ServerKey) {
      if (key === LOCAL) return
      registry.remove(key)
      runtimes.get(key)?.dispose()
      runtimes.delete(key)
      setGeneration((value) => value + 1)
    },
    /** Typed `own.remote` client; screens use RemoteStore (src/servers). */
    remote,
    /** Typed `own.computer` client; screens use the ComputerStore (src/computer). */
    computer,
  }
}

const NO_SCOPES: ReadonlySet<OwnScope> = new Set()

/** PC windows hold every scope; a gateway device what the gateway granted, never `local` (02 §9.1). */
function connectionScopes(entry: ServerEntry | undefined): ReadonlySet<OwnScope> {
  if (!entry || entry.auth !== "device") return ALL_SCOPES
  return new Set((entry.scopes ?? ["read"]).filter((scope) => scope !== "local"))
}

export type DataLayer = ReturnType<typeof createDataLayer>

/** PF1 marks (03 §20.1): rows available → painted two frames later; the server list replacing it → "fresh". */
function rowsLanded(source: "cache" | "server") {
  if (source === "server") markOnce("own:sessions-fresh")
  markAfterPaint("own:sessions-visible")
}

const DataContext = createContext<DataLayer>()

export function DataProvider(props: ParentProps<{ value: DataLayer }>) {
  return <DataContext.Provider value={props.value}>{props.children}</DataContext.Provider>
}

export function useData() {
  const value = useContext(DataContext)
  if (!value) throw new Error("useData() needs <DataProvider>")
  return value
}

/** The server runtime of a route (`/srv/:serverKey/...`); unknown keys resolve to `undefined`. */
export function useServer(key: () => ServerKey) {
  const data = useData()
  return () => data.get(key())
}

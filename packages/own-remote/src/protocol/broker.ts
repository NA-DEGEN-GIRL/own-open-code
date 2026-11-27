/**
 * The contract between own-remote (transport: ssh, epochs, keys, arm) and the credential broker (04 §4.2, §8).
 *
 * own-remote does not implement the broker. The local broker server is own-accounts `src/broker` (it sits on
 * `headersFor`, the secret cache, refresh single-flight and the ledger writer), and the remote broker client is
 * own-accounts `src/remote`, used in `mode:"remote"`. Both are found at run time through the process-global keys
 * below, so this package has no build-time dependency on either implementation. The local broker registers under the
 * build id both plugins share, which own-runtime's per-plugin leadership (`role`) makes the production setup:
 *
 * - local:  `globalThis[Symbol.for("own-open-code.remote-broker/<buildId>")]: LocalBroker`
 *           (or a `broker` property on the `@own/runtime` services, checked first)
 * - remote: `globalThis[Symbol.for("own-open-code.remote-broker-client/<buildId>")]: RemoteBrokerClient`
 *
 * The wire schemas are `Broker` in `@own/protocol`; this file is only the in-process run-time contract. own-accounts
 * keeps a copy (`src/broker/contract.ts`) that its `test/broker/contract.test.ts` checks against these lookups.
 */
export * as Broker from "./broker.js"

/**
 * Broker protocol number (04 §5.7): the shape of `hello`, `headers.get`, `observe.push`, `agent.broker.arm` and the
 * mirror `schemaVersion`, bumped only on an incompatible change. The local broker accepts `PROTO` and `PROTO - 1`.
 */
export const PROTO = 1

/** Bytes of the epoch key K (04 §8.3). */
export const KEY_BYTES = 32

/** HMAC labels of the handshake (04 §8.3). */
export const MAC_LOCAL = "own-broker/v1|L|"
export const MAC_REMOTE = "own-broker/v1|R|"

/** Frame limit (04 §8.4): 4-byte big-endian length + UTF-8 JSON, at most 1 MiB. */
export const MAX_FRAME_BYTES = 1_048_576

export type Endpoint = { readonly socket: string } | { readonly tcpPort: number }

export type AccountScope = { readonly mode: "all" } | { readonly mode: "only"; readonly ids: ReadonlyArray<string> }

/** Per-host settings own-remote hands to the local broker (04 §8.5, §8.7, §8.9). */
export interface HostSettings {
  readonly accounts: AccountScope
  readonly leaseSeconds: number
  readonly failClosedGraceSeconds: number
}

export interface LocalStatus {
  readonly state: "disconnected" | "connected" | "auth_failed"
  readonly mode: "normal" | "drain" | null
  readonly proto: number
  readonly leasesActive: number
  readonly lastPushAt: number | null
  readonly spoolBacklog: number
  readonly gaps: number
  readonly clockSkewMs: number | null
  readonly sourceStale: ReadonlyArray<string>
  /** Last time a remote connection finished the handshake (drives the 30 s re-arm check of 04 §8.3). */
  readonly lastConnectedAt: number | null
  /** 04 §8.14: the host's local model requests this PC relays now, and the last refusal of one. */
  readonly local?: { readonly inflight: number; readonly lastError: string | null }
  /**
   * 04 §8.11: the host's Claude subscription relay (verdict, relayed requests in flight, last refusal code, end of a
   * `needs_reauth` hold). Absent when this PC has no Claude slot.
   */
  readonly claude?: {
    readonly state: "not_ready" | "billing" | "off" | "consent" | "host_scope" | "enabled"
    readonly inflight: number
    readonly lastError: string | null
    readonly holdUntil: number | null
  }
}

/**
 * Local broker server (own-runtime). One loopback listener per host (`127.0.0.1:B_h`, 04 §8.2); the listener a
 * connection arrives on decides the host. own-remote calls, per connection attempt:
 * `listen` → (tunnel with `-R … :127.0.0.1:<port>`) → `setKey` (new epoch) → arm on the remote.
 */
export interface LocalBroker {
  /**
   * Opens the host's listener if needed and returns its port, with the port of the host's Claude egress relay when that
   * listens too (04 §8.11.4.2; absent: Claude stays off on the host). Idempotent while open.
   */
  listen(hostId: string): Promise<{ readonly port: number; readonly egressPort?: number }>
  /**
   * Makes `{epoch, key}` the only accepted credential of the host. A lower epoch than the current one is ignored.
   * The key bytes are copied; own-remote zeroes its copy after arm.
   */
  setKey(hostId: string, input: { readonly epoch: number; readonly key: Uint8Array }): void
  /** Host settings used by `headers.get` (scope, lease length). Called on every connect and `hosts.update`. */
  configure(hostId: string, settings: HostSettings): void
  /** Drops the key and closes the listener (`forget`, and disconnect of a host that will not reconnect). */
  close(hostId: string): Promise<void>
  status(hostId: string): LocalStatus
  /** Status changes; own-remote republishes them as `rpc.own.remote.broker.status`. Returns an unsubscribe. */
  subscribe(listener: (hostId: string, status: LocalStatus) => void): () => void
}

export interface ArmInput {
  readonly hostId: string
  readonly epoch: number
  readonly key: Uint8Array
  readonly endpoint: Endpoint
  /** The forward to the PC's Claude egress relay (04 §8.11.4.2); absent from older PCs. */
  readonly egress?: Endpoint
  readonly proto: number
}

export interface ArmResult {
  readonly accepted: boolean
  readonly reason?: "stale_epoch" | "key_mismatch" | "proto"
}

export interface RemoteStatus {
  readonly state: "unarmed" | "connecting" | "connected" | "drain" | "skew"
  readonly epoch: number | null
  readonly leases: ReadonlyArray<{ readonly providerID: string; readonly deadlineInMs: number }>
  readonly mirror: { readonly revision: number | null; readonly fetchedAt: number | null }
  readonly spool: { readonly backlog: number; readonly bytes: number; readonly gaps: number }
}

/**
 * Remote broker client (remote own-runtime, used by own-accounts `mode:"remote"`). own-remote `mode:"agent"` only
 * forwards `agent.broker.arm` to it and reads `status` for `agent.status`; it never keeps the key.
 * Rules the client must enforce (04 §8.3): keep K only in its own closure (no property, file, env or log); accept an
 * arm only for an epoch higher than any seen, or the same epoch with the same key (re-arm after a service restart);
 * reject `proto` it cannot speak.
 */
export interface RemoteBrokerClient {
  arm(input: ArmInput): ArmResult | Promise<ArmResult>
  status(): RemoteStatus
}

export function localKey(buildId: string) {
  return Symbol.for(`own-open-code.remote-broker/${buildId}`)
}

export function remoteKey(buildId: string) {
  return Symbol.for(`own-open-code.remote-broker-client/${buildId}`)
}

/** In-process endpoint lookup for the M1+ gateway (04 §12.7): never exposed over RPC. */
export function endpointsKey(buildId: string) {
  return Symbol.for(`own-open-code.remote-endpoints/${buildId}`)
}

export interface Endpoints {
  /** `{url, token, controlDir}` of a ready host, or `null`. The token is own-remote's signed server token. */
  endpoint(
    hostId: string,
  ): Promise<{ readonly url: string; readonly token: string; readonly controlDir: string } | null>
}

type Registry = Record<symbol, unknown>

function registry() {
  return globalThis as unknown as Registry
}

function isLocal(value: unknown): value is LocalBroker {
  return (
    typeof value === "object" &&
    value !== null &&
    "listen" in value &&
    typeof value.listen === "function" &&
    "setKey" in value &&
    typeof value.setKey === "function"
  )
}

function isRemote(value: unknown): value is RemoteBrokerClient {
  return typeof value === "object" && value !== null && "arm" in value && typeof value.arm === "function"
}

/** The local broker of this build: a `broker` property on the runtime services, else the global key. */
export function findLocal(buildId: string, services?: object): LocalBroker | undefined {
  if (services && "broker" in services && isLocal(services.broker)) return services.broker
  const value = registry()[localKey(buildId)]
  return isLocal(value) ? value : undefined
}

export function findRemote(buildId: string): RemoteBrokerClient | undefined {
  const value = registry()[remoteKey(buildId)]
  return isRemote(value) ? value : undefined
}

/** Registration helpers for implementations and tests. Each returns an unregister function. */
export function provideLocal(buildId: string, broker: LocalBroker) {
  registry()[localKey(buildId)] = broker
  return () => {
    if (registry()[localKey(buildId)] === broker) delete registry()[localKey(buildId)]
  }
}

export function provideRemote(buildId: string, client: RemoteBrokerClient) {
  registry()[remoteKey(buildId)] = client
  return () => {
    if (registry()[remoteKey(buildId)] === client) delete registry()[remoteKey(buildId)]
  }
}

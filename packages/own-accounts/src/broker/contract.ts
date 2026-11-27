export * as Contract from "./contract.js"

/**
 * The run-time contract with own-remote (`packages/own-remote/src/protocol/broker.ts`), which owns the transport
 * (ssh, epochs, keys, arm). own-accounts implements both sides and publishes them under the process-global keys that
 * own-remote looks up, so neither package depends on the other at build time:
 *
 * - local:  `globalThis[Symbol.for("own-open-code.remote-broker/<buildId>")]`        → {@link LocalBroker}
 * - remote: `globalThis[Symbol.for("own-open-code.remote-broker-client/<buildId>")]` → {@link RemoteBrokerClient}
 *
 * The shapes below are copies of own-remote's interfaces; `test/broker/contract.test.ts` checks them against
 * own-remote's lookup functions.
 */

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

export interface LocalBroker {
  /** The broker port, and the Claude egress relay's when it listens (04 §8.11.4.2). */
  listen(hostId: string): Promise<{ readonly port: number; readonly egressPort?: number }>
  setKey(hostId: string, input: { readonly epoch: number; readonly key: Uint8Array }): void
  configure(hostId: string, settings: HostSettings): void
  close(hostId: string): Promise<void>
  status(hostId: string): LocalStatus
  subscribe(listener: (hostId: string, status: LocalStatus) => void): () => void
}

export interface ArmInput {
  readonly hostId: string
  readonly epoch: number
  readonly key: Uint8Array
  readonly endpoint: Endpoint
  /** The forward to this PC's Claude egress relay (04 §8.11.4.2); absent from older PCs. */
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

function registry() {
  return globalThis as unknown as Record<symbol, unknown>
}

/** Publishes an implementation under its key; returns the unregister function (a no-op once replaced). */
export function provide(key: symbol, value: LocalBroker | RemoteBrokerClient) {
  registry()[key] = value
  return () => {
    if (registry()[key] === value) delete registry()[key]
  }
}

export function lookup(key: symbol) {
  return registry()[key]
}

export * as Server from "./server.js"

import net from "node:net"
import { Option, Schema } from "effect"
import { Account, Broker, type Alert, type Limit, type Plugin, type Registry } from "@own/protocol"
import { Creator } from "@own/protocol/creator"
import type { GitHubRelay } from "../github/relay.js"
import type { Logger } from "../logger.js"
import type { BrokerClaudeAgent } from "./claude-agent.js"
import type { ClaudeWire } from "./claude-wire.js"
import type { Contract } from "./contract.js"
import { Egress } from "./egress.js"
import { Lease } from "./lease.js"
import { Mirror } from "./mirror.js"
import { Observe } from "./observe.js"
import { Wire } from "./wire.js"

/**
 * The local credential broker (04 §8.2): one loopback listener per SSH host (`127.0.0.1:0`); the listener a connection
 * arrives on decides the host, so host A's key cannot use host B's forward. Mutual authentication with the epoch key
 * own-remote registered (`setKey`), `proto` and build checks (normal / drain / skew, 04 §5.7), then requests
 * (`registry.get`, `template.get`, `codexRow.get`, `headers.get`, `observe.push`, `ping`) and pushes (`mirror.changed`,
 * `quota.updated`, `account.status`, `revoke`). Implements own-remote's `LocalBroker` contract.
 *
 * `mirror.changed` also follows `presets.json` and the money state of paid accounts (T3, 07 §8.1 원격): a presets
 * change is announced to every host, and a host whose last view says another budget verdict than this PC's now is
 * told to fetch again (checked on a paid account's ledger line and once a minute, which covers a new month).
 *
 * 04 §8.11: each host also gets a Claude egress relay listener ({@link Egress.Relay}, a second `-R` of the tunnel). The
 * relay checks its per-request proof with the same epoch key, and the PC's verdict for the host (`Backend.claude`) is
 * judged again on every request; a verdict change aborts the host's relayed requests when it leaves `enabled` and
 * announces the view (`mirror.changed`) so the host follows. Its MAC failures count apart from the handshake bucket.
 *
 * 16 §8 (GH-37): a normal-mode session may also ask for the PC's GitHub (`github.offer`, `github.account`,
 * `github.call`) and is told when it changed (`github.changed`); the egress listener relays the host's git
 * ({@link Backend.github}`.gate`). Tokens stay here.
 *
 * Never logged: keys, frame bytes, header values. The local HTTP API is never reachable through this port.
 */

export interface Alerting {
  readonly code: Alert.Code
  readonly severity: Alert.Severity
  readonly message: string
  readonly accountID?: string
}

export interface Backend {
  readonly now: () => number
  readonly log: Logger.Logger
  /** What a `hello` must match for normal mode, and the id of this install (`mirror.from`). */
  readonly local: () => { readonly version: string; readonly buildId: string; readonly from: string }
  readonly issuer: Lease.Issuer
  readonly sink: Observe.Sink
  readonly view: (hostId: string, scope: Contract.AccountScope) => Promise<Mirror.Built>
  /** The PC's verdict for the host's Claude slot (04 §8.11.4.3); `undefined` when this PC has no slot detected. */
  readonly claude: (hostId: string, scope: Contract.AccountScope) => Plugin.ClaudeRemoteState | undefined
  /**
   * The Claude account an egress proof names, for a host with this account scope (02 §8.7, G5): its plugin key
   * (`undefined` = the slot's own account on a plugin that runs one), or `undefined` = refused.
   */
  readonly claudeAccount: (
    scope: Contract.AccountScope,
    accountID: string,
  ) => { readonly key: string | undefined } | undefined
  /**
   * 04 §8.14: this PC's local model a host's request names, for a host with this account scope: its server and key
   * headers, or the refusal. Absent = every local model request is refused `not_found`.
   */
  readonly localModel?: (scope: Contract.AccountScope, accountID: string, hostId: string) => Promise<Egress.LocalGate>
  /** The Claude egress relay's upstream and wire (04 §8.11.4.5), with test seams. */
  readonly egress: {
    readonly upstream: string
    readonly wire: () => Promise<ClaudeWire.Loaded>
    readonly options?: Egress.Options
  }
  /** The view's `presetsBudget` alone (`Mirror.paid` with this PC's verdicts), for the budget check. */
  readonly budget: (scope: Contract.AccountScope) => Promise<Readonly<Record<string, Broker.PresetBudget>>>
  readonly registry: () => Promise<Registry.File>
  /** events-ledger line (`remote.*` types, 04 §10.4). */
  readonly event: (input: {
    readonly type: string
    readonly accountID?: string | null
    readonly data: Record<string, unknown>
  }) => Promise<void>
  readonly alert: (input: Alerting) => void
  readonly acks: {
    read(hostId: string): Promise<{ readonly streamId: string; readonly ackThrough: number } | undefined>
    write(hostId: string, value: { readonly streamId: string; readonly ackThrough: number }): Promise<void>
  }
  /** Audit file `OWN_HOME\remote\<hostId>\leases.json`: last issue time per account (04 §8.9). */
  readonly leases: (hostId: string, issued: Readonly<Record<string, number>>) => Promise<void>
  /** Drain mode is allowed until this time (first start of this local build + `skewDrainHours`). */
  readonly drainUntil: () => number
  /** Sent to hosts in `ready` (04 §8.6 step 4). */
  readonly brokerWaitMs: number
  /** GitHub on the hosts (16 §8): absent = the `github.*` methods answer `invalid` and git is not relayed. */
  readonly github?: GitHubBackend
  /** The Claude Agent route on the hosts (02 §8.10.13): absent = the `claudeAgent.*` methods answer `invalid`. */
  readonly claudeAgent?: BrokerClaudeAgent.Relay
  /**
   * own.creator's extensions on the hosts (17 §10, 04 §9.3): read only. `view` and `file` answer from this PC's store
   * (absent when own.creator does not run here), `report` keeps a host's account in memory. Absent = `invalid`.
   */
  readonly creator?: CreatorBackend
  /**
   * The values the user sent to a host's MCP servers (04 §13 "MCP", MH): `values` answers that host only, from this
   * PC's copy. Absent = `mcp.values` answers `invalid`.
   */
  readonly mcp?: McpBackend
}

/** What this PC sent to the hosts' MCP servers (`McpSends`). Nothing here writes. */
export interface McpBackend {
  readonly values: (hostId: string, server: string) => Promise<Broker.McpValues>
}

/** This PC's extension store as the hosts may read it (17 §10). Nothing here writes the store. */
export interface CreatorBackend {
  readonly view: (hostId: string) => Promise<Creator.MirrorView | undefined>
  readonly file: (hostId: string, params: Broker.CreatorFile) => Promise<Broker.CreatorChunk | undefined>
  readonly report: (hostId: string, report: Creator.HostReport) => void
  /** The broker no longer serves the host: its report goes. */
  readonly forget?: (hostId: string) => void
}

/** This PC's GitHub as the hosts may use it (16 §8, `GitHubRelay`). */
export interface GitHubBackend {
  readonly offer: (hostId: string, params: Broker.GitHubOfferGet) => Promise<Broker.GitHubOffer>
  readonly account: (hostId: string, params: Broker.GitHubPlace) => Promise<Broker.GitHubAccountResult>
  readonly call: (hostId: string, params: Broker.GitHubCall) => Promise<Broker.GitHubCallResult>
  readonly gate: (hostId: string, ask: GitHubRelay.Ask) => Promise<GitHubRelay.Gate>
}

/** A connection that sent something other than `hello`, or nothing, within this time is closed. */
export const HELLO_TIMEOUT_MS = 10_000
export const AUTH_TIMEOUT_MS = 10_000
/** Stale-source release check and audit flush (04 §8.5 "풀림": the leader checks once a minute). */
export const SWEEP_MS = 60_000

const decodeHello = Schema.decodeUnknownOption(Broker.Hello)
const decodeAuth = Schema.decodeUnknownOption(Broker.Auth)
const decodeRequest = Schema.decodeUnknownOption(Broker.Request)
const decodeHeaders = Schema.decodeUnknownOption(Broker.HeadersGet)
const decodePush = Schema.decodeUnknownOption(Broker.ObservePush)
const decodePing = Schema.decodeUnknownOption(Broker.Ping)
const decodeTemplate = Schema.decodeUnknownOption(Broker.TemplateGet)
const decodeCodexRow = Schema.decodeUnknownOption(Broker.CodexRowGet)
const decodeGitHubOffer = Schema.decodeUnknownOption(Broker.GitHubOfferGet)
const decodeGitHubPlace = Schema.decodeUnknownOption(Broker.GitHubPlace)
const decodeGitHubCall = Schema.decodeUnknownOption(Broker.GitHubCall)
const decodeMcpValues = Schema.decodeUnknownOption(Broker.McpValuesGet)
const decodeAgentOpen = Schema.decodeUnknownOption(Broker.ClaudeAgentOpen)
const decodeAgentStart = Schema.decodeUnknownOption(Broker.ClaudeAgentStart)
const decodeAgentWrite = Schema.decodeUnknownOption(Broker.ClaudeAgentWrite)
const decodeAgentClose = Schema.decodeUnknownOption(Broker.ClaudeAgentClose)
const decodeCreatorFile = Schema.decodeUnknownOption(Broker.CreatorFile)
const decodeCreatorReport = Schema.decodeUnknownOption(Creator.HostReport)

interface Session {
  readonly channel: Wire.Channel
  readonly mode: Broker.Mode
  readonly epoch: number
  readonly streamId: string
  readonly connectedAt: number
  /** `creator.file` answers being read now (17 §10: a host fetches one chunk at a time). */
  creatorFiles: number
}

/**
 * A compromised host must not make this PC buffer `creator.file` chunks without bound (17 §10): a host asks for one
 * chunk at a time, so more than a few in flight, or a host that does not read the answers it already has, is refused.
 */
export const CREATOR_FILES_IN_FLIGHT = 4
export const CREATOR_WRITE_HIGH_WATER = 8 * 1024 * 1024

interface Known {
  readonly status: Account.Status
  readonly providerID: string
  readonly allowed: boolean
}

interface Host {
  readonly id: string
  server: net.Server | undefined
  port: number | undefined
  key: { readonly epoch: number; readonly key: Buffer } | undefined
  readonly lease: Lease.HostState
  session: Session | undefined
  failures: number[]
  lastFailureAt: number | null
  lastConnectedAt: number | null
  lastPushAt: number | null
  clockSkewMs: number | null
  backlog: number
  gaps: number
  known: Map<string, Known> | undefined
  /**
   * Hash of the `presetsBudget` the host holds (its last `registry.get`, or the verdict announced since); `undefined`
   * until the session fetched a view.
   */
  budget: string | undefined
  /** Last issue time per account for `leases.json`. */
  readonly issued: Record<string, number>
  alerted: Map<string, number>
  /** The last Claude verdict judged for this host (04 §8.11.4.3). */
  claude: Plugin.ClaudeRemoteState | undefined
}

export class LocalBroker implements Contract.LocalBroker {
  readonly #backend: Backend
  readonly #hosts = new Map<string, Host>()
  readonly #subscribers = new Set<(hostId: string, status: Contract.LocalStatus) => void>()
  readonly #timer: ReturnType<typeof setInterval>
  readonly #relay: Egress.Relay
  #closed = false

  constructor(backend: Backend) {
    this.#backend = backend
    this.#relay = new Egress.Relay(
      {
        now: backend.now,
        log: backend.log.child("egress"),
        upstream: backend.egress.upstream,
        wire: backend.egress.wire,
        limits: (windows, dropped) => backend.sink.limits(windows, dropped),
        audit: (data, kind) =>
          backend.event({
            type: `remote.egress.${kind}`,
            accountID: kind === "claude" ? Account.ID.claudeSlot : null,
            data,
          }),
        changed: (hostId) => {
          const host = this.#hosts.get(hostId)
          if (host) this.#notify(host)
        },
        ...(backend.github === undefined ? {} : { github: backend.github.gate }),
      },
      backend.egress.options,
    )
    this.#timer = setInterval(() => void this.sweep(), SWEEP_MS)
    this.#timer.unref?.()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // own-remote contract

  async listen(hostId: string) {
    const host = this.#host(hostId)
    const port = host.server && host.port !== undefined ? host.port : await this.#listen(host)
    // 04 §8.11.4.2: no relay listener leaves Claude off on the host (no `egressPort`, no second forward).
    const egressPort = await this.#relay.listen(hostId, {
      key: () => host.key,
      state: () => this.#claudeState(host) ?? "not_ready",
      account: (accountID) => this.#backend.claudeAccount(host.lease.settings.accounts, accountID),
      local: async (accountID) =>
        this.#backend.localModel
          ? this.#backend.localModel(host.lease.settings.accounts, accountID, host.id)
          : { ok: false, status: 404, code: "not_found" },
    })
    return egressPort === undefined ? { port } : { port, egressPort }
  }

  async #listen(host: Host) {
    const server = net.createServer((socket) => void this.#accept(host, socket))
    server.on("error", (error) => this.#backend.log.warn("listener_error", { hostId: host.id, error }))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", reject)
        resolve()
      })
    })
    host.server = server
    host.port = (server.address() as net.AddressInfo).port
    this.#backend.log.info("listening", { hostId: host.id, port: host.port })
    return host.port
  }

  setKey(hostId: string, input: { readonly epoch: number; readonly key: Uint8Array }) {
    const host = this.#host(hostId)
    if (host.key && input.epoch < host.key.epoch) return
    if (host.key) host.key.key.fill(0)
    host.key = { epoch: input.epoch, key: Buffer.from(input.key) }
    // Every arm (a new epoch, or the same one re-armed after a remote restart) starts the counters over (D3).
    this.#relay.reset(hostId)
    // A session of an older epoch ends: only the current key is accepted (04 §8.3).
    if (host.session && host.session.epoch < input.epoch) this.#drop(host, "superseded")
  }

  configure(hostId: string, settings: Contract.HostSettings) {
    const host = this.#host(hostId)
    const before = host.lease.settings
    host.lease.settings = {
      accounts: settings.accounts,
      leaseSeconds: clamp(settings.leaseSeconds, Broker.LEASE_SECONDS_MIN, Broker.LEASE_SECONDS_MAX),
      failClosedGraceSeconds: clamp(settings.failClosedGraceSeconds, 0, 600),
    }
    // The scope decides `host_scope` (04 §8.11.4.3).
    this.#claude(host)
    // A narrower account scope ends the leases of the accounts that left it.
    if (JSON.stringify(before.accounts) !== JSON.stringify(settings.accounts))
      void this.#backend.registry().then(
        (registry) => this.registryChanged(registry),
        () => undefined,
      )
  }

  async close(hostId: string) {
    const host = this.#hosts.get(hostId)
    if (!host) return
    this.#drop(host, "closed")
    this.#backend.claudeAgent?.drop(hostId)
    this.#backend.creator?.forget?.(hostId)
    host.key?.key.fill(0)
    host.key = undefined
    const server = host.server
    host.server = undefined
    host.port = undefined
    this.#hosts.delete(hostId)
    await this.#relay.close(hostId)
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  status(hostId: string): Contract.LocalStatus {
    const host = this.#hosts.get(hostId)
    const now = this.#backend.now()
    if (!host)
      return {
        state: "disconnected",
        mode: null,
        proto: Broker.PROTO,
        leasesActive: 0,
        lastPushAt: null,
        spoolBacklog: 0,
        gaps: 0,
        clockSkewMs: null,
        sourceStale: [],
        lastConnectedAt: null,
      }
    const failedLast = host.lastFailureAt !== null && (host.lastConnectedAt ?? 0) < host.lastFailureAt
    const claude = this.#claudeState(host)
    const relay = this.#relay.status(host.id)
    return {
      state: host.session ? "connected" : failedLast ? "auth_failed" : "disconnected",
      mode: host.session?.mode ?? null,
      proto: Broker.PROTO,
      leasesActive: host.lease.active(now),
      lastPushAt: host.lastPushAt,
      spoolBacklog: host.backlog,
      gaps: host.gaps,
      clockSkewMs: host.clockSkewMs,
      sourceStale: [...host.lease.stale.keys()],
      lastConnectedAt: host.lastConnectedAt,
      ...(relay ? { local: relay.local } : {}),
      ...(claude === undefined
        ? {}
        : {
            claude: {
              state: claude,
              inflight: relay?.inflight ?? 0,
              lastError: relay?.lastError ?? null,
              holdUntil: relay?.holdUntil ?? null,
            },
          }),
    }
  }

  subscribe(listener: (hostId: string, status: Contract.LocalStatus) => void) {
    this.#subscribers.add(listener)
    return () => void this.#subscribers.delete(listener)
  }

  /** The hosts this broker serves and their account scopes (04 §8.11.12 `plugin.claudeAuth.status.remote`). */
  hostScopes(): ReadonlyArray<{ readonly hostId: string; readonly scope: Contract.AccountScope }> {
    return [...this.#hosts.values()].map((host) => ({ hostId: host.id, scope: host.lease.settings.accounts }))
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Local changes → pushes

  /**
   * The registry, policy or rate cards changed (04 §9.2): `mirror.changed` to normal-mode sessions, `account.status`
   * for status changes (every session), and `revoke` for accounts a host may no longer use (04 §8.9).
   */
  registryChanged(registry: Registry.File) {
    for (const host of this.#hosts.values()) {
      const next = knownOf(registry, host.lease.settings.accounts)
      const previous = host.known
      host.known = next
      // `claudeSlot.remoteHosts` lives in this file (04 §8.11.12).
      this.#claude(host)
      if (!host.session) continue
      if (previous) {
        for (const [accountID, before] of previous) {
          const after = next.get(accountID)
          if (!after) {
            this.#push(host, "revoke", { providerID: before.providerID })
            continue
          }
          if (after.status !== before.status)
            this.#push(host, "account.status", { accountID: accountID as Account.ID, status: after.status })
          if ((before.allowed && !after.allowed) || (!Mirror.revokes(before.status) && Mirror.revokes(after.status))) {
            this.#push(host, "revoke", { providerID: after.providerID })
            host.lease.leases.delete(after.providerID)
          }
        }
      }
      this.#announce(host)
    }
  }

  /**
   * The Claude slot's facts changed (04 §8.11.4.1: detection, consents, the `anthropic` connection, Fast): every host's
   * verdict is judged again, a host leaving `enabled` loses its relayed requests, and every host fetches the view (its
   * `claude` carries the Fast consent too).
   */
  claudeChanged() {
    for (const host of this.#hosts.values()) {
      this.#claude(host)
      if (host.session) this.#announce(host)
    }
  }

  /** `presets.json` changed (07 §8.1 원격): every host fetches the view again. */
  presetsChanged() {
    for (const host of this.#hosts.values()) if (host.session) this.#announce(host)
  }

  /**
   * A paid account's spend may have crossed its budget (07 §5.4 step 4): hosts whose view says otherwise fetch again.
   */
  budgetChanged() {
    for (const host of this.#hosts.values()) void this.#budget(host)
  }

  /**
   * Local limit changes (04 §8.4 `quota.updated`), without echoing a host's own observations back to it, and the windows
   * this PC's store forgot (`dropped`, a removed budget), which each host forgets too.
   */
  limitsUpdated(
    windows: ReadonlyArray<Limit.Window>,
    dropped: ReadonlyArray<Pick<Limit.Window, "accountID" | "id">> = [],
  ) {
    for (const host of this.#hosts.values()) {
      const own = windows.filter((window) => window.origin !== host.id)
      if (own.length > 0 || dropped.length > 0)
        this.#push(host, "quota.updated", { windows: own, ...(dropped.length > 0 ? { dropped } : {}) })
    }
  }

  /** This PC's extension store changed (17 §10): every normal-mode host asks for its view again. */
  creatorChanged() {
    for (const host of this.#hosts.values()) this.#push(host, "creator.changed", {} satisfies Broker.CreatorChanged)
  }

  /** The hosts this broker serves and whether each has a session (Settings > 확장's host list, 17 §10). */
  hostSessions(): ReadonlyArray<{ readonly id: string; readonly connected: boolean }> {
    return [...this.#hosts.values()].map((host) => ({ id: host.id, connected: host.session !== undefined }))
  }

  /** What this PC sends to one host's MCP servers changed (MH): that host asks for its values again. */
  mcpChanged(hostId: string) {
    const host = this.#hosts.get(hostId)
    if (host) this.#push(host, "mcp.changed", {})
  }

  /** The PC's GitHub accounts, choices, settings or tool list changed (16 §8): every host asks again. */
  githubChanged() {
    for (const host of this.#hosts.values()) this.#push(host, "github.changed", {})
  }

  /** A credential was replaced by the user (key replacement, re-login): every host drops its lease (04 §8.9). */
  revokeProvider(providerID: string) {
    for (const host of this.#hosts.values()) {
      host.lease.leases.delete(providerID)
      this.#push(host, "revoke", { providerID })
    }
  }

  /**
   * Stale-source release (once a minute), the lease audit flush (04 §8.5, §8.9) and the budget check (a new month
   * frees budgets without a ledger line).
   */
  async sweep() {
    await this.#relay.sweep()
    for (const host of this.#hosts.values()) {
      if (host.session) {
        const pushes = await this.#backend.issuer.release(host.lease).catch(() => [])
        for (const push of pushes) this.#push(host, push.event, push.data)
        if (pushes.length > 0) this.#notify(host)
        await this.#budget(host)
      }
      await this.#flushAudit(host)
    }
  }

  async shutdown() {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#timer)
    await Promise.allSettled([...this.#hosts.keys()].map((id) => this.close(id)))
    await this.#relay.shutdown()
    this.#subscribers.clear()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Connections

  async #accept(host: Host, socket: net.Socket) {
    socket.setNoDelay(true)
    const now = this.#backend.now()
    host.failures = host.failures.filter((at) => now - at < 60_000)
    if (host.failures.length >= Broker.AUTH_FAILURES_PER_MINUTE) {
      socket.destroy()
      return
    }
    const channel = new Wire.Channel(socket)
    const hello = Option.getOrUndefined(decodeHello(await channel.next(HELLO_TIMEOUT_MS)))
    // Not a broker client (e.g. a browser request to the port): close without recording what it sent (04 §8.4).
    if (!hello) return channel.close("not_hello")
    const key = host.key
    if (hello.hostId !== host.id || !key || hello.epoch !== key.epoch) return this.#fail(host, channel, "epoch")
    if (!Broker.SUPPORTED_PROTOS.includes(hello.proto)) {
      channel.send({ type: "reject", reason: "skew" } satisfies Broker.Reject)
      channel.close("proto")
      this.#alertOnce(host, "remote_skew", "warning", `${host.id}: the remote broker speaks proto ${hello.proto}; update it.`)
      return
    }
    const nonceL = Wire.nonce()
    const macInput = { hostId: host.id, epoch: key.epoch, nonceR: hello.nonceR, nonceL }
    channel.send({ type: "challenge", nonceL, mac: Wire.mac(key.key, "L", macInput) } satisfies Broker.Challenge)
    const auth = Option.getOrUndefined(decodeAuth(await channel.next(AUTH_TIMEOUT_MS)))
    if (!auth || !Wire.equal(auth.mac, Wire.mac(key.key, "R", macInput))) return this.#fail(host, channel, "mac")
    if (host.key?.epoch !== key.epoch) return this.#fail(host, channel, "epoch")
    const local = this.#backend.local()
    const same = hello.version === local.version && hello.buildId === local.buildId
    const mode: Broker.Mode | undefined = same ? "normal" : this.#backend.now() < this.#backend.drainUntil() ? "drain" : undefined
    if (!mode) {
      channel.send({ type: "reject", reason: "skew" } satisfies Broker.Reject)
      channel.close("skew")
      this.#alertOnce(host, "remote_skew", "warning", `${host.id}: the remote build differs and the drain window ended.`)
      return
    }
    if (mode === "drain")
      this.#alertOnce(host, "remote_skew", "info", `${host.id}: the remote runs another build; running turns drain.`)
    const ready: Broker.Ready = {
      type: "ready",
      mode,
      proto: Broker.PROTO,
      localNow: this.#backend.now(),
      from: local.from,
      settings: {
        failClosedGraceSeconds: host.lease.settings.failClosedGraceSeconds,
        brokerWaitMs: this.#backend.brokerWaitMs,
      },
    }
    if (host.session) this.#drop(host, "replaced")
    const session: Session = {
      channel,
      mode,
      epoch: key.epoch,
      streamId: hello.streamId,
      connectedAt: this.#backend.now(),
      creatorFiles: 0,
    }
    host.session = session
    host.budget = undefined
    host.lastConnectedAt = session.connectedAt
    if (!host.known)
      host.known = knownOf(await this.#backend.registry().catch(() => undefined), host.lease.settings.accounts)
    channel.onFrame((frame) => void this.#request(host, session, frame))
    channel.onClose(() => {
      // 02 §8.10.13: the session's Claude Agent streams end with it (the host's provider resumes on the next turn); a
      // session another one already replaced leaves the new one's streams alone.
      if (host.session === session || host.session === undefined) this.#backend.claudeAgent?.drop(host.id)
      if (host.session !== session) return
      host.session = undefined
      this.#backend.log.info("disconnected", { hostId: host.id, epoch: session.epoch })
      this.#notify(host)
    })
    channel.send(ready)
    this.#backend.log.info("connected", { hostId: host.id, epoch: key.epoch, mode, proto: hello.proto })
    this.#notify(host)
  }

  #fail(host: Host, channel: Wire.Channel, reason: string) {
    const now = this.#backend.now()
    host.failures.push(now)
    host.lastFailureAt = now
    channel.close(reason)
    this.#backend.log.warn("auth_failed", { hostId: host.id, reason })
    void this.#backend
      .event({ type: "remote.broker.auth_failed", data: { hostId: host.id, reason } })
      .catch(() => undefined)
    this.#notify(host)
  }

  #drop(host: Host, reason: string) {
    const session = host.session
    if (!session) return
    host.session = undefined
    session.channel.close(reason)
  }

  async #request(host: Host, session: Session, frame: unknown) {
    const request = Option.getOrUndefined(decodeRequest(frame))
    if (!request) {
      // A frame that is not a request ends the session (the remote speaks only requests after `ready`).
      session.channel.close("invalid_frame")
      return
    }
    const reply = (value: Omit<Broker.Response, "type" | "id">) =>
      session.channel.send({ type: "res", id: request.id, ...value } satisfies Broker.Response)
    if (session.mode === "drain" && !Broker.DRAIN_METHODS.includes(request.method))
      return reply({ ok: false, error: "skew_drain" })
    try {
      const result = await this.#handle(host, session, request)
      if (result === undefined) return reply({ ok: false, error: "invalid" })
      reply({ ok: true, result })
    } catch (error) {
      this.#backend.log.error("request_failed", { hostId: host.id, method: request.method, error })
      reply({ ok: false, error: "internal" })
    }
  }

  async #handle(host: Host, session: Session, request: Broker.Request): Promise<unknown> {
    switch (request.method) {
      case "registry.get": {
        const view = (await this.#backend.view(host.id, host.lease.settings.accounts)).view
        if (host.session === session) host.budget = Mirror.hash(view.presetsBudget ?? {})
        return view
      }
      case "template.get": {
        const params = Option.getOrUndefined(decodeTemplate(request.params))
        if (!params) return undefined
        const item = (await this.#backend.view(host.id, host.lease.settings.accounts)).templates.get(params.id)
        return { id: params.id, hash: item?.hash ?? "", template: item?.template ?? null } satisfies Broker.TemplateResult
      }
      case "codexRow.get": {
        const params = Option.getOrUndefined(decodeCodexRow(request.params))
        if (!params) return undefined
        const item = (await this.#backend.view(host.id, host.lease.settings.accounts)).codexRows.get(params.slug)
        return { slug: params.slug, hash: item?.hash ?? "", row: item?.row ?? null } satisfies Broker.CodexRowResult
      }
      case "headers.get": {
        const params = Option.getOrUndefined(decodeHeaders(request.params))
        if (!params) return undefined
        const outcome = await this.#backend.issuer.issue(host.lease, params)
        for (const push of outcome.pushes) this.#push(host, push.event, push.data)
        if (outcome.issued) host.issued[outcome.issued] = this.#backend.now()
        if (outcome.pushes.length > 0) this.#notify(host)
        return outcome.result
      }
      case "observe.push": {
        const params = Option.getOrUndefined(decodePush(request.params))
        if (!params) return undefined
        const stored = await this.#backend.acks.read(host.id).catch(() => undefined)
        const ackThrough = stored && stored.streamId === params.streamId ? stored.ackThrough : 0
        const result = await Observe.ingest({
          hostId: host.id,
          sink: this.#backend.sink,
          ackThrough,
          skewMs: host.clockSkewMs,
          items: params.items,
        })
        if (result.ackThrough !== ackThrough || !stored || stored.streamId !== params.streamId)
          await this.#backend.acks.write(host.id, { streamId: params.streamId, ackThrough: result.ackThrough })
        host.lastPushAt = this.#backend.now()
        host.gaps += result.gaps
        if (result.rejected > 0) {
          void this.#backend
            .event({ type: "remote.observation.rejected", data: { hostId: host.id, count: result.rejected } })
            .catch(() => undefined)
          this.#alertOnce(
            host,
            "remote_observation_rejected",
            "warning",
            `${host.id}: ${result.rejected} remote observation(s) failed validation and were dropped.`,
          )
        }
        this.#notify(host)
        return { ackThrough: result.ackThrough } satisfies Broker.ObserveAck
      }
      case "ping": {
        const params = Option.getOrUndefined(decodePing(request.params))
        if (!params) return undefined
        const now = this.#backend.now()
        host.clockSkewMs = params.remoteNow - now
        if (params.backlog !== undefined) host.backlog = params.backlog
        if (Math.abs(host.clockSkewMs) > Broker.CLOCK_SKEW_WARN_MS)
          this.#alertOnce(
            host,
            "remote_clock_skew",
            "warning",
            `${host.id}: the remote clock is ${Math.round(host.clockSkewMs / 60_000)} minute(s) off.`,
          )
        this.#notify(host)
        return { localNow: now } satisfies Broker.Pong
      }
      case "github.offer": {
        const params = Option.getOrUndefined(decodeGitHubOffer(request.params))
        if (!params || !this.#backend.github) return undefined
        return this.#backend.github.offer(host.id, params)
      }
      case "github.account": {
        const params = Option.getOrUndefined(decodeGitHubPlace(request.params))
        if (!params || !this.#backend.github) return undefined
        return this.#backend.github.account(host.id, params)
      }
      case "github.call": {
        const params = Option.getOrUndefined(decodeGitHubCall(request.params))
        if (!params || !this.#backend.github) return undefined
        return this.#backend.github.call(host.id, params)
      }
      // 02 §8.10.13: a stream's text goes out only to the session that opened it.
      case "claudeAgent.open": {
        const params = Option.getOrUndefined(decodeAgentOpen(request.params))
        if (!params || !this.#backend.claudeAgent) return undefined
        return this.#backend.claudeAgent.open(host.id, host.lease.settings.accounts, params, (event, data) => {
          if (host.session === session) this.#push(host, event, data)
        })
      }
      case "claudeAgent.start": {
        const params = Option.getOrUndefined(decodeAgentStart(request.params))
        if (!params || !this.#backend.claudeAgent) return undefined
        return { ok: this.#backend.claudeAgent.start(host.id, params) }
      }
      case "claudeAgent.write": {
        const params = Option.getOrUndefined(decodeAgentWrite(request.params))
        if (!params || !this.#backend.claudeAgent) return undefined
        return { ok: this.#backend.claudeAgent.write(host.id, params) }
      }
      case "claudeAgent.close": {
        const params = Option.getOrUndefined(decodeAgentClose(request.params))
        if (!params || !this.#backend.claudeAgent) return undefined
        return { ok: this.#backend.claudeAgent.close(host.id, params) }
      }
      // 17 §10: read-only access to this PC's extension store; a host can never write it.
      case "creator.get": {
        if (!this.#backend.creator) return undefined
        const view = await this.#backend.creator.view(host.id)
        return (view === undefined ? {} : { view }) satisfies Broker.CreatorGetResult
      }
      case "creator.file": {
        const params = Option.getOrUndefined(decodeCreatorFile(request.params))
        if (!params || !this.#backend.creator) return undefined
        if (
          session.creatorFiles >= CREATOR_FILES_IN_FLIGHT ||
          session.channel.socket.writableLength > CREATOR_WRITE_HIGH_WATER
        )
          return undefined
        session.creatorFiles += 1
        return this.#backend.creator.file(host.id, params).finally(() => (session.creatorFiles -= 1))
      }
      case "creator.report": {
        const params = Option.getOrUndefined(decodeCreatorReport(request.params))
        if (!params || !this.#backend.creator) return undefined
        // The time is this PC's: a host cannot make its report look newer than it is.
        this.#backend.creator.report(host.id, { ...params, at: this.#backend.now() })
        return { ok: true }
      }
      // MH: the host asks for its own server's values; the record is looked up with this session's host id.
      case "mcp.values": {
        const params = Option.getOrUndefined(decodeMcpValues(request.params))
        if (!params || !this.#backend.mcp) return undefined
        return this.#backend.mcp.values(host.id, params.server)
      }
      default:
        return undefined
    }
  }

  /** `mirror.changed` with the revisions of the host's view now; the host fetches the whole view. */
  #announce(host: Host) {
    void this.#backend.view(host.id, host.lease.settings.accounts).then(
      ({ view }) =>
        this.#push(host, "mirror.changed", {
          registryRevision: view.registryRevision,
          policyRevision: view.policyRevision,
          ratecardsRevision: view.ratecardsRevision,
        } satisfies Broker.Revisions),
      (error: unknown) => this.#backend.log.warn("view_failed", { hostId: host.id, error }),
    )
  }

  /** Announces the view again when this PC's budget verdicts differ from those the host fetched last. */
  async #budget(host: Host) {
    const session = host.session
    if (!session || host.budget === undefined) return
    const budget = await this.#backend.budget(host.lease.settings.accounts).then(
      (value) => Mirror.hash(value),
      (error: unknown) => {
        this.#backend.log.warn("budget_failed", { hostId: host.id, error })
        return undefined
      },
    )
    if (budget === undefined || budget === host.budget || host.session !== session) return
    host.budget = budget
    this.#announce(host)
  }

  #claudeState(host: Host) {
    return this.#backend.claude(host.id, host.lease.settings.accounts)
  }

  /** Re-judges the host's Claude verdict; leaving `enabled` ends its relayed requests (04 §8.11.4.1 step 4). */
  #claude(host: Host) {
    const next = this.#claudeState(host)
    const previous = host.claude
    host.claude = next
    if (next === previous) return
    if (previous === "enabled") this.#relay.abort(host.id)
    this.#backend.log.info("claude_verdict", { hostId: host.id, state: next ?? null })
    this.#notify(host)
  }

  #push(host: Host, event: Broker.PushEvent, data: unknown) {
    const session = host.session
    if (!session) return
    if (session.mode === "drain" && !Broker.DRAIN_PUSHES.includes(event)) return
    session.channel.send({ type: "push", event, data } satisfies Broker.Push)
  }

  async #flushAudit(host: Host) {
    const now = this.#backend.now()
    const due = [...host.lease.audit].filter(([, entry]) => now - entry.firstAt >= Broker.AUDIT_WINDOW_MS)
    for (const [accountID, entry] of due) {
      host.lease.audit.delete(accountID)
      await this.#backend
        .event({
          type: "remote.lease.issued",
          accountID,
          data: { hostId: host.id, accountID, count: entry.count, firstAt: entry.firstAt, lastAt: entry.lastAt },
        })
        .catch(() => undefined)
    }
    if (due.length > 0) await this.#backend.leases(host.id, host.issued).catch(() => undefined)
  }

  #alertOnce(host: Host, code: Alert.Code, severity: Alert.Severity, message: string) {
    const now = this.#backend.now()
    const last = host.alerted.get(code)
    if (last !== undefined && now - last < 60 * 60_000) return
    host.alerted.set(code, now)
    this.#backend.alert({ code, severity, message })
  }

  #notify(host: Host) {
    const status = this.status(host.id)
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(host.id, status)
      } catch (error) {
        this.#backend.log.warn("subscriber_failed", { error })
      }
    }
  }

  #host(hostId: string) {
    const existing = this.#hosts.get(hostId)
    if (existing) return existing
    const host: Host = {
      id: hostId,
      server: undefined,
      port: undefined,
      key: undefined,
      lease: new Lease.HostState(hostId),
      session: undefined,
      failures: [],
      lastFailureAt: null,
      lastConnectedAt: null,
      lastPushAt: null,
      clockSkewMs: null,
      backlog: 0,
      gaps: 0,
      known: undefined,
      budget: undefined,
      issued: {},
      alerted: new Map(),
      claude: undefined,
    }
    this.#hosts.set(hostId, host)
    return host
  }
}

function knownOf(registry: Registry.File | undefined, scope: Contract.AccountScope) {
  const known = new Map<string, Known>()
  for (const account of registry?.accounts ?? [])
    known.set(account.id, {
      status: account.status,
      providerID: account.providerID,
      allowed: Mirror.allowed(account, scope),
    })
  return known
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export * as RemoteHost from "./host.js"

import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionModelRequest,
  SessionRetry,
  SessionWebSocketHandshake,
} from "@opencode/plugin/promise/session"
import path from "node:path"
import { Option, Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { Account, Broker, OwnID, type Kind, type Plugin } from "@own/protocol"
import { CreatorBridge, Hash, type Credentials, type LedgerWriter, type Runtime } from "@own/runtime"
import { Contract } from "../broker/contract.js"
import type { Deps } from "../deps.js"
import { GitHubRelayStub } from "../github/relay-stub.js"
import { ClaudeAgent } from "../claude-agent/agent.js"
import { RemoteClaudeAgent } from "./claude-agent.js"
import type { Logger } from "../logger.js"
import type { Modules } from "../modules.js"
import type { Options } from "../options.js"
import { Client } from "./client.js"
import { Dial } from "./dial.js"
import { EgressStub } from "./egress-stub.js"
import { Grace } from "./grace.js"
import { RemoteLedger } from "./ledger.js"
import { RemoteMirror } from "./mirror.js"
import { Sink } from "./sink.js"
import { Spool } from "./spool.js"

/**
 * own-accounts `mode:"remote"` (04 §8.6–8.7, §9, §10): the process-wide part of a remote service's own-accounts.
 *
 * - Credentials: no vault, no refresh. `model.request` gets the auth headers from a lease of the local broker
 *   (memory only, never disk/env/log); `session-id`/`originator` are added here like `Credentials.codexHeaders` does
 *   (codex; a siwc request gets its session headers in the auth hook, as a local one does).
 * - Fail closed: a request of an own slot that got no credential is redirected to the loopback {@link Sink.Sink}
 *   (`http.request` / `experimental.ws.handshake`), so nothing without auth and no conversation prefix reaches a
 *   provider. When the broker could not be reached, the turn retries within the fail-closed grace; a refusal
 *   (`source_stale`, `needs_reauth`, …) ends it at once.
 * - Registry: the mirror of the local registry ({@link RemoteMirror.Mirror}), `presets.json` included since T3, with
 *   the money state of paid accounts in memory ({@link Api.presetsBudget}); `accounts.*` and preset changes are
 *   refused (`remote_managed`) by the RPC registration.
 * - Observations: new ledger lines, events-ledger lines, limit windows and auth failures go to the spool and are
 *   pushed to the local broker (`observe.push`), which writes the ledger of record with `server = hostId`.
 * - Claude subscription slot (04 §8.11): no credential here at all. A request of `anthropic` goes to the PC's egress
 *   relay through the {@link EgressStub.Stub} with a per-request proof when the PC's mirrored verdict is `enabled`, the
 *   Location has no Claude login of its own, its allowlist is `ok` and the broker is reachable; otherwise to the sink.
 *   The relay's limit windows are the PC's: this host's own-telemetry windows of the slot are not spooled, and its
 *   exhaustion records reach the PC as events.
 * - Local models of the PC (04 §8.14, SLM): a `로컬 모델` account's server is on the PC (its loopback or its network),
 *   which this host cannot reach, and its key (if any) stays there. While the PC's mirror says it relays them
 *   (`localRelay`), such a request goes to the PC's relay through the {@link EgressStub.Stub} with a per-request proof
 *   (`x-own-local`), never to the address the account names (on this host that address is this host itself, where
 *   another user's process may listen); otherwise, or without the broker, to the sink with the reason.
 * - GitHub (16 §8, GH-37): no token here either. The instances' `github_*` tools ask the PC through the broker
 *   ({@link Api.github}), and git and git-lfs reach GitHub through the git relay stub ({@link GitHubRelayStub}) and the
 *   PC's egress relay, which adds the login.
 */

export interface Api {
  headers(account: Account.Info, sessionID: string, directory: string): Promise<Credentials.Auth>
  /** The provider answered 401/403 to a leased credential (telemetry's `logins.unauthorized`). */
  unauthorized(account: Account.Info): void
  /** After `auth.onModelRequest`: remembers whether this request of an own slot carries a credential. */
  afterModelRequest(event: SessionModelRequest, own: boolean): void
  /**
   * The relay or the sink for an `anthropic` request (04 §8.11.4.4), and the sink for an own slot without a
   * credential. `claudeAccount`: the Claude account the conversation is bound to (02 §8.7), named in the proof (v2).
   */
  onHttpRequest(event: SessionHttpRequest, claudeAccount?: string): void
  /** The Claude account a relayed request was sent for (its proof's), for the observers (G4). */
  claudeSigner(request: Request): string | undefined
  onWsHandshake(event: SessionWebSocketHandshake): void
  /**
   * 04 §8.11.4.4: routes this `anthropic` request (after dropping any host credential header): the PC's egress relay
   * when the mirrored verdict is `enabled`, there is no `conflict`, `trust` is `ok` and the broker is reachable
   * (waiting up to `brokerWaitMs` once), else the sink with the reason kept for the retry decision.
   */
  claudeRoute(
    event: SessionModelRequest,
    input: { readonly trust: Plugin.TrustStatus; readonly conflict: boolean },
  ): Promise<void>
  /**
   * 04 §8.14: routes this request of the PC's local model (after dropping any credential header): the PC's relay when
   * the PC relays local models, `trust` is `ok` and the broker is reachable (waiting up to `brokerWaitMs` once), else
   * the sink with the reason kept for the retry decision and the sink's answer.
   */
  localRoute(event: SessionModelRequest, input: { readonly trust: Plugin.TrustStatus }): Promise<void>
  /** 04 §8.14: the PC's local model account behind a provider of this host, if it is one. */
  local(providerID: string): Account.ID | undefined
  /** A relay refusal (`x-own-egress-error`) is recorded for the retry decision; `true` = not a provider answer. */
  onEgressResponse(event: SessionHttpResponse): boolean
  /** The PC's mirrored verdict for this host's Claude slot (04 §8.11.4.3). */
  claude(): Broker.ClaudeRemote | undefined
  /** The PC's Claude Agent accounts this host may use (02 §8.10.13); none = the route is off here. */
  claudeAgent(): Broker.ClaudeAgentRemote | undefined
  /** A response of the sink (skipped by telemetry and the auth-swap check). */
  isSink(url: string): boolean
  /** Decides a retry of an attempt that went to the sink; `true` = handled, skip the normal classification. */
  retryBefore(event: SessionRetry): boolean
  /** After classification: one immediate retry once a rejected lease was invalidated (04 §8.8). */
  retryAfter(event: SessionRetry): void
  health(): {
    readonly broker: { readonly state: Client.State; readonly epoch: number | null; readonly lastSeenAt: number | null }
    readonly mirror: { readonly revision: number | null; readonly fetchedAt: number | null }
  }
  /**
   * Whether the local PC counts each paid account's monthly budget as used up (`MirrorView.presetsBudget`, 07 §5.4
   * step 4), from the last view this process fetched; `undefined` before one or from an older local build. The
   * presets gate treats an account missing here as used up.
   */
  presetsBudget(): Readonly<Record<string, Broker.PresetBudget>> | undefined
  /** The PC's GitHub (16 §8): its broker methods, its changes and this host's git relay stub. */
  readonly github: GitHub
  /** The values the PC sent to this host's MCP servers (04 §13 "MCP", MH). */
  readonly mcp: Mcp
}

/**
 * The values the user sent from the PC to this host's MCP servers (`mcp.values`, normal mode only): kept in this
 * process's memory, never on disk, and asked again after the PC says what it sends changed (`mcp.changed`) or a
 * normal-mode session came up.
 */
export interface Mcp {
  /**
   * The values sent to this host's server `server` (`sent: false`: none are), or `undefined` when the PC was not
   * reached (not connected, another build, no answer); `wait` waits for a reconnect up to the broker wait once.
   */
  values(server: string, options: { readonly wait: boolean }): Promise<Broker.McpValues | undefined>
  /** Called when the PC changed what it sends or a normal-mode session came up (ask again). */
  on(listener: () => void): () => void
}

export interface GitHub {
  /**
   * One `github.*` request, only on a normal-mode session (the PC is this build); `wait`: the first ask of a tool call
   * waits for a reconnect up to the broker wait, a shell's never does.
   */
  ask(
    method: "github.offer" | "github.account" | "github.call",
    params: unknown,
    options: { readonly timeoutMs: number; readonly wait: boolean },
  ): Promise<Client.Reply>
  /** Called when a normal-mode session came up and when the PC says its GitHub changed (ask again). */
  on(listener: () => void): () => void
  /** The git relay stub's address on this host, where callers can be checked. */
  stub(): string | undefined
}

export interface Handle {
  readonly api: Api
  /** The runtime handle an instance's modules use: the same singleton with the spooling ledger. */
  wrap(runtime: Runtime.Handle): Runtime.Handle
  /** Lets the instance raise alerts (the first attached one serves). Returns the detach function. */
  attach(deps: Deps.Deps, modules: Modules.All): () => void
  release(): Promise<void>
}

interface Lease {
  readonly accountID: string
  readonly headers: Readonly<Record<string, string>>
  readonly hash: string
  readonly generation: number
  /** Monotonic ms. */
  readonly deadline: number
  readonly tail: number
  readonly refreshAt: number
}

type Mark =
  | { readonly reason: "unavailable"; readonly providerID: string; readonly at: number }
  | { readonly reason: "refused"; readonly providerID: string; readonly error: Broker.HeadersError; readonly at: number }
  | { readonly reason: "blocked"; readonly providerID: string; readonly at: number }
  /** 04 §8.11.4.4: the PC's verdict was not `enabled`, or this Location has its own Claude login (`conflict`). */
  | {
      readonly reason: "claude"
      readonly providerID: string
      readonly code: Plugin.ClaudeRemoteState | "conflict"
      readonly at: number
    }
  /** 04 §8.14: the PC does not relay local models (an older PC). */
  | { readonly reason: "local"; readonly providerID: string; readonly code: "local_pc_old"; readonly at: number }

type Fetched =
  | { readonly type: "lease"; readonly lease: Lease }
  | { readonly type: "unavailable" }
  | { readonly type: "refused"; readonly error: Broker.HeadersError }

interface Shared {
  readonly api: Api
  readonly ledger: RemoteLedger.Writer
  readonly attached: Array<{ readonly deps: Deps.Deps; readonly modules: Modules.All }>
  readonly close: () => Promise<void>
  refs: number
}

const MEMORY = 4_000

/** Host request headers the relay never gets (the PC drops them again, 04 §8.11.5). */
const HOST_CREDENTIALS = new Set(["authorization", "x-api-key", "cookie"])

/**
 * `claude_remote_refused` / `claude_remote_conflict` texts (04 §8.11.13). `not_ready` does not say why (an expired
 * login, the account list or the plugin not ready yet), so it names each remedy with its case (CS).
 */
const REFUSED: Readonly<Record<string, string>> = {
  off: "PC에서 이 호스트의 Claude 구독이 꺼져 있어 이번 턴을 멈췄습니다. PC의 Claude 카드에서 켜세요.",
  host_scope: "이 호스트의 계정 범위에 Claude 구독이 없어 이번 턴을 멈췄습니다.",
  consent: "PC에서 원격 사용 동의가 필요해 이번 턴을 멈췄습니다.",
  not_ready:
    "PC의 Claude 구독이 준비되지 않아 이번 턴을 멈췄습니다. Claude Code와 같은 로그인이 만료됐으면 PC의 Claude Code에서 요청을 한 번 보내거나, PC의 계정 화면에서 [own 전용 로그인으로 바꾸기]를 누르세요. 다른 로그인이 만료됐으면 그 계정의 [다시 로그인]을 누르세요. 서비스가 막 시작했으면 잠시 뒤 다시 보내고, 계속되면 PC에서 서비스를 다시 시작하세요.",
  billing: "PC의 Anthropic 연결이 API 키라 원격에서 Claude 구독을 쓰지 않습니다.",
  needs_reauth: "Anthropic이 Claude 로그인을 거절했습니다. PC에서 Claude Code에 다시 로그인한 뒤 계속하세요.",
  too_large: "요청이 너무 커서(32 MiB 초과) PC가 중계하지 않았습니다.",
  bad_request: "PC가 이 요청을 중계하지 않았습니다(요청 형식이 맞지 않습니다).",
  conflict: "이 호스트에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 Claude 구독을 쓰지 않습니다.",
}

const decodeHeaders = Schema.decodeUnknownOption(Broker.HeadersResult)
const decodeAck = Schema.decodeUnknownOption(Broker.ObserveAck)
const decodeQuota = Schema.decodeUnknownOption(Broker.QuotaUpdated)
const decodeStatus = Schema.decodeUnknownOption(Broker.AccountStatus)
const decodeRevoke = Schema.decodeUnknownOption(Broker.Revoke)
const decodeEgressError = Schema.decodeUnknownOption(Broker.EgressError)
const decodeLocalError = Schema.decodeUnknownOption(Broker.LocalError)
const decodeMcpValues = Schema.decodeUnknownOption(Broker.McpValues)

/** A local model's request carries no credential from this host: the PC adds the key (04 §8.14). */
const LOCAL_NONE: Credentials.Auth = { ok: true, headers: {}, hash: "", expiresAt: null, source: "vault" }

export function key(buildId: string) {
  return Symbol.for(`own-open-code.accounts-remote/${buildId}`)
}

function slots() {
  return globalThis as unknown as Record<symbol, Promise<Shared> | undefined>
}

/** Acquires the build's remote host (created on first use; concurrent setups share it). */
export async function acquire(input: {
  readonly buildId: string
  readonly version: string
  readonly runtime: Runtime.Handle
  readonly options: Options.Info
  readonly log: Logger.Logger
}): Promise<Handle> {
  const created = slots()[key(input.buildId)] ?? create(input)
  slots()[key(input.buildId)] = created
  const shared = await created.catch((error: unknown) => {
    if (slots()[key(input.buildId)] === created) delete slots()[key(input.buildId)]
    throw error
  })
  shared.refs++
  let released = false
  return {
    api: shared.api,
    wrap: (runtime) => ({ ...runtime, ledger: shared.ledger }),
    attach: (deps, modules) => {
      const entry = { deps, modules }
      if (deps.location.control) shared.attached.unshift(entry)
      else shared.attached.push(entry)
      return () => {
        const index = shared.attached.indexOf(entry)
        if (index >= 0) shared.attached.splice(index, 1)
      }
    },
    release: async () => {
      if (released) return
      released = true
      shared.refs--
      if (shared.refs > 0) return
      if (slots()[key(input.buildId)] === created) delete slots()[key(input.buildId)]
      await shared.close()
    },
  }
}

async function create(input: {
  readonly buildId: string
  readonly version: string
  readonly runtime: Runtime.Handle
  readonly options: Options.Info
  readonly log: Logger.Logger
}): Promise<Shared> {
  const runtime = input.runtime
  const log = input.log.child("remote")
  const testing = input.options.broker
  const mono = () => performance.now()
  const spool = await Spool.Store.open({ dir: path.join(runtime.layout.root, "spool"), limits: testing?.spoolLimits })
  const sink = await Sink.start()
  const mirror = new RemoteMirror.Mirror({ runtime, log: log.child("mirror"), now: Date.now })
  const dial = testing?.dial === "placeholder" ? Dial.placeholder : Dial.system
  const attached: Shared["attached"] = []
  const stops: Array<() => void> = []

  const leases = new Map<string, Lease>()
  const inflight = new Map<string, Promise<Fetched>>()
  const invalidations = new Map<string, string>()
  const retryOnce = new Set<string>()
  const marks = new Map<string, Mark>()
  const graces = new Map<string, number>()
  const sinks = new Set<string>()
  const alerted = new Set<string>()
  /** Sessions whose `anthropic` request goes to the PC's relay (04 §8.11.4.4). */
  const relays = new Set<string>()
  /** Sessions and providers whose local model request goes to the PC's relay, with the account (04 §8.14). */
  const locals = new Map<string, Account.ID>()
  /** The local relay's last refusal per session (`x-own-local-error`), consumed by the next retry decision. */
  const localRefusals = new Map<string, Broker.LocalError>()
  /** The Claude account each relayed request's proof named (02 §8.7, G4), for the observers. */
  const signers = new WeakMap<Request, string>()
  /** The relay's last refusal per session (`x-own-egress-error`), consumed by the next retry decision. */
  const refusals = new Map<string, Broker.EgressError>()
  /** Sessions that had their one immediate retry after a `mac` refusal (the epoch may have been changing). */
  const macRetried = new Set<string>()
  /** The instances' GitHub listeners (a normal session came up, the PC's GitHub changed). */
  const githubListeners = new Set<() => void>()
  const githubChanged = () => {
    for (const listener of [...githubListeners]) {
      try {
        listener()
      } catch (error) {
        log.warn("github_listener_failed", { error })
      }
    }
  }
  /** The MCP values the PC sent, by this host's server id (MH); dropped whenever the PC may have changed them. */
  const mcpValues = new Map<string, Broker.McpValues>()
  const mcpListeners = new Set<() => void>()
  const mcpChanged = () => {
    mcpValues.clear()
    for (const listener of [...mcpListeners]) {
      try {
        listener()
      } catch (error) {
        log.warn("mcp_listener_failed", { error })
      }
    }
  }
  /** own.creator's mirror on this host (17 §10): a normal session came up, or the PC's extensions changed. */
  const creatorListeners = new Set<() => void>()
  const creatorChanged = () => {
    for (const listener of [...creatorListeners]) {
      try {
        listener()
      } catch (error) {
        log.warn("creator_listener_failed", { error })
      }
    }
  }
  const settings = {
    graceSeconds: Broker.GRACE_SECONDS_DEFAULT,
    brokerWaitMs: Broker.BROKER_WAIT_SECONDS_DEFAULT * 1000,
    from: "",
  }
  let meta = RemoteMirror.metaOf(runtime.registry.cached() ?? (await runtime.registry.read().catch(() => undefined)))

  const alert = (input: {
    readonly code: "broker_unavailable" | "codex_source_stale" | "claude_remote_refused" | "claude_remote_conflict"
    readonly message: string
    readonly sessionID: string
    readonly accountID?: string
  }) => {
    const entry = attached[0]
    if (!entry) return
    try {
      entry.modules.telemetry.alert({ severity: input.code === "broker_unavailable" ? "error" : "warning", ...input })
    } catch (error) {
      log.warn("alert_failed", { code: input.code, error })
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Spool → observe.push

  const flushing = { running: false, again: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const flush = async () => {
    if (flushing.running) {
      flushing.again = true
      return
    }
    flushing.running = true
    try {
      do {
        flushing.again = false
        while (client.connected()) {
          const batch = spool.pending()
          if (batch.length === 0) break
          const reply = await client.request(
            "observe.push",
            { streamId: spool.streamId, fromSeq: batch[0]!.seq, items: batch } satisfies Broker.ObservePush,
            15_000,
          )
          const ack = reply.ok ? Option.getOrUndefined(decodeAck(reply.result)) : undefined
          if (!ack) break
          await spool.ack(ack.ackThrough)
          // Stopped at an item the local build cannot read: it stays until a later connection (04 §5.7).
          if (ack.ackThrough < batch.at(-1)!.seq) break
        }
      } while (flushing.again && client.connected())
    } catch (error) {
      log.warn("spool_flush_failed", { error })
    } finally {
      flushing.running = false
    }
  }
  const schedule = () => {
    if (flushing.timer) return
    flushing.timer = setTimeout(() => {
      flushing.timer = undefined
      void flush()
    }, 50)
    flushing.timer.unref?.()
  }
  const observe = (type: Broker.ItemType, payload: unknown) => {
    spool.add(type, payload)
    schedule()
  }

  const ledger = new RemoteLedger.Writer({
    inner: runtime.ledger,
    dir: runtime.layout.ledger,
    now: Date.now,
    onUsage: (eid, line) => observe("ledger", { eid, line } satisfies Broker.LedgerPayload),
    onEvent: (event: LedgerWriter.Event) =>
      observe("event", {
        eid: event.eid,
        ts: event.ts,
        type: event.type,
        ...(event.accountID === undefined ? {} : { accountID: event.accountID }),
        ...(event.providerID === undefined ? {} : { providerID: event.providerID }),
        ...(event.sessionID === undefined ? {} : { sessionID: event.sessionID }),
        ...(event.data === undefined ? {} : { data: event.data }),
      }),
  })
  // Limit windows this service observed itself (pushed windows are merged without a broadcast). The Claude slot's are
  // the PC relay's observations already (04 §8.11.10): the PC would refuse them, so they stay here.
  stops.push(
    runtime.broadcast.on("limits.updated", (change) => {
      const windows = change.windows.filter((window) => window.accountID !== Account.ID.claudeSlot)
      if (windows.length > 0) observe("limits", { windows })
    }),
  )
  // own-telemetry records an exhaustion of the Claude slot in the plain runtime ledger; the PC gets it as an event.
  stops.push(
    runtime.broadcast.on("exhausted", (change) => {
      if (change.providerID !== Provider.ID.anthropic) return
      const at = Date.now()
      observe("event", {
        eid: `exh_${OwnID.ulid(at)}`,
        ts: at,
        type: "exhaustion",
        accountID: Account.ID.claudeSlot,
        providerID: Provider.ID.anthropic,
        ...(change.sessionID === undefined ? {} : { sessionID: change.sessionID }),
        data: {
          class: change.exhaustion.class,
          windowId: change.exhaustion.windowId,
          until: change.exhaustion.until,
        },
      } satisfies Broker.EventPayload)
    }),
  )

  // ---------------------------------------------------------------------------------------------------------------
  // Broker client

  /** `broker.mirrorDelayMs` (tests) delays only the first sync of this process. */
  let firstMirror = true

  const ping = async () => {
    const stats = spool.stats()
    await client.request("ping", { remoteNow: Date.now(), backlog: stats.backlog, gaps: stats.gaps }, 5_000)
  }
  const pinger = setInterval(() => {
    if (client.connected()) void ping()
  }, testing?.pingMs ?? Broker.PING_INTERVAL_MS)
  pinger.unref?.()

  const dropAccount = async (accountID: string) => {
    for (const [providerID, lease] of leases) if (lease.accountID === accountID) leases.delete(providerID)
  }

  // Mirror syncs a push started: `close` waits for them, so none writes into an OWN_HOME that is being removed.
  const syncing = new Set<Promise<void>>()
  const onPush = (push: Broker.Push) => {
    switch (push.event) {
      case "mirror.changed": {
        if (client.state !== "connected") return
        const work = mirror
          .sync(client, settings.from)
          .then(async () => {
            meta = await mirror.meta()
          })
          .catch((error: unknown) => log.warn("mirror_sync_failed", { error }))
          .finally(() => syncing.delete(work))
        syncing.add(work)
        return
      }
      case "quota.updated": {
        const data = Option.getOrUndefined(decodeQuota(push.data))
        if (!data) return
        // A window the PC forgot (a removed budget) goes here too; otherwise this store only merges.
        data.dropped?.forEach((window) => runtime.limits.drop(window.accountID, window.id))
        runtime.limits.upsert(data.windows)
        return
      }
      case "account.status": {
        const data = Option.getOrUndefined(decodeStatus(push.data))
        if (!data) return
        // Host scope (a linked account's source_stale here), or a drain session without mirror updates (04 §5.7).
        if (data.scope === "host" || client.state === "drain")
          void mirror.override(data.accountID, data.status === "ready" ? undefined : data.status).catch(
            (error: unknown) => log.warn("mirror_override_failed", { error }),
          )
        if (data.status !== "ready") void dropAccount(data.accountID)
        return
      }
      case "github.changed":
        githubChanged()
        return
      case "creator.changed":
        creatorChanged()
        return
      case "mcp.changed":
        mcpChanged()
        return
      case "claudeAgent.data":
      case "claudeAgent.exit":
        agent.push(push)
        return
      case "revoke": {
        const data = Option.getOrUndefined(decodeRevoke(push.data))
        if (!data) return
        const lease = leases.get(data.providerID)
        if (lease && (data.generation === undefined || lease.generation <= data.generation))
          leases.delete(data.providerID)
        return
      }
      default:
        return
    }
  }

  const client = new Client.BrokerClient({
    version: input.version,
    buildId: input.buildId,
    streamId: () => spool.streamId,
    dial,
    log: log.child("client"),
    onReady: (ready) => {
      settings.graceSeconds = ready.settings.failClosedGraceSeconds
      settings.brokerWaitMs = ready.settings.brokerWaitMs
      settings.from = ready.from
      const work = (async () => {
        // 17 §10: in drain the creator mirror asks too, hears `skew_drain` and withdraws its code plugins (CRM-34).
        if (ready.mode !== "normal") creatorChanged()
        if (ready.mode === "normal") {
          githubChanged()
          creatorChanged()
          mcpChanged()
          const delay = firstMirror ? testing?.mirrorDelayMs : undefined
          firstMirror = false
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          await mirror.sync(client, ready.from)
          meta = await mirror.meta()
        }
        await ping()
        await flush()
      })()
        .catch((error: unknown) => log.warn("ready_work_failed", { error }))
        .finally(() => syncing.delete(work))
      syncing.add(work)
    },
    onPush,
    onState: (state) => {
      log.debug("broker_state", { state })
      // 02 §8.10.13: the PC closes a lost session's Claude Agent streams; the provider here learns it at once.
      if (state !== "connected") agent.drop()
    },
  })

  // 02 §8.10.13: this service's Claude Agent provider runs its claude on the PC through these streams (core P-052).
  const agent = RemoteClaudeAgent.make({
    request: (method, params, timeoutMs) => client.request(method, params, timeoutMs),
    normal: () => client.state === "connected",
    wait: () => client.waitConnected(settings.brokerWaitMs),
    log: log.child("claude-agent"),
  })
  const channel = ClaudeAgent.defaults().channel()
  channel.relay = agent.transport
  stops.push(() => {
    if (channel.relay === agent.transport) channel.relay = undefined
  })

  const facade: Contract.RemoteBrokerClient = {
    arm: (armInput) => client.arm(armInput),
    status: () => {
      const now = mono()
      return {
        state: client.state,
        epoch: client.epoch,
        leases: [...leases].map(([providerID, lease]) => ({ providerID, deadlineInMs: Math.max(0, Math.round(lease.deadline - now)) })),
        mirror: { revision: meta?.registryRevision ?? null, fetchedAt: meta?.fetchedAt ?? null },
        spool: spool.stats(),
      }
    },
  }
  stops.push(Contract.provide(Contract.remoteKey(input.buildId), facade))
  const stub = await EgressStub.start({ endpoint: () => client.egress, dial, log: log.child("egress") })
  // 16 §8: git and git-lfs of this host reach GitHub only through the PC; off Windows and Linux no caller check, none.
  const gitStub = GitHubRelayStub.CHECKED
    ? GitHubRelayStub.start({
        proof: (request) => client.githubProof(request),
        egress: () => (client.egress === undefined ? undefined : stub.url),
        log: log.child("github"),
      })
    : undefined

  // ---------------------------------------------------------------------------------------------------------------
  // Leases

  const fetch = (account: Account.Info, sessionID: string, directory: string, wait: boolean): Promise<Fetched> => {
    const providerID = account.providerID
    const running = inflight.get(providerID)
    if (running) return running
    const run = (async (): Promise<Fetched> => {
      if (!client.connected()) {
        const already = marks.get(sessionID)?.reason === "unavailable"
        if (!wait || already) return { type: "unavailable" }
        if (!(await client.waitConnected(settings.brokerWaitMs))) return { type: "unavailable" }
      }
      const invalidate = invalidations.get(providerID)
      const sent = mono()
      const reply = await client.request(
        "headers.get",
        {
          providerID: account.providerID,
          kind: account.kind,
          sessionID,
          directory,
          allowlist: "ok",
          ...(invalidate === undefined ? {} : { invalidate }),
        } satisfies Broker.HeadersGet,
        Broker.HEADERS_TIMEOUT_MS,
      )
      if (!reply.ok) return { type: "unavailable" }
      const received = mono()
      invalidations.delete(providerID)
      const result = Option.getOrUndefined(decodeHeaders(reply.result))
      if (!result) return { type: "unavailable" }
      if ("error" in result) {
        leases.delete(providerID)
        return { type: "refused", error: result.error }
      }
      const ttl = result.ttlMs
      const lease: Lease = {
        accountID: account.id,
        headers: result.headers,
        hash: result.authHash8,
        generation: result.generation,
        // 04 §8.5: the remote's own monotonic clock from the receive time, minus half the round trip.
        deadline: received + ttl - (received - sent) / 2,
        tail: Math.min(Broker.LEASE_TAIL_MS, ttl / 4),
        refreshAt: received + ttl * Broker.LEASE_REFRESH_SHARE,
      }
      remember(leases, providerID, lease)
      return { type: "lease", lease }
    })().finally(() => inflight.delete(providerID))
    inflight.set(providerID, run)
    return run
  }

  const granted = (account: Account.Info, lease: Lease, sessionID: string): Credentials.Auth => ({
    ok: true,
    // Same assembly as a local request (04 §8.6 step 6): the leased credential plus the session headers.
    headers: {
      ...lease.headers,
      ...(account.kind === "codex" ? { "session-id": sessionID, originator: "opencode" } : {}),
    },
    hash: Hash.auth(lease.headers)[0]?.hash ?? lease.hash,
    expiresAt: Date.now() + Math.max(0, lease.deadline - mono()),
    source: "vault",
  })

  const clearMarks = (sessionID: string) => {
    marks.delete(sessionID)
    graces.delete(sessionID)
  }

  const sessionKey = (sessionID: string, providerID: string) => `${sessionID}\u0000${providerID}`

  /**
   * The same request at the sink (path and query kept, the body a copy or the original), naming why it went there
   * (`x-own-fail-reason`), so the sink's answer tells the conversation the reason (SLM).
   */
  const toSink = (request: Request, sessionID: string, providerID: string) => {
    const target = new URL(request.url)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body
    const headers = new Headers(request.headers)
    headers.set(Broker.FAIL_REASON_HEADER, reasonOf(marks.get(sessionID), providerID))
    // SAFETY: `duplex` is required by fetch for a streamed body; the DOM `RequestInit` type does not list it.
    return new Request(`${sink.url}${target.pathname}${target.search}`, {
      method: request.method,
      headers,
      body,
      duplex: "half",
    } as RequestInit)
  }

  /**
   * 04 §8.14: the PC's account of a provider whose requests go through the PC (a local model, or a `compat` account on
   * the PC's loopback; the mirrored registry's), if it is one.
   */
  const localOf = (providerID: string) => {
    const registry = runtime.registry.cached()
    const account = registry?.accounts.find((item) => item.providerID === providerID && item.status !== "retired")
    const slot = registry?.slots[providerID as Kind.ProviderID]
    return account && Broker.viaPc(account, slot?.baseURL) ? account.id : undefined
  }

  /** The fail-closed grace of an attempt that could not reach the broker (04 §8.7). */
  const grace = (event: SessionRetry) => {
    // The grace counts from the first failure of this model call: core's first retry of a call is attempt 2.
    const previous = graces.get(event.sessionID)
    const deadline = previous === undefined || event.attempt <= 2 ? Date.now() + settings.graceSeconds * 1000 : previous
    graces.set(event.sessionID, deadline)
    const decision = Grace.decide({ now: Date.now(), deadline, attempt: event.attempt })
    event.decision = decision
    if (!decision.retry && !alerted.has(`${event.sessionID}:${deadline}`)) {
      alerted.add(`${event.sessionID}:${deadline}`)
      alert({
        code: "broker_unavailable",
        sessionID: event.sessionID,
        message: "로컬 PC의 자격 증명 브로커에 닿지 못해 이번 턴을 멈췄습니다. 연결한 뒤 계속하세요.",
      })
    }
    return true
  }

  /** A refusal of the Claude relay or its route that ends the turn: `{retry:false}`, alerted once per session and code. */
  const refuse = (event: SessionRetry, code: string) => {
    event.decision = { retry: false }
    if (alerted.has(`${event.sessionID}:claude:${code}`)) return true
    alerted.add(`${event.sessionID}:claude:${code}`)
    alert({
      code: code === "conflict" ? "claude_remote_conflict" : "claude_remote_refused",
      sessionID: event.sessionID,
      accountID: Account.ID.claudeSlot,
      message: REFUSED[code] ?? `PC가 이 호스트의 Claude 구독 요청을 중계하지 않았습니다(${code}).`,
    })
    return true
  }

  /** 04 §8.11.8: the retry of an attempt the relay refused (`x-own-egress-error`). */
  const relayRetry = (event: SessionRetry, code: Broker.EgressError) => {
    if (code === "upstream_unreachable") return false
    if (code === "busy" || code === "rate_limited") {
      event.decision = { retry: true, delay: 2_000 }
      return true
    }
    if (code === "mac") {
      if (macRetried.has(event.sessionID)) return grace(event)
      macRetried.add(event.sessionID)
      event.decision = { retry: true, delay: 0 }
      return true
    }
    return refuse(event, code)
  }

  /** 04 §8.14: the retry of an attempt the local relay refused (`x-own-local-error`). */
  const localRetry = (event: SessionRetry, code: Broker.LocalError) => {
    // The PC could not reach its model server: core retries it as any connection failure of a conversation there.
    if (code === "upstream_unreachable") return false
    if (code === "busy" || code === "rate_limited") {
      event.decision = { retry: true, delay: 2_000 }
      return true
    }
    if (code === "mac") {
      if (macRetried.has(event.sessionID)) return grace(event)
      macRetried.add(event.sessionID)
      event.decision = { retry: true, delay: 0 }
      return true
    }
    // The refusal's line is on the error card (the relay's answer); the turn ends.
    event.decision = { retry: false }
    return true
  }

  const api: Api = {
    headers: async (account, sessionID, directory) => {
      // 04 §8.14: no lease for an account the PC relays; its key (if any) never leaves the PC.
      if (mirror.localRelay() && localOf(account.providerID) === account.id) return LOCAL_NONE
      const providerID = account.providerID
      const current = leases.get(providerID)
      const now = mono()
      if (current && current.accountID === account.id && now < current.deadline - current.tail) {
        if (now >= current.refreshAt && client.connected()) void fetch(account, sessionID, directory, false)
        clearMarks(sessionID)
        return granted(account, current, sessionID)
      }
      const fetched = await fetch(account, sessionID, directory, true).catch((): Fetched => ({ type: "unavailable" }))
      if (fetched.type === "lease") {
        clearMarks(sessionID)
        return granted(account, fetched.lease, sessionID)
      }
      if (fetched.type === "unavailable") {
        const previous = marks.get(sessionID)
        if (previous?.reason !== "unavailable") remember(marks, sessionID, { reason: "unavailable", providerID, at: Date.now() })
        return { ok: false, problem: "vault_unavailable", detail: "broker_unavailable" }
      }
      remember(marks, sessionID, { reason: "refused", providerID, error: fetched.error, at: Date.now() })
      return {
        ok: false,
        problem:
          fetched.error === "source_stale"
            ? "source_stale"
            : fetched.error === "needs_reauth"
              ? "needs_reauth"
              : "vault_unavailable",
        detail: fetched.error,
      }
    },

    unauthorized: (account) => {
      const lease = leases.get(account.providerID)
      if (!lease || lease.accountID !== account.id) return
      leases.delete(account.providerID)
      invalidations.set(account.providerID, lease.hash)
      retryOnce.add(account.providerID)
      observe("authFailure", { providerID: account.providerID, authHash8: lease.hash, status: 401 } satisfies Broker.AuthFailurePayload)
    },

    afterModelRequest: (event, own) => {
      if (!own) return
      const keyOf = sessionKey(event.sessionID, event.model.providerID)
      if (Hash.auth(event.headers).length > 0) {
        sinks.delete(keyOf)
        return
      }
      sinks.add(keyOf)
      if (sinks.size > MEMORY) sinks.delete(sinks.values().next().value!)
      if (!marks.has(event.sessionID))
        remember(marks, event.sessionID, { reason: "blocked", providerID: event.model.providerID, at: Date.now() })
    },

    claudeRoute: async (event, routing) => {
      for (const name of Object.keys(event.headers))
        if (name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key") delete event.headers[name]
      const providerID = event.model.providerID
      const keyOf = sessionKey(event.sessionID, providerID)
      relays.delete(keyOf)
      sinks.add(keyOf)
      if (sinks.size > MEMORY) sinks.delete(sinks.values().next().value!)
      const state = mirror.claude()?.state ?? "not_ready"
      const at = Date.now()
      if (state !== "enabled") return remember(marks, event.sessionID, { reason: "claude", providerID, code: state, at })
      if (routing.conflict)
        return remember(marks, event.sessionID, { reason: "claude", providerID, code: "conflict", at })
      if (routing.trust !== "ok") return remember(marks, event.sessionID, { reason: "blocked", providerID, at })
      if (!client.connected() || client.egress === undefined) {
        // The first attempt of a call waits for a reconnect like a lease does (04 §8.6 step 4); later ones do not.
        const already = marks.get(event.sessionID)?.reason === "unavailable"
        const reached = !already && (await client.waitConnected(settings.brokerWaitMs)) && client.egress !== undefined
        if (!reached) {
          if (!already) remember(marks, event.sessionID, { reason: "unavailable", providerID, at })
          return
        }
      }
      sinks.delete(keyOf)
      relays.add(keyOf)
      if (relays.size > MEMORY) relays.delete(relays.values().next().value!)
      clearMarks(event.sessionID)
    },

    localRoute: async (event, routing) => {
      for (const name of Object.keys(event.headers))
        if (name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key") delete event.headers[name]
      const providerID = event.model.providerID
      const accountID = localOf(providerID)
      const keyOf = sessionKey(event.sessionID, providerID)
      locals.delete(keyOf)
      sinks.add(keyOf)
      if (sinks.size > MEMORY) sinks.delete(sinks.values().next().value!)
      if (accountID === undefined) return
      const at = Date.now()
      if (!mirror.localRelay())
        return remember(marks, event.sessionID, { reason: "local", providerID, code: "local_pc_old", at })
      if (routing.trust !== "ok") return remember(marks, event.sessionID, { reason: "blocked", providerID, at })
      if (!client.connected() || client.egress === undefined) {
        // The first attempt of a call waits for a reconnect like a lease does (04 §8.6 step 4); later ones do not.
        const already = marks.get(event.sessionID)?.reason === "unavailable"
        const reached = !already && (await client.waitConnected(settings.brokerWaitMs)) && client.egress !== undefined
        if (!reached) {
          if (!already) remember(marks, event.sessionID, { reason: "unavailable", providerID, at })
          return
        }
      }
      sinks.delete(keyOf)
      remember(locals, keyOf, accountID)
      clearMarks(event.sessionID)
    },

    local: (providerID) => localOf(providerID),

    onEgressResponse: (event) => {
      const local = Option.getOrUndefined(
        decodeLocalError(event.response.headers.get(Broker.LOCAL_ERROR_HEADER) ?? undefined),
      )
      if (local !== undefined) {
        remember(localRefusals, event.sessionID, local)
        return true
      }
      if (event.response.headers.get(Broker.LOCAL_HEADER) === "1") {
        localRefusals.delete(event.sessionID)
        macRetried.delete(event.sessionID)
        return false
      }
      const code = Option.getOrUndefined(
        decodeEgressError(event.response.headers.get(Broker.EGRESS_ERROR_HEADER) ?? undefined),
      )
      if (code === undefined) {
        if (event.response.headers.get(Broker.EGRESS_HEADER) === "1") {
          refusals.delete(event.sessionID)
          macRetried.delete(event.sessionID)
        }
        return false
      }
      remember(refusals, event.sessionID, code)
      return true
    },

    claude: () => mirror.claude(),

    claudeAgent: () => mirror.claudeAgent(),

    claudeSigner: (request) => signers.get(request),

    onHttpRequest: (event, claudeAccount) => {
      const providerID = event.model.providerID
      const keyOf = sessionKey(event.sessionID, providerID)
      const localID = localOf(providerID)
      if (localID !== undefined) {
        // 04 §8.14: the sink first, the PC's relay last; never the account's address, which here is this host itself.
        const original = event.request
        event.request = toSink(original.clone(), event.sessionID, providerID)
        if (locals.get(keyOf) !== localID) return
        const target = new URL(original.url)
        const path = `${target.pathname}${target.search}`
        const proof = client.localProof({ accountID: localID, method: original.method, path })
        if (proof === undefined) return
        const headers = new Headers()
        original.headers.forEach((value, name) => {
          if (!HOST_CREDENTIALS.has(name.toLowerCase())) headers.set(name, value)
        })
        headers.set(Broker.LOCAL_HEADER, proof)
        const body = original.method === "GET" || original.method === "HEAD" ? undefined : original.body
        // SAFETY: `duplex` is required by fetch for a streamed body; the DOM `RequestInit` type does not list it.
        event.request = new Request(`${stub.url}${Broker.LOCAL_PATH_PREFIX}${localID}${path}`, {
          method: original.method,
          headers,
          body,
          signal: original.signal,
          duplex: "half",
        } as RequestInit)
        return
      }
      if (providerID === Provider.ID.anthropic) {
        // 04 §8.11.4.4 step 3: the sink first, the relay last, so any failure in between leaves the request at the sink.
        const original = event.request
        event.request = toSink(original.clone(), event.sessionID, providerID)
        if (!relays.has(keyOf) || claudeAccount === undefined) return
        const proof = client.egressProof(claudeAccount)
        if (proof === undefined) return
        const target = new URL(original.url)
        const headers = new Headers()
        original.headers.forEach((value, name) => {
          const lower = name.toLowerCase()
          if (!HOST_CREDENTIALS.has(lower) && !lower.startsWith("x-stainless-")) headers.set(name, value)
        })
        headers.set(Broker.EGRESS_HEADER, proof)
        // SAFETY: `duplex` is required by fetch for a streamed body; the DOM `RequestInit` type does not list it.
        event.request = new Request(`${stub.url}${target.pathname}${target.search}`, {
          method: original.method,
          headers,
          body: original.body,
          signal: original.signal,
          duplex: "half",
        } as RequestInit)
        signers.set(event.request, claudeAccount)
        return
      }
      if (!sinks.has(keyOf)) return
      event.request = toSink(event.request, event.sessionID, providerID)
    },

    onWsHandshake: (event) => {
      // The relays are HTTP only (04 §8.11.15, §8.14): an `anthropic` or local model WebSocket always meets the sink.
      const providerID = event.model.providerID
      if (
        providerID !== Provider.ID.anthropic &&
        localOf(providerID) === undefined &&
        !sinks.has(sessionKey(event.sessionID, providerID))
      )
        return
      event.url = sink.wsURL
    },

    isSink: (url) => url.startsWith(sink.url) || url.startsWith(sink.wsURL),

    retryBefore: (event) => {
      const providerID = event.model.providerID
      const keyOf = sessionKey(event.sessionID, providerID)
      if (locals.has(keyOf)) {
        const code = localRefusals.get(event.sessionID)
        localRefusals.delete(event.sessionID)
        // An answer of the model server itself: the normal classification, as in a conversation of the PC.
        return code === undefined ? false : localRetry(event, code)
      }
      if (providerID === Provider.ID.anthropic && relays.has(keyOf)) {
        const code = refusals.get(event.sessionID)
        refusals.delete(event.sessionID)
        // A relayed answer of Anthropic itself: the normal classification (own-telemetry decides long stalls).
        return code === undefined ? false : relayRetry(event, code)
      }
      if (!sinks.has(keyOf)) return false
      const mark = marks.get(event.sessionID)
      if (mark?.reason === "unavailable" && mark.providerID === providerID) return grace(event)
      if (mark?.reason === "claude" && mark.providerID === providerID) return refuse(event, mark.code)
      // The PC relays no local model (an older PC): the sink's answer says to update it; the turn ends.
      // Refused by the broker or no credential at all: no grace (04 §8.5, §8.7).
      event.decision = { retry: false }
      if (mark?.reason === "refused" && mark.error === "source_stale" && !alerted.has(`${event.sessionID}:stale`)) {
        alerted.add(`${event.sessionID}:stale`)
        alert({
          code: "codex_source_stale",
          sessionID: event.sessionID,
          message: "이전 앱이 로그인을 갱신하지 않았습니다 — 이전 앱에서 이 프로필을 한 번 실행하세요 (또는 takeover로 전환)",
        })
      }
      return true
    },

    retryAfter: (event) => {
      if (!retryOnce.delete(event.model.providerID)) return
      // 04 §8.8: a valid lease got 401 → `invalidate` goes with the next `headers.get`; retry once right away.
      event.decision = { retry: true, delay: 0 }
    },

    health: () => ({
      broker: { state: client.state, epoch: client.epoch, lastSeenAt: client.lastSeenAt },
      mirror: { revision: meta?.registryRevision ?? null, fetchedAt: meta?.fetchedAt ?? null },
    }),

    presetsBudget: () => mirror.presetsBudget(),

    github: {
      ask: async (method, params, options) => {
        // The `github.*` methods are this build's: a drain-mode session (another build) never gets them.
        const normal = () => client.state === "connected"
        const ready = normal() || (options.wait && (await client.waitConnected(settings.brokerWaitMs)) && normal())
        if (!ready) return { ok: false, error: "unavailable" }
        return client.request(method, params, options.timeoutMs)
      },
      on: (listener) => {
        githubListeners.add(listener)
        return () => void githubListeners.delete(listener)
      },
      stub: () => gitStub?.url,
    },

    mcp: {
      values: async (server, options) => {
        const known = mcpValues.get(server)
        if (known) return known
        // `mcp.values` is this build's: a drain-mode session (another build) never gets it.
        const normal = () => client.state === "connected"
        const ready = normal() || (options.wait && (await client.waitConnected(settings.brokerWaitMs)) && normal())
        if (!ready) return undefined
        const reply = await client.request(
          "mcp.values",
          { server } satisfies Broker.McpValuesGet,
          Broker.MCP_ASK_TIMEOUT_MS,
        )
        const values = reply.ok ? Option.getOrUndefined(decodeMcpValues(reply.result)) : undefined
        if (values) mcpValues.set(server, values)
        return values
      },
      on: (listener) => {
        mcpListeners.add(listener)
        return () => void mcpListeners.delete(listener)
      },
    },
  }

  // 17 §10: own.creator's mirror asks the PC through this session; only normal mode (the PC is this build) answers.
  stops.push(
    CreatorBridge.provideLink({
      // In drain the PC answers no `creator.*`: the mirror hears it as the PC's `skew_drain` (CRM-34).
      request: async (method, params, timeoutMs) => {
        if (client.state === "drain") return { ok: false, error: "skew_drain" }
        return client.state === "connected" ? client.request(method, params, timeoutMs) : { ok: false }
      },
      on: (listener) => {
        creatorListeners.add(listener)
        return () => void creatorListeners.delete(listener)
      },
    }),
  )

  const close = async () => {
    clearInterval(pinger)
    if (flushing.timer) clearTimeout(flushing.timer)
    for (const stop of stops.splice(0)) stop()
    client.close()
    leases.clear()
    githubListeners.clear()
    creatorListeners.clear()
    mcpListeners.clear()
    mcpValues.clear()
    await Promise.allSettled([sink.close(), stub.close(), spool.flush(), gitStub?.close()])
    // The closed client answers their requests at once; a test's first-mirror delay is not waited out.
    await Promise.race([Promise.allSettled([...syncing]), Bun.sleep(SYNC_CLOSE_WAIT_MS)])
  }

  return { api, ledger, attached, close, refs: 0 }
}

/** The sink's reason code of a request (SLM): the session's mark for this provider, else `blocked` (no credential). */
function reasonOf(mark: Mark | undefined, providerID: string): Sink.Reason {
  if (!mark || mark.providerID !== providerID) return "blocked"
  if (mark.reason === "unavailable") return "unavailable"
  if (mark.reason === "refused") return `refused_${mark.error}`
  if (mark.reason === "claude") return `claude_${mark.code}`
  if (mark.reason === "local") return mark.code
  return "blocked"
}

/** How long `close` waits for mirror syncs still writing this OWN_HOME. */
const SYNC_CLOSE_WAIT_MS = 5_000

/** Insertion-ordered bounded map write. */
function remember<V>(map: Map<string, V>, name: string, value: V) {
  map.delete(name)
  map.set(name, value)
  if (map.size <= MEMORY) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

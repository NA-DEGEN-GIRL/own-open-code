export * as BrokerHost from "./host.js"

import { createHash } from "node:crypto"
import path from "node:path"
import { Option, Schema } from "effect"
import { Account, Broker, Kind, OwnID, type Registry } from "@own/protocol"
import { CreatorBridge, Fsx } from "@own/runtime"
import type { Deps } from "../deps.js"
import { GitHubRelay } from "../github/relay.js"
import { McpSends } from "../mcp/sends.js"
import type { Modules } from "../modules.js"
import { ClaudeBundle } from "../plugins/bundle.js"
import { Claude } from "../plugins/claude.js"
import type { Plugins } from "../plugins/plugins.js"
import { PresetBudget } from "../presets/budget.js"
import { CodexMeta } from "../slots/codex-meta.js"
import { ClaudeAgent } from "../claude-agent/agent.js"
import { BrokerClaudeAgent } from "./claude-agent.js"
import { ClaudeWire } from "./claude-wire.js"
import { Contract } from "./contract.js"
import { Egress } from "./egress.js"
import { Lease } from "./lease.js"
import { Mirror } from "./mirror.js"
import type { Observe } from "./observe.js"
import { Server } from "./server.js"

/**
 * The local credential broker as a process singleton of the build (04 §4.1–4.2): one {@link Server.LocalBroker} shared by
 * every own-accounts instance (one per Location), published under own-remote's lookup key. It serves from the
 * runtime (registry files, ledger writer, limit store, credentials) and from one attached instance's modules
 * (`logins.headers` with its refresher and status tracker, `telemetry.alert`), preferring the control location.
 * The last detach closes every listener (own-remote keeps its tunnels; the remote side fails closed after its leases).
 *
 * 04 §8.11: the Claude slot is judged and relayed from the attached instance that has it detected and acknowledged,
 * the control location's first ({@link serving}); the relay signs with that Location's claude-auth instance.
 */

interface Attached {
  readonly deps: Deps.Deps
  readonly modules: Modules.All
}

interface Slot {
  readonly server: Server.LocalBroker
  readonly attached: Attached[]
  readonly stops: Array<() => void>
}

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** A test upstream of the relay must be a loopback origin (04 §8.11.5). */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/

const decodeAck = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ streamId: Schema.String, ackThrough: Schema.Int })),
)
const decodeBuild = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, buildId: Schema.String, firstSeenAt: Schema.Finite })),
)

export function key(buildId: string) {
  return Symbol.for(`own-open-code.accounts-broker/${buildId}`)
}

function slots() {
  return globalThis as unknown as Record<symbol, Slot | undefined>
}

/** The broker of a build, if one is running in this process (tests, health). */
export function peek(buildId: string) {
  return slots()[key(buildId)]?.server
}

/**
 * Attaches a `mode:"local"` instance. Returns the detach function (for the plugin's cleanup stack). The first attach
 * creates the server and publishes it; the last detach shuts it down.
 */
export function attach(deps: Deps.Deps, modules: Modules.All): () => Promise<void> {
  const buildId = deps.runtime.buildId
  const existing = slots()[key(buildId)]
  const slot = existing ?? create(deps, buildId)
  const entry: Attached = { deps, modules }
  // The control location's instance serves first (it leads the runtime, 02 §9.1).
  if (deps.location.control) slot.attached.unshift(entry)
  else slot.attached.push(entry)
  let detached = false
  return async () => {
    if (detached) return
    detached = true
    slot.attached.splice(slot.attached.indexOf(entry), 1)
    if (slot.attached.length > 0) return
    if (slots()[key(buildId)] === slot) delete slots()[key(buildId)]
    for (const stop of slot.stops.splice(0)) stop()
    await slot.server.shutdown()
  }
}

function create(deps: Deps.Deps, buildId: string): Slot {
  const runtime = deps.runtime
  const log = deps.log.child("broker")
  const attached: Attached[] = []
  const current = () => {
    const first = attached[0]
    if (!first) throw new Error("own broker: no attached own-accounts instance")
    return first
  }
  const now = () => deps.clock.now()
  const root = runtime.layout.root
  const hostDir = (hostId: string) => (HOST_ID.test(hostId) ? path.join(root, "remote", hostId) : undefined)
  const installId = `own-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`
  const registry = async () => runtime.registry.cached() ?? (await runtime.registry.read())
  const testing = deps.options.broker
  /**
   * The Claude facts of the attached instance that serves the slot: detected and acknowledged, else detected, else
   * none. A failing instance must never cost the broker its leases, so an error here only means "no slot" (logged).
   */
  const servingEntry = (): Attached | undefined => {
    try {
      return (
        attached.find((item) => {
          const slot = item.modules.plugins.claudeSlot()
          return slot.detected && slot.verified
        }) ?? attached.find((item) => item.modules.plugins.claudeSlot().detected)
      )
    } catch (error) {
      log.warn("claude_slot_unknown", { error })
      return undefined
    }
  }
  /** The served Codex rows of the list this PC fetched (10 §6.14); `undefined` before a fetch (or from the PC cache). */
  const served = () => {
    const snapshot = CodexMeta.current()
    return snapshot?.source === "backend" ? (snapshot.harness ?? []) : undefined
  }
  const serving = (): Plugins.ClaudeRemote | undefined => {
    try {
      return servingEntry()?.modules.plugins.claudeRemote()
    } catch (error) {
      log.warn("claude_slot_unknown", { error })
      return undefined
    }
  }
  /** Every Claude account id of this PC (02 §8.7): the slot's own and the added ones. */
  const claudeIDs = () => [
    Account.ID.claudeSlot,
    ...(runtime.registry.cached()?.claudeAccounts ?? []).map((item) => item.accountID),
  ]
  const claude = (hostId: string, scope: Contract.AccountScope) => {
    const facts = serving()
    if (!facts) return undefined
    return Claude.remoteState({
      facts,
      remoteHosts: runtime.registry.cached()?.claudeSlot?.remoteHosts,
      hostId,
      scope,
      accounts: claudeIDs(),
    })
  }
  /**
   * The account an egress proof names (02 §8.7, G5): one of this PC's Claude accounts inside the host's scope, with
   * the key the patched plugin signs it with (`undefined` = the slot's own account on a plugin that runs one).
   */
  const claudeAccount = (scope: Contract.AccountScope, accountID: string) => {
    if (scope.mode === "only" && !scope.ids.includes(accountID)) return undefined
    const modules = servingEntry()?.modules
    const entry = modules?.claude.entry(accountID)
    if (!modules || !entry) return undefined
    return { key: entry.accountID === Account.ID.claudeSlot && !modules.claude.multi() ? undefined : entry.key }
  }
  const upstream =
    testing?.claudeUpstream !== undefined && LOOPBACK.test(testing.claudeUpstream)
      ? testing.claudeUpstream
      : Egress.UPSTREAM

  const issuer = new Lease.Issuer(
    {
      now,
      registry,
      headers: (account, sessionID) => current().modules.logins.headers(account, sessionID),
      refresh: async (account) => {
        const refresher = current().modules.logins.refresher(account)
        if (!refresher) return { type: "failed" }
        const result = await runtime.credentials.refresh(account, refresher, { force: true })
        if (result.type === "deferred") return { type: "deferred", until: result.until }
        return { type: result.type === "refreshed" || result.type === "current" ? "refreshed" : "failed" }
      },
      unauthorized: (account) => void runtime.credentials.unauthorized(account),
    },
    { leaseMs: testing?.leaseMs },
  )

  const verified = new Map<string, number>()
  const event = (input: {
    readonly type: string
    readonly accountID?: string | null
    readonly providerID?: string | null
    readonly sessionID?: string | null
    readonly data?: Record<string, unknown>
    readonly eid?: string
    readonly ts?: number
  }) =>
    runtime.ledger
      .event({
        eid: input.eid ?? `rb_${OwnID.ulid(now())}`,
        ts: input.ts ?? now(),
        type: input.type,
        ...(input.accountID === undefined ? {} : { accountID: input.accountID }),
        ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        ...(input.data === undefined ? {} : { data: input.data }),
      })
      .then(() => undefined)

  const sink: Observe.Sink = {
    now,
    registry,
    // 04 §8.11.10: a host's `anthropic` lines are a Claude account's while this PC has the slot and the host is
    // switched on (not the whole verdict, so a late spool after a switch-off still counts): the account the host's line
    // names when it is one of this PC's Claude accounts (02 §8.7), else the slot's own.
    claude: (hostId, accountID) => {
      if (serving() === undefined || !(runtime.registry.cached()?.claudeSlot?.remoteHosts ?? []).includes(hostId))
        return null
      return accountID !== null && claudeIDs().includes(accountID as Account.ID)
        ? (accountID as Account.ID)
        : Account.ID.claudeSlot
    },
    usage: async (eid, line) => {
      const outcome = await runtime.ledger.usage(eid, line)
      if (outcome !== "written") return false
      runtime.broadcast.emit("ledger.line", { eid, line })
      return true
    },
    event,
    limits: (windows, dropped = []) => {
      const changed = runtime.limits.upsert(windows)
      const gone = dropped.filter((window) => runtime.limits.drop(window.accountID, window.id))
      if (changed.length > 0 || gone.length > 0)
        runtime.broadcast.emit("limits.updated", { windows: changed, ...(gone.length > 0 ? { dropped: gone } : {}) })
    },
    authFailure: (hostId, payload) => {
      // 04 §10.6: vault OAuth is re-checked by the `invalidate` of the host's next `headers.get`; an API key gets one
      // light connection test here (at most every 5 minutes per host and account). Linked sources: nothing (8.8).
      void (async () => {
        const account = (await registry()).accounts.find(
          (item) => item.providerID === payload.providerID && item.status !== "retired",
        )
        if (!account || Kind.isOAuth(account.kind)) return
        const throttle = `${hostId}\u0000${account.id}`
        const last = verified.get(throttle)
        if (last !== undefined && now() - last < Broker.INVALIDATE_INTERVAL_MS) return
        verified.set(throttle, now())
        await event({ type: "remote.auth_failure", accountID: account.id, data: { hostId, status: payload.status } })
        await lightTest(current(), account.id)
      })().catch((error: unknown) => log.warn("auth_failure_check_failed", { hostId, error }))
    },
    gap: (hostId, payload) => {
      void event({ type: "remote.spool.gap", data: { hostId, count: payload.count, from: payload.fromSeq, to: payload.toSeq } })
      alert({
        code: "remote_spool_overflow",
        severity: "warning",
        message: `${hostId}: the remote observation spool overflowed; ${payload.count} item(s) are missing from the totals.`,
      })
    },
  }

  const alert = (input: Server.Alerting) => {
    try {
      current().modules.telemetry.alert(input)
    } catch (error) {
      log.warn("alert_failed", { code: input.code, error })
    }
  }

  const buildFile = path.join(root, "remote", "broker-build.json")
  const build = { firstSeenAt: now() }
  void (async () => {
    const version = deps.ctx.app.version
    const text = await Fsx.readText(buildFile).catch(() => undefined)
    const stored = text === undefined ? undefined : Option.getOrUndefined(decodeBuild(text))
    if (stored && stored.version === version && stored.buildId === buildId) {
      build.firstSeenAt = stored.firstSeenAt
      return
    }
    await Fsx.writeAtomic(buildFile, `${JSON.stringify({ version, buildId, firstSeenAt: build.firstSeenAt })}\n`)
  })().catch((error: unknown) => log.warn("build_file_failed", { error }))

  /** The Claude Agent accounts a host may use (02 §8.10.13); like the Claude slot's facts, a failure means none. */
  const agentOffer = (scope: Contract.AccountScope) => {
    try {
      return current().modules.claudeAgent?.offer(scope)
    } catch (error) {
      log.warn("claude_agent_offer_failed", { error })
      return undefined
    }
  }

  // The money state of the paid accounts a host may use, from this PC's ledger (07 §5.4 step 4, T3).
  const budget = (file: Registry.File, scope: Contract.AccountScope) =>
    PresetBudget.mirror(() => current().modules, Mirror.paid(file, scope))

  const server = new Server.LocalBroker({
    now,
    log,
    local: () => ({ version: current().deps.ctx.app.version, buildId, from: installId }),
    issuer,
    sink,
    registry,
    view: async (hostId, scope) => {
      const file = await runtime.registry.read()
      const state = claude(hostId, scope)
      return Mirror.build({
        registry: file,
        policy: await runtime.policy.read(),
        ratecards: await runtime.ratecards.read(),
        scope,
        // An unreadable presets.json never stops the registry mirror, and never resets a host's presets: the host gets
        // the last file this process read (as this PC's own store keeps it), or none (then it keeps what it has).
        presets: await runtime.presets.read().catch((error: unknown) => {
          log.warn("presets_unreadable", { error })
          return runtime.presets.cached()
        }),
        budget: await budget(file, scope),
        claudeUsable: (accountID) => servingEntry()?.modules.claude.usable(accountID) ?? false,
        claudeAgent: agentOffer(scope),
        // 10 §6.14: the rows of the list this PC fetched (a `pc-cache` snapshot holds none).
        codex: served(),
        ...(state === undefined
          ? {}
          : { claude: { state, fast: serving()?.fast ?? false } }),
      })
    },
    claude,
    claudeAccount,
    // 04 §8.14: a host's local model request goes to the account's server on this PC, with its key added here.
    localModel: async (scope, accountID, hostId) => {
      const account = (await registry()).accounts.find((item) => item.id === accountID && item.status !== "retired")
      const modules = current().modules
      const baseURL = account ? modules.slots.slot(account.providerID)?.slot.baseURL : undefined
      if (!account || !Broker.viaPc(account, baseURL)) return { ok: false, status: 404, code: "not_found" }
      if (!Mirror.allowed(account, scope) || account.status === "disabled")
        return { ok: false, status: 403, code: "host_scope" }
      const base = URL.parse(baseURL ?? "")
      if (!base || (base.protocol !== "http:" && base.protocol !== "https:"))
        return { ok: false, status: 404, code: "not_found" }
      const auth = await modules.logins.headers(account, Lease.Issuer.sessionOf(hostId))
      if (!auth.ok) return { ok: false, status: 403, code: "needs_key" }
      return {
        ok: true,
        origin: base.origin,
        basePath: base.pathname.replace(/\/+$/, ""),
        headers: Object.fromEntries(
          Object.entries(auth.headers).filter(([name]) => Lease.LEASED_HEADERS.has(name.toLowerCase())),
        ),
      }
    },
    egress: {
      upstream,
      // Several accounts sign only on a bundle verified as `patched` (02 §8.2); a marker alone is not enough.
      wire: async () => {
        const modules = servingEntry()?.modules
        // Nothing is signed before own's account list of this version is on disk (02 §8.7 CS): refused as not ready.
        if (!(await modules?.claude.ready())) return { ok: false as const, detail: "wire" as const }
        const plugins = modules?.plugins
        const loaded = await ClaudeWire.load(serving()?.entry, ClaudeBundle.stateDir(runtime.layout.thirdparty))
        if (!loaded.ok || loaded.multi === undefined) return loaded
        const patched = (await plugins?.bundleSettled())?.state === "patched"
        return patched ? loaded : { ...loaded, multi: undefined }
      },
    },
    budget: async (scope) => budget(await registry(), scope),
    event: (input) => event(input),
    alert,
    acks: {
      read: async (hostId) => {
        const dir = hostDir(hostId)
        if (!dir) return undefined
        const text = await Fsx.readText(path.join(dir, "observe-ack.json"))
        return text === undefined ? undefined : Option.getOrUndefined(decodeAck(text))
      },
      write: async (hostId, value) => {
        const dir = hostDir(hostId)
        if (dir) await Fsx.writeAtomic(path.join(dir, "observe-ack.json"), `${JSON.stringify(value)}\n`)
      },
    },
    leases: async (hostId, issued) => {
      const dir = hostDir(hostId)
      if (dir) await Fsx.writeAtomic(path.join(dir, "leases.json"), `${JSON.stringify({ lastIssuedAt: issued }, null, 2)}\n`)
    },
    drainUntil: () => build.firstSeenAt + Broker.SKEW_DRAIN_HOURS * 3600_000,
    brokerWaitMs: testing?.brokerWaitMs ?? Broker.BROKER_WAIT_SECONDS_DEFAULT * 1000,
    // 16 §8: the hosts' GitHub through this PC, served from the attached instance that serves first (the control
    // Location's); its GitHub files and vault items are the process's.
    github: {
      offer: (hostId, params) => GitHubRelay.offer(current().deps, hostId, params),
      account: (hostId, params) => GitHubRelay.account(current().deps, hostId, params),
      call: (hostId, params) => GitHubRelay.call(current().deps, hostId, params),
      gate: (hostId, ask) => GitHubRelay.gate(current().deps, hostId, ask),
    },
    // 02 §8.10.13: the hosts' Claude Agent conversations run their claude on this PC, through the provider's server.
    claudeAgent: BrokerClaudeAgent.make({
      log: log.child("claude-agent"),
      server: () => ClaudeAgent.defaults().channel().hosts,
      folder: (accountID, scope) => current().modules.claudeAgent.hostFolder(accountID, scope),
      root: path.join(runtime.layout.claudeAgent, "hosts"),
    }),
    // 17 §10: own.creator's store as the hosts may read it, through the process's bridge (own.creator provides it).
    // 04 §13 "MCP" (MH): the values the user sent to a host's MCP servers, from this PC's copy.
    mcp: { values: (hostId, server) => McpSends.values(current().deps, hostId, server) },
    creator: {
      view: async (hostId) => CreatorBridge.source()?.view(hostId),
      file: async (hostId, params) => CreatorBridge.source()?.file(hostId, params),
      report: (hostId, report) => CreatorBridge.report(hostId, report),
      forget: (hostId) => CreatorBridge.forget(hostId),
    },
  })

  const stops: Array<() => void> = []
  stops.push(Contract.provide(Contract.localKey(buildId), server))
  stops.push(
    runtime.broadcast.on("store.changed", (change) => {
      // Trust is not mirrored; presets travel with the view (07 §8.1 원격) but change no account.
      if (change.store === "trust") return
      if (change.store === "presets") return server.presetsChanged()
      void registry().then(
        (value) => server.registryChanged(value),
        (error: unknown) => log.warn("registry_read_failed", { error }),
      )
    }),
  )
  stops.push(
    runtime.broadcast.on("ledger.line", (change) => {
      // Only a paid account with a budget can cross it (this PC's line or a host's, both reach the ledger here).
      const account = runtime.registry.cached()?.accounts.find((item) => item.id === change.line.accountID)
      if (account && PresetBudget.paid(account) && account.budget?.monthlyUSD) server.budgetChanged()
    }),
  )
  stops.push(runtime.broadcast.on("limits.updated", (change) => server.limitsUpdated(change.windows, change.dropped)))
  stops.push(
    runtime.broadcast.on("claudeSlot.changed", () => {
      // After every instance re-read its facts (the event also queued their refreshes).
      void Promise.all(attached.map((entry) => entry.modules.plugins.refreshed())).then(
        () => server.claudeChanged(),
        (error: unknown) => log.warn("claude_refresh_failed", { error }),
      )
    }),
  )
  stops.push(runtime.broadcast.on("credential.replaced", (change) => server.revokeProvider(change.providerID)))
  stops.push(runtime.broadcast.on("github.changed", () => server.githubChanged()))
  stops.push(runtime.broadcast.on("mcp.hosts.changed", (change) => server.mcpChanged(change.hostId)))
  stops.push(CreatorBridge.onChanged(() => server.creatorChanged()))
  stops.push(CreatorBridge.provideHosts({ list: () => server.hostSessions() }))

  const slot: Slot = { server, attached, stops }
  slots()[key(buildId)] = slot
  return slot
}

/** `accounts.test` of the attached instance, as a light verification of an API key a host reported (04 §10.6). */
async function lightTest(entry: Attached, accountID: Account.ID) {
  const context = {
    signal: AbortSignal.timeout(15_000),
    error: (type: string) => ({ type }),
  }
  // SAFETY: the handler only uses `signal` and `error` of its call context; its result is not used here.
  await entry.modules.logins.test({ accountID }, context as never)
}

export * as Plugins from "./plugins.js"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Option, Schema, Struct } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { Kv, Plugin, Speed } from "@own/protocol"
import type { Account, Registry } from "@own/protocol"
import { Fsx } from "@own/runtime"
import { BrokerHost } from "../broker/host.js"
import { ClaudeLogin } from "../claude/login.js"
import type { Deps } from "../deps.js"
import { Location } from "../location.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import type { RpcTypes } from "../rpc/types.js"
import { Board } from "./board.js"
import { ClaudeBundle } from "./bundle.js"
import { Claude } from "./claude.js"
import { Inventory } from "./inventory.js"
import { Notice } from "./notice.js"
import { Trust } from "./trust.js"
import { ClaudeWire } from "../broker/claude-wire.js"

/**
 * Owner: PLUGINS agent. The Claude subscription plugin (02 §8): it ships inside the app and is always on (user decision
 * 2026-10-18, `ClaudeBundle`), so there is nothing to install, patch, remove or consent to here. This module detects
 * `heymaaz.claude-auth-v2` in this Location's list (`ctx.plugin.list()` on `plugin.updated`), verifies that the loaded
 * plugin is the app's bundle (`own-bundle.json`), reports it (`plugin.claudeAuth.status`), keeps the account source
 * change (`changeSource`), and runs the project-plugin allowlist (01 §13.2, 02 §4.2): `trust.json` approvals and this
 * Location's `ok | blocked_by_plugin` status. Trust changes broadcast `store.changed{store:"trust"}`; every instance
 * then re-reads its Location and reloads its own providers when its Claude slot facts changed.
 *
 * 04 §8.11.12 (PC): the remote consent `ack:claudeRemote` (`remote.ack`), the per-host switches in `accounts.json`
 * `claudeSlot.remoteHosts` (`remote.set`) and the Fast consent recorded for a remote session (`fastAck`); each
 * broadcasts `claudeSlot.changed` (`remote`, `fast`), and an `anthropic` connection change broadcasts `connection`, so
 * the local broker re-judges every host. {@link Api.claudeRemote} is what that verdict reads.
 *
 * 04 §8.11.4.3 (remote service): there is no claude-auth here. The slot is `{detected: ok, verified: ok}` with `ok` =
 * the PC's mirrored verdict is `enabled` and this Location has no Claude login of its own (no claude-auth entry, no
 * `anthropic` connection); a Location with one is a conflict (`claude_remote_conflict`), so the fold keeps `anthropic`
 * disabled there and the host's own token is never used.
 */

/**
 * What the PC's verdict for an SSH host reads (04 §8.11.4.3): {@link Claude.RemoteFacts}, whether this PC holds the
 * Fast consent (`ack:claudeFast`), and the local path of this Location's active claude-auth entry (the relay's wire).
 */
export interface ClaudeRemote extends Claude.RemoteFacts {
  readonly fast: boolean
  readonly entry: string | undefined
}

/** Claude slot facts the provider fold and the RPCs read without I/O. */
export interface ClaudeSlot {
  /** claude-auth is loaded and active in this Location's plugin list. */
  readonly detected: boolean
  /** The bundled plugin's version and lock integrity (`own-bundle.json`). */
  readonly version: string | null
  readonly integrity: string | null
  /**
   * The loaded plugin is the app's bundle and every file has its recorded hash (02 §8.2). No consent is asked (user
   * decision 2026-10-18): this is what keeps `anthropic` enabled (02 §8.4).
   */
  readonly verified: boolean
}

/** The patch of the loaded plugin (02 §8.2), as `plugin.claudeAuth.status.patch` reports it. */
export interface PatchFacts {
  readonly state: Plugin.ClaudePatchState | null
  readonly sha256: string | null
  /** The loaded module carries the patch's marker and its multi-account exports (several accounts can sign). */
  readonly loaded: boolean
}

export interface Config {
  /** Where the app ships the plugin ({@link ClaudeBundle.dir}): `app\<version>\plugins\claude-auth`. */
  readonly bundleDir: string
  /** Own plugin directories on the default allowlist ({@link Inventory.ownRoots}). */
  readonly ownRoots: ReadonlyArray<string>
}

export function defaults(deps: Deps): Config {
  return {
    bundleDir: ClaudeBundle.dir(deps.runtime.layout.app),
    ownRoots: Inventory.ownRoots(deps.runtime.layout),
  }
}

export interface Api extends Module.Lifecycle {
  /**
   * `anthropic` stays enabled only when `detected && verified`; the SLOTS provider fold disables it otherwise (02 §8.4).
   * Detection is per Location (this Location's plugin list).
   */
  claudeSlot(): ClaudeSlot
  /** This Location's allowlist state. `model.request` injects auth only when `"ok"` (02 §4.1, §4.2). */
  trustStatus(): Plugin.TrustStatus
  /**
   * {@link trustStatus} once this Location's plugin list has been checked at least once. Right after boot the list
   * still describes the loading generation, so the first model request would otherwise fail closed (401) until the
   * asynchronous check lands; this waits for that first check (at most {@link TRUST_SETTLE_MS}) and answers at once
   * afterwards. Still fail closed: an unsettled or blocked Location answers `blocked_by_plugin`.
   */
  trustSettled(): Promise<Plugin.TrustStatus>
  /** Allowlist state of every open Location of this process (`health.locations`, `plugin.trust.list`). */
  locations(): ReadonlyArray<Board.LocationState>
  /** Position of claude-auth in this Location's plugin order; `missing` when it is not loaded. */
  claudeOrder(): Plugin.ClaudeAuthOrder
  /** 04 §8.11.4.3: the facts of the PC's per-host verdict, without I/O. */
  claudeRemote(): ClaudeRemote
  /**
   * 04 §8.11.5 (remote service): this Location has a Claude login of its own (a claude-auth entry or an `anthropic`
   * connection), so it does not use the PC's slot. Always `false` on this PC.
   */
  claudeConflict(): boolean
  /** Resolves once the refresh a `claudeSlot.changed` queued has run (the broker re-judges hosts after it). */
  refreshed(): Promise<void>
  /** The loaded plugin's patch state, its manifest hash and whether the loaded module carries it (02 §8.2). */
  patch(): PatchFacts
  /**
   * The bundle a request signs through, read from disk when this Location has not refreshed yet (a request right after
   * startup): the loaded entry's folder, else the shipped bundle. Only a `patched` one signs for several accounts.
   */
  bundleSettled(): Promise<ClaudeBundle.Info | undefined>
  /** `<OWN_HOME>\thirdparty\claude-auth`: own's account list and the plugin's per-account state (02 §8.7). */
  readonly stateDir: string

  claudeAuthStatus: RpcTypes.Handler<"plugin.claudeAuth.status">
  claudeAuthAck: RpcTypes.Handler<"plugin.claudeAuth.ack">
  claudeRemoteAck: RpcTypes.Handler<"plugin.claudeAuth.remote.ack">
  claudeRemoteSet: RpcTypes.Handler<"plugin.claudeAuth.remote.set">
  claudeFastAck: RpcTypes.Handler<"plugin.claudeAuth.fastAck">
  changeSourcePlan: RpcTypes.Handler<"plugin.claudeAuth.changeSource.plan">
  changeSourceExecute: RpcTypes.Handler<"plugin.claudeAuth.changeSource.execute">
  trustList: RpcTypes.Handler<"plugin.trust.list">
  trustApprovePlan: RpcTypes.Handler<"plugin.trust.approve.plan">
  trustApproveExecute: RpcTypes.Handler<"plugin.trust.approve.execute">
  trustRevoke: RpcTypes.Handler<"plugin.trust.revoke">
}

export function create(deps: Deps, peers: Module.Peers): Api {
  return make(deps, peers)
}

const EMPTY_SLOT: ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }
/** Fallback re-reads of a plugin list that still predates this generation (see `start`). */
const CURRENT_RETRY_MS = 1_000
const CURRENT_RETRIES = 60
/** Longest wait of {@link Api.trustSettled} for the first allowlist check after boot. */
export const TRUST_SETTLE_MS = 10_000
const decodeRemoteAck = Schema.decodeUnknownOption(Plugin.ClaudeRemoteAck)
const decodeConsent = Schema.decodeUnknownOption(Speed.Consent)
const encodeConsent = Schema.encodeSync(Speed.Consent)
const toJson = Schema.decodeUnknownSync(Schema.Json)
const isSessionID = Schema.is(SessionID)
/** Display metadata of `acc_claude_slot` before the user changes it (as `Slots`' default, 02 §8.5). */
const CLAUDE_SLOT: Registry.ClaudeSlot = { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange" }

/** {@link create} with test overrides (the bundle folder, own roots). */
export function make(deps: Deps, peers: Module.Peers, overrides: Partial<Config> = {}): Api {
  const config: Config = { ...defaults(deps), ...overrides }
  const log = deps.log.child("plugins")
  const hub = deps.runtime.broadcast
  const directory = deps.location.directory
  const stateDir = ClaudeBundle.stateDir(deps.runtime.layout.thirdparty)
  const devDir = ClaudeBundle.devDir()
  const roots: Trust.Roots = {
    own: config.ownRoots,
    claude: [config.bundleDir, stateDir, ...(devDir === undefined ? [] : [devDir])],
  }
  const state = {
    // Fail closed until this Location's plugin list has been checked once (01 §13.2 (a)). The unchecked state is
    // still answered to board queries, so health counts this instance and shows the Location as blocked.
    trust: "blocked_by_plugin" as Plugin.TrustStatus,
    location: { directory, status: "blocked_by_plugin", candidates: [], pending: 0 } as Board.LocationState,
    checked: false,
    slot: EMPTY_SLOT,
    entries: [] as ReadonlyArray<Inventory.Entry>,
    order: "missing" as Plugin.ClaudeAuthOrder,
    /** The bundle the app carries (`config.bundleDir`, when it holds a record). */
    shipped: undefined as ClaudeBundle.Info | undefined,
    /** The record of the loaded claude-auth's folder; `undefined` = none loaded, or that folder has no record. */
    loaded: undefined as ClaudeBundle.Info | undefined,
    /** {@link shipped} and {@link loaded} were read at least once. */
    read: false,
    /** The loaded claude-auth module carries the patch's marker and its multi-account exports. */
    multi: false,
    /** `ack:claudeRemote` (04 §8.11.12). */
    remoteAck: undefined as Plugin.ClaudeRemoteAck | undefined,
    /** `ack:claudeFast` exists (02 §4.8). */
    fast: false,
    /** This Location's active `anthropic` connection as the UI shows it; `null` = none. */
    connection: null as Account.Connection | null,
    /** A conflict was alerted and has not cleared (remote service). */
    conflicted: false,
    /** Connection type last reported as `claude_slot_billing`; `null` = none. */
    billing: null as string | null,
    started: false,
  }
  // Sessions seen on the event stream since this instance started (all Locations deliver to every instance).
  const sessions = { running: new Set<string>() }
  /** `configDir: null` = back to the default source (the file is removed). */
  const sources = new Nonces.Scope<{ readonly configDir: string | null; readonly leaveOwnLogin: boolean }>(deps.clock)
  /** Account 1 is on a login folder of own's (`own 전용 로그인으로 바꾸기`, 02 §8.7 CS), not on its account source. */
  const ownLogin = () => peers().slots.snapshot().claudeSlot?.configDir !== undefined
  /**
   * 02 §8.7 (CS): one of own's login folders (`<OWN_HOME>\claude-accounts\…`, by path or realpath) is never an account
   * source. The launcher would export it as Claude Code's `CLAUDE_CONFIG_DIR`, so own would only read it from then on
   * and its account would stop at the next token expiry.
   */
  // Own's login folders: claude-auth's added accounts' and the Claude Agent route's (02 §8.10: one route per folder).
  const ownLoginFolder = async (configDir: string) => {
    const real = async (folder: string) => ClaudeLogin.key(await fs.realpath(folder).catch(() => folder))
    const inside = (folder: string, root: string) => folder === root || folder.startsWith(`${root}${path.sep}`)
    const roots = [deps.runtime.layout.claudeAccounts, deps.runtime.layout.claudeAgent]
    const found = await Promise.all(
      roots.map(
        async (root) =>
          inside(ClaudeLogin.key(configDir), ClaudeLogin.key(root)) || inside(await real(configDir), await real(root)),
      ),
    )
    return found.some(Boolean)
  }
  const approvals = new Nonces.Scope<{
    readonly directory: string
    readonly plugins: ReadonlyArray<Plugin.TrustPlugin>
  }>(deps.clock)
  const unsubscribe: Array<() => void> = []
  const firstCheck = Promise.withResolvers<void>()

  const readRemoteAck = () =>
    deps.ctx.storage.get(Kv.ackClaudeRemote).then(
      (value) => (value === undefined ? undefined : Option.getOrUndefined(decodeRemoteAck(value))),
      (error: unknown) => {
        log.warn("remote_ack_unreadable", { error })
        return undefined
      },
    )

  const readFast = () =>
    deps.ctx.storage.get(Kv.ackClaudeFast).then(
      (value) => Option.isSome(decodeConsent(value)),
      () => false,
    )

  const readTrust = () =>
    deps.runtime.trust.read().catch((error: unknown) => {
      // Unusable trust.json: nothing counts as approved (fail closed); the file is never rewritten automatically.
      log.warn("trust_unreadable", { error })
      return undefined
    })

  const conflict = () =>
    deps.remote !== undefined && (Inventory.claude(state.entries) !== undefined || state.connection !== null)

  /** The folder of this Location's active claude-auth entry. */
  const loadedDir = () => {
    const entry = Inventory.claude(state.entries)
    const file = entry ? Inventory.localPath(entry) : undefined
    return file === undefined ? undefined : Inventory.folderOf(file)
  }

  /** The bundle a version is shown for: the loaded one, else the one the app carries. */
  const reference = () => state.loaded ?? state.shipped

  const computeSlot = (): ClaudeSlot => {
    const remote = deps.remote
    if (remote) {
      const ok = remote.claude()?.state === "enabled" && !conflict()
      return { detected: ok, version: null, integrity: null, verified: ok }
    }
    const detected = Inventory.claude(state.entries) !== undefined
    return {
      detected,
      version: reference()?.version ?? null,
      integrity: reference()?.integrity ?? null,
      verified: detected && state.loaded?.state === "patched",
    }
  }

  const setLocation = (next: Board.LocationState) => {
    const previous = state.location
    const same =
      state.checked &&
      previous.status === next.status &&
      JSON.stringify(previous.candidates) === JSON.stringify(next.candidates)
    state.location = next
    state.trust = next.status
    state.checked = true
    firstCheck.resolve()
    if (!same) Board.announce(hub, next)
  }

  const setSlot = (next: ClaudeSlot) => {
    const changed = JSON.stringify(state.slot) !== JSON.stringify(next)
    state.slot = next
    if (!changed || !state.started) return
    log.info("claude_slot_changed", { detected: next.detected, verified: next.verified })
    // The Claude accounts are listed only while the slot is detected, and a change here moves no registry revision:
    // clients read `accounts.list` again on this (CL, 2026-11-27). A list read before claude-auth's first detection
    // (a new Location's plugin list still describes the previous generation) otherwise stayed without them.
    void deps.emitter.global("plugin.status", { plugin: "claudeAuth", phase: phase() })
    // This Location's provider fold reads `claudeSlot()`; other Locations reload on their own refresh.
    void peers()
      .slots.reload()
      .catch((error: unknown) => log.warn("provider_reload_failed", { error }))
    // So does the hidden agents' check (`anthropic` is a subscription slot only while detected, 07 §5.4).
    peers().presets.recheckAgents()
  }

  const refresh = coalesce(async () => {
    const [entries, trust, shipped, remoteAck, fast, connection] = await Promise.all([
      Inventory.read(deps.ctx),
      readTrust(),
      deps.remote ? Promise.resolve(undefined) : ClaudeBundle.read(config.bundleDir),
      readRemoteAck(),
      readFast(),
      activeConnection(),
    ])
    state.shipped = shipped
    state.remoteAck = remoteAck
    state.fast = fast
    state.connection = Claude.connection(connection)
    if (entries && Inventory.current(entries)) {
      state.entries = entries
      state.order = Inventory.order(entries)
      const candidates = await Trust.candidates(entries, roots)
      const evaluation = Trust.evaluate(directory, candidates, trust ?? [])
      setLocation({ directory, status: evaluation.status, candidates, pending: evaluation.pending })
    }
    const dir = deps.remote ? undefined : loadedDir()
    state.loaded = dir === undefined ? undefined : await ClaudeBundle.read(dir)
    state.read = true
    state.multi =
      dir !== undefined && (await ClaudeWire.multi(dir, stateDir).catch(() => undefined)) !== undefined
    setSlot(computeSlot())
    alertConflict()
  }, log)

  /** `claude_remote_conflict` once a conflict appears on a host the PC switched on (04 §8.11.5). */
  const alertConflict = () => {
    const now = deps.remote !== undefined && deps.remote.claude()?.state === "enabled" && conflict()
    if (now === state.conflicted) return
    state.conflicted = now
    if (now)
      peers().telemetry.alert({
        code: "claude_remote_conflict",
        severity: "warning",
        accountID: "acc_claude_slot",
        directory,
        message: "이 호스트에 다른 Claude 로그인이나 claude-auth 플러그인이 있어 Claude 구독을 쓰지 않습니다.",
      })
  }

  const activeConnection = () =>
    deps.ctx.integration.connection.active(Claude.PROVIDER_ID).catch((error: unknown) => {
      log.warn("connection_unreadable", { error })
      return undefined
    })

  const claudeRemote = (): ClaudeRemote => {
    const entry = Inventory.claude(state.entries)
    return {
      ready: state.slot.detected && state.slot.verified && state.connection !== null,
      billing: billsApi(state.connection),
      acknowledged: state.slot.verified && Claude.ackValid(state.remoteAck, reference(), Notice.REMOTE_HASHES),
      fast: state.fast,
      entry: entry ? Inventory.localPath(entry) : undefined,
    }
  }

  /**
   * Every host switched on or served by this PC's broker, with its switch and the PC's verdict (a host the broker has
   * not met yet is judged with the account scope `all`; the broker knows its real one once it connects).
   */
  const remoteHosts = (): ReadonlyArray<Plugin.ClaudeRemoteHost> => {
    const enabled = peers().slots.snapshot().claudeSlot?.remoteHosts ?? []
    const served = BrokerHost.peek(deps.runtime.buildId)?.hostScopes() ?? []
    const facts = claudeRemote()
    return [...new Set([...enabled, ...served.map((host) => host.hostId)])].sort().map((hostId) => ({
      hostId,
      enabled: enabled.includes(hostId),
      state: Claude.remoteState({
        facts,
        remoteHosts: enabled,
        hostId,
        scope: served.find((host) => host.hostId === hostId)?.scope ?? { mode: "all" },
      }),
    }))
  }

  /** An `anthropic` credential event: re-read, and tell every instance and the broker when the connection changed. */
  const connectionChanged = async () => {
    const before = state.connection?.type ?? null
    await refresh()
    if ((state.connection?.type ?? null) !== before) hub.emit("claudeSlot.changed", { reason: "connection" })
  }

  /** The patch state of the loaded plugin: its bundle's, `modified` for a claude-auth that is no bundle at all. */
  const patchState = (): Plugin.ClaudePatchState | null => {
    if (state.loaded) return state.loaded.state
    if (Inventory.claude(state.entries)) return "modified"
    return null
  }

  const phase = (): Plugin.ClaudeAuthPhase => {
    if (!state.slot.detected) return state.shipped ? "installed" : "absent"
    if (state.slot.verified && state.order === "ok" && state.connection !== null) return "ready"
    return "installed"
  }

  /** `claude_slot_billing` (02 §7.7, §8.9): judged by the leader when credentials change; once per connection type. */
  const checkBilling = async () => {
    if (!deps.runtime.isLeader() || deps.remote) return
    const connection = Claude.connection(await activeConnection())
    const type = billsApi(connection) ? (connection?.type ?? null) : null
    if (type === state.billing) return
    state.billing = type
    if (type)
      peers().telemetry.alert({
        code: "claude_slot_billing",
        severity: "danger",
        accountID: "acc_claude_slot",
        message: "Claude 구독 슬롯이 API 키로 바뀌었습니다 — 요금이 API로 청구됩니다.",
      })
  }

  const locationState = (target: string) =>
    Board.collect(hub).find((location) => Location.same(location.directory, target))

  return {
    start: async () => {
      unsubscribe.push(
        hub.on("store.changed", (change) => {
          if (change.store === "trust") void refresh()
        }),
        hub.on("claudeSlot.changed", () => void refresh()),
        Board.serve(hub, () => state.location),
        Board.onAnnounce(hub, (location) => {
          if (!deps.runtime.isLeader()) return
          void deps.emitter.global("plugin.trust.changed", {
            directory: location.directory,
            status: location.status,
            pending: location.pending,
          })
          if (location.status === "blocked_by_plugin")
            peers().telemetry.alert({
              code: "untrusted_plugin",
              severity: "error",
              directory: location.directory,
              message: `승인되지 않은 프로젝트 플러그인 ${location.pending}개 — 이 위치에서는 계정 인증을 주입하지 않습니다.`,
            })
        }),
      )
      await refresh()
      state.started = true
      // During setup the inventory predates this generation; `plugin.updated` normally follows. If that event is
      // missed (stream resubscribe), re-read the list until it describes this generation.
      const retry = (left: number) => {
        if (state.checked || !state.started || left === 0) return
        unsubscribe.push(deps.clock.schedule(CURRENT_RETRY_MS, () => void refresh().then(() => retry(left - 1))))
      }
      retry(CURRENT_RETRIES)
      void checkBilling().catch((error: unknown) => log.warn("billing_check_failed", { error }))
    },
    stop: async () => {
      state.started = false
      // Releases any `trustSettled` waiter with the current (fail-closed) status.
      firstCheck.resolve()
      for (const off of unsubscribe.splice(0)) off()
    },
    onEvent: (event, meta) => {
      if (event.type === "plugin.updated") {
        if (meta.local || !event.location) void refresh()
        return
      }
      if (
        event.type === "credential.updated" ||
        event.type === "credential.switched" ||
        event.type === "integration.updated"
      ) {
        if (!meta.local) return
        void checkBilling().catch((error: unknown) => log.warn("billing_check_failed", { error }))
        void connectionChanged().catch((error: unknown) => log.warn("connection_check_failed", { error }))
        return
      }
      if (event.type === "session.deleted") {
        sessions.running.delete(event.data.sessionID)
        return
      }
      if (event.type === "session.execution.started") {
        sessions.running.add(event.data.sessionID)
        return
      }
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      )
        sessions.running.delete(event.data.sessionID)
    },

    claudeSlot: () => state.slot,
    trustStatus: () => state.trust,
    trustSettled: async () => {
      if (state.checked || !state.started) return state.trust
      await new Promise<void>((resolve) => {
        const cancel = deps.clock.schedule(TRUST_SETTLE_MS, resolve)
        void firstCheck.promise.then(() => {
          cancel()
          resolve()
        })
      })
      return state.trust
    },
    locations: () => Board.collect(hub),
    claudeOrder: () => state.order,
    claudeRemote,
    claudeConflict: conflict,
    refreshed: () => refresh(),
    patch: () => ({ state: patchState(), sha256: reference()?.patchSha256 ?? null, loaded: state.multi }),
    bundleSettled: async () => {
      if (state.read) {
        const dir = loadedDir()
        return dir === undefined ? state.shipped : state.loaded
      }
      return ClaudeBundle.read(config.bundleDir)
    },
    stateDir,

    claudeAuthStatus: guard(log, "plugin.claudeAuth.status", async () => {
      await refresh()
      const connection = Claude.connection(await activeConnection())
      const detected = state.slot.detected
      const bundle = reference()
      const integrityOk = bundle === undefined ? (detected ? false : null) : patchState() !== "modified"
      const warnings = [
        ...(!detected && !state.shipped ? ["bundle_missing"] : []),
        ...(!detected && state.shipped ? ["not_loaded"] : []),
        ...(detected && !state.loaded ? ["not_bundled"] : []),
        ...(integrityOk === false ? ["integrity_mismatch"] : []),
        // A verified bundle whose loaded module lacks the multi-account exports (another copy loaded): restart.
        ...(state.slot.verified && !state.multi ? ["patch_restart"] : []),
        ...(detected && state.order !== "ok" ? [`order_${state.order}`] : []),
        ...(billsApi(connection) ? ["claude_slot_billing"] : []),
      ]
      return {
        installed: detected || state.shipped !== undefined,
        version: bundle?.version ?? null,
        integrityOk,
        order: state.order,
        phase: phase(),
        acknowledged: null,
        connection,
        warnings,
        patch: { state: patchState() ?? "no_manifest", sha256: bundle?.patchSha256 ?? null, loaded: state.multi },
        bundle: bundle
          ? {
              version: bundle.version,
              integrity: bundle.integrity,
              patchSha256: bundle.patchSha256,
              buildId: bundle.buildId,
            }
          : null,
        remote: {
          acknowledged: state.remoteAck
            ? {
                at: state.remoteAck.acknowledgedAt,
                valid: claudeRemote().acknowledged,
              }
            : null,
          noticeHash: Notice.REMOTE_HASH,
          hosts: remoteHosts(),
        },
      }
    }),

    // The plugin ships with the app and needs no consent (02 §8.4, user decision 2026-10-18): an older client's ack is
    // answered and nothing is stored.
    claudeAuthAck: guard(log, "plugin.claudeAuth.ack", async () => ({
      acknowledgedAt: new Date(deps.clock.now()).toISOString(),
    })),

    claudeRemoteAck: guard(log, "plugin.claudeAuth.remote.ack", async (input, context) => {
      await refresh()
      const bundle = reference()
      if (!bundle) return context.error("internal_error", "bundle_missing", {})
      if (
        input.version !== bundle.version ||
        input.integrity !== bundle.integrity ||
        !Notice.REMOTE_HASHES.includes(input.noticeHash)
      )
        return context.error("ack_required", "ack does not match the plugin or the remote notice", { reason: "stale" })
      const acknowledgedAt = new Date(deps.clock.now()).toISOString()
      await deps.ctx.storage.set(Kv.ackClaudeRemote, {
        acknowledgedAt,
        pluginVersion: bundle.version,
        integrity: bundle.integrity,
        noticeHash: input.noticeHash,
      })
      await refresh()
      hub.emit("claudeSlot.changed", { reason: "remote" })
      return { acknowledgedAt }
    }),

    claudeRemoteSet: guard(log, "plugin.claudeAuth.remote.set", async (input, context) => {
      await refresh()
      // Switching off always works; switching on needs the slot and a valid remote consent (04 §8.11.12).
      if (input.enabled && !state.slot.detected)
        return context.error("plugin_not_installed", "claude-auth is not loaded", {})
      if (input.enabled && !claudeRemote().acknowledged)
        return context.error("ack_required", "acknowledge the remote notice first", { reason: "remote" })
      await peers().slots.mutate((current) => {
        const slot = current.claudeSlot ?? CLAUDE_SLOT
        const hosts = slot.remoteHosts ?? []
        if (hosts.includes(input.hostId) === input.enabled) return undefined
        const next = input.enabled
          ? [...hosts, input.hostId].sort()
          : hosts.filter((hostId) => hostId !== input.hostId)
        const rest = Struct.omit(slot, ["remoteHosts"])
        return { ...current, claudeSlot: next.length > 0 ? { ...rest, remoteHosts: next } : rest }
      })
      log.info("claude_remote_host", { hostId: input.hostId, enabled: input.enabled })
      const host = remoteHosts().find((item) => item.hostId === input.hostId)
      return host ?? { hostId: input.hostId, enabled: input.enabled, state: "off" as const }
    }),

    claudeFastAck: guard(log, "plugin.claudeAuth.fastAck", async () => {
      const at = deps.clock.now()
      await deps.ctx.storage.set(Kv.ackClaudeFast, toJson(encodeConsent({ at })))
      await refresh()
      // Every instance's speed module drops its cached answer; the broker pushes the hosts' views again.
      hub.emit("claudeSlot.changed", { reason: "fast" })
      return { at }
    }),

    changeSourcePlan: guard(log, "plugin.claudeAuth.changeSource.plan", async (input, context) => {
      await refresh()
      if (!state.slot.detected) return context.error("plugin_not_installed", "claude-auth is not loaded", {})
      // 02 §8.7 CS: account 1 on an own login folder (`claudeSlot.configDir`) would ignore the source; it goes back to a
      // folder Claude Code uses (read only there) only when the caller says so (`leaveOwnLogin`).
      if (ownLogin() && input.leaveOwnLogin !== true)
        return context.error("claude_account_unavailable", "account 1 is on an own login folder", {
          reason: "own_login",
        })
      // The launcher only takes an absolute path (02 §8.7 step 2); `null` returns to %USERPROFILE%\.claude (v0.4).
      if (input.configDir !== null && !path.isAbsolute(input.configDir))
        return context.error("setting_out_of_range", "configDir must be an absolute path", {
          field: "configDir",
          min: null,
          max: null,
        })
      const configDir = input.configDir === null ? null : path.resolve(input.configDir)
      if (configDir !== null && (await ownLoginFolder(configDir)))
        return context.error("setting_out_of_range", "configDir is one of own's login folders", {
          field: "configDir",
          min: null,
          max: null,
        })
      // Existence only: the credentials file is Claude Code's and is never read here (02 §8.7).
      const credentialsFound = await fs
        .stat(path.join(configDir ?? path.join(os.homedir(), ".claude"), ".credentials.json"))
        .then(
          (info) => info.isFile(),
          () => false,
        )
      return {
        ...sources.issue({ configDir, leaveOwnLogin: input.leaveOwnLogin === true }),
        runningSessions: [...sessions.running].filter(isSessionID),
        credentialsFound,
        restartRequired: true as const,
      }
    }),

    changeSourceExecute: guard(log, "plugin.claudeAuth.changeSource.execute", async (input, context) => {
      const planned = sources.consume(input.nonce)
      if (!planned) return context.error("nonce_invalid", "unknown or expired nonce", {})
      if (!state.slot.detected) return context.error("plugin_not_installed", "claude-auth is not loaded", {})
      const running = [...sessions.running].filter(isSessionID)
      if (running.length > 0)
        return context.error("session_busy", "finish or interrupt running sessions", { sessionIDs: running })
      // Moved to an own login since the plan: still never ignored silently.
      if (ownLogin() && !planned.leaveOwnLogin)
        return context.error("claude_account_unavailable", "account 1 is on an own login folder", {
          reason: "own_login",
        })
      // A junction made since the plan can turn the folder into one of own's: the plan is out of date.
      if (planned.configDir !== null && (await ownLoginFolder(planned.configDir)))
        return context.error("nonce_invalid", "configDir is one of own's login folders now", {})
      // The launcher reads OWN_HOME\claude-auth.json on every start and sets CLAUDE_CONFIG_DIR from it (8.7 contract);
      // the client only restarts the service. `null` removes the file: the default source again.
      const file = deps.runtime.layout.claudeAuth
      const setAt = new Date(deps.clock.now()).toISOString()
      if (planned.configDir === null) await Fsx.remove(file)
      else await Fsx.writeAtomic(file, `${JSON.stringify({ configDir: planned.configDir, setAt }, null, 2)}\n`)
      // Account 1 leaves its own login folder for the source; nothing names that folder now, so the sweep removes it.
      if (planned.leaveOwnLogin)
        await peers().slots.mutate((current) =>
          current.claudeSlot?.configDir === undefined
            ? undefined
            : { ...current, claudeSlot: Struct.omit(current.claudeSlot, ["configDir"]) },
        )
      log.info("claude_source_changed", { reset: planned.configDir === null, leftOwnLogin: planned.leaveOwnLogin })
      return { clientAction: { type: "restart-service" as const } }
    }),

    trustList: guard(log, "plugin.trust.list", async () => {
      await refresh()
      const trust = (await readTrust()) ?? []
      return {
        locations: Board.collect(hub).map((location) => {
          const evaluation = Trust.evaluate(location.directory, location.candidates, trust)
          return { directory: location.directory, status: evaluation.status, plugins: evaluation.plugins }
        }),
      }
    }),

    trustApprovePlan: guard(log, "plugin.trust.approve.plan", async (input, context) => {
      await refresh()
      const location = locationState(input.directory)
      if (!location) return context.error("internal_error", "location_not_open", {})
      const chosen = input.sources.map((source) =>
        location.candidates.find((candidate) => Trust.sameSource(candidate.source, source)),
      )
      const known = chosen.filter((candidate) => candidate !== undefined)
      if (known.length !== chosen.length) return context.error("internal_error", "unknown_source", {})
      const plugins = await Promise.all(
        known.map(async (candidate) => ({ ...candidate, sha256: await Trust.rehash(candidate) })),
      )
      const hashed = plugins.flatMap((plugin) => (plugin.sha256 === null ? [] : [{ ...plugin, sha256: plugin.sha256 }]))
      if (hashed.length !== plugins.length) return context.error("internal_error", "source_unreadable", {})
      return {
        ...approvals.issue({ directory: location.directory, plugins: hashed }),
        directory: location.directory,
        plugins: hashed,
        warning: Trust.APPROVAL_WARNING,
      }
    }),

    trustApproveExecute: guard(log, "plugin.trust.approve.execute", async (input, context) => {
      const planned = approvals.consume(input.nonce)
      if (!planned) return context.error("nonce_invalid", "unknown or expired nonce", {})
      const current = await Promise.all(
        planned.plugins.map(async (plugin) => ({ plugin, actual: await Trust.rehash(plugin) })),
      )
      const changed = current.find((item) => item.actual !== item.plugin.sha256)
      if (changed)
        return context.error("trust_hash_mismatch", "the plugin changed after the plan", {
          source: changed.plugin.source,
          expected: changed.plugin.sha256,
          actual: changed.actual ?? "",
        })
      const approvedAt = new Date(deps.clock.now()).toISOString()
      const file = await deps.runtime.trust
        .update((trust) =>
          planned.plugins.reduce(
            (next, plugin) =>
              Trust.approve(next, {
                directory: planned.directory,
                source: plugin.source,
                sha256: plugin.sha256,
                approvedAt,
              }),
            trust,
          ),
        )
        .catch((error: unknown) => {
          log.error("trust_write_failed", { error })
          return undefined
        })
      if (!file) return context.error("internal_error", "trust_write_failed", {})
      return { directory: planned.directory, status: await afterTrustChange(planned.directory, file) }
    }),

    trustRevoke: guard(log, "plugin.trust.revoke", async (input, context) => {
      const file = await deps.runtime.trust
        .update((trust) => {
          const next = Trust.revoke(trust, input.directory, input.source)
          return next.length === trust.length ? undefined : next
        })
        .catch((error: unknown) => {
          log.error("trust_write_failed", { error })
          return undefined
        })
      if (!file) return context.error("internal_error", "trust_write_failed", {})
      return { directory: input.directory, status: await afterTrustChange(input.directory, file) }
    }),
  }

  /**
   * Tells every Location to re-check (3.8 propagation) and answers with the target Location's state under the new
   * file: this instance re-checks its own Location; another open Location is evaluated from its last hashes.
   */
  async function afterTrustChange(target: string, file: Registry.TrustFile): Promise<Plugin.TrustStatus> {
    hub.emit("store.changed", { store: "trust", origin: "local" })
    if (Location.same(target, directory)) {
      await refresh()
      return state.trust
    }
    const location = locationState(target)
    return location ? Trust.evaluate(location.directory, location.candidates, file).status : "ok"
  }
}

/**
 * Handlers never throw (02 §9.4): an unexpected exception is logged (redacted) and answered as `internal_error`, a
 * declared 400 instead of the host's 500 `rpc.internal`.
 */
function guard<N extends RpcTypes.MethodName>(
  log: Deps["log"],
  method: N,
  handler: RpcTypes.Handler<N>,
): RpcTypes.Handler<N> {
  const run = handler as unknown as (input: unknown, context: RpcTypes.Context<N>) => Promise<unknown>
  const guarded = (input: unknown, context: RpcTypes.Context<N>) =>
    run(input, context).catch((error: unknown) => {
      log.error("handler_failed", { method, error })
      // SAFETY: every own.accounts method declares `internal_error` with empty data (`OwnError.pick` adds it).
      const fail = context.error as unknown as (type: string, message: string, data: object) => unknown
      return fail("internal_error", "unexpected", {})
    })
  // SAFETY: `guarded` takes the parameters of `handler` and returns its result or a declared error.
  return guarded as unknown as RpcTypes.Handler<N>
}

/** An `env` or `key` connection on `anthropic` bills the API instead of the subscription (02 §8.9). */
function billsApi(connection: ReturnType<typeof Claude.connection>) {
  return connection !== null && connection.type !== "oauth"
}

/**
 * Runs `run` at most once at a time; calls made while it runs share one follow-up run, so a burst of
 * `plugin.updated` events costs two list reads, not one per event. Errors are logged, never thrown.
 */
function coalesce(run: () => Promise<void>, log: Deps["log"]) {
  const queue = { chain: Promise.resolve(), queued: false }
  return () => {
    if (queue.queued) return queue.chain
    queue.queued = true
    queue.chain = queue.chain.then(async () => {
      queue.queued = false
      await run().catch((error: unknown) => log.error("refresh_failed", { error }))
    })
    return queue.chain
  }
}

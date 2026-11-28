
// Vendored from packages/desktop/src/main/ssh/controller.ts @ 00d179015f (MIT), rewritten. See own/ledger/vendored.yaml
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Home } from "@own/runtime"
import { Events } from "./events.js"
import type { Log } from "./log.js"
import { Log as LogModule } from "./log.js"
import { Loopback } from "./loopback.js"
import type { Options } from "./options.js"
import { Prompt } from "./prompt.js"
import { Broker } from "./protocol/broker.js"
import type { OwnRemote } from "./protocol/rpc-remote.js"
import { Registry } from "./registry.js"
import { RemoteClient } from "./remote/client.js"
import { RemoteModel } from "./remote/model.js"
import { Scripts } from "./remote/scripts.js"
import { SshConfig } from "./ssh/config.js"
import { Failure } from "./ssh/failure.js"
import { Liveness } from "./ssh/liveness.js"
import { SshRunner } from "./ssh/runner.js"
import { Tunnel } from "./ssh/tunnel.js"
import { Token } from "./token.js"
import type { AskpassPrompt } from "./vendor/ssh/askpass.js"
import { minimalEnv, parseTarget, shortArgs, tunnelArgs, WINDOWS_SSH, type Target } from "./vendor/ssh/command.js"

/**
 * The process-lifetime SSH controller (04 §4.1, §6, §7). One per OWN_HOME and build, shared by every plugin
 * instance; plugin instances only answer RPC and republish events. Each host is an independent state machine
 * (04 §6.3 "호스트 격리"): no global lock, one attempt at a time per host, and a failure never blocks other hosts.
 */

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000]
const MAX_FAILURES = 5

export interface Input {
  readonly buildId: string
  /** Version a live connection requires (the local release version, 04 §5.7). */
  readonly version: string
  readonly ownHome: string
  readonly options: Options.Info
  readonly log?: Log.Logger
  /** `@own/runtime` services, searched first for a `broker` (04 §4.2). */
  readonly services?: object
}

interface PendingPrompt extends AskpassPrompt {}

/** The `host.prompt` payload (04 §16.3): the classified prompt and its owner, never an answer. */
export type PromptEvent = Extract<Events.Event, { readonly name: "host.prompt" }>["data"]

export function promptEvent(hostId: string, prompt: AskpassPrompt, owner: string | null | undefined): PromptEvent {
  return {
    hostId,
    promptId: prompt.id,
    kind: prompt.kind,
    text: prompt.text,
    ...(prompt.fingerprint ? { fingerprint: prompt.fingerprint } : {}),
    ...(prompt.keyType ? { keyType: prompt.keyType } : {}),
    ownerClientId: owner ?? null,
  }
}

interface Attempt {
  readonly serial: number
  owner: string | undefined
  readonly hostKeyPrompt: boolean
  /** Journal id of the update that runs this attempt; its own ensure passes the ops check (04 §6.1 step 3). */
  readonly opId: string | undefined
  readonly abort: AbortController
  askpass?: SshRunner.Askpass
  prompt?: PendingPrompt
  /** A background attempt met a prompt: it was cancelled and the host paused (04 §6.3). */
  promptBlocked: boolean
  done?: Promise<void>
  readonly before: { readonly stage: OwnRemote.Stage; readonly error: OwnRemote.HostError | null; readonly detail: string }
}

interface Live {
  readonly tunnel: Tunnel.Handle
  readonly url: string
  readonly password: string
  readonly controlDir: string
  readonly home: string
  readonly epoch: number
  /**
   * Broker forward of this tunnel and its key, kept for a same-epoch re-arm (04 §8.3), and the Claude egress relay's
   * forward when the tunnel carries one (04 §8.11.4.2).
   */
  readonly broker:
    | { readonly endpoint: Broker.Endpoint; readonly key: Buffer; readonly egress: Broker.Endpoint | undefined }
    | undefined
  token?: { readonly value: string; readonly expiresAt: number }
}

export interface HostState {
  stage: OwnRemote.Stage
  paused: boolean
  error: OwnRemote.HostError | null
  detail: string
  failures: number
  attempt: Attempt | undefined
  live: Live | undefined
  retry: ReturnType<typeof setTimeout> | undefined
  identityChanged: boolean
  resolved: SshConfig.Resolved | undefined
  stderrTail: string
  inspect: RemoteModel.Inspect | undefined
  probe: unknown
  remoteRunning: string | null
  /** Client that owned the last interactive attempt; prompts of later operations go to it. */
  lastOwner: string | undefined
  /** An install, update, drain or forget in progress (`host_busy`). */
  busy: { readonly opId: string; readonly kind: string } | undefined
  brokerNote: "unavailable" | "armed" | "arm_failed" | undefined
  armedAt: number | undefined
  /** When the live tunnel last ended by itself: `connection` failures keep retrying for a while (Liveness.DROP_RETRY_MS). */
  droppedAt: number | undefined
}

export class Controller {
  readonly registry: Registry.Store
  readonly runner: SshRunner.Runner
  readonly hub = new Events.Hub()
  readonly input: Input
  readonly log: Log.Logger
  readonly remoteDir: string
  readonly sshCommand: readonly string[]
  readonly askpassHelper: string
  readonly bundlesDir: string
  readonly sshDir: string
  readonly #hosts = new Map<string, HostState>()
  readonly #heartbeats = new Map<string, number>()
  /** Prompts of operations (install, update, drain), answered through `respond` like attempt prompts. */
  readonly #routed = new Map<
    string,
    {
      readonly hostId: string
      readonly kind: Prompt.Kind
      readonly owner: string
      readonly respond: (value: string | null) => Promise<void>
      /** The `host.prompt` payload, sent again by `heartbeat{replay}`. */
      readonly event?: PromptEvent
    }
  >()
  #serial = 0
  #closed = false
  #tickAt = Date.now()
  readonly #timers: Array<ReturnType<typeof setInterval>> = []
  #brokerUnsubscribe: (() => void) | undefined

  constructor(input: Input) {
    this.input = input
    this.log = input.log ?? LogModule.silent
    this.remoteDir = path.join(input.ownHome, "remote")
    this.registry = new Registry.Store({ dir: this.remoteDir, lockDir: path.join(input.ownHome, "locks") })
    const options = input.options
    this.sshCommand =
      options.sshCommand && options.sshCommand.length > 0
        ? options.sshCommand
        : [options.sshPath ?? (process.platform === "win32" ? WINDOWS_SSH : "ssh")]
    this.runner = new SshRunner.Runner({ command: this.sshCommand })
    // The installed version (app\current.json, never through a junction): its opencode.exe and remote bundles.
    const app = Home.layout(input.ownHome).app
    this.askpassHelper = options.askpassHelper ?? path.join(app, "opencode.exe")
    this.bundlesDir = options.remoteBundles ?? path.join(app, "remote")
    this.sshDir = options.sshDir ?? path.join(os.homedir(), ".ssh")
  }

  get version() {
    return this.input.version
  }

  async start() {
    const data = await this.registry.load()
    for (const record of data.hosts) {
      this.#hosts.set(record.id, this.#fresh())
      await Tunnel.cleanupOrphan(this.#pidFile(record.id)).catch(() => "none")
    }
    // Startup (04 §6.3): hosts come up paused; only autoConnect hosts try once in the background.
    for (const record of data.hosts) if (record.autoConnect) void this.connect(record.id, { background: true })
    this.#timers.push(setInterval(() => this.#sweepOwners(), 5000))
    this.#timers.push(setInterval(() => void this.#rearmCheck(), 30_000))
    this.#timers.push(setInterval(() => this.#tick(), Liveness.TICK_MS))
    for (const timer of this.#timers) timer.unref?.()
    const broker = this.broker()
    this.#brokerUnsubscribe = broker?.subscribe((hostId, status) => {
      if (!this.#hosts.has(hostId)) return
      if (status.state === "connected") {
        const host = this.#hosts.get(hostId)
        if (host) host.armedAt = Date.now()
      }
      this.hub.emit({
        name: "broker.status",
        data: {
          hostId,
          state: status.state,
          leasesActive: status.leasesActive,
          spoolBacklog: status.spoolBacklog,
          ...(status.claude
            ? {
                claude: {
                  state: status.claude.state,
                  lastError: status.claude.lastError,
                  holdUntil: status.claude.holdUntil,
                },
              }
            : {}),
        },
      })
    })
  }

  /** Ends every tunnel (the remote services keep running, 04 §6.2) and the askpass servers. */
  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const timer of this.#timers) clearInterval(timer)
    this.#brokerUnsubscribe?.()
    await Promise.allSettled([...this.#hosts.keys()].map((id) => this.#stop(id, { pause: true, stage: "disconnected" })))
    await this.runner.dispose()
  }

  broker() {
    return Broker.findLocal(this.input.buildId, this.input.services)
  }

  host(id: string) {
    return this.#hosts.get(id)
  }

  record(id: string) {
    return this.registry.get(id)
  }

  #fresh(): HostState {
    return {
      stage: "disconnected",
      paused: true,
      error: null,
      detail: "",
      failures: 0,
      attempt: undefined,
      live: undefined,
      retry: undefined,
      identityChanged: false,
      resolved: undefined,
      stderrTail: "",
      inspect: undefined,
      probe: undefined,
      remoteRunning: null,
      lastOwner: undefined,
      busy: undefined,
      brokerNote: undefined,
      armedAt: undefined,
      droppedAt: undefined,
    }
  }

  #pidFile(id: string) {
    return path.join(this.remoteDir, id, "tunnel.pid")
  }

  // -------------------------------------------------------------------------------------------------------------
  // Registry

  async addHost(input: { readonly alias: string } | { readonly target: string; readonly name: string }) {
    const target = "alias" in input ? input.alias : input.target
    try {
      parseTarget(target, { profile: path.dirname(this.sshDir) })
    } catch {
      return { ok: false as const, reason: "input" as const }
    }
    const data = await this.registry.load()
    const used = new Set(data.hosts.map((host) => host.loopback))
    const k = await Loopback.pickK(used)
    if (k === undefined) return { ok: false as const, reason: "loopback" as const, address: Loopback.apiAddress(1) }
    const port = await Loopback.pickPort(
      Loopback.apiAddress(k),
      new Set(data.hosts.map((host) => host.localPort)),
    )
    if (port === undefined) return { ok: false as const, reason: "loopback" as const, address: Loopback.apiAddress(k) }
    // Loose host key settings in the file view (04 §7.2): warn, and allow no broker account until the user picks.
    const blocks = await SshConfig.read(path.join(this.sshDir, "config")).catch(() => [])
    const info = "alias" in input ? SshConfig.aliases(blocks).find((item) => item.alias === input.alias) : undefined
    const warnings = [
      ...(info?.looseHostKey ? ["loose_host_key"] : []),
      ...(info?.localhostForward ? ["config_forward_localhost"] : []),
    ]
    const record: Registry.HostRecord = {
      id: Registry.newHostId(),
      alias: "alias" in input ? input.alias : null,
      name: "alias" in input ? input.alias : input.name,
      target,
      loopback: k,
      localPort: port,
      remotePort: this.input.options.remoteTest?.port ?? null,
      autoConnect: Registry.DEFAULTS.autoConnect,
      accounts: info?.looseHostKey ? { mode: "only", ids: [] } : Registry.DEFAULTS.accounts,
      leaseSeconds: Registry.DEFAULTS.leaseSeconds,
      failClosedGraceSeconds: Registry.DEFAULTS.failClosedGraceSeconds,
      tokenTtlHours: Registry.DEFAULTS.tokenTtlHours,
      installRoot: this.input.options.remoteInstallRoot ?? null,
      projectConfig: Registry.DEFAULTS.projectConfig,
      shellEnv: Registry.DEFAULTS.shellEnv,
      env: {},
      pathPrepend: [],
      hostIdentity: null,
      epoch: 0,
      broker: { mode: "socket", tcpPort: null },
      remote: null,
      platform: null,
      warnings,
      pendingSettings: false,
      appliedSettings: null,
      recentFolders: [],
      probedSettings: null,
      addedAt: Date.now(),
    }
    const written = await this.registry.update((current) => ({ ...current, hosts: [...current.hosts, record] }))
    this.#hosts.set(record.id, this.#fresh())
    this.hub.emit({ name: "hosts.changed", data: { revision: written.revision } })
    return { ok: true as const, record }
  }

  async updateHost(id: string, patch: Partial<Registry.HostRecord>) {
    const before = this.registry.get(id)
    if (!before) return undefined
    const next = { ...before, ...patch }
    const restart = RemoteModel.settingsHash(next) !== RemoteModel.settingsHash(before)
    const written = await this.registry.patchHost(id, {
      ...patch,
      ...(restart ? { pendingSettings: next.appliedSettings !== RemoteModel.settingsHash(next) } : {}),
    })
    this.broker()?.configure(id, {
      accounts: next.accounts,
      leaseSeconds: next.leaseSeconds,
      failClosedGraceSeconds: next.failClosedGraceSeconds,
    })
    this.hub.emit({ name: "hosts.changed", data: { revision: written.revision } })
    return this.registry.get(id)
  }

  async removeHost(id: string) {
    await this.#stop(id, { pause: true, stage: "disconnected" })
    await this.broker()?.close(id).catch(() => {})
    const written = await this.registry.update((data) => ({ ...data, hosts: data.hosts.filter((host) => host.id !== id) }))
    this.#hosts.delete(id)
    await fs.rm(path.join(this.remoteDir, id), { recursive: true, force: true }).catch(() => {})
    this.hub.emit({ name: "hosts.changed", data: { revision: written.revision } })
  }

  // -------------------------------------------------------------------------------------------------------------
  // State

  #set(id: string, patch: Partial<Pick<HostState, "stage" | "paused" | "error" | "detail">>) {
    const host = this.#hosts.get(id)
    if (!host) return
    const before = `${host.stage}|${host.paused}|${host.error}|${host.detail}`
    Object.assign(host, patch)
    if (`${host.stage}|${host.paused}|${host.error}|${host.detail}` === before) return
    this.hub.emit({
      name: "host.state",
      data: {
        hostId: id,
        stage: host.stage,
        paused: host.paused,
        error: host.error,
        detail: host.detail,
        ...(host.live ? { epoch: host.live.epoch } : {}),
        versions: this.versions(id),
      },
    })
  }

  versions(id: string) {
    const host = this.#hosts.get(id)
    const running = host?.remoteRunning ?? host?.inspect?.running?.version ?? null
    return {
      local: this.version,
      remoteRunning: running,
      remoteStaged: (host?.inspect?.installed ?? []).filter((version) => version !== running),
      skew: running !== null && running !== this.version,
    }
  }

  progress(id: string, op: "install" | "update" | "drain" | "sync" | "forget", step: string, extra: { opId?: string; ok?: boolean; error?: string } = {}) {
    this.hub.emit({ name: "host.progress", data: { hostId: id, op, step, ...extra } })
  }

  // -------------------------------------------------------------------------------------------------------------
  // Connect (04 §3.2, §6.1, §6.3)

  /**
   * Starts an attempt unless one is running. An interactive attempt of another client is never replaced while it is
   * not ready (upstream `controller.ts:58-68`). Returns the stage right after admission.
   */
  async connect(
    id: string,
    input: {
      readonly clientId?: string
      readonly hostKeyPrompt?: boolean
      readonly background?: boolean
      readonly opId?: string
    } = {},
  ): Promise<OwnRemote.Stage> {
    const host = this.#hosts.get(id)
    if (!host || this.#closed) return "disconnected"
    const owner = input.background ? undefined : input.clientId
    const running = host.attempt
    if (running) {
      if (running.owner !== undefined && running.owner !== owner) return host.stage
      if (running.owner === owner) return host.stage
      // A background attempt gives way to an interactive one.
      running.abort.abort()
      await running.done?.catch(() => {})
    }
    if (host.busy && !input.opId) return host.stage
    if (host.retry) clearTimeout(host.retry)
    host.retry = undefined
    if (owner) {
      this.#heartbeats.set(owner, Date.now())
      host.lastOwner = owner
      host.failures = 0
    }
    if (host.live && !input.hostKeyPrompt) {
      host.paused = false
      return host.stage
    }
    const attempt: Attempt = {
      serial: ++this.#serial,
      owner,
      hostKeyPrompt: input.hostKeyPrompt === true && owner !== undefined,
      opId: input.opId,
      abort: new AbortController(),
      promptBlocked: false,
      before: { stage: host.stage, error: host.error, detail: host.detail },
    }
    host.attempt = attempt
    this.#set(id, { stage: "connecting", paused: false, error: null, detail: "" })
    attempt.done = this.#run(id, attempt)
      .catch((error: unknown) => {
        this.log.error("attempt_crashed", { hostId: id, error })
        this.#fail(id, attempt, { error: "connection", detail: "internal", pause: false })
      })
      .finally(async () => {
        await attempt.askpass?.close().catch(() => {})
        attempt.askpass = undefined
        if (host.attempt === attempt) host.attempt = undefined
      })
    return host.stage
  }

  async #run(id: string, attempt: Attempt) {
    const record = this.registry.get(id)
    if (!record) return
    const host = this.#hosts.get(id)!
    const signal = attempt.abort.signal
    let target: Target
    try {
      target = parseTarget(record.target, { profile: path.dirname(this.sshDir) })
    } catch {
      return this.#fail(id, attempt, { error: "input", detail: "", pause: true })
    }
    // A source run ("local") has no remote bundle to match (04 §5.7): development sets the plugin option `version`.
    if (!/^[0-9][a-zA-Z0-9.+-]*$/.test(this.version))
      return this.#fail(id, attempt, { error: "input", detail: `local version ${this.version} is not a release`, pause: true })
    if (!this.input.options.sshCommand && path.isAbsolute(this.sshCommand[0]!) && !existsSync(this.sshCommand[0]!))
      return this.#fail(id, attempt, { error: "ssh_missing", detail: this.sshCommand[0]!, pause: true })
    // Every connection except the host-key flows refuses unknown host keys (04 §6.3, §14.2).
    const strict: Target = {
      host: target.host,
      args: [...(attempt.hostKeyPrompt ? [] : ["-o", "StrictHostKeyChecking=yes"]), ...target.args],
    }
    attempt.askpass = await this.runner.askpass({
      binary: this.askpassHelper,
      prompt: (prompt) => this.#onPrompt(id, attempt, prompt),
      clear: (promptId) => this.#onClear(id, attempt, promptId),
    })
    const env = { ...minimalEnv(), ...attempt.askpass.env }
    if (signal.aborted) return

    // Forward detection right before connecting (04 §7.5): ssh's own resolution, no connection.
    const resolved = await this.runner.resolved(strict, env)
    if (resolved.ok) {
      host.resolved = SshConfig.parseResolved(resolved.stdout)
      if (host.resolved.forwardKinds.length > 0)
        return this.#fail(id, attempt, { error: "forward_conflict", detail: host.resolved.forwardKinds.join(","), pause: true })
      if (SshConfig.looseResolved(host.resolved) && !record.warnings.includes("loose_host_key"))
        await this.registry.patchHost(id, (current) => ({ warnings: [...current.warnings, "loose_host_key"] }))
    }
    if (signal.aborted) return

    // inspect only on first contact, host-key flows, and when the stored paths are missing (04 §7.1).
    let current = this.registry.get(id)!
    if (!current.remote || !current.hostIdentity || attempt.hostKeyPrompt || !current.platform) {
      const inspected = await this.inspect(id, strict, env, signal)
      if (signal.aborted) return
      if (!inspected.ok) return this.#fail(id, attempt, inspected.failure)
      current = this.registry.get(id)!
      if (inspected.needsInstall) {
        host.failures = 0
        this.#set(id, { stage: "needs_install", paused: true, error: null, detail: "" })
        return
      }
    }
    await this.#tunnel(id, attempt, strict, env)
  }

  /** The remote command of every ssh call: unchanged, or under the test root of Options `remoteTest` (decisions RL35). */
  remoteCommand(command: string) {
    return RemoteModel.remoteCommand(command, this.input.options.remoteTest?.root)
  }

  /**
   * inspect (04 §5.4): platform, identity, owner, journals, shell environments. Records paths and warnings.
   * Shared with `prepare.plan` and `update.plan`.
   */
  async inspect(
    id: string,
    target: Target,
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly inspect: RemoteModel.Inspect; readonly needsInstall: boolean }
    | { readonly ok: false; readonly failure: Failure.Classified }
  > {
    const host = this.#hosts.get(id)!
    const record = this.registry.get(id)!
    this.#set(id, { stage: "checking" })
    const run = await this.runner.run({
      args: [...shortArgs(target), target.host, this.remoteCommand("sh -s")],
      env,
      stdin: Scripts.inspect({ ownHome: record.installRoot ?? record.remote?.ownHome }),
      timeout: this.input.options.scriptTimeoutMs ?? 120_000,
    })
    if (signal?.aborted) return { ok: false, failure: { error: "connection", detail: "aborted", pause: false } }
    if (!run.ok) {
      host.stderrTail = LogModule.scrub(run.failure.message)
      return { ok: false, failure: Failure.classify(run.failure) }
    }
    const inspect = RemoteModel.parseInspect(run.stdout)
    host.inspect = inspect
    if (!inspect.complete) return { ok: false, failure: { error: "connection", detail: "inspect incomplete", pause: false } }
    if (!(RemoteModel.SUPPORTED_TARGETS as readonly string[]).includes(inspect.target))
      return { ok: false, failure: { error: "platform_unsupported", detail: `${inspect.os}/${inspect.arch}`, pause: true } }
    if (record.hostIdentity && inspect.identity !== record.hostIdentity) {
      host.identityChanged = true
      return { ok: false, failure: { error: "host_identity_changed", detail: inspect.identity, pause: true } }
    }
    const data = this.registry.snapshot()
    if (inspect.owner && inspect.owner !== data.installId)
      return { ok: false, failure: { error: "other_owner", detail: inspect.ownerLabel ?? "", pause: true } }
    if (inspect.opsPending.length > 0)
      return {
        ok: false,
        failure: { error: "ops_pending", detail: inspect.opsPending.map((op) => `${op.opId}:${op.kind}`).join(","), pause: true },
      }
    const testRoot = this.input.options.remoteTest?.root
    const lost = testRoot === undefined ? undefined : RemoteModel.testRootLost(inspect, record.shellEnv, testRoot)
    if (lost !== undefined)
      return {
        ok: false,
        failure: { error: "input", detail: `the host's shell does not keep the test root's ${lost}`, pause: true },
      }
    const paths = RemoteModel.remotePaths(inspect, record.shellEnv, record.installRoot, testRoot)
    const warnings = new Set<string>(
      record.warnings.filter((warning) => warning === "loose_host_key" || warning === "config_forward_localhost"),
    )
    for (const warning of RemoteModel.warnings(inspect, record.shellEnv)) warnings.add(warning)
    await this.registry.patchHost(id, {
      remote: paths,
      platform: { os: inspect.os, arch: inspect.arch, target: inspect.target, libc: inspect.libc },
      hostIdentity: record.hostIdentity ?? inspect.identity,
      warnings: [...warnings],
    })
    host.remoteRunning = inspect.running?.exeOk ? inspect.running.version : null
    return { ok: true, inspect, needsInstall: !inspect.installed.includes(this.version) }
  }

  async #tunnel(id: string, attempt: Attempt, target: Target, env: Record<string, string>) {
    const host = this.#hosts.get(id)!
    const signal = attempt.abort.signal
    let floor = 0
    let portMode: "default" | "force" = "default"
    let forcedPort: number | undefined
    for (let round = 0; round < 4; round++) {
      if (signal.aborted) return
      const record = this.registry.get(id)!
      const paths = record.remote!
      const epoch = Registry.nextEpoch(Math.max(record.epoch, floor))
      await this.registry.patchHost(id, { epoch })
      const address = Loopback.apiAddress(record.loopback)
      let localPort = record.localPort
      const bind = await Loopback.tryBind(address, localPort)
      if (bind === "unavailable") return this.#fail(id, attempt, { error: "loopback_unavailable", detail: address, pause: true })
      if (bind === "in_use") {
        const temporary = await Loopback.ephemeralPort(address)
        if (temporary === undefined) return this.#fail(id, attempt, { error: "loopback_unavailable", detail: address, pause: true })
        localPort = temporary
      }
      const remotePort = forcedPort ?? record.remotePort ?? RemoteModel.defaultPort()
      // Broker forward (04 §7.4): a stream socket under the socket directory, or the TCP fallback.
      const broker = this.broker()
      let brokerForward: { remote: Broker.Endpoint; localPort: number } | undefined
      // 04 §8.11.4.2: the Claude egress relay's forward, beside the broker's, when the relay listens on this PC.
      let egressForward: { remote: Broker.Endpoint; localPort: number } | undefined
      if (broker) {
        const listener = await broker.listen(id).catch(() => undefined)
        if (listener) {
          const tcpPort = record.broker.tcpPort ?? randomPort()
          brokerForward =
            record.broker.mode === "socket"
              ? { remote: { socket: RemoteModel.socketPath(paths.socketDir, epoch) }, localPort: listener.port }
              : { remote: { tcpPort }, localPort: listener.port }
          if (listener.egressPort !== undefined)
            egressForward =
              record.broker.mode === "socket"
                ? { remote: { socket: RemoteModel.egressSocketPath(paths.socketDir, epoch) }, localPort: listener.egressPort }
                : { remote: { tcpPort: egressTcpPort(record.broker.egressTcpPort, tcpPort) }, localPort: listener.egressPort }
        }
      }
      host.brokerNote = broker ? undefined : "unavailable"
      const data = this.registry.snapshot()
      const script = Scripts.ensure({
        version: this.version,
        ownHome: paths.ownHome,
        stateDir: paths.stateDir,
        configDir: paths.configDir,
        upstreamConfigDir: paths.upstreamConfigDir,
        identity: record.hostIdentity ?? "",
        installId: data.installId,
        ownerJson: JSON.stringify({ installId: data.installId, hostId: id, label: os.hostname() }),
        epoch,
        ...(attempt.opId ? { opId: attempt.opId } : {}),
        socketDir: brokerForward && "socket" in brokerForward.remote ? paths.socketDir : "",
        port: remotePort,
        portMode,
        envJson: JSON.stringify(RemoteModel.serviceEnv(record, paths)),
        managedConfig: RemoteModel.managedConfig(paths),
        shellEnv: record.shellEnv,
        pathPrepend: record.pathPrepend.join(":"),
        keepInterval: this.input.options.keepIntervalSeconds ?? 15,
      })
      this.#set(id, { stage: "starting" })
      const started = await Tunnel.start({
        command: this.sshCommand,
        args: tunnelArgs(
          target,
          { address, port: localPort },
          { host: "127.0.0.1", port: remotePort },
          brokerForward,
          egressForward,
          this.remoteCommand("sh -s"),
        ),
        env,
        script,
        timeoutMs: this.input.options.scriptTimeoutMs ?? 120_000,
        authenticating: () => attempt.prompt !== undefined,
        signal,
        pidFile: this.#pidFile(id),
      })
      if (signal.aborted) {
        if (started.ok) await started.tunnel.close(500)
        return
      }
      if (!started.ok) {
        host.stderrTail = LogModule.scrub(started.stderr)
        if (attempt.promptBlocked) return
        if (brokerForward && Failure.remoteForwardFailed(started.stderr)) {
          // 04 §7.4: a /tmp short directory lost on reboot is recreated; otherwise fall back to TCP.
          if ("socket" in brokerForward.remote && paths.socketDir.startsWith("/tmp/") && round === 0) {
            await this.runner.run({
              args: [...shortArgs(target), target.host, this.remoteCommand("sh -s")],
              env,
              stdin: Scripts.prepareSocketDir(paths.socketDir),
              timeout: 30_000,
            })
            continue
          }
          await this.registry.patchHost(id, { broker: { mode: "tcp", tcpPort: null, egressTcpPort: null } })
          continue
        }
        return this.#fail(id, attempt, Failure.classifyStart(started))
      }
      const report = RemoteModel.parseEnsure(started.output)
      const stop = async (failure: Failure.Classified) => {
        await started.tunnel.close(1000)
        return this.#fail(id, attempt, failure)
      }
      switch (report.result) {
        case "ready":
        case "version_skew":
          break
        case "stale_epoch":
          await started.tunnel.close(1000)
          floor = report.staleEpoch ?? epoch
          continue
        case "host_identity_changed":
          host.identityChanged = true
          return stop({ error: "host_identity_changed", detail: report.identity ?? "", pause: true })
        case "other_owner":
          return stop({ error: "other_owner", detail: report.ownerLabel ?? "", pause: true })
        case "ops_pending":
          return stop({ error: "ops_pending", detail: report.ops ?? "", pause: true })
        case "service_not_loopback":
          return stop({ error: "service_not_loopback", detail: report.hostname ?? "", pause: true })
        case "run_unsafe":
          return stop({ error: "broker_failed", detail: "run directory is not private", pause: true })
        case "not_installed":
          await started.tunnel.close(1000)
          this.#set(id, { stage: "needs_install", paused: true, error: null, detail: "" })
          return
        case "service_failed":
          // A busy channel port on first start (04 §5.6): pick another fixed port once.
          if (record.remotePort === null && portMode === "default") {
            await started.tunnel.close(1000)
            portMode = "force"
            forcedPort = 20_000 + Math.floor(Math.random() * 40_000)
            continue
          }
          return stop({ error: "service_failed", detail: "service start failed", pause: false })
        default:
          return stop({ error: "service_failed", detail: report.result ?? "no result", pause: false })
      }
      if (report.hostname === "not_loopback")
        return stop({ error: "service_not_loopback", detail: "registration", pause: true })
      const registration = report.registration
      if (!registration) return stop({ error: "service_failed", detail: "no registration", pause: false })
      const registeredPort = Number(URL.parse(registration.url)?.port || 80)
      if (registeredPort !== remotePort) {
        // The service runs on another port than the tunnel targets: record it and rebuild the tunnel (04 §3.2).
        await this.registry.patchHost(id, { remotePort: registeredPort })
        await started.tunnel.close(1000)
        forcedPort = undefined
        continue
      }
      if (record.remotePort !== remotePort) await this.registry.patchHost(id, { remotePort })
      if (report.socketDir === "unsafe" && brokerForward && "socket" in brokerForward.remote)
        await this.registry.patchHost(id, { broker: { mode: "tcp", tcpPort: null, egressTcpPort: null } })
      if (brokerForward && "tcpPort" in brokerForward.remote)
        await this.registry.patchHost(id, {
          broker: {
            mode: "tcp",
            tcpPort: brokerForward.remote.tcpPort,
            egressTcpPort:
              egressForward && "tcpPort" in egressForward.remote
                ? egressForward.remote.tcpPort
                : (record.broker.egressTcpPort ?? null),
          },
        })
      return this.#established(id, attempt, {
        tunnel: started.tunnel,
        url: `http://${address}:${localPort}`,
        password: registration.password,
        controlDir: report.controlDir ?? `${paths.ownHome}/control`,
        home: report.home ?? paths.home,
        epoch,
        skew: report.result === "version_skew",
        runningVersion: report.runningVersion ?? registration.version,
        brokerForward,
        egressForward,
        started: report.result === "ready" && report.startedService,
      })
    }
    return this.#fail(id, attempt, { error: "connection", detail: "tunnel retries exhausted", pause: false })
  }

  async #established(
    id: string,
    attempt: Attempt,
    input: {
      readonly tunnel: Tunnel.Handle
      readonly url: string
      readonly password: string
      readonly controlDir: string
      readonly home: string
      readonly epoch: number
      readonly skew: boolean
      readonly runningVersion: string
      readonly brokerForward: { remote: Broker.Endpoint; localPort: number } | undefined
      readonly egressForward: { remote: Broker.Endpoint; localPort: number } | undefined
      readonly started: boolean
    },
  ) {
    const host = this.#hosts.get(id)!
    const signal = attempt.abort.signal
    // Readiness (04 §6.1 step 8): an alive pid that does not answer in time is "hung", never killed automatically.
    const ready = await RemoteClient.waitReady(
      { url: input.url, secret: input.password },
      { timeoutMs: this.input.options.readyTimeoutMs ?? 30_000, extend: () => attempt.prompt !== undefined, signal },
    )
    if (signal.aborted) {
      await input.tunnel.close(500)
      return
    }
    if (!ready) {
      await input.tunnel.close(1000)
      return this.#fail(id, attempt, { error: "service_unresponsive", detail: "", pause: true })
    }
    const key = input.brokerForward ? randomBytes(Broker.KEY_BYTES) : undefined
    host.live = {
      tunnel: input.tunnel,
      url: input.url,
      password: input.password,
      controlDir: input.controlDir,
      home: input.home,
      epoch: input.epoch,
      broker:
        input.brokerForward && key
          ? { endpoint: input.brokerForward.remote, key, egress: input.egressForward?.remote }
          : undefined,
    }
    host.remoteRunning = input.runningVersion
    host.failures = 0
    host.droppedAt = undefined
    host.stderrTail = ""
    void input.tunnel.exited.then(() => this.#onTunnelExit(id, input.tunnel))
    // The askpass server is only needed for authentication.
    await attempt.askpass?.close().catch(() => {})
    attempt.askpass = undefined
    await this.arm(id)
    const record = this.registry.get(id)!
    const settings = RemoteModel.settingsHash(record)
    if (input.started) await this.registry.patchHost(id, { appliedSettings: settings, pendingSettings: false })
    if (!input.skew && record.probedSettings !== settings) {
      const probe = await RemoteClient.call<unknown>(this.endpoint(id)!, "agent.probe", {}, 20_000)
      if (probe.ok) {
        host.probe = probe.output
        await this.registry.patchHost(id, { probedSettings: settings })
      }
    }
    if (input.skew) {
      // 04 §5.7: live use is blocked, the tunnel stays for drain checks and the broker's drain mode.
      this.#set(id, { stage: "incompatible", paused: true, error: "version_skew", detail: input.runningVersion })
      return
    }
    this.#set(id, { stage: "ready", paused: false, error: null, detail: "" })
    this.log.info("ready", { hostId: id, epoch: input.epoch })
  }

  /** Arms the remote broker client with this epoch's key (04 §8.3). Same epoch + same key on a re-arm. */
  async arm(id: string) {
    const host = this.#hosts.get(id)
    const live = host?.live
    const record = this.registry.get(id)
    const broker = this.broker()
    if (!host || !live || !record) return
    if (!broker || !live.broker) {
      host.brokerNote = "unavailable"
      return
    }
    broker.setKey(id, { epoch: live.epoch, key: live.broker.key })
    broker.configure(id, {
      accounts: record.accounts,
      leaseSeconds: record.leaseSeconds,
      failClosedGraceSeconds: record.failClosedGraceSeconds,
    })
    const result = await RemoteClient.call<{ accepted: boolean; reason?: string }>(this.endpoint(id)!, "agent.broker.arm", {
      hostId: id,
      epoch: live.epoch,
      key: live.broker.key.toString("base64url"),
      endpoint: live.broker.endpoint,
      ...(live.broker.egress ? { egress: live.broker.egress } : {}),
      proto: Broker.PROTO,
    })
    host.brokerNote = result.ok && result.output.accepted ? "armed" : "arm_failed"
    host.armedAt = Date.now()
    if (!(result.ok && result.output.accepted))
      this.log.warn("arm_refused", { hostId: id, reason: result.ok ? result.output.reason : result.type })
  }

  /** 04 §8.3: the tunnel lives but no broker connection for 30 s → `agent.status`; `unarmed` → re-arm. */
  async #rearmCheck() {
    const broker = this.broker()
    if (!broker) return
    for (const [id, host] of this.#hosts) {
      if (!host.live?.broker || host.stage !== "ready") continue
      const status = broker.status(id)
      if (status.state === "connected") continue
      if (host.armedAt !== undefined && Date.now() - host.armedAt < 30_000) continue
      const remote = await RemoteClient.call<{ broker: { state: string } }>(this.endpoint(id)!, "agent.status", {})
      if (remote.ok && remote.output.broker.state === "unarmed") await this.arm(id)
    }
  }

  /** Endpoint of a live host for own-remote's own calls (password auth). */
  endpoint(id: string): RemoteClient.Endpoint | undefined {
    const live = this.#hosts.get(id)?.live
    return live ? { url: live.url, secret: live.password, controlDir: live.controlDir } : undefined
  }

  #onTunnelExit(id: string, tunnel: Tunnel.Handle) {
    const host = this.#hosts.get(id)
    if (!host?.live || host.live.tunnel !== tunnel) return
    host.live.broker?.key.fill(0)
    host.live = undefined
    host.stderrTail = LogModule.scrub(tunnel.stderr())
    void Tunnel.removePidFile(this.#pidFile(id))
    const superseded = tunnel.after().includes("OWN_KEEP=superseded")
    if (host.paused || host.busy || this.#closed) return
    if (superseded) {
      this.#set(id, { stage: "disconnected", paused: true, error: null, detail: "superseded" })
      return
    }
    // Disconnect is not stop (04 §6.2): the remote service keeps running; reconnect in the background.
    const silent = Liveness.silentExit(tunnel.stderr())
    this.log.info("tunnel_ended", { hostId: id, cause: silent ? "silent" : "closed" })
    host.failures++
    host.droppedAt = Date.now()
    this.#set(id, { stage: "disconnected", error: "connection", detail: "tunnel closed" })
    this.#scheduleRetry(id)
  }

  /**
   * The clock tick (Liveness.TICK_MS). A tick that comes much later than due means this process was frozen, which on
   * a PC is a sleep or a hibernation: every live tunnel is probed now instead of waiting out ssh's keepalive after the
   * wake, and a host waiting for its next retry tries at once with a fresh drop window.
   */
  #tick() {
    const now = Date.now()
    const previous = this.#tickAt
    this.#tickAt = now
    if (!Liveness.resumed(previous, now) || this.#closed) return
    this.log.info("clock_gap", { gapMs: now - previous })
    for (const id of this.#hosts.keys()) void this.recheck(id)
  }

  /**
   * Probes a live host through its tunnel (Liveness.reachable) and ends a tunnel nothing answers through, so the
   * normal reconnect of `#onTunnelExit` follows; a host waiting for a retry retries now. Called after a wake.
   */
  async recheck(id: string) {
    const host = this.#hosts.get(id)
    if (!host || host.paused || host.busy || this.#closed) return
    if (!host.live) {
      if (!host.retry || host.attempt) return
      clearTimeout(host.retry)
      host.retry = undefined
      host.droppedAt = Date.now()
      void this.connect(id, { background: true })
      return
    }
    const live = host.live
    if (await Liveness.reachable({ url: live.url, secret: live.password })) return
    if (host.live !== live) return
    this.log.warn("link_silent", { hostId: id })
    await live.tunnel.close(0)
  }

  #scheduleRetry(id: string) {
    const host = this.#hosts.get(id)
    if (!host || host.paused || this.#closed) return
    if (host.failures >= MAX_FAILURES && !Liveness.keepRetrying(host.droppedAt, Date.now())) {
      this.#set(id, { paused: true })
      return
    }
    const schedule = this.input.options.backoffMs ?? DEFAULT_BACKOFF
    const delay = schedule[Math.min(Math.max(host.failures - 1, 0), schedule.length - 1)] ?? 30_000
    if (host.retry) clearTimeout(host.retry)
    host.retry = setTimeout(() => {
      host.retry = undefined
      if (!host.paused && !host.attempt && !host.live) void this.connect(id, { background: true })
    }, delay)
    host.retry.unref?.()
  }

  #fail(id: string, attempt: Attempt, failure: Failure.Classified) {
    const host = this.#hosts.get(id)
    if (!host || host.attempt !== attempt) return
    if (attempt.promptBlocked) {
      // A background attempt met an auth prompt: wait for the user (04 §6.3).
      this.#set(id, { stage: "authentication", paused: true, error: null, detail: "" })
      return
    }
    host.failures++
    const pause =
      failure.pause ||
      (host.failures >= MAX_FAILURES && !(failure.error === "connection" && Liveness.keepRetrying(host.droppedAt, Date.now())))
    this.#set(id, {
      stage: failure.error === "version_skew" ? "incompatible" : "failed",
      paused: pause,
      error: failure.error,
      detail: failure.detail,
    })
    if (!pause) this.#scheduleRetry(id)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Prompts (04 §6.3, §14.2)

  #onPrompt(id: string, attempt: Attempt, prompt: AskpassPrompt) {
    const host = this.#hosts.get(id)
    if (!host || host.attempt !== attempt) {
      void attempt.askpass?.respond(prompt.id, null)
      return
    }
    // Background attempts never prompt: pause and wait for the user. A host key question outside the host-key flows
    // cannot happen (StrictHostKeyChecking=yes); refuse it anyway.
    if (attempt.owner === undefined || (prompt.kind === "hostKey" && !attempt.hostKeyPrompt)) {
      attempt.promptBlocked = true
      host.paused = true
      void attempt.askpass?.respond(prompt.id, null)
      this.#set(id, { stage: "authentication", paused: true })
      return
    }
    attempt.prompt = prompt
    this.#set(id, { stage: "authentication" })
    this.hub.emit({ name: "host.prompt", data: promptEvent(id, prompt, attempt.owner) })
  }

  #onClear(id: string, attempt: Attempt, promptId: string) {
    const host = this.#hosts.get(id)
    if (!host || attempt.prompt?.id !== promptId) return
    attempt.prompt = undefined
    if (host.attempt === attempt && host.stage === "authentication" && !attempt.promptBlocked)
      this.#set(id, { stage: "connecting" })
  }

  routePrompt(
    promptId: string,
    route: {
      readonly hostId: string
      readonly kind: Prompt.Kind
      readonly owner: string
      readonly respond: (value: string | null) => Promise<void>
      readonly event?: PromptEvent
    },
  ) {
    this.#routed.set(promptId, route)
  }

  unroutePrompt(promptId: string) {
    this.#routed.delete(promptId)
  }

  /** `respond` (04 §16.2): only the owner answers; host key and confirm prompts take `"trust"` only. */
  async respond(id: string, promptId: string, clientId: string, value: string | null) {
    const routed = this.#routed.get(promptId)
    if (routed && routed.hostId === id) {
      if (routed.owner !== clientId) return { ok: false as const, reason: "not_owner" }
      const answer = Prompt.answer(routed.kind, value)
      if (!answer.ok) return { ok: false as const, reason: "value" }
      await routed.respond(answer.value)
      return { ok: true as const }
    }
    const attempt = this.#hosts.get(id)?.attempt
    const prompt = attempt?.prompt
    if (!attempt || !prompt || prompt.id !== promptId) return { ok: false as const, reason: "no_prompt" }
    if (attempt.owner !== clientId) return { ok: false as const, reason: "not_owner" }
    const answer = Prompt.answer(prompt.kind, value)
    if (!answer.ok) return { ok: false as const, reason: "value" }
    this.#heartbeats.set(clientId, Date.now())
    await attempt.askpass?.respond(promptId, answer.value)
    return { ok: true as const }
  }

  /**
   * `heartbeat` (04 §6.3). `replay`: the client (re)loaded; send `host.prompt` again for every prompt it still owns, so
   * a reloaded owner tab gets its question back (RG5 "새로 고침 뒤에도 같은 탭"). Returns how many were sent.
   */
  heartbeat(clientId: string, replay = false) {
    this.#heartbeats.set(clientId, Date.now())
    if (!replay) return 0
    let sent = 0
    for (const [id, host] of this.#hosts) {
      const attempt = host.attempt
      if (!attempt?.prompt || attempt.owner !== clientId || attempt.promptBlocked) continue
      this.hub.emit({ name: "host.prompt", data: promptEvent(id, attempt.prompt, clientId) })
      sent++
    }
    for (const route of this.#routed.values()) {
      if (route.owner !== clientId || !route.event) continue
      this.hub.emit({ name: "host.prompt", data: route.event })
      sent++
    }
    return sent
  }

  /** Owners silent for 30 s lose their attempt: prompts cancelled, host paused (04 §6.3). */
  #sweepOwners() {
    const timeout = this.input.options.ownerTimeoutMs ?? 30_000
    const now = Date.now()
    for (const [id, host] of this.#hosts) {
      const attempt = host.attempt
      if (!attempt?.owner || !attempt.prompt) continue
      const seen = this.#heartbeats.get(attempt.owner) ?? 0
      if (now - seen < timeout) continue
      attempt.promptBlocked = true
      void attempt.askpass?.respond(attempt.prompt.id, null)
      attempt.owner = undefined
      this.#set(id, { stage: "authentication", paused: true })
    }
  }

  async cancel(id: string, clientId: string) {
    const host = this.#hosts.get(id)
    const attempt = host?.attempt
    if (!host || !attempt || attempt.owner !== clientId) return host?.stage ?? "disconnected"
    host.paused = true
    const before = attempt.before
    this.#set(id, {
      stage:
        before.stage === "authentication" || before.stage === "failed" || before.stage === "incompatible"
          ? before.stage
          : "disconnected",
      paused: true,
      error: before.error,
      detail: before.detail,
    })
    attempt.abort.abort()
    await attempt.askpass?.close().catch(() => {})
    await attempt.done?.catch(() => {})
    return host.stage
  }

  /** `disconnect` = pause (04 §16.2): the local ssh ends, the remote service keeps running (04 §6.2). */
  async disconnect(id: string) {
    await this.#stop(id, { pause: true, stage: "disconnected" })
    return this.#hosts.get(id)?.stage ?? "disconnected"
  }

  async #stop(id: string, input: { readonly pause: boolean; readonly stage: OwnRemote.Stage }) {
    const host = this.#hosts.get(id)
    if (!host) return
    host.paused = input.pause
    if (host.retry) clearTimeout(host.retry)
    host.retry = undefined
    const attempt = host.attempt
    if (attempt) {
      attempt.abort.abort()
      await attempt.askpass?.close().catch(() => {})
      await attempt.done?.catch(() => {})
    }
    const live = host.live
    host.live = undefined
    if (live) {
      live.broker?.key.fill(0)
      await live.tunnel.close(2000)
    }
    this.#set(id, { stage: input.stage, paused: input.pause, error: null, detail: "" })
  }

  /** Closes the tunnel without pausing (update/drain steps reconnect afterwards). */
  closeTunnel(id: string) {
    return this.#stop(id, { pause: true, stage: "disconnected" })
  }

  /** Marks a long operation (`host_busy`, 04 §16.4). Returns false when another one runs. */
  begin(id: string, op: { readonly opId: string; readonly kind: string }) {
    const host = this.#hosts.get(id)
    if (!host || host.busy) return false
    host.busy = op
    return true
  }

  end(id: string) {
    const host = this.#hosts.get(id)
    if (host) host.busy = undefined
  }

  /** Waits for the current attempt of a host (tests and operations). */
  async settled(id: string) {
    await this.#hosts.get(id)?.attempt?.done?.catch(() => {})
  }

  setStage(id: string, patch: Partial<Pick<HostState, "stage" | "paused" | "error" | "detail">>) {
    this.#set(id, patch)
  }

  // -------------------------------------------------------------------------------------------------------------
  // resolve (04 §12.1)

  async resolve(id: string) {
    const host = this.#hosts.get(id)
    const record = this.registry.get(id)
    if (!host || !record) return undefined
    const live = host.live
    if (!live || host.stage !== "ready") {
      if (!host.paused && !host.attempt && !host.live && !host.busy) void this.connect(id, { background: true })
      return { url: null, stage: host.stage } as const
    }
    const now = Date.now()
    if (!live.token || live.token.expiresAt - now < Token.REFRESH_BELOW_MS) {
      const expiresAt = now + record.tokenTtlHours * 3600_000
      live.token = { value: Token.sign(live.password, expiresAt), expiresAt: Math.floor(expiresAt / 1000) * 1000 }
    }
    return {
      url: live.url,
      token: live.token.value,
      tokenExpiresAt: live.token.expiresAt,
      epoch: live.epoch,
      controlDir: live.controlDir,
      home: live.home,
    } as const
  }

  /** M1+ gateway lookup (04 §12.7), in process only. */
  endpoints(): Broker.Endpoints {
    return {
      endpoint: async (id) => {
        const resolved = await this.resolve(id)
        return resolved && resolved.url !== null
          ? { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
          : null
      },
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Views (04 §16.2)

  view(id: string): OwnRemote.HostView | undefined {
    const record = this.registry.get(id)
    const host = this.#hosts.get(id)
    if (!record || !host) return undefined
    const status = this.broker()?.status(id)
    const broker: OwnRemote.HostView["broker"] = status
      ? {
          state: status.state,
          mode: status.mode,
          proto: status.proto,
          leasesActive: status.leasesActive,
          lastPushAt: status.lastPushAt,
          spoolBacklog: status.spoolBacklog,
          gaps: status.gaps,
          clockSkewMs: status.clockSkewMs,
          sourceStale: [...status.sourceStale],
          ...(status.claude ? { claude: { ...status.claude } } : {}),
          ...(status.local ? { local: { ...status.local } } : {}),
        }
      : {
          state: host.brokerNote === "armed" ? "disconnected" : host.live ? "unarmed" : "unavailable",
          mode: null,
          proto: Broker.PROTO,
          leasesActive: 0,
          lastPushAt: null,
          spoolBacklog: 0,
          gaps: 0,
          clockSkewMs: null,
          sourceStale: [],
        }
    return {
      id: record.id as OwnRemote.HostID,
      alias: record.alias,
      name: record.name,
      target: record.target,
      stage: host.stage,
      paused: host.paused,
      error: host.error,
      detail: host.detail,
      platform: record.platform,
      hostIdentity: record.hostIdentity,
      identityChanged: host.identityChanged,
      versions: this.versions(id),
      autoConnect: record.autoConnect,
      loopback: Loopback.apiAddress(record.loopback),
      localPort: host.live ? Number(URL.parse(host.live.url)?.port ?? record.localPort) : record.localPort,
      epoch: host.live?.epoch ?? record.epoch,
      accounts: record.accounts,
      leaseSeconds: record.leaseSeconds,
      failClosedGraceSeconds: record.failClosedGraceSeconds,
      tokenTtlHours: record.tokenTtlHours,
      projectConfig: record.projectConfig,
      shellEnv: record.shellEnv,
      warnings: [
        ...record.warnings,
        ...(host.live && Number(URL.parse(host.live.url)?.port) !== record.localPort ? ["loopback_fallback_port"] : []),
      ],
      broker,
      sessions: { active: null },
      events: { state: "off", catalogEpoch: 0, catalogFetchedAt: null },
      pendingSettings: record.pendingSettings,
      owner: { clientId: host.attempt?.owner ?? null },
      upstreamOpencodeDetected: host.inspect?.upstreamOpencode ?? record.warnings.includes("upstream_opencode"),
    }
  }

  list() {
    const data = this.registry.snapshot()
    return {
      revision: data.revision,
      hosts: data.hosts.flatMap((record) => {
        const view = this.view(record.id)
        return view ? [view] : []
      }),
    }
  }
}

/** A random remote loopback port of the TCP fallback (04 §7.4 item 2). */
function randomPort() {
  return 20_000 + Math.floor(Math.random() * 40_000)
}

/** The egress relay's stored TCP port, or a new random one that is not the broker's (04 §8.11.4.2). */
function egressTcpPort(stored: number | null | undefined, brokerPort: number): number {
  if (stored !== null && stored !== undefined && stored !== brokerPort) return stored
  const port = randomPort()
  return port === brokerPort ? egressTcpPort(undefined, brokerPort) : port
}

import net from "node:net"
import os from "node:os"
import path from "node:path"
import { OwnID } from "@own/protocol"
import { Home, ServiceTarget, Vault } from "@own/runtime"
import type { Controller } from "../controller.js"
import { Events } from "../events.js"
import type { Log } from "../log.js"
import { Loopback } from "../loopback.js"
import type { OwnRemote } from "../protocol/rpc-remote.js"
import { Audit } from "./audit.js"
import { BrowserHub } from "./browser-hub.js"
import { GatewayConfig } from "./config.js"
import { Devices } from "./devices.js"
import { Feed } from "./feed.js"
import { Pairing } from "./pairing.js"
import { Policy } from "./policy.js"
import { PortProxy } from "./portproxy.js"
import { GatewayServer } from "./server.js"
import { Tailscale } from "./tailscale.js"
import { AppTls } from "./tls.js"
import { Web } from "./web.js"

/**
 * The M1 gateway (05 §13.4): settings, the device store, pairings, the loopback listener, Tailscale detection and the
 * feed, for one build in one service process. Created by own-remote (local mode); lives in the process-lifetime
 * singleton (`index.ts`) and, while enabled, pins the own runtime and the SSH controller itself (05 §13.4 "고정"), so
 * released Locations do not take the listener, the feed producer or the tunnels with them.
 */

export interface GatewayOptions {
  /** Registration file of the local service (url + password). Default: the channel's `service-<channel>.json`. */
  readonly registration?: string
  /** own-web build to serve. Default: the installed version's `<OWN_HOME>\app\<version>\web` (app\current.json). */
  readonly webRoot?: string
  /** argv prefix replacing `tailscale.exe` (tests), or `null` to skip detection. */
  readonly tailscaleCommand?: ReadonlyArray<string> | null
  /** Audit window (default 5 minutes). */
  readonly auditIntervalMs?: number
  /** Vault of the app listener's key (08 §3.2): `memory` in tests, else the helper (default: the installed one). */
  readonly vault?: "memory" | { readonly exePath?: string }
  /** argv replacing `netsh interface portproxy show v4tov4` (tests), or `null` to skip detection. */
  readonly portproxyCommand?: ReadonlyArray<string> | null
  /** Adds `127.0.0.1:<app port>` to the app routes (tests and development on one PC). */
  readonly appLoopbackRoute?: boolean
}

export interface GatewayInput {
  readonly buildId: string
  readonly ownHome: string
  readonly channel: string
  readonly options: GatewayOptions
  readonly log: Log.Logger
  /** Holds the runtime and the controller while the gateway is on; returns the controller and a release. */
  readonly pin: () => Promise<{ readonly controller: Controller; release(): Promise<void> }>
  readonly now?: () => number
}

type Failure<E extends string = string> = { readonly ok: false; readonly error: E; readonly data: Record<string, unknown> }
type Result<T, E extends string = string> = { readonly ok: true; readonly value: T } | Failure<E>

const NONCE_TTL_MS = 5 * 60 * 1000

interface ConfigurePlan {
  readonly bind: string
  readonly port: number
  readonly publicOrigin: string | null
  readonly app: GatewayConfig.AppSettings
}

export interface PlanInput {
  readonly port?: number
  readonly bind?: string
  readonly publicOrigin?: string | null
  readonly app?: {
    readonly enabled: boolean
    readonly port?: number
    readonly directHost?: string | null
    readonly directPort?: number | null
  }
}

/** The build whose gateway currently holds the listener in this process (another build hands over on start). */
const ACTIVE = Symbol.for("own-open-code.remote-gateway/active")

interface Active {
  readonly buildId: string
  yield(): Promise<void>
}

function active() {
  return globalThis as unknown as Record<symbol, Active | undefined>
}

export class Gateway {
  readonly hub = new Events.Hub()
  readonly devices: Devices.Store
  readonly pairings: Pairing.Book
  readonly limiter = new Pairing.Limiter()
  /**
   * The app listener's own counter (08 §2): every peer there is 127.0.0.1 (portproxy, `tailscale serve --tcp`), so
   * a scanner on the direct route would otherwise block browser pairing too.
   */
  readonly appLimiter = new Pairing.Limiter()
  readonly service: ServiceTarget.Service
  readonly web: Web.Files
  readonly tailscale: Tailscale.Detector
  readonly audit: Audit.Journal
  readonly feed: Feed.Producer
  readonly portproxy: PortProxy.Detector
  /** The browser pane on a device (05 §8.10): outlives a listener restart, like the device store. */
  readonly browser: BrowserHub.Hub
  readonly controlDir: string
  readonly #input: GatewayInput
  readonly #now: () => number
  /** Pairing steps (own-remote.log): ids, states and times only, never the code, the claim, the SAS or the token. */
  readonly #pairingLog: Log.Logger
  #settings: GatewayConfig.Settings = GatewayConfig.defaults()
  #listener: GatewayServer.Listener | undefined
  #problem: string | null = null
  /** The pinned-TLS app listener (08), open while the gateway and `app.enabled` are. */
  #app: GatewayServer.Listener | undefined
  #appProblem: string | null = null
  #identity: AppTls.Identity | undefined
  /** `memory` vault of a test gateway: one transport, so the identity survives a reopen like the real vault. */
  #memoryVault: Vault.Transport | undefined
  #rules: ReadonlyArray<PortProxy.Rule> | null = null
  #pin: { readonly controller: Controller; release(): Promise<void> } | undefined
  #controller: (() => Controller | undefined) | undefined
  #detection: Tailscale.Detection = { state: "unknown", version: null, dnsName: null, proxies: null }
  readonly #nonces = new Map<string, { readonly plan: ConfigurePlan; readonly expiresAt: number }>()
  #sweep: ReturnType<typeof setInterval> | undefined
  #started: Promise<void> | undefined
  #op: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(input: GatewayInput) {
    this.#input = input
    this.#now = input.now ?? Date.now
    this.devices = new Devices.Store({ ownHome: input.ownHome, now: this.#now })
    const pairingLog = input.log.child("pairing")
    this.#pairingLog = pairingLog
    this.pairings = new Pairing.Book({
      now: this.#now,
      events: {
        pending: (entry) =>
          this.hub.emit({
            name: "device.pairing.pending",
            data: {
              pairingId: entry.pairingId,
              name: entry.name,
              sas: entry.sas ?? "",
              userAgent: entry.userAgent,
              tailscaleUser: entry.tailscaleUser,
              expiresAt: entry.expiresAt,
            },
          }),
        ended: (entry, reason) => {
          pairingLog.info("pairing_ended", { pairingId: entry.pairingId, reason, from: entry.state })
          this.hub.emit({ name: "device.pairing.ended", data: { pairingId: entry.pairingId, reason } })
        },
        silent: (entry, silentMs) =>
          pairingLog.info("pairing_device_silent", { pairingId: entry.pairingId, state: entry.state, silentMs }),
        back: (entry, silentMs) =>
          pairingLog.info("pairing_device_back", { pairingId: entry.pairingId, state: entry.state, silentMs }),
      },
    })
    this.service = new ServiceTarget.Service(
      input.options.registration ?? ServiceTarget.registrationPath(input.channel),
    )
    this.web = new Web.Files(input.options.webRoot ?? path.join(Home.layout(input.ownHome).app, "web"))
    this.tailscale = new Tailscale.Detector(input.options.tailscaleCommand)
    this.portproxy = new PortProxy.Detector(input.options.portproxyCommand)
    this.audit = new Audit.Journal({ ownHome: input.ownHome, now: this.#now, intervalMs: input.options.auditIntervalMs })
    this.controlDir = Home.layout(input.ownHome).control
    this.feed = new Feed.Producer({
      ownHome: input.ownHome,
      log: input.log.child("feed"),
      service: this.service,
      controlDir: this.controlDir,
      devices: this.devices,
      // The same in-process host access as the relay: the feed follows each ready host's team (06 §9.8).
      hosts: () => this.#hosts(),
      emit: (item) => this.hub.emit({ name: "feed.item", data: { item } }),
      now: this.#now,
    })
    this.browser = new BrowserHub.Hub({
      log: input.log.child("browser"),
      emitWanted: (key) => this.hub.emit({ name: "browser.pane.wanted", data: BrowserHub.named(key) }),
      canView: () => this.#canView(),
      now: this.#now,
    })
  }

  /** Whether a paired device could open a browser viewer now (the shell polls slowly while none can). */
  #canView() {
    if (!this.#listener && !this.#app) return false
    const now = this.#now()
    return this.devices
      .list()
      .some(
        (device) =>
          Devices.state(device, now) === "active" &&
          Policy.browserView({ scopes: new Set(device.scopes), servers: device.servers }).ok,
      )
  }

  /** Controller of the plugin instances, for host names and endpoints when the gateway holds no pin yet. */
  useController(get: () => Controller | undefined) {
    this.#controller = get
  }

  get settings() {
    return this.#settings
  }

  /** Loads settings and devices; opens the listener when the settings say so (05 §13.4 "기동 깨우기"). */
  start() {
    this.#started ??= this.#serial(async () => {
      this.#settings = await GatewayConfig.load(this.#input.ownHome)
      await this.devices.load()
      this.#sweep = setInterval(() => this.pairings.sweep(), 5_000)
      this.#sweep.unref?.()
      if (this.#settings.enabled) await this.#open()
    })
    return this.#started
  }

  // ---- status and configuration (05 §13.4, 03 §21.2)

  async status(): Promise<OwnRemote.GatewayView> {
    await this.start()
    const app = GatewayConfig.appOf(this.#settings)
    const [detection, rules] = await Promise.all([
      this.tailscale.detect(),
      app.enabled && app.directPort !== null ? this.portproxy.rules() : Promise.resolve(this.#rules),
    ])
    this.#detection = detection
    this.#rules = rules
    return this.#view()
  }

  #view(): OwnRemote.GatewayView {
    const listening = this.#listener !== undefined
    const port = listening ? this.#listener!.port : this.#settings.enabled ? this.#settings.port : null
    const now = this.#now()
    return {
      enabled: this.#settings.enabled,
      state: listening ? "listening" : this.#settings.enabled ? "error" : "off",
      problem: listening ? null : this.#settings.enabled ? (this.#problem ?? "bind_failed") : null,
      bind: this.#settings.bind,
      port: this.#settings.enabled || listening ? (port ?? this.#settings.port) : null,
      url: listening ? GatewayConfig.loopbackUrl(this.#settings.bind, this.#listener!.port) : null,
      publicOrigin: this.#publicOrigin(),
      tailscale: Tailscale.view(
        this.#detection,
        listening ? this.#listener!.port : null,
        GatewayConfig.appOf(this.#settings).enabled ? GatewayConfig.appOf(this.#settings).port : null,
      ),
      devices: {
        active: this.devices.list().filter((device) => Devices.state(device, now) === "active").length,
        pairing: this.pairings.list().length,
      },
      app: this.#appView(),
    }
  }

  #appView(): OwnRemote.AppAccessView {
    const app = GatewayConfig.appOf(this.#settings)
    const open = this.#app !== undefined
    const direct = app.directPort
    return {
      enabled: app.enabled,
      state: open ? "listening" : app.enabled ? "error" : "off",
      problem: open || !app.enabled ? null : this.#settings.enabled ? (this.#appProblem ?? "bind_failed") : "gateway_off",
      port: app.enabled ? app.port : null,
      pcKey: this.#identity?.pcKey ?? null,
      pin: this.#identity?.pin ?? null,
      routes: app.enabled ? this.#appRoutes() : [],
      tailnetCommand: app.enabled ? Tailscale.tcpServeCommand(app.port) : null,
      direct: {
        host: app.directHost,
        port: direct,
        portproxy: direct !== null && this.#rules !== null ? PortProxy.forwards(this.#rules, direct, app.port) : null,
        setupCommands: direct !== null ? PortProxy.setupCommands(direct, app.port) : [],
        removeCommands: direct !== null ? PortProxy.removeCommands(direct) : [],
      },
    }
  }

  /** 08 §3.1: tailnet first, then direct; every configured route, ready or not (the app fails over in 3 s). */
  #appRoutes(): OwnRemote.AppRoute[] {
    const app = GatewayConfig.appOf(this.#settings)
    const dnsName = this.#detection.state === "running" ? this.#detection.dnsName : null
    const tailnet: OwnRemote.AppRoute[] = dnsName
      ? [{ kind: "tailnet", address: `${dnsName}:${app.port}`, ready: Tailscale.forwardsApp(this.#detection, app.port) }]
      : []
    const direct: OwnRemote.AppRoute[] =
      app.directHost && app.directPort !== null
        ? [
            {
              kind: "direct",
              address: `${app.directHost}:${app.directPort}`,
              ready: this.#rules !== null ? PortProxy.forwards(this.#rules, app.directPort, app.port) : null,
            },
          ]
        : []
    const loopback: OwnRemote.AppRoute[] = this.#input.options.appLoopbackRoute
      ? [{ kind: "direct", address: `127.0.0.1:${app.port}`, ready: this.#app !== undefined }]
      : []
    return [...tailnet, ...direct, ...loopback]
  }

  /** `GET /own/routes` and the pairing link (08 §3.3, §3.6). */
  #appIdentityRoutes(): GatewayServer.AppRoutes | undefined {
    const identity = this.#identity
    if (!identity || !this.#app) return undefined
    return { pcKey: identity.pcKey, pin: identity.pin, name: os.hostname(), routes: this.#appRoutes().map((route) => route.address) }
  }

  /**
   * The link of this PC's own 모바일 미리보기 (08 §4.3): one route, where the app listener listens. Only in that link,
   * which goes from local RPC to the shell over IPC; never in `/own/routes`, the gateway view or a QR.
   */
  #appLoopbackRoutes(): GatewayServer.AppRoutes | undefined {
    const identity = this.#identity
    if (!identity || !this.#app) return undefined
    const bind = this.#settings.bind
    const route = `${net.isIPv6(bind) ? `[${bind}]` : bind}:${this.#app.port}`
    return { pcKey: identity.pcKey, pin: identity.pin, name: os.hostname(), routes: [route] }
  }

  async plan(input: PlanInput) {
    await this.start()
    const bind = GatewayConfig.checkBind(input.bind ?? this.#settings.bind)
    if (!bind.ok)
      return bind.reason === "lan"
        ? fail("bind_rejected_lan", { address: bind.address })
        : fail("input_invalid", { field: "bind", reason: "address" })
    let publicOrigin = this.#settings.publicOrigin
    if (input.publicOrigin !== undefined) {
      if (input.publicOrigin === null || input.publicOrigin.trim() === "") publicOrigin = null
      else {
        const checked = GatewayConfig.checkOrigin(input.publicOrigin)
        if (!checked) return fail("input_invalid", { field: "publicOrigin", reason: "https origin" })
        publicOrigin = checked
      }
    }
    const port = input.port ?? this.#settings.port
    const ours = this.#listener && this.#listener.port === port && this.#settings.bind === bind.address
    if (!ours) {
      const free = await Loopback.tryBind(bind.address, port)
      if (free !== "ok") return fail("gateway_unavailable", { reason: free === "in_use" ? "port_in_use" : "bind_failed" })
    }
    const app = planApp(GatewayConfig.appOf(this.#settings), input.app, port)
    if (!app.ok) return app
    const appOurs = this.#app && this.#app.port === app.value.port && this.#settings.bind === bind.address
    if (app.value.enabled && !appOurs) {
      const free = await Loopback.tryBind(bind.address, app.value.port)
      if (free !== "ok") return fail("gateway_unavailable", { reason: free === "in_use" ? "app_port_in_use" : "bind_failed" })
    }
    this.#detection = await this.tailscale.detect(true)
    const tailscale = Tailscale.view(this.#detection, port)
    const warnings: Array<"tailscale_missing" | "tailscale_stopped" | "tailscale_logged_out" | "tailscale_not_serving"> = []
    if (this.#detection.state === "missing") warnings.push("tailscale_missing")
    else if (this.#detection.state === "stopped") warnings.push("tailscale_stopped")
    else if (this.#detection.state === "logged_out") warnings.push("tailscale_logged_out")
    else if (this.#detection.state === "running" && tailscale.serving === false) warnings.push("tailscale_not_serving")
    const now = this.#now()
    for (const [key, entry] of this.#nonces) if (entry.expiresAt <= now) this.#nonces.delete(key)
    const nonce = OwnID.Nonce.create()
    const expiresAt = now + NONCE_TTL_MS
    this.#nonces.set(nonce, { plan: { bind: bind.address, port, publicOrigin, app: app.value }, expiresAt })
    return ok({
      nonce,
      expiresAt,
      bind: bind.address,
      port,
      url: GatewayConfig.loopbackUrl(bind.address, port),
      publicOrigin: this.#publicOrigin(publicOrigin),
      tailscale,
      warnings,
    })
  }

  async execute(nonce: string): Promise<Result<OwnRemote.GatewayView>> {
    await this.start()
    const entry = this.#nonces.get(nonce)
    this.#nonces.delete(nonce)
    if (!entry || entry.expiresAt <= this.#now()) return fail("nonce_invalid", {})
    return this.#serial(async () => {
      const previous = this.#settings
      const previousApp = GatewayConfig.appOf(previous)
      this.#settings = { ...previous, ...entry.plan, enabled: true, updatedAt: this.#now() }
      const restart = this.#listener && (this.#listener.port !== entry.plan.port || previous.bind !== entry.plan.bind)
      if (restart) await this.#shut(false)
      const appRestart = previousApp.enabled !== entry.plan.app.enabled || previousApp.port !== entry.plan.app.port
      if (!restart && appRestart) await this.#shutApp()
      if (!this.#listener) await this.#open()
      if (this.#listener && !this.#app) await this.#openApp()
      if (!this.#listener) {
        const reason = this.#problem ?? "bind_failed"
        this.#settings = previous
        await this.#shut(false)
        if (previous.enabled) await this.#open()
        this.#emitState()
        return fail("gateway_unavailable", { reason })
      }
      await GatewayConfig.save(this.#input.ownHome, this.#settings)
      this.#emitState()
      return ok(this.#view())
    })
  }

  async disable(): Promise<OwnRemote.GatewayView> {
    await this.start()
    return this.#serial(async () => {
      this.#settings = { ...this.#settings, enabled: false, updatedAt: this.#now() }
      await GatewayConfig.save(this.#input.ownHome, this.#settings)
      this.pairings.clear()
      await this.#shut(true)
      this.#emitState()
      return this.#view()
    })
  }

  #publicOrigin(configured = this.#settings.publicOrigin) {
    if (this.#detection.state === "running" && this.#detection.dnsName) return `https://${this.#detection.dnsName}`
    return configured
  }

  async #open() {
    if (this.#listener || this.#closed) return
    // Another build of own-remote in this process (a reload across an update) hands the port over first.
    const holder = active()[ACTIVE]
    if (holder && holder.buildId !== this.#input.buildId) await holder.yield().catch(() => undefined)
    if (!(await this.web.available())) this.#input.log.warn("web_missing", { root: this.web.root })
    const bind = GatewayConfig.checkBind(this.#settings.bind)
    if (!bind.ok) {
      this.#problem = "bind_failed"
      return
    }
    try {
      this.#listener = GatewayServer.start(
        { ...this.#context("http"), allowedHosts: () => this.#allowedHosts(), allowedOrigins: () => this.#allowedOrigins() },
        bind.address,
        this.#settings.port,
      )
      this.#problem = null
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      this.#problem = code === "EADDRINUSE" || /in use/i.test(String(error)) ? "port_in_use" : "bind_failed"
      this.#input.log.warn("listen_failed", { port: this.#settings.port, problem: this.#problem })
      return
    }
    active()[ACTIVE] = { buildId: this.#input.buildId, yield: () => this.#serial(() => this.#shut(true)) }
    this.#input.log.info("listening", { port: this.#listener.port })
    this.#detection = await this.tailscale.detect().catch(() => this.#detection)
    try {
      this.#pin ??= await this.#input.pin()
    } catch (error) {
      this.#input.log.warn("pin_failed", { error: error instanceof Error ? error.message : String(error) })
    }
    this.feed.start()
    await this.#openApp()
  }

  #context(scope: string): Omit<GatewayServer.Context, "allowedHosts" | "allowedOrigins"> {
    return {
      log: this.#input.log.child(scope),
      devices: this.devices,
      pairings: this.pairings,
      limiter: this.limiter,
      service: this.service,
      web: this.web,
      audit: this.audit,
      browser: this.browser,
      hosts: () => this.#hosts(),
      controlDir: this.controlDir,
      pcName: os.hostname(),
      paired: (device) => this.hub.emit({ name: "device.paired", data: { deviceId: device.deviceId, name: device.name } }),
      revoke: async (deviceId) => {
        await this.revoke(deviceId)
      },
      now: this.#now,
    }
  }

  /** The pinned-TLS app listener (08 §1) on the gateway's loopback address; the key comes from the vault. */
  async #openApp() {
    const app = GatewayConfig.appOf(this.#settings)
    if (!app.enabled || this.#app || this.#closed || !this.#listener) return
    const identity = await this.#loadIdentity()
    if (!identity) {
      this.#appProblem = "vault_unavailable"
      this.#input.log.warn("app_listen_failed", { problem: this.#appProblem })
      return
    }
    try {
      this.#app = GatewayServer.start(
        {
          ...this.#context("app"),
          limiter: this.appLimiter,
          allowedHosts: () => this.#appHosts(identity.pcKey),
          allowedOrigins: () => this.#appOrigins(identity.pcKey),
          app: { routes: () => this.#appIdentityRoutes() },
        },
        this.#settings.bind,
        app.port,
        { cert: identity.certPem, key: identity.keyPem },
      )
      this.#appProblem = null
      this.#input.log.info("app_listening", { port: this.#app.port, pcKey: identity.pcKey })
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      this.#appProblem = code === "EADDRINUSE" || /in use/i.test(String(error)) ? "port_in_use" : "bind_failed"
      this.#input.log.warn("app_listen_failed", { port: app.port, problem: this.#appProblem })
    }
  }

  async #shutApp() {
    const app = this.#app
    this.#app = undefined
    if (app) await app.stop().catch(() => undefined)
  }

  /** Read once per process; a vault helper runs only for this call (it is not needed while serving). */
  async #loadIdentity() {
    if (this.#identity) return this.#identity
    const option = this.#input.options.vault
    const memory = option === "memory" ? (this.#memoryVault ??= Vault.memory()) : undefined
    const vault = new Vault.Client(
      memory ??
        Vault.spawnHelper({
          exePath: (option !== "memory" ? option?.exePath : undefined) ?? Home.layout(this.#input.ownHome).vaultExe,
          home: this.#input.ownHome,
        }),
    )
    const loaded = await AppTls.loadOrCreate(vault, this.#now())
    if (!memory) await vault.close().catch(() => undefined)
    if (!loaded.ok) return undefined
    if (loaded.created) this.#input.log.info("app_identity_created", { pcKey: loaded.identity.pcKey })
    this.#identity = loaded.identity
    return loaded.identity
  }

  async #shut(releasePin: boolean) {
    // Before the listeners close their sockets as "device revoked": a viewer learns the gateway went away.
    this.browser.closeAll()
    await this.#shutApp()
    const listener = this.#listener
    this.#listener = undefined
    if (listener) await listener.stop().catch(() => undefined)
    const holder = active()[ACTIVE]
    if (holder && holder.buildId === this.#input.buildId) delete active()[ACTIVE]
    await this.feed.stop()
    if (releasePin && this.#pin) {
      const pin = this.#pin
      this.#pin = undefined
      await pin.release().catch(() => undefined)
    }
  }

  #emitState() {
    const view = this.#view()
    this.hub.emit({
      name: "gateway.state",
      data: { enabled: view.enabled, state: view.state, problem: view.problem, port: view.port, url: view.url },
    })
  }

  #hosts(): GatewayServer.HostAccess | undefined {
    const controller = this.#pin?.controller ?? this.#controller?.()
    if (!controller) return undefined
    return {
      list: () => controller.list().hosts.map((host) => ({ id: host.id, name: host.name, stage: host.stage })),
      endpoint: async (hostId) => {
        const resolved = await controller.resolve(hostId)
        return resolved && resolved.url !== null
          ? { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
          : null
      },
    }
  }

  #allowedHosts() {
    const port = this.#listener?.port ?? this.#settings.port
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${this.#settings.bind}:${port}`])
    const add = (host: string | null | undefined) => {
      if (!host) return
      hosts.add(host.toLowerCase())
      if (!host.includes(":")) hosts.add(`${host.toLowerCase()}:443`)
    }
    if (this.#detection.dnsName) add(this.#detection.dnsName)
    const origin = this.#settings.publicOrigin ? URL.parse(this.#settings.publicOrigin) : null
    if (origin) add(origin.host)
    return hosts
  }

  #allowedOrigins() {
    const port = this.#listener?.port ?? this.#settings.port
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`])
    if (this.#detection.dnsName) origins.add(`https://${this.#detection.dnsName}`)
    if (this.#settings.publicOrigin) origins.add(this.#settings.publicOrigin.toLowerCase())
    return origins
  }

  /** 08 §3.4: apps always send `<pcKey>.ownpc.internal`; loopback forms answer tests on this PC. */
  #appHosts(pcKey: string) {
    const port = this.#app?.port ?? GatewayConfig.appOf(this.#settings).port
    const host = AppTls.hostOf(pcKey)
    return new Set([host, `${host}:443`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  }

  #appOrigins(pcKey: string) {
    const port = this.#app?.port ?? GatewayConfig.appOf(this.#settings).port
    return new Set([`https://${AppTls.hostOf(pcKey)}`, `https://127.0.0.1:${port}`, `https://localhost:${port}`])
  }

  // ---- devices (05 §13.5)

  async pairStart(
    request: Pairing.Request & { readonly appRoute?: "configured" | "loopback" },
  ): Promise<Result<{ pairingId: string; url: string; appLink: string | null; expiresAt: number }>> {
    await this.start()
    if (!this.#listener) return fail("gateway_unavailable", { reason: this.#settings.enabled ? (this.#problem ?? "bind_failed") : "off" })
    const known = new Set(["local", ...(this.#hosts()?.list().map((host) => host.id) ?? [])])
    if (request.servers.mode === "only" && request.servers.keys.some((key) => !known.has(key)))
      return fail("input_invalid", { field: "servers", reason: "unknown server" })
    if (GatewayConfig.appOf(this.#settings).enabled) this.#detection = await this.tailscale.detect().catch(() => this.#detection)
    const { entry, code } = this.pairings.start({
      name: request.name,
      scopes: request.scopes,
      servers: request.servers,
      expiresDays: request.expiresDays,
    })
    const origin = this.#publicOrigin() ?? GatewayConfig.loopbackUrl(this.#settings.bind, this.#listener.port)
    const routes = request.appRoute === "loopback" ? this.#appLoopbackRoutes() : this.#appIdentityRoutes()
    return ok({
      pairingId: entry.pairingId,
      url: `${origin}/auth/connect/${code}`,
      appLink: routes && routes.routes.length > 0 ? appLink(routes, code) : null,
      expiresAt: entry.expiresAt,
    })
  }

  approve(pairingId: string, sas: string) {
    const result = this.pairings.approve(pairingId, sas)
    if (result.ok) this.#pairingLog.info("pairing_approved", { pairingId })
    else this.#pairingLog.info("pairing_approve_failed", { pairingId, error: result.error, reason: result.reason ?? null })
    if (!result.ok)
      return result.error === "pairing_expired"
        ? fail("pairing_expired", { pairingId })
        : fail("pairing_rejected", { pairingId, reason: result.reason ?? "rejected" })
    return ok({ pairingId: result.entry.pairingId, deviceId: result.entry.deviceId, expiresAt: result.entry.expiresAt })
  }

  cancel(pairingId: string) {
    this.pairings.cancel(pairingId)
  }

  async list() {
    await this.start()
    const now = this.#now()
    const devices = await this.devices.all()
    return {
      devices: devices.sort((a, b) => b.createdAt - a.createdAt).map((device) => Devices.view(device, now)),
      pairings: this.pairings.list().map(Pairing.view),
    }
  }

  async update(input: {
    readonly deviceId: string
    readonly name?: string
    readonly scopes?: ReadonlyArray<OwnRemote.DeviceScope>
    readonly servers?: OwnRemote.ServerScope
  }) {
    await this.start()
    const current = this.devices.get(input.deviceId) ?? (await this.devices.all()).find((device) => device.deviceId === input.deviceId)
    if (!current) return fail("device_not_found", { deviceId: input.deviceId })
    if (current.revokedAt !== null) return fail("device_revoked", { deviceId: input.deviceId })
    const next = await this.devices.update(input.deviceId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      ...(input.servers !== undefined ? { servers: input.servers } : {}),
    })
    if (!next) return fail("device_not_found", { deviceId: input.deviceId })
    // Narrower scopes apply to open streams too: they reconnect with the new record.
    if (input.scopes !== undefined || input.servers !== undefined) this.#closeDevice(input.deviceId)
    return ok({ device: Devices.view(next, this.#now()) })
  }

  async revoke(deviceId: string) {
    await this.start()
    const revoked = await this.devices.revoke(deviceId)
    if (!revoked) return fail("device_not_found", { deviceId })
    this.#closeDevice(deviceId)
    this.hub.emit({ name: "device.revoked", data: { deviceId } })
    return ok({ device: Devices.view(revoked, this.#now()) })
  }

  async revokeAll() {
    await this.start()
    const revoked = await this.devices.revokeAll()
    for (const deviceId of revoked) {
      this.#closeDevice(deviceId)
      this.hub.emit({ name: "device.revoked", data: { deviceId } })
    }
    return { revoked: revoked.length }
  }

  /** Open requests, streams and sockets of a device on both listeners (tests: MG4). */
  openConnections(deviceId: string) {
    return (this.#listener?.connections.count(deviceId) ?? 0) + (this.#app?.connections.count(deviceId) ?? 0)
  }

  #closeDevice(deviceId: string) {
    this.#listener?.connections.closeDevice(deviceId)
    this.#app?.connections.closeDevice(deviceId)
  }

  /** The app listener's port while open (tests). */
  get appPort() {
    return this.#app?.port
  }

  // ---- lifecycle

  async close() {
    if (this.#closed) return
    await this.#serial(async () => {
      this.#closed = true
      if (this.#sweep) clearInterval(this.#sweep)
      await this.#shut(true)
      await this.devices.flush()
      await this.audit.close()
    })
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#op.then(run, run)
    this.#op = next.catch(() => undefined)
    return next
  }
}

/** 08 §3.3: `ownpc://pair?v=1&k=…&p=…&c=…&n=…&r=…` (the QR an app scans). */
export function appLink(routes: GatewayServer.AppRoutes, code: string) {
  // `%20`, never `+`, for spaces: Android's `Uri` and URLSearchParams disagree about `+`.
  const pairs: Array<[string, string]> = [
    ["v", "1"],
    ["k", routes.pcKey],
    ["p", routes.pin],
    ["c", code],
    ["n", routes.name],
    ...routes.routes.map((route): [string, string] => ["r", route]),
  ]
  return `ownpc://pair?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`
}

/**
 * The app part of a plan (08 §3.7): ports distinct from each other and from the gateway's, the direct host a DNS name
 * or address. A direct host without a port takes the default; clearing the host keeps the port.
 */
function planApp(
  current: GatewayConfig.AppSettings,
  input: PlanInput["app"],
  gatewayPort: number,
): Result<GatewayConfig.AppSettings, "input_invalid"> {
  if (!input) return ok(current)
  const port = input.port ?? current.port
  const directHost =
    input.directHost === undefined
      ? current.directHost
      : input.directHost === null || input.directHost.trim() === ""
        ? null
        : GatewayConfig.checkDirectHost(input.directHost)
  if (directHost === undefined) return fail("input_invalid", { field: "app.directHost", reason: "host name or address" })
  const directPort =
    input.directPort !== undefined
      ? input.directPort
      : (current.directPort ?? (directHost ? GatewayConfig.DEFAULT_DIRECT_PORT : null))
  if (port === gatewayPort) return fail("input_invalid", { field: "app.port", reason: "same as the gateway port" })
  if (directPort !== null && (directPort === port || directPort === gatewayPort))
    return fail("input_invalid", { field: "app.directPort", reason: "same as another port" })
  return ok({ enabled: input.enabled, port, directHost, directPort })
}

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function fail<E extends string>(error: E, data: Record<string, unknown>): Failure<E> {
  return { ok: false, error, data }
}

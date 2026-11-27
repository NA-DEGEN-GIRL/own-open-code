export * as GatewayServer from "./server.js"

import type { Server, ServerWebSocket } from "bun"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { ServiceTarget } from "@own/runtime"
import type { Log } from "../log.js"
import type { OwnRemote } from "../protocol/rpc-remote.js"
import { OwnRemote as Remote } from "../protocol/rpc-remote.js"
import type { Audit } from "./audit.js"
import type { BrowserHub } from "./browser-hub.js"
import { Devices } from "./devices.js"
import type { Pairing } from "./pairing.js"
import { Policy } from "./policy.js"
import type { Web } from "./web.js"

/**
 * The gateway listener (05 §13.4 "하는 일"), a `Bun.serve` on loopback only:
 *
 * | path | who | what |
 * |---|---|---|
 * | `/auth/connect/<code>` | anyone with the link | pairing: consumes the code, sets the `own_pairing` claim cookie, → `/pair` |
 * | `/own/pairing`, `/own/pairing/claim` | the pairing device (claim cookie) | SAS and state; the token once approved |
 * | `/own/device`, `/own/servers` | a device (`read`) | who am I (scopes, the service PC's name), the server list (05 §13.4 6) |
 * | `/srv/<serverKey>/api/*` | a device | scope check (`Policy`), then relay with the service's Basic or own-remote's signed host token |
 * | `/own/browser/<serverKey>/<sessionID>` | a device (`read` + `browser`) | WebSocket: the viewer of a session's browser pane (05 §8.10), handed to the hub |
 * | everything else | anyone | own-web static files (the pairing screen is part of the app) |
 *
 * Device credentials: the `own_device` cookie (`HttpOnly; Secure; SameSite=Strict`) or `Authorization: Bearer` (apps).
 * Cookie requests that change state must come from the gateway's own origin (CSRF, 05 §13.5). Incoming
 * `Authorization`, `Cookie`, `Origin`, `Referer` never reach the service (01 §6.4 불변식 5).
 */

export interface HostAccess {
  list(): ReadonlyArray<{ readonly id: string; readonly name: string; readonly stage: string }>
  /** 04 §12.7: the endpoint and signed token of a ready host, in process (never over RPC). */
  endpoint(hostId: string): Promise<{ readonly url: string; readonly token: string; readonly controlDir: string } | null>
}

export interface Context {
  readonly log: Log.Logger
  readonly devices: Devices.Store
  readonly pairings: Pairing.Book
  readonly limiter: Pairing.Limiter
  readonly service: ServiceTarget.Source
  readonly web: Web.Files
  readonly audit: Audit.Journal
  /** The browser pane's hub (05 §8.10). Without it the viewer socket answers 404 and prompts are relayed as they are. */
  readonly browser?: BrowserHub.Hub
  readonly hosts: () => HostAccess | undefined
  /** `OWN_HOME\control`: the local server's control location for devices (02 §9.1 Q41). */
  readonly controlDir: string
  /** This PC's name (`os.hostname()`), which `/own/device` gives devices for notices that name it (06 §9.8). */
  readonly pcName: string
  /** Host header values this listener answers to (loopback forms, the tailnet name, the configured origin). */
  readonly allowedHosts: () => ReadonlySet<string>
  /** Origins whose cookie requests may change state. */
  readonly allowedOrigins: () => ReadonlySet<string>
  readonly paired: (device: Devices.DeviceRecord) => void
  /** `POST /own/device/revoke`: a device removing this PC revokes itself (08 §3.5), like the PC's 폐기. */
  readonly revoke: (deviceId: string) => Promise<void>
  readonly now?: () => number
  /**
   * The pinned-TLS app listener (08): pairing only through the app's JSON + `x-own-pairing` flow (a browser that
   * clicked through the certificate warning cannot pair), forwarded-for headers ignored (no proxy in front adds them:
   * every peer is loopback behind `tailscale serve --tcp` or the portproxy), and `GET /own/routes`.
   */
  readonly app?: {
    readonly routes: () => AppRoutes | undefined
  }
}

/** `GET /own/routes` (08 §3.6): where the app may dial this PC now, and the pin it must keep seeing. */
export interface AppRoutes {
  readonly pcKey: string
  readonly pin: string
  readonly name: string
  readonly routes: ReadonlyArray<string>
}

export interface TlsOptions {
  readonly cert: string
  readonly key: string
}

export const DEVICE_COOKIE = "own_device"
export const PAIRING_COOKIE = "own_pairing"

interface Closer {
  close(): void
}

/** Open requests, event streams and sockets per device: revocation closes them all (MG4). */
export class Connections {
  readonly #byDevice = new Map<string, Set<Closer>>()
  /** `<deviceId>|<serverKey>` → the device's event stream for that server (05 §13.8: one per device per server). */
  readonly #streams = new Map<string, Closer>()

  add(deviceId: string, closer: Closer) {
    const set = this.#byDevice.get(deviceId) ?? new Set()
    set.add(closer)
    this.#byDevice.set(deviceId, set)
    return () => {
      set.delete(closer)
      if (set.size === 0 && this.#byDevice.get(deviceId) === set) this.#byDevice.delete(deviceId)
    }
  }

  /** The newest event stream of a device and server wins; the previous one is closed. */
  stream(deviceId: string, serverKey: string, closer: Closer) {
    const key = `${deviceId}|${serverKey}`
    const previous = this.#streams.get(key)
    this.#streams.set(key, closer)
    previous?.close()
    return () => {
      if (this.#streams.get(key) === closer) this.#streams.delete(key)
    }
  }

  count(deviceId: string) {
    return this.#byDevice.get(deviceId)?.size ?? 0
  }

  closeDevice(deviceId: string) {
    for (const closer of [...(this.#byDevice.get(deviceId) ?? [])]) closer.close()
    this.#byDevice.delete(deviceId)
  }

  closeAll() {
    for (const id of [...this.#byDevice.keys()]) this.closeDevice(id)
  }
}

/** A PTY socket relayed to the service or a host. */
interface RelaySocket {
  readonly kind: "relay"
  readonly deviceId: string
  readonly url: string
  readonly headers: Record<string, string>
  upstream?: WebSocket
  queue: Array<string | ArrayBuffer | Uint8Array>
  release?: () => void
}

/** A browser pane viewer: the gateway's own socket, ended at the hub. */
interface BrowserSocket {
  readonly kind: "browser"
  readonly deviceId: string
  /** `local` or the SSH host the session runs on (05 §8.10.8). */
  readonly serverKey: string
  readonly sessionID: string
  readonly control: boolean
  handle?: BrowserHub.ViewerHandle
  release?: () => void
}

type SocketData = RelaySocket | BrowserSocket

/** How long a device's prompt waits for the desktop window to attach the session's browser pane (05 §8.10.5). */
export const PANE_WAIT_MS = 3000

/** Per-device request budget (05 §13.8 DoS): 60 requests per second sustained, bursts of 240. */
class Buckets {
  readonly #buckets = new Map<string, { tokens: number; at: number }>()
  take(key: string, now: number, rate = 60, burst = 240) {
    const bucket = this.#buckets.get(key) ?? { tokens: burst, at: now }
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate)
    bucket.at = now
    this.#buckets.set(key, bucket)
    if (this.#buckets.size > 10_000) this.#buckets.clear()
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}

export interface Listener {
  readonly port: number
  readonly connections: Connections
  stop(): Promise<void>
}

export function start(ctx: Context, bind: string, port: number, tls?: TlsOptions): Listener {
  const now = ctx.now ?? Date.now
  const connections = new Connections()
  const buckets = new Buckets()
  const unauthorized = new Buckets()
  const quiet = new Map<string, { at: number; skipped: number }>()
  let stopping = false

  /**
   * Pairing lines anyone can cause (a refused link, a claim or poll of an ended pairing): at most one a minute per
   * message and reason, with how many were left out, so a scanner cannot fill the log. Values are fixed words only.
   */
  function notice(message: string, fields: Readonly<Record<string, string>>) {
    const key = `${message}|${Object.values(fields).join("|")}`
    const at = now()
    const last = quiet.get(key)
    if (last && at - last.at < 60_000) {
      last.skipped++
      return
    }
    if (quiet.size > 1000) quiet.clear()
    quiet.set(key, { at, skipped: 0 })
    ctx.log.info(message, { ...fields, ...(last && last.skipped > 0 ? { skipped: last.skipped } : {}) })
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
    })
  const denied = (scope: string, message = "not allowed for this device") =>
    json(403, { _tag: "RpcError", type: "scope_denied", message, data: { scope } })

  function clientIp(req: Request, server: Server<SocketData>) {
    const peer = server.requestIP(req)?.address ?? null
    if (ctx.app) return peer
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    // Behind `tailscale serve` the peer is loopback and the device's tailnet address is forwarded.
    return peer && ServiceTarget.isLoopback(peer) && forwarded ? forwarded.slice(0, 64) : peer
  }

  async function authenticate(req: Request) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]
    const token = bearer ?? cookie(req, DEVICE_COOKIE)
    if (!token) return { ok: false as const, type: "device_unauthorized", via: "none" as const }
    const verified = await ctx.devices.verify(token)
    if (!verified.ok)
      return {
        ok: false as const,
        type: verified.reason === "unknown" ? "device_unauthorized" : `device_${verified.reason}`,
        via: bearer ? ("bearer" as const) : ("cookie" as const),
      }
    return { ok: true as const, device: verified.device, via: bearer ? ("bearer" as const) : ("cookie" as const) }
  }

  /** CSRF (05 §13.5): a cookie request that changes state, or opens a socket, must come from the gateway's origin. */
  function sameOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (!origin) return false
    const site = req.headers.get("sec-fetch-site")
    if (site && site !== "same-origin") return false
    return ctx.allowedOrigins().has(origin.toLowerCase())
  }

  const server = Bun.serve<SocketData>({
    hostname: bind,
    port,
    ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
    // Event streams and sockets are long-lived; the service and hosts send their own heartbeats (15 s).
    idleTimeout: 120,
    async fetch(req, server) {
      try {
        return await route(req, server)
      } catch (error) {
        ctx.log.warn("request_failed", { error: error instanceof Error ? error.name : "error" })
        return json(500, { type: "gateway_error", message: "gateway error" })
      }
    },
    websocket: {
      open(ws) {
        const data = ws.data
        if (data.kind === "browser") return openViewer(ws, data)
        const upstream = new WebSocket(data.url, { headers: data.headers } as never)
        upstream.binaryType = "arraybuffer"
        data.upstream = upstream
        data.release = connections.add(data.deviceId, { close: () => ws.close(4401, "device revoked") })
        upstream.onopen = () => {
          for (const message of data.queue.splice(0))
            upstream.send(typeof message === "string" || message instanceof ArrayBuffer ? message : new Uint8Array(message))
        }
        upstream.onmessage = (event) => ws.send(event.data as string | ArrayBuffer)
        upstream.onclose = (event) => ws.close(event.code === 1005 || event.code === 1006 ? 1011 : event.code, event.reason)
        upstream.onerror = () => ws.close(1011, "upstream error")
      },
      message(ws, message) {
        const data = ws.data
        if (data.kind === "browser") {
          // A viewer only sends text (`RemoteBrowser.ClientMessage`).
          if (typeof message !== "string") return ws.close(RemoteBrowser.CLOSE.protocol, "protocol")
          return data.handle?.message(message)
        }
        const upstream = data.upstream
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
        else data.queue.push(message)
      },
      close(ws) {
        const data = ws.data
        data.release?.()
        if (data.kind === "browser") {
          data.handle?.leave()
          ctx.audit.note(data.deviceId, "browser_view_closed", data.sessionID)
          ctx.log.info("browser_view_closed", { deviceId: data.deviceId, sessionID: data.sessionID })
          return
        }
        const upstream = data.upstream
        if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close()
      },
    },
  })

  /** Whether the device behind a viewer is still active and may still watch (memory only, asked per frame). */
  function mayView(deviceId: string, serverKey: string) {
    const device = ctx.devices.get(deviceId)
    return (
      device !== undefined &&
      Devices.state(device, now()) === "active" &&
      Policy.browserView({ scopes: new Set(device.scopes), servers: device.servers, serverKey, hosts: hostIds() }).ok
    )
  }

  /** This PC's SSH hosts (its registry): the only other servers whose panes the desktop holds. */
  function hostIds() {
    return ctx.hosts()?.list().map((host) => host.id) ?? []
  }

  function openViewer(ws: ServerWebSocket<SocketData>, data: BrowserSocket) {
    const hub = ctx.browser
    if (!hub) return ws.close(RemoteBrowser.CLOSE.away, "gateway closing")
    // Revocation and a change of scopes or servers close a device's connections at once (`closeDevice`); the code
    // tells the viewer which it was. A changed device may connect again and gets its new `control`.
    data.release = connections.add(data.deviceId, {
      close: () => {
        if (stopping) return ws.close(RemoteBrowser.CLOSE.away, "gateway closing")
        const device = ctx.devices.get(data.deviceId)
        if (!device || device.revokedAt !== null) return ws.close(RemoteBrowser.CLOSE.revoked, "device revoked")
        ws.close(RemoteBrowser.CLOSE.scope, "scope changed")
      },
    })
    ctx.audit.note(data.deviceId, "browser_view_opened", data.sessionID)
    ctx.log.info("browser_view_opened", { deviceId: data.deviceId, sessionID: data.sessionID })
    data.handle = hub.join({
      deviceId: data.deviceId,
      serverKey: data.serverKey,
      sessionID: data.sessionID,
      control: data.control,
      send: (message) => void ws.send(message),
      sendFrame: (bytes) => void ws.send(bytes),
      close: (code, reason) => ws.close(code, reason),
      alive: () => mayView(data.deviceId, data.serverKey),
    })
  }

  async function route(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const host = (req.headers.get("host") ?? "").toLowerCase()
    // DNS-rebinding guard: only the names this listener is reached by.
    if (!ctx.allowedHosts().has(host)) return new Response("misdirected", { status: 421 })
    const url = new URL(req.url)
    const pathname = url.pathname
    const ip = clientIp(req, server)

    if (pathname.startsWith("/auth/connect/") && req.method === "GET") return connect(req, pathname.slice(14), ip)
    if (pathname === "/own/pairing" && req.method === "GET") return pairingStatus(req)
    if (pathname === "/own/pairing/claim" && req.method === "POST") return claim(req, ip)
    if (pathname === "/own/logout" && req.method === "POST")
      return json(200, {}, { "set-cookie": clearCookie(DEVICE_COOKIE, secure(req)) })

    // `/srv/<serverKey>/api/*` is the relay; other `/srv/…` paths are own-web routes (`/srv/:serverKey/s/:id`, 03 §3)
    // and get the page like any route.
    const srv = /^\/srv\/([^/]+)(\/api\/.*)$/.exec(pathname)
    const routes = pathname === "/own/routes" && req.method === "GET" && ctx.app !== undefined
    const forget = pathname === "/own/device/revoke" && req.method === "POST"
    const viewer = pathname.startsWith(`${RemoteBrowser.SOCKET_PATH}/`)
    const deviceRoute =
      pathname === "/own/device" || pathname === "/own/servers" || routes || forget || viewer || srv !== null
    if (deviceRoute) {
      const auth = await authenticate(req)
      if (!auth.ok) {
        ctx.audit.record(null, ip, "unauthorized")
        if (ip && !unauthorized.take(`ip:${ip}`, now(), 1, 60)) return json(429, { type: "rate_limited", message: "too many requests" })
        return json(401, { type: auth.type, message: "device authentication required" })
      }
      const device = auth.device
      if (!buckets.take(device.deviceId, now())) return json(429, { type: "rate_limited", message: "too many requests" })
      ctx.devices.touch(device.deviceId, ip)
      const scopes = new Set<string>(device.scopes)
      if (pathname === "/own/device") {
        ctx.audit.record(device.deviceId, ip, "ok")
        return json(200, {
          deviceId: device.deviceId,
          name: device.name,
          kind: device.kind,
          scopes: device.scopes,
          servers: device.servers,
          expiresAt: device.expiresAt,
          controlDir: ctx.controlDir,
          pc: ctx.pcName,
        })
      }
      if (forget) {
        if (auth.via === "cookie" && !sameOrigin(req)) return denied("origin", "cross-origin request")
        ctx.audit.record(device.deviceId, ip, "ok")
        await ctx.revoke(device.deviceId)
        return json(200, { deviceId: device.deviceId, revoked: true }, { "set-cookie": clearCookie(DEVICE_COOKIE, secure(req)) })
      }
      if (routes) {
        ctx.audit.record(device.deviceId, ip, "ok")
        const current = ctx.app?.routes()
        return current ? json(200, current) : json(503, { type: "gateway_unavailable", message: "app access is off" })
      }
      if (pathname === "/own/servers") {
        if (!scopes.has("read")) {
          ctx.audit.record(device.deviceId, ip, "denied")
          return denied("read")
        }
        ctx.audit.record(device.deviceId, ip, "ok")
        return json(200, { servers: await servers(device) })
      }
      if (viewer) return browserView(req, server, pathname, device, scopes, auth.via, ip)
      const key = decodeURIComponentSafe(srv![1]!)
      const rest = srv![2]!
      if (!key) {
        ctx.audit.record(device.deviceId, ip, "denied")
        return json(404, { type: "not_found", message: "not found" })
      }
      return relay(req, server, url, key, rest, device, scopes, auth.via, ip)
    }

    // The service's own API and auth are never exposed at the root (devices use /srv/<serverKey>).
    if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname === "/openapi.json")
      return json(pathname === "/api/pair" ? 403 : 404, { type: pathname === "/api/pair" ? "scope_denied" : "not_found", message: "not found" })
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 })
    const page = await ctx.web.serve(pathname, req.method)
    return page ?? new Response("own-web is not installed (app\\<version>\\web)", { status: 503 })
  }

  // ---- pairing (05 §13.5)

  async function connect(req: Request, code: string, ip: string | null) {
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json")
    const address = ip ?? "-"
    const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" }
    // 08 §3.5: the app listener pairs apps only; a browser here has accepted an unverifiable certificate.
    if (ctx.app && !wantsJson) {
      notice("pairing_open_refused", { reason: "browser" })
      return new Response(APP_ONLY_PAGE, { status: 403, headers: { ...noStore, "content-type": "text/html; charset=utf-8" } })
    }
    if (ctx.limiter.blocked(address)) {
      notice("pairing_open_refused", { reason: "rate_limited" })
      ctx.audit.record(null, ip, "unauthorized")
      return wantsJson
        ? json(429, { type: "rate_limited", message: "too many attempts" })
        : redirect("/pair?e=rate", noStore)
    }
    const opened = ctx.pairings.open(code, {
      userAgent: summarizeAgent(req.headers.get("user-agent")),
      // Only `tailscale serve --https` adds this header. Nothing in front of the app listener does (raw TCP), so there
      // it would be whatever the client claims.
      tailscaleUser: ctx.app ? null : (req.headers.get("tailscale-user-login") ?? "").slice(0, 128) || null,
      ip,
    })
    if (!opened) {
      notice("pairing_open_refused", { reason: "expired_or_used" })
      ctx.limiter.fail(address)
      ctx.audit.record(null, ip, "unauthorized")
      return wantsJson ? json(410, { type: "pairing_expired", message: "link expired or used" }) : redirect("/pair?e=expired", noStore)
    }
    ctx.log.info("pairing_opened", {
      pairingId: opened.entry.pairingId,
      agent: opened.entry.userAgent,
      via: wantsJson ? "json" : "page",
    })
    const maxAge = Math.ceil((opened.entry.expiresAt - now()) / 1000) + 180
    if (wantsJson)
      return json(200, { claim: opened.claim, sas: opened.entry.sas, name: opened.entry.name, expiresAt: opened.entry.expiresAt })
    return redirect("/pair", { ...noStore, "set-cookie": setCookie(PAIRING_COOKIE, opened.claim, maxAge, secure(req)) })
  }

  function claimSecret(req: Request) {
    const header = req.headers.get("x-own-pairing")
    if (header) return { secret: header, via: "header" as const }
    const value = cookie(req, PAIRING_COOKIE)
    return value ? { secret: value, via: "cookie" as const } : undefined
  }

  function pairingStatus(req: Request) {
    const claim = claimSecret(req)
    if (!claim) return json(200, { state: "none" })
    const status = ctx.pairings.status(claim.secret)
    if (status.state !== "pending" && status.state !== "approved") notice("pairing_poll_ended", { state: status.state })
    return json(200, status)
  }

  async function claim(req: Request, ip: string | null) {
    const found = claimSecret(req)
    if (!found) {
      notice("pairing_claim_failed", { reason: "no_pairing" })
      return json(401, { type: "pairing_expired", message: "no pairing" })
    }
    if (found.via === "cookie" && ctx.app) {
      notice("pairing_claim_failed", { reason: "cookie_on_app" })
      return denied("pairing", "apps pair with the x-own-pairing header")
    }
    if (found.via === "cookie" && !sameOrigin(req)) {
      notice("pairing_claim_failed", { reason: "cross_origin" })
      return denied("origin", "cross-origin request")
    }
    const body = await readJson(req, 4096)
    const requested = body.ok && typeof body.value === "object" && body.value !== null ? (body.value as { kind?: unknown }).kind : undefined
    const entry = ctx.pairings.claim(found.secret)
    if (!entry) {
      notice("pairing_claim_failed", { reason: "not_approved", state: ctx.pairings.status(found.secret).state })
      ctx.audit.record(null, ip, "unauthorized")
      return json(410, { type: "pairing_expired", message: "pairing is not approved or has ended" })
    }
    const kind: OwnRemote.DeviceKind =
      found.via === "header" ? "app" : requested === "pwa" ? "pwa" : "browser"
    const { record, token } = await ctx.devices.create({
      deviceId: entry.deviceId,
      name: entry.name,
      kind,
      scopes: entry.scopes,
      servers: entry.servers,
      expiresDays: entry.expiresDays,
      userAgent: entry.userAgent,
      ip,
    })
    ctx.paired(record)
    ctx.log.info("pairing_claimed", { pairingId: entry.pairingId, deviceId: record.deviceId, kind })
    ctx.audit.record(record.deviceId, ip, "ok")
    if (found.via === "header") return json(200, { deviceId: record.deviceId, token, expiresAt: record.expiresAt })
    const maxAge = Math.max(60, Math.floor((record.expiresAt - now()) / 1000))
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" })
    headers.append("set-cookie", setCookie(DEVICE_COOKIE, token, maxAge, secure(req)))
    headers.append("set-cookie", clearCookie(PAIRING_COOKIE, secure(req)))
    return new Response(JSON.stringify({ deviceId: record.deviceId, expiresAt: record.expiresAt }), { status: 200, headers })
  }

  // ---- servers (05 §13.4 6)

  async function servers(device: Devices.DeviceRecord) {
    const list: Array<{ serverKey: string; name: string; baseUrl: string; controlDir: string | null; state: string }> = []
    if (Policy.serverAllowed(device.servers, "local"))
      list.push({ serverKey: "local", name: "local", baseUrl: "/srv/local", controlDir: ctx.controlDir, state: "ready" })
    const hosts = ctx.hosts()
    for (const host of hosts?.list() ?? []) {
      if (!Policy.serverAllowed(device.servers, host.id)) continue
      const endpoint = host.stage === "ready" ? await hosts!.endpoint(host.id).catch(() => null) : null
      list.push({
        serverKey: host.id,
        name: host.name,
        baseUrl: `/srv/${host.id}`,
        controlDir: endpoint?.controlDir ?? null,
        state: host.stage,
      })
    }
    return list
  }

  // ---- the browser pane's viewer socket (05 §8.10.2)

  async function browserView(
    req: Request,
    server: Server<SocketData>,
    pathname: string,
    device: Devices.DeviceRecord,
    scopes: ReadonlySet<string>,
    via: "bearer" | "cookie" | "none",
    ip: string | null,
  ): Promise<Response | undefined> {
    const refuse = (response: Response) => {
      ctx.audit.record(device.deviceId, ip, "denied")
      return response
    }
    const unavailable = () => json(404, { type: "browser_unavailable", message: "no browser pane on this server" })
    const parts = /^\/([^/]+)\/([^/]+)$/.exec(pathname.slice(RemoteBrowser.SOCKET_PATH.length))
    const serverKey = parts ? decodeURIComponentSafe(parts[1]!) : undefined
    const sessionID = parts ? decodeURIComponentSafe(parts[2]!) : undefined
    if (!serverKey || !sessionID) return refuse(json(404, { type: "not_found", message: "not found" }))
    if (req.method !== "GET" || (req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
      return refuse(json(426, { type: "upgrade_required", message: "websocket only" }, { upgrade: "websocket" }))
    if (via === "cookie" && !sameOrigin(req)) return refuse(denied("origin", "cross-origin request"))
    const decision = Policy.browserView({ scopes, servers: device.servers, serverKey, hosts: hostIds() })
    if (!decision.ok) return refuse(decision.status === 403 ? denied(decision.scope) : unavailable())
    if (!ctx.browser) return refuse(unavailable())
    const isLocal = serverKey === "local"
    const target = isLocal ? await ctx.service.current() : await endpointOf(serverKey)
    if (!target) {
      ctx.audit.record(device.deviceId, ip, "ok")
      return isLocal
        ? json(503, { type: "gateway_unavailable", message: "local service not found", data: { reason: "registration_missing" } })
        : json(503, { type: "host_unavailable", message: "host is not connected", data: { hostId: serverKey } })
    }
    // A `read` device sees every session of a server it may see (05 §13.5): the session only has to exist there.
    // The id is one path segment of the read (`..` would name another route).
    const found =
      SESSION_ID.test(sessionID) &&
      (await fetch(`${target.url}/api/session/${sessionID}`, {
        headers: { authorization: target.authorization },
        redirect: "manual",
      })
        .then((response) => {
          if (isLocal && response.status === 401) ctx.service.invalidate()
          void response.body?.cancel()
          return response.status === 200
        })
        .catch(() => false))
    if (!found) return refuse(json(404, { type: "session_not_found", message: "unknown session" }))
    ctx.audit.record(device.deviceId, ip, "ok")
    const ok = server.upgrade(req, {
      data: { kind: "browser", deviceId: device.deviceId, serverKey, sessionID, control: scopes.has("prompt") },
    })
    return ok ? undefined : json(400, { type: "upgrade_failed", message: "websocket upgrade failed" })
  }

  /**
   * 05 §8.10.5 rule 2: before a device's prompt runs, the desktop window is asked to attach the session's browser pane
   * (the agent's browser tools follow the attachment) and the relay waits a moment for it. Only with a desktop app
   * running, for a session it does not hold yet and whose rules do not take the browser away. A session that cannot
   * be read, or a pane that does not come in time, never holds the prompt back.
   */
  async function attachPane(
    hub: BrowserHub.Hub,
    target: { readonly url: string; readonly authorization: string },
    serverKey: string,
    param: string,
  ) {
    const sessionID = decodeURIComponentSafe(param)
    const key = sessionID ? RemoteBrowser.paneKey(serverKey, sessionID) : undefined
    if (!key || !hub.desktop() || hub.hosted(key)) return
    const session = await fetch(`${target.url}/api/session/${param}`, {
      headers: { authorization: target.authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(PANE_WAIT_MS),
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined)
    if (Policy.paneAttachable(session)) await hub.ensure(key, PANE_WAIT_MS)
  }

  // ---- relay (05 §13.4 3)

  async function relay(
    req: Request,
    server: Server<SocketData>,
    url: URL,
    key: string,
    apiPath: string,
    device: Devices.DeviceRecord,
    scopes: ReadonlySet<string>,
    via: "bearer" | "cookie" | "none",
    ip: string | null,
  ): Promise<Response | undefined> {
    const refuse = (response: Response) => {
      ctx.audit.record(device.deviceId, ip, "denied")
      return response
    }
    if (!Policy.serverAllowed(device.servers, key)) return refuse(denied("server"))
    const isLocal = key === "local"
    const hosts = ctx.hosts()
    if (!isLocal && !hosts?.list().some((host) => host.id === key)) return refuse(json(404, { type: "host_not_found", message: "unknown server" }))
    const match = Policy.classify(req.method, apiPath)
    const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
    if (via === "cookie" && (upgrade || !["GET", "HEAD"].includes(req.method)) && !sameOrigin(req))
      return refuse(denied("origin", "cross-origin request"))
    if (upgrade && !Policy.WEBSOCKET_ROUTES.includes(match.template)) return refuse(denied("websocket"))

    let body: BodyInit | undefined
    let parsed: unknown
    if (Policy.needsBody(match.need)) {
      const read = await readBytes(req, Policy.bodyLimit(match))
      if (!read.ok) return refuse(json(413, { type: "scope_denied", message: "body too large to inspect", data: { scope: "body" } }))
      body = read.bytes.byteLength > 0 ? (read.bytes as Uint8Array<ArrayBuffer>) : undefined
      try {
        parsed = read.bytes.byteLength > 0 ? JSON.parse(new TextDecoder().decode(read.bytes)) : undefined
      } catch {
        return refuse(json(400, { type: "input_invalid", message: "invalid JSON" }))
      }
    }
    const decision = Policy.decide({ need: match.need, params: match.params, scopes, server: isLocal ? "local" : "host", body: parsed })
    if (!decision.ok) return refuse(denied(decision.scope))

    // 05 §13.5 "기기에 묶인 메서드": the device's own cursor and subscription only.
    if (match.need.kind === "rpc" && isLocal) {
      const [rpcID, method] = match.params.map((part) => decodeURIComponentSafe(part))
      if (rpcID === Remote.ID && method && Remote.DEVICE_BOUND.has(method as OwnRemote.MethodName)) {
        const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
        const input = typeof value.input === "object" && value.input !== null ? (value.input as Record<string, unknown>) : {}
        body = JSON.stringify({ ...value, input: { ...input, deviceId: device.deviceId } })
      }
    }
    // 05 §13.4, 06 §2.9: a device's prompt carries its scopes (`own.device`), on this PC and on a host alike.
    if (match.need.kind === "prompt" && parsed !== undefined) body = JSON.stringify(Policy.stamp(parsed, scopes))

    const target = isLocal ? await ctx.service.current() : await endpointOf(key)
    if (!target) {
      ctx.audit.record(device.deviceId, ip, "ok")
      return isLocal
        ? json(503, { type: "gateway_unavailable", message: "local service not found", data: { reason: "registration_missing" } })
        : json(503, {
            type: "host_unavailable",
            message: "host is not connected",
            data: { hostId: key, stage: hosts?.list().find((host) => host.id === key)?.stage ?? "disconnected" },
          })
    }
    // On this PC and on an SSH host alike: the PC's desktop pane holds both (05 §8.10.8).
    if (match.need.kind === "prompt" && ctx.browser) await attachPane(ctx.browser, target, key, match.params[0]!)
    // A fork copies its source's rules and a new child its parent's: read that session first; one that cannot be read is
    // refused too.
    const parentID = match.need.kind === "session-create" ? Policy.parentOf(parsed) : undefined
    const copied =
      match.need.kind === "session-fork"
        ? match.params[0]
        : parentID === undefined
          ? undefined
          : encodeURIComponent(parentID)
    if (copied !== undefined) {
      const source = await fetch(`${target.url}/api/session/${copied}`, {
        headers: { authorization: target.authorization },
        redirect: "manual",
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined)
      if (!Policy.forkable(source)) return refuse(denied("local"))
    }
    // A hand-over copies its source's rules as they are: only rules equal to that session's (decisions RL5-4).
    const handoff =
      match.need.kind === "session-create" && match.need.rules === "permissions" ? Policy.handoffSource(parsed) : undefined
    if (handoff !== undefined) {
      const source = await fetch(`${target.url}/api/session/${encodeURIComponent(handoff)}`, {
        headers: { authorization: target.authorization },
        redirect: "manual",
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined)
      if (!Policy.handedOver(parsed, source)) return refuse(denied("local"))
    }
    // A write lands only in that server's temp folder: read where it is first; an unreadable answer is refused too.
    if (match.need.kind === "fs-write") {
      const info = await fetch(`${target.url}/api/info`, {
        headers: { authorization: target.authorization },
        redirect: "manual",
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined)
      if (!Policy.tmpWritable(url.searchParams.getAll("path"), info)) return refuse(denied("local"))
    }
    ctx.audit.record(device.deviceId, ip, "ok")
    const upstreamUrl = `${target.url}${apiPath}${url.search}`
    const headers = forwardHeaders(req.headers, target.authorization)

    if (upgrade) {
      const ok = server.upgrade(req, {
        data: {
          kind: "relay",
          deviceId: device.deviceId,
          url: upstreamUrl.replace(/^http/, "ws"),
          headers: plain(headers),
          queue: [],
        },
      })
      return ok ? undefined : json(400, { type: "upgrade_failed", message: "websocket upgrade failed" })
    }

    if (body === undefined && req.method !== "GET" && req.method !== "HEAD") body = req.body ?? undefined
    const abort = new AbortController()
    const release = connections.add(device.deviceId, { close: () => abort.abort() })
    let response: Response
    try {
      response = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        signal: abort.signal,
        redirect: "manual",
        duplex: "half",
      } as RequestInit)
    } catch {
      release()
      return json(502, { type: "upstream_unavailable", message: "upstream request failed" })
    }
    if (isLocal && response.status === 401) ctx.service.invalidate()
    const outHeaders = responseHeaders(response.headers)
    const eventStream = (response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    if (!response.body) {
      release()
      return new Response(null, { status: response.status, headers: outHeaders })
    }
    if (!eventStream) return new Response(track(response.body, release), { status: response.status, headers: outHeaders })
    // Event stream: unbuffered, frame by frame, `local` and out-of-scope frames removed (05 §13.4 2).
    server.timeout(req, 0)
    const unstream = connections.stream(device.deviceId, key, { close: () => abort.abort() })
    const filtered = track(response.body.pipeThrough(sseFilter(device.servers)), () => {
      unstream()
      release()
    })
    return new Response(filtered, { status: response.status, headers: outHeaders })
  }

  async function endpointOf(hostId: string) {
    const endpoint = await ctx.hosts()?.endpoint(hostId).catch(() => null)
    return endpoint ? { url: endpoint.url, authorization: ServiceTarget.basic(endpoint.token) } : undefined
  }

  return {
    port: server.port ?? port,
    connections,
    async stop() {
      stopping = true
      connections.closeAll()
      await server.stop(true)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])
/** Never forwarded to the service or a host (01 §6.4 불변식 5) or back to the device. */
const STRIP_REQUEST = new Set(["authorization", "cookie", "origin", "referer", "accept-encoding", "x-own-pairing"])

export function forwardHeaders(incoming: Headers, authorization: string) {
  const headers = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (HOP.has(lower) || STRIP_REQUEST.has(lower)) return
    if (lower.startsWith("sec-websocket-") || lower.startsWith("x-forwarded-") || lower.startsWith("tailscale-")) return
    if (lower.startsWith("sec-fetch-") || lower === "forwarded") return
    headers.set(name, value)
  })
  headers.set("authorization", authorization)
  headers.set("accept-encoding", "identity")
  return headers
}

export function responseHeaders(incoming: Headers) {
  const headers = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    // The service's cookies, auth challenges and CORS grants are not the device's.
    if (HOP.has(lower) || lower === "set-cookie" || lower === "www-authenticate" || lower.startsWith("access-control-")) return
    if (lower === "content-encoding") return
    headers.set(name, value)
  })
  headers.set("cache-control", incoming.get("cache-control") ?? "no-store")
  headers.set("x-content-type-options", "nosniff")
  return headers
}

/** A pass-through stream that reports its end, whether it finished, failed or the device went away. */
function track(source: ReadableStream<Uint8Array>, done: () => void) {
  const reader = source.getReader()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    done()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch {
        // Revoked, replaced, or the upstream went away: end the response (an event stream reconnects and learns why).
        finish()
        controller.close()
      }
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason).catch(() => undefined)
    },
  })
}

function plain(headers: Headers) {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (name === "accept-encoding" || name.startsWith("sec-") || name === "content-type") return
    out[name] = value
  })
  return out
}

/** Splits an SSE byte stream into frames and keeps the visible ones (a frame of latency at most). */
export function sseFilter(servers: OwnRemote.ServerScope) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending)
        if (!match) break
        const frame = pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
        if (Policy.frameVisible(frame, servers)) controller.enqueue(encoder.encode(`${frame}\n\n`))
      }
      // A single frame larger than 4 MiB is not an event we relay.
      if (pending.length > 4 * 1024 * 1024) pending = ""
    },
  })
}

export function cookie(req: Request, name: string) {
  const header = req.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || undefined
  }
  return undefined
}

/**
 * `Secure` except on a plain-http loopback request (this PC's own browser, the tests): Chromium accepts Secure cookies
 * from `http://localhost` but not every browser does, and behind `tailscale serve` the device always uses https.
 */
function secure(req: Request) {
  if (req.headers.get("x-forwarded-proto") === "https") return true
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1")
  return !(new URL(req.url).protocol === "http:" && (host === "localhost" || ServiceTarget.isLoopback(host)))
}

function setCookie(name: string, value: string, maxAge: number, secure: boolean) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? "; Secure" : ""}`
}

function clearCookie(name: string, secure: boolean) {
  return setCookie(name, "", 0, secure)
}

function redirect(location: string, headers: Record<string, string>) {
  return new Response(null, { status: 302, headers: { location, ...headers } })
}

async function readBytes(req: Request, limit: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = Number(req.headers.get("content-length") ?? "0")
  if (declared > limit) return { ok: false }
  if (!req.body) return { ok: true, bytes: new Uint8Array() }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return { ok: false }
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

async function readJson(req: Request, limit: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const read = await readBytes(req, limit)
  if (!read.ok) return { ok: false }
  if (read.bytes.byteLength === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(read.bytes)) }
  } catch {
    return { ok: false }
  }
}

/** A session id as one safe path segment (upstream's ids start with `ses`). */
const SESSION_ID = /^ses[\w-]{1,128}$/

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const APP_ONLY_PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>앱 전용 주소</title><body style="font:16px system-ui;background:#1d1f22;color:#e6e6e6;padding:24px">
<p>이 주소는 Own OpenCode 앱(Android, 데스크톱) 전용이에요. 브라우저에서는 PC의 설정 &gt; 휴대폰·다른 PC에서 브라우저용 QR을 쓰세요.</p></body></html>`

/** `Safari · iOS`: browser and OS family only (the device list and the SAS dialog), never the raw header. */
export function summarizeAgent(agent: string | null): string | null {
  if (!agent) return null
  // This PC's own 모바일 미리보기 (08 §4.3) carries the Android app's token too, so it is told apart first.
  if (/OwnPreview\/\d+/.test(agent)) return "Own 모바일 미리보기 · Windows"
  // Our apps (08 §3.4): `OwnOpenCodeApp/1 (android)`, `OwnOpenCodeApp/1 (desktop)`.
  const app = /OwnOpenCodeApp\/\d+ \((android|desktop)\)/.exec(agent)?.[1]
  if (app === "android") return "Own 앱 · Android"
  if (app === "desktop") return "Own 데스크톱 앱 · Windows"
  const os = /iPhone|iPad|iOS/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : null
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /SamsungBrowser/.test(agent)
      ? "Samsung Internet"
      : /Firefox|FxiOS/.test(agent)
        ? "Firefox"
        : /Chrome|CriOS/.test(agent)
          ? "Chrome"
          : /Safari/.test(agent)
            ? "Safari"
            : null
  const parts = [browser, os].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : null
}

export const _testing = { Devices }

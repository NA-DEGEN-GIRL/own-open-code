export * as BrowserGateway from "./browser-gateway.js"

// A gateway for the browser pane on a device (05 §8.10), in process on loopback: the real `Gateway` (listener, device
// store, pairing, the hub) in front of a fake local service that knows a few sessions, records prompts and serves
// RPC `own.remote` `browser.*` through the real handlers, so a test can play all three parts:
//
//   device   `pair()` (the real HTTP pairing), `viewer()` (the socket `/own/browser/local/<sessionID>`)
//   shell    `rpc("browser.host.pull", …)` with the service password, as the desktop shell's main process does
//   window   `events` (what the leader would publish as `rpc.own.remote.browser.pane.wanted`), `rpc("browser.pane.wanted")`
//
// Used by test/gateway/browser.test.ts; other packages' tests may import it (own-desktop's shell against `service`,
// a viewer against `base`). Everything binds 127.0.0.1 on ephemeral ports and lives under one temp folder.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { ServiceTarget } from "@own/runtime"
import type { Events } from "../../src/events.js"
import { Gateway } from "../../src/gateway/gateway.js"
import { Log } from "../../src/log.js"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"
import { Handlers } from "../../src/rpc/handlers.js"

export const PASSWORD = "svc-password-fake-0123456789abcdef"
/** An SSH host the fixture's controller lists (not connected): a server a device may be limited to. */
export const HOST_ID = "h-abcdef"
/** Where the fake service plays the host's own service (the tunnel's endpoint). */
export const HOST_PREFIX = "/host-service"

export interface Session {
  readonly permissions?: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>
}

export interface Seen {
  readonly method: string
  readonly path: string
  readonly body: string
  readonly at: number
}

export interface Device {
  readonly deviceId: string
  readonly token: string
  /** The headers that authenticate it: the cookie and the gateway's origin, or `Authorization: Bearer` for an app. */
  readonly auth: Readonly<Record<string, string>>
  get(route: string, init?: RequestInit): Promise<Response>
  post(route: string, body: unknown): Promise<Response>
}

export type Fixture = Awaited<ReturnType<typeof start>>
export type ViewerClient = ReturnType<typeof viewer>

const FAILED = Symbol("rpc error")

interface Failure {
  readonly [FAILED]: true
  readonly type: string
  readonly message: string
  readonly data: unknown
}

function freePort() {
  return new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/**
 * `sessions`: this PC's service. `hostSessions`: the SSH host `HOST_ID`'s, served by the same fake under
 * `HOST_PREFIX` once the test turns the host ready (`host.ready`), with the service password as its token.
 */
export async function start(
  input: {
    readonly sessions?: Readonly<Record<string, Session>>
    readonly hostSessions?: Readonly<Record<string, Session>>
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-gw-browser-"))
  const ownHome = path.join(root, "own-home")
  const web = path.join(root, "web")
  fs.mkdirSync(ownHome, { recursive: true })
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(web, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  const sessions = new Map(Object.entries(input.sessions ?? { ses_1: {}, ses_2: {} }))
  const hostSessions = new Map(Object.entries(input.hostSessions ?? {}))
  const host = { ready: false }
  const seen: Seen[] = []
  const events: Events.Event[] = []
  const logs: Array<Record<string, unknown>> = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const slot: { gateway?: Gateway; handlers?: ReturnType<typeof Handlers.local> } = {}

  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The shell's long poll waits up to 30 s.
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url)
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text()
      seen.push({ method: req.method, path: url.pathname, body, at: Date.now() })
      if (req.headers.get("authorization") !== ServiceTarget.basic(PASSWORD)) return new Response("no", { status: 401 })
      // The SSH host's service: its sessions, and every other route answered with its path.
      if (url.pathname.startsWith(`${HOST_PREFIX}/`)) {
        if (!host.ready) return new Response("down", { status: 502 })
        const read = /^\/api\/session\/([^/]+)$/.exec(url.pathname.slice(HOST_PREFIX.length))
        const found = read && req.method === "GET" ? hostSessions.get(decodeURIComponent(read[1]!)) : undefined
        if (read && req.method === "GET" && !found) return Response.json({ type: "session_not_found" }, { status: 404 })
        if (found) return Response.json({ data: { id: read![1], ...(found.permissions ? { permissions: found.permissions } : {}) } })
        return Response.json({ data: { path: url.pathname } })
      }
      if (url.pathname === "/api/event") {
        server.timeout(req, 0)
        const own: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              own.controller = controller
              streams.add(controller)
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "e-0", type: "server.connected", data: {} })}\n\n`))
            },
            cancel() {
              if (own.controller) streams.delete(own.controller)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const session = /^\/api\/session\/([^/]+)$/.exec(url.pathname)
      if (session && req.method === "GET") {
        const found = sessions.get(decodeURIComponent(session[1]!))
        if (!found) return Response.json({ type: "session_not_found" }, { status: 404 })
        return Response.json({ data: { id: session[1], ...(found.permissions ? { permissions: found.permissions } : {}) } })
      }
      const rpc = /^\/api\/rpc\/own\.remote\/(browser\.[a-z.]+)$/.exec(url.pathname)
      if (rpc && req.method === "POST") return call(rpc[1]!, body)
      return Response.json({ data: { path: url.pathname } })
    },
  })

  /** One `own.remote` `browser.*` call as the service's RPC route makes it: input checked, the real handler, its error. */
  async function call(method: string, body: string) {
    if (!Object.hasOwn(OwnRemote.Definition.methods, method)) return Response.json({ type: "rpc.not_found" }, { status: 404 })
    const name = method as OwnRemote.MethodName
    const checked = await OwnRemote.Definition.methods[name].input["~standard"].validate(JSON.parse(body).input)
    if (checked.issues) return Response.json({ type: "rpc.invalid_input", message: "invalid input" }, { status: 400 })
    const context = {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown): Failure => ({ [FAILED]: true, type, message, data }),
    }
    const handler = slot.handlers![name] as unknown as (input: unknown, context: unknown) => Promise<object>
    const output = await handler(checked.value, context)
    if (FAILED in output) {
      const failure = output as Failure
      return Response.json({ _tag: "RpcError", type: failure.type, message: failure.message, data: failure.data }, { status: 400 })
    }
    return Response.json({ output })
  }

  const registration = path.join(root, "service-own.json")
  fs.writeFileSync(
    registration,
    JSON.stringify({ id: "x", version: "local", url: `http://127.0.0.1:${service.port}`, pid: process.pid, password: PASSWORD }),
  )
  const controller = {
    list: () => ({ revision: 1, hosts: [{ id: HOST_ID, name: "lab", stage: host.ready ? "ready" : "disconnected" }] }),
    resolve: async () =>
      host.ready
        ? { url: `http://127.0.0.1:${service.port}${HOST_PREFIX}`, token: PASSWORD, controlDir: "/home/dev/.local/share/own-open-code/control" }
        : { url: null, stage: "disconnected" },
  }
  const gateway = new Gateway({
    buildId: `gw-browser-${process.pid}-${path.basename(root)}`,
    ownHome,
    channel: "own",
    options: { registration, webRoot: web, tailscaleCommand: null, auditIntervalMs: 60_000 },
    log: Log.create({ scope: "test", sink: (line) => logs.push(JSON.parse(line)) }),
    pin: async () => ({ controller: controller as never, release: async () => {} }),
  })
  gateway.useController(() => controller as never)
  slot.gateway = gateway
  slot.handlers = Handlers.local({ controller: controller as never, operations: undefined as never, ready: Promise.resolve(), gateway })
  // What own-remote's leader instance publishes (`src/index.ts`): here to the service's event streams and `events`.
  gateway.hub.subscribe((event) => {
    events.push(event)
    const frame = encoder.encode(
      `data: ${JSON.stringify({ id: `e-${events.length}`, type: `rpc.${OwnRemote.ID}.${event.name}`, data: { eventId: `evt_${events.length}`, ...event.data } })}\n\n`,
    )
    for (const stream of streams) stream.enqueue(frame)
  })
  const plan = await gateway.plan({ port: await freePort() })
  if (!plan.ok) throw new Error(JSON.stringify(plan))
  const executed = await gateway.execute(plan.value.nonce)
  if (!executed.ok) throw new Error(JSON.stringify(executed))
  const base = executed.value.url!

  /** Pairs a device through the real HTTP flow: a browser (cookie + origin) or an app (`Authorization: Bearer`). */
  async function pair(device: {
    readonly name?: string
    readonly scopes: ReadonlyArray<OwnRemote.DeviceScope>
    readonly servers?: OwnRemote.ServerScope
    readonly kind?: "browser" | "app"
  }): Promise<Device> {
    const started = await gateway.pairStart({
      name: device.name ?? "기기",
      scopes: device.scopes,
      servers: device.servers ?? { mode: "all" },
      expiresDays: 30,
    })
    if (!started.ok) throw new Error(JSON.stringify(started))
    if (device.kind === "app") {
      const opened = await fetch(started.value.url, { headers: { accept: "application/json" } })
      const { claim, sas } = (await opened.json()) as { claim: string; sas: string }
      if (!gateway.approve(started.value.pairingId, sas).ok) throw new Error("approve")
      const claimed = await fetch(`${base}/own/pairing/claim`, {
        method: "POST",
        headers: { "x-own-pairing": claim, "content-type": "application/json" },
        body: "{}",
      })
      const { deviceId, token } = (await claimed.json()) as { deviceId: string; token: string }
      return client(deviceId, token, { authorization: `Bearer ${token}` })
    }
    const opened = await fetch(started.value.url, { redirect: "manual" })
    const pairing = /own_pairing=([^;]+)/.exec(opened.headers.getSetCookie().join("\n"))?.[1]
    const status = (await (await fetch(`${base}/own/pairing`, { headers: { cookie: `own_pairing=${pairing}` } })).json()) as { sas: string }
    if (!gateway.approve(started.value.pairingId, status.sas).ok) throw new Error("approve")
    const claimed = await fetch(`${base}/own/pairing/claim`, {
      method: "POST",
      headers: { cookie: `own_pairing=${pairing}`, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ kind: "browser" }),
    })
    const token = /own_device=([^;]+)/.exec(claimed.headers.getSetCookie().join("\n"))?.[1]
    const { deviceId } = (await claimed.json()) as { deviceId: string }
    if (!token) throw new Error("no device cookie")
    return client(deviceId, token, { cookie: `own_device=${token}`, origin: base })
  }

  function client(deviceId: string, token: string, auth: Record<string, string>): Device {
    const get = (route: string, init: RequestInit = {}) =>
      fetch(`${base}${route}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } })
    return {
      deviceId,
      token,
      auth,
      get,
      post: (route, body) => get(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }
  }

  /** The desktop app's side: RPC `own.remote` on the service with its password (never through the gateway). */
  async function rpc<T = Record<string, unknown>>(method: OwnRemote.MethodName, payload: unknown = {}) {
    const response = await fetch(`http://127.0.0.1:${service.port}/api/rpc/${OwnRemote.ID}/${method}`, {
      method: "POST",
      headers: { authorization: ServiceTarget.basic(PASSWORD), "content-type": "application/json" },
      body: JSON.stringify({ input: payload }),
    })
    const body = (await response.json()) as { output?: T; type?: string; data?: unknown }
    return { status: response.status, output: body.output as T, error: body.type, data: body.data }
  }

  return {
    /** The gateway's origin (`http://127.0.0.1:<port>`): what a device talks to. */
    base,
    gateway,
    /** The fake local service: the shell's RPC target. */
    service: { url: `http://127.0.0.1:${service.port}`, password: PASSWORD, seen, sessions },
    /** The SSH host `HOST_ID`: `ready` connects it (its sessions answer under `HOST_PREFIX`). */
    host,
    /** Every event of the gateway's hub, as own-remote's leader would publish it. */
    events,
    /** The gateway's log lines (parsed). */
    logs,
    pair,
    rpc,
    viewer: (device: Device, sessionID: string, options: ViewerOptions = {}) => viewer(base, device, sessionID, options),
    async stop() {
      await gateway.close()
      await service.stop(true)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export interface ViewerOptions {
  readonly serverKey?: string
  /** Replaces the device's own headers (a cookie without the origin, another origin). */
  readonly headers?: Readonly<Record<string, string>>
}

/** A device's viewer socket: what own-web's browser view does, without the drawing. */
export function viewer(base: string, device: Pick<Device, "auth">, sessionID: string, options: ViewerOptions = {}) {
  const url = `${base.replace(/^http/, "ws")}${RemoteBrowser.socketPath(options.serverKey ?? "local", sessionID)}`
  // Bun's client takes request headers (a browser sends its cookie and origin by itself).
  const socket = new WebSocket(url, { headers: options.headers ?? device.auth } as never)
  socket.binaryType = "arraybuffer"
  const messages: RemoteBrowser.ServerMessage[] = []
  const frames: Array<{ readonly header: RemoteBrowser.FrameHeader; readonly jpeg: Uint8Array }> = []
  const end: { closed?: { readonly code: number; readonly reason: string } } = {}
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }
  /** Messages sent before the socket opened. */
  const early: string[] = []
  const opened = new Promise<boolean>((resolve) => {
    socket.onopen = () => {
      for (const text of early.splice(0)) socket.send(text)
      resolve(true)
    }
    socket.onerror = () => resolve(false)
  })
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    socket.onclose = (event) => {
      end.closed = { code: event.code, reason: event.reason }
      resolve(end.closed)
      changed()
    }
  })
  socket.onmessage = (event) => {
    if (typeof event.data === "string") messages.push(JSON.parse(event.data))
    else {
      const frame = RemoteBrowser.decodeFrame(new Uint8Array(event.data as ArrayBuffer))
      if (frame) frames.push(frame)
    }
    changed()
  }
  /** Waits until `pick` answers something (checked on every message, frame and the close). */
  const until = <T>(pick: () => T | undefined | false, ms = 5000) =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const value = pick()
        if (value === undefined || value === false) return false
        clearTimeout(timer)
        listeners.delete(check)
        resolve(value)
        return true
      }
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error(`viewer: nothing in ${ms} ms (messages ${JSON.stringify(messages.map((message) => message.t))})`))
      }, ms)
      if (!check()) listeners.add(check)
    })
  const send = (message: RemoteBrowser.ClientMessage) => {
    if (socket.readyState === WebSocket.CONNECTING) return void early.push(JSON.stringify(message))
    socket.send(JSON.stringify(message))
  }
  return {
    socket,
    messages,
    frames,
    opened,
    closed,
    until,
    send,
    hello: (over: Partial<Extract<RemoteBrowser.ClientMessage, { t: "hello" }>> = {}) =>
      send({ t: "hello", v: 1, viewport: { width: 390, height: 800, dpr: 3 }, mode: "pc", quality: "auto", visible: true, ...over }),
    ready: () => until(() => messages.flatMap((message) => (message.t === "ready" ? [message] : []))[0]),
    /** The newest `state`, once one with this host word has come. */
    state: (host: RemoteBrowser.HostState) =>
      until(() => {
        const last = messages.flatMap((message) => (message.t === "state" ? [message.state] : [])).at(-1)
        return last?.host === host ? last : undefined
      }),
    result: (id: number) => until(() => messages.flatMap((message) => (message.t === "result" && message.id === id ? [message] : []))[0]),
    frame: (count = 1) => until(() => (frames.length >= count ? frames[count - 1] : undefined)),
    close: () => socket.close(),
  }
}

/** A tiny JPEG-looking payload (the hub checks the magic only) as the shell sends it: base64. */
export function jpeg(fill = 7, length = 64) {
  const bytes = Buffer.alloc(length, fill)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  return bytes.toString("base64")
}

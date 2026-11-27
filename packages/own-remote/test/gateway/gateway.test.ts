// The gateway end to end in process (05 §13.4–13.6): a fake local service and a fake SSH host behind it, a simulated
// device client (fetch with a cookie jar, WebSocket). Covers MG1 (loopback only), MG2 (pairing), MG3 (scope matrix:
// denied requests never reach the service), MG4 (revocation closes streams and sockets), MG5 (the /srv/<hostId> relay
// adds the host token; the device never sees it), MG8 (no plaintext token or password in OWN_HOME files or device
// responses), the feed, TG17's gateway part (a host's own.team on /srv/<hostId> by the OwnTeam table, `local`
// methods refused; the host team's decisions in the feed, 06 §9.8) for browser and app devices, and IG11's gateway
// part (own.import by its table on this PC only, its declared events relayed, 09 §5.5). The real-server version is
// packages/own-web/e2e/gateway (Edge, mobile emulation).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { ServiceTarget } from "@own/runtime"
import { Gateway } from "../../src/gateway/gateway.js"
import { Log } from "../../src/log.js"
import { Policy } from "../../src/gateway/policy.js"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"
import { Token } from "../../src/token.js"

/** Rules of a session in 읽기 전용 (shaped like own.accounts' `session.approval.set`; fake). */
const READ_ONLY = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "bash", resource: "*", effect: "ask" },
]
const PASSWORD = "svc-password-fake-0123456789abcdef"
const HOST_PASSWORD = "host-password-fake-0123456789"
const HOST_ID = "h-abcdef"
const OTHER_HOST = "h-zzzzzz"

interface Seen {
  readonly method: string
  readonly path: string
  readonly auth: string | null
  readonly cookie: boolean
  readonly origin: boolean
  readonly body: string
}

function upstream(name: string, password: string | ((header: string | null) => boolean)) {
  const seen: Seen[] = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>()
  const encoder = new TextEncoder()
  const accepts = typeof password === "function" ? password : (header: string | null) => header === ServiceTarget.basic(password)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text()
      seen.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        cookie: req.headers.has("cookie"),
        origin: req.headers.has("origin"),
        body,
      })
      if (!accepts(req.headers.get("authorization")) && !url.searchParams.has("ticket")) return new Response("no", { status: 401 })
      if (url.pathname.endsWith("/connect") && req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return undefined
      }
      if (url.pathname === "/api/event") {
        srv.timeout(req, 0)
        let own: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            own = controller
            streams.add(controller)
            const send = (type: string, data: Record<string, unknown>) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `e-${type}`, type, data })}\n\n`))
            send("server.connected", {})
            send("rpc.own.remote.host.prompt", { hostId: HOST_ID, promptId: "p1", text: "password:" })
            send("rpc.own.remote.device.pairing.pending", { pairingId: "pair_x", sas: "1234" })
            send("rpc.own.remote.host.state", { hostId: OTHER_HOST, stage: "ready" })
            send("rpc.own.remote.host.state", { hostId: HOST_ID, stage: "ready" })
            send("session.created", { sessionID: "ses_1", title: "로컬 세션" })
            send("session.execution.succeeded", { sessionID: "ses_1" })
          },
          cancel() {
            if (own) streams.delete(own)
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname.startsWith("/api/rpc/")) return Response.json({ output: { ok: true, from: name } })
      // A session the PC turned computer use on for, and one that does not exist.
      if (url.pathname === "/api/session/ses_pc")
        return Response.json({ data: { id: "ses_pc", permissions: [{ action: "computer", resource: "*", effect: "allow" }] } })
      if (url.pathname === "/api/session/ses_gone") return Response.json({ type: "session_not_found" }, { status: 404 })
      // A session in 읽기 전용 that a phone hands over to a new one (`새 세션으로 인계` copies its rules).
      if (url.pathname === "/api/session/ses_ro") return Response.json({ data: { id: "ses_ro", permissions: READ_ONLY } })
      return Response.json({ data: { from: name, path: url.pathname } })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(`pty-hello from ${name}`)
      },
      message(ws, message) {
        ws.send(`echo:${message}`)
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    sockets,
    streams,
    /** Writes one event to every open `/api/event` stream (the gateway feed's and relayed device streams). */
    send(type: string, data: Record<string, unknown>) {
      const frame = encoder.encode(`data: ${JSON.stringify({ id: `e-${type}`, type, data })}\n\n`)
      for (const controller of streams) controller.enqueue(frame)
    },
    stop: () => server.stop(true),
  }
}

class Jar {
  readonly cookies = new Map<string, string>()
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";")
      const index = pair!.indexOf("=")
      const name = pair!.slice(0, index).trim()
      const value = pair!.slice(index + 1).trim()
      if (value === "" || /Max-Age=0/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  }
}

const state: {
  root?: string
  ownHome?: string
  local?: ReturnType<typeof upstream>
  host?: ReturnType<typeof upstream>
  gateway?: Gateway
  base?: string
  hostStage: string
} = { hostStage: "ready" }

async function freePort() {
  return new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "own-gw-e2e-"))
  state.ownHome = path.join(state.root, "own-home")
  fs.mkdirSync(state.ownHome, { recursive: true })
  const web = path.join(state.root, "web")
  fs.mkdirSync(path.join(web, "_assets"), { recursive: true })
  fs.writeFileSync(
    path.join(web, "index.html"),
    '<!doctype html><html><head><script id="oc-theme-preload-script">document.documentElement.dataset.x="1"</script></head><body><div id="root"></div><script type="module" src="/_assets/app.js"></script></body></html>',
  )
  fs.writeFileSync(path.join(web, "_assets", "app.js"), "console.log('app')")
  fs.writeFileSync(path.join(web, "_assets", "manual-0123456789ab.html"), '<!doctype html><script src="manual-0123456789ab-0.js"></script>')
  fs.writeFileSync(path.join(web, "sw.js"), "self.addEventListener('fetch', () => {})")
  state.local = upstream("local", PASSWORD)
  const expires = Date.now() + 12 * 3600_000
  const hostToken = Token.sign(HOST_PASSWORD, expires)
  state.host = upstream("host", (header) => header === ServiceTarget.basic(hostToken))
  const registration = path.join(state.root, "service-own.json")
  fs.writeFileSync(registration, JSON.stringify({ id: "x", version: "local", url: state.local.url, pid: process.pid, password: PASSWORD }))
  const controller = {
    list: () => ({
      revision: 1,
      hosts: [
        { id: HOST_ID, name: "lab", stage: state.hostStage },
        { id: OTHER_HOST, name: "far", stage: "disconnected" },
      ],
    }),
    resolve: async (id: string) =>
      id === HOST_ID && state.hostStage === "ready"
        ? { url: state.host!.url, token: hostToken, tokenExpiresAt: expires, epoch: 1, controlDir: "/home/me/.local/share/own-open-code/control", home: "/home/me" }
        : { url: null, stage: "disconnected" },
  }
  state.gateway = new Gateway({
    buildId: `gw-test-${process.pid}`,
    ownHome: state.ownHome,
    channel: "own",
    options: { registration, webRoot: web, tailscaleCommand: null, auditIntervalMs: 60_000 },
    log: Log.silent,
    pin: async () => ({ controller: controller as never, release: async () => {} }),
  })
  state.gateway.useController(() => controller as never)
  const port = await freePort()
  const plan = await state.gateway.plan({ port })
  if (!plan.ok) throw new Error(JSON.stringify(plan))
  const executed = await state.gateway.execute(plan.value.nonce)
  if (!executed.ok) throw new Error(JSON.stringify(executed))
  state.base = executed.value.url!
})

afterAll(async () => {
  await state.gateway?.close()
  state.local?.stop()
  state.host?.stop()
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true })
})

/** A device: pairs through the real HTTP flow and keeps its cookie. */
async function pairDevice(input: {
  readonly name: string
  readonly scopes: ReadonlyArray<OwnRemote.DeviceScope>
  readonly servers?: OwnRemote.ServerScope
}) {
  const gateway = state.gateway!
  const started = await gateway.pairStart({ name: input.name, scopes: input.scopes, servers: input.servers ?? { mode: "all" }, expiresDays: 30 })
  if (!started.ok) throw new Error(JSON.stringify(started))
  const jar = new Jar()
  const link = new URL(started.value.url)
  expect(link.origin).toBe(state.base!)
  const opened = await fetch(link, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36" } })
  expect(opened.status).toBe(302)
  expect(opened.headers.get("location")).toBe("/pair")
  jar.take(opened)
  expect(jar.cookies.has("own_pairing")).toBe(true)
  const status = (await (await fetch(`${state.base}/own/pairing`, { headers: { cookie: jar.header() } })).json()) as { state: string; sas: string }
  expect(status.state).toBe("pending")
  const listed = await gateway.list()
  const pending = listed.pairings.find((pairing) => pairing.pairingId === started.value.pairingId)!
  expect(pending).toMatchObject({ state: "pending", sas: status.sas, userAgent: "Chrome · Android" })
  expect(gateway.approve(started.value.pairingId, status.sas).ok).toBe(true)
  const claimed = await fetch(`${state.base}/own/pairing/claim`, {
    method: "POST",
    headers: { cookie: jar.header(), origin: state.base!, "content-type": "application/json" },
    body: JSON.stringify({ kind: "browser" }),
  })
  expect(claimed.status).toBe(200)
  const setCookies = claimed.headers.getSetCookie()
  const deviceCookie = setCookies.find((line) => line.startsWith("own_device="))!
  expect(deviceCookie).toContain("HttpOnly")
  expect(deviceCookie).toContain("SameSite=Strict")
  jar.take(claimed)
  const token = jar.cookies.get("own_device")!
  const { deviceId } = (await claimed.json()) as { deviceId: string }
  const get = (route: string, init: RequestInit = {}) =>
    fetch(`${state.base}${route}`, { ...init, headers: { cookie: jar.header(), ...(init.headers as Record<string, string>) } })
  const post = (route: string, body: unknown) =>
    get(route, { method: "POST", headers: { origin: state.base!, "content-type": "application/json" }, body: JSON.stringify(body) })
  return { deviceId, token, jar, get, post }
}

/** An app device (`kind: "app"`, 08 §3.5): the JSON pairing with `x-own-pairing`, then `Authorization: Bearer`. */
async function pairApp(input: {
  readonly name: string
  readonly scopes: ReadonlyArray<OwnRemote.DeviceScope>
  readonly servers?: OwnRemote.ServerScope
}) {
  const gateway = state.gateway!
  const started = await gateway.pairStart({
    name: input.name,
    scopes: input.scopes,
    servers: input.servers ?? { mode: "all" },
    expiresDays: 30,
  })
  if (!started.ok) throw new Error(JSON.stringify(started))
  const opened = await fetch(started.value.url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (Linux; Android 15) OwnOpenCodeApp/1 (android)" },
  })
  expect(opened.status).toBe(200)
  const { claim, sas } = (await opened.json()) as { claim: string; sas: string }
  expect(gateway.approve(started.value.pairingId, sas).ok).toBe(true)
  const claimed = await fetch(`${state.base}/own/pairing/claim`, {
    method: "POST",
    headers: { "x-own-pairing": claim, "content-type": "application/json" },
    body: "{}",
  })
  expect(claimed.status).toBe(200)
  const { deviceId, token } = (await claimed.json()) as { deviceId: string; token: string }
  expect(gateway.devices.get(deviceId)?.kind).toBe("app")
  const get = (route: string, init: RequestInit = {}) =>
    fetch(`${state.base}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    })
  const post = (route: string, body: unknown) =>
    get(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { deviceId, token, get, post }
}

/** Reads an event stream until `done` holds for the text so far (or 3 s), then cancels it. */
async function readEvents(response: Response, done: (text: string) => boolean) {
  const reader = response.body!.getReader()
  let text = ""
  const deadline = Date.now() + 3000
  while (!done(text) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined })),
    ])
    if (next.done) break
    text += new TextDecoder().decode(next.value)
  }
  await reader.cancel()
  return text
}

const tokens: string[] = []

describe("gateway (in process)", () => {
  test("MG1: loopback listener only; LAN binds refused; no LAN address answers", async () => {
    const gateway = state.gateway!
    const view = await gateway.status()
    expect(view).toMatchObject({ enabled: true, state: "listening", bind: "127.0.0.1" })
    expect(view.tailscale).toMatchObject({ state: "missing", serveCommand: `tailscale serve --bg --https=443 http://127.0.0.1:${view.port}` })
    for (const bind of ["0.0.0.0", "::", "192.168.1.20", "10.1.2.3", "169.254.0.9", "fe80::1"])
      expect(await gateway.plan({ bind })).toMatchObject({ ok: false, error: "bind_rejected_lan" })
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry!.address)
    for (const address of lan) {
      const reached = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: address, port: view.port! })
        socket.once("connect", () => {
          socket.destroy()
          resolve(true)
        })
        socket.once("error", () => resolve(false))
        socket.setTimeout(1500, () => {
          socket.destroy()
          resolve(false)
        })
      })
      expect({ address, reached }).toEqual({ address, reached: false })
    }
    // A request naming another host (DNS rebinding) is refused.
    const misdirected = await fetch(`${state.base}/`, { headers: { host: "evil.example" } })
    expect(misdirected.status).toBe(421)
  })

  test("static own-web: page before auth, gateway marker and manifest link, CSP header with the script hash", async () => {
    const page = await fetch(`${state.base}/s/anything`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<meta name="own-gateway" content="1">')
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    const csp = page.headers.get("content-security-policy")!
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/)
    const sw = await fetch(`${state.base}/sw.js`)
    expect(sw.headers.get("cache-control")).toBe("no-cache")
    expect((await fetch(`${state.base}/_assets/missing.js`)).status).toBe(404)
    expect(csp).toContain("frame-ancestors 'none'")
    // 03 §4.3.1: the user manual is a page of its own that only this origin may frame (own-web's in-app viewer).
    const manual = await fetch(`${state.base}/_assets/manual-0123456789ab.html`)
    expect(manual.status).toBe(200)
    expect(manual.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(manual.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
    expect(manual.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval';")
    expect((await fetch(`${state.base}/_assets/app.js`)).headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    )
    // The service API and pairing are not exposed at the root.
    expect((await fetch(`${state.base}/api/session`)).status).toBe(404)
    expect((await fetch(`${state.base}/api/pair`, { method: "POST" })).status).toBe(403)
  })

  test("MG2: pairing — reuse, unknown code, rejection, mismatch leave no device; brute force is rate limited", async () => {
    const gateway = state.gateway!
    const before = (await gateway.list()).devices.length
    const started = await gateway.pairStart({ name: "x", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 })
    if (!started.ok) throw new Error("start")
    const first = await fetch(started.value.url, { redirect: "manual" })
    expect(first.headers.get("location")).toBe("/pair")
    const reuse = await fetch(started.value.url, { redirect: "manual" })
    expect(reuse.headers.get("location")).toBe("/pair?e=expired")
    const json = await fetch(started.value.url, { headers: { accept: "application/json" } })
    expect(json.status).toBe(410)
    // PC rejects: the device learns it, and no record exists.
    const jar = new Jar()
    jar.take(first)
    gateway.cancel(started.value.pairingId)
    const after = (await (await fetch(`${state.base}/own/pairing`, { headers: { cookie: jar.header() } })).json()) as { state: string }
    expect(after.state).toBe("rejected")
    const claim = await fetch(`${state.base}/own/pairing/claim`, { method: "POST", headers: { cookie: jar.header(), origin: state.base! } })
    expect(claim.status).toBe(410)
    // Mismatched SAS.
    const second = await gateway.pairStart({ name: "y", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 })
    if (!second.ok) throw new Error("start")
    await fetch(second.value.url, { redirect: "manual" })
    const sas = (await gateway.list()).pairings.find((item) => item.pairingId === second.value.pairingId)!.sas!
    expect(gateway.approve(second.value.pairingId, sas === "9999" ? "0000" : "9999")).toMatchObject({ ok: false, error: "pairing_rejected" })
    expect((await gateway.list()).devices.length).toBe(before)
    // Brute force from one address: the limiter answers 429 after 5 bad codes.
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const response = await fetch(`${state.base}/auth/connect/AAAAAAAAAAAAAAAAAAAAA${i}`, {
        headers: { accept: "application/json", "x-forwarded-for": "100.64.9.9" },
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 5)).toEqual([410, 410, 410, 410, 410])
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  test("MG3: scope matrix — out of scope and local are 403 and never reach the service", async () => {
    const readOnly = await pairDevice({ name: "읽기 전용", scopes: ["read"] })
    const phone = await pairDevice({ name: "휴대폰", scopes: ["read", "prompt", "switch"] })
    const admin = await pairDevice({ name: "관리", scopes: ["read", "prompt", "switch", "admin"] })
    tokens.push(readOnly.token, phone.token, admin.token)
    const local = state.local!
    const call = async (device: typeof phone, rpcID: string, method: string, input: unknown) => {
      const before = local.seen.length
      const response = await device.post(`/srv/local/api/rpc/${rpcID}/${method}`, { input })
      const reached = local.seen.slice(before).some((item) => item.path === `/api/rpc/${rpcID}/${method}`)
      return { status: response.status, reached }
    }
    const devices = { read: readOnly, phone, admin } as const
    const scopesOf = { read: new Set(["read"]), phone: new Set(["read", "prompt", "switch"]), admin: new Set(["read", "prompt", "switch", "admin"]) }
    for (const [label, device] of Object.entries(devices) as Array<[keyof typeof devices, typeof phone]>) {
      for (const [method, scope] of Object.entries(OwnAccounts.MethodScope)) {
        const allowed = scope !== "local" && scopesOf[label].has(scope)
        const result = await call(device, OwnAccounts.ID, method, {})
        expect({ label, method, ...result }).toEqual({ label, method, status: allowed ? 200 : 403, reached: allowed })
      }
      for (const method of Object.keys(OwnRemote.MethodScope) as OwnRemote.MethodName[]) {
        const scope = OwnRemote.MethodScope[method]
        const needed = scope === "read" ? "read" : scope === "drive" ? "switch" : scope === "manage" ? "admin" : undefined
        const allowed = needed !== undefined && scopesOf[label].has(needed)
        const result = await call(device, OwnRemote.ID, method, {})
        expect({ label, method, ...result }).toEqual({ label, method, status: allowed ? 200 : 403, reached: allowed })
      }
    }
    // Body rules: connect{hostKeyPrompt}, permission reply "always", accounts.update{replaceKey} (local), PTY.
    expect(await call(admin, OwnRemote.ID, "connect", { hostId: HOST_ID, clientId: "c", hostKeyPrompt: true })).toEqual({ status: 403, reached: false })
    expect(await call(admin, OwnRemote.ID, "connect", { hostId: HOST_ID, clientId: "c" })).toEqual({ status: 200, reached: true })
    expect(await call(admin, OwnAccounts.ID, "accounts.update", { accountID: "a", replaceKey: "sk-fake" })).toEqual({ status: 403, reached: false })
    // 02 §9.2: a long workspace note passes notes.put's 1 MiB inspection; every other RPC body stays at 64 KiB.
    const note = { workspace: "local:d:\\work\\repo", id: "n1", text: "가".repeat(100_000), baseRev: 0 }
    expect(await call(phone, OwnAccounts.ID, "notes.put", note)).toEqual({ status: 200, reached: true })
    expect(await call(readOnly, OwnAccounts.ID, "notes.put", note)).toEqual({ status: 403, reached: false })
    expect(await call(phone, OwnAccounts.ID, "accounts.list", note)).toEqual({ status: 413, reached: false })
    const reply = async (decision: string) => {
      const before = local.seen.length
      const response = await phone.post("/srv/local/api/session/ses_1/permission/per_1/reply", { decision })
      return { status: response.status, reached: local.seen.slice(before).some((item) => item.path.endsWith("/reply")) }
    }
    expect(await reply("once")).toEqual({ status: 200, reached: true })
    expect(await reply("always")).toEqual({ status: 403, reached: false })
    const blocked = async (device: typeof phone, method: string, route: string) => {
      const before = local.seen.length
      const response = await device.get(route, { method, headers: { origin: state.base! } })
      return { status: response.status, reached: local.seen.length > before }
    }
    for (const [method, route] of [
      ["POST", "/srv/local/api/pair"],
      ["GET", "/srv/local/api/integration"],
      ["POST", "/srv/local/api/credential/c1/activate"],
      ["POST", "/srv/local/api/location/reload"],
      ["PATCH", "/srv/local/api/experimental/config"],
      ["POST", "/srv/local/api/pty"],
      ["POST", "/srv/local/api/pty/pty_1/connect-token"],
      ["POST", "/srv/local/api/session/ses_1/shell"],
      ["GET", "/srv/local/api/fs/list"],
      ["GET", "/srv/local/api/unknown-route"],
    ] as const)
      expect({ route, ...(await blocked(admin, method, route)) }).toEqual({ route, status: 403, reached: false })
    // A fork copies its source's rules: a device may not fork a session that allows computer use (nor an unreadable one).
    const fork = async (sessionID: string) => {
      const before = local.seen.length
      const response = await phone.post(`/srv/local/api/session/${sessionID}/fork`, {})
      return { status: response.status, reached: local.seen.slice(before).some((item) => item.path.endsWith("/fork")) }
    }
    expect(await fork("ses_1")).toEqual({ status: 200, reached: true })
    expect(await fork("ses_pc")).toEqual({ status: 403, reached: false })
    expect(await fork("ses_gone")).toEqual({ status: 403, reached: false })
    expect(local.seen.some((item) => item.method === "GET" && item.path === "/api/session/ses_pc" && item.auth === ServiceTarget.basic(PASSWORD))).toBe(true)
    // A new child takes its parent's rules (upstream 19f203837e): the same rule as a fork, from the body's parentID.
    const child = async (body: Record<string, unknown>) => {
      const before = local.seen.length
      const response = await phone.post("/srv/local/api/session", body)
      return { status: response.status, reached: local.seen.slice(before).some((item) => item.method === "POST" && item.path === "/api/session") }
    }
    expect(await child({ parentID: "ses_1" })).toEqual({ status: 200, reached: true })
    expect(await child({ parentID: "ses_pc" })).toEqual({ status: 403, reached: false })
    expect(await child({ parentID: "ses_gone" })).toEqual({ status: 403, reached: false })
    // The body's id is one path segment of the read, never a path of its own.
    await child({ parentID: "../ses_pc" })
    expect(local.seen.some((item) => item.method === "GET" && item.path === "/api/session/..%2Fses_pc")).toBe(true)
    // A new session's rules are none or the browser deny: the mode follows through session.approval.set (RL5-4).
    const deny = { action: "browser", resource: "*", effect: "deny" }
    expect(await child({ title: "새 대화", agent: "build", permissions: [deny] })).toEqual({ status: 200, reached: true })
    expect(await child({ permissions: [{ action: "edit", resource: "*", effect: "allow" }] })).toEqual({ status: 403, reached: false })
    // A hand-over copies its source's rules exactly, read from the service first; anything more is refused.
    const handoff = (permissions: unknown, seededFrom = "ses_ro") => child({ permissions, metadata: { own: { seededFrom } } })
    expect(await handoff(READ_ONLY)).toEqual({ status: 200, reached: true })
    expect(local.seen.some((item) => item.method === "GET" && item.path === "/api/session/ses_ro")).toBe(true)
    expect(await handoff([...READ_ONLY, { action: "bash", resource: "*", effect: "allow" }])).toEqual({ status: 403, reached: false })
    expect(await handoff(READ_ONLY, "ses_1")).toEqual({ status: 403, reached: false })
    expect(await handoff(READ_ONLY, "ses_gone")).toEqual({ status: 403, reached: false })
    expect(await handoff([{ action: "computer", resource: "*", effect: "allow" }], "ses_pc")).toEqual({ status: 403, reached: false })
    // Allowed session work reaches the service with its Basic and none of the device's headers.
    const before = local.seen.length
    const prompt = await phone.post("/srv/local/api/session/ses_1/prompt", { text: "안녕" })
    expect(prompt.status).toBe(200)
    const forwarded = local.seen.slice(before).find((item) => item.path === "/api/session/ses_1/prompt")!
    expect(forwarded).toMatchObject({ auth: ServiceTarget.basic(PASSWORD), cookie: false, origin: false })
    // CSRF: a cookie POST without the gateway's origin is refused.
    const cross = await fetch(`${state.base}/srv/local/api/session/ses_1/prompt`, {
      method: "POST",
      headers: { cookie: phone.jar.header(), origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    })
    expect(cross.status).toBe(403)
    // The service password never comes back to the device.
    const info = await phone.get("/srv/local/api/info")
    expect(await info.text()).not.toContain(PASSWORD)
  }, 60_000)

  test("event stream: local frames and out-of-scope hosts are removed; device-bound feed input gets the caller's id", async () => {
    const device = await pairDevice({ name: "로컬만", scopes: ["read"], servers: { mode: "only", keys: ["local", HOST_ID] } })
    tokens.push(device.token)
    const response = await device.get("/srv/local/api/event")
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    let text = ""
    const deadline = Date.now() + 3000
    while (!text.includes("session.execution.succeeded") && Date.now() < deadline) {
      const next = await reader.read()
      if (next.done) break
      text += new TextDecoder().decode(next.value)
    }
    await reader.cancel()
    expect(text).toContain("server.connected")
    expect(text).toContain(`"hostId":"${HOST_ID}"`)
    expect(text).not.toContain("host.prompt")
    expect(text).not.toContain("pairing.pending")
    expect(text).not.toContain(OTHER_HOST)
    const before = state.local!.seen.length
    await device.post("/srv/local/api/rpc/own.remote/feed.list", { input: { deviceId: "dev_01HZZZZZZZZZZZZZZZZZZZZZZZ", limit: 5 } })
    const forwarded = state.local!.seen.slice(before).find((item) => item.path === "/api/rpc/own.remote/feed.list")!
    expect(JSON.parse(forwarded.body).input).toEqual({ deviceId: device.deviceId, limit: 5 })
  })

  test("feed: the producer records a completed turn from the local event stream, without content", async () => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !state.gateway!.feed.items().some((item) => item.kind === "turn.completed")) await Bun.sleep(100)
    const item = state.gateway!.feed.items().find((entry) => entry.kind === "turn.completed")!
    expect(item).toMatchObject({ kind: "turn.completed", serverKey: "local", sessionID: "ses_1", title: "로컬 세션", severity: "info" })
    const listed = await state.gateway!.feed.list({})
    expect(listed.items.map((entry) => entry.id)).toContain(item.id)
    const file = fs.readdirSync(path.join(state.ownHome!, "feed")).find((name) => name.startsWith("feed-"))!
    expect(fs.readFileSync(path.join(state.ownHome!, "feed", file), "utf8")).toContain(item.id)
  })

  test("MG5 (relay): /srv/<hostId> adds own-remote's signed host token; the device never gets it; a host outside servers is 403", async () => {
    const device = await pairDevice({ name: "원격", scopes: ["read", "prompt", "switch"] })
    tokens.push(device.token)
    const before = state.host!.seen.length
    const response = await device.get(`/srv/${HOST_ID}/api/session`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text).data.from).toBe("host")
    // The gateway feed's own team subscription to the host may reconnect meanwhile: look for the relayed request.
    const forwarded = state.host!.seen.slice(before).find((item) => item.path === "/api/session")!
    expect(forwarded.auth).toMatch(/^Basic /)
    expect(forwarded.cookie).toBe(false)
    const token = atob(forwarded.auth!.slice(6)).slice("opencode:".length)
    expect(text).not.toContain(token)
    // agent.* on the host is always blocked.
    const arm = await device.post(`/srv/${HOST_ID}/api/rpc/own.remote/agent.broker.arm`, { input: {} })
    expect(arm.status).toBe(403)
    // own.accounts on the host follows the same table.
    expect((await device.post(`/srv/${HOST_ID}/api/rpc/own.accounts/switch.state`, { input: {} })).status).toBe(200)
    // Not ready: 503 with the stage.
    const disconnected = await device.get(`/srv/${OTHER_HOST}/api/session`)
    expect(disconnected.status).toBe(503)
    expect(await disconnected.json()).toMatchObject({ type: "host_unavailable", data: { hostId: OTHER_HOST } })
    const restricted = await pairDevice({ name: "로컬 전용", scopes: ["read"], servers: { mode: "only", keys: ["local"] } })
    tokens.push(restricted.token)
    expect((await restricted.get(`/srv/${HOST_ID}/api/session`)).status).toBe(403)
    const servers = (await (await restricted.get("/own/servers")).json()) as { servers: Array<{ serverKey: string }> }
    expect(servers.servers.map((server) => server.serverKey)).toEqual(["local"])
    const all = (await (await device.get("/own/servers")).json()) as { servers: Array<{ serverKey: string; baseUrl: string; controlDir: string | null }> }
    expect(all.servers).toEqual([
      expect.objectContaining({ serverKey: "local", baseUrl: "/srv/local" }),
      expect.objectContaining({ serverKey: HOST_ID, baseUrl: `/srv/${HOST_ID}`, controlDir: "/home/me/.local/share/own-open-code/control" }),
      expect.objectContaining({ serverKey: OTHER_HOST, controlDir: null }),
    ])
  })

  test("voice input (02 §3.9): a recording over 64 KiB reaches this PC from a device that can prompt; other bodies keep 64 KiB; a host never gets one", async () => {
    const phone = await pairDevice({ name: "받아쓰기", scopes: ["read", "prompt"] })
    const reader = await pairDevice({ name: "보기만", scopes: ["read"] })
    tokens.push(phone.token, reader.token)
    const local = state.local!
    const audio = "A".repeat(300 * 1024)
    const route = (method: string, server = "local") => `/srv/${server}/api/rpc/${OwnAccounts.ID}/${method}`
    const before = local.seen.length
    const sent = await phone.post(route("voice.transcribe"), { input: { audio, mediaType: "audio/webm", hint: "own-web" } })
    expect(sent.status).toBe(200)
    const forwarded = local.seen.slice(before).find((item) => item.path === `/api/rpc/${OwnAccounts.ID}/voice.transcribe`)!
    expect(forwarded.auth).toBe(ServiceTarget.basic(PASSWORD))
    expect((JSON.parse(forwarded.body) as { input: { audio: string } }).input.audio).toHaveLength(audio.length)
    // The same body on any other method is still too large to inspect, and so is a recording past the voice cap.
    expect((await phone.post(route("voice.get"), { input: { audio } })).status).toBe(413)
    const huge = "A".repeat(Policy.VOICE_BODY_LIMIT)
    expect((await phone.post(route("voice.transcribe"), { input: { audio: huge, mediaType: "audio/webm" } })).status).toBe(413)
    // `prompt` spends paid minutes: a read-only device sees the settings but cannot transcribe; a key is never sent.
    expect((await reader.post(route("voice.get"), { input: {} })).status).toBe(200)
    expect((await reader.post(route("voice.transcribe"), { input: { audio: "AAAA", mediaType: "audio/webm" } })).status).toBe(403)
    const keyBefore = local.seen.length
    expect((await phone.post(route("voice.key.set"), { input: { provider: "openai", key: "sk-fake-voice" } })).status).toBe(403)
    expect(local.seen.slice(keyBefore).some((item) => item.path.includes("voice.key.set"))).toBe(false)
    // A remote host has no voice input: its own.accounts never gets a recording.
    const hostBefore = state.host!.seen.length
    for (const method of ["voice.get", "voice.transcribe"])
      expect((await phone.post(route(method, HOST_ID), { input: { audio: "AAAA", mediaType: "audio/webm" } })).status).toBe(403)
    expect(state.host!.seen.slice(hostBefore).some((item) => item.path.includes("voice."))).toBe(false)
  })

  test("device stamp (06 §2.9): a prompt reaches this PC and a host with the device's scopes; a client value is replaced; 4 MiB cap", async () => {
    const phone = await pairDevice({ name: "말 폰", scopes: ["read", "prompt", "switch"] })
    const admin = await pairApp({ name: "말 관리", scopes: ["admin", "read", "prompt"] })
    const reader = await pairDevice({ name: "말 보기", scopes: ["read"] })
    tokens.push(phone.token, admin.token, reader.token)
    const sent = async (device: typeof admin, server: "local" | "host", body: unknown) => {
      const upstream = server === "local" ? state.local! : state.host!
      const before = upstream.seen.length
      const key = server === "local" ? "local" : HOST_ID
      const response = await device.post(`/srv/${key}/api/session/ses_1/prompt`, body)
      const forwarded = upstream.seen.slice(before).find((item) => item.path === "/api/session/ses_1/prompt")
      return { status: response.status, body: forwarded === undefined ? undefined : JSON.parse(forwarded.body) }
    }
    const forged = {
      text: "응",
      metadata: { [OwnRemote.DEVICE_META]: { scopes: ["admin", "local"] }, "own.dictation": { lang: "ko" } },
    }
    expect(await sent(phone, "local", forged)).toEqual({
      status: 200,
      body: {
        text: "응",
        metadata: { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read", "switch"] }, "own.dictation": { lang: "ko" } },
      },
    })
    expect(await sent(admin, "host", { text: "응" })).toEqual({
      status: 200,
      body: { text: "응", metadata: { [OwnRemote.DEVICE_META]: { scopes: ["admin", "prompt", "read"] } } },
    })
    // A long paste passes the prompt's own cap; past 4 MiB the body is too large to inspect.
    const long = await sent(phone, "local", { text: "가".repeat(100 * 1024) })
    expect(long.status).toBe(200)
    expect(long.body.metadata[OwnRemote.DEVICE_META]).toEqual({ scopes: ["prompt", "read", "switch"] })
    expect(await sent(phone, "local", { text: "a".repeat(Policy.PROMPT_BODY_LIMIT) })).toEqual({ status: 413, body: undefined })
    expect(await sent(reader, "local", { text: "응" })).toEqual({ status: 403, body: undefined })
  })

  test("TG17 (gateway /srv/<hostId>): a host's own.team follows the table for browser and app devices; local methods never reach it", async () => {
    const browser = await pairDevice({ name: "원격 팀 폰", scopes: ["read", "prompt", "switch"] })
    const app = await pairApp({ name: "원격 팀 앱", scopes: ["read", "prompt", "switch"] })
    const admin = await pairApp({ name: "원격 팀 관리", scopes: ["read", "prompt", "switch", "admin"] })
    tokens.push(browser.token, app.token, admin.token)
    const host = state.host!
    const call = async (device: { post: typeof browser.post }, rpcID: string, method: string) => {
      const before = host.seen.length
      const response = await device.post(`/srv/${HOST_ID}/api/rpc/${rpcID}/${method}`, { input: { teamID: "tm_h" } })
      const reached = host.seen.slice(before).some((item) => item.path === `/api/rpc/${rpcID}/${method}`)
      return {
        status: response.status,
        reached,
        scope: response.ok ? null : ((await response.json()) as { data: { scope: string } }).data.scope,
      }
    }
    const devices = {
      browser: { device: browser, scopes: new Set(["read", "prompt", "switch"]) },
      app: { device: app, scopes: new Set(["read", "prompt", "switch"]) },
      admin: { device: admin, scopes: new Set(["read", "prompt", "switch", "admin"]) },
    }
    for (const [label, entry] of Object.entries(devices))
      for (const [method, scope] of Object.entries(OwnTeamRouting.MethodScope)) {
        const allowed = scope !== "local" && entry.scopes.has(scope)
        expect({ label, method, ...(await call(entry.device, OwnTeamRouting.ID, method)) }).toEqual({
          label,
          method,
          status: allowed ? 200 : 403,
          reached: allowed,
          scope: allowed ? null : scope,
        })
      }
    // Confirms, push and settings writes: 403 `local` even for an admin device; own.computer is not on a host.
    for (const method of ["op.confirm", "integration.push.plan", "integration.push.execute", "settings.set"])
      expect(await call(admin, OwnTeamRouting.ID, method)).toEqual({ status: 403, reached: false, scope: "local" })
    for (const method of ["status", "killswitch.engage"])
      expect(await call(admin, OwnComputer.ID, method)).toEqual({ status: 403, reached: false, scope: "remote" })
    expect(await call(admin, OwnTeamRouting.ID, "no.such.method")).toEqual({
      status: 403,
      reached: false,
      scope: "unknown",
    })
  }, 60_000)

  test("IG11 (gateway): own.import follows its table on this PC; local methods and every /srv/<hostId> call never reach a service; declared events reach the device", async () => {
    const browser = await pairDevice({ name: "가져오기 폰", scopes: ["read"] })
    const admin = await pairApp({ name: "가져오기 관리", scopes: ["read", "prompt", "switch", "admin"] })
    tokens.push(browser.token, admin.token)
    const call = async (device: { post: typeof browser.post }, serverKey: string, method: string) => {
      const target = serverKey === "local" ? state.local! : state.host!
      const before = target.seen.length
      const route = `/api/rpc/${OwnImportRouting.ID}/${method}`
      const response = await device.post(`/srv/${serverKey}${route}`, { input: {} })
      return {
        status: response.status,
        reached: target.seen.slice(before).some((item) => item.path === route),
        scope: response.ok ? null : ((await response.json()) as { data: { scope: string } }).data.scope,
      }
    }
    const devices = {
      browser: { device: browser, scopes: new Set(["read"]) },
      admin: { device: admin, scopes: new Set(["read", "prompt", "switch", "admin"]) },
    }
    for (const [label, entry] of Object.entries(devices))
      for (const [method, scope] of Object.entries(OwnImportRouting.MethodScope)) {
        const allowed = scope !== "local" && entry.scopes.has(scope)
        expect({ label, method, ...(await call(entry.device, "local", method)) }).toEqual({
          label,
          method,
          status: allowed ? 200 : 403,
          reached: allowed,
          scope: allowed ? null : scope,
        })
        // own.import is not on a remote host in v1 (09 §5.5).
        expect({ label, method, ...(await call(entry.device, HOST_ID, method)) }).toEqual({
          label,
          method,
          status: 403,
          reached: false,
          scope: "remote",
        })
      }
    expect(await call(admin, "local", "no.such.method")).toEqual({ status: 403, reached: false, scope: "unknown" })

    // The relayed event stream carries the events the table declares read, and nothing else of own.import.
    const local = state.local!
    const opened = local.streams.size
    const stream = await browser.get("/srv/local/api/event")
    const deadline = Date.now() + 5000
    while (local.streams.size <= opened && Date.now() < deadline) await Bun.sleep(20)
    const events = Object.entries(OwnImportRouting.EventScope)
    local.send("rpc.own.import.not.declared", { directories: ["/x"] })
    for (const [name] of events) local.send(`rpc.own.import.${name}`, {})
    const visible = events.filter(([, scope]) => scope === "read").map(([name]) => `"rpc.own.import.${name}"`)
    const received = await readEvents(stream, (text) => visible.every((type) => text.includes(type)))
    for (const type of visible) expect({ type, relayed: received.includes(type) }).toEqual({ type, relayed: true })
    for (const [name] of events.filter(([, scope]) => scope !== "read"))
      expect({ name, relayed: received.includes(`"rpc.own.import.${name}"`) }).toEqual({ name, relayed: false })
    expect(received).not.toContain("rpc.own.import.not.declared")
  }, 60_000)

  test("team.decision: a ready host's confirm reaches the feed with serverKey = hostId, and app devices like browsers", async () => {
    const browser = await pairDevice({ name: "결정 폰", scopes: ["read"] })
    const app = await pairApp({
      name: "결정 앱",
      scopes: ["read"],
      servers: { mode: "only", keys: ["local", HOST_ID] },
    })
    const localOnly = await pairApp({ name: "이 PC 앱", scopes: ["read"], servers: { mode: "only", keys: ["local"] } })
    tokens.push(browser.token, app.token, localOnly.token)
    const gateway = state.gateway!
    const host = state.host!
    const deadline = Date.now() + 10_000
    // The feed's own subscription to the host's events is open (its first stream on the fake host).
    while (host.streams.size < 1 && Date.now() < deadline) await Bun.sleep(50)
    expect(host.streams.size).toBe(1)
    // The relayed host stream shows its team's events to devices that may see the host, app or browser.
    const appStream = await app.get(`/srv/${HOST_ID}/api/event`)
    const browserStream = await browser.get(`/srv/${HOST_ID}/api/event`)
    expect((await localOnly.get(`/srv/${HOST_ID}/api/event`)).status).toBe(403)
    const confirm = {
      teamID: "tm_h",
      opID: "op_h",
      stepID: "s1",
      kind: "retire-remove",
      text: "/home/me/work/assets 폴더를 지웁니다",
      nonce: "n-secret",
    }
    // Both relayed streams are open (each has read its first frame) before the event is written.
    while (host.streams.size < 3 && Date.now() < deadline) await Bun.sleep(20)
    host.send("rpc.own.team.op.confirm", confirm)
    const [appText, browserText] = await Promise.all([
      readEvents(appStream, (text) => text.includes("rpc.own.team.op.confirm")),
      readEvents(browserStream, (text) => text.includes("rpc.own.team.op.confirm")),
    ])
    expect(appText).toContain("rpc.own.team.op.confirm")
    expect(browserText).toContain("rpc.own.team.op.confirm")
    // The feed: one item for the host's team, without the step's text, path or nonce.
    while (!gateway.feed.items().some((item) => item.kind === "team.decision") && Date.now() < deadline)
      await Bun.sleep(50)
    const item = gateway.feed.items().find((entry) => entry.kind === "team.decision")!
    expect(item).toMatchObject({ kind: "team.decision", severity: "warn", serverKey: HOST_ID })
    expect(JSON.stringify(item)).not.toMatch(/home\/me|assets|지웁니다|n-secret/)
    const listed = async (deviceId: string) =>
      (await gateway.feed.list({ deviceId })).items.some((entry) => entry.id === item.id)
    expect(await listed(browser.deviceId)).toBe(true)
    expect(await listed(app.deviceId)).toBe(true)
    expect(await listed(localOnly.deviceId)).toBe(false)
  }, 30_000)

  test("MG4: revoke closes the device's event stream and PTY socket within 5 s; other devices keep working", async () => {
    const victim = await pairDevice({ name: "잃어버린 폰", scopes: ["read", "prompt", "terminal"] })
    const other = await pairDevice({ name: "다른 폰", scopes: ["read", "prompt"] })
    tokens.push(victim.token, other.token)
    const stream = await victim.get("/srv/local/api/event")
    const reader = stream.body!.getReader()
    await reader.read()
    const otherStream = await other.get("/srv/local/api/event")
    const otherReader = otherStream.body!.getReader()
    await otherReader.read()
    const ws = new WebSocket(`${state.base!.replace("http", "ws")}/srv/local/api/pty/pty_1/connect?ticket=t1`, {
      headers: { cookie: victim.jar.header(), origin: state.base! },
    } as never)
    const hello = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => resolve(String(event.data))
      ws.onerror = () => reject(new Error("ws error"))
    })
    expect(hello).toBe("pty-hello from local")
    const closed = new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)))
    expect(state.gateway!.openConnections(victim.deviceId)).toBeGreaterThanOrEqual(2)
    const started = Date.now()
    const revoked = await state.gateway!.revoke(victim.deviceId)
    expect(revoked.ok).toBe(true)
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read().catch(() => ({ done: true }))
          if (next.done) return true
        }
      })(),
      Bun.sleep(5000).then(() => false),
    ])
    expect(ended).toBe(true)
    expect(await Promise.race([closed, Bun.sleep(5000).then(() => -1)])).not.toBe(-1)
    expect(Date.now() - started).toBeLessThan(5000)
    const after = await victim.get("/srv/local/api/session")
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ type: "device_revoked" })
    expect((await victim.get("/own/device")).status).toBe(401)
    // The other device and its stream are untouched.
    expect((await other.get("/srv/local/api/session")).status).toBe(200)
    expect(state.gateway!.openConnections(other.deviceId)).toBeGreaterThanOrEqual(1)
    await otherReader.cancel()
    // The PTY needs the terminal scope.
    const denied = await other.get("/srv/local/api/pty/pty_1/connect?ticket=t2", { headers: { upgrade: "websocket", origin: state.base! } })
    expect(denied.status).toBe(403)
  })

  test("MG8: OWN_HOME holds no plaintext device token or service password", async () => {
    await state.gateway!.audit.flush()
    await state.gateway!.devices.flush()
    expect(tokens.length).toBeGreaterThan(3)
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(state.ownHome!)
    expect(files.map((file) => path.relative(state.ownHome!, file)).sort()).toEqual(
      expect.arrayContaining(["devices.json", "gateway.json"]),
    )
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      for (const token of tokens) expect({ file, leaked: text.includes(token) }).toEqual({ file, leaked: false })
      expect({ file, leaked: text.includes(PASSWORD) }).toEqual({ file, leaked: false })
      expect({ file, leaked: text.includes(HOST_PASSWORD) }).toEqual({ file, leaked: false })
    }
  })

  test("disable closes the listener and forgets pairings; the settings file says off", async () => {
    const view = await state.gateway!.disable()
    expect(view).toMatchObject({ enabled: false, state: "off", url: null })
    expect(await fetch(`${state.base}/`).then(() => "up", () => "down")).toBe("down")
    expect(JSON.parse(fs.readFileSync(path.join(state.ownHome!, "gateway.json"), "utf8"))).toMatchObject({ enabled: false })
  })
})

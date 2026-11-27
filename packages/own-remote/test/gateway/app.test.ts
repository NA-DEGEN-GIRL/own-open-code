// The pinned-TLS app listener in process (08): identity in the vault, the native pairing flow over TLS with the app
// host name, browser pairing refused, `/own/routes`, Host rules (AA2), revocation on both listeners, computer use kept
// on the PC for app devices, its own pairing limiter, the plan validation of the app settings, and the 모바일 미리보기
// loopback link (08 §4.3). Unit parts: certificate, link, Tailscale TCP/lock parsing, portproxy parsing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { IncomingMessage } from "node:http"
import type { TLSSocket } from "node:tls"
import { OwnAccounts } from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { ServiceTarget, Vault } from "@own/runtime"
import { GatewayConfig } from "../../src/gateway/config.js"
import { appLink, Gateway } from "../../src/gateway/gateway.js"
import { PortProxy } from "../../src/gateway/portproxy.js"
import { summarizeAgent } from "../../src/gateway/server.js"
import { Tailscale } from "../../src/gateway/tailscale.js"
import { AppTls } from "../../src/gateway/tls.js"
import { Log } from "../../src/log.js"
import type { OwnRemote } from "../../src/protocol/rpc-remote.js"

const PASSWORD = "svc-password-fake-app-0123456789"
const ANDROID_UA = "OwnOpenCodeApp/1 (android) Android/15"
/** own-desktop's 모바일 미리보기 (08 §4.3, remote-pcs/emulation.ts): the Android app's token plus its own. */
const PREVIEW_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 OwnOpenCodeApp/1 (android) OwnPreview/1"

describe("certificate", () => {
  test("self-signed P-256 for <pcKey>.ownpc.internal, pinned by its public key", () => {
    const identity = AppTls.create(Date.UTC(2026, 9, 1))
    const cert = new crypto.X509Certificate(identity.certPem)
    expect(identity.pcKey).toMatch(AppTls.PC_KEY_PATTERN)
    expect(cert.subjectAltName).toBe(`DNS:${identity.pcKey}.ownpc.internal`)
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.ca).toBe(false)
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2036)
    expect(identity.pin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(AppTls.pinOfCertificate(identity.certPem)).toBe(identity.pin)
    expect(crypto.createPrivateKey(identity.keyPem).asymmetricKeyType).toBe("ec")
  })

  test("stored once in the vault and read back unchanged", async () => {
    const transport = Vault.memory()
    const first = await AppTls.loadOrCreate(new Vault.Client(transport))
    const second = await AppTls.loadOrCreate(new Vault.Client(transport))
    if (!first.ok || !second.ok) throw new Error("vault")
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.identity).toEqual(first.identity)
  })

  test("an unreachable vault is reported, never a key on disk", async () => {
    const broken: Vault.Transport = { request: () => Promise.reject(new Error("down")), close: async () => {} }
    expect(await AppTls.loadOrCreate(new Vault.Client(broken))).toEqual({ ok: false, problem: "vault_unavailable" })
  })
})

describe("settings and detection", () => {
  test("direct host: DNS names and addresses, nothing with a scheme or path", () => {
    expect(GatewayConfig.checkDirectHost("MyHome.DDNS.net.")).toBe("myhome.ddns.net")
    expect(GatewayConfig.checkDirectHost("203.0.113.7")).toBe("203.0.113.7")
    expect(GatewayConfig.checkDirectHost("2001:db8::1")).toBe("[2001:db8::1]")
    expect(GatewayConfig.checkDirectHost("[2001:db8::1]")).toBe("[2001:db8::1]")
    for (const bad of ["https://myhome.ddns.net", "myhome.ddns.net:28541", "myhome", "a/b.net", "-x.net", ""])
      expect(GatewayConfig.checkDirectHost(bad)).toBeUndefined()
  })

  test("tailscale serve TCP forwards and Tailnet Lock", () => {
    const serve = JSON.stringify({ TCP: { "28540": { TCPForward: "localhost:28540" }, "443": { HTTPS: true } }, Web: {} })
    const tcp = Tailscale.parseTcp(serve)
    expect(tcp).toEqual([{ port: 28540, target: "localhost:28540" }])
    // A handler of another shape is skipped on its own; the forward next to it still counts.
    const odd = JSON.stringify({ TCP: { "28540": { TCPForward: "localhost:28540" }, "22": "x", "80": { TCPForward: 80 } } })
    expect(Tailscale.parseTcp(odd)).toEqual([{ port: 28540, target: "localhost:28540" }])
    const detection = { state: "running" as const, version: "1.90.0", dnsName: "pc.tail.ts.net", proxies: [], tcp, lock: "on" as const }
    expect(Tailscale.forwardsApp(detection, 28540)).toBe(true)
    expect(Tailscale.forwardsApp(detection, 28999)).toBe(false)
    expect(Tailscale.forwardsApp({ ...detection, tcp: null }, 28540)).toBeNull()
    expect(Tailscale.parseLock('{"Enabled":true,"PublicKey":"tlpub:x"}')).toBe("on")
    expect(Tailscale.parseLock('{"Enabled":false}')).toBe("off")
    expect(Tailscale.parseLock("not json")).toBeNull()
    expect(Tailscale.tcpServeCommand(28540)).toBe("tailscale serve --bg --tcp=28540 tcp://localhost:28540")
    expect(Tailscale.view(detection, 28539, 28540)).toMatchObject({ lock: "on", appServing: true })
  })

  test("portproxy rules from netsh, with localized headers", () => {
    const text = [
      "",
      "ipv4 수신 대기:             ipv4에 연결:",
      "",
      "주소            포트        주소            포트",
      "--------------- ----------  --------------- ----------",
      "0.0.0.0         28541       127.0.0.1       28540",
      "",
    ].join("\r\n")
    const rules = PortProxy.parse(text)
    expect(rules).toEqual([{ listenAddress: "0.0.0.0", listenPort: 28541, connectAddress: "127.0.0.1", connectPort: 28540 }])
    expect(PortProxy.forwards(rules, 28541, 28540)).toBe(true)
    expect(PortProxy.forwards(rules, 28541, 28999)).toBe(false)
    expect(PortProxy.setupCommands(28541, 28540)[0]).toBe(
      "netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=28541 connectaddress=127.0.0.1 connectport=28540",
    )
    expect(PortProxy.setupCommands(28541, 28540)[1]).toBe(
      'New-NetFirewallRule -DisplayName "Own OpenCode app access (TCP 28541)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 28541 -Profile Private',
    )
    expect(PortProxy.removeCommands(28541)[1]).toBe('Remove-NetFirewallRule -DisplayName "Own OpenCode app access (TCP 28541)"')
  })

  test("pairing link: percent-encoded, routes in order", () => {
    const link = appLink(
      { pcKey: "abcdefghijk2", pin: "P".repeat(43), name: "My PC", routes: ["pc.tail.ts.net:28540", "[::1]:28541"] },
      "code_-123",
    )
    expect(link).toBe(
      `ownpc://pair?v=1&k=abcdefghijk2&p=${"P".repeat(43)}&c=code_-123&n=My%20PC&r=pc.tail.ts.net%3A28540&r=%5B%3A%3A1%5D%3A28541`,
    )
    const parsed = new URL(link)
    expect(parsed.searchParams.getAll("r")).toEqual(["pc.tail.ts.net:28540", "[::1]:28541"])
  })

  test("device summary names our apps", () => {
    expect(summarizeAgent(ANDROID_UA)).toBe("Own 앱 · Android")
    expect(summarizeAgent(PREVIEW_UA)).toBe("Own 모바일 미리보기 · Windows")
    expect(summarizeAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/140 Electron/38 OwnOpenCodeApp/1 (desktop)")).toBe(
      "Own 데스크톱 앱 · Windows",
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// In process

const state: {
  root?: string
  gateway?: Gateway
  local?: ReturnType<typeof Bun.serve>
  base?: string
  appPort?: number
  pcKey?: string
  pin?: string
  seen: string[]
  /** The suite gateway's log lines (own-remote.log on an installed PC). */
  lines: string[]
} = { seen: [], lines: [] }

async function freePort() {
  return new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

interface AppResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
  readonly pin: string
}

interface AppInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly host?: string
  /** Another gateway's app listener (default: the suite's). */
  readonly port?: number
  readonly pcKey?: string
}

/** What an app does: TLS to the app listener with the app host as SNI and Host, the certificate checked by pin only. */
function appRequest(route: string, init: AppInit = {}): Promise<AppResponse> {
  const host = init.host ?? AppTls.hostOf(init.pcKey ?? state.pcKey!)
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: init.port ?? state.appPort,
        path: route,
        method: init.method ?? "GET",
        servername: host,
        rejectUnauthorized: false,
        headers: { host, "user-agent": ANDROID_UA, ...init.headers },
      },
      (response) => {
        const socket = response.socket as TLSSocket
        const spki = socket.getPeerX509Certificate()!.publicKey.export({ type: "spki", format: "der" })
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => (body += chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body, pin: AppTls.pinOfSpki(spki) }),
        )
      },
    )
    request.on("error", reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}

beforeAll(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "own-gw-app-"))
  const ownHome = path.join(state.root, "own-home")
  fs.mkdirSync(ownHome, { recursive: true })
  const web = path.join(state.root, "web")
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(web, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  state.local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      state.seen.push(url.pathname)
      if (req.headers.get("authorization") !== ServiceTarget.basic(PASSWORD)) return new Response("no", { status: 401 })
      // A session the PC turned computer use on for (a device may not fork it).
      if (url.pathname === "/api/session/ses_pc")
        return Response.json({ data: { id: "ses_pc", permissions: [{ action: "computer", resource: "*", effect: "allow" }] } })
      // An event stream that stays open: a device's open connection until it is revoked.
      if (url.pathname === "/api/event")
        return new Response(
          new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": hello\n\n")) }),
          { headers: { "content-type": "text/event-stream" } },
        )
      // Where device writes may land (`fs.write`).
      if (url.pathname === "/api/info")
        return Response.json({ version: "local", pid: 1, urls: [], paths: { tmp: path.join(state.root!, "srv-tmp") } })
      return Response.json({ data: { path: url.pathname } })
    },
  })
  const registration = path.join(state.root, "service-own.json")
  fs.writeFileSync(
    registration,
    JSON.stringify({ id: "x", version: "local", url: `http://127.0.0.1:${state.local.port}`, pid: process.pid, password: PASSWORD }),
  )
  const controller = { list: () => ({ revision: 1, hosts: [] }), resolve: async () => ({ url: null, stage: "disconnected" }) }
  state.gateway = new Gateway({
    buildId: `gw-app-test-${process.pid}`,
    ownHome,
    channel: "own",
    options: {
      registration,
      webRoot: web,
      tailscaleCommand: null,
      portproxyCommand: null,
      vault: "memory",
      appLoopbackRoute: true,
      auditIntervalMs: 60_000,
    },
    log: Log.create({ scope: "own.remote.gateway", sink: (line) => state.lines.push(line) }),
    pin: async () => ({ controller: controller as never, release: async () => {} }),
  })
  state.gateway.useController(() => controller as never)
  const port = await freePort()
  const appPort = await freePort()
  const plan = await state.gateway.plan({
    port,
    app: { enabled: true, port: appPort, directHost: "myhome.ddns.net", directPort: 28541 },
  })
  if (!plan.ok) throw new Error(JSON.stringify(plan))
  const executed = await state.gateway.execute(plan.value.nonce)
  if (!executed.ok) throw new Error(JSON.stringify(executed))
  state.base = executed.value.url!
  state.appPort = state.gateway.appPort
  state.pcKey = executed.value.app!.pcKey!
  state.pin = executed.value.app!.pin!
})

afterAll(async () => {
  await state.gateway?.close()
  state.local?.stop(true)
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true })
})

async function pairApp(name: string, scopes: ReadonlyArray<OwnRemote.DeviceScope> = ["read", "prompt"]) {
  const gateway = state.gateway!
  const started = await gateway.pairStart({ name, scopes: [...scopes], servers: { mode: "all" }, expiresDays: 30 })
  if (!started.ok) throw new Error(JSON.stringify(started))
  const link = new URL(started.value.appLink!)
  const code = link.searchParams.get("c")!
  // A client-sent Tailscale identity is never believed on the app listener (no `tailscale serve --https` in front).
  const opened = await appRequest(`/auth/connect/${code}`, {
    headers: { accept: "application/json", "tailscale-user-login": "forged@example.com" },
  })
  expect(opened.status).toBe(200)
  expect(opened.pin).toBe(link.searchParams.get("p")!)
  const { claim, sas } = JSON.parse(opened.body) as { claim: string; sas: string }
  const pending = JSON.parse((await appRequest("/own/pairing", { headers: { "x-own-pairing": claim } })).body)
  expect(pending).toMatchObject({ state: "pending", sas })
  const listed = await gateway.list()
  expect(listed.pairings.find((pairing) => pairing.pairingId === started.value.pairingId)).toMatchObject({
    userAgent: "Own 앱 · Android",
    tailscaleUser: null,
  })
  expect(gateway.approve(started.value.pairingId, sas).ok).toBe(true)
  const claimed = await appRequest("/own/pairing/claim", {
    method: "POST",
    headers: { "x-own-pairing": claim, "content-type": "application/json" },
    body: "{}",
  })
  expect(claimed.status).toBe(200)
  return JSON.parse(claimed.body) as { deviceId: string; token: string; expiresAt: number }
}

describe("app listener", () => {
  test("listens on loopback with the vault identity; the view shows routes and commands", async () => {
    const view = await state.gateway!.status()
    expect(view.app).toMatchObject({
      enabled: true,
      state: "listening",
      problem: null,
      port: state.appPort,
      routes: [
        { kind: "direct", address: "myhome.ddns.net:28541", ready: null },
        { kind: "direct", address: `127.0.0.1:${state.appPort}`, ready: true },
      ],
      tailnetCommand: `tailscale serve --bg --tcp=${state.appPort} tcp://localhost:${state.appPort}`,
      direct: { host: "myhome.ddns.net", port: 28541, portproxy: null },
    })
    expect(view.app!.direct.setupCommands).toEqual(PortProxy.setupCommands(28541, state.appPort!))
    const peer = await appRequest("/")
    expect(peer.pin).toBe(state.pin!)
    expect(peer.status).toBe(200)
  })

  test("AA2: another Host name is refused before anything else", async () => {
    expect((await appRequest("/", { host: "myhome.ddns.net:28541" })).status).toBe(421)
    expect((await appRequest("/own/device", { host: "evil.example" })).status).toBe(421)
  })

  test("AA3: native pairing gives an app device; the link carries code, pin and routes", async () => {
    const started = await state.gateway!.pairStart({ name: "폰", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 })
    if (!started.ok) throw new Error("pair")
    const link = new URL(started.value.appLink!)
    expect(link.protocol).toBe("ownpc:")
    expect(link.searchParams.get("k")).toBe(state.pcKey!)
    expect(link.searchParams.get("p")).toBe(state.pin!)
    expect(link.searchParams.getAll("r")).toEqual(["myhome.ddns.net:28541", `127.0.0.1:${state.appPort}`])
    state.gateway!.cancel(started.value.pairingId)

    const device = await pairApp("내 폰")
    const devices = (await state.gateway!.list()).devices
    expect(devices.find((item) => item.deviceId === device.deviceId)).toMatchObject({ kind: "app", userAgent: "Own 앱 · Android" })
    const me = await appRequest("/own/device", { headers: { cookie: `own_device=${device.token}` } })
    expect(me.status).toBe(200)
    // The service PC's name, for the notices that tell a device where to confirm (06 §9.8).
    expect(JSON.parse(me.body)).toMatchObject({ deviceId: device.deviceId, kind: "app", pc: os.hostname() })
    const relayed = await appRequest("/srv/local/api/session", { headers: { authorization: `Bearer ${device.token}` } })
    expect(relayed.status).toBe(200)
    expect(state.seen).toContain("/api/session")
  })

  test("AA3: browser-style pairing is refused on the app listener", async () => {
    const started = await state.gateway!.pairStart({ name: "browser", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 })
    if (!started.ok) throw new Error("pair")
    const code = new URL(started.value.appLink!).searchParams.get("c")!
    const page = await appRequest(`/auth/connect/${code}`)
    expect(page.status).toBe(403)
    expect(page.headers["set-cookie"]).toBeUndefined()
    // The code was not consumed: the browser link on the plain listener still works.
    const browser = await fetch(new URL(started.value.url), { redirect: "manual" })
    expect(browser.status).toBe(302)
    const pairing = browser.headers.getSetCookie().find((line) => line.startsWith("own_pairing="))!.split(";")[0]!
    const claim = await appRequest("/own/pairing/claim", {
      method: "POST",
      headers: { cookie: pairing, origin: `https://${AppTls.hostOf(state.pcKey!)}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(claim.status).toBe(403)
    state.gateway!.cancel((await state.gateway!.list()).pairings[0]!.pairingId)
  })

  test("AA4: /own/routes for a paired app; 401 without a device", async () => {
    const device = await pairApp("routes")
    const routes = await appRequest("/own/routes", { headers: { authorization: `Bearer ${device.token}` } })
    expect(routes.status).toBe(200)
    expect(JSON.parse(routes.body)).toEqual({
      pcKey: state.pcKey,
      pin: state.pin,
      name: os.hostname(),
      routes: ["myhome.ddns.net:28541", `127.0.0.1:${state.appPort}`],
    })
    expect((await appRequest("/own/routes")).status).toBe(401)
    // The plain listener has no routes endpoint (it is not an app's origin): the path is an own-web page there.
    const plain = await fetch(`${state.base}/own/routes`, { headers: { authorization: `Bearer ${device.token}` } })
    expect(plain.headers.get("content-type") ?? "").not.toContain("application/json")
  })

  test("revocation reaches app devices", async () => {
    const device = await pairApp("lost phone")
    expect((await state.gateway!.revoke(device.deviceId)).ok).toBe(true)
    const after = await appRequest("/own/device", { headers: { authorization: `Bearer ${device.token}` } })
    expect(after.status).toBe(401)
    expect(JSON.parse(after.body).type).toBe("device_revoked")
  })

  test("an app removing this PC revokes its own device", async () => {
    const device = await pairApp("removed from the app")
    const forget = await appRequest("/own/device/revoke", { method: "POST", headers: { authorization: `Bearer ${device.token}` } })
    expect(forget.status).toBe(200)
    expect(JSON.parse(forget.body)).toEqual({ deviceId: device.deviceId, revoked: true })
    const listed = (await state.gateway!.list()).devices.find((item) => item.deviceId === device.deviceId)
    expect(listed?.state).toBe("revoked")
    expect((await appRequest("/own/device", { headers: { authorization: `Bearer ${device.token}` } })).status).toBe(401)
    // A cookie request from another origin cannot revoke a device (CSRF).
    const other = await pairApp("cookie device")
    const crossSite = await appRequest("/own/device/revoke", {
      method: "POST",
      headers: { cookie: `own_device=${other.token}`, origin: "https://evil.example" },
    })
    expect(crossSite.status).toBe(403)
    expect((await state.gateway!.list()).devices.find((item) => item.deviceId === other.deviceId)?.state).toBe("active")
  })

  test("computer use stays on this PC for app devices too (01 §10.2, 05 §13.4)", async () => {
    const device = await pairApp("every scope", ["read", "prompt", "switch", "files", "terminal", "admin"])
    const post = async (route: string, body: unknown) => {
      const before = state.seen.length
      const response = await appRequest(`/srv/local${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return { status: response.status, reached: state.seen.slice(before).includes(route) }
    }
    // own.computer: the status and Stop only.
    for (const method of Object.keys(OwnComputer.MethodScope)) {
      const allowed = method === "status" || method === "killswitch.engage"
      const result = await post(`/api/rpc/${OwnComputer.ID}/${method}`, { input: {} })
      expect({ method, ...result }).toEqual({ method, status: allowed ? 200 : 403, reached: allowed })
    }
    // Turning it on for a session, and sessions whose rules allow it: created, imported or forked.
    const on = { input: { sessionID: "ses_1", mode: "ask", computerUse: "on" } }
    expect(await post(`/api/rpc/${OwnAccounts.ID}/session.approval.set`, on)).toEqual({ status: 403, reached: false })
    const allow = [{ action: "computer", resource: "*", effect: "allow" }]
    expect(await post("/api/session", { permissions: allow })).toEqual({ status: 403, reached: false })
    expect(await post("/api/experimental/session/import", { info: { permissions: allow } })).toEqual({ status: 403, reached: false })
    expect(await post("/api/session/ses_pc/fork", {})).toEqual({ status: 403, reached: false })
    expect(await post("/api/session", { parentID: "ses_pc" })).toEqual({ status: 403, reached: false })
    expect(await post("/api/session/ses_1/fork", {})).toEqual({ status: 200, reached: true })
    expect(await post("/api/session", { title: "plain" })).toEqual({ status: 200, reached: true })
    // Nor any rules of its own beyond the browser deny: the mode follows through session.approval.set (RL5-4).
    const browserDeny = [{ action: "browser", resource: "*", effect: "deny" }]
    expect(await post("/api/session", { permissions: browserDeny })).toEqual({ status: 200, reached: true })
    const edit = [{ action: "edit", resource: "*", effect: "allow" }]
    expect(await post("/api/session", { permissions: edit })).toEqual({ status: 403, reached: false })
    // Granting an app in `question` approval: the allow answer stays on the PC; other answers pass.
    const reply = "/api/session/ses_1/form/frm_1/reply"
    expect(await post(reply, { answer: { q0: OwnComputer.ALLOW_ANSWER } })).toEqual({ status: 403, reached: false })
    expect(await post(reply, { answer: { q0: "거부 · Deny" } })).toEqual({ status: 200, reached: true })
  })

  test("a device writes files only into the server's temp folder (05 §13.5)", async () => {
    const device = await pairApp("files", ["read", "prompt", "files"])
    const tmp = path.join(state.root!, "srv-tmp")
    const write = async (target: string) => {
      const before = state.seen.length
      const query = new URLSearchParams({ "location[directory]": state.root!, path: target })
      const response = await appRequest(`/srv/local/api/experimental/fs/write?${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.token}`, "content-type": "application/octet-stream" },
        body: "data",
      })
      const reached = state.seen.slice(before).includes("/api/experimental/fs/write")
      return { status: response.status, reached }
    }
    expect(await write(`${tmp}/uploads/u1/photo.png`)).toEqual({ status: 200, reached: true })
    // An absolute path elsewhere (a Startup folder), climbing out with `..`, relative to the Location.
    const startup = path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs")
    expect(await write(path.join(startup, "Startup", "run.cmd"))).toEqual({ status: 403, reached: false })
    expect(await write(`${tmp}/../evil.cmd`)).toEqual({ status: 403, reached: false })
    expect(await write(".git/hooks/pre-commit")).toEqual({ status: 403, reached: false })
  })

  test("no key or token in OWN_HOME files", async () => {
    // The previous test's device touch may still be writing devices.json: its atomic write's temp file can vanish
    // between the listing and the stat, and its content is checked in the file it becomes.
    const files = (fs.readdirSync(path.join(state.root!, "own-home"), { recursive: true }) as string[]).filter(
      (file) => !file.endsWith(".tmp"),
    )
    for (const file of files) {
      const full = path.join(state.root!, "own-home", file)
      if (!fs.statSync(full).isFile()) continue
      const text = fs.readFileSync(full, "utf8")
      expect(text).not.toContain("PRIVATE KEY")
    }
    const settings = JSON.parse(fs.readFileSync(path.join(state.root!, "own-home", "gateway.json"), "utf8"))
    expect(settings.app).toEqual({ enabled: true, port: state.appPort, directHost: "myhome.ddns.net", directPort: 28541 })
  })

  test("pairing steps reach the log from both listeners, without the code, the claim, the SAS or the token", async () => {
    const from = state.lines.length
    const device = await pairApp("logged")
    const started = await state.gateway!.pairStart({ name: "browser log", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 })
    if (!started.ok) throw new Error("pair")
    const code = new URL(started.value.url).pathname.split("/").at(-1)!
    const browser = await fetch(new URL(started.value.url), { redirect: "manual" })
    expect(browser.status).toBe(302)
    const claim = browser.headers.getSetCookie().find((line) => line.startsWith("own_pairing="))!.split(";")[0]!.slice(12)
    const sas = (await state.gateway!.list()).pairings.find((pairing) => pairing.pairingId === started.value.pairingId)!.sas!
    state.gateway!.cancel(started.value.pairingId)
    // An ended pairing's poll and claim: one line each (anyone can send these).
    for (let i = 0; i < 3; i++) await appRequest("/own/pairing", { headers: { "x-own-pairing": claim } })
    await appRequest("/own/pairing/claim", { method: "POST", headers: { "x-own-pairing": claim }, body: "{}" })

    const text = state.lines.slice(from).filter((line) => line.includes('"msg":"pairing_'))
    const steps = text.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(steps.map((line) => `${line.scope} ${line.msg}`)).toEqual([
      "own.remote.gateway.app pairing_opened",
      "own.remote.gateway.pairing pairing_approved",
      "own.remote.gateway.pairing pairing_ended",
      "own.remote.gateway.app pairing_claimed",
      "own.remote.gateway.http pairing_opened",
      "own.remote.gateway.pairing pairing_ended",
      "own.remote.gateway.app pairing_poll_ended",
      "own.remote.gateway.app pairing_claim_failed",
    ])
    expect(steps[0]).toMatchObject({ agent: "Own 앱 · Android", via: "json" })
    expect(steps[2]).toMatchObject({ reason: "claimed", from: "approved" })
    expect(steps[3]).toMatchObject({ deviceId: device.deviceId, kind: "app" })
    expect(steps[4]).toMatchObject({ pairingId: started.value.pairingId, via: "page" })
    expect(steps[5]).toMatchObject({ pairingId: started.value.pairingId, reason: "rejected", from: "pending" })
    expect(steps[6]).toMatchObject({ state: "rejected" })
    expect(steps[7]).toMatchObject({ reason: "not_approved", state: "rejected" })
    for (const line of text) {
      expect(line).not.toContain(device.token)
      expect(line).not.toContain(code)
      expect(line).not.toContain(claim)
      expect(line).not.toContain("127.0.0.1")
    }
    for (const line of steps) expect(Object.keys(line).filter((key) => ["sas", "claim", "code", "token", "ip"].includes(key))).toEqual([])
    expect(text.some((line) => line.includes(`"${sas}"`))).toBe(false)
  })

  // Last test that pairs over the app listener: it leaves 127.0.0.1 blocked there for a minute.
  test("a scanner on the app listener does not block browser pairing (08 §2)", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++)
      statuses.push(
        (await appRequest(`/auth/connect/AAAAAAAAAAAAAAAAAAAAA${i}`, { headers: { accept: "application/json" } })).status,
      )
    expect(statuses).toEqual([410, 410, 410, 410, 410, 429])
    // One line per reason a minute, however many tries.
    const refused = state.lines.filter((line) => line.includes('"msg":"pairing_open_refused"') && line.includes('"scope":"own.remote.gateway.app"'))
    expect(refused.filter((line) => line.includes('"reason":"expired_or_used"'))).toHaveLength(1)
    expect(refused.filter((line) => line.includes('"reason":"rate_limited"'))).toHaveLength(1)
    // The browser listener sees the same 127.0.0.1 peer (no forwarded address) and still answers.
    const browser = await fetch(`${state.base}/auth/connect/AAAAAAAAAAAAAAAAAAAAAZ`, { headers: { accept: "application/json" } })
    expect(browser.status).toBe(410)
  })
})

describe("plan validation", () => {
  test("ports must differ; the direct host must be a name or address", async () => {
    const gateway = state.gateway!
    const view = await gateway.status()
    const same = await gateway.plan({ app: { enabled: true, port: view.port! } })
    expect(same).toMatchObject({ ok: false, error: "input_invalid", data: { field: "app.port" } })
    const direct = await gateway.plan({ app: { enabled: true, directPort: state.appPort! } })
    expect(direct).toMatchObject({ ok: false, error: "input_invalid", data: { field: "app.directPort" } })
    const host = await gateway.plan({ app: { enabled: true, directHost: "https://x.example" } })
    expect(host).toMatchObject({ ok: false, error: "input_invalid", data: { field: "app.directHost" } })
    const fine = await gateway.plan({ app: { enabled: true, directHost: "other.ddns.net" } })
    expect(fine.ok).toBe(true)
  })

  test("turning app access off closes only the app listener", async () => {
    const gateway = state.gateway!
    const plan = await gateway.plan({ app: { enabled: false } })
    if (!plan.ok) throw new Error(JSON.stringify(plan))
    const view = await gateway.execute(plan.value.nonce)
    if (!view.ok) throw new Error(JSON.stringify(view))
    expect(view.value.state).toBe("listening")
    expect(view.value.app).toMatchObject({ enabled: false, state: "off", routes: [] })
    expect(gateway.appPort).toBeUndefined()
    const started = await gateway.pairStart({ name: "x", scopes: ["read"], servers: { mode: "all" }, expiresDays: 1 })
    expect(started.ok && started.value.appLink).toBeNull()
    // 08 §4.3: no app listener, no 모바일 미리보기 link either (own-web then reports no_link).
    const loopback = await gateway.pairStart({
      name: "x",
      scopes: ["read"],
      servers: { mode: "all" },
      expiresDays: 1,
      appRoute: "loopback",
    })
    expect(loopback.ok && loopback.value.appLink).toBeNull()
  })
})

// Last: its gateway takes the listeners over from the suite's (another build in this process, 05 §13.4).
describe("모바일 미리보기 link (08 §4.3)", () => {
  const preview: { gateway?: Gateway; appPort?: number; pcKey?: string; pin?: string } = {}

  beforeAll(async () => {
    const ownHome = path.join(state.root!, "own-home-preview")
    fs.mkdirSync(ownHome, { recursive: true })
    const controller = { list: () => ({ revision: 1, hosts: [] }), resolve: async () => ({ url: null, stage: "disconnected" }) }
    // No tailnet, no direct route and no test route: the configured link has nothing to offer.
    preview.gateway = new Gateway({
      buildId: `gw-app-preview-${process.pid}`,
      ownHome,
      channel: "own",
      options: {
        registration: path.join(state.root!, "service-own.json"),
        webRoot: path.join(state.root!, "web"),
        tailscaleCommand: null,
        portproxyCommand: null,
        vault: "memory",
        auditIntervalMs: 60_000,
      },
      log: Log.silent,
      pin: async () => ({ controller: controller as never, release: async () => {} }),
    })
    preview.gateway.useController(() => controller as never)
    const plan = await preview.gateway.plan({ port: await freePort(), app: { enabled: true, port: await freePort() } })
    if (!plan.ok) throw new Error(JSON.stringify(plan))
    const executed = await preview.gateway.execute(plan.value.nonce)
    if (!executed.ok) throw new Error(JSON.stringify(executed))
    preview.appPort = preview.gateway.appPort
    preview.pcKey = executed.value.app!.pcKey!
    preview.pin = executed.value.app!.pin!
  })

  afterAll(async () => {
    await preview.gateway?.close()
  })

  const start = (appRoute?: "configured" | "loopback") =>
    preview.gateway!.pairStart({
      name: "모바일 미리보기 (이 PC)",
      scopes: ["read", "prompt", "switch"],
      servers: { mode: "all" },
      expiresDays: 7,
      ...(appRoute ? { appRoute } : {}),
    })

  test("the loopback link carries exactly this PC's app listener; the configured link is unchanged", async () => {
    const loopback = await start("loopback")
    if (!loopback.ok) throw new Error(JSON.stringify(loopback))
    const link = new URL(loopback.value.appLink!)
    expect(link.searchParams.get("k")).toBe(preview.pcKey!)
    expect(link.searchParams.get("p")).toBe(preview.pin!)
    expect(link.searchParams.getAll("r")).toEqual([`127.0.0.1:${preview.appPort}`])
    // The browser link of the same pairing stays the plain listener's.
    expect(loopback.value.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/connect\/[A-Za-z0-9_-]{22}$/)
    for (const appRoute of [undefined, "configured"] as const) {
      const configured = await start(appRoute)
      expect(configured.ok && configured.value.appLink).toBeNull()
    }
    // The route is offered nowhere else.
    expect((await preview.gateway!.status()).app!.routes).toEqual([])
    for (const pairing of (await preview.gateway!.list()).pairings) preview.gateway!.cancel(pairing.pairingId)
  })

  test("a preview pairs and claims as an app device under the PC's name; revoking closes its streams", async () => {
    const at = { port: preview.appPort!, pcKey: preview.pcKey! }
    const started = await start("loopback")
    if (!started.ok) throw new Error(JSON.stringify(started))
    const code = new URL(started.value.appLink!).searchParams.get("c")!
    const opened = await appRequest(`/auth/connect/${code}`, {
      ...at,
      headers: { accept: "application/json", "user-agent": PREVIEW_UA },
    })
    expect(opened.status).toBe(200)
    expect(opened.pin).toBe(preview.pin!)
    const { claim, sas, name } = JSON.parse(opened.body) as { claim: string; sas: string; name: string }
    expect(name).toBe("모바일 미리보기 (이 PC)")
    const pairing = (await preview.gateway!.list()).pairings.find((item) => item.pairingId === started.value.pairingId)
    expect(pairing).toMatchObject({ state: "pending", userAgent: "Own 모바일 미리보기 · Windows", tailscaleUser: null })
    // The PC's own [허용]: nothing approves a preview by itself.
    expect(preview.gateway!.approve(started.value.pairingId, sas).ok).toBe(true)
    const claimed = await appRequest("/own/pairing/claim", {
      ...at,
      method: "POST",
      headers: { "x-own-pairing": claim, "content-type": "application/json", "user-agent": PREVIEW_UA },
      body: "{}",
    })
    expect(claimed.status).toBe(200)
    const device = JSON.parse(claimed.body) as { deviceId: string; token: string }
    expect((await preview.gateway!.list()).devices.find((item) => item.deviceId === device.deviceId)).toMatchObject({
      kind: "app",
      name: "모바일 미리보기 (이 PC)",
      userAgent: "Own 모바일 미리보기 · Windows",
    })
    // `/own/routes` lists the configured routes only (none here), never the preview's loopback route.
    const routes = await appRequest("/own/routes", { ...at, headers: { authorization: `Bearer ${device.token}` } })
    expect(JSON.parse(routes.body)).toMatchObject({ pcKey: preview.pcKey, pin: preview.pin, routes: [] })

    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.request({
        host: "127.0.0.1",
        port: at.port,
        path: "/srv/local/api/event",
        servername: AppTls.hostOf(at.pcKey),
        rejectUnauthorized: false,
        headers: { host: AppTls.hostOf(at.pcKey), authorization: `Bearer ${device.token}`, "user-agent": PREVIEW_UA },
      })
      request.on("response", resolve)
      request.on("error", reject)
      request.end()
    })
    expect(stream.statusCode).toBe(200)
    const ended = new Promise<boolean>((resolve) => {
      stream.on("close", () => resolve(true))
      stream.on("error", () => resolve(true))
      stream.resume()
    })
    expect(preview.gateway!.openConnections(device.deviceId)).toBeGreaterThanOrEqual(1)
    expect((await preview.gateway!.revoke(device.deviceId)).ok).toBe(true)
    expect(await Promise.race([ended, Bun.sleep(5_000).then(() => false)])).toBe(true)
    expect(preview.gateway!.openConnections(device.deviceId)).toBe(0)
    const after = await appRequest("/own/device", { ...at, headers: { authorization: `Bearer ${device.token}` } })
    expect(after.status).toBe(401)
  })
})

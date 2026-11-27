// 원격 PC (08 §3–4.1) without Electron: the pairing link, the pin, the CONNECT proxy and its route failover, the
// store, and the native pairing + route refresh against a pinned TLS gateway stand-in reached through the proxy.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { awaitApproval, claimDevice, fetchRoutes, openPairing, revokeDevice } from "../src/main/remote-pcs/pairing"
import { ACCEPT, certificateVerdict, REJECT, spkiPin } from "../src/main/remote-pcs/pin"
import { connectTarget, createConnectProxy, orderRoutes, type ProxyRoutes } from "../src/main/remote-pcs/proxy"
import {
  keyChanged,
  loadRemotePcs,
  partitionName,
  purgeRemovedPartitions,
  REMOVED_MARK,
  saveRemotePcs,
  type RemotePcRecord,
} from "../src/main/remote-pcs/store"
import { appHost, appOrigin, parsePairingLink, parseRoute, pcKeyOfHost } from "../src/shared/remote-pc"
import { selfSigned } from "./helpers/cert"
import { closedPort, pinnedTransport, standInGateway, type GatewayScript } from "./helpers/gateway"

const KEY = "abcdefghij23"
const PIN = "A".repeat(43)
const CODE = "Q2xhaW1Db2RlXzEyMzQ1Ng"

function link(params: Record<string, string | string[]>) {
  const query = Object.entries(params)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${key}=${encodeURIComponent(item)}`),
    )
    .join("&")
  return `ownpc://pair?${query}`
}

const valid = { v: "1", k: KEY, p: PIN, c: CODE, n: "집 PC", r: ["pc.tail1234.ts.net:28540", "myhome.ddns.net:28541"] }

describe("pairing link (08 §3.3)", () => {
  test("a gateway link parses, in route order", () => {
    const parsed = parsePairingLink(`  ${link(valid)}\n`)
    expect(parsed).toEqual({
      ok: true,
      link: {
        pcKey: KEY,
        pin: PIN,
        code: CODE,
        name: "집 PC",
        routes: ["pc.tail1234.ts.net:28540", "myhome.ddns.net:28541"],
      },
    })
  })

  test("IPv6 routes, duplicates and unusable routes", () => {
    const parsed = parsePairingLink(
      link({ ...valid, r: ["[fd7a:115c::1]:28540", "bad route", "[fd7a:115c::1]:28540", "h:0"] }),
    )
    expect(parsed.ok && parsed.link.routes).toEqual(["[fd7a:115c::1]:28540"])
    expect(parseRoute("[::1]:28540")).toEqual({ host: "::1", port: 28540 })
    expect(parseRoute("127.0.0.1:28540")).toEqual({ host: "127.0.0.1", port: 28540 })
    expect(parseRoute("host:65536")).toBeUndefined()
    expect(parseRoute("-bad-.example:1")).toBeUndefined()
    expect(parseRoute("https://x:1")).toBeUndefined()
  })

  test("refused: other schemes, another version, malformed k/p/c, no route", () => {
    expect(parsePairingLink("https://pc.tail1234.ts.net/auth/connect/abc")).toEqual({ ok: false, problem: "not_link" })
    expect(parsePairingLink(link(valid).replace("ownpc://pair", "ownpc://other"))).toEqual({
      ok: false,
      problem: "not_link",
    })
    expect(parsePairingLink(link({ ...valid, v: "2" }))).toEqual({ ok: false, problem: "version" })
    expect(parsePairingLink(link({ ...valid, k: "ABCDEFGHIJ23" }))).toEqual({ ok: false, problem: "pc_key" })
    expect(parsePairingLink(link({ ...valid, k: "abcdefghij1" }))).toEqual({ ok: false, problem: "pc_key" })
    expect(parsePairingLink(link({ ...valid, p: "A".repeat(42) }))).toEqual({ ok: false, problem: "pin" })
    expect(parsePairingLink(link({ ...valid, p: `${"A".repeat(42)}=` }))).toEqual({ ok: false, problem: "pin" })
    expect(parsePairingLink(link({ ...valid, c: "short" }))).toEqual({ ok: false, problem: "code" })
    expect(parsePairingLink(link({ ...valid, c: `${CODE}/x` }))).toEqual({ ok: false, problem: "code" })
    expect(parsePairingLink(link({ ...valid, r: [] }))).toEqual({ ok: false, problem: "routes" })
    expect(parsePairingLink(link({ ...valid, r: ["nope"] }))).toEqual({ ok: false, problem: "routes" })
  })

  test("names: control characters go, at most 64 characters, the pcKey without one", () => {
    const named = parsePairingLink(link({ ...valid, n: `\u0007 ${"가".repeat(80)}` }))
    expect(named.ok && named.link.name).toBe("가".repeat(64))
    const unnamed = parsePairingLink(link({ v: "1", k: KEY, p: PIN, c: CODE, r: "h:1" }))
    expect(unnamed.ok && unnamed.link.name).toBe(KEY)
  })

  test("app host and origin", () => {
    expect(appHost(KEY)).toBe(`${KEY}.ownpc.internal`)
    expect(appOrigin(KEY)).toBe(`https://${KEY}.ownpc.internal`)
    expect(pcKeyOfHost(`${KEY.toUpperCase()}.OWNPC.INTERNAL`)).toBe(KEY)
    expect(pcKeyOfHost(`x.${KEY}.ownpc.internal`)).toBeUndefined()
    expect(pcKeyOfHost("example.com")).toBeUndefined()
  })
})

describe("pin (08 §3.1, §3.4 2)", () => {
  const cert = selfSigned(appHost(KEY))
  const other = selfSigned(appHost(KEY))

  test("base64url SHA-256 of the SPKI DER", () => {
    expect(spkiPin(cert.certPem)).toBe(cert.pin)
    expect(cert.pin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(spkiPin("not a certificate")).toBeUndefined()
  })

  test("accepted only for the app host with the partition's pin", () => {
    const request = { hostname: appHost(KEY), pem: cert.certPem }
    expect(certificateVerdict(request, KEY, cert.pin)).toBe(ACCEPT)
    expect(certificateVerdict({ ...request, hostname: appHost(KEY).toUpperCase() }, KEY, cert.pin)).toBe(ACCEPT)
    // another key, another name, another PC, garbage
    expect(certificateVerdict({ ...request, pem: other.certPem }, KEY, cert.pin)).toBe(REJECT)
    expect(certificateVerdict(request, KEY, other.pin)).toBe(REJECT)
    expect(certificateVerdict({ ...request, hostname: "pc.tail1234.ts.net" }, KEY, cert.pin)).toBe(REJECT)
    expect(certificateVerdict(request, "zzzzzzzzzzzz", cert.pin)).toBe(REJECT)
    expect(certificateVerdict({ ...request, pem: "x" }, KEY, cert.pin)).toBe(REJECT)
  })

  test("one partition per PC and pin: a new key never meets a verdict cached for the old one", () => {
    const name = partitionName(KEY, cert.pin)
    expect(name).toMatch(/^ownpc-abcdefghij23-[0-9a-f]{16}$/)
    expect(partitionName(KEY, cert.pin)).toBe(name)
    expect(partitionName(KEY, other.pin)).not.toBe(name)
    expect(partitionName("zzzzzzzzzzzz", cert.pin)).not.toBe(name)
  })
})

// ---- the proxy

const servers: Array<{ close(): unknown }> = []
afterAll(() => servers.forEach((server) => server.close()))

/** A TCP echo server that prefixes its replies, so a test can tell which route a tunnel reached. */
async function echo(tag: string) {
  const server = net.createServer((socket) => socket.on("data", (data) => socket.write(`${tag}:${data}`)))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return `127.0.0.1:${(server.address() as net.AddressInfo).port}`
}

function routesOf(table: Record<string, string[]>) {
  const events: string[] = []
  const last = new Map<string, string>()
  const known: ProxyRoutes = {
    routes: (pcKey) => table[pcKey],
    lastRoute: (pcKey) => last.get(pcKey),
    connected(pcKey, route) {
      events.push(`connected ${pcKey} ${route}`)
      last.set(pcKey, route)
    },
    unreachable: (pcKey) => void events.push(`unreachable ${pcKey}`),
  }
  return { known, events, last }
}

/** Sends `head`, then (after a 200) `payload`; resolves with everything the proxy sent back. */
function exchange(port: number, head: string, payload = "") {
  return new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    let received = ""
    socket.on("data", (data) => {
      received += data.toString()
      if (payload && received.startsWith("HTTP/1.1 200") && received.endsWith("\r\n\r\n")) socket.write(payload)
      if (payload && received.includes(`:${payload}`)) socket.end()
    })
    socket.on("close", () => resolve(received))
    socket.on("error", () => resolve(received))
    socket.write(head)
  })
}

const connect = (host: string, port = 443) => `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`

describe("CONNECT proxy (08 §3.4 1)", () => {
  test("parses only CONNECT <pcKey>.ownpc.internal:443", () => {
    expect(connectTarget(connect(appHost(KEY)))).toBe(KEY)
    expect(connectTarget(connect(appHost(KEY), 8443))).toBeUndefined()
    expect(connectTarget(connect("example.com"))).toBeUndefined()
    expect(connectTarget(`GET http://${appHost(KEY)}/ HTTP/1.1\r\n\r\n`)).toBeUndefined()
  })

  test("tunnels a known PC to its route", async () => {
    const route = await echo("a")
    const state = routesOf({ [KEY]: [route] })
    const proxy = createConnectProxy(state.known)
    servers.push(proxy)
    const port = await proxy.port()
    expect(await proxy.port()).toBe(port)
    const reply = await exchange(port, connect(appHost(KEY)), "hello")
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\na:hello")
    expect(state.events).toEqual([`connected ${KEY} ${route}`])
  })

  test("everything else is 403: unknown PCs, other hosts and ports, plain proxy requests", async () => {
    const state = routesOf({ [KEY]: [await echo("a")] })
    const proxy = createConnectProxy(state.known)
    servers.push(proxy)
    const port = await proxy.port()
    for (const head of [
      connect(appHost("zzzzzzzzzzzz")),
      connect("example.com"),
      connect(appHost(KEY), 80),
      `GET http://127.0.0.1:28538/api/session HTTP/1.1\r\nHost: 127.0.0.1:28538\r\n\r\n`,
    ])
      expect(await exchange(port, head)).toStartWith("HTTP/1.1 403 Forbidden\r\n")
    expect(state.events).toEqual([])
  })

  test("route failover, the last good route first next time, 502 when none answers", async () => {
    const dead = await closedPort()
    const good = await echo("b")
    const state = routesOf({ [KEY]: [dead, good], other23abcde: [await closedPort()] })
    const proxy = createConnectProxy(state.known)
    servers.push(proxy)
    const port = await proxy.port()
    expect(await exchange(port, connect(appHost(KEY)), "x")).toEndWith("b:x")
    expect(state.last.get(KEY)).toBe(good)
    expect(orderRoutes([dead, good], state.last.get(KEY))).toEqual([good, dead])
    expect(orderRoutes([dead, good], "gone:1")).toEqual([dead, good])
    expect(await exchange(port, connect(appHost(KEY)), "y")).toEndWith("b:y")
    expect(await exchange(port, connect(appHost("other23abcde")))).toStartWith("HTTP/1.1 502 Bad Gateway\r\n")
    expect(state.events).toEqual([`connected ${KEY} ${good}`, `connected ${KEY} ${good}`, "unreachable other23abcde"])
  })

  test("a route that does not answer in time is skipped", async () => {
    // 10.255.255.1 is not routed here: the handshake never completes (or fails at once), never within the limit.
    const good = await echo("c")
    const state = routesOf({ [KEY]: ["10.255.255.1:9", good] })
    const proxy = createConnectProxy(state.known, { connectTimeoutMs: 150 })
    servers.push(proxy)
    const started = Date.now()
    expect(await exchange(await proxy.port(), connect(appHost(KEY)), "z")).toEndWith("c:z")
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

// ---- the store

describe("remote-pcs.json (08 §3.5)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "own-remote-pcs-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const record: RemotePcRecord = {
    pcKey: KEY,
    name: "집 PC",
    pin: PIN,
    routes: ["pc.tail1234.ts.net:28540", "[fd7a:115c::1]:28540"],
    lastRoute: "[fd7a:115c::1]:28540",
    deviceId: "dev_1",
    expiresAt: 1_900_000_000_000,
    addedAt: 1_800_000_000_000,
  }

  test("round trip, written atomically, no token field", async () => {
    const file = path.join(dir, "nested", "remote-pcs.json")
    expect(await loadRemotePcs(file)).toEqual([])
    await saveRemotePcs(file, [record])
    expect(await loadRemotePcs(file)).toEqual([record])
    expect(readdirSync(path.dirname(file))).toEqual(["remote-pcs.json"])
    expect(await Bun.file(file).text()).not.toContain("token")
    await saveRemotePcs(file, [])
    expect(await loadRemotePcs(file)).toEqual([])
  })

  test("a link naming a stored PC under another key is refused; the same key and new PCs pair", () => {
    const forged = parsePairingLink(link({ ...valid, p: "B".repeat(43), r: "evil.example:443" }))
    const again = parsePairingLink(link(valid))
    const otherPc = parsePairingLink(link({ ...valid, k: "bbbbbbbbbbbb", p: "B".repeat(43) }))
    if (!forged.ok || !again.ok || !otherPc.ok) throw new Error("test links must parse")
    expect(keyChanged([record], forged.link)).toBe(true)
    expect(keyChanged([record], again.link)).toBe(false)
    expect(keyChanged([record], otherPc.link)).toBe(false)
    expect(keyChanged([], forged.link)).toBe(false)
  })

  test("validated when read: bad entries dropped, one record per PC, a stale last route forgotten", async () => {
    const file = path.join(dir, "mixed.json")
    writeFileSync(
      file,
      JSON.stringify([
        { ...record, lastRoute: "gone:1", name: "\u0000집" },
        { ...record, name: "duplicate" },
        { ...record, pcKey: "BAD" },
        { ...record, pcKey: "zzzzzzzzzzzz", pin: "short" },
        { ...record, pcKey: "yyyyyyyyyyyy", routes: ["nope"] },
        { ...record, pcKey: "xxxxxxxxxxxx", deviceId: 7 },
        "text",
      ]),
    )
    const loaded = await loadRemotePcs(file)
    expect(loaded.map((entry) => entry.pcKey)).toEqual([KEY])
    expect(loaded[0]!.name).toBe("집")
    expect(loaded[0]!.lastRoute).toBeUndefined()
    writeFileSync(file, "{ not json")
    expect(await loadRemotePcs(file)).toEqual([])
  })

  test("removed partitions: only marked ones go, a PC paired again keeps its folder", async () => {
    const partitions = path.join(dir, "Partitions")
    const folder = (name: string, marked: boolean) => {
      mkdirSync(path.join(partitions, name, "Local Storage"), { recursive: true })
      writeFileSync(path.join(partitions, name, "Cookies"), "x")
      if (marked) writeFileSync(path.join(partitions, name, REMOVED_MARK), "")
    }
    // A removed PC, a PC's old key after pairing again, a stored PC, a stored PC's partition marked by a removal or a
    // failed pairing earlier in its last run, and folders that are not PC partitions.
    const removed = partitionName("aaaaaaaaaaaa", PIN)
    const oldKey = partitionName("cccccccccccc", "B".repeat(43))
    const stored = partitionName("bbbbbbbbbbbb", PIN)
    const reused = partitionName("cccccccccccc", PIN)
    folder(removed, true)
    folder(oldKey, true)
    folder(stored, false)
    folder(reused, true)
    folder("other", true)
    folder("ownpc-dddddddddddd-zz", true)
    const deleted = await purgeRemovedPartitions(partitions, new Set([stored, reused]))
    expect(deleted.sort()).toEqual([removed, oldKey].sort())
    expect(readdirSync(partitions).sort()).toEqual(["other", "ownpc-dddddddddddd-zz", reused, stored].sort())
    expect(existsSync(path.join(partitions, reused, REMOVED_MARK))).toBe(false)
    expect(existsSync(path.join(partitions, reused, "Cookies"))).toBe(true)
    // An unreadable or empty remote-pcs.json never wipes unmarked logins.
    expect(await purgeRemovedPartitions(partitions, new Set())).toEqual([])
    expect(await purgeRemovedPartitions(path.join(dir, "missing"), new Set())).toEqual([])
  })
})

// ---- native pairing and route refresh against a pinned TLS gateway stand-in, through the proxy

function gateway(cert: { certPem: string; keyPem: string }, script: GatewayScript) {
  const pc = standInGateway(cert, script, { pcKey: KEY, code: CODE })
  servers.push(pc)
  return pc
}

async function setup(script: GatewayScript, options: { trust?: "served" | "other"; dead?: boolean } = {}) {
  const cert = selfSigned(appHost(KEY))
  const pc = gateway(cert, script)
  const flags = { unreachable: false }
  const routes = options.dead ? [await closedPort()] : [await closedPort(), pc.route]
  const proxy = createConnectProxy({
    routes: (pcKey) => (pcKey === KEY ? routes : undefined),
    lastRoute: () => undefined,
    connected: () => undefined,
    unreachable: () => void (flags.unreachable = true),
  })
  servers.push(proxy)
  const pin = options.trust === "other" ? selfSigned(appHost(KEY)).pin : cert.pin
  return { pc, cert, transport: pinnedTransport(await proxy.port(), cert, { pcKey: KEY, pin }, flags) }
}

describe("native pairing and routes over the pinned app origin (08 §3.5, §3.6)", () => {
  test("connect → SAS → approved → claim → routes with the device token", async () => {
    const routes = {
      pcKey: KEY,
      pin: PIN,
      name: "집 PC",
      routes: ["pc.tail1234.ts.net:28540", "bad", "h.example:28541"],
    }
    const env = await setup({ states: ["pending", "pending", "approved"], token: "device-token", routes })
    const opened = await openPairing(env.transport, CODE)
    expect(opened.sas).toBe("4821")
    expect(opened.claim).toBe("claim-secret")
    await awaitApproval(env.transport, opened.claim, { intervalMs: 5 })
    const credential = await claimDevice(env.transport, opened.claim)
    expect(credential).toEqual({ deviceId: "dev_app", token: "device-token", expiresAt: 1_900_000_000_000 })
    expect(await fetchRoutes(env.transport, credential.token)).toEqual({
      kind: "ok",
      pcKey: KEY,
      pin: PIN,
      name: "집 PC",
      routes: ["pc.tail1234.ts.net:28540", "h.example:28541"],
    })
    expect(await fetchRoutes(env.transport, "revoked")).toEqual({ kind: "unauthorized" })
    // Every request named the app host (no route in Host) and carried the app's user agent.
    expect(new Set(env.pc.seen.map((request) => request.host))).toEqual(new Set([appHost(KEY)]))
    expect(env.pc.seen.every((request) => request.ua?.endsWith("OwnOpenCodeApp/1 (desktop)"))).toBe(true)
    expect(env.pc.seen.filter((request) => request.path === "/own/pairing").map((request) => request.claim)).toEqual([
      "claim-secret",
      "claim-secret",
      "claim-secret",
    ])
  })

  test("the PC's answers become errors: rejected, expired, cancelled, used links, rate limits", async () => {
    for (const state of ["rejected", "expired", "cancelled"] as const) {
      const env = await setup({ states: ["pending", state], token: "t" })
      const opened = await openPairing(env.transport, CODE)
      await expect(awaitApproval(env.transport, opened.claim, { intervalMs: 5 })).rejects.toMatchObject({ code: state })
    }
    const claimed = await setup({ states: ["claimed"], token: "t" })
    await expect(awaitApproval(claimed.transport, "claim-secret", { intervalMs: 5 })).rejects.toMatchObject({
      code: "failed",
      detail: "pairing claimed",
    })
    const used = await setup({ states: [], connectStatus: 410, token: "t" })
    await expect(openPairing(used.transport, CODE)).rejects.toMatchObject({ code: "expired" })
    const limited = await setup({ states: [], connectStatus: 429, token: "t" })
    await expect(openPairing(limited.transport, CODE)).rejects.toMatchObject({ code: "rate_limited" })
  })

  test("another key behind the app host: refused before any request reaches it", async () => {
    const env = await setup({ states: ["approved"], token: "t" }, { trust: "other" })
    await expect(openPairing(env.transport, CODE)).rejects.toMatchObject({ code: "pin_mismatch" })
    expect(env.pc.seen).toEqual([])
  })

  test("no route answers: unreachable", async () => {
    const env = await setup({ states: ["approved"], token: "t" }, { dead: true })
    await expect(openPairing(env.transport, CODE)).rejects.toMatchObject({ code: "unreachable" })
  })

  test("cancelled while waiting for the PC", async () => {
    const env = await setup({ states: ["pending"], token: "t" })
    const controller = new AbortController()
    const waiting = awaitApproval(env.transport, "claim-secret", { intervalMs: 20, signal: controller.signal })
    setTimeout(() => controller.abort(), 60)
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
  })

  test("removing a PC: it revokes this device over the pinned origin (08 §3.6a)", async () => {
    const env = await setup({ states: [], token: "device-token" })
    expect(await revokeDevice(env.transport, "device-token")).toBe(true)
    const call = env.pc.seen.find((request) => request.path === "/own/device/revoke")
    expect(call).toMatchObject({ host: appHost(KEY), auth: "Bearer device-token" })
    // A token the PC no longer knows: not revoked there, the caller removes the PC anyway.
    expect(await revokeDevice(env.transport, "stale")).toBe(false)
    // A PC that does not answer: the transport's error, which the shell ignores.
    const dead = await setup({ states: [], token: "device-token" }, { dead: true })
    await expect(revokeDevice(dead.transport, "device-token")).rejects.toMatchObject({ code: "unreachable" })
  })
})

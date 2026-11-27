// 모바일 미리보기 (08 §4.3) without Electron: the loopback-only link, the preview's own partitions and their purge, the
// mobile-preview.json record, the proxy that knows only this PC, the emulation parameters, and the whole pinned
// pair → approve → claim → routes → revoke sequence against a gateway stand-in reached through that proxy.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {
  emulationCommands,
  fitScale,
  PRESET_IDS,
  PRESETS,
  previewUserAgent,
  screenSize,
  viewport,
} from "../src/main/remote-pcs/emulation"
import { awaitApproval, claimDevice, fetchRoutes, openPairing, revokeDevice } from "../src/main/remote-pcs/pairing"
import { createConnectProxy, singleRoute } from "../src/main/remote-pcs/proxy"
import {
  loadMobilePreview,
  parsePreviewLink,
  partitionName,
  purgeRemovedPartitions,
  REMOVED_MARK,
  saveMobilePreview,
  type MobilePreviewRecord,
} from "../src/main/remote-pcs/store"
import { appHost, isLoopbackRoute } from "../src/shared/remote-pc"
import { selfSigned } from "./helpers/cert"
import { closedPort, pinnedTransport, standInGateway } from "./helpers/gateway"

const KEY = "abcdefghij23"
const OTHER = "bbbbbbbbbbbb"
const PIN = "A".repeat(43)
const CODE = "Q2xhaW1Db2RlXzEyMzQ1Ng"
const CHROME = "152.0.7977.130"

function link(routes: readonly string[], extra: Record<string, string> = {}) {
  const params = { v: "1", k: KEY, p: PIN, c: CODE, n: "내 PC", ...extra }
  const query = [
    ...Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`),
    ...routes.map((route) => `r=${encodeURIComponent(route)}`),
  ]
  return `ownpc://pair?${query.join("&")}`
}

const servers: Array<{ close(): unknown }> = []
afterAll(() => servers.forEach((server) => server.close()))

describe("preview link (08 §4.3): exactly one route, to this PC itself", () => {
  test("loopback routes are accepted", () => {
    for (const route of ["127.0.0.1:28540", "[::1]:28540", "127.0.0.2:30000"]) {
      const parsed = parsePreviewLink(link([route]))
      expect(parsed.ok && parsed.link.routes).toEqual([route])
    }
  })

  test("tailnet, DDNS, LAN, names and several routes are refused", () => {
    for (const routes of [
      ["pc.tail1234.ts.net:28540"],
      ["myhome.ddns.net:28541"],
      ["192.168.0.10:28540"],
      ["localhost:28540"],
      ["[fd7a:115c::1]:28540"],
      ["127.0.0.1:28540", "pc.tail1234.ts.net:28540"],
      ["127.0.0.1:28540", "127.0.0.1:28541"],
    ])
      expect(parsePreviewLink(link(routes))).toEqual({ ok: false, problem: "loopback" })
    // Anything that is no pairing link keeps its own reason.
    expect(parsePreviewLink("https://127.0.0.1:28540/")).toEqual({ ok: false, problem: "not_link" })
    expect(parsePreviewLink(link(["127.0.0.1:28540"], { p: "short" }))).toEqual({ ok: false, problem: "pin" })
  })

  test("loopback means an address, never a name", () => {
    expect(isLoopbackRoute("127.255.255.254:1")).toBe(true)
    expect(isLoopbackRoute("[::1]:1")).toBe(true)
    for (const route of ["128.0.0.1:1", "127.0.0.256:1", "localhost:1", "127.0.0.1.nip.io:1", "[::2]:1", "nope"])
      expect(isLoopbackRoute(route)).toBe(false)
  })
})

describe("partitions (08 §4.3)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "own-preview-partitions-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("the preview never shares a partition with a 원격 PC entry of the same PC", () => {
    const preview = partitionName(KEY, PIN, "ownpreview")
    expect(preview).toMatch(/^ownpreview-abcdefghij23-[0-9a-f]{16}$/)
    expect(preview).not.toBe(partitionName(KEY, PIN))
    expect(partitionName(KEY, PIN)).toBe(partitionName(KEY, PIN, "ownpc"))
    expect(partitionName(KEY, "B".repeat(43), "ownpreview")).not.toBe(preview)
  })

  test("each service purges its own marked folders only", async () => {
    const partitions = path.join(dir, "Partitions")
    const folder = (name: string) => {
      mkdirSync(path.join(partitions, name), { recursive: true })
      writeFileSync(path.join(partitions, name, "Cookies"), "x")
      writeFileSync(path.join(partitions, name, REMOVED_MARK), "")
    }
    const remotePc = partitionName(KEY, PIN)
    const oldPreview = partitionName(OTHER, PIN, "ownpreview")
    const preview = partitionName(KEY, PIN, "ownpreview")
    for (const name of [remotePc, oldPreview, preview]) folder(name)
    // The preview service: its stored partition keeps its folder (the marker goes), the old one goes, the 원격 PC's stays.
    expect(await purgeRemovedPartitions(partitions, new Set([preview]), "ownpreview")).toEqual([oldPreview])
    expect(existsSync(path.join(partitions, preview, REMOVED_MARK))).toBe(false)
    expect(existsSync(path.join(partitions, remotePc, REMOVED_MARK))).toBe(true)
    // The 원격 PC service: only its own prefix.
    expect(await purgeRemovedPartitions(partitions, new Set())).toEqual([remotePc])
    expect(readdirSync(partitions)).toEqual([preview])
  })
})

describe("mobile-preview.json (08 §4.3)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "own-preview-store-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const record: MobilePreviewRecord = {
    pcKey: KEY,
    pin: PIN,
    route: "127.0.0.1:28540",
    deviceId: "dev_preview",
    expiresAt: 1_900_000_000_000,
    addedAt: 1_800_000_000_000,
    preset: "galaxy",
    orientation: "landscape",
  }

  test("round trip, atomic, no token; removing deletes the file", async () => {
    const file = path.join(dir, "nested", "mobile-preview.json")
    expect(await loadMobilePreview(file)).toBeUndefined()
    await saveMobilePreview(file, record)
    expect(await loadMobilePreview(file)).toEqual(record)
    expect(readdirSync(path.dirname(file))).toEqual(["mobile-preview.json"])
    expect(await Bun.file(file).text()).not.toContain("token")
    await saveMobilePreview(file, undefined)
    expect(existsSync(file)).toBe(false)
  })

  test("validated when read: a route that is not loopback drops it, an unknown look falls back", async () => {
    const file = path.join(dir, "checked.json")
    writeFileSync(file, JSON.stringify({ ...record, route: "pc.tail1234.ts.net:28540" }))
    expect(await loadMobilePreview(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ ...record, pin: "short" }))
    expect(await loadMobilePreview(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ ...record, preset: "watch", orientation: 3 }))
    expect(await loadMobilePreview(file)).toEqual({ ...record, preset: "pixel", orientation: "portrait" })
    writeFileSync(file, "{ not json")
    expect(await loadMobilePreview(file)).toBeUndefined()
  })
})

/** A TCP echo server that prefixes its replies. */
async function echo(tag: string) {
  const server = net.createServer((socket) => socket.on("data", (data) => socket.write(`${tag}:${data}`)))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return `127.0.0.1:${(server.address() as net.AddressInfo).port}`
}

function exchange(port: number, host: string, payload = "") {
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
    socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
  })
}

describe("the preview's proxy (08 §4.3): this PC only, loopback only", () => {
  test("tunnels this PC's pcKey to its route; every other pcKey is 403", async () => {
    const route = await echo("pc")
    const events: string[] = []
    const target: { pcKey: string; route: string } = { pcKey: KEY, route }
    const proxy = createConnectProxy(
      singleRoute(() => target, {
        connected: (pcKey, at) => void events.push(`connected ${pcKey} ${at}`),
        unreachable: (pcKey) => void events.push(`unreachable ${pcKey}`),
      }),
    )
    servers.push(proxy)
    const port = await proxy.port()
    expect(await exchange(port, appHost(KEY), "hi")).toBe("HTTP/1.1 200 Connection Established\r\n\r\npc:hi")
    // A stored 원격 PC, or any other PC: unknown here.
    expect(await exchange(port, appHost(OTHER))).toStartWith("HTTP/1.1 403 Forbidden\r\n")
    // A record that somehow names another route is never dialled.
    target.route = "pc.tail1234.ts.net:28540"
    expect(await exchange(port, appHost(KEY))).toStartWith("HTTP/1.1 403 Forbidden\r\n")
    target.route = await closedPort()
    expect(await exchange(port, appHost(KEY))).toStartWith("HTTP/1.1 502 Bad Gateway\r\n")
    expect(events).toEqual([`connected ${KEY} ${route}`, `unreachable ${KEY}`])
  })

  test("no preview: everything is 403", async () => {
    const proxy = createConnectProxy(singleRoute(() => undefined, { connected: () => {}, unreachable: () => {} }))
    servers.push(proxy)
    expect(await exchange(await proxy.port(), appHost(KEY))).toStartWith("HTTP/1.1 403 Forbidden\r\n")
  })
})

describe("emulation (08 §4.3)", () => {
  const base = { preset: "pixel", orientation: "portrait", keyboard: false, scheme: "system" } as const

  test("presets, rotation and the keyboard", () => {
    expect(PRESET_IDS).toEqual(["compact", "pixel", "galaxy", "fold", "tablet"])
    expect(PRESET_IDS.map((id) => `${PRESETS[id].width}x${PRESETS[id].height}`)).toEqual([
      "360x740",
      "412x868",
      "384x790",
      "673x790",
      "800x1220",
    ])
    expect(viewport(base)).toEqual({ width: 412, height: 868 })
    expect(screenSize({ ...base, orientation: "landscape" })).toEqual({ width: 868, height: 412 })
    expect(viewport({ ...base, orientation: "landscape" })).toEqual({ width: 868, height: 412 })
    // adjustResize: the page shrinks, the screen does not.
    expect(viewport({ ...base, keyboard: true })).toEqual({ width: 412, height: 521 })
    expect(viewport({ ...base, orientation: "landscape", keyboard: true })).toEqual({ width: 868, height: 185 })
  })

  test("the window scales a screen that does not fit, never above 1", () => {
    expect(fitScale({ width: 412, height: 868 }, { width: 1920, height: 1040 })).toBe(1)
    expect(fitScale({ width: 800, height: 1220 }, { width: 1920, height: 1040 })).toBe(0.77)
    expect(fitScale({ width: 800, height: 1220 }, { width: 200, height: 200 })).toBe(0.25)
  })

  test("the user agent is the app's with the preview's own token and this Chromium", () => {
    const agent = previewUserAgent(CHROME)
    expect(agent).toContain("Android 15")
    expect(agent).toContain("; wv)")
    expect(agent).toContain(`Chrome/${CHROME} Mobile Safari/537.36`)
    expect(agent).toEndWith(" OwnOpenCodeApp/1 (android) OwnPreview/1")
    expect(/OwnOpenCodeApp\/\d+/.test(agent)).toBe(true)
  })

  test("the CDP commands: a mobile viewport, touch with 5 points, the app's agent, the color scheme", () => {
    const commands = emulationCommands({ ...base, keyboard: true, scheme: "dark" }, { chrome: CHROME, scale: 0.5 })
    expect(commands.map((command) => command.method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setEmitTouchEventsForMouse",
      "Emulation.setUserAgentOverride",
      "Emulation.setEmulatedMedia",
    ])
    expect(commands[0]!.params).toEqual({
      width: 412,
      height: 521,
      deviceScaleFactor: 0,
      mobile: true,
      scale: 0.5,
      screenWidth: 412,
      screenHeight: 868,
      screenOrientation: { type: "portraitPrimary", angle: 0 },
    })
    expect(commands[1]!.params).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(commands[2]!.params).toEqual({ enabled: true, configuration: "mobile" })
    expect(commands[3]!.params).toMatchObject({
      userAgent: previewUserAgent(CHROME),
      userAgentMetadata: { platform: "Android", mobile: true, brands: [{ brand: "Chromium", version: "152" }, { brand: "Android WebView", version: "152" }] },
    })
    expect(commands[4]!.params).toEqual({ features: [{ name: "prefers-color-scheme", value: "dark" }] })
    const landscape = emulationCommands({ ...base, orientation: "landscape" }, { chrome: CHROME, scale: 1 })
    expect(landscape[0]!.params).toMatchObject({ width: 868, height: 412, screenOrientation: { type: "landscapePrimary", angle: 90 } })
    expect(landscape[4]!.params).toEqual({ features: [{ name: "prefers-color-scheme", value: "" }] })
  })
})

describe("pairing a preview over the pinned loopback route (08 §4.3, §3.5)", () => {
  test("connect → SAS → the PC's 허용 → claim → routes → revoke, every request as the preview", async () => {
    const cert = selfSigned(appHost(KEY))
    const pc = standInGateway(
      cert,
      { states: ["pending", "approved"], token: "preview-token", routes: { pcKey: KEY, pin: cert.pin, name: "내 PC", routes: [] } },
      { pcKey: KEY, code: CODE },
    )
    servers.push(pc)
    const parsed = parsePreviewLink(link([pc.route], { p: cert.pin }))
    if (!parsed.ok) throw new Error(`link: ${parsed.problem}`)
    const flags = { unreachable: false }
    const proxy = createConnectProxy(
      singleRoute(() => ({ pcKey: parsed.link.pcKey, route: parsed.link.routes[0]! }), {
        connected: () => undefined,
        unreachable: () => void (flags.unreachable = true),
      }),
    )
    servers.push(proxy)
    const transport = pinnedTransport(
      await proxy.port(),
      cert,
      { pcKey: KEY, pin: parsed.link.pin, userAgent: previewUserAgent(CHROME) },
      flags,
    )
    const opened = await openPairing(transport, parsed.link.code)
    expect(opened.sas).toBe("4821")
    await awaitApproval(transport, opened.claim, { intervalMs: 5 })
    const credential = await claimDevice(transport, opened.claim)
    expect(credential).toEqual({ deviceId: "dev_app", token: "preview-token", expiresAt: 1_900_000_000_000 })
    // The gateway offers no configured route; the preview keeps dialling loopback (`unavailable` counts as reached).
    expect(await fetchRoutes(transport, credential.token)).toEqual({ kind: "unavailable", status: 200 })
    expect(await revokeDevice(transport, credential.token)).toBe(true)
    expect(new Set(pc.seen.map((request) => request.host))).toEqual(new Set([appHost(KEY)]))
    expect(pc.seen.every((request) => request.ua?.endsWith("OwnOpenCodeApp/1 (android) OwnPreview/1"))).toBe(true)
    expect(pc.seen.map((request) => request.path)).toEqual([
      `/auth/connect/${CODE}`,
      "/own/pairing",
      "/own/pairing",
      "/own/pairing/claim",
      "/own/routes",
      "/own/device/revoke",
    ])
  })

  test("another key behind this PC's route is refused before any request reaches it", async () => {
    const cert = selfSigned(appHost(KEY))
    const pc = standInGateway(cert, { states: ["approved"], token: "t" }, { pcKey: KEY, code: CODE })
    servers.push(pc)
    const flags = { unreachable: false }
    const proxy = createConnectProxy(
      singleRoute(() => ({ pcKey: KEY, route: pc.route }), { connected: () => undefined, unreachable: () => undefined }),
    )
    servers.push(proxy)
    const transport = pinnedTransport(await proxy.port(), cert, { pcKey: KEY, pin: selfSigned(appHost(KEY)).pin }, flags)
    await expect(openPairing(transport, CODE)).rejects.toMatchObject({ code: "pin_mismatch" })
    expect(pc.seen).toEqual([])
  })
})

// The browser pane on a device through the real gateway (05 §8.10.2, §8.10.5, §8.10.7): a listener on loopback, paired
// devices, the viewer socket, and a test playing the desktop shell with RPC `browser.host.*` on a fake local service
// (test/harness/browser-gateway.ts). The hub's own rules are test/gateway/browser-hub.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { PANE_WAIT_MS } from "../../src/gateway/server.js"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"
import { BrowserGateway } from "../harness/browser-gateway.js"

const SHELL = "shell-0001"
const DENY = { action: "browser", resource: "*", effect: "deny" }
const TAP: RemoteBrowser.InputEvent = { k: "touch", phase: "start", points: [{ id: 0, x: 0.25, y: 0.75 }] }
const PANE: RemoteBrowser.PaneState = {
  tabs: [{ id: "t1", url: "http://localhost:5173/secret-page", title: "비밀 제목", loading: false, canGoBack: false, canGoForward: false }],
  focusedTabID: "t1",
  page: { mode: "pc", width: 1280, height: 800 },
  dialog: null,
}

interface Pulled {
  readonly views: ReadonlyArray<RemoteBrowser.HostView>
  readonly commands: ReadonlyArray<RemoteBrowser.HostCommand>
  readonly idle: boolean
}

const state: { fixture?: BrowserGateway.Fixture } = {}
const fx = () => state.fixture!

beforeAll(async () => {
  state.fixture = await BrowserGateway.start({
    sessions: {
      ses_1: {},
      ses_2: {},
      ses_3: {},
      ses_wait: {},
      ses_never: {},
      ses_off: { permissions: [DENY] },
      ses_on: { permissions: [DENY, { action: "browser", resource: "*", effect: "allow" }] },
    },
    hostSessions: { ses_h1: {}, ses_hwait: {}, ses_hoff: { permissions: [DENY] } },
  })
})

afterAll(async () => {
  await state.fixture?.stop()
})

/** The desktop shell's poll: what it holds, answered at once. */
const pull = async (hosted: ReadonlyArray<string>, over: Record<string, unknown> = {}) =>
  (await fx().rpc<Pulled>("browser.host.pull", { host: SHELL, windows: 1, hosted, waitMs: 0, ...over })).output

async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await Bun.sleep(20)
  }
}

/** One upgrade request on a raw socket: the status and JSON body of a refusal (a WebSocket client hides them). */
function knock(route: string, headers: Readonly<Record<string, string>>, upgrade = true) {
  const url = new URL(fx().base)
  return new Promise<{ readonly status: number; readonly body: Record<string, any> }>((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) })
    const received = { text: "" }
    const lines = [
      `GET ${route} HTTP/1.1`,
      `Host: ${url.host}`,
      ...(upgrade
        ? ["Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="]
        : ["Connection: close"]),
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ]
    socket.once("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`))
    socket.on("data", (chunk) => {
      received.text += chunk.toString("utf8")
      const head = received.text.indexOf("\r\n\r\n")
      if (head < 0) return
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(received.text)?.[1])
      const length = Number(/content-length: (\d+)/i.exec(received.text.slice(0, head))?.[1] ?? "0")
      const body = received.text.slice(head + 4)
      if (status !== 101 && Buffer.byteLength(body) < length) return
      socket.destroy()
      resolve({ status, body: length > 0 ? JSON.parse(body) : {} })
    })
    socket.once("error", reject)
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error("knock: no answer"))
    })
  })
}

const VIEW = RemoteBrowser.socketPath("local", "ses_1")

describe("the browser pane's viewer socket on the gateway", () => {
  test("a device without `browser` (or without `read`) is refused 403 and no viewer opens", async () => {
    const phone = await fx().pair({ scopes: ["read", "prompt", "switch", "files", "terminal", "admin"] })
    const refused = await knock(VIEW, phone.auth)
    expect(refused).toEqual({
      status: 403,
      body: { _tag: "RpcError", type: "scope_denied", message: "not allowed for this device", data: { scope: "browser" } },
    })
    const blind = await fx().pair({ scopes: ["browser", "prompt"] })
    expect((await knock(VIEW, blind.auth)).body).toMatchObject({ type: "scope_denied", data: { scope: "read" } })
    const socket = fx().viewer(phone, "ses_1")
    expect(await socket.opened).toBe(false)
    expect(fx().gateway.browser.viewers()).toBe(0)
    // The scope is listed for own-web only when granted.
    expect(((await (await phone.get("/own/device")).json()) as { scopes: string[] }).scopes).not.toContain("browser")
    // Nobody, a wrong token and a plain request: 401, 401, 426.
    expect((await knock(VIEW, {})).status).toBe(401)
    expect((await knock(VIEW, { authorization: `Bearer ${"A".repeat(43)}` })).status).toBe(401)
    expect(await knock(VIEW, phone.auth, false)).toMatchObject({ status: 426, body: { type: "upgrade_required" } })
    expect((await phone.post(VIEW, {})).status).toBe(426)
  })

  test("`browser` + `read` watches: ready{control:false}, its input never reaches the shell; a `prompt` device's does", async () => {
    const watcher = await fx().pair({ scopes: ["read", "browser"] })
    const driver = await fx().pair({ scopes: ["read", "prompt", "browser"], kind: "app" })
    // The granted scope is what own-web reads, and the file keeps it apart from the old words (05 §8.10.2).
    expect(((await (await watcher.get("/own/device")).json()) as { scopes: string[] }).scopes).toEqual(["read", "browser"])
    const stored = JSON.parse(fs.readFileSync(fx().gateway.devices.file, "utf8")) as { devices: Array<Record<string, unknown>> }
    expect(stored.devices.find((device) => device.deviceId === watcher.deviceId)).toMatchObject({ scopes: ["read"], extraScopes: ["browser"] })
    await pull(["ses_1"])
    const watching = fx().viewer(watcher, "ses_1")
    expect(await watching.opened).toBe(true)
    watching.hello()
    expect(await watching.ready()).toEqual({ t: "ready", v: 1, control: false })
    expect(await watching.state("ready")).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "ready" })
    expect((await pull(["ses_1"])).views).toEqual([
      { sessionID: "ses_1", mode: "pc", quality: "auto", viewport: { width: 390, height: 800, dpr: 3 } },
    ])
    watching.send({ t: "input", events: [TAP, { k: "text", text: "보기만 하는 기기" }] })
    watching.send({ t: "action", id: 1, action: { type: "navigate", url: "https://example.com/" } })
    expect(await watching.result(1)).toEqual({ t: "result", id: 1, ok: false, error: "read_only" })
    expect((await pull(["ses_1"])).commands).toEqual([])
    // An app (Bearer, no origin) with `prompt` drives: its input and action reach the next pull, in order.
    const driving = fx().viewer(driver, "ses_1")
    driving.hello({ mode: "phone" })
    expect(await driving.ready()).toEqual({ t: "ready", v: 1, control: true })
    driving.send({ t: "input", events: [TAP] })
    driving.send({ t: "action", id: 5, action: { type: "reload" } })
    const commands: RemoteBrowser.HostCommand[] = []
    await eventually(
      async () => commands.push(...(await pull(["ses_1"])).commands),
      (count) => count >= 2,
    )
    expect(commands).toEqual([
      { type: "input", sessionID: "ses_1", events: [TAP] },
      { type: "action", sessionID: "ses_1", id: expect.any(String), action: { type: "reload" } },
    ])
    const action = commands[1]!
    await fx().rpc("browser.host.result", { host: SHELL, id: action.type === "action" ? action.id : "", ok: true })
    expect(await driving.result(5)).toEqual({ t: "result", id: 5, ok: true })
    // The shell's report of the pane reaches both viewers; a binary message from a viewer is a protocol error.
    await fx().rpc("browser.host.state", { host: SHELL, sessionID: "ses_1", state: PANE, notice: "download" })
    expect((await watching.until(() => watching.messages.find((message) => message.t === "notice")))).toEqual({ t: "notice", kind: "download" })
    expect(await driving.until(() => driving.messages.findLast((message) => message.t === "state" && message.state.tabs.length > 0))).toEqual({
      t: "state",
      state: { ...PANE, host: "ready" },
    })
    driving.socket.send(new Uint8Array([1, 2, 3]))
    expect((await driving.closed).code).toBe(RemoteBrowser.CLOSE.protocol)
    watching.close()
    await watching.closed
    await eventually(() => fx().gateway.browser.viewers(), (count) => count === 0)
    // Opening and closing is logged and audited with ids only: no address, title or typed text.
    await fx().gateway.audit.flush()
    const journal = fs.readdirSync(fx().gateway.audit.dir).map((file) => fs.readFileSync(path.join(fx().gateway.audit.dir, file), "utf8")).join("")
    const text = `${JSON.stringify(fx().logs)}\n${journal}`
    expect(fx().logs.filter((line) => line.msg === "browser_view_opened" && line.deviceId === watcher.deviceId)).toEqual([
      expect.objectContaining({ msg: "browser_view_opened", deviceId: watcher.deviceId, sessionID: "ses_1" }),
    ])
    expect(fx().logs.some((line) => line.msg === "browser_view_closed" && line.deviceId === driver.deviceId)).toBe(true)
    expect(journal).toContain(`"deviceId":"${watcher.deviceId}","event":"browser_view_opened","sessionID":"ses_1"`)
    expect(journal).toContain(`"event":"browser_view_closed"`)
    for (const secret of ["secret-page", "비밀 제목", "보기만 하는 기기", "example.com"]) expect(text).not.toContain(secret)
  })

  test("frames pushed with browser.host.frame arrive as binary with their header; the ack answers the push", async () => {
    const device = await fx().pair({ scopes: ["read", "browser"] })
    await pull(["ses_2"])
    const watching = fx().viewer(device, "ses_2")
    watching.hello()
    await watching.state("ready")
    const data = BrowserGateway.jpeg(9, 2048)
    const answer: { value?: { viewers: number; acked: boolean } } = {}
    const pushed = fx()
      .rpc<{ viewers: number; acked: boolean }>("browser.host.frame", { host: SHELL, sessionID: "ses_2", width: 720, height: 1480, sharp: true, data })
      .then((response) => (answer.value = response.output))
    const frame = await watching.frame()
    expect(frame.header).toEqual({ seq: expect.any(Number), width: 720, height: 1480, sharp: true })
    expect(Buffer.from(frame.jpeg).toString("base64")).toBe(data)
    await Bun.sleep(100)
    expect(answer.value).toBeUndefined()
    watching.send({ t: "ack", seq: frame.header.seq })
    expect(await pushed).toEqual({ viewers: 1, acked: true })
    // Refused as input_invalid: not a JPEG, not base64, another shell's.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")
    const bad = { host: SHELL, sessionID: "ses_2", width: 720, height: 1480, sharp: false }
    expect(await fx().rpc("browser.host.frame", { ...bad, data: png })).toMatchObject({
      status: 400,
      error: "input_invalid",
      data: { field: "data", reason: "not_jpeg" },
    })
    expect(await fx().rpc("browser.host.frame", { ...bad, data: "@@@@" })).toMatchObject({ status: 400, data: { reason: "base64" } })
    expect(await fx().rpc("browser.host.frame", { ...bad, host: "shell-other", data })).toMatchObject({
      status: 400,
      data: { field: "host", reason: "not_current" },
    })
    expect(watching.frames).toHaveLength(1)
    watching.close()
    await watching.closed
  })

  test("taking `browser` away mid-stream closes the socket at once: no view, and a frame finds nobody; the same for 폐기", async () => {
    const changed = await fx().pair({ scopes: ["read", "prompt", "browser"] })
    const revoked = await fx().pair({ scopes: ["read", "browser"], kind: "app" })
    await pull(["ses_3"])
    const first = fx().viewer(changed, "ses_3")
    first.hello()
    await first.state("ready")
    expect((await pull(["ses_3"])).views.map((view) => view.sessionID)).toEqual(["ses_3"])
    const started = Date.now()
    const updated = await fx().gateway.update({ deviceId: changed.deviceId, scopes: ["read", "prompt"] })
    expect(updated.ok).toBe(true)
    expect(await first.closed).toMatchObject({ code: RemoteBrowser.CLOSE.scope })
    expect(Date.now() - started).toBeLessThan(2000)
    expect((await eventually(() => pull(["ses_3"]), (output) => output.views.length === 0)).views).toEqual([])
    const frame = { host: SHELL, sessionID: "ses_3", width: 10, height: 10, sharp: false, data: BrowserGateway.jpeg() }
    expect((await fx().rpc("browser.host.frame", frame)).output).toEqual({ viewers: 0, acked: false })
    expect((await knock(RemoteBrowser.socketPath("local", "ses_3"), changed.auth)).body).toMatchObject({ data: { scope: "browser" } })
    // Given back, it connects again with what it holds now.
    await fx().gateway.update({ deviceId: changed.deviceId, scopes: ["read", "browser"] })
    const again = fx().viewer(changed, "ses_3")
    again.hello()
    expect(await again.ready()).toEqual({ t: "ready", v: 1, control: false })
    // A changed server list closes it too: the pane is this PC's.
    await fx().gateway.update({ deviceId: changed.deviceId, servers: { mode: "only", keys: [BrowserGateway.HOST_ID] } })
    expect(await again.closed).toMatchObject({ code: RemoteBrowser.CLOSE.scope })
    // 폐기.
    const second = fx().viewer(revoked, "ses_3")
    second.hello()
    await second.state("ready")
    expect((await pull(["ses_3"])).views).toHaveLength(1)
    expect((await fx().gateway.revoke(revoked.deviceId)).ok).toBe(true)
    expect(await second.closed).toMatchObject({ code: RemoteBrowser.CLOSE.revoked, reason: "device revoked" })
    expect((await eventually(() => pull(["ses_3"]), (output) => output.views.length === 0)).views).toEqual([])
    expect((await fx().rpc("browser.host.frame", frame)).output).toEqual({ viewers: 0, acked: false })
    expect((await knock(RemoteBrowser.socketPath("local", "ses_3"), revoked.auth)).status).toBe(401)
    expect(fx().gateway.openConnections(revoked.deviceId)).toBe(0)
  })

  test("this PC's sessions: an unknown session is 404, a device not allowed `local` is 403", async () => {
    const device = await fx().pair({ scopes: ["read", "prompt", "browser"] })
    const before = fx().service.seen.length
    expect(await knock(RemoteBrowser.socketPath("local", "ses_gone"), device.auth)).toMatchObject({
      status: 404,
      body: { type: "session_not_found" },
    })
    const reads = () => fx().service.seen.slice(before).filter((item) => item.path.startsWith("/api/session/"))
    expect(reads().map((item) => item.path)).toEqual(["/api/session/ses_gone"])
    // An id that is not one path segment of the read never reaches the service.
    for (const id of ["..", "%2e%2e", "ses_1%2F..%2F..%2Finfo", "x"])
      expect({ id, status: (await knock(`${RemoteBrowser.SOCKET_PATH}/local/${id}`, device.auth)).status }).toEqual({ id, status: 404 })
    expect(reads()).toHaveLength(1)
    expect((await knock(`${RemoteBrowser.SOCKET_PATH}/local`, device.auth)).status).toBe(404)
    const hostOnly = await fx().pair({ scopes: ["read", "browser"], servers: { mode: "only", keys: [BrowserGateway.HOST_ID] } })
    expect(await knock(VIEW, hostOnly.auth)).toMatchObject({ status: 403, body: { type: "scope_denied", data: { scope: "server" } } })
    expect(fx().gateway.browser.viewers()).toBe(0)
  })

  test("an SSH host's sessions (05 §8.10.8): this PC's host only, while it is connected, a session it knows", async () => {
    const device = await fx().pair({ scopes: ["read", "prompt", "browser"] })
    const HOSTED = RemoteBrowser.socketPath(BrowserGateway.HOST_ID, "ses_h1")
    // A server that is not one of this PC's hosts is not here; a host of this PC that is not connected cannot say.
    expect(await knock(RemoteBrowser.socketPath("h-zzzzzz", "ses_h1"), device.auth)).toMatchObject({
      status: 404,
      body: { type: "browser_unavailable" },
    })
    expect(await knock(HOSTED, device.auth)).toMatchObject({ status: 503, body: { type: "host_unavailable" } })
    fx().host.ready = true
    try {
      await pull([])
      const before = fx().service.seen.length
      expect(await knock(RemoteBrowser.socketPath(BrowserGateway.HOST_ID, "ses_1"), device.auth)).toMatchObject({
        status: 404,
        body: { type: "session_not_found" },
      })
      // The read goes to the host's service, with the host's token.
      expect(fx().service.seen.slice(before).map((item) => item.path)).toEqual([`${BrowserGateway.HOST_PREFIX}/api/session/ses_1`])
      // A device not allowed that host is refused before anything is read.
      const localOnly = await fx().pair({ scopes: ["read", "browser"], servers: { mode: "only", keys: ["local"] } })
      expect(await knock(HOSTED, localOnly.auth)).toMatchObject({ status: 403, body: { type: "scope_denied", data: { scope: "server" } } })
      // The viewer joins the hub under the host's pane key: wanted with its host, streamed once the shell holds it.
      const view = fx().viewer(device, "ses_h1", { serverKey: BrowserGateway.HOST_ID })
      view.hello()
      await view.ready()
      expect((await view.state("attaching")).tabs).toEqual([])
      expect(fx().events.findLast((event) => event.name === "browser.pane.wanted")).toEqual({
        name: "browser.pane.wanted",
        data: { serverKey: BrowserGateway.HOST_ID, sessionID: "ses_h1" },
      })
      expect((await fx().rpc<{ sessionIDs: string[]; hosts: unknown[] }>("browser.pane.wanted")).output).toMatchObject({
        hosts: [{ serverKey: BrowserGateway.HOST_ID, sessionID: "ses_h1" }],
      })
      const key = RemoteBrowser.paneKey(BrowserGateway.HOST_ID, "ses_h1")
      expect((await pull([key])).views).toEqual([
        { serverKey: BrowserGateway.HOST_ID, sessionID: "ses_h1", mode: "pc", quality: "auto", viewport: { width: 390, height: 800, dpr: 3 } },
      ])
      await fx().rpc("browser.host.state", { host: SHELL, serverKey: BrowserGateway.HOST_ID, sessionID: "ses_h1", state: PANE })
      // The shell's pull already made the pane `ready` with no tabs (the hub's empty pane): wait for PANE's state.
      const shown = await eventually(() => view.state("ready"), (state) => state.tabs.length > 0)
      expect(shown.tabs[0]?.url).toBe(PANE.tabs[0]!.url)
      view.send({ t: "input", events: [TAP] })
      const commands = await eventually(
        async () => (await pull([key])).commands,
        (list) => list.length > 0,
      )
      expect(commands).toEqual([{ type: "input", serverKey: BrowserGateway.HOST_ID, sessionID: "ses_h1", events: [TAP] }])
      view.close()
      await eventually(() => fx().gateway.browser.viewers(), (count) => count === 0)
    } finally {
      fx().host.ready = false
      await pull([])
    }
  })

  test("the shell's methods are never a device's: browser.host.* and browser.pane.wanted are 403; browser.status is read", async () => {
    const every = await fx().pair({ scopes: OwnRemote.DEVICE_SCOPES })
    const before = fx().service.seen.length
    for (const method of ["browser.host.pull", "browser.host.frame", "browser.host.state", "browser.host.result", "browser.pane.wanted"]) {
      const response = await every.post(`/srv/local/api/rpc/own.remote/${method}`, { input: { host: SHELL, windows: 1, hosted: [], waitMs: 0 } })
      expect({ method, status: response.status, body: await response.json() }).toMatchObject({
        method,
        status: 403,
        body: { type: "scope_denied", data: { scope: "local" } },
      })
    }
    expect(fx().service.seen.slice(before).filter((item) => item.path.includes("/rpc/"))).toEqual([])
    await pull([])
    const reader = await fx().pair({ scopes: ["read"] })
    const status = await reader.post("/srv/local/api/rpc/own.remote/browser.status", { input: {} })
    expect({ status: status.status, body: await status.json() }).toEqual({ status: 200, body: { output: { desktop: true } } })
    const none = await fx().pair({ scopes: ["prompt", "browser"] })
    expect((await none.post("/srv/local/api/rpc/own.remote/browser.status", { input: {} })).status).toBe(403)
    // Core's own browser RPC stays closed to devices, as before.
    expect((await every.post("/srv/local/api/rpc/experimental.browser/tabs.list", { input: {} })).status).toBe(403)
  })

  test("CSRF: a cookie upgrade needs the gateway's origin; an app's Bearer does not", async () => {
    const device = await fx().pair({ scopes: ["read", "browser"] })
    const cookie = { cookie: device.auth.cookie! }
    expect(await knock(VIEW, cookie)).toMatchObject({ status: 403, body: { type: "scope_denied", data: { scope: "origin" } } })
    expect((await knock(VIEW, { ...cookie, origin: "https://evil.example" })).status).toBe(403)
    expect((await knock(VIEW, { ...cookie, origin: fx().base, "sec-fetch-site": "cross-site" })).status).toBe(403)
    const cross = fx().viewer(device, "ses_1", { headers: { ...cookie, origin: "https://evil.example" } })
    expect(await cross.opened).toBe(false)
    expect(fx().gateway.browser.viewers()).toBe(0)
    expect((await knock(VIEW, device.auth)).status).toBe(101)
    const app = await fx().pair({ scopes: ["read", "browser"], kind: "app" })
    expect((await knock(VIEW, app.auth)).status).toBe(101)
    await eventually(() => fx().gateway.browser.viewers(), (count) => count === 0)
  })

  test("the event that asks the window for a pane never reaches a device's event stream", async () => {
    const device = await fx().pair({ scopes: OwnRemote.DEVICE_SCOPES })
    await pull([])
    const stream = await device.get("/srv/local/api/event")
    const reader = stream.body!.getReader()
    const read = { text: "" }
    const pump = (async () => {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        read.text += new TextDecoder().decode(next.value)
      }
    })()
    await eventually(() => read.text, (text) => text.includes("server.connected"))
    const before = fx().events.length
    fx().gateway.browser.want("ses_2")
    expect(fx().events.slice(before)).toEqual([{ name: "browser.pane.wanted", data: { sessionID: "ses_2" } }])
    // A `read` event after it marks the place in the stream.
    const marker = await fx().pair({ name: "표시", scopes: ["read"] })
    await eventually(() => read.text, (text) => text.includes(marker.deviceId))
    expect(read.text).toContain("rpc.own.remote.device.paired")
    expect(read.text).not.toContain("browser.pane.wanted")
    await reader.cancel()
    await pump
    // The window itself asks the service, not the gateway.
    expect((await fx().rpc<{ sessionIDs: string[] }>("browser.pane.wanted")).output.sessionIDs).toContain("ses_2")
  })
})

describe("a device's prompt and the session's pane (05 §8.10.5)", () => {
  const prompt = async (device: BrowserGateway.Device, sessionID: string) => {
    const started = Date.now()
    const response = await device.post(`/srv/local/api/session/${sessionID}/prompt`, { text: "안녕" })
    const forwarded = fx().service.seen.findLast((item) => item.method === "POST" && item.path === `/api/session/${sessionID}/prompt`)
    return { status: response.status, ms: Date.now() - started, forwarded }
  }
  const wantedFor = (sessionID: string) =>
    fx().events.filter((event) => event.name === "browser.pane.wanted" && event.data.sessionID === sessionID).length

  test("with a desktop app, the pane is asked for and the prompt goes on once the shell holds it", async () => {
    // A device without `browser` gets this too: the scope is about watching, not about the agent's tools.
    const phone = await fx().pair({ scopes: ["read", "prompt"] })
    await pull([])
    const sent = prompt(phone, "ses_wait")
    await eventually(() => wantedFor("ses_wait"), (count) => count > 0)
    expect(wantedFor("ses_wait")).toBe(1)
    await Bun.sleep(300)
    expect(fx().service.seen.some((item) => item.path === "/api/session/ses_wait/prompt")).toBe(false)
    const attached = Date.now()
    await pull(["ses_wait"])
    const result = await sent
    expect(result.status).toBe(200)
    expect(result.forwarded!.at).toBeGreaterThanOrEqual(attached)
    expect(result.ms).toBeLessThan(PANE_WAIT_MS - 500)
    expect(JSON.parse(result.forwarded!.body)).toMatchObject({ text: "안녕", metadata: { "own.device": { scopes: ["prompt", "read"] } } })
    // Held already: no wait, no event.
    const next = await prompt(phone, "ses_wait")
    expect(next.ms).toBeLessThan(1000)
    expect(wantedFor("ses_wait")).toBe(1)
  })

  test("a prompt on an SSH host waits for that host's pane the same way; its rules are read from the host", async () => {
    const phone = await fx().pair({ scopes: ["read", "prompt"] })
    fx().host.ready = true
    try {
      await pull([])
      const route = (sessionID: string) => `/srv/${BrowserGateway.HOST_ID}/api/session/${sessionID}/prompt`
      const send = async (sessionID: string) => {
        const started = Date.now()
        const response = await phone.post(route(sessionID), { text: "안녕" })
        return { status: response.status, ms: Date.now() - started }
      }
      const asked = () =>
        fx().events.filter(
          (event) =>
            event.name === "browser.pane.wanted" &&
            event.data.serverKey === BrowserGateway.HOST_ID &&
            event.data.sessionID === "ses_hwait",
        ).length
      const sent = send("ses_hwait")
      await eventually(asked, (count) => count > 0)
      expect(fx().service.seen.some((item) => item.path === `${BrowserGateway.HOST_PREFIX}/api/session/ses_hwait/prompt`)).toBe(false)
      await pull([RemoteBrowser.paneKey(BrowserGateway.HOST_ID, "ses_hwait")])
      const result = await sent
      expect(result.status).toBe(200)
      expect(result.ms).toBeLessThan(PANE_WAIT_MS - 500)
      expect(fx().service.seen.some((item) => item.path === `${BrowserGateway.HOST_PREFIX}/api/session/ses_hwait/prompt`)).toBe(true)
      // A local session of the same name is another pane: not hosted by the host's.
      expect(fx().gateway.browser.hosted("ses_hwait")).toBe(false)
      // The host's rules take the browser away: nothing is asked.
      const off = await send("ses_hoff")
      expect(off.ms).toBeLessThan(1000)
      expect(fx().events.some((event) => event.name === "browser.pane.wanted" && event.data.sessionID === "ses_hoff")).toBe(false)
    } finally {
      fx().host.ready = false
      await pull([])
    }
  }, 20_000)

  test("a pane that does not come holds the prompt for 3 s once; rules that remove the browser, or no desktop, not at all", async () => {
    const phone = await fx().pair({ scopes: ["read", "prompt"] })
    await pull([])
    const slow = await prompt(phone, "ses_never")
    expect(slow.status).toBe(200)
    expect(slow.ms).toBeGreaterThanOrEqual(PANE_WAIT_MS - 100)
    expect(slow.ms).toBeLessThan(PANE_WAIT_MS + 2000)
    expect(wantedFor("ses_never")).toBe(1)
    // The same session again: sent at once (and still wanted, for a later step).
    await pull([])
    const again = await prompt(phone, "ses_never")
    expect(again.ms).toBeLessThan(1000)
    // `browser * deny` last: the window would not attach it, so nothing is asked.
    const off = await prompt(phone, "ses_off")
    expect(off.status).toBe(200)
    expect(off.ms).toBeLessThan(1000)
    expect(wantedFor("ses_off")).toBe(0)
    // The deny is not the last word: asked like any session.
    const on = prompt(phone, "ses_on")
    await eventually(() => wantedFor("ses_on"), (count) => count > 0)
    await pull(["ses_on"])
    expect((await on).ms).toBeLessThan(PANE_WAIT_MS - 500)
    // A session the service does not know is the service's to refuse: forwarded without a wait.
    const gone = await prompt(phone, "ses_gone")
    expect(gone.forwarded).toBeDefined()
    expect(gone.ms).toBeLessThan(1000)
    expect(wantedFor("ses_gone")).toBe(0)
    // No window: nothing can attach.
    await pull([], { windows: 0 })
    const asked = wantedFor("ses_1")
    const closed = await prompt(phone, "ses_1")
    expect(closed.ms).toBeLessThan(1000)
    expect(wantedFor("ses_1")).toBe(asked)
  }, 20_000)
})

// Boots the upstream server from source (own-accounts' e2e kit) with own-remote loaded from its package directory,
// once per mode, and checks the RPC wiring end to end: the `own.remote` definition under the real core RPC,
// declared errors as HTTP 400, the agent-only registration of a remote service, and guard 1. One test runs the browser
// pane on a device (05 §8.10) through all of it: the gateway opened by RPC, a device paired with `browser`, the viewer
// socket, and the shell's `browser.host.*` calls with the service password.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { OwnRemote } from "../src/protocol/rpc-remote.js"
import { recordServerEvents, REPO_ROOT, startOpencodeServer, type OpencodeServer } from "../../own-accounts/test/e2e-kit"
import { BrowserGateway } from "./harness/browser-gateway.js"

const BOOT_TIMEOUT = 180_000
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")

async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnRemote.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> }
}

describe("own-remote on a real server", () => {
  const state: { local?: OpencodeServer; agent?: OpencodeServer; unmanaged?: OpencodeServer } = {}

  beforeAll(async () => {
    const [local, agent, unmanaged] = await Promise.all([
      startOpencodeServer({
        config: (paths) => {
          const sshDir = path.join(paths.root, "dot-ssh")
          fs.mkdirSync(sshDir, { recursive: true })
          fs.writeFileSync(path.join(sshDir, "config"), "Host devbox\n  HostName devbox.test\nHost lab-7676\n  LocalForward 7676 127.0.0.1:7676\n")
          return {
            update: "disable",
            share: "disabled",
            providers: {},
            plugins: [
              {
                package: REMOTE,
                options: {
                  home: paths.ownHome,
                  buildId: "e2e-remote-local",
                  version: "2.0.18-own.9",
                  sshDir,
                  sshCommand: ["C:\\definitely\\not\\ssh.exe"],
                  lingerSeconds: 0,
                  // The gateway stays off until a test turns it on; then it reaches this server through this file.
                  gateway: {
                    registration: path.join(paths.root, "service-registration.json"),
                    tailscaleCommand: null,
                    portproxyCommand: null,
                    vault: "memory",
                  },
                },
              },
            ],
          }
        },
        env: { OWN_OPEN_CODE: "1" },
      }),
      startOpencodeServer({
        config: (paths) => ({
          update: "disable",
          share: "disabled",
          providers: {},
          plugins: [{ package: REMOTE, options: { mode: "agent", home: paths.ownHome, buildId: "e2e-remote-agent" } }],
        }),
        env: { OWN_REMOTE: "1" },
      }),
      startOpencodeServer({
        config: (paths) => ({
          update: "disable",
          share: "disabled",
          providers: {},
          plugins: [{ package: REMOTE, options: { home: paths.ownHome, buildId: "e2e-remote-unmanaged", version: "2.0.18-own.9" } }],
        }),
        env: { OWN_OPEN_CODE: undefined },
      }),
    ])
    state.local = local
    state.agent = agent
    state.unmanaged = unmanaged
    // Plugins load in the background since upstream v2.4.0 (#63814): wait until own-remote has loaded everywhere.
    await Promise.all([local.waitForPlugins(1), agent.waitForPlugins(1), unmanaged.waitForPlugins(1)])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await Promise.all([state.local?.stop(), state.agent?.stop(), state.unmanaged?.stop()])
  }, 60_000)

  test("local mode: discover, add, list; declared errors are HTTP 400; agent.* is not served locally", async () => {
    const server = state.local!
    const discover = await rpc(server, "hosts.discover")
    expect(discover.status).toBe(200)
    expect(discover.body.output.aliases).toEqual([
      expect.objectContaining({ alias: "devbox", forwards: "none", known: false }),
      expect.objectContaining({ alias: "lab-7676", forwards: "yes", localhostForward: true }),
    ])
    const added = await rpc(server, "hosts.add", { alias: "devbox" })
    expect(added.status).toBe(200)
    const host = added.body.output.host
    expect(host).toMatchObject({ alias: "devbox", stage: "disconnected", paused: true, projectConfig: "instructions" })
    expect(host.loopback).toMatch(/^127\.0\.\d+\.2$/)
    const list = await rpc(server, "hosts.list")
    expect(list.body.output.hosts).toHaveLength(1)
    // The configured ssh does not exist: connect fails with ssh_missing and pauses; no process was started.
    const connect = await rpc(server, "connect", { hostId: host.id, clientId: "tab-1" })
    expect(connect.status).toBe(200)
    await Bun.sleep(500)
    const after = (await rpc(server, "hosts.list")).body.output.hosts[0]
    expect(after).toMatchObject({ error: "ssh_missing", paused: true })
    const stale = await rpc(server, "prepare.execute", { nonce: "nonce-never-issued-0000" })
    expect(stale.status).toBe(400)
    expect(stale.body).toMatchObject({ type: "nonce_invalid" })
    const missing = await rpc(server, "resolve", { hostId: "h-zzzzzz" })
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ type: "host_not_found", data: { hostId: "h-zzzzzz" } })
    const agentHere = await rpc(server, "agent.status")
    expect(agentHere.status).toBe(400)
    expect(agentHere.body).toMatchObject({ type: "not_supported" })
    const bad = await rpc(server, "hosts.add", { target: "ssh -o ProxyCommand=calc host", name: "x" })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ type: "input_invalid" })
    // hosts.json holds no secret-looking value; the registry lives under OWN_HOME\remote.
    const hosts = fs.readFileSync(path.join(server.paths.ownHome, "remote", "hosts.json"), "utf8")
    expect(JSON.parse(hosts).hosts[0].id).toBe(host.id)
    // Its lines also land in OWN_HOME\logs\own-remote.log: nobody reads an installed service's stderr.
    const logged = fs.readFileSync(path.join(server.paths.ownHome, "logs", "own-remote.log"), "utf8")
    expect(logged).toContain('"msg":"ready"')
  }, 60_000)

  test("local mode: the browser pane on a device, from the paired device to the shell's RPC (05 §8.10)", async () => {
    const server = state.local!
    const shell = "shell-e2e-0001"
    const pull = async (hosted: ReadonlyArray<string>, waitMs = 0) =>
      (await rpc(server, "browser.host.pull", { host: shell, windows: 1, hosted, waitMs })).body.output as {
        views: RemoteBrowser.HostView[]
        commands: RemoteBrowser.HostCommand[]
        idle: boolean
      }
    // Nothing runs yet: no desktop app, and with the gateway off the shell is told to idle.
    expect((await rpc(server, "browser.status")).body.output).toEqual({ desktop: false })
    expect(await pull([], 30_000)).toEqual({ views: [], commands: [], idle: true })
    expect((await rpc(server, "browser.status")).body.output).toEqual({ desktop: true })
    expect((await rpc(server, "browser.pane.wanted")).body.output).toEqual({ sessionIDs: [], hosts: [] })
    // The input schema is the definition's: a host id too short, a wait too long.
    expect((await rpc(server, "browser.host.pull", { host: "x", windows: 1, hosted: [], waitMs: 0 })).status).toBe(400)
    expect((await rpc(server, "browser.host.pull", { host: shell, windows: 1, hosted: [], waitMs: 30_001 })).status).toBe(400)

    // The gateway on a free loopback port, reaching this server with its password.
    const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
    fs.writeFileSync(path.join(server.paths.root, "service-registration.json"), JSON.stringify({ url: server.url, password }))
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer()
      probe.listen(0, "127.0.0.1", () => {
        const free = (probe.address() as net.AddressInfo).port
        probe.close(() => resolve(free))
      })
    })
    const plan = await rpc(server, "gateway.configure.plan", { port })
    expect(plan.status).toBe(200)
    const opened = await rpc(server, "gateway.configure.execute", { nonce: plan.body.output.nonce })
    expect(opened.body.output).toMatchObject({ state: "listening", url: `http://127.0.0.1:${port}` })
    const base = opened.body.output.url as string
    try {
      // A device paired as an app, with `browser` granted at pairing (the PC's dialog).
      const started = await rpc(server, "devices.pair.start", {
        name: "휴대폰",
        scopes: ["read", "prompt", "browser"],
        servers: { mode: "all" },
        expiresDays: 30,
      })
      expect(started.status).toBe(200)
      const link = (await (await fetch(started.body.output.url, { headers: { accept: "application/json" } })).json()) as {
        claim: string
        sas: string
      }
      expect((await rpc(server, "devices.pair.approve", { pairingId: started.body.output.pairingId, sas: link.sas })).status).toBe(200)
      const claimed = (await (
        await fetch(`${base}/own/pairing/claim`, { method: "POST", headers: { "x-own-pairing": link.claim, "content-type": "application/json" }, body: "{}" })
      ).json()) as { deviceId: string; token: string }
      const auth = { authorization: `Bearer ${claimed.token}` }
      expect(((await (await fetch(`${base}/own/device`, { headers: auth })).json()) as { scopes: string[] }).scopes).toEqual([
        "read",
        "prompt",
        "browser",
      ])
      const listed = (await rpc(server, "devices.list")).body.output.devices as Array<{ deviceId: string; scopes: string[] }>
      expect(listed.find((device) => device.deviceId === claimed.deviceId)?.scopes).toEqual(["read", "prompt", "browser"])
      // Through the gateway the device reads the status and nothing of the shell's.
      const viaGateway = (method: string) =>
        fetch(`${base}/srv/local/api/rpc/own.remote/${method}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ input: { host: shell, windows: 1, hosted: [], waitMs: 0 } }),
        })
      expect((await viaGateway("browser.host.pull")).status).toBe(403)
      const status = await viaGateway("browser.status")
      expect({ status: status.status, body: await status.json() }).toEqual({ status: 200, body: { output: { desktop: true } } })

      const session = await server.createSession({ title: "브라우저" })
      const events = await recordServerEvents(server)
      const view = BrowserGateway.viewer(base, { auth }, session.id)
      expect(await view.opened).toBe(true)
      view.hello({ mode: "phone" })
      expect(await view.ready()).toEqual({ t: "ready", v: 1, control: true })
      // No pane yet: the window is asked by event (published by the leader with an event id) and by the method.
      expect(await view.state("attaching")).toEqual({ ...RemoteBrowser.EMPTY_PANE, host: "attaching" })
      const wanted = await events.waitFor((event) => event.type === "rpc.own.remote.browser.pane.wanted", 10_000)
      expect(wanted.data).toEqual({ eventId: expect.any(String), sessionID: session.id })
      expect((await rpc(server, "browser.pane.wanted")).body.output).toEqual({ sessionIDs: [session.id], hosts: [] })
      await events.close()
      // The shell holds the pane: the view is wanted at once, with the viewer's mode and viewport.
      expect(await pull([session.id], 30_000)).toEqual({
        views: [{ sessionID: session.id, mode: "phone", quality: "auto", viewport: { width: 390, height: 800, dpr: 3 } }],
        commands: [],
        idle: false,
      })
      await view.state("ready")
      expect((await rpc(server, "browser.pane.wanted")).body.output).toEqual({ sessionIDs: [], hosts: [] })
      // The long poll waits when nothing changed, and wakes on the device's input.
      const quiet = Date.now()
      expect((await pull([session.id], 1500)).commands).toEqual([])
      expect(Date.now() - quiet).toBeGreaterThanOrEqual(1400)
      const tap: RemoteBrowser.InputEvent = { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] }
      const waiting = pull([session.id], 30_000)
      await Bun.sleep(200)
      const sent = Date.now()
      view.send({ t: "input", events: [tap, { k: "text", text: "한글" }] })
      expect((await waiting).commands).toEqual([{ type: "input", sessionID: session.id, events: [tap, { k: "text", text: "한글" }] }])
      expect(Date.now() - sent).toBeLessThan(5000)
      // An action and its answer.
      view.send({ t: "action", id: 4, action: { type: "navigate", url: "https://example.com/" } })
      const [action] = (await pull([session.id], 5000)).commands
      expect(action).toMatchObject({ type: "action", sessionID: session.id, action: { type: "navigate", url: "https://example.com/" } })
      expect((await rpc(server, "browser.host.result", { host: shell, id: action?.type === "action" ? action.id : "", ok: false, error: "browser.address.blocked" })).status).toBe(200)
      expect(await view.result(4)).toEqual({ t: "result", id: 4, ok: false, error: "browser.address.blocked" })
      // The pane's state and a frame.
      const pane: RemoteBrowser.PaneState = {
        tabs: [{ id: "t1", url: "http://localhost:5173/", title: "앱", loading: true, canGoBack: false, canGoForward: false }],
        focusedTabID: "t1",
        page: { mode: "phone", width: 390, height: 800 },
        dialog: { type: "confirm", message: "지울까요?", defaultPrompt: "" },
      }
      expect((await rpc(server, "browser.host.state", { host: shell, sessionID: session.id, state: pane, notice: "file_chooser" })).status).toBe(200)
      expect(await view.until(() => view.messages.findLast((message) => message.t === "state" && message.state.tabs.length > 0))).toEqual({
        t: "state",
        state: { ...pane, host: "ready" },
      })
      const data = BrowserGateway.jpeg(3, 4096)
      const pushed = rpc(server, "browser.host.frame", { host: shell, sessionID: session.id, width: 390, height: 800, sharp: false, data })
      const frame = await view.frame()
      expect(frame.header).toMatchObject({ width: 390, height: 800, sharp: false })
      expect(Buffer.from(frame.jpeg).toString("base64")).toBe(data)
      view.send({ t: "ack", seq: frame.header.seq })
      expect((await pushed).body.output).toEqual({ viewers: 1, acked: true })
      const refused = await rpc(server, "browser.host.frame", { host: shell, sessionID: session.id, width: 390, height: 800, sharp: false, data: "AAAA" })
      expect(refused.status).toBe(400)
      expect(refused.body).toMatchObject({ type: "input_invalid", data: { field: "data", reason: "not_jpeg" } })
      // The PC takes `browser` away: the socket closes, nothing is streamed, a frame finds nobody.
      expect((await rpc(server, "devices.update", { deviceId: claimed.deviceId, scopes: ["read", "prompt"] })).status).toBe(200)
      expect(await view.closed).toMatchObject({ code: RemoteBrowser.CLOSE.scope })
      expect((await pull([session.id])).views).toEqual([])
      expect((await rpc(server, "browser.host.frame", { host: shell, sessionID: session.id, width: 390, height: 800, sharp: false, data })).body.output).toEqual({
        viewers: 0,
        acked: false,
      })
      const again = BrowserGateway.viewer(base, { auth }, session.id)
      expect(await again.opened).toBe(false)
      // devices.json keeps the new scope apart, and nothing of the page is in own-remote's log.
      const stored = JSON.parse(fs.readFileSync(path.join(server.paths.ownHome, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> }
      expect(stored.devices[0]).toMatchObject({ scopes: ["read", "prompt"] })
      expect(Object.keys(stored.devices[0]!)).not.toContain("extraScopes")
      const logged = fs.readFileSync(path.join(server.paths.ownHome, "logs", "own-remote.log"), "utf8")
      expect(logged).toContain('"msg":"browser_view_opened"')
      expect(logged).toContain('"msg":"browser_view_closed"')
      for (const secret of ["localhost:5173", "example.com", "한글", "지울까요"]) expect(logged).not.toContain(secret)
    } finally {
      // Off again: the gateway holds no pin when the server stops.
      expect((await rpc(server, "gateway.disable")).body.output).toMatchObject({ enabled: false, state: "off" })
    }
  }, 90_000)

  test("agent mode: only agent.* is registered", async () => {
    const server = state.agent!
    // A host's agent keeps stderr only (no own-remote.log there).
    expect(fs.existsSync(path.join(server.paths.ownHome, "logs", "own-remote.log"))).toBe(false)
    const real = await rpc(server, "agent.realpath", { path: server.paths.workspace })
    expect(real.status).toBe(200)
    expect(real.body.output).toMatchObject({ exists: true, isSymlink: false })
    const status = await rpc(server, "agent.status")
    expect(status.status).toBe(200)
    expect(status.body.output).toMatchObject({ proto: 1, broker: { state: "unavailable" }, owner: { installId: null } })
    const arm = await rpc(server, "agent.broker.arm", {
      hostId: "h-abcdef",
      epoch: 1,
      key: Buffer.alloc(32, 7).toString("base64url"),
      endpoint: { tcpPort: 40000 },
      proto: 1,
    })
    expect(arm.status).toBe(200)
    expect(arm.body.output).toEqual({ accepted: false, reason: "unavailable" })
    const skew = await rpc(server, "agent.broker.arm", {
      hostId: "h-abcdef",
      epoch: 1,
      key: Buffer.alloc(32, 7).toString("base64url"),
      endpoint: { tcpPort: 40000 },
      proto: 9,
    })
    expect(skew.body.output).toEqual({ accepted: false, reason: "proto" })
    const probe = await rpc(server, "agent.probe", { commands: ["curl"] })
    expect(probe.status).toBe(400)
    expect(probe.body).toMatchObject({ type: "input_invalid" })
    const local = await rpc(server, "hosts.list")
    expect(local.status).toBe(400)
    expect(["rpc.method_not_found", "rpc.unavailable"]).toContain(local.body.type)
  }, 60_000)

  test("guard 1: without OWN_OPEN_CODE=1 nothing is registered", async () => {
    const list = await rpc(state.unmanaged!, "hosts.list")
    expect(list.status).toBe(400)
    expect(["rpc.method_not_found", "rpc.unavailable"]).toContain(list.body.type)
  }, 30_000)
})

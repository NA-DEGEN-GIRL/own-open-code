// Gateway units: loopback-only binds (MG1), pairing codes and SAS (MG2), the hashed device store (MG4, MG8), and the
// feed's team decisions from this PC and from a ready host (06 §9.8).
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ServiceTarget } from "@own/runtime"
import { GatewayConfig } from "../../src/gateway/config.js"
import { Devices } from "../../src/gateway/devices.js"
import { Feed } from "../../src/gateway/feed.js"
import { Pairing } from "../../src/gateway/pairing.js"
import { Tailscale } from "../../src/gateway/tailscale.js"
import { summarizeAgent } from "../../src/gateway/server.js"
import { Log } from "../../src/log.js"
import type { OwnRemote } from "../../src/protocol/rpc-remote.js"

const roots: string[] = []
function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-gw-unit-"))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

describe("bind (05 §13.3, MG1)", () => {
  test("loopback only; LAN, link-local, CGNAT, any-address and names are bind_rejected_lan", () => {
    expect(GatewayConfig.checkBind("127.0.0.1")).toEqual({ ok: true, address: "127.0.0.1" })
    expect(GatewayConfig.checkBind("localhost")).toEqual({ ok: true, address: "127.0.0.1" })
    expect(GatewayConfig.checkBind("::1").ok).toBe(true)
    for (const address of [
      "0.0.0.0",
      "::",
      "192.168.0.10",
      "10.0.0.5",
      "172.16.3.4",
      "169.254.10.1",
      "fe80::1",
      "100.101.102.103",
      "8.8.8.8",
      "my-pc.local",
      "::ffff:192.168.0.1",
    ])
      expect({ address, result: GatewayConfig.checkBind(address) }).toMatchObject({ address, result: { ok: false, reason: "lan" } })
  })

  test("public origin: https, or a loopback http origin; never LAN http", () => {
    expect(GatewayConfig.checkOrigin("https://pc.tailnet.ts.net")).toBe("https://pc.tailnet.ts.net")
    expect(GatewayConfig.checkOrigin("http://127.0.0.1:28539")).toBe("http://127.0.0.1:28539")
    expect(GatewayConfig.checkOrigin("http://192.168.0.2:28539")).toBeUndefined()
    expect(GatewayConfig.checkOrigin("https://pc.tailnet.ts.net/path")).toBeUndefined()
    expect(GatewayConfig.checkOrigin("https://user:pw@pc.tailnet.ts.net")).toBeUndefined()
  })

  test("a hand-edited LAN bind loads as off", async () => {
    const home = tempHome()
    fs.writeFileSync(
      GatewayConfig.file(home),
      JSON.stringify({ version: 1, enabled: true, bind: "0.0.0.0", port: 28539, publicOrigin: null, updatedAt: 1 }),
    )
    const loaded = await GatewayConfig.load(home)
    expect(loaded).toMatchObject({ enabled: false, bind: "127.0.0.1" })
  })
})

describe("pairing (05 §13.5, MG2)", () => {
  const request = { name: "휴대폰", scopes: ["read", "prompt", "switch"] as const, servers: { mode: "all" } as const, expiresDays: 30 }

  function book(now: { value: number }) {
    const ended: string[] = []
    const pending: string[] = []
    const pairings = new Pairing.Book({
      now: () => now.value,
      events: { pending: (entry) => pending.push(entry.pairingId), ended: (_entry, reason) => ended.push(reason) },
    })
    return { pairings, ended, pending }
  }

  test("normal: open once → pending with a 4-digit SAS → approve with that SAS → one claim", () => {
    const now = { value: 1_000_000 }
    const { pairings, pending, ended } = book(now)
    const { entry, code } = pairings.start({ ...request, scopes: [...request.scopes] })
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(entry.expiresAt - now.value).toBe(Pairing.CODE_TTL_MS)
    const opened = pairings.open(code, { userAgent: "Safari · iOS", tailscaleUser: null, ip: "100.64.0.2" })!
    expect(opened.entry.sas).toMatch(/^\d{4}$/)
    expect(pending).toEqual([entry.pairingId])
    // Reusing the code fails: it was consumed.
    expect(pairings.open(code, { userAgent: null, tailscaleUser: null, ip: null })).toBeUndefined()
    expect(pairings.status(opened.claim)).toMatchObject({ state: "pending", sas: opened.entry.sas })
    expect(pairings.claim(opened.claim)).toBeUndefined()
    const approved = pairings.approve(entry.pairingId, opened.entry.sas!)
    expect(approved.ok).toBe(true)
    expect(pairings.status(opened.claim)).toMatchObject({ state: "approved" })
    expect(pairings.claim(opened.claim)?.deviceId).toBe(entry.deviceId)
    expect(pairings.claim(opened.claim)).toBeUndefined()
    expect(pairings.status(opened.claim)).toEqual({ state: "claimed" })
    expect(ended).toEqual(["claimed"])
  })

  test("SAS mismatch cancels; PC reject; expiry after 5 minutes; approval window 2 minutes", () => {
    const now = { value: 5_000_000 }
    const { pairings, ended } = book(now)
    const a = pairings.start({ ...request, scopes: [...request.scopes] })
    const openedA = pairings.open(a.code, { userAgent: null, tailscaleUser: null, ip: null })!
    const wrong = openedA.entry.sas === "0000" ? "0001" : "0000"
    expect(pairings.approve(a.entry.pairingId, wrong)).toMatchObject({ ok: false, error: "pairing_rejected", reason: "sas_mismatch" })
    expect(pairings.approve(a.entry.pairingId, openedA.entry.sas!)).toMatchObject({ ok: false, error: "pairing_expired" })
    expect(pairings.status(openedA.claim)).toEqual({ state: "rejected" })

    const b = pairings.start({ ...request, scopes: [...request.scopes] })
    const openedB = pairings.open(b.code, { userAgent: null, tailscaleUser: null, ip: null })!
    pairings.cancel(b.entry.pairingId)
    expect(pairings.status(openedB.claim)).toEqual({ state: "rejected" })

    const c = pairings.start({ ...request, scopes: [...request.scopes] })
    expect(pairings.approve(c.entry.pairingId, "1234")).toMatchObject({ ok: false, error: "pairing_rejected", reason: "not_pending" })
    now.value += Pairing.CODE_TTL_MS + 1
    expect(pairings.open(c.code, { userAgent: null, tailscaleUser: null, ip: null })).toBeUndefined()

    const d = pairings.start({ ...request, scopes: [...request.scopes] })
    const openedD = pairings.open(d.code, { userAgent: null, tailscaleUser: null, ip: null })!
    now.value += Pairing.APPROVAL_TTL_MS + 1
    expect(pairings.approve(d.entry.pairingId, openedD.entry.sas!)).toMatchObject({ ok: false, error: "pairing_expired" })
    expect(pairings.status(openedD.claim)).toEqual({ state: "expired" })
    expect(ended).toEqual(["rejected", "rejected", "expired", "expired"])
    expect(pairings.list()).toEqual([])
  })

  test("a device that stops polling is reported once as silent, and again when it is back", () => {
    const now = { value: 7_000_000 }
    const seen: string[] = []
    const pairings = new Pairing.Book({
      now: () => now.value,
      events: {
        pending: () => {},
        ended: () => {},
        silent: (entry, ms) => seen.push(`silent ${entry.state} ${ms}`),
        back: (entry, ms) => seen.push(`back ${entry.state} ${ms}`),
      },
    })
    const { entry, code } = pairings.start({ ...request, scopes: [...request.scopes] })
    // A code nobody opened yet is not a device going quiet.
    now.value += Pairing.SILENT_MS
    pairings.sweep()
    expect(seen).toEqual([])
    const opened = pairings.open(code, { userAgent: null, tailscaleUser: null, ip: null })!
    now.value += 1000
    pairings.status(opened.claim)
    now.value += Pairing.SILENT_MS - 1
    pairings.sweep()
    expect(seen).toEqual([])
    now.value += 1
    pairings.sweep()
    now.value += 5000
    pairings.sweep()
    expect(seen).toEqual([`silent pending ${Pairing.SILENT_MS}`])
    expect(pairings.approve(entry.pairingId, opened.entry.sas!).ok).toBe(true)
    pairings.status(opened.claim)
    pairings.status(opened.claim)
    expect(seen).toEqual([`silent pending ${Pairing.SILENT_MS}`, `back approved ${Pairing.SILENT_MS + 5000}`])
  })

  test("brute force: 5 bad codes per address, 30 in total, then a minute's wait", () => {
    const now = { value: 0 }
    const limiter = new Pairing.Limiter({ now: () => now.value })
    for (let i = 0; i < 4; i++) limiter.fail("100.64.0.9")
    expect(limiter.blocked("100.64.0.9")).toBe(false)
    limiter.fail("100.64.0.9")
    expect(limiter.blocked("100.64.0.9")).toBe(true)
    expect(limiter.blocked("100.64.0.10")).toBe(false)
    now.value += 61_000
    expect(limiter.blocked("100.64.0.9")).toBe(false)
    for (let i = 0; i < 30; i++) limiter.fail(`100.64.1.${i}`)
    expect(limiter.blocked("100.64.2.1")).toBe(true)
  })
})

describe("device store (05 §13.5 저장)", () => {
  test("only the token hash is stored; verify, revoke, expiry, idle expiry", async () => {
    const home = tempHome()
    const now = { value: Date.UTC(2026, 8, 27) }
    const store = new Devices.Store({ ownHome: home, now: () => now.value })
    await store.load()
    const { record, token } = await store.create({
      deviceId: Devices.newDeviceId(),
      name: "휴대폰",
      kind: "browser",
      scopes: ["read", "prompt"],
      servers: { mode: "all" },
      expiresDays: 30,
      userAgent: "Chrome · Android",
      ip: "100.64.0.2",
    })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const file = fs.readFileSync(path.join(home, "devices.json"), "utf8")
    expect(file).not.toContain(token)
    expect(file).toContain(`sha256:`)
    expect((await store.verify(token)).ok).toBe(true)
    expect((await store.verify(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).ok).toBe(false)
    // idle 14 days → expired
    now.value += 15 * 24 * 3600_000
    expect(await store.verify(token)).toMatchObject({ ok: false, reason: "expired" })
    now.value -= 15 * 24 * 3600_000
    await store.revoke(record.deviceId)
    expect(await store.verify(token)).toMatchObject({ ok: false, reason: "revoked", deviceId: record.deviceId })
    // A second store (another reader) sees the revocation from the file.
    const other = new Devices.Store({ ownHome: home, now: () => now.value })
    expect(await other.verify(token)).toMatchObject({ ok: false, reason: "revoked" })
    expect(Devices.view(other.get(record.deviceId)!, now.value).state).toBe("revoked")
  })
})

describe("tailscale detection is read-only parsing", () => {
  test("status and serve JSON", () => {
    expect(
      Tailscale.parseStatus(JSON.stringify({ BackendState: "Running", Version: "1.88.1-t123", Self: { DNSName: "my-pc.tail1234.ts.net." } })),
    ).toEqual({ state: "running", version: "1.88.1", dnsName: "my-pc.tail1234.ts.net" })
    expect(Tailscale.parseStatus(JSON.stringify({ BackendState: "NeedsLogin" }))?.state).toBe("logged_out")
    expect(Tailscale.parseStatus("nope")).toBeUndefined()
    const proxies = Tailscale.parseServe(
      JSON.stringify({ Web: { "my-pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:28539" } } } } }),
    )
    expect(proxies).toEqual(["http://127.0.0.1:28539"])
    const view = Tailscale.view({ state: "running", version: "1.88.1", dnsName: "my-pc.tail1234.ts.net", proxies }, 28539)
    expect(view).toMatchObject({ serving: true, serveCommand: "tailscale serve --bg --https=443 http://127.0.0.1:28539" })
    expect(Tailscale.view({ state: "missing", version: null, dnsName: null, proxies: null }, 28539).serving).toBeNull()
  })

  test("user agent summary never keeps the raw header", () => {
    expect(summarizeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari · iOS")
    expect(summarizeAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36")).toBe("Chrome · Android")
    expect(summarizeAgent(null)).toBeNull()
  })
})

describe("feed: team decisions (06 §9.8, FeedKind team.decision)", () => {
  const HOST = "h-abcdef"
  const PASSWORD = "svc-password-fake-0123456789abcdef"
  const HOST_TOKEN = "host-token-fake-0123456789"
  const HOST_CONTROL = "/home/me/.local/share/own-open-code/control"
  const LOCAL_CONTROL = "C:\\Users\\me\\.own\\control"
  const LONG_TITLE = `팀 메인 ${"가".repeat(200)}`

  /** A fake service: an event stream the test writes to, and the own.team reads and session the feed looks up. */
  function service(input: {
    readonly authorization: string
    readonly teamID: string
    readonly sessionID: string
    readonly title: string
  }) {
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
    const seen: Array<{ path: string; search: string }> = []
    const encoder = new TextEncoder()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        seen.push({ path: url.pathname, search: decodeURIComponent(url.search) })
        if (req.headers.get("authorization") !== input.authorization) return new Response("no", { status: 401 })
        if (url.pathname === "/api/event") {
          srv.timeout(req, 0)
          let own: ReadableStreamDefaultController<Uint8Array> | undefined
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              own = controller
              streams.add(controller)
            },
            cancel() {
              if (own) streams.delete(own)
            },
          })
          return new Response(stream, { headers: { "content-type": "text/event-stream" } })
        }
        if (url.pathname === "/api/rpc/own.team/team.list")
          return Response.json({
            output: {
              teams: [{ id: input.teamID, projectID: "p1", home: "D:\\work\\secret-project", state: "on", areas: 2 }],
            },
          })
        if (url.pathname === "/api/rpc/own.team/team.get")
          return Response.json({
            output: { team: { id: input.teamID, main: { sessionID: input.sessionID, previous: [] } } },
          })
        if (url.pathname === `/api/session/${input.sessionID}`)
          return Response.json({ data: { id: input.sessionID, title: input.title } })
        return Response.json({ type: "not_found" }, { status: 404 })
      },
    })
    let count = 0
    return {
      url: `http://127.0.0.1:${server.port}`,
      seen,
      streams,
      events: () => seen.filter((item) => item.path === "/api/event").length,
      send(type: string, data: Record<string, unknown>) {
        const frame = encoder.encode(`data: ${JSON.stringify({ id: `e${++count}`, type, data })}\n\n`)
        for (const controller of streams) controller.enqueue(frame)
      },
      /** Ends every open stream from the server's side. */
      close() {
        for (const controller of [...streams]) {
          streams.delete(controller)
          controller.close()
        }
      },
      stop: () => server.stop(true),
    }
  }

  async function until(check: () => boolean, ms = 5000) {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out")
      await Bun.sleep(20)
    }
  }

  test("a confirm (warn) and a failed integration (danger) of this PC's team: main conversation, 10 s merge, no text or path", async () => {
    const home = tempHome()
    const local = service({
      authorization: ServiceTarget.basic(PASSWORD),
      teamID: "tm_local",
      sessionID: "ses_main",
      title: LONG_TITLE,
    })
    const clock = { value: Date.UTC(2026, 9, 4, 9) }
    const devices = new Devices.Store({ ownHome: home, now: () => clock.value })
    await devices.load()
    const emitted: OwnRemote.FeedItem[] = []
    const feed = new Feed.Producer({
      ownHome: home,
      log: Log.silent,
      service: ServiceTarget.fixed({ url: local.url, password: PASSWORD }),
      controlDir: LOCAL_CONTROL,
      devices,
      hosts: () => undefined,
      emit: (item) => emitted.push(item),
      now: () => clock.value,
    })
    const decisions = () => feed.items().filter((item) => item.kind === "team.decision")
    const confirm = {
      eventId: "ev1",
      origin: "global",
      teamID: "tm_local",
      opID: "op_1",
      stepID: "s3",
      kind: "retire-remove",
      areaID: "ar_1",
      nonce: "nonce-secret-0123",
      expiresAt: clock.value + 600_000,
      text: "D:\\work\\secret-project-team\\inventory 폴더를 지웁니다",
      bytes: 1024,
      files: [{ path: "assets/big-texture.bin", bytes: 1024 }],
      manifest: "sha256:abc",
    }
    const failed = { eventId: "ev2", origin: "global", teamID: "tm_local", areaID: "ar_1", integrationID: "ig_1" }
    try {
      feed.start()
      await until(() => local.streams.size === 1)
      local.send("rpc.own.team.op.confirm", confirm)
      await until(() => decisions().length === 1)
      const [warn] = decisions()
      expect(warn).toMatchObject({ kind: "team.decision", severity: "warn", serverKey: "local", sessionID: "ses_main" })
      expect(warn!.title).toBe(LONG_TITLE.slice(0, 120))
      expect(warn!.title!.length).toBeLessThanOrEqual(120)
      for (const leak of [
        "secret-project",
        "D:\\",
        "assets/",
        "big-texture",
        "nonce-secret",
        "지웁니다",
        "sha256:abc",
        "op_1",
      ])
        expect({ leak, found: JSON.stringify(warn).includes(leak) }).toEqual({ leak, found: false })
      // The team was read at this PC's control location.
      expect(local.seen.find((item) => item.path === "/api/rpc/own.team/team.list")!.search).toContain(LOCAL_CONTROL)

      // Within 10 s the same team's confirms merge; a failed integration is its own danger item; other states pass by.
      local.send("rpc.own.team.op.confirm", { ...confirm, stepID: "s4" })
      local.send("rpc.own.team.integration.changed", { ...failed, state: "done" })
      local.send("rpc.own.team.integration.changed", { ...failed, state: "conflict" })
      local.send("rpc.own.team.integration.changed", { ...failed, state: "failed" })
      await until(() => decisions().length === 2)
      expect(decisions()[1]).toMatchObject({ severity: "danger", serverKey: "local", sessionID: "ses_main" })
      clock.value += 10_001
      local.send("rpc.own.team.op.confirm", { ...confirm, stepID: "s5" })
      await until(() => decisions().length === 3)
      expect(decisions().map((item) => item.severity)).toEqual(["warn", "danger", "warn"])
      expect(emitted.map((item) => item.id)).toEqual(feed.items().map((item) => item.id))

      // A team the service no longer lists still gets its item, without a conversation.
      local.send("rpc.own.team.op.confirm", { ...confirm, teamID: "tm_gone" })
      await until(() => decisions().length === 4)
      expect(decisions()[3]).toEqual({
        id: expect.any(String),
        at: clock.value,
        kind: "team.decision",
        serverKey: "local",
        severity: "warn",
      })
    } finally {
      await feed.stop()
      local.stop()
    }
    const file = fs.readdirSync(path.join(home, "feed")).find((name) => name.startsWith("feed-"))!
    const text = fs.readFileSync(path.join(home, "feed", file), "utf8")
    expect(text.trim().split("\n")).toHaveLength(4)
    expect(text).not.toContain("secret-project")
    expect(text).not.toContain("assets/")
  }, 30_000)

  test("a ready host's team (HostAccess.endpoint): serverKey = hostId, rpc.own.team.* only, backoff reconnect, stops when not ready", async () => {
    const home = tempHome()
    const local = service({
      authorization: ServiceTarget.basic(PASSWORD),
      teamID: "tm_local",
      sessionID: "ses_main",
      title: "로컬 팀 메인",
    })
    const host = service({
      authorization: ServiceTarget.basic(HOST_TOKEN),
      teamID: "tm_host",
      sessionID: "ses_host_main",
      title: "원격 팀 메인",
    })
    const stage = { value: "ready" }
    const devices = new Devices.Store({ ownHome: home })
    await devices.load()
    const pair = (name: string, servers: OwnRemote.ServerScope, kind: OwnRemote.DeviceKind) =>
      devices.create({
        deviceId: Devices.newDeviceId(),
        name,
        kind,
        scopes: ["read"],
        servers,
        expiresDays: 30,
        userAgent: null,
        ip: null,
      })
    const browser = await pair("휴대폰", { mode: "all" }, "browser")
    const app = await pair("앱", { mode: "only", keys: ["local", HOST] }, "app")
    const localOnly = await pair("이 PC만", { mode: "only", keys: ["local"] }, "app")
    const resolved: string[] = []
    const feed = new Feed.Producer({
      ownHome: home,
      log: Log.silent,
      service: ServiceTarget.fixed({ url: local.url, password: PASSWORD }),
      controlDir: LOCAL_CONTROL,
      devices,
      hosts: () => ({
        list: () => [
          { id: HOST, name: "lab", stage: stage.value },
          { id: "h-zzzzzz", name: "far", stage: "disconnected" },
        ],
        endpoint: async (id) => {
          resolved.push(id)
          return id === HOST && stage.value === "ready"
            ? { url: host.url, token: HOST_TOKEN, controlDir: HOST_CONTROL }
            : null
        },
      }),
      emit: () => undefined,
    })
    const decisions = () => feed.items().filter((item) => item.kind === "team.decision")
    try {
      feed.start()
      await until(() => local.streams.size === 1 && host.streams.size === 1)
      // Only ready hosts are resolved: resolving another would start its connection.
      expect(resolved).not.toContain("h-zzzzzz")
      // Session and account events of the host are not read here; its team's decisions are.
      host.send("session.created", { sessionID: "ses_remote", title: "원격 세션" })
      host.send("session.execution.succeeded", { sessionID: "ses_remote" })
      host.send("rpc.own.accounts.account.status", { status: "auth_failed" })
      host.send("rpc.own.team.integration.changed", {
        teamID: "tm_host",
        areaID: "ar_9",
        integrationID: "ig_9",
        state: "failed",
      })
      await until(() => decisions().length === 1)
      expect(feed.items()).toEqual([
        {
          id: expect.any(String),
          at: expect.any(Number),
          kind: "team.decision",
          severity: "danger",
          serverKey: HOST,
          sessionID: "ses_host_main",
          title: "원격 팀 메인",
        },
      ])
      expect(host.seen.find((item) => item.path === "/api/rpc/own.team/team.get")!.search).toContain(HOST_CONTROL)
      // A confirm on this PC's team stays `local`.
      local.send("rpc.own.team.op.confirm", { teamID: "tm_local", opID: "op_2", stepID: "s1", text: "x" })
      await until(() => decisions().length === 2)
      expect(decisions()[1]).toMatchObject({ serverKey: "local", sessionID: "ses_main" })

      // Devices see a host's items only when they may see that host; an app device like a browser.
      const listed = async (deviceId: string) => (await feed.list({ deviceId })).items.map((item) => item.serverKey)
      expect(await listed(browser.record.deviceId)).toEqual([HOST, "local"])
      expect(await listed(app.record.deviceId)).toEqual([HOST, "local"])
      expect(await listed(localOnly.record.deviceId)).toEqual(["local"])

      // The host's stream ends: the feed connects again after its backoff.
      const before = host.events()
      host.close()
      await until(() => host.events() > before && host.streams.size === 1)

      // The host leaves ready: its subscription ends and stays ended until the host is ready again.
      stage.value = "disconnected"
      local.send("rpc.own.remote.host.state", { hostId: HOST, stage: "disconnected" })
      await until(() => host.streams.size === 0)
      const stopped = host.events()
      await Bun.sleep(1500)
      expect(host.events()).toBe(stopped)
      stage.value = "ready"
      local.send("rpc.own.remote.host.state", { hostId: HOST, stage: "ready" })
      await until(() => host.streams.size === 1)
    } finally {
      await feed.stop()
    }
    await until(() => host.streams.size === 0 && local.streams.size === 0)
    local.stop()
    host.stop()
  }, 30_000)
})

describe("device store: scopes added later (05 §8.10.2 devices.json)", () => {
  const now = Date.UTC(2026, 10, 20)
  const input = {
    name: "휴대폰",
    kind: "browser",
    servers: { mode: "all" },
    expiresDays: 30,
    userAgent: "Chrome · Android",
    ip: "100.64.0.2",
  } as const
  const read = (home: string) =>
    JSON.parse(fs.readFileSync(path.join(home, "devices.json"), "utf8")) as {
      version: number
      devices: Array<Record<string, unknown>>
    }
  const base = {
    name: "기기",
    kind: "app",
    servers: { mode: "all" },
    createdAt: now - 1000,
    lastSeenAt: now - 500,
    lastIp: null,
    userAgent: null,
    expiresAt: now + 30 * 24 * 3600_000,
    idleTimeoutDays: 14,
    revokedAt: null,
    feedCursor: null,
  }

  test("browser is written to extraScopes, never to scopes, and read back into the record", async () => {
    const home = tempHome()
    const store = new Devices.Store({ ownHome: home, now: () => now })
    await store.load()
    const plain = await store.create({ ...input, deviceId: Devices.newDeviceId(), scopes: ["read", "prompt", "switch"] })
    const browser = await store.create({ ...input, deviceId: Devices.newDeviceId(), scopes: ["read", "browser", "prompt"] })
    expect(browser.record.scopes).toEqual(["read", "browser", "prompt"])
    const file = read(home)
    expect(file.version).toBe(1)
    // A device without the new scope is written exactly as before: no new key.
    expect(file.devices[0]).toMatchObject({ deviceId: plain.record.deviceId, scopes: ["read", "prompt", "switch"] })
    expect(Object.keys(file.devices[0]!)).not.toContain("extraScopes")
    expect(file.devices[1]).toMatchObject({ deviceId: browser.record.deviceId, scopes: ["read", "prompt"], extraScopes: ["browser"] })
    // Every word in `scopes` is one a build from before the scope knows.
    const legacy = ["read", "prompt", "switch", "files", "terminal", "admin"]
    for (const device of file.devices) expect((device.scopes as string[]).every((scope) => legacy.includes(scope))).toBe(true)
    // Another reader (a restart) gets the scope back, and the token still verifies.
    const other = new Devices.Store({ ownHome: home, now: () => now })
    expect((await other.all()).find((device) => device.deviceId === browser.record.deviceId)!.scopes).toEqual(["read", "prompt", "browser"])
    expect(await other.verify(browser.token)).toMatchObject({ ok: true, device: { deviceId: browser.record.deviceId } })
    expect(Devices.view(other.get(browser.record.deviceId)!, now).scopes).toContain("browser")
    // Granting and taking it away again (the PC's settings): the key comes and goes with it.
    await other.update(plain.record.deviceId, { scopes: ["read", "browser"] })
    expect(read(home).devices[0]).toMatchObject({ scopes: ["read"], extraScopes: ["browser"] })
    const taken = await other.update(browser.record.deviceId, { scopes: ["read", "prompt"] })
    expect(taken!.scopes).toEqual(["read", "prompt"])
    expect(Object.keys(read(home).devices[1]!)).not.toContain("extraScopes")
    // A write that touches another field keeps it (revocation, the feed cursor, lastSeenAt).
    await other.update(plain.record.deviceId, { feedCursor: "feed_1" })
    await other.revoke(browser.record.deviceId)
    expect(read(home).devices[0]).toMatchObject({ scopes: ["read"], extraScopes: ["browser"], feedCursor: "feed_1" })
    expect(other.get(plain.record.deviceId)!.scopes).toEqual(["read", "browser"])
    // A device that holds only the new scope has an empty `scopes` on disk and still decodes.
    await other.update(plain.record.deviceId, { scopes: ["browser"] })
    expect(read(home).devices[0]).toMatchObject({ scopes: [], extraScopes: ["browser"] })
    const third = new Devices.Store({ ownHome: home, now: () => now })
    expect((await third.all())[0]!.scopes).toEqual(["browser"])
  })

  test("a file from before extraScopes reads as it always did, and stays in that form when written", async () => {
    const home = tempHome()
    const record = {
      ...base,
      deviceId: "dev_01HZZZZZZZZZZZZZZZZZZZZZZA",
      name: "예전 기기",
      kind: "pwa",
      scopes: ["read", "prompt", "switch"],
      tokenHash: Devices.hashToken("a".repeat(43)),
      lastIp: "100.64.0.9",
    }
    fs.writeFileSync(path.join(home, "devices.json"), JSON.stringify({ version: 1, devices: [record] }, null, 2) + "\n")
    const store = new Devices.Store({ ownHome: home, now: () => now })
    await store.load()
    expect(store.list() as unknown[]).toEqual([record])
    expect(await store.verify("a".repeat(43))).toMatchObject({ ok: true })
    await store.update(record.deviceId, { name: "새 이름" })
    expect(read(home)).toEqual({ version: 1, devices: [{ ...record, name: "새 이름" }] })
  })

  test("unknown words in extraScopes are ignored; a known one written into scopes is kept and moved", async () => {
    const home = tempHome()
    const file = path.join(home, "devices.json")
    const words = { ...base, deviceId: "dev_words", tokenHash: Devices.hashToken("c".repeat(43)), scopes: ["read"], extraScopes: ["hologram"] }
    const inline = { ...base, deviceId: "dev_inline", tokenHash: Devices.hashToken("d".repeat(43)), scopes: ["read", "browser"] }
    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [words, inline] }))
    const store = new Devices.Store({ ownHome: home, now: () => now })
    await store.load()
    expect(store.get("dev_words")!.scopes).toEqual(["read"])
    expect(store.get("dev_inline")!.scopes).toEqual(["read", "browser"])
    expect(Object.keys(store.get("dev_words")!)).not.toContain("extraScopes")
    await store.update("dev_words", { name: "다시 씀" })
    const written = read(home).devices
    expect(Object.keys(written[0]!)).not.toContain("extraScopes")
    expect(written[1]).toMatchObject({ deviceId: "dev_inline", scopes: ["read"], extraScopes: ["browser"] })
    // An old scope named in extraScopes grants nothing: only the scopes this build keeps there are read from it.
    const mixed = { ...words, deviceId: "dev_mixed", extraScopes: ["hologram", "browser", "browser", "admin"] }
    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [mixed] }))
    const second = new Devices.Store({ ownHome: home, now: () => now })
    await second.load()
    expect(second.get("dev_mixed")!.scopes).toEqual(["read", "browser"])
    // A value that is not a list of words fails the file like any broken file: no device is trusted from it.
    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [{ ...mixed, extraScopes: ["browser", 7] }] }))
    const broken = new Devices.Store({ ownHome: home, now: () => now })
    await broken.load()
    expect(broken.list()).toEqual([])
  })
})

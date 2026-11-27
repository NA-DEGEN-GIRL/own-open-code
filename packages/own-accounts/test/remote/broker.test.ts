// The local credential broker and the remote mode in one process (no ssh): the local BrokerHost on one OWN_HOME, a
// RemoteHost (broker client, mirror, spool, sink) on another, connected over loopback TCP like the tunnel's TCP
// fallback. Covers the handshake and arm rules (04 §8.3), leases and pushes (§8.4–8.5), the mirror (§9.2),
// observations into the local ledger (§10), fail closed and grace (§8.6–8.7), reconnect, drain mode (§5.7), auth
// failure limits and that the epoch key never reaches the remote disk.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import type { SessionModelRequest, SessionRetry } from "@opencode/plugin/promise/session"
import { Broker, type Account, type Ledger, type Limit, type Registry } from "@own/protocol"
import { Home } from "@own/runtime"
import { BrokerHost } from "../../src/broker/host.js"
import { Contract } from "../../src/broker/contract.js"
import type { Server } from "../../src/broker/server.js"
import { Wire } from "../../src/broker/wire.js"
import { Clock } from "../../src/clock.js"
import type { Deps } from "../../src/deps.js"
import type { Modules } from "../../src/modules.js"
import { RemoteHost } from "../../src/remote/host.js"
import { Sink } from "../../src/remote/sink.js"
import { registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const HOST = "h-int001"
const KEY_A = "sk-proj-brokerIntegrationAlpha00000000000001"
const KEY_B = "sk-proj-brokerIntegrationBravo00000000000002"

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(25)
  }
}

describe("local broker ↔ remote mode over loopback", () => {
  const state = {} as {
    local: Awaited<ReturnType<typeof testDeps>>
    remote: Awaited<ReturnType<typeof testDeps>>
    localDeps: Deps.Deps
    detach: () => Promise<void>
    server: Server.LocalBroker
    handle: RemoteHost.Handle
    detachRemote: () => void
    client: Contract.RemoteBrokerClient
    registry: Registry.File
    alerts: Array<Record<string, unknown>>
    localAlerts: Array<Record<string, unknown>>
    keys: Buffer[]
    alpha: Account.Info
    bravo: Account.Info
  }

  const arm = async (epoch: number, key: Buffer) => {
    const { port } = await state.server.listen(HOST)
    state.server.setKey(HOST, { epoch, key })
    state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 2 })
    return state.client.arm({ hostId: HOST, epoch, key: new Uint8Array(key), endpoint: { tcpPort: port }, proto: Broker.PROTO })
  }

  beforeAll(async () => {
    state.alerts = []
    state.localAlerts = []
    state.keys = []
    state.local = await testDeps({ ctx: { app: { version: "local" } }, control: true, options: { broker: { leaseMs: 1_500, brokerWaitMs: 300 } } })
    state.localDeps = { ...state.local.deps, clock: Clock.system }
    const runtime = state.local.deps.runtime
    const registry = await registryWith([
      { kind: "oai", label: "Alpha", slug: "alpha" },
      { kind: "oai", label: "Bravo", slug: "bravo" },
    ])
    state.registry = await runtime.registry.write(registry)
    state.alpha = state.registry.accounts[0]!
    state.bravo = state.registry.accounts[1]!
    expect((await runtime.credentials.store(state.alpha.id, { type: "key", key: KEY_A })).ok).toBe(true)
    expect((await runtime.credentials.store(state.bravo.id, { type: "key", key: KEY_B })).ok).toBe(true)
    const localModules = {
      logins: {
        headers: (account: Account.Info, sessionID: string) => runtime.credentials.headersFor({ account, sessionID }),
        refresher: () => undefined,
        test: async () => ({}),
      },
      telemetry: { alert: (input: Record<string, unknown>) => void state.localAlerts.push(input) },
    } as unknown as Modules.All
    state.detach = BrokerHost.attach(state.localDeps, localModules)
    state.server = BrokerHost.peek(runtime.buildId)!

    state.remote = await testDeps({ ctx: {} })
    state.handle = await RemoteHost.acquire({
      buildId: runtime.buildId,
      version: "local",
      runtime: state.remote.deps.runtime,
      options: { broker: { pingMs: 60_000 } },
      log: state.remote.deps.log,
    })
    state.detachRemote = state.handle.attach(state.remote.deps, {
      telemetry: { alert: (input: Record<string, unknown>) => void state.alerts.push(input) },
    } as unknown as Modules.All)
    state.client = Contract.lookup(Contract.remoteKey(runtime.buildId)) as Contract.RemoteBrokerClient
  }, 30_000)

  afterAll(async () => {
    await state.handle?.release()
    state.detachRemote?.()
    await state.detach?.()
    await state.remote?.[Symbol.asyncDispose]()
    await state.local?.[Symbol.asyncDispose]()
  }, 30_000)

  test("arm → handshake → normal mode → mirror written on the remote without identifiers", async () => {
    const key = randomBytes(32)
    state.keys.push(key)
    expect(await arm(10, key)).toEqual({ accepted: true })
    await until(() => state.server.status(HOST).state === "connected")
    expect(state.server.status(HOST)).toMatchObject({ mode: "normal", proto: Broker.PROTO })
    const remoteRuntime = state.remote.deps.runtime
    const mirrored = await until(async () => {
      const file = await remoteRuntime.registry.read()
      return file.accounts.length === 2 ? file : undefined
    })
    expect(mirrored.accounts.map((account) => [account.id, account.status, account.identity])).toEqual([
      [state.alpha.id, "ready", {}],
      [state.bravo.id, "ready", {}],
    ])
    expect(Object.keys(mirrored.modelTemplates)).toEqual(Object.keys(state.registry.modelTemplates))
    const meta = (mirrored as unknown as { mirror: Broker.MirrorMeta }).mirror
    expect(meta).toMatchObject({ schemaVersion: 1, registryRevision: state.registry.revision })
    await until(() => state.client.status().mirror.revision === state.registry.revision)
    expect(state.client.status()).toMatchObject({ state: "connected", epoch: 10, mirror: { revision: state.registry.revision } })
    expect(state.handle.api.health().broker.state).toBe("connected")
  })

  test("arm rules: a lower epoch or another key for the same epoch is refused; an unknown proto too", async () => {
    const key = state.keys[0]!
    expect(await state.client.arm({ hostId: HOST, epoch: 9, key: new Uint8Array(key), endpoint: { tcpPort: 1 }, proto: 1 })).toEqual({ accepted: false, reason: "stale_epoch" })
    expect(await state.client.arm({ hostId: HOST, epoch: 10, key: new Uint8Array(randomBytes(32)), endpoint: { tcpPort: 1 }, proto: 1 })).toEqual({ accepted: false, reason: "key_mismatch" })
    expect(await state.client.arm({ hostId: HOST, epoch: 11, key: new Uint8Array(key), endpoint: { tcpPort: 1 }, proto: 99 })).toEqual({ accepted: false, reason: "proto" })
    // The same epoch with the same key and endpoint (a re-arm after a service restart) is accepted and changes nothing.
    const { port } = await state.server.listen(HOST)
    expect(await state.client.arm({ hostId: HOST, epoch: 10, key: new Uint8Array(key), endpoint: { tcpPort: port }, proto: 1 })).toEqual({ accepted: true })
    expect(state.client.status().state).toBe("connected")
  })

  test("headers: a lease of the local key, cached on the remote; session headers are the remote's", async () => {
    const auth = await state.handle.api.headers(state.alpha, "ses_int1", "/home/u/work")
    expect(auth).toMatchObject({ ok: true, headers: { authorization: `Bearer ${KEY_A}` } })
    expect(state.server.status(HOST).leasesActive).toBe(1)
    const again = await state.handle.api.headers(state.alpha, "ses_int2", "/home/u/work")
    expect(again.ok && again.hash).toBe(auth.ok && auth.hash)
    expect(state.client.status().leases.map((lease) => lease.providerID)).toEqual([state.alpha.providerID])
    // Nothing of the lease reaches the status (only provider ids and remaining time).
    expect(JSON.stringify(state.client.status())).not.toContain(KEY_A)
  })

  test("observations: a remote ledger line reaches the local ledger once, with server = hostId", async () => {
    const ledger = state.handle.wrap(state.remote.deps.runtime).ledger
    const now = Date.now()
    const line: Ledger.Line = {
      v: 1,
      ts: now,
      sessionID: "ses_int1" as Ledger.Line["sessionID"],
      messageID: "msg_1",
      kind: "primary",
      accountID: state.alpha.id,
      providerID: state.alpha.providerID,
      modelID: "gpt-5.5" as Ledger.Line["modelID"],
      variant: null,
      credentialRef: null,
      transport: null,
      switchEpoch: 0,
      compactionEpoch: 0,
      tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null, output: 10, reasoning: 0 },
      P: 1000,
      hit: 0,
      cost: null,
      costUSDOpenCode: null,
      coldExpected: null,
      usageSource: "event",
    }
    expect(await ledger.usage("st_int_1", line)).toBe("written")
    // A duplicate write (another Location instance) is not spooled again.
    expect(await ledger.usage("st_int_1", line)).toBe("duplicate")
    const localLedger = state.local.deps.runtime.ledger
    const found = await until(async () => (await localLedger.usageOf(Home.month(now))).find((entry) => entry.eid === "st_int_1"))
    expect(found.line).toMatchObject({ server: HOST, accountID: state.alpha.id, remoteAt: now })
    await until(() => state.client.status().spool.backlog === 0)
    expect((await localLedger.usageOf(Home.month(now))).filter((entry) => entry.eid === "st_int_1")).toHaveLength(1)
    // The remote keeps its own copy for its sessions' estimator and ledger.session.
    expect((await state.remote.deps.runtime.ledger.usageOf(Home.month(now))).map((entry) => entry.eid)).toContain("st_int_1")
    expect(state.server.status(HOST).lastPushAt).not.toBeNull()
  })

  test("a local change reaches the host: mirror.changed, then account.status and revoke for a disabled account", async () => {
    const runtime = state.local.deps.runtime
    await state.handle.api.headers(state.bravo, "ses_int3", "/home/u/work")
    expect(state.client.status().leases.map((lease) => lease.providerID)).toContain(state.bravo.providerID)
    const next = await runtime.registry.update((current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === state.bravo.id ? { ...account, label: "Bravo 2", status: "disabled" as const } : account,
      ),
    }))
    runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local", revision: next.revision })
    const remoteRuntime = state.remote.deps.runtime
    await until(async () => {
      const file = await remoteRuntime.registry.read()
      return file.accounts.find((account) => account.id === state.bravo.id)?.label === "Bravo 2"
    })
    const mirrored = await remoteRuntime.registry.read()
    expect(mirrored.accounts.find((account) => account.id === state.bravo.id)?.status).toBe("disabled")
    await until(() => !state.client.status().leases.some((lease) => lease.providerID === state.bravo.providerID))
    // A new lease is refused while disabled.
    const refused = await state.handle.api.headers(state.bravo, "ses_int3", "/home/u/work")
    expect(refused).toMatchObject({ ok: false, detail: "account_not_remote" })
  })

  test("a budget this PC forgets leaves the host too; the account's other windows stay (LV)", async () => {
    // The fourth limits review: the host only merged pushes, so a removed budget stayed there for the rest of the month.
    const runtime = state.local.deps.runtime
    const remote = state.remote.deps.runtime
    const now = Date.now()
    const budget: Limit.Window = {
      id: "api.budget_month",
      accountID: state.alpha.id,
      providerID: state.alpha.providerID,
      scope: "account",
      kind: "budget",
      label: "이번 달 예산",
      usedPercent: 92,
      remaining: 2,
      limit: 25,
      unit: "USD",
      resetAt: now + 86_400_000,
      status: "warning",
      confidence: "live",
      source: "ledger",
      observedAt: now,
    }
    const requests: Limit.Window = {
      ...budget,
      id: "oai.requests",
      kind: "rate",
      label: "분당 요청",
      usedPercent: 10,
      remaining: 90,
      limit: 100,
      unit: "requests",
      status: "ok",
      source: "header",
    }
    // As own-accounts' telemetry publishes them (`Limits.Store.upsert`, then `limits.updated`).
    runtime.broadcast.emit("limits.updated", { windows: runtime.limits.upsert([budget, requests]) })
    const held = () =>
      remote.limits
        .list({ accountID: state.alpha.id })
        .map((window) => window.id)
        .toSorted()
    await until(() => held().length === 2)
    expect(held()).toEqual(["api.budget_month", "oai.requests"])
    // The budget is removed on this PC: `refreshBudgets` drops the window and says which one.
    runtime.limits.drop(state.alpha.id, "api.budget_month")
    runtime.broadcast.emit("limits.updated", {
      windows: [],
      dropped: [{ accountID: state.alpha.id, id: "api.budget_month" }],
    })
    await until(() => held().length === 1)
    expect(held()).toEqual(["oai.requests"])
  })

  test("fail closed: broker gone and lease expired → sink 401, the grace ends the turn with broker_unavailable", async () => {
    // A fresh lease (1.5 s in this test build), then the broker goes away.
    expect((await state.handle.api.headers(state.alpha, "ses_pre", "/home/u/work")).ok).toBe(true)
    await state.server.close(HOST)
    await until(() => state.client.status().state === "connecting")
    // The lease keeps working until its deadline (short outages are absorbed) …
    const early = await state.handle.api.headers(state.alpha, "ses_fail", "/home/u/work")
    expect(early.ok).toBe(true)
    // … and then nothing: no credential after the lease expired.
    await Bun.sleep(1_600)
    const started = Date.now()
    const failed = await state.handle.api.headers(state.alpha, "ses_fail", "/home/u/work")
    expect(failed).toMatchObject({ ok: false, detail: "broker_unavailable" })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250) // waited for the broker (brokerWaitMs 300)
    // The request carries no credential, so it is redirected to the loopback sink.
    const event: SessionModelRequest = {
      sessionID: "ses_fail" as SessionModelRequest["sessionID"],
      agent: "build" as SessionModelRequest["agent"],
      model: { providerID: state.alpha.providerID, id: "gpt-5.5" } as SessionModelRequest["model"],
      kind: "primary",
      headers: { "content-type": "application/json" },
    }
    state.handle.api.afterModelRequest(event, true)
    const http = {
      sessionID: event.sessionID,
      agent: event.agent,
      model: event.model,
      kind: event.kind,
      request: new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "a long conversation prefix that must not leave the host" }),
      }),
    }
    state.handle.api.onHttpRequest(http)
    expect(http.request.url.startsWith("http://127.0.0.1:")).toBe(true)
    expect(state.handle.api.isSink(http.request.url)).toBe(true)
    const response = await fetch(http.request)
    expect(response.status).toBe(401)
    // The sink says why (SLM): the broker could not be reached.
    expect(await response.json()).toEqual({
      error: { type: "own_broker_unavailable", code: "unavailable", message: Sink.REASONS.unavailable },
    })
    // Second attempt within the grace (2 s, from `configure`): retry with a bounded delay, no second broker wait.
    const retry = { sessionID: event.sessionID, agent: event.agent, model: event.model, attempt: 2, decision: { retry: false as const } } as unknown as SessionRetry
    expect(state.handle.api.retryBefore(retry)).toBe(true)
    expect(retry.decision).toMatchObject({ retry: true })
    const quick = Date.now()
    expect(await state.handle.api.headers(state.alpha, "ses_fail", "/home/u/work")).toMatchObject({ ok: false })
    expect(Date.now() - quick).toBeLessThan(250)
    await Bun.sleep(2_100)
    const last = { ...retry, attempt: 3, decision: { retry: false as const } } as unknown as SessionRetry
    expect(state.handle.api.retryBefore(last)).toBe(true)
    expect(last.decision).toEqual({ retry: false })
    expect(state.alerts).toEqual([expect.objectContaining({ code: "broker_unavailable", sessionID: "ses_fail" })])
  }, 20_000)

  test("reconnect with a new epoch resumes: the next request gets a lease again", async () => {
    const key = randomBytes(32)
    state.keys.push(key)
    expect(await arm(11, key)).toEqual({ accepted: true })
    await until(() => state.server.status(HOST).state === "connected")
    // The broker side reports the link before the remote side has its ready answer (2026-10-17, loaded PC).
    await until(() => state.client.status().state === "connected")
    const auth = await state.handle.api.headers(state.alpha, "ses_fail", "/home/u/work")
    expect(auth).toMatchObject({ ok: true, headers: { authorization: `Bearer ${KEY_A}` } })
    // A request of a session that has a credential again goes to the provider, not the sink.
    const event = {
      sessionID: "ses_fail",
      agent: "build",
      model: { providerID: state.alpha.providerID, id: "gpt-5.5" },
      kind: "primary",
      headers: { ...(auth.ok ? auth.headers : {}) },
    } as unknown as SessionModelRequest
    state.handle.api.afterModelRequest(event, true)
    const http = { ...event, request: new Request("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }) }
    state.handle.api.onHttpRequest(http as never)
    expect(http.request.url).toBe("https://api.openai.com/v1/responses")
    const retry = { ...event, attempt: 2, decision: { retry: false } } as unknown as SessionRetry
    expect(state.handle.api.retryBefore(retry)).toBe(false)
  })

  test("drain mode: another build is served headers but no mirror (registry.get → skew_drain)", async () => {
    const { port } = await state.server.listen(HOST)
    const key = state.keys[1]!
    const socket = net.connect({ host: "127.0.0.1", port })
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    const channel = new Wire.Channel(socket)
    const nonceR = Wire.nonce()
    channel.send({ type: "hello", proto: 1, hostId: HOST, epoch: 11, nonceR, version: "0.0.1-older", buildId: "older-build", mirrorSchemaVersion: 1, streamId: "feedfacefeedface" })
    const challenge = (await channel.next(5_000)) as Broker.Challenge
    const input = { hostId: HOST, epoch: 11, nonceR, nonceL: challenge.nonceL }
    expect(Wire.equal(challenge.mac, Wire.mac(key, "L", input))).toBe(true)
    channel.send({ type: "auth", mac: Wire.mac(key, "R", input) })
    const ready = (await channel.next(5_000)) as Broker.Ready
    expect(ready).toMatchObject({ type: "ready", mode: "drain", settings: { failClosedGraceSeconds: 2, brokerWaitMs: 300 } })
    channel.send({ type: "req", id: 1, method: "registry.get", params: { since: null } })
    expect(await channel.next(5_000)).toEqual({ type: "res", id: 1, ok: false, error: "skew_drain" })
    channel.send({
      type: "req",
      id: 2,
      method: "headers.get",
      params: { providerID: state.alpha.providerID, kind: "oai", sessionID: "ses_d", directory: "/", allowlist: "ok" },
    })
    const lease = (await channel.next(5_000)) as Broker.Response
    expect(lease).toMatchObject({ id: 2, ok: true, result: { headers: { authorization: `Bearer ${KEY_A}` } } })
    expect(state.localAlerts.some((alert) => alert.code === "remote_skew")).toBe(true)
    channel.close()
    // The drain session replaced the remote host's session; the real client reconnects by itself.
    await until(() => state.client.status().state === "connected", 15_000)
  }, 30_000)

  test("a proof with a wrong key is refused, logged, and five failures a minute close the port for the host", async () => {
    const { port } = await state.server.listen(HOST)
    const events = () => state.local.deps.runtime.ledger.eventsOf(Home.month(Date.now()))
    for (let attempt = 0; attempt < 5; attempt++) {
      const outcome = await rawHandshake(port, { epoch: 11, key: randomBytes(32) })
      expect(outcome).toBe("closed_after_auth")
    }
    await until(async () => (await events()).filter((event) => event.type === "remote.broker.auth_failed").length >= 5)
    // Past the limit a connection is closed before any challenge (even with the right key).
    expect(await rawHandshake(port, { epoch: 11, key: state.keys[1]! })).toBe("closed_before_challenge")
    // The authenticated session is not affected.
    expect(state.server.status(HOST).state).toBe("connected")
  })

  test("a first frame that is not hello is closed without a record; the key never reaches the remote disk", async () => {
    const other = "h-int002"
    const { port } = await state.server.listen(other)
    state.server.setKey(other, { epoch: 1, key: randomBytes(32) })
    const socket = net.connect({ host: "127.0.0.1", port })
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    socket.write("GET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    await new Promise<void>((resolve) => socket.once("close", () => resolve()))
    expect(state.server.status(other).state).toBe("disconnected")
    await state.server.close(other)
    const hits = scan(state.remote.home, state.keys)
    expect(hits).toEqual([])
  })

  test("the sink answers WebSocket upgrades with 401 too", async () => {
    const sink = await Sink.start()
    try {
      const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(sink.url).port) })
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
      socket.write("GET /backend-api/codex/responses HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
      const text = await new Promise<string>((resolve) => {
        let data = ""
        socket.on("data", (chunk) => (data += chunk.toString()))
        socket.on("close", () => resolve(data))
      })
      expect(text.startsWith("HTTP/1.1 401")).toBe(true)
      expect(text).toContain("own_broker_unavailable")
      expect(sink.hits()).toBe(1)
    } finally {
      await sink.close()
    }
  })
})

/** A hand-rolled remote side: returns how far the local broker let it get. */
async function rawHandshake(port: number, input: { readonly epoch: number; readonly key: Uint8Array }) {
  const socket = net.connect({ host: "127.0.0.1", port })
  const connected = await new Promise<boolean>((resolve) => {
    socket.once("connect", () => resolve(true))
    socket.once("error", () => resolve(false))
  })
  if (!connected) return "refused"
  const channel = new Wire.Channel(socket)
  const nonceR = Wire.nonce()
  channel.send({ type: "hello", proto: 1, hostId: HOST, epoch: input.epoch, nonceR, version: "local", buildId: "x", mirrorSchemaVersion: 1, streamId: "abcdefabcdef0000" })
  const challenge = (await channel.next(3_000)) as Broker.Challenge | undefined
  if (!challenge) return "closed_before_challenge"
  channel.send({ type: "auth", mac: Wire.mac(input.key, "R", { hostId: HOST, epoch: input.epoch, nonceR, nonceL: challenge.nonceL }) })
  const answer = await channel.next(3_000)
  channel.close()
  return answer === undefined ? "closed_after_auth" : "answered"
}

/** Files under `root` that contain any key in raw, hex, base64 or base64url form. */
function scan(root: string, keys: ReadonlyArray<Buffer>) {
  const needles = keys.flatMap((key) => [key.toString("hex"), key.toString("base64"), key.toString("base64url")])
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) {
        const data = fs.readFileSync(file)
        if (keys.some((key) => data.includes(key)) || needles.some((needle) => data.includes(needle))) hits.push(file)
      }
    }
  }
  walk(root)
  return hits
}

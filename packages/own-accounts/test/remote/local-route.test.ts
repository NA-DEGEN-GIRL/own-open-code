// SLM (04 §8.14): the remote mode's route of a PC local model (a `로컬 모델` account) against a real local broker and
// its egress relay in one process (no ssh), like claude-route.test.ts: the local BrokerHost (modules stubbed, a fake
// model server on 127.0.0.1), a RemoteHost on another OWN_HOME, armed over loopback TCP. The hooks are driven the way
// core calls them. The mirror carries the account's local format (never `keyless`) and says the PC relays; the host
// takes no lease and drops every credential; the request goes to the PC's relay first and last, never to the
// account's address; the PC adds a keyed account's key; refusals and the sink say why, and the retry decision follows.
// Fake keys only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionModelRequest,
  SessionRetry,
} from "@opencode/plugin/promise/session"
import { Account, Broker, Kind, type Registry } from "@own/protocol"
import { Contract } from "../../src/broker/contract.js"
import { BrokerHost } from "../../src/broker/host.js"
import type { Server } from "../../src/broker/server.js"
import { Clock } from "../../src/clock.js"
import type { Modules } from "../../src/modules.js"
import { RemoteHost } from "../../src/remote/host.js"
import { Sink } from "../../src/remote/sink.js"
import { registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

setDefaultTimeout(30_000)

const HOST = "h-local1"
const PC_KEY = "sk-ownLocalRoutePcOnlyFakeKey000001"
const KEYLESS = Kind.ProviderID.from("compat", "tflm")
const KEYED = Kind.ProviderID.from("compat", "keyed")
const CLOUD = Kind.ProviderID.from("compat", "cloud")
/** A `기타 OpenAI 호환` account on this PC's loopback (a proxy, or a server the user reverted from 로컬 모델). */
const LOOPBACK = Kind.ProviderID.from("compat", "lpbk")

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(25)
  }
}

const state = {} as {
  root: string
  local: Awaited<ReturnType<typeof testDeps>>
  remote: Awaited<ReturnType<typeof testDeps>>
  detach: () => Promise<void>
  server: Server.LocalBroker
  handle: RemoteHost.Handle
  detachRemote: () => void
  client: Contract.RemoteBrokerClient
  logs: string[]
  model: { origin: string; seen: Array<{ path: string; authorization: string | null; body: string }>; stop(): void }
  epoch: number
}

function events(providerID: string, sessionID: string) {
  const model = { providerID, id: "tf-local" }
  const body = JSON.stringify({ model: "tf-local", stream: true, messages: [{ role: "user", content: "git init" }] })
  const request: SessionModelRequest = {
    sessionID,
    agent: "build",
    model,
    kind: "context",
    headers: { authorization: "Bearer sk-host-own", "x-session-affinity": sessionID },
  } as unknown as SessionModelRequest
  const http: SessionHttpRequest = {
    sessionID,
    agent: "build",
    model,
    kind: "context",
    // The account's address as the host registers it: on this host it would be the host itself.
    request: new Request(`http://127.0.0.1:1/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-host-own", "x-session-affinity": sessionID },
      body,
    }),
  } as unknown as SessionHttpRequest
  return { request, http, body }
}

function retry(providerID: string, sessionID: string, attempt = 2): SessionRetry {
  return {
    sessionID,
    agent: "build",
    model: { providerID, id: "tf-local" },
    error: { type: "provider", message: "x" },
    attempt,
    decision: { retry: true, delay: 1_000 },
  } as unknown as SessionRetry
}

async function send(providerID: string, sessionID: string, trust: "ok" | "blocked_by_plugin" = "ok") {
  const { request, http, body } = events(providerID, sessionID)
  await state.handle.api.localRoute(request, { trust })
  state.handle.api.onHttpRequest(http, undefined)
  const response = await fetch(http.request)
  const refused = state.handle.api.onEgressResponse({ ...http, response } as unknown as SessionHttpResponse)
  return { request, http, response, refused, body }
}

async function arm(epoch: number, accounts: Contract.AccountScope = { mode: "all" }) {
  const ports = await state.server.listen(HOST)
  const key = randomBytes(32)
  state.server.setKey(HOST, { epoch, key })
  state.server.configure(HOST, { accounts, leaseSeconds: 900, failClosedGraceSeconds: 2 })
  const result = await state.client.arm({
    hostId: HOST,
    epoch,
    key: new Uint8Array(key),
    endpoint: { tcpPort: ports.port },
    ...(ports.egressPort === undefined ? {} : { egress: { tcpPort: ports.egressPort } }),
    proto: Broker.PROTO,
  })
  expect(result).toEqual({ accepted: true })
  await until(() => state.server.status(HOST).state === "connected")
}

beforeAll(async () => {
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-local-route-")))
  state.logs = []
  state.epoch = 200
  const seen: Array<{ path: string; authorization: string | null; body: string }> = []
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname + url.search, authorization: request.headers.get("authorization"), body: await request.text() })
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  state.model = { origin: `http://127.0.0.1:${served.port}`, seen, stop: () => void served.stop(true) }
  const baseURL = `${state.model.origin}/v1`
  state.local = await testDeps({
    logs: state.logs,
    ctx: { app: { version: "local" } },
    control: true,
    options: { broker: { brokerWaitMs: 300 } },
  })
  const runtime = state.local.deps.runtime
  const seeded = await registryWith([
    { kind: "compat", label: "TF", slug: "tflm", baseURL },
    { kind: "compat", label: "Keyed", slug: "keyed", baseURL },
    { kind: "compat", label: "Cloud", slug: "cloud", baseURL: "https://api.example.test/v1" },
    { kind: "compat", label: "Proxy", slug: "lpbk", baseURL: "http://localhost:4000/v1" },
  ])
  const registry: Registry.File = {
    ...seeded,
    accounts: seeded.accounts.map((account) =>
      account.providerID === KEYLESS
        ? { ...account, compat: { local: { format: "chat", keyless: true }, server: { family: "other", overflowClassified: false } } }
        : account.providerID === KEYED
          ? { ...account, compat: { local: { format: "responses" } } }
          : account,
    ),
  }
  await runtime.registry.write(registry)
  const localModules = {
    logins: {
      // The PC's own credential path: the keyed local model's key, nothing for the keyless one.
      headers: async (account: { providerID: string }) =>
        account.providerID === KEYED
          ? { ok: true, headers: { authorization: `Bearer ${PC_KEY}` }, hash: "h", expiresAt: null, source: "vault" }
          : { ok: true, headers: {}, hash: "", expiresAt: null, source: "vault" },
      refresher: () => undefined,
      test: async () => ({}),
    },
    slots: {
      slot: (providerID: string) => {
        const slot = registry.slots[providerID as keyof Registry.File["slots"]]
        return slot ? { slot } : undefined
      },
    },
    telemetry: { alert: () => {} },
    plugins: {
      claudeSlot: () => ({ detected: false, verified: false, version: null, integrity: null }),
      claudeRemote: () => undefined,
      refreshed: async () => {},
    },
    claude: { entry: () => undefined, multi: () => false, usable: () => false, ready: async () => false },
  } as unknown as Modules.All
  state.detach = BrokerHost.attach({ ...state.local.deps, clock: Clock.system }, localModules)
  state.server = BrokerHost.peek(runtime.buildId)!
  state.remote = await testDeps({ ctx: {}, logs: state.logs })
  state.handle = await RemoteHost.acquire({
    buildId: runtime.buildId,
    version: "local",
    runtime: state.remote.deps.runtime,
    options: { broker: { pingMs: 60_000 } },
    log: state.remote.deps.log,
  })
  state.detachRemote = state.handle.attach(state.remote.deps, {
    telemetry: { alert: () => {} },
  } as unknown as Modules.All)
  state.client = Contract.lookup(Contract.remoteKey(runtime.buildId)) as Contract.RemoteBrokerClient
  await arm(state.epoch)
  await until(() => state.handle.api.local(KEYLESS) !== undefined)
}, 30_000)

afterAll(async () => {
  await state.handle?.release()
  state.detachRemote?.()
  await state.detach?.()
  state.model?.stop()
  await state.remote?.[Symbol.asyncDispose]()
  await state.local?.[Symbol.asyncDispose]()
  fs.rmSync(state.root, { recursive: true, force: true })
  expect(state.logs.join("\n")).not.toContain(PC_KEY)
}, 30_000)

describe("a PC local model on a host (04 §8.14)", () => {
  test("the mirror carries the local format without `keyless`, says the PC relays, and names only local models", async () => {
    const mirrored = state.remote.deps.runtime.registry.cached()!
    const keyless = mirrored.accounts.find((account) => account.providerID === KEYLESS)!
    expect(keyless.compat).toEqual({ local: { format: "chat" }, server: { family: "other", overflowClassified: false } })
    expect(mirrored.accounts.find((account) => account.providerID === KEYED)!.compat).toEqual({
      local: { format: "responses" },
    })
    expect((mirrored as unknown as { mirror: Broker.MirrorMeta }).mirror.localRelay).toBe(true)
    expect(state.handle.api.local(KEYLESS)).toBe(keyless.id)
    expect(state.handle.api.local(CLOUD)).toBeUndefined()
    // A loopback base URL is the host itself there: such a `compat` account goes through the PC too.
    expect(state.handle.api.local(LOOPBACK)).toBe(Account.ID.make("acc_lpbk"))
  })

  test("which accounts go through the PC (`Broker.viaPc`): local models, and `compat` ones on the PC's loopback", () => {
    const compat = { kind: "compat" }
    expect(Broker.viaPc({ kind: "compat", compat: { local: { format: "chat" } } }, "http://192.168.0.5:1234/v1")).toBe(true)
    for (const url of ["http://127.0.0.1:64644/v1", "http://localhost:8080/v1", "http://[::1]:11434", "http://127.3.2.1/v1", "http://0.0.0.0:8000/v1", "http://[::ffff:127.0.0.1]:1234/v1"])
      expect(Broker.viaPc(compat, url)).toBe(true)
    for (const url of ["https://api.example.test/v1", "http://192.168.0.5:1234/v1", "http://10.0.0.2/v1", undefined])
      expect(Broker.viaPc(compat, url)).toBe(false)
    expect(Broker.viaPc({ kind: "oai" }, "http://127.0.0.1:1/v1")).toBe(false)
  })

  test("no lease for a local model: the host asks the PC for no credential", async () => {
    const account = state.remote.deps.runtime.registry.cached()!.accounts.find((item) => item.providerID === KEYED)!
    const auth = await state.handle.api.headers(account, "ses_lease", "/work")
    expect(auth).toMatchObject({ ok: true, headers: {} })
    expect(state.server.status(HOST).leasesActive).toBe(0)
  })

  test("the PC's relay, first and last: no host credential, the same body, the PC's key for a keyed account", async () => {
    const before = state.model.seen.length
    const keyless = await send(KEYLESS, "ses_keyless")
    expect(Object.keys(keyless.request.headers)).toEqual(["x-session-affinity"])
    const target = new URL(keyless.http.request.url)
    expect(target.port).not.toBe("1")
    expect(target.pathname).toBe(`${Broker.LOCAL_PATH_PREFIX}${state.handle.api.local(KEYLESS)}/v1/chat/completions`)
    expect(keyless.http.request.headers.get("authorization")).toBeNull()
    expect(keyless.http.request.headers.get(Broker.LOCAL_HEADER)).toMatch(/^v1\.200\.\d+\.acc_tflm.[0-9a-f]{64}$/)
    expect(keyless.response.status).toBe(200)
    expect(keyless.response.headers.get(Broker.LOCAL_HEADER)).toBe("1")
    expect(keyless.refused).toBe(false)
    expect(await keyless.response.text()).toContain("[DONE]")
    expect(state.handle.api.retryBefore(retry(KEYLESS, "ses_keyless"))).toBe(false)
    const keyed = await send(KEYED, "ses_keyed")
    await keyed.response.text()
    const seen = state.model.seen.slice(before)
    expect(seen.map((item) => item.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"])
    expect(seen[0]).toMatchObject({ authorization: null, body: keyless.body })
    expect(seen[1]).toMatchObject({ authorization: `Bearer ${PC_KEY}`, body: keyed.body })
  })

  test("a folder whose plugin trust blocks credentials: the sink, which says why, and the turn ends", async () => {
    const before = state.model.seen.length
    const { http, response } = await send(KEYLESS, "ses_trust", "blocked_by_plugin")
    expect(state.handle.api.isSink(http.request.url)).toBe(true)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { type: Sink.TYPE, code: "blocked", message: Sink.REASONS.blocked } })
    const event = retry(KEYLESS, "ses_trust")
    expect(state.handle.api.retryBefore(event)).toBe(true)
    expect(event.decision).toEqual({ retry: false })
    expect(state.model.seen.length).toBe(before)
  })

  test("an account outside the host's scope: the PC refuses it (host_scope) and the turn ends", async () => {
    state.epoch++
    await arm(state.epoch, { mode: "only", ids: [] })
    const before = state.model.seen.length
    const { response, refused } = await send(KEYLESS, "ses_scope")
    expect(response.status).toBe(403)
    expect(response.headers.get(Broker.LOCAL_ERROR_HEADER)).toBe("host_scope")
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("계정 범위")
    expect(refused).toBe(true)
    const event = retry(KEYLESS, "ses_scope")
    expect(state.handle.api.retryBefore(event)).toBe(true)
    expect(event.decision).toEqual({ retry: false })
    expect(state.model.seen.length).toBe(before)
    expect(state.server.status(HOST).local).toMatchObject({ inflight: 0, lastError: "host_scope" })
    state.epoch++
    await arm(state.epoch)
  })

  test("the broker unreachable: the sink after one wait, `unavailable`, with the fail-closed grace", async () => {
    await state.server.close(HOST)
    await until(() => state.server.status(HOST).state === "disconnected")
    const started = Date.now()
    const { http, response } = await send(KEYLESS, "ses_down")
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(state.handle.api.isSink(http.request.url)).toBe(true)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unavailable")
    const event = retry(KEYLESS, "ses_down")
    expect(state.handle.api.retryBefore(event)).toBe(true)
    expect(event.decision).toMatchObject({ retry: true })
    state.epoch++
    await arm(state.epoch)
  })
})

describe("the sink's answer (SLM)", () => {
  test("a known reason gets its line, anything else is `blocked`; nothing of the request comes back", () => {
    expect(JSON.parse(Sink.body("local_pc_old")).error).toEqual({
      type: "own_broker_unavailable",
      code: "local_pc_old",
      message: Sink.REASONS.local_pc_old,
    })
    expect(JSON.parse(Sink.body("refused_account_not_remote")).error.code).toBe("refused_account_not_remote")
    expect(JSON.parse(Sink.body("<script>")).error.code).toBe("blocked")
    expect(JSON.parse(Sink.body(undefined)).error.code).toBe("blocked")
    expect(JSON.parse(Sink.body("__proto__")).error.code).toBe("blocked")
  })
})

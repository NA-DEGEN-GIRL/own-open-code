// B6 (04 §8.11.4.4, §8.11.8, T8): the remote mode's Claude route against a real local broker and its egress relay in
// one process (no ssh): the local BrokerHost (Claude facts stubbed, the fake claude-auth shim, a fake upstream) on one
// OWN_HOME, a RemoteHost on another, armed with both endpoints over loopback TCP like the tunnel's TCP fallback. The
// hooks are driven the way core calls them. Every row of the route table, the sink-first order, the header cleaning,
// every row of the retry table, and the observation filters. Fake tokens and keys only.
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
import { Account, Broker, type Limit, type Registry } from "@own/protocol"
import { Contract } from "../../src/broker/contract.js"
import { BrokerHost } from "../../src/broker/host.js"
import type { Server } from "../../src/broker/server.js"
import { Clock } from "../../src/clock.js"
import type { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { RemoteHost } from "../../src/remote/host.js"
import { registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { writeFakeClaudeAuth, type FakeState } from "../support/fake-claude-auth.js"

setDefaultTimeout(30_000)

const HOST = "h-claude1"
const TOKEN = "sk-ant-oat01-ownRouteFakeToken0000000001"
const SESSION = "ses_claude_route"

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
  fake: FakeState
  facts: Plugins.ClaudeRemote
  /** The PC's account list of this version is on disk (02 §8.7 CS: the relay signs nothing before). */
  listed: boolean
  alerts: Array<Record<string, unknown>>
  logs: string[]
  upstream: {
    url: string
    seen: Array<{ readonly authorization: string | null }>
    status: number
    headers: Record<string, string>
    stop(): void
  }
  epoch: number
}

function events(sessionID = SESSION) {
  const model = { providerID: "anthropic", id: "claude-fake" }
  const request: SessionModelRequest = {
    sessionID,
    agent: "build",
    model,
    kind: "context",
    headers: { authorization: "Bearer sk-host-own", "X-Api-Key": "sk-host-key", "anthropic-version": "2023-06-01" },
  } as unknown as SessionModelRequest
  const http: SessionHttpRequest = {
    sessionID,
    agent: "build",
    model,
    kind: "context",
    request: new Request("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer sk-host-own",
        "x-api-key": "sk-host-key",
        cookie: "c=1",
        "x-stainless-os": "Linux",
        "x-opencode-session": sessionID,
      },
      body: JSON.stringify({ model: "claude-fake", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
    }),
  } as unknown as SessionHttpRequest
  return { request, http }
}

function retry(sessionID = SESSION, attempt = 2): SessionRetry {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-fake" },
    error: { type: "provider", message: "x" },
    attempt,
    decision: { retry: true, delay: 1_000 },
  } as unknown as SessionRetry
}

function respond(event: SessionHttpRequest, response: Response): SessionHttpResponse {
  return { ...event, request: event.request, response } as unknown as SessionHttpResponse
}

/** Routes, rewrites and sends one request the way core does: model.request → http.request → fetch → http.response. */
async function send(
  sessionID = SESSION,
  routing: { readonly trust: "ok" | "blocked_by_plugin"; readonly conflict: boolean } = { trust: "ok", conflict: false },
) {
  const { request, http } = events(sessionID)
  await state.handle.api.claudeRoute(request, routing)
  state.handle.api.onHttpRequest(http, "acc_claude_slot")
  const response = await fetch(http.request)
  const refused = state.handle.api.onEgressResponse(respond(http, response))
  return { request, http, response, refused }
}

async function arm(epoch: number) {
  const ports = await state.server.listen(HOST)
  const key = randomBytes(32)
  state.server.setKey(HOST, { epoch, key })
  state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 2 })
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
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-route-")))
  const shim = writeFakeClaudeAuth(path.join(state.root, "claude-auth"))
  await import(shim.entry)
  state.fake = ((await import(shim.module)) as { fake: FakeState }).fake
  state.fake.account = { source: "fake", token: TOKEN }
  state.fake.stored = TOKEN
  state.alerts = []
  state.logs = []
  state.epoch = 100
  const seen: Array<{ readonly authorization: string | null }> = []
  const upstream = { status: 200, headers: {} as Record<string, string> }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({ authorization: request.headers.get("authorization") })
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: upstream.status,
        headers: { "content-type": "text/event-stream", ...upstream.headers },
      })
    },
  })
  state.upstream = {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    get status() {
      return upstream.status
    },
    set status(value) {
      upstream.status = value
    },
    get headers() {
      return upstream.headers
    },
    set headers(value) {
      upstream.headers = value
    },
    stop: () => void server.stop(true),
  }
  state.facts = { ready: true, billing: false, acknowledged: true, fast: true, entry: shim.entry }
  state.listed = true
  state.local = await testDeps({
    logs: state.logs,
    ctx: { app: { version: "local" } },
    control: true,
    options: { broker: { brokerWaitMs: 300, claudeUpstream: state.upstream.url } },
  })
  const runtime = state.local.deps.runtime
  await runtime.registry.write({
    ...(await registryWith([{ kind: "oai", label: "Alpha", slug: "alpha" }])),
    claudeSlot: { accountID: "acc_claude_slot", label: "PC Claude", shortLabel: "PC", color: "orange", remoteHosts: [HOST] },
  } satisfies Registry.File)
  const localModules = {
    logins: { headers: async () => ({ ok: false }), refresher: () => undefined, test: async () => ({}) },
    telemetry: { alert: () => {} },
    plugins: {
      claudeSlot: () => ({ detected: true, verified: true, version: "0.0.0-fake", integrity: "x" }),
      claudeRemote: () => state.facts,
      refreshed: async () => {},
    },
    // 02 §8.7: the slot's own account only, on a plugin that runs one account.
    claude: {
      entry: (accountID: string) => (accountID === "acc_claude_slot" ? { accountID, key: "c:/fake/.claude" } : undefined),
      multi: () => false,
      usable: (accountID: string) => accountID === "acc_claude_slot",
      ready: async () => state.listed,
    },
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
    telemetry: { alert: (input: Record<string, unknown>) => void state.alerts.push(input) },
  } as unknown as Modules.All)
  state.client = Contract.lookup(Contract.remoteKey(runtime.buildId)) as Contract.RemoteBrokerClient
  await arm(state.epoch)
  await until(() => state.handle.api.claude()?.state === "enabled")
}, 30_000)

afterAll(async () => {
  await state.handle?.release()
  state.detachRemote?.()
  await state.detach?.()
  state.upstream?.stop()
  await state.remote?.[Symbol.asyncDispose]()
  await state.local?.[Symbol.asyncDispose]()
  fs.rmSync(state.root, { recursive: true, force: true })
  // Neither side logged a token or a proof.
  expect(state.logs.join("\n")).not.toContain(TOKEN)
  expect(state.logs.join("\n")).not.toContain("v1.10")
}, 30_000)

describe("the route of an anthropic request (04 §8.11.4.4)", () => {
  test("enabled, no conflict, trust ok, broker up: the PC's relay, host credentials gone", async () => {
    const before = state.upstream.seen.length
    const { request, http, response, refused } = await send()
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).toEqual(["anthropic-version"])
    expect(new URL(http.request.url).hostname).toBe("127.0.0.1")
    expect(http.request.headers.get(Broker.EGRESS_HEADER)).toMatch(/^v2\.100\.\d+\.acc_claude_slot\.[0-9a-f]{64}$/)
    for (const name of ["authorization", "x-api-key", "cookie", "x-stainless-os"])
      expect(http.request.headers.get(name)).toBeNull()
    expect(http.request.headers.get("x-opencode-session")).toBe(SESSION)
    expect(response.status).toBe(200)
    expect(response.headers.get(Broker.EGRESS_HEADER)).toBe("1")
    expect(refused).toBe(false)
    await response.text()
    expect(state.upstream.seen.length).toBe(before + 1)
    // The relay signed it with this PC's plugin, not with anything of the host.
    expect(state.upstream.seen.at(-1)!.authorization).toBe(`Bearer ${TOKEN}`)
    // A provider answer through the relay: the retry hook classifies it as usual.
    expect(state.handle.api.retryBefore(retry())).toBe(false)
  })

  test("each other row sends it to the sink, first, with the reason the retry decision needs", async () => {
    const sinkRow = async (
      routing: { readonly trust: "ok" | "blocked_by_plugin"; readonly conflict: boolean },
      sessionID: string,
    ) => {
      const { http, response } = await send(sessionID, routing)
      expect(state.handle.api.isSink(http.request.url)).toBe(true)
      expect(response.status).toBe(401)
      expect(response.headers.get(Broker.FAIL_CLOSED_HEADER)).toBe("sink")
      const event = retry(sessionID)
      expect(state.handle.api.retryBefore(event)).toBe(true)
      return event.decision
    }
    expect(await sinkRow({ trust: "ok", conflict: true }, "ses_conflict")).toEqual({ retry: false })
    expect(state.alerts.at(-1)).toMatchObject({ code: "claude_remote_conflict", sessionID: "ses_conflict" })
    expect(await sinkRow({ trust: "blocked_by_plugin", conflict: false }, "ses_blocked")).toEqual({ retry: false })

    // The PC switches this host off: the next view says `off`.
    state.facts = { ...state.facts, acknowledged: false }
    state.local.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "remote" })
    await until(() => state.handle.api.claude()?.state === "consent")
    expect(await sinkRow({ trust: "ok", conflict: false }, "ses_consent")).toEqual({ retry: false })
    expect(state.alerts.at(-1)).toMatchObject({ code: "claude_remote_refused", sessionID: "ses_consent" })
    expect(String(state.alerts.at(-1)!.message)).toContain("원격 사용 동의")
    // Once per session and code.
    const count = state.alerts.length
    expect(state.handle.api.retryBefore(retry("ses_consent", 3))).toBe(true)
    expect(state.alerts).toHaveLength(count)
    state.facts = { ...state.facts, acknowledged: true }
    state.local.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "remote" })
    await until(() => state.handle.api.claude()?.state === "enabled")
  })

  test("the broker unreachable: the sink, after one wait, with the fail-closed grace", async () => {
    const egress = state.server.status(HOST)
    expect(egress.state).toBe("connected")
    await state.server.close(HOST)
    await until(() => state.client.status().state !== "connected")
    const started = Date.now()
    const { http, response } = await send("ses_down")
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(state.handle.api.isSink(http.request.url)).toBe(true)
    await response.text()
    const event = retry("ses_down")
    expect(state.handle.api.retryBefore(event)).toBe(true)
    expect(event.decision).toMatchObject({ retry: true })
    // The second attempt of the call does not wait again.
    const again = Date.now()
    await send("ses_down")
    expect(Date.now() - again).toBeLessThan(250)
    state.epoch++
    await arm(state.epoch)
  })
})

describe("relay refusals and the retry table (04 §8.11.8)", () => {
  const refusal = async (code: Broker.EgressError, sessionID: string) => {
    const { http } = events(sessionID)
    await state.handle.api.claudeRoute(events(sessionID).request, { trust: "ok", conflict: false })
    state.handle.api.onHttpRequest(http, "acc_claude_slot")
    const response = new Response("{}", { status: 403, headers: { [Broker.EGRESS_ERROR_HEADER]: code } })
    // Skipped by own observers: not a provider answer.
    expect(state.handle.api.onEgressResponse(respond(http, response))).toBe(true)
    const event = retry(sessionID)
    const handled = state.handle.api.retryBefore(event)
    return { handled, decision: event.decision }
  }

  test("refusal codes end the turn with claude_remote_refused; busy and rate_limited wait 2 s; 502 is normal", async () => {
    for (const code of ["off", "host_scope", "consent", "not_ready", "billing", "needs_reauth", "too_large", "bad_request"] as const) {
      expect(await refusal(code, `ses_r_${code}`)).toEqual({ handled: true, decision: { retry: false } })
      expect(state.alerts.at(-1)).toMatchObject({
        code: "claude_remote_refused",
        sessionID: `ses_r_${code}`,
        accountID: "acc_claude_slot",
      })
    }
    // not_ready does not say why: it names the remedies, those of Claude Code's own login first (CS).
    const notReady = state.alerts.find((alert) => alert.sessionID === "ses_r_not_ready")?.message
    expect(notReady).toContain("PC의 Claude Code에서 요청을 한 번 보내거나")
    expect(notReady).toContain("[own 전용 로그인으로 바꾸기]")
    expect(notReady).toContain("[다시 로그인]")
    expect(await refusal("busy", "ses_busy")).toEqual({ handled: true, decision: { retry: true, delay: 2_000 } })
    expect(await refusal("rate_limited", "ses_rate")).toEqual({ handled: true, decision: { retry: true, delay: 2_000 } })
    expect((await refusal("upstream_unreachable", "ses_502")).handled).toBe(false)
  })

  test("mac: the first is retried at once (the epoch may be changing), later ones get the grace", async () => {
    expect(await refusal("mac", "ses_mac")).toEqual({ handled: true, decision: { retry: true, delay: 0 } })
    const second = await refusal("mac", "ses_mac")
    expect(second.handled).toBe(true)
    expect(second.decision.retry).toBe(true)
    expect(second.decision).not.toEqual({ retry: true, delay: 0 })
  })

  test("a real relay refusal: the host switched off on the PC gets 403 off from the relay", async () => {
    // Route as enabled (the mirror still says so), then the PC refuses at the relay.
    await state.handle.api.claudeRoute(events("ses_live").request, { trust: "ok", conflict: false })
    const { http } = events("ses_live")
    state.handle.api.onHttpRequest(http, "acc_claude_slot")
    state.facts = { ...state.facts, billing: true }
    state.local.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "connection" })
    await until(() => state.server.status(HOST).claude?.state === "billing")
    const response = await fetch(http.request)
    expect(response.status).toBe(403)
    expect(state.handle.api.onEgressResponse(respond(http, response))).toBe(true)
    const event = retry("ses_live")
    expect(state.handle.api.retryBefore(event)).toBe(true)
    expect(event.decision).toEqual({ retry: false })
    state.facts = { ...state.facts, billing: false }
    state.local.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "connection" })
    await until(() => state.handle.api.claude()?.state === "enabled")
  })

  // 02 §8.7 (CS re-review a): the first start after an update may find an older own's account list; nothing is signed
  // for a host before the PC saw its own list of this version.
  test("before the PC's account list of this version is on disk, the relay answers 403 not_ready and sends nothing", async () => {
    const before = state.upstream.seen.length
    state.listed = false
    try {
      const { response, refused } = await send("ses_not_listed")
      expect(response.status).toBe(403)
      expect(response.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("not_ready")
      expect(refused).toBe(true)
      await response.text()
      expect(state.upstream.seen.length).toBe(before)
    } finally {
      state.listed = true
    }
  })
})

describe("observations of the Claude slot on the host (04 §8.11.10)", () => {
  test("its windows are not spooled; its exhaustion reaches the PC as an event", async () => {
    const runtime = state.remote.deps.runtime
    const claude: Limit.Window = {
      id: "claude.5h",
      accountID: Account.ID.claudeSlot,
      providerID: "anthropic" as Limit.Window["providerID"],
      scope: "account",
      kind: "rolling_quota",
      label: "5시간",
      windowMinutes: 300,
      usedPercent: 99,
      status: "warning",
      confidence: "live",
      source: "header",
      observedAt: Date.now(),
    }
    runtime.broadcast.emit("limits.updated", { windows: [claude] })
    runtime.broadcast.emit("exhausted", {
      exhaustion: { accountID: Account.ID.claudeSlot, windowId: "claude.5h", until: Date.now() + 60_000, class: "hard" },
      providerID: "anthropic",
      sessionID: SESSION,
    })
    // The spool takes the event only; the broker writes it to this PC's events ledger.
    const local = state.local.deps.runtime
    const month = new Date().toISOString().slice(0, 7)
    const event = await until(async () => {
      await local.ledger.flush()
      return (await local.ledger.eventsOf(month)).find((entry) => entry.type === "exhaustion")
    })
    expect(event).toMatchObject({ type: "exhaustion", accountID: "acc_claude_slot", providerID: "anthropic" })
    // Had the window been spooled, this PC would have dropped it as an invalid observation and recorded that.
    expect((await local.ledger.eventsOf(month)).filter((entry) => entry.type === "remote.observation.rejected")).toEqual([])
    expect(local.limits.list({ accountID: "acc_claude_slot" }).filter((window) => window.origin === HOST)).toEqual([])
  })
})

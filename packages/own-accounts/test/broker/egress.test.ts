// B1 (04 §8.11.4.5, T5): the PC egress relay against a fake Anthropic upstream and the fake claude-auth shim (loaded
// through the real `ClaudeWire` seam). Every refusal happens before any upstream call; what reaches upstream carries
// this PC's plugin headers and identity only; the answer streams with backpressure and cancellation; one first-401
// recovery at a time (D2) and a 60 s hold after a final 401; the unified headers become this PC's limit windows.
// Every token is fake; the captured logs must never hold one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Account, Broker, type Limit, type Plugin } from "@own/protocol"
import { ClaudeWire } from "../../src/broker/claude-wire.js"
import { Egress } from "../../src/broker/egress.js"
import { Logger } from "../../src/logger.js"
import { hashSecret, startFakeAnthropic, type FakeAnthropic } from "../e2e-kit/index.js"
import { writeFakeClaudeAuth, type FakeState } from "../support/fake-claude-auth.js"

const HOST = "h-egress1"
const EPOCH = 1_790_000_000
const KEY = randomBytes(32)
const TOKEN = "sk-ant-oat01-ownEgressFakeToken0000000001"
const TOKEN2 = "sk-ant-oat01-ownEgressFakeToken0000000002"
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const logs: string[] = []
const log = Logger.create({ scope: "egress-test", level: "debug", sink: (line) => logs.push(line) })
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-egress-")))
const counter = { n: 0 }

let fake: FakeState
let entry: string

beforeAll(async () => {
  const shim = writeFakeClaudeAuth(path.join(root, "claude-auth"))
  entry = shim.entry
  await import(shim.entry)
  fake = ((await import(shim.module)) as { fake: FakeState }).fake
})

afterAll(() => {
  // No token, proof or key of this file ever reached a log line.
  const text = logs.join("\n")
  for (const secret of [TOKEN, TOKEN2, KEY.toString("hex"), "Bearer"]) expect(text).not.toContain(secret)
  fs.rmSync(root, { recursive: true, force: true })
})

function proof(
  n = ++counter.n,
  input: { readonly key?: Uint8Array; readonly epoch?: number; readonly accountID?: string } = {},
) {
  const epoch = input.epoch ?? EPOCH
  const accountID = input.accountID ?? "acc_claude_slot"
  const mac = createHmac("sha256", input.key ?? KEY)
    .update(Broker.egressMacInput({ hostId: HOST, epoch, n, accountID }))
    .digest("hex")
  return Broker.egressHeader({ epoch, n, accountID, mac })
}

function messages(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "claude-fake",
    max_tokens: 64,
    stream: true,
    system: [{ type: "text", text: "You are a careful agent." }],
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  })
}

interface Rig extends AsyncDisposable {
  readonly relay: Egress.Relay
  readonly url: string
  readonly clock: { now: number }
  readonly state: { value: Plugin.ClaudeRemoteState }
  readonly limits: Limit.Window[]
  /** Windows a response said the account no longer has (02 §7.1.2). */
  readonly dropped: Array<Pick<Limit.Window, "accountID" | "id">>
  readonly audits: Array<Record<string, unknown>>
  send(init?: { headers?: Record<string, string>; body?: BodyInit; path?: string; method?: string }): Promise<Response>
}

async function rig(upstream: string, options: Egress.Options = {}): Promise<Rig> {
  fake.account = { source: "fake", token: TOKEN }
  fake.stored = TOKEN
  fake.refresh = async () => null
  for (const name of Object.keys(fake.calls) as Array<keyof FakeState["calls"]>) fake.calls[name] = 0
  const clock = { now: 1_790_000_000_000 }
  const state = { value: "enabled" as Plugin.ClaudeRemoteState }
  const limits: Limit.Window[] = []
  const dropped: Array<Pick<Limit.Window, "accountID" | "id">> = []
  const audits: Array<Record<string, unknown>> = []
  const relay = new Egress.Relay(
    {
      now: () => clock.now,
      log,
      upstream,
      wire: () => ClaudeWire.load(entry, path.join(path.dirname(entry), "state")),
      limits: (windows, gone = []) => {
        limits.push(...windows)
        dropped.push(...gone)
      },
      audit: async (data) => {
        audits.push(data)
      },
      changed: () => {},
    },
    options,
  )
  const port = await relay.listen(HOST, {
    local: async () => ({ ok: false, status: 404, code: "not_found" }),
    key: () => ({ epoch: EPOCH, key: KEY }),
    state: () => state.value,
    account: (accountID) => (accountID === "acc_claude_slot" ? { key: undefined } : undefined),
  })
  const url = `http://127.0.0.1:${port}`
  return {
    relay,
    url,
    clock,
    state,
    limits,
    dropped,
    audits,
    send: (init = {}) =>
      fetch(`${url}${init.path ?? "/v1/messages?beta=true"}`, {
        method: init.method ?? "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          [Broker.EGRESS_HEADER]: proof(),
          ...init.headers,
        },
        body: init.method === "GET" ? undefined : (init.body ?? messages()),
      }),
    [Symbol.asyncDispose]: () => relay.shutdown(),
  }
}

/** A programmable upstream for the stream tests: the handler sees each request (and its abort signal). */
function upstream(handle: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      seen.push(request)
      return handle(request)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

let anthropic: FakeAnthropic
beforeAll(() => {
  anthropic = startFakeAnthropic({ credentials: { [TOKEN]: { domain: "pc" }, [TOKEN2]: { domain: "pc" } } })
})
afterAll(() => anthropic.stop())

describe("refusals: nothing reaches upstream", () => {
  test("no proof, a wrong one, another epoch, a reused or too old counter: 401 mac", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    const refused = async (header: string | undefined) => {
      const response = await r.send({ headers: header === undefined ? {} : { [Broker.EGRESS_HEADER]: header } })
      expect(response.status).toBe(401)
      expect(response.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("mac")
      expect(await response.text()).not.toContain("hi")
    }
    const response = await r.send({ headers: { [Broker.EGRESS_HEADER]: "" } })
    expect(response.status).toBe(401)
    await refused("v1.1.1.zz")
    await refused(proof(undefined, { key: randomBytes(32) }))
    await refused(proof(undefined, { epoch: EPOCH - 1 }))
    const used = ++counter.n
    expect((await r.send({ headers: { [Broker.EGRESS_HEADER]: proof(used) } })).status).toBe(200)
    await refused(proof(used))
    // Far ahead, then one more than the window below it.
    const ahead = counter.n + 5_000
    counter.n = ahead
    expect((await r.send({ headers: { [Broker.EGRESS_HEADER]: proof(ahead) } })).status).toBe(200)
    await refused(proof(ahead - Broker.EGRESS_REPLAY_WINDOW))
    expect((await r.send({ headers: { [Broker.EGRESS_HEADER]: proof(ahead - Broker.EGRESS_REPLAY_WINDOW + 1) } })).status).toBe(200)
    expect(anthropic.requests).toHaveLength(3)
  })

  test("past 20 failed proofs a minute the host is answered at once, even with a valid proof", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    for (let index = 0; index < Broker.EGRESS_MAC_FAILURES_PER_MINUTE; index++)
      expect((await r.send({ headers: { [Broker.EGRESS_HEADER]: "v1.0.1.00" } })).status).toBe(401)
    const blocked = await r.send()
    expect(blocked.status).toBe(401)
    expect(blocked.headers.get("connection")).toBe("close")
    expect(anthropic.requests).toHaveLength(0)
    r.clock.now += 60_001
    expect((await r.send()).status).toBe(200)
  })

  test("wrong method, path or query: 405, 404, 400", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    expect((await r.send({ method: "GET" })).status).toBe(405)
    expect((await r.send({ path: "/v1/complete" })).status).toBe(404)
    expect((await r.send({ path: "/v1/messages/count_tokens" })).status).toBe(404)
    expect((await r.send({ path: "/v1/messages?beta=false&x=1" })).status).toBe(400)
    expect((await r.send({ path: "/v1/messages" })).status).toBe(200)
    expect(anthropic.requests).toHaveLength(1)
  })

  test("a verdict other than enabled is its own 403; rate and concurrency bounds answer 429", async () => {
    const held = upstream(() => new Promise<Response>(() => {}))
    try {
      await using r = await rig(held.url)
      for (const state of ["off", "host_scope", "consent", "not_ready", "billing"] as const) {
        r.state.value = state
        const response = await r.send()
        expect(response.status).toBe(403)
        expect(response.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe(state)
      }
      // 5 of the burst of 30 used; 25 more pass the rate check, the next is refused.
      for (let index = 0; index < Broker.EGRESS_RATE_BURST - 5; index++) expect((await r.send()).status).toBe(403)
      const limited = await r.send()
      expect(limited.status).toBe(429)
      expect(limited.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("rate_limited")
      expect(held.seen).toHaveLength(0)
      // 16 in flight (the upstream never answers), the 17th is busy.
      r.state.value = "enabled"
      r.clock.now += 10_000
      const pending = Array.from({ length: Broker.EGRESS_MAX_INFLIGHT }, () => r.send().catch(() => undefined))
      while (held.seen.length < Broker.EGRESS_MAX_INFLIGHT) await Bun.sleep(10)
      const busy = await r.send()
      expect(busy.status).toBe(429)
      expect(busy.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("busy")
      r.relay.abort(HOST)
      await Promise.all(pending)
      expect(r.relay.status(HOST)?.inflight).toBe(0)
    } finally {
      held.stop()
    }
  })

  test("a body over 32 MiB is 413; an upload that stalls is cut", async () => {
    await using r = await rig(anthropic.url, { uploadTimeoutMs: 300 })
    anthropic.reset()
    // Raw uploads: the relay answers from the head (a declared length past the bound) or cuts a stalled body.
    const port = Number(new URL(r.url).port)
    const raw = (length: number, body: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () =>
          socket.write(
            [
              "POST /v1/messages?beta=true HTTP/1.1",
              "host: x",
              "content-type: application/json",
              `${Broker.EGRESS_HEADER}: ${proof()}`,
              `content-length: ${length}`,
              "",
              body,
            ].join("\r\n"),
          ),
        )
        let data = ""
        socket.on("data", (chunk) => (data += chunk))
        socket.on("close", () => resolve(data))
        socket.on("error", () => resolve(data))
        setTimeout(() => {
          socket.destroy()
          resolve(`timeout:${data}`)
        }, 5_000)
      })
    const large = await raw(Broker.EGRESS_MAX_BODY_BYTES + 1, "")
    expect(large.startsWith("HTTP/1.1 413")).toBe(true)
    expect(large).toContain(`${Broker.EGRESS_ERROR_HEADER}: too_large`)
    // A body that announces 100 bytes and sends 10.
    const answer = await raw(100, '{"model":"')
    expect(answer.startsWith("HTTP/1.1 408")).toBe(true)
    expect(answer).toContain(`${Broker.EGRESS_ERROR_HEADER}: bad_request`)
    expect(anthropic.requests).toHaveLength(0)
    // Not JSON, or a system that is not text blocks.
    expect((await r.send({ body: "{nope" })).status).toBe(400)
    expect((await r.send({ body: messages({ system: [{ type: "image" }] }) })).status).toBe(400)
    expect(anthropic.requests).toHaveLength(0)
  })

  test("no claude-auth wire (no account): 403 not_ready", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    fake.account = null
    const response = await r.send()
    expect(response.status).toBe(403)
    expect(response.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("not_ready")
    expect(anthropic.requests).toHaveLength(0)
  })
})

describe("what reaches upstream", () => {
  test("this PC's plugin headers only, whatever the host sent; the origin is fixed", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    const response = await r.send({
      headers: {
        authorization: "Bearer sk-host-own-token",
        "x-api-key": "sk-host-key",
        cookie: "a=b",
        "x-stainless-os": "linux",
        "x-stainless-arch": "x64",
        "user-agent": "host-agent/1.0",
        "x-own-secret": "1",
        host: "api.evil.example",
        "anthropic-beta": "fast-mode-2026-02-01",
        "x-opencode-session": "ses_1",
        "x-session-affinity": "ses_1",
      },
    })
    expect(response.status).toBe(200)
    await response.text()
    const seen = anthropic.requests[0]!
    expect(seen.path).toBe("/v1/messages?beta=true")
    expect(seen.headers.authorization).toBe(hashSecret(`Bearer ${TOKEN}`))
    expect(seen.headers["x-api-key"]).toBeUndefined()
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers["x-stainless-os"]).toBe(process.platform)
    expect(seen.headers["x-stainless-arch"]).toBeUndefined()
    expect(seen.headers["user-agent"]).toStartWith("claude-cli/")
    expect(Object.keys(seen.headers).filter((name) => name.startsWith("x-own-"))).toEqual([])
    expect(seen.headers.host).toBe(new URL(anthropic.url).host)
    expect(seen.headers["anthropic-beta"]?.split(",")).toEqual(
      expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20", "fast-mode-2026-02-01"]),
    )
    expect(seen.headers["x-opencode-session"]).toBe("ses_1")
    expect(seen.headers["x-session-affinity"]).toBe("ses_1")
    // The relay never calls the plugin's refresh paths on a good answer.
    expect(fake.calls).toMatchObject({ prepare: 1, finish: 1, forceRefresh: 0, reload: 0 })
  })

  test("the identity goes in once, first, without cache_control; a string or absent system is normalized", async () => {
    await using r = await rig(anthropic.url)
    const systemOf = async (body: string) => {
      anthropic.reset()
      await (await r.send({ body })).text()
      return (anthropic.requests[0]!.json as { system: Array<Record<string, unknown>> }).system
    }
    expect(await systemOf(messages())).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "You are a careful agent." },
    ])
    expect(
      await systemOf(messages({ system: [{ type: "text", text: IDENTITY }, { type: "text", text: "x", cache_control: { type: "ephemeral" } }] })),
    ).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "x", cache_control: { type: "ephemeral" } },
    ])
    expect(await systemOf(messages({ system: "Plain." }))).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "Plain." },
    ])
    expect(await systemOf(messages({ system: undefined }))).toEqual([{ type: "text", text: IDENTITY }])
  })

  test("tool names go out prefixed and come back as they were", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    anthropic.enqueue({ type: "tool-call", name: "mcp_bash", input: { command: "ls" } })
    const response = await r.send({
      body: messages({ tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }] }),
    })
    const text = await response.text()
    expect((anthropic.requests[0]!.json as { tools: Array<{ name: string }> }).tools[0]!.name).toBe("mcp_bash")
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain("mcp_bash")
  })

  test("the answer: no content-encoding, content-length or set-cookie, and x-own-egress: 1", async () => {
    const up = upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              // Streamed in two parts, so the relay answers before the end (chunked, no length of its own either).
              controller.enqueue(new TextEncoder().encode(sse("message_start", { type: "message_start" })))
              await Bun.sleep(300)
              controller.enqueue(new TextEncoder().encode(sse("message_stop", { type: "message_stop" })))
              controller.close()
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "set-cookie": "sid=1",
              "x-request-id": "req_1",
            },
          },
        ),
    )
    try {
      await using r = await rig(up.url)
      const response = await r.send()
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(response.headers.get("content-encoding")).toBeNull()
      expect(response.headers.get("content-length")).toBeNull()
      expect(response.headers.get(Broker.EGRESS_HEADER)).toBe("1")
      expect(response.headers.get("x-request-id")).toBe("req_1")
      expect(await response.text()).toContain("message_stop")
    } finally {
      up.stop()
    }
  })
})

describe("streaming and cancellation", () => {
  test("the first event arrives before upstream finishes; a host that stops reading stops the upstream pull", async () => {
    const release = Promise.withResolvers<void>()
    const pulls = { count: 0 }
    const chunk = new TextEncoder().encode(`${sse("ping", { type: "ping" })}`.padEnd(64 * 1024, " "))
    const up = upstream((request) => {
      const url = new URL(request.url)
      if (url.searchParams.get("beta") === "true" && request.headers.get("x-test") === "slow")
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls.count++
              controller.enqueue(chunk)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(sse("message_start", { type: "message_start" })))
            await release.promise
            controller.enqueue(new TextEncoder().encode(sse("message_stop", { type: "message_stop" })))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    try {
      await using r = await rig(up.url)
      const response = await r.send()
      const reader = response.body!.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      expect(first).toContain("message_start")
      release.resolve()
      let rest = ""
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        rest += new TextDecoder().decode(next.value)
      }
      expect(rest).toContain("message_stop")

      // Not reading: the upstream is pulled only as far as the buffers on the way allow.
      const slow = await r.send({ headers: { "x-test": "slow" } })
      await Bun.sleep(800)
      const pulled = pulls.count
      await Bun.sleep(400)
      expect(pulls.count - pulled).toBeLessThan(4)
      expect(pulls.count * chunk.length).toBeLessThan(64 * 1024 * 1024)
      await slow.body?.cancel()
    } finally {
      up.stop()
    }
  })

  test("a host that goes away mid-stream ends the upstream request within a second", async () => {
    const closed = Promise.withResolvers<number>()
    const up = upstream(
      (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse("message_start", { type: "message_start" })))
              request.signal.addEventListener("abort", () => closed.resolve(performance.now()))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    try {
      await using r = await rig(up.url)
      const controller = new AbortController()
      const response = await fetch(`${r.url}/v1/messages?beta=true`, {
        method: "POST",
        headers: { "content-type": "application/json", [Broker.EGRESS_HEADER]: proof() },
        body: messages(),
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      await reader.read()
      expect(r.relay.status(HOST)?.inflight).toBe(1)
      const abortedAt = performance.now()
      controller.abort()
      const seenAt = await Promise.race([closed.promise, Bun.sleep(3_000).then(() => Number.NaN)])
      expect(seenAt - abortedAt).toBeLessThan(1_000)
      while ((r.relay.status(HOST)?.inflight ?? 0) > 0) await Bun.sleep(10)
    } finally {
      up.stop()
    }
  })

  test("a silent upstream outlasts the idle timeout once the request is checked", async () => {
    const up = upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await Bun.sleep(2_500)
              controller.enqueue(new TextEncoder().encode(sse("message_stop", { type: "message_stop" })))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    try {
      // The test idle timeout (1 s) stands for the production 30 s, the 2.5 s pause for 4.5 minutes.
      await using r = await rig(up.url, { idleTimeoutSeconds: 1 })
      const response = await r.send()
      expect(await response.text()).toContain("message_stop")
    } finally {
      up.stop()
    }
  }, 10_000)
})

describe("401 recovery (D2), limits and audit", () => {
  test("twenty concurrent 401s refresh once; the others adopt the refreshed token", async () => {
    const strict = startFakeAnthropic({ credentials: { [TOKEN2]: { domain: "pc" } } })
    try {
      await using r = await rig(strict.url)
      fake.refresh = async () => {
        await Bun.sleep(20)
        return TOKEN2
      }
      const responses = await Promise.all(Array.from({ length: 20 }, () => r.send()))
      await Promise.all(responses.map((response) => response.text()))
      // Past 16 in flight the rest are `busy` (the host retries them); every relayed one succeeded.
      const busy = responses.filter((response) => response.status === 429)
      expect(busy.length).toBeLessThanOrEqual(20 - Broker.EGRESS_MAX_INFLIGHT)
      expect(busy.every((response) => response.headers.get(Broker.EGRESS_ERROR_HEADER) === "busy")).toBe(true)
      expect(responses.filter((response) => response.status === 200)).toHaveLength(20 - busy.length)
      const retried = await Promise.all(busy.map(() => r.send()))
      expect(retried.map((response) => response.status)).toEqual(busy.map(() => 200))
      await Promise.all(retried.map((response) => response.text()))
      expect(fake.calls.forceRefresh).toBe(1)
      expect(r.relay.status(HOST)?.holdUntil).toBeNull()
    } finally {
      await strict.stop()
    }
  })

  test("a final 401 holds the host needs_reauth for 60 s; queued recoveries do not refresh again", async () => {
    const strict = startFakeAnthropic({ credentials: { [TOKEN2]: { domain: "pc" } } })
    try {
      await using r = await rig(strict.url)
      const responses = await Promise.all(Array.from({ length: 5 }, () => r.send()))
      const statuses = responses.map((response) => response.status).sort()
      expect(statuses).toEqual([401, 403, 403, 403, 403])
      expect(fake.calls.forceRefresh).toBe(1)
      const held = r.relay.status(HOST)
      expect(held?.holdUntil).toBe(r.clock.now + Broker.EGRESS_REAUTH_HOLD_MS)
      expect(held?.lastError).toBe("needs_reauth")
      strict.reset()
      const refused = await r.send()
      expect(refused.status).toBe(403)
      expect(refused.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("needs_reauth")
      expect(strict.requests).toHaveLength(0)
      r.clock.now += Broker.EGRESS_REAUTH_HOLD_MS
      fake.refresh = async () => TOKEN2
      expect((await r.send()).status).toBe(200)
    } finally {
      await strict.stop()
    }
  })

  test("unified headers become this PC's windows of acc_claude_slot, origin = host; the audit sums 5 minutes", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    anthropic.setUnified("pc", {
      status: "allowed_warning",
      fiveHourUtilization: 0.91,
      sevenDayUtilization: 0.4,
      fiveHourReset: 1_790_010_000,
      sevenDayReset: 1_790_500_000,
    })
    try {
      await (await r.send()).text()
      expect(r.limits.map((window) => [window.id, window.accountID, window.origin, window.status])).toEqual([
        ["claude.5h", "acc_claude_slot", HOST, "ok"],
        ["claude.7d", "acc_claude_slot", HOST, "ok"],
        ["claude.overage", "acc_claude_slot", HOST, "exhausted"],
      ])
      await r.send({ path: "/v1/complete" })
      await r.relay.sweep()
      expect(r.audits).toHaveLength(0)
      r.clock.now += Egress.AUDIT_WINDOW_MS
      await r.relay.sweep()
      expect(r.audits).toHaveLength(1)
      expect(r.audits[0]).toMatchObject({
        hostId: HOST,
        count: 1,
        statuses: { "200": 1 },
        refusals: { bad_request: 1 },
      })
      expect(Number(r.audits[0]!.bytesIn)).toBeGreaterThan(0)
      expect(Number(r.audits[0]!.bytesOut)).toBeGreaterThan(0)
      expect(JSON.stringify(r.audits)).not.toContain("hi")
      expect(r.dropped).toEqual([])
    } finally {
      anthropic.setUnified("pc", undefined)
    }
  })

  test("an answer with the weekly window only drops the account's claude.5h (verified Ultra, 02 §7.1.2)", async () => {
    await using r = await rig(anthropic.url)
    anthropic.reset()
    anthropic.setUnified("pc", { status: "allowed", sevenDayUtilization: 0.4, sevenDayReset: 1_790_500_000 })
    try {
      await (await r.send()).text()
      expect(r.limits.map((window) => [window.id, window.origin])).toEqual([
        ["claude.7d", HOST],
        ["claude.overage", HOST],
      ])
      expect(r.dropped).toEqual([{ accountID: Account.ID.claudeSlot, id: "claude.5h" }])
    } finally {
      anthropic.setUnified("pc", undefined)
    }
  })
})

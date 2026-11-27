// SLM (04 §8.14): the PC relay's local model route against a programmable fake model server on 127.0.0.1. Every
// refusal happens before any upstream call and says why in Korean; what reaches the server is the host's request as it
// came (path, query, body bytes and headers) without the host's credentials and own's proof, plus the account's key
// on this PC; the answer streams as it arrives, a host that goes away aborts it, and the requests in flight are
// counted apart from Claude's. Every key is fake; the captured logs must never hold one.
import { afterAll, describe, expect, test } from "bun:test"
import { createHmac, randomBytes } from "node:crypto"
import { Broker } from "@own/protocol"
import { Egress } from "../../src/broker/egress.js"
import { Logger } from "../../src/logger.js"

const HOST = "h-local1"
const EPOCH = 1_790_000_100
const KEY = randomBytes(32)
const ACCOUNT = "acc_01LOCALMODELFAKE00000000001"
const DENIED = "acc_01LOCALMODELDENIED0000001"
const PC_KEY = "sk-ownLocalRelayPcOnlyFakeKey000001"
const HOST_KEY = "sk-ownLocalRelayHostFakeKey0000001"
const logs: string[] = []
const log = Logger.create({ scope: "egress-local-test", level: "debug", sink: (line) => logs.push(line) })
const counter = { n: 0 }

afterAll(() => {
  const text = logs.join("\n")
  for (const secret of [PC_KEY, HOST_KEY, KEY.toString("hex")]) expect(text).not.toContain(secret)
})

function proof(
  path: string,
  input: { readonly n?: number; readonly key?: Uint8Array; readonly accountID?: string; readonly method?: string } = {},
) {
  const n = input.n ?? ++counter.n
  const accountID = input.accountID ?? ACCOUNT
  const mac = createHmac("sha256", input.key ?? KEY)
    .update(Broker.localMacInput({ hostId: HOST, epoch: EPOCH, n, accountID, method: input.method ?? "POST", path }))
    .digest("hex")
  return Broker.localHeader({ epoch: EPOCH, n, accountID, mac })
}

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** A fake model server: records each request and answers with `handle` (an SSE stream by default). */
function server(handle?: (request: Request) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const aborted: number[] = []
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "GET" ? "" : await request.text()
      seen.push({ method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body })
      request.signal.addEventListener("abort", () => aborted.push(Date.now()))
      if (handle) return handle(request)
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream", "x-served-by": "fake-local" },
      })
    },
  })
  return { origin: `http://127.0.0.1:${served.port}`, seen, aborted, stop: () => served.stop(true) }
}

async function rig(origin: string, options: { readonly keyed?: boolean } = {}) {
  const audits: Array<{ readonly kind: string; readonly data: Record<string, unknown> }> = []
  const relay = new Egress.Relay({
    now: Date.now,
    log,
    upstream: "http://127.0.0.1:9",
    wire: async () => ({ ok: false, detail: "wire" }),
    limits: () => {},
    audit: async (data, kind) => {
      audits.push({ kind, data })
    },
    changed: () => {},
  })
  const port = await relay.listen(HOST, {
    key: () => ({ epoch: EPOCH, key: KEY }),
    state: () => "off",
    account: () => undefined,
    local: async (accountID) => {
      if (accountID === DENIED) return { ok: false, status: 403, code: "host_scope" }
      if (accountID !== ACCOUNT) return { ok: false, status: 404, code: "not_found" }
      return {
        ok: true,
        origin,
        basePath: "/v1",
        headers: Object.fromEntries(options.keyed ? [["authorization", `Bearer ${PC_KEY}`]] : []),
      }
    },
  })
  const url = `http://127.0.0.1:${port}`
  return {
    relay,
    url,
    audits,
    send: (
      path: string,
      init: {
        readonly headers?: Record<string, string>
        readonly body?: string
        readonly method?: string
        readonly accountID?: string
        readonly signal?: AbortSignal
        readonly proof?: string | null
      } = {},
    ) => {
      const accountID = init.accountID ?? ACCOUNT
      const method = init.method ?? "POST"
      const header = init.proof === undefined ? proof(path, { accountID, method }) : init.proof
      return fetch(`${url}${Broker.LOCAL_PATH_PREFIX}${accountID}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(header === null ? {} : { [Broker.LOCAL_HEADER]: header }), ...init.headers },
        body: method === "GET" ? undefined : (init.body ?? '{"model":"m","stream":true,"messages":[]}'),
        signal: init.signal,
      })
    },
    [Symbol.asyncDispose]: () => relay.shutdown(),
  }
}

describe("the local model route of the PC relay", () => {
  test("the host's request reaches the account's server as it came, with the PC's key and nothing of the host's", async () => {
    const fake = server()
    await using r = await rig(fake.origin, { keyed: true })
    const body = JSON.stringify({ model: "tf-local", stream: true, messages: [{ role: "user", content: "git init" }] })
    const response = await r.send("/v1/chat/completions?x=1", {
      body,
      headers: {
        accept: "text/event-stream",
        "user-agent": "opencode/host",
        "x-session-affinity": "ses_1",
        authorization: `Bearer ${HOST_KEY}`,
        "x-api-key": HOST_KEY,
        cookie: "a=b",
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get(Broker.LOCAL_HEADER)).toBe("1")
    expect(response.headers.get("x-served-by")).toBe("fake-local")
    expect(await response.text()).toContain("[DONE]")
    expect(fake.seen).toHaveLength(1)
    const seen = fake.seen[0]!
    expect(seen.path).toBe("/v1/chat/completions?x=1")
    // The same bytes a conversation of this PC sends: prompt caching on the server is the same.
    expect(seen.body).toBe(body)
    expect(seen.headers.authorization).toBe(`Bearer ${PC_KEY}`)
    expect(seen.headers["x-api-key"]).toBeUndefined()
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers[Broker.LOCAL_HEADER]).toBeUndefined()
    expect(seen.headers["user-agent"]).toBe("opencode/host")
    expect(seen.headers["x-session-affinity"]).toBe("ses_1")
    expect(seen.headers.accept).toBe("text/event-stream")
    // The same framing as a conversation of this PC: a whole body with its length, never a chunked upload.
    expect(seen.headers["content-length"]).toBe(String(Buffer.byteLength(body)))
    expect(seen.headers["transfer-encoding"]).toBeUndefined()
    expect(r.relay.status(HOST)?.local).toEqual({ inflight: 0, lastError: null })
    fake.stop()
  })

  test("a keyless account's request carries no credential at all", async () => {
    const fake = server()
    await using r = await rig(fake.origin)
    const response = await r.send("/v1/chat/completions", { headers: { authorization: `Bearer ${HOST_KEY}` } })
    expect(response.status).toBe(200)
    await response.text()
    expect(fake.seen[0]!.headers.authorization).toBeUndefined()
    fake.stop()
  })

  test("refusals: a missing, wrong, moved or reused proof, another path, method or account; nothing reaches the server", async () => {
    const fake = server()
    await using r = await rig(fake.origin)
    const refused = async (response: Response, status: number, code: string) => {
      expect(response.status).toBe(status)
      expect(response.headers.get(Broker.LOCAL_ERROR_HEADER)).toBe(code)
      const json = (await response.json()) as { error: { type: string; code: string; message: string } }
      expect(json.error).toMatchObject({ type: "own_local_relay", code })
      expect(json.error.message).toBe(Egress.LOCAL_REFUSED[code as Broker.LocalError])
      expect(JSON.stringify(json)).not.toContain("git init")
    }
    await refused(await r.send("/v1/chat/completions", { proof: null }), 401, "mac")
    await refused(await r.send("/v1/chat/completions", { proof: proof("/v1/chat/completions", { key: randomBytes(32) }) }), 401, "mac")
    // The MAC covers the path: a proof for another path is refused.
    await refused(await r.send("/v1/chat/completions", { proof: proof("/v1/embeddings") }), 401, "mac")
    // And the account: a proof of one account moved to another one's route.
    await refused(
      await r.send("/v1/chat/completions", { accountID: DENIED, proof: proof("/v1/chat/completions") }),
      401,
      "mac",
    )
    const used = proof("/v1/chat/completions")
    const first = await r.send("/v1/chat/completions", { proof: used })
    expect(first.status).toBe(200)
    await first.text()
    await refused(await r.send("/v1/chat/completions", { proof: used }), 401, "mac")
    const before = fake.seen.length
    await refused(await r.send("/admin/shutdown"), 404, "bad_request")
    await refused(await r.send("/v1x/chat"), 404, "bad_request")
    await refused(await r.send("/v1/chat/completions", { method: "PUT" }), 405, "bad_request")
    await refused(await r.send("/v1/chat/completions", { accountID: DENIED }), 403, "host_scope")
    await refused(await r.send("/v1/chat/completions", { accountID: "acc_01NOSUCHLOCALMODEL000000001" }), 404, "not_found")
    expect(fake.seen.length).toBe(before)
    expect(r.relay.status(HOST)?.local.lastError).toBe("not_found")
    fake.stop()
  })

  test("a model server that is off: 502 upstream_unreachable with the line to turn it on", async () => {
    const fake = server()
    const origin = fake.origin
    fake.stop()
    await using r = await rig(origin)
    const response = await r.send("/v1/chat/completions")
    expect(response.status).toBe(502)
    expect(response.headers.get(Broker.LOCAL_ERROR_HEADER)).toBe("upstream_unreachable")
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("모델 서버")
    expect(r.relay.status(HOST)?.local.inflight).toBe(0)
  })

  test("the answer streams as it arrives, and a host that goes away aborts the server's request", async () => {
    const gate = { release: () => {} }
    const fake = server(
      (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"))
              gate.release = () => controller.enqueue(new TextEncoder().encode("data: second\n\n"))
              request.signal.addEventListener("abort", () => controller.error(new Error("aborted")))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    await using r = await rig(fake.origin)
    const abort = new AbortController()
    const response = await r.send("/v1/chat/completions", { signal: abort.signal })
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("first")
    expect(r.relay.status(HOST)?.local.inflight).toBe(1)
    gate.release()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("second")
    abort.abort()
    await reader.cancel().catch(() => undefined)
    const deadline = Date.now() + 5_000
    while (fake.aborted.length === 0 && Date.now() < deadline) await Bun.sleep(25)
    expect(fake.aborted.length).toBeGreaterThan(0)
    while (r.relay.status(HOST)!.local.inflight > 0 && Date.now() < deadline) await Bun.sleep(25)
    expect(r.relay.status(HOST)?.local.inflight).toBe(0)
    fake.stop()
  })

  test("its audit sums are their own (`remote.egress.local`)", async () => {
    const fake = server()
    const r = await rig(fake.origin)
    const response = await r.send("/v1/chat/completions")
    await response.text()
    await r.relay.shutdown()
    expect(r.audits.map((item) => item.kind)).toEqual(["local"])
    expect(r.audits[0]!.data).toMatchObject({ hostId: HOST, count: 1, statuses: { "200": 1 } })
    fake.stop()
  })
})

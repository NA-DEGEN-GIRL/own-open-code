import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { ServiceTarget } from "@own/runtime"
import { SelfHttp } from "../../src/http.js"

/**
 * The self-HTTP client (09 §5.1, 06 §2.6) against a fake loopback service: every call carries `location[directory]`
 * when it is about a folder or a session, the password only travels in `Authorization`, a 401 re-reads the source
 * once, and nothing throws. The I2 calls (import, log, estimate.request) are pinned here before their callers exist.
 */

const PASSWORD = "fake-own-import-service-password"
const DIRECTORY = "C:\\work\\proj"

interface Seen {
  readonly method: string
  readonly path: string
  readonly url: string
  readonly query: Readonly<Record<string, string>>
  readonly authorization: string | null
  readonly body?: unknown
}

type Route = (request: Request, url: URL) => Response | Promise<Response>

const servers: Array<{ stop(): void }> = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
})

function fake() {
  const requests: Seen[] = []
  const routes = new Map<string, Route>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      requests.push({
        method: request.method,
        path: url.pathname,
        url: request.url,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.get("authorization"),
        ...(text === "" ? {} : { body: JSON.parse(text) }),
      })
      if (request.headers.get("authorization") !== ServiceTarget.basic(PASSWORD))
        return Response.json({ _tag: "UnauthorizedError", message: "no" }, { status: 401 })
      const route = routes.get(`${request.method} ${url.pathname}`)
      if (route === undefined) return Response.json({ _tag: "NotFound", message: "no route" }, { status: 404 })
      return route(request, url)
    },
  })
  servers.push({ stop: () => server.stop(true) })
  const url = `http://127.0.0.1:${server.port}`
  return {
    url,
    requests,
    routes,
    client: SelfHttp.create({ source: SelfHttp.source({ service: { url, password: PASSWORD }, channel: "local" }) }),
  }
}

function session(id: string, input: { readonly metadata?: Record<string, unknown>; readonly archived?: number } = {}) {
  return {
    id,
    projectID: "prj_fixture",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 2_000, ...(input.archived === undefined ? {} : { archived: input.archived }) },
    location: { directory: DIRECTORY },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}

/** A transcript in its JSON form, decoded with the core schema: what the migration hands to `import`. */
const TRANSFER = Schema.decodeUnknownSync(SessionTransfer.Data)({
  info: { ...session("ses_fixture00000000000000001"), title: "설치기 정리", agent: "build" },
  messages: [
    { id: "msg_000000000001fixture00000", type: "user", text: "고쳐 줘", time: { created: 1_000 } },
    { id: "msg_000000000002fixture00000", type: "synthetic", text: "history", time: { created: 1_001 } },
  ],
})

describe("requests", () => {
  test("project and session lists: query, Authorization only, every page of a cursor", async () => {
    const service = fake()
    service.routes.set("GET /api/project", () =>
      Response.json([{ id: "prj_fixture", canonical: DIRECTORY, sandboxes: [], time: { created: 1 } }]),
    )
    service.routes.set("GET /api/session", (_request, url) =>
      url.searchParams.get("cursor") === "page-2"
        ? Response.json({ data: [session("ses_b", { archived: 5 })], cursor: { previous: "page-1", next: null } })
        : Response.json({ data: [session("ses_a")], cursor: { next: "page-2" } }),
    )
    const projects = await service.client.project.list()
    expect(projects).toEqual({ ok: true, value: [{ id: "prj_fixture", canonical: DIRECTORY, sandboxes: [] }] })
    const all = await service.client.session.all({ project: "prj_fixture", parentID: null })
    expect<unknown>(all.ok && all.value.map((item) => [item.id, item.time.archived])).toEqual([
      ["ses_a", undefined],
      ["ses_b", 5],
    ])
    const lists = service.requests.filter((request) => request.path === "/api/session")
    expect(lists.map((request) => request.query)).toEqual([
      { project: "prj_fixture", parentID: "null", limit: "200" },
      { project: "prj_fixture", parentID: "null", limit: "200", cursor: "page-2" },
    ])
    for (const request of service.requests) {
      expect(request.authorization).toBe(ServiceTarget.basic(PASSWORD))
      expect(request.url).not.toContain(PASSWORD)
    }
  })

  test("session get carries location[directory]; a missing session is a typed failure", async () => {
    const service = fake()
    service.routes.set("GET /api/session/ses_a", () => Response.json({ data: session("ses_a") }))
    service.routes.set("GET /api/session/ses_gone", () =>
      Response.json({ _tag: "SessionNotFoundError", message: "Session not found: ses_gone" }, { status: 404 }),
    )
    const got = await service.client.session.get({ sessionID: "ses_a", directory: DIRECTORY })
    expect(got).toMatchObject({ ok: true, value: { id: "ses_a", location: { directory: DIRECTORY } } })
    expect(service.requests[0]?.query).toEqual({ "location[directory]": DIRECTORY })
    const gone = await service.client.session.get({ sessionID: "ses_gone", directory: DIRECTORY })
    expect(gone).toEqual({
      ok: false,
      status: 404,
      type: "SessionNotFoundError",
      message: "Session not found: ses_gone",
    })
  })

  test("import sends the encoded transcript with the folder as its location; 409 is a conflict", async () => {
    const service = fake()
    const state = { calls: 0 }
    service.routes.set("POST /api/experimental/session/import", () => {
      state.calls++
      return state.calls === 1
        ? Response.json({ data: session("ses_fixture00000000000000001") })
        : Response.json({ _tag: "ConflictError", message: "Session already exists" }, { status: 409 })
    })
    const first = await service.client.session.import({ directory: DIRECTORY, data: TRANSFER })
    expect(first).toMatchObject({ ok: true, value: { id: "ses_fixture00000000000000001" } })
    const sent = service.requests[0]
    expect(sent?.query).toEqual({ "location[directory]": DIRECTORY })
    expect(sent?.body).toEqual({
      ...Schema.encodeSync(SessionTransfer.Data)(TRANSFER),
      location: { directory: DIRECTORY },
    })
    expect(sent?.body).toMatchObject({
      info: { time: { created: 1_000 } },
      messages: [{ type: "user" }, { type: "synthetic" }],
    })
    const again = await service.client.session.import({ directory: DIRECTORY, data: TRANSFER })
    expect(again).toMatchObject({ ok: false, status: 409, type: "ConflictError" })
  })

  test("a transcript that does not encode is refused before any request", async () => {
    const service = fake()
    const broken = { ...TRANSFER, messages: [{ type: "nonsense" }] } as unknown as SessionTransfer.Data
    const result = await service.client.session.import({ directory: DIRECTORY, data: broken })
    expect(result).toMatchObject({ ok: false, status: null, type: "invalid_request" })
    expect(service.requests).toEqual([])
  })
})

describe("the session log", () => {
  const event = (seq: number, type: string) =>
    `data: ${JSON.stringify({ id: `evt_${seq}`, type, created: seq, durable: { aggregateID: "ses_h", seq, version: 1 }, data: {} })}\n\n`

  test("items after the cursor, the next cursor from durable items and the synced marker", async () => {
    const service = fake()
    service.routes.set(
      "GET /api/experimental/session/ses_h/log",
      () =>
        new Response(
          `${event(5, "session.compaction.started")}: keep-alive\n\n${event(7, "session.compaction.ended")}data: {"type":"log.synced","aggregateID":"ses_h","seq":9}\n\ndata: not json\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const log = await service.client.session.log({ sessionID: "ses_h", directory: DIRECTORY, after: 4 })
    expect(log.ok && log.value.items.map((item) => item.type)).toEqual([
      "session.compaction.started",
      "session.compaction.ended",
      "log.synced",
    ])
    expect(log.ok && log.value.cursor).toBe(9)
    expect(service.requests[0]?.query).toEqual({ after: "4", "location[directory]": DIRECTORY })
  })

  test("follow reads live events until the visitor stops, then lets the stream go", async () => {
    const service = fake()
    const stream = { cancelled: false }
    service.routes.set(
      "GET /api/experimental/session/ses_h/log",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(event(3, "session.compaction.started")))
              // The rest arrives later and split across chunks; the stream never ends by itself.
              setTimeout(() => {
                const text = event(4, "session.compaction.ended")
                controller.enqueue(new TextEncoder().encode(text.slice(0, 20)))
                controller.enqueue(new TextEncoder().encode(text.slice(20)))
              }, 30)
            },
            cancel() {
              stream.cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const seen: string[] = []
    const log = await service.client.session.log({
      sessionID: "ses_h",
      directory: DIRECTORY,
      after: 2,
      follow: true,
      visit: (item) => {
        seen.push(String(item.type))
        return item.type !== "session.compaction.ended"
      },
    })
    expect(seen).toEqual(["session.compaction.started", "session.compaction.ended"])
    expect(log).toMatchObject({ ok: true, value: { cursor: 4 } })
    expect(service.requests[0]?.query).toEqual({ after: "2", follow: "true", "location[directory]": DIRECTORY })
    await Bun.sleep(20)
    expect(stream.cancelled).toBe(true)
  })

  test("a follow that times out keeps what it read and the cursor to resume from", async () => {
    const service = fake()
    service.routes.set(
      "GET /api/experimental/session/ses_h/log",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(event(6, "session.compaction.started")))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const log = await service.client.session.log(
      { sessionID: "ses_h", directory: DIRECTORY, follow: true },
      { timeoutMs: 300 },
    )
    expect(log).toMatchObject({ ok: true, value: { cursor: 6, interrupted: true } })
    expect(log.ok && log.value.items).toHaveLength(1)
  })
})

describe("own.accounts estimate.request", () => {
  const output = {
    unit: "credits",
    delta: null,
    quota: null,
    remaining: { fiveHour: 80, weekly: null },
    Z: 12_000,
    zSource: "default",
    exchange: 3_000,
    window: 272_000,
    ceiling: 244_800,
  }
  const input = {
    target: Schema.decodeUnknownSync(Model.Ref)({ providerID: "openai", id: "gpt-fixture" }),
    requests: [
      { prompt: 100_000, output: 4_000 },
      { prompt: 100_000, output: 4_000, cachedPrefix: 90_000 },
    ],
  }

  test("is an RPC call at the folder's location; the output is decoded", async () => {
    const service = fake()
    service.routes.set("POST /api/rpc/own.accounts/estimate.request", () => Response.json({ output }))
    const result = await service.client.accounts.estimate(input, { directory: DIRECTORY })
    expect<unknown>(result).toEqual({ ok: true, value: output })
    expect(service.requests[0]).toMatchObject({
      method: "POST",
      query: { "location[directory]": DIRECTORY },
      body: { input },
    })
  })

  test("a declared error keeps its type and data; an unexpected output is invalid_response", async () => {
    const service = fake()
    const state = { calls: 0 }
    service.routes.set("POST /api/rpc/own.accounts/estimate.request", () => {
      state.calls++
      return state.calls === 1
        ? Response.json(
            { _tag: "RpcError", type: "account_not_found", message: "no account", data: { accountID: "acc_x" } },
            { status: 400 },
          )
        : Response.json({ output: { unit: "credits" } })
    })
    expect(await service.client.accounts.estimate(input, { directory: DIRECTORY })).toEqual({
      ok: false,
      status: 400,
      type: "account_not_found",
      message: "no account",
      data: { accountID: "acc_x" },
    })
    expect(await service.client.accounts.estimate(input, { directory: DIRECTORY })).toMatchObject({
      ok: false,
      type: "invalid_response",
    })
  })
})

describe("the import location's catalog", () => {
  const routes = (service: ReturnType<typeof fake>, agent: () => Response) => {
    service.routes.set("GET /api/model", () => Response.json({ data: [] }))
    service.routes.set("GET /api/provider", () => Response.json({ data: [] }))
    service.routes.set("GET /api/agent/compaction", agent)
  }

  test("the hidden compaction agent's model; a Location without the agent summarizes with the target", async () => {
    const model = { providerID: "own-oai-dddd", id: "gpt-fixture-mini" }
    const service = fake()
    routes(service, () => Response.json({ data: { model } }))
    expect<unknown>(await service.client.location.catalog(DIRECTORY)).toEqual({
      ok: true,
      value: { models: [], providers: [], compaction: model },
    })
    expect(service.requests.every((request) => request.query["location[directory]"] === DIRECTORY)).toBe(true)
    const none = fake()
    routes(none, () =>
      Response.json({ _tag: "AgentNotFoundError", agentID: "compaction", message: "no agent" }, { status: 404 }),
    )
    expect(await none.client.location.catalog(DIRECTORY)).toEqual({ ok: true, value: { models: [], providers: [] } })
  })

  test("any other failure of the agent fails the catalog instead of naming the target as summarizer", async () => {
    const service = fake()
    routes(service, () => Response.json({ _tag: "InternalError", message: "boom" }, { status: 500 }))
    expect(await service.client.location.catalog(DIRECTORY)).toMatchObject({ ok: false, status: 500 })
    const odd = fake()
    routes(odd, () => Response.json({ data: { model: 7 } }))
    expect(await odd.client.location.catalog(DIRECTORY)).toMatchObject({ ok: false, type: "invalid_response" })
    // A 404 that is not the agent's own answer (a route that moved) is no "no agent" either.
    const moved = fake()
    routes(moved, () => new Response("not found", { status: 404 }))
    expect(await moved.client.location.catalog(DIRECTORY)).toMatchObject({ ok: false, status: 404 })
  })
})

describe("the service target", () => {
  test("a 401 reads the source again once", async () => {
    const service = fake()
    service.routes.set("GET /api/project", () => Response.json([]))
    const state = { invalidated: 0 }
    const source: ServiceTarget.Source = {
      current: async () => ({
        url: service.url,
        authorization: ServiceTarget.basic(state.invalidated === 0 ? "stale-fake-password" : PASSWORD),
      }),
      invalidate: () => {
        state.invalidated++
      },
    }
    expect(await SelfHttp.create({ source }).project.list()).toEqual({ ok: true, value: [] })
    expect(state.invalidated).toBe(1)
    expect(service.requests).toHaveLength(2)
  })

  test("a second 401 is a failure, not a loop", async () => {
    const service = fake()
    const source: ServiceTarget.Source = {
      current: async () => ({ url: service.url, authorization: ServiceTarget.basic("wrong-fake-password") }),
      invalidate: () => undefined,
    }
    expect(await SelfHttp.create({ source }).project.list()).toMatchObject({ ok: false, status: 401 })
    expect(service.requests).toHaveLength(2)
  })

  test("only a loopback http service is used, and failures never carry the password", async () => {
    const remote = SelfHttp.source({ service: { url: "http://10.1.2.3:4096", password: PASSWORD }, channel: "local" })
    const refused = await SelfHttp.create({ source: remote }).project.list()
    expect(refused).toMatchObject({ ok: false, type: "no_service", status: null })
    // A loopback port nothing listens on.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const url = `http://127.0.0.1:${closed.port}`
    closed.stop(true)
    const source = SelfHttp.source({ service: { url, password: PASSWORD }, channel: "local" })
    const result = await SelfHttp.create({ source, timeoutMs: 2_000 }).session.get({
      sessionID: "ses_a",
      directory: DIRECTORY,
    })
    expect(result).toMatchObject({ ok: false, type: "unreachable", status: null })
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
  })
})

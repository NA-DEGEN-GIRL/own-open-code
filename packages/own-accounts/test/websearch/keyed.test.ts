// own's keyed variants of core's keyless web search services (`KeyedSearch`, 02 §9.2, SK 2026-10-23): each key in
// own's vault (`websearch.key.get/set`, a feature item like Brave's), the websearch fold (a variant listed beside
// core's keyless service only while its key is there, never the default, again when a key is stored or removed), the
// request of each service as core sends it (the same URL with the key where core puts it), the mapping of each answer,
// the failure codes, TinyFish's MCP session (core's since v2.0.32), and `여러 서비스 함께` asking a service with its
// key. The five services are fakes on 127.0.0.1
// (e2e-kit `startFakeSearchServices`); there are no real keys, and every key and page here is made up.

import { afterAll, describe, expect, test } from "bun:test"
import type { WebSearchEditor } from "@opencode/plugin/promise/websearch"
import type { WebSearch } from "@opencode/schema/websearch"
import { SearchKey } from "@own/protocol"
import { SearchKeyRpc } from "../../src/rpc/search-key.js"
import { KeyedSearch } from "../../src/websearch/keyed.js"
import { MultiSearch } from "../../src/websearch/multi.js"
import {
  mcpJson,
  mcpStream,
  pageOf,
  queryOf,
  SEARCH_SERVICES,
  searchesOf,
  SHARED_PAGE,
  startFakeSearchServices,
  type SearchService,
} from "../e2e-kit"
import { hashSecret } from "../e2e-kit/fakes/shared"
import { memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const KEYS: Readonly<Record<SearchService, string>> = {
  exa: "fake-exa-key-Ex4a",
  firecrawl: "fc-fake-key-Fc5b",
  parallel: "fake-parallel-key-Pa6c",
  tavily: "tvly-fake-key-Tv7d",
  tinyfish: "fake-tinyfish-key-Tf8e",
}
const QUERY = "secret query bun 1.4 release notes"
const APP = { name: "opencode", version: "2.0.28-own.6", channel: "own" }

const fake = startFakeSearchServices(KEYS)
afterAll(() => fake.stop())

/** Another host, which a redirect from a fake names: every request it got (never any). */
const elsewhere: string[] = []
const other = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    elsewhere.push(`${request.method} ${request.url}`)
    return mcpJson({ content: [] })
  },
})
afterAll(() => other.stop(true))

/** A plugin context with core's websearch transforms (the fold and its reloads) and core's app info. */
function context() {
  const state = { websearch: [] as Array<(editor: WebSearchEditor) => void>, reloads: 0 }
  const ctx = {
    app: APP,
    websearch: {
      transform: async (callback: (editor: WebSearchEditor) => void) => void state.websearch.push(callback),
      reload: async () => {
        state.reloads++
      },
    },
  }
  /** The services the websearch folds list now (id and name) and the default, as core would fold them. */
  const listed = () => {
    const folded: { selection: string | false | undefined; added: Array<{ id: string; name: string }> } = {
      selection: undefined,
      added: [],
    }
    const editor: WebSearchEditor = {
      add: (definition) => void folded.added.push({ id: definition.id, name: definition.name }),
      default: {
        get: () => folded.selection,
        set: (selection) => {
          folded.selection = selection
        },
      },
    }
    for (const fold of state.websearch) fold(editor)
    return folded
  }
  return { ctx, state, listed }
}

async function setup(input: { readonly endpoints?: Readonly<Record<string, string>> } = {}) {
  const logs: string[] = []
  const core = context()
  const t = await testDeps({
    ctx: core.ctx,
    logs,
    control: true,
    options: { endpoints: input.endpoints ?? fake.endpoints },
  })
  const rpc = SearchKeyRpc.handlers(t.deps)
  return {
    t,
    core,
    logs,
    setKey: (service: SearchKey.Service, key: string | null) =>
      rpc["websearch.key.set"]({ service, key }, rpcContext<"websearch.key.set">()),
    getKeys: () => rpc["websearch.key.get"]({}, rpcContext<"websearch.key.get">()),
    search: (service: KeyedSearch.Service, query = QUERY, signal = new AbortController().signal) =>
      KeyedSearch.create(t.deps, service)({ query }, { signal }),
    lines: () =>
      logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "websearch_query"),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

/** Waits until the broadcast's refold ran (inspects of the vault and a reload). */
async function settled(read: () => number, count: number) {
  for (let tries = 0; tries < 100 && read() < count; tries++) await Bun.sleep(5)
}

/** The key rows of a `websearch.key.*` answer; a refusal fails the test. */
function rows(answer: unknown) {
  const view = answer as SearchKey.View
  expect(Array.isArray(view.keys)).toBe(true)
  return view.keys
}

/** The calls the fake got since `from`. */
const callsSince = (from: number) => fake.calls.slice(from)

describe("KeyedSearch: the keys in own's vault and the listing", () => {
  test("no key: nothing listed; a stored key lists that service's variant; removing it unlists it", async () => {
    await using s = await setup()
    const stop = await KeyedSearch.register(s.t.deps)
    await Bun.sleep(30)
    expect(s.core.listed().added).toEqual([])
    expect(s.core.state.reloads).toBe(0)

    const stored = await s.setKey("exa", `  ${KEYS.exa}  `)
    expect(rows(stored).find((row) => row.service === "exa")).toEqual({
      service: "exa",
      configured: true,
      keyHint: `…${KEYS.exa.slice(-4)}`,
    })
    await settled(() => s.core.state.reloads, 1)
    expect(s.core.listed()).toEqual({ selection: undefined, added: [{ id: "own-exa", name: "Exa (내 키)" }] })

    await s.setKey("tavily", KEYS.tavily)
    await settled(() => s.core.state.reloads, 2)
    expect(s.core.listed().added.map((item) => item.id)).toEqual(["own-exa", "own-tavily"])

    // The same key again, or Brave's key, changes nothing listed here: a refold only when a state flips.
    await s.setKey("exa", KEYS.exa)
    await s.setKey("brave", "BSAfake-brave-keyed-0001")
    await Bun.sleep(30)
    expect(s.core.state.reloads).toBe(2)

    await s.setKey("exa", null)
    await settled(() => s.core.state.reloads, 3)
    expect(s.core.listed().added.map((item) => item.id)).toEqual(["own-tavily"])
    expect(
      rows(await s.getKeys())
        .filter((row) => row.configured)
        .map((row) => row.service),
    ).toEqual(["brave", "tavily"])
    stop()
  })

  test("keys stored before start are listed right after registering; the fold never sets the default", async () => {
    await using s = await setup()
    for (const service of ["parallel", "tinyfish"] as const)
      await s.t.deps.runtime.credentials.storeFeatureKey(SearchKey.keyID(service), KEYS[service])
    const stop = await KeyedSearch.register(s.t.deps)
    await settled(() => s.core.state.reloads, 1)
    stop()
    expect(s.core.state.reloads).toBe(1)
    expect(s.core.listed()).toEqual({
      selection: undefined,
      added: [
        { id: "own-parallel", name: "Parallel (내 키)" },
        { id: "own-tinyfish", name: "TinyFish (내 키)" },
      ],
    })
    expect(KeyedSearch.SERVICES.map(KeyedSearch.idOf)).toEqual(SearchKey.KEYED.map(SearchKey.providerID))
    expect(MultiSearch.KEYLESS).toEqual(KeyedSearch.SERVICES)
  })

  test("each key is a feature item placed as its service takes it; the logs name the service, never the key", async () => {
    await using s = await setup()
    for (const service of SEARCH_SERVICES) await s.setKey(service, KEYS[service])
    const credentials = s.t.deps.runtime.credentials
    expect(await credentials.featureHeaders(SearchKey.keyID("parallel"), "Bearer")).toEqual({
      ok: true,
      headers: { authorization: `Bearer ${KEYS.parallel}` },
    })
    expect(await credentials.featureURL(SearchKey.keyID("exa"), "https://mcp.example.test/mcp", "exaApiKey")).toEqual({
      ok: true,
      url: `https://mcp.example.test/mcp?exaApiKey=${KEYS.exa}`,
    })
    for (const bad of ["  ", "fake exa", "fake\nexa"])
      expect(await s.setKey("exa", bad)).toMatchObject({ rpcError: true, type: "websearch_key_invalid" })
    const logged = s.logs.join("\n")
    expect(s.logs.filter((line) => line.includes("websearch_key_set"))).toHaveLength(SEARCH_SERVICES.length)
    for (const service of SEARCH_SERVICES) {
      expect(logged).not.toContain(KEYS[service])
      expect(logged).not.toContain(KEYS[service].slice(-4))
    }
  })
})

describe("KeyedSearch: each request as core sends it, with the user's key", () => {
  const MCP_ACCEPT = "application/json, text/event-stream"
  const AGENT = `opencode/${APP.channel}/${APP.version}/${APP.name}`
  const call = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })
  const EXPECTED: Readonly<
    Record<SearchService, { readonly body: unknown; readonly agent: boolean; readonly accept: string }>
  > = {
    exa: { body: call("web_search_exa", { query: QUERY, numResults: 8 }), agent: false, accept: MCP_ACCEPT },
    firecrawl: { body: call("firecrawl_search", { query: QUERY, limit: 8 }), agent: true, accept: MCP_ACCEPT },
    parallel: {
      body: call("web_search", { objective: QUERY, search_queries: [QUERY] }),
      agent: true,
      accept: MCP_ACCEPT,
    },
    tavily: {
      body: { query: QUERY, search_depth: "basic", chunks_per_source: 3, max_results: 8 },
      agent: true,
      accept: "application/json",
    },
    tinyfish: { body: call("search", { query: QUERY }), agent: true, accept: MCP_ACCEPT },
  }
  const TITLES: Readonly<Record<SearchService, string>> = {
    exa: "Exa page",
    firecrawl: "Firecrawl page",
    parallel: "Parallel page",
    tavily: "Tavily page",
    tinyfish: "TinyFish page",
  }

  for (const service of SEARCH_SERVICES)
    test(`${service}: one POST to core's URL, the key where core puts it, the answer as core maps it`, async () => {
      await using s = await setup()
      await s.setKey(service, KEYS[service])
      const from = fake.calls.length
      const results = await s.search(service, `  ${QUERY}  `)
      const calls = callsSince(from)
      const [request, ...more] = searchesOf(calls)
      expect(more).toEqual([])
      // TinyFish's search runs in the MCP session its `initialize` answered (below); every other service has none.
      expect(calls.filter((item) => item.step !== undefined).length).toBe(service === "tinyfish" ? 2 : 0)
      expect(request?.session).toEqual(service === "tinyfish" ? expect.stringMatching(/^fake-tinyfish-session-/) : null)
      expect(request).toMatchObject({ service, method: "POST", key: hashSecret(KEYS[service]) })
      expect(request?.body).toEqual(EXPECTED[service].body)
      expect(request?.accept).toBe(EXPECTED[service].accept)
      if (EXPECTED[service].agent) expect(request?.userAgent).toBe(AGENT)
      else expect(request?.userAgent).not.toContain("opencode")
      expect(request?.clientName).toBe(service === "tavily" ? "opencode2" : null)
      // Exa's key is the URL's query parameter, and nothing else is in the query.
      expect(Object.keys(request?.query ?? {})).toEqual(service === "exa" ? ["exaApiKey"] : [])
      expect(results.map((item) => item.url)).toEqual([pageOf(service), SHARED_PAGE])
      expect(results[0]).toMatchObject({
        title: TITLES[service],
        content: `${TITLES[service].split(" ")[0]} found this.`,
      })
      expect(s.lines()).toEqual([expect.objectContaining({ provider: `own-${service}`, results: 2 })])
      for (const secret of [QUERY, KEYS[service]]) expect(s.logs.join("\n")).not.toContain(secret)
    })

  test("dates: Exa's `Published:` and Parallel's `publish_date` when they parse", async () => {
    await using s = await setup()
    await s.setKey("exa", KEYS.exa)
    await s.setKey("parallel", KEYS.parallel)
    expect((await s.search("exa")).map((item) => item.time)).toEqual([
      { published: Date.parse("2026-08-20T09:00:00.000Z") },
      {},
    ])
    expect((await s.search("parallel")).map((item) => item.time)).toEqual([{ published: Date.parse("2026-09-01") }, {}])
  })

  test("no key, a wrong key, statuses, a tool error and odd bodies fail with a code; nothing found is no failure", async () => {
    await using s = await setup()
    const from = fake.calls.length
    await expect(s.search("exa")).rejects.toThrow("Exa web search with your key failed (no_key)")
    expect(callsSince(from)).toEqual([])

    await s.setKey("parallel", "fake-parallel-revoked")
    await expect(s.search("parallel")).rejects.toThrow("(auth)")
    await s.setKey("parallel", KEYS.parallel)
    fake.next("parallel", () => Response.json({ error: "slow down" }, { status: 429 }))
    await expect(s.search("parallel")).rejects.toThrow("(rate_limit)")
    fake.next("parallel", () => new Response("upstream", { status: 502 }))
    await expect(s.search("parallel")).rejects.toThrow("(status_502)")
    // An exhausted or refused key: the MCP tool answers `isError` (upstream reads that as no results, #54311).
    fake.next("parallel", () =>
      mcpJson({ content: [{ type: "text", text: "Credits exhausted for this key" }], isError: true }),
    )
    await expect(s.search("parallel")).rejects.toThrow("(service_error)")
    fake.next("parallel", () =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }),
    )
    await expect(s.search("parallel")).rejects.toThrow("(service_error)")
    fake.next("parallel", () => new Response("<html></html>"))
    await expect(s.search("parallel")).rejects.toThrow("(bad_response)")
    fake.next("parallel", () => mcpJson({ content: [{ type: "text", text: "x".repeat(300 * 1024) }] }))
    await expect(s.search("parallel")).rejects.toThrow("(too_large)")
    fake.next("parallel", () =>
      mcpJson({ content: [], structuredContent: { search_id: "s", results: [], session_id: "s" } }),
    )
    expect(await s.search("parallel")).toEqual([])
    await expect(s.search("parallel", "   ")).rejects.toThrow("(empty_query)")
    await expect(s.search("parallel", QUERY, AbortSignal.abort())).rejects.toThrow("(cancelled)")
    expect(s.lines().map((line) => line.error ?? "ok")).toEqual([
      "no_key",
      "auth",
      "rate_limit",
      "status_502",
      "service_error",
      "service_error",
      "bad_response",
      "too_large",
      "ok",
      "empty_query",
      "cancelled",
    ])
    const logged = s.logs.join("\n")
    for (const secret of [KEYS.parallel, "fake-parallel-revoked", QUERY]) expect(logged).not.toContain(secret)
  })

  test("a redirect is never followed, so no key (header or Exa's URL) reaches the host it names", async () => {
    await using s = await setup()
    elsewhere.length = 0
    const redirect = () => new Response(null, { status: 307, headers: { location: `${other.url.origin}/mcp` } })
    for (const service of SEARCH_SERVICES) {
      await s.setKey(service, KEYS[service])
      fake.next(service, redirect)
      await expect(s.search(service)).rejects.toThrow("(status_307)")
    }
    // TinyFish's session steps carry the key too.
    for (const step of ["initialize", "notifications/initialized"] as const) {
      fake.next("tinyfish", redirect, step)
      await expect(s.search("tinyfish")).rejects.toThrow("(status_307)")
    }
    expect(elsewhere).toEqual([])
    expect(s.lines().map((line) => line.error)).toEqual(
      Array.from({ length: SEARCH_SERVICES.length + 2 }, () => "status_307"),
    )
  })

  test("TinyFish: initialize and notifications/initialized with the key, then the search in that session", async () => {
    await using s = await setup()
    await s.setKey("tinyfish", KEYS.tinyfish)
    const from = fake.calls.length
    expect((await s.search("tinyfish")).map((item) => item.url)).toEqual([pageOf("tinyfish"), SHARED_PAGE])
    const [initialize, initialized, search, ...more] = callsSince(from)
    expect(more).toEqual([])
    const sent = { service: "tinyfish", path: "/tinyfish/mcp", key: hashSecret(KEYS.tinyfish) }
    expect(initialize).toMatchObject({ ...sent, step: "initialize", session: null })
    expect(initialize?.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode", version: "1.0" } },
    })
    const session = initialized?.session
    expect(session).toStartWith("fake-tinyfish-session-")
    expect(initialized).toMatchObject({ ...sent, step: "notifications/initialized" })
    expect(initialized?.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" })
    expect(search).toMatchObject({ ...sent, session })
    expect(search?.step).toBeUndefined()
    for (const call of [initialize, initialized, search]) {
      expect(call?.userAgent).toBe(`opencode/${APP.channel}/${APP.version}/${APP.name}`)
      expect(call?.accept).toBe("application/json, text/event-stream")
    }
    // Each search opens a session of its own, as core's does.
    await s.search("tinyfish")
    expect(new Set(searchesOf(callsSince(from)).map((call) => call.session)).size).toBe(2)
  })

  test("TinyFish: a session that cannot be opened fails the search before it is sent", async () => {
    await using s = await setup()
    await s.setKey("tinyfish", KEYS.tinyfish)
    const from = fake.calls.length
    const json =
      (status = 200) =>
      () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { status })
    fake.next("tinyfish", json(), "initialize")
    await expect(s.search("tinyfish")).rejects.toThrow("TinyFish web search with your key failed (no_session)")
    fake.next("tinyfish", json(429), "initialize")
    await expect(s.search("tinyfish")).rejects.toThrow("(rate_limit)")
    fake.next(
      "tinyfish",
      () => new Response("x".repeat(300 * 1024), { headers: { "mcp-session-id": "fake-tinyfish-session-big" } }),
      "initialize",
    )
    await expect(s.search("tinyfish")).rejects.toThrow("(too_large)")
    fake.next("tinyfish", json(400), "notifications/initialized")
    await expect(s.search("tinyfish")).rejects.toThrow("(status_400)")
    await s.setKey("tinyfish", "fake-tinyfish-revoked")
    await expect(s.search("tinyfish")).rejects.toThrow("(auth)")
    await expect(s.search("tinyfish", QUERY, AbortSignal.abort())).rejects.toThrow("(cancelled)")
    expect(searchesOf(callsSince(from))).toEqual([])
    expect(s.lines().map((line) => line.error)).toEqual([
      "no_session",
      "rate_limit",
      "too_large",
      "status_400",
      "auth",
      "cancelled",
    ])
    // The fake refuses a search outside an initialized session, as TinyFish does with a key.
    const refused = await fetch(fake.endpoints.tinyfish, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEYS.tinyfish },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } }),
    })
    expect(refused.status).toBe(400)
    for (const secret of [KEYS.tinyfish, "fake-tinyfish-revoked", QUERY])
      expect(s.logs.join("\n")).not.toContain(secret)
  })

  test("a service given test endpoints but none of its own never reaches the real host", async () => {
    await using s = await setup({ endpoints: { brave: "http://127.0.0.1:9/res/v1" } })
    await s.setKey("tinyfish", KEYS.tinyfish)
    await expect(s.search("tinyfish")).rejects.toThrow("(no_endpoint)")
  })

  test("answers: only http(s) addresses, each once; Exa's `N/A`, an event stream and empty texts", () => {
    const exa = KeyedSearch.answer(
      "exa",
      [
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: [
                  "Title: N/A\nURL: https://a.example.test/\nPublished: N/A\nText: A",
                  "Title: again\nURL: https://a.example.test/\nText: B",
                  "Title: script\nURL: javascript:alert(1)\nText: never",
                  "Title: no address\nText: never",
                ].join("\n\n---\n\n"),
              },
            ],
          },
        })}`,
        "",
      ].join("\n"),
    )
    expect(exa).toEqual({ type: "ok", results: [{ url: "https://a.example.test/", content: "A", time: {} }] })
    expect(KeyedSearch.answer("exa", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }))).toEqual({
      type: "ok",
      results: [],
    })
    expect(KeyedSearch.answer("firecrawl", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }))).toEqual(
      { type: "ok", results: [] },
    )
    expect(
      KeyedSearch.answer(
        "tinyfish",
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not json" }] } }),
      ),
    ).toEqual({ type: "failed", code: "bad_response" })
    expect(KeyedSearch.answer("tavily", JSON.stringify({ detail: "x" }))).toEqual({
      type: "failed",
      code: "bad_response",
    })
    expect(KeyedSearch.mcpResult("data: [1]\n")).toBeUndefined()
    // An event stream without the space after `data:` too.
    expect(KeyedSearch.mcpResult(`data:${JSON.stringify({ result: { content: [] } })}`)).toEqual({
      type: "result",
      result: { content: [] },
    })
    // The fake's stream helper is what Exa's server sends.
    expect(mcpStream({ content: [] }).headers.get("content-type")).toBe("text/event-stream")
  })
})

describe("KeyedSearch with 여러 서비스 함께 (MS)", () => {
  test("resolve: a keyless service goes to its keyed variant while that is listed, and back once it is gone", () => {
    const listed = ["own-chatgpt", "exa", "own-exa", "parallel", "tavily"]
    expect(KeyedSearch.resolve("exa", listed)).toBe("own-exa")
    expect(KeyedSearch.resolve("own-exa", listed)).toBe("own-exa")
    expect(KeyedSearch.resolve("parallel", listed)).toBe("parallel")
    expect(KeyedSearch.resolve("own-parallel", listed)).toBe("parallel")
    expect(KeyedSearch.resolve("own-tinyfish", listed)).toBe("own-tinyfish")
    expect(KeyedSearch.resolve("brave", listed)).toBe("brave")
    expect(KeyedSearch.resolve("own-chatgpt", listed)).toBe("own-chatgpt")
  })

  test("the default and a stored selection ask a service with the user's key from own's vault, once", async () => {
    const listed = ["own-chatgpt", "exa", "firecrawl", "parallel", "tavily", "tinyfish", "own-exa", "own-tavily"]
    expect(MultiSearch.defaults(listed, {})).toEqual([
      "own-chatgpt",
      "own-exa",
      "firecrawl",
      "parallel",
      "own-tavily",
      "tinyfish",
    ])
    // A key in core (credential table or environment) still keeps a service out of the default.
    expect(MultiSearch.defaults(listed, { exa: "env" })).toEqual([
      "own-chatgpt",
      "firecrawl",
      "parallel",
      "own-tavily",
      "tinyfish",
    ])
    const { storage } = memoryStorage()
    const deps = { ctx: { storage } as never }
    await MultiSearch.store(deps, ["exa", "own-exa", "own-parallel", "brave"])
    expect(await MultiSearch.selection(deps, listed, {})).toEqual({
      services: ["own-exa", "parallel", "brave"],
      custom: true,
    })
  })

  test("a search asks the keyed variants directly with the user's keys and merges them with core's", async () => {
    const logs: string[] = []
    const { storage } = memoryStorage()
    const asked: string[] = []
    const t = await testDeps({
      logs,
      ctx: {
        app: APP,
        storage,
        integration: { list: async () => ({ data: [] }) },
        websearch: {
          providers: async () => ({
            data: [
              { id: "exa", name: "Exa" },
              { id: "tavily", name: "Tavily" },
              { id: "own-exa", name: "Exa (내 키)" },
              { id: "own-tavily", name: "Tavily (내 키)" },
            ],
          }),
          query: async (request: { readonly providerID: string }) => {
            asked.push(request.providerID)
            return { data: { providerID: request.providerID, results: [] as WebSearch.Result[] } }
          },
        },
      },
      options: { endpoints: fake.endpoints },
    })
    await using _ = t
    for (const service of ["exa", "tavily"] as const)
      await t.deps.runtime.credentials.storeFeatureKey(SearchKey.keyID(service), KEYS[service])
    await MultiSearch.store(t.deps, ["exa", "tavily"])
    const from = fake.calls.length
    const results = await MultiSearch.create(t.deps, t.modules())(
      { query: QUERY },
      { signal: new AbortController().signal },
    )
    // Core's keyless Exa and Tavily were not asked; own's keyed variants were, once each with the user's key.
    expect(asked).toEqual([])
    expect(
      callsSince(from)
        .map((request) => [request.service, request.key, queryOf(request)])
        .toSorted(),
    ).toEqual([
      ["exa", hashSecret(KEYS.exa), QUERY],
      ["tavily", hashSecret(KEYS.tavily), QUERY],
    ])
    expect(results[0]).toMatchObject({ url: SHARED_PAGE })
    expect(results[0]?.content).toEndWith("Found by: Exa (내 키), Tavily (내 키)")
    const line = logs
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry.msg === "websearch_query")
    expect(line).toMatchObject({
      provider: "own-multi",
      services: [
        { id: "own-exa", results: 2 },
        { id: "own-tavily", results: 2 },
      ],
    })
    const logged = logs.join("\n")
    for (const secret of [QUERY, KEYS.exa, KEYS.tavily]) expect(logged).not.toContain(secret)
  })
})

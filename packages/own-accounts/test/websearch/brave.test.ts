// own's Brave web search service (`BraveSearch`, 02 §9.2): the key in own's vault (`websearch.key.get/set`, a feature
// item like the voice-only keys), the websearch fold (listed only while the key is there, never the default, again
// when the key is stored or removed), the request and the result mapping. The Brave API is a fake on 127.0.0.1
// answering in the documented shape (`web.results`); there is no real key, and every key and page here is made up.

import { afterAll, describe, expect, test } from "bun:test"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { OwnAccounts, SearchKey } from "@own/protocol"
import type { Vault } from "@own/runtime"
import { Register } from "../../src/rpc/register.js"
import { SearchKeyRpc } from "../../src/rpc/search-key.js"
import { BraveSearch } from "../../src/websearch/brave.js"
import { rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const KEY = "BSAfake-brave-key-Qz7w"
const QUERY = "bun 1.4 release notes"

const ANSWER = {
  type: "search",
  query: { original: QUERY, more_results_available: true },
  web: {
    type: "search",
    results: [
      {
        title: "<strong>Bun</strong> v1.4 | Bun Blog",
        url: "https://bun.example.test/blog/bun-v1.4",
        description: "<strong>Bun</strong> 1.4 adds zstd to fetch() &amp; Bun&#x27;s image API.",
        extra_snippets: [
          "Cron jobs are built in.",
          "<strong>Bun</strong> 1.4 adds zstd to fetch() &amp; Bun&#x27;s image API.",
        ],
        age: "August 20, 2026",
        page_age: "2026-08-20T09:00:00",
      },
      {
        title: "Releases",
        url: "https://github.example.test/oven-sh/bun/releases",
        description: "",
        age: "2 days ago",
      },
      { title: "again", url: "https://bun.example.test/blog/bun-v1.4", description: "duplicate" },
      { title: "script", url: "javascript:alert(1)", description: "never shown" },
    ],
  },
}

/** What the fake answers: 401 for another key, else `reply` (the answer above by default). */
const reply: { next?: () => Response } = {}
const requests: Array<{ readonly url: URL; readonly token: string | null; readonly method: string }> = []
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const token = request.headers.get("x-subscription-token")
    requests.push({ url: new URL(request.url), token, method: request.method })
    if (token !== KEY)
      return Response.json({ type: "ErrorResponse", error: { code: "SUBSCRIPTION_TOKEN_INVALID" } }, { status: 401 })
    return reply.next?.() ?? Response.json(ANSWER)
  },
})
afterAll(() => api.stop(true))

/** Another host, which a redirect from the fake names: the key header it got, for every request (never any). */
const elsewhere: Array<string | null> = []
const other = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    elsewhere.push(request.headers.get("x-subscription-token"))
    return Response.json(ANSWER)
  },
})
afterAll(() => other.stop(true))

const noop: WebSearchDefinition["execute"] = async () => []

/** `websearch.key.get`'s answer with Brave's row as given and no other service's key. */
function view(brave: { readonly configured: boolean; readonly keyHint?: string }) {
  return {
    keys: SearchKey.Service.literals.map((service) =>
      service === "brave" ? { service, ...brave } : { service, configured: false },
    ),
    vault: "ok" as const,
  }
}

function websearchEditor(selected?: string | false) {
  const state: { selection: string | false | undefined; added: string[] } = { selection: selected, added: [] }
  const value: WebSearchEditor = {
    add: (definition) => void state.added.push(definition.id),
    default: {
      get: () => state.selection,
      set: (selection) => {
        state.selection = selection
      },
    },
  }
  return { value, state }
}

/** A plugin context with core's websearch transforms (the fold and its reloads). */
function context() {
  const state = { websearch: [] as Array<(editor: WebSearchEditor) => void>, reloads: 0 }
  const ctx = {
    websearch: {
      transform: async (callback: (editor: WebSearchEditor) => void) => void state.websearch.push(callback),
      reload: async () => {
        state.reloads++
      },
    },
  }
  /** The services the websearch folds list now, as core would fold them. */
  const listed = () => {
    const editor = websearchEditor()
    for (const fold of state.websearch) fold(editor.value)
    return editor.state
  }
  return { ctx, state, listed }
}

async function setup(input: { readonly vault?: Vault.Transport } = {}) {
  requests.length = 0
  reply.next = undefined
  const logs: string[] = []
  const fake = context()
  const t = await testDeps({
    ctx: fake.ctx,
    logs,
    control: true,
    options: { endpoints: { brave: `${api.url.origin}/res/v1` } },
    vault: input.vault,
  })
  const execute = BraveSearch.create(t.deps)
  const rpc = SearchKeyRpc.handlers(t.deps)
  return {
    t,
    fake,
    logs,
    /** `websearch.key.set` as own-web sends it. */
    setKey: (key: string | null) =>
      rpc["websearch.key.set"]({ service: "brave", key }, rpcContext<"websearch.key.set">()),
    getKeys: () => rpc["websearch.key.get"]({}, rpcContext<"websearch.key.get">()),
    search: (query = QUERY, signal = new AbortController().signal) => execute({ query }, { signal }),
    lines: () =>
      logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "websearch_query"),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

/** Waits until the broadcast's refold ran (an inspect of the vault and a reload). */
async function settled(read: () => number, count: number) {
  for (let tries = 0; tries < 100 && read() < count; tries++) await Bun.sleep(5)
}

describe("BraveSearch: the key in own's vault (websearch.key.get/set)", () => {
  test("no key: not listed; a stored key lists Brave on the next fold; removing it unlists it", async () => {
    await using s = await setup()
    const stop = await BraveSearch.register(s.t.deps)
    expect(s.fake.listed().added).toEqual([])
    expect(await s.getKeys()).toEqual(view({ configured: false }))

    expect(await s.setKey(`  ${KEY}  `)).toEqual(view({ configured: true, keyHint: `…${KEY.slice(-4)}` }))
    await settled(() => s.fake.state.reloads, 1)
    expect(s.fake.state.reloads).toBe(1)
    expect(s.fake.listed()).toEqual({ selection: undefined, added: ["brave"] })
    // The vault item is a feature key, not an account, and holds the trimmed key.
    const auth = await s.t.deps.runtime.credentials.featureHeaders(BraveSearch.KEY_ID, {
      header: "X-Subscription-Token",
    })
    expect(auth).toEqual({ ok: true, headers: { "X-Subscription-Token": KEY } })

    // The same key again changes nothing listed; the fold reloads only when the state flips.
    await s.setKey(KEY)
    await Bun.sleep(30)
    expect(s.fake.state.reloads).toBe(1)

    expect(await s.setKey(null)).toEqual(view({ configured: false }))
    await settled(() => s.fake.state.reloads, 2)
    expect(s.fake.listed().added).toEqual([])
    stop()
  })

  test("a key with spaces or control characters is refused; the logs name the service, never the key", async () => {
    await using s = await setup()
    for (const bad of ["   ", "BSA fake", "BSA\tfake"])
      expect(await s.setKey(bad)).toMatchObject({ rpcError: true, type: "websearch_key_invalid" })
    expect(await s.getKeys()).toEqual(view({ configured: false }))
    await s.setKey(KEY)
    expect(s.logs.some((line) => line.includes("websearch_key_set"))).toBe(true)
    const logged = s.logs.join("\n")
    expect(logged).not.toContain(KEY)
    expect(logged).not.toContain(KEY.slice(-4))
  })

  test("a key at start lists it right after registering; the fold never sets or changes the default; remote services refuse", async () => {
    await using s = await setup()
    await s.t.deps.runtime.credentials.storeFeatureKey(BraveSearch.KEY_ID, KEY)
    const stop = await BraveSearch.register(s.t.deps)
    await settled(() => s.fake.state.reloads, 1)
    stop()
    expect(s.fake.state.reloads).toBe(1)
    expect(s.fake.listed()).toEqual({ selection: undefined, added: ["brave"] })
    for (const choice of ["own-chatgpt", "random", false] as const) {
      const editor = websearchEditor(choice)
      BraveSearch.fold(editor.value, true, noop)
      expect(editor.state).toEqual({ selection: choice, added: ["brave"] })
    }
    for (const method of ["websearch.key.get", "websearch.key.set"] as const)
      expect(Register.REMOTE_MANAGED).toContain(method)
    expect(OwnAccounts.MethodScope["websearch.key.set"]).toBe("local")
    expect(OwnAccounts.MethodScope["websearch.key.get"]).toBe("read")
  })

  test("a vault that does not answer never holds up registering, which plugin setup and every model list wait for", async () => {
    // A vault helper still starting, or stuck: no request is ever answered.
    const asked: unknown[] = []
    await using s = await setup({
      vault: {
        request: (message) => {
          asked.push(message)
          return new Promise<unknown>(() => {})
        },
        close: async () => {},
      },
    })
    const registered = BraveSearch.register(s.t.deps)
    const outcome = await Promise.race([
      registered.then(() => "registered" as const),
      Bun.sleep(2_000).then(() => "waiting" as const),
    ])
    expect(outcome).toBe("registered")
    // The key is being looked up meanwhile; until it answers Brave is not listed.
    expect(asked.length).toBeGreaterThan(0)
    expect(s.fake.listed()).toEqual({ selection: undefined, added: [] })
    expect(s.fake.state.reloads).toBe(0)
    const stop = await registered
    stop()
  })
})

describe("BraveSearch: request and results", () => {
  test("GET /res/v1/web/search with the key header, the query, ten results and extra snippets", async () => {
    await using s = await setup()
    await s.setKey(KEY)
    const results = await s.search(`  ${QUERY}  `)
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.method).toBe("GET")
    expect(request.url.pathname).toBe("/res/v1/web/search")
    expect(request.token).toBe(KEY)
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ q: QUERY, count: "10", extra_snippets: "true" })
    expect(results).toEqual([
      {
        url: "https://bun.example.test/blog/bun-v1.4",
        title: "Bun v1.4 | Bun Blog",
        content: "Bun 1.4 adds zstd to fetch() & Bun's image API.\n\nCron jobs are built in.",
        time: { published: Date.parse("2026-08-20T09:00:00") },
      },
      { url: "https://github.example.test/oven-sh/bun/releases", title: "Releases", time: {} },
    ])
    expect(s.lines()).toEqual([expect.objectContaining({ provider: "brave", results: 2 })])
    const logged = s.logs.join("\n")
    for (const secret of [QUERY, KEY]) expect(logged).not.toContain(secret)
  })

  test("a Hangul query asks for Korean pages from Korea; long queries are cut to 400 characters and 50 words", async () => {
    const korean = new URL(BraveSearch.url("https://api.example.test/res/v1/", "한국은행 기준금리"))
    expect(korean.href.startsWith("https://api.example.test/res/v1/web/search?")).toBe(true)
    expect(korean.searchParams.get("search_lang")).toBe("ko")
    expect(korean.searchParams.get("country")).toBe("KR")
    expect(new URL(BraveSearch.url("https://api.example.test/res/v1", QUERY)).searchParams.get("country")).toBeNull()
    expect(Array.from(BraveSearch.cut("가".repeat(500)))).toHaveLength(400)
    expect(BraveSearch.cut(Array(60).fill("word").join("  ")).split(" ")).toHaveLength(50)
  })

  test("no key, a rejected key, other statuses and odd bodies fail with a code; no web results is no failure", async () => {
    await using s = await setup()
    await expect(s.search()).rejects.toThrow("Brave web search failed (no_key)")
    expect(requests).toEqual([])

    await s.setKey("BSAfake-revoked")
    await expect(s.search()).rejects.toThrow("(auth)")

    await s.setKey(KEY)
    reply.next = () => Response.json({ type: "ErrorResponse" }, { status: 429 })
    await expect(s.search()).rejects.toThrow("(rate_limit)")
    reply.next = () => Response.json({ type: "ErrorResponse" }, { status: 422 })
    await expect(s.search()).rejects.toThrow("(status_422)")
    reply.next = () => new Response("<html></html>")
    await expect(s.search()).rejects.toThrow("(bad_response)")
    reply.next = () => Response.json({ type: "search", query: { original: QUERY } })
    expect(await s.search()).toEqual([])
    await expect(s.search("  ")).rejects.toThrow("(empty_query)")
    await expect(s.search(QUERY, AbortSignal.abort())).rejects.toThrow("(cancelled)")
    expect(s.lines().map((line) => line.error ?? "ok")).toEqual([
      "no_key",
      "auth",
      "rate_limit",
      "status_422",
      "bad_response",
      "ok",
      "empty_query",
      "cancelled",
    ])
    expect(s.logs.join("\n")).not.toContain("BSAfake")
  })

  test("a redirect is never followed, so the key header never reaches the host it names", async () => {
    await using s = await setup()
    await s.setKey(KEY)
    elsewhere.length = 0
    reply.next = () =>
      new Response(null, { status: 307, headers: { location: `${other.url.origin}/res/v1/web/search?q=bun` } })
    await expect(s.search()).rejects.toThrow("Brave web search failed (status_307)")
    expect(requests).toHaveLength(1)
    expect(elsewhere).toEqual([])
  })
})

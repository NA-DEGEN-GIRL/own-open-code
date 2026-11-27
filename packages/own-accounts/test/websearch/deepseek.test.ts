// own's DeepSeek web search service (`DeepSeekSearch`, 02 §9.2): the websearch fold (listed with a DeepSeek account,
// never the default), the request and the result mapping, and a query over the ready DeepSeek accounts with the real
// slots and logins modules. The Search API is a fake on 127.0.0.1 answering in the shape the live API answered
// (2026-10-19, `fixture/deepseek-answer.json`); every key, account and page is made up.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { Account } from "@own/protocol"
import { Home } from "@own/runtime"
import { DeepSeekSearch } from "../../src/websearch/deepseek.js"
import { memoryStorage, registryWith, type AccountSeed } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const LONG = "검색결과요약".repeat(300)
const ANSWER = (await Bun.file(path.join(import.meta.dir, "fixture", "deepseek-answer.json")).text()).replace(
  '"LONG"',
  JSON.stringify(LONG),
)
const QUERY = "bun 1.4 release notes"

const KEYS = {
  rich: "sk-fake-ds-rich-0001",
  other: "sk-fake-ds-rich-0004",
  poor: "sk-fake-ds-poor-0002",
  bad: "sk-fake-ds-bad-0003",
} as const

/** What the fake answers: 402 for the poor key, 401 for the bad one, else `reply` (the recorded shape by default). */
const reply: { next?: () => Response } = {}
const requests: Array<{ readonly path: string; readonly auth: string | null; readonly json: unknown }> = []
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const auth = request.headers.get("authorization")
    requests.push({ path: new URL(request.url).pathname, auth, json: await request.json().catch(() => undefined) })
    if (auth === `Bearer ${KEYS.poor}`)
      return Response.json({ error: { message: "Insufficient Balance" } }, { status: 402 })
    if (auth === `Bearer ${KEYS.bad}`)
      return Response.json({ error: { message: "Authentication Fails" } }, { status: 401 })
    return reply.next?.() ?? new Response(ANSWER, { headers: { "content-type": "application/json" } })
  },
})
afterAll(() => api.stop(true))

const seed = (slug: string, extra: Partial<AccountSeed> = {}): AccountSeed => ({
  kind: "ds",
  label: `DeepSeek ${slug}`,
  slug,
  ...extra,
})

const noop: WebSearchDefinition["execute"] = async () => []

function editor(selected?: string | false) {
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

describe("DeepSeekSearch.fold", () => {
  test("a DeepSeek account lists own-deepseek and never makes it the default", async () => {
    const fold = editor()
    DeepSeekSearch.fold(fold.value, await registryWith([seed("dsaa")]), noop)
    expect(fold.state).toEqual({ selection: undefined, added: ["own-deepseek"] })
    expect(DeepSeekSearch.NAME).toBe("DeepSeek")
    for (const choice of ["own-chatgpt", "random", false] as const) {
      const chosen = editor(choice)
      DeepSeekSearch.fold(chosen.value, await registryWith([seed("dsaa")]), noop)
      expect(chosen.state).toEqual({ selection: choice, added: ["own-deepseek"] })
    }
  })

  test("listed while an account needs attention; not without one, nor with only turned-off ones", async () => {
    const attention = editor()
    DeepSeekSearch.fold(attention.value, await registryWith([seed("dsaa", { status: "auth_failed" })]), noop)
    expect(attention.state.added).toEqual(["own-deepseek"])
    const registries = [
      await registryWith([]),
      await registryWith([{ kind: "codex", label: "ChatGPT", slug: "dsxcodex" }]),
      await registryWith([seed("dsaa", { status: "disabled" }), seed("dsbb", { status: "retired" })]),
    ]
    for (const registry of registries) {
      const fold = editor()
      DeepSeekSearch.fold(fold.value, registry, noop)
      expect(fold.state).toEqual({ selection: undefined, added: [] })
    }
  })
})

describe("DeepSeekSearch: request and results", () => {
  test("the query is trimmed and cut to 128 characters, never inside a surrogate pair", () => {
    expect(DeepSeekSearch.body(`  ${QUERY}  `)).toEqual({ query: QUERY, count: 10 })
    const korean = "가".repeat(200)
    expect(Array.from(DeepSeekSearch.cut(korean))).toHaveLength(128)
    const emoji = `${"a".repeat(127)}😀😀`
    expect(DeepSeekSearch.cut(emoji)).toBe(`${"a".repeat(127)}😀`)
    expect(DeepSeekSearch.cut("   ")).toBe("")
  })

  test("maps title, url, summary (else snippet), date; http(s) only, each once, in the API's order", () => {
    const results = DeepSeekSearch.results(DeepSeekSearch.read(ANSWER) ?? [])
    expect(results.map((result) => result.url)).toEqual([
      "https://bun.example.test/blog/bun-v1.4",
      "https://github.example.test/oven-sh/bun/releases/tag/bun-v1.4.0",
      "https://blog.example.test/windows-service-env",
    ])
    expect(results[0]).toEqual({
      url: "https://bun.example.test/blog/bun-v1.4",
      title: "Bun v1.4 | Bun Blog",
      content: "Bun 1.4 adds zstd to fetch() and Bun.zstdCompress, a built-in image API and cron jobs.",
      time: { published: Date.parse("2026-08-19T16:00:00+00:00") },
    })
    // No title (core then shows the address), an empty summary falls back to the snippet, a null date is no time.
    expect(results[1]).toEqual({
      url: "https://github.example.test/oven-sh/bun/releases/tag/bun-v1.4.0",
      content: "Release notes of bun-v1.4.0.",
      time: {},
    })
    // A long summary is cut to MAX_CONTENT characters with an ellipsis.
    const content = results[2]?.content ?? ""
    expect(Array.from(content)).toHaveLength(DeepSeekSearch.MAX_CONTENT + 1)
    expect(content.endsWith("…")).toBe(true)
  })

  test("an unexpected body is no answer; an entry with odd fields is skipped, not the whole answer", () => {
    expect(DeepSeekSearch.read("not json")).toBeUndefined()
    expect(DeepSeekSearch.read(JSON.stringify([{ url: "https://a.example.test" }]))).toBeUndefined()
    const read = DeepSeekSearch.read(JSON.stringify({ results: [{ url: 5 }, { url: "https://a.example.test/" }] }))
    expect(DeepSeekSearch.results(read ?? []).map((result) => result.url)).toEqual(["https://a.example.test/"])
  })
})

/** Real slots and logins modules on a temp OWN_HOME; the DeepSeek endpoint is the fake; `keys` go to the vault. */
async function setup(input: {
  readonly seeds: ReadonlyArray<AccountSeed>
  readonly keys: Readonly<Record<string, string>>
}) {
  requests.length = 0
  reply.next = undefined
  const logs: string[] = []
  const t = await testDeps({
    ctx: { provider: { reload: async () => {}, list: async () => [] }, storage: memoryStorage().storage },
    logs,
    options: { endpoints: { deepseek: `${api.url.origin}/v1` } },
  })
  await t.deps.runtime.registry.write(await registryWith(input.seeds))
  for (const [slug, key] of Object.entries(input.keys))
    await t.deps.runtime.credentials.store(`acc_${slug}`, { type: "key", key })
  const modules = t.modules()
  await modules.slots.start()
  const execute = DeepSeekSearch.create(t.deps, modules)
  return {
    t,
    logs,
    search: (query = QUERY, signal = new AbortController().signal) => execute({ query }, { signal }),
    outcome: () => DeepSeekSearch.search(t.deps, modules, QUERY, new AbortController().signal),
    /** The `websearch_query` log lines. */
    lines: () =>
      logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "websearch_query"),
    /** The billed searches in the events ledger. */
    billed: async () => {
      await t.deps.runtime.ledger.flush()
      return (await t.deps.runtime.ledger.eventsOf(Home.month(t.clock.now()))).filter(
        (event) => event.type === "websearch",
      )
    },
    async [Symbol.asyncDispose]() {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

describe("DeepSeekSearch: a query", () => {
  test("one POST /v1/tools/search with the first account's key; results, one log line, one billed line", async () => {
    await using s = await setup({ seeds: [seed("dsaa"), seed("dsbb")], keys: { dsaa: KEYS.rich, dsbb: KEYS.other } })
    const long = `${"검".repeat(130)} more`
    const results = await s.search(long)
    expect(results).toHaveLength(3)
    expect(requests).toEqual([
      { path: "/v1/tools/search", auth: `Bearer ${KEYS.rich}`, json: { query: "검".repeat(128), count: 10 } },
    ])
    expect(s.lines()).toHaveLength(1)
    expect(s.lines()[0]).toMatchObject({ provider: "own-deepseek", slot: "own-ds-dsaa", results: 3 })
    expect(s.lines()[0]?.durationMs).toBeNumber()
    const billed = await s.billed()
    expect(billed).toHaveLength(1)
    expect(billed[0]).toMatchObject({
      type: "websearch",
      accountID: "acc_dsaa",
      providerID: "own-ds-dsaa",
      data: { service: "own-deepseek", cost: { unit: "USD", amount: 0.00075, source: "estimate" } },
    })
    // Never the query or a key, in the log or the ledger.
    const written = [...s.logs, JSON.stringify(billed)].join("\n")
    for (const secret of ["검검검", KEYS.rich]) expect(written).not.toContain(secret)
  })

  test("402 (insufficient balance) and 401 move the query to the next account", async () => {
    await using s = await setup({
      seeds: [seed("dsaa"), seed("dsbb"), seed("dscc")],
      keys: { dsaa: KEYS.poor, dsbb: KEYS.bad, dscc: KEYS.rich },
    })
    expect(await s.outcome()).toMatchObject({ type: "ok", slot: "own-ds-dscc", billed: true })
    expect(requests.map((request) => request.auth)).toEqual([
      `Bearer ${KEYS.poor}`,
      `Bearer ${KEYS.bad}`,
      `Bearer ${KEYS.rich}`,
    ])
  })

  test("every account short of balance fails with insufficient_balance; nothing is billed", async () => {
    await using s = await setup({ seeds: [seed("dsaa"), seed("dsbb")], keys: { dsaa: KEYS.poor, dsbb: KEYS.poor } })
    await expect(s.search()).rejects.toThrow("DeepSeek web search failed (insufficient_balance)")
    expect(requests).toHaveLength(2)
    expect(s.lines().at(-1)).toMatchObject({ slot: "own-ds-dsbb", results: 0, error: "insufficient_balance" })
    expect(await s.billed()).toEqual([])
  })

  test("an account without a key or with an exhaustion is skipped; turned-off and failed ones are never used", async () => {
    await using s = await setup({
      seeds: [
        seed("dsaa", { status: "disabled" }),
        seed("dsbb", { status: "auth_failed" }),
        seed("dscc"),
        seed("dsdd"),
        seed("dsee"),
      ],
      keys: { dsaa: KEYS.rich, dsbb: KEYS.rich, dsdd: KEYS.rich, dsee: KEYS.other },
    })
    s.t.deps.runtime.limits.exhaust({
      accountID: Account.ID.make("acc_dsdd"),
      windowId: null,
      until: s.t.clock.now() + 60_000,
      class: "hard",
    })
    expect(await s.outcome()).toMatchObject({ type: "ok", slot: "own-ds-dsee" })
    expect(requests.map((request) => request.auth)).toEqual([`Bearer ${KEYS.other}`])
  })

  test("without a usable account it fails at once with a code that says why", async () => {
    {
      await using s = await setup({ seeds: [seed("dsaa", { status: "auth_failed" })], keys: {} })
      expect(await s.outcome()).toEqual({ type: "failed", code: "auth" })
    }
    {
      await using s = await setup({ seeds: [seed("dsaa", { status: "exhausted" })], keys: {} })
      expect(await s.outcome()).toEqual({ type: "failed", code: "insufficient_balance" })
    }
    {
      await using s = await setup({ seeds: [], keys: {} })
      expect(await s.outcome()).toEqual({ type: "failed", code: "no_account" })
    }
    {
      await using s = await setup({ seeds: [seed("dsaa")], keys: { dsaa: KEYS.rich } })
      s.t.deps.runtime.limits.exhaust({
        accountID: Account.ID.make("acc_dsaa"),
        windowId: null,
        until: s.t.clock.now() + 60_000,
        class: "hard",
      })
      expect(await s.outcome()).toEqual({ type: "failed", code: "insufficient_balance" })
      await expect(s.search("   ")).rejects.toThrow("(empty_query)")
    }
    expect(requests).toEqual([])
  })

  test("an empty answer is no failure and not billed; other statuses, odd bodies and cancels end the query", async () => {
    await using s = await setup({ seeds: [seed("dsaa"), seed("dsbb")], keys: { dsaa: KEYS.rich, dsbb: KEYS.other } })
    reply.next = () => Response.json({ results: [] })
    expect(await s.search()).toEqual([])
    expect(await s.billed()).toEqual([])

    reply.next = () => Response.json({ error: { message: "rate limited" } }, { status: 429 })
    await expect(s.search()).rejects.toThrow("(status_429)")
    reply.next = () => new Response("<html>gateway</html>", { status: 200 })
    await expect(s.search()).rejects.toThrow("(bad_response)")
    // None moved on to the second account.
    expect(requests.map((request) => request.auth)).toEqual(Array(3).fill(`Bearer ${KEYS.rich}`))

    reply.next = undefined
    await expect(s.search(QUERY, AbortSignal.abort())).rejects.toThrow("(cancelled)")
  })
})

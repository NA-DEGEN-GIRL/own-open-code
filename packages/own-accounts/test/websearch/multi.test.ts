// own's multi-service web search (`MultiSearch`, `여러 서비스 함께`, 03 §18.2, MS 2026-10-19): the fold (listed only
// while chosen), the default selection, the address normalization and the reciprocal-rank-fusion merge, the fan-out
// with its deadline on a manual clock, the cooldown of a service that failed or answered empty, a search where every
// service failed, the one log line without the query, and a DeepSeek member that records its spend. Core's services
// are stand-ins answering through a fake `ctx.websearch.query`; the DeepSeek Search API is a fake on 127.0.0.1. Every
// key, account and page is made up.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import type { WebSearch } from "@opencode/schema/websearch"
import { Home } from "@own/runtime"
import { Clock } from "../../src/clock.js"
import { CoreConfig } from "../../src/slots/core-config.js"
import { MultiSearch } from "../../src/websearch/multi.js"
import { memoryStorage, registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const REPO = path.join(import.meta.dir, "../../../..")
const QUERY = "secret query bun 1.4 release notes"

const page = (url: string, extra: Partial<WebSearch.Result> = {}): WebSearch.Result => ({ url, time: {}, ...extra })

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

/** Lets resolved promises run (members answer through promise chains). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A member whose answer the test gives when it wants; `started` counts its runs. */
function deferred(id: string, name = id) {
  const control = { started: 0, aborted: false, answer: (_: MultiSearch.Answer) => {} }
  const member: MultiSearch.Member = {
    id,
    name,
    run: (_query, signal) =>
      new Promise((resolve) => {
        control.started++
        control.answer = resolve
        signal.addEventListener("abort", () => (control.aborted = true))
      }),
  }
  return { member, control }
}

describe("MultiSearch: listing and the default selection", () => {
  test("listed only while own's config names it, never made the default", async () => {
    const chosen = editor()
    MultiSearch.fold(chosen.value, true, noop)
    expect(chosen.state).toEqual({ selection: undefined, added: ["own-multi"] })
    const other = editor("own-chatgpt")
    MultiSearch.fold(other.value, false, noop)
    expect(other.state).toEqual({ selection: "own-chatgpt", added: [] })
    expect(MultiSearch.NAME).toBe("여러 서비스")
    // The config file: `{provider:"own-multi"}` names it; another value, no file or no directory does not.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-multi-config-"))
    try {
      expect(MultiSearch.chosen(undefined)).toBe(false)
      expect(MultiSearch.chosen(dir)).toBe(false)
      await CoreConfig.writeWebSearch(dir, { type: "multi" })
      expect(MultiSearch.chosen(dir)).toBe(true)
      expect(await fs.readFile(CoreConfig.file(dir), "utf8")).toContain('"provider": "own-multi"')
      await CoreConfig.writeWebSearch(dir, { type: "any" })
      expect(MultiSearch.chosen(dir)).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("own's keyless list is exactly the services core registers in plugin/websearch", async () => {
    const dir = path.join(REPO, "packages/core/src/plugin/websearch")
    const ids = new Set<string>()
    for (const file of new Bun.Glob("*.ts").scanSync({ cwd: dir }))
      // Since v2.2.6 (a809a4755f) a keyed service registers through WebSearchProvider.register.
      for (const match of (await Bun.file(path.join(dir, file)).text()).matchAll(
        /(?:editor\.add|WebSearchProvider\.register)\((?:ctx, )?\{\s*id: "([\w-]+)"/g,
      ))
        ids.add(match[1]!)
    expect([...ids].sort()).toEqual([...MultiSearch.KEYLESS])
  })

  test("default: ChatGPT while listed, then the keyless ones without a key; paid and keyed ones never", () => {
    const listed = ["brave", "exa", "fake-search", "own-chatgpt", "own-deepseek", "parallel", "tavily", "tinyfish"]
    expect(MultiSearch.defaults(listed, {})).toEqual(["own-chatgpt", "exa", "parallel", "tavily", "tinyfish"])
    expect(MultiSearch.defaults(listed, { exa: "key", tavily: "env" })).toEqual(["own-chatgpt", "parallel", "tinyfish"])
    expect(MultiSearch.defaults(["exa", "own-deepseek"], undefined)).toEqual(["exa"])
  })

  test("the stored selection wins over the default and keeps its order", async () => {
    const { storage, values } = memoryStorage()
    expect(await MultiSearch.selection({ ctx: { storage } as never }, ["exa", "parallel"], {})).toEqual({
      services: ["exa", "parallel"],
      custom: false,
    })
    await MultiSearch.store({ ctx: { storage } as never }, ["parallel", "own-deepseek"])
    expect(values.get("websearch:multi")).toEqual({ services: ["parallel", "own-deepseek"] })
    expect(await MultiSearch.selection({ ctx: { storage } as never }, ["exa", "parallel"], {})).toEqual({
      services: ["parallel", "own-deepseek"],
      custom: true,
    })
  })
})

describe("MultiSearch: one result per page, by reciprocal rank fusion", () => {
  test("addresses: scheme, www, trailing slash, fragment and tracking parameters do not tell pages apart", () => {
    const same = [
      "https://www.Example.test/docs/?b=2&a=1#intro",
      "http://example.test/docs?a=1&b=2&utm_source=openai",
      "https://example.test/docs/?fbclid=x&a=1&b=2&gclid=y",
    ]
    expect(new Set(same.map(MultiSearch.normalize))).toEqual(new Set(["example.test/docs?a=1&b=2"]))
    expect(MultiSearch.normalize("https://example.test/Docs")).not.toBe(
      MultiSearch.normalize("https://example.test/docs"),
    )
    expect(MultiSearch.normalize("https://example.test:8443/a")).toBe("example.test:8443/a")
    expect(MultiSearch.normalize("ftp://example.test/a")).toBeUndefined()
    expect(MultiSearch.normalize("not a url")).toBeUndefined()
  })

  test("a page found by several services ranks first and names them; the best-ranked hit gives the address", () => {
    const settled: MultiSearch.Settled[] = [
      {
        id: "own-chatgpt",
        name: "ChatGPT",
        ms: 9000,
        answer: {
          type: "ok",
          results: [
            page("https://a.test/only-chatgpt", { title: "A", content: "chatgpt text" }),
            page("https://www.shared.test/page/", { content: "chatgpt about shared" }),
          ],
        },
      },
      {
        id: "exa",
        name: "Exa",
        ms: 900,
        answer: {
          type: "ok",
          results: [
            page("https://shared.test/page", { title: "Shared", time: { published: 1_700_000_000_000 } }),
            page("https://b.test/only-exa", { title: "B" }),
            // The same page twice from one service counts once, at its better rank.
            page("https://shared.test/page#again"),
          ],
        },
      },
      {
        id: "parallel",
        name: "Parallel",
        ms: 700,
        answer: { type: "ok", results: [page("https://shared.test/page")] },
      },
      { id: "tavily", name: "Tavily", ms: 25_000, answer: { type: "failed", code: "timeout" } },
    ]
    const merged = MultiSearch.merge(settled)
    expect(merged.map((result) => result.url)).toEqual([
      "https://shared.test/page",
      "https://a.test/only-chatgpt",
      "https://b.test/only-exa",
    ])
    expect(merged[0]).toEqual({
      url: "https://shared.test/page",
      title: "Shared",
      content: "chatgpt about shared\n\nFound by: ChatGPT, Exa, Parallel",
      time: { published: 1_700_000_000_000 },
    })
    expect(merged[1]).toEqual({
      url: "https://a.test/only-chatgpt",
      title: "A",
      content: "chatgpt text\n\nFound by: ChatGPT",
      time: {},
    })
    expect(merged[2]?.content).toBe("Found by: Exa")
  })

  test("at most ten results; equal scores keep the services' order", () => {
    const many = (id: string, name: string, host: string): MultiSearch.Settled => ({
      id,
      name,
      ms: 1,
      answer: { type: "ok", results: Array.from({ length: 8 }, (_, index) => page(`https://${host}.test/${index}`)) },
    })
    const merged = MultiSearch.merge([many("exa", "Exa", "exa"), many("parallel", "Parallel", "parallel")])
    expect(merged).toHaveLength(MultiSearch.LIMITS.results)
    expect(merged.slice(0, 4).map((result) => result.url)).toEqual([
      "https://exa.test/0",
      "https://parallel.test/0",
      "https://exa.test/1",
      "https://parallel.test/1",
    ])
  })
})

describe("MultiSearch.ask: every service at once, within the deadline", () => {
  const limits = { ...MultiSearch.LIMITS }

  test("all start at once; the answer goes back as soon as all answered", async () => {
    const clock = Clock.manual()
    const a = deferred("exa")
    const b = deferred("parallel")
    const asked = MultiSearch.ask(clock, [a.member, b.member], QUERY, new AbortController().signal, limits)
    expect([a.control.started, b.control.started]).toEqual([1, 1])
    clock.advance(1_200)
    b.control.answer({ type: "ok", results: [page("https://p.test/")] })
    await settle()
    clock.advance(300)
    a.control.answer({ type: "failed", code: "status_500" })
    const settled = await asked
    expect(settled.map((item) => [item.id, item.answer.type, item.ms])).toEqual([
      ["exa", "failed", 1_500],
      ["parallel", "ok", 1_200],
    ])
    expect(clock.pending()).toBe(0)
  })

  test("8 s after the first answer with results the rest is cut and aborted", async () => {
    const clock = Clock.manual()
    const fast = deferred("parallel")
    const empty = deferred("exa")
    const slow = deferred("tavily")
    const asked = MultiSearch.ask(clock, [fast.member, empty.member, slow.member], QUERY, new AbortController().signal)
    // An empty answer does not start the grace period.
    clock.advance(500)
    empty.control.answer({ type: "ok", results: [] })
    await settle()
    clock.advance(1_500)
    fast.control.answer({ type: "ok", results: [page("https://p.test/")] })
    await settle()
    clock.advance(7_999)
    await settle()
    expect(slow.control.aborted).toBe(false)
    clock.advance(1)
    const settled = await asked
    expect(settled.find((item) => item.id === "tavily")).toEqual({
      id: "tavily",
      name: "tavily",
      answer: { type: "failed", code: "timeout" },
      ms: 10_000,
    })
    expect(slow.control.aborted).toBe(true)
  })

  test("a ChatGPT search still running is waited for until the 25 s cap", async () => {
    const clock = Clock.manual()
    const fast = deferred("parallel")
    const chatgpt = deferred("own-chatgpt", "ChatGPT")
    const asked = MultiSearch.ask(clock, [chatgpt.member, fast.member], QUERY, new AbortController().signal)
    clock.advance(1_000)
    fast.control.answer({ type: "ok", results: [page("https://p.test/")] })
    await settle()
    clock.advance(17_000)
    chatgpt.control.answer({ type: "ok", results: [page("https://c.test/")] })
    const settled = await asked
    expect(settled.map((item) => [item.id, item.answer.type, item.ms])).toEqual([
      ["own-chatgpt", "ok", 18_000],
      ["parallel", "ok", 1_000],
    ])

    // Past the cap even ChatGPT is cut.
    const later = Clock.manual()
    const late = deferred("own-chatgpt", "ChatGPT")
    const quick = deferred("exa")
    const capped = MultiSearch.ask(later, [late.member, quick.member], QUERY, new AbortController().signal)
    quick.control.answer({ type: "ok", results: [page("https://e.test/")] })
    await settle()
    later.advance(24_999)
    await settle()
    expect(late.control.aborted).toBe(false)
    later.advance(1)
    expect((await capped)[0]).toMatchObject({
      id: "own-chatgpt",
      answer: { type: "failed", code: "timeout" },
      ms: 25_000,
    })
    expect(late.control.aborted).toBe(true)
  })

  test("nothing answers: everything times out at the cap; a cancel ends it at once", async () => {
    const clock = Clock.manual()
    const a = deferred("exa")
    const asked = MultiSearch.ask(clock, [a.member], QUERY, new AbortController().signal)
    clock.advance(24_999)
    await settle()
    expect(a.control.aborted).toBe(false)
    clock.advance(1)
    expect((await asked)[0]?.answer).toEqual({ type: "failed", code: "timeout" })

    const cancel = new AbortController()
    const b = deferred("parallel")
    const cancelled = MultiSearch.ask(Clock.manual(), [b.member], QUERY, cancel.signal)
    cancel.abort()
    expect((await cancelled)[0]?.answer).toEqual({ type: "failed", code: "cancelled" })
    expect(b.control.aborted).toBe(true)
  })
})

describe("MultiSearch: a search through core's services", () => {
  /** Core's services as stand-ins: `answers[id]` gives each query's answer (a list or an error to throw). */
  async function setup(input: {
    readonly listed: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly selection?: readonly string[]
    readonly answers: Record<string, () => WebSearch.Result[] | Error>
  }) {
    const logs: string[] = []
    const { storage } = memoryStorage()
    const asked: string[] = []
    const t = await testDeps({
      logs,
      ctx: {
        storage,
        integration: { list: async () => ({ data: [] }) },
        websearch: {
          providers: async () => ({ data: input.listed }),
          query: async (request: { readonly query: string; readonly providerID: string }) => {
            asked.push(request.providerID)
            const answer = input.answers[request.providerID]?.()
            if (answer instanceof Error) throw answer
            return { data: { providerID: request.providerID, results: answer ?? [] } }
          },
        },
      },
    })
    if (input.selection) await MultiSearch.store(t.deps, input.selection)
    const execute = MultiSearch.create(t.deps, t.modules())
    return {
      t,
      asked,
      search: () => execute({ query: QUERY }, { signal: new AbortController().signal }),
      lines: () =>
        logs
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.msg === "websearch_query"),
      logs,
      async [Symbol.asyncDispose]() {
        await t[Symbol.asyncDispose]()
      },
    }
  }

  const LISTED = [
    { id: "exa", name: "Exa" },
    { id: "parallel", name: "Parallel" },
    { id: "fake-search", name: "Fake Search" },
    { id: "own-multi", name: "여러 서비스" },
  ]

  test("the default selection, merged; one log line with each service and never the query", async () => {
    await using s = await setup({
      listed: LISTED,
      answers: {
        exa: () => [page("https://shared.test/a"), page("https://exa.test/b")],
        parallel: () => [page("https://shared.test/a/")],
        "fake-search": () => [page("https://never.test/")],
      },
    })
    const results = await s.search()
    // Default: the keyless ones without a key (no ChatGPT listed); fake-search and own-multi are never asked.
    expect(s.asked.toSorted()).toEqual(["exa", "parallel"])
    expect(results.map((result) => [result.url, result.content])).toEqual([
      ["https://shared.test/a", "Found by: Exa, Parallel"],
      ["https://exa.test/b", "Found by: Exa"],
    ])
    expect(s.lines()).toHaveLength(1)
    expect(s.lines()[0]).toMatchObject({
      provider: "own-multi",
      results: 2,
      services: [
        { id: "exa", results: 2 },
        { id: "parallel", results: 1 },
      ],
    })
    expect(s.logs.join("\n")).not.toContain("secret query")
  })

  test("an empty answer beside results and a failure cool the service down; then it is asked again", async () => {
    const answers: Record<string, () => WebSearch.Result[] | Error> = {
      exa: () => [],
      parallel: () => [page("https://p.test/")],
      "fake-search": () => new Error("boom"),
    }
    await using s = await setup({ listed: LISTED, selection: ["exa", "parallel", "fake-search"], answers })
    await s.search()
    expect(s.lines()[0]).toMatchObject({
      services: [
        { id: "exa", results: 0 },
        { id: "parallel", results: 1 },
        { id: "fake-search", error: "error" },
      ],
    })
    s.asked.length = 0
    await s.search()
    expect(s.asked).toEqual(["parallel"])
    expect(s.lines()[1]).toMatchObject({ skipped: ["exa", "fake-search"] })
    // Two minutes later both are asked again; a second miss doubles the wait.
    s.t.clock.advance(MultiSearch.LIMITS.cooldownMs)
    s.asked.length = 0
    await s.search()
    expect(s.asked.toSorted()).toEqual(["exa", "fake-search", "parallel"])
    s.t.clock.advance(MultiSearch.LIMITS.cooldownMs)
    s.asked.length = 0
    await s.search()
    expect(s.asked).toEqual(["parallel"])
    // An answer with results clears a service's cooldown.
    answers.exa = () => [page("https://e.test/")]
    s.t.clock.advance(MultiSearch.LIMITS.cooldownMs * 2)
    await s.search()
    s.asked.length = 0
    await s.search()
    expect(s.asked).toContain("exa")
  })

  test("every service empty is no miss; every chosen one cooling down is asked anyway", async () => {
    const answers: Record<string, () => WebSearch.Result[] | Error> = { exa: () => [], parallel: () => [] }
    await using s = await setup({ listed: LISTED, selection: ["exa", "parallel"], answers })
    expect(await s.search()).toEqual([])
    s.asked.length = 0
    await s.search()
    expect(s.asked.toSorted()).toEqual(["exa", "parallel"])
    answers.exa = () => new Error("down")
    answers.parallel = () => new Error("down")
    await expect(s.search()).rejects.toThrow("Web search failed on every service (Exa: error, Parallel: error)")
    s.asked.length = 0
    await expect(s.search()).rejects.toThrow("Web search failed on every service")
    expect(s.asked.toSorted()).toEqual(["exa", "parallel"])
    expect(s.lines().at(-1)).not.toHaveProperty("skipped")
  })

  test("a selection with nothing listed now fails with no_service", async () => {
    await using s = await setup({ listed: LISTED, selection: ["brave", "own-multi"], answers: {} })
    await expect(s.search()).rejects.toThrow("no_service")
    expect(s.asked).toEqual([])
    expect(s.lines()[0]).toMatchObject({ provider: "own-multi", error: "no_service", results: 0 })
  })

  test("core's HTTP failure reads as status_<n>", async () => {
    const failure = Object.assign(new Error("request"), {
      _tag: "WebSearch.Request",
      cause: { response: { status: 429 } },
    })
    await using s = await setup({
      listed: LISTED,
      selection: ["exa", "parallel"],
      answers: { exa: () => failure, parallel: () => [page("https://p.test/")] },
    })
    await s.search()
    expect(s.lines()[0]).toMatchObject({ services: [{ id: "exa", error: "status_429" }, { id: "parallel" }] })
  })
})

const DS_ANSWER = (await Bun.file(path.join(import.meta.dir, "fixture", "deepseek-answer.json")).text()).replace(
  '"LONG"',
  '"short"',
)
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(DS_ANSWER, { headers: { "content-type": "application/json" } }),
})
afterAll(() => api.stop(true))

describe("MultiSearch: own's DeepSeek beside core's services", () => {
  test("DeepSeek is asked with its account's key and its billed search is in the events ledger", async () => {
    const { storage } = memoryStorage()
    const t = await testDeps({
      ctx: {
        storage,
        provider: { reload: async () => {}, list: async () => [] },
        integration: { list: async () => ({ data: [] }) },
        websearch: {
          providers: async () => ({
            data: [
              { id: "own-deepseek", name: "DeepSeek" },
              { id: "exa", name: "Exa" },
            ],
          }),
          query: async () => ({
            data: { providerID: "exa", results: [page("https://bun.example.test/blog/bun-v1.4")] },
          }),
        },
      },
      options: { endpoints: { deepseek: `${api.url.origin}/v1` } },
    })
    await t.deps.runtime.registry.write(await registryWith([{ kind: "ds", label: "DeepSeek", slug: "dsaa" }]))
    await t.deps.runtime.credentials.store("acc_dsaa", { type: "key", key: "sk-fake-ds-multi-0001" })
    const modules = t.modules()
    await modules.slots.start()
    try {
      await MultiSearch.store(t.deps, ["own-deepseek", "exa"])
      const results = await MultiSearch.create(t.deps, modules)(
        { query: QUERY },
        { signal: new AbortController().signal },
      )
      expect(results[0]).toMatchObject({ url: "https://bun.example.test/blog/bun-v1.4" })
      expect(results[0]?.content).toEndWith("Found by: DeepSeek, Exa")
      await t.deps.runtime.ledger.flush()
      const billed = (await t.deps.runtime.ledger.eventsOf(Home.month(t.clock.now()))).filter(
        (event) => event.type === "websearch",
      )
      expect(billed).toHaveLength(1)
      expect(billed[0]).toMatchObject({ accountID: "acc_dsaa", data: { service: "own-deepseek" } })
    } finally {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    }
  })
})

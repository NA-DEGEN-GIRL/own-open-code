// own's ChatGPT web search service (`ChatGPTSearch`): the websearch fold (registration and the default selection) and
// a query over the ready codex accounts with the real slots and logins modules. The Codex backend is the e2e kit's
// fake on 127.0.0.1 answering a recorded-shape stream; every token, ChatGPT account and page is made up.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { Account, type CodexModels } from "@own/protocol"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import { ChatGPTSearch } from "../../src/websearch/chatgpt.js"
import { startFakeCodex, type ChatGPTTokens } from "../e2e-kit"
import { parseSse } from "../e2e-kit/fakes/shared"
import { memoryStorage, registryWith, type AccountSeed } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const ANSWER = parseSse(await Bun.file(path.join(import.meta.dir, "fixture", "answer-json.sse")).text()).map(
  (event) => event.data as Record<string, unknown>,
)
const QUERY = "bun 1.4 release notes"

const ACCOUNTS = {
  a: { accountID: "acct-ws-a", email: "ws-a@example.test" },
  b: { accountID: "acct-ws-b", email: "ws-b@example.test" },
} as const

const seed = (slug: "a" | "b", extra: Partial<AccountSeed> = {}): AccountSeed => ({
  kind: "codex",
  label: `ChatGPT ${slug}`,
  slug: `ws${slug}${slug}`,
  identity: { chatgptAccountId: ACCOUNTS[slug].accountID },
  ...extra,
})

/** What the fake answers a search with: the recorded stream, unless a test queued a scripted reply instead. */
const answering = { stream: true }
const codex = startFakeCodex({ events: () => (answering.stream ? ANSWER : undefined) })
afterAll(() => codex.stop())

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

describe("ChatGPTSearch.fold", () => {
  test("a ready codex account registers own-chatgpt and makes it the default when nothing is chosen", async () => {
    const fold = editor()
    ChatGPTSearch.fold(fold.value, await registryWith([seed("a")]), noop)
    expect(fold.state).toEqual({ selection: "own-chatgpt", added: ["own-chatgpt"] })
    expect(ChatGPTSearch.NAME).toBe("ChatGPT")
  })

  test("never overrides a choice: another service, random, or off stays; the service is still listed", async () => {
    const registry = await registryWith([seed("a")])
    for (const choice of ["exa", "random", false] as const) {
      const fold = editor(choice)
      ChatGPTSearch.fold(fold.value, registry, noop)
      expect(fold.state).toEqual({ selection: choice, added: ["own-chatgpt"] })
    }
  })

  test("without a codex account, or with only turned-off ones, nothing is registered or selected", async () => {
    const registries = [
      await registryWith([]),
      await registryWith([{ kind: "ds", label: "DeepSeek", slug: "wsdsx" }]),
      await registryWith([seed("a", { status: "retired" }), seed("b", { status: "disabled" })]),
    ]
    for (const registry of registries) {
      const fold = editor()
      ChatGPTSearch.fold(fold.value, registry, noop)
      expect(fold.state).toEqual({ selection: undefined, added: [] })
    }
  })

  test("a login that needs attention keeps ChatGPT the default, so searches never fall back to another service", async () => {
    // WM (2026-10-19): dropping the service here let an earlier first-use answer (core KV `random`) send the user's
    // searches to a free third-party service without a word.
    for (const status of ["unverified", "auth_failed", "needs_reauth", "misconfigured"] as const) {
      const fold = editor()
      ChatGPTSearch.fold(fold.value, await registryWith([seed("a", { status }), seed("b", { status: "disabled" })]), noop)
      expect(fold.state, status).toEqual({ selection: "own-chatgpt", added: ["own-chatgpt"] })
    }
  })
})

/** Real slots and logins modules on a temp OWN_HOME; the codex endpoint is the fake; `tokens` go to the vault. */
async function setup(input: { readonly seeds: ReadonlyArray<AccountSeed>; readonly tokens: ReadonlyArray<"a" | "b"> }) {
  codex.reset()
  for (const account of Object.values(ACCOUNTS)) codex.setUsage(account.accountID, { primary: 0, secondary: 0 })
  answering.stream = true
  const logs: string[] = []
  const t = await testDeps({
    ctx: { provider: { reload: async () => {}, list: async () => [] }, storage: memoryStorage().storage },
    logs,
    options: { endpoints: { codex: codex.baseURL } },
  })
  await t.deps.runtime.registry.write(await registryWith(input.seeds))
  const logins: Partial<Record<"a" | "b", ChatGPTTokens>> = {}
  for (const slug of input.tokens) {
    const tokens = codex.login(ACCOUNTS[slug])
    logins[slug] = tokens
    await t.deps.runtime.credentials.store(`acc_ws${slug}${slug}`, {
      type: "oauth",
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expiresAt: t.clock.now() + 3_600_000,
    })
  }
  const modules = t.modules()
  await modules.slots.start()
  const execute = ChatGPTSearch.create(t.deps, modules)
  return {
    t,
    logs,
    logins,
    modules,
    search: (signal = new AbortController().signal) => execute({ query: QUERY }, { signal }),
    outcome: () => ChatGPTSearch.search(t.deps, modules, QUERY, new AbortController().signal),
    /** The search requests the fake got (the `/responses` POSTs). */
    requests: () => codex.requests.filter((request) => request.path === "/backend-api/codex/responses"),
    /** The `websearch_query` log lines. */
    lines: () =>
      logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "websearch_query"),
    async [Symbol.asyncDispose]() {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

describe("ChatGPTSearch: a query", () => {
  test("one streamed /responses request with the first account; the results and its usage windows", async () => {
    await using s = await setup({ seeds: [seed("a"), seed("b")], tokens: ["a", "b"] })
    const results = await s.search()
    expect(results.map((result) => result.url)).toEqual([
      "https://bun.example.test/blog/bun-v1.4",
      "https://github.example.test/oven-sh/bun/releases/tag/bun-v1.4.0",
    ])
    const [request, ...rest] = s.requests()
    expect(rest).toEqual([])
    expect(request?.identity).toBe(`codex:${ACCOUNTS.a.accountID}`)
    expect(request?.headers["session-id"]).toBe(ChatGPTSearch.SESSION)
    expect(request?.headers.accept).toBe("text/event-stream")
    // No Codex metadata here: the first preferred model.
    expect(request?.json).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      tools: [{ type: "web_search", external_web_access: true }],
      input: [{ role: "user", content: [{ type: "input_text", text: QUERY }] }],
    })
    // The answer's x-codex-* headers are the account's usage now, as a session request's would be.
    const windows = s.t.deps.runtime.limits.list({ accountID: "acc_wsaa" })
    expect(windows.find((window) => window.id === "codex.primary")?.usedPercent).toBe(
      codex.usage(ACCOUNTS.a.accountID).primary,
    )
    // One log line: slot, duration, count; never the query, a token, an e-mail or a ChatGPT account id.
    expect(s.lines()).toHaveLength(1)
    expect(s.lines()[0]).toMatchObject({ provider: "own-chatgpt", slot: "own-codex-wsaa", results: 2 })
    expect(s.lines()[0]?.durationMs).toBeNumber()
    const logged = s.logs.join("\n")
    for (const secret of [QUERY, s.logins.a?.accessToken, ACCOUNTS.a.accountID, ACCOUNTS.a.email])
      expect(logged).not.toContain(secret ?? "")
  })

  test("the account's own Codex list picks the model (its plan's), before the shared list", async () => {
    await using s = await setup({ seeds: [seed("a")], tokens: ["a"] })
    const list = (...slugs: string[]): CodexModels.Snapshot => ({
      source: "backend",
      fetchedAt: 1,
      clientVersion: CodexMeta.BACKEND.clientVersion,
      models: slugs.map((slug) => ({ slug, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] })),
    })
    await CodexMeta.file(s.t.deps.runtime.layout).write({
      version: 1,
      kinds: { codex: list("gpt-6-sol", "gpt-5.6-luna") },
      accounts: { acc_wsaa: list("gpt-6-sol", "gpt-6-luna") },
    })
    await s.search()
    expect(s.requests()[0]?.json).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" } })
  })

  test("an account at its usage limit hands the query to the next one, and is skipped while it stays there", async () => {
    await using s = await setup({ seeds: [seed("a"), seed("b")], tokens: ["a", "b"] })
    codex.setUsage(ACCOUNTS.a.accountID, { primary: 100 })
    expect(await s.outcome()).toMatchObject({ type: "ok", slot: "own-codex-wsbb" })
    expect(s.requests().map((request) => [request.identity, request.status])).toEqual([
      [`codex:${ACCOUNTS.a.accountID}`, 429],
      [`codex:${ACCOUNTS.b.accountID}`, 200],
    ])
    // The 429's headers marked the window exhausted: the next query goes straight to the second account.
    await s.search()
    expect(
      s
        .requests()
        .slice(2)
        .map((request) => request.identity),
    ).toEqual([`codex:${ACCOUNTS.b.accountID}`])
  })

  test("an account without a usable login is skipped without a request", async () => {
    await using s = await setup({ seeds: [seed("a"), seed("b")], tokens: ["b"] })
    expect(await s.outcome()).toMatchObject({ type: "ok", slot: "own-codex-wsbb" })
    expect(s.requests().map((request) => request.identity)).toEqual([`codex:${ACCOUNTS.b.accountID}`])
  })

  test("accounts that all need a login fail at once with auth; no codex account at all is no_account", async () => {
    {
      await using s = await setup({ seeds: [seed("a", { status: "needs_reauth" }), seed("b", { status: "auth_failed" })], tokens: [] })
      expect(await s.outcome()).toEqual({ type: "failed", code: "auth" })
      expect(s.requests()).toEqual([])
    }
    await using none = await setup({ seeds: [seed("a", { status: "disabled" })], tokens: [] })
    expect(await none.outcome()).toEqual({ type: "failed", code: "no_account" })
  })

  test("every account at its limit fails at once with usage_limit; any other failure is not handed on", async () => {
    await using s = await setup({ seeds: [seed("a"), seed("b")], tokens: ["a", "b"] })
    for (const accountID of ["acc_wsaa", "acc_wsbb"] as const)
      s.t.deps.runtime.limits.exhaust({
        accountID: Account.ID.make(accountID),
        windowId: null,
        until: s.t.clock.now() + 60_000,
        class: "hard",
      })
    expect(await s.outcome()).toEqual({ type: "failed", code: "usage_limit" })
    expect(s.requests()).toEqual([])
    for (const accountID of ["acc_wsaa", "acc_wsbb"]) s.t.deps.runtime.limits.clearExhaustion(accountID)

    answering.stream = false
    codex.enqueue({ type: "error", status: 500, body: { detail: "upstream failed" } })
    await expect(s.search()).rejects.toThrow("ChatGPT web search failed (status_500)")
    expect(s.requests()).toHaveLength(1)
    expect(s.lines().at(-1)).toMatchObject({ slot: "own-codex-wsaa", results: 0, error: "status_500" })
  })

  test("a call core cancelled ends as cancelled; a stream cut short keeps what arrived, a dropped one fails", async () => {
    await using s = await setup({ seeds: [seed("a")], tokens: ["a"] })
    await expect(s.search(AbortSignal.abort())).rejects.toThrow("(cancelled)")
    answering.stream = false
    codex.enqueue({ type: "eof", reply: { type: "text", text: "not json and no citation" } })
    expect(await s.outcome()).toEqual({ type: "ok", slot: "own-codex-wsaa", results: [] })
    codex.enqueue({ type: "drop", reply: { type: "text", text: "lost" }, after: 0 })
    expect(await s.outcome()).toEqual({ type: "failed", slot: "own-codex-wsaa", code: "network" })
  })
})

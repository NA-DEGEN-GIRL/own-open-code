// End to end on a real upstream server: own's DeepSeek and Brave web search services (`own-deepseek`, `brave`, 02 §9.2)
// next to core's own, on a server without a ChatGPT account.
//
// - A DeepSeek account lists DeepSeek, but never as the default: the first `websearch` call still asks the first-use
//   form, and DeepSeek gets no request. Chosen in settings (`websearch.set`), core's `websearch` tool searches with it:
//   one `POST /v1/tools/search` with the account's key, the mapped results reach the model, the billed search is in
//   the events ledger.
// - Brave is listed only once its key is in own's vault (`websearch.key.set`, what own-web's `Brave 키 넣기…` sends);
//   core gets no integration and no credential for it. Chosen, the tool searches with Brave: `GET /res/v1/web/search`
//   with the key in `X-Subscription-Token`, and the key is nowhere in the database, the logs or the event stream.
//
// One fake DeepSeek-dialect server answers the chat model, the account's balance probe and the Search API (in the shape
// the live API answered, `fixture/deepseek-answer.json`); a second fake is the Brave API. Every key is fake; the server
// binds 127.0.0.1, and no search reaches a real service.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SearchKey } from "@own/protocol"
import { Home } from "@own/runtime"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolOutputs,
  toolParts,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).

/** What `여러 서비스 함께` would ask (MS): own's default without ChatGPT, core's keyless services; never DeepSeek or Brave. */
const MULTI = { services: ["exa", "firecrawl", "parallel", "tavily", "tinyfish"], custom: false }

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ANSWER: unknown = JSON.parse(
  (await Bun.file(path.join(import.meta.dir, "fixture", "deepseek-answer.json")).text()).replace('"LONG"', '"요약"'),
)
const BRAVE_ANSWER = {
  type: "search",
  web: {
    results: [
      {
        title: "<strong>한국은행</strong> 기준금리",
        url: "https://news.example.test/bok-rate",
        description: "<strong>한국은행</strong>이 10월 기준금리를 동결했어요.",
        page_age: "2026-10-16T01:00:00",
      },
    ],
  },
}
const DS_KEY = "sk-fake-ds-search-e2e-0001"
const CHAT_KEY = "fake-ds-chat-key"
const BRAVE_KEY = "BSAfake-brave-e2e-Kp4x"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const LONG_QUERY = `bun 1.4 release notes ${"zstd ".repeat(40)}`.trim()
const KOREAN_QUERY = "한국은행 기준금리 10월"
const AFTER_TOOL = "검색 결과를 읽었습니다."

const fixture: {
  codex?: FakeCodex
  chat?: FakeOpenAIChat
  brave?: ReturnType<typeof Bun.serve>
  rig?: PresetRig
} = {}
const braveRequests: Array<{ readonly url: URL; readonly token: string | null }> = []

beforeAll(async () => {
  fixture.codex = startFakeCodex()
  const chat = startFakeOpenAIChat({
    responder: reply,
    credentials: { [DS_KEY]: { domain: "ds-account" }, [CHAT_KEY]: { domain: "chat-model" } },
    native: { "POST /v1/tools/search": () => ANSWER },
  })
  fixture.chat = chat
  const brave = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const token = request.headers.get("x-subscription-token")
      braveRequests.push({ url: new URL(request.url), token })
      return token === BRAVE_KEY ? Response.json(BRAVE_ANSWER) : Response.json({}, { status: 401 })
    },
  })
  fixture.brave = brave
  fixture.rig = await startPresetRig({
    name: "websearch-services",
    codex: fixture.codex,
    chatgpt: [],
    endpoints: { deepseek: chat.baseURL, brave: `${brave.url.origin}/res/v1` },
    config: { providers: { [CHAT.providerID]: deepseekProvider(chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) } },
    // `websearch.set` writes the global config; an installed service reloads it through the file watcher.
    watchConfig: true,
    models: [CHAT],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop(), fixture.brave?.stop(true)])
}, 60_000)

describe("own-deepseek and brave on a server without a ChatGPT account (02 §9.2)", () => {
  test("before any account or key: neither is listed, core has no Brave integration, own's vault no Brave key", async () => {
    const rig = required(fixture.rig)
    expect(await providerIDs()).not.toContain("own-deepseek")
    expect(await providerIDs()).not.toContain("brave")
    expect(await integrationIDs()).not.toContain("brave")
    expect(await rig.call("websearch.key.get")).toEqual(keyView({ configured: false }))
  })

  test(
    "a DeepSeek account lists DeepSeek but not as the default: the first search asks, and DeepSeek gets nothing",
    async () => {
      const rig = required(fixture.rig)
      await rig.call("accounts.add.key", { kind: "ds", label: "DeepSeek", key: DS_KEY })
      await waitUntil(async () => (await providerIDs()).includes("own-deepseek"), "own-deepseek was never listed")
      expect(await rig.call("websearch.get")).toEqual({ keys: {}, multi: MULTI })

      const session = await rig.server.createSession({ model: CHAT, title: "first search" })
      await rig.server.prompt(session.id, `[websearch] ${KOREAN_QUERY}`)
      const asked = await rig.events.waitFor(
        (event) =>
          event.type === "form.created" &&
          isRecord(event.data.form) &&
          event.data.form.sessionID === session.id &&
          isRecord(event.data.form.metadata) &&
          event.data.form.metadata.kind === "websearch.provider",
        60_000,
      )
      const form = isRecord(asked.data.form) ? asked.data.form : {}
      const cancelled = await rig.server.request("DELETE", `/api/session/${session.id}/form/${String(form.id)}`)
      expect(cancelled.ok).toBe(true)
      await rig.server.waitIdle(session.id)
      expect(searches()).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test(
    "chosen in settings, a session's websearch runs on DeepSeek with the account's key; the model reads the results",
    async () => {
      const rig = required(fixture.rig)
      const choice = { type: "service", id: "own-deepseek" }
      expect(await rig.call("websearch.set", { choice })).toEqual({ choice, keys: {}, multi: MULTI })
      await configured("own-deepseek")

      const session = await rig.server.createSession({ model: CHAT, title: "deepseek search" })
      await rig.server.prompt(session.id, `[websearch] ${LONG_QUERY}`)
      await rig.server.waitIdle(session.id)
      const [search, ...more] = await toolParts(rig.server, session.id, "websearch")
      expect(more).toEqual([])
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "own-deepseek" })

      // One search, with the DeepSeek account's key (not the chat model's), the query cut to 128 characters.
      const [request, ...others] = searches()
      expect(others).toEqual([])
      expect(request).toMatchObject({ method: "POST", identity: "ds-account", status: 200 })
      expect(request?.json).toEqual({ query: Array.from(LONG_QUERY).slice(0, 128).join("").trimEnd(), count: 10 })

      const after = required(fixture.chat).requests.filter(afterToolResult).at(-1)
      const output = after ? toolOutputs(after).join("\n") : ""
      expect(output).toContain("## [Bun v1.4 | Bun Blog](https://bun.example.test/blog/bun-v1.4)")
      expect(output).toContain("Bun 1.4 adds zstd to fetch()")
      expect(output).not.toContain("javascript:")

      // The billed search is in the events ledger; the log line has no query or key.
      const ledger = await fs.readFile(path.join(rig.home, "ledger", `events-${Home.month(Date.now())}.jsonl`), "utf8")
      const billed = ledger
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === "websearch")
      expect(billed).toEqual([
        expect.objectContaining({
          data: { service: "own-deepseek", cost: { unit: "USD", amount: 0.00075, source: "estimate" } },
        }),
      ])
      const line = rig.server
        .logs()
        .split("\n")
        .find((entry) => entry.includes('"msg":"websearch_query"') && entry.includes('"provider":"own-deepseek"'))
      expect(line).toContain('"results":3')
      const logs = rig.server.logs()
      for (const secret of [DS_KEY, "zstd zstd zstd"]) expect(logs).not.toContain(secret)
    },
    TURN_TIMEOUT,
  )

  test(
    "a Brave key stored in own's vault lists Brave; chosen, the websearch runs on Brave; the key stays out of core",
    async () => {
      const rig = required(fixture.rig)
      expect(await rig.call("websearch.key.set", { service: "brave", key: BRAVE_KEY })).toEqual(
        keyView({ configured: true, keyHint: `…${BRAVE_KEY.slice(-4)}` }),
      )
      await waitUntil(async () => (await providerIDs()).includes("brave"), "brave was never listed")
      const choice = { type: "service", id: "brave" }
      expect(await rig.call("websearch.set", { choice })).toEqual({ choice, keys: {}, multi: MULTI })
      await configured("brave")

      const session = await rig.server.createSession({ model: CHAT, title: "brave search" })
      await rig.server.prompt(session.id, `[websearch] ${KOREAN_QUERY}`)
      await rig.server.waitIdle(session.id)
      const [search] = await toolParts(rig.server, session.id, "websearch")
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "brave" })

      expect(braveRequests).toHaveLength(1)
      expect(braveRequests[0]?.token).toBe(BRAVE_KEY)
      expect(braveRequests[0]?.url.pathname).toBe("/res/v1/web/search")
      expect(Object.fromEntries(braveRequests[0]?.url.searchParams ?? [])).toEqual({
        q: KOREAN_QUERY,
        count: "10",
        extra_snippets: "true",
        search_lang: "ko",
        country: "KR",
      })
      const after = required(fixture.chat).requests.filter(afterToolResult).at(-1)
      const output = after ? toolOutputs(after).join("\n") : ""
      expect(output).toContain("## [한국은행 기준금리](https://news.example.test/bok-rate)")
      expect(output).toContain("한국은행이 10월 기준금리를 동결했어요.")
      expect(rig.server.logs()).not.toContain(BRAVE_KEY)
      expect(rig.events.text()).not.toContain(BRAVE_KEY)
      // Core never saw it: no integration, and neither the database nor its write-ahead log holds it.
      expect(await integrationIDs()).not.toContain("brave")
      for (const file of [rig.server.paths.database, `${rig.server.paths.database}-wal`]) {
        const bytes = await fs.readFile(file).catch(() => Buffer.alloc(0))
        expect(bytes.includes(Buffer.from(BRAVE_KEY))).toBe(false)
      }
    },
    TURN_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** The scripted chat model: a tool result gets a short text; `[websearch] <query>` calls the websearch tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const directive = lastUserText(request).match(/\[websearch\] (.+)/)
  if (directive) return { type: "tool-call", name: "websearch", input: { query: directive[1]!.trim() } }
  return { type: "text", text: "답변" }
}

/** `websearch.key.get`'s answer with Brave's row as given and no other service's key. */
function keyView(brave: { readonly configured: boolean; readonly keyHint?: string }) {
  return {
    keys: SearchKey.Service.literals.map((service) =>
      service === "brave" ? { service, ...brave } : { service, configured: false },
    ),
    vault: "ok",
  }
}

/** The search requests the DeepSeek fake got. */
function searches() {
  return required(fixture.chat).requests.filter((request) => request.path === "/v1/tools/search")
}

/** The ids of core's integrations at the workspace. */
async function integrationIDs() {
  const listed = await required(fixture.rig).server.call("GET", "/api/integration")
  const integrations = isRecord(listed) && Array.isArray(listed.data) ? listed.data : []
  return integrations.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
}

/** The ids of the web search services the server lists at the workspace. */
async function providerIDs() {
  const listed = await required(fixture.rig).server.call("GET", "/api/websearch/provider")
  const providers = isRecord(listed) && Array.isArray(listed.data) ? listed.data : []
  return providers.flatMap((provider) => (isRecord(provider) && typeof provider.id === "string" ? [provider.id] : []))
}

/** Waits until core's config names `provider` for web search (the config watcher reloaded the file). */
async function configured(provider: string) {
  const rig = required(fixture.rig)
  await waitUntil(
    async () => {
      const entries = await rig.server.call("GET", "/api/config")
      const last = (Array.isArray(entries) ? entries : [])
        .filter(
          (entry) => isRecord(entry) && entry.type === "document" && isRecord(entry.info) && "websearch" in entry.info,
        )
        .at(-1)
      return (
        isRecord(last) &&
        isRecord(last.info) &&
        isRecord(last.info.websearch) &&
        last.info.websearch.provider === provider
      )
    },
    `core never loaded websearch ${provider}`,
    30_000,
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

// End to end on a real upstream server: own's ChatGPT web search service (`own-chatgpt`, 02 §9.2) lets a session on
// a model that has no hosted search (a DeepSeek-dialect chat model here) search with the user's ChatGPT account.
//
// - With a ready ChatGPT account and nothing chosen in the config, the server lists `ChatGPT` and uses it as the
//   default: the first `websearch` call asks nobody (no first-use form, no permission request).
// - The call becomes one streamed `/responses` request to the Codex backend with the hosted `web_search` tool, and the
//   model reads the mapped results (title, link, excerpt) as the tool output.
//
// own-accounts loads from its package directory (`startPresetRig`) with one linked ChatGPT account on the fake Codex
// backend, which answers search requests with a recorded-shape stream (`fixture/answer-json.sse`). The chat model is
// the fake chat server, scripted by a directive in the last user text. Every credential is fake; the server binds
// 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolOutputs,
  toolParts,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord, parseSse } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).

/** What `여러 서비스 함께` would ask (MS): own's default, ChatGPT and core's keyless services. */
const MULTI = { services: ["own-chatgpt", "exa", "firecrawl", "parallel", "tavily", "tinyfish"], custom: false }

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ANSWER = parseSse(await Bun.file(path.join(import.meta.dir, "fixture", "answer-json.sse")).text()).map(
  (event) => event.data as Record<string, unknown>,
)
const ACCOUNT = { accountID: "acct-wse-01", email: "wse@example.test", plan: "plus" } as const
const DEEPSEEK = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const QUERY = "bun 1.4 release notes"
const AFTER_TOOL = "검색 결과를 읽었습니다."

const fixture: { codex?: FakeCodex; chat?: FakeOpenAIChat; rig?: PresetRig } = {}

beforeAll(async () => {
  // The Codex backend streams the recorded search answer to requests with the hosted search tool; session requests of
  // the ChatGPT slot (none here) would get the default reply.
  const codex = startFakeCodex({ events: (body) => (hostedSearch(body.tools) ? ANSWER : undefined) })
  fixture.codex = codex
  const chat = startFakeOpenAIChat({ responder: reply })
  fixture.chat = chat
  fixture.rig = await startPresetRig({
    name: "websearch",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ACCOUNT) }],
    config: {
      providers: {
        [DEEPSEEK.providerID]: deepseekProvider(chat, { apiKey: "fake-ds-key", models: [DEEPSEEK.id] }),
      },
    },
    models: [DEEPSEEK],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.codex?.stop()
  await fixture.chat?.stop()
}, 60_000)

describe("own-chatgpt on a server with a ChatGPT account", () => {
  test("the server lists ChatGPT next to core's services; nothing is chosen in the config file", async () => {
    const rig = required(fixture.rig)
    const listed = await rig.server.call("GET", "/api/websearch/provider")
    const providers = isRecord(listed) && Array.isArray(listed.data) ? listed.data : []
    expect(providers).toContainEqual({ id: "own-chatgpt", name: "ChatGPT" })
    expect(await rig.call("websearch.get")).toEqual({ keys: {}, multi: MULTI })
  })

  test(
    "a DeepSeek session's websearch runs on ChatGPT search by default and the model reads the mapped results",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: DEEPSEEK, title: "web search" })
      await rig.server.prompt(session.id, `[websearch] ${QUERY}`)
      await rig.server.waitIdle(session.id)

      const [search, ...more] = await toolParts(rig.server, session.id, "websearch")
      expect(more).toEqual([])
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "own-chatgpt" })
      // Nobody was asked: the default is set, and core's agent rules allow websearch.
      expect(rig.events.events.filter((event) => event.type === "form.created")).toEqual([])
      expect(rig.events.events.filter((event) => event.type === "permission.asked")).toEqual([])

      // One search request to the Codex backend, with the account's login and Codex's hosted tool.
      const searches = required(fixture.codex).requests.filter((request) => request.path.endsWith("/responses"))
      expect(searches).toHaveLength(1)
      expect(searches[0]).toMatchObject({ identity: `codex:${ACCOUNT.accountID}`, status: 200 })
      expect(searches[0]?.json).toMatchObject({
        model: "gpt-5.6-luna",
        stream: true,
        store: false,
        tools: [{ type: "web_search", external_web_access: true }],
        include: ["web_search_call.action.sources"],
        input: [{ role: "user", content: [{ type: "input_text", text: QUERY }] }],
      })

      // The model's next request carries the mapped results as the tool output.
      const after = required(fixture.chat).requests.filter(afterToolResult)
      expect(after).toHaveLength(1)
      const output = toolOutputs(after[0]!).join("\n")
      expect(output).toContain("## [Bun v1.4](https://bun.example.test/blog/bun-v1.4)")
      expect(output).toContain("Bun 1.4 adds a built-in SQL client")
      expect(output).toContain(
        "## [Release bun-v1.4.0 · oven-sh/bun](https://github.example.test/oven-sh/bun/releases/tag/bun-v1.4.0)",
      )
      expect(output).not.toContain("javascript:")
      expect(output).not.toContain("(duplicate)")
    },
    TURN_TIMEOUT,
  )

  test("the search was logged without the query or a credential, and no hook failed", () => {
    const logs = required(fixture.rig).server.logs()
    expect(logs).toContain("websearch_query")
    expect(logs).not.toMatch(/hook_failed/)
    const line = logs.split("\n").find((entry) => entry.includes('"msg":"websearch_query"')) ?? ""
    expect(line).toContain('"slot":"own-codex-pg01"')
    expect(line).toContain('"results":2')
    expect(line).not.toContain(QUERY)
    expect(line).not.toContain(ACCOUNT.accountID)
  })

  test("settings can choose it like any listed service (`websearch.set`, 03 §18.2)", async () => {
    const rig = required(fixture.rig)
    const choice = { type: "service", id: "own-chatgpt" }
    expect(await rig.call("websearch.set", { choice })).toEqual({ choice, keys: {}, multi: MULTI })
    expect(await rig.call("websearch.get")).toEqual({ choice, keys: {}, multi: MULTI })
    const config = await Bun.file(path.join(rig.server.paths.config, "opencode.jsonc")).json()
    expect(config.websearch).toEqual({ provider: "own-chatgpt" })
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** The scripted chat model: a tool result gets a short text; `[websearch] <query>` calls the websearch tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  const directive = text.match(/\[websearch\] (.+)/)
  if (directive) return { type: "tool-call", name: "websearch", input: { query: directive[1]!.trim() } }
  return { type: "text", text: "답변" }
}

function hostedSearch(tools: unknown) {
  return Array.isArray(tools) && tools.some((tool) => isRecord(tool) && tool.type === "web_search")
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

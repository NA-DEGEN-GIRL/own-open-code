// End to end on a real upstream server: `여러 서비스 함께` (own's `own-multi`, 03 §18.2, MS 2026-10-19) over fake
// services, on a server without a ChatGPT account.
//
// - `websearch.get` always shows what `여러 서비스 함께` would ask (own's default: the keyless services, never DeepSeek
//   or Brave) and `own-multi` is not listed, so core's `random` cannot draw it.
// - `websearch.set{multi, services}` stores the selection and writes `{provider:"own-multi"}`; `own-multi` is listed
//   then. A session's `websearch` asks own's DeepSeek and Brave directly and the kit's `fake-search` through core's
//   `websearch.query` at once; the model reads one merged list (the page both DeepSeek and Brave found first, each
//   result ending with `Found by: …`), the billed DeepSeek search is in the events ledger, and the one log line names
//   every service without the query.
// - A service that is not listed, or `own-multi` itself, is refused; another choice takes `own-multi` off the list and
//   keeps the stored selection.
//
// One fake DeepSeek-dialect server answers the chat model and the Search API; a second fake is the Brave API; the e2e
// kit's plugin adds `fake-search`. Core's keyless services are listed but never asked here, so no query leaves this
// PC. Every key is fake; the server binds 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
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
  WEBSEARCH_FIXTURE_PLUGIN,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
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
      // DeepSeek's first page too (another spelling of its address): one result, found by both.
      { title: "Bun v1.4", url: "https://www.bun.example.test/blog/bun-v1.4/", description: "Bun 1.4 notes." },
      { title: "Brave only", url: "https://brave-only.example.test/page", description: "Only Brave has this." },
    ],
  },
}
const DS_KEY = "sk-fake-ds-multi-e2e-0001"
const CHAT_KEY = "fake-ds-chat-key"
const BRAVE_KEY = "BSAfake-brave-multi-Qw7e"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const QUERY = "secretive multi query bun 1.4"
const AFTER_TOOL = "검색 결과를 읽었습니다."
const SERVICES = ["own-deepseek", "brave", "fake-search"]

const fixture: {
  codex?: FakeCodex
  chat?: FakeOpenAIChat
  brave?: ReturnType<typeof Bun.serve>
  rig?: PresetRig
} = {}
const braveRequests: URL[] = []

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
      braveRequests.push(new URL(request.url))
      return request.headers.get("x-subscription-token") === BRAVE_KEY
        ? Response.json(BRAVE_ANSWER)
        : Response.json({}, { status: 401 })
    },
  })
  fixture.brave = brave
  fixture.rig = await startPresetRig({
    name: "websearch-multi",
    codex: fixture.codex,
    chatgpt: [],
    endpoints: { deepseek: chat.baseURL, brave: `${brave.url.origin}/res/v1` },
    config: { providers: { [CHAT.providerID]: deepseekProvider(chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) } },
    plugins: [WEBSEARCH_FIXTURE_PLUGIN],
    // `websearch.set` writes the global config; an installed service reloads it through the file watcher.
    watchConfig: true,
    models: [CHAT],
  })
  const rig = fixture.rig
  await rig.call("accounts.add.key", { kind: "ds", label: "DeepSeek", key: DS_KEY })
  await rig.call("websearch.key.set", { service: "brave", key: BRAVE_KEY })
  await waitUntil(async () => {
    const ids = await providerIDs()
    return ids.includes("own-deepseek") && ids.includes("brave") && ids.includes("fake-search")
  }, "own-deepseek, brave and fake-search were never all listed")
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop(), fixture.brave?.stop(true)])
}, 60_000)

describe("여러 서비스 함께 (own-multi) on a real server (03 §18.2)", () => {
  test("before it is chosen: the default selection is shown, own-multi is not listed", async () => {
    const rig = required(fixture.rig)
    expect(await rig.call("websearch.get")).toEqual({
      keys: {},
      multi: { services: ["exa", "firecrawl", "parallel", "tavily", "tinyfish"], custom: false },
    })
    expect(await providerIDs()).not.toContain("own-multi")
    for (const id of ["no-such-search", "own-multi"]) {
      const refused = await rig.rpc("websearch.set", { choice: { type: "multi", services: ["fake-search", id] } })
      expect(refused.error).toMatchObject({ type: "websearch_unavailable", data: { reason: "unknown_service", id } })
    }
  })

  test(
    "chosen with DeepSeek, Brave and Fake Search: one search asks all three and the model reads one merged list",
    async () => {
      const rig = required(fixture.rig)
      expect(await rig.call("websearch.set", { choice: { type: "multi", services: SERVICES } })).toEqual({
        choice: { type: "multi" },
        keys: {},
        multi: { services: SERVICES, custom: true },
      })
      await configured("own-multi")
      await waitUntil(async () => (await providerIDs()).includes("own-multi"), "own-multi was never listed")

      const session = await rig.server.createSession({ model: CHAT, title: "multi search" })
      await rig.server.prompt(session.id, `[websearch] ${QUERY}`)
      await rig.server.waitIdle(session.id)
      const [search, ...more] = await toolParts(rig.server, session.id, "websearch")
      expect(more).toEqual([])
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "own-multi" })

      // Each service once: DeepSeek with the account's key, Brave with the vault's key.
      const searches = required(fixture.chat).requests.filter((request) => request.path === "/v1/tools/search")
      expect(searches).toHaveLength(1)
      expect(searches[0]).toMatchObject({ identity: "ds-account", status: 200 })
      expect(braveRequests).toHaveLength(1)

      const after = required(fixture.chat).requests.filter(afterToolResult).at(-1)
      const output = after ? toolOutputs(after).join("\n") : ""
      const blocks = output.split(/\n(?=## \[)/)
      expect(blocks[0]).toStartWith("## [Bun v1.4 | Bun Blog](https://bun.example.test/blog/bun-v1.4)")
      expect(blocks[0]).toContain("Found by: DeepSeek, Brave")
      expect(output).toContain("(https://brave-only.example.test/page)")
      expect(output).toContain(`(https://search.example.test/?q=${encodeURIComponent(QUERY)})`)
      expect(output).toContain("Found by: Fake Search")
      // DeepSeek's two blog entries of the fixture are one page with Brave's; nothing appears twice.
      const links = [...output.matchAll(/^## \[[^\]]*\]\(([^)]+)\)/gm)].map((match) => match[1])
      expect(new Set(links).size).toBe(links.length)

      // The billed DeepSeek search is in the events ledger; the one log line names the services, never the query.
      const ledger = await fs.readFile(path.join(rig.home, "ledger", `events-${Home.month(Date.now())}.jsonl`), "utf8")
      expect(ledger).toContain('"service":"own-deepseek"')
      const lines = rig.server
        .logs()
        .split("\n")
        .filter((entry) => entry.includes('"msg":"websearch_query"') && entry.includes('"provider":"own-multi"'))
      expect(lines).toHaveLength(1)
      for (const id of SERVICES) expect(lines[0]).toContain(`"id":"${id}"`)
      const logs = rig.server.logs()
      for (const secret of [DS_KEY, BRAVE_KEY, "secretive multi"]) expect(logs).not.toContain(secret)
    },
    TURN_TIMEOUT,
  )

  test("another choice takes own-multi off the list and keeps the stored selection", async () => {
    const rig = required(fixture.rig)
    expect(await rig.call("websearch.set", { choice: { type: "service", id: "fake-search" } })).toEqual({
      choice: { type: "service", id: "fake-search" },
      keys: {},
      multi: { services: SERVICES, custom: true },
    })
    await configured("fake-search")
    await waitUntil(async () => !(await providerIDs()).includes("own-multi"), "own-multi stayed listed")
    // Back to multi without services: the stored ones.
    expect(await rig.call("websearch.set", { choice: { type: "multi" } })).toMatchObject({
      choice: { type: "multi" },
      multi: { services: SERVICES, custom: true },
    })
    await configured("own-multi")
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** The scripted chat model: a tool result gets a short text; `[websearch] <query>` calls the websearch tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const directive = lastUserText(request).match(/\[websearch\] (.+)/)
  if (directive) return { type: "tool-call", name: "websearch", input: { query: directive[1]!.trim() } }
  return { type: "text", text: "답변" }
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

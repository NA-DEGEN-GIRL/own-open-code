// End to end on a real upstream server: own's keyed variants of core's keyless web search services (`own-exa`,
// `own-firecrawl`, `own-parallel`, `own-tavily`, `own-tinyfish`, 02 §9.2, SK 2026-10-23), with the keys in own's vault.
//
// - Before any key only core's keyless services are listed. A key stored through `websearch.key.set` (what own-web's
//   `Exa 키 넣기…` sends) lists that service's variant beside core's keyless one; core gets no integration and no
//   credential for it.
// - Chosen in settings, core's `websearch` tool searches with the variant: core's request to the same URL with the key
//   where core puts it (Exa: `exaApiKey`), and the model reads the results.
// - `여러 서비스 함께` with its default asks every service with its key through own's variants, never core's keyless
//   ones, and the model reads one merged list.
// - No key is in the database, its write-ahead log, the logs or the event stream. Removing a key unlists the variant.
//
// The five services are one fake on 127.0.0.1 (e2e-kit `startFakeSearchServices`), the chat model a fake
// DeepSeek-dialect server; every key is fake. Core's keyless services are listed but never asked, so no search reaches
// a real service.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import { SearchKey } from "@own/protocol"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  pageOf,
  queryOf,
  SEARCH_SERVICES,
  searchesOf,
  SHARED_PAGE,
  startFakeCodex,
  startFakeOpenAIChat,
  startFakeSearchServices,
  startPresetRig,
  toolOutputs,
  toolParts,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIChat,
  type FakeSearchServices,
  type PresetRig,
  type RecordedRequest,
  type Reply,
  type SearchService,
} from "../e2e-kit"
import { hashSecret, isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const KEYS: Readonly<Record<SearchService, string>> = {
  exa: "fake-exa-e2e-key-Ke1a",
  firecrawl: "fc-fake-e2e-key-Ke2b",
  parallel: "fake-parallel-e2e-key-Ke3c",
  tavily: "tvly-fake-e2e-key-Ke4d",
  tinyfish: "fake-tinyfish-e2e-key-Ke5e",
}
const CHAT_KEY = "fake-keyed-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const QUERY = "secretive keyed search bun 1.4"
const AFTER_TOOL = "검색 결과를 읽었습니다."
const KEYLESS = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]
const VARIANTS = KEYLESS.map((service) => `own-${service}`)

const fixture: { codex?: FakeCodex; chat?: FakeOpenAIChat; search?: FakeSearchServices; rig?: PresetRig } = {}

beforeAll(async () => {
  fixture.codex = startFakeCodex()
  const chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
  fixture.chat = chat
  const search = startFakeSearchServices(KEYS)
  fixture.search = search
  fixture.rig = await startPresetRig({
    name: "websearch-keyed",
    codex: fixture.codex,
    chatgpt: [],
    endpoints: { ...search.endpoints },
    config: { providers: { [CHAT.providerID]: deepseekProvider(chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) } },
    // `websearch.set` writes the global config; an installed service reloads it through the file watcher.
    watchConfig: true,
    models: [CHAT],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop(), fixture.search?.stop()])
}, 60_000)

describe("own's keyed variants of core's keyless web search services (02 §9.2, SK)", () => {
  test("before any key: only core's keyless services are listed, and websearch.key.get lists every service unset", async () => {
    const rig = required(fixture.rig)
    const ids = await providerIDs()
    for (const id of KEYLESS) expect(ids).toContain(id)
    for (const id of VARIANTS) expect(ids).not.toContain(id)
    expect(await rig.call("websearch.key.get")).toEqual({
      keys: SearchKey.Service.literals.map((service) => ({ service, configured: false })),
      vault: "ok",
    })
  })

  test("each key stored through websearch.key.set lists its variant beside core's keyless one; core gets none", async () => {
    const rig = required(fixture.rig)
    for (const service of SEARCH_SERVICES) await rig.call("websearch.key.set", { service, key: KEYS[service] })
    await waitUntil(async () => {
      const ids = await providerIDs()
      return VARIANTS.every((id) => ids.includes(id))
    }, "the keyed variants were never all listed")
    const providers = await providerList()
    expect(providers.find((provider) => provider.id === "own-exa")?.name).toBe("Exa (내 키)")
    for (const id of KEYLESS) expect(providers.map((provider) => provider.id)).toContain(id)
    expect(await rig.call("websearch.key.get")).toEqual({
      keys: SearchKey.Service.literals.map((service) =>
        service === "brave"
          ? { service, configured: false }
          : { service, configured: true, keyHint: `…${KEYS[service].slice(-4)}` },
      ),
      vault: "ok",
    })
    // No integration connection: `websearch.get`'s `keys` (core's keys) stays empty.
    expect(await rig.call("websearch.get")).toMatchObject({ keys: {} })
  })

  test(
    "chosen in settings, a session's websearch runs on own-exa: core's request with the key in exaApiKey",
    async () => {
      const rig = required(fixture.rig)
      const search = required(fixture.search)
      const choice = { type: "service", id: "own-exa" }
      expect(await rig.call("websearch.set", { choice })).toMatchObject({ choice })
      await configured("own-exa")
      const from = search.calls.length

      const session = await rig.server.createSession({ model: CHAT, title: "keyed search" })
      await rig.server.prompt(session.id, `[websearch] ${QUERY}`)
      await rig.server.waitIdle(session.id)
      const [part, ...more] = await toolParts(rig.server, session.id, "websearch")
      expect(more).toEqual([])
      expect(part?.state.status).toBe("completed")
      expect(part?.state.metadata).toMatchObject({ provider: "own-exa" })

      const [request, ...others] = search.calls.slice(from)
      expect(others).toEqual([])
      expect(request).toMatchObject({ service: "exa", path: "/exa/mcp", key: hashSecret(KEYS.exa) })
      expect(queryOf(required(request))).toBe(QUERY)
      const after = required(fixture.chat).requests.filter(afterToolResult).at(-1)
      const output = after ? toolOutputs(after).join("\n") : ""
      expect(output).toContain(`## [Exa page](${pageOf("exa")})`)
      expect(output).toContain("Exa found this.")
    },
    TURN_TIMEOUT,
  )

  test(
    "여러 서비스 함께 with its default asks every service with its key through own's variants, once each",
    async () => {
      const rig = required(fixture.rig)
      const search = required(fixture.search)
      expect(await rig.call("websearch.set", { choice: { type: "multi" } })).toMatchObject({
        choice: { type: "multi" },
        multi: { services: VARIANTS, custom: false },
      })
      await configured("own-multi")
      await waitUntil(async () => (await providerIDs()).includes("own-multi"), "own-multi was never listed")
      const from = search.calls.length

      const session = await rig.server.createSession({ model: CHAT, title: "keyed multi search" })
      await rig.server.prompt(session.id, `[websearch] ${QUERY}`)
      await rig.server.waitIdle(session.id)
      const [part] = await toolParts(rig.server, session.id, "websearch")
      expect(part?.state.status).toBe("completed")
      expect(part?.state.metadata).toMatchObject({ provider: "own-multi" })

      const sent = search.calls.slice(from)
      const calls = searchesOf(sent)
      expect(calls.map((call) => call.service).toSorted()).toEqual([...SEARCH_SERVICES])
      for (const call of sent) expect(call.key).toBe(hashSecret(KEYS[call.service]))
      for (const call of sent.filter((item) => item.service !== "exa")) expect(call.userAgent).toStartWith("opencode/")
      // TinyFish's search runs in the MCP session its `initialize` answered (core's since v2.0.32).
      expect(sent.filter((call) => call.step !== undefined).map((call) => call.step)).toEqual([
        "initialize",
        "notifications/initialized",
      ])
      expect(calls.find((call) => call.service === "tinyfish")?.session).toStartWith("fake-tinyfish-session-")
      const after = required(fixture.chat).requests.filter(afterToolResult).at(-1)
      const output = after ? toolOutputs(after).join("\n") : ""
      const blocks = output.split(/\n(?=## \[)/)
      expect(blocks[0]).toStartWith(`## [Shared page](${SHARED_PAGE})`)
      expect(blocks[0]).toContain(
        "Found by: Exa (내 키), Firecrawl (내 키), Parallel (내 키), Tavily (내 키), TinyFish (내 키)",
      )
      for (const service of SEARCH_SERVICES) expect(output).toContain(`(${pageOf(service)})`)
      const lines = rig.server
        .logs()
        .split("\n")
        .filter((entry) => entry.includes('"msg":"websearch_query"') && entry.includes('"provider":"own-multi"'))
      expect(lines).toHaveLength(1)
      for (const id of VARIANTS) expect(lines[0]).toContain(`"id":"${id}"`)
    },
    TURN_TIMEOUT,
  )

  test("no key is in the database, its write-ahead log, the logs or the event stream", async () => {
    const rig = required(fixture.rig)
    const logs = rig.server.logs()
    const events = rig.events.text()
    const files = await Promise.all(
      [rig.server.paths.database, `${rig.server.paths.database}-wal`].map((file) =>
        fs.readFile(file).catch(() => Buffer.alloc(0)),
      ),
    )
    expect(files[0]!.length).toBeGreaterThan(0)
    for (const key of Object.values(KEYS)) {
      expect(logs).not.toContain(key)
      expect(events).not.toContain(key)
      for (const bytes of files) expect(bytes.includes(Buffer.from(key))).toBe(false)
    }
    expect(logs).not.toContain(QUERY)
    expect(await integrationIDs()).toEqual(expect.not.arrayContaining(VARIANTS))
  })

  test("removing a key unlists its variant; 여러 서비스 함께 then names core's keyless service again", async () => {
    const rig = required(fixture.rig)
    await rig.call("websearch.key.set", { service: "tavily", key: null })
    await waitUntil(async () => !(await providerIDs()).includes("own-tavily"), "own-tavily stayed listed")
    expect(await rig.call("websearch.get")).toMatchObject({
      multi: { services: ["own-exa", "own-firecrawl", "own-parallel", "tavily", "own-tinyfish"], custom: false },
    })
    // Back to one service, so no later search could reach core's keyless Tavily.
    await rig.call("websearch.set", { choice: { type: "service", id: "own-exa" } })
    await configured("own-exa")
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

/** The web search services the server lists at the workspace. */
async function providerList() {
  const answer = await required(fixture.rig).server.call("GET", "/api/websearch/provider")
  const providers = isRecord(answer) && Array.isArray(answer.data) ? answer.data : []
  return providers.flatMap((provider) =>
    isRecord(provider) && typeof provider.id === "string"
      ? [{ id: provider.id, name: typeof provider.name === "string" ? provider.name : "" }]
      : [],
  )
}

async function providerIDs() {
  return (await providerList()).map((provider) => provider.id)
}

/** The ids of core's integrations at the workspace. */
async function integrationIDs() {
  const answer = await required(fixture.rig).server.call("GET", "/api/integration")
  const integrations = isRecord(answer) && Array.isArray(answer.data) ? answer.data : []
  return integrations.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
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

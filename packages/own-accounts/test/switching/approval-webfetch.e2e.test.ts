// End to end on a real upstream server with own-accounts loaded (decisions MR10-3, MR11): own's `묻기` and `읽기 전용`
// approval ask before a web request, the `webfetch` tool's and Code Mode's `fetch` alike, and before a `websearch`,
// because a URL or a search query can send data out after a prompt injection; `전체 허용` still reaches the web unasked.
// Each mode is written through own.accounts' `session.approval.set`, as own-web does for a new conversation; each
// request raises exactly one card for its URL or query, answered `once`, and the page is then fetched or the search
// run. The chat model is a fake DeepSeek-dialect server, the page a local one on 127.0.0.1, the search service the
// e2e kit's `fake-search` (no network); every credential is fake. Conversations written with a former ask bundle (no
// web rule, or no websearch rule) still read 묻기 and ask through own-accounts' evaluate hook, their rules untouched.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolParts,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
  WEBSEARCH_FIXTURE_PLUGIN,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const CHAT_KEY = "fake-webfetch-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }

const fixture: { codex?: FakeCodex; chat?: FakeOpenAIChat; rig?: PresetRig; page?: ReturnType<typeof Bun.serve> } = {}
/** Every path the local page served. */
const served: string[] = []

beforeAll(async () => {
  fixture.page = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      served.push(pathname)
      return new Response(`page ${pathname}`)
    },
  })
  fixture.codex = startFakeCodex()
  fixture.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
  fixture.rig = await startPresetRig({
    name: "approval-webfetch",
    codex: fixture.codex,
    chatgpt: [],
    config: {
      providers: { [CHAT.providerID]: deepseekProvider(fixture.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
      // The chosen search service: no first-use form, and no search leaves this PC.
      websearch: { provider: "fake-search" },
      // The user's own deny (MR12-5): no own bundle lifts it, `전체 허용` neither.
      permission: { webfetch: { "*/denied/*": "deny" } },
    },
    plugins: [WEBSEARCH_FIXTURE_PLUGIN],
    models: [CHAT],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
  await fixture.page?.stop(true)
}, 60_000)

describe("web requests under own's approval modes (MR10-3, MR11)", () => {
  const cases = [
    { mode: "ask", cards: 1 },
    { mode: "read-only", cards: 1 },
    { mode: "full", cards: 0 },
  ] as const

  for (const item of cases)
    test(
      `${item.mode}: webfetch, Code Mode fetch and websearch each raise ${item.cards} card${item.cards === 1 ? "" : "s"}`,
      async () => {
        const rig = required(fixture.rig)
        const session = await rig.server.createSession({ model: CHAT, title: `webfetch ${item.mode}` })
        expect(await rig.call("session.approval.set", { sessionID: session.id, mode: item.mode })).toMatchObject({
          mode: item.mode,
        })
        for (const kind of ["webfetch", "fetch"] as const) {
          const url = `${base()}/${item.mode}/${kind}`
          const asked = await turn(session.id, `[${kind}] ${url}`)
          expect(asked).toEqual(item.cards === 1 ? [{ action: "webfetch", resources: [url] }] : [])
          expect(served).toContain(`/${item.mode}/${kind}`)
        }
        const query = `search ${item.mode}`
        const searched = await turn(session.id, `[websearch] ${query}`)
        expect(searched).toEqual(item.cards === 1 ? [{ action: "websearch", resources: [query] }] : [])
        // The tools and Code Mode all ran: the page and the result reached the model through each.
        const webfetch = await toolParts(rig.server, session.id, "webfetch")
        expect(webfetch.at(-1)?.state.status).toBe("completed")
        const execute = await toolParts(rig.server, session.id, "execute")
        expect(JSON.stringify(execute.at(-1)?.state)).toContain(`page /${item.mode}/fetch`)
        await expectSearched(session.id, query)
      },
      TURN_TIMEOUT,
    )
})

test("a webfetch the user's config denies is refused without a card under full and ask approval (MR12-5)", async () => {
  const rig = required(fixture.rig)
  for (const mode of ["full", "ask"] as const) {
    const session = await rig.server.createSession({ model: CHAT, title: `config deny ${mode}` })
    await rig.call("session.approval.set", { sessionID: session.id, mode })
    for (const kind of ["webfetch", "fetch"] as const) {
      const url = `${base()}/denied/${mode}-${kind}`
      expect(await turn(session.id, `[${kind}] ${url}`)).toEqual([])
      expect(served).not.toContain(`/denied/${mode}-${kind}`)
    }
    expect((await toolParts(rig.server, session.id, "webfetch")).at(-1)?.state.status).toBe("error")
  }
}, TURN_TIMEOUT)

const former = [
  { name: "before MR10-3 (no web rule)", tag: "legacy", drop: ["webfetch", "websearch"] },
  { name: "before MR11 (no websearch rule)", tag: "nosearch", drop: ["websearch"] },
] as const

for (const item of former)
  test(
    `a conversation written with the former ask bundle ${item.name} still reads 묻기 and asks once per web request`,
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: `web ${item.tag}` })
      await rig.call("session.approval.set", { sessionID: session.id, mode: "ask" })
      // The bundle as an older own-accounts wrote it.
      const current = (await rig.call("session.approval.get", { sessionID: session.id })).rules as ReadonlyArray<{
        readonly action: string
      }>
      const drop: ReadonlyArray<string> = item.drop
      const old = current.filter((rule) => !drop.includes(rule.action))
      expect(old.length).toBe(current.length - drop.length)
      await rig.server.call("PATCH", `/api/session/${session.id}`, { body: { permissions: old } })
      const read = await rig.call("session.approval.get", { sessionID: session.id })
      expect(read).toMatchObject({ mode: "ask", rules: old })
      for (const kind of ["webfetch", "fetch"] as const) {
        const url = `${base()}/${item.tag}/${kind}`
        expect(await turn(session.id, `[${kind}] ${url}`)).toEqual([{ action: "webfetch", resources: [url] }])
        expect(served).toContain(`/${item.tag}/${kind}`)
      }
      const query = `search ${item.tag}`
      expect(await turn(session.id, `[websearch] ${query}`)).toEqual([{ action: "websearch", resources: [query] }])
      await expectSearched(session.id, query)
      // Reading never rewrote the conversation's rules.
      expect((await rig.call("session.approval.get", { sessionID: session.id })).rules).toEqual(old)
    },
    TURN_TIMEOUT,
  )

test("no hook failed", () => {
  expect(required(fixture.rig).server.logs()).not.toMatch(/hook_failed/)
})

// ---------------------------------------------------------------------------------------------------------------

const base = () => `http://127.0.0.1:${required(fixture.page).port}`

/** The session's last `websearch` call completed with the fake service's result for `query`. */
async function expectSearched(sessionID: string, query: string) {
  const search = (await toolParts(required(fixture.rig).server, sessionID, "websearch")).at(-1)
  expect(search?.state.status).toBe("completed")
  expect(JSON.stringify(search?.state)).toContain(`result for ${query}`)
}

/** One prompt; every card it raises is answered `once`. Returns the cards in order. */
async function turn(sessionID: string, text: string) {
  const rig = required(fixture.rig)
  const seen = new Set(rig.events.events)
  const asked: Array<{ action: unknown; resources: unknown }> = []
  const state = { done: false }
  const answering = (async () => {
    while (!state.done) {
      const fresh = rig.events.events.filter(
        (event) => !seen.has(event) && event.type === "permission.asked" && event.data.sessionID === sessionID,
      )
      for (const event of fresh) {
        seen.add(event)
        asked.push({ action: event.data.action, resources: event.data.resources })
        await rig.server.call("POST", `/api/session/${sessionID}/permission/${String(event.data.id)}/reply`, {
          body: { decision: "once" },
        })
      }
      await Bun.sleep(100)
    }
  })()
  await rig.server.prompt(sessionID, text)
  await rig.server.waitIdle(sessionID).finally(() => {
    state.done = true
  })
  await answering
  return asked
}

/**
 * The chat model: `[webfetch] <url>` calls the tool, `[fetch] <url>` runs Code Mode's `fetch`, `[websearch] <query>`
 * searches; a result gets text.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "읽었어요." }
  const text = lastUserText(request)
  if (text.startsWith("[websearch]"))
    return { type: "tool-call", name: "websearch", input: { query: text.slice("[websearch] ".length) } }
  const url = text.split(" ").at(-1) ?? ""
  if (text.startsWith("[webfetch]")) return { type: "tool-call", name: "webfetch", input: { url, format: "text" } }
  if (text.startsWith("[fetch]"))
    return {
      type: "tool-call",
      name: "execute",
      input: { code: `const r = await fetch(${JSON.stringify(url)})\nreturn await r.text()` },
    }
  return { type: "text", text: "답변" }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

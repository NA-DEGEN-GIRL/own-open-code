// Code Mode's `fetch` goes through the `webfetch` permission in every harness (upstream bdca40ac0e, v2.2.3, and the
// redirect and requested-URL fixes b5b9bddb54 and 805a4b8200 picked onto v2.2.5; decisions US5). Until v2.2.3 it
// fetched any URL without a permission check, past a `webfetch` deny or ask. On a real server (source plugin, fake
// providers) core's `execute` runs `fetch` against a local page: ask approval's `webfetch` ask (MR10-3) raises a card
// for the exact URL and a declined card fetches nothing; a `webfetch` deny after read-only approval refuses without a
// card; an agent whose own rules deny `webfetch` refuses as well where the session's rules say nothing about it; full
// approval fetches, and a redirect to a URL a rule denies stops before that URL. codex (gpt-5.5, Direct tools), pi and
// opencode run on a fake OpenAI Responses provider, dsh on a fake DeepSeek chat provider. A Code Mode codex model
// (gpt-6.1-sol) gets Codex's `exec` instead of core's `execute`, and `exec` has no `fetch` at all. omo's case is in
// packages/own-omo/test/e2e/code-mode-fetch.test.ts.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  openAIResponsesProvider,
  opencodeConfig,
  sessionInfo,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIChat,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { HARNESS_PLUGINS } from "./full-prefix.js"

const BOOT_TIMEOUT = 180_000
const RESPONSES = { providerID: "fake-a", id: "gpt-5.5" }
const CODE_MODE = { providerID: "fake-a", id: "gpt-6.1-sol" }
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-pro" }
/** An agent whose own rules deny `webfetch`, as a read-only role's rules deny its actions. */
const NO_WEB = "no-web"
/**
 * own's approval bundles as own-accounts writes them (packages/own-accounts/src/switching/approval.ts): read-only and
 * ask ask before `webfetch` since MR10-3 (own-accounts `test/switching/approval-webfetch.e2e.test.ts`).
 */
const READ_ONLY = [
  { action: "edit", resource: "**", effect: "deny" },
  { action: "shell", resource: "**", effect: "deny" },
  { action: "webfetch", resource: "**", effect: "ask" },
]
const ASK = [
  { action: "edit", resource: "**", effect: "ask" },
  { action: "shell", resource: "**", effect: "ask" },
  { action: "webfetch", resource: "**", effect: "ask" },
]
/** Session rules that say nothing about `webfetch` (no own bundle's), where an agent's own rule decides. */
const NO_WEB_RULE = READ_ONLY.filter((rule) => rule.action !== "webfetch")
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  { action: "webfetch", resource: "**", effect: "allow" },
]

type Fake = FakeOpenAIResponses | FakeOpenAIChat
type Body = Record<string, unknown>
interface Case {
  readonly harness: OwnHarness.HarnessID
  readonly model: typeof RESPONSES
  readonly list: "input" | "messages"
  readonly fake: () => Fake
}

let responses: FakeOpenAIResponses
let chat: FakeOpenAIChat
let server: OpencodeServer
/** The local page `fetch` asks for, with every path it served. */
let page: ReturnType<typeof Bun.serve>
const served: string[] = []

const CASES: ReadonlyArray<Case> = [
  { harness: "codex", model: RESPONSES, list: "input", fake: () => responses },
  { harness: "pi", model: RESPONSES, list: "input", fake: () => responses },
  { harness: "opencode", model: RESPONSES, list: "input", fake: () => responses },
  { harness: "dsh", model: CHAT, list: "messages", fake: () => chat },
]

beforeAll(async () => {
  page = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      served.push(url.pathname)
      if (url.pathname.startsWith("/redirect/"))
        return Response.redirect(`${url.origin}/secret/${url.pathname.slice("/redirect/".length)}`, 302)
      return new Response(`page ${url.pathname}`)
    },
  })
  responses = startFakeOpenAIResponses({ models: ["gpt-5.5", "gpt-6.1-sol"] })
  chat = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(responses, {
            apiKey: "fake-key-a",
            models: { "gpt-5.5": { name: "gpt-5.5" }, "gpt-6.1-sol": { name: "gpt-6.1-sol" } },
          }),
          "fake-ds": deepseekProvider(chat, {
            apiKey: "fake-key-ds",
            models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 393_216 } } },
          }),
        },
        plugins: HARNESS_PLUGINS,
        extra: {
          agents: {
            [NO_WEB]: {
              mode: "primary",
              description: "No web access",
              permissions: [{ action: "webfetch", resource: "*", effect: "deny" }],
            },
          },
        },
      })
    },
  })
  await server.waitForModels([RESPONSES, CODE_MODE, CHAT])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await responses?.stop()
  await chat?.stop()
  await page?.stop(true)
}, 60_000)

const base = () => `http://127.0.0.1:${page.port}`

async function create(
  harness: OwnHarness.HarnessID,
  model: typeof RESPONSES,
  permissions: ReadonlyArray<object>,
  agent?: string,
) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `fetch ${harness}`,
      model,
      location: { directory: server.paths.workspace },
      permissions,
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
      ...(agent === undefined ? {} : { agent }),
    },
  })) as { data: { id: string } }
  const deadline = Date.now() + 15_000
  while (
    OwnHarness.bound((await sessionInfo(server, created.data.id)).metadata as Record<string, unknown>) === undefined
  ) {
    if (Date.now() > deadline) throw new Error("own.harness did not bind the session")
    await Bun.sleep(50)
  }
  return created.data.id
}

/**
 * One prompt answered by one tool call, then text; every permission request is answered `reply`. Returns the
 * session's requests that carried the prompt (first and last) and the permission requests it raised.
 */
async function run(
  item: Pick<Case, "list" | "fake">,
  sessionID: string,
  text: string,
  call: { name: string; input: Readonly<Record<string, unknown>>; freeform?: string },
  reply: Record<string, unknown> = { decision: "reject" },
) {
  const asked: Array<{ action: string; resources: ReadonlyArray<string> }> = []
  const state = { done: false }
  const answering = (async () => {
    while (!state.done) {
      const body = (await server.call("GET", `/api/session/${sessionID}/permission`)) as {
        data?: Array<Record<string, unknown>>
      }
      await Promise.all(
        (body.data ?? []).map((request) => {
          asked.push({ action: String(request.action), resources: request.resources as ReadonlyArray<string> })
          return server.call("POST", `/api/session/${sessionID}/permission/${String(request.id)}/reply`, {
            body: reply,
          })
        }),
      )
      await Bun.sleep(100)
    }
  })()
  const fake = item.fake()
  fake.enqueue({ type: "tool-call", ...call }, { type: "text", text: "done" })
  const before = fake.requests.length
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID).finally(() => {
    state.done = true
  })
  await answering
  const sent = fake.requests
    .slice(before)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as Body)
    // The session's own requests: a title request carries the prompt too, with no tools (a Responses Lite model gets
    // its tools as an `additional_tools` input item).
    .filter((body) => {
      const list = JSON.stringify(body[item.list])
      return (body.tools !== undefined || list.includes('"additional_tools"')) && list.includes(text)
    })
  if (sent.length === 0) throw new Error(`no request carried ${text}`)
  return { first: sent[0]!, last: sent.at(-1)!, asked }
}

const toolNames = (body: Body) =>
  ((body.tools ?? []) as Array<{ name?: string; function?: { name: string } }>).map(
    (tool) => tool.name ?? tool.function?.name,
  )

const execute = (code: string) => ({ name: "execute", input: { code } })
const fetchOne = (url: string) => execute(`const r = await fetch(${JSON.stringify(url)})\nreturn await r.text()`)

describe("Code Mode fetch follows webfetch rules in every harness", () => {
  for (const item of CASES) {
    test(`${item.harness}: ask raises a card for the URL, a deny and an agent's deny refuse, full stops a denied redirect`, async () => {
      const name = item.harness
      // Ask approval's `webfetch` ask: one card for the exact URL; declining it fetches nothing.
      const asking = await create(name, item.model, ASK)
      const askURL = `${base()}/ask/${name}`
      const declined = await run(item, asking, `Fetch ask ${name}.`, fetchOne(askURL), {
        decision: "reject",
        message: "No web pages now.",
      })
      expect(toolNames(declined.first)).toContain("execute")
      expect(declined.asked).toEqual([{ action: "webfetch", resources: [askURL] }])
      expect(JSON.stringify(declined.last[item.list])).toContain("No web pages now.")

      // A `webfetch` deny after read-only approval: refused, no card.
      const denying = await create(name, item.model, [
        ...READ_ONLY,
        { action: "webfetch", resource: "**", effect: "deny" },
      ])
      const denied = await run(item, denying, `Fetch deny ${name}.`, fetchOne(`${base()}/deny/${name}`))
      expect(denied.asked).toEqual([])

      // The agent's own deny, under session rules that say nothing about webfetch.
      const role = await create(name, item.model, NO_WEB_RULE, NO_WEB)
      const refused = await run(item, role, `Fetch role ${name}.`, fetchOne(`${base()}/role/${name}`))
      expect(refused.asked).toEqual([])

      // Full approval fetches; a redirect to a denied URL stops before it.
      const full = await create(name, item.model, [
        ...FULL,
        { action: "webfetch", resource: `${base()}/secret/*`, effect: "deny" },
      ])
      const code = [
        `const ok = await (await fetch("${base()}/full/${name}")).text()`,
        `const moved = await fetch("${base()}/redirect/${name}").then(() => "fetched", (error) => String(error))`,
        "return { ok, moved }",
      ].join("\n")
      const fetched = await run(item, full, `Fetch full ${name}.`, execute(code))
      expect(fetched.asked).toEqual([])
      const output = JSON.stringify(fetched.last[item.list])
      expect(output).toContain(`page /full/${name}`)
      expect(output).not.toContain(`page /secret/${name}`)

      expect(served.filter((pathname) => pathname.endsWith(`/${name}`))).toEqual([`/full/${name}`, `/redirect/${name}`])
    }, 180_000)
  }

  test("codex Code Mode: exec has no fetch, and core's execute is not offered", async () => {
    const sessionID = await create("codex", CODE_MODE, ASK)
    const url = `${base()}/exec/codex`
    const result = await run(
      { list: "input", fake: () => responses },
      sessionID,
      "Fetch from exec.",
      { name: "exec", input: {}, freeform: `const r = await fetch(${JSON.stringify(url)})\ntext(await r.text())` },
      { decision: "once" },
    )
    // GPT-6.1 Sol is a Responses Lite model: its tools arrive as an `additional_tools` input item.
    const offered = JSON.stringify(result.first.input)
    expect(offered).toContain('"name":"exec"')
    expect(offered).not.toContain('"name":"execute"')
    expect(result.asked).toEqual([])
    expect(served).not.toContain("/exec/codex")
    const output = (result.last.input as Array<Record<string, unknown>>).findLast(
      (entry) => entry.type === "custom_tool_call_output",
    )
    expect(JSON.stringify(output)).toContain("fetch")
  }, 180_000)
})

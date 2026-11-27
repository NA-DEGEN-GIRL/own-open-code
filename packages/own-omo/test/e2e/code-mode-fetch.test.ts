// Code Mode's `fetch` goes through the `webfetch` permission in an `omo` session too (upstream bdca40ac0e, v2.2.3, with
// b5b9bddb54 and 805a4b8200 picked onto v2.2.5; decisions US5); the other harnesses' case is
// packages/own-harness/test/e2e/code-mode-fetch.test.ts. A real server with own-harness and own-omo (the built omo
// runtime, OWN_OMO_RUNTIME or own/.out/omo; build it first with `bun script/bundle.ts`) and a fake DeepSeek chat provider:
// core's `execute` runs `fetch` against a local page; a `webfetch` ask raises one card for the exact URL and a declined
// card fetches nothing; a `webfetch` deny refuses without a card; full approval fetches.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  { action: "webfetch", resource: "**", effect: "allow" },
]

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }

let fake: FakeOpenAIChat
let server: OpencodeServer
let page: ReturnType<typeof Bun.serve>
const served: string[] = []

beforeAll(async () => {
  page = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      served.push(url.pathname)
      return new Response(`page ${url.pathname}`)
    },
  })
  fake = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
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
          "fake-ds": deepseekProvider(fake, {
            apiKey: "fake-key-ds",
            models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 393_216 } } },
          }),
        },
        model: "fake-ds/deepseek-v4-pro",
        plugins: [
          { package: path.join(REPO_ROOT, "packages/own-harness/test/e2e/fixtures/cache-verdict"), options: {} },
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
          { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
        ],
      })
    },
  })
  await server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
  await page?.stop(true)
}, 60_000)

const base = () => `http://127.0.0.1:${page.port}`

async function create(permissions: ReadonlyArray<object>) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "omo fetch",
      model: MODEL,
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value("omo") },
      permissions,
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

/** One prompt answered by an `execute` that fetches `url`, then text; every card is answered `reply`. */
async function run(sessionID: string, text: string, url: string, reply: Record<string, unknown>) {
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
  const code = `const r = await fetch(${JSON.stringify(url)})\nreturn await r.text()`
  fake.enqueue({ type: "tool-call", name: "execute", input: { code } }, { type: "text", text: "done" })
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
    .filter((body) => body.tools !== undefined && JSON.stringify(body.messages).includes(text))
  return { first: sent[0], last: sent.at(-1), asked }
}

test("omo: a webfetch ask raises a card for the URL, a deny refuses without one, full approval fetches", async () => {
  const askURL = `${base()}/ask/omo`
  const declined = await run(
    await create([...FULL.slice(0, 2), { action: "webfetch", resource: "**", effect: "ask" }]),
    "Fetch ask omo.",
    askURL,
    { decision: "reject", message: "No web pages now." },
  )
  expect(declined.first?.tools?.map((tool) => tool.function.name)).toContain("execute")
  expect(declined.asked).toEqual([{ action: "webfetch", resources: [askURL] }])
  expect(JSON.stringify(declined.last?.messages)).toContain("No web pages now.")

  const denied = await run(
    await create([...FULL.slice(0, 2), { action: "webfetch", resource: "**", effect: "deny" }]),
    "Fetch deny omo.",
    `${base()}/deny/omo`,
    { decision: "reject" },
  )
  expect(denied.asked).toEqual([])

  const full = await run(await create(FULL), "Fetch full omo.", `${base()}/full/omo`, { decision: "reject" })
  expect(full.asked).toEqual([])
  expect(JSON.stringify(full.last?.messages)).toContain("page /full/omo")
  expect(served).toEqual(["/full/omo"])
}, 180_000)

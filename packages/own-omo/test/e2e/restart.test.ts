// An omo turn across a service restart (15 §3.2): the server stops while an omo session's model request is open and
// starts again on the same data. The run that then goes on selects its tools when its drain starts, before any hook of
// own-omo runs, so own-omo starts omo while the plugin activates (the session was marked running), and the first
// request after the restart already has omo's tools. Core's restart recovery runs only in the managed service
// (`serve --service`, whose process tests are skipped on Windows); this server is `serve --stdio`, so a synthetic
// notice starts that drain instead, the way a recovered background job's notice does. Either way the drain selects
// its tools before own-omo's hooks. Uses the built runtime (OWN_OMO_RUNTIME or own/.out/omo).
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  opencodeConfig,
  REPO_ROOT,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const PROMPT = "survive the restart"
const OMO_TOOLS = ["task", "background_output", "background_cancel", "call_omo_agent", "todowrite"]

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }

let fake: FakeOpenAIChat
let server: OpencodeServer
let root: string
let restarted = false

function boot() {
  return startOpencodeServer({
    root,
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
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
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
          { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
        ],
      })
    },
  })
}

/** Waits for the model list; right after a boot it can answer 503 while the Location's plugins activate. */
async function ready() {
  const deadline = Date.now() + 60_000
  for (;;) {
    const listed = await server.waitForModels([MODEL]).then(
      () => true,
      (error: unknown) => {
        if (Date.now() > deadline || !String(error).includes("503")) throw error
        return false
      },
    )
    if (listed) return
    await Bun.sleep(250)
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "own-e2e-omo-restart-"))
  fake = startFakeOpenAIChat({
    models: ["deepseek-v4-pro"],
    responder: (request) => {
      if (!JSON.stringify((request.json as Body).messages).includes(PROMPT)) return undefined
      // Before the restart the request stays open until the server stops; after it the run ends.
      return restarted ? { type: "text", text: "back after the restart" } : { type: "text", text: "slow", delayMs: 600_000 }
    },
  })
  server = await boot()
  await ready()
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
  fs.rmSync(root, { recursive: true, force: true })
}, 60_000)

const asked = (from: number) =>
  fake.requests
    .slice(from)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as Body)
    .filter((body) => JSON.stringify(body.messages).includes(PROMPT))
const tools = (body: Body) => (body.tools ?? []).map((tool) => tool.function.name)

async function until<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${server.logs().split("\n").filter((line) => line.includes("own.omo")).join("\n")}`)
    await Bun.sleep(100)
  }
}

describe("omo across a restart (own-omo)", () => {
  test("the first request after a restart has omo's tools", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: {
        title: "omo restart",
        model: MODEL,
        location: { directory: server.paths.workspace },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value("omo") },
        permissions: [{ action: "edit", resource: "**", effect: "allow" }],
      },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    await server.prompt(sessionID, PROMPT)
    const first = await until(() => asked(0)[0], 60_000, "the first request")
    for (const name of OMO_TOOLS) expect(tools(first)).toContain(name)
    // The running mark is written when own-omo hears the execution start; give it a moment before the stop.
    await Bun.sleep(1_000)

    await server.stop()
    restarted = true
    const before = fake.requests.length
    server = await boot()
    await ready()
    await server.call("POST", `/api/session/${sessionID}/synthetic`, {
      body: { text: `The server restarted: ${PROMPT}.`, description: "Continuing after restart", resume: true },
    })
    const resumed = await until(() => asked(before)[0], 120_000, "the first request after the restart")
    expect(tools(resumed)).toEqual(expect.arrayContaining(OMO_TOOLS))
    expect(tools(resumed).some((name) => name.startsWith("omo_"))).toBe(false)
    await server.waitIdle(sessionID)
  }, 360_000)
})

// Codex's MultiAgentV2 tree across a server restart (agent-store.ts): a gpt-6 root spawns a helper with a full-history
// fork, the server stops and starts again on the same data, and the root's `followup_task` still finds `/root/helper`;
// the helper's next request still starts with the root's request it forked from (Codex 0.164.0 keeps the parent's
// prefix, #55548) and its role, and `wait_agent` returns on its FINAL_ANSWER. The fake answers by request content,
// since the root and the helper run concurrently.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-6.1-sol" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const FIRST = "Delegate the greeting to a helper."
const SECOND = "Ask the helper to say goodbye."

let fake: FakeOpenAIResponses
let server: OpencodeServer
let root: string

type Item = Record<string, any>
const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (json: unknown) => JSON.stringify(json)
const outputs = (json: unknown, name: string) =>
  items(json).filter(
    (item) =>
      item.type === "function_call_output" &&
      items(json).some((call) => call.type === "function_call" && call.name === name && call.call_id === item.call_id),
  )

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
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "gpt-6.1-sol": { name: "gpt-6.1-sol" } },
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "own-e2e-collab-restart-"))
  fake = startFakeOpenAIResponses({
    models: ["gpt-6.1-sol"],
    responder: (request) => {
      const json = request.json
      // The helper: its history holds the NEW_TASK messages.
      if (text(json).includes("Message Type: NEW_TASK"))
        return {
          type: "text",
          text: text(json).includes("Say goodbye.") ? "Goodbye from the helper." : "Hi from the helper.",
        }
      if (text(json).includes(SECOND)) {
        if (outputs(json, "followup_task").length === 0)
          return {
            type: "tool-call",
            name: "collaboration__followup_task",
            input: { target: "/root/helper", message: "Say goodbye." },
          }
        if (outputs(json, "wait_agent").length < 2)
          return { type: "tool-call", name: "collaboration__wait_agent", input: { timeout_ms: 60_000 } }
        return { type: "text", text: "The helper said goodbye." }
      }
      if (!text(json).includes(FIRST)) return { type: "text", text: "ok" }
      if (outputs(json, "spawn_agent").length === 0)
        return {
          type: "tool-call",
          name: "collaboration__spawn_agent",
          input: { task_name: "helper", message: "Say hi to the user.", fork_turns: "all" },
        }
      if (outputs(json, "wait_agent").length === 0)
        return { type: "tool-call", name: "collaboration__wait_agent", input: { timeout_ms: 60_000 } }
      return { type: "text", text: "The helper said hi." }
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

const posts = (from: number) => fake.requests.slice(from).filter((request) => request.method === "POST")

describe("codex collaboration across a restart", () => {
  test("the restarted server still resolves /root/helper, sends its forked history and wakes wait_agent", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: {
        title: "collab restart",
        model: MODEL,
        location: { directory: server.paths.workspace },
        permissions: FULL,
      },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)

    const before = fake.requests.length
    await server.prompt(sessionID, FIRST)
    await server.waitIdle(sessionID)
    const helperBefore = posts(before).filter((request) => text(request.json).includes("Message Type: NEW_TASK"))
    expect(helperBefore.length).toBeGreaterThan(0)
    // The full-history fork: the helper's request starts with the root's request it was spawned from, byte for byte.
    const rootFirst = items(
      posts(before).find(
        (request) => text(request.json).includes(FIRST) && !text(request.json).includes("Message Type: NEW_TASK"),
      )!.json,
    )
    expect(text(items(helperBefore[0]!.json).slice(0, rootFirst.length))).toBe(text(rootFirst))

    await server.stop()
    server = await boot()
    await ready()

    const after = fake.requests.length
    await server.prompt(sessionID, SECOND)
    const deadline = Date.now() + 90_000
    while (
      !posts(after).some((request) => text(request.json).includes("The helper said goodbye")) &&
      Date.now() < deadline
    ) {
      if (posts(after).some((request) => outputs(request.json, "wait_agent").length >= 2)) break
      await Bun.sleep(100)
    }
    await server.waitIdle(sessionID)
    const rootAfter = posts(after).filter(
      (request) => text(request.json).includes(SECOND) && !text(request.json).includes("Message Type: NEW_TASK"),
    )
    const helperAfter = posts(after)
      .filter((request) => text(request.json).includes("Say goodbye."))
      .filter((request) => text(request.json).includes("Message Type: NEW_TASK"))

    // followup_task found the helper by its path.
    const followup = outputs(rootAfter.at(-1)!.json, "followup_task")[0]!
    expect(String(followup.output)).not.toContain("not found")
    // The helper's request after the restart: its role and the same forked prefix as before.
    expect(helperAfter.length).toBeGreaterThan(0)
    const helperItems = items(helperAfter[0]!.json)
    expect(
      helperItems.some(
        (item) =>
          item.type === "message" &&
          item.role === "developer" &&
          String(item.content[0].text).includes("You are an agent in a team"),
      ),
    ).toBe(true)
    const prefix = (list: Array<Item>) => {
      const start = list.findIndex((item) => text(item).includes(FIRST))
      const end = list.findIndex((item) => text(item).includes("Message Type: NEW_TASK"))
      return JSON.parse(text(list.slice(start, end)), (key, value) => (key === "id" ? undefined : value)) as unknown
    }
    expect(prefix(helperItems)).toEqual(prefix(items(helperBefore[0]!.json)))
    // The stored fork brings back the same request, its tools item included.
    expect(text(helperItems.slice(0, rootFirst.length))).toBe(text(rootFirst))
    // wait_agent returned on the helper's FINAL_ANSWER.
    const last = rootAfter.at(-1)!.json
    expect(JSON.parse(String(outputs(last, "wait_agent").at(-1)!.output))).toEqual({
      message: "Wait completed.",
      timed_out: false,
    })
    expect(text(last)).toContain("Payload:\\nGoodbye from the helper.")
  }, 300_000)
})

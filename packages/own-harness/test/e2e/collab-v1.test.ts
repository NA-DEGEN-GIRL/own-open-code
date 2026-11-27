// Codex's MultiAgent v1 agents on own child sessions (collab-v1.ts) for gpt-5.5: the agent tools are deferred behind
// client tool_search (P-026), spawn_agent runs a child session, wait_agent returns its final status, and the parent
// gets Codex's <subagent_notification>. The fake answers by request content, since parent and child run concurrently.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
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

const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const PROMPT = "Ask a helper agent to say hi."

let fake: FakeOpenAIResponses
let server: OpencodeServer

type Item = Record<string, any>
const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (json: unknown) => JSON.stringify(json)
const call = (json: unknown, type: string, name?: string) =>
  items(json).find((item) => item.type === type && (name === undefined || item.name === name))
const output = (json: unknown, type: string, name?: string): Item | undefined => {
  const found = call(json, type, name)
  return found && items(json).find((item) => item.type.endsWith("_output") && item.call_id === found.call_id)
}

beforeAll(async () => {
  fake = startFakeOpenAIResponses({
    models: ["gpt-5.5"],
    responder: (request) => {
      const json = request.json
      if (!text(json).includes(PROMPT)) return { type: "text", text: "Hi from the helper." }
      if (output(json, "tool_search_call") === undefined)
        return { type: "tool-call", name: "tool_search", input: { query: "spawn agent" } }
      const spawned = output(json, "function_call", "spawn_agent")
      if (spawned === undefined)
        return { type: "tool-call", name: "multi_agent_v1__spawn_agent", input: { message: "Say hi to the user." } }
      if (output(json, "function_call", "wait_agent") === undefined)
        return {
          type: "tool-call",
          name: "multi_agent_v1__wait_agent",
          input: { targets: [JSON.parse(spawned.output).agent_id], timeout_ms: 60_000 },
        }
      return { type: "text", text: "The helper said hi." }
    },
  })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { "gpt-5.5": { name: "gpt-5.5" } } }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  await server.waitForModels([MODEL])
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe("codex v1 agents", () => {
  test(
    "tool_search finds the deferred agent tools; spawn_agent and wait_agent run a child session",
    async () => {
      const created = (await server.call("POST", "/api/session", {
        body: { title: "v1", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
      })) as { data: { id: string } }
      const sessionID = created.data.id
      while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
        await Bun.sleep(50)
      const before = fake.requests.length
      await server.prompt(sessionID, PROMPT)
      const sent = () => fake.requests.slice(before).filter((request) => request.method === "POST")
      const deadline = Date.now() + 90_000
      while (!sent().some((request) => text(request.json).includes("The helper said hi")) && Date.now() < deadline) {
        if (sent().some((request) => output(request.json, "function_call", "wait_agent") !== undefined)) break
        await Bun.sleep(100)
      }
      await server.waitIdle(sessionID)
      const root = sent().filter((request) => text(request.json).includes(PROMPT))

      // The first request: tool_search, no agent tools or subagent.
      const tools = (root[0]!.json as { tools: Array<Item> }).tools
      expect(tools.some((tool) => tool.type === "tool_search" && tool.execution === "client")).toBe(true)
      expect(tools.some((tool) => tool.name === "multi_agent_v1" || tool.name === "subagent")).toBe(false)

      // tool_search answers the deferred namespace; the replay carries Codex's items.
      const searched = output(root[1]!.json, "tool_search_call")!
      expect(searched.type).toBe("tool_search_output")
      expect(searched.tools[0]).toMatchObject({ type: "namespace", name: "multi_agent_v1" })
      expect(searched.tools[0].tools.some((tool: Item) => tool.name === "spawn_agent" && tool.defer_loading)).toBe(true)

      // spawn_agent: the call replays in the namespace; the output carries the thread id and a nickname.
      expect(call(root[2]!.json, "function_call", "spawn_agent")).toMatchObject({ namespace: "multi_agent_v1" })
      const spawned = JSON.parse(output(root[2]!.json, "function_call", "spawn_agent")!.output)
      expect(spawned.agent_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(typeof spawned.nickname).toBe("string")

      // wait_agent returns the child's final status.
      const waited = JSON.parse(output(root.at(-1)!.json, "function_call", "wait_agent")!.output)
      expect(waited).toEqual({ status: { [spawned.agent_id]: { completed: "Hi from the helper." } }, timed_out: false })
    },
    150_000,
  )
})

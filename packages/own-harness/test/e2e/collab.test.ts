// Codex's MultiAgentV2 collaboration on own child sessions (collab.ts): a gpt-6 root spawns an agent, waits for it,
// and reads its FINAL_ANSWER. The fake answers by request content, since the root and the child run concurrently.
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

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-6.1-sol" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const PROMPT = "Delegate the greeting to a helper."

let fake: FakeOpenAIResponses
let server: OpencodeServer

type Item = Record<string, any>
const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (json: unknown) => JSON.stringify(json)
const output = (json: unknown, name: string) => {
  const call = items(json).find((item) => item.type === "function_call" && item.name === name)
  return call && items(json).find((item) => item.type === "function_call_output" && item.call_id === call.call_id)
}

beforeAll(async () => {
  fake = startFakeOpenAIResponses({
    models: ["gpt-6.1-sol"],
    responder: (request) => {
      const json = request.json
      if (text(json).includes("Message Type: NEW_TASK")) return { type: "text", text: "Hi from the helper." }
      if (!text(json).includes(PROMPT)) return { type: "text", text: "ok" }
      if (output(json, "spawn_agent") === undefined)
        return {
          type: "tool-call",
          name: "collaboration__spawn_agent",
          input: { task_name: "helper", message: "Say hi to the user.", fork_turns: "none" },
        }
      if (output(json, "wait_agent") === undefined)
        return { type: "tool-call", name: "collaboration__wait_agent", input: { timeout_ms: 60_000 } }
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
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "gpt-6.1-sol": { name: "gpt-6.1-sol" } },
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  await server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe("codex collaboration", () => {
  test(
    "spawn_agent runs a child session, wait_agent returns when its FINAL_ANSWER arrives",
    async () => {
      const created = (await server.call("POST", "/api/session", {
        body: { title: "collab", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
      })) as { data: { id: string } }
      const sessionID = created.data.id
      while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
        await Bun.sleep(50)
      const before = fake.requests.length
      await server.prompt(sessionID, PROMPT)
      const sent = () => fake.requests.slice(before).filter((request) => request.method === "POST")
      const deadline = Date.now() + 90_000
      while (!sent().some((request) => text(request.json).includes("The helper said hi")) && Date.now() < deadline) {
        if (sent().some((request) => output(request.json, "wait_agent") !== undefined)) break
        await Bun.sleep(100)
      }
      await server.waitIdle(sessionID)
      const root = sent().filter((request) => text(request.json).includes(PROMPT))
      const child = sent().filter((request) => text(request.json).includes("Message Type: NEW_TASK"))

      // The root's first request: Codex's collaboration namespace and the multi-agent developer messages.
      const first = items(root[0]!.json)
      const tools = first[0]!.tools as Array<Item>
      expect(tools.map((namespace) => namespace.name)).toEqual(["functions", "clock", "collaboration"])
      expect(tools[2]!.tools.map((tool: Item) => tool.name)).toEqual([
        "followup_task",
        "interrupt_agent",
        "list_agents",
        "send_message",
        "spawn_agent",
        "wait_agent",
      ])
      expect(tools[0]!.tools.map((tool: Item) => tool.name)).not.toContain("subagent")
      const developer = first.filter((item) => item.type === "message" && item.role === "developer").map((item) => item.content[0].text as string)
      expect(developer.some((entry) => entry.startsWith("<multi_agent_role>You are `/root`"))).toBe(true)
      expect(developer.some((entry) => entry.startsWith("<multi_agent_mode>"))).toBe(true)

      // spawn_agent answers the task name; the child runs the NEW_TASK with the subagent role.
      expect(output(root[1]!.json, "spawn_agent")!.output).toBe('{"task_name":"/root/helper"}')
      expect(child.length).toBeGreaterThan(0)
      const childItems = items(child[0]!.json)
      expect(
        childItems.some((item) => item.type === "message" && item.role === "developer" && String(item.content[0].text).includes("You are an agent in a team")),
      ).toBe(true)
      expect(text(child[0]!.json)).toContain("Message Type: NEW_TASK\\nTask name: /root/helper\\nSender: /root\\nPayload:\\nSay hi to the user.")

      // wait_agent returns on the child's FINAL_ANSWER, which reaches the root's history.
      const last = root.at(-1)!.json
      expect(JSON.parse(output(last, "wait_agent")!.output)).toEqual({ message: "Wait completed.", timed_out: false })
      expect(text(last)).toContain("Message Type: FINAL_ANSWER\\nTask name: /root\\nSender: /root/helper\\nPayload:\\nHi from the helper.")
    },
    150_000,
  )
})

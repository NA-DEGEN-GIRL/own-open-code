// Full-history forks keep the parent's prefix (Codex 0.164.0, #55548; collab.ts `fork`, request.ts `childContext`):
// a gpt-6 root spawns a helper with `fork_turns` omitted (Codex's default, all), the helper spawns a leaf with
// `fork_turns: "all"` on another model (gpt-6-astra). Each child's first request starts with exactly the input of the
// request its parent spawned it from, byte for byte down to the `additional_tools` item, as Codex's
// `grandchild_full_fork_preserves_context_baseline` checks; after it come the spawning call completed as `aborted`, the
// inherited-context notice, the child's role and mode, and its task. The leaf on another model continues the window it
// inherited (MR8-17): `<model_instructions>` and its `<collaboration_mode>` before its mode, no `<model_switch>`. The fake
// answers by the latest task in a request, since the agents run concurrently.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { CodexRequest } from "../../src/codex/request.js"
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
const PROMPT = "Split the review between helpers."

type Item = Record<string, any>
type Body = { readonly input: Array<Item> }

let fake: FakeOpenAIResponses
let server: OpencodeServer

const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (value: unknown) => JSON.stringify(value)
/** The recipient of the latest task in a request: the agent whose request it is (`/root` has none). */
const agent = (json: unknown) => {
  const tasks = items(json).flatMap((item) => [
    ...text(item).matchAll(/Message Type: NEW_TASK\\nTask name: (\/root[^\\]*)\\n/g),
  ])
  return tasks.at(-1)?.[1] ?? "/root"
}
/** Outputs of the agent's own calls named `name`: after its latest task, so inherited calls do not count. */
const own = (json: unknown, name: string) => {
  const list = items(json)
  const start = list.findLastIndex((item) => text(item).includes("Message Type: NEW_TASK"))
  const mine = list.slice(start + 1)
  return mine.filter(
    (item) =>
      item.type === "function_call_output" &&
      mine.some((call) => call.type === "function_call" && call.name === name && call.call_id === item.call_id),
  )
}

beforeAll(async () => {
  fake = startFakeOpenAIResponses({
    models: ["gpt-6.1-sol", "gpt-6-astra"],
    responder: (request) => {
      const json = request.json
      const who = agent(json)
      if (who === "/root/helper/leaf") return { type: "text", text: "The leaf reviewed its half." }
      if (who === "/root/helper") {
        if (own(json, "spawn_agent").length === 0)
          return {
            type: "tool-call",
            name: "collaboration__spawn_agent",
            input: { task_name: "leaf", message: "Review the second half.", fork_turns: "all", model: "gpt-6-astra" },
          }
        if (own(json, "wait_agent").length === 0)
          return { type: "tool-call", name: "collaboration__wait_agent", input: { timeout_ms: 60_000 } }
        return { type: "text", text: "The helper and its leaf reviewed everything." }
      }
      if (!text(json).includes(PROMPT)) return { type: "text", text: "ok" }
      if (own(json, "spawn_agent").length === 0)
        return {
          type: "tool-call",
          name: "collaboration__spawn_agent",
          input: { task_name: "helper", message: "Review the first half." },
        }
      if (own(json, "wait_agent").length === 0)
        return { type: "tool-call", name: "collaboration__wait_agent", input: { timeout_ms: 60_000 } }
      return { type: "text", text: "Both halves are reviewed." }
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
            models: { "gpt-6.1-sol": { name: "gpt-6.1-sol" }, "gpt-6-astra": { name: "gpt-6-astra" } },
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  // Right after a boot the model list can answer 503 while the Location's plugins activate (5 s limit, slow under load).
  const deadline = Date.now() + 60_000
  while (
    !(await server.waitForModels([MODEL]).then(
      () => true,
      (error: unknown) => {
        if (Date.now() > deadline || !String(error).includes("503")) throw error
        return false
      },
    ))
  )
    await Bun.sleep(250)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe("codex full-history forks", () => {
  test("a child's and a grandchild's first requests start with their parent's spawning request unchanged", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: { title: "forks", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    const before = fake.requests.length
    const sent = () =>
      fake.requests
        .slice(before)
        .filter((request) => request.method === "POST")
        .map((request) => request.json as Body)
    await server.prompt(sessionID, PROMPT)
    const deadline = Date.now() + 150_000
    while (!sent().some((body) => text(body).includes("Both halves are reviewed")) && Date.now() < deadline) {
      if (sent().some((body) => agent(body) === "/root" && own(body, "wait_agent").length > 0)) break
      await Bun.sleep(100)
    }
    await server.waitIdle(sessionID)
    const of = (path: string) => sent().filter((body) => agent(body) === path)
    const root = of("/root").filter((body) => text(body).includes(PROMPT))
    const helper = of("/root/helper")
    const leaf = of("/root/helper/leaf")
    expect([root.length > 0, helper.length > 0, leaf.length > 0]).toEqual([true, true, true])

    // The helper forked from the root's first request (its answer was the spawn), the leaf from the helper's first.
    const parent = root[0]!.input
    const child = helper[0]!.input
    const grandchild = leaf[0]!.input
    expect(text(child.slice(0, parent.length))).toBe(text(parent))
    expect(text(grandchild.slice(0, child.length))).toBe(text(child))
    expect(parent[0]!.type).toBe("additional_tools")

    // After the inherited request: the spawning call completed as `aborted`, the inherited-context notice, the child's
    // role and mode as developer messages, then its task.
    const added = child.slice(parent.length)
    expect(added.map((item) => item.type)).toEqual([
      "function_call",
      "function_call_output",
      "message",
      "message",
      "message",
      "message",
    ])
    expect(added[0]).toMatchObject({ name: "spawn_agent", namespace: "collaboration" })
    expect(JSON.parse(added[0]!.arguments)).toEqual({ task_name: "helper", message: "Review the first half." })
    expect(added[1]).toMatchObject({ call_id: added[0]!.call_id, output: "aborted" })
    const developer = added.slice(2, 5)
    expect(developer.every((item) => item.role === "developer")).toBe(true)
    expect(developer[0]!.content[0].text).toBe(CodexRequest.INHERITED_NOTICE)
    expect(developer[1]!.content[0].text).toContain("You are an agent in a team")
    expect(developer[2]!.content[0].text).toStartWith("<multi_agent_mode>")
    expect(text(added[5])).toContain(
      "Message Type: NEW_TASK\\nTask name: /root/helper\\nSender: /root\\nPayload:\\nReview the first half.",
    )
    // Nothing of the child's initial context is repeated: same model, permissions and Location.
    expect(added.filter((item) => item.role === "user")).toEqual([])

    // The grandchild runs gpt-6-astra: after its role, the window's model update and its collaboration text, then the
    // same mode and task (MR8-17).
    const deeper = grandchild.slice(child.length)
    expect(leaf[0]!).toMatchObject({ model: "gpt-6-astra" })
    expect(deeper.map((item) => item.type)).toEqual([...added.map((item) => item.type), "message", "message"])
    expect(JSON.parse(deeper[0]!.arguments)).toEqual({
      task_name: "leaf",
      message: "Review the second half.",
      fork_turns: "all",
      model: "gpt-6-astra",
    })
    const texts = deeper.slice(2, 7).map((item) => item.content[0].text as string)
    expect(texts[0]).toBe(CodexRequest.INHERITED_NOTICE)
    expect(texts[1]).toContain("You are an agent in a team")
    expect(texts[2]).toStartWith("<model_instructions>\nThe current model is gpt-6-astra.\n")
    expect(texts[3]).toStartWith("<collaboration_mode>")
    expect(texts[4]).toStartWith("<multi_agent_mode>")
    expect(text(deeper)).not.toContain("<model_switch>")
    expect(text(deeper[7])).toContain("Task name: /root/helper/leaf\\nSender: /root/helper\\n")

    // The answers came back up the tree.
    expect(text(root.at(-1))).toContain("Payload:\\nThe helper and its leaf reviewed everything.")
  }, 240_000)
})

// Codex 0.165.0's incremental tools windows end to end (10 §6.10, incremental.ts): on a real server with the source
// plugin and a fake OpenAI Responses provider, a codex session switches GPT-6.1 Sol → Terra → Sol. Each request's
// input extends the one before it byte for byte (the window's prefix, Sol's base instructions and collaboration text
// included, is never rewritten), and each switch appends `<model_instructions>` and the new model's
// `<collaboration_mode>` right before the user's message, never `<model_switch>`.
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
import { Catalog } from "../../src/codex/catalog.js"
import { CodexIncremental } from "../../src/codex/incremental.js"
import { Fragments } from "../../src/codex/fragments.js"

const BOOT_TIMEOUT = 180_000
const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

type Item = Record<string, any>
type Body = { model: string; input: Array<Item> }

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: [SOL, TERRA] })
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
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { [SOL]: { name: SOL }, [TERRA]: { name: TERRA } },
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  await server.waitForModels([SOL, TERRA].map((id) => ({ providerID: "fake-a", id })))
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

const texts = (item: Item): Array<string> =>
  Array.isArray(item.content) ? item.content.map((part: Item) => part.text) : []

describe("codex harness: a Responses Lite window across changes of model", () => {
  test("Sol → Terra → Sol keeps the window's prefix and appends Codex's model updates", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: {
        title: "incremental",
        model: { providerID: "fake-a", id: SOL },
        location: { directory: server.paths.workspace },
        permissions: FULL,
      },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    const turn = async (prompt: string, model?: string) => {
      if (model !== undefined) await server.switchModel(sessionID, { providerID: "fake-a", id: model })
      fake.enqueue({ type: "text", text: `Answered: ${prompt}` })
      const before = fake.requests.length
      await server.prompt(sessionID, prompt)
      await server.waitIdle(sessionID)
      const sent = fake.requests
        .slice(before)
        .map((request) => request.json as Body)
        .filter((body) => JSON.stringify(body.input).includes(prompt))
      expect(sent).toHaveLength(1)
      return sent[0]!
    }
    const first = await turn("First on Sol.")
    const second = await turn("Then on Terra.", TERRA)
    const third = await turn("Back on Sol.", SOL)
    expect([first.model, second.model, third.model]).toEqual([SOL, TERRA, SOL])

    // Each request extends the one before it: nothing of the window is rewritten. Core replays an assistant item's
    // provider id only to the model that made it (to-llm-message.ts `sameModel`), so those ids are left aside.
    const plain = (item: Item) => JSON.stringify(item.role === "assistant" ? { ...item, id: undefined } : item)
    const extending = (next: Body, previous: Body) =>
      expect(next.input.slice(0, previous.input.length).map(plain)).toEqual(previous.input.map(plain))
    expect(first.input.some((item) => item.role === "assistant")).toBe(false)
    expect(second.input.slice(0, first.input.length)).toEqual(first.input)
    extending(third, second)
    expect(first.input[0]!.type).toBe("additional_tools")
    expect(texts(first.input[1]!)).toEqual([Catalog.instructions(Catalog.lookup(SOL))])

    // Right before each user message on a new model: <model_instructions>, then that model's collaboration text.
    const updates = (body: Body, prompt: string) => {
      const at = body.input.findIndex((item) => texts(item).includes(prompt))
      return body.input.slice(at - 2, at).map((item) => ({ role: item.role, texts: texts(item) }))
    }
    const expected = (model: string) => [
      {
        role: "developer",
        texts: [CodexIncremental.instructions(model, Catalog.instructions(Catalog.lookup(model)))],
      },
      { role: "developer", texts: [Fragments.collaboration(false, Catalog.lookup(model))] },
    ]
    expect(updates(second, "Then on Terra.")).toEqual(expected(TERRA))
    expect(updates(third, "Back on Sol.")).toEqual(expected(SOL))
    expect(JSON.stringify(third.input)).not.toContain("<model_switch>")
  }, 180_000)
})

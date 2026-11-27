// Context reset (core P-035, 11 §7) end to end for every harness on a real server (source plugin, fake providers):
// after `POST /reset` the next request carries none of the earlier messages, and after `DELETE /reset/:id` it carries
// them again, the part before the reset byte for byte as the last request before it (no instruction changed), with the
// same top-level fields. A compaction after a reset sees only what followed it. codex, pi and opencode run on a fake
// OpenAI Responses provider, dsh on a fake DeepSeek chat provider.
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
import { Checkpoint } from "../../src/checkpoint.js"
import { HARNESS_PLUGINS } from "./full-prefix.js"

const BOOT_TIMEOUT = 180_000
const RESPONSES = { providerID: "fake-a", id: "gpt-5.5" }
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-pro" }
/** Another Responses model, for a model switch across a reset. */
const SWITCHED = { providerID: "fake-a", id: "gpt-6.1-sol" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const CHECKPOINT = Checkpoint.SECTIONS.map((heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`).join(
  "\n",
)
/** Output limits are not part of a prompt cache key, and the request sizes them from the measured context. */
const OUTPUT_KEYS = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens"])

type Body = Record<string, unknown>
type Fake = FakeOpenAIResponses | FakeOpenAIChat
interface Case {
  readonly harness: OwnHarness.HarnessID
  readonly model: typeof RESPONSES
  /** The request's message list: `input` on Responses, `messages` on chat completions. */
  readonly list: "input" | "messages"
  readonly fake: () => Fake
}

let responses: FakeOpenAIResponses
let chat: FakeOpenAIChat
let server: OpencodeServer

const CASES: ReadonlyArray<Case> = [
  { harness: "codex", model: RESPONSES, list: "input", fake: () => responses },
  { harness: "pi", model: RESPONSES, list: "input", fake: () => responses },
  { harness: "opencode", model: RESPONSES, list: "input", fake: () => responses },
  { harness: "dsh", model: CHAT, list: "messages", fake: () => chat },
]

beforeAll(async () => {
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
      })
    },
  })
  await server.waitForModels([RESPONSES, CHAT, SWITCHED])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await responses?.stop()
  await chat?.stop()
}, 60_000)

/** A new session of `harness`, once own.harness has bound it. */
async function create(item: Case) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `reset ${item.harness}`,
      model: item.model,
      location: { directory: server.paths.workspace },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(item.harness) },
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

/** Runs one prompt answered by `reply`; the primary request that carried it. */
async function run(item: Case, sessionID: string, text: string, reply = `Answer: ${text}`) {
  const fake = item.fake()
  fake.enqueue({ type: "text", text: reply })
  const before = fake.requests.length
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  const sent = fake.requests
    .slice(before)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as Body)
    .find((body) => JSON.stringify(body[item.list]).includes(text))
  if (!sent) throw new Error(`no request carried ${text}`)
  return sent
}

async function reset(sessionID: string) {
  const admitted = (await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })) as {
    data: { id: string; type: string; delivery: string }
  }
  expect(admitted.data).toMatchObject({ type: "reset", delivery: "queue" })
  await server.waitIdle(sessionID)
  return admitted.data.id
}

const items = (body: Body, item: Case) => body[item.list] as ReadonlyArray<unknown>
const rest = (body: Body, item: Case) =>
  JSON.stringify(Object.entries(body).filter(([key]) => key !== item.list && !OUTPUT_KEYS.has(key)))

describe("context reset", () => {
  for (const item of CASES)
    test(`${item.harness}: the request after a reset has none of the earlier messages, an undo brings them back`, async () => {
      const sessionID = await create(item)
      const before = await run(item, sessionID, `Earlier secret question (${item.harness})`, "Earlier secret answer")
      const resetID = await reset(sessionID)

      const after = await run(item, sessionID, `Question after the reset (${item.harness})`)
      expect(JSON.stringify(items(after, item))).not.toContain("Earlier secret")
      expect(rest(after, item)).toBe(rest(before, item))

      await server.call("DELETE", `/api/session/${sessionID}/reset/${resetID}`)
      const again = await run(item, sessionID, `Question after the undo (${item.harness})`)
      const restored = JSON.stringify(items(again, item))
      expect(restored).toContain("Earlier secret question")
      expect(restored).toContain("Earlier secret answer")
      expect(restored).toContain("Question after the reset")
      expect(rest(again, item)).toBe(rest(before, item))
      // The part before the reset is the last request before it, item by item (the prefix cache reads it again).
      expect(
        items(again, item)
          .slice(0, items(before, item).length)
          .map((entry) => JSON.stringify(entry)),
      ).toEqual(items(before, item).map((entry) => JSON.stringify(entry)))
    }, 150_000)

  test("codex: a model switch just before a reset keeps its notice on the first message after it once undone", async () => {
    const item = CASES[0]!
    const sessionID = await create(item)
    await run(item, sessionID, "Question before the switch")
    await server.switchModel(sessionID, SWITCHED)
    const resetID = await reset(sessionID)
    const after = await run(item, sessionID, "Question after the switch and the reset")
    expect(JSON.stringify(items(after, item))).not.toContain("Question before the switch")
    await server.call("DELETE", `/api/session/${sessionID}/reset/${resetID}`)
    const again = items(await run(item, sessionID, "Question after the undo"), item).map((entry) =>
      JSON.stringify(entry),
    )
    // The marker renders nothing, so the switch belongs to the first visible message after it (historyMarks).
    const notice = again.findIndex((entry) => entry.includes("<model_switch>"))
    expect(notice).toBeGreaterThan(again.findIndex((entry) => entry.includes("Question before the switch")))
    expect(notice).toBeLessThanOrEqual(again.findIndex((entry) => entry.includes("Question after the switch")))
  }, 150_000)

  for (const item of CASES)
    test(`${item.harness}: a compaction after a reset sees only what followed it`, async () => {
      const sessionID = await create(item)
      await run(item, sessionID, `Hidden secret question (${item.harness})`, "Hidden secret answer")
      await reset(sessionID)
      await run(item, sessionID, `First visible question (${item.harness})`)
      await run(item, sessionID, `Second visible question (${item.harness})`)
      const fake = item.fake()
      fake.enqueue({ type: "text", text: `<checkpoint>\n${CHECKPOINT}\n</checkpoint>` })
      const start = fake.requests.length
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
      await server.waitIdle(sessionID)
      const compaction = fake.requests.slice(start).filter((request) => request.method === "POST")
      expect(compaction.length).toBeGreaterThan(0)
      for (const request of compaction) expect(JSON.stringify(request.json)).not.toContain("Hidden secret")
      const next = await run(item, sessionID, `Question after the compaction (${item.harness})`)
      expect(JSON.stringify(items(next, item))).not.toContain("Hidden secret")
      expect(JSON.stringify(items(next, item))).toContain("First visible question")
    }, 150_000)
})

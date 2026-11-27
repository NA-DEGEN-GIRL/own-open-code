// own's checkpoint compaction (own/docs/11-compaction-prompt.md) for a model outside OpenAI Responses, end to end: the
// compaction request asks with the checkpoint prompt and keeps the tools (prefix cache), first as the previous request
// byte for byte plus the newer messages and a prompt naming the kept start (P-034; the verdict fixture stands in for
// own-accounts' warm verdict, CC-16), then, when that reply is unusable, as the older part whose malformed reply is
// repaired once (P-025 `accept`/`repair`); the stored summary has no analysis, and the next request carries the
// checkpoint with the user's earlier messages verbatim.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Checkpoint } from "../../src/checkpoint.js"
import { expectFullPrefix, HARNESS_PLUGINS, keptPrompt } from "./full-prefix.js"
import {
  deepseekProvider,
  opencodeConfig,
  sessionInfo,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const CHECKPOINT = Checkpoint.SECTIONS.map((heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`).join("\n")

let fake: FakeOpenAIChat
let server: OpencodeServer

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }
const text = (content: unknown) =>
  typeof content === "string" ? content : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("")

beforeAll(async () => {
  fake = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-ds": deepseekProvider(fake, { apiKey: "fake-key", models: { "deepseek-v4-pro": { name: "deepseek-v4-pro" } } }),
        },
        plugins: HARNESS_PLUGINS,
      })
    },
  })
  await server.waitForModels([MODEL])
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe("checkpoint compaction", () => {
  test(
    "asks with the checkpoint prompt, repairs a malformed reply, and resumes with the checkpoint",
    async () => {
      const created = (await server.call("POST", "/api/session", {
        body: { title: "checkpoint", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
      })) as { data: { id: string } }
      const sessionID = created.data.id
      while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
        await Bun.sleep(50)
      fake.enqueue({ type: "text", text: "First answer." })
      await server.prompt(sessionID, "첫 질문: parser 고쳐줘.")
      await server.waitIdle(sessionID)
      fake.enqueue({ type: "text", text: "Second answer." })
      await server.prompt(sessionID, "Second question about the lexer.")
      await server.waitIdle(sessionID)

      const previous = fake.requests.filter((request) => request.method === "POST").at(-1)!.json as Body
      // The full-prefix attempt's unusable reply goes straight to the older request (P-034), whose malformed reply is
      // repaired once.
      fake.enqueue(
        { type: "text", text: "<analysis>notes only</analysis>" },
        { type: "text", text: "<analysis>notes only</analysis>" },
        { type: "text", text: `<analysis>private notes</analysis>\n<checkpoint>\n${CHECKPOINT}\n</checkpoint>` },
      )
      const before = fake.requests.length
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
      await server.waitIdle(sessionID)
      const compaction = fake.requests
        .slice(before)
        .filter((request) => request.method === "POST")
        .map((request) => request.json as Body)
      expect(compaction).toHaveLength(3)
      expect(text(compaction[0]!.messages.at(-1)!.content)).toBe(keptPrompt("Second question about the lexer."))
      expectFullPrefix(previous, compaction[0]!, "messages")
      expect(text(compaction[1]!.messages.at(-1)!.content)).toBe(Checkpoint.prompt())
      expect(compaction[1]!.messages.length).toBeLessThan(compaction[0]!.messages.length)
      expect(text(compaction[2]!.messages.at(-1)!.content)).toBe(Checkpoint.repair())
      expect((compaction[0]!.tools ?? []).length).toBeGreaterThan(0)

      fake.enqueue({ type: "text", text: "Third answer." })
      const after = fake.requests.length
      await server.prompt(sessionID, "Third question.")
      await server.waitIdle(sessionID)
      const next = fake.requests
        .slice(after)
        .map((request) => request.json as Body)
        .find((body) => JSON.stringify(body).includes("Third question."))!
      const all = next.messages.map((message) => text(message.content)).join("\n")
      expect(all).toContain("<conversation-checkpoint>\nThe earlier part of this conversation was condensed")
      expect(all).toContain("## Next step\n- Next step item")
      expect(all).toContain("<message>\n첫 질문: parser 고쳐줘.\n</message>")
      expect(all).not.toContain("private notes")
    },
    150_000,
  )

  test(
    "an opencode-harness session compacts the same way",
    async () => {
      const sessionID = await session({ [OwnHarness.META_KEY]: OwnHarness.value("opencode") })
      fake.enqueue({ type: "text", text: "First answer." })
      await server.prompt(sessionID, "Plain harness question.")
      await server.waitIdle(sessionID)
      fake.enqueue({ type: "text", text: "Second answer." })
      await server.prompt(sessionID, "Plain harness follow-up question.")
      await server.waitIdle(sessionID)
      const previous = fake.requests.filter((request) => request.method === "POST").at(-1)!.json as Body
      fake.enqueue({ type: "text", text: `<checkpoint>\n${CHECKPOINT}\n</checkpoint>` })
      const before = fake.requests.length
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
      await server.waitIdle(sessionID)
      const compaction = fake.requests.slice(before).map((request) => request.json as Body)
      expect(compaction).toHaveLength(1)
      expect(text(compaction[0]!.messages.at(-1)!.content)).toBe(keptPrompt("Plain harness follow-up question."))
      expectFullPrefix(previous, compaction[0]!, "messages")

      const all = await nextRequest(sessionID, "Plain harness follow-up.")
      expect(all).toContain("<conversation-checkpoint>\nThe earlier part of this conversation was condensed")
      expect(all).toContain("<message>\nPlain harness question.\n</message>")
    },
    150_000,
  )

  test(
    "when the model fails to compact and nothing stands in, code makes the checkpoint and says so",
    async () => {
      const sessionID = await session()
      fake.enqueue({ type: "text", text: "Edited the lexer." })
      await server.prompt(sessionID, "Fix the lexer, please.")
      await server.waitIdle(sessionID)
      fake.enqueue({ type: "error", status: 400, body: { error: { message: "refused by safeguards" } } })
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
      await server.waitIdle(sessionID)

      const all = await nextRequest(sessionID, "And now the parser.")
      expect(all).toContain("made by code without a model because compaction failed (")
      expect(all).toContain("## Critical context\n- The assistant's last message before this point:\nEdited the lexer.")
      expect(all).toContain("<message>\nFix the lexer, please.\n</message>")
    },
    150_000,
  )
})

/** A new session on the fake DeepSeek model, once the harness bound it. */
async function session(metadata?: Record<string, unknown>) {
  const created = (await server.call("POST", "/api/session", {
    body: { title: "checkpoint", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL, metadata },
  })) as { data: { id: string } }
  while (OwnHarness.bound((await sessionInfo(server, created.data.id)).metadata as Record<string, unknown>) === undefined)
    await Bun.sleep(50)
  return created.data.id
}

/** The text of the next request that carries `prompt`. */
async function nextRequest(sessionID: string, prompt: string) {
  fake.enqueue({ type: "text", text: "Answer." })
  const after = fake.requests.length
  await server.prompt(sessionID, prompt)
  await server.waitIdle(sessionID)
  const next = fake.requests
    .slice(after)
    .map((request) => request.json as Body)
    .find((body) => JSON.stringify(body).includes(prompt))!
  return next.messages.map((message) => text(message.content)).join("\n")
}

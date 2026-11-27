import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { startFakeAnthropic, type FakeAnthropic } from "./fakes/anthropic"
import { startFakeCodex, type FakeCodex } from "./fakes/codex"
import { startFakeOpenAIChat, type FakeOpenAIChat } from "./fakes/openai-chat"
import { startFakeOpenAIResponses, type FakeOpenAIResponses } from "./fakes/openai-responses"
import { hashSecret, type RecordedRequest } from "./fakes/shared"
import {
  anthropicProvider,
  codexProvider,
  deepseekProvider,
  opencodeConfig,
  openAIResponsesProvider,
} from "./harness/config"
import { startOpencodeServer, type ModelRef, type OpencodeServer } from "./harness/opencode-server"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

// Booting the upstream server from source takes ~10s warm and ~30s on a cold transpiler cache.
const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const PRIMARY = { providerID: "fake-primary", id: "fake-model-a" }
const SECONDARY = { providerID: "fake-secondary", id: "fake-model-b" }
const CODEX = { providerID: "fake-codex", id: "gpt-fake" }
const ANTHROPIC = { providerID: "fake-anthropic", id: "claude-fake" }
const DEEPSEEK = { providerID: "fake-deepseek", id: "deepseek-fake" }

describe("e2e kit smoke", () => {
  const state: {
    responses?: FakeOpenAIResponses
    codex?: FakeCodex
    anthropic?: FakeAnthropic
    chat?: FakeOpenAIChat
    server?: OpencodeServer
  } = {}

  beforeAll(async () => {
    const small = { minTokens: 0, blockTokens: 32 }
    state.responses = startFakeOpenAIResponses({ cache: small })
    state.codex = startFakeCodex({ cache: small })
    state.anthropic = startFakeAnthropic({ cache: { minTokens: 0 } })
    state.chat = startFakeOpenAIChat({ cache: small })
    const tokens = state.codex.login({ accountID: "acct-smoke" })
    state.server = await startOpencodeServer({
      config: opencodeConfig({
        providers: {
          // One fake OpenAI Responses server backs both; they differ by credential and model.
          [PRIMARY.providerID]: openAIResponsesProvider(state.responses, {
            apiKey: "fake-key-primary",
            models: [PRIMARY.id],
          }),
          [SECONDARY.providerID]: openAIResponsesProvider(state.responses, {
            apiKey: "fake-key-secondary",
            models: [SECONDARY.id],
          }),
          [CODEX.providerID]: codexProvider(state.codex, {
            accessToken: tokens.accessToken,
            accountID: tokens.accountID,
            models: [CODEX.id],
            transport: "websocket",
          }),
          [ANTHROPIC.providerID]: anthropicProvider(state.anthropic, { apiKey: "sk-ant-fake", models: [ANTHROPIC.id] }),
          [DEEPSEEK.providerID]: deepseekProvider(state.chat, { apiKey: "ds-fake", models: [DEEPSEEK.id] }),
        },
        model: `${PRIMARY.providerID}/${PRIMARY.id}`,
      }),
    })
    await state.server.waitForModels([PRIMARY, SECONDARY, CODEX, ANTHROPIC, DEEPSEEK])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.responses?.stop(), state.codex?.stop(), state.anthropic?.stop(), state.chat?.stop()])
  }, 60_000)

  test(
    "a prompt reaches the fake and a model switch changes the next request",
    async () => {
      const fake = required(state.responses)
      const server = required(state.server)
      const session = await server.createSession({ model: PRIMARY })

      fake.enqueue({ type: "text", text: "first answer" })
      await server.prompt(session.id, "first question")
      await server.waitIdle(session.id)

      const [first] = await fake.waitForRequests(1, { filter: isResponsesCall })
      expect(first.status).toBe(200)
      expect(first.model).toBe(PRIMARY.id)
      expect(first.headers.authorization).toBe(hashSecret("Bearer fake-key-primary"))
      expect(first.headers["x-opencode-session"]).toBe(session.id)
      expect(instructions(first)).toContain(`- Provider ID: ${PRIMARY.providerID}`)
      expect(first.body).toContain("first question")

      await server.switchModel(session.id, SECONDARY)
      fake.enqueue({ type: "text", text: "second answer" })
      await server.prompt(session.id, "second question")
      await server.waitIdle(session.id)

      const second = (await fake.waitForRequests(2, { filter: isResponsesCall }))[1]
      expect(second.status).toBe(200)
      expect(second.model).toBe(SECONDARY.id)
      expect(second.headers.authorization).toBe(hashSecret("Bearer fake-key-secondary"))
      expect(second.identity).not.toBe(first.identity)
      expect(instructions(second)).toContain(`- Provider ID: ${SECONDARY.providerID}`)
      // The history carries over: the first turn is replayed to the new provider.
      expect(second.body).toContain("first answer")
      expect(second.body).toContain("second question")
      // Another credential is another cache domain, so nothing of the first prefix is reused.
      expect(second.cache?.cachedTokens).toBe(0)

      expect(await assistantModels(server, session.id)).toEqual([PRIMARY, SECONDARY])
    },
    TURN_TIMEOUT,
  )

  test(
    "Codex (WebSocket), Anthropic and DeepSeek fakes speak the native packages' protocols",
    async () => {
      const server = required(state.server)
      const codex = required(state.codex)
      const anthropic = required(state.anthropic)
      const chat = required(state.chat)
      const session = await server.createSession({ model: CODEX })
      const turn = async (model: ModelRef, text: string) => {
        await server.switchModel(session.id, model)
        await server.prompt(session.id, text)
        await server.waitIdle(session.id)
      }

      await turn(CODEX, "via codex")
      await turn(ANTHROPIC, "via anthropic")
      await turn(DEEPSEEK, "via deepseek")

      const [frame] = await codex.waitForRequests(1, { filter: (request) => request.method === "WS" })
      expect(codex.requests[0]).toMatchObject({ transport: "websocket", method: "GET", status: 101 })
      expect(frame).toMatchObject({ status: 200, model: CODEX.id, identity: "codex:acct-smoke" })
      expect(frame.headers["chatgpt-account-id"]).toBe("acct-smoke")

      const [message] = await anthropic.waitForRequests(1)
      expect(message).toMatchObject({ status: 200, path: "/v1/messages", model: ANTHROPIC.id })
      expect(message.headers["x-api-key"]).toBe(hashSecret("sk-ant-fake"))
      expect(message.body).toContain("via codex")

      const [completion] = await chat.waitForRequests(1)
      expect(completion).toMatchObject({ status: 200, path: "/v1/chat/completions", model: DEEPSEEK.id })
      expect(completion.headers.authorization).toBe(hashSecret("Bearer ds-fake"))
      expect(completion.body).toContain("via anthropic")

      expect(await assistantModels(server, session.id)).toEqual([CODEX, ANTHROPIC, DEEPSEEK])
    },
    TURN_TIMEOUT,
  )
})

function isResponsesCall(request: RecordedRequest) {
  return request.method === "POST" && request.path === "/v1/responses"
}

/** The system prompt: a leading developer message on Responses routes since upstream v2.3.2 (#64542). */
function instructions(request: RecordedRequest) {
  const json = request.json
  if (typeof json !== "object" || json === null || !("input" in json) || !Array.isArray(json.input)) return ""
  const first: unknown = json.input[0]
  if (typeof first !== "object" || first === null || !("role" in first) || first.role !== "developer") return ""
  return "content" in first && typeof first.content === "string" ? first.content : ""
}

/** Models of the assistant messages, oldest first (the message list is newest first). */
async function assistantModels(server: OpencodeServer, sessionID: string) {
  return (await server.messages(sessionID))
    .filter((message) => message.type === "assistant")
    .toReversed()
    .map((message) => {
      const model = message.model
      return typeof model === "object" && model !== null && "providerID" in model && "id" in model
        ? { providerID: model.providerID, id: model.id }
        : undefined
    })
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

// P-017 on the runner's output-limit path, on a real upstream server (own/ledger/core-patches.yaml P-017, upstream
// d9987ef9c8). Two providers serve one model id from the same fake OpenAI-compatible chat server, the way two own
// account slots of one kind do. A session answers once on A, switches to B and asks again. Core gives B's request
// `maxTokens = min(output, context − measured − ceil(estimated × 1.15))`; with P-017 the measured part is A's count of
// the history and only B's new tail is estimated. Without it B has no count of its own, estimates the whole history
// from text, and Korean text (P-016: 0.65 tokens a syllable; the fake counts 0.25) asks for a far smaller limit.
// No own plugin is loaded: the patch is core's. Every credential is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  deepseekProvider,
  opencodeConfig,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
  type RecordedRequest,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 180_000
const MODEL = "shared-model"
const A = { providerID: "fake-slot-a", id: MODEL }
const B = { providerID: "fake-slot-b", id: MODEL }
const LIMIT = { context: 100_000, output: 90_000 }
/** 40k Hangul syllables: the fake counts about 10k tokens, P-016 estimates 26k. */
const KOREAN = "가나다라마바사아자차".repeat(4_000)
/** Room for B's new tail (one short user message), estimated and padded by core. */
const TAIL_ALLOWANCE = 1_000

describe("P-017: the output limit after a switch between providers of one model id", () => {
  const state: { chat?: FakeOpenAIChat; server?: OpencodeServer } = {}

  beforeAll(async () => {
    state.chat = startFakeOpenAIChat({ cache: { minTokens: 0 } })
    const models = { [MODEL]: { name: MODEL, limit: LIMIT } }
    state.server = await startOpencodeServer({
      config: opencodeConfig({
        providers: {
          [A.providerID]: deepseekProvider(state.chat, { apiKey: "fake-key-slot-a", models }),
          [B.providerID]: deepseekProvider(state.chat, { apiKey: "fake-key-slot-b", models }),
        },
        model: `${A.providerID}/${A.id}`,
      }),
    })
    await state.server.waitForModels([A, B])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.chat?.stop()
  }, 60_000)

  test(
    "B's limit leaves room for A's measured count plus its own tail, not a text estimate of the whole history",
    async () => {
      const server = required(state.server)
      const chat = required(state.chat)
      const session = await server.createSession({ model: A, title: "shared anchor" })
      await server.prompt(session.id, KOREAN)
      await server.waitIdle(session.id)
      const answered = (await server.messages(session.id)).findLast((message) => message.type === "assistant")
      const measured = measuredOf(answered)
      expect(measured).toBeGreaterThan(10_000)

      await server.switchModel(session.id, B)
      await server.prompt(session.id, "다음 질문")
      await server.waitIdle(session.id)

      const requests = chat.requests.filter(
        (request) => request.path.endsWith("/chat/completions") && request.headers["x-opencode-session-id"] === session.id,
      )
      expect(requests).toHaveLength(2)
      const [first, second] = requests
      // Two providers, two credentials.
      expect(required(second).identity).not.toBe(required(first).identity)
      const limit = maxTokensOf(required(second))
      // Primary output limits leave upstream's 1% window headroom (v2.2.1, model-request.ts WINDOW_HEADROOM).
      const room = Math.floor(LIMIT.context * 0.99) - measured
      expect(limit).toBeLessThanOrEqual(room)
      expect(limit).toBeGreaterThan(room - TAIL_ALLOWANCE)
    },
    TURN_TIMEOUT,
  )
})

/** Core's measured prompt of an assistant message: every counted token (`compaction.ts` estimatePrompt). */
function measuredOf(message: Record<string, unknown> | undefined) {
  const tokens = required(message).tokens as {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning
}

function maxTokensOf(request: RecordedRequest) {
  const body = request.json as { readonly max_tokens?: number; readonly max_completion_tokens?: number }
  return required(body.max_tokens ?? body.max_completion_tokens)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value")
  return value
}

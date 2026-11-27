// Sign in with ChatGPT input items (02 §3.2c "입력 항목"): a same-model effort change leaves a marker that OpenAI
// Responses lowers to a `configuration_update` item for GPT-6 and later, which token sharing refuses with
// `subscription_sharing_unsupported_capability`. siwc requests drop the markers; other slots keep them. A refusal that
// nothing sends again raises a Korean alert. The lowering check runs the real `@opencode/ai` request compiler.

import { describe, expect, test } from "bun:test"
import { ai, Auth as RouteAuth, Message } from "@opencode/ai/effect"
import { OpenAIResponses } from "@opencode/ai/protocols/openai-responses"
import { compileRequest } from "@opencode/ai/testing"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import { Effect } from "effect"
import { Shape } from "../../src/auth/shape.js"
import { registryWith } from "../slots/support.js"
import { authSetup, context, ref, registeredHooks } from "./support.js"

const SESSION = "ses_sharing_input"
const SIWC = ref("own-siwc-ssss", "gpt-6.1-sol")
const CODEX = ref("own-codex-cccc", "gpt-6.1-sol")
const UNSUPPORTED = JSON.stringify({
  error: {
    message: "User subscription sharing currently supports only text, image, and file messages, …",
    type: "invalid_request_error",
    param: "input",
    code: "subscription_sharing_unsupported_capability",
  },
})

/** The history of the reported session: one turn, high → max → high, then the failing prompt. */
function history() {
  return [
    Message.user("first"),
    Message.assistant("reply"),
    Message.effort({ effort: "max", previous: "high" }),
    Message.effort({ effort: "high", previous: "max" }),
    Message.system("Instructions updated: core/codemode"),
    Message.user("test"),
  ]
}

async function setup() {
  const registry = await registryWith([
    { kind: "siwc", label: "S", slug: "ssss" },
    { kind: "codex", label: "C", slug: "cccc" },
  ])
  return authSetup({ registry })
}

const responses = (id: string) =>
  OpenAIResponses.route
    .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: RouteAuth.bearer("test") })
    .model({ id })

/** The OpenAI Responses body core would send for these messages at the given effort. */
async function body(messages: ReadonlyArray<Message>, effort: string) {
  const prepared = await Effect.runPromise(
    compileRequest(
      ai.request({ model: responses("gpt-6.1-sol"), messages, providerOptions: { reasoningEffort: effort } }),
    ),
  )
  // SAFETY: the OpenAI Responses route compiles to its body schema.
  return prepared.body as OpenAIResponses.OpenAIResponsesBody
}

const itemTypes = (value: OpenAIResponses.OpenAIResponsesBody) =>
  value.input.map((item) => ("type" in item ? item.type : "message"))

describe("siwc effort markers", () => {
  test("a siwc request drops effort markers and keeps every other message; a codex request keeps them", async () => {
    await using s = await setup()
    const siwc = context(SESSION, SIWC, { messages: history() })
    const codex = context(SESSION, CODEX, { messages: history() })
    await s.auth.onRequestShape(siwc)
    await s.auth.onRequestShape(codex)
    expect(siwc.messages.map((message) => message.content[0]?.type)).toEqual(["text", "text", "text", "text"])
    expect(siwc.messages.map((message) => message.role)).toEqual(["user", "assistant", "system", "user"])
    expect(codex.messages).toHaveLength(6)
    expect(s.logs.join("\n")).toContain("sharing_effort_updates_dropped")
  })

  test("the shaping is deterministic and leaves a history without markers as it was", async () => {
    await using s = await setup()
    const first = context(SESSION, SIWC, { messages: history() })
    const second = context(SESSION, SIWC, { messages: history() })
    await s.auth.onRequestShape(first)
    await s.auth.onRequestShape(second)
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
    const plain = [Message.user("first"), Message.assistant("reply"), Message.user("next")]
    const untouched = context(SESSION, SIWC, { messages: plain })
    await s.auth.onRequestShape(untouched)
    expect(untouched.messages).toEqual(plain)
    expect(untouched.messages.every((message, at) => message === plain[at])).toBe(true)
    expect(Shape.withoutEffortUpdates(plain)).toEqual(plain)
  })

  test("lowered by the real compiler: no configuration_update item, reasoning.effort is the current variant's", async () => {
    await using s = await setup()
    const shaped = context(SESSION, SIWC, { messages: history() })
    await s.auth.onRequestShape(shaped)
    // Unshaped, GPT-6.1 keeps the marker as the item token sharing refuses, and the frozen top-level effort.
    const before = await body(history(), "high")
    expect(itemTypes(before)).toContain("configuration_update")
    const after = await body(shaped.messages, "high")
    expect(itemTypes(after)).not.toContain("configuration_update")
    expect(after.reasoning).toMatchObject({ effort: "high" })
    // The next variant change only moves the top-level effort; the input items stay the same.
    const max = await body(shaped.messages, "max")
    expect(max.reasoning).toMatchObject({ effort: "max" })
    expect(max.input).toEqual(after.input)
  })
})

describe("sharing_unsupported_input", () => {
  const retry = (model: typeof SIWC, decision: SessionRetry["decision"], body = UNSUPPORTED) =>
    // SAFETY: the fields of a core retry event the hooks read; the error is a provider invalid request.
    ({
      sessionID: SESSION,
      agent: "build",
      model,
      attempt: 2,
      decision,
      error: { type: "provider.invalid-request", message: "This request uses a feature …", response: { body } },
    }) as unknown as SessionRetry

  test("a siwc refusal nothing retries raises a Korean error alert and leaves the decision alone", async () => {
    await using s = await setup()
    const hooks = await registeredHooks(s)
    const event = retry(SIWC, { retry: false })
    await hooks.get("retry")?.(event)
    expect(event.decision).toEqual({ retry: false })
    const alert = s.alerts.find((item) => item.code === "sharing_unsupported_input")
    expect(alert).toMatchObject({
      severity: "error",
      sessionID: SESSION,
      fields: { providerID: "own-siwc-ssss", modelID: "gpt-6.1-sol", param: "input" },
    })
    expect(alert?.message).toBe(
      "이 대화에는 ChatGPT 구독 공유가 지원하지 않는 항목(대화 기록의 입력 항목)이 있습니다. " +
        "다른 계정으로 바꾸거나 이 항목을 빼고 다시 시도하세요.",
    )
  })

  test("no alert for a retried request, another error or another kind", async () => {
    await using s = await setup()
    s.auth.onRetry(retry(SIWC, { retry: true, delay: 0 }))
    s.auth.onRetry(retry(SIWC, { retry: false }, '{"error":{"code":"server_error"}}'))
    s.auth.onRetry(retry(CODEX, { retry: false }))
    s.auth.onRetry(retry(ref("openai", "gpt-6.1-sol"), { retry: false }))
    expect(s.alerts.filter((item) => item.code === "sharing_unsupported_input")).toEqual([])
  })
})

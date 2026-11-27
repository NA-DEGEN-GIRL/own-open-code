import { interrupted, startFake, type FakeOptions, type FakeProvider } from "./fake-server"
import { openAIError } from "./responses-protocol"
import {
  answerOf,
  bearerToken,
  credentialDomain,
  cut,
  estimateTokens,
  isRecord,
  jsonResponse,
  pieces,
  randomId,
  replyHeaders,
  sseResponse,
  timing,
  unsupportedFault,
  type AnswerReply,
  type CacheUsage,
  type Reply,
  type SseEvent,
  type WireMarks,
} from "./shared"

export interface FakeOpenAIChatOptions extends FakeOptions {
  readonly models?: readonly string[]
  /**
   * A local server's native endpoints by `"METHOD /path"` (`"POST /api/show"`, `"GET /props"`): the JSON each answers
   * for the request's JSON body. Authenticated like every other route.
   */
  readonly native?: Readonly<Record<string, (json: unknown) => unknown>>
  /** Extra fields of a model's `/models` entry by id (a local server's `reasoning_efforts`, `max_model_len`). */
  readonly modelFields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** A local server that takes no key (02 §3.3a): a request without one is answered as domain `anonymous`. */
  readonly anonymous?: boolean
}

export interface DeepSeekBalance {
  readonly available: boolean
  readonly currency: "USD" | "CNY"
  readonly total: string
}

export interface FakeOpenAIChat extends FakeProvider {
  /** Balance served by `GET /user/balance` for a credential domain (default: available, 10.00 USD). */
  setBalance(domain: string, balance: DeepSeekBalance): void
}

type ChatBody = Record<string, unknown> & { readonly model: string; readonly messages: readonly unknown[] }

/**
 * OpenAI-compatible chat completions in the DeepSeek dialect (`POST /v1/chat/completions`, streamed).
 * Automatic prefix caching in 64-token units; usage reports `prompt_cache_hit_tokens`,
 * `prompt_cache_miss_tokens` and `prompt_tokens_details.cached_tokens`. Also serves `GET /user/balance`.
 */
export function startFakeOpenAIChat(options: FakeOpenAIChatOptions = {}): FakeOpenAIChat {
  const balances = new Map<string, DeepSeekBalance>()
  const fake = startFake({
    name: "openai-chat",
    basePath: "/v1",
    options,
    defaultCache: { blockTokens: 64, minTokens: 64, ttlMs: 60 * 60_000 },
    async handle(context, internals) {
      const token = bearerToken(context.request.headers)
      const identity =
        token === undefined
          ? options.anonymous
            ? "anonymous"
            : undefined
          : credentialDomain(token, options.credentials)
      if (identity === undefined) {
        const failure = openAIError(
          401,
          "Authentication Fails, Your api key is invalid",
          "invalid_request_error",
          "authentication_error",
        )
        return { response: jsonResponse(failure.status, failure.body) }
      }
      const path = context.url.pathname
      if (context.request.method === "GET" && (path === "/user/balance" || path === "/v1/user/balance")) {
        const balance = balances.get(identity) ?? { available: true, currency: "USD", total: "10.00" }
        return {
          identity,
          response: jsonResponse(200, {
            is_available: balance.available,
            balance_infos: [
              {
                currency: balance.currency,
                total_balance: balance.total,
                granted_balance: "0.00",
                topped_up_balance: balance.total,
              },
            ],
          }),
        }
      }
      if (context.request.method === "GET" && (path === "/v1/models" || path === "/models"))
        return {
          identity,
          response: jsonResponse(200, {
            object: "list",
            data: (options.models ?? ["deepseek-fake"]).map((id) => ({
              id,
              object: "model",
              owned_by: "fake",
              ...options.modelFields?.[id],
            })),
          }),
        }
      const native = options.native?.[`${context.request.method} ${path}`]
      if (native) return { identity, response: jsonResponse(200, native(context.json)) }
      if (context.request.method !== "POST" || (path !== "/v1/chat/completions" && path !== "/chat/completions"))
        return {
          identity,
          response: jsonResponse(404, { error: { message: "Not found", type: "invalid_request_error" } }),
        }
      const parsed = chatBody(context.json)
      if ("error" in parsed) {
        const failure = openAIError(400, parsed.error, "invalid_request_error")
        return { identity, response: jsonResponse(failure.status, failure.body) }
      }
      const body = parsed.body
      const prompt = chatPrompt(body)
      const cache = internals.cache.prefix(`${identity}|${body.model}`, prompt, { write: false })
      const reply = context.reply({ identity, model: body.model, cache })
      const headers = { "x-request-id": randomId("req") }
      const answered = { identity, model: body.model, cache }
      if (reply.type === "error")
        return { ...answered, response: jsonResponse(reply.status, reply.body, { ...headers, ...reply.headers }) }
      if (reply.type === "reset" || reply.type === "delayed-listen")
        return { ...answered, ...interrupted(internals, reply) }
      if (reply.type === "ws-close") return { ...answered, response: unsupportedFault("openai-chat", reply.type) }
      internals.cache.prefix(`${identity}|${body.model}`, prompt)
      const plan = cut(reply, chatEvents(answerOf(reply), body.model, cache), CHAT_MARKS)
      return {
        ...answered,
        ...("reply" in reply ? { fault: reply.type } : {}),
        response: sseResponse(plan.events, {
          headers: { ...headers, ...replyHeaders(reply) },
          ...timing(reply),
          corrupt: plan.corrupt,
          end: plan.end,
          until: plan.until,
        }),
      }
    },
  })
  return {
    ...fake,
    setBalance(domain, balance) {
      balances.set(domain, balance)
    },
  }
}

function chatBody(json: unknown): { readonly body: ChatBody } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Request body must be a JSON object" }
  if (typeof json.model !== "string" || json.model === "") return { error: "Missing required parameter: 'model'" }
  if (!Array.isArray(json.messages)) return { error: "Missing required parameter: 'messages'" }
  if (json.stream !== true) return { error: "This fake only serves streamed completions ('stream': true)" }
  return { body: { ...json, model: json.model, messages: json.messages } }
}

/** Tools then messages, one JSON value per line. */
export function chatPrompt(body: ChatBody) {
  return [JSON.stringify(body.tools ?? []), ...body.messages.map((message) => JSON.stringify(message))].join("\n")
}

/** Chat chunks a wire fault counts (content and tool-call deltas) and `eof` leaves out (the finish chunk, `[DONE]`). */
const CHAT_MARKS: WireMarks<SseEvent> = {
  delta: (event) => {
    const delta = choiceOf(event)?.delta
    return isRecord(delta) && ((typeof delta.content === "string" && delta.content !== "") || "tool_calls" in delta)
  },
  terminal: (event) => event.data === "[DONE]" || typeof choiceOf(event)?.finish_reason === "string",
}

function choiceOf(event: SseEvent) {
  const choices = isRecord(event.data) && Array.isArray(event.data.choices) ? event.data.choices : []
  const first: unknown = choices[0]
  return isRecord(first) ? first : undefined
}

function chatEvents(
  reply: AnswerReply | Extract<Reply, { readonly type: "stream-error" }>,
  model: string,
  cache: CacheUsage,
): SseEvent[] {
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    data: {
      id: "chatcmpl-" + crypto.randomUUID(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, logprobs: null, ...choice }],
      ...extra,
    },
  })
  const opening = chunk({ delta: { role: "assistant", content: "" }, finish_reason: null })
  if (reply.type === "stream-error") return [opening, { data: { error: reply.error } }]
  const text = reply.type === "text"
  const completion = text
    ? (reply.outputTokens ?? Math.max(1, estimateTokens(reply.text)))
    : Math.max(1, estimateTokens(JSON.stringify(reply.input)))
  const deltas = text
    ? pieces(reply.text, reply.deltas).map((content) => ({ content }))
    : [
        {
          tool_calls: [
            {
              index: 0,
              id: reply.id ?? randomId("call"),
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.input) },
            },
          ],
        },
      ]
  return [
    opening,
    ...deltas.map((delta) => chunk({ delta, finish_reason: null })),
    chunk(
      { delta: {}, finish_reason: text ? "stop" : "tool_calls" },
      {
        usage: {
          prompt_tokens: cache.promptTokens,
          completion_tokens: completion,
          total_tokens: cache.promptTokens + completion,
          prompt_tokens_details: { cached_tokens: cache.cachedTokens },
          prompt_cache_hit_tokens: cache.cachedTokens,
          prompt_cache_miss_tokens: cache.promptTokens - cache.cachedTokens,
        },
      },
    ),
    { data: "[DONE]" },
  ]
}

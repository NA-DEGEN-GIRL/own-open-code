import { startFake, type FakeOptions, type FakeProvider } from "./fake-server"
import type { BreakpointUsage, CacheBlock } from "./prompt-cache"
import {
  bearerToken,
  credentialDomain,
  estimateTokens,
  isRecord,
  jsonResponse,
  randomId,
  sseResponse,
  timing,
  type Clock,
  type Reply,
  type SseEvent,
} from "./shared"

export interface FakeAnthropicOptions extends FakeOptions {
  readonly models?: readonly string[]
  /** A local server that takes no key (02 §3.3a): a request without one is answered as domain `anonymous`. */
  readonly anonymous?: boolean
  /**
   * 02 §4.8: the `usage.speed` a response names for a request's `speed` (`undefined` = none asked). By default the
   * requested speed is echoed (served); answer `standard` for a silent downgrade.
   */
  readonly servedSpeed?: (requested: string | undefined) => string | undefined
  /** Per-domain limits per minute, reported with `anthropic-ratelimit-*` headers. */
  readonly rateLimits?: { readonly requests?: number; readonly inputTokens?: number; readonly outputTokens?: number }
}

/** Claude subscription (`anthropic-ratelimit-unified-*`) state for one credential domain. */
export interface UnifiedLimits {
  readonly status: "allowed" | "allowed_warning" | "rejected"
  /** 0..1. Absent (with its reset): a verified Ultra account without a five-hour window (02 §7.1.2), no `5h-*` header. */
  readonly fiveHourUtilization?: number
  readonly sevenDayUtilization: number
  /** Epoch seconds. */
  readonly fiveHourReset?: number
  readonly sevenDayReset: number
  readonly representativeClaim?: "five_hour" | "seven_day"
}

export interface FakeAnthropic extends FakeProvider {
  /** Adds unified subscription headers for a domain; `rejected` answers 429 `rate_limit_error`. */
  setUnified(domain: string, limits: UnifiedLimits | undefined): void
}

type MessagesBody = Record<string, unknown> & {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly max_tokens: number
}

/**
 * Anthropic Messages API (`POST /v1/messages`, streamed). Caching follows explicit `cache_control`
 * breakpoints (max 4, `ttl` 5m/1h, 20-block lookback); usage reports `cache_read_input_tokens`,
 * `cache_creation_input_tokens` and the 5m/1h split. Credentials: `x-api-key` or OAuth bearer.
 */
export function startFakeAnthropic(options: FakeAnthropicOptions = {}): FakeAnthropic {
  const unified = new Map<string, UnifiedLimits>()
  const windows = new Map<string, { start: number; requests: number; input: number; output: number }>()
  const fake = startFake({
    name: "anthropic",
    basePath: "/v1",
    options,
    defaultCache: { minTokens: 1024 },
    async handle(context, internals) {
      const credential = context.request.headers.get("x-api-key") ?? bearerToken(context.request.headers)
      const identity =
        credential === null || credential === undefined
          ? options.anonymous
            ? "anonymous"
            : undefined
          : credentialDomain(credential, options.credentials)
      if (identity === undefined) return { response: error(401, "authentication_error", "invalid x-api-key") }
      if (context.request.method === "GET" && context.url.pathname === "/v1/models")
        return {
          identity,
          response: jsonResponse(200, {
            data: (options.models ?? ["claude-fake"]).map((id) => ({ type: "model", id, display_name: id })),
            has_more: false,
          }),
        }
      if (context.request.method !== "POST" || context.url.pathname !== "/v1/messages")
        return { identity, response: error(404, "not_found_error", "Not found") }
      if (!context.request.headers.get("anthropic-version"))
        return { identity, response: error(400, "invalid_request_error", "anthropic-version: header is required") }
      const parsed = messagesBody(context.json)
      if ("error" in parsed) return { identity, response: error(400, "invalid_request_error", parsed.error) }
      const body = parsed.body
      const blocks = cacheBlocks(body)
      const invalid = invalidBreakpoints(blocks)
      if (invalid) return { identity, model: body.model, response: error(400, "invalid_request_error", invalid) }
      const cache = internals.cache.breakpoints(`${identity}|${body.model}`, blocks, { write: false })
      const limits = unified.get(identity)
      const headers = {
        "request-id": randomId("req"),
        ...rateLimitHeaders(identity, cache.promptTokens, internals.clock),
        ...(limits ? unifiedHeaders(limits) : {}),
      }
      if (limits?.status === "rejected")
        return {
          identity,
          model: body.model,
          cache,
          response: error(429, "rate_limit_error", "This request would exceed your account's rate limit.", headers),
        }
      const reply = context.reply({ identity, model: body.model, cache })
      if (reply.type === "error")
        return {
          identity,
          model: body.model,
          cache,
          response: jsonResponse(reply.status, reply.body, { ...headers, ...reply.headers }),
        }
      // Wire faults (P1-9b) are simulated by the OpenAI-family fakes only.
      if (reply.type !== "text" && reply.type !== "tool-call" && reply.type !== "stream-error")
        return {
          identity,
          model: body.model,
          cache,
          response: error(
            501,
            "not_supported_error",
            `The anthropic fake does not simulate the wire fault '${reply.type}'.`,
          ),
        }
      internals.cache.breakpoints(`${identity}|${body.model}`, blocks)
      return {
        identity,
        model: body.model,
        cache,
        response: sseResponse(messagesEvents(reply, body.model, cache, speedOf(body, options)), {
          headers: { ...headers, ...(reply.type === "stream-error" ? {} : reply.headers) },
          ...timing(reply),
        }),
      }
    },
  })

  const rateLimitHeaders = (identity: string, inputTokens: number, clock: Clock) => {
    const now = clock.now()
    const existing = windows.get(identity)
    const window =
      existing && now - existing.start < 60_000 ? existing : { start: now, requests: 0, input: 0, output: 0 }
    windows.set(identity, window)
    window.requests += 1
    window.input += inputTokens
    const reset = new Date(window.start + 60_000).toISOString()
    const limit = {
      requests: options.rateLimits?.requests ?? 4000,
      input: options.rateLimits?.inputTokens ?? 2_000_000,
      output: options.rateLimits?.outputTokens ?? 400_000,
    }
    return {
      "anthropic-ratelimit-requests-limit": String(limit.requests),
      "anthropic-ratelimit-requests-remaining": String(Math.max(0, limit.requests - window.requests)),
      "anthropic-ratelimit-requests-reset": reset,
      "anthropic-ratelimit-input-tokens-limit": String(limit.input),
      "anthropic-ratelimit-input-tokens-remaining": String(Math.max(0, limit.input - window.input)),
      "anthropic-ratelimit-input-tokens-reset": reset,
      "anthropic-ratelimit-output-tokens-limit": String(limit.output),
      "anthropic-ratelimit-output-tokens-remaining": String(Math.max(0, limit.output - window.output)),
      "anthropic-ratelimit-output-tokens-reset": reset,
      "anthropic-ratelimit-tokens-limit": String(limit.input + limit.output),
      "anthropic-ratelimit-tokens-remaining": String(
        Math.max(0, limit.input + limit.output - window.input - window.output),
      ),
      "anthropic-ratelimit-tokens-reset": reset,
    }
  }

  return {
    ...fake,
    setUnified(domain, limits) {
      if (limits === undefined) unified.delete(domain)
      if (limits !== undefined) unified.set(domain, limits)
    },
  }
}

export function unifiedHeaders(limits: UnifiedLimits) {
  return {
    "anthropic-ratelimit-unified-status": limits.status,
    ...(limits.fiveHourUtilization === undefined
      ? {}
      : {
          "anthropic-ratelimit-unified-5h-status": limits.fiveHourUtilization >= 1 ? "rejected" : "allowed",
          "anthropic-ratelimit-unified-5h-utilization": String(limits.fiveHourUtilization),
          "anthropic-ratelimit-unified-5h-reset": String(limits.fiveHourReset),
        }),
    "anthropic-ratelimit-unified-7d-status": limits.sevenDayUtilization >= 1 ? "rejected" : "allowed",
    "anthropic-ratelimit-unified-7d-utilization": String(limits.sevenDayUtilization),
    "anthropic-ratelimit-unified-7d-reset": String(limits.sevenDayReset),
    "anthropic-ratelimit-unified-representative-claim":
      limits.representativeClaim ?? (limits.fiveHourUtilization === undefined ? "seven_day" : "five_hour"),
    "anthropic-ratelimit-unified-overage-status": "rejected",
  }
}

function messagesBody(json: unknown): { readonly body: MessagesBody } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Request body must be a JSON object" }
  if (typeof json.model !== "string" || json.model === "") return { error: "model: Field required" }
  if (!Array.isArray(json.messages)) return { error: "messages: Field required" }
  if (typeof json.max_tokens !== "number") return { error: "max_tokens: Field required" }
  if (json.stream !== true) return { error: "This fake only serves streamed messages ('stream': true)" }
  return { body: { ...json, model: json.model, messages: json.messages, max_tokens: json.max_tokens } }
}

/** Tools, then system blocks, then message content blocks, in prompt order. */
export function cacheBlocks(body: MessagesBody): CacheBlock[] {
  const system =
    typeof body.system === "string"
      ? [{ type: "text", text: body.system }]
      : Array.isArray(body.system)
        ? body.system
        : []
  const messages = body.messages
    .filter(isRecord)
    .flatMap((message) =>
      (typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : []
      ).map((block: unknown) => ({ role: message.role, block })),
    )
  return [
    ...(Array.isArray(body.tools) ? body.tools : []).map((tool: unknown) => cacheBlock(tool)),
    ...system.map((block: unknown) => cacheBlock(block)),
    ...messages.map((item) => cacheBlock(item.block, item.role)),
  ]
}

function cacheBlock(block: unknown, role?: unknown): CacheBlock {
  if (!isRecord(block)) return { text: JSON.stringify([role, block]) }
  const { cache_control: control, ...content } = block
  return {
    text: JSON.stringify(role === undefined ? content : [role, content]),
    breakpoint: isRecord(control) ? (control.ttl === "1h" ? "1h" : "5m") : undefined,
  }
}

/** Mirrors the API's 400s: at most 4 breakpoints, and a 1h breakpoint may not follow a 5m one. */
function invalidBreakpoints(blocks: readonly CacheBlock[]) {
  const ttls = blocks.flatMap((block) => (block.breakpoint ? [block.breakpoint] : []))
  if (ttls.length > 4) return `A maximum of 4 blocks with cache_control may be provided. Found ${ttls.length}.`
  if (ttls.some((ttl, index) => ttl === "1h" && ttls.slice(0, index).includes("5m")))
    return "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block."
  return undefined
}

/** The speed a response names (02 §4.8): `servedSpeed`, else the request's `speed`; none when it asked for none. */
function speedOf(body: Readonly<Record<string, unknown>>, options: FakeAnthropicOptions) {
  const requested = typeof body.speed === "string" ? body.speed : undefined
  return options.servedSpeed ? options.servedSpeed(requested) : requested
}

function messagesEvents(
  reply: Extract<Reply, { readonly type: "text" | "tool-call" | "stream-error" }>,
  model: string,
  cache: BreakpointUsage,
  speed?: string,
): SseEvent[] {
  const usage = {
    input_tokens: cache.promptTokens - cache.cachedTokens - cache.writtenTokens,
    cache_creation_input_tokens: cache.writtenTokens,
    cache_read_input_tokens: cache.cachedTokens,
    cache_creation: { ephemeral_5m_input_tokens: cache.written5m, ephemeral_1h_input_tokens: cache.written1h },
    ...(speed === undefined ? {} : { speed }),
  }
  const start: SseEvent = {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: randomId("msg"),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
  }
  if (reply.type === "stream-error") return [start, { event: "error", data: { type: "error", error: reply.error } }]
  const text = reply.type === "text"
  const outputTokens = text
    ? (reply.outputTokens ?? Math.max(1, estimateTokens(reply.text)))
    : Math.max(1, estimateTokens(JSON.stringify(reply.input)))
  return [
    start,
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: text
          ? { type: "text", text: "" }
          : { type: "tool_use", id: reply.id ?? randomId("toolu"), name: reply.name, input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: text
          ? { type: "text_delta", text: reply.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: text ? "end_turn" : "tool_use", stop_sequence: null },
        usage: { ...usage, output_tokens: outputTokens },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]
}

function error(status: number, type: string, message: string, headers?: Readonly<Record<string, string>>) {
  return jsonResponse(status, { type: "error", error: { type, message } }, headers)
}

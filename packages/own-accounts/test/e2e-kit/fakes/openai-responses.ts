import { interrupted, startFake, type FakeOptions, type FakeProvider } from "./fake-server"
import { openAIError, responsesBody, responsesPrompt, responsesSse } from "./responses-protocol"
import {
  bearerToken,
  credentialDomain,
  jsonResponse,
  randomId,
  unsupportedFault,
  type Clock,
  type Reply,
} from "./shared"

export interface FakeOpenAIResponsesOptions extends FakeOptions {
  /** Ids served by `GET /v1/models`. */
  readonly models?: readonly string[]
  /** A local server that takes no key (02 §3.3a): a request without one is answered as domain `anonymous`. */
  readonly anonymous?: boolean
  /**
   * Sign in with ChatGPT account catalog: `GET /v1/models` answers `{models:[…]}` with these entries (as given, so a
   * test can include malformed ones) instead of the API key list.
   */
  readonly sharingModels?: readonly unknown[]
  /** Per-domain limits per minute, reported through `x-ratelimit-*` headers; exceeding one returns 429. */
  readonly rateLimits?: { readonly requests?: number; readonly tokens?: number }
  /**
   * The `service_tier` every answer names whatever was asked (02 §4.8). The ChatGPT plan routes say `default`: token
   * sharing did so (or named none) for the Ultrafast and Fast requests of the user's sessions (2026-10-10 to 10-22).
   */
  readonly servedTier?: string
}

export type FakeOpenAIResponses = FakeProvider

/**
 * OpenAI Responses API (`POST /v1/responses`, streamed). Cache domain = credential domain + model;
 * usage reports `input_tokens_details.cached_tokens`.
 */
export function startFakeOpenAIResponses(options: FakeOpenAIResponsesOptions = {}): FakeOpenAIResponses {
  const limits = rateLimiter(options.rateLimits ?? {})
  return startFake({
    name: "openai-responses",
    basePath: "/v1",
    options,
    defaultCache: { blockTokens: 128, minTokens: 1024, ttlMs: 10 * 60_000 },
    async handle(context, fake) {
      const token = bearerToken(context.request.headers)
      const identity =
        token === undefined ? (options.anonymous ? "anonymous" : undefined) : credentialDomain(token, options.credentials)
      if (identity === undefined) {
        const error = openAIError(401, "Incorrect API key provided.", "invalid_api_key")
        return { response: jsonResponse(error.status, error.body), identity }
      }
      if (context.request.method === "GET" && context.url.pathname === "/v1/models" && options.sharingModels)
        return { identity, response: jsonResponse(200, { models: options.sharingModels }) }
      if (context.request.method === "GET" && context.url.pathname === "/v1/models")
        return {
          identity,
          response: jsonResponse(200, {
            object: "list",
            data: (options.models ?? ["gpt-fake"]).map((id) => ({ id, object: "model", owned_by: "fake" })),
          }),
        }
      if (context.request.method !== "POST" || context.url.pathname !== "/v1/responses")
        return {
          identity,
          response: jsonResponse(404, { error: { message: "Not found", type: "invalid_request_error" } }),
        }
      const parsed = responsesBody(context.json)
      if ("error" in parsed) {
        const error = openAIError(400, parsed.error, "invalid_request")
        return { identity, response: jsonResponse(error.status, error.body) }
      }
      const body = parsed.body
      const prompt = responsesPrompt(body)
      const cache = fake.cache.prefix(`${identity}|${body.model}`, prompt, { write: false })
      const headers = {
        "x-request-id": randomId("req"),
        ...(options.credentials?.[token ?? ""] ? { "openai-organization": identity } : {}),
        ...limits.headers(identity, cache.promptTokens, fake.clock),
      }
      if (limits.exceeded(identity, fake.clock)) {
        const error = openAIError(429, "Rate limit reached for requests.", "rate_limit_exceeded", "requests")
        return { identity, model: body.model, cache, response: jsonResponse(error.status, error.body, headers) }
      }
      const reply = context.reply({ identity, model: body.model, cache })
      const answered = { identity, model: body.model, cache }
      if (reply.type === "error")
        return { ...answered, response: jsonResponse(reply.status, reply.body, { ...headers, ...reply.headers }) }
      if (reply.type === "reset" || reply.type === "delayed-listen") return { ...answered, ...interrupted(fake, reply) }
      if (reply.type === "ws-close") return { ...answered, response: unsupportedFault("openai-responses", reply.type) }
      fake.cache.prefix(`${identity}|${body.model}`, prompt)
      return {
        ...answered,
        ...("reply" in reply ? { fault: reply.type } : {}),
        response: responsesSse(reply, {
          model: body.model,
          usage: cache,
          headers,
          ...(options.servedTier === undefined ? {} : { serviceTier: options.servedTier }),
        }),
      }
    },
  })
}

/** HTTP status of each Sign in with ChatGPT error code (OpenAI token-sharing docs, errors and recovery). */
export const SHARING_ERROR_STATUS: Readonly<Record<string, number>> = {
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
  subscription_sharing_user_unavailable: 503,
}

/** A token-sharing error reply: the code's HTTP status and an OpenAI error body, or a `response.failed` stream. */
export function sharingError(
  code: string,
  options: { readonly stream?: boolean; readonly param?: string } = {},
): Reply {
  const error = { message: `Fake token-sharing failure (${code}).`, type: "invalid_request_error", code }
  if (options.stream) return { type: "stream-error", error }
  return {
    type: "error",
    status: SHARING_ERROR_STATUS[code] ?? 400,
    body: { error: { ...error, param: options.param ?? null } },
  }
}

/** Fixed one-minute windows per domain, reported with OpenAI's `x-ratelimit-*` header family. */
export function rateLimiter(limits: { readonly requests?: number; readonly tokens?: number }) {
  const windows = new Map<string, { start: number; requests: number; tokens: number }>()
  const requestLimit = limits.requests ?? 10_000
  const tokenLimit = limits.tokens ?? 10_000_000
  const current = (identity: string, clock: Clock) => {
    const now = clock.now()
    const existing = windows.get(identity)
    if (existing && now - existing.start < 60_000) return existing
    const fresh = { start: now, requests: 0, tokens: 0 }
    windows.set(identity, fresh)
    return fresh
  }
  return {
    headers(identity: string, tokens: number, clock: Clock) {
      const window = current(identity, clock)
      window.requests += 1
      window.tokens += tokens
      const reset = duration(window.start + 60_000 - clock.now())
      return {
        "x-ratelimit-limit-requests": String(requestLimit),
        "x-ratelimit-remaining-requests": String(Math.max(0, requestLimit - window.requests)),
        "x-ratelimit-reset-requests": reset,
        "x-ratelimit-limit-tokens": String(tokenLimit),
        "x-ratelimit-remaining-tokens": String(Math.max(0, tokenLimit - window.tokens)),
        "x-ratelimit-reset-tokens": reset,
      }
    },
    exceeded(identity: string, clock: Clock) {
      const window = current(identity, clock)
      return window.requests > requestLimit || window.tokens > tokenLimit
    },
  }
}

/** Formats milliseconds the way OpenAI reports resets: `120ms`, `7s`, `6m0s`. */
function duration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = Math.ceil(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

import type { ServerWebSocket } from "bun"
import { chatGPTAccount, mintChatGPTTokens, type ChatGPTAccount, type ChatGPTTokens } from "../fixtures/chatgpt-tokens"
import { interrupted, startFake, type FakeInternals, type FakeOptions, type FakeProvider } from "./fake-server"
import {
  RESPONSES_MARKS,
  responsesBody,
  responsesEvents,
  responsesPrompt,
  responsesSse,
  type ResponsesBody,
} from "./responses-protocol"
import {
  answerOf,
  bearerToken,
  corrupted,
  cut,
  hashSecret,
  isRecord,
  jsonResponse,
  parseJson,
  recordHeaders,
  settle,
  sha256,
  sseResponse,
  stringField,
  timing,
  unsupportedFault,
} from "./shared"

export interface FakeCodexOptions extends Omit<FakeOptions, "credentials"> {
  /** Accounts registered at start; tokens for them come from `login()`. */
  readonly accounts?: readonly (Partial<ChatGPTAccount> & { readonly accountID: string })[]
  /** Access token lifetime (default 1 hour). */
  readonly accessTokenTtlMs?: number
  /** Percentage points each model request adds to the windows (default primary 1, secondary 0.1). */
  readonly usagePerRequest?: { readonly primary?: number; readonly secondary?: number }
  readonly windowMinutes?: { readonly primary?: number; readonly secondary?: number }
  /** Model ids the account may use; others get 400. Undefined allows every model. */
  readonly models?: readonly string[]
  /** Reject requests without `chatgpt-account-id` (default true), as the Codex backend does. */
  readonly requireAccountHeader?: boolean
  /** Reusing a refresh token revokes its whole family (default true), forcing a re-login. */
  readonly revokeFamilyOnReuse?: boolean
  /**
   * 02 §4.8: the `service_tier` a response names (every event) for the one a request asked for (`undefined` = none
   * asked). By default the fake answers as the real backend does (live, 2026-10-18): `auto` in `response.created` and
   * `default` in `response.completed`, whatever was asked and served.
   */
  readonly servedTier?: (requested: string | undefined) => string | undefined
  /**
   * A plan with one weekly window, as the real `promax` plan on 2026-10-18: the primary family is the 10080-minute
   * window, the secondary family is empty (headers `0`, `0`, `""`, `0`; frame and usage `secondary: null`).
   */
  readonly weeklyOnly?: boolean
  /**
   * Raw Responses events for an HTTP request (own's ChatGPT web search answers with hosted `web_search_call` items, which
   * no scripted reply can express): when it returns events, they are streamed as they are, after the usage charge and
   * with the usage headers, instead of the next reply.
   */
  readonly events?: (body: ResponsesBody) => readonly Record<string, unknown>[] | undefined
  /**
   * The Codex model list (`GET /backend-api/codex/models`, 07 §4.5): the body for the asking `client_version` (the
   * backend lists only the rows that version may see) and account, with an etag per version (a 304 for it). Without
   * it the list answers 404, as before, and own keeps the metadata it has.
   */
  readonly modelList?: (clientVersion: string | undefined, accountID: string) => unknown
  /** Serve `POST /backend-api/codex/images/{generations,edits}` with this base64 image (02 §9.6). */
  readonly images?: string
}

export interface CodexUsage {
  primary: number
  secondary: number
  primaryResetAt: number
  secondaryResetAt: number
}

/** One usage-limit reset credit as `GET /backend-api/wham/rate-limit-reset-credits` lists it (codex-rs shape, 02 §7.1.1). */
export interface FakeResetCredit {
  readonly id: string
  readonly reset_type?: string
  /** `available` unless set; a redeemed one turns `redeemed` and leaves the count. */
  status?: string
  readonly granted_at: string
  readonly expires_at?: string | null
  readonly title?: string
  readonly description?: string
}

/**
 * How the next `POST …/rate-limit-reset-credits/consume` of an account answers (`scriptConsume`). `auto` (the default
 * when nothing is scripted) is the backend's judgement: `no_credit` without an available credit (or the picked one),
 * `nothing_to_reset` while no window is used, else `reset` (the credit leaves the count, both windows go to 0%).
 * `error` answers 500 without redeeming; `delayMs` redeems as `then` (default `auto`) and answers that much later.
 */
export type ConsumeScript = ConsumeOutcome | "error" | { readonly delayMs: number; readonly then?: ConsumeOutcome }
export type ConsumeOutcome = "auto" | "reset" | "nothing_to_reset" | "no_credit"

export type RefreshResult =
  | { readonly type: "ok"; readonly tokens: ChatGPTTokens }
  | { readonly type: "error"; readonly status: number; readonly code: string; readonly message: string }

export interface FakeCodex extends FakeProvider {
  /** `wss`-style URL of the Responses WebSocket (`ws://…/backend-api/codex/responses`). */
  readonly websocketURL: string
  /** OAuth token endpoint accepting `grant_type=refresh_token` (form or JSON). */
  readonly tokenURL: string
  /** Registers the account if needed and mints a new token family, like a fresh login. */
  login(account: Partial<ChatGPTAccount> & { readonly accountID: string }): ChatGPTTokens
  /** Rotates a refresh token exactly like `POST /oauth/token`, without an HTTP round trip. */
  refresh(refreshToken: string): RefreshResult
  /** Number of successful refreshes per account (single-refresher assertions, AC-P20). */
  refreshCount(accountID: string): number
  usage(accountID: string): CodexUsage
  setUsage(accountID: string, usage: Partial<CodexUsage>): void
  /** Accounts that read `GET /backend-api/wham/usage`, in order (left out of `requests`). */
  readonly usagePolls: readonly string[]
  /**
   * 02 §7.1.1: the account's reset credits. `wham/usage` then carries `rate_limit_reset_credits`
   * (`{available_count, applicable_available_count}`); `null` sends `rate_limit_reset_credits: null`. Unset: no field.
   */
  setResetCredits(accountID: string, credits: readonly FakeResetCredit[] | null, applicable?: number): void
  /** The account's credits now (statuses included), `undefined` when none were set. */
  resetCredits(accountID: string): readonly FakeResetCredit[] | undefined
  /** Queues how the account's next consume calls answer, in order (then `auto`). */
  scriptConsume(accountID: string, ...scripts: ConsumeScript[]): void
  /** Accounts that read `GET /backend-api/wham/rate-limit-reset-credits`, in order (left out of `requests`). */
  readonly resetCreditReads: readonly string[]
  /** Every `POST …/consume`, in order, with its parsed body (left out of `requests`). */
  readonly consumes: readonly {
    readonly accountID: string
    readonly body: unknown
    /** Request headers, secrets hashed (`recordHeaders`). */
    readonly headers: Readonly<Record<string, string>>
  }[]
  /** Reads of the model list (`modelList`), in order, with the `client_version` each asked (left out of `requests`). */
  readonly modelListReads: readonly { readonly accountID: string; readonly clientVersion: string | undefined }[]
  /** Image generations and edits (`images`), in order, with the parsed body. */
  readonly imageCalls: readonly { readonly accountID: string; readonly path: string; readonly body: unknown }[]
}

interface Family {
  readonly accountID: string
  revoked: boolean
}

interface Socket {
  readonly identity: string
  readonly accountID: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/**
 * ChatGPT Codex backend (`/backend-api/codex/responses`, SSE and WebSocket) plus its OAuth refresh
 * endpoint and the usage read `GET /backend-api/wham/usage`. The cache and rate-limit domain is the ChatGPT account,
 * so refreshed tokens keep the cache. Limit data has the real backend's shapes (live, 2026-10-18): every HTTP answer
 * carries the `x-codex-*` header set; WebSocket turns start with a `codex.rate_limits` frame and a
 * `codex.response.metadata` frame; responses name `service_tier` `auto`, then `default`. Exhausted windows answer 429
 * `usage_limit_reached` (shape approximated).
 */
export function startFakeCodex(options: FakeCodexOptions = {}): FakeCodex {
  const accounts = new Map<string, ChatGPTAccount>()
  const families = new Map<string, Family>()
  const accessTokens = new Map<string, { readonly family: string; readonly expiresAt: number }>()
  const refreshTokens = new Map<string, { readonly family: string; used: boolean }>()
  const refreshes = new Map<string, number>()
  const usageState = new Map<string, CodexUsage>()
  const accessTtl = options.accessTokenTtlMs ?? 60 * 60_000
  const windows = {
    primary: (options.windowMinutes?.primary ?? (options.weeklyOnly ? 10_080 : 300)) * 60_000,
    secondary: (options.windowMinutes?.secondary ?? 10_080) * 60_000,
  }
  const usagePolls: string[] = []
  const resetCredits = new Map<string, { credits: FakeResetCredit[] | null; applicable?: number }>()
  const consumeScripts = new Map<string, ConsumeScript[]>()
  /** `redeem_request_id`s that redeemed: a repeat is `already_redeemed`. */
  const redeemed = new Set<string>()
  const resetCreditReads: string[] = []
  const consumes: { accountID: string; body: unknown; headers: Readonly<Record<string, string>> }[] = []
  const modelListReads: { accountID: string; clientVersion: string | undefined }[] = []
  const imageCalls: { accountID: string; path: string; body: unknown }[] = []

  const fake: FakeProvider & FakeInternals = startFake<Socket>({
    name: "codex",
    basePath: "/backend-api/codex",
    options,
    defaultCache: { blockTokens: 128, minTokens: 1024, ttlMs: 10 * 60_000 },
    // Refresh tokens are fake, but recordings still never carry credential values.
    redactBody: (url, body) =>
      url.pathname === "/oauth/token"
        ? body.replace(
            /(refresh_token"?\s*[:=]\s*"?)([^"&\s]+)/g,
            (_match, key: string, value: string) => key + hashSecret(value),
          )
        : body,
    async handle(context) {
      if (context.request.method === "POST" && context.url.pathname === "/oauth/token") {
        const result = refresh(refreshTokenOf(context.body, context.request.headers.get("content-type")))
        if (result.type === "error")
          return {
            response: jsonResponse(result.status, {
              error: { code: result.code, message: result.message, type: "invalid_request_error" },
            }),
          }
        return {
          identity: `codex:${result.tokens.accountID}`,
          response: jsonResponse(200, {
            access_token: result.tokens.accessToken,
            refresh_token: result.tokens.refreshToken,
            id_token: result.tokens.idToken,
            token_type: "Bearer",
            expires_in: Math.round(accessTtl / 1000),
            scope: "openid profile email offline_access",
          }),
        }
      }
      if (context.request.method === "GET" && context.url.pathname === "/backend-api/wham/usage") {
        const auth = authenticate(context.request.headers)
        if (auth.type === "error")
          return { unrecorded: true, response: jsonResponse(auth.status, { detail: auth.message }) }
        usagePolls.push(auth.accountID)
        return { unrecorded: true, identity: auth.identity, response: jsonResponse(200, usageBody(auth.accountID)) }
      }
      if (context.request.method === "GET" && context.url.pathname === "/backend-api/wham/rate-limit-reset-credits") {
        const auth = authenticate(context.request.headers)
        if (auth.type === "error")
          return { unrecorded: true, response: jsonResponse(auth.status, { detail: auth.message }) }
        resetCreditReads.push(auth.accountID)
        return { unrecorded: true, identity: auth.identity, response: jsonResponse(200, creditList(auth.accountID)) }
      }
      if (
        context.request.method === "POST" &&
        context.url.pathname === "/backend-api/wham/rate-limit-reset-credits/consume"
      ) {
        const auth = authenticate(context.request.headers)
        if (auth.type === "error")
          return { unrecorded: true, response: jsonResponse(auth.status, { detail: auth.message }) }
        consumes.push({
          accountID: auth.accountID,
          body: context.json,
          headers: recordHeaders(context.request.headers),
        })
        return {
          unrecorded: true,
          identity: auth.identity,
          response: await consumeAnswer(auth.accountID, context.json),
        }
      }
      if (options.modelList && context.request.method === "GET" && context.url.pathname === "/backend-api/codex/models") {
        const auth = authenticate(context.request.headers)
        if (auth.type === "error")
          return { unrecorded: true, response: jsonResponse(auth.status, { detail: auth.message }) }
        const clientVersion = context.url.searchParams.get("client_version") ?? undefined
        modelListReads.push({ accountID: auth.accountID, clientVersion })
        const etag = `W/"models-${clientVersion ?? "none"}"`
        if (context.request.headers.get("if-none-match") === etag)
          return { unrecorded: true, identity: auth.identity, response: new Response(null, { status: 304, headers: { etag } }) }
        const list = options.modelList(clientVersion, auth.accountID)
        return { unrecorded: true, identity: auth.identity, response: jsonResponse(200, list, { etag }) }
      }
      // Codex's image generation (`codex-rs/ext/image-generation`, 02 §9.6): one image per call, charged to the
      // account's usage like a request, answered with the usage headers.
      if (
        options.images &&
        context.request.method === "POST" &&
        /^\/backend-api\/codex\/images\/(generations|edits)$/.test(context.url.pathname)
      ) {
        const auth = authenticate(context.request.headers)
        if (auth.type === "error") return { response: jsonResponse(auth.status, { detail: auth.message }) }
        imageCalls.push({ accountID: auth.accountID, path: context.url.pathname, body: context.json })
        consume(auth.accountID)
        return {
          identity: auth.identity,
          response: jsonResponse(
            200,
            { created: 1, data: [{ b64_json: options.images }], output_format: "png", quality: "medium", size: "1024x1024" },
            limitHeaders(auth.accountID),
          ),
        }
      }
      if (context.url.pathname !== "/backend-api/codex/responses")
        return { response: jsonResponse(404, { detail: "Not Found" }) }
      const auth = authenticate(context.request.headers)
      if (auth.type === "error") return { response: jsonResponse(auth.status, { detail: auth.message }) }
      if (context.request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const data: Socket = {
          identity: auth.identity,
          accountID: auth.accountID,
          path: context.url.pathname + context.url.search,
          headers: recordHeaders(context.request.headers),
        }
        fake.record({
          transport: "websocket",
          method: "GET",
          path: data.path,
          headers: data.headers,
          identity: auth.identity,
          body: "",
          bodyHash: sha256(""),
          json: undefined,
          model: undefined,
          cache: undefined,
          status: 101,
          responseHeaders: {},
        })
        if (context.server.upgrade(context.request, { data })) return undefined
        return { identity: auth.identity, response: jsonResponse(400, { detail: "WebSocket upgrade failed" }) }
      }
      if (context.request.method !== "POST") return { response: jsonResponse(405, { detail: "Method Not Allowed" }) }
      const parsed = responsesBody(context.json)
      if ("error" in parsed) return { identity: auth.identity, response: jsonResponse(400, { detail: parsed.error }) }
      const body = parsed.body
      if (options.models && !options.models.includes(body.model))
        return {
          identity: auth.identity,
          model: body.model,
          response: jsonResponse(400, {
            detail: `The '${body.model}' model is not supported when using Codex with a ChatGPT account.`,
          }),
        }
      const prompt = responsesPrompt(body)
      const cache = fake.cache.prefix(`${auth.identity}|${body.model}`, prompt, { write: false })
      const turn = consume(auth.accountID)
      const headers = {
        ...limitHeaders(auth.accountID),
        ...(turn.exhausted ? { "x-codex-rate-limit-reached-type": turn.exhausted } : {}),
      }
      if (turn.exhausted)
        return {
          identity: auth.identity,
          model: body.model,
          cache,
          response: jsonResponse(429, exhaustedBody(auth.accountID, turn.exhausted), headers),
        }
      const answered = { identity: auth.identity, model: body.model, cache }
      const events = options.events?.(body)
      if (events)
        return {
          ...answered,
          response: sseResponse(
            events.map((event) => ({ event: String(event.type), data: event })),
            { headers },
          ),
        }
      const reply = context.reply({ identity: auth.identity, model: body.model, cache })
      if (reply.type === "error")
        return { ...answered, response: jsonResponse(reply.status, reply.body, { ...headers, ...reply.headers }) }
      if (reply.type === "reset" || reply.type === "delayed-listen") return { ...answered, ...interrupted(fake, reply) }
      if (reply.type === "ws-close") return { ...answered, response: unsupportedFault("codex HTTP", reply.type) }
      fake.cache.prefix(`${auth.identity}|${body.model}`, prompt)
      return {
        ...answered,
        ...("reply" in reply ? { fault: reply.type } : {}),
        response: responsesSse(reply, { model: body.model, usage: cache, headers, ...served(body) }),
      }
    },
    websocket: {
      async message(socket, message) {
        await onFrame(socket, typeof message === "string" ? message : new TextDecoder().decode(message))
      },
    },
  })

  const onFrame = async (socket: ServerWebSocket<Socket>, frame: string) => {
    const json = parseJson(frame)
    const base = {
      transport: "websocket" as const,
      method: "WS",
      path: socket.data.path,
      headers: socket.data.headers,
      identity: socket.data.identity,
      body: frame,
      bodyHash: sha256(frame),
      json,
      responseHeaders: {},
    }
    const parsed =
      isRecord(json) && json.type === "response.create" ? responsesBody({ ...json, stream: true }) : undefined
    if (parsed === undefined || "error" in parsed) {
      fake.record({ ...base, model: undefined, cache: undefined, status: 400 })
      socket.send(
        JSON.stringify({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: parsed?.error ?? "Expected a response.create frame" },
        }),
      )
      return
    }
    const body = parsed.body
    const prompt = responsesPrompt(body)
    const cache = fake.cache.prefix(`${socket.data.identity}|${body.model}`, prompt, { write: false })
    const turn = consume(socket.data.accountID)
    if (turn.exhausted) {
      socket.send(JSON.stringify(rateLimitFrame(socket.data.accountID)))
      fake.record({ ...base, model: body.model, cache, status: 429 })
      socket.send(
        JSON.stringify({ type: "error", status: 429, ...exhaustedBody(socket.data.accountID, turn.exhausted) }),
      )
      return
    }
    const draft = { ...base, model: body.model, cache, status: 200 }
    const reply = fake.nextReply({ ...draft, seq: fake.requests.length + 1, fake: "codex", at: fake.clock.now() })
    const headless = reply.type === "reset" || reply.type === "delayed-listen"
    fake.record({
      ...draft,
      status: reply.type === "error" ? reply.status : headless ? 0 : 200,
      ...("reply" in reply || headless ? { fault: reply.type } : {}),
    })
    // A reset drops the socket before any frame; `delayed-listen` closes it with the listener.
    if (reply.type === "reset") return socket.terminate()
    if (reply.type === "delayed-listen") return fake.unlisten(reply.ms)
    socket.send(JSON.stringify(rateLimitFrame(socket.data.accountID)))
    socket.send(JSON.stringify({ type: "codex.response.metadata", headers: { "x-models-etag": "fake-etag" } }))
    if (reply.type === "error") {
      socket.send(JSON.stringify({ type: "error", status: reply.status, error: errorOf(reply.body) }))
      return
    }
    fake.cache.prefix(`${socket.data.identity}|${body.model}`, prompt)
    const plan = cut(
      reply,
      responsesEvents({ reply: answerOf(reply), model: body.model, usage: cache, ...served(body) }),
      RESPONSES_MARKS,
    )
    const pace = timing(reply)
    if (pace.delayMs) await Bun.sleep(pace.delayMs)
    for (const [index, event] of plan.events.entries()) {
      socket.send(index === plan.corrupt ? corrupted(JSON.stringify(event)) : JSON.stringify(event))
      if (pace.eventDelayMs) await Bun.sleep(pace.eventDelayMs)
    }
    if (plan.end === "complete") return
    // Let the frames sent so far reach the client before the socket goes away.
    await settle(plan.until)
    if (plan.end === "eof") socket.close(1000)
    if (plan.end === "close") socket.close(plan.code)
    if (plan.end === "reset") socket.terminate()
  }

  /** The tier the response names (02 §4.8): `options.servedTier`, else what the real backend says. */
  const served = (body: Readonly<Record<string, unknown>>) => {
    if (!options.servedTier) return { createdTier: "auto", serviceTier: "default" }
    const tier = options.servedTier(typeof body.service_tier === "string" ? body.service_tier : undefined)
    return tier === undefined ? {} : { serviceTier: tier }
  }

  const register = (input: Partial<ChatGPTAccount> & { readonly accountID: string }) => {
    const account = accounts.get(input.accountID) ?? chatGPTAccount(input)
    accounts.set(account.accountID, account)
    return account
  }

  const mint = (family: string, account: ChatGPTAccount) => {
    const tokens = mintChatGPTTokens(account, fake.clock.now(), accessTtl)
    accessTokens.set(tokens.accessToken, { family, expiresAt: tokens.expiresAt })
    refreshTokens.set(tokens.refreshToken, { family, used: false })
    return tokens
  }

  const login = (input: Partial<ChatGPTAccount> & { readonly accountID: string }) => {
    const account = register(input)
    const family = crypto.randomUUID()
    families.set(family, { accountID: account.accountID, revoked: false })
    return mint(family, account)
  }

  const refresh = (refreshToken: string | undefined): RefreshResult => {
    const entry = refreshToken === undefined ? undefined : refreshTokens.get(refreshToken)
    const family = entry === undefined ? undefined : families.get(entry.family)
    if (entry === undefined || family === undefined)
      return { type: "error", status: 400, code: "invalid_grant", message: "Invalid refresh token." }
    if (family.revoked)
      return {
        type: "error",
        status: 401,
        code: "refresh_token_invalidated",
        message: "Your refresh token has been invalidated.",
      }
    if (entry.used) {
      if (options.revokeFamilyOnReuse ?? true) family.revoked = true
      return {
        type: "error",
        status: 401,
        code: "refresh_token_reused",
        message:
          "Your refresh token has already been used to generate a new access token. Please try signing in again.",
      }
    }
    entry.used = true
    refreshes.set(family.accountID, (refreshes.get(family.accountID) ?? 0) + 1)
    return { type: "ok", tokens: mint(entry.family, register({ accountID: family.accountID })) }
  }

  const authenticate = (headers: Headers) => {
    const token = bearerToken(headers)
    const access = token === undefined ? undefined : accessTokens.get(token)
    const family = access === undefined ? undefined : families.get(access.family)
    if (access === undefined || family === undefined)
      return { type: "error" as const, status: 401, message: "Could not validate your credentials" }
    if (family.revoked)
      return { type: "error" as const, status: 401, message: "Your authentication token has been invalidated." }
    if (access.expiresAt <= fake.clock.now())
      return { type: "error" as const, status: 401, message: "Your authentication token has expired." }
    const header = headers.get("chatgpt-account-id")
    if (header === null && (options.requireAccountHeader ?? true))
      return { type: "error" as const, status: 400, message: "Missing chatgpt-account-id header" }
    if (header !== null && header !== family.accountID)
      return { type: "error" as const, status: 403, message: "chatgpt-account-id does not match the token" }
    return { type: "ok" as const, identity: `codex:${family.accountID}`, accountID: family.accountID }
  }

  const usage = (accountID: string) => {
    const now = fake.clock.now()
    const current = usageState.get(accountID) ?? {
      primary: 0,
      secondary: 0,
      primaryResetAt: now + windows.primary,
      secondaryResetAt: now + windows.secondary,
    }
    if (current.primaryResetAt <= now) Object.assign(current, { primary: 0, primaryResetAt: now + windows.primary })
    if (current.secondaryResetAt <= now)
      Object.assign(current, { secondary: 0, secondaryResetAt: now + windows.secondary })
    usageState.set(accountID, current)
    return current
  }

  /** Charges one model request; returns which window was already exhausted, if any. */
  const consume = (accountID: string) => {
    const current = usage(accountID)
    const exhausted: "primary" | "secondary" | undefined =
      current.primary >= 100 ? "primary" : current.secondary >= 100 ? "secondary" : undefined
    if (exhausted) return { exhausted }
    current.primary = Math.min(100, round(current.primary + (options.usagePerRequest?.primary ?? 1)))
    current.secondary = Math.min(100, round(current.secondary + (options.usagePerRequest?.secondary ?? 0.1)))
    return { exhausted: undefined }
  }

  /** The header set of a real answer (2026-10-18), the credits flags capitalized as the backend sends them. */
  const limitHeaders = (accountID: string) => {
    const current = usage(accountID)
    const now = fake.clock.now()
    const after = (at: number) => String(Math.max(0, Math.round((at - now) / 1000)))
    return {
      "x-codex-plan-type": accounts.get(accountID)?.plan ?? "plus",
      "x-codex-active-limit": "premium",
      "x-codex-primary-used-percent": String(current.primary),
      "x-codex-primary-window-minutes": String(windows.primary / 60_000),
      "x-codex-primary-reset-at": String(Math.floor(current.primaryResetAt / 1000)),
      "x-codex-primary-reset-after-seconds": after(current.primaryResetAt),
      "x-codex-primary-over-secondary-limit-percent": "0",
      ...(options.weeklyOnly
        ? {
            "x-codex-secondary-used-percent": "0",
            "x-codex-secondary-window-minutes": "0",
            "x-codex-secondary-reset-at": "",
            "x-codex-secondary-reset-after-seconds": "0",
          }
        : {
            "x-codex-secondary-used-percent": String(current.secondary),
            "x-codex-secondary-window-minutes": String(windows.secondary / 60_000),
            "x-codex-secondary-reset-at": String(Math.floor(current.secondaryResetAt / 1000)),
            "x-codex-secondary-reset-after-seconds": after(current.secondaryResetAt),
          }),
      "x-codex-credits-has-credits": "False",
      "x-codex-credits-unlimited": "False",
    }
  }

  /** A window of a frame (`window_minutes`) or of the usage answer (`limit_window_seconds`), as the backend sends it. */
  const limitWindow = (used: number, length: number, resetAt: number, unit: "minutes" | "seconds") => ({
    used_percent: used,
    ...(unit === "minutes" ? { window_minutes: length / 60_000 } : { limit_window_seconds: length / 1000 }),
    reset_after_seconds: Math.max(0, Math.round((resetAt - fake.clock.now()) / 1000)),
    reset_at: Math.floor(resetAt / 1000),
  })

  const rateLimits = (accountID: string, unit: "minutes" | "seconds") => {
    const current = usage(accountID)
    const primary = limitWindow(current.primary, windows.primary, current.primaryResetAt, unit)
    const secondary = options.weeklyOnly
      ? null
      : limitWindow(current.secondary, windows.secondary, current.secondaryResetAt, unit)
    const reached = current.primary >= 100 || current.secondary >= 100
    return unit === "minutes"
      ? { allowed: !reached, limit_reached: reached, primary, secondary }
      : { allowed: !reached, limit_reached: reached, primary_window: primary, secondary_window: secondary }
  }

  /** The first frame of every WebSocket answer, with the real frame's fields (2026-10-18). */
  const rateLimitFrame = (accountID: string) => ({
    type: "codex.rate_limits",
    plan_type: accounts.get(accountID)?.plan ?? "plus",
    rate_limits: rateLimits(accountID, "minutes"),
    code_review_rate_limits: null,
    additional_rate_limits: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    promo: null,
  })

  /** `GET /backend-api/wham/usage` (what Codex CLI's `/status` reads), with the real answer's fields (2026-10-18). */
  const usageBody = (accountID: string) => ({
    user_id: `user-${accountID}`,
    account_id: accountID,
    email: accounts.get(accountID)?.email ?? `${accountID}@example.test`,
    plan_type: accounts.get(accountID)?.plan ?? "plus",
    rate_limit: rateLimits(accountID, "seconds"),
    code_review_rate_limit: null,
    additional_rate_limits: null,
    credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" },
    spend_control: { reached: false, individual_limit: null },
    rate_limit_reached_type: null,
    promo: null,
    ...creditCount(accountID),
  })

  const available = (accountID: string) =>
    (resetCredits.get(accountID)?.credits ?? []).filter((credit) => (credit.status ?? "available") === "available")

  /** `rate_limit_reset_credits` of the usage answer: absent until set, `null` when set so. */
  const creditCount = (accountID: string) => {
    const state = resetCredits.get(accountID)
    if (!state) return {}
    if (state.credits === null) return { rate_limit_reset_credits: null }
    return {
      rate_limit_reset_credits: {
        available_count: available(accountID).length,
        applicable_available_count: state.applicable ?? 0,
      },
    }
  }

  /** The list answer (codex-rs `RateLimitResetCreditsDetails`, with fields it ignores). */
  const creditList = (accountID: string) => ({
    credits: available(accountID).map((credit) => ({
      id: credit.id,
      reset_type: credit.reset_type ?? "codex_rate_limits",
      status: credit.status ?? "available",
      granted_at: credit.granted_at,
      expires_at: credit.expires_at ?? null,
      redeem_started_at: null,
      redeemed_at: null,
      ...(credit.title === undefined ? {} : { title: credit.title }),
      ...(credit.description === undefined ? {} : { description: credit.description }),
    })),
    available_count: available(accountID).length,
    total_earned_count: resetCredits.get(accountID)?.credits?.length ?? 0,
  })

  const consumeAnswer = async (accountID: string, body: unknown): Promise<Response> => {
    const script = consumeScripts.get(accountID)?.shift() ?? "auto"
    const requestID = stringField(body, "redeem_request_id")
    if (!requestID) return jsonResponse(400, { detail: "redeem_request_id is required" })
    if (script === "error") return jsonResponse(500, { detail: "Internal Server Error" })
    const outcome = typeof script === "object" ? (script.then ?? "auto") : script
    const answer = redeem(accountID, requestID, stringField(body, "credit_id"), outcome)
    if (typeof script === "object") await Bun.sleep(script.delayMs)
    return jsonResponse(200, answer)
  }

  const redeem = (accountID: string, requestID: string, creditID: string | undefined, script: ConsumeOutcome) => {
    if (redeemed.has(requestID)) return { code: "already_redeemed", windows_reset: 0 }
    const usable = available(accountID)
    const credit = creditID === undefined ? usable[0] : usable.find((item) => item.id === creditID)
    const current = usage(accountID)
    const idle = current.primary === 0 && current.secondary === 0
    const code = script !== "auto" ? script : !credit ? "no_credit" : idle ? "nothing_to_reset" : "reset"
    if (code !== "reset") return { code, windows_reset: 0 }
    redeemed.add(requestID)
    if (credit) credit.status = "redeemed"
    const windowsReset = [current.primary, current.secondary].filter((used) => used > 0).length
    Object.assign(current, { primary: 0, secondary: 0 })
    return { code: "reset", credit: { id: credit?.id ?? "fake-credit" }, windows_reset: windowsReset }
  }

  const exhaustedBody = (accountID: string, window: "primary" | "secondary") => {
    const current = usage(accountID)
    const resetAt = window === "primary" ? current.primaryResetAt : current.secondaryResetAt
    return {
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: accounts.get(accountID)?.plan ?? "plus",
        resets_at: Math.floor(resetAt / 1000),
        resets_in_seconds: Math.max(0, Math.round((resetAt - fake.clock.now()) / 1000)),
      },
    }
  }

  options.accounts?.forEach(register)

  return {
    ...fake,
    websocketURL: `${fake.url.replace(/^http/, "ws")}/backend-api/codex/responses`,
    tokenURL: `${fake.url}/oauth/token`,
    login,
    refresh,
    refreshCount: (accountID) => refreshes.get(accountID) ?? 0,
    usage: (accountID) => ({ ...usage(accountID) }),
    setUsage: (accountID, next) => {
      usageState.set(accountID, { ...usage(accountID), ...next })
    },
    usagePolls,
    modelListReads,
    imageCalls,
    setResetCredits: (accountID, credits, applicable) => {
      resetCredits.set(accountID, {
        credits: credits === null ? null : credits.map((credit) => ({ ...credit })),
        ...(applicable === undefined ? {} : { applicable }),
      })
    },
    resetCredits: (accountID) => resetCredits.get(accountID)?.credits?.map((credit) => ({ ...credit })),
    scriptConsume: (accountID, ...scripts) => {
      consumeScripts.set(accountID, [...(consumeScripts.get(accountID) ?? []), ...scripts])
    },
    resetCreditReads,
    consumes,
  }
}

function refreshTokenOf(body: string, contentType: string | null) {
  if (contentType?.includes("application/x-www-form-urlencoded"))
    return new URLSearchParams(body).get("refresh_token") ?? undefined
  return stringField(parseJson(body), "refresh_token")
}

function errorOf(body: unknown) {
  return isRecord(body) && body.error !== undefined ? body.error : body
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}

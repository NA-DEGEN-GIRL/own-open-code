// Sign in with ChatGPT (token sharing, 02 §3.2c) on a real upstream server: own.accounts loads from its package
// directory, the opencode config has no providers, and the fake token-sharing issuer plus the fake OpenAI Responses
// server stand in for auth.openai.com and api.openai.com. The login runs through the `accounts.add.chatgpt.*` RPCs and
// the loopback callback; the session then talks to the `own-siwc-*` slot with Bearer auth, the session headers of
// upstream's token sharing (a subagent and a fork route on their parent's or source's) and zstd bodies, which the fake
// route decodes. A usage limit must end the turn without core's retries, `accounts.test` reads the account catalog,
// and deleting the account revokes its refresh token. Fast and Ultrafast from the account catalog stay on although
// every answer names `default`, as the real route does (02 §4.8), and own-accounts' lines reach `OWN_HOME\logs`
// (02 §7.2). Every credential is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { Templates } from "../../src/slots/templates.js"
import {
  REPO_ROOT,
  hashSecret,
  logLeaks,
  ledgerAlerts,
  opencodeConfig,
  sharingError,
  startFakeChatGPTSharing,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeChatGPTSharing,
  type FakeOpenAIResponses,
  type OpencodeServer,
  type RecordedRequest,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const SCENARIO_TIMEOUT = 300_000
const MODEL = "gpt-5.5"
const USER = { sub: "user-e2e-sharing", email: "sharing@example.test", plan: "plus" }
/** In every prompt: the log file must never hold the user's words (02 §7.2). */
const QUERY = "query-canary-7f3a91"
/** Two more logins for one session that moves between them. */
const SWITCH_USERS = [
  { sub: "user-e2e-sharing-a", email: "sharing-a@example.test", plan: "plus" },
  { sub: "user-e2e-sharing-b", email: "sharing-b@example.test", plan: "pro" },
] as const
/** Core's title agent prompt (core plugin/agent.ts). */
const TITLE_PROMPT = "You name conversations so the user can find them later"
/** Core's first summary prompt (core session/compaction.ts `buildPrompt`). */
const SUMMARY_PROMPT = "You MUST summarize the conversation above"
/** A summary in core's template shape: it needs one of the template's `## …` heading lines. */
const SUMMARY = ["## Objective", "- greet the plan", "", "## Next Move", "1. (none)"].join("\n")

type Json = Record<string, unknown>

describe("Sign in with ChatGPT on a real server", () => {
  const state: {
    auth?: FakeChatGPTSharing
    responses?: FakeOpenAIResponses
    server?: OpencodeServer
    control?: string
    outputs: string[]
  } = { outputs: [] }

  async function rpc(method: string, input: unknown = {}) {
    const server = required(state.server)
    // A session's methods (`session.speed.*`) go to its Location, the rest to the control one (02 §9.1).
    const directory =
      OwnAccounts.MethodLocation[method as keyof typeof OwnAccounts.MethodLocation] === "control"
        ? required(state.control)
        : server.paths.workspace
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const text = await response.text()
    state.outputs.push(text)
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text}`)
    return ((JSON.parse(text) as { readonly output?: Json }).output ?? {}) as Json
  }

  /** A token-sharing login through the RPCs and the loopback callback: its slot and the access token it got. */
  async function login(user: (typeof SWITCH_USERS)[number], label: string) {
    const auth = required(state.auth)
    const started = await rpc("accounts.add.chatgpt.start", { method: "siwc" })
    expect((await fetch(auth.authorize(String(started.authorizeURL), user))).status).toBe(200)
    const completed = await rpc("accounts.add.chatgpt.complete", { attemptID: started.attemptID, label })
    return {
      providerID: String((completed.account as Json).providerID),
      access: auth.issued.at(-1)?.accessToken ?? "missing",
    }
  }

  beforeAll(async () => {
    const auth = startFakeChatGPTSharing()
    const responses = startFakeOpenAIResponses({
      cache: { minTokens: 0, blockTokens: 16 },
      // What the token-sharing route names whatever it ran (the user's sessions, 2026-10-10 to 10-22).
      servedTier: "default",
      sharingModels: [
        {
          slug: MODEL,
          display_name: "GPT-5.5",
          visibility: "list",
          supported_in_api: true,
          context_window: 400_000,
          input_modalities: ["text", "image"],
          service_tiers: [
            { id: "priority", name: "Fast" },
            { id: "ultrafast", name: "Ultrafast" },
          ],
        },
      ],
    })
    Object.assign(state, { auth, responses })
    const server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: path.join(REPO_ROOT, "packages/own-accounts"),
              options: {
                home: paths.ownHome,
                buildId: `e2e-sharing-${process.pid}`,
                vault: "memory",
                endpoints: { openai: responses.baseURL, oauthIssuer: auth.url },
              },
            },
          ],
        }),
    })
    state.server = server
    // The launcher creates the empty control directory (02 §9.1).
    const control = path.join(server.paths.ownHome, "control")
    await fs.mkdir(control, { recursive: true })
    state.control = control
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.auth?.stop(), state.responses?.stop()])
  }, 60_000)

  test(
    "login, Bearer requests with session headers and zstd bodies, a usage limit without retries, the catalog test and revocation on delete",
    async () => {
      const server = required(state.server)
      const auth = required(state.auth)
      const responses = required(state.responses)

      // The login: the listener runs before the URL is handed out; the browser comes back to 127.0.0.1.
      const started = await rpc("accounts.add.chatgpt.start", { method: "siwc" })
      expect(started.method).toBe("siwc")
      const callback = auth.authorize(String(started.authorizeURL), USER)
      expect(new URL(callback).hostname).toBe("127.0.0.1")
      const page = await fetch(callback)
      expect(page.status).toBe(200)
      expect(await rpc("accounts.add.chatgpt.status", { attemptID: started.attemptID })).toMatchObject({
        phase: "authorized",
        identity: { emailMasked: "sh***@example.test", plan: "plus" },
      })
      const completed = await rpc("accounts.add.chatgpt.complete", { attemptID: started.attemptID, label: "Plus" })
      expect(completed).toMatchObject({
        reauthenticated: false,
        account: { kind: "siwc", status: "ready", connection: { type: "oauth", method: "chatgpt-siwc" } },
      })
      const account = completed.account as Json
      const providerID = String(account.providerID)
      expect(providerID).toMatch(/^own-siwc-[a-z0-9]{4,8}$/)

      // The slot: public API base URL (overridden here), HTTP, summary compaction, the fallback models only.
      const model = { providerID, id: MODEL }
      await server.waitForModels([model])
      const provider = (await providers(server)).find((item) => item.id === providerID)
      expect(provider).toMatchObject({
        canonical: "openai",
        settings: { baseURL: responses.baseURL, compaction: { type: "summary" } },
      })
      expect(provider?.settings).not.toHaveProperty("transport")
      expect(provider).not.toHaveProperty("headers")
      const listed = (await server.models())
        .filter((item) => item.providerID === providerID)
        .map((item) => String(item.id))
      expect(new Set(listed)).toEqual(new Set(Templates.SHARING_MODELS))

      // A turn: Bearer, the Codex client's session headers upstream's token sharing sends (5183ea45c3), no Codex
      // account or originator header, the session's prompt cache key, and a zstd body (5673bfa4a8) the route decodes.
      // Core sends no generation options of its own (its request hook starts with none), so the strip of those this
      // route rejects is tested in shape.test.ts.
      const session = await server.createSession({ model, title: "sharing e2e" })
      const resetAt = Math.floor(Date.now() / 1000) + 3_600
      responses.enqueue({ type: "text", text: "hello from the plan", headers: planHeaders("37", resetAt) })
      await server.prompt(session.id, `hi ${QUERY}`)
      await server.waitIdle(session.id)
      const calls = responses.requests.filter(isResponsesCall)
      expect(calls).toHaveLength(1)
      const first = required(calls[0])
      const access = auth.issued.at(-1)?.accessToken ?? "missing"
      expect(first.status).toBe(200)
      expect(first.headers.authorization).toBe(hashSecret(`Bearer ${access}`))
      expect(sessionHeaders(first)).toEqual({
        "session-id": session.id,
        "thread-id": session.id,
        "x-client-request-id": session.id,
      })
      for (const header of ["chatgpt-account-id", "originator", "x-codex-beta-features"])
        expect(first.headers[header]).toBeUndefined()
      expect(first.headers["content-encoding"]).toBe("zstd")
      expect(Number(first.wireBytes)).toBeLessThan(first.body.length)
      const body = first.json as Json
      expect(body).toMatchObject({ model: MODEL, stream: true })
      // The prompt cache key comes from the same session affinity as `session-id` (core model-request.ts).
      expect(typeof body.prompt_cache_key).toBe("string")
      expect(session.id.endsWith(String(body.prompt_cache_key))).toBe(true)

      // The plan headers on the answer become the account's windows (02 §7.1), next to the public API's rate ones.
      const windows = await until(async () => {
        const snapshot = await rpc("quota.snapshot", { accountIDs: [account.id] })
        const list = snapshot.windows as ReadonlyArray<Json>
        return list.some((window) => window.id === "codex.primary") ? list : undefined
      })
      expect(windows.find((window) => window.id === "codex.primary")).toMatchObject({
        accountID: account.id,
        providerID,
        label: "5시간",
        usedPercent: 37,
        windowMinutes: 300,
        resetAt: resetAt * 1000,
        status: "ok",
        source: "header",
      })
      expect(windows.find((window) => window.id === "codex.secondary")).toMatchObject({
        label: "주간",
        usedPercent: 37,
      })

      // Ultrafast as the account catalog lists it stays on through answers that all say `default` (02 §4.8): token
      // sharing names no served tier, like the Codex backend. No downgrade notice, no fallback.
      await until(async () => {
        const view = await rpc("session.speed.get", { sessionID: session.id })
        const listed = Array.isArray(view.offers) ? (view.offers as ReadonlyArray<Json>) : []
        return listed.some((offer) => offer.choice === "ultrafast" && offer.status === "available") ? true : undefined
      })
      await rpc("session.speed.set", { sessionID: session.id, speed: "ultrafast" })
      for (const text of ["하나", "둘", "셋"]) {
        responses.enqueue({ type: "text", text: `fast ${text}` })
        await server.prompt(session.id, `${text} ${QUERY}`)
        await server.waitIdle(session.id)
      }
      const fast = responses.requests.filter(isResponsesCall).slice(1)
      expect(fast.map((request) => (request.json as Json).service_tier)).toEqual([
        "ultrafast",
        "ultrafast",
        "ultrafast",
      ])
      const view = await rpc("session.speed.get", { sessionID: session.id })
      expect(view).toMatchObject({ choice: "ultrafast", effective: "ultrafast", tier: "ultrafast" })
      expect(view).not.toHaveProperty("served")
      expect(await ledgerAlerts(server.paths.ownHome, "speed_downgraded")).toEqual([])
      expect(await ledgerAlerts(server.paths.ownHome, "speed_fallback")).toEqual([])
      // Every request of the session sends the same session headers (the prompt cache routes on them) and a zstd body.
      for (const request of fast) {
        expect(sessionHeaders(request)).toEqual(sessionHeaders(first))
        expect(request.headers["content-encoding"]).toBe("zstd")
      }

      // A subagent shares its parent's `session-id` (core's affinity, `SessionAffinity.get`), so its requests stay in
      // the parent's prompt-cache routing; `thread-id` and `x-client-request-id` are its own session, as upstream sends.
      responses.enqueue(
        {
          type: "tool-call",
          name: "subagent",
          id: "call_sharing_child",
          input: { agent: "explore", description: "하위 작업", prompt: `child ${QUERY}` },
        },
        { type: "text", text: "done" },
        { type: "text", text: "done" },
        { type: "text", text: "done" },
      )
      const delegatedFrom = responses.requests.filter(isResponsesCall).length
      await server.prompt(session.id, `delegate ${QUERY}`)
      // Since upstream v2.3.0 (#63382) a subagent runs in the background: the parent answers at once and the child's
      // report wakes it once more, so four requests in an order the scheduler picks (the parent's call, its answer, the
      // child's turn, the parent after the report).
      await until(async () =>
        responses.requests.filter(isResponsesCall).length - delegatedFrom >= 4 ? true : undefined,
      )
      await server.waitIdle(session.id)
      const delegated = responses.requests.filter(isResponsesCall).slice(delegatedFrom)
      expect(delegated.map((request) => request.status)).toEqual([200, 200, 200, 200])
      const child = delegated.find((request) => request.headers["thread-id"] !== session.id)
      const childID = String(child?.headers["thread-id"])
      expect(await sessionInfo(server, childID)).toMatchObject({ id: childID, parentID: session.id })
      expect(delegated.map(sessionHeaders)).toEqual(
        delegated.map((request) =>
          request === child
            ? { "session-id": session.id, "thread-id": childID, "x-client-request-id": childID }
            : sessionHeaders(first),
        ),
      )
      for (const request of delegated) expect(request.headers["content-encoding"]).toBe("zstd")
      // The child's prompt cache key is its parent's too: both come from the affinity (core model-request.ts).
      expect(delegated.map((request) => (request.json as Json).prompt_cache_key)).toEqual(
        delegated.map(() => body.prompt_cache_key),
      )

      // A fork keeps routing on its source's `session-id`; its own id is the thread.
      const fork = (await server.call("POST", `/api/session/${session.id}/fork`, { body: {} })) as { data: Json }
      const forkID = String(fork.data.id)
      expect(forkID).not.toBe(session.id)
      responses.enqueue({ type: "text", text: "fork done" })
      await server.prompt(forkID, `fork ${QUERY}`)
      await server.waitIdle(forkID)
      const forked = required(responses.requests.filter(isResponsesCall).at(-1))
      expect(forked.status).toBe(200)
      expect(sessionHeaders(forked)).toEqual({
        "session-id": session.id,
        "thread-id": forkID,
        "x-client-request-id": forkID,
      })
      expect(forked.headers["content-encoding"]).toBe("zstd")
      expect((forked.json as Json).prompt_cache_key).toBe(body.prompt_cache_key)

      // A usage limit ends the turn at once: core would retry a 429 as a rate limit. Its full plan window dates the
      // exhaustion; the reason stays the sharing code the plan banner keys on.
      const limit = sharingError("subscription_sharing_usage_limit_exceeded")
      if (limit.type !== "error") throw new Error("expected an HTTP error reply")
      responses.enqueue({ ...limit, headers: planHeaders("100", resetAt) })
      const sent = responses.requests.filter(isResponsesCall).length
      await server.prompt(session.id, `again ${QUERY}`)
      await server.waitIdle(session.id)
      const exhausted = await until(async () => {
        const snapshot = await rpc("quota.snapshot", { accountIDs: [account.id] })
        return (snapshot.exhausted as ReadonlyArray<Json>)[0]
      })
      expect(exhausted).toMatchObject({ accountID: account.id, reason: "subscription_sharing_usage_limit_exceeded" })
      expect(Number(exhausted.until)).toBeGreaterThan(resetAt * 1000)
      const limited = responses.requests.filter(isResponsesCall)
      expect(limited).toHaveLength(sent + 1)
      expect(limited.at(-1)?.status).toBe(429)
      // The follow-up turn is sent in full over HTTP; it does not continue the previous response server-side.
      expect(JSON.stringify(limited.at(-1)?.json)).toContain("hello from the plan")
      expect(limited.at(-1)?.json).not.toHaveProperty("previous_response_id")

      // own-accounts' lines reach a file the user can find (02 §7.2): the plan headers' first observation, and the
      // first answer that came without them, by header name only.
      const logged = (await Bun.file(logFile(server)).text())
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Json)
      expect(logged.find((line) => line.msg === "limits_observed" && line.source === "header")).toMatchObject({
        accountID: account.id,
        providerID,
      })
      expect(logged.find((line) => line.msg === "limits_absent")).toMatchObject({
        accountID: account.id,
        providerID,
        headers: expect.arrayContaining(["x-request-id"]),
      })
      // The usage limit by field name: its full window came from the plan headers, so none from the body.
      expect(logged.find((line) => line.msg === "usage_limit_answer")).toMatchObject({
        accountID: account.id,
        providerID,
        status: 429,
        fields: expect.arrayContaining(["error.code"]),
        reset: false,
      })

      // The connection test reads the account catalog with the Bearer token.
      expect(await rpc("accounts.test", { accountID: account.id })).toMatchObject({ ok: true })
      const catalog = responses.requests.findLast((request) => request.path === "/v1/models")
      expect(catalog?.headers.authorization).toBe(hashSecret(`Bearer ${access}`))

      // Deleting the account revokes its refresh token at the issuer.
      const planned = await rpc("accounts.remove.plan", { accountID: account.id, mode: "delete" })
      expect(planned.willShredVault).toBe(true)
      await rpc("accounts.remove.execute", { nonce: planned.nonce })
      const refresh = auth.issued.at(-1)?.refreshToken ?? "missing"
      await until(async () => (auth.revocations.length > 0 ? true : undefined))
      expect(auth.revocations).toEqual([
        { token: hashSecret(refresh), hint: "refresh_token", clientID: auth.clients.at(-1) },
      ])

      const exposed = state.outputs.join("\n") + server.logs() + (await Bun.file(logFile(server)).text())
      const secrets = auth.issued.flatMap((tokens) => [tokens.accessToken, tokens.refreshToken, tokens.idToken])
      for (const secret of secrets) expect(exposed).not.toContain(secret)
      // Every line of the log file: no credential pattern, no unredacted token field, no prompt and no answer text.
      expect(
        logLeaks(await Bun.file(logFile(server)).text(), [...secrets, QUERY, "hello from the plan", "fast 하나"]),
      ).toEqual([])
    },
    SCENARIO_TIMEOUT,
  )

  test(
    "title, retried, compaction and switched-account requests send the session's headers and zstd bodies",
    async () => {
      const server = required(state.server)
      const responses = required(state.responses)
      const [a, b] = [await login(SWITCH_USERS[0], "A"), await login(SWITCH_USERS[1], "B")]
      expect(b.providerID).not.toBe(a.providerID)
      await server.waitForModels([
        { providerID: a.providerID, id: MODEL },
        { providerID: b.providerID, id: MODEL },
      ])
      // An untitled session, so core's title agent names it after the first prompt on the same slot.
      const created = (await server.call("POST", "/api/session", {
        body: { model: { providerID: a.providerID, id: MODEL }, location: { directory: server.paths.workspace } },
      })) as { data: Json }
      const sessionID = String(created.data.id)
      const ofSession = () =>
        responses.requests.filter(
          (request) => isResponsesCall(request) && request.headers["x-opencode-session-id"] === sessionID,
        )
      await server.prompt(sessionID, `name this ${QUERY}`)
      await server.waitIdle(sessionID)
      const title = await until(async () => ofSession().find((request) => request.body.includes(TITLE_PROMPT)))
      const turn = required(ofSession().find((request) => !request.body.includes(TITLE_PROMPT)))

      // A server error is retried by core; the retry is the same request again.
      responses.enqueue(
        { type: "error", status: 500, body: { error: { message: "Fake server error.", type: "server_error" } } },
        { type: "text", text: "after the retry" },
      )
      const retriedFrom = ofSession().length
      await server.prompt(sessionID, `retry ${QUERY}`)
      await server.waitIdle(sessionID)
      const retried = ofSession().slice(retriedFrom)
      expect(retried.map((request) => request.status)).toEqual([500, 200])

      // A manual compaction: core's summary request on the session's slot (summary compaction, 02 §3.6).
      responses.enqueue({ type: "text", text: SUMMARY })
      const compactedFrom = ofSession().length
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
      await server.waitIdle(sessionID)
      const compaction = required(
        ofSession()
          .slice(compactedFrom)
          .find((request) => request.body.includes(SUMMARY_PROMPT)),
      )

      // The session moves to the second login: its credential, the same session headers.
      await server.switchModel(sessionID, { providerID: b.providerID, id: MODEL })
      responses.enqueue({ type: "text", text: "on the second login" })
      const switchedFrom = ofSession().length
      await server.prompt(sessionID, `switched ${QUERY}`)
      await server.waitIdle(sessionID)
      const switched = ofSession().slice(switchedFrom)
      expect(switched).toHaveLength(1)

      // Every kind as the route saw it, side by side, so a failure shows each kind it hits.
      const sent = { title, turn, retry: retried[0], retried: retried[1], compaction, switched: switched[0] }
      const promptCacheKey = (turn.json as Json).prompt_cache_key
      expect(sessionID.endsWith(String(promptCacheKey))).toBe(true)
      expect(
        Object.fromEntries(
          Object.entries(sent).map(([name, request]) => [
            name,
            request && {
              status: request.status,
              session: sessionHeaders(request),
              encoding: request.headers["content-encoding"],
              promptCacheKey: (request.json as Json).prompt_cache_key,
              authorization: request.headers.authorization,
            },
          ]),
        ),
      ).toEqual(
        Object.fromEntries(
          Object.keys(sent).map((name) => [
            name,
            {
              status: name === "retry" ? 500 : 200,
              session: { "session-id": sessionID, "thread-id": sessionID, "x-client-request-id": sessionID },
              encoding: "zstd",
              promptCacheKey,
              authorization: hashSecret(`Bearer ${name === "switched" ? b.access : a.access}`),
            },
          ]),
        ),
      )
      // Nothing else of the session was sent: every request of it is one of the above.
      expect(ofSession()).toHaveLength(Object.keys(sent).length)
    },
    SCENARIO_TIMEOUT,
  )
})

/** own-accounts' log file under the server's OWN_HOME (02 §7.2). */
function logFile(server: OpencodeServer) {
  return path.join(server.paths.ownHome, "logs", "own-accounts.log")
}

/**
 * The Codex plan header families (02 §7.1) a token-sharing response would carry: a 5-hour and a weekly window. Real
 * answers have carried none so far (12장 48); the parser stays, so they would show up at once.
 */
function planHeaders(used: string, resetAt: number) {
  return {
    "x-codex-primary-used-percent": used,
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(resetAt),
    "x-codex-secondary-used-percent": used,
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(resetAt + 86_400),
  }
}

async function providers(server: OpencodeServer) {
  const listed = (await server.call("GET", "/api/provider")) as unknown
  const list = Array.isArray(listed) ? listed : isRecord(listed) && Array.isArray(listed.data) ? listed.data : []
  return list.filter(isRecord)
}

function isResponsesCall(request: RecordedRequest) {
  return request.method === "POST" && request.path === "/v1/responses"
}

/** The Codex client's session headers of a recorded request (upstream chatgpt.ts, 5183ea45c3). */
function sessionHeaders(request: RecordedRequest) {
  return {
    "session-id": request.headers["session-id"],
    "thread-id": request.headers["thread-id"],
    "x-client-request-id": request.headers["x-client-request-id"],
  }
}

async function sessionInfo(server: OpencodeServer, sessionID: string) {
  const got = (await server.call("GET", `/api/session/${sessionID}`)) as unknown
  return isRecord(got) && isRecord(got.data) ? got.data : undefined
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(200)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("sharing e2e fixture was not set up")
  return value
}

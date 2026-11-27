// Sign in with ChatGPT (token sharing, 02 §3.2c) through the login RPC handlers against the fake token-sharing issuer
// and the fake OpenAI Responses server: the loopback callback, client registration and re-login, the account guard
// scoped by kind, Bearer-only headers, the refresher, the catalog test, rejection and revocation. Fake tokens only;
// the manual clock drives expiry and the fakes follow it.

import { afterAll, describe, expect, test } from "bun:test"
import { Kv, Preset, type Account, type OwnAccounts } from "@own/protocol"
import { Hash, Jwt, Vault } from "@own/runtime"
import {
  AUTH_CLAIM,
  SHARING_RESOURCE,
  hashSecret,
  startFakeChatGPTSharing,
  startFakeOpenAIResponses,
  type SharingAuthorizeOptions,
  type SharingTokens,
  type SharingUser,
} from "../e2e-kit"
import { ChatgptSharing } from "../../src/credentials/sharing.js"
import { Templates } from "../../src/slots/templates.js"
import { memoryStorage } from "../slots/support.js"
import { call, harness, sharedClock, statuses, until, type Harness } from "./support.js"

const time = sharedClock()
const earliest = { at: undefined as ((now: number) => number) | undefined }
const auth = startFakeChatGPTSharing({ clock: time.clock, earliestRefreshAt: (now) => earliest.at?.(now) })
const responses = startFakeOpenAIResponses({
  clock: time.clock,
  sharingModels: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      visibility: "list",
      supported_in_api: true,
      context_window: 400_000,
      input_modalities: ["text", "image"],
    },
  ],
})

/** An account catalog that refuses with a chosen status and error code (`accounts.test` failures). */
const refusal = { status: 403, code: "subscription_sharing_user_not_eligible" }
const refusing = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    Response.json(
      { error: { code: refusal.code, message: "Fake refusal.", type: "invalid_request_error" } },
      { status: refusal.status },
    ),
})

afterAll(async () => {
  await Promise.all([auth.stop(), responses.stop(), refusing.stop()])
})

const endpoints = { oauthIssuer: auth.url, openai: responses.baseURL }
const NADIA: SharingUser = { sub: "user-nadia", email: "nadia@example.test", plan: "plus" }
const OTHER: SharingUser = { sub: "user-other", email: "other@example.test", plan: "pro" }

async function setup() {
  const kv = memoryStorage()
  const h = await harness({ options: { endpoints }, ctx: { storage: kv.storage } })
  time.follow(h.clock)
  return { h, kv }
}

type StartInput = Omit<OwnAccounts.LoginStartInput, "method">

async function start(h: Harness, input: StartInput = {}) {
  const started = await call(h.logins.chatgptStart, { method: "siwc", ...input })
  if (!started.ok || started.output.method !== "siwc") throw new Error(`start failed: ${JSON.stringify(started)}`)
  return started.output
}

async function status(h: Harness, attemptID: string) {
  const result = await call(h.logins.chatgptStatus, { attemptID: attemptID as never })
  if (!result.ok) throw new Error("status failed")
  return result.output
}

/** Start, sign in at the fake issuer as `user`, load the callback; returns the attempt and the browser page. */
async function signIn(h: Harness, user: SharingUser, input: StartInput = {}, options: SharingAuthorizeOptions = {}) {
  const started = await start(h, input)
  const callback = auth.authorize(started.authorizeURL, user, options)
  const page = await fetch(callback)
  return { started, callback, page, html: await page.text() }
}

async function added(h: Harness, user = NADIA) {
  const login = await signIn(h, user)
  expect(login.page.status).toBe(200)
  const completed = await call(h.logins.chatgptComplete, { attemptID: login.started.attemptID })
  if (!completed.ok) throw new Error(`complete failed: ${completed.type} ${completed.message}`)
  const account = h.modules.slots.account(completed.output.account.id)
  if (!account) throw new Error("no account")
  return { ...login, completed: completed.output, account }
}

describe("Sign in with ChatGPT login", () => {
  test("registers a client through the loopback callback and creates a working siwc account", async () => {
    const { h, kv } = await setup()
    await using _h = h
    const started = await start(h)
    const url = new URL(started.authorizeURL)
    expect(url.origin + url.pathname).toBe(`${auth.url}/api/accounts/authorize`)
    const query = url.searchParams
    expect(query.get("client_id")).toBe("dynamic_agent_client")
    expect(query.get("agent_name_hint")).toBe("Own OpenCode")
    expect(query.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct")
    expect(query.get("resource")).toBe(SHARING_RESOURCE)
    expect(query.get("code_challenge_method")).toBe("S256")
    expect(query.get("nonce")).toMatch(/^[\w-]{43}$/)
    expect(query.has("prompt")).toBe(false)
    const host = query.get("ext_agent_host_id")
    expect(host).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(kv.values.get(Kv.chatgptAgentHost)).toBe(host ?? "")
    const redirect = new URL(query.get("redirect_uri") ?? "")
    expect(redirect.protocol + redirect.hostname + redirect.pathname).toBe("http:127.0.0.1/auth/callback")
    expect(Number(redirect.port)).toBeGreaterThan(0)

    // Stray, forged and wrong-path requests are answered without consuming the attempt.
    const stray = new URL(redirect)
    expect((await fetch(stray)).status).toBe(400)
    stray.searchParams.set("code", "ac_forged")
    stray.searchParams.set("state", "wrong")
    expect((await fetch(stray)).status).toBe(400)
    stray.searchParams.set("error", "access_denied")
    expect((await fetch(stray)).status).toBe(400)
    expect((await fetch(new URL("/other", redirect))).status).toBe(404)
    // A valid-looking callback under another host name (DNS rebinding) is refused too.
    const rebound = new URL(redirect)
    rebound.searchParams.set("code", "ac_rebound")
    rebound.searchParams.set("state", query.get("state") ?? "")
    expect((await fetch(rebound, { headers: { host: "evil.example" } })).status).toBe(400)
    expect(await status(h, started.attemptID)).toEqual({ phase: "pending" })

    const callback = auth.authorize(started.authorizeURL, NADIA)
    const clientId = new URL(callback).searchParams.get("client_id") ?? ""
    expect(clientId).toBe(auth.clients.at(-1) ?? "missing")
    const page = await fetch(callback)
    expect(page.status).toBe(200)
    expect(Object.fromEntries(page.headers)).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": expect.stringContaining("default-src 'none'"),
    })
    // The listener closes once the attempt is authorized: a reload cannot exchange the one-time code again.
    await expect(fetch(callback)).rejects.toThrow()
    expect(await status(h, started.attemptID)).toEqual({
      phase: "authorized",
      identity: { emailMasked: "na***@example.test", plan: "plus" },
    })
    const stored = await h.deps.runtime.vault.list()
    expect(stored.ok && stored.ids).toEqual([])

    const completed = await call(h.logins.chatgptComplete, { attemptID: started.attemptID })
    if (!completed.ok) throw new Error(`complete failed: ${completed.type} ${completed.message}`)
    expect(completed.output).toMatchObject({
      reauthenticated: false,
      account: {
        kind: "siwc",
        label: "na***@example.test",
        status: "ready",
        billing: "subscription",
        connection: { type: "oauth", method: "chatgpt-siwc" },
        identity: { emailMasked: "na***@example.test", plan: "plus" },
      },
    })
    const account = h.modules.slots.account(completed.output.account.id)
    if (!account) throw new Error("no account")
    expect(account.method).toBe("chatgpt-siwc")
    expect(account.identity.fingerprint).toBe(Hash.fingerprint(clientId, NADIA.sub))
    expect(h.modules.slots.snapshot().cacheDomains[account.cacheDomain]).toMatchObject({
      kind: "siwc",
      scope: "chatgpt_sharing",
      externalId: clientId,
    })
    expect(h.modules.slots.snapshot().quotaDomains[account.quotaDomain]).toMatchObject({
      scope: "chatgpt_sharing",
      externalId: clientId,
    })
    expect(await h.deps.runtime.credentials.inspect(account)).toMatchObject({
      ok: true,
      type: "oauth",
      generation: 1,
      clientId,
    })

    // Bearer only: no ChatGPT account, session or originator headers.
    const headers = await h.logins.headers(account, "ses_1")
    if (!headers.ok) throw new Error(`headers failed: ${headers.problem}`)
    expect(Object.keys(headers.headers)).toEqual(["authorization"])
    expect(headers.headers.authorization).toBe(`Bearer ${auth.issued.at(-1)?.accessToken}`)

    expect(statuses(h.events).map((event) => event.phase)).toEqual(["awaiting_user", "authorized", "completed"])
    const exposed = JSON.stringify([h.events, completed.output, await status(h, started.attemptID)]) + h.logs.join("\n")
    const issued = auth.issued.at(-1)
    for (const secret of [issued?.accessToken, issued?.refreshToken, issued?.idToken])
      expect(exposed).not.toContain(secret ?? "missing")
  })

  test("the host id is created once; every new account registers a new client", async () => {
    const { h, kv } = await setup()
    await using _h = h
    const first = await added(h)
    const second = await added(h)
    const hosts = auth.authorizations.slice(-2).map((query) => query.get("ext_agent_host_id"))
    expect(hosts[0]).toBe(hosts[1] ?? "")
    expect(kv.values.get(Kv.chatgptAgentHost)).toBe(hosts[0] ?? "")
    // "Add account" never reuses another account's client, even for the same user.
    expect(auth.authorizations.slice(-2).map((query) => query.get("client_id"))).toEqual([
      "dynamic_agent_client",
      "dynamic_agent_client",
    ])
    expect(second.account.id).not.toBe(first.account.id)
    expect(second.account.identity.fingerprint).not.toBe(first.account.identity.fingerprint)
    expect(h.modules.slots.snapshot().accounts).toHaveLength(2)
  })

  test("a failed host id read refuses the start and never replaces the stored id", async () => {
    const kv = memoryStorage()
    const stored = "urn:uuid:9b2d6b8e-3c1a-4e7f-8a52-1f0c2d3e4a5b"
    kv.values.set(Kv.chatgptAgentHost, stored)
    const busy = {
      ...kv.storage,
      get: async () => {
        throw new Error("database is locked")
      },
    }
    const h = await harness({ options: { endpoints }, ctx: { storage: busy } })
    time.follow(h.clock)
    await using _h = h
    expect(await call(h.logins.chatgptStart, { method: "siwc" })).toMatchObject({
      ok: false,
      type: "internal_error",
      message: "host_id_unavailable",
    })
    expect(kv.values.get(Kv.chatgptAgentHost)).toBe(stored)
    expect(h.logs.join("\n")).toContain("chatgpt_host_id_unavailable")
  })

  test("a re-login reuses the account's client, needs the same user and keeps the registration", async () => {
    const { h } = await setup()
    await using _h = h
    const first = await added(h)
    const clientId = auth.clients.at(-1)
    const superseded = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")

    // The same user, a callback without client_id: the saved id is used, no agent name is sent.
    const again = await signIn(h, NADIA, { accountID: first.account.id }, { clientID: null })
    const query = auth.authorizations.at(-1)
    expect(query?.get("client_id")).toBe(clientId ?? "missing")
    expect(query?.has("agent_name_hint")).toBe(false)
    expect(again.page.status).toBe(200)
    expect(await status(h, again.started.attemptID)).toMatchObject({ phase: "authorized" })
    const completed = await call(h.logins.chatgptComplete, { attemptID: again.started.attemptID })
    expect(completed).toMatchObject({ ok: true, output: { reauthenticated: true, account: { id: first.account.id } } })
    expect(await h.deps.runtime.credentials.inspect(first.account)).toMatchObject({ generation: 2, clientId })

    // Another ChatGPT user on the same client is refused by the account guard, and its tokens are revoked.
    const other = await signIn(h, OTHER, { accountID: first.account.id })
    expect(other.page.status).toBe(400)
    expect(await status(h, other.started.attemptID)).toEqual({ phase: "failed", error: "account_mismatch" })
    const refused = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")
    await until(() => (auth.revocations.some((item) => item.token === refused) ? true : undefined))
    // The family the re-login replaced shares the new one's user and client, so it is left alone, not revoked.
    expect(auth.revocations.some((item) => item.token === superseded)).toBe(false)

    // A callback naming another client is refused before any exchange; the stored tokens stay.
    const exchanges = auth.requests.filter((request) => request.path === "/api/accounts/oauth/token").length
    const mismatch = await signIn(h, NADIA, { accountID: first.account.id }, { clientID: "oaiapp_someoneelse" })
    expect(mismatch.page.status).toBe(400)
    expect(await status(h, mismatch.started.attemptID)).toEqual({ phase: "failed", error: "client_mismatch" })
    expect(auth.requests.filter((request) => request.path === "/api/accounts/oauth/token")).toHaveLength(exchanges)
    expect(await h.deps.runtime.credentials.inspect(first.account)).toMatchObject({ generation: 2, clientId })
  })

  test("logins never cross kinds: no codex duplicate, no siwc re-login of a codex account or the reverse", async () => {
    const { h } = await setup()
    await using _h = h
    const started = await start(h)
    const callback = auth.authorize(started.authorizeURL, NADIA)
    const clientId = new URL(callback).searchParams.get("client_id") ?? ""
    // A codex account that happens to carry the same fingerprint.
    const codex = await h.modules.slots.createAccount({
      id: "acc_codexsame" as Account.ID,
      kind: "codex",
      label: "Codex",
      identity: { chatgptAccountId: "acct-x", fingerprint: Hash.fingerprint(clientId, NADIA.sub) },
      cacheDomain: { scope: "chatgpt_login", externalId: "acct-x" },
      quotaDomain: { scope: "chatgpt_seat", externalId: "acct-x" },
      status: "ready",
    })
    if (!codex.ok) throw new Error("seed failed")
    expect((await fetch(callback)).status).toBe(200)
    const authorized = await status(h, started.attemptID)
    expect(authorized.phase).toBe("authorized")
    expect(authorized.duplicateOf).toBeUndefined()
    const completed = await call(h.logins.chatgptComplete, { attemptID: started.attemptID })
    expect(completed).toMatchObject({ ok: true, output: { reauthenticated: false, account: { kind: "siwc" } } })
    expect(await h.deps.runtime.credentials.inspect(codex.account)).toMatchObject({ ok: false })

    expect(await call(h.logins.chatgptStart, { method: "siwc", accountID: codex.account.id })).toMatchObject({
      ok: false,
      type: "account_not_found",
    })
    const siwc = completed.ok ? completed.output.account.id : ("missing" as Account.ID)
    expect(await call(h.logins.chatgptStart, { method: "browser", accountID: siwc })).toMatchObject({
      ok: false,
      type: "account_not_found",
    })
  })

  test("a missing sharing scope fails; the consent retry asks again on the same client", async () => {
    const { h } = await setup()
    await using _h = h
    const registered = auth.clients.length
    const denied = await signIn(h, NADIA, {}, { grantSharing: false })
    expect(denied.page.status).toBe(400)
    expect(await status(h, denied.started.attemptID)).toEqual({ phase: "failed", error: "token_sharing_not_granted" })
    const clientId = new URL(denied.callback).searchParams.get("client_id") ?? "missing"
    // The refused token response is revoked: nothing keeps it.
    const discarded = auth.issued.at(-1)?.refreshToken ?? "missing"
    await until(() => (auth.revocations.some((item) => item.token === hashSecret(discarded)) ? true : undefined))

    const retried = await signIn(h, NADIA, { consent: true, retryOf: denied.started.attemptID })
    const query = auth.authorizations.at(-1)
    expect(query?.get("prompt")).toBe("consent")
    expect(query?.get("client_id")).toBe(clientId)
    expect(query?.has("agent_name_hint")).toBe(false)
    expect(retried.page.status).toBe(200)
    expect(await status(h, retried.started.attemptID)).toMatchObject({ phase: "authorized" })
    expect(auth.clients.length - registered).toBe(1)
    const completed = await call(h.logins.chatgptComplete, { attemptID: retried.started.attemptID })
    if (!completed.ok) throw new Error("complete failed")
    expect(h.modules.slots.account(completed.output.account.id)?.identity.fingerprint).toBe(
      Hash.fingerprint(clientId, NADIA.sub),
    )

    // A completed attempt's client belongs to its account now: a start naming it registers anew.
    const after = await signIn(h, NADIA, { retryOf: retried.started.attemptID })
    expect(auth.authorizations.at(-1)?.get("client_id")).toBe("dynamic_agent_client")
    expect(after.page.status).toBe(200)
    expect(auth.clients.length - registered).toBe(2)
  })

  test("a declined sign-in that names its client is retried on that client", async () => {
    const { h } = await setup()
    await using _h = h
    const registered = auth.clients.length
    const declined = await signIn(h, NADIA, {}, { error: "access_denied", errorNamesClient: true })
    expect(declined.page.status).toBe(400)
    expect(await status(h, declined.started.attemptID)).toEqual({ phase: "failed", error: "authorization_denied" })
    const retried = await signIn(h, NADIA, { consent: true, retryOf: declined.started.attemptID })
    expect(auth.authorizations.at(-1)?.get("client_id")).toBe(auth.clients.at(-1) ?? "missing")
    expect(retried.page.status).toBe(200)
    expect(auth.clients.length - registered).toBe(1)

    // Without a client on the declined callback there is nothing to reuse.
    const plain = await signIn(h, NADIA, {}, { error: "access_denied" })
    await signIn(h, NADIA, { consent: true, retryOf: plain.started.attemptID })
    expect(auth.authorizations.at(-1)?.get("client_id")).toBe("dynamic_agent_client")
  })

  test("a token endpoint outage keeps the attempt: reloading the callback retries the same client", async () => {
    const { h } = await setup()
    await using _h = h
    const started = await start(h)
    const callback = auth.authorize(started.authorizeURL, NADIA)
    auth.failToken(1)
    const first = await fetch(callback)
    expect(first.status).toBe(503)
    expect(await status(h, started.attemptID)).toEqual({ phase: "pending" })
    expect((await fetch(callback)).status).toBe(200)
    expect(await status(h, started.attemptID)).toMatchObject({ phase: "authorized" })
    expect(auth.clients.at(-1)).toBe(new URL(callback).searchParams.get("client_id") ?? "missing")

    const unverifiable = await start(h)
    auth.failJwks(1)
    expect((await fetch(auth.authorize(unverifiable.authorizeURL, NADIA))).status).toBe(400)
    expect(await status(h, unverifiable.attemptID)).toEqual({ phase: "failed", error: "jwks_unavailable" })
  })

  test("tokens an attempt drops after the exchange are revoked: cancel, expiry, the account guard", async () => {
    const { h } = await setup()
    await using _h = h
    const revoked = (tokens: SharingTokens | undefined) =>
      auth.revocations.some((item) => item.token === hashSecret(tokens?.refreshToken ?? "missing")) ? true : undefined

    const cancelled = await signIn(h, NADIA)
    const first = auth.issued.at(-1)
    expect(await status(h, cancelled.started.attemptID)).toMatchObject({ phase: "authorized" })
    await call(h.logins.chatgptCancel, { attemptID: cancelled.started.attemptID })
    await until(() => revoked(first))

    const idle = await signIn(h, NADIA)
    const second = auth.issued.at(-1)
    expect(revoked(second)).toBeUndefined()
    h.clock.advance(10 * 60_000)
    expect(await status(h, idle.started.attemptID)).toMatchObject({ phase: "failed", error: "expired" })
    await until(() => revoked(second))

    // Another user on a re-login passes the exchange and fails the account guard.
    const { account } = await added(h)
    const kept = auth.issued.at(-1)
    const other = await signIn(h, OTHER, { accountID: account.id })
    expect(await status(h, other.started.attemptID)).toEqual({ phase: "failed", error: "account_mismatch" })
    await until(() => revoked(auth.issued.at(-1)))
    // A completed login keeps its family.
    expect(revoked(kept)).toBeUndefined()
    await until(() => (h.logs.join("\n").includes("chatgpt_sharing_attempt_revoked") ? true : undefined))
  })

  test("a cancel while complete stores the tokens does not revoke the family complete keeps", async () => {
    const { h } = await setup()
    await using _h = h
    const login = await signIn(h, NADIA)
    const refresh = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")
    // complete has claimed the tokens and is awaiting the vault when the cancel arrives.
    const completing = call(h.logins.chatgptComplete, { attemptID: login.started.attemptID })
    await call(h.logins.chatgptCancel, { attemptID: login.started.attemptID })
    expect(await completing).toMatchObject({ ok: true })
    await Bun.sleep(200)
    expect(auth.revocations.some((item) => item.token === refresh)).toBe(false)
  })

  test("a second complete while the first stores the tokens is refused: one family, one account", async () => {
    const { h } = await setup()
    await using _h = h
    const login = await signIn(h, NADIA)
    const [first, second] = await Promise.all([
      call(h.logins.chatgptComplete, { attemptID: login.started.attemptID }),
      call(h.logins.chatgptComplete, { attemptID: login.started.attemptID }),
    ])
    expect(first).toMatchObject({ ok: true, output: { reauthenticated: false } })
    expect(second).toMatchObject({ ok: false, type: "internal_error", message: "attempt_storing" })
    expect(h.modules.slots.snapshot().accounts.filter((account) => account.kind === "siwc")).toHaveLength(1)
  })

  test("a re-login whose account is gone at complete hands its tokens back to the attempt, which revokes them", async () => {
    const { h } = await setup()
    await using _h = h
    const { account } = await added(h)
    const relogin = await signIn(h, NADIA, { accountID: account.id })
    const refresh = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")
    expect(await status(h, relogin.started.attemptID)).toMatchObject({ phase: "authorized" })
    await h.modules.slots.mutate((current) => ({
      ...current,
      accounts: current.accounts.filter((item) => item.id !== account.id),
    }))
    expect(await call(h.logins.chatgptComplete, { attemptID: relogin.started.attemptID })).toMatchObject({
      ok: false,
      type: "account_not_found",
    })
    await call(h.logins.chatgptCancel, { attemptID: relogin.started.attemptID })
    await until(() => (auth.revocations.some((item) => item.token === refresh) ? true : undefined))
  })

  test("a complete that cannot create the account discards and revokes the stored tokens", async () => {
    const kv = memoryStorage()
    const h = await harness({
      options: { endpoints },
      ctx: { storage: kv.storage },
      slots: { failCreate: "no_template" },
    })
    time.follow(h.clock)
    await using _h = h
    const login = await signIn(h, NADIA)
    const refresh = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")
    expect(await call(h.logins.chatgptComplete, { attemptID: login.started.attemptID })).toMatchObject({
      ok: false,
      type: "template_unavailable",
    })
    const stored = await h.deps.runtime.vault.list()
    expect(stored.ok && stored.ids).toEqual([])
    await until(() => (auth.revocations.some((item) => item.token === refresh) ? true : undefined))
  })

  test("cancel and expiry stop the listener", async () => {
    const { h } = await setup()
    await using _h = h
    const started = await start(h)
    expect(await call(h.logins.chatgptCancel, { attemptID: started.attemptID })).toEqual({ ok: true, output: {} })
    expect(await status(h, started.attemptID)).toEqual({ phase: "cancelled" })
    const late = await start(h)
    h.clock.advance(10 * 60_000)
    expect(await status(h, late.attemptID)).toEqual({ phase: "failed", error: "expired" })
    const exchanges = auth.requests.filter((request) => request.path === "/api/accounts/oauth/token").length
    await fetch(auth.authorize(late.authorizeURL, NADIA)).catch(() => undefined)
    expect(auth.requests.filter((request) => request.path === "/api/accounts/oauth/token")).toHaveLength(exchanges)
  })
})

describe("Sign in with ChatGPT account", () => {
  test("a due token refreshes once with the issued client and resource, gated by earliest_refresh_at", async () => {
    const { h } = await setup()
    await using _h = h
    // Every token response asks for no refresh before 58 minutes into its 60-minute life.
    earliest.at = (now) => Math.floor(now / 1000) + 58 * 60
    const { account } = await added(h)
    earliest.at = undefined
    const clientId = auth.clients.at(-1) ?? "missing"
    const first = await h.logins.headers(account, "ses_1")
    if (!first.ok) throw new Error("headers failed")

    // Due by expiry (4 minutes left) but before earliest_refresh_at: the current token stays in use.
    h.clock.advance(56 * 60_000)
    const early = await h.logins.headers(account, "ses_1")
    expect(early.ok && early.hash).toBe(first.hash)
    expect(auth.refreshCount(clientId)).toBe(0)

    h.clock.advance(3 * 60_000)
    const results = await Promise.all(Array.from({ length: 5 }, () => h.logins.headers(account, "ses_1")))
    expect(auth.refreshCount(clientId)).toBe(1)
    expect(new Set(results.map((result) => (result.ok ? result.hash : "failed"))).size).toBe(1)
    expect(results[0]?.ok && results[0].hash).not.toBe(first.hash)
    const body = new URLSearchParams(
      auth.requests.findLast((request) => request.path === "/api/accounts/oauth/token")?.body,
    )
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("client_id")).toBe(clientId)
    expect(body.get("resource")).toBe(SHARING_RESOURCE)
    expect(await h.deps.runtime.credentials.inspect(account)).toMatchObject({ generation: 2, clientId })
    expect(h.modules.slots.account(account.id)?.status).toBe("ready")
  })

  test("accounts.test reads the account catalog with the Bearer token", async () => {
    const { h } = await setup()
    await using _h = h
    const { account } = await added(h)
    const tested = await call(h.logins.test, { accountID: account.id })
    expect(tested).toMatchObject({ ok: true, output: { ok: true, status: "ready" } })
    const request = responses.requests.findLast((recorded) => recorded.path === "/v1/models")
    expect(request?.headers.authorization).toBe(hashSecret(`Bearer ${auth.issued.at(-1)?.accessToken}`))
    expect(request?.headers["chatgpt-account-id"]).toBeUndefined()
    // The test's template had none of the catalog's fallback models; the listed one was added from the catalog.
    const registry = h.modules.slots.snapshot()
    const template = registry.modelTemplates[registry.slots[account.providerID]?.modelTemplate ?? ""]
    expect(template?.models.map((model) => String(model.id))).toEqual(["gpt-5.5"])

    // Template models with the API catalog's larger window keep it: the account catalog's 400k shortens nothing
    // (upstream 209346a0fe stopped reading it, R8).
    const bundled = await Templates.bundled("siwc")
    const wide = bundled?.models.filter((model) => String(model.modelID ?? model.id) === "gpt-5.5") ?? []
    expect(wide.map((model) => model.limit.context)).toEqual([1_050_000, 1_050_000])
    await h.modules.slots.mutate((current) => {
      const id = current.slots[account.providerID]?.modelTemplate ?? ""
      const shared = current.modelTemplates[id]
      return shared && { ...current, modelTemplates: { ...current.modelTemplates, [id]: { ...shared, models: wide } } }
    })
    expect(await call(h.logins.test, { accountID: account.id })).toMatchObject({ ok: true, output: { ok: true } })
    const kept = h.modules.slots.snapshot()
    const limits = kept.modelTemplates[kept.slots[account.providerID]?.modelTemplate ?? ""]?.models.map((model) => [
      String(model.id),
      model.limit,
    ])
    expect(limits).toEqual(wide.map((model) => [String(model.id), model.limit]))
  })

  test("accounts.test: a 403 is a failed probe naming its code and forces no refresh; a 401 fails the login", async () => {
    const kv = memoryStorage()
    const h = await harness({
      options: { endpoints: { oauthIssuer: auth.url, openai: `http://127.0.0.1:${refusing.port}/v1` } },
      ctx: { storage: kv.storage },
    })
    time.follow(h.clock)
    await using _h = h
    const { account } = await added(h)
    const clientId = auth.clients.at(-1) ?? "missing"
    expect(await call(h.logins.test, { accountID: account.id })).toMatchObject({
      ok: false,
      type: "probe_failed",
      message: "subscription_sharing_user_not_eligible",
    })
    expect(h.modules.slots.account(account.id)?.status).toBe("ready")
    // The token was not marked rejected: its next use does not refresh it early.
    expect((await h.logins.headers(account, "ses_1")).ok).toBe(true)
    expect(auth.refreshCount(clientId)).toBe(0)

    Object.assign(refusal, { status: 401, code: "invalid_token" })
    expect(await call(h.logins.test, { accountID: account.id })).toMatchObject({
      ok: true,
      output: { ok: false, status: "auth_failed" },
    })
    expect((await h.logins.headers(account, "ses_1")).ok).toBe(true)
    expect(auth.refreshCount(clientId)).toBe(1)
    Object.assign(refusal, { status: 403, code: "subscription_sharing_user_not_eligible" })
  })

  test("a rejected login stays needs_reauth until a new login replaces its tokens", async () => {
    const { h } = await setup()
    await using _h = h
    const { account } = await added(h)
    expect((await h.logins.headers(account, "ses_1")).ok).toBe(true)
    await h.logins.rejected(account, "subscription_sharing_invalid_user")
    expect(await h.logins.headers(account, "ses_1")).toMatchObject({
      ok: false,
      problem: "needs_reauth",
      detail: "subscription_sharing_invalid_user",
    })
    await until(() => (h.modules.slots.account(account.id)?.status === "needs_reauth" ? true : undefined))
    // A later use still does not hand out the rejected token.
    expect((await h.logins.headers(account, "ses_1")).ok).toBe(false)

    const again = await signIn(h, NADIA, { accountID: account.id })
    expect(again.page.status).toBe(200)
    expect(await call(h.logins.chatgptComplete, { attemptID: again.started.attemptID })).toMatchObject({ ok: true })
    expect((await h.logins.headers(account, "ses_1")).ok).toBe(true)
    expect(h.modules.slots.account(account.id)?.status).toBe("ready")
  })

  test("a delete the vault refuses keeps a working login; only a delete that succeeds revokes", async () => {
    const vault = Vault.memory({ now: time.clock.now })
    const kv = memoryStorage()
    const h = await harness({ options: { endpoints }, ctx: { storage: kv.storage }, vault })
    time.follow(h.clock)
    await using _h = h
    const { account } = await added(h)
    const clientId = auth.clients.at(-1) ?? "missing"
    const refresh = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")
    vault.inject((request) => (request.op === "delete" ? { ok: false, error: "busy" } : undefined))
    expect(await h.logins.forget(account, { shred: true })).toEqual({ ok: false })
    // The account stays, and so does its token family: a due token still refreshes.
    h.clock.advance(58 * 60_000)
    expect((await h.logins.headers(account, "ses_1")).ok).toBe(true)
    expect(auth.refreshCount(clientId)).toBe(1)
    expect(auth.revocations.filter((item) => item.token === refresh)).toEqual([])

    expect(await h.logins.forget(account, { shred: true })).toEqual({ ok: true })
    const rotated = hashSecret(auth.issued.at(-1)?.refreshToken ?? "missing")
    await until(() => (auth.revocations.some((item) => item.token === rotated) ? true : undefined))
  })

  test("deleting the account revokes its refresh token in the background, retrying an outage", async () => {
    const { h } = await setup()
    await using _h = h
    const { account } = await added(h)
    const clientId = auth.clients.at(-1) ?? "missing"
    const refresh = auth.issued.at(-1)?.refreshToken ?? "missing"
    const before = auth.revocations.length
    auth.failRevoke(1)
    expect(await h.logins.forget(account, { shred: true })).toEqual({ ok: true })
    expect(await h.deps.runtime.credentials.inspect(account)).toMatchObject({ ok: false, problem: "not_found" })
    await until(() => (auth.revocations.length - before >= 2 ? true : undefined))
    expect(auth.revocations.slice(before)).toEqual([
      { token: hashSecret(refresh), hint: "refresh_token", clientID: clientId },
      { token: hashSecret(refresh), hint: "refresh_token", clientID: clientId },
    ])
    await until(() => (h.logs.join("\n").includes("chatgpt_sharing_revoked") ? true : undefined))
  })
})

describe("Sign in with ChatGPT login key (07 §5.4)", () => {
  const NOW = Date.UTC(2026, 9, 2)
  const CHATGPT_ACCOUNT = "33333333-3333-4333-8333-333333333333"
  const client = { issuer: auth.url, now: () => NOW }
  const signed = (clientId: string, claims: Readonly<Record<string, unknown>>) =>
    auth.signIDToken({
      iss: auth.url,
      aud: clientId,
      sub: NADIA.sub,
      email: NADIA.email,
      nonce: "n-login",
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
      ...claims,
    })

  test("a verified ID token with chatgpt_account_id records the login a codex account of that login has", async () => {
    const clientId = "oaiapp_loginkey"
    const token = signed(clientId, { [AUTH_CLAIM]: { chatgpt_account_id: CHATGPT_ACCOUNT, chatgpt_plan_type: "plus" } })
    const verified = await ChatgptSharing.verifyIDToken(client, token, { clientId, nonce: "n-login" })
    if (!verified.ok) throw new Error(`verify failed: ${verified.reason}`)
    const identity = ChatgptSharing.identityOf(verified.claims)
    // The codex guard fingerprint of the same ChatGPT login (chatgpt_account_id:sub).
    const codexFingerprint = Jwt.chatgpt({ idToken: token }).fingerprint
    expect(identity.login).toBe(Hash.fingerprint(CHATGPT_ACCOUNT, NADIA.sub))
    expect(identity.login).toBe(codexFingerprint ?? "missing")
    // The registration stays keyed by the issued client: never a duplicate of the codex login.
    expect(identity.fingerprint).toBe(Hash.fingerprint(clientId, NADIA.sub))
    expect(identity.fingerprint).not.toBe(identity.login)
    const codex: Preset.Member = {
      id: "acc_codexlogin" as Account.ID,
      kind: "codex",
      billing: "subscription",
      identity: { fingerprint: codexFingerprint },
    }
    const siwc: Preset.Member = { id: "acc_siwclogin" as Account.ID, kind: "siwc", billing: "subscription", identity }
    expect(Preset.loginOf(siwc)).toBe(Preset.loginOf(codex) ?? "missing")
    // Only hashes: neither the sub nor the token is stored with the identity.
    expect(JSON.stringify(identity)).not.toContain(NADIA.sub)
    expect(JSON.stringify(identity)).not.toContain(token)
  })

  test("without chatgpt_account_id the login stays unknown: a separate subscription (fail closed)", async () => {
    const clientId = "oaiapp_nologin"
    const orgOnly = signed(clientId, { organizations: [{ id: CHATGPT_ACCOUNT }] })
    const verified = await ChatgptSharing.verifyIDToken(client, orgOnly, { clientId, nonce: "n-login" })
    if (!verified.ok) throw new Error(`verify failed: ${verified.reason}`)
    const identity = ChatgptSharing.identityOf(verified.claims)
    expect(identity.login).toBeUndefined()
    expect(
      Preset.loginOf({ id: "acc_siwcnologin" as Account.ID, kind: "siwc", billing: "subscription", identity }),
    ).toBeUndefined()
  })

  test("a sign-in through the fake issuer (no chatgpt_account_id) records no login; a re-login keeps a known one", async () => {
    const { h } = await setup()
    await using _h = h
    const { account } = await added(h)
    expect(account.identity.login).toBeUndefined()
    expect(account.identity.fingerprint).toBeDefined()
    // An account that recorded its login keeps it when a later ID token does not carry the claim.
    const login = Hash.fingerprint(CHATGPT_ACCOUNT, NADIA.sub)
    await h.modules.slots.mutate((current) => ({
      ...current,
      accounts: current.accounts.map((item) =>
        item.id === account.id ? { ...item, identity: { ...item.identity, login } } : item,
      ),
    }))
    const again = await signIn(h, NADIA, { accountID: account.id })
    expect(again.page.status).toBe(200)
    expect(await call(h.logins.chatgptComplete, { attemptID: again.started.attemptID })).toMatchObject({ ok: true })
    expect(h.modules.slots.account(account.id)?.identity.login).toBe(login)
  })
})

// Sign in with ChatGPT wire code (02 §3.2c) against the fake token-sharing issuer: authorize parameters, the code
// exchange with its scope and ID token checks, ID token verification with a real RSA key set, the refresher, token
// revocation and the account model catalog. Fake tokens only; nothing here calls a real OpenAI endpoint.

import { afterAll, describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import type { Account, Credential, Registry } from "@own/protocol"
import { Hash, Refresh } from "@own/runtime"
import { ChatgptOAuth } from "../../src/credentials/oauth.js"
import { ChatgptSharing } from "../../src/credentials/sharing.js"
import { Templates } from "../../src/slots/templates.js"
import { until } from "./support.js"
import {
  SHARING_REGISTRATION_CLIENT_ID,
  SHARING_RESOURCE,
  hashSecret,
  startFakeChatGPTSharing,
  startFakeOpenAIResponses,
  type SharingUser,
} from "../e2e-kit"

const earliest = { value: undefined as number | string | undefined }
const rotation = { to: undefined as ((user: SharingUser) => SharingUser | undefined) | undefined }
const auth = startFakeChatGPTSharing({
  earliestRefreshAt: () => earliest.value,
  refreshIdToken: (user) => rotation.to?.(user),
})
const quiet = startFakeChatGPTSharing({ omitRefreshScope: true })
const responses = startFakeOpenAIResponses({
  sharingModels: [
    catalogEntry("gpt-5.5", "GPT-5.5"),
    { slug: "broken", display_name: "No window", visibility: "list", input_modalities: ["text"] },
    catalogEntry("gpt-5.6-sol", "GPT-5.6 Sol", { visibility: "hide" }),
    catalogEntry("gpt-6-astra", "GPT-6 Astra", { supported_in_api: false }),
    catalogEntry("gpt-5.6-luna", "GPT-5.6 Luna", {
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      input_modalities: ["text", "image", "audio"],
    }),
    "not an object",
  ],
})

afterAll(async () => {
  await Promise.all([auth.stop(), quiet.stop(), responses.stop()])
})

const NADIA = { sub: "user-nadia", email: "nadia@example.test", plan: "plus" }
const HOST = "urn:uuid:9b2d6b8e-3c1a-4e7f-8a52-1f0c2d3e4a5b"
const REDIRECT = "http://127.0.0.1:1455/auth/callback"
const client = (issuer = auth.url) => ({ issuer, now: () => Date.now() })

function catalogEntry(slug: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    display_name: name,
    visibility: "list",
    supported_in_api: true,
    context_window: 400_000,
    input_modalities: ["text", "image"],
    ...extra,
  }
}

/** One sign-in up to the callback: the authorize URL, the fake's callback and what the exchange needs. */
async function signIn(
  user = NADIA,
  options: { readonly clientId?: string; readonly grantSharing?: boolean; readonly issuer?: typeof auth } = {},
) {
  const issuer = options.issuer ?? auth
  const pkce = await ChatgptOAuth.pkce()
  const state = ChatgptOAuth.state()
  const nonce = ChatgptOAuth.state()
  const url = ChatgptSharing.authorizeURL(issuer.url, {
    redirect: REDIRECT,
    pkce,
    state,
    nonce,
    hostId: HOST,
    clientId: options.clientId,
  })
  const callback = new URL(issuer.authorize(url, user, { grantSharing: options.grantSharing }))
  const clientId = callback.searchParams.get("client_id") ?? options.clientId ?? ""
  return { url, callback, clientId, verifier: pkce.verifier, nonce, state }
}

/** The fake's revocations of `token`, once there is one. */
function revoked(token: string) {
  return until(() => {
    const found = auth.revocations.filter((revocation) => revocation.token === hashSecret(token))
    return found.length > 0 ? found : undefined
  })
}

async function exchanged(user = NADIA, issuer = auth) {
  const login = await signIn(user, { issuer })
  const result = await ChatgptSharing.exchange(client(issuer.url), {
    code: login.callback.searchParams.get("code") ?? "",
    clientId: login.clientId,
    redirect: REDIRECT,
    verifier: login.verifier,
    nonce: login.nonce,
  })
  if (!result.ok) throw new Error(`exchange failed: ${result.reason}`)
  return { ...login, result }
}

function account(identity: Account.Identity): Account.Info {
  // SAFETY: the refresher reads only `identity` of the account.
  return { identity } as unknown as Account.Info
}

function item(secret: ReturnType<ChatgptOAuth.Tokens["secret"]>): Credential.OAuthSecret {
  if (secret.type !== "oauth") throw new Error("not oauth")
  return {
    v: 1,
    type: "oauth",
    family: secret.family ?? "openai-chatgpt",
    access: secret.access,
    refresh: secret.refresh,
    idToken: secret.idToken,
    expiresAt: secret.expiresAt,
    obtainedAt: secret.obtainedAt ?? Date.now(),
    generation: 1,
    clientId: secret.clientId,
    scopes: secret.scopes,
    earliestRefreshAt: secret.earliestRefreshAt,
  }
}

describe("authorize URL", () => {
  test("a new registration sends dynamic_agent_client and the agent name; a re-login its issued id only", async () => {
    const pkce = await ChatgptOAuth.pkce()
    const fresh = new URL(
      ChatgptSharing.authorizeURL("https://auth.example.test", {
        redirect: REDIRECT,
        pkce,
        state: "st",
        nonce: "nn",
        hostId: HOST,
      }),
    )
    expect(fresh.origin + fresh.pathname).toBe("https://auth.example.test/api/accounts/authorize")
    expect(Object.fromEntries(fresh.searchParams)).toEqual({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Own OpenCode",
      ext_agent_host_id: HOST,
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: "st",
      nonce: "nn",
      code_challenge_method: "S256",
      code_challenge: pkce.challenge,
    })
    const again = new URL(
      ChatgptSharing.authorizeURL("https://auth.example.test", {
        redirect: REDIRECT,
        pkce,
        state: "st",
        nonce: "nn",
        hostId: HOST,
        clientId: "oaiapp_123",
        consent: true,
      }),
    )
    expect(again.searchParams.get("client_id")).toBe("oaiapp_123")
    expect(again.searchParams.has("agent_name_hint")).toBe(false)
    expect(again.searchParams.get("prompt")).toBe("consent")
  })

  test("client and host id checks", () => {
    expect(ChatgptSharing.isClientId("oaiapp_abc-DEF_123")).toBe(true)
    expect(ChatgptSharing.isClientId(SHARING_REGISTRATION_CLIENT_ID)).toBe(false)
    expect(ChatgptSharing.isClientId("oaiapp abc")).toBe(false)
    expect(ChatgptSharing.isClientId("x".repeat(201))).toBe(false)
    expect(ChatgptSharing.isClientId(undefined)).toBe(false)
    const host = ChatgptSharing.newHostId()
    expect(ChatgptSharing.isHostId(host)).toBe(true)
    expect(ChatgptSharing.isHostId("urn:uuid:not-a-uuid")).toBe(false)
    expect(ChatgptSharing.isHostId(42)).toBe(false)
  })
})

describe("code exchange", () => {
  test("exchanges with the issued client and resource, then verifies the ID token", async () => {
    const at = Math.floor(Date.now() / 1000) + 600
    earliest.value = at
    const { result, clientId } = await exchanged()
    earliest.value = undefined
    if (!result.ok) throw new Error("exchange failed")
    expect(clientId).toMatch(/^oaiapp_[0-9a-f]+$/)
    const call = auth.requests.findLast((request) => request.path === "/api/accounts/oauth/token")
    const body = new URLSearchParams(call?.body)
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("client_id")).toBe(clientId)
    expect(body.get("resource")).toBe(SHARING_RESOURCE)
    expect(body.get("redirect_uri")).toBe(REDIRECT)
    expect(result.identity).toEqual({
      chatgptAccountId: undefined,
      emailMasked: "na***@example.test",
      plan: "plus",
      fingerprint: Hash.fingerprint(clientId, NADIA.sub),
    })
    const secret = result.tokens.secret(1)
    expect(secret).toMatchObject({
      type: "oauth",
      family: "openai-chatgpt-sharing",
      clientId,
      scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
      earliestRefreshAt: at * 1000,
    })
    // Token values never serialize.
    expect(JSON.stringify(result.tokens)).toBe('"[ChatgptOAuth.Tokens]"')
    const issued = auth.issued.at(-1)
    expect(JSON.stringify(result)).not.toContain(issued?.accessToken ?? "missing")
  })

  test("a grant without the sharing scope is token_sharing_not_granted", async () => {
    const login = await signIn(NADIA, { grantSharing: false })
    const result = await ChatgptSharing.exchange(client(), {
      code: login.callback.searchParams.get("code") ?? "",
      clientId: login.clientId,
      redirect: REDIRECT,
      verifier: login.verifier,
      nonce: login.nonce,
    })
    expect(result).toEqual({ ok: false, reason: "token_sharing_not_granted", transient: false })
    // Nothing keeps the refused token response: its family ends at the issuer.
    const refresh = auth.issued.at(-1)?.refreshToken ?? "missing"
    expect(await revoked(refresh)).toEqual([
      { token: hashSecret(refresh), hint: "refresh_token", clientID: login.clientId },
    ])
  })

  test("token endpoint failures: a 5xx is transient, a bad code is final, a wrong nonce is an invalid ID token", async () => {
    const login = await signIn()
    const input = {
      code: login.callback.searchParams.get("code") ?? "",
      clientId: login.clientId,
      redirect: REDIRECT,
      verifier: login.verifier,
      nonce: login.nonce,
    }
    auth.failToken(1)
    expect(await ChatgptSharing.exchange(client(), input)).toEqual({
      ok: false,
      reason: "server_error",
      transient: true,
    })
    expect(await ChatgptSharing.exchange(client(), { ...input, nonce: "another-attempt" })).toEqual({
      ok: false,
      reason: "id_token_invalid",
      transient: false,
    })
    expect(await revoked(auth.issued.at(-1)?.refreshToken ?? "missing")).toHaveLength(1)
    // The code was used by the call above.
    expect(await ChatgptSharing.exchange(client(), input)).toEqual({
      ok: false,
      reason: "invalid_grant",
      transient: false,
    })
  })
})

describe("ID token verification", () => {
  const now = () => Math.floor(Date.now() / 1000)
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: auth.url,
    aud: "oaiapp_verify",
    sub: "user-verify",
    nonce: "nonce-1",
    iat: now(),
    exp: now() + 600,
    ...overrides,
  })
  const verify = (token: string, expected: { readonly clientId?: string; readonly nonce?: string } = {}) =>
    ChatgptSharing.verifyIDToken(client(), token, { clientId: "oaiapp_verify", nonce: "nonce-1", ...expected })

  test("a valid token yields the identity claims", async () => {
    const result = await verify(auth.signIDToken(claims({ email: "v@example.test" })))
    expect(result).toMatchObject({
      ok: true,
      claims: {
        sub: "user-verify",
        email: "v@example.test",
        fingerprint: Hash.fingerprint("oaiapp_verify", "user-verify"),
      },
    })
    // A refresh-time check has no nonce to compare.
    expect((await verify(auth.signIDToken(claims({ nonce: undefined })), { nonce: undefined })).ok).toBe(true)
  })

  test("profile claims of an unexpected type do not block a valid identity", async () => {
    const odd = claims({
      email: null,
      organizations: [{ name: "no id" }],
      "https://api.openai.com/auth": { chatgpt_plan_type: null },
    })
    expect(await verify(auth.signIDToken(odd))).toMatchObject({
      ok: true,
      claims: {
        sub: "user-verify",
        email: undefined,
        plan: undefined,
        accountId: undefined,
        fingerprint: Hash.fingerprint("oaiapp_verify", "user-verify"),
      },
    })
  })

  test("the invalid-token matrix", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["missing sub", auth.signIDToken(claims({ sub: undefined }))],
      ["blank sub", auth.signIDToken(claims({ sub: "   " }))],
      ["wrong nonce", auth.signIDToken(claims({ nonce: "other" }))],
      ["missing nonce", auth.signIDToken(claims({ nonce: undefined }))],
      ["wrong audience", auth.signIDToken(claims({ aud: "oaiapp_other" }))],
      ["wrong issuer", auth.signIDToken(claims({ iss: "https://auth.openai.com" }))],
      ["no exp", auth.signIDToken(claims({ exp: undefined }))],
      ["no iat", auth.signIDToken(claims({ iat: undefined }))],
      ["expired", auth.signIDToken(claims({ iat: now() - 7200, exp: now() - 3600 }))],
      ["another azp", auth.signIDToken(claims({ azp: "oaiapp_other" }))],
      ["forged key", auth.signIDToken(claims(), { forged: true })],
      ["not a JWT", "not-a-jwt"],
    ]
    for (const [name, token] of cases)
      expect({ name, result: await verify(token) }).toEqual({ name, result: { ok: false, reason: "id_token_invalid" } })
    expect((await verify(auth.signIDToken(claims({ azp: "oaiapp_verify", aud: ["oaiapp_verify"] })))).ok).toBe(true)
  })

  test("a key set that cannot be fetched is jwks_unavailable, not an invalid identity", async () => {
    auth.failJwks(1)
    expect(await verify(auth.signIDToken(claims()))).toEqual({ ok: false, reason: "jwks_unavailable" })
    expect(
      await ChatgptSharing.verifyIDToken(client("http://127.0.0.1:9"), auth.signIDToken(claims()), {
        clientId: "oaiapp_verify",
      }),
    ).toEqual({ ok: false, reason: "jwks_unavailable" })
    // An issuer that is no URL fails the same way instead of throwing out of the callback.
    expect(
      await ChatgptSharing.verifyIDToken(client("not a url"), auth.signIDToken(claims()), {
        clientId: "oaiapp_verify",
      }),
    ).toEqual({ ok: false, reason: "jwks_unavailable" })
  })
})

describe("refresher", () => {
  test("refreshes with the issued client id and resource and reports the response metadata", async () => {
    const { result, clientId } = await exchanged()
    if (!result.ok) throw new Error("exchange failed")
    earliest.value = "2031-01-01T00:00:00Z"
    const refreshed = await ChatgptSharing.refresher(client(), account(result.identity))(item(result.tokens.secret(1)))
    earliest.value = undefined
    expect(refreshed).toMatchObject({
      type: "tokens",
      scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
      earliestRefreshAt: Date.parse("2031-01-01T00:00:00Z"),
      idToken: undefined,
    })
    const body = new URLSearchParams(
      auth.requests.findLast((request) => request.path === "/api/accounts/oauth/token")?.body,
    )
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: hashSecret(auth.issued.at(-2)?.refreshToken ?? ""),
      resource: SHARING_RESOURCE,
    })
    expect(auth.refreshCount(clientId)).toBe(1)
  })

  test("a rotated ID token must name the account's user; another sub is account_mismatch", async () => {
    const { result } = await exchanged()
    if (!result.ok) throw new Error("exchange failed")
    const refresh = ChatgptSharing.refresher(client(), account(result.identity))
    rotation.to = (user) => user
    const same = await refresh(item(result.tokens.secret(1)))
    expect(same).toMatchObject({ type: "tokens", idToken: auth.issued.at(-1)?.idToken ?? "missing" })
    if (same.type !== "tokens") throw new Error("refresh failed")
    rotation.to = () => ({ sub: "user-other", email: "other@example.test" })
    expect(await refresh({ ...item(result.tokens.secret(1)), refresh: same.refresh })).toEqual({
      type: "permanent",
      reason: "account_mismatch",
    })
    rotation.to = undefined
  })

  test("a refresh without scope keeps the stored scopes (the coordinator merges an absent value)", async () => {
    const { result } = await exchanged(NADIA, quiet)
    if (!result.ok) throw new Error("exchange failed")
    const refreshed = await ChatgptSharing.refresher(
      client(quiet.url),
      account(result.identity),
    )(item(result.tokens.secret(1)))
    expect(refreshed).toMatchObject({ type: "tokens", scopes: undefined, earliestRefreshAt: undefined })
  })

  test("dead families and missing client ids are permanent; a 5xx is transient", async () => {
    const { result, clientId } = await exchanged()
    if (!result.ok) throw new Error("exchange failed")
    const current = item(result.tokens.secret(1))
    const refresh = ChatgptSharing.refresher(client(), account(result.identity))
    expect(await refresh({ ...current, clientId: undefined })).toEqual({
      type: "permanent",
      reason: "client_id_missing",
    })
    expect(await refresh({ ...current, clientId: SHARING_REGISTRATION_CLIENT_ID })).toEqual({
      type: "permanent",
      reason: "client_id_missing",
    })
    auth.failToken(1)
    expect(await refresh(current)).toEqual({ type: "transient", reason: "server_error" })
    expect((await refresh(current)).type).toBe("tokens")
    // The rotated-away refresh token is reused: the family is dead.
    expect(await refresh(current)).toEqual({ type: "permanent", reason: "refresh_token_reused" })
    const other = await exchanged()
    if (!other.result.ok) throw new Error("exchange failed")
    auth.expire(other.clientId)
    expect(
      await ChatgptSharing.refresher(client(), account(other.result.identity))(item(other.result.tokens.secret(1))),
    ).toEqual({ type: "permanent", reason: "invalid_grant" })
    expect(clientId).not.toBe(other.clientId)
  })

  test("earliest_refresh_at parses like the token endpoint sends it", () => {
    expect(Refresh.earliestOf(1_900_000_000)).toBe(1_900_000_000_000)
    expect(Refresh.earliestOf("2031-01-01T00:00:00Z")).toBe(Date.parse("2031-01-01T00:00:00Z"))
  })
})

describe("revocation", () => {
  test("revokes the refresh token with its client id, retrying network and 5xx failures at most twice", async () => {
    const { result, clientId } = await exchanged()
    if (!result.ok) throw new Error("exchange failed")
    const token = item(result.tokens.secret(1)).refresh
    const before = auth.revocations.length
    expect(await ChatgptSharing.revoke(client(), { token, clientId })).toBe(true)
    expect(auth.revocations.slice(before)).toEqual([
      { token: hashSecret(token), hint: "refresh_token", clientID: clientId },
    ])
    // The family is gone at the issuer.
    expect(
      (await ChatgptSharing.refresher(client(), account(result.identity))(item(result.tokens.secret(1)))).type,
    ).toBe("permanent")

    auth.failRevoke(2)
    const retried = auth.revocations.length
    expect(await ChatgptSharing.revoke(client(), { token, clientId })).toBe(true)
    expect(auth.revocations.length - retried).toBe(3)

    auth.failRevoke(3)
    const exhausted = auth.revocations.length
    expect(await ChatgptSharing.revoke(client(), { token, clientId })).toBe(false)
    expect(auth.revocations.length - exhausted).toBe(3)
    expect(await ChatgptSharing.revoke(client("http://127.0.0.1:9"), { token, clientId })).toBe(false)
    // Three retried revocations wait 500 + 1,000 ms each (linear backoff): about 4.5 s before any work, so Bun's 5 s
    // default ran out on a loaded PC (2026-10-17).
  }, 20_000)
})

describe("account model catalog", () => {
  test("reads {models:[…]}, keeps listed API models and drops malformed entries one by one", async () => {
    const result = await ChatgptSharing.fetchModels(responses.baseURL, { authorization: "Bearer at_fake_catalog" })
    if (!result.ok) throw new Error(`catalog failed: ${result.reason}`)
    expect(result.models.map((model) => model.slug)).toEqual(["gpt-5.5", "gpt-5.6-luna"])
    const request = responses.requests.findLast((recorded) => recorded.path === "/v1/models")
    expect(request?.headers.authorization).toBe(hashSecret("Bearer at_fake_catalog"))
    expect(await ChatgptSharing.fetchModels(responses.baseURL, {})).toMatchObject({ ok: false, status: 401 })
    expect(await ChatgptSharing.fetchModels("http://127.0.0.1:9/v1", {})).toEqual({
      ok: false,
      reason: "network_error",
    })
  })

  test("never shortens a template model to the account catalog's window (upstream 209346a0fe, R8)", async () => {
    const result = await ChatgptSharing.fetchModels(responses.baseURL, { authorization: "Bearer at_fake_catalog" })
    if (!result.ok) throw new Error("catalog failed")
    const bundled = await Templates.bundled("siwc")
    if (!bundled) throw new Error("no bundled siwc template")
    expect(bundled.models.find((model) => model.id === "gpt-5.5")?.limit).toEqual({
      context: 1_050_000,
      input: 922_000,
      output: 128_000,
    })
    // The catalog lists gpt-5.5 and gpt-5.6-luna with a 400k window, smaller than the template's: nothing changes.
    expect(result.models.find((model) => model.slug === "gpt-5.5")?.context_window).toBe(400_000)
    expect(ChatgptSharing.deriveModels(result.models, bundled, "2026-10-01T00:00:00Z")).toBeUndefined()
    const larger: ChatgptSharing.RemoteModel = {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      visibility: "list",
      context_window: 2_000_000,
      input_modalities: ["text"],
    }
    expect(ChatgptSharing.deriveModels([larger], bundled, "2026-10-02T00:00:00Z")).toBeUndefined()
    // A template model next to an added one keeps its window too.
    const without: Registry.ModelTemplate = {
      ...bundled,
      models: bundled.models.filter((model) => model.id !== "gpt-5.6-luna"),
    }
    const derived = ChatgptSharing.deriveModels(result.models, without, "2026-10-01T00:00:00Z")
    expect(derived?.models.find((model) => model.id === "gpt-5.5")?.limit).toEqual(
      bundled.models.find((model) => model.id === "gpt-5.5")?.limit,
    )
  })

  test("derives only the fallback models a template lacks", async () => {
    const result = await ChatgptSharing.fetchModels(responses.baseURL, { authorization: "Bearer at_fake_catalog" })
    if (!result.ok) throw new Error("catalog failed")
    const bundled = await Templates.bundled("siwc")
    if (!bundled) throw new Error("no bundled siwc template")
    const without: Registry.ModelTemplate = {
      ...bundled,
      models: bundled.models.filter((model) => model.id !== "gpt-5.6-luna"),
    }
    const derived = ChatgptSharing.deriveModels(result.models, without, "2026-10-01T00:00:00Z")
    expect(derived?.capturedAt).toBe("2026-10-01T00:00:00Z")
    expect(derived?.models.map((model) => String(model.id))).toEqual([
      ...without.models.map((model) => String(model.id)),
      "gpt-5.6-luna",
    ])
    expect(derived?.models.at(-1)).toMatchObject({
      id: Model.ID.make("gpt-5.6-luna"),
      name: "GPT-5.6 Luna",
      package: "@opencode/ai/providers/openai",
      settings: { compaction: { type: "summary" } },
      capabilities: { input: ["text", "image"] },
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
      cost: [],
      limit: { context: 400_000, output: 32_000 },
    })
  })
})

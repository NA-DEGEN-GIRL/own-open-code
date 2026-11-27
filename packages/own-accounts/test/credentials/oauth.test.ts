// The token-endpoint refresher's outcome classification (02 §3.5 F5) and the probe URLs (02 §3.3), against a stub
// server. Fake tokens only.

import { afterAll, describe, expect, test } from "bun:test"
import type { Account, Credential } from "@own/protocol"
import { Hash } from "@own/runtime"
import { ChatgptOAuth } from "../../src/credentials/oauth.js"
import { Probe } from "../../src/credentials/probe.js"
import { Endpoints } from "../../src/endpoints.js"
import { chatGPTAccount, mintChatGPTTokens } from "../e2e-kit"

const NOW = Date.UTC(2026, 8, 27, 3, 0, 0)
const replies: Array<{ readonly status: number; readonly body: unknown }> = []
const bodies: string[] = []
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    bodies.push(await request.text())
    const reply = replies.shift() ?? { status: 500, body: {} }
    return Response.json(reply.body, { status: reply.status })
  },
})

afterAll(() => stub.stop(true))

const user = chatGPTAccount({ accountID: "acct-oauth", userID: "user-oauth" })
// The refresher reads only the account's identity (the guard fingerprint).
const account = {
  id: "acc_TEST" as Account.ID,
  identity: { chatgptAccountId: "acct-oauth", fingerprint: Hash.fingerprint("acct-oauth", "user-oauth") },
} as Account.Info
const current: Credential.OAuthSecret = {
  v: 1,
  type: "oauth",
  family: "openai-chatgpt",
  access: "old-access",
  refresh: "rt_fake_old",
  expiresAt: NOW,
  obtainedAt: NOW - 3_600_000,
  generation: 3,
}
const refresh = ChatgptOAuth.refresher({ issuer: `http://127.0.0.1:${stub.port}`, now: () => NOW }, account)

function tokenBody(tokens = mintChatGPTTokens(user, NOW, 3_600_000)) {
  return {
    status: 200,
    body: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      id_token: tokens.idToken,
      expires_in: 3600,
    },
  }
}

describe("ChatgptOAuth.refresher", () => {
  test("new tokens come back with the access token's expiry; the request is upstream's form", async () => {
    replies.push(tokenBody())
    const outcome = await refresh(current)
    expect(outcome).toMatchObject({ type: "tokens", expiresAt: Math.floor((NOW + 3_600_000) / 1000) * 1000 })
    const form = new URLSearchParams(bodies.at(-1))
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt_fake_old",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    })
  })

  test("dead families are permanent; server trouble is transient", async () => {
    const cases: Array<[number, unknown, string, string]> = [
      [400, { error: "invalid_grant", error_description: "bad" }, "permanent", "invalid_grant"],
      [401, { error: { code: "refresh_token_reused", message: "used" } }, "permanent", "refresh_token_reused"],
      [401, { error: { code: "refresh_token_invalidated" } }, "permanent", "refresh_token_invalidated"],
      [403, {}, "permanent", "http_403"],
      [503, {}, "transient", "http_503"],
      [429, { error: "slow_down" }, "transient", "slow_down"],
    ]
    for (const [status, body, type, reason] of cases) {
      replies.push({ status, body })
      expect(await refresh(current)).toEqual({ type, reason } as never)
    }
    const offline = ChatgptOAuth.refresher({ issuer: "http://127.0.0.1:1", now: () => NOW }, account)
    expect(await offline(current)).toEqual({ type: "transient", reason: "network_error" })
  })

  test("tokens of another ChatGPT user are refused (account guard)", async () => {
    replies.push(tokenBody(mintChatGPTTokens(chatGPTAccount({ accountID: "acct-oauth", userID: "user-else" }), NOW, 1)))
    expect(await refresh(current)).toEqual({ type: "permanent", reason: "account_mismatch" })
  })

  test("Tokens never serialize their values", () => {
    const tokens = new ChatgptOAuth.Tokens({
      access: "a-secret",
      refresh: "r-secret",
      idToken: "i-secret",
      expiresAt: 1,
    })
    expect(JSON.stringify({ tokens })).toBe('{"tokens":"[ChatgptOAuth.Tokens]"}')
    expect(Bun.inspect(tokens)).not.toContain("secret")
  })
})

describe("Probe.target", () => {
  const endpoints = Endpoints.resolve()
  test("uses the kind's probe path on the production endpoints", () => {
    expect(Probe.target({ kind: "oai", endpoints })).toBe("https://api.openai.com/v1/models")
    expect(Probe.target({ kind: "anth", endpoints })).toBe("https://api.anthropic.com/v1/models?limit=1")
    expect(Probe.target({ kind: "ds", endpoints })).toBe("https://api.deepseek.com/user/balance")
    expect(Probe.target({ kind: "xai", endpoints })).toBe("https://api.x.ai/v1/api-key")
    expect(Probe.target({ kind: "or", endpoints })).toBe("https://openrouter.ai/api/v1/key")
  })

  test("compat needs a usable http(s) base URL", () => {
    expect(Probe.target({ kind: "compat", endpoints })).toBeUndefined()
    expect(Probe.target({ kind: "compat", endpoints, baseURL: "not a url" })).toBeUndefined()
    expect(Probe.target({ kind: "compat", endpoints, baseURL: "file:///c:/x" })).toBeUndefined()
    expect(Probe.target({ kind: "compat", endpoints, baseURL: "http://127.0.0.1:9/v1/" })).toBe(
      "http://127.0.0.1:9/v1/models",
    )
  })
})

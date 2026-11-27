import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Credential, Kind } from "../src/index.js"
import { roundTrip } from "./fixtures.js"

// Fake values only.
const tokens = {
  id_token: "fake.id.token",
  access_token: "fake.access.token",
  refresh_token: "fake-refresh-token",
  account_id: "00000000-0000-4000-8000-000000000000",
}

describe("vault items", () => {
  test("decode the 02 §2.4.5 oauth and key shapes", () => {
    const oauth = {
      v: 1,
      type: "oauth",
      family: "openai-chatgpt",
      access: "fake-access",
      refresh: "fake-refresh",
      idToken: "fake-id",
      expiresAt: 1790000000000,
      obtainedAt: 1789990000000,
      generation: 7,
    }
    const key = { v: 1, type: "key", key: "fake-key", generation: 1 }
    expect(roundTrip(Credential.VaultItem, oauth)).toEqual(oauth)
    expect(roundTrip(Credential.VaultItem, key)).toEqual(key)
    expect(Credential.VaultItem.guards.oauth(Schema.decodeUnknownSync(Credential.VaultItem)(oauth))).toBe(true)
    expect(() => Schema.decodeUnknownSync(Credential.VaultItem)({ ...key, key: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Credential.VaultItem)({ ...key, v: 2 })).toThrow()
  })
})

describe("Sign in with ChatGPT token family", () => {
  const legacy = {
    v: 1,
    type: "oauth",
    family: "openai-chatgpt",
    access: "fake-access",
    refresh: "fake-refresh",
    expiresAt: 1790000000000,
    obtainedAt: 1789990000000,
    generation: 3,
  }
  const sharing = {
    ...legacy,
    family: "openai-chatgpt-sharing",
    idToken: "fake.id.token",
    clientId: "oaiapp_fake0123",
    scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
    earliestRefreshAt: 1789993600000,
  }
  const decode = Schema.decodeUnknownSync(Credential.VaultItem)

  test("items written before the token-sharing fields existed still decode unchanged", () => {
    expect(roundTrip(Credential.VaultItem, legacy)).toEqual(legacy)
    const item = decode(legacy)
    expect(Credential.VaultItem.guards.oauth(item) && [item.clientId, item.scopes, item.earliestRefreshAt]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  test("the sharing family keeps its non-secret metadata through decode and encode", () => {
    expect(roundTrip(Credential.VaultItem, sharing)).toEqual(sharing)
    expect(roundTrip(Credential.OAuthSecret, sharing)).toEqual(sharing)
  })

  test("unknown families and malformed metadata are rejected", () => {
    expect(() => decode({ ...legacy, family: "openai-api" })).toThrow()
    expect(() => decode({ ...sharing, scopes: "openid profile" })).toThrow()
    expect(() => decode({ ...sharing, earliestRefreshAt: -1 })).toThrow()
    expect(() => decode({ ...sharing, clientId: 7 })).toThrow()
  })

  test("each OAuth kind has its own family", () => {
    expect(Object.keys(Credential.familyOf).sort()).toEqual([...Kind.OAuth.literals].sort())
    expect(Credential.familyOf.codex).toBe("openai-chatgpt")
    expect(Credential.familyOf.siwc).toBe("openai-chatgpt-sharing")
    expect(new Set(Object.values(Credential.familyOf))).toEqual(new Set(Credential.OAuthFamily.literals))
  })
})

describe("codex-multi-provider sources", () => {
  const authFile = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: "2026-09-26T10:11:12.123456789Z",
  }

  test("the old app's auth.json decodes without keeping unknown fields", () => {
    const decoded = Schema.decodeUnknownSync(Credential.CodexAuthFile)({ ...authFile, extra: "ignored" })
    expect(Object.keys(decoded)).not.toContain("extra")
    expect(decoded.tokens?.refresh_token).toBe("fake-refresh-token")
  })

  test("only ChatGPT files with a full token set can back an account", () => {
    const decode = Schema.decodeUnknownSync(Credential.CodexChatgptAuthFile)
    expect(decode(authFile).tokens.access_token).toBe("fake.access.token")
    expect(() => decode({ ...authFile, auth_mode: "apikey" })).toThrow()
    expect(() => decode({ ...authFile, tokens: null })).toThrow()
    expect(() => decode({ ...authFile, tokens: { ...tokens, refresh_token: "" } })).toThrow()
    expect(
      Schema.decodeUnknownSync(Credential.CodexAuthFile)({ auth_mode: "apikey", OPENAI_API_KEY: "fake" }).tokens,
    ).toBeUndefined()
  })

  test("a missing auth_mode resolves like Codex CLI: apikey with OPENAI_API_KEY, chatgpt otherwise", () => {
    const { auth_mode: _, ...legacy } = authFile
    const decoded = Schema.decodeUnknownSync(Credential.CodexAuthFile)(legacy)
    expect(Credential.codexAuthMode(decoded)).toBe("chatgpt")
    expect(Schema.decodeUnknownSync(Credential.CodexChatgptAuthFile)(legacy).tokens.id_token).toBe(tokens.id_token)
    expect(Credential.codexAuthMode({ OPENAI_API_KEY: "fake" })).toBe("apikey")
    expect(Credential.codexAuthMode({ auth_mode: "chatgptAuthTokens" })).toBe("chatgptAuthTokens")
  })

  test("state.json is read for profile ids and aliases only", () => {
    const state = Schema.decodeUnknownSync(Credential.CodexStateFile)({
      version: 3,
      profiles: [
        { id: "a1a1a1a1-0000-4000-8000-000000000001", alias: "personal", home: "C:\\x", usage: { windows: [] } },
        { id: "b2b2b2b2-0000-4000-8000-000000000002", alias: null, auth_mode: "chatgpt", login_state: "ready" },
      ],
      shortcuts: [],
    })
    expect(state.profiles.map((profile) => profile.alias ?? null)).toEqual(["personal", null])
    expect(Object.keys(state.profiles[0])).toEqual(["id", "alias"])
  })

  test("import modes are linked (default) and takeover", () => {
    expect(Credential.CodexImportMode.literals).toEqual(["linked", "takeover"])
  })
})

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Hash, Home, Jwt, Redact } from "../src/index.js"
import {
  ACCOUNT_A,
  AUTH_CLAIM,
  chatgptTokens,
  fakeJwt,
  PROFILE_CLAIM,
  SHARING_CLIENT,
  SHARING_ISSUER,
  sharingTokens,
} from "./fixture.js"

describe("Hash", () => {
  test("canonical JSON ignores key order, drops undefined members and sorts integer-like keys as strings", () => {
    const a = { b: 1, a: { d: [1, undefined, "x"], c: null }, 10: true, 2: false, skip: undefined }
    const b = { 2: false, a: { c: null, d: [1, undefined, "x"] }, 10: true, b: 1 }
    expect(Hash.canonical(a)).toBe('{"10":true,"2":false,"a":{"c":null,"d":[1,null,"x"]},"b":1}')
    expect(Hash.canonical(b)).toBe(Hash.canonical(a))
    expect(Hash.stable(a)).toBe(Hash.stable(b))
    expect(Hash.canonical(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"')
    expect(Hash.stable({ a: 1 })).not.toBe(Hash.stable({ a: 2 }))
  })

  test("short hashes and the C5 fingerprint are deterministic", () => {
    expect(Hash.short("abc")).toBe("ba7816bf")
    expect(Hash.short("abc", 12)).toBe("ba7816bf8f01")
    expect(Hash.fingerprint("acct", "sub")).toBe(`sha256:${Hash.sha256("acct:sub")}`)
  })

  test("header hashing is independent of order and name case", () => {
    const one = Hash.headers({ Authorization: "Bearer x", "session-id": "s" })
    const two = Hash.headers(
      new Headers([
        ["session-id", "s"],
        ["authorization", "Bearer x"],
      ]),
    )
    expect(one).toBe(two)
    expect(
      Hash.headers([
        ["authorization", "Bearer y"],
        ["session-id", "s"],
      ]),
    ).not.toBe(one)
  })

  test("auth hashes cover Authorization and x-api-key only", () => {
    const hashes = Hash.auth({ Authorization: "Bearer fake", "x-api-key": "fake-key", originator: "opencode" })
    expect(hashes).toEqual([
      { name: "authorization", hash: Hash.short("Bearer fake") },
      { name: "x-api-key", hash: Hash.short("fake-key") },
    ])
  })

  test("key hints show a known prefix and the last four characters", () => {
    expect(Hash.keyHint("sk-ant-api03-FAKEFAKEFAKE9fQ2")).toBe("sk-ant-…9fQ2")
    expect(Hash.keyHint("sk-proj-fakefakefakeab12")).toBe("sk-proj-…ab12")
    expect(Hash.keyHint("xai-fakefakefakefake1234")).toBe("xai-…1234")
    expect(Hash.keyHint("plainfakekey0001")).toBe("…0001")
    expect(Hash.keyHint("sk-short")).toBe("sk-…")
  })
})

describe("Redact", () => {
  const jwt = fakeJwt({ sub: "fake" })

  test("text replaces secrets with hash markers and keeps the Bearer scheme", () => {
    const input = `Authorization: Bearer ${"a".repeat(32)} key=sk-ant-${"b".repeat(24)} other=sk-${"c".repeat(24)} xai-${"d".repeat(24)} jwt=${jwt}`
    const output = Redact.text(input)
    expect(output).toContain(`Bearer ${Redact.marker("a".repeat(32))}`)
    expect(output).toContain(Redact.marker(`sk-ant-${"b".repeat(24)}`))
    expect(output).toContain(Redact.marker(`sk-${"c".repeat(24)}`))
    expect(output).toContain(Redact.marker(`xai-${"d".repeat(24)}`))
    expect(output).toContain(Redact.marker(jwt))
    expect(output).not.toContain("aaaaaaaaaaaaaaaa")
    expect(output).not.toContain(jwt)
    expect(Redact.text("usage_limit_reached after 3 retries")).toBe("usage_limit_reached after 3 retries")
  })

  test("value removes OAuth token fields wherever they appear, including the old app's auth.json", () => {
    const body = {
      access_token: "opaque-access",
      refresh_token: "opaque-refresh",
      id_token: jwt,
      expires_in: 3600,
      nested: [{ tokens: { access_token: "x", account_id: "acct" } }],
      message: `failed with Bearer ${"z".repeat(20)}`,
      key: "usage-row-group",
    }
    const redacted = Redact.value(body)
    expect(JSON.stringify(redacted)).not.toContain("opaque-")
    expect(JSON.stringify(redacted)).not.toContain(jwt)
    expect(redacted).toMatchObject({
      access_token: Redact.marker("opaque-access"),
      expires_in: 3600,
      nested: [{ tokens: { access_token: Redact.marker("x"), account_id: "acct" } }],
      key: "usage-row-group",
    })
    const cyclic: Record<string, unknown> = { name: "loop" }
    cyclic.self = cyclic
    expect(Redact.value(cyclic)).toEqual({ name: "loop", self: "[circular]" })
    expect(Redact.value(new Error(`bad token ${jwt}`))).toEqual({
      name: "Error",
      message: `bad token ${Redact.marker(jwt)}`,
    })
  })

  test("headers and findings never return credential values", () => {
    expect(
      Redact.headers({
        Authorization: "Bearer secret-value-123",
        "x-api-key": "k",
        "x-codex-primary-used-percent": "12.5",
      }),
    ).toEqual({
      authorization: Redact.marker("Bearer secret-value-123"),
      "x-api-key": Redact.marker("k"),
      "x-codex-primary-used-percent": "12.5",
    })
    const findings = Redact.findings({ ok: "fine", tokens: { refresh_token: "r" }, log: [`value ${jwt}`] })
    expect(findings).toEqual([
      { path: "tokens.refresh_token", reason: "secret field" },
      { path: "log[0]", reason: "JWT" },
    ])
    expect(JSON.stringify(findings)).not.toContain(jwt)
  })
})

describe("Jwt", () => {
  test("reads ChatGPT identity claims without verifying", () => {
    const tokens = chatgptTokens(ACCOUNT_A, Date.UTC(2026, 9, 1))
    const claims = Jwt.chatgpt({ idToken: tokens.idToken, accessToken: tokens.accessToken })
    expect(claims).toMatchObject({
      accountId: ACCOUNT_A.accountId,
      sub: ACCOUNT_A.sub,
      email: ACCOUNT_A.email,
      plan: "plus",
      expiresAt: Date.UTC(2026, 9, 1),
      fingerprint: Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub),
    })
  })

  test("account id falls back like upstream: top-level claim, auth namespace, first organization, access token", () => {
    expect(
      Jwt.chatgpt({ idToken: fakeJwt({ chatgpt_account_id: "top", [AUTH_CLAIM]: { chatgpt_account_id: "ns" } }) })
        .accountId,
    ).toBe("top")
    expect(Jwt.chatgpt({ idToken: fakeJwt({ organizations: [{ id: "org-1" }] }) }).accountId).toBe("org-1")
    expect(
      Jwt.chatgpt({
        idToken: fakeJwt({ sub: "s" }),
        accessToken: fakeJwt({ [AUTH_CLAIM]: { chatgpt_account_id: "from-access" } }),
      }).accountId,
    ).toBe("from-access")
  })

  test("malformed tokens give no claims instead of throwing", () => {
    expect(Jwt.payload("not-a-jwt")).toBeUndefined()
    expect(Jwt.payload("a.b")).toBeUndefined()
    expect(Jwt.payload(`x.${Buffer.from("[1,2]").toString("base64url")}.y`)).toBeUndefined()
    expect(Jwt.chatgpt({ idToken: "garbage", accessToken: fakeJwt({ exp: "soon" }) })).toEqual({})
  })

  test("reads a Sign in with ChatGPT identity keyed by the issued client id and sub", () => {
    const tokens = sharingTokens(ACCOUNT_A, Date.UTC(2026, 9, 1))
    const identity = Jwt.sharing({ idToken: tokens.idToken, clientId: SHARING_CLIENT })
    expect(identity).toEqual({
      sub: ACCOUNT_A.sub,
      email: ACCOUNT_A.email,
      plan: undefined,
      accountId: undefined,
      issuer: SHARING_ISSUER,
      audience: [SHARING_CLIENT],
      authorizedParty: undefined,
      nonce: "fake-nonce",
      expiresAt: Date.UTC(2026, 9, 1),
      fingerprint: Hash.fingerprint(SHARING_CLIENT, ACCOUNT_A.sub),
    })
    // One user with two registrations (one per workspace) gets two fingerprints.
    expect(Jwt.sharing({ idToken: tokens.idToken, clientId: "oaiapp_other" }).fingerprint).not.toBe(
      identity.fingerprint,
    )
    expect(identity.fingerprint).not.toBe(Jwt.chatgpt({ idToken: tokens.idToken }).fingerprint)
  })

  test("sharing claims: audience lists, profile e-mail, optional plan and blank subjects", () => {
    const token = fakeJwt({
      sub: "user-1",
      aud: [SHARING_CLIENT, "other"],
      azp: SHARING_CLIENT,
      [PROFILE_CLAIM]: { email: "p@example.test" },
      [AUTH_CLAIM]: { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-1" },
    })
    expect(Jwt.sharing({ idToken: token, clientId: SHARING_CLIENT })).toMatchObject({
      audience: [SHARING_CLIENT, "other"],
      authorizedParty: SHARING_CLIENT,
      email: "p@example.test",
      plan: "pro",
      accountId: "acct-1",
      fingerprint: Hash.fingerprint(SHARING_CLIENT, "user-1"),
    })
    const blank = Jwt.sharing({ idToken: fakeJwt({ sub: "  ", aud: SHARING_CLIENT }), clientId: SHARING_CLIENT })
    expect([blank.sub, blank.fingerprint]).toEqual([undefined, undefined])
    expect(Jwt.sharing({ idToken: fakeJwt({ sub: "user-1" }), clientId: "" }).fingerprint).toBeUndefined()
    expect(Jwt.sharing({ idToken: "garbage", clientId: SHARING_CLIENT })).toEqual({
      sub: undefined,
      email: undefined,
      plan: undefined,
      accountId: undefined,
      issuer: undefined,
      audience: [],
      authorizedParty: undefined,
      nonce: undefined,
      expiresAt: undefined,
      fingerprint: undefined,
    })
    // A malformed identity claim gives no identity rather than a partial one.
    expect(Jwt.sharing({ idToken: fakeJwt({ sub: "user-1", aud: 7 }), clientId: SHARING_CLIENT }).sub).toBeUndefined()
    expect(Jwt.sharing({ idToken: fakeJwt({ sub: "user-1", azp: 7 }), clientId: SHARING_CLIENT }).sub).toBeUndefined()
    expect(Jwt.sharing({ idToken: fakeJwt({ sub: "user-1", nonce: null }), clientId: SHARING_CLIENT })).toMatchObject({
      sub: undefined,
      nonce: undefined,
      fingerprint: undefined,
    })
  })

  test("sharing claims: a profile claim of an unexpected type drops only itself", () => {
    const identity = (claims: Record<string, unknown>) =>
      Jwt.sharing({ idToken: fakeJwt({ sub: "user-1", nonce: "n-1", ...claims }), clientId: SHARING_CLIENT })
    const kept = { sub: "user-1", nonce: "n-1", fingerprint: Hash.fingerprint(SHARING_CLIENT, "user-1") }
    expect(identity({ email: null, [AUTH_CLAIM]: { chatgpt_plan_type: "plus" } })).toMatchObject({
      ...kept,
      email: undefined,
      plan: "plus",
    })
    expect(identity({ email: "e@example.test", [AUTH_CLAIM]: { chatgpt_plan_type: null } })).toMatchObject({
      ...kept,
      email: "e@example.test",
      plan: undefined,
    })
    expect(identity({ [AUTH_CLAIM]: "not an object", [PROFILE_CLAIM]: { email: 5 } })).toMatchObject({
      ...kept,
      email: undefined,
      plan: undefined,
    })
    expect(identity({ organizations: [{ name: "no id" }] })).toMatchObject({ ...kept, accountId: undefined })
    expect(identity({ organizations: "none", chatgpt_account_id: 42 })).toMatchObject({ ...kept, accountId: undefined })
    expect(identity({ organizations: [{ id: "org-1" }] })).toMatchObject({ ...kept, accountId: "org-1" })
  })

  test("sharing login: the Codex fingerprint of an explicit chatgpt_account_id and sub, else unknown", () => {
    const codex = chatgptTokens(ACCOUNT_A, Date.UTC(2026, 9, 1))
    const codexLogin = Jwt.chatgpt({ idToken: codex.idToken, accessToken: codex.accessToken }).fingerprint
    // The same ChatGPT login signed in through Sign in with ChatGPT: equal to the codex account's fingerprint.
    const sameLogin = fakeJwt({
      sub: ACCOUNT_A.sub,
      aud: SHARING_CLIENT,
      [AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT_A.accountId },
    })
    const shared = Jwt.sharing({ idToken: sameLogin, clientId: SHARING_CLIENT })
    expect(shared.login).toBe(Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub))
    expect(shared.login).toBe(codexLogin ?? "missing")
    // The registration key stays the issued client's, so the guard never treats the two logins as one account.
    expect(shared.fingerprint).toBe(Hash.fingerprint(SHARING_CLIENT, ACCOUNT_A.sub))
    expect(shared.fingerprint).not.toBe(shared.login)
    // The top-level claim counts as well.
    const top = fakeJwt({ sub: ACCOUNT_A.sub, chatgpt_account_id: ACCOUNT_A.accountId })
    expect(Jwt.sharing({ idToken: top, clientId: SHARING_CLIENT }).login).toBe(codexLogin ?? "missing")
    // Another workspace of the same user is another login.
    const other = fakeJwt({ sub: ACCOUNT_A.sub, chatgpt_account_id: "acct-other" })
    expect(Jwt.sharing({ idToken: other, clientId: SHARING_CLIENT }).login).not.toBe(codexLogin)

    // Fail closed: no account id claim (the first organization is not one), no sub, or a malformed claim.
    const unknown = (claims: Record<string, unknown>) =>
      Jwt.sharing({ idToken: fakeJwt({ aud: SHARING_CLIENT, ...claims }), clientId: SHARING_CLIENT }).login
    expect(unknown({ sub: ACCOUNT_A.sub })).toBeUndefined()
    expect(unknown({ sub: ACCOUNT_A.sub, organizations: [{ id: ACCOUNT_A.accountId }] })).toBeUndefined()
    expect(unknown({ chatgpt_account_id: ACCOUNT_A.accountId })).toBeUndefined()
    expect(unknown({ sub: "  ", chatgpt_account_id: ACCOUNT_A.accountId })).toBeUndefined()
    expect(unknown({ sub: ACCOUNT_A.sub, chatgpt_account_id: 7 })).toBeUndefined()
    expect(unknown({ sub: ACCOUNT_A.sub, [AUTH_CLAIM]: { chatgpt_account_id: "" } })).toBeUndefined()
    expect(Jwt.sharing({ idToken: "garbage", clientId: SHARING_CLIENT }).login).toBeUndefined()
    // The login is a hash: neither the account id nor the sub appears in it.
    expect(shared.login).not.toContain(ACCOUNT_A.sub)
    expect(shared.login).not.toContain(ACCOUNT_A.accountId)
  })

  test("masks e-mails for display", () => {
    expect(Jwt.maskEmail("nadia@example.test")).toBe("na***@example.test")
    expect(Jwt.maskEmail("ab@x.test")).toBe("a***@x.test")
    expect(Jwt.maskEmail("nope")).toBe("***")
  })
})

describe("Home", () => {
  test("resolves OWN_HOME from the option, then OWN_HOME, then the platform default", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", OWN_HOME: "D:\\own-home" }
    expect(Home.resolve({ home: "E:\\dev-home", env, platform: "win32" })).toBe("E:\\dev-home")
    expect(Home.resolve({ env, platform: "win32" })).toBe("D:\\own-home")
    expect(Home.resolve({ env: { ...env, OWN_HOME: "" }, platform: "win32" })).toBe(
      "C:\\Users\\me\\AppData\\Local\\own-open-code",
    )
    expect(Home.resolve({ env: {}, platform: "win32", homedir: "C:\\Users\\me" })).toBe(
      "C:\\Users\\me\\AppData\\Local\\own-open-code",
    )
    expect(Home.resolve({ env: { XDG_DATA_HOME: "/data" }, platform: "linux" })).toBe("/data/own-open-code")
    expect(Home.resolve({ env: {}, platform: "linux", homedir: "/home/me" })).toBe(
      "/home/me/.local/share/own-open-code",
    )
  })

  test("lays out the 01 §5.1 files and partitions months in UTC", () => {
    const root = path.join("X:", "own")
    const layout = Home.layout(root)
    expect(layout.registryLock).toBe(path.join(root, "locks", "registry.lock"))
    expect(layout.limits).toBe(path.join(root, "state", "limits.json"))
    expect(layout.vaultExe).toBe(path.join(root, "app", "current", "own-vault.exe"))
    expect(layout.ratecardsSeed).toBe(path.join(root, "app", "current", "templates", "ratecards.default.json"))
    expect(Home.month(Date.UTC(2026, 8, 30, 23, 59))).toBe("2026-09")
    expect(Home.month(Date.UTC(2026, 9, 1, 0, 0))).toBe("2026-10")
  })
})

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto"
import { AUTH_CLAIM } from "../fixtures/chatgpt-tokens"
import { startFake, type FakeInternals, type FakeOptions, type FakeProvider } from "./fake-server"
import { hashSecret, jsonResponse } from "./shared"

/** First sign-in registers a new client with this placeholder id. */
export const SHARING_REGISTRATION_CLIENT_ID = "dynamic_agent_client"
export const SHARING_RESOURCE = "https://api.openai.com/v1"
export const SHARING_SCOPE = "chatgpt.tokens.use.direct"
const BASE_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke"]
const KEY_ID = "fake-sharing-1"

export interface SharingUser {
  /** The ID token `sub`. */
  readonly sub: string
  readonly email: string
  readonly plan?: string
}

export interface SharingAuthorizeOptions {
  /** `client_id` on the callback instead of the issued one; `null` leaves it out (a reauthorization may). */
  readonly clientID?: string | null
  /** Whether the user allowed plan usage (`chatgpt.tokens.use.direct` in the granted scope). Default true. */
  readonly grantSharing?: boolean
  /** The callback carries `error=<value>` instead of a code (the user declined). */
  readonly error?: string
  /** With `error`: the declined callback still names the client the registration created. */
  readonly errorNamesClient?: boolean
}

export interface FakeChatGPTSharingOptions extends Omit<FakeOptions, "credentials" | "cache" | "responder"> {
  /** Access token lifetime. Default one hour. */
  readonly accessTtlMs?: number
  /** `earliest_refresh_at` of each token response, as OpenAI sends it (number = epoch seconds, string = ISO). */
  readonly earliestRefreshAt?: (now: number) => number | string | undefined
  /** Refresh responses leave out `scope` (the client keeps the previous scopes). */
  readonly omitRefreshScope?: boolean
  /**
   * Refresh responses carry a newly signed ID token for the user this returns (the family's own user, or another one
   * to test the identity check); `undefined` sends none, the default.
   */
  readonly refreshIdToken?: (user: SharingUser) => SharingUser | undefined
}

/** One token family the fake handed out; values are fake and only for secret scans and assertions. */
export interface SharingTokens {
  readonly clientID: string
  readonly sub: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly idToken: string
}

export interface FakeChatGPTSharing extends FakeProvider {
  /** `GET /.well-known/jwks.json`. */
  readonly jwksURL: string
  /** Query of every authorize URL the fake "opened", oldest first. */
  readonly authorizations: readonly URLSearchParams[]
  /** Issued client ids (`oaiapp_…`), oldest first. */
  readonly clients: readonly string[]
  /** Every token family handed out (exchanges and refreshes), oldest first. */
  readonly issued: readonly SharingTokens[]
  /** Revocation requests (`token` hashed), oldest first. */
  readonly revocations: readonly { readonly token: string; readonly hint?: string; readonly clientID?: string }[]
  /**
   * Plays the browser for a sign-in: "opens" the authorize URL (validating its parameters), signs in as `user` and
   * returns the callback URL (`redirect_uri?code=…&state=…&client_id=…&scope=…`) the browser would load next.
   */
  authorize(authorizeURL: string, user: SharingUser, options?: SharingAuthorizeOptions): string
  /** Successful refresh grants of one issued client. */
  refreshCount(clientID: string): number
  /** Every refresh token of the client's families is refused from now on (`invalid_grant`). */
  expire(clientID: string): void
  /** The next `count` token-endpoint calls answer `status` (default 503) without consuming anything. */
  failToken(count: number, status?: number): void
  /** The next `count` revocations answer 503. */
  failRevoke(count: number): void
  /** The next `count` key-set requests answer 503. */
  failJwks(count: number): void
  /** Signs an ID token with the published key, or with a key outside the key set (`forged`). */
  signIDToken(claims: Readonly<Record<string, unknown>>, options?: { readonly forged?: boolean }): string
}

interface Code {
  readonly clientID: string
  readonly user: SharingUser
  readonly redirect: string
  readonly challenge: string
  readonly nonce: string
  readonly scopes: readonly string[]
}

interface Refresh {
  readonly clientID: string
  readonly user: SharingUser
  readonly scopes: readonly string[]
  readonly family: string
  used: boolean
}

/**
 * Fake Sign in with ChatGPT issuer (`auth.openai.com` token sharing): dynamic client registration through
 * {@link FakeChatGPTSharing.authorize}, `POST /api/accounts/oauth/token` (`authorization_code` and rotating
 * `refresh_token` grants, both requiring `resource`), `POST /api/accounts/oauth/revoke`, and a JWKS with a real RSA
 * key, so ID tokens verify like the real ones (issuer = this fake's origin, audience = the issued client id). A reused
 * refresh token answers `refresh_token_reused` and ends its family. Token values are hashed in recordings.
 */
export function startFakeChatGPTSharing(options: FakeChatGPTSharingOptions = {}): FakeChatGPTSharing {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const forged = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const accessTtlMs = options.accessTtlMs ?? 3_600_000
  const codes = new Map<string, Code>()
  const refreshes = new Map<string, Refresh>()
  const revoked = new Set<string>()
  const expired = new Set<string>()
  const owners = new Map<string, SharingUser>()
  const refreshCounts = new Map<string, number>()
  const authorizations: URLSearchParams[] = []
  const clients: string[] = []
  const issued: SharingTokens[] = []
  const revocations: Array<{ readonly token: string; readonly hint?: string; readonly clientID?: string }> = []
  const failures = { token: 0, tokenStatus: 503, revoke: 0, jwks: 0 }

  const fake: FakeProvider & FakeInternals = startFake({
    name: "chatgpt-sharing",
    basePath: "",
    options,
    defaultCache: {},
    redactBody: (_url, body) =>
      body.replace(
        /((?:^|&)(?:code|code_verifier|refresh_token|token)=)([^&]+)/g,
        (_match, key: string, value: string) => key + hashSecret(decodeURIComponent(value)),
      ),
    async handle(context) {
      const path = context.url.pathname
      if (context.request.method === "GET" && path === "/.well-known/jwks.json") {
        if (failures.jwks > 0) {
          failures.jwks -= 1
          return { response: jsonResponse(503, { error: "temporarily_unavailable" }) }
        }
        const jwk = key.publicKey.export({ format: "jwk" })
        return { response: jsonResponse(200, { keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] }) }
      }
      if (context.request.method !== "POST") return { response: jsonResponse(404, { error: "not_found" }) }
      const form = new URLSearchParams(context.body)
      if (path === "/api/accounts/oauth/revoke") {
        const token = form.get("token") ?? ""
        revocations.push({
          token: hashSecret(token),
          hint: form.get("token_type_hint") ?? undefined,
          clientID: form.get("client_id") ?? undefined,
        })
        if (failures.revoke > 0) {
          failures.revoke -= 1
          return { response: jsonResponse(503, { error: "temporarily_unavailable" }) }
        }
        const family = refreshes.get(token)?.family
        if (family) revoked.add(family)
        return { response: new Response(null, { status: 200 }) }
      }
      if (path !== "/api/accounts/oauth/token") return { response: jsonResponse(404, { error: "not_found" }) }
      if (failures.token > 0) {
        failures.token -= 1
        return { response: jsonResponse(failures.tokenStatus, { error: "server_error" }) }
      }
      if (form.get("resource") !== SHARING_RESOURCE)
        return { response: oauthError(400, "invalid_target", "The resource parameter is required.") }
      const clientID = form.get("client_id") ?? ""
      if (!owners.has(clientID)) return { response: oauthError(401, "invalid_client", "Unknown client.") }
      if (form.get("grant_type") === "refresh_token") {
        const presented = form.get("refresh_token") ?? ""
        const current = refreshes.get(presented)
        if (!current || current.clientID !== clientID || revoked.has(current.family) || expired.has(clientID))
          return { response: oauthError(400, "invalid_grant", "The refresh token is invalid.") }
        if (current.used) {
          revoked.add(current.family)
          return { response: oauthError(400, "refresh_token_reused", "The refresh token was already used.") }
        }
        current.used = true
        refreshCounts.set(clientID, (refreshCounts.get(clientID) ?? 0) + 1)
        const rotated = options.refreshIdToken?.(current.user)
        const tokens = mint(clientID, rotated ?? current.user, current.scopes, current.family, undefined)
        return {
          identity: `sharing:${clientID}`,
          response: tokenResponse(tokens, current.scopes, !options.omitRefreshScope, rotated !== undefined),
        }
      }
      if (form.get("grant_type") !== "authorization_code")
        return { response: oauthError(400, "unsupported_grant_type") }
      const code = codes.get(form.get("code") ?? "")
      codes.delete(form.get("code") ?? "")
      if (
        !code ||
        code.clientID !== clientID ||
        code.redirect !== form.get("redirect_uri") ||
        code.challenge !== s256(form.get("code_verifier") ?? "")
      )
        return { response: oauthError(400, "invalid_grant", "Invalid authorization code.") }
      const tokens = mint(clientID, code.user, code.scopes, randomBytes(8).toString("hex"), code.nonce)
      return { identity: `sharing:${clientID}`, response: tokenResponse(tokens, code.scopes, true, true) }
    },
  })

  const idToken = (claims: Readonly<Record<string, unknown>>, signer: KeyObject) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const input = `${encode({ alg: "RS256", typ: "JWT", kid: KEY_ID })}.${encode(claims)}`
    return `${input}.${sign("sha256", Buffer.from(input), signer).toString("base64url")}`
  }

  const mint = (
    clientID: string,
    user: SharingUser,
    scopes: readonly string[],
    family: string,
    nonce: string | undefined,
  ): SharingTokens => {
    const issuedAt = Math.floor(fake.clock.now() / 1000)
    const tokens: SharingTokens = {
      clientID,
      sub: user.sub,
      accessToken: `at_sharing_${randomBytes(18).toString("base64url")}`,
      refreshToken: `rt_sharing_${randomBytes(18).toString("base64url")}`,
      idToken: idToken(
        {
          iss: fake.url,
          aud: clientID,
          sub: user.sub,
          email: user.email,
          ...(user.plan ? { [AUTH_CLAIM]: { chatgpt_plan_type: user.plan } } : {}),
          ...(nonce === undefined ? {} : { nonce }),
          iat: issuedAt,
          exp: issuedAt + 3600,
        },
        key.privateKey,
      ),
    }
    refreshes.set(tokens.refreshToken, { clientID, user, scopes, family, used: false })
    issued.push(tokens)
    return tokens
  }

  const tokenResponse = (
    tokens: SharingTokens,
    scopes: readonly string[],
    withScope: boolean,
    withIdToken: boolean,
  ) => {
    const earliest = options.earliestRefreshAt?.(fake.clock.now())
    return jsonResponse(200, {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      ...(withIdToken ? { id_token: tokens.idToken } : {}),
      token_type: "Bearer",
      expires_in: Math.round(accessTtlMs / 1000),
      ...(withScope ? { scope: scopes.join(" ") } : {}),
      ...(earliest === undefined ? {} : { earliest_refresh_at: earliest }),
    })
  }

  return {
    ...fake,
    jwksURL: `${fake.url}/.well-known/jwks.json`,
    authorizations,
    clients,
    issued,
    revocations,
    authorize: (authorizeURL, user, authorize = {}) => {
      const url = new URL(authorizeURL)
      const query = url.searchParams
      if (url.origin !== fake.url || url.pathname !== "/api/accounts/authorize")
        throw new Error("fake chatgpt-sharing: not this issuer's authorize URL")
      const missing = ["ext_agent_host_id", "redirect_uri", "state", "nonce", "code_challenge"].filter(
        (name) => !query.get(name),
      )
      if (
        missing.length > 0 ||
        query.get("response_type") !== "code" ||
        query.get("code_challenge_method") !== "S256" ||
        query.get("resource") !== SHARING_RESOURCE ||
        !query.get("scope")?.split(" ").includes(SHARING_SCOPE)
      )
        throw new Error(`fake chatgpt-sharing: bad authorize parameters ${missing.join(",")}`)
      authorizations.push(new URLSearchParams(query))
      const requested = query.get("client_id") ?? ""
      if (requested !== SHARING_REGISTRATION_CLIENT_ID && !owners.has(requested))
        throw new Error("fake chatgpt-sharing: unknown client id")
      const clientID = requested === SHARING_REGISTRATION_CLIENT_ID ? register(user) : requested
      const callback = new URL(query.get("redirect_uri") ?? "")
      callback.searchParams.set("state", query.get("state") ?? "")
      if (authorize.error) {
        callback.searchParams.set("error", authorize.error)
        if (authorize.errorNamesClient) callback.searchParams.set("client_id", clientID)
        return callback.toString()
      }
      const scopes = authorize.grantSharing === false ? BASE_SCOPES : [...BASE_SCOPES, SHARING_SCOPE]
      const code = `ac_sharing_${randomBytes(16).toString("hex")}`
      codes.set(code, {
        clientID,
        user,
        redirect: query.get("redirect_uri") ?? "",
        challenge: query.get("code_challenge") ?? "",
        nonce: query.get("nonce") ?? "",
        scopes,
      })
      callback.searchParams.set("code", code)
      const returned = authorize.clientID === undefined ? clientID : authorize.clientID
      if (returned !== null) callback.searchParams.set("client_id", returned)
      callback.searchParams.set("scope", scopes.join(" "))
      return callback.toString()
    },
    refreshCount: (clientID) => refreshCounts.get(clientID) ?? 0,
    expire: (clientID) => {
      expired.add(clientID)
    },
    failToken: (count, status = 503) => {
      failures.token = count
      failures.tokenStatus = status
    },
    failRevoke: (count) => {
      failures.revoke = count
    },
    failJwks: (count) => {
      failures.jwks = count
    },
    signIDToken: (claims, signing = {}) => idToken(claims, signing.forged ? forged.privateKey : key.privateKey),
  }

  function register(user: SharingUser) {
    const clientID = `oaiapp_${randomBytes(10).toString("hex")}`
    owners.set(clientID, user)
    clients.push(clientID)
    return clientID
  }
}

function oauthError(status: number, error: string, description?: string) {
  return jsonResponse(status, { error, ...(description ? { error_description: description } : {}) })
}

function s256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}

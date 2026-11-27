export * as ChatgptOAuth from "./oauth.js"

import { Option, Schema } from "effect"
import type { Account, Credential } from "@own/protocol"
import { Jwt, type Credentials, type Refresh } from "@own/runtime"

// ChatGPT OAuth, ported from upstream `core/src/plugin/provider/openai.ts` (MIT, 02 §3.2): the same public client id,
// device-code endpoints, PKCE parameters and token endpoint. The issuer root is `endpoints.oauthIssuer` so tests can
// point it at a fake. Token values stay inside {@link Tokens}; nothing here logs or returns them.

/** Upstream's public client id (02 §3.1 C6). We never impersonate another client. */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const SCOPE = "openid profile email offline_access"
/** Added to the server's poll interval, like upstream (`pollingSafetyMargin`). */
export const DEVICE_POLL_MARGIN_MS = 3_000
/** A device code is valid for 15 minutes. */
export const DEVICE_TTL_MS = 15 * 60_000
/** Browser callback ports: 1455 like Codex CLI, then 1457 (`openai.ts:15-16`). */
export const CALLBACK_PORTS: ReadonlyArray<number> = [1455, 1457]
const REQUEST_TIMEOUT_MS = 20_000

/**
 * One token set from the token endpoint. Private fields keep the values out of `JSON.stringify`, `console.log` and
 * enumeration, like `CodexSource.Secret`.
 */
export class Tokens {
  readonly #access: string
  readonly #refresh: string
  readonly #idToken: string
  /** Access token expiry, epoch ms. */
  readonly expiresAt: number
  readonly family: Credential.OAuthFamily
  /** Token sharing only (not secret): the issued client id, the granted scopes and `earliest_refresh_at` (epoch ms). */
  readonly clientId?: string
  readonly scopes?: ReadonlyArray<string>
  readonly earliestRefreshAt?: number

  constructor(input: {
    readonly access: string
    readonly refresh: string
    readonly idToken: string
    readonly expiresAt: number
    readonly family?: Credential.OAuthFamily
    readonly clientId?: string
    readonly scopes?: ReadonlyArray<string>
    readonly earliestRefreshAt?: number
  }) {
    this.#access = input.access
    this.#refresh = input.refresh
    this.#idToken = input.idToken
    this.expiresAt = input.expiresAt
    this.family = input.family ?? "openai-chatgpt"
    this.clientId = input.clientId
    this.scopes = input.scopes
    this.earliestRefreshAt = input.earliestRefreshAt
  }

  /** The vault item to store (persist-before-use, 02 §3.5 F4). */
  secret(obtainedAt: number): Extract<Credentials.NewSecret, { readonly type: "oauth" }> {
    return {
      type: "oauth",
      family: this.family,
      access: this.#access,
      refresh: this.#refresh,
      idToken: this.#idToken,
      expiresAt: this.expiresAt,
      obtainedAt,
      clientId: this.clientId,
      scopes: this.scopes,
      earliestRefreshAt: this.earliestRefreshAt,
    }
  }

  /** Non-secret facts from the token claims (02 §3.2 step 2, C5). */
  identity() {
    return identityOf(Jwt.chatgpt({ idToken: this.#idToken, accessToken: this.#access }))
  }

  toJSON() {
    return "[ChatgptOAuth.Tokens]"
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "[ChatgptOAuth.Tokens]"
  }
}

/** Registry identity of a ChatGPT login: account id, masked e-mail, plan and the guard fingerprint. */
export function identityOf(claims: Jwt.Chatgpt): Account.Identity {
  return {
    chatgptAccountId: claims.accountId,
    emailMasked: claims.email === undefined ? undefined : Jwt.maskEmail(claims.email),
    plan: claims.plan,
    fingerprint: claims.fingerprint,
  }
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  refresh_token: Schema.String.check(Schema.isMinLength(1)),
  id_token: Schema.String.check(Schema.isMinLength(1)),
  expires_in: Schema.optionalKey(Schema.Finite),
})
const DeviceCode = Schema.Struct({
  device_auth_id: Schema.String.check(Schema.isMinLength(1)),
  user_code: Schema.String.check(Schema.isMinLength(1)),
  interval: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
})
const DeviceToken = Schema.Struct({
  authorization_code: Schema.String.check(Schema.isMinLength(1)),
  code_verifier: Schema.String.check(Schema.isMinLength(1)),
})
const ErrorBody = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        code: Schema.optionalKey(Schema.NullOr(Schema.String)),
        type: Schema.optionalKey(Schema.NullOr(Schema.String)),
        message: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ]),
  ),
  error_description: Schema.optionalKey(Schema.String),
})
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeTokens = Schema.decodeUnknownOption(TokenResponse)
const decodeDevice = Schema.decodeUnknownOption(DeviceCode)
const decodeDeviceToken = Schema.decodeUnknownOption(DeviceToken)
const decodeError = Schema.decodeUnknownOption(ErrorBody)

/** Token endpoint codes that mean the refresh token family is dead (02 §3.5 F5; token sharing adds the last two). */
const PERMANENT_CODES = new Set([
  "invalid_grant",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "refresh_token_expired",
  "invalid_client",
  "unauthorized_client",
  "invalid_refresh_token",
  "token_expired",
])

export interface Client {
  readonly issuer: string
  readonly now: () => number
  readonly signal?: AbortSignal
}

export type DeviceStart =
  | { readonly ok: true; readonly deviceAuthID: string; readonly userCode: string; readonly intervalMs: number }
  | { readonly ok: false; readonly reason: string }

/** `POST <issuer>/api/accounts/deviceauth/usercode {client_id}` (02 §3.2 device step 1). */
export async function deviceStart(client: Client): Promise<DeviceStart> {
  const response = await post(client, "/api/accounts/deviceauth/usercode", "json", { client_id: CLIENT_ID })
  if (!response.ok) return { ok: false, reason: response.reason }
  const device = Option.getOrUndefined(decodeDevice(response.json))
  if (!device) return { ok: false, reason: "invalid_response" }
  const interval = Number.parseInt(String(device.interval ?? "5")) || 5
  return {
    ok: true,
    deviceAuthID: device.device_auth_id,
    userCode: device.user_code,
    intervalMs: Math.max(interval, 1) * 1000,
  }
}

export type DevicePoll =
  | { readonly type: "pending" }
  | { readonly type: "tokens"; readonly tokens: Tokens }
  | { readonly type: "failed"; readonly reason: string }

/**
 * One poll of `POST <issuer>/api/accounts/deviceauth/token` (02 §3.2 device step 3–4). 403 and 404 mean the user has
 * not finished yet; a 200 carries an authorization code that is exchanged at once with the device callback redirect.
 */
export async function devicePoll(
  client: Client,
  device: { readonly deviceAuthID: string; readonly userCode: string },
): Promise<DevicePoll> {
  const response = await post(client, "/api/accounts/deviceauth/token", "json", {
    device_auth_id: device.deviceAuthID,
    user_code: device.userCode,
  })
  if (!response.ok && (response.status === 403 || response.status === 404)) return { type: "pending" }
  if (!response.ok) return { type: "failed", reason: response.reason }
  const code = Option.getOrUndefined(decodeDeviceToken(response.json))
  if (!code) return { type: "failed", reason: "invalid_response" }
  const exchanged = await exchange(client, {
    code: code.authorization_code,
    verifier: code.code_verifier,
    redirect: `${client.issuer}/deviceauth/callback`,
  })
  if (!exchanged.ok) return { type: "failed", reason: exchanged.reason }
  return { type: "tokens", tokens: exchanged.tokens }
}

/** `POST <issuer>/oauth/token` with `grant_type=authorization_code` (`openai.ts:323-335`). */
export async function exchange(
  client: Client,
  input: { readonly code: string; readonly verifier: string; readonly redirect: string },
): Promise<{ readonly ok: true; readonly tokens: Tokens } | { readonly ok: false; readonly reason: string }> {
  const response = await post(client, "/oauth/token", "form", {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirect,
    client_id: CLIENT_ID,
    code_verifier: input.verifier,
  })
  if (!response.ok) return { ok: false, reason: response.reason }
  const tokens = tokensOf(response.json, client.now())
  if (!tokens) return { ok: false, reason: "invalid_response" }
  return { ok: true, tokens }
}

/**
 * The token-endpoint refresher for one vault OAuth account (02 §3.5). The runtime coordinator calls it with the
 * current item under the refresh lease and persists the result before anyone uses it (F2–F4). A new id token that
 * belongs to a different login is a permanent failure (C5).
 */
export function refresher(client: Omit<Client, "signal">, account: Account.Info): Refresh.Refresher {
  return async (current) => {
    const response = await post(client, "/oauth/token", "form", {
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: CLIENT_ID,
    })
    if (!response.ok)
      return response.permanent
        ? { type: "permanent", reason: response.reason }
        : { type: "transient", reason: response.reason }
    const tokens = tokensOf(response.json, client.now())
    if (!tokens) return { type: "transient", reason: "invalid_response" }
    const fingerprint = tokens.identity().fingerprint
    if (account.identity.fingerprint && fingerprint && fingerprint !== account.identity.fingerprint)
      return { type: "permanent", reason: "account_mismatch" }
    const secret = tokens.secret(client.now())
    if (secret.type !== "oauth") return { type: "transient", reason: "invalid_response" }
    return {
      type: "tokens",
      access: secret.access,
      refresh: secret.refresh,
      idToken: secret.idToken,
      expiresAt: secret.expiresAt,
    }
  }
}

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

/** PKCE pair (`openai.ts` `generatePKCE`). */
export async function pkce(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
    "base64url",
  )
  return { verifier, challenge }
}

export function state() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

/** Browser authorize URL with the upstream scope and parameters (`openai.ts:388-401`). */
export function authorizeURL(
  issuer: string,
  input: { readonly redirect: string; readonly pkce: Pkce; readonly state: string },
) {
  return `${issuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: input.redirect,
    scope: SCOPE,
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: "opencode",
  })}`
}

function tokensOf(json: unknown, now: number) {
  const body = Option.getOrUndefined(decodeTokens(json))
  if (!body) return undefined
  // The access token's `exp` is what the linked reader and the provider use; `expires_in` is the fallback.
  const exp = Jwt.chatgpt({ accessToken: body.access_token }).expiresAt
  return new Tokens({
    access: body.access_token,
    refresh: body.refresh_token,
    idToken: body.id_token,
    expiresAt: exp ?? now + (body.expires_in ?? 3600) * 1000,
  })
}

export type Posted =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly status?: number; readonly reason: string; readonly permanent: boolean }

/**
 * `POST <issuer><pathname>` with a JSON or form body. A failure carries the OAuth error code (or `http_<status>`,
 * `network_error`) and whether it is final: a dead-family code, or a 4xx other than 408/429.
 */
export async function post(
  client: Client,
  pathname: string,
  encoding: "json" | "form",
  body: Readonly<Record<string, string>>,
): Promise<Posted> {
  const signal = client.signal
    ? AbortSignal.any([client.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(`${client.issuer}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": encoding === "json" ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: encoding === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    signal,
  }).catch(() => undefined)
  if (!response) return { ok: false, reason: "network_error", permanent: false }
  const text = await response.text().catch(() => "")
  const json = Option.getOrUndefined(decodeJson(text))
  if (response.ok) return { ok: true, json }
  const code = errorCode(json)
  const reason = code ?? `http_${response.status}`
  // A dead-family code is final whatever the status; otherwise 5xx, 408 and 429 are worth retrying later and any
  // other 4xx from the token endpoint will not heal (02 §3.5 F5).
  const transient = response.status >= 500 || response.status === 408 || response.status === 429
  return { ok: false, status: response.status, reason, permanent: PERMANENT_CODES.has(reason) || !transient }
}

function errorCode(json: unknown) {
  const body = json === undefined ? undefined : Option.getOrUndefined(decodeError(json))
  if (!body?.error) return undefined
  if (typeof body.error === "string") return body.error
  return body.error.code ?? body.error.type ?? undefined
}

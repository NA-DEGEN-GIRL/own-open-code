export * as ChatgptSharing from "./sharing.js"

import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { CodexModels, Kind, type Account, type Registry } from "@own/protocol"
import { Jwt, Refresh } from "@own/runtime"
import { Templates } from "../slots/templates.js"
import { Classify } from "../telemetry/classify.js"
import { ChatgptOAuth } from "./oauth.js"

// Sign in with ChatGPT (token sharing), ported from upstream `core/src/plugin/provider/chatgpt.ts` at 0f83038253
// (MIT, 02 §3.2c): the same authorize, token and model endpoints, scope, resource and registration parameters. The
// issuer root is `endpoints.oauthIssuer` so tests can point it at a fake; `RESOURCE` is a protocol identifier and
// stays constant even when the OpenAI base URL is overridden. Token values never leave `ChatgptOAuth.Tokens`.

/** First sign-in registers a user-owned client; the callback returns its issued client id. Never stored or exchanged. */
export const REGISTRATION_CLIENT_ID = "dynamic_agent_client"
/** `agent_name_hint` of a new registration (display metadata the user may edit on the consent screen). */
export const AGENT_NAME = "Own OpenCode"
/** The scope that authorizes plan usage; a valid ID token alone does not. */
export const SHARING_SCOPE = "chatgpt.tokens.use.direct"
export const SCOPE = `openid profile email offline_access resource.invoke ${SHARING_SCOPE}`
export const RESOURCE = "https://api.openai.com/v1"
export const AUTHORIZE_PATH = "/api/accounts/authorize"
export const TOKEN_PATH = "/api/accounts/oauth/token"
export const REVOKE_PATH = "/api/accounts/oauth/revoke"
export const JWKS_PATH = "/.well-known/jwks.json"
/** Loopback redirect: only the port may vary; a registration is bound to this host and path (never `localhost`). */
export const CALLBACK_HOST = "127.0.0.1"
export const CALLBACK_PATH = "/auth/callback"
/** Ephemeral callback port by default. */
export const CALLBACK_PORTS: ReadonlyArray<number> = [0]
/** Per-app plan usage settings in ChatGPT. */
export const USAGE_URL = "https://chatgpt.com/settings/usage"
/** Fallback when the token response has no `expires_in`. */
const ACCESS_TTL_S = 3600
const JWKS_TIMEOUT_MS = 15_000
const MODELS_TIMEOUT_MS = 15_000
const CLOCK_TOLERANCE_S = 5
/** Revocation retries on network errors and 5xx, with linear backoff. */
const REVOKE_RETRIES = 2
const REVOKE_BACKOFF_MS = 500
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
/** jose codes of a key set that could not be fetched or read. */
const JWKS_CODES: ReadonlySet<string> = new Set(["ERR_JOSE_GENERIC", "ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID"])
const HOST_ID_PATTERN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** An issued client id that may be saved and used: never the registration placeholder. */
export function isClientId(value: string | undefined): value is string {
  return value !== undefined && value !== REGISTRATION_CLIENT_ID && CLIENT_ID_PATTERN.test(value)
}

/** A persisted `ext_agent_host_id` (`urn:uuid:<v4>`). */
export function isHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID_PATTERN.test(value)
}

export function newHostId() {
  return `urn:uuid:${crypto.randomUUID()}`
}

/**
 * Browser authorize URL (`chatgpt.ts` `authorizeURL`). Without a saved client id this registers a new client
 * (`dynamic_agent_client` plus `agent_name_hint`); a re-login reuses the account's issued id and sends no hint.
 * `consent` adds `prompt=consent`, only on the user's explicit retry after `token_sharing_not_granted`.
 */
export function authorizeURL(
  issuer: string,
  input: {
    readonly redirect: string
    readonly pkce: ChatgptOAuth.Pkce
    readonly state: string
    readonly nonce: string
    readonly hostId: string
    readonly clientId?: string
    readonly consent?: boolean
  },
) {
  return `${issuer}${AUTHORIZE_PATH}?${new URLSearchParams({
    client_id: input.clientId ?? REGISTRATION_CLIENT_ID,
    ...(input.clientId ? {} : { agent_name_hint: AGENT_NAME }),
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: input.redirect,
    scope: SCOPE,
    resource: RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: "S256",
    code_challenge: input.pkce.challenge,
    ...(input.consent ? { prompt: "consent" } : {}),
  })}`
}

const NonEmpty = Schema.String.check(Schema.isMinLength(1))
const TokenResponse = Schema.Struct({
  access_token: NonEmpty,
  refresh_token: NonEmpty,
  id_token: Schema.optionalKey(NonEmpty),
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
  scope: Schema.optionalKey(Schema.String),
  earliest_refresh_at: Schema.optionalKey(Schema.Unknown),
})
type TokenResponse = typeof TokenResponse.Type
const decodeTokens = Schema.decodeUnknownOption(TokenResponse)

export type Exchanged =
  | { readonly ok: true; readonly tokens: ChatgptOAuth.Tokens; readonly identity: Account.Identity }
  | {
      readonly ok: false
      readonly reason: string
      /** The token endpoint could not be reached or failed with 5xx: the same code may still be exchanged. */
      readonly transient: boolean
    }

/**
 * `POST <issuer>/api/accounts/oauth/token` with `grant_type=authorization_code` and `resource`, then the checks a
 * sign-in needs before anything is accepted: the sharing scope (`token_sharing_not_granted` otherwise), an ID token,
 * and its verification against the attempt's nonce and the issued client id. Nothing keeps a token response these
 * checks refuse, so its refresh token is revoked in the background (best effort, never awaited).
 */
export async function exchange(
  client: ChatgptOAuth.Client,
  input: {
    readonly code: string
    readonly clientId: string
    readonly redirect: string
    readonly verifier: string
    readonly nonce: string
  },
): Promise<Exchanged> {
  const response = await ChatgptOAuth.post(client, TOKEN_PATH, "form", {
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirect,
    resource: RESOURCE,
  })
  if (!response.ok) return { ok: false, reason: response.reason, transient: !response.permanent }
  const body = usable(response.json)
  if (!body) return { ok: false, reason: "invalid_response", transient: false }
  const refuse = (reason: string): Exchanged => {
    // The attempt's signal is aborted once it fails; the revocation must outlive it.
    void revoke({ issuer: client.issuer, now: client.now }, { token: body.refresh_token, clientId: input.clientId })
    return { ok: false, reason, transient: false }
  }
  const scopes = scopesOf(body.scope)
  if (!scopes?.includes(SHARING_SCOPE)) return refuse("token_sharing_not_granted")
  if (!body.id_token) return refuse("id_token_missing")
  const verified = await verifyIDToken(client, body.id_token, { clientId: input.clientId, nonce: input.nonce })
  if (!verified.ok) return refuse(verified.reason)
  return {
    ok: true,
    tokens: tokensOf(body, input.clientId, client.now(), scopes),
    identity: identityOf(verified.claims),
  }
}

export type Verified =
  | { readonly ok: true; readonly claims: Jwt.Sharing }
  /**
   * `id_token_invalid`, or `jwks_unavailable` when the key set could not be fetched or the verifier could not be set up
   * (retry later, not an identity).
   */
  | { readonly ok: false; readonly reason: "id_token_invalid" | "jwks_unavailable" }

/**
 * Verifies a Sign in with ChatGPT ID token against the issuer's JWKS (`chatgpt.ts` `verifyIDToken`): RS256, issuer,
 * audience = the issued client id, `iss`/`aud`/`exp`/`iat`/`sub` present, 5 s clock tolerance, a non-blank `sub`,
 * `azp` absent or the client id, and the attempt's `nonce` when one is given.
 */
export async function verifyIDToken(
  client: Omit<ChatgptOAuth.Client, "signal">,
  token: string,
  expected: { readonly clientId: string; readonly nonce?: string },
): Promise<Verified> {
  // A bundle without jose or an issuer that is no URL must fail the sign-in, not leave it waiting.
  const jose = await import("jose").catch(() => undefined)
  const url = URL.parse(`${client.issuer}${JWKS_PATH}`)
  if (!jose || !url) return { ok: false, reason: "jwks_unavailable" }
  const jwks = jose.createRemoteJWKSet(url, { timeoutDuration: JWKS_TIMEOUT_MS })
  const verified = await jose
    .jwtVerify(token, jwks, {
      issuer: client.issuer,
      audience: expected.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: new Date(client.now()),
    })
    .then(
      () => true as const,
      // A key set that could not be fetched or read (network, non-200, timeout, malformed set) is retryable; any other
      // jose failure (signature, claims, algorithm, unknown key) is an invalid token.
      (error: unknown) =>
        error instanceof jose.errors.JOSEError && !JWKS_CODES.has(error.code)
          ? ("id_token_invalid" as const)
          : ("jwks_unavailable" as const),
    )
  if (verified !== true) return { ok: false, reason: verified }
  const claims = Jwt.sharing({ idToken: token, clientId: expected.clientId })
  if (claims.sub === undefined) return { ok: false, reason: "id_token_invalid" }
  if (claims.authorizedParty !== undefined && claims.authorizedParty !== expected.clientId)
    return { ok: false, reason: "id_token_invalid" }
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) return { ok: false, reason: "id_token_invalid" }
  return { ok: true, claims }
}

/**
 * Registry identity of a token-sharing login: masked e-mail, plan, the guard fingerprint of (client id, `sub`) and the
 * ChatGPT login (`Jwt.Sharing.login`) that makes it one subscription with a `codex` account of the same login (07
 * §5.4). `sub` is kept only inside those hashes, and no token is kept. An account signed in before this build records
 * its login at its next sign-in (a re-login merges the identity); until then, and whenever the ID token lacks the
 * claims, it counts as a subscription of its own.
 */
export function identityOf(claims: Jwt.Sharing): Account.Identity {
  return {
    chatgptAccountId: claims.accountId,
    emailMasked: claims.email === undefined ? undefined : Jwt.maskEmail(claims.email),
    plan: claims.plan,
    fingerprint: claims.fingerprint,
    login: claims.login,
  }
}

/**
 * The token-endpoint refresher of one `siwc` vault account (02 §3.5): `grant_type=refresh_token` with the item's
 * issued client id and `resource`, serialized by the runtime coordinator. Scopes absent from the response keep the
 * stored ones; `earliest_refresh_at` belongs to the new tokens. A rotated ID token comes straight from the token
 * endpoint on the back channel, so its `sub` is compared without another JWKS round trip, like the Codex refresher.
 */
export function refresher(client: Omit<ChatgptOAuth.Client, "signal">, account: Account.Info): Refresh.Refresher {
  return async (current) => {
    const clientId = current.clientId
    if (!isClientId(clientId)) return { type: "permanent", reason: "client_id_missing" }
    const response = await ChatgptOAuth.post(client, TOKEN_PATH, "form", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: current.refresh,
      resource: RESOURCE,
    })
    if (!response.ok)
      return response.permanent
        ? { type: "permanent", reason: response.reason }
        : { type: "transient", reason: response.reason }
    const body = usable(response.json)
    if (!body) return { type: "transient", reason: "invalid_response" }
    const fingerprint = body.id_token ? Jwt.sharing({ idToken: body.id_token, clientId }).fingerprint : undefined
    if (account.identity.fingerprint && fingerprint && fingerprint !== account.identity.fingerprint)
      return { type: "permanent", reason: "account_mismatch" }
    return {
      type: "tokens",
      access: body.access_token,
      refresh: body.refresh_token,
      idToken: body.id_token,
      expiresAt: expiresAt(body, client.now()),
      scopes: scopesOf(body.scope),
      earliestRefreshAt: Refresh.earliestOf(body.earliest_refresh_at),
    }
  }
}

/**
 * Ends the renewable session at the issuer (`POST /api/accounts/oauth/revoke`, `token_type_hint=refresh_token`).
 * Network errors and 5xx are retried at most {@link REVOKE_RETRIES} times; `false` means the revocation is
 * unconfirmed. The registered client stays (it is the user's), only the token family ends.
 */
export async function revoke(
  client: Omit<ChatgptOAuth.Client, "signal">,
  input: { readonly token: string; readonly clientId: string },
): Promise<boolean> {
  const attempt = async (retry: number): Promise<boolean> => {
    const response = await ChatgptOAuth.post(client, REVOKE_PATH, "form", {
      token: input.token,
      token_type_hint: "refresh_token",
      client_id: input.clientId,
    })
    if (response.ok) return true
    const retryable = response.status === undefined || response.status >= 500
    if (!retryable || retry >= REVOKE_RETRIES) return false
    await Bun.sleep(REVOKE_BACKOFF_MS * (retry + 1))
    return attempt(retry + 1)
  }
  return attempt(0)
}

// The account catalog shape of `GET /v1/models` (`chatgpt.ts` `RemoteModel`), decoded entry by entry so one malformed
// model never drops the others. `supported_in_api` is optional here: only an explicit `false` hides a model. The speed
// tier fields (02 §4.8) are kept as given and read by `tiersOf`, so their shape never drops a model.
const RemoteModel = Schema.Struct({
  slug: NonEmpty,
  display_name: Schema.String,
  visibility: Schema.String,
  supported_in_api: Schema.optionalKey(Schema.Boolean),
  context_window: Schema.Int.check(Schema.isGreaterThan(1)),
  input_modalities: Schema.Array(Schema.String),
  supported_reasoning_levels: Schema.optionalKey(Schema.Array(Schema.Struct({ effort: NonEmpty }))),
  service_tiers: Schema.optionalKey(Schema.Unknown),
  additional_speed_tiers: Schema.optionalKey(Schema.Unknown),
})
export type RemoteModel = typeof RemoteModel.Type
const decodeCatalog = Schema.decodeUnknownOption(Schema.Struct({ models: Schema.Array(Schema.Unknown) }))
const decodeRemote = Schema.decodeUnknownOption(RemoteModel)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export type Models =
  | { readonly ok: true; readonly models: ReadonlyArray<RemoteModel> }
  /** `reason`: the token-sharing code the error body names (02 §3.2c), else `http_<status>` or a transport reason. */
  | { readonly ok: false; readonly status?: number; readonly reason: string }

/**
 * The account's model catalog: `GET <baseURL>/models` with the Bearer headers (`{models:[…]}`, not `{data:[…]}`),
 * keeping listed models usable through the API in server order. Also the billing-free connection test of a `siwc`
 * account.
 */
export async function fetchModels(
  baseURL: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Models> {
  const timeout = AbortSignal.timeout(MODELS_TIMEOUT_MS)
  const response = await fetch(`${baseURL}/models`, {
    headers: { ...headers, accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => undefined)
  if (!response) return { ok: false, reason: "network_error" }
  const text = await response.text().catch(() => "")
  if (!response.ok)
    return { ok: false, status: response.status, reason: Classify.sharingCode(text) ?? `http_${response.status}` }
  const catalog = Option.getOrUndefined(decodeJson(text).pipe(Option.flatMap(decodeCatalog)))
  if (!catalog) return { ok: false, status: response.status, reason: "invalid_response" }
  return {
    ok: true,
    models: catalog.models
      .flatMap((entry) => Option.toArray(decodeRemote(entry)))
      .filter((model) => model.visibility === "list" && model.supported_in_api !== false),
  }
}

/**
 * The speed tiers an account catalog entry names (02 §4.8), read like a Codex row (`CodexModels.tiers`: `service_tiers`,
 * else the deprecated `additional_speed_tiers`) but without the Codex list's model checks; `undefined` when the entry
 * says nothing about tiers, which is what the public catalog usually does (the tiers are then offered from the
 * catalog's modes, unverified).
 */
export function tiersOf(model: RemoteModel): ReadonlyArray<CodexModels.Tier> | undefined {
  return CodexModels.entryTiers({
    slug: model.slug,
    ...(model.service_tiers === undefined ? {} : { service_tiers: model.service_tiers }),
    ...(model.additional_speed_tiers === undefined ? {} : { additional_speed_tiers: model.additional_speed_tiers }),
  })
}

/**
 * The kind template completed from an account catalog (`chatgpt.ts` `deriveModel`): fallback models the template
 * lacks but the catalog lists are added from the catalog entry (name, text/image input, reasoning efforts as
 * variants, context window; plan-billed, summary compaction). Template models are left as they are: the catalog's
 * `context_window` never shortens one. Upstream stopped reading this catalog "due to openai bugs" (209346a0fe) and
 * registers token-sharing models with the API catalog's window, which own follows (`Templates.live`, R8); an added
 * model's catalog window only stands in until the live catalog lists it. `undefined` when nothing is added, so the
 * template and its byte-identical model names stay as they are (D4, D9).
 */
export function deriveModels(
  remote: ReadonlyArray<RemoteModel>,
  template: Registry.ModelTemplate,
  capturedAt: string,
): Registry.ModelTemplate | undefined {
  const known = new Set(template.models.map((model) => String(model.id)))
  const added = remote
    .filter((model) => Templates.SHARING_MODELS.has(model.slug) && !known.has(model.slug))
    .map((model) => derive(model))
  if (added.length === 0) return undefined
  return { ...template, capturedAt, models: [...template.models, ...added] }
}

function derive(remote: RemoteModel): Registry.TemplateModel {
  const id = Model.ID.make(remote.slug)
  return {
    id,
    modelID: id,
    name: remote.display_name || remote.slug,
    package: Kind.meta.siwc.package,
    settings: { compaction: { type: "summary" } },
    capabilities: {
      tools: true,
      input: remote.input_modalities.filter((modality) => modality === "text" || modality === "image"),
      output: ["text"],
    },
    variants: (remote.supported_reasoning_levels ?? []).map((level) => ({
      id: Model.VariantID.make(level.effort),
      settings: { reasoningEffort: level.effort },
    })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: remote.context_window, output: Math.min(32_000, remote.context_window) },
  }
}

/** A decoded token response that names a Bearer token (an absent `token_type` is accepted). */
function usable(json: unknown) {
  const body = Option.getOrUndefined(decodeTokens(json))
  if (!body || (body.token_type !== undefined && body.token_type.toLowerCase() !== "bearer")) return undefined
  return body
}

function tokensOf(body: TokenResponse, clientId: string, now: number, scopes: ReadonlyArray<string>) {
  return new ChatgptOAuth.Tokens({
    family: "openai-chatgpt-sharing",
    access: body.access_token,
    refresh: body.refresh_token,
    idToken: body.id_token ?? "",
    expiresAt: expiresAt(body, now),
    clientId,
    scopes,
    earliestRefreshAt: Refresh.earliestOf(body.earliest_refresh_at),
  })
}

/** The access token is opaque for token sharing: its lifetime comes from `expires_in` only. */
function expiresAt(body: TokenResponse, now: number) {
  const seconds = body.expires_in !== undefined && body.expires_in > 0 ? body.expires_in : ACCESS_TTL_S
  return now + seconds * 1000
}

function scopesOf(scope: string | undefined) {
  return scope === undefined ? undefined : scope.split(/\s+/).filter(Boolean)
}

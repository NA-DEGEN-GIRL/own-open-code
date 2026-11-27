export * as Jwt from "./jwt.js"

import { Option, Schema } from "effect"
import { fingerprint } from "./hash.js"

/** Claim namespaces ChatGPT uses in both the id token and the access token. */
export const AUTH_CLAIM = "https://api.openai.com/auth"
export const PROFILE_CLAIM = "https://api.openai.com/profile"

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/**
 * Payload of a JWT, decoded but **not verified**. Claims describe a token; they prove nothing about it. Returns
 * `undefined` for anything that is not a three-part token with a JSON object payload.
 */
export function payload(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return undefined
  return Option.getOrUndefined(decodeObject(Buffer.from(parts[1], "base64url").toString("utf8")))
}

const OpenAIAuth = Schema.Struct({
  chatgpt_account_id: Schema.optionalKey(Schema.String),
  chatgpt_plan_type: Schema.optionalKey(Schema.String),
  chatgpt_user_id: Schema.optionalKey(Schema.String),
  user_id: Schema.optionalKey(Schema.String),
})

const ChatgptClaims = Schema.Struct({
  sub: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  exp: Schema.optionalKey(Schema.Finite),
  chatgpt_account_id: Schema.optionalKey(Schema.String),
  organizations: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
  [AUTH_CLAIM]: Schema.optionalKey(OpenAIAuth),
  [PROFILE_CLAIM]: Schema.optionalKey(Schema.Struct({ email: Schema.optionalKey(Schema.String) })),
})
type ChatgptClaims = typeof ChatgptClaims.Type

const decodeClaims = Schema.decodeUnknownOption(ChatgptClaims)

// The claims a Sign in with ChatGPT identity rests on, decoded as one set: an unexpected shape of any of them leaves
// them all absent, so the checks fail closed. Kept apart from `ChatgptClaims` so it never hides a Codex identity.
const SharingIdentity = Schema.Struct({
  sub: Schema.optionalKey(Schema.String),
  iss: Schema.optionalKey(Schema.String),
  aud: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  azp: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String),
  exp: Schema.optionalKey(Schema.Finite),
})

const decodeSharing = Schema.decodeUnknownOption(SharingIdentity)
const decodeText = Schema.decodeUnknownOption(Schema.String)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

/** Non-secret facts read from a ChatGPT token pair. Every field is absent when the tokens do not carry it. */
export interface Chatgpt {
  readonly accountId?: string
  readonly sub?: string
  readonly userId?: string
  readonly email?: string
  readonly plan?: string
  /** Access token expiry (`exp`) in epoch milliseconds. */
  readonly expiresAt?: number
  /** `sha256:` guard fingerprint when both the account id and `sub` are known (02 §3.1 C5). */
  readonly fingerprint?: string
}

/**
 * Reads the ChatGPT identity from an id token and an access token. The account id follows upstream
 * `extractAccountID` (`core/src/plugin/provider/openai.ts:403-417`): id token first, then access token, each trying
 * `chatgpt_account_id`, the auth claim namespace, then the first organization. Expiry comes from the access token.
 */
export function chatgpt(tokens: { readonly idToken?: string; readonly accessToken?: string }): Chatgpt {
  const id = claims(tokens.idToken)
  const access = claims(tokens.accessToken)
  const accountId = accountIdOf(id) ?? accountIdOf(access)
  const sub = id?.sub ?? access?.sub
  const auth = id?.[AUTH_CLAIM] ?? access?.[AUTH_CLAIM]
  return {
    accountId,
    sub,
    userId: auth?.chatgpt_user_id ?? auth?.user_id,
    email: id?.email ?? access?.[PROFILE_CLAIM]?.email,
    plan: id?.[AUTH_CLAIM]?.chatgpt_plan_type ?? access?.[AUTH_CLAIM]?.chatgpt_plan_type,
    expiresAt: access?.exp === undefined ? undefined : access.exp * 1000,
    fingerprint: accountId === undefined || sub === undefined ? undefined : fingerprint(accountId, sub),
  }
}

/** Non-secret facts of a Sign in with ChatGPT (token sharing) ID token. Every field is absent when it is not carried. */
export interface Sharing {
  /** Non-blank `sub`: the user identity of the registration. */
  readonly sub?: string
  readonly email?: string
  readonly plan?: string
  readonly accountId?: string
  readonly issuer?: string
  /** `aud` as a list; a single audience becomes one entry. */
  readonly audience: ReadonlyArray<string>
  readonly authorizedParty?: string
  readonly nonce?: string
  /** ID token expiry (`exp`) in epoch milliseconds. */
  readonly expiresAt?: number
  /**
   * `sha256:` guard fingerprint of the issued client id and `sub` (02 §3.2c). An issued client is bound to one user
   * and workspace, so the client id, not the e-mail or a ChatGPT account id, keys the registration.
   */
  readonly fingerprint?: string
  /**
   * The ChatGPT login (07 §5.4 R4): the Codex guard fingerprint of `chatgpt_account_id` and `sub`, so it equals the
   * fingerprint of a `codex` account signed in as the same ChatGPT login. Only an explicit `chatgpt_account_id` claim
   * counts (the first organization is no account id); without it or without `sub` the login is unknown and the
   * account counts as a subscription of its own (fail closed). ⚠ Unverified that a real siwc ID token carries
   * `chatgpt_account_id` and the `sub` the Codex client sees (T1.33 spot check).
   */
  readonly login?: string
}

/**
 * Reads the identity of a Sign in with ChatGPT ID token issued to `clientId`. This only decodes the claims: call it
 * after the token was verified (signature, issuer, audience, expiry and nonce are checked by own-accounts). The
 * profile claims (e-mail, plan, account id) are read one by one: a claim of an unexpected type drops only itself and
 * never the identity. The access token is opaque for token sharing and is never read.
 */
export function sharing(input: { readonly idToken: string; readonly clientId: string }): Sharing {
  const decoded = payload(input.idToken) ?? {}
  const value = Option.getOrUndefined(decodeSharing(decoded))
  const sub = value?.sub?.trim() ? value.sub : undefined
  const aud = value?.aud
  const auth = record(decoded[AUTH_CLAIM])
  const chatgptAccountId = text(decoded.chatgpt_account_id) ?? text(auth?.chatgpt_account_id)
  return {
    sub,
    email: text(decoded.email) ?? text(record(decoded[PROFILE_CLAIM])?.email),
    plan: text(auth?.chatgpt_plan_type),
    accountId: chatgptAccountId ?? text(record(Option.getOrUndefined(decodeList(decoded.organizations))?.[0])?.id),
    issuer: value?.iss,
    audience: aud === undefined ? [] : typeof aud === "string" ? [aud] : aud,
    authorizedParty: value?.azp,
    nonce: value?.nonce,
    expiresAt: value?.exp === undefined ? undefined : value.exp * 1000,
    fingerprint: sub === undefined || !input.clientId ? undefined : fingerprint(input.clientId, sub),
    login: sub === undefined || !chatgptAccountId ? undefined : fingerprint(chatgptAccountId, sub),
  }
}

/** Masks an e-mail for display: `nadia@example.test` → `na***@example.test` (02 §2.4.1 `emailMasked`). */
export function maskEmail(email: string) {
  const at = email.lastIndexOf("@")
  if (at <= 0) return "***"
  const local = email.slice(0, at)
  return `${local.slice(0, local.length > 2 ? 2 : 1)}***${email.slice(at)}`
}

function claims(token: string | undefined) {
  if (!token) return undefined
  const decoded = payload(token)
  return decoded === undefined ? undefined : Option.getOrUndefined(decodeClaims(decoded))
}

function accountIdOf(value: ChatgptClaims | undefined) {
  return value?.chatgpt_account_id ?? value?.[AUTH_CLAIM]?.chatgpt_account_id ?? value?.organizations?.[0]?.id
}

function text(value: unknown) {
  return Option.getOrUndefined(decodeText(value))
}

function record(value: unknown) {
  return Option.getOrUndefined(decodeRecord(value))
}

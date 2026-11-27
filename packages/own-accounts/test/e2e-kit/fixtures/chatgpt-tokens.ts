import { randomBytes } from "node:crypto"

/** Claim namespace ChatGPT uses for account data in both the id token and the access token. */
export const AUTH_CLAIM = "https://api.openai.com/auth"
export const PROFILE_CLAIM = "https://api.openai.com/profile"
export const FAKE_CLIENT_ID = "app_fake_codex_client"

export interface ChatGPTAccount {
  readonly accountID: string
  readonly userID: string
  readonly email: string
  readonly plan: string
}

/** One token family as a ChatGPT login returns it. Every value is fake and unsigned. */
export interface ChatGPTTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly idToken: string
  readonly accountID: string
  /** Access token expiry, epoch milliseconds. */
  readonly expiresAt: number
}

/**
 * An unsigned JWT with the structure of a real one (`RS256` header, three segments). Only claim
 * decoding works; the signature segment is a placeholder and must never be verified.
 */
export function fakeJwt(claims: Readonly<Record<string, unknown>>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "RS256", typ: "JWT", kid: "fake" })}.${encode(claims)}.${Buffer.from("fake-signature").toString("base64url")}`
}

export function decodeJwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
}

export function chatGPTAccount(input: Partial<ChatGPTAccount> & { readonly accountID: string }): ChatGPTAccount {
  return {
    accountID: input.accountID,
    userID: input.userID ?? `user-${input.accountID}`,
    email: input.email ?? `${input.accountID}@example.test`,
    plan: input.plan ?? "plus",
  }
}

/** Mints a fresh fake token family for the account, shaped like a ChatGPT OAuth token response. */
export function mintChatGPTTokens(account: ChatGPTAccount, now: number, accessTtlMs: number): ChatGPTTokens {
  const issuedAt = Math.floor(now / 1000)
  const expiresAt = now + accessTtlMs
  const auth = {
    chatgpt_account_id: account.accountID,
    chatgpt_plan_type: account.plan,
    chatgpt_user_id: account.userID,
    user_id: account.userID,
  }
  return {
    accountID: account.accountID,
    expiresAt,
    idToken: fakeJwt({
      iss: "https://auth.openai.com",
      aud: [FAKE_CLIENT_ID],
      sub: account.userID,
      email: account.email,
      email_verified: true,
      [AUTH_CLAIM]: { ...auth, organizations: [], groups: [] },
      iat: issuedAt,
      auth_time: issuedAt,
      exp: issuedAt + 3600,
      jti: randomBytes(8).toString("hex"),
    }),
    accessToken: fakeJwt({
      iss: "https://auth.openai.com",
      aud: ["https://api.openai.com/v1"],
      client_id: FAKE_CLIENT_ID,
      sub: account.userID,
      scp: ["openid", "profile", "email", "offline_access"],
      [AUTH_CLAIM]: auth,
      [PROFILE_CLAIM]: { email: account.email, email_verified: true },
      iat: issuedAt,
      nbf: issuedAt,
      exp: Math.floor(expiresAt / 1000),
      jti: randomBytes(8).toString("hex"),
    }),
    refreshToken: `rt_fake_${randomBytes(18).toString("base64url")}`,
  }
}

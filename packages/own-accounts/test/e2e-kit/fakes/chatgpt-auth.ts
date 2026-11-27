import { createHash, randomBytes } from "node:crypto"
import type { ChatGPTAccount, ChatGPTTokens } from "../fixtures/chatgpt-tokens"
import type { FakeCodex } from "./codex"
import { startFake, type FakeInternals, type FakeOptions, type FakeProvider } from "./fake-server"
import { hashSecret, jsonResponse, parseJson, stringField } from "./shared"

/** Upstream's public client id (`core/src/plugin/provider/openai.ts`), which own-accounts must keep using. */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

export interface FakeChatGPTAuthOptions extends Omit<FakeOptions, "credentials" | "cache" | "responder"> {
  /** Token source: exchanged codes become `codex.login()` token families, refreshes go to `codex.refresh()`. */
  readonly codex: FakeCodex
  /** `interval` (seconds) returned by the user-code endpoint. Default 1. */
  readonly interval?: number
  /** Client id every call must carry. Default {@link CHATGPT_CLIENT_ID}. */
  readonly clientID?: string
}

type AccountInput = Partial<ChatGPTAccount> & { readonly accountID: string }

export interface FakeChatGPTAuth extends FakeProvider {
  /** `POST /oauth/token` (authorization code and refresh grants). */
  readonly tokenURL: string
  /** User codes handed out by `POST /api/accounts/deviceauth/usercode`, oldest first. */
  readonly userCodes: readonly string[]
  /** The user entered `userCode` at `/codex/device` and signed in as `account`; the next poll succeeds. */
  approve(userCode: string, account: AccountInput): void
  /** The user declined; the next poll answers 400. */
  deny(userCode: string): void
  /**
   * Plays the browser for a PKCE login: "opens" the authorize URL, signs in as `account` and returns the callback URL
   * (`redirect_uri?code=…&state=…`) the browser would load next.
   */
  authorize(authorizeURL: string, account: AccountInput): string
  /** Successful code exchanges (logins) so far. */
  exchangeCount(): number
  /** Every token family `/oauth/token` handed out (exchanges and refreshes), oldest first, for secret scans. */
  readonly issued: readonly ChatGPTTokens[]
}

interface Device {
  readonly userCode: string
  state: "pending" | "approved" | "denied"
  account?: AccountInput
}

interface Code {
  readonly account: AccountInput
  readonly redirect: string
  /** Device flow: the verifier the server handed out. Browser flow: the S256 challenge of the client's verifier. */
  readonly verifier?: string
  readonly challenge?: string
}

/**
 * Fake ChatGPT OAuth issuer (`auth.openai.com`): device-code login (`/api/accounts/deviceauth/usercode` → `/token`
 * polling, 403 while pending), browser PKCE (`/oauth/authorize` via {@link FakeChatGPTAuth.authorize}), and the token
 * endpoint (`authorization_code` and `refresh_token` grants). Tokens come from the given fake Codex backend, so a
 * login made here works against it and refreshes count in `codex.refreshCount`. Codes, verifiers and tokens are
 * hashed in recordings. Response shapes follow upstream's client (`openai.ts:169-228,323-335`); the device error
 * bodies are approximations.
 */
export function startFakeChatGPTAuth(options: FakeChatGPTAuthOptions): FakeChatGPTAuth {
  const clientID = options.clientID ?? CHATGPT_CLIENT_ID
  const devices = new Map<string, Device>()
  const codes = new Map<string, Code>()
  const userCodes: string[] = []
  const exchanges = { count: 0 }
  const issued: ChatGPTTokens[] = []
  const codex = options.codex

  const fake: FakeProvider & FakeInternals = startFake({
    name: "chatgpt-auth",
    basePath: "",
    options: { ...options, clock: options.clock ?? codex.clock },
    defaultCache: {},
    redactBody: (_url, body) =>
      body.replace(
        /((?:code|code_verifier|refresh_token|authorization_code|device_auth_id|user_code)"?\s*[:=]\s*"?)([^"&\s,}]+)/g,
        (_match, key: string, value: string) => key + hashSecret(value),
      ),
    async handle(context) {
      const path = context.url.pathname
      if (context.request.method !== "POST") return { response: jsonResponse(404, { error: "not_found" }) }
      if (path === "/api/accounts/deviceauth/usercode") {
        if (stringField(context.json, "client_id") !== clientID)
          return { response: jsonResponse(400, { error: "invalid_client" }) }
        const deviceAuthID = `dev_${randomBytes(12).toString("hex")}`
        const userCode = `${letters(4)}-${letters(4)}`
        devices.set(deviceAuthID, { userCode, state: "pending" })
        userCodes.push(userCode)
        return {
          response: jsonResponse(200, {
            device_auth_id: deviceAuthID,
            user_code: userCode,
            interval: String(options.interval ?? 1),
          }),
        }
      }
      if (path === "/api/accounts/deviceauth/token") {
        const device = devices.get(stringField(context.json, "device_auth_id") ?? "")
        if (!device || device.userCode !== stringField(context.json, "user_code"))
          return { response: jsonResponse(404, { error: "device_auth_not_found" }) }
        if (device.state === "pending") return { response: jsonResponse(403, { error: "authorization_pending" }) }
        if (device.state === "denied" || !device.account)
          return { response: jsonResponse(400, { error: "access_denied" }) }
        const code = `ac_${randomBytes(16).toString("hex")}`
        const verifier = randomBytes(32).toString("base64url")
        codes.set(code, { account: device.account, redirect: `${fake.url}/deviceauth/callback`, verifier })
        devices.delete(stringField(context.json, "device_auth_id") ?? "")
        return {
          response: jsonResponse(200, {
            authorization_code: code,
            code_challenge: s256(verifier),
            code_verifier: verifier,
          }),
        }
      }
      if (path !== "/oauth/token") return { response: jsonResponse(404, { error: "not_found" }) }
      const form = formOf(context.body, context.request.headers.get("content-type"))
      if (form.get("client_id") !== clientID)
        return { response: jsonResponse(401, { error: { code: "invalid_client", message: "Unknown client." } }) }
      if (form.get("grant_type") === "refresh_token") {
        const result = codex.refresh(form.get("refresh_token") ?? "")
        if (result.type === "error")
          return {
            response: jsonResponse(result.status, {
              error: { code: result.code, message: result.message, type: "invalid_request_error" },
            }),
          }
        issued.push(result.tokens)
        return { identity: `codex:${result.tokens.accountID}`, response: tokenResponse(result.tokens) }
      }
      if (form.get("grant_type") !== "authorization_code")
        return { response: jsonResponse(400, { error: "unsupported_grant_type" }) }
      const code = codes.get(form.get("code") ?? "")
      codes.delete(form.get("code") ?? "")
      const verifier = form.get("code_verifier") ?? ""
      const verified = code?.verifier !== undefined ? code.verifier === verifier : code?.challenge === s256(verifier)
      if (!code || !verified || form.get("redirect_uri") !== code.redirect)
        return {
          response: jsonResponse(400, { error: "invalid_grant", error_description: "Invalid authorization code." }),
        }
      exchanges.count += 1
      const tokens = codex.login(code.account)
      issued.push(tokens)
      return { identity: `codex:${tokens.accountID}`, response: tokenResponse(tokens) }
    },
  })

  const tokenResponse = (tokens: ChatGPTTokens) =>
    jsonResponse(200, {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.round((tokens.expiresAt - fake.clock.now()) / 1000)),
      scope: "openid profile email offline_access",
    })

  const device = (userCode: string) => [...devices.values()].find((candidate) => candidate.userCode === userCode)

  return {
    ...fake,
    tokenURL: `${fake.url}/oauth/token`,
    userCodes,
    approve: (userCode, account) => {
      const found = device(userCode)
      if (!found) throw new Error(`fake chatgpt-auth: unknown user code ${userCode}`)
      found.state = "approved"
      found.account = account
    },
    deny: (userCode) => {
      const found = device(userCode)
      if (!found) throw new Error(`fake chatgpt-auth: unknown user code ${userCode}`)
      found.state = "denied"
    },
    authorize: (authorizeURL, account) => {
      const url = new URL(authorizeURL)
      const query = url.searchParams
      if (url.origin !== fake.url || url.pathname !== "/oauth/authorize")
        throw new Error("fake chatgpt-auth: not this issuer's authorize URL")
      if (query.get("client_id") !== clientID || query.get("code_challenge_method") !== "S256")
        throw new Error("fake chatgpt-auth: bad authorize parameters")
      const redirect = query.get("redirect_uri") ?? ""
      const code = `ac_${randomBytes(16).toString("hex")}`
      codes.set(code, { account, redirect, challenge: query.get("code_challenge") ?? "" })
      const callback = new URL(redirect)
      callback.searchParams.set("code", code)
      callback.searchParams.set("state", query.get("state") ?? "")
      return callback.toString()
    },
    exchangeCount: () => exchanges.count,
    issued,
  }
}

function formOf(body: string, contentType: string | null) {
  if (contentType?.includes("application/x-www-form-urlencoded")) return new URLSearchParams(body)
  const json = parseJson(body)
  const keys = ["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "refresh_token"]
  return new URLSearchParams(
    keys.flatMap((key) => {
      const value = stringField(json, key)
      return value === undefined ? [] : [[key, value]]
    }),
  )
}

function s256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}

function letters(count: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  return Array.from(randomBytes(count), (byte) => alphabet[byte % alphabet.length]).join("")
}

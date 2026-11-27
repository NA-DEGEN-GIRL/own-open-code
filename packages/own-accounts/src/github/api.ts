export * as GitHubApi from "./api.js"

import { OwnGitHub } from "@own/protocol"
import type { Deps } from "../deps.js"

/**
 * github.com's and a GitHub Enterprise site's addresses, and the two GitHub requests own makes itself (16 §4): who a
 * token is (`GET /user`), and the browser login with a code (device flow, `POST /login/device/code` and
 * `/login/oauth/access_token`) with the user's own app. Every other GitHub request goes through GitHub's MCP server.
 * A token is sent only to its account's site; nothing here logs or answers it.
 */

export const TIMEOUT_MS = 20_000
const USER_AGENT = "own-open-code"
const API_VERSION = "2022-11-28"

export interface Urls {
  /** The site's web root: the browser login's pages. */
  readonly web: string
  /** The REST API root (`https://api.github.com`, `https://api.<sub>.ghe.com`, `<site>/api/v3`). */
  readonly api: string
  /** GitHub's hosted MCP server for the site, when it has one (github.com and `*.ghe.com`). */
  readonly hosted?: string
}

/**
 * The addresses of `site`. github.com's come from the endpoints (a test's fakes); a service given other endpoints but
 * not GitHub's never asks github.com (`undefined`), as the MCP Registry's guard does.
 */
export function urls(deps: Pick<Deps, "endpoints">, site: string): Urls | undefined {
  const origin = new URL(site).origin
  if (origin === OwnGitHub.GITHUB_COM) {
    const given = deps.endpoints.overrides
    const guarded = Object.keys(given).length > 0 && given.github === undefined && given.githubApi === undefined
    if (guarded) return undefined
    return { web: deps.endpoints.url.github, api: deps.endpoints.url.githubApi, hosted: deps.endpoints.url.githubMcp }
  }
  const host = new URL(origin).hostname
  const cloud = /^([a-z0-9-]+)\.ghe\.com$/i.exec(host)
  if (cloud) {
    const sub = cloud[1]!.toLowerCase()
    return { web: origin, api: `https://api.${sub}.ghe.com`, hosted: `https://copilot-api.${sub}.ghe.com/mcp` }
  }
  return { web: origin, api: `${origin}/api/v3` }
}

export type Failure =
  | { readonly type: "github_token_invalid"; readonly status: number }
  | { readonly type: "github_unavailable"; readonly reason: "offline" | "status" | "invalid"; readonly status?: number }

export interface Who {
  readonly login: string
  readonly name?: string
  readonly scopes?: ReadonlyArray<string>
  readonly expiresAt?: number
}

/** Who `token` is on the site of `api` (`GET /user`), its scopes and expiry from the answer's headers. */
export async function whoami(
  api: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly who: Who } | { readonly ok: false; readonly failure: Failure }> {
  const response = await fetch(`${api.replace(/\/+$/, "")}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": USER_AGENT,
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response) return { ok: false, failure: { type: "github_unavailable", reason: "offline" } }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    return { ok: false, failure: { type: "github_token_invalid", status: response.status } }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { ok: false, failure: { type: "github_unavailable", reason: "status", status: response.status } }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body) || typeof body.login !== "string" || !body.login)
    return { ok: false, failure: { type: "github_unavailable", reason: "invalid" } }
  const scopes = response.headers.get("x-oauth-scopes")
  const expiry = parseExpiry(response.headers.get("github-authentication-token-expiration"))
  return {
    ok: true,
    who: {
      login: body.login,
      ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
      ...(scopes === null
        ? {}
        : {
            scopes: scopes
              .split(",")
              .map((scope) => scope.trim())
              .filter(Boolean),
          }),
      ...(expiry === undefined ? {} : { expiresAt: expiry }),
    },
  }
}

/** `GitHub-Authentication-Token-Expiration`: `2026-12-01 00:00:00 UTC` or `2026-12-01 09:00:00 +0900`. */
export function parseExpiry(value: string | null) {
  if (!value) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|[+-]\d{2}:?\d{2})?$/.exec(value.trim())
  if (!match) return undefined
  const zone = match[3] === undefined || match[3] === "UTC" ? "Z" : match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")
  const at = Date.parse(`${match[1]}T${match[2]}${zone}`)
  return Number.isFinite(at) ? at : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Device flow (16 §4.2)

/** What the user's app is asked for: private repositories and org membership (an OAuth app; a GitHub App ignores it). */
export const SCOPES = "repo read:org"

export interface DeviceCode {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresInMs: number
  readonly intervalMs: number
}

export type DeviceFailure = { readonly reason: "offline" | "status" | "invalid"; readonly status?: number }

/** `POST /login/device/code` with the user's client ID. */
export async function deviceCode(
  web: string,
  clientID: string,
): Promise<{ readonly ok: true; readonly code: DeviceCode } | { readonly ok: false; readonly failure: DeviceFailure }> {
  const answer = await form(`${web}/login/device/code`, { client_id: clientID, scope: SCOPES })
  if (!answer.ok) return answer
  const body = answer.body
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  )
    return { ok: false, failure: { reason: "invalid" } }
  return {
    ok: true,
    code: {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresInMs: seconds(body.expires_in, 900) * 1000,
      intervalMs: seconds(body.interval, 5) * 1000,
    },
  }
}

export type Poll =
  | { readonly state: "token"; readonly token: Tokens }
  | { readonly state: "pending" }
  | { readonly state: "slow_down"; readonly intervalMs: number }
  | { readonly state: "expired" | "denied" }
  | { readonly state: "failed"; readonly message: string }

export interface Tokens {
  readonly token: string
  readonly refresh?: string
  readonly expiresAt?: number
  readonly refreshExpiresAt?: number
}

/** One poll of `POST /login/oauth/access_token` (device code grant). */
export async function pollToken(web: string, clientID: string, deviceCode: string, now: number): Promise<Poll> {
  const answer = await form(`${web}/login/oauth/access_token`, {
    client_id: clientID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  })
  if (!answer.ok) return { state: "failed", message: failureText(answer.failure) }
  return tokenAnswer(answer.body, now)
}

/** A GitHub App's expiring user token, renewed with its refresh token (no client secret after a device login). */
export async function refresh(web: string, clientID: string, refreshToken: string, now: number): Promise<Poll> {
  const answer = await form(`${web}/login/oauth/access_token`, {
    client_id: clientID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })
  if (!answer.ok) return { state: "failed", message: failureText(answer.failure) }
  return tokenAnswer(answer.body, now)
}

function tokenAnswer(body: Record<string, unknown>, now: number): Poll {
  if (typeof body.access_token === "string" && body.access_token)
    return {
      state: "token",
      token: {
        token: body.access_token,
        ...(typeof body.refresh_token === "string" && body.refresh_token ? { refresh: body.refresh_token } : {}),
        ...(typeof body.expires_in === "number" ? { expiresAt: now + body.expires_in * 1000 } : {}),
        ...(typeof body.refresh_token_expires_in === "number"
          ? { refreshExpiresAt: now + body.refresh_token_expires_in * 1000 }
          : {}),
      },
    }
  const error = typeof body.error === "string" ? body.error : ""
  if (error === "authorization_pending") return { state: "pending" }
  if (error === "slow_down") return { state: "slow_down", intervalMs: seconds(body.interval, 10) * 1000 }
  if (error === "expired_token") return { state: "expired" }
  if (error === "access_denied") return { state: "denied" }
  const described = typeof body.error_description === "string" ? body.error_description : error
  return { state: "failed", message: described || "GitHub did not give a token" }
}

async function form(
  url: string,
  fields: Readonly<Record<string, string>>,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly failure: DeviceFailure }
> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response) return { ok: false, failure: { reason: "offline" } }
  const body: unknown = await response.json().catch(() => undefined)
  // GitHub answers the device grant's waits and refusals with 200 and an `error` field; anything else is a failure.
  if (!response.ok && !(isRecord(body) && typeof body.error === "string"))
    return { ok: false, failure: { reason: "status", status: response.status } }
  if (!isRecord(body)) return { ok: false, failure: { reason: "invalid" } }
  return { ok: true, body }
}

function failureText(failure: DeviceFailure) {
  if (failure.reason === "offline") return "GitHub did not answer"
  if (failure.reason === "status") return `GitHub answered ${failure.status ?? "an error"}`
  return "GitHub answered something unexpected"
}

function seconds(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

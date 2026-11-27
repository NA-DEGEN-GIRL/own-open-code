export * as Classify from "./classify.js"

import type { Kind, Limit } from "@own/protocol"
import type { LastResponse } from "@own/runtime"
import { Windows } from "./windows.js"

/**
 * Retry-hook classification of an own-slot failure (02 §5.2 "kind별 오류 분류", 01 §14.3). Pure: the module feeds
 * the retry event, the session's last capture (`runtime.lastResponse`, same provider, ≤ 30 s) and the account's
 * current windows. Only `hard` and `auth` are switch triggers; 429/529/5xx without a quota signal stay `transient`.
 */

export type Class = Limit.ExhaustionClass | "unknown"

/** How far a `hard` result reaches (02 §5.2 "quota domain 전파"). */
export type Scope = "account" | "quota_domain" | "workspace"

/** As much of the session error's response body as a capture keeps of one (02 §7.2 "앞 2KB"). */
export const BODY_HEAD_CHARS = 2_048

export interface Input {
  readonly kind: Kind.Own
  /**
   * The retry event's error. `response.body` is the provider's own response, which upstream keeps on the session
   * error (c14a1f5acf) while it may put a friendlier `message` in front, as it does for token-sharing codes.
   */
  readonly error: {
    readonly type: string
    readonly message: string
    readonly status?: number
    readonly response?: { readonly body: string }
  }
  readonly capture?: LastResponse.Capture
  readonly windows: ReadonlyArray<Limit.Window>
  readonly now: number
}

export interface Result {
  readonly class: Class
  /** Short machine reason, e.g. `usage_limit_reached`, `insufficient_quota`, `status_402`. Never a secret. */
  readonly reason: string
  readonly windowId: string | null
  /** Epoch ms when the limit resets, when the signal says so. */
  readonly resetAt?: number
  readonly scope: Scope
  /** The provider said retrying cannot help: the retry hook answers `retry: false` whatever the class. */
  readonly stop?: boolean
  /** The login is unusable until the user signs in again (`logins.rejected`). */
  readonly reauth?: boolean
}

export function classify(input: Input): Result {
  const status = input.error.status ?? input.capture?.frame?.status ?? input.capture?.status ?? undefined
  // The error's own body stands in when nothing was captured: the capture is gone after 30 s, or never existed.
  const body = input.capture?.bodyHead ?? input.error.response?.body.slice(0, BODY_HEAD_CHARS)
  const text = [body, input.capture?.frame?.code, input.error.message]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase()
  const headers = input.capture?.headers ?? {}
  const retryAt = retryAfter(headers, input.now) ?? resetFromBody(text, input.now, input.capture?.frame)

  // Token sharing names its failures by code, whatever the status (a 403 may be eligibility, not auth).
  const sharing = input.kind === "siwc" ? sharingEntry(text) : undefined
  if (sharing) return sharingResult(sharing, retryAt, fullPlanWindow(input))

  if (status === 401 || input.error.type === "provider.auth")
    return { class: "auth", reason: `status_${status ?? 401}`, windowId: null, scope: "account" }
  if (status === 403 && !(input.kind === "xai" && text.includes("credit")))
    return { class: "auth", reason: "status_403", windowId: null, scope: "account" }
  if (status === 402 && outputUnaffordable(text))
    return { class: "unknown", reason: "max_tokens_unaffordable", windowId: null, scope: "account" }

  const hard = hardOf(input, status, text, headers)
  if (hard) {
    const resetAt = hard.resetAt ?? retryAt
    return { class: "hard", reason: hard.reason, windowId: hard.windowId, scope: hard.scope, ...at(resetAt) }
  }
  if (status === 429 || status === 529 || (status !== undefined && status >= 500) || TRANSIENT.has(input.error.type))
    return {
      class: "transient",
      reason: status === undefined ? input.error.type : `status_${status}`,
      windowId: null,
      scope: "account",
      ...at(retryAt),
    }
  return { class: "unknown", reason: input.error.type, windowId: null, scope: "account" }
}

const TRANSIENT: ReadonlySet<string> = new Set([
  "provider.rate-limit",
  "provider.internal",
  "provider.transport",
  "provider.timeout",
])

/** Core's smallest requested output (`model-request.ts` OUTPUT_TOKEN_MIN): a balance below it affords no answer. */
const OUTPUT_MIN_TOKENS = 1_024

/**
 * OpenRouter holds the price of the requested output against the balance and answers 402 "This request requires more
 * credits, or fewer max_tokens. You requested up to N tokens, but can only afford M." while M tokens still fit: the
 * request was too large for the balance, the account is not exhausted (02 §5.2). Own sends OpenRouter no output limit,
 * but another plugin or a provider default may; the telemetry module turns a repeat into exhaustion
 * (`UNAFFORDABLE_REPEAT_MS`). A balance that affords less than any answer (a negative M included), or a message
 * without M, stays exhaustion.
 */
function outputUnaffordable(text: string) {
  if (!text.includes("fewer max_tokens")) return false
  const affordable = /can only afford (-?\d+)/.exec(text)?.[1]
  return affordable !== undefined && Number(affordable) >= OUTPUT_MIN_TOKENS
}

interface Hard {
  readonly reason: string
  readonly windowId: string | null
  readonly resetAt?: number
  readonly scope: Scope
}

function hardOf(
  input: Input,
  status: number | undefined,
  text: string,
  headers: Readonly<Record<string, string>>,
): Hard | undefined {
  const quotaLike =
    status === 429 || input.error.type === "provider.quota" || input.error.type === "provider.rate-limit"
  if (input.kind === "codex") return codexHard(input, status, text, headers, quotaLike)
  if (status === 402)
    return { reason: "status_402", windowId: null, scope: input.kind === "oai" ? "quota_domain" : "account" }
  if (input.kind === "oai" && quotaLike && text.includes("insufficient_quota"))
    return { reason: "insufficient_quota", windowId: null, scope: "quota_domain" }
  if (input.kind === "anth" && quotaLike && text.includes("enforced_spend_limit_reached"))
    return { reason: "enforced_spend_limit_reached", windowId: null, scope: "quota_domain" }
  if (input.kind === "anth" && status === 400 && /workspace api usage limit/.test(text))
    return { reason: "workspace_usage_limit", windowId: null, scope: "workspace" }
  if (input.kind === "xai" && status === 403 && text.includes("credit"))
    return { reason: "credits_exhausted", windowId: null, scope: "account" }
  // Core already matched its QUOTA_TEXT on a 429 (`provider-error.ts`): honour it for every kind.
  if (input.error.type === "provider.quota") return { reason: "quota_exceeded", windowId: null, scope: "account" }
  return undefined
}

function codexHard(
  input: Input,
  status: number | undefined,
  text: string,
  headers: Readonly<Record<string, string>>,
  quotaLike: boolean,
): Hard | undefined {
  const full = fullPlanWindow(input)
  const reached = Windows.codexReachedType(headers)
  const usageLimit =
    text.includes("usage_limit_reached") || text.includes("usage limit") || text.includes("usage_not_included")
  if (quotaLike && (usageLimit || reached !== undefined))
    return {
      reason: reached ?? (text.includes("usage_not_included") ? "usage_not_included" : "usage_limit_reached"),
      windowId: full?.id ?? null,
      ...at(full?.resetAt),
      scope: "account",
    }
  if ((quotaLike || status === undefined) && full)
    return { reason: "window_exhausted", windowId: full.id, ...at(full.resetAt), scope: "account" }
  return undefined
}

/**
 * The full Codex plan window (`x-codex-*`, also read on `siwc`, 02 §7.1) that resets last and has not reset yet: the
 * observed reset of a plan usage limit. `undefined` when no plan window is full.
 */
function fullPlanWindow(input: Input) {
  return input.windows
    .filter((window) => window.id.startsWith("codex.") && window.id !== "codex.credits")
    .filter((window) => window.confidence !== "estimated" && (window.usedPercent ?? 0) >= 100)
    .filter((window) => window.resetAt === undefined || window.resetAt > input.now)
    .toSorted((a, b) => (b.resetAt ?? 0) - (a.resetAt ?? 0))[0]
}

type SharingOutcome = "hard" | "reauth" | "stop" | "transient"

interface SharingCode {
  readonly code: string
  readonly outcome: SharingOutcome
  /** The current name of a legacy `_v2_` alias, reported as the reason. */
  readonly current?: string
}

/**
 * Sign in with ChatGPT error codes (02 §3.2c; upstream `to-session-error.ts` and `chatgpt.ts` at 0f83038253, plus the
 * legacy `_v2_` names that OpenAI's reference client still accepts). Matched in the captured body, the stream
 * failure's `code` and the error message. Core classifies the usage limit as a retryable rate limit, so every
 * outcome but `transient` stops the retries here. Nothing here invents a reset time for a usage limit (an app-specific
 * cap may apply); only the response's own reset signal is kept.
 */
export const SHARING_CODES: ReadonlyArray<SharingCode> = [
  { code: "subscription_sharing_usage_limit_exceeded", outcome: "hard" },
  { code: "subscription_sharing_user_not_eligible", outcome: "hard" },
  {
    code: "subscription_sharing_v2_user_not_eligible",
    outcome: "hard",
    current: "subscription_sharing_user_not_eligible",
  },
  { code: "subscription_sharing_invalid_user", outcome: "reauth" },
  { code: "subscription_sharing_v2_invalid_user", outcome: "reauth", current: "subscription_sharing_invalid_user" },
  { code: "chatpass_v2_scope_not_authorized", outcome: "reauth" },
  { code: "chatpass_v2_invalid_authorization_context", outcome: "reauth" },
  { code: "subscription_sharing_unsupported_capability", outcome: "stop" },
  { code: "subscription_sharing_route_not_supported", outcome: "stop" },
  {
    code: "subscription_sharing_v2_route_not_supported",
    outcome: "stop",
    current: "subscription_sharing_route_not_supported",
  },
  { code: "subscription_sharing_v2_client_not_enabled", outcome: "stop" },
  { code: "subscription_sharing_usage_unavailable", outcome: "transient" },
  { code: "subscription_sharing_user_unavailable", outcome: "transient" },
  {
    code: "subscription_sharing_v2_user_unavailable",
    outcome: "transient",
    current: "subscription_sharing_user_unavailable",
  },
]

/** The Sign in with ChatGPT code a response body names, by its current name; `undefined` when it names none. */
export function sharingCode(text: string) {
  const entry = sharingEntry(text.toLowerCase())
  return entry && (entry.current ?? entry.code)
}

function sharingEntry(text: string) {
  return SHARING_CODES.find((entry) => text.includes(entry.code))
}

/**
 * A usage limit takes the full plan window's observed reset only when the responses carried plan headers; an app's own
 * cap in ChatGPT settings has no reset to read, so none is made up. `windowId` stays `null`: the account status reason
 * must remain the sharing code own-web's plan banner keys on (`relay.ts`).
 */
function sharingResult(entry: SharingCode, retryAt: number | undefined, full: Limit.Window | undefined): Result {
  const base = { reason: entry.current ?? entry.code, windowId: null, scope: "account" as const }
  if (entry.outcome === "hard" && entry.code === "subscription_sharing_usage_limit_exceeded")
    return { ...base, class: "hard", stop: true, ...at(full?.resetAt ?? retryAt) }
  if (entry.outcome === "hard") return { ...base, class: "hard", stop: true, ...at(retryAt) }
  if (entry.outcome === "reauth") return { ...base, class: "auth", stop: true, reauth: true }
  if (entry.outcome === "stop") return { ...base, class: "unknown", stop: true }
  return { ...base, class: "transient", ...at(retryAt) }
}

function at(resetAt: number | undefined) {
  return resetAt === undefined ? {} : { resetAt }
}

/** `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
export function retryAfter(headers: Readonly<Record<string, string>>, now: number) {
  const ms = Number(headers["retry-after-ms"])
  if (headers["retry-after-ms"] !== undefined && Number.isFinite(ms)) return now + ms
  const value = headers["retry-after"]
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

/** `resets_at` (epoch s) or `resets_in_seconds` in a codex error body or frame summary. */
function resetFromBody(text: string, now: number, frame: LastResponse.Frame | null | undefined) {
  if (frame?.resetsInSeconds !== undefined) return now + frame.resetsInSeconds * 1000
  const absolute = /"resets_at"\s*:\s*(\d+)/.exec(text)
  if (absolute) return Number(absolute[1]) * 1000
  const relative = /"resets_in_seconds"\s*:\s*(\d+)/.exec(text)
  if (relative) return now + Number(relative[1]) * 1000
  return undefined
}

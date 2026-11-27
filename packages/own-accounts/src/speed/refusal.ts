export * as SpeedRefusal from "./refusal.js"

import { Option, Schema } from "effect"
import type { Speed } from "@own/protocol"

/**
 * Owner: SPEED (02 §4.8, decision 6). Whether a failed request that carried a speed tier failed because of the tier,
 * judged before any output (core's retry hook). Pure. Nothing here switches the account (R2/R4): a refused tier is
 * marked for that account and model only, and the request goes again at once without it.
 * - OpenAI family: a 4xx other than 401/429 whose body names the tier (`service_tier`, `ultrafast`, `priority`),
 *   e.g. Sign in with ChatGPT's `subscription_sharing_unsupported_capability` with `param: "service_tier"`, or a tier
 *   the plan does not include. The Codex backend answers a tier it does not take with 400 `{"detail":"Unsupported
 *   service_tier: <tier>"}` over HTTP and the frame `{"type":"error","status":400,"error":{"type":
 *   "invalid_request_error","message":"Unsupported service_tier: <tier>"}}` over the WebSocket (live, 2026-10-18):
 *   `unsupported_tier`. Any other 4xx naming a tier counts too (`status_<n>`).
 * - Anthropic: a 429 or 529 is the fast rate limit or capacity (a separate pool; also how an organization without
 *   fast access is answered): a cooldown, Standard meanwhile, as Claude Code does. A 4xx naming `speed` or fast mode
 *   (a model without it) or the usage credits running out is a refusal.
 */
export interface Input {
  readonly wire: Speed.Wire
  /** The tier the failed request sent. */
  readonly tier: string
  readonly status: number | undefined
  /** The error body's head, the stream failure's code and the error message, joined. */
  readonly text: string
  /** `retry-after` of the answer, in ms from now, when it had one. */
  readonly retryAfterMs?: number
}

export type Verdict =
  | { readonly type: "refused"; readonly reason: string }
  | { readonly type: "cooldown"; readonly reason: string; readonly retryAfterMs?: number }

/** The Codex backend's words for a tier it does not take (see the header). */
const UNSUPPORTED_TIER = /unsupported service[_ ]tier/i

/** Words that tie an OpenAI-family failure to the tier. */
const OPENAI_TIER = ["service_tier", "service tier", "ultrafast", "priority", "speed tier"]
/** Words that tie an Anthropic failure to fast mode. */
const ANTHROPIC_FAST = ['"speed"', "speed", "fast mode", "fast-mode", "fast_mode"]
/** Usage credits ran out (Claude subscription slot): Fast stops, Standard goes on. */
const CREDITS = ["usage credits", "extra usage", "out of credits"]

export function judge(input: Input): Verdict | undefined {
  const text = input.text.toLowerCase()
  const status = input.status
  if (input.wire === "speed") {
    if (status === 429 || status === 529)
      return {
        type: "cooldown",
        reason: `status_${status}`,
        ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
      }
    if (status !== undefined && status >= 400 && status < 500 && CREDITS.some((word) => text.includes(word)))
      return { type: "refused", reason: "usage_credits" }
    if (status !== undefined && status >= 400 && status < 500 && ANTHROPIC_FAST.some((word) => text.includes(word)))
      return { type: "refused", reason: `status_${status}` }
    return undefined
  }
  if (status === 401 || status === 429) return undefined
  const named = OPENAI_TIER.some((word) => text.includes(word)) || text.includes(input.tier.toLowerCase())
  if (!named) return undefined
  if (text.includes("subscription_sharing_unsupported_capability"))
    return { type: "refused", reason: "subscription_sharing_unsupported_capability" }
  if (UNSUPPORTED_TIER.test(text) && (status === undefined || (status >= 400 && status < 500)))
    return { type: "refused", reason: "unsupported_tier" }
  if (status !== undefined && status >= 400 && status < 500) return { type: "refused", reason: `status_${status}` }
  // A stream failure without a status (a WebSocket `error` frame) that names the tier.
  if (status === undefined && /invalid|not (?:allowed|available|supported|entitled)|unsupported|denied/.test(text))
    return { type: "refused", reason: "rejected" }
  return undefined
}

/** Characters of the provider's message an alert quotes at most. */
export const DETAIL_CHARS = 200

/**
 * The provider's own message in a failure text (an error body or frame: `detail`, `error.message`, `message`), at most
 * {@link DETAIL_CHARS} characters, for the alert that names why a tier went; `undefined` when there is none.
 */
export function detail(text: string) {
  const found = text
    .split("\n")
    .map((line) => record(Option.getOrUndefined(decodeJson(line))))
    .map((json) => {
      const error = record(json?.error) ?? record(record(json?.response)?.error)
      return [json?.detail, error?.message, json?.message].find((value) => typeof value === "string" && value !== "")
    })
    .find((value) => value !== undefined)
  return typeof found === "string" ? found.slice(0, DETAIL_CHARS) : undefined
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

/**
 * How long Anthropic's fast rate limit keeps a tier off (decision 6): `retry-after` when given, at least
 * {@link COOLDOWN_MS}, doubled for each cooldown in a row without a fast success (an organization without fast access
 * answers every request so), at most {@link COOLDOWN_MAX_MS}.
 */
export function cooldownMs(retryAfterMs: number | undefined, strikes: number) {
  const base = Math.max(COOLDOWN_MS, retryAfterMs ?? 0)
  return Math.min(COOLDOWN_MAX_MS, base * 2 ** Math.min(strikes, 10))
}

export const COOLDOWN_MS = 60_000
export const COOLDOWN_MAX_MS = 60 * 60_000

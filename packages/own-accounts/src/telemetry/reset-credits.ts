export * as ResetCredits from "./reset-credits.js"

import type { Limit } from "@own/protocol"
import type { Windows } from "./windows.js"

/**
 * Pure parsers of ChatGPT's usage-limit reset credits ("리셋권", 02 §7.1.1), the shapes codex-rs `backend-client`
 * reads (`rate_limit_resets.rs`, `types.rs`): the count in `wham/usage`, the list of
 * `wham/rate-limit-reset-credits`, and the answer of its `/consume`. No I/O, no clock. Anything malformed is
 * `undefined`, never guessed: a count that is not a whole number of 0 or more is no count.
 */

/** The count part of an answer: `available_count`, and `applicable_available_count` when it is a count too. */
export interface Count {
  readonly availableCount: number
  readonly applicableCount?: number
}

/**
 * `wham/usage` → its `rate_limit_reset_credits` (`{available_count, applicable_available_count}`, live 2026-10-18:
 * `{2, 0}`). Absent, `null` or a malformed `available_count` is `undefined`; a malformed applicable count is left out.
 */
export function fromUsage(json: unknown): Count | undefined {
  return count(record(record(json)?.rate_limit_reset_credits))
}

/**
 * `GET <chatgpt>/wham/rate-limit-reset-credits` → the count and the credits (`{credits:[{id, reset_type, status,
 * granted_at, expires_at|null, title?, description?}], available_count}`). RFC 3339 times become epoch ms; a credit
 * without an id or a readable `granted_at` (or with an unreadable `expires_at`) is left out. An unknown `status` is
 * `unknown`; `reset_type` passes as received.
 */
export function fromDetails(
  json: unknown,
): (Count & { readonly credits: ReadonlyArray<Limit.ResetCredit> }) | undefined {
  const body = record(json)
  const counted = count(body)
  if (!body || !counted || !Array.isArray(body.credits)) return undefined
  return { ...counted, credits: body.credits.flatMap((item) => credit(record(item))) }
}

export const OUTCOMES = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const
export type Outcome = (typeof OUTCOMES)[number]

/**
 * `POST …/rate-limit-reset-credits/consume` → `{code, windows_reset}` (`windows_reset` defaults to 0, as codex-rs).
 * Another code is `undefined`: the caller keeps the nonce, and a retry sends the same request id.
 */
export function consumed(json: unknown): { readonly outcome: Outcome; readonly windowsReset: number } | undefined {
  const body = record(json)
  const outcome = OUTCOMES.find((item) => item === body?.code)
  if (!body || !outcome) return undefined
  return { outcome, windowsReset: whole(body.windows_reset) ?? 0 }
}

/** An observation of an account's credits, for the runtime store and `quota.updated`. */
export function observed(
  subject: Windows.Subject,
  observedAt: number,
  counted: Count,
  credits?: ReadonlyArray<Limit.ResetCredit>,
): Limit.ResetCredits {
  return {
    accountID: subject.accountID,
    providerID: subject.providerID,
    availableCount: counted.availableCount,
    ...(counted.applicableCount === undefined ? {} : { applicableCount: counted.applicableCount }),
    ...(credits === undefined ? {} : { credits }),
    observedAt,
    source: "poll",
  }
}

function count(body: Readonly<Record<string, unknown>> | undefined): Count | undefined {
  const availableCount = whole(body?.available_count)
  if (availableCount === undefined) return undefined
  const applicableCount = whole(body?.applicable_available_count)
  return { availableCount, ...(applicableCount === undefined ? {} : { applicableCount }) }
}

const STATUSES: ReadonlyArray<Limit.ResetCredit["status"]> = ["available", "redeeming", "redeemed"]
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

function credit(item: Readonly<Record<string, unknown>> | undefined): Limit.ResetCredit[] {
  const id = item?.id
  const grantedAt = time(item?.granted_at)
  const expires = item?.expires_at
  const expiresAt = expires === null || expires === undefined ? undefined : time(expires)
  if (!item || typeof id !== "string" || id === "" || grantedAt === undefined) return []
  if (expires !== null && expires !== undefined && expiresAt === undefined) return []
  const title = text(item.title)
  const description = text(item.description)
  return [
    {
      id,
      type: typeof item.reset_type === "string" && item.reset_type !== "" ? item.reset_type : "unknown",
      status: STATUSES.find((status) => status === item.status) ?? "unknown",
      grantedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    },
  ]
}

function time(value: unknown) {
  if (typeof value !== "string" || !RFC3339.test(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function whole(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

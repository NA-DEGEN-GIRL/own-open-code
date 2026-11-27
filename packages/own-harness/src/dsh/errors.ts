// Ports dsh's provider-error ordering: packages/llm/llm/src/error.ts `isQuotaExceededError` and
// packages/llm/llm-deepseek/src/transport.ts `providerError`, which reads an exhausted balance or quota (by its wording,
// or HTTP 402) before it reads a rate limit, so a 429 that says "insufficient balance" ends the request instead of being
// retried as a transient limit. own applies it through the session `retry` hook (hooks.ts) to dsh sessions only.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshErrors from "./errors.js"

import type { SessionError } from "@opencode/schema/session-error"

/** `isQuotaExceededError`: terminal quota, balance, credit, budget or usage-limit wording. */
export function isQuotaExceeded(detail: string) {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail) ||
    /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
  )
}

/** Whether `error` is an exhausted balance or quota (dsh's `QUOTA` code), checked before any rate-limit reading. */
export function exhausted(error: SessionError.Error) {
  if (error.status === 402) return true
  return isQuotaExceeded([error.type, error.message, error.response?.body ?? ""].join(" "))
}

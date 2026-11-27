export * as ExtraUsage from "./extra-usage.js"

/**
 * Phrases in an `anthropic` error body that mean Anthropic refused the request for extra usage: it counts the request as
 * third-party use, which draws from extra usage (now named "usage credits"), and the account has none to draw (off,
 * used up, not funded). Nothing was billed for it. Raises `claude_extra_usage` (danger) and the card's `rejected` state
 * (02 §7.7, §8.9, 03 §5.4.1(d)). Reported by users, not documented by Anthropic:
 * - 400 `invalid_request_error` `Third-party apps now draw from your extra usage, not your plan limits. …`
 *   (anthropics/claude-code#45134, 2026-04-08; router-for-me/CLIProxyAPI#6432, 2026-10-07), and the Team form without
 *   "your" (NousResearch/hermes-agent#48176, 2026-06-18);
 * - 400 `invalid_request_error` `You're out of extra usage. Add more at claude.ai/settings/usage …` (claude-code#45134,
 *   also seen with extra usage off);
 * - 429 `credits_required` `Usage credits are required for this model` (CLIProxyAPI#5920, 2026-09-17, credits off).
 * Server wording can change; this list is the only place to update it.
 */
export const PHRASES: ReadonlyArray<string> = [
  "Third-party apps now draw from your extra usage",
  "Third-party apps now draw from extra usage",
  "You're out of extra usage",
  "Usage credits are required for this model",
]

/** Whether the first 2 KB of an error body carry an extra-usage phrase (case-insensitive, either apostrophe). */
export function detect(bodyHead: string) {
  const text = bodyHead.toLowerCase().replaceAll("\u2019", "'")
  return PHRASES.some((phrase) => text.includes(phrase.toLowerCase()))
}

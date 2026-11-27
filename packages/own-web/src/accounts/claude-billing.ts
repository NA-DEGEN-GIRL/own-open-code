// How a Claude subscription account's requests are billed, as far as its responses tell (02 §8.9, CW 2026-10-19). The
// router keeps the verdict on the account's `claude.overage` window (`meta.billing`, `Unified.parse` and own-telemetry):
// `extra_usage` when the limit headers say the account moved to extra usage, `rejected` when Anthropic refused a
// request because extra usage is off or short. Nothing else is known from a response, which the card's `자세히` says.
import type { Limit } from "@own/protocol"

/** claude.ai's usage page (Settings › Usage), where extra usage and its spend are shown. */
export const USAGE_URL = "https://claude.ai/settings/usage"

/**
 * Anthropic's own pages and the public reports of the 2026-04-04 change, shown under `자세히` › `출처`: the usage
 * credits help (claude.ai Settings › Usage), the Agent SDK help whose 2026-06-15 and 2026-10-07 updates say third-party
 * app use draws from plan limits, Claude Code's legal page on subscription sign-ins, the three news reports, and a user
 * report of the refusal itself.
 */
export const SOURCES = [
  {
    label: { ko: "Anthropic 도움말 · Manage usage credits", en: "Anthropic help · Manage usage credits" },
    url: "https://support.claude.com/en/articles/12429409",
  },
  {
    label: {
      ko: "Anthropic 도움말 · Agent SDK with your Claude plan",
      en: "Anthropic help · Agent SDK with your Claude plan",
    },
    url: "https://support.claude.com/en/articles/15036540",
  },
  {
    label: { ko: "Claude Code 문서 · Legal and compliance", en: "Claude Code docs · Legal and compliance" },
    url: "https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use",
  },
  {
    label: "TechRadar (2026-04)",
    url: "https://www.techradar.com/pro/bad-news-claude-users-anthropic-says-youll-need-to-pay-to-use-openclaw-now",
  },
  {
    label: "GIGAZINE (2026-04-05)",
    url: "https://gigazine.net/gsc_news/en/20260405-anthropic-claude-code-need-pay-extra-openclaw",
  },
  {
    label: "Implicator.ai (2026-04)",
    url: "https://www.implicator.ai/anthropic-cuts-openclaw-from-claude-subscriptions-citing-unsustainable-compute-costs/",
  },
  { label: "GitHub · claude-code #45134 (2026-04-08)", url: "https://github.com/anthropics/claude-code/issues/45134" },
] as const

/** The account's observed billing state and when its response came, or `undefined` while nothing says so. */
export function billingOf(windows: readonly Limit.Window[] | undefined) {
  const overage = windows?.find((window) => window.id === "claude.overage")
  const state = overage?.meta?.billing
  if (!overage || !state) return undefined
  return { state, observedAt: overage.observedAt }
}

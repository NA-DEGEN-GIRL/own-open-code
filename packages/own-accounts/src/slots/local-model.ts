export * as LocalModel from "./local-model.js"

import { Model } from "@opencode/schema/model"
import { Kind, type Account } from "@own/protocol"

/**
 * Local models (02 §3.3a, `로컬 모델`): a `compat` account marked `local` with its server's API format. Pure parts only:
 * the provider package each format registers with, the effective reasoning of a model, the effort variants that follow
 * from it, and whether a base URL points at this PC or the local network. The variants follow core's per-protocol
 * shapes (`core/src/variant.ts`): Chat Completions `reasoning_effort` (`settings.reasoningEffort`), Responses
 * `reasoning.effort` (the same setting), `chat_template_kwargs.enable_thinking` as a body overlay, and Anthropic
 * `thinking` with a token budget.
 */

/** Provider package of each format. Ollama answers requests on its OpenAI-compatible `/v1`. */
export const PACKAGES: Readonly<Record<Account.LocalFormat, string>> = {
  chat: Kind.meta.compat.package,
  // Core injects no credential of its own for this package, so own's per-request key (or none) is what goes out.
  responses: "@opencode/ai/providers/openai/responses",
  anthropic: "@opencode/ai/providers/anthropic-compatible",
  ollama: Kind.meta.compat.package,
}

/** The package a `compat` account's models register with: its local format's, else Chat Completions. */
export function packageOf(compat: Account.Compat | undefined) {
  return PACKAGES[compat?.local?.format ?? "chat"]
}

/**
 * The reasoning a `compat` model registers with (02 §3.3a): the user's setting (`off` = none), else what the server
 * reported, else none.
 */
export function reasoningOf(stored: Account.CompatCapabilities | undefined): Account.Reasoning | undefined {
  if (stored?.reasoning === "off") return undefined
  return stored?.reasoning ?? stored?.detected?.reasoning ?? undefined
}

/** The user's reasoning setting as `accounts.list` shows it. */
export function settingOf(stored: Account.CompatCapabilities | undefined): Account.ReasoningSetting {
  return stored?.reasoning ?? "auto"
}

/** Anthropic thinking budgets never pass this (core's `ANTHROPIC_OUTPUT_TOKEN_MAX`). */
const BUDGET_MAX = 32_000
/** Anthropic's smallest thinking budget. */
const BUDGET_MIN = 1_024
/** Levels that turn thinking off. */
const OFF = new Set(["none", "off"])

/**
 * The effort variants of a model (02 §3.3a): one per level, in the order the levels were given; `[]` when it does not
 * reason, or when a thinking budget does not fit its output cap. A Chat Completions, Responses or Ollama model sends
 * the level as its effort (`reasoning_effort`, `reasoning.effort`); a toggle sends `enable_thinking` (Ollama: effort
 * `none` or `high`). An Anthropic-format model gets thinking budgets: levels spread up to the output cap, `none` off.
 */
export function variants(
  reasoning: Account.Reasoning | undefined,
  format: Account.LocalFormat,
  output: number,
): Model.Variant[] {
  if (!reasoning) return []
  if (format === "anthropic") return anthropic(reasoning, output)
  if (reasoning.style === "budget") return []
  if (reasoning.style === "toggle")
    return format === "ollama"
      ? [
          variant("none", { settings: { reasoningEffort: "none" } }),
          variant("thinking", { settings: { reasoningEffort: "high" } }),
        ]
      : [
          variant("none", { body: { chat_template_kwargs: { enable_thinking: false } } }),
          variant("thinking", { body: { chat_template_kwargs: { enable_thinking: true } } }),
        ]
  return unique(reasoning.levels).map((level) => variant(level, { settings: { reasoningEffort: level } }))
}

function anthropic(reasoning: Account.Reasoning, output: number): Model.Variant[] {
  const ceiling = Math.min(BUDGET_MAX, output - 1)
  if (ceiling < BUDGET_MIN) return []
  const off = variant("none", { settings: { thinking: { type: "disabled" } } })
  const budget = (tokens: number) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } })
  if (reasoning.style === "toggle") return [off, variant("thinking", budget(Math.min(16_000, ceiling)))]
  if (reasoning.style === "budget")
    return [
      off,
      variant("high", budget(Math.max(BUDGET_MIN, Math.floor((ceiling + 1) / 2)))),
      variant("max", budget(ceiling)),
    ]
  const levels = unique(reasoning.levels)
  const on = levels.filter((level) => !OFF.has(level))
  return levels.map((level) => {
    if (OFF.has(level)) return off
    const step = on.indexOf(level) + 1
    return variant(level, budget(Math.max(BUDGET_MIN, Math.floor((ceiling * step) / on.length))))
  })
}

function variant(id: string, overlay: Omit<Model.Variant, "id">): Model.Variant {
  return { id: Model.VariantID.make(id), ...overlay }
}

function unique(levels: ReadonlyArray<string>) {
  return levels.filter((level, index) => levels.indexOf(level) === index)
}

/**
 * Whether a base URL's host is this PC or the local network (02 §3.3a): loopback, `localhost`, `*.local`, a private or
 * link-local IPv4 address (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 for Tailscale-style networks) or a private
 * IPv6 address (`fc00::/7`, `fe80::/10`). A `기타 OpenAI 호환` account on such a host is a local model.
 */
export function isLocalURL(baseURL: string | undefined) {
  if (!baseURL || !URL.canParse(baseURL)) return false
  const host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") return true
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const a = parts[0]!
  const b = parts[1]!
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

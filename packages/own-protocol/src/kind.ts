export * as Kind from "./kind.js"

import { Schema } from "effect"
import { statics } from "@opencode/schema/schema"

/**
 * Every account kind shown in the UI, including the third-party Claude subscription slot (02 §2.1), whose provider
 * id is the reserved `Provider.ID.anthropic` (R-ID-4), and the Claude Agent route (02 §8.10, CAG 2026-10-31): Claude
 * Code itself, logged in by the user in a folder own manages, on upstream's built-in provider `claude-agent`.
 */
export const Any = Schema.Literals([
  "codex",
  "siwc",
  "oai",
  "anth",
  "ds",
  "xai",
  "or",
  "compat",
  "claude-sub",
  "claude-agent",
]).annotate({
  identifier: "Own.Kind.Any",
})
export type Any = typeof Any.Type

/** Kinds that own an `own-<kind>-<slug>` provider slot (02 §2.2 R-ID-3). */
export const Own = Schema.Literals(["codex", "siwc", "oai", "anth", "ds", "xai", "or", "compat"]).annotate({
  identifier: "Own.Kind.Own",
})
export type Own = typeof Own.Type

/** Kinds added with an API key through `accounts.add.key` (02 §3.3). */
export const Api = Schema.Literals(["oai", "anth", "ds", "xai", "or", "compat"]).annotate({
  identifier: "Own.Kind.Api",
})
export type Api = typeof Api.Type

export const own: ReadonlyArray<Own> = Own.literals

/**
 * Kinds whose credential is a ChatGPT OAuth token family (an `oauth` vault item, re-login, never an API key): the
 * Codex-style ChatGPT login (`codex`) and Sign in with ChatGPT token sharing (`siwc`). Both are a ChatGPT plan: billed
 * in plan credits, with the same speed tiers and the same `service_tier` answer that never names the tier it ran (02
 * §4.8). Ask {@link isOAuth} instead of comparing with `"codex"` when the question is "is this a ChatGPT OAuth account"
 * or "is this a ChatGPT plan". What differs is the route: only `codex` reaches the ChatGPT backend (its WebSocket, its
 * plan headers and `wham/usage`); `siwc` is the public API, which must not be pointed at ChatGPT's `backend-api`.
 */
export const OAuth = Schema.Literals(["codex", "siwc"]).annotate({ identifier: "Own.Kind.OAuth" })
export type OAuth = typeof OAuth.Type

const OAUTH: ReadonlySet<string> = new Set(OAuth.literals)

export function isOAuth(kind: string): kind is OAuth {
  return OAUTH.has(kind)
}

export interface Meta {
  /** `canonical` of the registered provider; also the slot-neutral identity value (02 §3.6, §4.3 D9). */
  readonly canonical: string
  /** Native package for the provider and each model entry (02 §3.6). */
  readonly package: string
  /** Default `billing` for new accounts of this kind; the registry value wins. */
  readonly billing: "subscription" | "metered" | "prepaid"
  /** Built-in provider hidden by `hideBuiltinProviders: "auto"` (02 §2.4.3). */
  readonly builtin: string | null
  /** Whether `canonical` is written on the provider info. `compat` omits it (02 §3.6). */
  readonly writesCanonical: boolean
}

export const meta: Readonly<Record<Own, Meta>> = {
  codex: {
    canonical: "openai",
    package: "@opencode/ai/providers/openai",
    billing: "subscription",
    builtin: "openai",
    writesCanonical: true,
  },
  // Sign in with ChatGPT (token sharing): plan-billed like codex, but served by the public API at its default base URL
  // over HTTP with Bearer auth only (02 §3.2c).
  siwc: {
    canonical: "openai",
    package: "@opencode/ai/providers/openai",
    billing: "subscription",
    builtin: "openai",
    writesCanonical: true,
  },
  oai: {
    canonical: "openai",
    package: "@opencode/ai/providers/openai",
    billing: "metered",
    builtin: "openai",
    writesCanonical: true,
  },
  anth: {
    canonical: "anthropic",
    package: "@opencode/ai/providers/anthropic",
    billing: "metered",
    builtin: null,
    writesCanonical: true,
  },
  ds: {
    canonical: "deepseek",
    package: "@opencode/ai/providers/deepseek",
    billing: "prepaid",
    builtin: "deepseek",
    writesCanonical: true,
  },
  xai: {
    canonical: "xai",
    package: "@opencode/ai/providers/xai",
    billing: "prepaid",
    builtin: "xai",
    writesCanonical: true,
  },
  or: {
    canonical: "openrouter",
    package: "@opencode/ai/providers/openrouter",
    billing: "prepaid",
    builtin: "openrouter",
    writesCanonical: true,
  },
  compat: {
    canonical: "openai-compatible",
    package: "@opencode/ai/providers/openai-compatible",
    billing: "metered",
    builtin: null,
    writesCanonical: false,
  },
}

const PROVIDER_ID_PATTERN = /^own-(codex|siwc|oai|anth|ds|xai|or|compat)-([a-z0-9]{4,8})$/
const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

/**
 * Own slot provider id `own-<kind>-<slug>`, where slug is 4–8 random `[a-z0-9]` (02 §2.2 R-ID-3).
 * Shares the `Provider.ID` brand so it can be used wherever a core `Provider.ID` is expected.
 */
export const ProviderID = Schema.String.check(Schema.isPattern(PROVIDER_ID_PATTERN)).pipe(
  Schema.brand("Provider.ID"),
  Schema.annotate({ identifier: "Own.Kind.ProviderID" }),
  statics((schema) => ({
    from: (kind: Own, slug: string) => schema.make(`own-${kind}-${slug}`),
    /** Creates a fresh random slot id. Callers must still reject ids already present in the registry (R-ID-3). */
    create: (kind: Own, length = 6) => {
      const bytes = crypto.getRandomValues(new Uint8Array(Math.min(8, Math.max(4, length))))
      return schema.make(`own-${kind}-${Array.from(bytes, (byte) => SLUG_CHARS[byte % 36]).join("")}`)
    },
    /** Returns the kind and slug of an own slot id, or `undefined` for any other provider id. */
    parse: (providerID: string) => {
      const match = PROVIDER_ID_PATTERN.exec(providerID)
      const kind = match?.[1]
      if (!match || !Schema.is(Own)(kind)) return undefined
      return { kind, slug: match[2] }
    },
  })),
)
export type ProviderID = typeof ProviderID.Type

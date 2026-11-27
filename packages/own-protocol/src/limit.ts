export * as Limit from "./limit.js"

import { Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { AccountID } from "./account-id.js"
import { EpochMillis, NonNegative } from "./id.js"

export const Scope = Schema.Literals(["account", "quota_domain"]).annotate({ identifier: "Own.Limit.Scope" })
export type Scope = typeof Scope.Type

export const WindowKind = Schema.Literals(["rolling_quota", "rate", "balance", "spend_cap", "budget"]).annotate({
  identifier: "Own.Limit.WindowKind",
})
export type WindowKind = typeof WindowKind.Type

export const Unit = Schema.Literals([
  "requests",
  "tokens",
  "input_tokens",
  "output_tokens",
  "USD",
  "CNY",
  "credits",
]).annotate({ identifier: "Own.Limit.Unit" })
export type Unit = typeof Unit.Type

export const Status = Schema.Literals(["ok", "warning", "exhausted", "unknown"]).annotate({
  identifier: "Own.Limit.Status",
})
export type Status = typeof Status.Type

/** `live` ≤ 2 min, `recent` ≤ 15 min, `stale` older, `estimated` after an unobserved reset (02 §7.4). */
export const Confidence = Schema.Literals(["live", "recent", "stale", "estimated", "unknown"]).annotate({
  identifier: "Own.Limit.Confidence",
})
export type Confidence = typeof Confidence.Type

export const Source = Schema.Literals(["header", "ws_event", "poll", "error", "ledger", "estimate"]).annotate({
  identifier: "Own.Limit.Source",
})
export type Source = typeof Source.Type

/**
 * Well-known window ids (02 §7.3). Codex product families add `codex.<limitId>.primary|secondary`, so ids are
 * open strings rather than a closed set.
 */
export const WindowIDs = [
  "codex.primary",
  "codex.secondary",
  "codex.credits",
  /** A Sign in with ChatGPT usage limit whose 429 body named its reset (02 §3.2c). */
  "siwc.usage",
  "claude.5h",
  "claude.7d",
  /**
   * Claude Code's "Fable limit", a per-model weekly bucket (`7d_oi-*` headers, LV 2026-10-24). It and the two below
   * limit one model family only (`LimitModel`).
   */
  "claude.7d_oi",
  /** Model weekly windows a response names only as its `representative-claim` (status and reset, no percent). */
  "claude.7d_opus",
  "claude.7d_sonnet",
  "claude.overage",
  "anth.requests",
  "anth.input_tokens",
  "anth.output_tokens",
  "oai.requests",
  "oai.tokens",
  "ds.balance",
  "ds.balance.granted",
  "or.key_limit",
  "api.budget_month",
] as const

/** Normalized limit/usage window shared by every kind (02 §7.3). */
export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  /** `acc_claude_slot` for the Claude subscription slot. */
  accountID: AccountID,
  providerID: Provider.ID,
  scope: Scope,
  kind: WindowKind,
  /** Display label, e.g. "5시간", "주간", "잔액". */
  label: Schema.String,
  windowMinutes: optional(NonNegative),
  /** Usually 0..100; Codex may report more than 100 when exhausted. */
  usedPercent: optional(NonNegative),
  remaining: optional(Schema.Finite),
  limit: optional(Schema.Finite),
  unit: optional(Unit),
  resetAt: optional(EpochMillis),
  status: Status,
  confidence: Confidence,
  source: Source,
  observedAt: EpochMillis,
  /**
   * Claude unified `representative-claim` is kept as `meta.representative`. On `claude.overage` only (02 §8.9, CW
   * 2026-10-19): `billing`, how the account's latest response says it is billed (`extra_usage`: moved to extra usage;
   * `rejected`: refused because extra usage is off or used up), and `disabledReason`, the raw
   * `overage-disabled-reason` header.
   */
  meta: optional(
    Schema.Struct({
      representative: optional(Schema.String),
      billing: optional(Schema.Literals(["extra_usage", "rejected"])),
      disabledReason: optional(Schema.String),
    }),
  ),
  /**
   * Who observed it (04 §10.4): absent or `"local"` for the local service, the SSH host's `hostId` for a remote
   * observation the local broker merged. Used for display and the integrity rules of 04 §10.5.
   */
  origin: optional(Schema.String),
}).annotate({ identifier: "Own.Limit.Window" })

/**
 * A ChatGPT usage-limit reset credit ("리셋권", 02 §7.1.1), as `GET <chatgpt>/wham/rate-limit-reset-credits` lists it.
 * Not a {@link Window}: redeeming one resets the plan windows, it limits nothing itself. Never the paid `codex.credits`.
 */
export interface ResetCredit extends Schema.Schema.Type<typeof ResetCredit> {}
export const ResetCredit = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  /** `codex_rate_limits` so far; another value passes as received. */
  type: Schema.String,
  /** The backend's status; a value it adds later is `unknown`. */
  status: Schema.Literals(["available", "redeeming", "redeemed", "unknown"]),
  grantedAt: EpochMillis,
  /** Absent: it does not expire. */
  expiresAt: optional(EpochMillis),
  title: optional(Schema.String),
  description: optional(Schema.String),
}).annotate({ identifier: "Own.Limit.ResetCredit" })

/**
 * An account's reset credits (02 §7.1.1): the count `wham/usage` reports (`rate_limit_reset_credits`), and the credits
 * themselves once the 리셋권 dialog read them. Only `codex` accounts have one; the newest observation wins.
 */
export interface ResetCredits extends Schema.Schema.Type<typeof ResetCredits> {}
export const ResetCredits = Schema.Struct({
  accountID: AccountID,
  providerID: Provider.ID,
  availableCount: NonNegativeInt,
  /** `applicable_available_count`, as received; what it counts is not documented (02 §7.1.1). */
  applicableCount: optional(NonNegativeInt),
  /** Known only after a details read (the dialog); a later count-only observation keeps the ones still counted. */
  credits: optional(Schema.Array(ResetCredit)),
  observedAt: EpochMillis,
  source: Schema.Literal("poll"),
  /** As {@link Window} `origin`; absent for this PC. */
  origin: optional(Schema.String),
}).annotate({ identifier: "Own.Limit.ResetCredits" })

/** `OWN_HOME\state\limits.json`: the last snapshot of every window, written by the runtime leader (02 §2.3). */
export interface SnapshotFile extends Schema.Schema.Type<typeof SnapshotFile> {}
export const SnapshotFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  savedAt: EpochMillis,
  windows: Schema.Array(Window),
  /** The last reset credit count of each ChatGPT account (02 §7.1.1); absent from files of older builds. */
  resetCredits: optional(Schema.Array(ResetCredits)),
}).annotate({ identifier: "Own.Limit.SnapshotFile" })

export const ExhaustionClass = Schema.Literals(["hard", "transient", "auth"]).annotate({
  identifier: "Own.Limit.ExhaustionClass",
})
export type ExhaustionClass = typeof ExhaustionClass.Type

/**
 * Retry-hook classification pushed to the runtime (02 §5.2). `until` is `resetAt` plus 1–3 min jitter, or a
 * 15/30/60 min backoff when the reset is unknown. A success from another session clears it.
 */
export interface Exhaustion extends Schema.Schema.Type<typeof Exhaustion> {}
export const Exhaustion = Schema.Struct({
  accountID: AccountID,
  windowId: Schema.NullOr(Schema.String),
  until: EpochMillis,
  class: ExhaustionClass,
  /** The classification's reason code, e.g. `subscription_sharing_usage_limit_exceeded` (02 §3.2c). */
  reason: optional(Schema.String),
}).annotate({ identifier: "Own.Limit.Exhaustion" })

/**
 * An exhaustion in force, as `quota.snapshot` reports it for a resync (02 §9.1): `reason` is the one its
 * `account.status` announced (the exhausted window, else the classification code, else the class).
 */
export interface Exhausted extends Schema.Schema.Type<typeof Exhausted> {}
export const Exhausted = Schema.Struct({
  accountID: AccountID,
  reason: Schema.String,
  until: EpochMillis,
}).annotate({ identifier: "Own.Limit.Exhausted" })

/**
 * The worst account-wide window of an account (model weekly buckets left out, `LimitModel`), for the compact limit bar
 * in `accounts.list` (02 §9.2).
 */
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  worst: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      /** The window's {@link Window} `label` (`5시간`), so a card names it before the windows arrive; older services send none. */
      label: optional(Schema.String),
      usedPercent: optional(Schema.NullOr(NonNegative)),
      resetAt: optional(Schema.NullOr(EpochMillis)),
      status: Status,
    }),
  ),
}).annotate({ identifier: "Own.Limit.Summary" })

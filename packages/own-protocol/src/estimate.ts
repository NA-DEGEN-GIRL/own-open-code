export * as Estimate from "./estimate.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { AccountID } from "./account-id.js"
import { Compaction } from "./compaction.js"
import { EpochMillis, EstimateID, NonNegative } from "./id.js"

/** Estimate unit: codex credits, API USD, or subscription quota percent (02 §6.1). */
export const Unit = Schema.Literals(["credits", "USD", "percent"]).annotate({ identifier: "Own.Estimate.Unit" })
export type Unit = typeof Unit.Type

/** A cost range. The UI prints `+X` when `lo === hi`, otherwise `+X~Y` (02 §6.5). */
export interface Delta extends Schema.Schema.Type<typeof Delta> {}
export const Delta = Schema.Struct({ lo: Schema.Finite, hi: Schema.Finite, unit: Unit }).annotate({
  identifier: "Own.Estimate.Delta",
})

export const Strategy = Schema.Literals([
  "now",
  "compact-then-switch",
  "switch-then-compact",
  "cold-point",
  "new-session",
  "fork",
]).annotate({ identifier: "Own.Estimate.Strategy" })
export type Strategy = typeof Strategy.Type

export const ScheduleTrigger = Schema.Literals(["compaction", "idle_ttl", "either"]).annotate({
  identifier: "Own.Estimate.ScheduleTrigger",
})
export type ScheduleTrigger = typeof ScheduleTrigger.Type

export const Warning = Schema.Literals([
  "same_org_no_headroom",
  "cross_provider_reasoning_loss",
  "target_context_too_small",
  "image_trim",
  "anthropic_compaction_may_be_cold",
  "rate_unknown",
  /** `0.8·T_t ≤ P_t < T_t`: the target compacts soon after the switch (02 §4.7.5, v0.3). */
  "target_compacts_soon",
  /** The summary the target would run exceeds its budget `T_t` (02 §4.7.5, v0.3). */
  "compaction_may_truncate",
]).annotate({ identifier: "Own.Estimate.Warning" })
export type Warning = typeof Warning.Type

export const UnavailableReason = Schema.Literals([
  "source_available",
  "source_exhausted",
  "source_already_cold",
  "ttl_too_long",
  "rate_unknown",
  "policy_denied",
  "target_context_too_small",
  /** v0.4: a staged revert blocks every strategy that sends `POST /compact` (02 §4.7.4). */
  "revert_staged",
]).annotate({ identifier: "Own.Estimate.UnavailableReason" })
export type UnavailableReason = typeof UnavailableReason.Type

/** `calibrating`: no % shown; `partial`: range only; `calibrated`: point estimate with a 90% range (02 §6.3 ⑪). */
export const CalibrationState = Schema.Literals(["calibrating", "partial", "calibrated"]).annotate({
  identifier: "Own.Estimate.CalibrationState",
})
export type CalibrationState = typeof CalibrationState.Type

export interface QuotaImpact extends Schema.Schema.Type<typeof QuotaImpact> {}
export const QuotaImpact = Schema.Struct({
  /** Limit window id, e.g. `codex.primary`. */
  window: Schema.String,
  percent: Schema.NullOr(Schema.Struct({ lo: Schema.Finite, hi: Schema.Finite, point: optional(Schema.Finite) })),
  state: CalibrationState,
}).annotate({ identifier: "Own.Estimate.QuotaImpact" })

/** One `switch.estimate` option (02 §9.2). Field presence depends on the strategy. */
export interface Option extends Schema.Schema.Type<typeof Option> {}
export const Option = Schema.Struct({
  strategy: Strategy,
  available: Schema.Boolean,
  /** The four dialog options are `primary`; `fork` is `secondary` ("더 보기") (02 §6.5). */
  display: Schema.Literals(["primary", "secondary"]),
  /** Set only by the 02 §5.6 rules; never set across billing units. */
  recommended: optional(Schema.Boolean),
  /** Why the option is unavailable. */
  reason: optional(UnavailableReason),
  /** `null` with `reason: "rate_unknown"` when a needed rate is unknown (02 §2.4.4). */
  delta: optional(Schema.NullOr(Delta)),
  quota: optional(QuotaImpact),
  perRequestAfter: optional(Schema.NullOr(Schema.Finite)),
  /** `cold-point` only. */
  trigger: optional(ScheduleTrigger),
  idleMinutes: optional(NonNegative),
  /** The source TTL upper bound is unknown (e.g. codex), shown as "캐시 유지 시간 미측정". */
  uncertain: optional(Schema.Boolean),
  /** `new-session` loses part of the context. */
  contextLoss: optional(Schema.Boolean),
  warnings: optional(Schema.Array(Warning)),
}).annotate({ identifier: "Own.Estimate.Option" })

export const VariantOnlyReason = Schema.Literals([
  "message_effort_update",
  "route_unsupported",
  "non_effort_variant",
  "effort_marker_mismatch",
]).annotate({ identifier: "Own.Estimate.VariantOnlyReason" })
export type VariantOnlyReason = typeof VariantOnlyReason.Type

/** Set when the target differs from the current Ref only by `variant` (02 §5.1). */
export interface VariantOnly extends Schema.Schema.Type<typeof VariantOnly> {}
export const VariantOnly = Schema.Struct({ preservesCache: Schema.Boolean, reason: VariantOnlyReason }).annotate({
  identifier: "Own.Estimate.VariantOnly",
})

/** `switch.estimate` result (02 §9.2). */
export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  estimateID: EstimateID,
  /** PLANNED expires five minutes after the estimate (02 §5.4). */
  expiresAt: EpochMillis,
  context: Schema.Struct({
    P: NonNegative,
    Z: NonNegative,
    units: Schema.Struct({ source: Unit, target: Unit }),
  }),
  target: Schema.Struct({
    providerID: Provider.ID,
    id: Model.ID,
    variant: optional(Model.VariantID),
    /** `P_t < compactAt.triggerTokens`: the target does not compact right after the switch. */
    fits: Schema.Boolean,
    /** The target's window and effective threshold (session value included), for the switcher (v0.3, 03 §5.8.6). */
    compactAt: optional(
      Schema.Struct({ windowTokens: PositiveInt, triggerTokens: PositiveInt, source: Compaction.Source }),
    ),
    /**
     * The Claude account the target runs on (`anthropic` only, SL-17): the `switch.estimate` input's `accountID`, else
     * the account the session's tree runs on. Absent for every other provider (one account each) and from older
     * services.
     */
    accountID: optional(AccountID),
  }),
  options: Schema.Array(Option),
  warnings: optional(Schema.Array(Warning)),
  variantOnly: Schema.NullOr(VariantOnly),
  /**
   * 07 §5.5: subagents still running on the account the main leaves, when the target is another subscription of the
   * same company. The switch then waits for them (`switch.apply{children:"after-idle"}`) or stops them first
   * (`"stop"`), so one root never uses both subscriptions at once. `null` (or absent, older services) = none.
   */
  busyChildren: optional(Schema.NullOr(Schema.Struct({ count: PositiveInt, accountID: AccountID }))),
  /** Measured steps in this session and the estimator's recent relative error (02 §6.5, §7.7). */
  confidence: Schema.Struct({ steps: NonNegativeInt, recentError: Schema.NullOr(NonNegative) }),
  /** Estimator inputs, for the dialog's details view. Rates are per 1M tokens. */
  inputs: Schema.Struct({
    W_lo: NonNegative,
    W_hi: NonNegative,
    rates: Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)),
    ttl: Schema.Struct({ lo: Schema.NullOr(NonNegative), hi: Schema.NullOr(NonNegative) }),
  }),
}).annotate({ identifier: "Own.Estimate.Result" })

/** Ranked switch target with its reason (02 §5.7), used by `switch.suggested`. */
export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}
export const Candidate = Schema.Struct({
  providerID: Provider.ID,
  accountID: optional(Schema.NullOr(AccountID)),
  target: optional(Model.Ref),
  score: Schema.NullOr(Schema.Finite),
  deltaNow: Schema.NullOr(Delta),
  perRequest: Schema.NullOr(Schema.Finite),
  /** `min(1 − used%/100)` over the account's windows. */
  headroom: Schema.NullOr(Schema.Finite),
  excludedReason: optional(Schema.String),
}).annotate({ identifier: "Own.Estimate.Candidate" })

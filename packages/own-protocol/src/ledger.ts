export * as Ledger from "./ledger.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { AccountID } from "./account-id.js"
import { CompactionCache } from "./compaction-cache.js"
import { EpochMillis, NonNegative } from "./id.js"
import { Ratecard } from "./ratecard.js"

/**
 * Request kind of a ledger line; `generate` lines carry `tokens: null` (02 §7.5). `image`: one call of own's image
 * tool (02 §9.6): an API key's line carries its Images API tokens and USD, a subscription's none. `side`: one side question
 * (곁질문, 02 §9.7), with the usage core reported; never a step, so turn footers and compaction leave it out.
 */
export const RequestKind = Schema.Literals(["primary", "compaction", "title", "generate", "image", "side"]).annotate({
  identifier: "Own.Ledger.RequestKind",
})
export type RequestKind = typeof RequestKind.Type

export interface Tokens extends Schema.Schema.Type<typeof Tokens> {}
export const Tokens = Schema.Struct({
  input: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  /** Anthropic 1h writes, only in precise mode. */
  cacheWrite1h: Schema.NullOr(NonNegativeInt),
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
}).annotate({ identifier: "Own.Ledger.Tokens" })

/** Where a line's token counts came from (02 §7.5, v0.3): core's step event, a response-stream copy, or an estimate. */
export const UsageSource = Schema.Literals(["event", "stream", "estimate"]).annotate({
  identifier: "Own.Ledger.UsageSource",
})
export type UsageSource = typeof UsageSource.Type

export const CostSource = Schema.Literals(["ratecard", "opencode", "estimate"]).annotate({
  identifier: "Own.Ledger.CostSource",
})
export type CostSource = typeof CostSource.Type

/** An amount in a rate unit (`credits` for codex, `USD` for API keys). */
export interface Amount extends Schema.Schema.Type<typeof Amount> {}
export const Amount = Schema.Struct({ unit: Ratecard.Unit, amount: Schema.Finite }).annotate({
  identifier: "Own.Ledger.Amount",
})

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({ unit: Ratecard.Unit, amount: Schema.Finite, source: CostSource }).annotate({
  identifier: "Own.Ledger.Cost",
})

/**
 * One line of `OWN_HOME\ledger\usage-YYYY-MM.jsonl` and the `ledger.step` event (02 §7.5).
 * Never carries message content or token values.
 */
export interface Line extends Schema.Schema.Type<typeof Line> {}
export const Line = Schema.Struct({
  v: Schema.Literal(1),
  ts: EpochMillis,
  sessionID: SessionID,
  /**
   * `primary`: the step's assistant message. `compaction`: the compaction message (SL 2026-10-26; `null` on lines
   * written before it). `null` for `title` and `generate`.
   */
  messageID: Schema.NullOr(Schema.String),
  kind: RequestKind,
  /**
   * `null` for providers without an own account (built-ins, external switches). For `anthropic`, the Claude account
   * that signed the request (G4, 02 §8.7): the UI names a step's or compaction's account from it, not from the provider.
   */
  accountID: Schema.NullOr(AccountID),
  providerID: Provider.ID,
  modelID: Model.ID,
  variant: Schema.NullOr(Model.VariantID),
  /** Pooling mode only: the account whose credential the request used. */
  credentialRef: Schema.NullOr(AccountID),
  transport: Schema.NullOr(Provider.Transport),
  switchEpoch: NonNegativeInt,
  compactionEpoch: NonNegativeInt,
  tokens: Schema.NullOr(Tokens),
  /** Estimated request input size. */
  P: Schema.NullOr(NonNegative),
  /** Cache hit ratio 0..1. */
  hit: Schema.NullOr(NonNegative),
  cost: Schema.NullOr(Cost),
  costUSDOpenCode: Schema.NullOr(Schema.Finite),
  /** Estimator prediction for the first step after a switch (AC-P14). */
  coldExpected: Schema.NullOr(NonNegative),
  /** v0.3 (02 §9.5); absent on lines written before it. */
  usageSource: optional(UsageSource),
  /** `warming` for a request sent only to warm a cache (v0.3); `null`/absent otherwise. */
  purpose: optional(Schema.NullOr(Schema.Literal("warming"))),
  /**
   * Server the step ran on (04 §10.4): `"local"` or the SSH host's `hostId`. Absent reads as `"local"` (v1 lines and
   * every line the local service writes itself). Set by the local broker when it records a remote observation.
   */
  server: optional(Schema.String),
  /** Remote lines only: the remote clock's `ts` before clock-skew normalization (04 §10.5). */
  remoteAt: optional(EpochMillis),
  /**
   * 02 §4.8: the speed tier own sent (`priority`, `ultrafast`, Anthropic `fast`) and the one the response named
   * (`served`; `default`/`standard` is a silent downgrade, `null` = not reported). Absent for a Standard request.
   */
  speed: optional(Schema.Struct({ requested: Schema.String, served: Schema.NullOr(Schema.String) })),
  /**
   * Compaction lines (CC 2026-10-24, P-034): the request the summary came from (`full`: the whole history, read from
   * the session's cache; `older`: the part before the kept messages) and why, and `trigger: "idle"` for one own
   * admitted while the user was away (02 §4.7.7). `hit` is the cached share over all of the compaction's requests.
   */
  compaction: optional(CompactionCache.Sent),
}).annotate({ identifier: "Own.Ledger.Line" })

/** A block of a request prefix in cache order (P0-2b): the tool definitions, a system part, a message or input item. */
export const PrefixBlock = Schema.Literals(["tools", "system", "message"]).annotate({
  identifier: "Own.Ledger.PrefixBlock",
})
export type PrefixBlock = typeof PrefixBlock.Type

/**
 * How a primary request's prefix relates to the previous primary request of its session and slot (P0-2b, 02 §7.8):
 * `first` (nothing to compare with), `append` (the previous request is reused whole), else what explains the first
 * block that differs, in this order: a `compaction` request or event, a committed `revert`, a context `reset` or its
 * undo (`reset-undo`, core P-035, 11 §7), another `model` or variant,
 * another `agent`, a change of the tool definitions or system (`toolset`, alerted by D10 as `toolset_changed`), and for
 * a message a `strip` rule (02 §4.4), core's `image-trim` cut (02 §4.3 D8) or an `instructions` update; else
 * `unexplained` (alert `prefix_diverged`).
 */
export const PrefixCause = Schema.Literals([
  "first",
  "append",
  "compaction",
  "revert",
  "reset",
  "reset-undo",
  "model",
  "agent",
  "strip",
  "image-trim",
  "instructions",
  "toolset",
  "unexplained",
]).annotate({ identifier: "Own.Ledger.PrefixCause" })
export type PrefixCause = typeof PrefixCause.Type

/**
 * `data` of a `prefix` line of `events-YYYY-MM.jsonl` (P0-2b, 02 §7.8): one per own-slot primary request while a
 * capture window records its session and slot. Block counts and kinds only, never content or hashes.
 */
export interface Prefix extends Schema.Schema.Type<typeof Prefix> {}
export const Prefix = Schema.Struct({
  cause: PrefixCause,
  /** Leading blocks this request shares with the previous one (tools, system parts, messages in cache order). */
  lcp: NonNegativeInt,
  /** Blocks of the previous request; `null` for `first`. `lcp` equal to it: nothing before was rewritten. */
  previous: Schema.NullOr(NonNegativeInt),
  /** Blocks of this request. */
  blocks: NonNegativeInt,
  /** Kind of the first previous block that differs; `null` when none does. */
  at: Schema.NullOr(PrefixBlock),
  modelID: Model.ID,
  variant: Schema.NullOr(Model.VariantID),
  agent: Schema.String,
  /** Milliseconds the request hook spent on the fingerprint and the comparison. */
  ms: NonNegative,
}).annotate({ identifier: "Own.Ledger.Prefix" })

/** `Line.server` of lines the local service wrote (04 §10.4). */
export const LOCAL_SERVER = "local"

/** The server of a line: its `server`, or `"local"` when absent (04 §10.4 "없으면 local로 읽는다"). */
export function serverOf(line: { readonly server?: string | undefined }) {
  return line.server ?? LOCAL_SERVER
}

export interface TokenTotals extends Schema.Schema.Type<typeof TokenTotals> {}
export const TokenTotals = Schema.Struct({
  input: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  output: NonNegativeInt,
  reasoning: NonNegativeInt,
}).annotate({ identifier: "Own.Ledger.TokenTotals" })

/** Aggregate over ledger lines; `cost` has one entry per unit. */
export interface Totals extends Schema.Schema.Type<typeof Totals> {}
export const Totals = Schema.Struct({
  requests: NonNegativeInt,
  tokens: TokenTotals,
  cost: Schema.Array(Amount),
  hitRate: Schema.NullOr(NonNegative),
}).annotate({ identifier: "Own.Ledger.Totals" })

/** `server` (04 §16.5): one row per server (`"local"` or a `hostId`). */
export const GroupBy = Schema.Literals(["hour", "day", "session", "model", "server"]).annotate({
  identifier: "Own.Ledger.GroupBy",
})
export type GroupBy = typeof GroupBy.Type

/** One `accounts.usage` row (02 §9.2). `session` rows fill the session-only fields (03 §5.5). */
export interface UsageRow extends Schema.Schema.Type<typeof UsageRow> {}
export const UsageRow = Schema.Struct({
  key: Schema.String,
  ...Totals.fields,
  projectID: optional(Schema.NullOr(Schema.String)),
  switchCount: optional(NonNegativeInt),
  lastActivityAt: optional(EpochMillis),
  accountIDs: optional(Schema.Array(AccountID)),
  modelIDs: optional(Schema.Array(Model.ID)),
  /** 04 §16.5: the row's servers (`"local"` or `hostId`s), sorted. */
  servers: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Own.Ledger.UsageRow" })

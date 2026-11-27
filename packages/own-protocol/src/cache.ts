export * as Cache from "./cache.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { AccountID } from "./account-id.js"
import { Compaction } from "./compaction.js"
import { EpochMillis, NonNegative } from "./id.js"

/** Anthropic TTL mode, KV `sess:<sid>:ttlMode:<providerID>` (02 §4.5, Phase 3). */
export const TtlMode = Schema.Literals(["5m", "1h"]).annotate({ identifier: "Own.Cache.TtlMode" })
export type TtlMode = typeof TtlMode.Type

/**
 * `warm`: age < TTL_lo; `cooling`: TTL_lo ≤ age < TTL_hi; `cold`: age ≥ TTL_hi or epoch/model/variant changed;
 * `unknown`: TTL_hi unknown and age ≥ TTL_lo (02 §9.2).
 */
export const Temperature = Schema.Literals(["warm", "cooling", "cold", "unknown"]).annotate({
  identifier: "Own.Cache.Temperature",
})
export type Temperature = typeof Temperature.Type

/** Per-slot cache state of a session, KV `sess:<sid>:cache:<providerID>`, updated from step events (02 §2.4.6). */
export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  lastReqAt: EpochMillis,
  /** Input size of the slot's last request. */
  L: NonNegative,
  epoch: NonNegativeInt,
  modelID: Model.ID,
  variant: Schema.NullOr(Model.VariantID),
  watermark: Schema.NullOr(Schema.Struct({ messageID: Schema.String, partIndex: NonNegativeInt })),
  blocksSince: NonNegativeInt,
  messageEndsSince: NonNegativeInt,
  imageTrimEpoch: NonNegativeInt,
  /**
   * The account that signed the slot's last request (the ledger line's, SL 2026-10-26): several Claude accounts share
   * `anthropic`, and a company's cache belongs to one account. Absent on entries written before it.
   */
  accountID: optional(Schema.NullOr(AccountID)),
}).annotate({ identifier: "Own.Cache.Entry" })

/**
 * The account a slot's cache entry is keyed by (`Kv.cache`, SL-8): the Claude accounts share `anthropic` and each has
 * its own prompt cache, so an `anthropic` entry belongs to the account that signed its request; so do the Claude Agent
 * accounts on `claude-agent` (CAG-53). Every other provider is one account (`undefined`: keyed by the provider alone),
 * as is `anthropic` without an account (a built-in key).
 */
export function keyAccount(providerID: string, accountID: string | null | undefined) {
  return (providerID === Provider.ID.anthropic || providerID === Provider.ID.claudeAgent) && accountID
    ? accountID
    : undefined
}

/** One slot in `cache.state` (02 §9.2). */
export interface Slot extends Schema.Schema.Type<typeof Slot> {}
export const Slot = Schema.Struct({
  providerID: Provider.ID,
  state: Temperature,
  L: NonNegative,
  lastReqAt: EpochMillis,
  warmUntil: optional(Schema.NullOr(EpochMillis)),
  coldAfter: optional(Schema.NullOr(EpochMillis)),
  epoch: optional(NonNegativeInt),
  blocksSince: optional(NonNegativeInt),
  ttlMode: optional(TtlMode),
  /**
   * The account whose cache this is (SL 2026-10-26): the one that signed the slot's last request. Another Claude account
   * of the same slot has none of it, so a client shows this state only for this account. Since SL-8 each Claude account
   * of a session has its own slot (`anthropic` once per account). Absent when not known.
   */
  accountID: optional(AccountID),
}).annotate({ identifier: "Own.Cache.Slot" })

/** `cache.state` result and the `cache.state` event body (02 §9.2, §9.3). */
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  sessionID: SessionID,
  now: EpochMillis,
  slots: Schema.Array(Slot),
  /** Auto-compaction view of the session's current model (02 §4.7.4, §9.2); `null` when unpinned. */
  compaction: optional(Schema.NullOr(Compaction.View)),
}).annotate({ identifier: "Own.Cache.Snapshot" })

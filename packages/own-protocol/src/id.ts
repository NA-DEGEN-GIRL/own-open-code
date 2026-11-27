export * as OwnID from "./id.js"

import { Schema } from "effect"
import { statics } from "@opencode/schema/schema"

// Crockford base32, as used by ULID.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A 26-character ULID (48-bit millisecond time + 80 random bits). Browser-safe. */
export function ulid(timestamp = Date.now()) {
  const time = Array.from({ length: 10 }, (_, index) => ALPHABET[Math.floor(timestamp / 32 ** (9 - index)) % 32]).join(
    "",
  )
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => ALPHABET[byte % 32]).join("")
  return time + random
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Event id (ULID) attached to every `rpc.own.accounts.*` event for de-duplication (02 §9.1). */
export const EventID = Schema.String.check(Schema.isPattern(ULID_PATTERN)).pipe(
  Schema.brand("Own.EventID"),
  Schema.annotate({ identifier: "Own.EventID" }),
  statics((schema) => ({ create: () => schema.make(ulid()) })),
)
export type EventID = typeof EventID.Type

/** `switch.estimate` result id (`est_<ulid>`). */
export const EstimateID = Schema.String.check(Schema.isPattern(/^est_[0-9A-Za-z]+$/)).pipe(
  Schema.brand("Own.EstimateID"),
  Schema.annotate({ identifier: "Own.EstimateID" }),
  statics((schema) => ({ create: () => schema.make("est_" + ulid()) })),
)
export type EstimateID = typeof EstimateID.Type

/** ChatGPT login attempt id (`att_<ulid>`). */
export const AttemptID = Schema.String.check(Schema.isPattern(/^att_[0-9A-Za-z]+$/)).pipe(
  Schema.brand("Own.AttemptID"),
  Schema.annotate({ identifier: "Own.AttemptID" }),
  statics((schema) => ({ create: () => schema.make("att_" + ulid()) })),
)
export type AttemptID = typeof AttemptID.Type

/** One-time token returned by a destructive `*.plan` call and consumed by the matching `*.execute` (02 §9.2). */
export const Nonce = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)).pipe(
  Schema.brand("Own.Nonce"),
  Schema.annotate({ identifier: "Own.Nonce" }),
  statics((schema) => ({
    create: () =>
      schema.make(Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => ALPHABET[byte % 32]).join("")),
  })),
)
export type Nonce = typeof Nonce.Type

/** ISO-8601 UTC timestamp string used in the registry files, e.g. `2026-09-26T11:02:00Z`. */
export const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/),
).annotate({ identifier: "Own.IsoDateTime" })
export type IsoDateTime = typeof IsoDateTime.Type

/** Epoch milliseconds. */
export const EpochMillis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "Own.EpochMillis",
})
export type EpochMillis = typeof EpochMillis.Type

export const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const REGISTRY_KEY = /^[a-z0-9][a-z0-9_]*$/

/** Cache domain key in `accounts.json.cacheDomains` (`cd_…`, 02 §2.4.1). */
export const CacheDomainID = Schema.String.check(Schema.isStartingWith("cd_"), Schema.isPattern(REGISTRY_KEY)).pipe(
  Schema.brand("Own.CacheDomainID"),
  Schema.annotate({ identifier: "Own.CacheDomainID" }),
)
export type CacheDomainID = typeof CacheDomainID.Type

/** Quota domain key in `accounts.json.quotaDomains` (`qd_…`, 02 §2.4.1). */
export const QuotaDomainID = Schema.String.check(Schema.isStartingWith("qd_"), Schema.isPattern(REGISTRY_KEY)).pipe(
  Schema.brand("Own.QuotaDomainID"),
  Schema.annotate({ identifier: "Own.QuotaDomainID" }),
)
export type QuotaDomainID = typeof QuotaDomainID.Type

/** Pinned model template key in `accounts.json.modelTemplates` (`tpl_…`, 02 §2.4.2). */
export const TemplateID = Schema.String.check(Schema.isStartingWith("tpl_"), Schema.isPattern(REGISTRY_KEY)).pipe(
  Schema.brand("Own.TemplateID"),
  Schema.annotate({ identifier: "Own.TemplateID" }),
)
export type TemplateID = typeof TemplateID.Type

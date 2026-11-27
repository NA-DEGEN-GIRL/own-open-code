export * as CompactionCache from "./compaction-cache.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { SessionMessage } from "@opencode/schema/session-message"
import { NonNegative } from "./id.js"

/**
 * Cache-preserving summary compaction (core P-034) and idle compaction before the cache expires (02 §4.7.7), CC
 * 2026-10-24. Kept apart from the threshold rules (`Compaction`) so own-web's first chunk does not carry them.
 */

/**
 * Checkpoint metadata keys. own-accounts' compaction hook (it runs before own-harness's) writes {@link CACHE_KEY}, its
 * verdict on sending the whole history (P-034), and {@link TRIGGER_KEY} `"idle"` on a compaction it admitted while the
 * user was away; core writes {@link PREFIX_KEY}, the request it used when a hook asked for the whole history.
 */
export const CACHE_KEY = "own.compaction.cache"
export const TRIGGER_KEY = "own.compaction.trigger"
export const PREFIX_KEY = "prefix"

/**
 * Why own-accounts allowed or refused the full-prefix request on the first run: `warm` (the Anthropic engine's
 * breakpoint cache, the API key or the Claude subscription, whose last primary request on this model started less than
 * `TTL_lo` ago), `cold` (longer ago), `model` (no primary request on this model and variant in this process),
 * `longest-prefix` (a cache that reads the longest cached prefix: ChatGPT, Sign in with ChatGPT, OpenAI before 5.6 or
 * without a lookback card, DeepSeek, xAI, OpenRouter, local servers; the older request already reads it, live
 * 2026-10-24), `unmeasured` (OpenAI GPT-5.6+, whose card sets a breakpoint lookback too, but the full request was not
 * measured there, CC-16), `no-ttl` (no warm guarantee: `TTL_lo` 0 or unknown), `account` (the compaction runs on
 * another Claude account than the one that signed that request: each account has its own cache, SL-8), `error` (the
 * verdict failed: fail closed). Checkpoints made before 2026-10-24's narrowing may hold `transport` (ChatGPT over WebSocket) or `thinking`
 * (DeepSeek thinking variants, local servers), which are both `longest-prefix` now.
 */
export const CacheReason = Schema.Literals([
  "warm",
  "cold",
  "model",
  "longest-prefix",
  "unmeasured",
  "no-ttl",
  "account",
  "error",
  "transport",
  "thinking",
]).annotate({ identifier: "Own.CompactionCache.CacheReason" })
export type CacheReason = typeof CacheReason.Type

export interface CacheVerdict extends Schema.Schema.Type<typeof CacheVerdict> {}
export const CacheVerdict = Schema.Struct({
  prefix: Schema.Literals(["full", "older"]),
  reason: CacheReason,
  /** Since the last primary request on this model started, and its `TTL_lo` (ms), when known. */
  ageMs: optional(NonNegative),
  ttlMs: optional(NonNegative),
}).annotate({ identifier: "Own.CompactionCache.CacheVerdict" })

/**
 * Core's record (P-034 `prefix`), what became of the full-prefix request: `full`, or `older` with `overflow`,
 * `thinking` (a fixed thinking budget), `fit`, `tier`, `failed`, `flattened` (nothing was kept and the whole history
 * went out as text), `declined`, or the reason own-accounts gave when it declined on the second run ({@link
 * RecentReason}). It stays on a stand-in's and a model-free summary's checkpoint, where {@link sentOf} reads past it.
 */
export interface PrefixRecord extends Schema.Schema.Type<typeof PrefixRecord> {}
export const PrefixRecord = Schema.Struct({
  request: Schema.Literals(["full", "older"]),
  reason: optional(Schema.String),
}).annotate({ identifier: "Own.CompactionCache.PrefixRecord" })

/** What a checkpoint's metadata says about its request (ledger and the 압축 내용 dialog). */
export interface Sent extends Schema.Schema.Type<typeof Sent> {}
export const Sent = Schema.Struct({
  /** `full`: the whole history, read from the session's cache; `older`: the part before the kept messages. */
  request: Schema.Literals(["full", "older"]),
  reason: optional(Schema.String),
  trigger: optional(Schema.Literal("idle")),
}).annotate({ identifier: "Own.CompactionCache.Sent" })

/**
 * Why own-accounts declined the full-prefix request on the second run (CC-12), where it sees the kept part as the
 * provider counts it: `short` (the kept part is within the lookback, so the older request reads the last request's
 * entry), `fresh` (longer, but the entry the older request would read was written less than `TTL_lo` ago), `error` (the
 * check failed: fail closed).
 */
export const RecentReason = Schema.Literals(["short", "fresh", "error"]).annotate({
  identifier: "Own.CompactionCache.RecentReason",
})
export type RecentReason = typeof RecentReason.Type

const decodeVerdict = Schema.decodeUnknownOption(CacheVerdict)
const decodeRecord = Schema.decodeUnknownOption(PrefixRecord)
/** Core's P-025 `fallback` record; a model-free summary's has no stand-in `model`. */
const decodeFallback = Schema.decodeUnknownOption(
  Schema.Struct({ failed: Schema.String, model: optional(Schema.String) }),
)

/** own-accounts' verdict in an event's or checkpoint's metadata; `undefined` without one. */
export function verdictOf(metadata: Readonly<Record<string, unknown>> | undefined) {
  const found = decodeVerdict(metadata?.[CACHE_KEY])
  return found._tag === "Some" ? found.value : undefined
}

/**
 * The request a checkpoint's summary came from: core's record when a hook asked for the whole history, else
 * own-accounts' refusal; `undefined` for a checkpoint made before P-034, without own's hooks, or by the model-free
 * digest, which no request wrote. A stand-in's summary came from that model's own older request, which read nothing
 * the session cached (`older`, `stand-in`, CC-16), whatever core recorded for the session model's attempt (`full` when
 * nothing was kept). Both records stay in the metadata.
 */
export function sentOf(metadata: Readonly<Record<string, unknown>> | undefined): Sent | undefined {
  const fallback = decodeFallback(metadata?.fallback)
  if (fallback._tag === "Some" && fallback.value.model === undefined) return undefined
  const trigger = metadata?.[TRIGGER_KEY] === "idle" ? { trigger: "idle" as const } : {}
  const record = decodeRecord(metadata?.[PREFIX_KEY])
  const verdict = verdictOf(metadata)
  // Only a checkpoint own's hooks saw (P-034's record or own-accounts' verdict) says what its request was.
  if (fallback._tag === "Some" && (record._tag === "Some" || verdict !== undefined))
    return { request: "older", reason: "stand-in", ...trigger }
  if (record._tag === "Some") return { ...record.value, ...trigger }
  return verdict ? { request: "older", reason: verdict.reason, ...trigger } : undefined
}

/** Idle compaction defaults (02 §4.7.7): it is an opt-in, off unless the user switches it on. */
export const IDLE = {
  /** Compact this long before the deadline (`TTL_lo` after the last request started). */
  leadSeconds: 30,
  /** Smaller contexts are cheap to rebuild cold; a 50k Opus rewrite is about $0.25. */
  minTokens: 100_000,
  /** The user must have been away at least this long when it would fire. */
  minIdleMinutes: 20,
  /** A subscription slot whose plan window is used beyond this share is left alone. */
  limitPercent: 80,
} as const

/**
 * KV `sess:<sid>:idleCompaction`: the one idle compaction admitted for a cold point epoch, its inbox item, when it was
 * admitted and the cache's deadline then. The compaction hook tells it from a user's `/compact` by the item, and drops
 * it when it delivers only after the deadline (CC-16).
 */
export interface IdleRecord extends Schema.Schema.Type<typeof IdleRecord> {}
export const IdleRecord = Schema.Struct({
  epoch: NonNegativeInt,
  inputID: SessionMessage.ID,
  at: NonNegative,
  deadline: NonNegative,
}).annotate({ identifier: "Own.CompactionCache.IdleRecord" })

/**
 * Whether a cache's lifetime suits idle compaction: it surely expires at its lower bound (`TTL_lo = TTL_hi > 0`). That
 * holds for OpenAI GPT-5.6+ (30 min) and Anthropic (5 min, or 1 h in the 1-hour mode); a cache whose end is unknown or
 * much later (ChatGPT, OpenAI before 5.6, DeepSeek, OpenRouter, xAI, local servers) may still be warm on return.
 */
export function idleSuits<T extends { readonly lo: number; readonly hi: number | null }>(
  ttl: T | undefined,
): ttl is T & { readonly hi: number } {
  return ttl !== undefined && ttl.lo > 0 && ttl.hi === ttl.lo
}

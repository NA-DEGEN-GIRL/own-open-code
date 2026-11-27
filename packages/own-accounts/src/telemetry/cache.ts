export * as CacheState from "./cache.js"

import { Option, Schema } from "effect"
import { Cache, Kv } from "@own/protocol"

/**
 * Per-session, per-slot cache state (KV `sess:<sid>:cache:<pid>`, 02 §2.4.6; per Claude account
 * `sess:<sid>:cache:anthropic@<accountID>`, SL-8) and its temperature (02 §9.2 `cache.state`). Pure but {@link read}.
 */

const decodeEntry = Schema.decodeUnknownOption(Cache.Entry)

/**
 * The slot's entry for the account that signs on it (SL-8, `Cache.keyAccount`): the Claude accounts share `anthropic`
 * and one account's cache is no other's. An `anthropic` entry written before per-account keys stands in while it names
 * this account or none. `get` reads the KV (a failed read is no entry).
 */
export async function read(
  get: (key: string) => Promise<unknown>,
  sessionID: string,
  providerID: string,
  accountID: string | null | undefined,
): Promise<Cache.Entry | undefined> {
  const account = Cache.keyAccount(providerID, accountID)
  const decode = async (key: string) => Option.getOrUndefined(decodeEntry(await get(key).catch(() => undefined)))
  const own = await decode(Kv.cache(sessionID, providerID, account))
  if (own || account === undefined) return own
  return legacyOf(await decode(Kv.cache(sessionID, providerID)), account)
}

/** An entry under the provider's key, written before per-account keys, as the entry of `accountID` (SL-8). */
export function legacyOf(entry: Cache.Entry | undefined, accountID: string) {
  return entry && (!entry.accountID || entry.accountID === accountID) ? entry : undefined
}

export interface Ttl {
  /** `TTL_lo` ms: surely warm below it. */
  readonly lo: number
  /** `TTL_hi` ms: surely cold from it; `null` = unknown. */
  readonly hi: number | null
}

/** Blocks a step appends at least (assistant message + tool results), for Anthropic's 20-block lookback. */
export const BLOCKS_PER_STEP = 2

/** The slot's entry after one of its own steps ended. */
export function afterStep(
  previous: Cache.Entry | undefined,
  step: {
    readonly at: number
    readonly P: number
    readonly epoch: number
    readonly modelID: Cache.Entry["modelID"]
    readonly variant: Cache.Entry["variant"]
    readonly messageID: string | null
    /** The account that signed the request (the ledger line's). */
    readonly accountID: Cache.Entry["accountID"]
  },
): Cache.Entry {
  return {
    lastReqAt: step.at,
    L: step.P,
    epoch: step.epoch,
    modelID: step.modelID,
    variant: step.variant,
    watermark: step.messageID === null ? (previous?.watermark ?? null) : { messageID: step.messageID, partIndex: 0 },
    blocksSince: 0,
    messageEndsSince: 0,
    imageTrimEpoch: previous?.imageTrimEpoch ?? 0,
    accountID: step.accountID ?? null,
  }
}

/** Another slot of the session took a step: the conversation moved on past this slot's last breakpoint. */
export function aged(entry: Cache.Entry): Cache.Entry {
  return {
    ...entry,
    blocksSince: entry.blocksSince + BLOCKS_PER_STEP,
    messageEndsSince: entry.messageEndsSince + 1,
  }
}

/**
 * `warm` age < TTL_lo; `cooling` TTL_lo ≤ age < TTL_hi; `cold` age ≥ TTL_hi or epoch/model/variant changed;
 * `unknown` when TTL_hi is unknown and age ≥ TTL_lo (02 §9.2).
 */
export function temperature(input: {
  readonly entry: Cache.Entry
  readonly ttl: Ttl | undefined
  readonly now: number
  readonly epoch: number
  /** The session's current model when it is on this slot. */
  readonly current?: { readonly modelID: string; readonly variant: string | null }
}) {
  const entry = input.entry
  const ttl = input.ttl ?? { lo: 0, hi: null }
  const warmUntil = entry.lastReqAt + ttl.lo
  const coldAfter = ttl.hi === null ? null : entry.lastReqAt + ttl.hi
  const changed =
    entry.epoch !== input.epoch ||
    (input.current !== undefined &&
      (input.current.modelID !== entry.modelID || input.current.variant !== entry.variant))
  const age = input.now - entry.lastReqAt
  const state: Cache.Temperature = changed
    ? "cold"
    : age < ttl.lo
      ? "warm"
      : ttl.hi === null
        ? "unknown"
        : age < ttl.hi
          ? "cooling"
          : "cold"
  return { state, warmUntil, coldAfter }
}

/** The next time any slot of the snapshot crosses a boundary after `now` (for the `cache.state` event timer). */
export function nextBoundary(slots: ReadonlyArray<Cache.Slot>, now: number) {
  return slots
    .flatMap((slot) => [slot.warmUntil ?? undefined, slot.coldAfter ?? undefined])
    .filter((at): at is number => at !== undefined && at > now)
    .toSorted((a, b) => a - b)[0]
}

/**
 * A committed revert removed the messages from `to` on (02 §4.7.4 "committed"): the slot's size is unknown now (the
 * epoch moves, so the estimator takes `W^lo = 0`), and lookback counters and a watermark past the boundary are
 * dropped. Message ids ascend, so a watermark at or after `to` pointed into the removed part.
 */
export function reverted(entry: Cache.Entry, to: string): Cache.Entry {
  const watermark = entry.watermark && entry.watermark.messageID >= to ? null : entry.watermark
  return { ...entry, watermark, blocksSince: 0, messageEndsSince: 0 }
}

/**
 * A context reset or its undo (11 §7, 02 §4.7.4): the request's message part changes from its first message (the
 * earlier messages leave it, or come back), so the size is unknown like after a revert and no watermark holds.
 */
export function cleared(entry: Cache.Entry): Cache.Entry {
  return { ...entry, watermark: null, blocksSince: 0, messageEndsSince: 0 }
}

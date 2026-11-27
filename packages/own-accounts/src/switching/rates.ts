export * as Rates from "./rates.js"

import { type Estimate, type Kind, Ratecard } from "@own/protocol"

/**
 * Effective rates and cache parameters of one slot × model (02 §6.1, §6.2). Rates are per 1M tokens in `unit`;
 * `null` means unknown, and the estimator then reports `rate_unknown` instead of computing with 0 (02 §2.4.4).
 */
export interface Rates {
  readonly unit: Estimate.Unit
  /** r_in. */
  readonly in: number | null
  /** r_read. Falls back to r_in (no discount) when neither the card nor the catalog gives it. */
  readonly read: number | null
  /** r_cold (02 §6.1): anth `write5m` (`write1h` in 1h mode), oai 5.6+ `writeMul·r_in`, otherwise r_in. */
  readonly cold: number | null
  /** r_out: the card's `out`, else the catalog `cost.output` (USD cards only). */
  readonly out: number | null
  /** TTL_lo in seconds: the cache is surely still warm before this age. */
  readonly ttlLo: number
  /** TTL_hi in seconds: the cache is surely cold after this age; `null` = unknown (e.g. codex). */
  readonly ttlHi: number | null
  readonly lookback: Ratecard.Lookback | null
  /**
   * `prefix`: automatic longest-prefix cache (codex, oai ≤5.5, ds, …), so a summary request right after the last
   * request hits (h_c ≈ 1). `breakpoint`: Anthropic-style breakpoints with a lookback (anth, oai 5.6+ ⚠).
   */
  readonly mode: "prefix" | "breakpoint"
}

/** Catalog `Model.Cost` entry (USD per 1M tokens). */
export interface CatalogCost {
  readonly input: number
  readonly output: number
  readonly cache?: { readonly read: number; readonly write: number }
}

/** The Claude subscription slot has no card: limit percent only, 5-minute cache with a 20-block lookback (02 §6.2). */
const CLAUDE_SLOT_TTL = { warmLowerSec: 300, coldUpperSec: 300 } as const
/**
 * Claude Code on a plan writes one-hour cache entries (02 §8.10.5; an API key's five minutes are rarer on this route and
 * the estimate only ranks moves the user makes by hand).
 */
const CLAUDE_AGENT_TTL = { warmLowerSec: 3600, coldUpperSec: 3600 } as const

/**
 * The most specific card for a kind and model (02 §2.4.4): an exact `model` beats a `modelGte`/`modelLt` range,
 * which beats a kind-only card; ties go to the earlier card.
 */
export function match(cards: ReadonlyArray<Ratecard.Card>, kind: Kind.Any, modelID: string) {
  const base = modelID.slice(modelID.lastIndexOf("/") + 1)
  const scored = cards.flatMap((card, index) => {
    if (card.match.kind !== kind) return []
    if (card.match.model !== undefined && card.match.model !== modelID && card.match.model !== base) return []
    if (card.match.modelGte !== undefined && !((compareVersion(base, card.match.modelGte) ?? -1) >= 0)) return []
    if (card.match.modelLt !== undefined && !((compareVersion(base, card.match.modelLt) ?? 0) < 0)) return []
    const ranged = card.match.modelGte !== undefined || card.match.modelLt !== undefined
    return [{ card, index, specificity: card.match.model !== undefined ? 3 : ranged ? 2 : 1 }]
  })
  return scored.sort((a, b) => b.specificity - a.specificity || a.index - b.index)[0]?.card
}

/**
 * Compares model versions such as `gpt-5.6-sol` and `gpt-5.6`: equal name prefixes, then the dotted numbers.
 * `undefined` when the two ids are not comparable (different families or no version).
 */
export function compareVersion(a: string, b: string) {
  const left = version(a)
  const right = version(b)
  if (!left || !right || left.prefix !== right.prefix) return undefined
  const length = Math.max(left.numbers.length, right.numbers.length)
  const diff = Array.from({ length }, (_, index) => (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)).find(
    (value) => value !== 0,
  )
  return diff === undefined ? 0 : Math.sign(diff)
}

function version(id: string) {
  const found = /^(?<prefix>[a-z-]*?)(?<version>\d+(?:\.\d+)*)/i.exec(id)?.groups
  if (!found) return undefined
  return { prefix: found.prefix.toLowerCase(), numbers: found.version.split(".").map(Number) }
}

/**
 * Resolves the rates of a kind and model from its card and the catalog cost (02 §2.4.4, §6.1, §6.2). Without a card
 * a USD catalog cost still gives the input and output rates; TTLs are then unknown (`0`/`null`), which makes every
 * reuse estimate cold. `oneHour` selects the Anthropic 1h mode (Phase 3, KV `ttlMode`). `at` (epoch ms) prices a
 * request made then: outside the card's peak windows every rate is multiplied by `offPeakMul` (02 §6.2). Without
 * `at` the card's own (peak) rates apply.
 */
export function resolve(input: {
  readonly kind: Kind.Any | undefined
  readonly card: Ratecard.Card | undefined
  readonly catalog?: CatalogCost
  readonly oneHour?: boolean
  readonly at?: number
}): Rates {
  const card = input.card
  const unit: Estimate.Unit =
    card?.unit ??
    (input.kind === "codex" || input.kind === "siwc"
      ? "credits"
      : input.kind === "claude-sub" || input.kind === "claude-agent"
        ? "percent"
        : "USD")
  // A credits card never borrows USD catalog prices.
  const catalog = unit === "USD" && (card === undefined || card.inFromCatalog === true) ? input.catalog : undefined
  const rateIn = card?.in ?? catalog?.input ?? null
  const read =
    card?.read ??
    (card?.readMul !== undefined && rateIn !== null ? rateIn * card.readMul : undefined) ??
    catalog?.cache?.read ??
    rateIn
  const oneHour = input.oneHour === true && card?.write1h !== undefined && card.write1h !== null
  const cold =
    (oneHour ? card?.write1h : undefined) ??
    card?.write5m ??
    card?.write ??
    (card?.writeMul !== undefined && rateIn !== null ? rateIn * card.writeMul : undefined) ??
    rateIn
  const out = card?.out ?? (unit === "USD" ? (input.catalog?.output ?? null) : null)
  const ttl =
    (input.oneHour ? card?.ttl.oneHour : undefined) ??
    card?.ttl ??
    (input.kind === "claude-sub"
      ? CLAUDE_SLOT_TTL
      : input.kind === "claude-agent"
        ? CLAUDE_AGENT_TTL
        : { warmLowerSec: 0, coldUpperSec: null })
  const claude = input.kind === "claude-sub" || input.kind === "claude-agent"
  const lookback = card?.lookback ?? (claude ? { blocks: 20 } : null)
  const breakpoint = lookback !== null || input.kind === "anth" || claude
  const factor = card !== undefined && input.at !== undefined ? Ratecard.multiplier(card, input.at) : 1
  const price = (rate: number | null) => (rate === null ? null : rate * factor)
  return {
    unit,
    in: price(rateIn),
    read: price(read),
    cold: price(cold),
    out: price(out),
    ttlLo: ttl.warmLowerSec,
    ttlHi: ttl.coldUpperSec,
    lookback,
    mode: breakpoint ? "breakpoint" : "prefix",
  }
}

/** The first catalog cost entry without a context tier, else the first one. */
export function catalogCost(costs: ReadonlyArray<CatalogCost & { readonly tier?: unknown }> | undefined) {
  if (!costs || costs.length === 0) return undefined
  return costs.find((cost) => cost.tier === undefined) ?? costs[0]
}

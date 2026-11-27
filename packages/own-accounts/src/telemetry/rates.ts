export * as Rates from "./rates.js"

import type { Kind, Ledger, Ratecard } from "@own/protocol"

/**
 * Rate card lookup and ratecard costs (02 §2.4.4, §6.2, §7.5 "비용"). Pure.
 */

/** Catalog cost of a model (`Model.Info.cost` entry without tier), USD per 1M tokens. */
export interface CatalogCost {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** Per-1M rates resolved from a card (and the catalog for `inFromCatalog`). `undefined` = unknown. */
export interface Resolved {
  readonly unit: Ratecard.Unit
  readonly input?: number
  readonly read?: number
  readonly write?: number
  readonly output?: number
}

/**
 * The card for `(kind, modelID)`: an exact `model` match first, then `modelGte`/`modelLt` ranges, then a card with
 * only `kind`. `undefined` when none matches. Rate cards and speed cards (02 §4.8) select the same way.
 */
export function match<C extends Pick<Ratecard.Card, "match">>(
  cards: ReadonlyArray<C>,
  kind: Kind.Any,
  modelID: string,
) {
  const ofKind = cards.filter((card) => card.match.kind === kind)
  const exact = ofKind.find((card) => card.match.model === modelID)
  if (exact) return exact
  const ranged = ofKind.find(
    (card) =>
      card.match.model === undefined &&
      (card.match.modelGte !== undefined || card.match.modelLt !== undefined) &&
      (card.match.modelGte === undefined || compareVersion(modelID, card.match.modelGte) >= 0) &&
      (card.match.modelLt === undefined || compareVersion(modelID, card.match.modelLt) < 0),
  )
  if (ranged) return ranged
  return ofKind.find(
    (card) => card.match.model === undefined && card.match.modelGte === undefined && card.match.modelLt === undefined,
  )
}

/**
 * Compares the numeric version inside model ids (`gpt-5.6-sol` vs `gpt-5.6` → 0, `gpt-5.5` < `gpt-5.6`). Ids
 * without digits compare as equal, so a range card never matches them by accident.
 */
/**
 * The card whose TTL applies to `(kind, modelID)`: the matching card, else any card of the kind. Cache lifetime is a
 * property of the provider rather than of one model, so a model without its own card (a new catalog id) still gets
 * the kind's TTL; its costs stay unknown.
 */
export function ttlCard(cards: ReadonlyArray<Ratecard.Card>, kind: Kind.Any, modelID: string) {
  return match(cards, kind, modelID) ?? cards.find((card) => card.match.kind === kind)
}

export function compareVersion(a: string, b: string) {
  const left = versionOf(a)
  const right = versionOf(b)
  if (left.length === 0 || right.length === 0) return Number.NaN
  for (const index of Array.from({ length: Math.max(left.length, right.length) }, (_, i) => i)) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function versionOf(id: string) {
  const match = /(\d+(?:\.\d+)*)/.exec(id)
  return match ? match[1].split(".").map(Number) : []
}

export function resolve(card: Ratecard.Card, catalog?: CatalogCost): Resolved {
  const input = card.in ?? (card.inFromCatalog ? catalog?.input : undefined) ?? undefined
  const read =
    card.read ??
    (card.readMul !== undefined && input !== undefined ? input * card.readMul : undefined) ??
    catalog?.cacheRead
  // `write: null` = not billed separately (codex): cache writes cost like input (02 §6.2 "write 과금 없음").
  const write =
    card.write ??
    card.write5m ??
    (card.writeMul !== undefined && input !== undefined ? input * card.writeMul : undefined) ??
    input
  const output = card.out ?? catalog?.output ?? undefined
  return {
    unit: card.unit,
    ...(input === undefined ? {} : { input }),
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
    ...(output === undefined ? {} : { output }),
  }
}

/**
 * Cost of one request from resolved rates, as core computes it (`core/src/session/usage.ts`): reasoning is billed as
 * output. `undefined` when the input rate is unknown; an unknown output rate counts output as 0 only if there was no
 * output.
 */
export function cost(rates: Resolved, tokens: Ledger.Tokens): number | undefined {
  if (rates.input === undefined) return undefined
  const out = tokens.output + tokens.reasoning
  if (rates.output === undefined && out > 0) return undefined
  return (
    (tokens.input * rates.input +
      tokens.cacheRead * (rates.read ?? rates.input) +
      tokens.cacheWrite * (rates.write ?? rates.input) +
      out * (rates.output ?? 0)) /
    1_000_000
  )
}

/** Estimated cost of `P` cold input tokens (generate lines without usage, 02 §7.5 step 4). */
export function estimate(rates: Resolved, P: number): number | undefined {
  return rates.input === undefined ? undefined : (P * rates.input) / 1_000_000
}

/** `TTL_lo`/`TTL_hi` in ms for a card and TTL mode; `hi: null` = unknown (02 §6.1). */
export function ttl(card: Ratecard.Card | undefined, mode: "5m" | "1h" | undefined) {
  const source = mode === "1h" && card?.ttl.oneHour ? card.ttl.oneHour : card?.ttl
  if (!source) return undefined
  return {
    lo: source.warmLowerSec * 1000,
    hi: source.coldUpperSec === null ? null : source.coldUpperSec * 1000,
  }
}

/** Claude subscription slot TTL (02 §6.2: 5m/5m, 1h mode 60m/60m); it has no rate card. */
export function claudeTtl(mode: "5m" | "1h" | undefined) {
  return mode === "1h" ? { lo: 3_600_000, hi: 3_600_000 } : { lo: 300_000, hi: 300_000 }
}

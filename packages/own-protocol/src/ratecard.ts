export * as Ratecard from "./ratecard.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "@opencode/schema/schema"
import { NonNegative } from "./id.js"
import { Kind } from "./kind.js"

/** Rate unit. Codex rates are credits per 1M tokens, API rates USD per 1M tokens (02 §6.2). */
export const Unit = Schema.Literals(["credits", "USD"]).annotate({ identifier: "Own.Ratecard.Unit" })
export type Unit = typeof Unit.Type

/** Card selector. `modelGte`/`modelLt` compare model versions such as `gpt-5.6`; a card without a model matches the kind. */
export interface Match extends Schema.Schema.Type<typeof Match> {}
export const Match = Schema.Struct({
  kind: Kind.Any,
  model: optional(Schema.String),
  modelGte: optional(Schema.String),
  modelLt: optional(Schema.String),
}).annotate({ identifier: "Own.Ratecard.Match" })

const Seconds = NonNegative

/** `warmLowerSec` = TTL_lo (still warm), `coldUpperSec` = TTL_hi (surely cold), `null` = unknown (02 §6.1). */
export interface Ttl extends Schema.Schema.Type<typeof Ttl> {}
export const Ttl = Schema.Struct({
  warmLowerSec: Seconds,
  coldUpperSec: Schema.NullOr(Seconds),
  /** Anthropic 1h cache mode (Phase 3). */
  oneHour: optional(Schema.Struct({ warmLowerSec: Seconds, coldUpperSec: Schema.NullOr(Seconds) })),
}).annotate({ identifier: "Own.Ratecard.Ttl" })

/** How far back the provider looks for a cache breakpoint (02 §6.3 ① lookbackOK). */
export const Lookback = Schema.Union([
  Schema.Struct({ blocks: PositiveInt }),
  Schema.Struct({ messageEnds: PositiveInt }),
]).annotate({ identifier: "Own.Ratecard.Lookback" })
export type Lookback = typeof Lookback.Type

const Rate = NonNegative

/** `HH:MM` on the UTC clock; `24:00` ends a window at midnight. */
const TimeOfDay = Schema.String.check(Schema.isPattern(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/))

/**
 * One window of peak prices (02 §2.4.4, §6.2): on the UTC `days` (0 = Sunday … 6 = Saturday), from `from` up to but
 * not including `to`. A window does not cross midnight; one that would is written as two.
 */
export interface PeakWindow extends Schema.Schema.Type<typeof PeakWindow> {}
export const PeakWindow = Schema.Struct({
  days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
  from: TimeOfDay,
  to: TimeOfDay,
})
  .annotate({ identifier: "Own.Ratecard.PeakWindow" })
  .check(Schema.makeFilter((window) => minuteOf(window.from) < minuteOf(window.to) || "from must be before to"))

/** One `ratecards.json` card (02 §2.4.4). Rates are per 1M tokens in `unit`; `null` means "not billed". */
export interface Card extends Schema.Schema.Type<typeof Card> {}
export const Card = Schema.Struct({
  match: Match,
  unit: Unit,
  in: optional(Schema.NullOr(Rate)),
  read: optional(Schema.NullOr(Rate)),
  write: optional(Schema.NullOr(Rate)),
  write5m: optional(Schema.NullOr(Rate)),
  write1h: optional(Schema.NullOr(Rate)),
  /** Missing: catalog `cost.output`. Still unknown: options needing `r_out` report `rate_unknown` (02 §2.4.4). */
  out: optional(Schema.NullOr(Rate)),
  /** Take `in` (and `out`) from the model catalog `cost`. */
  inFromCatalog: optional(Schema.Boolean),
  readMul: optional(NonNegative),
  writeMul: optional(NonNegative),
  /** Multiplies every rate outside the `peak` windows; ignored without them (flat rates). */
  offPeakMul: optional(NonNegative),
  /** Peak-price windows (UTC). The rates above are the peak rates; files written before the field have flat rates. */
  peak: optional(Schema.Array(PeakWindow)),
  ttl: Ttl,
  lookback: optional(Schema.NullOr(Lookback)),
  note: optional(Schema.String),
}).annotate({ identifier: "Own.Ratecard.Card" })

const CalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}/))

/**
 * The cost of a speed tier on a plan-billed kind (`codex`, `siwc`, 02 §4.8): Standard usage times `included` while the
 * plan's included usage lasts, times `credits` on purchased credits. `tier` is the request value (`priority`,
 * `ultrafast`); `source` and `date` say where the numbers were read. API kinds need no card: their tier price is the
 * catalog's mode price.
 */
export interface SpeedCard extends Schema.Schema.Type<typeof SpeedCard> {}
export const SpeedCard = Schema.Struct({
  match: Match,
  tier: Schema.NonEmptyString,
  included: optional(NonNegative),
  credits: optional(NonNegative),
  source: Schema.String,
  date: CalendarDate,
  note: optional(Schema.String),
}).annotate({ identifier: "Own.Ratecard.SpeedCard" })

/**
 * `OWN_HOME\ratecards.json` (02 §2.4.4). `updatedAt` is a calendar date (`YYYY-MM-DD`). `speed`: the speed tier cards
 * (02 §4.8); a file written before the field reads the seed's.
 */
export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  updatedAt: CalendarDate,
  cards: Schema.Array(Card),
  speed: optional(Schema.Array(SpeedCard)),
}).annotate({ identifier: "Own.Ratecard.File" })

/**
 * The factor on a card's rates for a request made at `at` (epoch ms, 02 §6.2): `offPeakMul` outside every `peak`
 * window, else 1. A card without windows or without `offPeakMul` prices the same at any time.
 */
export function multiplier(card: Card, at: number) {
  if (card.peak === undefined || card.offPeakMul === undefined) return 1
  const date = new Date(at)
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  const peak = card.peak.some(
    (window) =>
      window.days.includes(date.getUTCDay()) && minuteOf(window.from) <= minute && minute < minuteOf(window.to),
  )
  return peak ? 1 : card.offPeakMul
}

function minuteOf(time: string) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}

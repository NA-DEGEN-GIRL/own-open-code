export * as Texts from "./texts.js"

import { Option, Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnID } from "@own/protocol"
import type { Log } from "../log.js"
import { Keys } from "../registry/keys.js"

/**
 * Whole report texts outside the digest (2026-11-14). The digest (`digest:<teamID>`) is one KV value, decoded
 * all-or-nothing and rewritten on every report, so it keeps only excerpts (`Fold.excerpt`); the whole texts live per
 * area, written only when that area reports, so an invalid value loses only that area's texts:
 *
 * - `report:<teamID>:<areaID>` ({@link AreaTexts}): the newest report of each kind per seat (the owner or a peer),
 *   and the relays (사용자 부탁), newest first, kept by size ({@link RELAY_CHARS});
 * - `stretch:<teamID>:<areaID>` ({@link Stretch}): every report stored while the user worked with the area directly,
 *   oldest first, kept by size ({@link STRETCH_CHARS}); it stays until the next stretch starts.
 *
 * Reads and writes happen inside the team's write section (`Services.Base.write`). An invalid value reads as absent
 * and is logged.
 */

const At = OwnID.EpochMillis

/** Characters of relays one area keeps; the oldest beyond it are counted in `relaysDropped`. */
export const RELAY_CHARS = 100_000
/** Characters of reports one stretch of direct work keeps; the oldest beyond it are counted in `dropped`. */
export const STRETCH_CHARS = 100_000

/**
 * One whole text. `kind`: the report kind (`progress`, `done`, `ready`, `blocked`, `relay`, `failed`, …), an open
 * string like the digest's `Entry.reason`, so a later kind never makes an older build's value undecodable. `peer`: the
 * peer's key when a peer wrote it (absent = the owner).
 */
export const TextItem = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  at: At,
  task: optional(Schema.String),
  peer: optional(Schema.String),
})
export type TextItem = typeof TextItem.Type

/** KV `report:<teamID>:<areaID>`. */
export const AreaTexts = Schema.Struct({
  /** At most one item per seat (`peer ?? owner`) and kind, replaced in place. */
  reports: Schema.Array(TextItem),
  /** Newest first; kept while their summed length is at most {@link RELAY_CHARS} (always at least one). */
  relays: optional(Schema.Array(TextItem)),
  /** Relays dropped for size, all told. */
  relaysDropped: optional(NonNegativeInt),
})
export type AreaTexts = typeof AreaTexts.Type

/** KV `stretch:<teamID>:<areaID>`: `since` is `Area.directWork.since` of the stretch, `until` its hand-back. */
const StretchFields = {
  since: At,
  until: optional(At),
  /** Oldest first; kept while their summed length is at most {@link STRETCH_CHARS} (always at least the newest). */
  items: Schema.Array(TextItem),
  /** Items dropped for size. */
  dropped: optional(NonNegativeInt),
}
export const Stretch = Schema.Struct({
  ...StretchFields,
  /**
   * The stretch handed back before this one began (2026-11-15), kept until this one is handed back: its hand-back
   * line points the main to `team_status{area}`, which the next stretch's first report would otherwise overwrite.
   */
  previous: optional(Schema.Struct(StretchFields)),
})
export type Stretch = typeof Stretch.Type

const decodeTexts = Schema.decodeUnknownOption(AreaTexts)
const encodeTexts = Schema.encodeSync(AreaTexts)
const decodeStretch = Schema.decodeUnknownOption(Stretch)
const encodeStretch = Schema.encodeSync(Stretch)

/** The area's texts; absent or invalid (logged) = `undefined`. */
export async function load(kv: Keys.Store, log: Log.Logger, teamID: string, areaID: string) {
  return read(await kv.get(Keys.report(teamID, areaID)), decodeTexts, log, { teamID, areaID, key: "report" })
}

/** Inside the team's write section. */
export function save(kv: Keys.Store, teamID: string, areaID: string, texts: AreaTexts) {
  return kv.set(Keys.report(teamID, areaID), Keys.toJson(encodeTexts(texts)))
}

/** The area's stretch; absent or invalid (logged) = `undefined`. */
export async function loadStretch(kv: Keys.Store, log: Log.Logger, teamID: string, areaID: string) {
  return read(await kv.get(Keys.stretch(teamID, areaID)), decodeStretch, log, { teamID, areaID, key: "stretch" })
}

/** Inside the team's write section. */
export function saveStretch(kv: Keys.Store, teamID: string, areaID: string, stretch: Stretch) {
  return kv.set(Keys.stretch(teamID, areaID), Keys.toJson(encodeStretch(stretch)))
}

// ---------------------------------------------------------------------------------------------------------------
// Pure parts

/** The texts with `item` as its seat's newest report of its kind (the older one of the same seat and kind goes). */
export function report(texts: AreaTexts | undefined, item: TextItem): AreaTexts {
  const reports = texts?.reports ?? []
  const at = reports.findIndex((other) => other.kind === item.kind && other.peer === item.peer)
  return {
    ...texts,
    reports: at < 0 ? [...reports, item] : reports.map((other, index) => (index === at ? item : other)),
  }
}

/** The texts with `item` as the newest relay; the oldest go while the relays are longer than {@link RELAY_CHARS}. */
export function relay(texts: AreaTexts | undefined, item: TextItem): AreaTexts {
  const all = [item, ...(texts?.relays ?? [])]
  const kept = newestWithin(all, RELAY_CHARS)
  const dropped = (texts?.relaysDropped ?? 0) + all.length - kept.length
  return {
    reports: texts?.reports ?? [],
    relays: kept,
    ...(dropped === 0 ? {} : { relaysDropped: dropped }),
  }
}

/**
 * The stretch `since` with `item` appended: a stored stretch of another `since` is replaced by a fresh one, which keeps
 * the stored one as `previous` when it was handed back. The oldest items go while the items are longer than
 * {@link STRETCH_CHARS}; the newest always stays.
 */
export function append(stretch: Stretch | undefined, since: number, item: TextItem): Stretch {
  const current = stretch?.since === since ? stretch : fresh(stretch, since)
  const all = [...current.items, item]
  const kept = newestWithin(all.toReversed(), STRETCH_CHARS).toReversed()
  const dropped = (current.dropped ?? 0) + all.length - kept.length
  return { ...current, items: kept, ...(dropped === 0 ? {} : { dropped }) }
}

/**
 * The stretch `since` ended at `until`; a stretch without reports is stored empty, so its time range shows. The one
 * before it goes now: this hand-back's line is the one that points at `team_status{area}`.
 */
export function end(stretch: Stretch | undefined, since: number, until: number): Stretch {
  const current = stretch?.since === since ? stretch : { since, items: [] }
  const { previous: _previous, ...rest } = current
  return { ...rest, until }
}

/** A new stretch `since` after `stored`: a handed-back `stored` (it has `until`) is kept as `previous`. */
function fresh(stored: Stretch | undefined, since: number): Stretch {
  if (stored?.until === undefined) return { since, items: [] }
  const { previous: _previous, ...ended } = stored
  return { since, items: [], previous: ended }
}

/** The leading items (newest first) whose summed text length stays within `max`; always the first one. */
function newestWithin(items: ReadonlyArray<TextItem>, max: number) {
  const sums = items.reduce<number[]>((acc, item) => {
    acc.push((acc.at(-1) ?? 0) + item.text.length)
    return acc
  }, [])
  return items.filter((_, index) => index === 0 || sums[index] <= max)
}

function read<T>(
  value: Schema.Json | undefined,
  decode: (value: unknown) => Option.Option<T>,
  log: Log.Logger,
  fields: Log.Fields,
) {
  if (value === undefined) return undefined
  const decoded = Option.getOrUndefined(decode(value))
  if (decoded === undefined) log.warn("own.team: a stored text value does not decode; read as absent", fields)
  return decoded
}

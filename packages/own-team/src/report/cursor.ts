export * as Cursor from "./cursor.js"

import { Option, Schema } from "effect"
import { NonNegativeInt } from "@opencode/schema/schema"
import { Keys } from "../registry/keys.js"
import type { SessionHttp } from "../sessions/http.js"

/**
 * Catch-up (06 §5.5 따라잡기, §5.7): for each team main and owner session own.team keeps the last durable log seq it
 * folded in KV `cursor:<sessionID>`, and folds the session log after it (`session.log?after=<cursor>`, without
 * follow, so no Location is woken and no stream stays open). The controller does this when it starts, when an
 * instance appears, and on each live event of such a session, so events are folded once and in order whether they
 * arrived live, while no instance listened, or before a restart.
 *
 * The local server keeps no event rows (core `events.persist` is off), so its log answers only the `log.synced`
 * watermark. Live durable events are therefore folded together with the log items (`live`), deduplicated by seq;
 * events that happened while nobody listened are then lost and the controller's refresh re-derives the area status.
 */

/** A durable event (from the log or live) and its seq. */
export interface Item {
  readonly seq: number
  readonly item: unknown
}

const Seq = NonNegativeInt
const decodeSeq = Schema.decodeUnknownOption(Seq)
const decodeDurable = Schema.decodeUnknownOption(Schema.Struct({ durable: Schema.Struct({ seq: Seq }) }))

export async function get(kv: Keys.Store, sessionID: string) {
  return Option.getOrUndefined(decodeSeq(await kv.get(Keys.cursor(sessionID))))
}

export function set(kv: Keys.Store, sessionID: string, seq: number) {
  return kv.set(Keys.cursor(sessionID), seq)
}

/** A durable event as an item, or `undefined` for an ephemeral one (no `durable.seq`). */
export function item(event: unknown): Item | undefined {
  const durable = Option.getOrUndefined(decodeDurable(event))
  return durable ? { seq: durable.durable.seq, item: event } : undefined
}

/**
 * Reads `ref`'s log after its cursor, hands the new items (plus the `live` ones after the cursor, once per seq) to
 * `fold` in seq order, then moves the cursor to the last folded seq. Call it inside the team's write section: the
 * fold's writes come first and the cursor last, so a crash in between folds the items again (digest entries carry
 * the log seq as their key and count once). A session without a cursor is read from its start (own.team made it).
 * When the log cannot be read the live items are still folded and the cursor stays, so a later read covers the log
 * again; folding an item twice changes nothing.
 */
export async function follow<T>(input: {
  readonly kv: Keys.Store
  readonly http: SessionHttp.Client
  readonly ref: SessionHttp.SessionRef
  readonly live?: ReadonlyArray<Item>
  readonly fold: (items: ReadonlyArray<Item>) => Promise<T>
}): Promise<{ readonly value: T; readonly cursor: number | undefined }> {
  const after = await get(input.kv, input.ref.sessionID)
  const log = await input.http.session.log({ ...input.ref, ...(after === undefined ? {} : { after }) })
  const logged = log.ok ? log.value.flatMap((event) => item(event) ?? []) : []
  const items = [...new Map([...(input.live ?? []), ...logged].map((entry) => [entry.seq, entry])).values()]
    .filter((entry) => after === undefined || entry.seq > after)
    .toSorted((a, b) => a.seq - b.seq)
  const value = await input.fold(items)
  if (!log.ok) return { value, cursor: after }
  const last = Math.max(after ?? -1, ...items.map((entry) => entry.seq))
  if (last >= 0 && last !== after) await set(input.kv, input.ref.sessionID, last)
  return { value, cursor: last >= 0 ? last : undefined }
}

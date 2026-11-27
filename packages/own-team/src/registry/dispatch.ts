export * as Dispatches from "./dispatch.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import type { Log } from "../log.js"
import { Keys } from "./keys.js"

/**
 * Main request records (KV `dispatch:<teamID>:<areaID>:<seq>`, 06 §2.4, §5.1). The `waiting` ones are the area's
 * outbox, sent in `seq` order; `sent` and `cancelled` ones are removed 7 days after they were made. Request writes do
 * not raise the team's `rev`: the outbox has its own event (`outbox.changed`).
 */

/** How long sent and cancelled requests are kept (06 §2.4). */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000

export interface Store {
  /** The team's requests (or one area's), oldest first within each area. */
  list(teamID: string, areaID?: string): Promise<ReadonlyArray<OwnTeam.Dispatch>>
  /** The outbox: `waiting` requests in send order. */
  waiting(teamID: string, areaID?: string): Promise<ReadonlyArray<OwnTeam.Dispatch>>
  /** Outbox size per area (areas without waiting requests are absent). */
  counts(teamID: string): Promise<Readonly<Record<OwnTeam.AreaID, number>>>
  find(teamID: string, dispatchID: string): Promise<OwnTeam.Dispatch | undefined>
  /** The `seq` of the area's next request. */
  next(teamID: string, areaID: string): Promise<number>
  /** Inside the team's mutex. */
  put(dispatch: OwnTeam.Dispatch): Promise<void>
  /**
   * Re-keys a request (06 §8.2 outbox-migrate): writes `next` under its key, then removes `current`'s key when it
   * differs, so a crash in between leaves a second copy (same id), never none. Inside the team's mutex.
   */
  move(current: OwnTeam.Dispatch, next: OwnTeam.Dispatch): Promise<void>
  /** Removes `sent` and `cancelled` requests older than {@link KEEP_MS}; returns how many. */
  prune(teamID: string, now: number): Promise<number>
}

const decode = Schema.decodeUnknownOption(OwnTeam.Dispatch)
const encode = Schema.encodeSync(OwnTeam.Dispatch)

export function create(kv: Keys.Store, log: Log.Logger): Store {
  const list = async (teamID: string, areaID?: string) =>
    (await kv.scan(Keys.prefix.dispatches(teamID, areaID))).flatMap((entry) => {
      const dispatch = Option.getOrUndefined(decode(entry.value))
      if (!dispatch) log.warn("dispatch_record_invalid", { key: entry.key })
      return dispatch ? [dispatch] : []
    })
  const waiting = async (teamID: string, areaID?: string) =>
    (await list(teamID, areaID)).filter((dispatch) => dispatch.state === "waiting")
  return {
    list,
    waiting,
    counts: async (teamID) =>
      (await waiting(teamID)).reduce<Record<OwnTeam.AreaID, number>>(
        (counts, dispatch) => ({ ...counts, [dispatch.areaID]: (counts[dispatch.areaID] ?? 0) + 1 }),
        {},
      ),
    find: async (teamID, dispatchID) => (await list(teamID)).find((dispatch) => dispatch.id === dispatchID),
    next: async (teamID, areaID) =>
      (await list(teamID, areaID)).reduce((next, dispatch) => Math.max(next, dispatch.seq + 1), 0),
    put: (dispatch) =>
      kv.set(Keys.dispatch(dispatch.teamID, dispatch.areaID, dispatch.seq), Keys.toJson(encode(dispatch))),
    move: async (current, next) => {
      const key = Keys.dispatch(next.teamID, next.areaID, next.seq)
      await kv.set(key, Keys.toJson(encode(next)))
      const old = Keys.dispatch(current.teamID, current.areaID, current.seq)
      if (old !== key) await kv.remove(old)
    },
    prune: async (teamID, now) => {
      const old = (await list(teamID)).filter(
        (dispatch) => dispatch.state !== "waiting" && now - dispatch.createdAt > KEEP_MS,
      )
      await Promise.all(old.map((dispatch) => kv.remove(Keys.dispatch(teamID, dispatch.areaID, dispatch.seq))))
      return old.length
    },
  }
}

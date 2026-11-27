export * as Areas from "./area.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import type { Log } from "../log.js"
import { Keys } from "./keys.js"
import type { Teams } from "./team.js"

/**
 * Area records (KV `area:<teamID>:<areaID>`, 06 §2.4). `status` is a cache of what git, core and the events say
 * (recomputed, never trusted after a restart); the binding (folder, git dir, branch, owner, area main, preset, Main 멈춤)
 * is the record's substance. Every write raises the team's `rev`.
 */

/** `ar_<slug>` (V6). Unique within a team only. */
export function id(slug: string): OwnTeam.AreaID {
  return OwnTeam.AreaID.make(`ar_${slug}`)
}

/** An area as methods return it (`OwnTeam.AreaView`): today the record itself. */
export function view(area: OwnTeam.Area): OwnTeam.AreaView {
  return area
}

export interface Store {
  get(teamID: string, areaID: string): Promise<OwnTeam.Area | undefined>
  /** Every area of the team, retired ones included, in id order. */
  list(teamID: string): Promise<ReadonlyArray<OwnTeam.Area>>
  /** Writes the area and raises the team's `rev`; inside the team's mutex. Returns the new `rev`. */
  put(area: OwnTeam.Area): Promise<number | undefined>
  /**
   * Removes the area with its whole report texts and direct-work stretch (`report/texts.ts`): area ids are `ar_<slug>`
   * and a freed slug can come back, so a later area of that slug must not inherit them.
   */
  remove(teamID: string, areaID: string): Promise<number | undefined>
}

const decode = Schema.decodeUnknownOption(OwnTeam.Area)
const encode = Schema.encodeSync(OwnTeam.Area)

export function create(kv: Keys.Store, teams: Teams.Store, log: Log.Logger): Store {
  const read = (value: unknown, key: string) => {
    const area = Option.getOrUndefined(decode(value))
    if (area === undefined && value !== undefined) log.warn("area_record_invalid", { key })
    return area
  }
  return {
    get: async (teamID, areaID) => read(await kv.get(Keys.area(teamID, areaID)), Keys.area(teamID, areaID)),
    list: async (teamID) =>
      (await kv.scan(Keys.prefix.areas(teamID))).flatMap((entry) => {
        const area = read(entry.value, entry.key)
        return area ? [area] : []
      }),
    put: async (area) => {
      await kv.set(Keys.area(area.teamID, area.id), Keys.toJson(encode(area)))
      return teams.bump(area.teamID)
    },
    remove: async (teamID, areaID) => {
      await Promise.all(
        [Keys.area(teamID, areaID), Keys.report(teamID, areaID), Keys.stretch(teamID, areaID)].map((key) =>
          kv.remove(key),
        ),
      )
      return teams.bump(teamID)
    },
  }
}

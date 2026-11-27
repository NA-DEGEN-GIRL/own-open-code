export * as Teams from "./team.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Hash } from "@own/runtime"
import { Identity } from "../git/identity.js"
import type { Log } from "../log.js"
import { Keys } from "./keys.js"

/**
 * Team records (KV `team:<teamID>`, 06 §2.4). The registry stores bindings and intent only: git facts (branch tips,
 * worktrees, locks, sparse cones) and core facts (session state, inboxes) are read when needed and never stored, and
 * area `status` is a cache that can always be computed again.
 */

/** `tm_` + the first 12 hex digits of SHA-256 of the real path of the git common dir: one team per common dir. */
export function id(commonDir: string): OwnTeam.TeamID {
  return OwnTeam.TeamID.make(`tm_${Hash.sha256(Identity.key(commonDir)).slice(0, 12)}`)
}

/**
 * The team records folder `<common dir>/own/team/<teamID>/` (06 §2.4): handoffs, decision records, integration logs
 * and settings files moved out of retired areas. Outside every worktree, so no clean-up command reaches it.
 */
export function records(team: Pick<OwnTeam.Team, "id" | "commonDir">) {
  return path.join(team.commonDir, "own", "team", team.id)
}

export interface Store {
  get(teamID: string): Promise<OwnTeam.Team | undefined>
  list(): Promise<ReadonlyArray<OwnTeam.Team>>
  /**
   * Writes `team` with `rev` one above the stored record (0 for a new team) and returns what was written. Callers run
   * inside the team's mutex (`Services.Base.write`).
   */
  put(team: OwnTeam.Team): Promise<OwnTeam.Team>
  /** `rev` + 1 for a write elsewhere in the team (an area record); returns the new `rev`, or `undefined`. */
  bump(teamID: string): Promise<number | undefined>
  /** Removes the team record and every record of the team (areas, requests, ops, digest, …). */
  remove(teamID: string): Promise<void>
}

const decode = Schema.decodeUnknownOption(OwnTeam.Team)
const encode = Schema.encodeSync(OwnTeam.Team)

export function create(kv: Keys.Store, log: Log.Logger): Store {
  const read = (value: unknown, key: string) => {
    const team = Option.getOrUndefined(decode(value))
    if (team === undefined && value !== undefined) log.warn("team_record_invalid", { key })
    return team
  }
  const get = async (teamID: string) => read(await kv.get(Keys.team(teamID)), Keys.team(teamID))
  return {
    get,
    list: async () =>
      (await kv.scan(Keys.prefix.teams)).flatMap((entry) => {
        const team = read(entry.value, entry.key)
        return team ? [team] : []
      }),
    put: async (team) => {
      const stored = await get(team.id)
      const next = { ...team, rev: stored === undefined ? 0 : stored.rev + 1 }
      await kv.set(Keys.team(team.id), Keys.toJson(encode(next)))
      return next
    },
    bump: async (teamID) => {
      const stored = await get(teamID)
      if (!stored) return undefined
      const rev = stored.rev + 1
      await kv.set(Keys.team(teamID), Keys.toJson(encode({ ...stored, rev })))
      return rev
    },
    remove: async (teamID) => {
      const keys = await Promise.all(
        Keys.ofTeam(teamID).map(async (key) =>
          key.endsWith(":") ? (await kv.scan(key)).map((entry) => entry.key) : [key],
        ),
      )
      await Promise.all(keys.flat().map((key) => kv.remove(key)))
    },
  }
}

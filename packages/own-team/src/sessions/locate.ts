export * as Locate from "./locate.js"

import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Identity } from "../git/identity.js"
import { Git } from "../git/run.js"
import { Teams } from "../registry/team.js"
import type { Services } from "../services.js"

/**
 * Where a session or a folder belongs (06 §2.8 "등록부가 원본이다", §5.4). Roles come from the registry's session ids,
 * never from session metadata: a child session copies its parent's metadata and permissions (core session.ts:273-276)
 * but its id is in no registry slot, and a replaced owner's id is only in `owner.previous`. An area peer (동료) is
 * found by its id in `area.peers` of an area that is not retired.
 */

export type Session =
  | { readonly role: "main"; readonly team: OwnTeam.Team }
  | { readonly role: "owner"; readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }
  /** An area peer (동료, 2026-10-09): registered by its session id in an area that is not retired. */
  | { readonly role: "peer"; readonly team: OwnTeam.Team; readonly area: OwnTeam.Area; readonly peer: OwnTeam.Peer }
  /** A main conversation replaced by `main.rotate` (6.5). */
  | { readonly role: "previous-main"; readonly team: OwnTeam.Team }
  /** An owner conversation replaced by a rotation (6.2 step 4). */
  | { readonly role: "previous-owner"; readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }

export interface Place {
  readonly team: OwnTeam.Team
  /** Absent in the home (the main folder is not an area, 5.4). */
  readonly area?: OwnTeam.Area
}

export interface Api {
  /** The registry role of a session id, or `undefined` (not a team session, or a child of one). */
  session(sessionID: string): Promise<Session | undefined>
  /** The team folder (home or area) that contains `directory`, by the longest path prefix (3.2, 5.4). */
  directory(directory: string): Promise<Place | undefined>
  /** The team of `directory`: its folder, else the team of its git common dir (any checkout of the repository). */
  team(directory: string): Promise<OwnTeam.Team | undefined>
}

export function create(registry: Services.Registry): Api {
  const all = async () => {
    const teams = await registry.teams.list()
    return Promise.all(teams.map(async (team) => ({ team, areas: await registry.areas.list(team.id) })))
  }
  const directory = async (target: string): Promise<Place | undefined> => {
    const candidates = (await all()).flatMap(({ team, areas }) => [
      { team, folder: team.home.directory },
      ...areas.filter((area) => area.state !== "retired").map((area) => ({ team, area, folder: area.directory })),
    ])
    const containing = candidates.filter((candidate) => Identity.inside(candidate.folder, target))
    const deepest = containing.reduce<(typeof containing)[number] | undefined>(
      (best, candidate) =>
        best === undefined || Identity.key(candidate.folder).length > Identity.key(best.folder).length
          ? candidate
          : best,
      undefined,
    )
    if (!deepest) return undefined
    return "area" in deepest ? { team: deepest.team, area: deepest.area } : { team: deepest.team }
  }
  return {
    session: async (sessionID) => {
      const teams = await all()
      const current = teams.flatMap(({ team, areas }): Session[] => [
        ...(team.main.sessionID === sessionID ? [{ role: "main" as const, team }] : []),
        ...areas
          .filter((area) => area.owner.sessionID === sessionID)
          .map((area) => ({ role: "owner" as const, team, area })),
        // 끝낸 영역의 동료 is no team session any more (retire and merge drop the record as well).
        ...areas.flatMap((area) =>
          area.state === "retired"
            ? []
            : (area.peers ?? [])
                .filter((peer) => peer.sessionID === sessionID)
                .map((peer) => ({ role: "peer" as const, team, area, peer })),
        ),
      ])
      if (current[0]) return current[0]
      const previous = teams.flatMap(({ team, areas }): Session[] => [
        ...(team.main.previous.some((id) => id === sessionID) ? [{ role: "previous-main" as const, team }] : []),
        ...areas
          .filter((area) => area.owner.previous.some((item) => item.sessionID === sessionID))
          .map((area) => ({ role: "previous-owner" as const, team, area })),
      ])
      return previous[0]
    },
    directory,
    team: async (target) => {
      const place = await directory(target)
      if (place) return place.team
      if (!Git.isNative(target)) return undefined
      const common = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: target })
      if (!common.ok) return undefined
      const commonDir = common.stdout.trim()
      if (!commonDir) return undefined
      return registry.teams.get(Teams.id(path.resolve(target, commonDir)))
    },
  }
}

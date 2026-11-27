export * as TeamGroupRpc from "./team.js"

import type { OwnTeam } from "@own/protocol"
import { Confirm } from "../ops/confirm.js"
import { Disable } from "../ops/disable.js"
import { Enable } from "../ops/enable.js"
import { TeamHome } from "../ops/home.js"
import { Areas } from "../registry/area.js"
import { TeamAccount } from "../sessions/team-account.js"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * Team reads and the team lifecycle (06 §2.7, §3): `team.list`, `team.get` (the team of a folder: its home or area, or
 * any checkout of the same repository: the team, its areas with the `끝낼 수 있음` signal (`AreaView.retirable`, 8.1),
 * waiting requests per area, the running or waiting op and its pending confirms), `enable` (the `enable` op,
 * `ops/enable.ts`, with the shared-folder confirms of 4.11), `disable` (`ops/disable.ts`; `cleanup` = 끝난 영역
 * 정리하고 끄기) and `team.home` (`ops/home.ts`). Undo is `op.undo` (`rpc/op.ts`).
 */

export type Methods = "team.get" | "team.list" | "enable" | "disable" | "team.home"

/**
 * `enable` covers enable, disable, `team.home` and undo (`OwnTeam.Feature`); `cleanup` is `disable{cleanup}` and
 * `shared` the shared folders enable proposes (4.11).
 */
export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["enable", "cleanup", "shared"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "team.list": async () => {
      const teams = await services.registry.teams.list()
      return {
        teams: await Promise.all(
          teams.map(async (team) => ({
            id: team.id,
            projectID: team.projectID,
            home: team.home.directory,
            state: team.state,
            areas: (await services.registry.areas.list(team.id)).filter((area) => area.state !== "retired").length,
          })),
        ),
      }
    },
    "team.get": async (input) => {
      const team = await services.locate.team(input.directory)
      if (!team) return { team: null, areas: [], waiting: {}, op: null, pending: [] }
      const [areas, waiting, op, notices, retirable] = await Promise.all([
        services.registry.areas.list(team.id),
        services.registry.dispatches.counts(team.id),
        services.journal.active(team.id),
        services.notices.open(team.id),
        services.features().reorg.retirable(team.id),
      ])
      return {
        team,
        areas: areas.map((area) => {
          const since = retirable.get(area.id)
          return { ...Areas.view(area), ...(since === undefined ? {} : { retirable: { since } }) }
        }),
        waiting,
        op: op ?? null,
        pending: op ? Confirm.pending(op) : [],
        // A wait of an op that failed or was cancelled ended with it.
        notices: notices.filter(
          (notice) =>
            notice.kind !== "account.waiting" || (op !== undefined && notice.id === TeamAccount.waitingID(op.id)),
        ),
      }
    },
    enable: async (input, context) => {
      const started = await Enable.start(services, input)
      if (!started.ok) return RpcFailure.fail("enable", context, started)
      return { opID: started.opID }
    },
    disable: async (input, context) => {
      const started = await Disable.start(services, input)
      if (!started.ok) return RpcFailure.fail("disable", context, started)
      return { opID: started.opID }
    },
    "team.home": async (input, context) => {
      const started = await TeamHome.start(services, input)
      if (!started.ok) return RpcFailure.fail("team.home", context, started)
      return { opID: started.opID }
    },
  }
}

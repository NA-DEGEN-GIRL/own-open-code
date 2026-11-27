export * as AdoptRpc from "./adopt.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * 팀에 넣기 / 빼기 (06 §8.2, §2.7): `area.adopt{teamID, directory}` starts an undoable `adopt` op for a linked worktree
 * the team's repository has (`ops/adopt.ts`: lock, keep refs, naming a detached HEAD, the owner registered without
 * touching its conversation); `area.unadopt{teamID, areaID}` takes an adopted area out at its safe point. Both through
 * the adopt feature. Area reconcile (8.8), which lists the folders 팀에 넣기 offers, registers its `reconcile-move` step
 * kind here, while the plugin sets up.
 */

export type Methods = "area.adopt" | "area.unadopt"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["adopt"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  services.features().reconcile.register()
  return {
    "area.adopt": async (input, context) => {
      const started = await services.features().adopt.adopt({ teamID: input.teamID, directory: input.directory })
      if (!started.ok) return RpcFailure.fail("area.adopt", context, started)
      return { opID: started.opID }
    },
    "area.unadopt": async (input, context) => {
      const started = await services.features().adopt.unadopt({ teamID: input.teamID, areaID: input.areaID })
      if (!started.ok) return RpcFailure.fail("area.unadopt", context, started)
      return { opID: started.opID }
    },
  }
}

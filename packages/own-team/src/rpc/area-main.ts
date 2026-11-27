export * as AreaMainRpc from "./area-main.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/** Area main, area preset and the team account (06 §10.1, §2.7), through the area-main service. */

export type Methods = "area.main" | "area.preset" | "team.account"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["area-main", "area-preset", "team-account"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "area.main": async (input, context) => {
      const set = await services.features().areaMain.set({
        teamID: input.teamID,
        areaID: input.areaID,
        model: input.model,
        by: "user",
        ...(input.now === undefined ? {} : { now: input.now }),
      })
      if (!set.ok) return RpcFailure.fail("area.main", context, set)
      return { area: set.area, ...(set.opID === undefined ? {} : { opID: set.opID }) }
    },
    "area.preset": async (input, context) => {
      const set = await services.features().areaMain.preset({
        teamID: input.teamID,
        areaID: input.areaID,
        presetID: input.presetID,
      })
      if (!set.ok) return RpcFailure.fail("area.preset", context, set)
      return { area: set.area }
    },
    "team.account": async (input, context) => {
      const moved = await services.features().areaMain.account({
        teamID: input.teamID,
        target: input.target,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      })
      if (!moved.ok) return RpcFailure.fail("team.account", context, moved)
      return "plan" in moved ? { plan: moved.plan } : { opID: moved.opID }
    },
  }
}

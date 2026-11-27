export * as PauseRpc from "./pause.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/** Main 멈춤 (06 §5.3): `area.pause` and 모두 멈추기 / 다시 시작 (`team.pause`), through the pause service. */

export type Methods = "team.pause" | "area.pause"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["pause"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "team.pause": async (input, context) => {
      const paused = await services.features().pause.team({ teamID: input.teamID, on: input.on })
      if (!paused.ok) return RpcFailure.fail("team.pause", context, paused)
      return { team: paused.team }
    },
    "area.pause": async (input, context) => {
      const paused = await services.features().pause.area({ teamID: input.teamID, areaID: input.areaID, on: input.on })
      if (!paused.ok) return RpcFailure.fail("area.pause", context, paused)
      return { area: paused.area }
    },
  }
}

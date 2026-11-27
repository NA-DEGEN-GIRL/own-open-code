export * as RotateRpc from "./rotate.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * 새 대화로 이어가기 (`area.rotate`) and 메인 새 대화 (`main.rotate`) (06 §6.1, §6.2, §6.5): user actions, so they run
 * whatever Main 멈춤 says, wait for the safe point inside the op and answer its id at once. A warm handoff turn on the
 * old owner unless its account is BLOCKED. `busy` while another op of the team runs.
 */

export type Methods = "area.rotate" | "main.rotate"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["rotate"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "area.rotate": async (input, context) => {
      const started = await services.features().rotate.request({
        teamID: input.teamID,
        areaID: input.areaID,
        reason: "user",
        handoff: "warm",
        by: "user",
      })
      if (!started.ok) return RpcFailure.fail("area.rotate", context, started)
      return { opID: started.opID }
    },
    "main.rotate": async (input, context) => {
      const started = await services.features().rotate.main({ teamID: input.teamID, by: "user" })
      if (!started.ok) return RpcFailure.fail("main.rotate", context, started)
      return { opID: started.opID }
    },
  }
}

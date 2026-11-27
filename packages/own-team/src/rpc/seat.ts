export * as SeatRpc from "./seat.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * 담당 대화 바꾸기 (`area.seat`, 2026-11-12): the owner seat of an area moves onto an existing root conversation of the
 * area's folder. A user action like 새 대화로 이어가기: it runs whatever Main 멈춤 says, waits for the safe point inside
 * the op and answers the op's id at once. `seat_invalid` and `same_company_subscription` say why a conversation cannot
 * take the seat; `busy` while another op of the team runs.
 */

export type Methods = "area.seat"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["seat"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "area.seat": async (input, context) => {
      const started = await services.features().seat.request({
        teamID: input.teamID,
        areaID: input.areaID,
        sessionID: input.sessionID,
        by: "user",
      })
      if (!started.ok) return RpcFailure.fail("area.seat", context, started)
      return { opID: started.opID }
    },
  }
}

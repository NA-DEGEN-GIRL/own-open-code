export * as OutboxRpc from "./outbox.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * The outbox (06 §5.2): waiting main requests and area messages of an area and why they wait, the notes (쪽지) held for
 * its owner and peers (5.8), and cancelling one.
 */

export type Methods = "outbox.list" | "outbox.cancel"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["outbox"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "outbox.list": async (input, context) => {
      const listed = await services.features().admit.list({ teamID: input.teamID, areaID: input.areaID })
      if (!listed.ok) return RpcFailure.fail("outbox.list", context, listed)
      return {
        items: listed.items,
        ...(listed.why === undefined ? {} : { why: listed.why }),
        ...(listed.since === undefined ? {} : { since: listed.since }),
        ...(listed.cause === undefined ? {} : { cause: listed.cause }),
        ...(listed.notes === undefined ? {} : { notes: listed.notes }),
      }
    },
    "outbox.cancel": async (input, context) => {
      const cancelled = await services.features().admit.cancel({
        teamID: input.teamID,
        areaID: input.areaID,
        dispatchID: input.dispatchID,
      })
      if (!cancelled.ok) return RpcFailure.fail("outbox.cancel", context, cancelled)
      return {}
    },
  }
}

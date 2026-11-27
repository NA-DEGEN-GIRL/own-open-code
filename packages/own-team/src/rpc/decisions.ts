export * as DecisionsRpc from "./decisions.js"

import type { OwnTeam } from "@own/protocol"
import { Decisions } from "../docs/decisions.js"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * Decision records (06 §6.6, §2.7): `decisions.list` and 결정 적기 (`decisions.add`, the user's record). The main reads
 * a decision the user wrote in its next team update, without being woken (5.6). With `commitDecisions` on, that note
 * tells the main to commit the copy in the main folder. Both go through the `decisions` feature, as `team_decide` does.
 */

export type Methods = "decisions.list" | "decisions.add"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["decisions"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "decisions.list": async (input, context) => {
      const listed = await services.features().decisions.list(input.teamID)
      if (!listed.ok) return RpcFailure.fail("decisions.list", context, listed)
      return { items: listed.items }
    },
    "decisions.add": async (input, context) => {
      const added = await services.features().decisions.add({
        teamID: input.teamID,
        title: input.title,
        body: input.body,
        source: "user",
      })
      if (!added.ok) return RpcFailure.fail("decisions.add", context, added)
      await services.features().digest.add(input.teamID, Decisions.entry(added))
      return { number: added.record.number, file: added.record.file }
    },
  }
}

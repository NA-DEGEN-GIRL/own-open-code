export * as ReorgRpc from "./reorg.js"

import type { OwnTeam } from "@own/protocol"
import { ReorgOps } from "../ops/reorg.js"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * Reorganization (06 §8.1–8.2): `reorg.propose` is 팀 구성 다시 보기 (one judge call on the team main, planned by
 * `auto` and stored for 7 days, `reorg/propose.ts`); `reorg.apply` takes a proposal the user wrote (`{teamID,
 * proposal}`, by `user`: own-web's area menu, 영역 만들기, 이름 바꾸기, 나누기, 묶기, 끝내기, 변환, 대화 옮기기) or a
 * stored judge proposal (`{teamID, proposalID}`) and answers the op it started (`ops/reorg.ts`, `reorg/plan.ts`). A
 * stored proposal runs whole by `auto` (older clients) or, with `items` (2026-10-27), only the items the user chose in
 * 팀 구성 다시 보기, by `user` as the judge wrote them (`author: "auto"`): the V-rules leave out what only the user
 * sets (a new area's model, 에이전트 방식 and user-made mark), whatever the judge's answer held. The reorganization
 * step kinds are registered here, while the plugin sets up: before the controller's first resume continues a
 * reorganization op (`Services.Reorg.register`).
 */

export type Methods = "reorg.propose" | "reorg.apply"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = [
  "reorg.new",
  "reorg.rename",
  "reorg.split",
  "reorg.merge",
  "reorg.retire",
  "reorg.convert",
  "reorg.move",
]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  services.features().reorg.register()
  return {
    "reorg.propose": async (input, context) => {
      const proposed = await services.features().reorg.propose({
        teamID: input.teamID,
        signal: context.signal,
        ...(input.hint === undefined ? {} : { hint: input.hint }),
      })
      if (!proposed.ok) return RpcFailure.fail("reorg.propose", context, proposed)
      return { proposalID: proposed.proposalID, proposal: proposed.proposal, plan: proposed.plan }
    },
    "reorg.apply": async (input, context) => {
      if ("proposal" in input) {
        const applied = await ReorgOps.apply(services, { teamID: input.teamID, proposal: input.proposal, by: "user" })
        if (!applied.ok) return RpcFailure.fail("reorg.apply", context, applied)
        return { opID: applied.op.id }
      }
      const stored = await ReorgOps.stored(services, input.teamID, input.proposalID)
      if (!stored) return context.error("not_found", "proposal not found", { what: "proposal", id: input.proposalID })
      const chosen = input.items === undefined ? undefined : new Set(input.items)
      const applied = await ReorgOps.apply(
        services,
        chosen === undefined
          ? { teamID: input.teamID, proposal: stored, by: "auto" }
          : {
              teamID: input.teamID,
              // The chosen ops and areas only, as `chosenProposal` (own-web) sent them before: no notes or suggestions.
              proposal: {
                version: 1,
                ops: (stored.ops ?? []).filter((_, index) => chosen.has(`ops/${index}`)),
                areas: (stored.areas ?? []).filter((_, index) => chosen.has(`areas/${index}`)),
              },
              by: "user",
              author: "auto",
            },
      )
      if (!applied.ok) return RpcFailure.fail("reorg.apply", context, applied)
      return { opID: applied.op.id }
    },
  }
}

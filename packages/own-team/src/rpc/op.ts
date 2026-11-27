export * as OpRpc from "./op.js"

import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * Ops (06 §2.7, §8.5): `op.get`, `op.confirm` (10-minute nonce bound to the confirmed list; `skip` = 두기),
 * `op.undo`, which the undo service runs as its own op, and (RH-20) `op.cancel` (취소: an op that waits ends
 * `cancelled`) and `op.force` (바로 진행: the waiting step's fallback now, or the commands that hold the folder stopped).
 */

export type Methods = "op.get" | "op.confirm" | "op.undo" | "op.cancel" | "op.force"

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  /** The op, when its team exists and is on. */
  const live = async (opID: string) => {
    const op = await services.journal.find(opID)
    if (!op) return { ok: false as const, error: "not_found" as const, data: { what: "op" as const, id: opID } }
    const team = await services.registry.teams.get(op.teamID)
    if (!team)
      return { ok: false as const, error: "not_found" as const, data: { what: "team" as const, id: op.teamID } }
    if (team.state !== "on") return { ok: false as const, error: "team_off" as const, data: { teamID: team.id } }
    return { ok: true as const, op }
  }
  return {
    "op.get": async (input, context) => {
      const op = await services.journal.find(input.opID)
      if (!op) return context.error("not_found", "op not found", { what: "op", id: input.opID })
      return { op }
    },
    "op.confirm": async (input, context) => {
      const found = await live(input.opID)
      if (!found.ok)
        return found.error === "team_off"
          ? context.error("team_off", "team mode is off", found.data)
          : context.error("not_found", `${found.data.what} not found`, found.data)
      const confirmed = await services.runner.confirm(input)
      if (!confirmed.ok) return RpcFailure.fail("op.confirm", context, confirmed)
      return { op: confirmed.op }
    },
    "op.undo": async (input, context) => {
      const started = await services.features().undo.start({ opID: input.opID, by: "user" })
      if (!started.ok) return RpcFailure.fail("op.undo", context, started)
      return { opID: started.opID }
    },
    "op.cancel": async (input, context) => {
      const found = await live(input.opID)
      if (!found.ok)
        return found.error === "team_off"
          ? context.error("team_off", "team mode is off", found.data)
          : context.error("not_found", `${found.data.what} not found`, found.data)
      const cancelled = await services.runner.cancel(input.opID)
      if (!cancelled.ok) return RpcFailure.fail("op.cancel", context, cancelled)
      return { op: cancelled.op }
    },
    "op.force": async (input, context) => {
      const found = await live(input.opID)
      if (!found.ok)
        return found.error === "team_off"
          ? context.error("team_off", "team mode is off", found.data)
          : context.error("not_found", `${found.data.what} not found`, found.data)
      const forced = await services.runner.force(input.opID, input.action ?? "force")
      if (!forced.ok) return RpcFailure.fail("op.force", context, forced)
      return { op: forced.op }
    },
  }
}

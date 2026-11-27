export * as IntegrateRpc from "./integrate.js"

import { OwnID, type OwnTeam } from "@own/protocol"
import { Advance } from "../integrate/advance.js"
import { Verify } from "../integrate/verify.js"
import { Teams } from "../registry/team.js"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * 반영하기 (06 §7, §2.7) through the integrate feature: `area.integrate` (a new integration, or a waiting one tried
 * again; the user's menu takes the branch tip when there is no candidate, 7.1), `integration.get`, `integration.undo`
 * and its cancel while it waits (7.4, RH-42) and the push plan and its execution (7.5, `local` scope). The integrate, undo and push step kinds are
 * registered here, while the plugin sets up: before the controller's first resume continues an integrate op.
 *
 * `integration.get` answers the checks' output, not where it is kept: KV holds the path of
 * `integrations/<igID>.log` in the team records folder (`verify.*.log`), and the answer carries that log's text (its
 * last 64 KB, as `integrate/verify.ts` keeps it). A log outside the team records folder or one that cannot be read
 * is left out.
 */

export type Methods =
  | "area.integrate"
  | "integration.get"
  | "integration.undo"
  | "integration.undo.cancel"
  | "integration.push.plan"
  | "integration.push.execute"

/**
 * `assets`: step 7 runs the asset checks in `.assets` (4.10), asking first when it makes that folder large.
 * `undo-cancel`: 되돌리기 취소 of an undo that waits (RH-42).
 */
export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["integrate", "push", "assets", "undo-cancel"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  services.features().integrate.register()
  return {
    "area.integrate": async (input, context) => {
      const started = await services
        .features()
        .integrate.start({ teamID: input.teamID, areaID: input.areaID, by: "user", tip: true })
      if (started.ok) return { opID: started.opID, integrationID: started.integrationID }
      // A git operation stopped half way in the area folder (7.1): the area's branch is in use there.
      if (started.error !== "not_safe_point") return RpcFailure.fail("area.integrate", context, started)
      const area = await services.registry.areas.get(input.teamID, input.areaID)
      return context.error("in_use", started.message, {
        branch: area?.branch ?? input.areaID,
        directory: area?.directory ?? null,
      })
    },
    "integration.get": async (input, context) => {
      const integration = await Advance.find(services, input.integrationID)
      if (!integration)
        return context.error("not_found", "integration not found", { what: "integration", id: input.integrationID })
      const team = await services.registry.teams.get(integration.teamID)
      const records = team && Teams.records(team)
      const [code, assets] = await Promise.all([
        integration.verify.code && Verify.withLog(records, integration.verify.code),
        typeof integration.verify.assets === "object" ? Verify.withLog(records, integration.verify.assets) : undefined,
      ])
      return {
        integration: {
          ...integration,
          verify: {
            ...integration.verify,
            ...(code === undefined ? {} : { code }),
            ...(assets === undefined ? {} : { assets }),
          },
        },
      }
    },
    "integration.undo": async (input, context) => {
      const started = await services.features().integrate.undo({ integrationID: input.integrationID, by: "user" })
      if (!started.ok) return RpcFailure.fail("integration.undo", context, started)
      return { opID: started.opID }
    },
    "integration.undo.cancel": async (input, context) => {
      const cancelled = await services.features().integrate.undoCancel({ integrationID: input.integrationID })
      if (!cancelled.ok) return RpcFailure.fail("integration.undo.cancel", context, cancelled)
      return { integration: cancelled.integration }
    },
    "integration.push.plan": async (input, context) => {
      const planned = await services.features().integrate.plan({
        integrationID: input.integrationID,
        ...(input.pr === undefined ? {} : { pr: input.pr }),
      })
      if (!planned.ok) return RpcFailure.fail("integration.push.plan", context, planned)
      return {
        nonce: OwnID.Nonce.make(planned.nonce),
        expiresAt: planned.expiresAt,
        remote: planned.remote,
        ref: planned.ref,
        commands: [...planned.commands],
      }
    },
    "integration.push.execute": async (input, context) => {
      const started = await services.features().integrate.push({ nonce: input.nonce })
      if (!started.ok) return RpcFailure.fail("integration.push.execute", context, started)
      return { opID: started.opID }
    },
  }
}

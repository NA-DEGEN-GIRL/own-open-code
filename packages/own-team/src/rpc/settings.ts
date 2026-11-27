export * as SettingsRpc from "./settings.js"

import type { OwnTeam } from "@own/protocol"
import { Direct } from "../dispatch/direct.js"
import { TeamSettings } from "../ops/settings.js"
import type { Services } from "../services.js"
import { RoleInstructions } from "../sessions/instructions.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * 설정 `팀` (06 §9.8): the team's policy (download and disk thresholds, local merge, decision commits, auto-allowed
 * commands, and since 2026-11-14 직접 작업: `directHold`, `directTell`, shown with their defaults filled in), its
 * commands (chosen by the program, V10: shown, not edited), the extra other-tool patterns and 팀 지시문 (per role the
 * program's part, the guard, the default 일하는 방식 and the user's block). There are no window, compaction or
 * rotation values (U6). Writing is `local` scope (never a remote device); the write itself is `ops/settings.ts`, which
 * the voice tool calls the same way after the user's answer on the PC (06 §2.9).
 */

export type Methods = "settings.get" | "settings.set"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["settings", "direct", "instructions"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "settings.get": async (input, context) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return context.error("not_found", "team not found", { what: "team", id: input.teamID })
      const blocks = await RoleInstructions.blocks(services.kv, services.log, team.id)
      return {
        policy: { ...team.policy, directHold: Direct.hold(team), directTell: Direct.tell(team) },
        commands: team.commands,
        patterns: team.patterns,
        instructions: RoleInstructions.view(team, blocks),
      }
    },
    "settings.set": async (input, context) => {
      const written = await TeamSettings.write(services, input.teamID, input.patch)
      if (!written.ok) return RpcFailure.fail("settings.set", context, written)
      return { team: written.team }
    },
  }
}

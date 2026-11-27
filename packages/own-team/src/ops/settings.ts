export * as TeamSettings from "./settings.js"

import { OwnTeam } from "@own/protocol"
import { Direct } from "../dispatch/direct.js"
import { Services } from "../services.js"
import { RoleInstructions } from "../sessions/instructions.js"

/**
 * Writing 설정 `팀` (06 §9.8): the patch's policy fields over the team's, the full list of extra other-tool patterns
 * when the patch has one, and the 팀 지시문 blocks (KV `instructions:<teamID>`), announced with `team.changed`.
 * `settings.set` (the PC's settings page) and `team_control{action: "settings"}` after the user's answer on the PC
 * (06 §2.9) write through here.
 *
 * What the role texts say follows (2026-11-14): `directHold` switched off hands every held area back
 * (`direct.sweep`); `directHold` or the main block changed rewrites the main's role entry now (`main.refresh`);
 * `directHold`, `directTell` or the owner block changed brings the owners' entries up again before their next request
 * (`owner.stale`), and `directTell` or the peer block the peers' (`peers.stale`).
 */
export async function write(
  services: Services.Context,
  teamID: string,
  patch: OwnTeam.SettingsPatch,
): Promise<Services.Result<{ readonly team: OwnTeam.Team }>> {
  const asked = requested(patch.instructions)
  if (RoleInstructions.ROLES.some((role) => breaks(asked[role]))) return Services.failure("internal_error", BREAKER, {})
  const written = await services.write(teamID, async () => {
    const team = await services.registry.teams.get(teamID)
    if (!team) return undefined
    const before = await RoleInstructions.blocks(services.kv, services.log, teamID)
    const after: RoleInstructions.Blocks = Object.fromEntries(
      RoleInstructions.ROLES.flatMap((role) => {
        const value = role in asked ? asked[role] : before[role]
        return value === undefined ? [] : [[role, value]]
      }),
    )
    const changed = RoleInstructions.ROLES.filter((role) => before[role] !== after[role])
    if (changed.length > 0) await RoleInstructions.saveBlocks(services.kv, teamID, after)
    const next = await services.registry.teams.put({
      ...team,
      policy: { ...team.policy, ...patch.policy },
      patterns: patch.patterns ?? team.patterns,
    })
    return { before: team, team: next, changed }
  })
  if (!written) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: teamID })
  services.hub.publish({ name: "team.changed", data: { teamID: written.team.id, rev: written.team.rev } })
  await follow(services, written)
  return { ok: true, team: written.team }
}

/** The role texts after a save: hand-backs, the main's entry now, owners and peers before their next request. */
async function follow(
  services: Services.Context,
  input: {
    readonly before: OwnTeam.Team
    readonly team: OwnTeam.Team
    readonly changed: ReadonlyArray<RoleInstructions.Role>
  },
) {
  const features = services.features()
  const teamID = input.team.id
  const hold = Direct.hold(input.before) !== Direct.hold(input.team)
  const tell = Direct.tell(input.before) !== Direct.tell(input.team)
  if (hold && !Direct.hold(input.team)) await features.direct.sweep(teamID)
  if (hold || input.changed.includes("main")) {
    const refreshed = await features.main.refresh?.({ teamID })
    if (refreshed && !refreshed.ok) services.log.warn("main_role_update_failed", { teamID, message: refreshed.message })
  }
  if (hold || tell || input.changed.includes("owner")) await features.owner.stale?.({ teamID })
  if (tell || input.changed.includes("peer")) await features.peers.stale?.({ teamID })
}

/**
 * The blocks the patch sets, normalised as the settings page counts them (`\r\n` → `\n`, trimmed): `undefined` for a
 * role it resets (`null`, empty, or the default text). Roles the patch leaves out are not keys.
 */
function requested(
  input: OwnTeam.SettingsPatch["instructions"],
): Partial<Record<RoleInstructions.Role, string | undefined>> {
  return Object.fromEntries(
    RoleInstructions.ROLES.flatMap((role) => {
      const value = input?.[role]
      if (value === undefined) return []
      const text = value === null ? "" : value.replaceAll("\r\n", "\n").trim()
      return [[role, text === "" || text === RoleInstructions.STANDARD[role] ? undefined : text]]
    }),
  )
}

/**
 * A line the harness's baseline parser would read as its own marker. The wire refuses such lines; trimming can bring
 * one to the start of the block, so the normalised block is checked again.
 */
function breaks(text: string | undefined) {
  return (
    text !== undefined &&
    text.split("\n").some((line) => OwnTeam.INSTRUCTION_BREAKERS.some((breaker) => line.startsWith(breaker)))
  )
}

const BREAKER = "'</context>', '<context key=', 'Today's date:'로 시작하는 줄은 쓸 수 없어요."

export * as AreaEditRpc from "./area-edit.js"

import { OwnTeam } from "@own/protocol"
import { JudgeValidate } from "../judge/validate.js"
import { AreaCreate } from "../ops/area-create.js"
import { OwnerAlias } from "../registry/alias.js"
import { Areas } from "../registry/area.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * `area.edit` (06 §2.7, 2026-10-26): the area menu's 역할 바꾸기… (the area's `goal`, at most 1,000 characters: the wire
 * and `team_area{role}` refuse a longer one, so V12's clean never cuts it) and 내가 정한 영역 (`userMade`; `false` removes
 * the mark). A registry write in the team's mutex (`AreaCreate.save` announces `area.changed`): no op, no journal slot,
 * no undo, so it never waits for another team op. A changed role reaches an attached owner at once (`Owner.refresh`: an
 * equal value is not written again); an owner not attached yet gets it with its first main request. A role change
 * leaves status, candidate, outbox, peers, Main 멈춤 and direct work alone. Since 2026-11-14 `team_area{role}` edits
 * through here too (`by`): a change the user made on the screen or through the owner tells the main in its next update
 * (a `role` entry, no wake); the main's own change does not.
 *
 * 담당 메모 (`note`, feature `owner-note`): the user's note on the owner seat (`Owner.note`), trimmed; an empty one
 * removes it. At most {@link OwnTeam.OWNER_NOTE_MAX} characters, as a peer's role text. It is in no role entry, so
 * nothing is written to a conversation; the team's views show it where the area has a peer.
 *
 * 별칭 (`alias`, feature `owner-alias`, 2026-11-27): the user's short name for the owner seat (`Owner.alias`), trimmed;
 * an empty one removes it. At most {@link OwnTeam.OWNER_ALIAS_MAX} characters on one line, unique in the team
 * (`OwnerAlias.problem`, checked in the mutex against the registry as it is then). A registry write only: no role entry,
 * no title, no digest entry; the main's next team update names the area `별칭 · 영역(slug)`.
 *
 * `area.create.check` (2026-10-27, the same feature: the dialog that sends what `area-edit` builds take): 영역 만들기's
 * `만들 곳`, the folder and record name V6 gives a new area of the slug now (`AreaCreate.check`), so the dialog shows
 * `<slug>-2` where a branch or a non-empty folder has the name.
 */

export type Methods = "area.edit" | "area.create.check"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["area-edit", "owner-note", "owner-alias"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "area.edit": async (input, context) => {
      const edited = await edit(services, { ...input, by: "user" })
      if (!edited.ok) return RpcFailure.fail("area.edit", context, edited)
      return { area: edited.area }
    },
    "area.create.check": async (input, context) => {
      const checked = await AreaCreate.check(services, input)
      if (!checked.ok) return RpcFailure.fail("area.create.check", context, checked)
      return {
        slug: checked.slug,
        directory: checked.directory,
        ...(checked.taken === undefined ? {} : { taken: checked.taken }),
      }
    },
  }
}

export async function edit(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly goal?: string
    readonly userMade?: boolean
    readonly note?: string
    readonly alias?: string
    /** Who changes the role (internal, not on the wire): the screen's RPC is the user's; absent = the user. */
    readonly by?: "user" | "owner" | "main"
  },
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const note = input.note?.trim()
  if (note !== undefined && note.length > OwnTeam.OWNER_NOTE_MAX)
    return Services.failure("seat_invalid", "담당 메모는 1,024자 이하로 적어요", { why: "note" })
  const alias = input.alias?.trim()
  const written = await services.write(team.id, async (): Promise<Services.Result<Written>> => {
    const current = await services.registry.areas.get(team.id, input.areaID)
    if (!current || current.state === "retired")
      return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
    if (current.state === "broken")
      return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
        areaID: current.id,
        why: current.broken?.why ?? "identity",
      })
    const why = alias ? OwnerAlias.problem(alias, current.id, await services.registry.areas.list(team.id)) : undefined
    if (why === "alias")
      return Services.failure("seat_invalid", `별칭은 줄바꿈 없이 ${OwnTeam.OWNER_ALIAS_MAX}자 이하로 적어요`, { why })
    if (why === "alias-taken")
      return Services.failure("seat_invalid", `'${alias}'은(는) 팀의 다른 영역이나 동료가 이미 쓰는 이름이에요`, {
        why,
      })
    const goal = input.goal === undefined ? current.goal : JudgeValidate.clean(input.goal, JudgeValidate.LIMITS.goal)
    const owner = named(noted(current.owner, note), alias)
    const next = marked({ ...current, goal, owner }, input.userMade, services.clock.now())
    if (JSON.stringify(next) !== JSON.stringify(current)) await AreaCreate.save(services, next)
    return { ok: true, area: next, role: goal !== current.goal }
  })
  if (!written.ok) return written
  const by = input.by ?? "user"
  if (written.role && by !== "main")
    await services.features().digest.add(
      team.id,
      Fold.entry({
        at: services.clock.now(),
        reason: "role",
        areaID: written.area.id,
        text: by === "owner" ? "역할이 바뀜(담당이 사용자 말로)" : "역할이 바뀜(사용자가 화면에서)",
      }),
    )
  if (written.role) {
    const refreshed = await services.features().owner.refresh?.({ teamID: team.id, areaID: written.area.id })
    // The registry holds the new role; the owner gets it before its next request (`Owner.role`).
    if (refreshed && !refreshed.ok)
      services.log.warn("area_role_refresh_failed", {
        teamID: team.id,
        areaID: written.area.id,
        message: refreshed.message,
      })
  }
  return { ok: true, area: Areas.view(written.area) }
}

interface Written {
  readonly area: OwnTeam.Area
  /** The role text changed. */
  readonly role: boolean
}

/** The owner note as asked: kept (`undefined`), removed (empty) or set. */
function noted(owner: OwnTeam.Owner, note: string | undefined): OwnTeam.Owner {
  if (note === undefined) return owner
  const { note: _note, ...rest } = owner
  return note === "" ? rest : { ...rest, note }
}

/** The owner alias as asked: kept (`undefined`), removed (empty) or set. */
function named(owner: OwnTeam.Owner, alias: string | undefined): OwnTeam.Owner {
  if (alias === undefined) return owner
  const { alias: _alias, ...rest } = owner
  return alias === "" ? rest : { ...rest, alias }
}

/** The mark as asked: kept (`undefined`), set once (`true`, its first time stays) or removed (`false`). */
function marked(area: OwnTeam.Area, userMade: boolean | undefined, now: number): OwnTeam.Area {
  if (userMade === undefined) return area
  const { userMade: mark, ...rest } = area
  return userMade ? { ...rest, userMade: mark ?? { at: now } } : rest
}

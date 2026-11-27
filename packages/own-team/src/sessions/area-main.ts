export * as AreaMain from "./area-main.js"

import { Option, Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { AreaCreate } from "../ops/area-create.js"
import { Areas } from "../registry/area.js"
import { Services } from "../services.js"
import { TeamAccount } from "./team-account.js"
import { TeamContext } from "./team-context.js"
import { Journal } from "../ops/journal.js"

/**
 * Area main and area preset with the team-wide R4 (06 §10.1 영역 메인·영역 프리셋, §6.1 영역 계정 변경, §2.7), and the team
 * account (`sessions/team-account.ts`, which also follows the team main).
 *
 * `area.main{model | null, now?}` (`null` = 팀과 같게, the team main's Ref): the area's new account must keep the team's
 * R4 (`same_company_subscription`). The registry is written first and every binding gets the new team context; then
 * - an account change continues in a new conversation at the next safe point (a rotation op, by the user, Main 멈춤 or
 *   not), or with `now` (영역 메뉴 `지금 바꾸기`, the owner's composer) switches the owner conversation now;
 * - a model or effort change always switches the owner conversation now (02 switch, never a rotation);
 * - a move to another provider group takes the area preset of the same name in that group, else its ★, else its
 *   `평소대로`, passing over one that breaks R4 (07 §5.3): the cost dialog's `프리셋: X → Y` line.
 *
 * `area.preset{presetID}`: a preset of the area main's group (`preset_wrong_group`) that keeps R4, applied to the owner
 * conversation now with the team context (no rotation, no switch, 07 §5.3), then recorded and pushed to every binding.
 * While the owner still waits for its move to an area main of another group, the preset is only recorded.
 */

const decodeAccount = Schema.decodeUnknownOption(Schema.Struct({ accountID: Account.ID }))
const decodeGroup = Schema.decodeUnknownOption(Schema.Struct({ group: Preset.Group }))

export function create(services: Services.Context): Services.AreaMain {
  const account = TeamAccount.create(services)
  return {
    set: (input) => set(services, input),
    preset: (input) => preset(services, input),
    account: (input) => account.account(input),
    resume: () => account.resume(),
    close: () => account.close(),
  }
}

async function set(
  services: Services.Context,
  input: Parameters<Services.AreaMain["set"]>[0],
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView; readonly opID?: OwnTeam.OpID }>> {
  const found = await place(services, input.teamID, input.areaID)
  if (!found.ok) return found
  const active = await services.journal.active(input.teamID)
  if (active) return Services.failure("busy", "another team operation is running", Journal.busy(active))
  const snapshot = await TeamContext.load(services, input.teamID)
  if (!snapshot) return Services.failure("internal_error", "own.accounts could not be read", {})
  const main = snapshot.state.holders[0]?.ref
  if (!main) return Services.failure("internal_error", "팀 메인의 모델을 알 수 없어요", {})
  const area = found.area
  const next = input.model ?? main
  const owner = area.owner.sessionID
  const session =
    owner === null ? undefined : await services.http.session.get({ sessionID: owner, directory: area.directory })
  const current = (session?.ok ? session.value.model : undefined) ?? area.main?.model ?? main
  const presetID = regroup(snapshot, area, current, next)
  const after = TeamContext.change(snapshot, area.id, { ref: next, preset: snapshot.preset(presetID) })
  const clash = TeamContext.breaks(snapshot.state, after)
  if (clash)
    return Services.failure("same_company_subscription", "this account would be a second subscription of a company", {
      accountID: clash,
    })

  await services.write(input.teamID, async () => {
    const latest = await services.registry.areas.get(input.teamID, area.id)
    if (!latest) return
    const { main: _cleared, ...rest } = latest
    await AreaCreate.save(services, {
      ...rest,
      ...(input.model === null ? {} : { main: { model: input.model, chosenBy: "user" as const } }),
      preset: presetID,
    })
  })
  await services.features().teamContext.push(input.teamID)
  const moved = await move(services, {
    teamID: input.teamID,
    area,
    owner: owner === null ? undefined : { sessionID: owner, current },
    next,
    now: input.now === true,
    by: input.by,
  })
  if (!moved.ok) return moved
  const latest = (await services.registry.areas.get(input.teamID, area.id)) ?? area
  return { ok: true, area: Areas.view(latest), ...(moved.opID === undefined ? {} : { opID: moved.opID }) }
}

/**
 * The owner conversation follows the new area main: an account change continues in a new conversation (the rotation
 * op) unless `now`; a model or effort change, and `now`, switch it now. No owner, or the same Ref, changes nothing.
 */
async function move(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly area: OwnTeam.Area
    readonly owner: { readonly sessionID: string; readonly current: Model.Ref } | undefined
    readonly next: Model.Ref
    readonly now: boolean
    readonly by: OwnTeam.Op["by"]
  },
): Promise<Services.Result<{ readonly opID?: OwnTeam.OpID }>> {
  const owner = input.owner
  if (!owner || TeamAccount.sameRef(owner.current, input.next)) return { ok: true }
  if (owner.current.providerID !== input.next.providerID && !input.now) {
    const started = await services.features().rotate.request({
      teamID: input.teamID,
      areaID: input.area.id,
      reason: "account",
      handoff: "warm",
      by: input.by,
    })
    return started.ok ? { ok: true, opID: started.opID } : started
  }
  return TeamAccount.switchNow(services, {
    sessionID: owner.sessionID,
    directory: input.area.directory,
    target: input.next,
  })
}

/**
 * The area preset after the area main moves from `current` to `next` (07 §5.3, 06 §10.1): unchanged within a group;
 * in another group, the preset of the same name there, else that group's ★, else its `평소대로`, passing over a preset
 * that breaks the team's R4.
 */
function regroup(snapshot: TeamContext.Snapshot, area: OwnTeam.Area, current: Model.Ref, next: Model.Ref) {
  const from = TeamContext.groupOf({ ref: current, account: snapshot.account(current.providerID) })
  const to = TeamContext.groupOf({ ref: next, account: snapshot.account(next.providerID) })
  if (to === undefined || to === from) return area.preset
  const listing = snapshot.group(to)
  const name = snapshot.preset(area.preset)?.name
  const named = name === undefined ? undefined : listing.presets.find((preset) => preset.name === name)
  const star = listing.star === undefined ? undefined : snapshot.preset(listing.star)
  const fits = (preset: Preset.Info) =>
    TeamContext.breaks(snapshot.state, TeamContext.change(snapshot, area.id, { ref: next, preset })) === undefined
  return (
    [named, star].find((preset): preset is Preset.Info => preset !== undefined && fits(preset))?.id ??
    Preset.builtinID(to)
  )
}

async function preset(
  services: Services.Context,
  input: Parameters<Services.AreaMain["preset"]>[0],
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView }>> {
  const found = await place(services, input.teamID, input.areaID)
  if (!found.ok) return found
  const snapshot = await TeamContext.load(services, input.teamID)
  if (!snapshot) return Services.failure("internal_error", "own.accounts could not be read", {})
  const area = found.area
  const holder = snapshot.state.holders.find((item) => item.areaID === area.id)
  const group = holder && TeamContext.groupOf(holder)
  const chosen = snapshot.preset(input.presetID)
  if (!chosen) return Services.failure("not_found", "preset not found", { what: "preset", id: input.presetID })
  if (group === undefined) return Services.failure("internal_error", "the area main's provider has no presets", {})
  if (chosen.group !== group)
    return Services.failure("preset_wrong_group", "the preset is not of the area main's group", { group })
  const after = TeamContext.change(snapshot, area.id, { preset: chosen })
  const clash = TeamContext.breaks(snapshot.state, after)
  if (clash)
    return Services.failure("same_company_subscription", "a target of this preset breaks the team's subscriptions", {
      accountID: clash,
    })

  const owner = area.owner.sessionID
  // An owner still on another group waits for its move to the area main (an account change continues in a new
  // conversation, 06 §10.1): the preset is recorded now and binds the new owner (6.2 step 3); `push` keeps the old
  // owner on its own group's preset meanwhile.
  const bound =
    owner === null ? undefined : await services.accounts.presetGet({ sessionID: owner }, { directory: area.directory })
  const moving = bound?.ok === true && bound.value.preset !== null && bound.value.preset.group !== group
  if (owner !== null && !moving) {
    const team: Preset.Team = {
      teamID: input.teamID,
      role: "owner",
      ...TeamContext.context(after, TeamContext.offenders(after)),
    }
    const applied = await services.accounts.presetApply(
      { sessionID: owner, presetID: chosen.id, team },
      { directory: area.directory },
    )
    if (!applied.ok) return refused(applied, group, chosen.id)
  }
  await services.write(input.teamID, async () => {
    const latest = await services.registry.areas.get(input.teamID, area.id)
    if (latest) await AreaCreate.save(services, { ...latest, preset: chosen.id })
  })
  await services.features().teamContext.push(input.teamID)
  const latest = (await services.registry.areas.get(input.teamID, area.id)) ?? area
  return { ok: true, area: Areas.view(latest) }
}

/** own.accounts' refusal of `session.preset.apply` as the `area.preset` error of the same meaning (07 §8.1). */
function refused(
  applied: { readonly type: string; readonly message: string; readonly data?: unknown },
  group: Preset.Group,
  presetID: Preset.ID,
): Services.Failure {
  if (applied.type === "same_company_subscription") {
    const data = Option.getOrUndefined(decodeAccount(applied.data))
    if (data) return Services.failure("same_company_subscription", applied.message, { accountID: data.accountID })
  }
  if (applied.type === "preset_wrong_group")
    return Services.failure("preset_wrong_group", applied.message, {
      group: Option.getOrUndefined(decodeGroup(applied.data))?.group ?? group,
    })
  if (applied.type === "preset_not_found")
    return Services.failure("not_found", applied.message, { what: "preset", id: presetID })
  return Services.failure("internal_error", `프리셋을 적용하지 못했어요: ${applied.message}`, {})
}

/** The team (on) and the area (not retired, not broken) an area method works on. */
async function place(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) {
  const team = await services.registry.teams.get(teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(teamID, areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: areaID })
  if (area.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  return { ok: true as const, team, area }
}

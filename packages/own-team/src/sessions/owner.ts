export * as OwnerSession from "./owner.js"

import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { type OwnTeam, Preset } from "@own/protocol"
import { AreaCreate } from "../ops/area-create.js"
import { Services } from "../services.js"
import { Permissions } from "../tools/permissions.js"
import { RoleInstructions } from "./instructions.js"
import { MainSession } from "./main.js"
import { TeamContext } from "./team-context.js"

/**
 * Area owner sessions (06 §6.2 step 3, §3.7, §10.1). `create` writes the new id to `owner.pending` first
 * (write-ahead), so a retry after a crash adopts the session made before (core session.ts:253), then
 * `session.create` in the area folder on `model` ?? the area main ?? the team main's current Ref (`팀과 같게`, given
 * explicitly so own-accounts' default never pins another account) and on the 에이전트 방식 the user chose for a new
 * area or that of the conversation it replaces (2026-10-26, `own.harness`), the team owner allows, approval mode (never
 * `computerUse`), `session.preset.apply{area.preset, team}` (ultra off) and the role entries `own.team.role` (+
 * `own.team.handoff`).
 *
 * Registry: an area without an owner (a new area, or an adopted folder without a conversation) gets the new session as
 * its owner and `pending` is cleared. When the area still has an owner, the caller is a rotation: `pending` stays,
 * and the rotation swaps it in (6.2 step 4, `sessions/rotate.ts`). When own.accounts refused `area.preset` because it
 * is gone or of another group, the preset bound instead becomes `area.preset`; a team R4 refusal leaves it for the
 * repair notice (10.1).
 *
 * An adopted owner (`owner.attached: false`, `ops/adopt.ts`) gets the team at its first main request ({@link attach},
 * delta 1: 06 §2.8, 02 §4.3 D10's exception) and loses it again when the area leaves the team ({@link detach}).
 */

export function create(services: Services.Context): Services.Owner {
  /** Owners whose role entry this controller brought (or is bringing) up to date (`team:area:session`). */
  const current = new Set<string>()
  /**
   * Per team, how often {@link Services.Owner.stale} ran: a write that read the registry before a `stale` does not
   * count as up to date, so a settings save that lands while a write is under way is never lost.
   */
  const stamps = new Map<string, number>()
  /** The owner's role entry from the area as recorded; `once`: skipped when this controller wrote it already. */
  const write = async (input: Target, once: boolean): Promise<Services.Result> => {
    const stamp = stamps.get(input.teamID) ?? 0
    const [team, area] = await Promise.all([
      services.registry.teams.get(input.teamID),
      services.registry.areas.get(input.teamID, input.areaID),
    ])
    const sessionID = area?.owner.sessionID
    if (!team || !area || !sessionID || !area.owner.attached) return { ok: true }
    const key = `${team.id}:${area.id}:${sessionID}`
    if (once && current.has(key)) return { ok: true }
    // Marked first: two sends that overlap check it once.
    current.add(key)
    const put = await RoleInstructions.put(services, {
      sessionID,
      directory: area.directory,
      key: RoleInstructions.OWNER,
      value: RoleInstructions.owner({
        team,
        area,
        blocks: await RoleInstructions.blocks(services.kv, services.log, team.id),
      }),
    })
    if (!put.ok || (stamps.get(team.id) ?? 0) !== stamp) current.delete(key)
    return put.ok ? { ok: true } : put
  }
  return {
    // 역할 바꾸기 (`area.edit`, 2026-10-26): written now with the area as recorded. A write that fails leaves the owner
    // to `role` before its next request (the mark goes); one that succeeds counts as that update.
    refresh: (input) => write(input, false),
    role: async (input) => {
      // 06 §6.2, §5.8: an attached owner gets the current text once per controller (and again after `stale`), before
      // its next request goes (which reaches its folder's Location anyway; the controller's start wakes no area
      // Location). An area edit made since (a new name or role) comes with it. `put` skips an equal value, so an
      // owner that has it already gets no instruction delta.
      const written = await write(input, true)
      if (!written.ok)
        services.log.warn("owner_role_update_failed", {
          teamID: input.teamID,
          areaID: input.areaID,
          message: written.message,
        })
    },
    stale: async (input) => {
      // 2026-11-14: `directHold`, `directTell` or the owner block changed: every owner (of the area) is written again
      // by `role` before its next request.
      stamps.set(input.teamID, (stamps.get(input.teamID) ?? 0) + 1)
      const prefix = input.areaID === undefined ? `${input.teamID}:` : `${input.teamID}:${input.areaID}:`
      for (const key of [...current].filter((item) => item.startsWith(prefix))) current.delete(key)
    },
    create: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
      const area = await services.registry.areas.get(team.id, input.areaID)
      if (!area || area.state === "retired")
        return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
      if (area.state === "broken")
        return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
          areaID: area.id,
          why: area.broken?.why ?? "identity",
        })
      const model = input.model ?? area.main?.model ?? (await services.features().main.model(team.id))
      if (!model) return Services.failure("internal_error", "팀 메인의 모델을 알 수 없어요", {})
      const sessionID = await pending(services, area)
      if (!sessionID) return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: area.id })
      // 2026-10-26: the 에이전트 방식 the user chose for a new area, else the one of the conversation it replaces.
      const harness =
        input.harness ??
        (input.harnessFrom === undefined ? undefined : await MainSession.harnessOf(services, input.harnessFrom))
      const opened = await MainSession.open(services, {
        sessionID,
        directory: area.directory,
        model,
        title: `${area.name} · 담당`,
        meta: { role: "owner", teamID: team.id, areaID: area.id },
        ...(harness === undefined ? {} : { harness }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (!opened.ok) return opened
      const prepared = await MainSession.prepare(services, {
        teamID: team.id,
        role: "owner",
        sessionID,
        directory: area.directory,
        model: opened.model,
        approval: input.approval ?? MainSession.APPROVAL,
        presetID: area.preset,
        entries: [
          {
            key: RoleInstructions.OWNER,
            value: RoleInstructions.owner({
              team,
              area,
              blocks: await RoleInstructions.blocks(services.kv, services.log, team.id),
            }),
          },
          ...(input.handoff === undefined ? [] : [{ key: RoleInstructions.HANDOFF, value: input.handoff }]),
        ],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (!prepared.ok) return prepared
      const preset =
        prepared.fallback === "preset_not_found" || prepared.fallback === "preset_wrong_group"
          ? prepared.presetID
          : null
      await services.write(team.id, async () => {
        const current = await services.registry.areas.get(team.id, area.id)
        if (!current) return
        const first = current.owner.sessionID === null
        if (!first && preset === null) return
        await AreaCreate.save(services, {
          ...current,
          ...(first
            ? { owner: { sessionID, previous: current.owner.previous, attached: true, ...carried(current.owner) } }
            : {}),
          ...(preset === null ? {} : { preset }),
        })
      })
      return { ok: true, sessionID }
    },
    attach: (input) => attach(services, input),
  }
}

interface Target {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly signal?: AbortSignal
}

/**
 * 3.7: the team for an adopted owner at its first main request, in this order: the owner's team tool allows
 * (`Permissions.write`: read-merge-write of exactly `team.owner` and `team.member`, then own.accounts
 * `session.approval.set{mode}` with the mode the session had, skipped for `custom`, never `computerUse`, so its
 * computer allow stays), the `own.team.role` entry (not written again when it holds the same text), and the area
 * preset with the team context, applied only when the binding does not hold both already. Then `owner.attached`.
 * Nothing else of the conversation changes: its model, its size and its history stay (U6, 10.1).
 */
export async function attach(services: Services.Context, input: Target): Promise<Services.Result> {
  const found = await areaOf(services, input)
  if (!found.ok) return found
  const area = found.area
  if (area.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  const sessionID = area.owner.sessionID
  if (sessionID === null)
    return Services.failure("not_found", "영역에 담당 대화가 없어요", { what: "session", id: area.id })
  if (area.owner.attached) return { ok: true }
  const call = input.signal === undefined ? undefined : { signal: input.signal }
  const session = await services.http.session.get({ sessionID, directory: area.directory }, call)
  if (!session.ok)
    return session.status === 404
      ? Services.failure("not_found", "담당 대화를 찾을 수 없어요", { what: "session", id: sessionID })
      : Services.failure("internal_error", `담당 대화를 읽지 못했어요: ${session.message}`, {})
  const allowed = await Permissions.write(services, { sessionID, directory: area.directory, role: "owner" })
  if (!allowed.ok) return allowed
  const role = await RoleInstructions.put(services, {
    sessionID,
    directory: area.directory,
    key: RoleInstructions.OWNER,
    value: RoleInstructions.owner({
      team: found.team,
      area,
      blocks: await RoleInstructions.blocks(services.kv, services.log, found.team.id),
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!role.ok) return role
  const model = session.value.model
  const bound = model === undefined ? { ok: true as const } : await rebind(services, { area, sessionID, model })
  if (!bound.ok) return bound
  await services.write(area.teamID, async () => {
    const current = await services.registry.areas.get(area.teamID, area.id)
    if (!current || current.owner.sessionID !== sessionID) return
    await AreaCreate.save(services, {
      ...current,
      owner: { ...current.owner, attached: true },
      ...(bound.presetID === undefined ? {} : { preset: bound.presetID }),
    })
  })
  return { ok: true }
}

/**
 * The inverse of {@link attach} (8.2 빼기, 3.8 되돌리기): the team allows (`Permissions.merge(current, null)`, then
 * own.accounts `session.approval.set{mode}` again), the role and handoff entries and the binding's team context, each
 * only where it is, so a conversation that never got them is not written to. `owner.attached` goes back to `false`;
 * the conversation, its model and its preset stay the user's.
 */
export async function detach(services: Services.Context, input: Target): Promise<Services.Result> {
  const found = await areaOf(services, input)
  if (!found.ok) return found
  const area = found.area
  const sessionID = area.owner.sessionID
  if (sessionID === null) return { ok: true }
  const stripped = await strip(services, {
    sessionID,
    directory: area.directory,
    keys: [RoleInstructions.OWNER, RoleInstructions.HANDOFF],
    allows: true,
    context: true,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!stripped.ok) return stripped
  await services.write(area.teamID, async () => {
    const current = await services.registry.areas.get(area.teamID, area.id)
    if (!current || current.owner.sessionID !== sessionID || !current.owner.attached) return
    await AreaCreate.save(services, { ...current, owner: { ...current.owner, attached: false } })
  })
  return { ok: true }
}

/**
 * What the team gave one conversation, taken back by its id: the team allows (`allows`), the instruction entries
 * `keys` and the binding's team context (`context`), each only where it is. {@link detach} does it for the area's
 * owner; `Seat.sweep` for a conversation that held the seat before (담당 대화 바꾸기), which may be a peer by now and
 * then keeps its allows. The registry is not written.
 */
export async function strip(
  services: Services.Context,
  input: {
    readonly sessionID: SessionID
    readonly directory: string
    readonly keys: ReadonlyArray<string>
    readonly allows: boolean
    readonly context: boolean
    readonly signal?: AbortSignal
  },
): Promise<Services.Result> {
  const sessionID = input.sessionID
  const where = { sessionID, directory: input.directory }
  const instance = services.instance(input.directory)
  if (!instance) return Services.failure("internal_error", "이 폴더의 팀 서비스가 아직 준비되지 않았어요", {})
  const session = await instance.ctx.session.get({ sessionID }).catch(() => undefined)
  if (!session) return Services.failure("not_found", "담당 대화를 찾을 수 없어요", { what: "session", id: sessionID })
  const actions: ReadonlySet<string> = new Set(Object.values(Permissions.ACTIONS))
  if (input.allows && (session.permissions ?? []).some((rule) => actions.has(rule.action))) {
    const written = await Permissions.write(services, { ...where, role: null })
    if (!written.ok) return written
  }
  const call = input.signal === undefined ? undefined : { signal: input.signal }
  const entries = await services.http.instructions.list(where, call)
  if (!entries.ok) return Services.failure("internal_error", `대화의 지시 항목을 읽지 못했어요: ${entries.message}`, {})
  const removed = await Promise.all(
    input.keys
      .filter((key) => entries.value.some((entry) => entry.key === key))
      .map((key) => services.http.instructions.remove({ ...where, key }, call)),
  )
  const kept = removed.find((result) => !result.ok)
  if (kept && !kept.ok) return Services.failure("internal_error", `역할 지시를 떼지 못했어요: ${kept.message}`, {})
  if (!input.context) return { ok: true }
  const view = await services.accounts.presetGet({ sessionID }, { directory: input.directory })
  const preset = view.ok ? view.value.preset : null
  if (view.ok && view.value.binding?.team !== undefined && preset) {
    // `team: null` clears the team context; the preset itself stays.
    const cleared = await services.accounts.presetApply(
      { sessionID, presetID: preset.id, team: null },
      { directory: input.directory },
    )
    if (!cleared.ok) services.log.warn("owner_team_context_kept", { sessionID, type: cleared.type })
  }
  return { ok: true }
}

/**
 * The owner fields that stay with the area when its owner conversation changes: the conversations still to be released
 * (`Seat.sweep`), the user's owner note and the owner alias (별칭).
 */
export function carried(owner: OwnTeam.Owner) {
  return {
    ...(owner.release === undefined ? {} : { release: owner.release }),
    ...(owner.note === undefined ? {} : { note: owner.note }),
    ...(owner.alias === undefined ? {} : { alias: owner.alias }),
  }
}

async function areaOf(
  services: Services.Context,
  input: Target,
): Promise<Services.Result<{ readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  return { ok: true, team, area }
}

/** Why a preset could not be bound, so the next candidate is tried (07 §5.3, §8.1). */
const RETRY: ReadonlySet<string> = new Set(["preset_not_found", "preset_wrong_group", "same_company_subscription"])

/**
 * `session.preset.apply{area.preset, team}` for an adopted owner, unless its binding holds that preset and this team
 * context already (07 §5.1: own.accounts then writes no instruction entry either). A refused preset falls back to the
 * group's ★, then its `평소대로`; `presetID` is the preset to record when the area's is gone or of another group (a
 * team R4 refusal keeps it for the repair notice, as `create` does). A model without a preset group gets no binding.
 */
async function rebind(
  services: Services.Context,
  input: { readonly area: OwnTeam.Area; readonly sessionID: string; readonly model: Model.Ref },
): Promise<Services.Result<{ readonly presetID?: Preset.ID }>> {
  const kind = await MainSession.group(services, input.model)
  if (!kind) return { ok: true }
  const where = { directory: input.area.directory }
  const [team, view] = await Promise.all([
    services.features().teamContext.get({ teamID: input.area.teamID, role: "owner" }),
    services.accounts.presetGet({ sessionID: input.sessionID }, where),
  ])
  const binding = view.ok ? view.value.binding : null
  const holds = team === null ? binding?.team === undefined : TeamContext.holds(binding?.team, team)
  if (binding?.presetID === input.area.preset && holds) return { ok: true }
  const candidates = [...new Set([input.area.preset, await MainSession.star(services, kind), Preset.builtinID(kind)])]
  const attempt = async (
    index: number,
    refused: string | undefined,
  ): Promise<Services.Result<{ readonly presetID?: Preset.ID }>> => {
    const presetID = candidates[index]
    if (presetID === undefined) return Services.failure("internal_error", "그 묶음의 프리셋을 붙이지 못했어요", {})
    const applied = await services.accounts.presetApply(
      { sessionID: input.sessionID, presetID, ...(team === null ? {} : { team }) },
      where,
    )
    if (applied.ok)
      return refused === "preset_not_found" || refused === "preset_wrong_group" ? { ok: true, presetID } : { ok: true }
    if (!RETRY.has(applied.type))
      return Services.failure("internal_error", `프리셋을 적용하지 못했어요: ${applied.message}`, {})
    services.log.warn("preset_refused", { sessionID: input.sessionID, presetID, type: applied.type })
    return attempt(index + 1, refused ?? applied.type)
  }
  return attempt(0, undefined)
}

/** The write-ahead id (6.2 step 3): the one an earlier attempt wrote, else a new one written now. */
async function pending(services: Services.Context, area: OwnTeam.Area) {
  return services.write(area.teamID, async () => {
    const current = await services.registry.areas.get(area.teamID, area.id)
    if (!current) return undefined
    if (current.owner.pending) return current.owner.pending
    const id = SessionID.create()
    await services.registry.areas.put({ ...current, owner: { ...current.owner, pending: id } })
    return id
  })
}

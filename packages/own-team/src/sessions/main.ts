export * as MainSession from "./main.js"

import type { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import { type Approval, OwnTeam, Preset } from "@own/protocol"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import { Identity } from "../git/identity.js"
import { Services } from "../services.js"
import { Permissions } from "../tools/permissions.js"
import { RoleInstructions } from "./instructions.js"

/**
 * The team main session (06 §3.6 step 2, §6.3, §10.1): made fresh at the home with the enabling conversation's
 * account, model and effort, the group's ★ preset and the main role entry; never that conversation's preset or ultra,
 * and never a computer allow. `model` reads the main session's current Ref (what `팀과 같게` follows). `resume` brings
 * the role entry of every team that is on up to date once per controller (06 §6.3), and `refresh` again when the
 * team's `directHold` or its main block changed (`ops/settings.ts`).
 *
 * The creation chain is shared with owners (`sessions/owner.ts`): {@link open} is `session.create{id, location,
 * model, permissions, metadata, title}` with the role's team tool allows only (delta 0, 06 §2.8), the 에이전트 방식 it
 * keeps (`own.harness` beside `own.team`, 2026-10-26: own.team's new conversations stay on the one before), and
 * {@link prepare} runs before the first prompt: own.accounts `session.approval.set{mode}` (never `computerUse`: computer
 * use is switched on per session by the user only), `session.preset.apply{presetID, team}` and the role entries.
 */

export const TITLE = "팀 메인"

/**
 * The approval mode when the caller passes none: `묻기`, the default of a new session (03 §18.8). The user's
 * new-session default lives in own-web, so enable passes it when it has it.
 */
export const APPROVAL: Approval.SetMode = "ask"

export function create(services: Services.Context): Services.Main {
  /** Mains whose role entry this controller brought (or is bringing) up to date (`team:session`). */
  const current = new Set<string>()
  /**
   * The main's role entry from the team's settings and 팀 지시문. Marked before the first await, so resumes that
   * overlap (controller start, a new instance) write it once; a failed write takes the mark back.
   */
  const write = async (team: OwnTeam.Team) => {
    const key = `${team.id}:${team.main.sessionID}`
    current.add(key)
    const put = await RoleInstructions.put(services, {
      sessionID: team.main.sessionID,
      directory: team.home.directory,
      key: RoleInstructions.MAIN,
      value: RoleInstructions.main({ team, blocks: await RoleInstructions.blocks(services.kv, services.log, team.id) }),
    })
    if (!put.ok) current.delete(key)
    return put
  }
  return {
    resume: async () => {
      // 06 §6.3: the role text changed (the voice actions, 06 §2.9; direct work and 팀 지시문, 2026-11-14); a main made
      // before gets it once. `put` skips an equal value, so a main that has it already gets no instruction delta.
      const teams = (await services.registry.teams.list()).filter(
        (team) => team.state === "on" && !current.has(`${team.id}:${team.main.sessionID}`),
      )
      await Promise.all(
        teams.map(async (team) => {
          const put = await write(team)
          if (!put.ok) services.log.warn("main_role_update_failed", { teamID: team.id, message: put.message })
        }),
      )
    },
    refresh: async (input) => {
      // 2026-11-14: `directHold` or the main's block changed; written even when `resume` brought the main up already.
      const team = await services.registry.teams.get(input.teamID)
      if (!team || team.state !== "on") return { ok: true }
      const put = await write(team)
      return put.ok ? { ok: true } : put
    },
    create: async (input) => {
      const opened = await open(services, {
        sessionID: input.sessionID,
        directory: input.directory,
        model: input.model,
        title: TITLE,
        meta: { role: "main", teamID: input.teamID },
        signal: input.signal,
      })
      if (!opened.ok) return opened
      const prepared = await prepare(services, {
        teamID: input.teamID,
        role: "main",
        sessionID: input.sessionID,
        directory: input.directory,
        model: opened.model,
        approval: input.approval ?? APPROVAL,
        entries: [{ key: RoleInstructions.MAIN, value: await role(services, input.teamID) }],
        signal: input.signal,
      })
      if (!prepared.ok) return prepared
      return { ok: true, sessionID: input.sessionID }
    },
    model: async (teamID) => {
      const team = await services.registry.teams.get(teamID)
      if (!team) return undefined
      const session = await services.http.session.get({
        sessionID: team.main.sessionID,
        directory: team.home.directory,
      })
      return session.ok ? session.value.model : undefined
    },
  }
}

/**
 * The main's role text from the team's record and 팀 지시문. Enable makes the main before it writes the team record
 * (only a new team has an early one), so without a record the text follows `OwnTeam.POLICY` and the default blocks.
 */
async function role(services: Services.Context, teamID: OwnTeam.TeamID) {
  const [team, blocks] = await Promise.all([
    services.registry.teams.get(teamID),
    RoleInstructions.blocks(services.kv, services.log, teamID),
  ])
  return RoleInstructions.main({ team: team ?? { policy: OwnTeam.POLICY }, blocks })
}

/**
 * `session.create` of a team main or owner (06 §3.6 `session-create`). The id was chosen ahead, so a retry adopts the
 * session made before (core session.ts:253); an id that names a session in another folder is refused. Returns the
 * session's model (an adopted session keeps its own).
 */
export async function open(
  services: Services.Context,
  input: {
    readonly sessionID: SessionID
    readonly directory: string
    readonly model: Model.Ref
    readonly title: string
    readonly meta: OwnTeam.SessionMeta
    /** The 에이전트 방식 it starts on (metadata `own.harness`); absent = the service's default for a new conversation. */
    readonly harness?: OwnTeam.Harness
    readonly signal?: AbortSignal
  },
): Promise<Services.Result<{ readonly model: Model.Ref }>> {
  const harness = input.harness
  const created = await services.http.session.create(
    {
      id: input.sessionID,
      directory: input.directory,
      model: input.model,
      title: input.title,
      // A created peer gets exactly the owner's allows (동료: the same catalog; the registry narrows what it may do).
      permissions: [...Permissions.rules(input.meta.role === "main" ? "main" : "owner")],
      metadata: {
        [OwnTeam.SESSION_META]: {
          role: input.meta.role,
          teamID: input.meta.teamID,
          ...(input.meta.areaID === undefined ? {} : { areaID: input.meta.areaID }),
        },
        ...(harness === undefined
          ? {}
          : { [OwnHarnessRouting.META_KEY]: OwnHarnessRouting.value(harness.id, harness.prompt) }),
      },
    },
    input.signal === undefined ? undefined : { signal: input.signal },
  )
  if (!created.ok)
    return Services.failure("internal_error", `${ROLE[input.meta.role]} 대화를 만들지 못했어요: ${created.message}`, {})
  if (created.value.parentID !== undefined || !Identity.same(created.value.location.directory, input.directory))
    return Services.failure("internal_error", `같은 ID의 대화가 다른 폴더에 이미 있어요: ${input.sessionID}`, {})
  return { ok: true, model: created.value.model ?? input.model }
}

/**
 * The 에이전트 방식 a conversation runs (its metadata `own.harness`), for the conversation own.team makes in its place
 * (2026-10-26); `undefined` when it names none this build knows (it runs the service's default) or cannot be read.
 */
export async function harnessOf(
  services: Services.Context,
  ref: { readonly sessionID: string; readonly directory: string },
): Promise<OwnTeam.Harness | undefined> {
  const session = await services.http.session.get(ref)
  if (!session.ok) return undefined
  const id = OwnHarnessRouting.bound(session.value.metadata)
  return id === undefined ? undefined : { id, prompt: OwnHarnessRouting.promptOf(session.value.metadata) }
}

/** The roles in screen words (06 §9.1), for the failure a step turns into its note. */
const ROLE: Readonly<Record<OwnTeam.SessionMeta["role"], string>> = { main: "팀 메인", owner: "담당", peer: "동료" }

/** Why a preset could not be bound, so the next candidate is tried (07 §5.3, §8.1). */
const RETRY: ReadonlySet<string> = new Set(["preset_not_found", "preset_wrong_group", "same_company_subscription"])

/**
 * Approval mode, preset binding and role entries of a new team session, in that order (06 §3.6, §6.2 step 3).
 *
 * The preset is `presetID` (an owner's `area.preset`), else the ★ of the model's group (07 §5.1: never the enabling
 * conversation's preset; ultra starts off). own.team's team context goes with it. When own.accounts refuses the preset
 * (another group, gone, or the team's R4), the group's ★ and then its `평소대로` are tried; `fallback` names the
 * refusal. A model outside every preset group gets no binding (`presetID: null`).
 */
export async function prepare(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly role: "main" | "owner"
    readonly sessionID: SessionID
    readonly directory: string
    readonly model: Model.Ref
    readonly approval: Approval.SetMode
    readonly presetID?: Preset.ID
    readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>
    readonly signal?: AbortSignal
  },
): Promise<Services.Result<{ readonly presetID: Preset.ID | null; readonly fallback?: string }>> {
  const where = { directory: input.directory }
  const approval = await services.accounts.approvalSet({ sessionID: input.sessionID, mode: input.approval }, where)
  if (!approval.ok) return Services.failure("internal_error", `승인 모드를 정하지 못했어요: ${approval.message}`, {})
  const kind = await group(services, input.model)
  const bound = kind === undefined ? { ok: true as const, presetID: null } : await bind(services, input, kind)
  if (!bound.ok) return bound
  for (const entry of input.entries) {
    const put = await RoleInstructions.put(services, {
      sessionID: input.sessionID,
      directory: input.directory,
      key: entry.key,
      value: entry.value,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!put.ok) return put
  }
  return bound
}

async function bind(
  services: Services.Context,
  input: Parameters<typeof prepare>[1],
  kind: Preset.Group,
): Promise<Services.Result<{ readonly presetID: Preset.ID; readonly fallback?: string }>> {
  const team = await services.features().teamContext.get({ teamID: input.teamID, role: input.role })
  const best = await star(services, kind)
  const candidates = [...new Set([input.presetID ?? best, best, Preset.builtinID(kind)])]
  const attempt = async (
    index: number,
    fallback: string | undefined,
  ): Promise<Services.Result<{ readonly presetID: Preset.ID; readonly fallback?: string }>> => {
    const presetID = candidates[index]
    if (presetID === undefined) return Services.failure("internal_error", "그 묶음의 프리셋을 붙이지 못했어요", {})
    const applied = await services.accounts.presetApply(
      { sessionID: input.sessionID, presetID, ...(team === null ? {} : { team }) },
      { directory: input.directory },
    )
    if (applied.ok) return { ok: true, presetID, ...(fallback === undefined ? {} : { fallback }) }
    if (!RETRY.has(applied.type))
      return Services.failure("internal_error", `프리셋을 적용하지 못했어요: ${applied.message}`, {})
    services.log.warn("preset_refused", { sessionID: input.sessionID, presetID, type: applied.type })
    return attempt(index + 1, fallback ?? applied.type)
  }
  return attempt(0, undefined)
}

/**
 * The preset group of a model (07 P-D2): its account's kind (own.accounts' account of that provider id), else a local
 * provider's `local:<id>`; `undefined` when no preset applies.
 */
export async function group(services: Services.Context, model: Model.Ref): Promise<Preset.Group | undefined> {
  const listed = await services.accounts.accountsList()
  const account = listed.ok ? listed.value.accounts.find((item) => item.providerID === model.providerID) : undefined
  return Preset.groupOf(model.providerID, account)
}

/** The group's ★ (`presets.list`), else its `평소대로`. */
export async function star(services: Services.Context, kind: Preset.Group): Promise<Preset.ID> {
  const listed = await services.accounts.presetsList({ group: kind })
  const row = listed.ok ? listed.value.groups.find((item) => item.group === kind) : undefined
  return row?.star ?? Preset.builtinID(kind)
}

export * as TeamContext from "./team-context.js"

import { Option, Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { type Account, OwnAccounts, type OwnTeam, Preset } from "@own/protocol"
import type { Services } from "../services.js"

/**
 * The team context of every team session's preset binding and the team-wide R4 (07 §5.1, §5.4; 06 §10.1 팀 전체 R4).
 *
 * S = the team main's account, every area main's account (`팀과 같게` = the team main's), and the pinned targets of the
 * team main's preset and of every area preset. R4 holds when each company has at most one subscription in S and, for
 * the team main's company, that subscription is the team main's; one ChatGPT login's `codex` and `siwc` accounts count
 * once (`Preset.allowed`). own.accounts' gate judges each session with its binding's `team`: `accounts` = the team's
 * subscription accounts, `pinned` = the pinned targets that keep R4. A pinned target that breaks it (a preset edited
 * later, the team moved to another account) stays out of `pinned`, is announced once per process (`preset.repair`) and
 * stays open in `team.get` `notices` until it is fixed; the gate then runs that role like the main (07 §1.2).
 *
 * `push` sends `session.preset.apply{presetID, team}` to the team main (its preset in force) and to every owner (its
 * area preset) whose binding differs, so a change that only moves the team context writes no instruction entry
 * (own.accounts keeps the entry when its text is the same). While a team account op runs, a session keeps its own current
 * account for its company in `accounts` (06 §10.1 경로): the team main may already be on the new account while an owner
 * still finishes on the old one. It runs on `presets.changed`, on a team main's `session.preset.changed` (the main's
 * preset pins are part of S), once `enable.registry` turns the team on (the main was bound before, while it was off),
 * after every new area record and every area main, area preset and team account change, and on resume. Nothing may
 * count on an area Location booting (and resuming the controller) when its owner is made: since v2.2.1 none does.
 */

/** A team session's side of R4: the main Ref it runs on, that Ref's account and its preset. */
export interface Holder {
  /** Absent: the team main. */
  readonly areaID?: OwnTeam.AreaID
  readonly ref: Model.Ref | undefined
  /** `undefined`: a local or built-in provider (no own account). */
  readonly account: Account.View | undefined
  readonly preset: Preset.Info | undefined
}

/** S as holders: the team main first, then the areas in id order. */
export interface State {
  readonly teamID: OwnTeam.TeamID
  readonly holders: ReadonlyArray<Holder>
  readonly lookup: Preset.Lookup
}

/** One team as R4 and the context read it (`load`). */
export interface Snapshot {
  readonly team: OwnTeam.Team
  /** Areas that are not retired. */
  readonly areas: ReadonlyArray<OwnTeam.Area>
  readonly state: State
  readonly accounts: ReadonlyArray<Account.View>
  /** own.accounts' account of a provider; `undefined` for a local or built-in provider. */
  readonly account: (providerID: string) => Account.View | undefined
  /** A preset by id among every group's (`평소대로` included); `undefined` when unknown. */
  readonly preset: (presetID: string) => Preset.Info | undefined
  /** A group's presets (★ first) and its ★. */
  readonly group: (group: Preset.Group) => { readonly presets: ReadonlyArray<Preset.Info>; readonly star?: Preset.ID }
}

/** The team part of a binding without its role. */
export type Context = Pick<Preset.Team, "accounts" | "pinned">

/** Upstream's Claude Agent provider, whose accounts share it (02 §8.10). */
const CLAUDE_AGENT = "claude-agent"

const PRESETS_CHANGED = `rpc.${OwnAccounts.ID}.presets.changed`
const SESSION_PRESET_CHANGED = `rpc.${OwnAccounts.ID}.session.preset.changed`

const decodeSessionEvent = Schema.decodeUnknownOption(Schema.Struct({ sessionID: Schema.String }))

/** Role names as the repair notice words them (07 §7.5). */
const ROLE_WORDS: Readonly<Record<Preset.Role, string>> = {
  explore: "탐색",
  general: "일반",
  "own-review": "리뷰",
  "own-quick": "빠른 일",
  "own-deep": "어려운 일",
}

export function create(services: Services.Context): Services.TeamContext {
  /** Repairs already announced per team, so each is told once (until it is fixed and breaks again). */
  const announced = new Map<string, ReadonlySet<string>>()

  const sync = async (teamID: OwnTeam.TeamID, announce: boolean) => {
    const snapshot = await load(services, teamID)
    if (!snapshot || snapshot.team.state !== "on") return
    const found = offenders(snapshot.state)
    const known = announced.get(teamID) ?? new Set<string>()
    const notices = repairsOf(snapshot.state, found).map((repair) => ({
      key: repairKey(repair),
      notice: noticeOf(snapshot, repair),
    }))
    announced.set(teamID, new Set(notices.map((item) => item.key)))
    if (announce)
      for (const item of notices.filter((entry) => !known.has(entry.key))) services.notices.publish(item.notice)
    // Open until fixed (06 §2.7 `team.get` `notices`): a window opened later still shows the repair.
    const now = services.clock.now()
    await services.notices.keep(
      teamID,
      "preset.repair",
      notices.map((item) => ({ id: item.key, at: now, ...item.notice })),
    )
    const op = await services.journal.active(teamID)
    await bindAll(services, snapshot, context(snapshot.state, found), op?.kind === "team-account")
  }
  const syncAll = async (announce: boolean) => {
    const teams = await services.registry.teams.list()
    await Promise.all(teams.filter((team) => team.state === "on").map((team) => sync(team.id, announce)))
  }

  const stop = services.hub.on(async (event) => {
    if (event.type === PRESETS_CHANGED) return syncAll(true)
    if (event.type !== SESSION_PRESET_CHANGED) return
    const sessionID = Option.getOrUndefined(decodeSessionEvent(event.data))?.sessionID
    if (sessionID === undefined) return
    const found = await services.locate.session(sessionID)
    // Owners' presets are their area presets (registry); only the team main's preset is chosen on the session.
    if (found?.role === "main") await sync(found.team.id, true)
  })

  return {
    get: async (input) => {
      const snapshot = await load(services, input.teamID)
      if (!snapshot || snapshot.team.state !== "on") return null
      return { teamID: input.teamID, role: input.role, ...context(snapshot.state, offenders(snapshot.state)) }
    },
    push: (teamID) => sync(teamID, true),
    // After a restart every repair still broken is told again; one told in this process is not.
    resume: () => syncAll(true),
    close: async () => stop(),
  }
}

/**
 * Reads the team, its areas, own.accounts' accounts and presets, and the team main's Ref and preset in force.
 * `undefined` when the team is unknown or the accounts cannot be read (nothing can be judged without them).
 */
export async function load(services: Services.Context, teamID: OwnTeam.TeamID): Promise<Snapshot | undefined> {
  const team = await services.registry.teams.get(teamID)
  if (!team) return undefined
  const home = { directory: team.home.directory }
  const [areas, listed, groups, main, bound] = await Promise.all([
    services.registry.areas.list(teamID),
    services.accounts.accountsList(),
    services.accounts.presetsList({}),
    services.http.session.get({ sessionID: team.main.sessionID, directory: team.home.directory }),
    services.accounts.presetGet({ sessionID: team.main.sessionID }, home),
  ])
  if (!listed.ok) {
    services.log.warn("team_context_unreadable", { teamID, message: listed.message })
    return undefined
  }
  if (!groups.ok) services.log.warn("team_context_presets_unreadable", { teamID, message: groups.message })
  const accounts = listed.value.accounts
  const views = groups.ok ? groups.value.groups : []
  const presets: ReadonlyArray<Preset.Info> = views.flatMap((view) => view.presets ?? [])
  // Several Claude Agent accounts share one provider (02 §8.10): a holder on it runs on the team's account, so R4 tells
  // that account apart from the route's others (its pinned targets, a team context naming another).
  const ref = main.ok ? main.value.model : undefined
  const live = areas.filter((area) => area.state !== "retired")
  const agent = [ref, ...live.map((area) => area.main?.model)].some((item) => item?.providerID === CLAUDE_AGENT)
    ? await services.accounts.claudeAgentSession({ sessionID: team.main.sessionID }, home)
    : undefined
  const agentID = agent?.ok ? agent.value.accountID : null
  const account = (providerID: string) =>
    (providerID === CLAUDE_AGENT && agentID !== null
      ? accounts.find((item) => item.id === agentID && item.providerID === providerID)
      : undefined) ?? accounts.find((item) => item.providerID === providerID)
  const preset = (presetID: string) => presets.find((item) => item.id === presetID)
  const holder = (input: { readonly areaID?: OwnTeam.AreaID; readonly ref: Model.Ref | undefined }) => ({
    ...(input.areaID === undefined ? {} : { areaID: input.areaID }),
    ref: input.ref,
    account: input.ref && account(input.ref.providerID),
  })
  return {
    team,
    areas: live,
    accounts,
    account,
    preset,
    group: (group) => {
      const view = views.find((item) => item.group === group)
      return { presets: view?.presets ?? [], ...(view?.star === undefined ? {} : { star: view.star }) }
    },
    state: {
      teamID,
      lookup: (accountID) => accounts.find((item) => item.id === accountID),
      holders: [
        { ...holder({ ref }), preset: (bound.ok ? bound.value.preset : null) ?? undefined },
        ...live.map((area) => ({
          ...holder({ areaID: area.id, ref: area.main?.model ?? ref }),
          preset: preset(area.preset),
        })),
      ],
    },
  }
}

/** The state with one area's main Ref (and its account) or preset replaced. */
export function change(
  snapshot: Snapshot,
  areaID: OwnTeam.AreaID,
  next: { readonly ref?: Model.Ref; readonly preset?: Preset.Info },
): State {
  const state = snapshot.state
  return {
    ...state,
    holders: state.holders.map((holder) =>
      holder.areaID !== areaID
        ? holder
        : {
            ...holder,
            ...(next.ref === undefined ? {} : { ref: next.ref, account: snapshot.account(next.ref.providerID) }),
            ...(next.preset === undefined ? {} : { preset: next.preset }),
          },
    ),
  }
}

/**
 * The accounts that break the team's R4 (06 §10.1), in S order: the team main's account judged with every area main's
 * account and every pinned target as members of S, so one ChatGPT login's `codex` and `siwc` accounts count once. Each
 * offender is taken out and S is judged again, so every clash names one account.
 */
export function offenders(state: State): ReadonlyArray<Account.ID> {
  const main = state.holders[0]
  if (!main) return []
  const members = [
    ...state.holders.slice(1).flatMap((holder) => (holder.account ? [holder.account.id] : [])),
    ...state.holders.flatMap((holder) => pins(holder.preset).flatMap((pin) => accountOf(pin))),
  ]
  const judge = (left: ReadonlyArray<Account.ID>, found: ReadonlyArray<Account.ID>): ReadonlyArray<Account.ID> => {
    const verdict = Preset.allowed(bare(main), main.account?.id ?? null, state.lookup, {
      teamID: state.teamID,
      role: "main",
      accounts: left,
      pinned: [],
    })
    if (verdict.ok) return found
    if (!left.includes(verdict.accountID)) return [...found, verdict.accountID]
    return judge(
      left.filter((accountID) => accountID !== verdict.accountID),
      [...found, verdict.accountID],
    )
  }
  return judge(members, [])
}

/**
 * The first account that breaks R4 in `next` and did not in `current`, or `undefined`: a change is refused for what it
 * breaks, never for a repair the team already waits for.
 */
export function breaks(current: State, next: State) {
  const before = new Set(offenders(current))
  return offenders(next).find((accountID) => !before.has(accountID))
}

/**
 * The team part of a binding: the team's subscription accounts and the pinned targets that keep R4 for every team
 * session. A pinned target an offender holds is left out (the gate runs its role like the main), and so is one that a
 * session would judge as another slot of its own main's company (the same login's `codex`/`siwc` sibling): the gate
 * never runs a subagent there, and listing it would make that session refuse every pinned target.
 */
export function context(state: State, found: ReadonlyArray<Account.ID>): Context {
  const out = new Set(found)
  const accounts = unique(
    state.holders.flatMap((holder) =>
      holder.account?.billing === "subscription" && !out.has(holder.account.id) ? [holder.account.id] : [],
    ),
  )
  const pinned = uniqueBy(
    state.holders.flatMap((holder) => pins(holder.preset)),
    pinKey,
  ).filter((pin) => {
    const owner = pin.pin.account
    if (Preset.isLocal(owner)) return true
    if (out.has(owner)) return false
    return state.holders.every(
      (holder) =>
        Preset.allowed(bare(holder), holder.account?.id ?? null, state.lookup, {
          teamID: state.teamID,
          role: "main",
          accounts: [],
          pinned: [pin],
        }).ok,
    )
  })
  return { accounts, pinned }
}

/** The preset targets whose account is an offender, per preset and account (06 §10.1 수리 알림, `team.account` plan). */
export function repairsOf(state: State, found: ReadonlyArray<Account.ID>): ReadonlyArray<OwnTeam.Repair> {
  const out = new Set(found)
  return state.holders.flatMap((holder) => {
    const preset = holder.preset
    if (!preset) return []
    const accounts = unique(pins(preset).flatMap((pin) => accountOf(pin)))
    return accounts
      .filter((accountID) => out.has(accountID))
      .map((accountID) => {
        const pool = poolOn(preset, accountID)
        return {
          ...(holder.areaID === undefined ? {} : { areaID: holder.areaID }),
          presetID: preset.id,
          accountID,
          roles: rolesOn(preset, accountID),
          ...(pool.length > 0 ? { pool } : {}),
        }
      })
  })
}

/** Whether a binding already holds this team context (same accounts and pinned targets, in any order). */
export function holds(stored: Preset.Team | undefined, team: Preset.Team) {
  if (!stored || stored.teamID !== team.teamID || stored.role !== team.role) return false
  const accounts = (value: Preset.Team) => [...value.accounts].toSorted().join("\n")
  const pinned = (value: Preset.Team) =>
    value.pinned
      .map((target) => ("pin" in target ? pinKey(target) : `rel\0${target.rel}`))
      .toSorted()
      .join("\n")
  return accounts(stored) === accounts(team) && pinned(stored) === pinned(team)
}

/** Whether two accounts are one subscription (`Preset.oneSubscription`, the rule R4 itself uses). */
export const sameSubscription = Preset.oneSubscription

/** Another subscription of the same company (07 §5.5): the accounts a team never uses at once (U5). */
export function rival(a: Preset.Member | undefined, b: Preset.Member | undefined) {
  return (
    a?.billing === "subscription" &&
    b?.billing === "subscription" &&
    Preset.company(a) === Preset.company(b) &&
    !sameSubscription(a, b)
  )
}

/**
 * `accounts` as one session sees them while the team moves (06 §10.1 경로): the session's own current account stands
 * for its company, so the session's gate judges with the account it really runs on.
 */
export function keep(context: Context, current: Account.View | undefined, lookup: Preset.Lookup): Context {
  if (current?.billing !== "subscription") return context
  const others = context.accounts.filter((accountID) => {
    const member = lookup(accountID)
    return !member || Preset.company(member) !== Preset.company(current) || sameSubscription(member, current)
  })
  return { ...context, accounts: unique([...others, current.id]) }
}

/**
 * The pinned targets of a preset: every role row, `single` and the model pool's pinned entries (inactive ones too, as
 * R4 counts them; `Preset.targetsOf`).
 */
export function pins(preset: Pick<Preset.Info, "workers"> | undefined) {
  if (!preset) return []
  return Preset.targetsOf(preset.workers).flatMap((target) => ("pin" in target ? [target] : []))
}

/** The group a holder's main belongs to (07 P-D2); `undefined` for a built-in provider (no preset applies). */
export function groupOf(holder: Pick<Holder, "ref" | "account">) {
  return holder.ref && Preset.groupOf(holder.ref.providerID, holder.account)
}

type Pin = Extract<Preset.Target, { readonly pin: unknown }>

function accountOf(pin: Pin): ReadonlyArray<Account.ID> {
  const owner = pin.pin.account
  return Preset.isLocal(owner) ? [] : [owner]
}

function pinKey(pin: Pin) {
  return `${pin.pin.account}\0${pin.pin.model}`
}

/**
 * A preset without targets in the holder's group, so `Preset.allowed` judges S alone. A main without an own account (a
 * local or built-in provider) has no company of its own, which a `local:` group says.
 */
function bare(holder: Holder): Pick<Preset.Info, "group" | "workers"> {
  const group: Preset.Group = holder.account?.kind ?? `local:${holder.ref?.providerID ?? "none"}`
  return { group, workers: { mode: "same", roles: {} } }
}

/** The roles whose targets run on `accountID`; `single` stands for every role when it is the preset's mode. */
function rolesOn(preset: Preset.Info, accountID: Account.ID): ReadonlyArray<Preset.Role> {
  const workers = preset.workers
  const on = (target: Preset.Target) => "pin" in target && target.pin.account === accountID
  const single = Preset.modeOf(workers) === "single" && workers.single !== undefined && on(workers.single)
  if (single) return Preset.ROLES
  return Preset.ROLES.filter((role) => (workers.roles[role]?.targets ?? []).some(on))
}

/** The model pool names pinned to `accountID` (07 T4), in pool order. */
function poolOn(preset: Preset.Info, accountID: Account.ID): ReadonlyArray<string> {
  return (preset.workers.pool ?? []).flatMap((entry) => (entry.account === accountID ? [entry.key] : []))
}

/** The repair's open notice id: the same while one preset breaks R4 with one account in one place. */
function repairKey(repair: OwnTeam.Repair) {
  return `repair:${repair.areaID ?? "main"}:${repair.presetID}:${repair.accountID}`
}

/**
 * `preset.repair` (06 §10.1): `'다른 회사 리뷰' 프리셋이 ChatGPT 03 계정을 써서 cl-perf 리뷰 역할을 cl-perf 모델로 돌려요` (the
 * roles run on that conversation's own model: the area's 모델, 2026-10-16 glossary); a model pool entry (07 T4) `…
 * cl-perf 모델 묶음의 gpt-6-sol 항목을 기본 규칙으로 돌려요`, both clauses joined when both break.
 */
function noticeOf(snapshot: Snapshot, repair: OwnTeam.Repair) {
  const preset = snapshot.preset(repair.presetID)?.name ?? repair.presetID
  const label = snapshot.accounts.find((item) => item.id === repair.accountID)?.label ?? repair.accountID
  const area = repair.areaID === undefined ? undefined : snapshot.areas.find((item) => item.id === repair.areaID)
  const roles = repair.roles.map((role) => ROLE_WORDS[role]).join(", ")
  const pool = (repair.pool ?? []).join(", ")
  const where = area?.name ?? "팀 메인"
  const clause = pool
    ? roles
      ? `${where} ${roles} 역할을 ${where} 모델로, 모델 묶음의 ${pool} 항목을 기본 규칙으로 돌려요`
      : `${where} 모델 묶음의 ${pool} 항목을 기본 규칙으로 돌려요`
    : `${where} ${roles || "하위 에이전트"} 역할을 ${where} 모델로 돌려요`
  return {
    teamID: snapshot.team.id,
    ...(repair.areaID === undefined ? {} : { areaID: repair.areaID }),
    kind: "preset.repair" as const,
    text: `'${preset}' 프리셋이 ${label} 계정을 써서 ${clause}`,
    data: {
      presetID: repair.presetID,
      preset,
      accountID: repair.accountID,
      account: label,
      roles,
      ...(pool ? { pool } : {}),
    },
  }
}

/** `session.preset.apply{presetID, team}` for the team main and every owner whose binding differs. */
async function bindAll(services: Services.Context, snapshot: Snapshot, base: Context, moving: boolean) {
  const team = snapshot.team
  const sessions = [
    { role: "main" as const, sessionID: team.main.sessionID, directory: team.home.directory },
    // An adopted owner (`attached: false`) keeps its own conversation untouched until its first main request (3.7).
    ...snapshot.areas.flatMap((area) =>
      area.owner.sessionID === null || !area.owner.attached
        ? []
        : [
            {
              role: "owner" as const,
              sessionID: area.owner.sessionID,
              directory: area.directory,
              presetID: area.preset,
            },
          ],
    ),
    // A peer own.team created (동료) runs on the area preset like its owner; a registered one keeps the user's preset.
    ...snapshot.areas.flatMap((area) =>
      (area.peers ?? [])
        .filter((peer) => peer.origin === "created" && peer.attached)
        .map((peer) => ({
          role: "owner" as const,
          sessionID: peer.sessionID,
          directory: area.directory,
          presetID: area.preset,
        })),
    ),
  ]
  await Promise.all(
    sessions.map((session) =>
      bind(services, snapshot, base, moving, session).catch((error: unknown) =>
        services.log.warn("team_context_bind_failed", { sessionID: session.sessionID, error }),
      ),
    ),
  )
}

async function bind(
  services: Services.Context,
  snapshot: Snapshot,
  base: Context,
  moving: boolean,
  session: {
    readonly role: "main" | "owner"
    readonly sessionID: string
    readonly directory: string
    /** The area preset of an owner; the main keeps the preset in force. */
    readonly presetID?: Preset.ID
  },
) {
  const where = { directory: session.directory }
  const view = await services.accounts.presetGet({ sessionID: session.sessionID }, where)
  if (!view.ok) return services.log.warn("team_context_get_failed", { sessionID: session.sessionID, type: view.type })
  const current = view.value.preset
  // No preset applies to a built-in provider's main.
  if (!current) return
  const desired = session.presetID === undefined ? undefined : snapshot.preset(session.presetID)
  const presetID = desired?.group === current.group ? desired.id : current.id
  const runs = view.value.resolution?.main
  const own = moving && runs ? keep(base, snapshot.account(runs.providerID), snapshot.state.lookup) : base
  const team: Preset.Team = { teamID: snapshot.team.id, role: session.role, ...own }
  if (view.value.binding?.presetID === presetID && holds(view.value.binding.team, team)) return
  const applied = await services.accounts.presetApply({ sessionID: session.sessionID, presetID, team }, where)
  if (applied.ok) return
  if (applied.type !== "same_company_subscription" || Preset.isBuiltin(presetID))
    return services.log.warn("team_context_apply_failed", { sessionID: session.sessionID, type: applied.type })
  // The preset's own pinned target breaks R4 with this team (06 §10.1): `평소대로` keeps the gate on the new team until
  // the user fixes the preset; the repair notice says which one.
  const fallback = await services.accounts.presetApply(
    { sessionID: session.sessionID, presetID: Preset.builtinID(current.group), team },
    where,
  )
  services.log.warn("team_context_preset_held", {
    sessionID: session.sessionID,
    presetID,
    applied: fallback.ok,
  })
}

function unique<T>(values: ReadonlyArray<T>) {
  return [...new Set(values)]
}

function uniqueBy<T>(values: ReadonlyArray<T>, key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value), value])).values()]
}

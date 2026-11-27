// What the composer shows of a root session's preset (07 §7.3, §5.1, §2.6, §2.9, §8.1 원격): the group of its main,
// the preset in effect (`[프리셋: <이름> ▾]`), the start preset of a new session, the menu's rows (★ first, `평소대로`
// always, 최근), the team's R4 for team sessions, the `하위 에이전트 2/3 실행 중 · 이 메시지 5개` badge, the heavy and
// ultra banner with the accounts its usage line names, when an ultra change asks with the cost dialog, and the role a
// subagent runs as. Pure: callers pass store values (OwnStore `presetGroups`, `presetSettings`, `sessionPreset`).
import type { Account, Estimate } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { Schema } from "effect"
import { presetRows } from "./model"
import type { PresetsBootKey } from "./boot-strings"

/** The preset settings a new session reads (`presets.list`, 07 §5.1). */
export interface StartSettings {
  readonly newSession: Preset.NewSession
  readonly recent: ReadonlyArray<Preset.ID>
}

/** A main as the composer knows it: its provider, and the account behind it (none for a local or built-in provider). */
export function mainGroup(
  ref: { readonly providerID: string } | null | undefined,
  accountOf: (providerID: string) => Account.View | undefined,
): Preset.Group | undefined {
  return ref ? Preset.groupOf(ref.providerID, accountOf(ref.providerID)) : undefined
}

/** A preset of a group by id: one `presets.list` gives, or the group's `평소대로`. */
export function presetOf(group: Preset.Group, view: Preset.GroupView | undefined, id: Preset.ID) {
  return presetRows(group, view).find((item) => item.id === id)
}

/**
 * The preset a root session uses now (07 §5.3): `session.preset.get`'s while it is of the main's group; else the
 * binding's, or the group's ★ when the main moved to another group (the service rebinds it), else `평소대로`.
 */
export function presetInEffect(
  group: Preset.Group,
  session: Preset.SessionView | undefined,
  view: Preset.GroupView | undefined,
): Preset.Info {
  if (session?.preset?.group === group) return session.preset
  const id = Preset.effective(session?.binding ?? undefined, group, view?.star)
  return presetOf(group, view, id) ?? Preset.builtin(group)
}

/**
 * The preset a new session starts with (07 §5.1): the group's ★; with `마지막에 쓴 것` the group's newest recently
 * used preset while it is light (delegation at most `요청할 때만`, no paid target), else the ★.
 */
export function startPreset(
  group: Preset.Group,
  settings: StartSettings,
  view: Preset.GroupView | undefined,
  lookup: Preset.Lookup,
): Preset.ID {
  const star = view?.star ?? Preset.builtinID(group)
  if (settings.newSession !== "last-light") return star
  const last = settings.recent.flatMap((id) => presetOf(group, view, id) ?? []).at(0)
  return last && Preset.light(last, lookup) ? last.id : star
}

/**
 * The menu's presets (07 §7.3): the group's own, ★ first and `평소대로` always; `평소대로` only for a remote server
 * without this PC's presets (`presetPlace` `builtin`, 07 §8.1 원격). Other groups are never listed.
 */
export function menuRows(group: Preset.Group, view: Preset.GroupView | undefined, remote: boolean): Preset.Listed[] {
  if (remote) return [{ ...Preset.builtin(group), status: "ok" }]
  return presetRows(group, view)
}

/** `최근`: up to `limit` recently applied presets of this group, newest first, without the one in use. */
export function recentRows(
  group: Preset.Group,
  view: Preset.GroupView | undefined,
  recent: ReadonlyArray<Preset.ID>,
  current: Preset.ID | undefined,
  limit = 3,
) {
  return [...new Set(recent)].flatMap((id) => (id === current ? [] : (presetOf(group, view, id) ?? []))).slice(0, limit)
}

/** A preset's name on screen: `평소대로` in the current language, a stored preset by its own name. */
export function presetName(preset: Pick<Preset.Info, "id" | "name">, builtin: string) {
  return Preset.isBuiltin(preset.id) ? builtin : preset.name
}

/**
 * The account a preset adds against a team's R4 (07 §5.1, §5.3 step 2): the menu of a team session dims it with that
 * account; `undefined` when it fits, or without a team.
 */
export function teamClash(
  preset: Pick<Preset.Info, "group" | "workers">,
  main: Account.ID | null,
  lookup: Preset.Lookup,
  team: Preset.Team | undefined,
): Account.ID | undefined {
  if (!team) return undefined
  const verdict = Preset.allowed(preset, main, lookup, team)
  return verdict.ok ? undefined : verdict.accountID
}

/** A preset by id among every group's presets (the team's worst case counts areas of any group). */
export function presetByID(groups: Readonly<Record<string, Preset.GroupView>>, id: string): Preset.Info | undefined {
  const listed = Object.values(groups)
    .flatMap((view) => view.presets ?? [])
    .find((item) => item.id === id)
  if (listed) return listed
  const group = id.startsWith("builtin:") ? id.slice("builtin:".length) : undefined
  return group !== undefined && isGroup(group) ? Preset.builtin(group) : undefined
}

const isGroup = Schema.is(Preset.Group)

/** Live subagent counts of a root (07 §2.6): running children, and children started since its last user message. */
export function liveCounts(
  children: ReadonlyArray<{ readonly created: number; readonly running: boolean }>,
  lastUser: number | undefined,
) {
  return {
    running: children.filter((child) => child.running).length,
    message: lastUser === undefined ? undefined : children.filter((child) => child.created >= lastUser).length,
  }
}

export interface Running {
  readonly running: number
  readonly max: number
  readonly message: number
}

/**
 * `하위 에이전트 2/3 실행 중 · 이 메시지 5개` (07 §7.3): only while the preset delegates actively or ultra is on. The
 * cap is the one in force (`Preset.caps`, the service's `session.preset.get`); live counts win over the read ones.
 */
export function runningBadge(
  session: Preset.SessionView | undefined,
  live: { readonly running: number; readonly message?: number } | undefined,
): Running | undefined {
  if (!session) return undefined
  if (session.preset?.delegation !== "active" && !session.binding?.ultra) return undefined
  return {
    running: live?.running ?? session.counts.running,
    max: session.caps.concurrent,
    message: live?.message ?? session.counts.message,
  }
}

/**
 * The targets a preset sends work to now: `Preset.targetsOf` over the places its mode uses (the role rows, `single`, or
 * the model pool's pins; none for `메인과 같은 모델로`). Rows a mode does not use stay stored but send nothing.
 */
export function usedTargets(workers: Preset.Workers): ReadonlyArray<Preset.Target> {
  const mode = Preset.modeOf(workers)
  return Preset.targetsOf({
    ...workers,
    roles: mode === "by-role" ? workers.roles : {},
    single: mode === "single" ? workers.single : undefined,
    pool: mode === "pool" ? workers.pool : undefined,
  })
}

/** The pinned accounts a preset sends work to now ({@link usedTargets}), the main account left out. */
export function pinnedAccounts(preset: Pick<Preset.Info, "workers">, main?: string): Account.ID[] {
  const accounts = usedTargets(preset.workers).flatMap((target) =>
    "pin" in target && !Preset.isLocal(target.pin.account) && target.pin.account !== main ? [target.pin.account] : [],
  )
  return [...new Set(accounts)]
}

function paid(billing: Account.Charge | undefined) {
  return billing === "metered" || billing === "prepaid"
}

/**
 * The one-line banner above the composer (07 §5.1, §2.9): ultra on, or a heavy preset (`적극적으로`, a paid target).
 * Ultra's line names the main account and every subscription a target runs on (their usage), and this conversation's
 * paid amount when a target costs money.
 */
export type Banner =
  | {
      readonly kind: "ultra"
      readonly accounts: ReadonlyArray<Account.ID>
      readonly paid: boolean
    }
  | { readonly kind: "heavy"; readonly active: boolean; readonly paid: boolean }

export function bannerOf(
  session: Preset.SessionView | undefined,
  preset: Pick<Preset.Info, "workers" | "delegation">,
  main: Account.ID | undefined,
  lookup: Preset.Lookup,
): Banner | undefined {
  const pinned = pinnedAccounts(preset, main)
  const costs = pinned.some((accountID) => paid(lookup(accountID)?.billing))
  if (session?.binding?.ultra) {
    const subscriptions = pinned.filter((accountID) => lookup(accountID)?.billing === "subscription")
    return { kind: "ultra", accounts: [...(main ? [main] : []), ...subscriptions], paid: costs }
  }
  if (!Preset.heavy(preset, lookup)) return undefined
  return { kind: "heavy", active: preset.delegation === "active", paid: costs }
}

/**
 * 07 §2.9: an ultra change asks with a cost dialog only when the main's effort changes off the effort-update path
 * (`variantOnly.preservesCache`); no estimate means the effort stays as it is.
 */
export function ultraNeedsDialog(result: { readonly estimate: Estimate.Result | null }) {
  return result.estimate !== null && result.estimate.variantOnly?.preservesCache !== true
}

/** Groups whose ultra keeps the effort and offers `xhigh로 올리기` instead (07 §2.9, Claude Code ultracode). */
export function keepsEffort(group: Preset.Group | undefined) {
  return group === "claude-sub" || group === "anth"
}

/** Role names (07 §7.5 `own.preset.role.*`) by agent id. */
export const ROLE_KEY: Readonly<Record<Preset.Role, PresetsBootKey>> = {
  explore: "own.preset.role.explore",
  general: "own.preset.role.general",
  "own-review": "own.preset.role.review",
  "own-quick": "own.preset.role.quick",
  "own-deep": "own.preset.role.deep",
}

/** The role a subagent runs as (its agent id); other agents have none. */
export function roleKey(agent: string | undefined): PresetsBootKey | undefined {
  const role = agent ? Preset.ROLES.find((item) => item === agent) : undefined
  return role ? ROLE_KEY[role] : undefined
}

/** Preset errors of `session.preset.apply` and `area.preset` (07 §8.1) in the editor's words. */
const ERRORS: Readonly<Record<string, PresetsBootKey>> = {
  preset_not_found: "own.preset.err.notFound",
  preset_wrong_group: "own.preset.err.wrongGroup",
  same_company_subscription: "own.preset.err.sameCompany",
  preset_target_unavailable: "own.preset.err.targetUnavailable",
  preset_builtin_locked: "own.preset.err.builtinLocked",
  "own.scope_denied": "own.preset.page.readOnly",
}

export function errorKey(type: string | undefined): PresetsBootKey | undefined {
  return type ? ERRORS[type] : undefined
}

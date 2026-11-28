// Team-aware parts of the switch flow (06 §9.5, §10.1; 07 §5.5, §7.3), loaded with the popover (lazy chunk):
// - Routes. On the team main, another subscription of a company the team has an account of is 팀 계정 바꾸기
//   (`team.account`). In an area's owner conversation, account, model and effort changes are the area main's
//   (`area.main{model, now:true}`). A `team_switch_required` answer from any switch path opens 팀 계정 바꾸기 too.
// - The 팀 계정 바꾸기 dialog. `team.account{dryRun}` plans it; the cost dialog shows the plan's team-wide lines with
//   [끝나면 바꾸기] (the default), [멈추고 바꾸기] and [취소]; the choice runs `team.account{mode}`.
// - The area main switcher. `openSwitcher({mode: "area", …})`, also answering team/intents `openSwitcherForArea`,
//   opens the popover on an area with `팀과 같게` on top; its choice is `area.main`: an account change continues in a
//   new conversation at the next safe point, while `지금 바꾸기` and model or effort changes switch the owner now.
// - The pick of 영역 만들기 (2026-10-26). `openSwitcherToPick` opens the same popover on the team (its R4 filter and
//   `팀과 같게` on top) and only hands the choice back; the dialog sends it with the new area (`ReorgOp.main`).
import type { Estimate, Switch } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { OwnRpcError, type ServerKey, type ServerRuntime } from "@/data"
import type { I18n } from "@/i18n"
import { presetPlace } from "@/presets/model"
import { presetsText, type PresetsKey } from "@/presets/strings"
import { teamIntents, type AreaTarget } from "@/team/intents"
import { errorText, type TeamText } from "@/team/model"
import type { SessionPlace } from "@/team/store"
import { teamText } from "@/team/strings"
import { switcherControl, type SwitcherRequest } from "./control"
import { sameRef, type TargetRef } from "./cost"
import { presetMove, presetMoveText, presetNow } from "./describe"
import type { FlowEnv } from "./flow"
import { accountOf } from "./labels"
import { outsideTeam } from "./picker"
import { showToast } from "./toast"

// ---------------------------------------------------------------------------------------------------------------
// Routes

export type SwitchRoute =
  | { readonly kind: "plain" }
  /** The team main moving to another subscription of a team company: 팀 계정 바꾸기 (06 §10.1). */
  | { readonly kind: "team-account"; readonly teamID: string }
  /** An area's owner conversation: the change is the area main's, switched in this conversation now (06 §9.5). */
  | { readonly kind: "owner"; readonly teamID: string; readonly areaID: string }

/**
 * How a switch of `sessionID` to `target` goes (06 §9.5, §10.1). The role comes from the registry (session metadata
 * only as a hint, never for a child, team/store.ts); the team's accounts from the root's preset binding
 * (`session.preset.get`). A team main whose binding has not loaded yet switches plainly, and the service's
 * `team_switch_required` brings it to 팀 계정 바꾸기 all the same.
 */
export function routeOf(runtime: ServerRuntime, sessionID: string, target: TargetRef): SwitchRoute {
  return switchRoute({
    place: runtime.team.placeOf(sessionID),
    team: runtime.own.state.sessionPreset[sessionID]?.binding?.team,
    target: accountOf(runtime, target.providerID),
    lookup: (accountID) => runtime.own.state.accounts[accountID],
  })
}

/** Pure core of {@link routeOf}. A replaced conversation (`지난 대화`) is no longer the team's: it switches plainly. */
export function switchRoute(input: {
  readonly place: Pick<SessionPlace, "teamID" | "role" | "areaID" | "previous"> | undefined
  readonly team: Pick<Preset.Team, "accounts"> | undefined
  readonly target: Preset.Member | undefined
  readonly lookup: Preset.Lookup
}): SwitchRoute {
  const place = input.place
  // An area peer (동료) keeps the model and account the user gives it: its switch is its own, never the team's.
  if (!place || place.previous || place.role === "peer") return { kind: "plain" }
  if (place.role === "owner")
    return place.areaID ? { kind: "owner", teamID: place.teamID, areaID: place.areaID } : { kind: "plain" }
  return input.team && input.target && outsideTeam(input.target, input.team, input.lookup)
    ? { kind: "team-account", teamID: place.teamID }
    : { kind: "plain" }
}

/** The team of a `team_switch_required{teamID}` answer (07 §5.5); `undefined` for any other error. */
export function teamSwitchRequired(error: unknown) {
  if (!(error instanceof OwnRpcError) || error.type !== "team_switch_required") return undefined
  const data = error.data
  if (typeof data !== "object" || data === null || !("teamID" in data) || typeof data.teamID !== "string")
    return undefined
  return data.teamID
}

/**
 * `프리셋: <지금> → <다음>(<묶음>)` for a main moving from `base` to `target` (07 §5.3, §7.3): the switcher's line under
 * the cost line and the cost dialog's. `undefined` while the provider group stays.
 */
export function presetLineFor(input: {
  readonly i18n: I18n
  readonly runtime: ServerRuntime
  /** This PC's `presets.list` groups: presets are global to its service (07 §8.1); a remote one mirrors them. */
  readonly groups: Readonly<Record<string, Preset.GroupView>>
  readonly base: TargetRef
  readonly target: TargetRef
  /** The root whose preset is in use. */
  readonly sessionID?: string
  /** An area without a conversation: the area's preset (06 §10.1). */
  readonly areaPreset?: string
  readonly team?: Preset.Team
}) {
  const runtime = input.runtime
  const to = accountOf(runtime, input.target.providerID)
  const from = Preset.groupOf(input.base.providerID, accountOf(runtime, input.base.providerID))
  const group = Preset.groupOf(input.target.providerID, to)
  if (!from || !group || from === group) return undefined
  // A remote server's session reads that server's list, its mirror of this PC's presets (07 §8.1 원격, T3); one that
  // does not mirror them yet keeps `평소대로`.
  const place = presetPlace(runtime.kind === "ssh" ? runtime.own.state.presetGroups : undefined, input.groups)
  const groups = place === "mirror" ? runtime.own.state.presetGroups : input.groups
  const builtin = place === "builtin"
  const view = groups[from]
  const current = builtin
    ? Preset.builtin(from)
    : input.areaPreset !== undefined
      ? (view?.presets?.find((preset) => preset.id === input.areaPreset) ?? Preset.builtin(from))
      : presetNow(from, input.sessionID ? runtime.own.state.sessionPreset[input.sessionID] : undefined, view)
  const move = presetMove({
    from,
    to: group,
    current,
    view: builtin ? undefined : groups[group],
    main: to?.id ?? null,
    lookup: (accountID) => runtime.own.state.accounts[accountID],
    team: input.team,
  })
  return move && presetMoveText(input.i18n, move)
}

// ---------------------------------------------------------------------------------------------------------------
// 팀 계정 바꾸기 (06 §10.1)

/** The plan a 팀 계정 바꾸기 dialog shows, for the session the switch started from. */
export interface TeamDialog {
  readonly teamID: string
  readonly target: TargetRef
  readonly plan: OwnTeam.AccountPlan
}

const teamDialogs = createRoot(() => {
  const [state, setState] = createStore<Record<string, TeamDialog | undefined>>({})
  return { state, set: (sessionID: string, dialog: TeamDialog | undefined) => setState(sessionID, dialog) }
})

/** The 팀 계정 바꾸기 plan the cost dialog of `sessionID` shows instead of the switch options, when it is for `target`. */
export function teamDialogOf(sessionID: string, target: TargetRef) {
  const dialog = teamDialogs.state[sessionID]
  return dialog && sameRef(dialog.target, target) ? dialog : undefined
}

export function closeTeamDialog(sessionID: string) {
  teamDialogs.set(sessionID, undefined)
}

/**
 * 팀 계정 바꾸기, step 1 (06 §10.1): plans the move with `team.account{dryRun}` and opens the cost dialog on the plan.
 * `false` when it could not be planned; a toast says why.
 */
export async function openTeamAccount(
  env: FlowEnv,
  input: {
    readonly sessionID: string
    readonly teamID: string
    readonly target: TargetRef
    readonly opener?: Element | null
  },
) {
  const target = { ...input.target }
  try {
    const output = await env.runtime.team.rpc.call("team.account", { teamID: input.teamID, target, dryRun: true })
    if (!("plan" in output)) return false
    teamDialogs.set(input.sessionID, { teamID: input.teamID, target, plan: output.plan })
    switcherControl.openDialog({
      serverKey: env.serverKey,
      sessionID: input.sessionID,
      target,
      estimate: output.plan.estimate ?? noEstimate(target),
      opener: input.opener,
    })
    return true
  } catch (error) {
    teamFailure(env, error)
    return false
  }
}

/**
 * [끝나면 바꾸기] / [멈추고 바꾸기], steps 2–5 (06 §10.1): starts the team's move. own.team reports its progress with
 * `account.waiting` and `account.moved` notices; `waiting` names the old account when the move waits for its work.
 */
export async function runTeamAccount(
  env: FlowEnv,
  input: {
    readonly teamID: string
    readonly target: TargetRef
    readonly mode: Switch.Children
    readonly waiting?: string
  },
) {
  try {
    await env.runtime.team.rpc.call("team.account", {
      teamID: input.teamID,
      target: { ...input.target },
      mode: input.mode,
    })
    switcherControl.remember(input.target)
    if (input.waiting)
      showToast({ message: textOf(env.i18n)("own.team.notice.accountWaiting", { account: input.waiting }) })
    return true
  } catch (error) {
    teamFailure(env, error)
    return false
  }
}

/** Names the 팀 계정 바꾸기 lines use, resolved by the caller. */
export interface PlanNames {
  /** The account the team moves to. */
  readonly to: string
  /** The team's current account. */
  readonly from: string
  readonly area: (areaID: string) => string
  readonly preset: (presetID: string) => string
  readonly account: (accountID: string) => string
  readonly role: (role: Preset.Role) => string
}

/**
 * The 팀 계정 바꾸기 dialog's lines (06 §10.1 step 1): `팀 전체(메인과 영역 3개)를 ChatGPT 02로 · ChatGPT 01에서 …
 * 일하는 중입니다`, the areas that continue in new conversations, and every preset target that breaks the team's R4 on
 * the new account (its roles then run on the main model).
 */
export function teamAccountLines(text: TeamText, plan: OwnTeam.AccountPlan, names: PlanNames) {
  const busy =
    plan.busy.sessions + plan.busy.children > 0
      ? text("own.team.account.busy", {
          current: names.from,
          sessions: plan.busy.sessions,
          children: plan.busy.children,
        })
      : text("own.team.account.idle", { current: names.from })
  const rotate = plan.areas.filter((area) => area.rotate).length
  return {
    move: `${text("own.team.account.move", { areas: plan.areas.length, account: names.to })} · ${busy}`,
    rotate: rotate > 0 ? text("own.team.account.rotate", { n: rotate }) : undefined,
    repairs: plan.r4.map((repair) =>
      text("own.team.notice.presetRepair", {
        preset: names.preset(repair.presetID),
        account: names.account(repair.accountID),
        area: repair.areaID ? names.area(repair.areaID) : text("own.team.main"),
        roles: repair.roles.map(names.role).join(", "),
      }),
    ),
    /** The move waits for work on the old account (`account.waiting`). */
    waits: plan.busy.sessions + plan.busy.children > 0,
  }
}

const ROLE: Readonly<Record<Preset.Role, PresetsKey>> = {
  explore: "own.preset.role.explore",
  general: "own.preset.role.general",
  "own-review": "own.preset.role.review",
  "own-quick": "own.preset.role.quick",
  "own-deep": "own.preset.role.deep",
}

const COMPANY: Readonly<Record<string, PresetsKey>> = {
  openai: "own.preset.company.openai",
  anthropic: "own.preset.company.anthropic",
}

/** A company as the hidden-accounts line names it: its subscription product (`ChatGPT`, `Claude`). */
export function companyName(i18n: I18n, company: string) {
  const key = COMPANY[company]
  return key ? presetsText(i18n.locale(), key) : company
}

/** A role's name (`리뷰`). */
export function roleName(i18n: I18n, role: Preset.Role) {
  return presetsText(i18n.locale(), ROLE[role])
}

/** A preset's name by id among every group's presets (`평소대로` in the current language); the id when unknown. */
export function presetName(i18n: I18n, groups: Readonly<Record<string, Preset.GroupView>>, presetID: string) {
  if (Preset.isBuiltin(presetID)) return presetsText(i18n.locale(), "own.preset.builtin")
  return (
    Object.values(groups)
      .flatMap((view) => view.presets ?? [])
      .find((preset) => preset.id === presetID)?.name ?? presetID
  )
}

/**
 * The cost dialog's state carries an estimate. A plan without one (own.accounts could not estimate the team main)
 * shows no cost, so this stands in: no options and no context to draw.
 */
function noEstimate(target: TargetRef): Estimate.Result {
  type Ref = Estimate.Result["target"]
  return {
    // SAFETY: branded ids of a stand-in that is never sent anywhere: a 팀 계정 바꾸기 dialog applies through
    // `team.account`, and the dialog reads the plan, not this estimate.
    estimateID: "est_none" as Estimate.Result["estimateID"],
    expiresAt: Date.now(),
    context: { P: 0, Z: 0, units: { source: "USD", target: "USD" } },
    target: {
      providerID: target.providerID as Ref["providerID"],
      id: target.id as Ref["id"],
      variant: target.variant as Ref["variant"],
      fits: true,
    },
    options: [],
    variantOnly: null,
    busyChildren: null,
    confidence: { steps: 0, recentError: null },
    inputs: { W_lo: 0, W_hi: 0, rates: {}, ttl: { lo: null, hi: null } },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Area main (06 §10.1 영역별로 바꾸기)

/**
 * `area.main` (06 §10.1): `model: null` = 팀과 같게. Without `now` an account change continues in a new conversation
 * at the next safe point (`later` says so in a toast); model or effort changes, and `now`, switch the owner now
 * through the own.accounts switch, whose `switch.recorded` the switcher announces.
 */
export async function applyAreaMain(
  env: FlowEnv,
  input: {
    readonly teamID: string
    readonly areaID: string
    readonly model: TargetRef | null
    readonly now?: boolean
    readonly later?: boolean
  },
) {
  try {
    await env.runtime.team.rpc.call("area.main", {
      teamID: input.teamID,
      areaID: input.areaID,
      model: input.model && { ...input.model },
      now: input.now,
    })
    if (input.model) switcherControl.remember(input.model)
    if (input.later) showToast({ message: textOf(env.i18n)("own.team.mainPicker.later") })
    return true
  } catch (error) {
    teamFailure(env, error)
    return false
  }
}

/** `openSwitcher({mode: "area", …})`: the switcher on an area main (06 §10.1 `메인 바꾸기…`). */
export interface AreaSwitcherRequest extends AreaTarget {
  readonly mode: "area"
}

const [areaSlot, setAreaSlot] = createRoot(() => createSignal<{ readonly target: AreaTarget; readonly seq?: number }>())

/**
 * Opens the "모델 @ 계정" switcher (03 §5.2). With `mode: "area"` it is the switcher on an area main (06 §10.1):
 * `팀과 같게` on top, the team's R4 filter, and `area.main` on apply; the popover runs against the area's owner
 * conversation on the area's server. Any other request opens the plain switcher.
 */
export function openSwitcher(request: SwitcherRequest | AreaSwitcherRequest = {}) {
  if (!("mode" in request)) return switcherControl.open(request)
  const target: AreaTarget = {
    serverKey: request.serverKey,
    teamID: request.teamID,
    areaID: request.areaID,
    anchor: request.anchor,
  }
  setAreaSlot({ target })
  // The control lays the request over the route it keeps: here the area's server, and no session of the route.
  const open: SwitcherRequest & { readonly serverKey: ServerKey; readonly sessionID: undefined } = {
    anchor: request.anchor,
    serverKey: request.serverKey,
    sessionID: undefined,
  }
  switcherControl.open(open)
  setAreaSlot({ target, seq: switcherControl.state.open?.seq })
}

/** The area an open of the switcher is for (its `seq`); `undefined` for a plain open. */
export function areaOf(seq: number) {
  const slot = areaSlot()
  return slot && (slot.seq === undefined || slot.seq === seq) ? slot.target : undefined
}

/**
 * The switcher as a picker: it chooses a "모델 @ 계정" and hands it back, nothing else.
 *
 * - With `teamID`, 영역 만들기 (06 §9.4, 2026-10-26): a model for a new area of that team, with the team's R4 filter and
 *   `팀과 같게` on top (`null`).
 * - Without it, a new conversation another screen starts on `serverKey` (04 §13.1 `AI에게 설치 맡기기`, MH): the
 *   accounts and models a new conversation there may use, the same rules as on that server's new-conversation screen
 *   (an SSH host's accounts only, its Claude verdict), the next new conversation's model preselected. Applying sets
 *   that server's new-conversation target as the new-conversation switcher does (a Claude account becomes the default
 *   one), then hands the choice back. Closing it hands nothing back.
 */
export interface PickRequest {
  readonly serverKey: ServerKey
  readonly teamID?: string
  /** The model picked before; absent = 팀과 같게 (a team's pick) or the next new conversation's (otherwise). */
  readonly current?: TargetRef
  readonly anchor?: HTMLElement | null
  /** A pick without a team: the title's suffix, the line under the lists and the apply button, in the caller's words. */
  readonly labels?: { readonly title: string; readonly hint: string; readonly apply: string }
  /** The choice: a model, or `null` for 팀과 같게. */
  readonly onPick: (ref: TargetRef | null) => void
}

const [pickSlot, setPickSlot] = createRoot(() =>
  createSignal<{ readonly request: PickRequest; readonly seq?: number }>(),
)

/**
 * Opens the switcher to pick a model for a new area (영역 만들기): the team's R4 filter and `팀과 같게` on top, as on an
 * area main; applying hands the choice to `onPick`. Answers the open's `seq` (the popover is open while
 * `switcherControl.state.open?.seq` is that).
 */
export function openSwitcherToPick(request: PickRequest) {
  setPickSlot({ request })
  const open: SwitcherRequest & { readonly serverKey: ServerKey; readonly sessionID: undefined } = {
    anchor: request.anchor,
    serverKey: request.serverKey,
    sessionID: undefined,
  }
  switcherControl.open(open)
  const seq = switcherControl.state.open?.seq
  setPickSlot({ request, seq })
  return seq
}

/** The pick an open of the switcher is for (its `seq`); `undefined` otherwise. */
export function pickOf(seq: number) {
  const slot = pickSlot()
  return slot && (slot.seq === undefined || slot.seq === seq) ? slot.request : undefined
}

// The switcher answers the team screens' `메인 바꾸기…` from the moment this chunk loads (the shell prefetches it when
// the page is idle); a request made earlier waits in the channel (team/intents.ts).
teamIntents.areaSwitcher.register((target) => openSwitcher({ ...target, mode: "area" }))

// ---------------------------------------------------------------------------------------------------------------

/** The own.team catalog in the current language, as team/model.ts takes it. */
export function textOf(i18n: I18n): TeamText {
  return (key, params) => teamText.text(i18n.locale(), key, params)
}

function teamFailure(env: FlowEnv, error: unknown) {
  console.error("[own-web] team switch", error)
  showToast({ message: errorText(textOf(env.i18n), error), tone: "danger" })
}

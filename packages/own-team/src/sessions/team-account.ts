export * as TeamAccount from "./team-account.js"

import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { type Account, OwnAccounts, OwnTeam, Preset, type Switch } from "@own/protocol"
import { AreaCreate } from "../ops/area-create.js"
import type { Steps } from "../ops/steps.js"
import { Wait } from "../ops/wait.js"
import { Services } from "../services.js"
import { Rotation } from "./rotate.js"
import { TeamContext } from "./team-context.js"
import { Journal } from "../ops/journal.js"

/**
 * 팀 계정 바꾸기 and following the team main (06 §10.1, §6.1 영역 계정 변경; 07 §5.5 팀 전체로 넓힘).
 *
 * `team.account` is one Op `team-account` (one op per team, so new main requests wait in the outbox while it runs,
 * 5.1). Each area that continues in a new conversation gets the rotation steps of `sessions/rotate.ts`
 * (`Rotation.steps`): `prepare` = its safe point and the handoff on the old account (a warm turn, or the program's
 * document for `stop`, an exhausted old account, or a team main that moved already), `replace` = the new owner on the
 * new account, the registry swap and the old conversation archived outside the team. Around them:
 *
 *   account-stop    `stop` only: the old account's runs in the team's trees and the moving owners' trees are
 *                   interrupted first (no resume: queued prompts stay parked)
 *   account-switch  nothing of the team works on another subscription of the target's company (the team main, the
 *                   owners and their subagents; `stop` interrupts what started again), then own.accounts
 *                   `switch.apply{team main, target, teamOp}` and the team context of every binding
 *   account-area    an area main the user chose on the old team account moves with it (model and effort stay)
 *   account-done    the team context of every binding, `account.moved`, and the 팀과 같게 owners follow the main's model
 *
 * When the old and the new account are two subscriptions of one company (`wait`), every `prepare` runs while the
 * whole team is still on the old account, then the switch, then every `replace`: the team never holds both (U5, TG15).
 * Otherwise (another company, or one ChatGPT login's `codex` and `siwc` accounts) nothing waits for the whole team:
 * the team main switches first and each area hands over and moves at its own safe point.
 *
 * Following (10.1 팀 메인을 바꾸면): a `session.model.selected` of the team main that keeps its account is followed by
 * every 팀과 같게 owner at its next safe point (a 02 switch in that conversation); one that changes the account outside
 * this op (TUI `switchModel`, a plain switch to another company or to the same login's sibling) starts the op with the
 * team main already moved, and its owners then hand over with the program's document (no new turn on the old account).
 */

export const KIND = {
  stop: "account-stop",
  switch: "account-switch",
  area: "account-area",
  done: "account-done",
} as const

/** Switch states with no switch pending (RH-20): the main is where it will stay. */
const SETTLED: ReadonlySet<Switch.State["state"]> = new Set(["STEADY", "COOLDOWN"])

const decodeStop = Schema.decodeUnknownSync(
  Schema.Struct({ target: Model.Ref, wait: Schema.Boolean, owners: Schema.Array(SessionID) }),
)
const decodeSwitch = Schema.decodeUnknownSync(
  Schema.Struct({ target: Model.Ref, wait: Schema.Boolean, stop: Schema.Boolean, from: Schema.String }),
)
const decodeArea = Schema.decodeUnknownSync(Schema.Struct({ areaID: OwnTeam.AreaID, model: Model.Ref }))
const decodeDone = Schema.decodeUnknownSync(Schema.Struct({ target: Model.Ref, rotated: NonNegativeInt }))
const decodeRef = Schema.decodeUnknownOption(Model.Ref)
const decodeSelected = Schema.decodeUnknownOption(
  Schema.Struct({ sessionID: Schema.String, model: Schema.Unknown, previous: Schema.optional(Schema.Unknown) }),
)

/** Events after which a session may have stopped or switched. */
const WAKES: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.model.selected",
  `rpc.${OwnAccounts.ID}.switch.state`,
])

/** Every own.team switch is the user's choice (02 §5.2 `manual`): a switch reason, not a rotation reason. */
const MANUAL: Switch.Reason = "manual"

/** A wait checks again after this long without an event (one from another process, a dropped stream). */
export const RECHECK_MS = 60_000

/**
 * RH-20: how long the team main's switch may take once own.accounts accepted it; after that (or once own.accounts
 * reports it failed, blocked or dropped) the move fails: the handoff documents are written, no owner has moved.
 */
export const SWITCH_MS = 15 * 60_000

/** RH-20: an account change of the team main that waits for another op is told after this long. */
export const FOLLOW_TOLD_MS = 5 * 60_000

const NOT_MOVED = "팀 메인을 새 계정으로 옮기지 못했어요"

export interface Input {
  readonly teamID: OwnTeam.TeamID
  readonly target: Model.Ref
  readonly mode?: "after-idle" | "stop"
  readonly dryRun?: boolean
}

export interface Api {
  /** `team.account`: the plan with `dryRun`, else the `team-account` op. */
  account(
    input: Input,
  ): Promise<Services.Result<{ readonly plan: OwnTeam.AccountPlan } | { readonly opID: OwnTeam.OpID }>>
  /** Pending follows go again; a missed account change of the team main starts the op. */
  resume(): Promise<void>
  close(): Promise<void>
}

/**
 * `account.waiting` (06 §2.7), told once per op: the move waits for the old account's work. It stays open
 * (`Notices.keep`) until the move is done, so a window opened meanwhile shows it too. RH-20: the kept notice also says
 * since when (`since`) and how many runs are still on the old account (`runs`), updated when that changes; the op's
 * card offers 취소 (`op.cancel`).
 */
type Waiting = (input: {
  readonly teamID: OwnTeam.TeamID
  readonly opID: string
  readonly from: string
  readonly since?: number
  readonly runs?: number
}) => void

export function create(services: Services.Context): Api {
  const waited = new Map<string, string>()
  const waiting: Waiting = (input) => {
    const notice = {
      teamID: input.teamID,
      kind: "account.waiting" as const,
      text:
        input.runs === undefined
          ? `팀 계정 바꾸기: ${input.from}에서 하던 일이 끝나기를 기다려요`
          : `팀 계정 바꾸기: ${input.from}에서 하던 일 ${input.runs}개가 끝나기를 기다려요`,
      data: {
        account: input.from,
        opID: input.opID,
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.runs === undefined ? {} : { runs: input.runs }),
      },
    }
    const key = JSON.stringify(notice.data)
    if (waited.get(input.opID) === key) return
    if (!waited.has(input.opID)) services.notices.publish(notice)
    waited.set(input.opID, key)
    void services.notices
      .keep(input.teamID, "account.waiting", [
        { id: waitingID(input.opID), at: input.since ?? services.clock.now(), ...notice },
      ])
      .catch((error: unknown) => services.log.warn("account_waiting_keep_failed", { teamID: input.teamID, error }))
  }
  const follower = following(services, (input) => begin(services, waiting, input))
  for (const kind of kinds(waiting, follower.main)) services.steps.register(kind)
  return {
    account: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
      if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
      const active = await services.journal.active(team.id)
      if (active) return busy(active)
      const id = OwnTeam.OpID.create()
      const built = await build(services, {
        team,
        target: input.target,
        mode: input.mode ?? "after-idle",
        opID: id,
        estimate: input.dryRun === true,
      })
      if (!built.ok) return built
      if (input.dryRun) return { ok: true, plan: built.plan }
      return start(services, waiting, { teamID: team.id, id, built, by: "user" })
    },
    resume: () => follower.resume(),
    close: async () => follower.close(),
  }
}

/** Why own.accounts stopped a switch (02 §5.4 `BLOCKED`, `FAILED`), in screen words. */
const STOPPED = {
  BLOCKED: "새 계정의 한도가 다 찼거나 인증이 필요해 전환하지 않았어요",
  FAILED: "계정 전환이 실패했어요",
} as const

/**
 * A 02 switch of a session now (06 §10.1: an area main's model or effort, `area.main{now:true}`, following the team
 * main): `switch.estimate`, then `switch.apply{strategy:"now"}`, which own.accounts runs at the session's idle point.
 */
export async function switchNow(
  services: Services.Context,
  input: { readonly sessionID: string; readonly directory: string; readonly target: Model.Ref },
): Promise<Services.Result> {
  const where = { directory: input.directory }
  const estimate = await services.accounts.switchEstimate(
    { sessionID: input.sessionID, target: input.target, reason: MANUAL },
    where,
  )
  if (!estimate.ok) return Services.failure("internal_error", `계정 전환을 계획하지 못했어요: ${estimate.message}`, {})
  const applied = await services.accounts.switchApply(
    {
      sessionID: input.sessionID,
      estimateID: estimate.value.estimateID,
      target: input.target,
      strategy: "now",
      reason: MANUAL,
    },
    where,
  )
  if (!applied.ok) return Services.failure("internal_error", `계정 전환을 거절당했어요: ${applied.message}`, {})
  if (applied.value.state === "BLOCKED" || applied.value.state === "FAILED")
    return Services.failure("internal_error", STOPPED[applied.value.state], {})
  return { ok: true }
}

/**
 * Whether two Refs name the same model and effort. Core reads a session made without a variant back as variant
 * `default` (no effort chosen), so that and no variant are one effort.
 */
export function sameRef(a: Model.Ref, b: Model.Ref) {
  return a.providerID === b.providerID && a.id === b.id && effort(a.variant) === effort(b.variant)
}

function effort(variant: string | undefined) {
  return variant === undefined || variant === "default" ? null : variant
}

// ---------------------------------------------------------------------------------------------------------------
// Plan

interface Built {
  readonly ok: true
  readonly plan: OwnTeam.AccountPlan
  readonly steps: ReadonlyArray<Steps.Spec>
  /** The move waits for work on the old account (`account.waiting`), whose label is `from`. */
  readonly waits: boolean
  readonly from: string
}

/**
 * 10.1 step 1. `from`: the team's account before (the TUI path's previous Ref; default the team main's Ref now). The
 * areas that move are the 팀과 같게 ones and those whose own main is the old team account (when the team stays with
 * that company: their model and effort stay, the account follows). A non-moving area main that clashes with the target
 * refuses the move (`same_company_subscription`); preset targets that newly break R4 are the plan's `r4` lines.
 */
async function build(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly target: Model.Ref
    readonly mode: "after-idle" | "stop"
    readonly opID: OwnTeam.OpID
    readonly estimate: boolean
    readonly from?: Model.Ref
  },
): Promise<Built | Services.Failure> {
  const team = input.team
  const snapshot = await TeamContext.load(services, team.id)
  if (!snapshot) return Services.failure("internal_error", "own.accounts could not be read", {})
  const now = snapshot.state.holders[0]?.ref
  const from = input.from ?? now
  if (!from || !now) return Services.failure("internal_error", "팀 메인의 모델을 알 수 없어요", {})
  const target = input.target
  const old = snapshot.account(from.providerID)
  const to = snapshot.account(target.providerID)
  const wait = TeamContext.rival(old, to)
  const company = old !== undefined && to !== undefined && Preset.company(old) === Preset.company(to)
  const moves = new Map(
    snapshot.areas.flatMap((area): Array<[OwnTeam.AreaID, Model.Ref]> => {
      if (area.state !== "active") return []
      if (!area.main) return [[area.id, target]]
      const chosen = snapshot.account(area.main.model.providerID)
      return company && old && chosen && TeamContext.sameSubscription(chosen, old)
        ? [[area.id, { ...area.main.model, providerID: target.providerID }]]
        : []
    }),
  )
  // The team main and every 팀과 같게 area are on `from` before and on `target` after.
  const follows = (areaID: OwnTeam.AreaID | undefined) =>
    areaID === undefined || !snapshot.areas.find((area) => area.id === areaID)?.main
  const before = state(snapshot, (areaID) => (follows(areaID) ? from : undefined))
  const after = state(snapshot, (areaID) => (areaID === undefined || follows(areaID) ? target : moves.get(areaID)))
  const known = new Set(TeamContext.offenders(before))
  const fresh = TeamContext.offenders(after).filter((accountID) => !known.has(accountID))
  const clash = fresh.find((accountID) => after.holders.slice(1).some((holder) => holder.account?.id === accountID))
  if (clash)
    return Services.failure("same_company_subscription", "an area main would share the company of the new account", {
      accountID: clash,
    })

  const home = { directory: team.home.directory }
  const [active, owners, switchState, estimate] = await Promise.all([
    running(services, team.home.directory),
    Promise.all(
      snapshot.areas.map(async (area) => {
        const owner = area.owner.sessionID
        // An adopted conversation that never got the team is judged at its first main request (3.7), not moved here.
        if (owner === null || !area.owner.attached || !moves.has(area.id)) return undefined
        const got = await services.http.session.get({ sessionID: owner, directory: area.directory })
        return { area, owner, ref: got.ok ? got.value.model : undefined }
      }),
    ),
    services.accounts.switchState({ sessionID: team.main.sessionID }, home),
    input.estimate && !sameRef(now, target)
      ? services.accounts.switchEstimate(
          { sessionID: team.main.sessionID, target, reason: MANUAL, teamOp: input.opID },
          home,
        )
      : Promise.resolve(undefined),
  ])
  const roots = new Set([team.main.sessionID, ...snapshot.areas.flatMap((area) => present(area.owner.sessionID))])
  const blocking = wait && active ? holding(active, roots, to, snapshot.account) : []
  const blocked = old?.status === "exhausted" || (switchState.ok && switchState.value.state === "BLOCKED")
  // The TUI path: the team main is on the new account already, so the old one runs no new turn (10.1 경로).
  const ahead = now.providerID === target.providerID && from.providerID !== target.providerID
  const stop = input.mode === "stop"
  const rotating = owners.flatMap((item) =>
    item && (item.ref === undefined || item.ref.providerID !== moves.get(item.area.id)?.providerID) ? [item] : [],
  )
  const busyOwner = (owner: string | null) => owner !== null && (active ?? []).some((item) => item.root === owner)
  const plan: OwnTeam.AccountPlan = {
    areas: [...moves.keys()].map((areaID) => ({
      areaID,
      rotate: rotating.some((item) => item.area.id === areaID),
      busy: busyOwner(snapshot.areas.find((area) => area.id === areaID)?.owner.sessionID ?? null),
    })),
    busy: {
      sessions: blocking.filter((item) => !item.child).length,
      children: blocking.filter((item) => item.child).length,
    },
    estimate: estimate?.ok ? estimate.value : null,
    r4: TeamContext.repairsOf(after, fresh),
  }
  const parts = rotating.map((item) =>
    Rotation.steps({
      areaID: item.area.id,
      from: item.owner,
      directory: item.area.directory,
      reason: "team-account",
      handoff: stop || blocked || (wait && ahead) ? "program" : "warm",
      by: "user",
    }),
  )
  // The waiting notice names the account the team works on (its main's Claude account, not the first one, SL-8).
  const label = (await mainAccount(services, team, from.providerID))?.label ?? old?.label ?? from.providerID
  const stopping = stop ? [{ kind: KIND.stop, args: { target, wait, owners: rotating.map((item) => item.owner) } }] : []
  const mains = snapshot.areas.flatMap((area) => {
    const model = moves.get(area.id)
    return area.main && model ? [{ kind: KIND.area, args: { areaID: area.id, model } }] : []
  })
  const switching = { kind: KIND.switch, args: { target, wait, stop, from: label } }
  const done = { kind: KIND.done, args: { target, rotated: rotating.length } }
  const steps: ReadonlyArray<Steps.Spec> = wait
    ? [
        ...stopping,
        ...parts.flatMap((part) => part.prepare),
        switching,
        ...mains,
        ...parts.flatMap((part) => part.replace),
        done,
      ]
    : [...stopping, switching, ...mains, ...parts.flatMap((part) => [...part.prepare, ...part.replace]), done]
  const waits = blocking.length > 0 || rotating.some((item) => busyOwner(item.owner))
  return { ok: true, plan, steps, waits: !stop && !blocked && waits, from: label }
}

/** S with the team main's Ref (`areaID` undefined) and area Refs replaced where `ref` answers one. */
function state(
  snapshot: TeamContext.Snapshot,
  ref: (areaID: OwnTeam.AreaID | undefined) => Model.Ref | undefined,
): TeamContext.State {
  return {
    ...snapshot.state,
    holders: snapshot.state.holders.map((holder) => {
      const next = ref(holder.areaID)
      return next ? { ...holder, ref: next, account: snapshot.account(next.providerID) } : holder
    }),
  }
}

async function start(
  services: Services.Context,
  waiting: Waiting,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly id: OwnTeam.OpID
    readonly built: Built
    readonly by: OwnTeam.Op["by"]
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const started = await services.runner.start({
    teamID: input.teamID,
    kind: "team-account",
    by: input.by,
    id: input.id,
    steps: input.built.steps,
    undo: { available: false },
  })
  if (!started.ok) return busy(started.op)
  if (input.built.waits) waiting({ teamID: input.teamID, opID: started.op.id, from: input.built.from })
  // Each binding keeps its session's own account while the team moves (the TUI path's main is ahead already).
  void services
    .features()
    .teamContext.push(input.teamID)
    .catch((error: unknown) => services.log.warn("team_account_push_failed", { teamID: input.teamID, error }))
  return { ok: true, opID: started.op.id }
}

/**
 * Starts the op for an account change the team main made outside `team.account` (TUI, plain switch). `false` when
 * another op holds the team: the caller keeps the change and tries again when that op ends (RH-20).
 */
async function begin(
  services: Services.Context,
  waiting: Waiting,
  input: { readonly teamID: OwnTeam.TeamID; readonly target: Model.Ref; readonly from: Model.Ref },
) {
  const team = await services.registry.teams.get(input.teamID)
  if (!team || team.state !== "on") return true
  const id = OwnTeam.OpID.create()
  const built = await build(services, {
    team,
    target: input.target,
    mode: "after-idle",
    opID: id,
    estimate: false,
    from: input.from,
  })
  if (!built.ok) {
    services.log.warn("team_account_follow_refused", { teamID: team.id, error: built.error })
    return true
  }
  const started = await start(services, waiting, { teamID: team.id, id, built, by: "user" })
  if (started.ok) return true
  services.log.info("team_account_follow_busy", { teamID: team.id })
  return false
}

function busy(op: OwnTeam.Op) {
  return Services.failure("busy", "another team operation is running", Journal.busy(op))
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions that work now

interface Active {
  readonly sessionID: string
  /** The root of its tree (itself for a root). */
  readonly root: string
  readonly child: boolean
  /** Its main's provider; `undefined` when the session has no model. */
  readonly providerID: string | undefined
}

/** The running sessions (`session.active`) with their tree roots; `undefined` when the service cannot tell. */
async function running(services: Services.Context, directory: string): Promise<ReadonlyArray<Active> | undefined> {
  const ids = await services.http.session.active()
  if (!ids.ok) return undefined
  /** `null`: the session is gone; `undefined`: the service could not tell. */
  const read = async (sessionID: string) => {
    const got = await services.http.session.get({ sessionID, directory })
    if (got.ok) return got.value
    return got.status === 404 ? null : undefined
  }
  const cache = new Map<string, ReturnType<typeof read>>()
  const get = (sessionID: string) => {
    const known = cache.get(sessionID)
    if (known) return known
    const next = read(sessionID)
    cache.set(sessionID, next)
    return next
  }
  const rootOf = async (sessionID: string, depth: number): Promise<string | undefined> => {
    const view = await get(sessionID)
    if (view === undefined) return undefined
    if (view === null || view.parentID === undefined || depth >= 16) return sessionID
    return rootOf(view.parentID, depth + 1)
  }
  const found = await Promise.all(
    [...ids.value].map(async (sessionID): Promise<Active | null | undefined> => {
      const view = await get(sessionID)
      if (view === null) return null
      const root = await rootOf(sessionID, 0)
      if (view === undefined || root === undefined) return undefined
      return { sessionID, root, child: root !== sessionID, providerID: view.model?.providerID }
    }),
  )
  if (found.includes(undefined)) return undefined
  return found.filter((item): item is Active => item !== null && item !== undefined)
}

/**
 * The sessions of the team's trees (`roots`) that work on another subscription of the target's company: the old
 * account's team main, owners and subagents (07 §5.5). A session without a model counts (fail closed).
 */
function holding(
  active: ReadonlyArray<Active>,
  roots: ReadonlySet<string>,
  to: Account.View | undefined,
  account: (providerID: string) => Account.View | undefined,
) {
  return active.filter(
    (item) =>
      roots.has(item.root) && (item.providerID === undefined || TeamContext.rival(account(item.providerID), to)),
  )
}

/** Interrupts each session (no resume: queued prompts stay parked, 06 §10.1 `stop`). */
async function interrupt(services: Services.Context, sessions: ReadonlyArray<Active>, directory: string) {
  await Promise.all(
    sessions.map(async (item) => {
      const stopped = await services.http.session.interrupt({ sessionID: item.sessionID, directory })
      if (!stopped.ok) services.log.warn("team_account_interrupt_failed", { sessionID: item.sessionID })
    }),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

function kinds(
  waiting: Waiting,
  follow: (teamID: OwnTeam.TeamID, target: Model.Ref) => void,
): ReadonlyArray<Steps.Kind> {
  return [stopKind(), switchKind(waiting), areaKind(), doneKind(follow)]
}

/**
 * The team main's account of `providerID` as `accounts.list` shows it. `anthropic`: the Claude account the team is
 * bound to (several Claude accounts share the provider, so it alone names only the first, SL-8), read whatever the main
 * runs now: on the TUI path it already runs on the new company's account (SL-17). Any other provider: the main's
 * binding, else the provider's one account. `undefined` when none is known, so the caller names the old account.
 */
async function mainAccount(services: Services.Context, team: OwnTeam.Team, providerID: string) {
  const where = { directory: team.home.directory }
  const sessionID = team.main.sessionID
  const [listed, accountID] = await Promise.all([
    services.accounts.accountsList(),
    providerID === Provider.ID.anthropic
      ? services.accounts
          .claudeSession({ sessionID }, where)
          .then((tree) => (tree.ok ? tree.value.accountID : undefined))
      : services.accounts
          .sessionBinding({ sessionIDs: [sessionID] }, where)
          .then((bound) =>
            bound.ok ? bound.value.bindings.find((item) => item.sessionID === sessionID)?.accountID : undefined,
          ),
  ])
  const accounts = listed.ok ? listed.value.accounts : []
  const named = accounts.find((item) => item.id === accountID && item.providerID === providerID)
  if (named || providerID === Provider.ID.anthropic) return named
  return accounts.find((item) => item.providerID === providerID)
}

async function teamOf(services: Services.Context, teamID: string) {
  const team = await services.registry.teams.get(teamID)
  if (!team) throw new Error(`팀 기록이 없어요: ${teamID}`)
  return team
}

/**
 * The team's runs on another subscription of `target`'s company (`wait`), and every run in the moving owners' trees.
 * `undefined` when the service cannot tell.
 */
async function working(
  services: Services.Context,
  team: OwnTeam.Team,
  input: { readonly target: Model.Ref; readonly wait: boolean; readonly owners: ReadonlyArray<string> },
) {
  const [active, areas, listed] = await Promise.all([
    running(services, team.home.directory),
    services.registry.areas.list(team.id),
    services.accounts.accountsList(),
  ])
  if (!active) return undefined
  const accounts = listed.ok ? listed.value.accounts : []
  const account = (providerID: string) => accounts.find((item) => item.providerID === providerID)
  const roots = new Set([team.main.sessionID, ...areas.flatMap((area) => present(area.owner.sessionID))])
  const old = input.wait ? holding(active, roots, account(input.target.providerID), account) : []
  const moving = active.filter((item) => input.owners.includes(item.root))
  return [...new Map([...old, ...moving].map((item) => [item.sessionID, item])).values()]
}

/** `멈추고 바꾸기` (10.1 step 3): the old account's runs and the moving owners' runs stop before anything moves. */
function stopKind(): Steps.Kind {
  return {
    kind: KIND.stop,
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const services = input.services
      const team = await teamOf(services, input.op.teamID)
      await interrupt(services, (await working(services, team, decodeStop(input.step.args))) ?? [], team.home.directory)
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

function switchKind(waiting: Waiting): Steps.Kind {
  const onTarget = async (services: Services.Context, team: OwnTeam.Team, target: Model.Ref) => {
    const main = await services.http.session.get({ sessionID: team.main.sessionID, directory: team.home.directory })
    return main.ok && main.value.model !== undefined && sameRef(main.value.model, target)
  }
  return {
    kind: KIND.switch,
    observe: async (input) => {
      const args = decodeSwitch(input.step.args)
      const team = await teamOf(input.services, input.op.teamID)
      return (await onTarget(input.services, team, args.target)) ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (input) => {
      const services = input.services
      const args = decodeSwitch(input.step.args)
      const team = await teamOf(services, input.op.teamID)
      if (args.wait) {
        const holds = () => working(services, team, { target: args.target, wait: true, owners: [] })
        // A run that started again on the old account since `account-stop` stops too.
        if (args.stop) await interrupt(services, (await holds()) ?? [], team.home.directory)
        // RH-20: the card and `team_status` say how many runs are left and since when; 취소 ends the move here.
        const idle = await Wait.until<true>(input, {
          why: "account",
          text: `${args.from}에서 하던 일이 끝나기를 기다려요`,
          wakes: (event) => WAKES.has(event.type),
          recheckMs: RECHECK_MS,
          stalled: false,
          check: async (report, since) => {
            const runs = await holds()
            if (runs?.length === 0) return true
            const text =
              runs === undefined
                ? `${args.from}에서 하던 일을 읽지 못해 기다려요`
                : `${args.from}에서 하던 일 ${runs.length}개가 끝나기를 기다려요`
            report({
              detail: "old-account",
              text,
              ...(runs === undefined || runs.length === 0
                ? {}
                : {
                    sessionIDs: runs.flatMap((run) =>
                      run.sessionID.startsWith("ses") ? [SessionID.make(run.sessionID)] : [],
                    ),
                  }),
            })
            waiting({
              teamID: team.id,
              opID: input.op.id,
              from: args.from,
              since,
              ...(runs === undefined ? {} : { runs: runs.length }),
            })
            return undefined
          },
        })
        if (idle === undefined) return { ok: false, note: input.cancelled() ? "취소했어요" : "기다리기를 멈췄어요" }
      }
      const applied = await services.accounts.switchApply(
        {
          sessionID: team.main.sessionID,
          target: args.target,
          strategy: "now",
          reason: MANUAL,
          teamOp: input.op.id,
          children: args.stop ? "stop" : "after-idle",
        },
        { directory: team.home.directory },
      )
      if (!applied.ok) return { ok: false, note: `팀 메인을 옮기지 못했어요: ${applied.message}` }
      if (applied.value.state === "BLOCKED" || applied.value.state === "FAILED")
        return { ok: false, note: `팀 메인을 옮기지 못했어요: ${STOPPED[applied.value.state]}` }
      // RH-20: a switch that later fails, is dropped or is superseded (the user picked another model on the main) ends
      // the wait; so does SWITCH_MS. The handoff documents are written and no owner has moved, so nothing is lost.
      const moved = await Wait.until<Steps.Outcome>(input, {
        why: "account-switch",
        text: "팀 메인이 새 계정으로 옮기기를 기다려요",
        wakes: (event) => WAKES.has(event.type),
        recheckMs: RECHECK_MS,
        check: async (report) => {
          // RH-33: the switch state before the model. own.accounts moves the main's model first and settles only
          // after core's `session.model.selected`, so a settled state read first means the model read after it shows
          // where the switch landed; the other order could read the old model, then the settled state, and fail a
          // move that landed.
          const state = await services.accounts.switchState(
            { sessionID: team.main.sessionID },
            { directory: team.home.directory },
          )
          if (await onTarget(services, team, args.target)) return { ok: true }
          if (state.ok && (state.value.state === "BLOCKED" || state.value.state === "FAILED"))
            return { ok: false, note: `${NOT_MOVED}: ${STOPPED[state.value.state]}` }
          if (state.ok && SETTLED.has(state.value.state))
            return { ok: false, note: `${NOT_MOVED}: 전환이 다른 모델로 끝났거나 취소됐어요` }
          report({ detail: state.ok ? state.value.state : "unknown", text: "팀 메인이 새 계정으로 옮기기를 기다려요" })
          return undefined
        },
        deadline: {
          ms: SWITCH_MS,
          answer: async () => {
            // RH-33: a switch the op gave up on is not left to land later without its owners.
            await cancelSwitch(services, team)
            return { ok: false, note: `${NOT_MOVED}: 전환이 끝나지 않았어요` }
          },
        },
      })
      if (moved === undefined) {
        if (!input.cancelled()) return { ok: false, note: "기다리기를 멈췄어요" }
        // RH-33: 취소 after the switch was applied drops it in own.accounts too. A controller that closes leaves it: the
        // op resumes and looks again.
        await cancelSwitch(services, team)
        return { ok: false, note: "취소했어요" }
      }
      if (!moved.ok) return moved
      // The team main is on the new account: every binding now names it (each session keeps its own until it moves).
      await services.features().teamContext.push(team.id)
      return { ok: true }
    },
    verify: async (input) => {
      const args = decodeSwitch(input.step.args)
      const team = await teamOf(input.services, input.op.teamID)
      return (await onTarget(input.services, team, args.target))
        ? { ok: true }
        : { ok: false, note: "팀 메인이 새 계정에 있지 않아요" }
    },
  }
}

/**
 * Drops the team main's pending switch (own.accounts `switch.cancel`), so a move that ended without it does not land
 * later with no owner moved. One already `SWITCHING` lands anyway; {@link following} then moves the owners.
 */
async function cancelSwitch(services: Services.Context, team: OwnTeam.Team) {
  const cancelled = await services.accounts.switchCancel(
    { sessionID: team.main.sessionID },
    { directory: team.home.directory },
  )
  if (!cancelled.ok) services.log.warn("team_account_switch_cancel_failed", { teamID: team.id, type: cancelled.type })
}

function areaKind(): Steps.Kind {
  return {
    kind: KIND.area,
    observe: async (input) => {
      const args = decodeArea(input.step.args)
      const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
      if (!area?.main) return { state: "skip", note: "영역 모델이 팀과 같아요" }
      return sameRef(area.main.model, args.model) ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (input) => {
      const services = input.services
      const args = decodeArea(input.step.args)
      await services.write(input.op.teamID, async () => {
        const area = await services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area?.main) return
        await AreaCreate.save(services, { ...area, main: { model: args.model, chosenBy: area.main.chosenBy } })
      })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

function doneKind(follow: (teamID: OwnTeam.TeamID, target: Model.Ref) => void): Steps.Kind {
  return {
    kind: KIND.done,
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const services = input.services
      const args = decodeDone(input.step.args)
      const teamID = input.op.teamID
      await services.features().teamContext.push(teamID)
      const account = await mainAccount(services, await teamOf(services, teamID), args.target.providerID)
      const label = account?.label ?? args.target.providerID
      services.notices.publish({
        teamID,
        kind: "account.moved",
        text: `팀이 ${label} 계정으로 옮겼어요 · 영역 ${args.rotated}개 새 대화`,
        data: { account: label, n: args.rotated },
      })
      await services.notices.keep(teamID, "account.waiting", [])
      input.summary({
        kind: "account",
        model: args.target,
        areas: args.rotated,
        ...(account ? { accountID: account.id } : {}),
      })
      follow(teamID, args.target)
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Following the team main

interface Follow {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly target: Model.Ref
}

/**
 * 10.1 팀 메인을 바꾸면: a model or effort change of the team main is followed by each 팀과 같게 owner at its next safe
 * point; an account change outside the op starts it. Both wait while another op runs (retried on `op.done`).
 */
function following(
  services: Services.Context,
  begin: (input: {
    readonly teamID: OwnTeam.TeamID
    readonly target: Model.Ref
    readonly from: Model.Ref
  }) => Promise<boolean>,
) {
  const pending = new Map<string, Follow>()
  const trying = new Set<string>()
  /** Account changes seen while another op ran, per team (RH-20: also one whose start met another op). */
  const starts = new Map<string, { readonly target: Model.Ref; readonly from: Model.Ref; readonly at: number }>()
  /** RH-33: account changes of the team main seen while a team account op ran, by that op's id. */
  const covered = new Map<string, { readonly target: Model.Ref; readonly from: Model.Ref }>()
  /** The team main is on `target` now (the change a covering op did not finish still stands). */
  const landed = async (teamID: OwnTeam.TeamID, target: Model.Ref) => {
    const team = await services.registry.teams.get(teamID)
    if (team?.state !== "on") return false
    const main = await services.http.session.get({ sessionID: team.main.sessionID, directory: team.home.directory })
    return main.ok && main.value.model !== undefined && sameRef(main.value.model, target)
  }
  const told = new Map<string, () => void>()
  /** Keeps an account change for the end of the op that holds the team, and tells the user if that takes long. */
  const later = (teamID: OwnTeam.TeamID, change: { readonly target: Model.Ref; readonly from: Model.Ref }) => {
    starts.set(teamID, { ...change, at: starts.get(teamID)?.at ?? services.clock.now() })
    if (told.has(teamID)) return
    told.set(
      teamID,
      services.clock.schedule(FOLLOW_TOLD_MS, () => {
        told.delete(teamID)
        if (!starts.has(teamID)) return
        services.notices.publish({
          teamID,
          kind: "account.waiting",
          text: "팀 메인의 계정이 바뀌었어요. 다른 팀 작업이 끝나면 영역들이 따라 옮겨요",
          data: { account: change.target.providerID, follow: true },
        })
      }),
    )
  }
  const started = (teamID: OwnTeam.TeamID, change: { readonly target: Model.Ref; readonly from: Model.Ref }) =>
    begin({ teamID, ...change }).then((ok) => {
      if (!ok) return later(teamID, change)
      starts.delete(teamID)
      told.get(teamID)?.()
      told.delete(teamID)
    })

  const main = (teamID: OwnTeam.TeamID, target: Model.Ref) => {
    void (async () => {
      const areas = await services.registry.areas.list(teamID)
      for (const area of areas.filter((item) => item.state === "active" && !item.main))
        pending.set(`${teamID}:${area.id}`, { teamID, areaID: area.id, target })
      await attempt()
    })().catch((error: unknown) => services.log.warn("team_follow_failed", { teamID, error }))
  }

  const one = async (key: string, entry: Follow) => {
    const [team, area, op] = await Promise.all([
      services.registry.teams.get(entry.teamID),
      services.registry.areas.get(entry.teamID, entry.areaID),
      services.journal.active(entry.teamID),
    ])
    const owner = area?.owner.sessionID ?? null
    const drop = () => {
      if (pending.get(key) === entry) pending.delete(key)
    }
    if (team?.state !== "on" || !area || area.state !== "active" || area.main || owner === null) return drop()
    if (op) return
    const current = await services.http.session.get({ sessionID: owner, directory: area.directory })
    if (!current.ok) return
    const ref = current.value.model
    // Another account is the team account op's (rotation), not a follow; the same Ref is done.
    if (!ref || ref.providerID !== entry.target.providerID || sameRef(ref, entry.target)) return drop()
    const safe = await services.features().safePoint.check({ teamID: entry.teamID, areaID: entry.areaID })
    if (!safe.ok) return
    drop()
    const switched = await switchNow(services, { sessionID: owner, directory: area.directory, target: entry.target })
    if (!switched.ok)
      services.log.warn("team_follow_switch_failed", { areaID: entry.areaID, message: switched.message })
  }

  const attempt = async () => {
    await Promise.all(
      [...pending].map(([key, entry]) => {
        if (trying.has(key)) return Promise.resolve()
        trying.add(key)
        return one(key, entry)
          .catch((error: unknown) => services.log.warn("team_follow_failed", { areaID: entry.areaID, error }))
          .finally(() => trying.delete(key))
      }),
    )
  }

  const selected = async (data: unknown) => {
    const decoded = Option.getOrUndefined(decodeSelected(data))
    if (!decoded) return
    const found = await services.locate.session(decoded.sessionID)
    if (found?.role !== "main" || found.team.state !== "on") return
    const model = Option.getOrUndefined(decodeRef(decoded.model))
    const previous = decoded.previous === undefined ? undefined : Option.getOrUndefined(decodeRef(decoded.previous))
    if (!model) return
    const teamID = found.team.id
    const op = await services.journal.active(teamID)
    // The op's own switch, or a change the running team account op already covers. RH-33: kept until that op ends;
    // an op that does not end `done` (it failed after the switch landed, or was cancelled or gave up while own.accounts
    // was already switching) has not moved the owners, so the change is followed then.
    if (op?.kind === "team-account") {
      if (!previous || previous.providerID === model.providerID) return
      const change = { target: model, from: previous }
      covered.set(op.id, change)
      // RH-44: `op.done` may have come between the read above and the set; then nobody else takes the change.
      const now = await services.journal.find(op.id)
      if ((now && Journal.ACTIVE.has(now.state)) || covered.get(op.id) !== change) return
      covered.delete(op.id)
      if (now?.state !== "done" && (await landed(teamID, model))) await started(teamID, change)
      return
    }
    if (!previous || previous.providerID === model.providerID) return main(teamID, model)
    if (!op) return started(teamID, { target: model, from: previous })
    later(teamID, { target: model, from: previous })
  }

  const stopEvents = services.hub.on(async (event) => {
    if (event.type === "session.model.selected") await selected(event.data)
    if (WAKES.has(event.type) && pending.size > 0) await attempt()
  })
  const stopOps = services.hub.subscribe((event) => {
    if (event.name !== "op.done") return
    const teamID = event.data.teamID
    const missed = covered.get(event.data.opID)
    covered.delete(event.data.opID)
    const start = starts.get(teamID)
    void (async () => {
      if (start) return started(teamID, { target: start.target, from: start.from })
      if (missed && event.data.state !== "done" && (await landed(teamID, missed.target))) return started(teamID, missed)
      return attempt()
    })().catch((error: unknown) => services.log.warn("team_follow_failed", { teamID, error }))
  })

  return {
    main,
    /**
     * Pending follows go again, and a team whose 팀과 같게 owner works on another subscription of the team main's
     * company (an account change missed while no instance listened) moves with the op.
     */
    resume: async () => {
      await attempt()
      const teams = await services.registry.teams.list()
      await Promise.all(teams.filter((team) => team.state === "on").map((team) => reconcile(services, team, begin)))
    },
    close: () => {
      told.forEach((cancel) => cancel())
      told.clear()
      stopEvents()
      stopOps()
    },
  }
}

async function reconcile(
  services: Services.Context,
  team: OwnTeam.Team,
  begin: (input: {
    readonly teamID: OwnTeam.TeamID
    readonly target: Model.Ref
    readonly from: Model.Ref
  }) => Promise<boolean>,
) {
  if (await services.journal.active(team.id)) return
  const main = await services.http.session.get({ sessionID: team.main.sessionID, directory: team.home.directory })
  const target = main.ok ? main.value.model : undefined
  if (!target) return
  const listed = await services.accounts.accountsList()
  if (!listed.ok) return
  const account = (providerID: string) => listed.value.accounts.find((item) => item.providerID === providerID)
  const areas = await services.registry.areas.list(team.id)
  const owners = await Promise.all(
    areas.flatMap((area) => {
      const owner = area.owner.sessionID
      if (area.state !== "active" || area.main || owner === null || !area.owner.attached) return []
      return [services.http.session.get({ sessionID: owner, directory: area.directory })]
    }),
  )
  const from = owners
    .flatMap((got) => (got.ok && got.value.model ? [got.value.model] : []))
    .find((ref) => TeamContext.rival(account(ref.providerID), account(target.providerID)))
  if (from) await begin({ teamID: team.id, target, from })
}

function present<T>(value: T | null | undefined): ReadonlyArray<T> {
  return value === null || value === undefined ? [] : [value]
}

/** The open `account.waiting` notice of a team account op (`team.get` drops it once the op is no longer active). */
export function waitingID(opID: string) {
  return `waiting:${opID}`
}

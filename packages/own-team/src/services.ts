export * as Services from "./services.js"

import type { Plugin } from "@opencode/plugin"
import type { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import type { Approval, OwnTeam, Preset } from "@own/protocol"
import type { Drift } from "./assets/drift.js"
import type { Heavy } from "./assets/heavy.js"
import type { Shared } from "./assets/shared.js"
import type { Talk } from "./dispatch/talk.js"
import type { Hub } from "./hub.js"
import type { Log } from "./log.js"
import type { Notices } from "./notices.js"
import type { Journal } from "./ops/journal.js"
import type { Runner } from "./ops/runner.js"
import type { Steps } from "./ops/steps.js"
import type { ReorgPropose } from "./reorg/propose.js"
import type { Areas } from "./registry/area.js"
import type { Dispatches } from "./registry/dispatch.js"
import type { Keys } from "./registry/keys.js"
import type { Teams } from "./registry/team.js"
import type { AccountsRpc } from "./sessions/accounts-rpc.js"
import type { SessionHttp } from "./sessions/http.js"
import type { Locate } from "./sessions/locate.js"

/**
 * The typed contracts of own.team (06 §2.2). `Base` is the controller's infrastructure (registry, op journal and
 * runner, hub, self-HTTP, own.accounts RPC); `Features` are the team behaviours, one module each, created by the
 * controller with `create(services)`. Every feature module exists from T1.05 on with its final signature and a
 * neutral body (it answers `unsupported`, or does nothing); later waves fill the bodies. T2 added the adopt, reconcile,
 * integrate, decisions and drift features without changing a T1 contract; T3 adds the shared-folder and reorganization
 * features the same way.
 *
 * Features call each other at run time through `services.features()` (never inside `create`, where the others may
 * not exist yet). Core events reach them through `services.hub.on` (subscribe in `create`), and `resume` runs on
 * controller start and whenever a new plugin instance appears (06 §2.6 "수명의 한계": catch up, recompute timers,
 * send waiting requests again).
 */

// ---------------------------------------------------------------------------------------------------------------
// Time

/** Time source and timers, so debounces and nonce expiry can be driven by tests. */
export interface Clock {
  now(): number
  /** Runs `run` once after `ms`; returns a cancel function. Timers never keep the process alive. */
  schedule(ms: number, run: () => void): () => void
}

export const system: Clock = {
  now: () => Date.now(),
  schedule: (ms, run) => {
    const timer = setTimeout(run, Math.max(0, ms))
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Results

type ErrorData<K extends OwnTeam.ErrorName> = (typeof OwnTeam.errors)[K]["Type"]

/** A declared own.team error (06 §2.7) with its typed data; RPC handlers return it as is, tools word it. */
export type Failure = {
  readonly [K in OwnTeam.ErrorName]: {
    readonly ok: false
    readonly error: K
    readonly message: string
    readonly data: ErrorData<K>
  }
}[OwnTeam.ErrorName]

/** Success with its fields, or a {@link Failure}. Services return failures; they never throw on purpose. */
export type Result<T extends object = {}> = ({ readonly ok: true } & T) | Failure

export function failure<K extends OwnTeam.ErrorName>(error: K, message: string, data: ErrorData<K>): Failure {
  // SAFETY: `{ok, error: K, message, data: ErrorData<K>}` is the K member of the Failure union.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { ok: false, error, message, data } as Failure
}

/** What a build answers before the feature exists (`unsupported{feature}`, 06 §2.7). */
export function unsupported(feature: string): Failure {
  return failure("unsupported", `${feature} is not available in this build`, { feature })
}

// ---------------------------------------------------------------------------------------------------------------
// Infrastructure

/** A live own.team plugin instance (one per Location). Its `ctx` reaches KV, own.accounts RPC and session writes. */
export interface Instance {
  readonly id: number
  readonly ctx: Plugin.Context
  readonly directory: string
  /** The control location instance (it leads, 06 §2.6). */
  readonly control: boolean
  readonly leader: () => boolean
}

/** One recent failure shown by `diagnostics.lastErrors` (kept in memory, last 20 per team). */
export interface ErrorEntry {
  readonly at: number
  readonly opID?: OwnTeam.OpID
  readonly stepID?: string
  readonly message: string
}

export interface Registry {
  readonly teams: Teams.Store
  readonly areas: Areas.Store
  readonly dispatches: Dispatches.Store
}

export interface Base {
  readonly buildId: string
  /** OWN_HOME. */
  readonly home: string
  readonly log: Log.Logger
  readonly clock: Clock
  /** The plugin KV; write only inside {@link Base.write}. */
  readonly kv: Keys.Store
  readonly registry: Registry
  readonly journal: Journal.Store
  /** Step kinds; feature modules register theirs in `create`. */
  readonly steps: Steps.Registry
  readonly runner: Runner.Engine
  readonly hub: Hub.Bus
  readonly notices: Notices.Publisher
  /** Self-HTTP to the own service (06 §2.6): session, inbox, instructions, metadata, worktree refresh. */
  readonly http: SessionHttp.Client
  /** own.accounts through `ctx.rpc` (approval, presets, switching, quota). */
  readonly accounts: AccountsRpc.Client
  /** Which team, area and role a directory or a session belongs to (the registry is the source, 06 §2.8). */
  readonly locate: Locate.Api
  /**
   * Runs `section` in the team's mutex once this controller holds the controller lock: the only way registry, journal
   * and digest records of a team are written (06 §2.4 "쓰기는 컨트롤러 하나만").
   */
  readonly write: <T>(teamID: string, section: () => Promise<T>) => Promise<T>
  /**
   * Whether this controller holds the controller lock, so {@link Base.write} runs at once. A hook skips work that would
   * wait for it: core waits for every hook (06 §2.6).
   */
  readonly started: () => boolean
  /** A live instance, preferring the one at `directory`, then the control location's (06 §2.6). */
  readonly instance: (directory?: string) => Instance | undefined
  /** Records a failure for `diagnostics.lastErrors`. */
  readonly failed: (teamID: string, entry: ErrorEntry) => void
  readonly errors: (teamID: string) => ReadonlyArray<ErrorEntry>
  /**
   * RH-20: resolves `true` once {@link Base.write} runs at once (this controller holds the controller lock), or `false`
   * after `ms` while it does not (another live process of this OWN_HOME holds it). RPC methods and tools that write
   * answer `unavailable` then instead of waiting for good.
   */
  readonly ready: (ms: number) => Promise<boolean>
  /** RH-20: the controller lock and this process's event streams (`health`, `diagnostics`, `team_status`). */
  readonly status: Status
}

/** What `health` and `diagnostics` tell of this process (RH-20). */
export interface Status {
  controller(): OwnTeam.Controller
  /** The event streams of this process's instances: `restarting` while one of them is. */
  intake(): { readonly state: "reading" | "restarting"; readonly restarts: number } | undefined
  /** An instance's stream (`Intake.start`); `undefined` drops it (the instance went away). */
  setIntake(
    id: number,
    state: { readonly state: "reading" | "restarting"; readonly restarts: number } | undefined,
  ): void
}

export interface Context extends Base {
  /** The feature services; resolved at run time (call it inside methods, not in `create`). */
  readonly features: () => Features
}

/** Optional hooks of a feature, run by the controller. */
export interface Lifecycle {
  /** Controller start and every new instance: catch up from KV and core, recompute timers, resend waiting work. */
  readonly resume?: () => Promise<void>
  /** Controller close: stop timers and loops. */
  readonly close?: () => Promise<void>
}

type By = OwnTeam.Op["by"]

// ---------------------------------------------------------------------------------------------------------------
// Sessions (06 §3.6, §6.2, §10.1)

export interface MainCreate {
  readonly teamID: OwnTeam.TeamID
  /** The main folder (`team.home.directory`). */
  readonly directory: string
  /** Chosen ahead by the caller, so a retry adopts the session instead of making a second one (core session.ts:253). */
  readonly sessionID: SessionID
  /** The enabling conversation's account, model and effort (10.1); never its preset or ultra. */
  readonly model: Model.Ref
  /** The approval mode for own.accounts `session.approval.set` (default: the user's default). */
  readonly approval?: Approval.SetMode
  readonly signal?: AbortSignal
}

/** The team main session (`sessions/main.ts`). */
export interface Main extends Lifecycle {
  /**
   * `session.create` at the home (title `팀 메인`, the team tool allows of `tools/permissions.ts`, metadata
   * `own.team`), then `session.approval.set` (never `computerUse`), `session.preset.apply{group ★, team}` and the
   * `own.team.main.role` instruction entry (skipped when its hash is unchanged).
   */
  create(input: MainCreate): Promise<Result<{ readonly sessionID: SessionID }>>
  /** The team main session's current `Model.Ref` (what `팀과 같게` follows); `undefined` when unknown. */
  model(teamID: OwnTeam.TeamID): Promise<Model.Ref | undefined>
  /**
   * 2026-11-14: the main's `own.team.main.role` entry written again now from the team's settings and 팀 지시문 (the
   * `directHold` setting or the main's block changed); an equal value is not written again. Absent in builds and
   * tests without it.
   */
  readonly refresh?: (input: { readonly teamID: OwnTeam.TeamID }) => Promise<Result>
}

export interface OwnerCreate {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  /** Default: `area.main?.model`, else the team main's current Ref (10.1). */
  readonly model?: Model.Ref
  /** Default: the user's default mode; a rotation passes the previous owner's mode (6.2 step 3). */
  readonly approval?: Approval.SetMode
  /** Text of the `own.team.handoff` instruction entry (6.2, 6.4). */
  readonly handoff?: string
  /**
   * The 에이전트 방식 the conversation starts on (metadata `own.harness`, 2026-10-26): a new area's first owner gets
   * the one the user chose (영역 만들기); absent with {@link harnessFrom} too = the service's default.
   */
  readonly harness?: OwnTeam.Harness
  /** The conversation whose 에이전트 방식 the new one keeps (the owner it replaces, the area it splits from). */
  readonly harnessFrom?: { readonly sessionID: string; readonly directory: string }
  readonly signal?: AbortSignal
}

/** Area owner sessions (`sessions/owner.ts`). */
export interface Owner extends Lifecycle {
  /**
   * 6.2 step 3: writes `owner.pending` first, `session.create` (an existing id is adopted), approval (never
   * `computerUse`), `session.preset.apply{area.preset, team}`, `own.team.role` (+ `own.team.handoff`), registry.
   */
  create(input: OwnerCreate): Promise<Result<{ readonly sessionID: SessionID }>>
  /** 3.7: attaches the role, the team tool allows and the area preset to an adopted owner (`owner.attached: false`). */
  attach(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly signal?: AbortSignal
  }): Promise<Result>
  /**
   * 06 §6.2, §5.8: an attached owner's role entry brought up to date once per controller, before its next request goes
   * (the outbox calls it; a failure is logged, the request goes on). Absent in builds and tests without it.
   */
  readonly role?: (input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID }) => Promise<void>
  /**
   * 역할 바꾸기 (`area.edit`, 2026-10-26): an attached owner's role entry written now with the area as recorded (an
   * equal value is not written again), so {@link role} counts it done; a failure leaves it to `role` before the next
   * request. Absent in builds and tests without it.
   */
  readonly refresh?: (input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID }) => Promise<Result>
  /**
   * 2026-11-14: the team's settings or 팀 지시문 changed what the owners' role entries say (`directHold`,
   * `directTell`, the owner block): every attached owner of the team (or of one area) gets its entry again through
   * {@link role} before its next request. Absent in builds and tests without it.
   */
  readonly stale?: (input: { readonly teamID: OwnTeam.TeamID; readonly areaID?: OwnTeam.AreaID }) => Promise<void>
}

export interface AreaPlan {
  readonly team: OwnTeam.Team
  /** V6 slug; the area id is `ar_<slug>`, and the slug names its branch and folder. */
  readonly slug: string
  readonly name: string
  readonly goal?: string
  /** Heavy folders the area needs from the start (4.5). */
  readonly needs?: ReadonlyArray<string>
  /** `main` (default: the team target) or the slug of the area whose branch tip it starts at. */
  readonly from?: string
  readonly by: By
  /**
   * 영역 만들기 (the user's, 2026-10-26): the area's own model; team R4 is checked with the area as one more holder,
   * and its preset is the ★ of that model's group. Absent = 팀과 같게.
   */
  readonly main?: Model.Ref
  /** 영역 만들기: the first owner conversation's 에이전트 방식 (`OwnerCreate.harness`). */
  readonly harness?: OwnTeam.Harness
  /** The record carries `userMade` (영역 만들기, or 다시 만들기 of a user-made area). */
  readonly userMade?: boolean
}

/** New areas (`ops/area-create.ts`, 06 §3.6, §4.5, §8.2 새 영역). */
export interface AreaCreate extends Lifecycle {
  /**
   * The op steps that make one area: branch, code-only worktree (locked), `worktree.refresh`, owner session, and the
   * setup command as an op step. The kinds are registered by this module; enable and `reorg.apply` append the steps.
   */
  plan(input: AreaPlan): Promise<Result<{ readonly areaID: OwnTeam.AreaID; readonly steps: ReadonlyArray<Steps.Spec> }>>
}

/** The 8.4 check that failed (the `not_safe_point` error's `why`). */
export type SafeWhy = ErrorData<"not_safe_point">["why"]

/** A command or terminal that holds a folder (`shell`, `pty` of 8.4), with the conversation that started it. */
export type Holding = NonNullable<OwnTeam.StepWait["shells"]>[number]

/**
 * `shells` (RH-20): for `shell` and `pty`, what runs. They outlived the run that started them (a dev server, a watcher,
 * a terminal), since a folder whose conversations work answers `session` first.
 */
export type Safe =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly why: SafeWhy
      readonly sessionIDs: ReadonlyArray<SessionID>
      readonly shells?: ReadonlyArray<Holding>
    }

/** Safe points (`sessions/safe-point.ts`, 06 §8.4). */
export interface SafePoint extends Lifecycle {
  /**
   * Whether nobody works in the area folder (or the home when `areaID` is absent): Location-free checks first
   * (active, inbox, permissions, own ops, git), forms and shells only when that Location is alive; `extended` also
   * requires no pty.
   */
  check(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID?: OwnTeam.AreaID
    readonly extended?: boolean
    /**
     * The owner's queue does not count: what is parked there stays with that conversation (a team account move whose
     * old owner was stopped or is out of its limit, 06 §10.1, §6.2).
     */
    readonly parked?: boolean
    /** Conversations of the folder whose queue counts too (담당 대화 바꾸기: the one that takes the seat). */
    readonly also?: ReadonlyArray<SessionID>
    readonly signal?: AbortSignal
  }): Promise<Safe>
}

/** Owner conversation rotation (`sessions/rotate.ts`, 06 §6.1–6.2, §6.5); only at semantic boundaries, never by size. */
export interface Rotate extends Lifecycle {
  /** Starts a rotation op for the area (`warm` = a handoff turn on the old owner, `program` = no LLM call). */
  request(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly reason: OwnTeam.RotationReason
    readonly handoff: "warm" | "program"
    readonly by: By
  }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
  /** 메인 새 대화 (`main.rotate`, 6.5). */
  main(input: { readonly teamID: OwnTeam.TeamID; readonly by: By }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
}

/** The team context own.accounts gets with every preset binding (`sessions/team-context.ts`, 07 §5.1, §5.4; 10.1). */
export interface TeamContext extends Lifecycle {
  /** `session.preset.apply{team}` for the team main or an owner; `null` when the team is unknown or off. */
  get(input: { readonly teamID: OwnTeam.TeamID; readonly role: "main" | "owner" }): Promise<Preset.Team | null>
  /** Pushes the current context to the main and every owner whose binding differs (no change, no write). */
  push(teamID: OwnTeam.TeamID): Promise<void>
}

/** Area main, area preset and the team account (`sessions/area-main.ts`, 06 §10.1, §2.7). */
export interface AreaMain extends Lifecycle {
  /** `area.main`: `null` = 팀과 같게; team R4 is checked (`same_company_subscription`). */
  set(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly model: Model.Ref | null
    readonly now?: boolean
    readonly by: By
  }): Promise<Result<{ readonly area: OwnTeam.AreaView; readonly opID?: OwnTeam.OpID }>>
  /** `area.preset`: the area main's group (`preset_wrong_group`), team R4, then `session.preset.apply` on the owner. */
  preset(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly presetID: Preset.ID
  }): Promise<Result<{ readonly area: OwnTeam.AreaView }>>
  /** `team.account`: the plan with `dryRun`, else the `team-account` op. */
  account(input: {
    readonly teamID: OwnTeam.TeamID
    readonly target: Model.Ref
    readonly mode?: "after-idle" | "stop"
    readonly dryRun?: boolean
  }): Promise<Result<{ readonly plan: OwnTeam.AccountPlan } | { readonly opID: OwnTeam.OpID }>>
}

// ---------------------------------------------------------------------------------------------------------------
// Main requests and Main 멈춤 (06 §5.1–5.3)

export interface DispatchInput {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly text: string
  readonly task?: string
  /** Unrelated new work: the owner conversation is replaced first (6.1). */
  readonly fresh?: boolean
  /** The area peer it goes to (`Peer.key`, 동료); absent = the owner. Never with `fresh`. */
  readonly to?: string
  /** A main request, or the program's request or notice (`kind: "notice"`, 5.8); area messages go by {@link MessageInput}. */
  readonly from: "main" | "team"
  readonly kind: OwnTeam.Dispatch["kind"]
  /** `from: "team"`: when the integration or op that asks started (`Dispatch.origin`); absent = now. */
  readonly origin?: number
}

/** An area message (06 §5.8): an ask or a reply of an area's owner or peer to another conversation of the team. */
export interface MessageInput {
  readonly teamID: OwnTeam.TeamID
  /** The receiving area. */
  readonly areaID: OwnTeam.AreaID
  /** The receiving peer (`Peer.key`); absent = the owner. */
  readonly to?: string
  readonly kind: "ask" | "reply"
  readonly sender: OwnTeam.Sender
  /** `reply`: the ask it answers. */
  readonly replyTo?: OwnTeam.DispatchID
  readonly text: string
  /** A reply taken from the last answer of the run that took the ask (it called no reply); worded so for the main. */
  readonly last?: boolean
}

/** The outbox and admission (`dispatch/admit.ts`). */
export interface Admit extends Lifecycle {
  /**
   * Records the request and sends it now when the area folder is idle (one at a time), else it waits (5.1).
   * `refused`: a request to a peer was not sent, its conversation is on another subscription of the team main's
   * company (team R4, no rotation for a peer).
   */
  dispatch(input: DispatchInput): Promise<
    Result<{
      readonly dispatchID: OwnTeam.DispatchID
      readonly state: "queued" | "waiting" | "refused"
      readonly why?: OwnTeam.WaitReason
      /** It waits because the user works with the area directly (`why: "paused"`, 2026-11-14). */
      readonly direct?: true
    }>
  >
  /**
   * An area message (06 §5.8): the loop guards and the record in one write section of the team, then the area's step
   * as for {@link dispatch}. `guard`: a guard held it back and nothing was written.
   */
  message(input: MessageInput): Promise<
    Result<
      | { readonly guard: Talk.Guard }
      | {
          readonly dispatchID: OwnTeam.DispatchID
          readonly state: "queued" | "waiting" | "refused"
          readonly why?: OwnTeam.WaitReason
          /** It waits because the user works with the area directly (`why: "paused"`, 2026-11-14). */
          readonly direct?: true
        }
    >
  >
  /** Sends the next waiting request of each area (or one area) whose folder is idle (on events, 5.1). */
  drain(input: { readonly teamID: OwnTeam.TeamID; readonly areaID?: OwnTeam.AreaID }): Promise<void>
  /**
   * `outbox.list`: the waiting requests and why they wait (since when, what holds them: RH-20), and the notes (쪽지)
   * held for the area (5.8).
   */
  list(input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID }): Promise<
    Result<{
      readonly items: ReadonlyArray<OwnTeam.Dispatch>
      readonly why?: OwnTeam.WaitReason
      readonly since?: number
      readonly cause?: OwnTeam.WaitCause
      readonly notes?: ReadonlyArray<OwnTeam.AreaNote>
    }>
  >
  /**
   * Why the area's waiting requests wait now, since when and what holds them (RH-20: `team_status`); `undefined` when
   * none waits or the next can go. Absent in builds and tests without it.
   */
  readonly waited?: (input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID }) => Promise<
    | {
        readonly why: OwnTeam.WaitReason
        readonly since: number
        readonly cause?: OwnTeam.WaitCause
      }
    | undefined
  >
  /** `outbox.cancel`. */
  cancel(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly dispatchID: OwnTeam.DispatchID
  }): Promise<Result>
  /** Cancels every waiting request of the team (or one area) and returns them (disable, retire, unadopt; 3.8). */
  cancelAll(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID?: OwnTeam.AreaID
  }): Promise<ReadonlyArray<{ readonly areaID: OwnTeam.AreaID; readonly dispatchID: OwnTeam.DispatchID }>>
}

/** Main 멈춤 (`dispatch/pause.ts`, 5.3). */
export interface Pause extends Lifecycle {
  /** `area.pause`: on sets `"user"`; off wakes the parked queue and drains the outbox. */
  area(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly on: boolean
    /** The main's own hand-back (its approved `team_area resume` plan): direct work ends as `taken`. Not on the wire. */
    readonly taken?: boolean
  }): Promise<Result<{ readonly area: OwnTeam.AreaView }>>
  /** `team.pause`: on = 모두 멈추기 (`"all"`, owners interrupted); off clears only `"all"`. */
  team(input: {
    readonly teamID: OwnTeam.TeamID
    readonly on: boolean
  }): Promise<Result<{ readonly team: OwnTeam.Team }>>
  /** An area session's run ended by the user's stop (`interrupted{reason:"user"}`): Main 멈춤 goes on. */
  stopped(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly sessionID: SessionID
  }): Promise<void>
}

// ---------------------------------------------------------------------------------------------------------------
// Reports and waking the main (06 §5.5–5.7)

export interface ReportInput {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly sessionID: SessionID
  /** An area peer's report (its key; `ready` is the owner's only, `tools/report.ts`). */
  readonly peer?: string
  readonly kind: "progress" | "done" | "ready" | "blocked"
  readonly text: string
  readonly task?: string
  /** `ready` only: the change needs an engine run, so the integration runs the `.assets` check (4.10). */
  readonly assets?: boolean
}

/** Session events and reports (`report/events.ts`). */
export interface Events extends Lifecycle {
  /** `team_report` (5.5): folds, checks and records the candidate on `ready`, wakes; `text` answers the owner. */
  report(input: ReportInput): Promise<Result<{ readonly text: string }>>
  /** Reads each main and owner session log after its cursor (5.5 따라잡기); `resume` runs it for every team. */
  catchUp(teamID?: OwnTeam.TeamID): Promise<void>
}

/** One folded event of the digest (KV `digest:<teamID>`). */
export interface DigestEntry {
  readonly at: number
  readonly areaID?: OwnTeam.AreaID
  /** A 5.6 reason word (`ready`, `blocked`, `failed`, `all-done`, `progress`, `direct`, …). */
  readonly reason: string
  readonly text: string
  /** Whether the entry wakes the main (5.6 table). */
  readonly wake: boolean
  /** The area peer it is about (its note goes under the peer's line). */
  readonly peer?: string
}

/** The digest (`report/digest.ts`). */
export interface Digest extends Lifecycle {
  add(teamID: OwnTeam.TeamID, entry: DigestEntry): Promise<void>
  /**
   * `team_status` (no token bound of its own since 2026-11-14: core bounds a tool's output and saves the whole) and
   * the team update text (5.6, at most 2k tokens); `areaID` = an owner's view.
   */
  render(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID?: OwnTeam.AreaID
    /**
     * An owner's or a peer's own view (with `areaID`, 06 §5.8): also the other areas, its asks, watches and the notes
     * held for it. `peer`: the calling peer's key.
     */
    readonly viewer?: { readonly peer?: string }
    /** `team_status` (RH-20): each waiting outbox says why it waits, since when and what holds it. */
    readonly causes?: boolean
  }): Promise<string>
}

/** Waking the main (`report/wake.ts`, 5.6): debounced team updates, at most one undelivered in the main inbox. */
export interface Wake extends Lifecycle {
  request(teamID: OwnTeam.TeamID): void
}

// ---------------------------------------------------------------------------------------------------------------
// Documents and undo

/** Handoff documents (`docs/handoff.ts`, 06 §6.2, §6.4): `areas/<slug>/handoff.md` in the team records folder. */
export interface Handoff extends Lifecycle {
  /** `team_handoff{text}` or a program handoff: writes the file (64 KB cap) and records its hash. */
  write(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly text: string
    readonly by: "owner" | "program"
  }): Promise<Result<{ readonly file: string; readonly hash: string }>>
  /**
   * 6.2 step 2: the program handoff (requests, reports, branch state, changed files; no LLM). `seat`: its reader is a
   * conversation that was there already and takes the seat (6.8), so the note calls nothing about it new.
   */
  program(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly seat?: true
  }): Promise<Result<{ readonly text: string }>>
  read(input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID }): Promise<string | undefined>
}

// ---------------------------------------------------------------------------------------------------------------
// Area peers (동료, 2026-10-09: 06 §1.2, §2.4, §2.7, §5.1)

/** `area.peer.add`: a root conversation of the area's folder, or a new one own.team creates there. */
export type PeerAdd =
  | {
      readonly teamID: OwnTeam.TeamID
      readonly areaID: OwnTeam.AreaID
      readonly sessionID: SessionID
      readonly label: string
      readonly role: string
    }
  | {
      readonly teamID: OwnTeam.TeamID
      readonly areaID: OwnTeam.AreaID
      readonly create: { readonly label: string; readonly role: string }
    }

/**
 * Area peers (`sessions/peer.ts`): the RPC methods `area.peer.*` (and later the voice tools) call these; the outbox
 * attaches a registered peer at its first main request, and unadopt, disable and undo detach every attached one.
 */
export interface Peers extends Lifecycle {
  add(input: PeerAdd): Promise<Result<{ readonly area: OwnTeam.AreaView; readonly peer: OwnTeam.Peer }>>
  edit(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly key: string
    readonly label?: string
    readonly role?: string
  }): Promise<Result<{ readonly area: OwnTeam.AreaView }>>
  remove(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly key: string
  }): Promise<Result<{ readonly area: OwnTeam.AreaView }>>
  /** 5.1 step 3 for a peer: the team allows and the peer role (a created one: its session, preset and role). */
  attach(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly key: string
    readonly signal?: AbortSignal
  }): Promise<Result>
  /** The inverse for every attached peer of the area (팀에서 빼기, 끄기, 되돌리기); the records stay. */
  detach(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly signal?: AbortSignal
  }): Promise<Result>
  /** 06 §6.2, §5.8: an attached peer's role entry brought up to date once per controller, before its next request goes. */
  readonly role?: (input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly key: string
  }) => Promise<void>
  /**
   * 2026-11-14: the team's settings or 팀 지시문 changed what the peers' role entries say (`directTell`, the peer
   * block): every attached peer of the team (or of one area) gets its entry again through {@link role} before its next
   * request. Absent in builds and tests without it.
   */
  readonly stale?: (input: { readonly teamID: OwnTeam.TeamID; readonly areaID?: OwnTeam.AreaID }) => Promise<void>
}

/**
 * What a hand-back ended (`Direct.end`): `line`, the digest entry it wrote (`Direct.handed`: the time range, the
 * pointer to the whole reports, counts, program facts, the newest report), and the main requests that waited for it.
 */
export interface Handed {
  readonly line: string
  readonly waiting: number
}

/**
 * 직접 작업 (`dispatch/direct.ts`, 2026-11-14): the user works with an area's owner directly (`Area.directWork`).
 * The pure rules (`Direct.live`, `kept`, `pass`, `serving`, …) are module functions; this feature holds what
 * writes and the process-local memory of the main conversation.
 */
export interface Direct extends Lifecycle {
  /**
   * A user (not machine) message at the clock's now in the area's owner conversation (`sessionID`): in one team
   * write the area's `direct` mark is set and `directWork` starts or moves its `at` (`Direct.marked`: hold on, the
   * owner not `serving`), with one `area.changed`. Peers and other conversations of the folder never start it.
   */
  note(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly sessionID: SessionID
  }): Promise<void>
  /**
   * The outbox is about to send `dispatch` (marked inside the team write of its held re-check, released once the
   * request is recorded `sent` or the send gave up): while a main or program request to the owner is marked, {@link note}
   * counts the owner as serving, so a user message that lands mid-send steers that request instead of holding the area.
   * Returns the release.
   */
  sending(dispatch: Pick<OwnTeam.Dispatch, "teamID" | "areaID" | "from" | "kind" | "to">): () => void
  /** The user wrote into the team's main conversation now (the prompt hook, before its detached record). */
  said(teamID: OwnTeam.TeamID): void
  /** When the user last wrote into the team's main conversation in this process; 0 when unknown (after a restart). */
  spoke(teamID: OwnTeam.TeamID): number
  /**
   * The hand-back: reads the program facts (commits not in the target, uncommitted changes), then in the team write
   * removes `directWork`, ends the stretch (`until`), appends the `handed` (wakes) or `taken` entry and publishes
   * `area.changed`; afterwards, with Main 멈춤 off, the waiting requests and integrations go again. `undefined` when
   * the area was not held.
   */
  end(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly why: "handed" | "taken"
  }): Promise<Handed | undefined>
  /** `directHold` switched off: {@link end} with `handed` for every held area of the team. */
  sweep(teamID: OwnTeam.TeamID): Promise<void>
}

/**
 * 담당 대화 바꾸기 (`sessions/seat.ts`, 2026-11-12): the owner seat of an area moves onto an existing root conversation
 * of the area's folder. `area.seat` and `team_control{seat}` call `request`, which answers the op's id at once.
 */
export interface Seat extends Lifecycle {
  request(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly sessionID: SessionID
    readonly by: By
  }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
  /**
   * Strips the conversations listed in the area's `owner.release` of what an owner holds and takes them off the list
   * (one that cannot be reached stays listed). An owner listed there is a swap that stopped after its record write:
   * the sweep finishes it first (the promoted peer's requests and slots, the team note, the main's line). `inside`:
   * called by a step of the op that holds the area; any other caller skips an area an op maintains, whose claimed
   * conversation is listed without being the owner yet, and runs one at a time per area, so a claim can wait for it.
   */
  sweep(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly inside?: boolean
  }): Promise<void>
}

/** `op.undo` (`ops/undo.ts`, 06 §3.8). */
export interface Undo extends Lifecycle {
  start(input: { readonly opID: OwnTeam.OpID; readonly by: By }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
}

// ---------------------------------------------------------------------------------------------------------------
// Adoption, area reconcile, integration and decision records (T2: 06 §8.2, §8.8, §7, §6.6)
//
// Features whose step kinds take the feature's callbacks register them in `register`, which the RPC groups call while
// the plugin sets up (before the controller's first resume continues an op), not in `create`: a test controller then
// registers the module's kinds with its own callbacks.

/** 팀에 넣기 / 빼기 (`ops/adopt.ts`, 06 §8.2); the adopt step kinds come with the undo feature. */
export interface Adopt extends Lifecycle {
  /** `area.adopt`: one undoable `adopt` op for a linked worktree of the team's repository (V3). */
  adopt(input: {
    readonly teamID: OwnTeam.TeamID
    readonly directory: string
  }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
  /** `area.unadopt`: the `unadopt` op of an adopted area at its safe point; folder, branch and conversations stay. */
  unadopt(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
  }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
}

/** When an area reconcile runs (06 §8.8 "켤 때, 안전 지점마다, 컨트롤러가 시작할 때"). */
export type ReconcileTrigger = "enable" | "safe-point" | "start"

/** Area reconcile (`reconcile/area.ts`, 06 §8.8): areas follow branches and folders changed outside own. */
export interface Reconcile extends Lifecycle {
  /** One run for the team; a run asked for while one runs makes one more run after it. */
  run(input: { readonly teamID: OwnTeam.TeamID; readonly trigger: ReconcileTrigger }): Promise<void>
  /**
   * The start reconcile (8.8 "컨트롤러가 시작할 때"): one run for every team that is on when the controller starts.
   * `Controller.start` calls it before any write may run, so it covers what an earlier controller left; a record
   * written afterwards is the next trigger's. Later calls answer the same runs.
   */
  start(): Promise<void>
  /** Registers the `reconcile-move` step kind (8.8) in the controller's registry, once. */
  register(): void
}

/** What `integration.push.plan` shows before anything runs (06 §7.5). */
export interface PushPlan {
  /** Binds `integration.push.execute` to this plan for 10 minutes. */
  readonly nonce: string
  readonly expiresAt: number
  readonly remote: string
  readonly ref: string
  readonly commands: ReadonlyArray<string>
}

/** Integration (`integrate/*.ts`, 06 §7): the op of steps 0-9, its retries, undo and push. */
export interface Integrate extends Lifecycle {
  /**
   * `area.integrate`, `team_integrate`, 이 영역 반영하기: the area's waiting integration is tried again (7.2 기다림과
   * 다시 시도), otherwise a new integration op under the start rules of 7.1 (`tip`: the user's menu without a
   * candidate takes the branch tip).
   */
  start(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly by: By
    readonly tip?: boolean
    /** C as a voice plan showed it (06 §2.9): another C now is `conflict` and nothing starts. */
    readonly source?: string
  }): Promise<Result<{ readonly opID: OwnTeam.OpID; readonly integrationID: OwnTeam.IntegrationID }>>
  /** The team's waiting integration is tried again (the main woke, a git operation ended); a busy team skips it. */
  retry(teamID: OwnTeam.TeamID): Promise<void>
  /** `integration.undo` (7.4): only while the target is still K. */
  undo(input: { readonly integrationID: string; readonly by: By }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
  /**
   * `integration.undo.cancel` (7.4, RH-42): the undo that waits outside its op is dropped, and the integrations into
   * the same target it held go on.
   */
  undoCancel(input: { readonly integrationID: string }): Promise<Result<{ readonly integration: OwnTeam.Integration }>>
  /** `integration.push.plan` (7.5). */
  plan(input: { readonly integrationID: string; readonly pr?: boolean }): Promise<Result<PushPlan>>
  /** `integration.push.execute{nonce}` (7.5): the planned push as an op, with the plan's unexpired nonce only. */
  push(input: { readonly nonce: string }): Promise<Result<{ readonly opID: OwnTeam.OpID }>>
  /** Registers the integrate (0-9), undo and push step kinds with this feature's callbacks, once. */
  register(): void
}

/** A decision record written (`docs/decisions.ts`, 06 §6.6). */
export interface DecisionAdded {
  readonly record: OwnTeam.DecisionRecord
  /** The record file's absolute path in the team records folder. */
  readonly path: string
  /** `policy.commitDecisions` on: the copy the main commits in the main folder, and what to do. */
  readonly commit?: {
    readonly directory: string
    readonly path: string
    readonly text: string
    readonly instruction: string
  }
}

/** Decision records (`docs/decisions.ts`, 06 §6.6). */
export interface Decisions extends Lifecycle {
  /** `team_decide` (source `main`) and 결정 적기 (`user`): the next number, its file and its index entry. */
  add(input: {
    readonly teamID: OwnTeam.TeamID
    readonly title: string
    readonly body: string
    readonly source: OwnTeam.DecisionRecord["source"]
    readonly areas?: ReadonlyArray<OwnTeam.AreaID>
  }): Promise<Result<DecisionAdded>>
  /** `decisions.list`: in number order. */
  list(teamID: OwnTeam.TeamID): Promise<Result<{ readonly items: ReadonlyArray<OwnTeam.DecisionRecord> }>>
}

// ---------------------------------------------------------------------------------------------------------------
// Reorganization (T3: 06 §8.1–8.8, §3.8 cleanup)

/**
 * The T3 reorganization wiring (`controller.ts`): the step kinds of the reorganization modules, 팀 구성 다시 보기 and
 * the `끝낼 수 있음` signal. Like integration's, its kinds come with {@link register}, which `rpc/reorg.ts` calls while
 * the plugin sets up (before the controller's first resume continues an op) and the feature calls before it plans.
 */
export interface Reorg extends Lifecycle {
  /**
   * Registers, once per controller, the kinds of 끝내기 (`retire.*`, `retire-remove` with the shared-folder unlink of
   * 4.11), 나누기, 묶기 (`outbox-migrate` with it), 변환, 대화 옮기기 and `lfs-remote`.
   */
  register(): void
  /** `reorg.propose` (8.1): one judge call on the team main, planned as `reorg.apply{proposalID}` would run it. */
  propose(input: {
    readonly teamID: OwnTeam.TeamID
    readonly hint?: string
    readonly signal?: AbortSignal
  }): Promise<Result<ReorgPropose.Proposed>>
  /**
   * `끝낼 수 있음` (8.1) of the team's active areas: each retirable area with its last change (`AreaView.retirable.since`).
   * git's facts are read by the first call after the controller started and again once they are a day old; the area
   * record and the clock are read now. A signal only: nothing is retired by it.
   */
  retirable(teamID: OwnTeam.TeamID): Promise<ReadonlyMap<OwnTeam.AreaID, number>>
}

export interface Features {
  readonly main: Main
  readonly owner: Owner
  readonly areas: AreaCreate
  readonly safePoint: SafePoint
  readonly rotate: Rotate
  readonly teamContext: TeamContext
  readonly areaMain: AreaMain
  readonly admit: Admit
  readonly pause: Pause
  readonly events: Events
  readonly digest: Digest
  readonly wake: Wake
  readonly handoff: Handoff
  readonly undo: Undo
  readonly adopt: Adopt
  readonly reconcile: Reconcile
  readonly integrate: Integrate
  readonly decisions: Decisions
  /** Cone drift (`assets/drift.ts`, 06 §4.8): the cone follows HEAD; re-checked after runs end. */
  readonly drift: Drift.Api
  /** Shared untracked folders (`assets/shared.ts`, 06 §4.11): links made again at safe points, removed unfollowed. */
  readonly shared: Shared.Api
  /** Reorganization (`controller.ts`, 06 §8): step kinds, 팀 구성 다시 보기, the 끝낼 수 있음 signal. */
  readonly reorg: Reorg
  /** The heavy list follows the project (`assets/heavy.ts`, 06 §4.4): measured per commit, grown by `heavy` ops. */
  readonly heavy: Heavy.Api
  /** Area peers (`sessions/peer.ts`, 동료). */
  readonly peers: Peers
  /** 담당 대화 바꾸기 (`sessions/seat.ts`). */
  readonly seat: Seat
  /** 직접 작업 (`dispatch/direct.ts`, 2026-11-14). */
  readonly direct: Direct
  /** Worktree conversations (`worktree-chat/`, 06 §13, 2026-11-24): their records follow core events; notes. */
  readonly worktreeChat: WorktreeChat
}

/** Worktree conversations (06 §13): `worktreeChat.list` and the follow-up of core events. */
export interface WorktreeChat extends Lifecycle {
  list(sessionID: string): Promise<{
    readonly items: ReadonlyArray<OwnTeam.WorktreeChat>
    readonly parent?: { readonly sessionID: string; readonly title?: string }
  }>
}

/** A feature module's constructor; tests replace single features (`Controller.Input.features`). */
export type Factories = { readonly [K in keyof Features]: (services: Context) => Features[K] }

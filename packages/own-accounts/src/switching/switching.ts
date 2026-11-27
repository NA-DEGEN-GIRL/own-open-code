export * as Switching from "./switching.js"

import os from "node:os"
import { Option, Schema } from "effect"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { SessionPrompt, SessionRetry } from "@opencode/plugin/promise/session"
import type { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { ServiceTarget, Store } from "@own/runtime"
import {
  Account,
  type Approval,
  ClaudeAgent,
  Compaction,
  Estimate,
  Kind,
  Kv,
  type Limit,
  LimitRank,
  OutputLimit,
  OwnID,
  Policy,
  Preset,
  Switch,
} from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { OwnTeam } from "@own/protocol/rpc-team"
import type { Deps } from "../deps.js"
import type { Emitter } from "../emitter.js"
import { Location } from "../location.js"
import type { Module } from "../module.js"
import { PresetBinding } from "../presets/binding.js"
import type { PresetStore } from "../presets/store.js"
import { Resets } from "../resets.js"
import type { RpcTypes } from "../rpc/types.js"
import { CoreConfig } from "../slots/core-config.js"
import type { Telemetry } from "../telemetry/telemetry.js"
import { SessionApproval } from "./approval.js"
import { SessionCompaction } from "./compaction.js"
import { IdleCompaction } from "./idle-compaction.js"
import { SwitchInbox } from "./inbox.js"
import { Estimator } from "./estimator.js"
import { Hysteresis } from "./hysteresis.js"
import { Planner } from "./planner.js"
import { PolicyRules } from "./policy.js"
import type { Rates } from "./rates.js"
import { Targets } from "./targets.js"
import { Tracker } from "./tracker.js"
import { Variant } from "./variant.js"

/**
 * Owner: SWITCHING agent. The switch state machine (02 §5.4, KV `sess:<sid>:switch`), busy/idle tracking from
 * `session.execution.*`, safe-point application (`ctx.session.wait` → `ctx.session.switchModel`, idle only; never
 * `credential.activate`), bindings and home slot, pending/scheduled switches and their timers, compaction
 * orchestration (server-side `ctx.session.compact`, `compaction.ended/failed`), unpinned-session pinning and the root
 * session's first preset binding (07 §5.1, `PresetBinding`), hysteresis and breaker, target selection (5.7), the
 * estimator (02 §6), and policy (`policy.json`, 5.10: subscriptions never auto-rotate to each other; only hard-quota
 * and auth triggers).
 */
export interface Api extends Module.Lifecycle {
  /**
   * Session `prompt` admission. Before AC-P26 it only turns `delivery` into `"queue"` for a busy session with a
   * pending switch; it never changes prompt content (02 §4.6, §5.3 method 2).
   */
  onPrompt(event: SessionPrompt): Promise<void>
  /** Session `retry`, after telemetry's verdict: records a hard/auth trigger for the idle path (02 §5.9(g)). */
  onRetry(event: SessionRetry, verdict: Telemetry.Verdict): Promise<void>
  /** Whether an execution of the session is running (02 §5.3 idle rule). */
  isBusy(sessionID: string): boolean
  /**
   * Whether the session's running compaction is one own admitted while the user was away (02 §4.7.7), and whether it
   * delivered too late and is dropped (CC-16); `undefined` for any other compaction.
   */
  idleCompaction(sessionID: string): Promise<IdleCompaction.Origin | undefined>
  /** `session.presence` (CC-14): a client shows the session to the user, which holds idle compaction back. */
  presence: RpcTypes.Handler<"session.presence">
  /**
   * The `permission` `evaluate` hook's part for conversations written with a former bundle (before MR10-3 or MR11): a
   * web request (`webfetch`, Code Mode's `fetch`, `websearch`) that core allows in a session ending with a former `ask`
   * or `read-only` bundle asks instead, as the current bundle would (`SessionApproval.legacyWeb`); a saved project
   * approval still allows it. Tighten only.
   */
  webAsk(event: PermissionEvaluation): Promise<void>
  /**
   * Predicted cold tokens (`P_t − W^lo`) of the first step on `providerID` after the session's last switch, for the
   * ledger's `coldExpected` (02 §7.5 step 5, AC-P14); `null` otherwise.
   */
  coldExpected(sessionID: string, providerID: string): number | null
  /**
   * Runs `work` on the session's serial work queue, the one `session.created` pins the root and binds its preset on
   * (`PresetBinding.ensure`, 07 §3.3 두 경로의 순서), behind every event, timer and RPC of the session already queued.
   * A failure rejects only this call; the queue goes on.
   */
  serial<T>(sessionID: string, work: () => Promise<T>): Promise<T>

  binding: RpcTypes.Handler<"session.binding">
  estimate: RpcTypes.Handler<"switch.estimate">
  /**
   * `estimate.request` (09 §5.6): requests priced on a slot no session runs on yet, with the slot's Z, one exchange,
   * its window and the account's remaining quota. Reads only: no PLANNED state, no secret prefetch. Never throws.
   */
  estimateRequest: RpcTypes.Handler<"estimate.request">
  apply: RpcTypes.Handler<"switch.apply">
  schedule: RpcTypes.Handler<"switch.schedule">
  cancel: RpcTypes.Handler<"switch.cancel">
  undo: RpcTypes.Handler<"switch.undo">
  state: RpcTypes.Handler<"switch.state">
  waitReset: RpcTypes.Handler<"switch.waitReset">
  setConfirmOverride: RpcTypes.Handler<"switch.setConfirmOverride">
  policyGet: RpcTypes.Handler<"policy.get">
  policySet: RpcTypes.Handler<"policy.set">
  /** `compaction.setSession` (02 §4.7.4). */
  compactionSet: RpcTypes.Handler<"compaction.setSession">
  approvalGet: RpcTypes.Handler<"session.approval.get">
  approvalSet: RpcTypes.Handler<"session.approval.set">
  /** `cache.state.compaction` of a session (telemetry builds `cache.state`). */
  compactionView(sessionID: string): Promise<Compaction.View | null>
}

/** How often the leader saves the runtime session index (`state\sessions.json`). */
export const SESSIONS_SAVE_MS = 30_000

/** Strategies that send `POST /compact`; a staged revert blocks them (02 §4.7.4). */
const COMPACTING_STRATEGIES: ReadonlySet<Estimate.Strategy> = new Set(["compact-then-switch", "switch-then-compact"])

/** PoC gates (02 §11). */
export interface Gates {
  /**
   * AC-P26 (= 01 G8b) passed: the prompt hook may apply a pending switch on an idle session (02 §5.3 method 2).
   * Until then the hook only turns `delivery` into `"queue"` for busy sessions.
   */
  readonly admissionSwitch: boolean
}

export const GATES: Gates = { admissionSwitch: false }

/** `switchModel` must be confirmed by `session.model.selected` within this time, else FAILED (02 §5.4). */
export const CONFIRM_MS = 30_000
/** COMPACTING gives up after this (02 §5.4). */
export const COMPACT_TIMEOUT_MS = 10 * 60_000
/** The estimator error that raises `estimator_drift` (02 §7.7). */
export const DRIFT = 0.25

type TimerName = "planned" | "compacting" | "idle" | "deadline" | "switching" | "cooldown" | "waitReset"

const STATE_TIMERS: Readonly<Record<Switch.StateName, ReadonlyArray<TimerName>>> = {
  STEADY: [],
  PLANNED: ["planned"],
  WAIT_SAFE: [],
  COMPACTING: ["compacting"],
  SCHEDULED: ["idle", "deadline"],
  SWITCHING: ["switching"],
  COOLDOWN: ["cooldown"],
  BLOCKED: ["waitReset"],
  DELEGATED: [],
  FAILED: [],
}

type BindingReason = Switch.BindingReason

/** What a pending or issued switch carries until it is confirmed and recorded. */
interface Intent {
  readonly strategy: Estimate.Strategy
  readonly reason: BindingReason
  readonly estimate: Estimate.Delta | null
  readonly predictedCold: number | null
  readonly rates: Rates.Rates | undefined
  /** Chosen by the policy, not the user (breaker bookkeeping). */
  readonly auto: boolean
  /** Sent with `switch.suggested{continue:true}` once the automatic switch is confirmed (02 §5.9(g)). */
  readonly suggest?: { readonly reason: Switch.SuggestReason; readonly candidates: ReadonlyArray<Estimate.Candidate> }
  /** 07 §5.5: subagents on another subscription of the target's company are waited for, or (`stop`) interrupted. */
  readonly children?: Switch.Children | undefined
  /** own.team's team account operation: its switch opens no undo window, which would move the team back alone. */
  readonly teamOp?: Switch.TeamOp | undefined
}

interface Expected extends Intent {
  readonly target: Variant.Ref
  readonly previous: Variant.Ref | undefined
  readonly issuedAt: number
}

interface Memory {
  readonly sessionID: SessionID
  state: Switch.State
  queue: Promise<unknown>
  readonly timers: Map<TimerName, () => void>
  /** Intent of the WAIT_SAFE/COMPACTING/SCHEDULED switch (memory only; a restart falls back to defaults). */
  pending: Intent | undefined
  expected: Expected | undefined
  /** Open until the first step after the switch starts (02 §5.8 되돌리기). */
  undo: { readonly previous: Variant.Ref } | undefined
  /** First step on the new slot, for `switch.recorded.actual` and `estimator_drift`. */
  awaiting:
    | {
        readonly providerID: string
        readonly predictedCold: number | null
        readonly rates: Rates.Rates | undefined
        readonly record: RpcTypes.EventBody<"switch.recorded">
      }
    | undefined
  cooldown: { until: number; requestsLeft: number } | undefined
  readonly switches: Hysteresis.SwitchRecord[]
  manualAt: number | undefined
  breakerUntil: number | undefined
  /** Hard/auth classification waiting for the turn to end (02 §5.9(g)). */
  trigger: { readonly reason: "hard" | "auth"; readonly providerID: string; readonly until?: number } | undefined
  /** Where to suggest returning once the home slot resets (02 §5.8). */
  homeReturn: { readonly providerID: string; readonly eligibleAt: number | null } | undefined
}

interface StoredEstimate {
  readonly sessionID: string
  readonly result: Estimate.Result
  readonly expiresAt: number
  readonly epoch: number
  readonly predictedCold: number
  readonly rates: Rates.Rates
}

/** The reason own's web ask carries, so another own hook's extension allow never lifts it (L1/L2). */
const WEB_ASK_MESSAGE = "A web request (fetch or web search) asks first in this conversation."
const decodeState = Schema.decodeUnknownOption(Switch.State)
const encodeState = Schema.encodeSync(Switch.State)
const decodeHome = Schema.decodeUnknownOption(Switch.Home)
const decodeBinding = Schema.decodeUnknownOption(Preset.Binding)
const encodeChildPolicy = Schema.encodeSync(Switch.ChildPolicy)
const toJson = Schema.decodeUnknownSync(Schema.Json)

export function create(deps: Deps, peers: Module.Peers): Api {
  return createWith(deps, peers, GATES)
}

/**
 * {@link create} with explicit PoC gates, for tests of the post-AC-P26 path. `inbox` reads a session's pending inbox
 * (default: self-HTTP to the channel's registered service, `SwitchInbox.reader`).
 */
export function createWith(
  deps: Deps,
  peers: Module.Peers,
  gates: Gates,
  options: { readonly inbox?: SwitchInbox.Reader } = {},
): Api {
  const log = deps.log.child("switching")
  const service: { source?: ServiceTarget.Source } = {}
  const inbox =
    options.inbox ??
    SwitchInbox.reader(() => {
      service.source ??= new ServiceTarget.Service(ServiceTarget.registrationPath(deps.ctx.app.channel))
      return service.source
    }, deps.location.directory)
  // The slot samples are the process's: `estimate.request` at the control Location sizes a slot from every Location.
  const tracker = new Tracker.Store({
    keep: () => peers().slots.core().keepTokens ?? Compaction.KEEP_TOKENS,
    samples: deps.runtime.samples,
  })
  const planner = Planner.create(deps, peers, tracker)
  const sessions = new Map<string, Memory>()
  const compaction = SessionCompaction.create({
    deps,
    peers,
    tracker,
    planner,
    current: (sessionID) => current(sessionID),
    switchCompacting: (sessionID) => sessions.get(sessionID)?.state.state === "COMPACTING",
    emit: (name, body) => emit(name, body),
    inbox,
  })
  const idle = IdleCompaction.create({
    deps,
    peers,
    tracker,
    compaction,
    switchIdle: (sessionID) => {
      const state = sessions.get(sessionID)?.state.state
      return state === undefined || state === "STEADY" || state === "COOLDOWN" || state === "FAILED"
    },
    serial: (sessionID, work) => run(sessionID, () => work()),
  })
  const loading = new Map<string, Promise<Memory>>()
  const estimates = new Map<string, StoredEstimate>()
  const unsubscribe: Array<() => void> = []
  const shared: {
    policy: Policy.File
    stopped: boolean
    recentError: number | null
    rearm: Promise<void> | undefined
  } = { policy: Policy.defaults, stopped: false, recentError: null, rearm: undefined }
  const now = () => deps.clock.now()
  const failed = (what: string) => (error: unknown) => log.error("switching_failed", { what, error })

  // --- memory, queue, persistence ------------------------------------------------------------------------------

  function memory(sessionID: string): Promise<Memory> {
    const found = sessions.get(sessionID)
    if (found) return Promise.resolve(found)
    const pending = loading.get(sessionID)
    if (pending) return pending
    const load = (async () => {
      const stored = await deps.ctx.storage.get(Kv.switchState(sessionID)).catch(() => undefined)
      const created = fresh(sessionID, Option.getOrUndefined(decodeState(stored)))
      sessions.set(sessionID, created)
      loading.delete(sessionID)
      return created
    })()
    loading.set(sessionID, load)
    return load
  }

  function fresh(sessionID: string, state: Switch.State | undefined): Memory {
    return {
      sessionID: SessionID.make(sessionID),
      state: state ?? { state: "STEADY" },
      queue: Promise.resolve(),
      timers: new Map(),
      pending: undefined,
      expected: undefined,
      undo: undefined,
      awaiting: undefined,
      cooldown: state?.state === "COOLDOWN" ? { until: state.until, requestsLeft: state.requestsLeft } : undefined,
      switches: [],
      manualAt: undefined,
      breakerUntil: undefined,
      trigger: undefined,
      homeReturn: undefined,
    }
  }

  /** Serializes work per session: events, timers and RPCs never interleave on one session's state. */
  function run<T>(sessionID: string, work: (m: Memory) => Promise<T>): Promise<T> {
    return memory(sessionID).then((m) => {
      const next = m.queue.then(() => work(m))
      m.queue = next.catch(() => undefined)
      return next
    })
  }

  async function persist(m: Memory) {
    const key = Kv.switchState(m.sessionID)
    if (m.state.state === "STEADY") return deps.ctx.storage.remove(key).catch(failed("kv.remove"))
    return deps.ctx.storage.set(key, toJson(JSON.parse(JSON.stringify(encodeState(m.state))))).catch(failed("kv.set"))
  }

  async function transition(m: Memory, entered: Switch.State) {
    const next = await withAccount(m.sessionID, entered)
    const previous = m.state
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    m.state = next
    if (previous.state !== next.state) disarm(m, ...STATE_TIMERS[previous.state])
    await persist(m)
    emit("switch.state", { sessionID: m.sessionID, state: next.state, detail: next })
  }

  /**
   * A pending switch to `anthropic` names the Claude account it lands on (SL-17): the account the session's tree runs
   * on (the switcher moves the tree before a switch from another company, while the binding still names the old one).
   */
  async function withAccount(sessionID: string, state: Switch.State): Promise<Switch.State> {
    if (
      state.state !== "WAIT_SAFE" &&
      state.state !== "COMPACTING" &&
      state.state !== "SCHEDULED" &&
      state.state !== "SWITCHING"
    )
      return state
    if (state.target.providerID !== Provider.ID.anthropic || !peers().plugins.claudeSlot().detected) return state
    return { ...state, accountID: await peers().claude.accountOf(sessionID) }
  }

  /** The state to rest in: COOLDOWN while it lasts, else STEADY on the current slot. */
  function rest(m: Memory): Switch.State {
    if (m.cooldown && !Hysteresis.cooldownDone(m.cooldown, now()))
      return { state: "COOLDOWN", until: m.cooldown.until, requestsLeft: Math.max(0, m.cooldown.requestsLeft) }
    m.cooldown = undefined
    const model = tracker.get(m.sessionID)?.model
    return model ? { state: "STEADY", slot: Variant.ref(model).providerID } : { state: "STEADY" }
  }

  async function settle(m: Memory) {
    m.pending = undefined
    await transition(m, rest(m))
    if (m.state.state === "COOLDOWN") arm(m, "cooldown", m.state.until, cooldownTick)
  }

  function arm(m: Memory, name: TimerName, at: number, work: (m: Memory) => Promise<void>) {
    m.timers.get(name)?.()
    m.timers.delete(name)
    if (shared.stopped) return
    const cancel = deps.clock.schedule(Math.max(0, at - now()), () => {
      m.timers.delete(name)
      void run(m.sessionID, work).catch(failed(`timer.${name}`))
    })
    m.timers.set(name, cancel)
  }

  function disarm(m: Memory, ...names: ReadonlyArray<TimerName>) {
    for (const name of names) {
      m.timers.get(name)?.()
      m.timers.delete(name)
    }
  }

  function emit<N extends Emitter.SessionEvent>(name: N, body: RpcTypes.EventBody<N>) {
    void deps.emitter.session(name, body)
  }

  function alert(input: Telemetry.AlertInput) {
    try {
      peers().telemetry.alert(input)
    } catch (error) {
      failed("alert")(error)
    }
  }

  function ledger(type: string, m: Memory, ref: Variant.Ref | undefined, data: Record<string, unknown>) {
    void deps.runtime.ledger
      .event({
        eid: `sw_${OwnID.ulid()}`,
        type,
        sessionID: m.sessionID,
        providerID: ref?.providerID ?? null,
        accountID: accountOf(ref, m.sessionID),
        data,
      })
      .catch(failed("ledger"))
  }

  /**
   * The account a model runs on; `anthropic` the Claude account of the session's tree (02 §8.7), `claude-agent` the
   * Claude Agent account of the tree (02 §8.10).
   */
  function accountOf(ref: Variant.Ref | undefined, sessionID?: string): Account.ID | null {
    if (!ref) return null
    if (ref.providerID === "anthropic")
      return sessionID === undefined ? Account.ID.claudeSlot : peers().claude.peek(sessionID)
    if (ref.providerID === "claude-agent") return peers().claudeAgent.peek(sessionID) ?? null
    const slots = peers().slots
    return slots.slot(ref.providerID)?.account.id ?? Store.accountFor(slots.snapshot(), ref.providerID)?.id ?? null
  }

  async function current(sessionID: string): Promise<Variant.Ref | undefined> {
    const known = tracker.get(sessionID)?.model
    if (known) return known
    const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
    if (!info) return undefined
    const session = tracker.ensure(sessionID, now())
    session.model = info.model ?? session.model
    const local = Location.same(info.location.directory, deps.location.directory)
    session.local = session.local || local
    // The lookup places the session, so its location-less events (plugin-host switches) count as local (events.ts).
    if (deps.places.get(sessionID) === undefined) deps.places.learn(sessionID, local)
    if (local) {
      deps.runtime.sessions.update(sessionID, {
        directory: info.location.directory,
        parentID: info.parentID ?? null,
        ...modelFields(info.model),
      })
      // After a restart the staged revert comes from the session itself (02 §4.7.4 "revert").
      const staged = info.revert !== undefined
      if (compaction.revertStaged(sessionID) !== staged) await compaction.setRevert(sessionID, staged)
    }
    return info.model
  }

  function confidence(sessionID: string) {
    return { steps: tracker.steps(sessionID), recentError: shared.recentError }
  }

  /** `cached`: the copy another module or Location already read (setup); changes and `policy.get` read the file. */
  async function loadPolicy(cached?: Policy.File) {
    shared.policy =
      cached ??
      (await deps.runtime.policy.read().catch((error: unknown) => {
        log.warn("policy_unreadable", { error })
        return shared.policy
      }))
  }

  // --- applying a switch ------------------------------------------------------------------------------------------

  /**
   * Safe-point application (02 §5.3 method 1): `wait` for idle, then `switchModel`; SWITCHING until
   * `session.model.selected` confirms it (else FAILED after {@link CONFIRM_MS}).
   */
  async function switchTo(m: Memory, target: Variant.Ref, intent: Intent) {
    const previous = await current(m.sessionID)
    if (Variant.same(previous, target)) {
      await settle(m)
      return m.state
    }
    const issuedAt = now()
    m.pending = undefined
    m.expected = { ...intent, target, previous, issuedAt }
    await transition(m, { state: "SWITCHING", target: Variant.ref(target), issuedAt })
    arm(m, "switching", issuedAt + CONFIRM_MS, async (m) => {
      if (m.state.state !== "SWITCHING") return
      m.expected = undefined
      await transition(m, { state: "FAILED", error: "model_selected_timeout" })
    })
    const ok = await (async () => {
      await deps.ctx.session.wait({ sessionID: m.sessionID })
      await deps.ctx.session.switchModel({ sessionID: m.sessionID, model: plain(target) })
      return true
    })().catch((error: unknown) => {
      log.warn("switch_model_failed", { sessionID: m.sessionID, providerID: target.providerID, error })
      return false
    })
    if (!ok && m.state.state === "SWITCHING") {
      m.expected = undefined
      await transition(m, { state: "FAILED", error: "switch_model_failed" })
    }
    return m.state
  }

  async function applyPending(m: Memory) {
    if (m.state.state !== "WAIT_SAFE") return
    const state = m.state
    const intent = m.pending ?? defaultIntent(state.strategy, state.reason)
    if (await held(m.sessionID, state.target, intent.children)) return
    const switched = await switchTo(m, state.target, intent)
    // A switch-then-compact that waited for a safe point compacts on the target too (5.9(c)).
    if (state.strategy === "switch-then-compact" && switched.state === "SWITCHING")
      await compaction.compact(m.sessionID)
  }

  // --- the session tree (07 §5.5) ---------------------------------------------------------------------------------

  /**
   * 세션 트리 기다리기: the running sessions below `sessionID` (runtime index, written from every local event) whose
   * account is another subscription of the target's company. Switching while they run would have one root use both
   * subscriptions; other companies, metered and local accounts never count, nor the same subscription (the `codex`
   * and `siwc` accounts of one ChatGPT login).
   */
  function rivals(sessionID: string, target: Variant.Ref) {
    const owner = planner.member(target.providerID)
    if (owner?.billing !== "subscription") return []
    const index = deps.runtime.sessions
    const below = (id: string): boolean => {
      const parentID = index.get(id)?.parentID
      return parentID ? parentID === sessionID || below(parentID) : false
    }
    return index.list().flatMap((entry) => {
      if (!(entry.busy || tracker.busy(entry.sessionID)) || entry.providerID === null) return []
      const member = planner.member(entry.providerID)
      return member && Targets.rival(member, owner) && below(entry.sessionID)
        ? [{ sessionID: entry.sessionID, accountID: member.id }]
        : []
    })
  }

  /**
   * Whether a WAIT_SAFE switch to `target` keeps waiting for {@link rivals}; with `children: "stop"` they are
   * interrupted first (`[멈추고 바꾸기]`) and the switch goes on once their runs ended ({@link wake}).
   */
  async function held(sessionID: string, target: Variant.Ref, children: Switch.Children | undefined) {
    const running = rivals(sessionID, target)
    if (children === "stop")
      for (const child of running)
        await deps.ctx.session.interrupt({ sessionID: child.sessionID }).catch(failed("children.stop"))
    return running.length > 0
  }

  /**
   * A run ended: every idle ancestor whose switch waits for its tree checks again. The state is read in the
   * ancestor's queue, behind a `switch.apply` that may be about to enter WAIT_SAFE after seeing this run still busy.
   */
  function wake(sessionID: string) {
    const parentID = deps.runtime.sessions.get(sessionID)?.parentID
    if (!parentID) return
    if (sessions.has(parentID))
      void run(parentID, async (m) => {
        if (m.state.state === "WAIT_SAFE" && !tracker.busy(parentID)) await applyPending(m)
      }).catch(failed("children.idle"))
    wake(parentID)
  }

  /** The root of a session tree: the runtime index first, then session lookups. */
  async function rootOf(sessionID: string): Promise<string> {
    const indexed = deps.runtime.sessions.get(sessionID)
    const parentID = indexed
      ? indexed.parentID
      : (await deps.ctx.session.get({ sessionID }).catch(() => undefined))?.parentID
    return parentID ? rootOf(parentID) : sessionID
  }

  /** The team context own.team stored in the tree root's binding (07 §5.1 `session.preset.apply{team}`). */
  async function teamOf(sessionID: string) {
    const stored = await deps.ctx.storage.get(Kv.preset(await rootOf(sessionID))).catch(() => undefined)
    return Option.getOrUndefined(decodeBinding(stored))?.team
  }

  /**
   * 07 §5.5, 06 §10.1: a team session's switch to another subscription of a company the team has an account of
   * changes the team's account, which only own.team's team account operation (`teamOp`) may do. `verify`: the op must
   * be a running `team-account` op of the session's team, as own.team itself answers ({@link teamOperation}); a
   * `switch.estimate` takes it at its word, since an estimate moves nothing and own.team plans a move
   * (`team.account{dryRun}`) before its op exists. `switch.apply` always verifies.
   */
  async function teamRefusal(
    sessionID: string,
    target: Variant.Ref,
    teamOp: Switch.TeamOp | undefined,
    verify: boolean,
  ) {
    const team = await teamOf(sessionID)
    if (!team || !Targets.outsideTeam(planner.member(target.providerID), team, planner.lookup)) return undefined
    if (teamOp === undefined) return team
    if (!verify) return undefined
    return (await teamOperation(teamOp, team.teamID)) ? undefined : team
  }

  /**
   * Whether own.team runs `opID` as the team account operation of `teamID` now (`ctx.rpc` own.team `op.get`, 07 §8.1
   * "own.team만 넘김"). A made-up id, another team's op, a finished one or no own.team at all reads as none, so no
   * other caller (own-web, a gateway device) gets past the team filter by naming an op.
   */
  async function teamOperation(opID: Switch.TeamOp, teamID: string) {
    const found = await (async () =>
      deps.ctx.rpc(OwnTeam.Definition)["op.get"]({ opID: OwnTeam.OpID.make(opID) }))().catch(() => undefined)
    const op = found?.op
    return op?.kind === "team-account" && op.state === "running" && op.teamID === teamID
  }

  /**
   * KV `sess:<sid>:childPolicy` (02 §5.11 rule 4, 07 §5.5): children on the slot the session left keep it only after a
   * manual switch and only while it stays in the new main's A (another company's subscription, a metered account, a
   * local model); otherwise they follow the main, which the subagent gate does at their next call.
   */
  async function recordChildPolicy(m: Memory, left: Variant.Ref, main: Variant.Ref, reason: BindingReason) {
    const keep = reason === "manual" && inA(left.providerID, main, await teamOf(m.sessionID), m.sessionID)
    const policy: Switch.ChildPolicy = {
      policy: keep ? "keep" : "follow",
      providerID: Variant.ref(left).providerID,
      since: now(),
    }
    await deps.ctx.storage.set(Kv.childPolicy(m.sessionID), toJson(encodeChildPolicy(policy))).catch(failed("kv.child"))
  }

  /** Whether a child on `providerID` passes the main's A: local, or a usable own account R4 allows with the main. */
  function inA(providerID: string, main: Variant.Ref, team: Preset.Team | undefined, sessionID: string) {
    if (Preset.LOCAL_PROVIDERS.some((id) => id === providerID)) return true
    const member = planner.member(providerID)
    if (!member || !planner.usability(peers().slots.slot(providerID)?.account, providerID, sessionID).usable)
      return false
    // The slot as a pinned target, like a configured `agent.model` (`Access.admit`).
    const pinned = {
      group: peers().presets.groupOf(main.providerID) ?? member.kind,
      workers: {
        mode: "single" as const,
        single: { pin: { account: member.id, model: Variant.ref(main).id } },
        roles: {},
      },
    }
    return Preset.allowed(pinned, planner.member(main.providerID)?.id ?? null, planner.lookup, team).ok
  }

  /**
   * own.computer-use's `policy.allowSubagents` (cu-review): without it the plugin refuses children, so they get no
   * computer allow. A missing plugin or a failed call reads as off.
   */
  async function computerSubagents() {
    const status = await (async () => deps.ctx.rpc(OwnComputer.Definition).status({}))().catch(() => undefined)
    return status?.policy?.allowSubagents === true
  }

  /**
   * A new child starts with its parent's session rules (`packages/core/src/session.ts:276`), the computer allow
   * included; it is removed read-merge-write while subagents may not use the computer. own.computer-use's gate and the
   * read-only roles' deny cover the moment before this write.
   */
  async function inheritedComputer(sessionID: string) {
    const rules = (await deps.ctx.session.get({ sessionID })).permissions ?? []
    if (!SessionApproval.hasComputerAllow(rules) || (await computerSubagents())) return
    await deps.ctx.session.update({
      sessionID,
      permissions: SessionApproval.withComputerUse(rules, "off", protectedPaths()),
    })
  }

  async function onModelSelected(m: Memory, model: Variant.Ref, previous: Variant.Ref | undefined) {
    const expected = m.expected
    const target = Variant.ref(model)
    const from = previous ? Variant.ref(previous) : null
    if (!expected || !Variant.same(expected.target, model)) return external(m, target, from)
    m.expected = undefined
    disarm(m, "switching")
    emit("binding.changed", {
      sessionID: m.sessionID,
      model: target,
      previous: from,
      accountID: accountOf(model, m.sessionID),
      reason: expected.reason,
      external: false,
    })
    await setHome(m.sessionID, model, false)
    if (expected.reason === "pin") return
    if (expected.reason === "undo") {
      m.switches.pop()
      m.cooldown = undefined
      m.awaiting = undefined
      ledger("switch.undo", m, model, { from, to: target })
      return settle(m)
    }
    const at = now()
    const reason = switchReason(expected.reason)
    const record: RpcTypes.EventBody<"switch.recorded"> = {
      sessionID: m.sessionID,
      from,
      to: target,
      strategy: expected.strategy,
      reason,
      estimate: expected.estimate,
    }
    emit("switch.recorded", record)
    ledger("switch", m, model, {
      from,
      to: target,
      strategy: expected.strategy,
      reason,
      auto: expected.auto,
      estimate: expected.estimate,
      predictedCold: expected.predictedCold,
    })
    m.undo = expected.previous && expected.teamOp === undefined ? { previous: expected.previous } : undefined
    const left = previous ?? expected.previous
    if (left && left.providerID !== model.providerID) await recordChildPolicy(m, left, model, expected.reason)
    m.awaiting = {
      providerID: model.providerID,
      predictedCold: expected.predictedCold,
      rates: expected.rates,
      record,
    }
    m.switches.push({ at, from: previous?.providerID ?? null, to: model.providerID, auto: expected.auto })
    if (m.switches.length > 20) m.switches.shift()
    if (!expected.auto) m.manualAt = at
    m.cooldown = Hysteresis.cooldown(shared.policy.hysteresis, at)
    await settle(m)
    if (expected.suggest)
      emit("switch.suggested", {
        sessionID: m.sessionID,
        reason: expected.suggest.reason,
        candidates: [...expected.suggest.candidates],
        continue: true,
      })
    if (expected.auto) tripBreaker(m)
  }

  /** Another client called `POST /api/session/:id/model` (02 §5.4 외부 전환 감지): record it, never block it. */
  async function external(m: Memory, model: Model.Ref, previous: Model.Ref | null) {
    emit("binding.changed", {
      sessionID: m.sessionID,
      model,
      previous,
      accountID: accountOf(model, m.sessionID),
      reason: "external",
      external: true,
    })
    ledger("switch.external", m, model, { from: previous, to: model })
    await setHome(m.sessionID, model, false)
    m.undo = undefined
    m.awaiting = undefined
    m.manualAt = now()
    if (m.state.state !== "SWITCHING") await settle(m)
  }

  function tripBreaker(m: Memory) {
    const reason = Hysteresis.breaker({
      hysteresis: shared.policy.hysteresis,
      switches: m.switches,
      manualAt: m.manualAt,
      colds: tracker.colds(m.sessionID, now()),
      P: tracker.P(m.sessionID),
      now: now(),
    })
    if (!reason) return
    m.breakerUntil = now() + shared.policy.hysteresis.breakerOpenMinutes * 60_000
    alert({
      code: "flap",
      severity: "warning",
      sessionID: m.sessionID,
      message:
        reason === "cold_sum"
          ? "최근 15분 동안 캐시 재작성이 커서 자동 전환을 30분 멈춥니다(prefix 변동 의심)."
          : "자동 전환이 반복되어 30분 동안 제안만 합니다.",
    })
  }

  async function setHome(sessionID: string, model: Variant.Ref, pinned: boolean) {
    const key = Kv.home(sessionID)
    const existing = Option.getOrUndefined(decodeHome(await deps.ctx.storage.get(key).catch(() => undefined)))
    if (existing && !pinned) return
    await deps.ctx.storage
      .set(key, toJson({ providerID: model.providerID, pinned, since: now() }))
      .catch(failed("kv.home"))
  }

  // --- event reactions ---------------------------------------------------------------------------------------------

  async function onIdle(m: Memory) {
    const trigger = m.trigger
    m.trigger = undefined
    if (trigger) return autoPlan(m, trigger)
    if (m.state.state === "WAIT_SAFE") return applyPending(m)
    if (m.state.state === "SCHEDULED") armIdle(m)
    return homeCheck(m)
  }

  async function onStepStarted(m: Memory) {
    m.undo = undefined
    if (m.cooldown) {
      m.cooldown.requestsLeft = Math.max(0, m.cooldown.requestsLeft - 1)
      if (m.state.state === "COOLDOWN") {
        m.state = { ...m.state, requestsLeft: m.cooldown.requestsLeft }
        if (Hysteresis.cooldownDone(m.cooldown, now())) await settle(m)
      }
    }
    if (m.state.state === "SCHEDULED") armIdle(m)
  }

  async function onStepEnded(m: Memory, step: Tracker.StepEnd) {
    const awaiting = m.awaiting
    if (!awaiting || awaiting.providerID !== step.model.providerID) return
    m.awaiting = undefined
    const rates = awaiting.rates
    const unit = rates?.unit ?? awaiting.record.estimate?.unit ?? "USD"
    const cold = rates?.cold ?? null
    emit("switch.recorded", {
      ...awaiting.record,
      actual: { cold: cold === null ? step.cold : Estimator.round(Estimator.cost(step.cold, cold)), unit },
    })
    ledger("switch.actual", m, step.model, { coldTokens: step.cold, predictedCold: awaiting.predictedCold })
    if (awaiting.predictedCold === null || step.cold <= 0) return
    const error = Math.abs(awaiting.predictedCold - step.cold) / step.cold
    shared.recentError = Estimator.round(error)
    if (error > DRIFT)
      alert({
        code: "estimator_drift",
        severity: "info",
        sessionID: m.sessionID,
        message: `전환 추정 cold ${awaiting.predictedCold} 대 실측 ${step.cold} 토큰(오차 ${Math.round(error * 100)}%).`,
      })
  }

  async function onCompacted(m: Memory) {
    const state = m.state
    if (state.state === "COMPACTING") {
      const intent = m.pending ?? defaultIntent("compact-then-switch", "manual")
      m.pending = intent
      await transition(m, {
        state: "WAIT_SAFE",
        target: state.target,
        strategy: "compact-then-switch",
        reason: switchReason(intent.reason),
      })
      if (!tracker.busy(m.sessionID)) await applyPending(m)
      return
    }
    if (state.state === "SCHEDULED" && state.trigger !== "idle_ttl") {
      m.pending = m.pending ?? defaultIntent("cold-point", "manual")
      await transition(m, { state: "WAIT_SAFE", target: state.target, strategy: "cold-point", reason: "manual" })
      if (!tracker.busy(m.sessionID)) await applyPending(m)
      return
    }
    await homeCheck(m)
  }

  async function onCompactionFailed(m: Memory) {
    if (m.state.state !== "COMPACTING") return
    const target = m.state.target
    alert({
      code: "compaction_failed",
      severity: "warning",
      sessionID: m.sessionID,
      message: "압축이 실패했습니다. 지금 전환할까요?",
    })
    await replan(m, target, switchReason(m.pending?.reason ?? "manual"))
  }

  /** PLANNED again with a fresh estimate (COMPACTING failure or timeout, SCHEDULED deadline). */
  async function replan(m: Memory, target: Variant.Ref, reason: Switch.Reason) {
    const currentRef = await current(m.sessionID)
    const planned = await planner.planFor({
      sessionID: m.sessionID,
      current: currentRef,
      target,
      reason,
      policy: shared.policy,
    })
    const result = planner.result(planned, confidence(m.sessionID))
    remember(m.sessionID, result, planned.plan.predictedCold, planned.targetSide.rates)
    m.pending = undefined
    await transition(m, {
      state: "PLANNED",
      estimateID: result.estimateID,
      target: Variant.ref(target),
      options: result.options,
      reason,
      expiresAt: result.expiresAt,
    })
    arm(m, "planned", result.expiresAt, expirePlan)
  }

  async function expirePlan(m: Memory) {
    if (m.state.state === "PLANNED" && m.state.expiresAt <= now()) await settle(m)
  }

  async function cooldownTick(m: Memory) {
    if (m.state.state !== "COOLDOWN" || !m.cooldown) return
    if (Hysteresis.cooldownDone(m.cooldown, now())) await settle(m)
  }

  // --- automatic triggers (02 §5.9(g)) ---------------------------------------------------------------------------

  function mode(source: Planner.Resolved, target: Planner.Resolved): Policy.SwitchMode {
    const auto = shared.policy.autoSwitch
    // Never onto the Claude slot or the Claude Agent route (02 §8.10, CAG-3: it moves by hand only).
    if (target.kind === "claude-sub" || target.kind === "claude-agent") return "off"
    const sourceSubscription = source.side.billing === "subscription"
    const targetSubscription = target.side.billing === "subscription"
    if (sourceSubscription) return targetSubscription ? auto.subscriptionToSubscription : auto.subscriptionToApi
    if (targetSubscription) return "ask"
    const allowed = source.account?.autoSwitch === true && target.account?.autoSwitch === true
    return auto.apiToApi === "auto" && !allowed ? "ask" : auto.apiToApi
  }

  async function autoPlan(m: Memory, trigger: NonNullable<Memory["trigger"]>) {
    const currentRef = await current(m.sessionID)
    if (!currentRef || currentRef.providerID !== trigger.providerID) return
    const source = await planner.resolve(currentRef, m.sessionID)
    const found = await planner.candidates({
      sessionID: m.sessionID,
      current: currentRef,
      reason: trigger.reason,
      policy: shared.policy,
      exclude: (target) => (mode(source, target) === "off" ? "policy_off" : undefined),
      team: await teamOf(m.sessionID),
    })
    if (trigger.reason === "hard")
      m.homeReturn = { providerID: currentRef.providerID, eligibleAt: trigger.until ?? null }
    const candidates = found.ranked.map(Planner.candidate)
    const best = found.ranked.find((item) => item.excludedReason === undefined)
    if (!best || !best.target) {
      await transition(m, {
        state: "BLOCKED",
        reason: trigger.reason === "auth" ? "auth_failed" : "all_exhausted",
        nextResetAt: trigger.until ?? null,
      })
      return
    }
    const resolved = found.resolved.find((item) => item.ref.providerID === best.providerID)
    const breakerOpen = (m.breakerUntil ?? 0) > now()
    const auto = resolved !== undefined && mode(source, resolved) === "auto" && !breakerOpen
    const target = best.target
    if (auto) {
      const planned = await planner.planFor({
        sessionID: m.sessionID,
        current: currentRef,
        target,
        reason: trigger.reason,
        policy: shared.policy,
      })
      m.pending = {
        strategy: "now",
        reason: trigger.reason,
        estimate: planned.plan.deltaNow,
        predictedCold: planned.plan.predictedCold,
        rates: planned.targetSide.rates,
        auto: true,
        suggest: { reason: trigger.reason, candidates },
      }
      await transition(m, { state: "WAIT_SAFE", target, strategy: "now", reason: trigger.reason })
      if (!tracker.busy(m.sessionID)) await applyPending(m)
      return
    }
    await replan(m, target, trigger.reason)
    emit("switch.suggested", { sessionID: m.sessionID, reason: trigger.reason, candidates, continue: true })
  }

  /** Suggests returning home once its reset passed (02 §5.8); never switches back by itself. */
  async function homeCheck(m: Memory) {
    const home = m.homeReturn
    // Without a known reset time the home slot is never suggested: it may still be exhausted.
    if (!home || home.eligibleAt === null || home.eligibleAt > now()) return
    const currentRef = await current(m.sessionID)
    const team = await teamOf(m.sessionID)
    // A team that moved off its old account never returns there alone (07 §5.5 팀 거르기).
    if (
      !currentRef ||
      currentRef.providerID === home.providerID ||
      (team && Targets.outsideTeam(planner.member(home.providerID), team, planner.lookup))
    ) {
      m.homeReturn = undefined
      return
    }
    const resolved = await planner.resolve({ providerID: home.providerID, id: currentRef.id }, m.sessionID)
    if (!planner.usability(resolved.account, home.providerID, m.sessionID, resolved.ref.id).usable) return
    m.homeReturn = undefined
    emit("switch.suggested", {
      sessionID: m.sessionID,
      reason: "home_available",
      candidates: [
        {
          providerID: resolved.ref.providerID,
          accountID: resolved.account?.id ?? null,
          target: resolved.ref,
          score: null,
          deltaNow: null,
          perRequest: null,
          headroom: null,
        },
      ],
      continue: false,
    })
  }

  // --- scheduling (02 §5.9(d)) ------------------------------------------------------------------------------------

  function armIdle(m: Memory) {
    const state = m.state
    if (state.state !== "SCHEDULED" || state.trigger === "compaction") return
    const last = tracker.get(m.sessionID)?.lastActivity ?? now()
    arm(m, "idle", Math.max(now(), last) + state.idleMinutes * 60_000, async (m) => {
      if (m.state.state !== "SCHEDULED") return
      if (tracker.busy(m.sessionID)) return armIdle(m)
      const scheduled = m.state
      m.pending = m.pending ?? defaultIntent("cold-point", "manual")
      await transition(m, { state: "WAIT_SAFE", target: scheduled.target, strategy: "cold-point", reason: "manual" })
      await applyPending(m)
    })
  }

  async function scheduleIn(
    m: Memory,
    input: {
      readonly target: Variant.Ref
      readonly trigger: Estimate.ScheduleTrigger
      readonly idleMinutes: number
      readonly uncertain: boolean
      readonly deadline: number
    },
  ) {
    m.manualAt = now()
    const target = Variant.ref(input.target)
    m.pending = defaultIntent("cold-point", "manual")
    await transition(m, {
      state: "SCHEDULED",
      target,
      trigger: input.trigger,
      idleMinutes: input.idleMinutes,
      uncertain: input.uncertain,
      deadline: input.deadline,
    })
    arm(m, "deadline", input.deadline, async (m) => {
      if (m.state.state !== "SCHEDULED") return
      await replan(m, m.state.target, "manual")
    })
    armIdle(m)
    emit("switch.scheduled", {
      sessionID: m.sessionID,
      target,
      trigger: input.trigger,
      idleMinutes: input.idleMinutes,
      uncertain: input.uncertain,
      deadline: input.deadline,
    })
  }

  async function scheduleDefaults(
    sessionID: string,
    input: { readonly idleMinutes?: number; readonly deadlineMinutes?: number },
  ) {
    const currentRef = await current(sessionID)
    const source = currentRef ? await planner.resolve(currentRef, sessionID) : undefined
    const ttlHi = source?.side.rates.ttlHi ?? null
    const idleMinutes =
      input.idleMinutes ?? (ttlHi !== null ? Math.ceil(ttlHi / 60) : shared.policy.thresholds.unknownTtlIdleMinutes)
    const uncertain = input.idleMinutes === undefined && ttlHi === null
    const deadlineMinutes =
      input.deadlineMinutes ?? Math.max(shared.policy.thresholds.scheduleDeadlineMinMinutes, 2 * idleMinutes)
    return { idleMinutes, uncertain, deadlineMinutes }
  }

  // --- waitReset (02 §5.9(i)) -------------------------------------------------------------------------------------

  async function resume(m: Memory) {
    const state = m.state
    if (state.state !== "BLOCKED" || !state.waitReset) return
    const message = state.waitReset.message
    // The source tells own.team's feed this is not the user typing (06 §5.4, §10.4 #2).
    const sent = await deps.ctx.session
      .prompt({ sessionID: m.sessionID, text: message, metadata: { source: "own.accounts" } })
      .then(() => true)
      .catch((error: unknown) => {
        log.warn("wait_reset_prompt_failed", { sessionID: m.sessionID, error })
        return false
      })
    if (!sent) return transition(m, { state: "BLOCKED", reason: state.reason, nextResetAt: state.nextResetAt })
    ledger("switch.resume", m, undefined, { resumeAt: state.waitReset.resumeAt })
    return settle(m)
  }

  // --- restart (02 §5.4 "재시작 뒤 다시 평가") ------------------------------------------------------------------------

  async function rearm() {
    const scan = async (after?: string): Promise<void> => {
      if (shared.stopped) return
      const page = await deps.ctx.storage.scan({ prefix: "sess:", after, limit: 1000 })
      for (const entry of page.entries) {
        if (shared.stopped) return
        if (!entry.key.endsWith(":switch")) continue
        const state = Option.getOrUndefined(decodeState(entry.value))
        if (!state || state.state === "STEADY") continue
        const sessionID = entry.key.slice("sess:".length, -":switch".length)
        const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
        if (!info || !Location.same(info.location.directory, deps.location.directory)) continue
        const followed = tracker.ensure(sessionID, now())
        followed.local = true
        deps.places.learn(sessionID, true)
        followed.model = info.model ?? followed.model
        await run(sessionID, (m) => revive(m, state)).catch(failed("rearm"))
      }
      if (page.next) return scan(page.next)
    }
    await scan()
  }

  async function revive(m: Memory, state: Switch.State) {
    m.state = state
    const at = now()
    switch (state.state) {
      case "WAIT_SAFE":
        return applyPending(m)
      case "SCHEDULED":
        if (state.deadline <= at) return replan(m, state.target, "manual")
        arm(m, "deadline", state.deadline, async (m) => {
          if (m.state.state === "SCHEDULED") await replan(m, m.state.target, "manual")
        })
        return armIdle(m)
      case "COMPACTING":
        return arm(m, "compacting", state.requestedAt + state.timeout, compactTimeout)
      case "SWITCHING": {
        const model = await current(m.sessionID)
        if (Variant.same(model, state.target)) {
          m.cooldown = Hysteresis.cooldown(shared.policy.hysteresis, at)
          return settle(m)
        }
        return transition(m, { state: "FAILED", error: "restarted_while_switching" })
      }
      case "COOLDOWN":
        m.cooldown = { until: state.until, requestsLeft: state.requestsLeft }
        return arm(m, "cooldown", state.until, cooldownTick)
      case "PLANNED":
        if (state.expiresAt <= at) return settle(m)
        return arm(m, "planned", state.expiresAt, expirePlan)
      case "BLOCKED": {
        const wait = state.waitReset
        if (!wait) return
        if (wait.resumeAt > at) return arm(m, "waitReset", wait.resumeAt, resume)
        emit("switch.suggested", { sessionID: m.sessionID, reason: "reset_passed", candidates: [], continue: true })
        return settle(m)
      }
      case "DELEGATED":
        return settle(m)
      default:
        return
    }
  }

  async function compactTimeout(m: Memory) {
    if (m.state.state !== "COMPACTING") return
    alert({
      code: "compaction_failed",
      severity: "warning",
      sessionID: m.sessionID,
      message: "압축이 10분 안에 끝나지 않았습니다. 지금 전환할까요?",
    })
    await replan(m, m.state.target, switchReason(m.pending?.reason ?? "manual"))
  }

  function remember(sessionID: string, result: Estimate.Result, predictedCold: number, rates: Rates.Rates) {
    const at = now()
    for (const [id, stored] of estimates) if (stored.expiresAt <= at) estimates.delete(id)
    estimates.set(result.estimateID, {
      sessionID,
      result,
      expiresAt: result.expiresAt,
      epoch: tracker.epoch(sessionID),
      predictedCold,
      rates,
    })
  }

  function react(event: Module.OpenCodeEvent, step: Tracker.StepEnd | undefined) {
    switch (event.type) {
      case "session.created": {
        const model = event.data.model
        // Child sessions (subagents) are left to core's inheritance (02 Q10) and follow their root's preset (07 §2.8);
        // only top-level sessions are pinned and bound.
        const parentID = event.data.parentID
        const sessionID = event.data.sessionID
        if (parentID !== undefined) {
          void addChild(parentID, sessionID).catch(failed("children"))
          void inheritedComputer(sessionID).catch(failed("children.computer"))
        }
        return {
          sessionID,
          work: async (m: Memory) => {
            if (model) await setHome(m.sessionID, model, false)
            if (parentID !== undefined) return
            // In this queue after the pin, so a `session.preset.apply` queued here later always wins (07 §3.3).
            const ref = model ?? (await pin(m))
            if (ref) await PresetBinding.ensure(deps, peers, m.sessionID, ref).catch(failed("preset.binding"))
          },
        }
      }
      case "session.model.selected": {
        const data = event.data
        return { sessionID: data.sessionID, work: (m: Memory) => onModelSelected(m, data.model, data.previous) }
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        // After `index`: this run no longer counts for an ancestor's switch waiting for its tree (07 §5.5).
        wake(event.data.sessionID)
        return { sessionID: event.data.sessionID, work: onIdle }
      case "session.step.started":
        return { sessionID: event.data.sessionID, work: onStepStarted }
      case "session.step.ended":
      case "session.step.failed": {
        const sessionID = event.data.sessionID
        return {
          sessionID,
          work: async (m: Memory) => {
            if (step) await onStepEnded(m, step)
            // After the state machine: a COMPACTING switch owns the next compaction (02 §4.7.4).
            await compaction.check(sessionID)
          },
        }
      }
      case "session.compaction.started":
        return { sessionID: event.data.sessionID, work: (m: Memory) => compaction.started(m.sessionID) }
      case "session.compaction.ended":
        return { sessionID: event.data.sessionID, work: onCompacted }
      case "session.compaction.failed":
        return { sessionID: event.data.sessionID, work: onCompactionFailed }
      case "session.revert.staged":
        return { sessionID: event.data.sessionID, work: (m: Memory) => compaction.setRevert(m.sessionID, true) }
      case "session.revert.cleared":
      case "session.revert.committed":
        // Committed: telemetry moves the cold point epoch and re-baselines the cache state (02 §4.7.4).
        return {
          sessionID: event.data.sessionID,
          work: async (m: Memory) => {
            await compaction.setRevert(m.sessionID, false)
            await compaction.clearDue(m.sessionID)
          },
        }
      default:
        return undefined
    }
  }

  /**
   * The runtime session index (accounts.list `sessions`, remove plan, compaction impact), written by the instance of
   * the session's Location from the events it observes.
   */
  /**
   * A context reset or its undo (11 §7): a cold point in the tracker, and the index's P unmeasured until the next step
   * (the meter shows `—`). An undo the tracker cannot size (its reset came before this process) is sized from the
   * session's history meanwhile, so a switch estimate never takes the restored context as empty.
   */
  function cold(point: Resets.ColdPoint) {
    tracker.cold(point, now())
    deps.runtime.sessions.update(point.sessionID, { P: null })
    if (point.kind !== "undo" || tracker.estimated(point.sessionID)) return
    void deps.ctx.session
      .context({ sessionID: point.sessionID })
      .then((messages) => {
        const P = Resets.restoredSize(messages, point.resetID)
        if (P !== undefined) tracker.estimate(point.sessionID, P)
      })
      .catch(failed("reset.estimate"))
  }

  function index(event: Module.OpenCodeEvent) {
    const sessions = deps.runtime.sessions
    switch (event.type) {
      case "session.created":
        sessions.update(event.data.sessionID, {
          directory: event.data.location.directory,
          parentID: event.data.parentID ?? null,
          ...modelFields(event.data.model),
        })
        return
      case "session.model.selected":
        sessions.update(event.data.sessionID, modelFields(event.data.model))
        return
      case "session.moved":
        sessions.update(event.data.sessionID, { directory: event.data.location.directory })
        return
      case "session.execution.started":
        sessions.update(event.data.sessionID, { busy: true })
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        sessions.update(event.data.sessionID, { busy: false })
        return
      case "session.step.started":
        sessions.update(event.data.sessionID, modelFields(event.data.model))
        return
      case "session.step.ended":
      case "session.compaction.ended":
        if (tracker.measured(event.data.sessionID))
          sessions.update(event.data.sessionID, { P: tracker.P(event.data.sessionID) })
        return
      case "session.revert.staged":
        sessions.update(event.data.sessionID, { revertStaged: true })
        return
      case "session.revert.cleared":
      case "session.revert.committed":
        sessions.update(event.data.sessionID, { revertStaged: false })
        return
      case "session.deleted":
        sessions.remove(event.data.sessionID)
        return
      default:
        return
    }
  }

  /** KV `sess:<parent>:children` (02 §2.4.6): the plugin session API has no child listing. */
  async function addChild(parentID: string, childID: string) {
    const key = Kv.children(parentID)
    const stored = Option.getOrUndefined(decodeChildren(await deps.ctx.storage.get(key).catch(() => undefined))) ?? []
    if (stored.includes(childID)) return
    await deps.ctx.storage.set(key, toJson([...stored, childID].slice(-MAX_CHILDREN)))
  }

  async function children(parentID: string) {
    const stored = await deps.ctx.storage.get(Kv.children(parentID)).catch(() => undefined)
    const known = deps.runtime.sessions.children(parentID).map((entry) => entry.sessionID)
    return [...new Set([...(Option.getOrUndefined(decodeChildren(stored)) ?? []), ...known])]
  }

  /**
   * Children that have not finished (03 §18.8: finished ones are left alone): running now, or never through a run
   * (`Session.Info.outcome` is set when a run reaches a terminal state).
   */
  async function openChildren(parentID: string) {
    const found = await Promise.all(
      (await children(parentID)).map(async (childID) => {
        if (deps.runtime.sessions.get(childID)?.busy) return [childID]
        const info = await deps.ctx.session.get({ sessionID: childID }).catch(() => undefined)
        return info && info.outcome === undefined ? [childID] : []
      }),
    )
    return found.flat()
  }

  /** Protected resources of the approval bundles (01 §13), from this process's layout and env. */
  function protectedPaths() {
    return SessionApproval.protectedPaths(
      SessionApproval.protectedInput({
        home: deps.runtime.layout.root,
        userHome: os.homedir(),
        env: process.env,
        registry: peers().slots.snapshot(),
      }),
    )
  }

  /** `policy.get` view: the stored policy plus the config file's `keep` (never stored in policy.json). */
  function policyView(policy: Policy.File, keep: number | null): Policy.File {
    return {
      ...policy,
      compaction: {
        byKind: policy.compaction?.byKind ?? {},
        ...(keep !== null && keep > 0 ? { keepTokens: keep } : {}),
        ...(policy.compaction?.idle === undefined ? {} : { idle: policy.compaction.idle }),
      },
    }
  }

  /**
   * 01 §8.5, 07 §2.2: a session another client created without a model (TUI, `own run`) is pinned before its first
   * step, so the default's variant costs nothing: to the model the user configured when it is usable, else to the
   * group default of the new-session account, else (no account at all) to core's default model. Returns the model it
   * pinned, `undefined` when it could not.
   */
  async function pin(m: Memory) {
    const [fallback, listed] = await Promise.all([
      deps.ctx.model.default().catch(() => undefined),
      deps.ctx.model.list().catch(() => undefined),
    ])
    const model = fallback?.data
    const account = model && configured(model, listed?.data[0]) ? undefined : newSessionAccount()
    const grouped = account ? await peers().presets.defaultFor(account) : undefined
    const target = grouped ?? (model ? { providerID: model.providerID, id: model.id } : undefined)
    if (!target) {
      alert({
        code: "unpinned_session",
        severity: "warning",
        sessionID: m.sessionID,
        message: "기본 모델이 없어 세션을 계정에 고정하지 못했습니다.",
      })
      return
    }
    m.expected = { ...defaultIntent("now", "pin"), target, previous: undefined, issuedAt: now() }
    return deps.ctx.session.switchModel({ sessionID: m.sessionID, model: target }).then(
      () => target,
      (error: unknown) => {
        m.expected = undefined
        log.warn("pin_failed", { sessionID: m.sessionID, error })
        return undefined
      },
    )
  }

  /**
   * Whether core's default model is the user's usable choice (07 §2.2 "쓸 수 있으면"): core answers the configured
   * `model` when it is enabled and the first available model otherwise, so a different answer was configured; the own
   * global config's `model` settles the case where both are the same model. A configured model whose account cannot
   * serve now (exhausted, auth failed) yields to the new-session account rule.
   */
  function configured(model: Variant.Ref, first: Variant.Ref | undefined) {
    const chosen =
      peers().slots.core().model === `${model.providerID}/${model.id}` ||
      first === undefined ||
      first.providerID !== model.providerID ||
      first.id !== model.id
    return (
      chosen &&
      planner.usability(
        Store.accountFor(peers().slots.snapshot(), model.providerID),
        model.providerID,
        undefined,
        model.id,
      ).usable
    )
  }

  /**
   * The account of a new session (07 §2.2 rule 3), the same rule as own-web's composer (`newSessionAccount`): the
   * kind's default account (`policy.defaults.byKind`) of the most recent top-level session's account, else that
   * account, each only when it can serve now; else the first account in order that can (own accounts, then the Claude
   * slot when its models are enabled).
   */
  function newSessionAccount(): PresetStore.Target | undefined {
    const registry = peers().slots.snapshot()
    const claude = peers().plugins.claudeSlot()
    const usable = (providerID: string): PresetStore.Target | undefined => {
      if (providerID === Provider.ID.anthropic)
        return claude.detected && claude.verified && planner.usability(undefined, providerID).usable
          ? { kind: "claude-sub", providerID }
          : undefined
      const account = Store.accountFor(registry, providerID)
      return account && planner.usability(account, providerID).usable ? account : undefined
    }
    const latest =
      deps.runtime.sessions.list().findLast((entry) => entry.parentID === null && entry.providerID !== null)
        ?.providerID ?? undefined
    const kind = latest === undefined ? undefined : Store.accountFor(registry, latest)?.kind
    const named = kind === undefined ? undefined : shared.policy.defaults.byKind[kind]
    const preferred = named === undefined ? undefined : registry.accounts.find((account) => account.id === named)
    return (
      (preferred && usable(preferred.providerID)) ??
      (latest === undefined ? undefined : usable(latest)) ??
      [...registry.accounts.map((account) => account.providerID), Provider.ID.anthropic]
        .map(usable)
        .find((target) => target !== undefined)
    )
  }

  // --- API --------------------------------------------------------------------------------------------------------

  return {
    start: async () => {
      await loadPolicy(deps.runtime.policy.cached())
      // PG6 (07 §6.2 #9–#11, §2.2): an older build's advice thresholds and `defaults.global` leave the file once.
      if (deps.runtime.isLeader() && !deps.remote && PolicyRules.prune(shared.policy))
        shared.policy = await deps.runtime.policy.update(PolicyRules.prune).catch((error: unknown) => {
          failed("policy.prune")(error)
          return shared.policy
        })
      // CAG-5: a stored automatic Claude-to-Claude switch is turned off once (the app tells the user once).
      if (deps.runtime.isLeader() && !deps.remote && PolicyRules.migrate(shared.policy, deps.clock.now()))
        shared.policy = await deps.runtime.policy
          .update((file) => PolicyRules.migrate(file, deps.clock.now()))
          .then((file) => {
            if (file.migrated?.claudeToClaudeOff?.changed) log.info("claude_to_claude_off", {})
            return file
          })
          .catch((error: unknown) => {
            failed("policy.migrate")(error)
            return shared.policy
          })
      unsubscribe.push(
        deps.runtime.broadcast.on("store.changed", (payload) => {
          if (payload.store === "policy") void loadPolicy()
          if (payload.store === "ratecards") void deps.runtime.ratecards.read().catch(failed("ratecards"))
        }),
        deps.runtime.broadcast.on("exhausted", (payload) => {
          const sessionID = payload.sessionID
          if (sessionID === undefined || tracker.get(sessionID)?.local !== true) return
          const reason = payload.exhaustion.class
          if (reason !== "hard" && reason !== "auth") return
          // A Claude account the conversation no longer runs on (02 §8.8: its tree moved to another one) is not its.
          if (
            payload.providerID === Provider.ID.anthropic &&
            payload.exhaustion.accountID !== peers().claude.peek(sessionID)
          )
            return
          void run(sessionID, async (m) => {
            m.trigger = { reason, providerID: payload.providerID, until: payload.exhaustion.until }
            if (!tracker.busy(sessionID)) await onIdle(m)
          }).catch(failed("exhausted"))
        }),
      )
      shared.rearm = rearm().catch(failed("rearm"))
      const save = () => {
        const cancel = deps.clock.schedule(SESSIONS_SAVE_MS, () => {
          const at = unsubscribe.indexOf(cancel)
          if (at >= 0) unsubscribe.splice(at, 1)
          if (shared.stopped) return
          if (deps.runtime.isLeader()) void deps.runtime.sessions.save().catch(failed("sessions.save"))
          save()
        })
        unsubscribe.push(cancel)
      }
      save()
    },
    stop: async () => {
      shared.stopped = true
      idle.stop()
      for (const cancel of unsubscribe.splice(0)) cancel()
      for (const m of sessions.values()) disarm(m, ...m.timers.keys())
      await shared.rearm
    },
    onEvent: (event, meta) => {
      // Location-less events of a known local session (plugin-host switches) already arrive as local (events.ts).
      if (!meta.local) return
      if (meta.reset) cold(meta.reset)
      // A reset leaves nothing to compact: core settles every compaction pending at its delivery, admitted before it or
      // behind it, as not needed (cancelled, 11 §7.2), so a compact-then-switch waiting for one switches now, as after
      // `compaction.ended`.
      if (meta.reset?.kind === "reset")
        void run(meta.reset.sessionID, async (m) => {
          if (m.state.state === "COMPACTING") await onCompacted(m)
        }).catch(failed("reset"))
      const step = tracker.observe(event, now())
      index(event)
      idle.onEvent(event)
      const reaction = react(event, step)
      if (reaction) void run(reaction.sessionID, reaction.work).catch(failed(event.type))
    },
    // A lost reset delivery or compaction end must not hold `compaction.due` (its check reads both back).
    onResubscribe: () => tracker.resubscribed(),
    onPrompt: async (event) => {
      // The prompt hook runs in the session's Location.
      if (deps.places.get(event.sessionID) === undefined) deps.places.learn(event.sessionID, true)
      tracker.prompt(event.sessionID, event.prompt.text, now())
      idle.prompted(event.sessionID)
      const m = await memory(event.sessionID)
      if (m.state.state === "SCHEDULED") void run(event.sessionID, async (m) => armIdle(m)).catch(failed("prompt"))
      if (m.state.state !== "WAIT_SAFE" && m.state.state !== "COMPACTING") return
      const session = tracker.get(event.sessionID)
      if (session?.busy || session?.compacting) {
        event.delivery = "queue"
        return
      }
      if (gates.admissionSwitch && m.state.state === "WAIT_SAFE") await run(event.sessionID, applyPending)
    },
    onRetry: async (event, verdict) => {
      if (verdict.class !== "hard" && verdict.class !== "auth") return
      const providerID = event.model.providerID
      const slots = peers().slots
      if (!slots.slot(providerID) && !Store.accountFor(slots.snapshot(), providerID)) return
      const m = await memory(event.sessionID)
      // Phase 3 `inTurnFailover` (02 §5.9(h), AC-P17b) is not implemented: the turn ends and the idle path plans.
      m.trigger = {
        reason: verdict.class,
        providerID,
        ...(verdict.until === undefined ? {} : { until: verdict.until }),
      }
    },
    isBusy: (sessionID) => tracker.busy(sessionID),
    idleCompaction: (sessionID) => idle.origin(sessionID),
    webAsk: async (event) => {
      if (!SessionApproval.WEB_ACTIONS.includes(event.action) || event.effect === "deny") return
      // A web request the agent's own rules deny (the user's config) stays denied under every own bundle (MR12-5).
      const agent = event.agent
      const rules =
        agent === undefined
          ? []
          : await deps.ctx.agent.get({ agentID: agent }).then(
              (answer) => answer.data.permissions,
              () => undefined,
            )
      if (
        rules &&
        event.resources.some((resource) => SessionApproval.agentDenies(event.action, resource, rules, agent))
      ) {
        event.effect = "deny"
        return
      }
      if (event.effect !== "allow") return
      // Every own ask carries a reason, so another own hook's approved extension allow does not lift it (L1/L2, MR15).
      const askWeb = () => {
        event.effect = "ask"
        if (event.message === undefined) event.message = WEB_ASK_MESSAGE
      }
      // An agent that cannot be read may deny it: ask (fail closed).
      if (!rules) return askWeb()
      const saved = event.saved ?? []
      if (event.resources.every((resource) => SessionApproval.savedCovers(resource, saved))) return
      const info = await deps.ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      // A session that cannot be read may hold a former bundle: ask (fail closed).
      if (info && !SessionApproval.legacyWeb(info.permissions ?? [], protectedPaths())) return
      askWeb()
    },

    presence: async (input) => {
      idle.seen(input.sessionID)
      return {}
    },
    coldExpected: (sessionID, providerID) => {
      const awaiting = sessions.get(sessionID)?.awaiting
      return awaiting?.providerID === providerID ? awaiting.predictedCold : null
    },
    serial: (sessionID, work) => run(sessionID, () => work()),

    binding: async (input) => {
      const bindings = await Promise.all(
        input.sessionIDs.map(async (sessionID) => {
          const m = await memory(sessionID)
          const model = await current(sessionID)
          const home = Option.getOrUndefined(
            decodeHome(await deps.ctx.storage.get(Kv.home(sessionID)).catch(() => undefined)),
          )
          const own = model !== undefined && Kind.ProviderID.parse(model.providerID) !== undefined
          const thirdParty = model?.providerID === "anthropic"
          // 02 §8.10: the tree's Claude Agent account (the default before its first request); none without an account.
          const agent =
            model?.providerID === ClaudeAgent.PROVIDER_ID
              ? ((await peers().claudeAgent.accountOf(sessionID)) ?? null)
              : undefined
          return {
            sessionID,
            model: model ? Variant.ref(model) : null,
            // 02 §8.7: a Claude conversation's own account among this PC's Claude accounts; 02 §8.10 the same among the
            // Claude Agent accounts.
            accountID:
              thirdParty && accountOf(model) !== null
                ? await peers().claude.accountOf(sessionID)
                : agent !== undefined
                  ? agent
                  : accountOf(model),
            // A Claude Agent conversation runs on one of own's Claude Agent accounts, not on global credentials: no
            // `기본 claude-agent · 전역 계정` warning, and the composer keeps its effort and preset controls.
            builtin: model !== undefined && !own && !thirdParty && !agent,
            thirdParty,
            home: home?.providerID ?? null,
            switch: m.state,
          }
        }),
      )
      return { bindings }
    },

    estimate: async (input, context) => {
      const sessionID = input.sessionID
      const target = await planner.resolve(input.target, sessionID)
      const refusal = planner.refusal(target)
      if (refusal?.type === "account_not_found")
        return context.error("account_not_found", "account_not_found", { accountID: refusal.accountID })
      if (refusal?.type === "slot_misconfigured")
        return context.error("slot_misconfigured", "slot_misconfigured", {
          providerID: refusal.providerID,
          problems: refusal.problems,
        })
      if (refusal) return context.error("no_eligible_target", "target_unusable", { reasons: refusal.reasons })
      const team = await teamRefusal(sessionID, input.target, input.teamOp, false)
      if (team) return context.error("team_switch_required", "team_switch_required", { teamID: team.teamID })
      const usable = planner.usability(target.account, target.ref.providerID, sessionID, target.ref.id)
      if (!usable.usable)
        return context.error("no_eligible_target", "target_unusable", { reasons: [usable.reason ?? "unusable"] })
      if (target.account) void deps.runtime.credentials.prefetch(target.account).catch(failed("prefetch"))
      const reason = input.reason ?? "manual"
      const planned = await planner.planFor({
        sessionID,
        current: await current(sessionID),
        target: input.target,
        ...(input.accountID === undefined ? {} : { accountID: input.accountID }),
        reason,
        policy: shared.policy,
      })
      const running = rivals(sessionID, input.target)
      const result = {
        ...withRevert(sessionID, planner.result(planned, confidence(sessionID))),
        busyChildren: running[0] ? { count: running.length, accountID: running[0].accountID } : null,
      }
      remember(sessionID, result, planned.plan.predictedCold, planned.targetSide.rates)
      await run(sessionID, async (m) => {
        const state = m.state
        const replaceable =
          state.state === "STEADY" ||
          state.state === "COOLDOWN" ||
          state.state === "PLANNED" ||
          state.state === "FAILED" ||
          (state.state === "BLOCKED" && state.waitReset === undefined)
        if (!replaceable) return
        await transition(m, {
          state: "PLANNED",
          estimateID: result.estimateID,
          target: input.target,
          options: result.options,
          reason,
          expiresAt: result.expiresAt,
        })
        arm(m, "planned", result.expiresAt, expirePlan)
      })
      return result
    },

    estimateRequest: (input, context) =>
      priceRequests(input, context).catch((error: unknown) => {
        log.error("estimate_request_failed", { error })
        return context.error("internal_error", "unexpected", {})
      }),

    apply: async (input, context) => {
      const sessionID = input.sessionID
      const stored = input.estimateID === undefined ? undefined : estimates.get(input.estimateID)
      if (input.estimateID !== undefined && (!stored || stored.expiresAt <= now() || stored.sessionID !== sessionID))
        return context.error("estimate_expired", "estimate_expired", { estimateID: input.estimateID })
      const target = await planner.resolve(input.target, sessionID)
      const refusal = planner.refusal(target)
      if (refusal?.type === "account_not_found")
        return context.error("account_not_found", "account_not_found", { accountID: refusal.accountID })
      if (refusal?.type === "slot_misconfigured")
        return context.error("slot_misconfigured", "slot_misconfigured", {
          providerID: refusal.providerID,
          problems: refusal.problems,
        })
      const team = await teamRefusal(sessionID, input.target, input.teamOp, true)
      if (team) return context.error("team_switch_required", "team_switch_required", { teamID: team.teamID })
      const account = target.account
      if (account && (account.status === "needs_reauth" || account.status === "auth_failed"))
        return context.error("needs_reauth", "needs_reauth", { accountID: account.id })
      // Admitting a compaction would commit the staged revert (02 §4.7.4).
      if (COMPACTING_STRATEGIES.has(input.strategy)) {
        await current(sessionID)
        if (compaction.revertStaged(sessionID))
          return context.error("revert_staged", "a revert is staged; compacting would commit it", { sessionID })
      }
      const usable = planner.usability(account, target.ref.providerID, sessionID, target.ref.id)
      if (refusal || !usable.usable) {
        const detail: Switch.State = {
          state: "BLOCKED",
          reason: refusal ? (refusal.reasons[0] ?? "unusable") : `target_${usable.reason ?? "unusable"}`,
          nextResetAt: usable.until ?? null,
        }
        return { state: "BLOCKED" as const, detail }
      }
      if (account) void deps.runtime.credentials.prefetch(account).catch(failed("prefetch"))
      const intent = {
        ...(await intentFor(sessionID, input.target, input.strategy, input.reason, stored)),
        children: input.children,
        teamOp: input.teamOp,
      }
      return run(sessionID, (m) => applyStrategy(m, input, intent, stored))
    },

    schedule: async (input, context) => {
      const target = await planner.resolve(input.target, input.sessionID)
      const refusal = planner.refusal(target)
      if (refusal?.type === "account_not_found")
        return context.error("account_not_found", "account_not_found", { accountID: refusal.accountID })
      if (refusal?.type === "slot_misconfigured")
        return context.error("slot_misconfigured", "slot_misconfigured", {
          providerID: refusal.providerID,
          problems: refusal.problems,
        })
      const team = await teamRefusal(input.sessionID, input.target, undefined, true)
      if (team) return context.error("team_switch_required", "team_switch_required", { teamID: team.teamID })
      if (
        input.idleMinutes !== undefined &&
        input.deadlineMinutes !== undefined &&
        input.deadlineMinutes < input.idleMinutes
      )
        return context.error("invalid_schedule", "deadline_before_idle", {
          idleMinutes: input.idleMinutes,
          deadlineMinutes: input.deadlineMinutes,
        })
      const defaults = await scheduleDefaults(input.sessionID, input)
      if (defaults.deadlineMinutes < defaults.idleMinutes && input.trigger !== "compaction")
        return context.error("invalid_schedule", "deadline_before_idle", {
          idleMinutes: defaults.idleMinutes,
          deadlineMinutes: defaults.deadlineMinutes,
        })
      const deadline = now() + defaults.deadlineMinutes * 60_000
      await run(input.sessionID, (m) =>
        scheduleIn(m, {
          target: input.target,
          trigger: input.trigger,
          idleMinutes: defaults.idleMinutes,
          uncertain: defaults.uncertain,
          deadline,
        }),
      )
      return {
        state: "SCHEDULED" as const,
        trigger: input.trigger,
        idleMinutes: defaults.idleMinutes,
        uncertain: defaults.uncertain,
        deadline,
      }
    },

    cancel: async (input) =>
      run(input.sessionID, async (m) => {
        m.manualAt = now()
        m.pending = undefined
        if (m.state.state !== "SWITCHING") await settle(m)
        return { state: "STEADY" as const }
      }),

    undo: async (input, context) =>
      run(input.sessionID, async (m) => {
        const window = m.undo
        if (!window) return context.error("undo_window_closed", "undo_window_closed", {})
        m.undo = undefined
        m.awaiting = undefined
        m.manualAt = now()
        const state = await switchTo(m, window.previous, defaultIntent("now", "undo"))
        if (state.state === "FAILED") return context.error("internal_error", "undo_failed", {})
        return { state: "STEADY" as const }
      }),

    state: async (input) => (await memory(input.sessionID)).state,

    waitReset: async (input, context) =>
      run(input.sessionID, async (m) => {
        const state = m.state
        const currentRef = await current(input.sessionID)
        // The account the session runs on: for `anthropic` its tree's Claude account as `binding` reads it (02 §8.7;
        // the sync peek falls back to the default account after a restart).
        const accountID =
          currentRef?.providerID === Provider.ID.anthropic
            ? await peers().claude.accountOf(input.sessionID)
            : accountOf(currentRef, input.sessionID)
        // What holds this model back there, and the wait lasts until all of it frees: the BLOCKED state's reset, the
        // exhaustion record that holds this model back (a model weekly bucket's only for its family), the exhausted
        // windows that limit the model (`LimitRank.blocks`, LV 2026-10-24: a used-up Opus week does not push a Sonnet
        // session's wait to the Opus reset, and Claude's extra usage never holds back alone).
        const windows = accountID ? deps.runtime.limits.list({ accountID }) : []
        const resets = [
          state.state === "BLOCKED" ? state.nextResetAt : null,
          accountID ? deps.runtime.limits.exhaustion(accountID, currentRef?.id)?.until : undefined,
          ...windows
            .filter((window) => window.resetAt !== undefined && LimitRank.blocks(window, now(), currentRef?.id))
            .map((window) => window.resetAt),
        ].filter((at): at is number => typeof at === "number")
        if (resets.length === 0) return context.error("internal_error", "no_reset_known", {})
        const reset = Math.max(...resets)
        const resumeAt = Math.max(reset, now()) + 60_000 + Math.floor(Math.random() * 120_000)
        await transition(m, {
          state: "BLOCKED",
          reason: state.state === "BLOCKED" ? state.reason : "all_exhausted",
          nextResetAt: reset,
          waitReset: { resumeAt, message: input.message ?? "계속" },
        })
        arm(m, "waitReset", resumeAt, resume)
        return { state: "BLOCKED" as const, resumeAt }
      }),

    setConfirmOverride: async (input) => {
      const key = Kv.confirmOverride(input.sessionID)
      if (input.silentBelowTokens === null) {
        await deps.ctx.storage.remove(key)
        return { silentBelowTokens: null }
      }
      await deps.ctx.storage.set(key, { silentBelowTokens: input.silentBelowTokens })
      return { silentBelowTokens: input.silentBelowTokens }
    },

    policyGet: async () => {
      await loadPolicy()
      const core = await peers().slots.refreshCore()
      return { policy: policyView(shared.policy, core.keepTokens), compactionDefaults: Compaction.defaults }
    },

    policySet: async (input, context) => {
      const slots = peers().slots
      const field = PolicyRules.denied(input.patch, slots.snapshot())
      if (field) return context.error("policy_denied", "policy_denied", { field })
      const patch = input.patch.compaction
      // The Claude slot is not ours: v2 default and session "earlier" only (02 §4.7.2 (b), I5).
      if (patch?.byKind?.["claude-sub"] !== undefined)
        return context.error("policy_denied", "policy_denied", { field: "compaction.byKind.claude-sub" })
      const keep = slots.core().keepTokens ?? Compaction.KEEP_TOKENS
      const kinds = PolicyRules.compactionKinds(patch?.byKind)
      const problem = kinds
        .map((kind) => {
          const setting = patch?.byKind?.[kind]
          return setting === null || setting === undefined
            ? undefined
            : Compaction.check(setting, slots.windows(kind), { keep, prefix: `compaction.byKind.${kind}.` })
        })
        .find((item) => item !== undefined)
      if (problem) return context.error("setting_out_of_range", `${problem.field} is out of range`, problem)
      const output = input.patch.outputLimit ? OutputLimit.check(input.patch.outputLimit) : undefined
      if (output) return context.error("setting_out_of_range", `${output.field} is out of range`, output)
      const keepTokens = patch?.keepTokens
      if (
        keepTokens !== undefined &&
        !(Number.isInteger(keepTokens) && keepTokens >= Compaction.KEEP_MIN && keepTokens <= Compaction.KEEP_MAX)
      )
        return context.error("setting_out_of_range", "compaction.keepTokens is out of range", {
          field: "compaction.keepTokens",
          min: Compaction.KEEP_MIN,
          max: Compaction.KEEP_MAX,
        })
      const byKind =
        patch?.byKind === undefined
          ? undefined
          : PolicyRules.compactionByKind(shared.policy.compaction?.byKind, patch.byKind)
      const registry = slots.snapshot()
      const compactionImpact =
        byKind === undefined
          ? undefined
          : slots.impact({
              providerIDs: [
                ...Object.entries(registry.slots)
                  .filter((entry) => kinds.includes(entry[1].kind) && entry[1].retired !== true)
                  .map((entry) => entry[0]),
                // The Claude Agent route has no slot; its conversations follow its kind default (CAG-50).
                ...(kinds.includes("claude-agent") ? [ClaudeAgent.PROVIDER_ID] : []),
              ],
              policy: byKind,
            })
      if (input.dryRun && compactionImpact !== undefined)
        return { policy: policyView(shared.policy, slots.core().keepTokens), compactionImpact }
      if (keepTokens !== undefined) {
        // The own global config is the only source of `keep` (02 §4.7.6 (가)); core's config watcher reloads it.
        const configDir = process.env.OPENCODE_CONFIG_DIR || undefined
        const written = configDir
          ? await CoreConfig.writeKeep(configDir, keepTokens).catch((error: unknown) => {
              failed("config.keep")(error)
              return { ok: false as const, reason: "write_failed" }
            })
          : { ok: false as const, reason: "config_dir_unset" }
        if (!written.ok) return context.error("policy_denied", written.reason, { field: "compaction.keepTokens" })
      }
      shared.policy = await deps.runtime.policy.update((stored) => PolicyRules.apply(stored, input.patch))
      // Every Location reloads providers (thresholds are registered windows) and re-reads `keep`.
      deps.runtime.broadcast.emit("store.changed", { store: "policy", origin: "local" })
      const core = await slots.refreshCore()
      return {
        policy: policyView(shared.policy, core.keepTokens),
        ...(compactionImpact === undefined ? {} : { compactionImpact }),
      }
    },

    compactionSet: async (input, context) =>
      run(input.sessionID, async () => {
        const result = await compaction.set(input.sessionID, input.triggerTokens)
        if (!result.ok) return context.error("setting_out_of_range", "triggerTokens is out of range", result.error)
        void peers().telemetry.refreshCacheState(input.sessionID)
        await compaction.check(input.sessionID)
        return { compaction: result.compaction }
      }),

    compactionView: (sessionID) => compaction.view(sessionID),

    approvalGet: async (input, context) => {
      const info = await deps.ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
      if (!info) return context.error("internal_error", "session_not_found", {})
      const rules = info.permissions ?? []
      return {
        mode: SessionApproval.modeOf(rules, protectedPaths()),
        rules,
        children: { open: (await openChildren(input.sessionID)).length },
        browserTool: SessionApproval.browserToolOf(rules),
        computerUse: SessionApproval.computerUseOf(rules),
        browse: SessionApproval.browseOf(rules),
      }
    },

    approvalSet: async (input, context) => {
      const paths = protectedPaths()
      const open = await openChildren(input.sessionID)
      // Children get the computer allow only while own.computer-use lets subagents act; otherwise `on` takes it from
      // them (cu-review). Without `computerUse` (own.team's mode writes) no computer allow is added or removed.
      const childUse =
        input.computerUse === "on" && open.length > 0 && !(await computerSubagents()) ? "off" : input.computerUse
      const patched: SessionID[] = []
      let browserTool: Approval.BrowserTool | undefined
      let computerUse: Approval.ComputerUse | undefined
      let browse: Approval.Browse | undefined
      for (const sessionID of [input.sessionID, ...open]) {
        // Read-merge-write per session: only own bundle rules change, the rest keeps its order (03 §18.8); with
        // `browserTool` also the browser creation deny (03 §18.15 rule 3), with `computerUse` the computer allow.
        const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
        if (!info) {
          if (sessionID === input.sessionID) return context.error("internal_error", "session_not_found", {})
          continue
        }
        const moded = SessionApproval.replace(info.permissions ?? [], input.mode, paths)
        const browsed = input.browserTool ? SessionApproval.withBrowserTool(moded, input.browserTool, paths) : moded
        const use = sessionID === input.sessionID ? input.computerUse : childUse
        const used = use ? SessionApproval.withComputerUse(browsed, use, paths) : browsed
        // 내 브라우저 사용 (BRW): children follow the parent; the read-only roles' hook refuses their browser actions.
        const permissions = input.browse ? SessionApproval.withBrowse(used, input.browse, paths) : used
        if (input.browserTool && sessionID === input.sessionID) browserTool = SessionApproval.browserToolOf(permissions)
        if (input.computerUse && sessionID === input.sessionID) computerUse = SessionApproval.computerUseOf(permissions)
        if (input.browse && sessionID === input.sessionID) browse = SessionApproval.browseOf(permissions)
        const written = await deps.ctx.session
          .update({ sessionID, permissions })
          .then(() => true)
          .catch((error: unknown) => {
            log.warn("approval_write_failed", { sessionID, error })
            return false
          })
        if (!written && sessionID === input.sessionID) return context.error("internal_error", "update_failed", {})
        if (written) patched.push(SessionID.make(sessionID))
      }
      emit("approval.changed", { sessionID: input.sessionID, mode: input.mode, patched })
      return {
        mode: input.mode,
        patched,
        ...(browserTool ? { browserTool } : {}),
        ...(computerUse ? { computerUse } : {}),
        ...(browse ? { browse } : {}),
      }
    },
  }

  /** `switch.estimate` options that would send `POST /compact` are unavailable while a revert is staged (4.7.4). */
  function withRevert(sessionID: string, result: Estimate.Result): Estimate.Result {
    if (!compaction.revertStaged(sessionID)) return result
    return {
      ...result,
      options: result.options.map((option) =>
        COMPACTING_STRATEGIES.has(option.strategy)
          ? { strategy: option.strategy, available: false, reason: "revert_staged", display: option.display }
          : option,
      ),
    }
  }

  /** `estimate.request` (09 §5.6): the 02 §6 estimator on the target alone, no session state. */
  async function priceRequests(
    input: RpcTypes.Input<"estimate.request">,
    context: RpcTypes.Context<"estimate.request">,
  ) {
    const target = await planner.resolve(input.target)
    const refusal = planner.refusal(target)
    if (refusal?.type === "account_not_found")
      return context.error("account_not_found", "account_not_found", { accountID: refusal.accountID })
    if (refusal?.type === "slot_misconfigured")
      return context.error("slot_misconfigured", "slot_misconfigured", {
        providerID: refusal.providerID,
        problems: refusal.problems,
      })
    const rates = target.side.rates
    const measure = tracker.slotMeasure(target.ref.providerID)
    const threshold = target.compaction?.slot
    // 01 R16: the limit the slot registers (`ctx_eff` once its threshold moved), so the ceiling is where core compacts.
    const window = threshold ? (threshold.effectiveInput ?? threshold.windowTokens) : target.model?.window || null
    // own.import's picked account (09 §4.5) when it serves the target: any Claude account for `anthropic`, which they
    // all serve; for another provider only its own account. Else the provider's account, as before.
    const picked = input.accountID
    const serves =
      picked !== undefined &&
      (target.ref.providerID === Provider.ID.anthropic
        ? peers().claude.entry(picked) !== undefined
        : target.account?.id === picked)
    const accountID = serves ? picked : (planner.member(target.ref.providerID)?.id ?? target.account?.id)
    return {
      unit: rates.unit,
      delta: priced(rates, input.requests),
      quota: quotaOf(target.side),
      remaining: accountID === undefined ? null : remaining(deps.runtime.limits.list({ accountID })),
      Z: measure.Z,
      zSource: measure.zSource,
      exchange: measure.exchange,
      window,
      ceiling: window === null ? null : Compaction.ceiling(window),
    }
  }

  async function intentFor(
    sessionID: string,
    target: Variant.Ref,
    strategy: Estimate.Strategy,
    reason: Switch.Reason,
    stored: StoredEstimate | undefined,
  ): Promise<Intent> {
    if (stored && Variant.same(stored.result.target, target)) {
      const option = stored.result.options.find((item) => item.strategy === strategy)
      return {
        strategy,
        reason,
        estimate: option?.delta ?? null,
        predictedCold: stored.predictedCold,
        rates: stored.rates,
        auto: false,
      }
    }
    const planned = await planner
      .planFor({ sessionID, current: await current(sessionID), target, reason, policy: shared.policy })
      .catch((error: unknown) => {
        failed("plan")(error)
        return undefined
      })
    const option = planned?.plan.options.find((item) => item.strategy === strategy)
    return {
      strategy,
      reason,
      estimate: option?.delta ?? null,
      predictedCold: planned?.plan.predictedCold ?? null,
      rates: planned?.targetSide.rates,
      auto: false,
    }
  }

  async function applyStrategy(
    m: Memory,
    input: RpcTypes.Input<"switch.apply">,
    intent: Intent,
    stored: StoredEstimate | undefined,
  ): Promise<Switch.ApplyResult> {
    m.manualAt = now()
    const sessionID = m.sessionID
    const target = input.target
    const session = tracker.get(sessionID)
    const busy = session?.busy === true || session?.compacting === true
    switch (input.strategy) {
      case "now":
      case "switch-then-compact": {
        if (Variant.same(await current(sessionID), target)) {
          await settle(m)
          return { state: m.state.state, detail: m.state }
        }
        const compact = input.strategy === "switch-then-compact"
        // Checked (and with `stop` interrupted) even while the session runs: its turn may be waiting on them.
        if ((await held(sessionID, target, input.children)) || busy) {
          m.pending = intent
          await transition(m, { state: "WAIT_SAFE", target, strategy: input.strategy, reason: input.reason })
          return { state: "WAIT_SAFE", detail: m.state }
        }
        const state = await switchTo(m, target, intent)
        // The server admits the compaction itself, so no client has to (5.9(c)); the target model summarizes.
        if (compact && state.state === "SWITCHING") await compaction.compact(sessionID)
        return { state: state.state, detail: state }
      }
      case "compact-then-switch": {
        if (stored && tracker.epoch(sessionID) > stored.epoch) {
          if ((await held(sessionID, target, input.children)) || busy) {
            m.pending = intent
            await transition(m, { state: "WAIT_SAFE", target, strategy: input.strategy, reason: input.reason })
            return { state: "WAIT_SAFE", detail: m.state }
          }
          const state = await switchTo(m, target, intent)
          return { state: state.state, detail: state }
        }
        m.pending = intent
        const requestedAt = now()
        await transition(m, { state: "COMPACTING", target, requestedAt, timeout: COMPACT_TIMEOUT_MS })
        arm(m, "compacting", requestedAt + COMPACT_TIMEOUT_MS, compactTimeout)
        // The server admits the compaction itself (5.9(b)); `compaction.ended` then moves on to the switch.
        if ((await compaction.compact(sessionID)) !== "admitted") await onCompactionFailed(m)
        return { state: m.state.state, detail: m.state }
      }
      case "cold-point": {
        const defaults = await scheduleDefaults(sessionID, {})
        await scheduleIn(m, {
          target,
          trigger: "either",
          idleMinutes: defaults.idleMinutes,
          uncertain: defaults.uncertain,
          deadline: now() + defaults.deadlineMinutes * 60_000,
        })
        return { state: "SCHEDULED", detail: m.state }
      }
      case "fork":
      case "new-session": {
        if (input.childSessionID !== undefined) return delegate(m, input.childSessionID, target, input.strategy, intent)
        const clientAction =
          input.strategy === "fork"
            ? { type: "fork" as const, sessionID, target }
            : { type: "create-session" as const, sessionID, target }
        return { state: m.state.state, clientAction, detail: m.state }
      }
    }
  }

  async function delegate(
    m: Memory,
    childSessionID: SessionID,
    target: Variant.Ref,
    strategy: Estimate.Strategy,
    intent: Intent,
  ): Promise<Switch.ApplyResult> {
    const detail: Switch.State = { state: "DELEGATED", childSessionID }
    await transition(m, detail)
    await setHome(childSessionID, target, false)
    const from = await current(m.sessionID)
    emit("switch.recorded", {
      sessionID: m.sessionID,
      from: from ? Variant.ref(from) : null,
      to: Variant.ref(target),
      strategy,
      reason: switchReason(intent.reason),
      estimate: intent.estimate,
    })
    ledger("switch.delegated", m, target, { childSessionID, strategy, to: target })
    await settle(m)
    return { state: "DELEGATED", detail }
  }
}

const decodeChildren = Schema.decodeUnknownOption(Schema.Array(Schema.String))
/** Child ids kept per parent in KV (newest last). */
const MAX_CHILDREN = 500

/** The binding fields of the runtime session index; events carry the encoded (plain string) Ref. */
function modelFields(
  model: { readonly providerID: string; readonly id: string; readonly variant?: string | undefined } | undefined,
) {
  if (!model) return {}
  return { providerID: model.providerID, modelID: model.id, variant: model.variant ?? null }
}

function defaultIntent(strategy: Estimate.Strategy, reason: BindingReason): Intent {
  return { strategy, reason, estimate: null, predictedCold: null, rates: undefined, auto: false }
}

/** `switch.recorded.reason` only knows the three triggers (02 §5.2); pins, undos and external switches are manual. */
function switchReason(reason: BindingReason): Switch.Reason {
  return reason === "hard" || reason === "auth" ? reason : "manual"
}

function plain(ref: Variant.Ref) {
  return { providerID: ref.providerID, id: ref.id, ...(ref.variant === undefined ? {} : { variant: ref.variant }) }
}

/**
 * `estimate.request`'s requests together in the slot's unit (02 §6.3 ②, ⑥): the cached prefix at r_read, the rest of
 * the input at r_cold, the output at r_out. The upper bound reads nothing from the cache on a kind whose cache is never
 * sure to be warm (`TTL_lo = 0`, 6.3 ⑫). `null` when a needed rate is unknown (a local model, the Claude slot).
 */
function priced(rates: Rates.Rates, requests: RpcTypes.Input<"estimate.request">["requests"]): Estimate.Delta | null {
  const total = (worst: boolean) => {
    const costs = requests.map((request) => {
      const reused = worst && rates.ttlLo === 0 ? 0 : Math.min(request.cachedPrefix ?? 0, request.prompt)
      if (request.output === 0) return Estimator.firstRequest(rates, reused, request.prompt)
      const hit = request.prompt === 0 ? 0 : reused / request.prompt
      return Estimator.compactRequest(rates, request.prompt, request.output, hit)
    })
    if (!costs.every((cost): cost is number => cost !== null)) return null
    return Estimator.round(costs.reduce((sum, cost) => sum + cost, 0))
  }
  const lo = total(false)
  const hi = total(true)
  return lo === null || hi === null ? null : { lo, hi, unit: rates.unit }
}

/**
 * The limit window a subscription request counts against, as `switch.estimate` names it; its percent stays unknown
 * (`calibrating`) until the 02 §7.6 regression gives `k_u` for `Estimator.quotaDelta`.
 */
function quotaOf(side: Pick<Estimator.Side, "kind" | "billing">): Estimate.QuotaImpact | null {
  if (side.kind === "claude-sub" || side.kind === "claude-agent")
    return { window: "claude.5h", percent: null, state: "calibrating" }
  if (side.kind === "codex" && side.billing !== "metered")
    return { window: "codex.primary", percent: null, state: "calibrating" }
  return null
}

/**
 * Percent left of the account's 5-hour and weekly plan windows (`windowMinutes` 300 and 10,080, as Codex and the Claude
 * slot report them), the tightest when several report one (09 §4.6 `quota_insufficient`).
 */
function remaining(windows: ReadonlyArray<Limit.Window>) {
  const left = (minutes: number) => {
    const values = windows.flatMap((window) =>
      window.kind === "rolling_quota" && window.windowMinutes === minutes && window.usedPercent !== undefined
        ? [Math.max(0, 100 - window.usedPercent)]
        : [],
    )
    return values.length === 0 ? null : Math.min(...values)
  }
  return { fiveHour: left(300), weekly: left(10_080) }
}

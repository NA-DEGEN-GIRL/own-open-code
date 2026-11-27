// The switch flow (03 §6.2–6.5, 02 §5.9), loaded with the popover (lazy chunk): estimate → decide how loudly to ask →
// apply through the router (`switch.apply | schedule | undo | cancel`), then do the HTTP work the router hands back
// (`clientAction: compact`, fork, new-session handoff). The UI never calls `switchModel` or `POST /model` itself.
// Team sessions (06 §9.5, §10.1) take the routes of team-flow.ts: the owner's changes go to `area.main{now:true}`, the
// team main's move to another subscription of a team company and every `team_switch_required` answer to 팀 계정
// 바꾸기. A same-company subscription switch with subagents on the old account always asks (07 §5.5).
import type { Estimate, Switch } from "@own/protocol"
import { Policy } from "@own/protocol/policy"
import { OwnRpcError, type ServerKey, type ServerRuntime } from "@/data"
import type { I18n } from "@/i18n"
import type { Route } from "@/routing/routes"
import { decide, dontAskTokens, nowOption, sameRef, type Decision, type TargetRef } from "./cost"
import { switcherControl } from "./control"
import { createEstimator, type Estimator } from "./estimate"
import { formatTokens } from "./format"
import { accountOf, pendingAccountID, slotOf, targetAccount, variantName } from "./labels"
import { currentRef } from "./session"
import {
  applyAreaMain,
  closeTeamDialog,
  openTeamAccount,
  routeOf,
  teamSwitchRequired,
  type SwitchRoute,
} from "./team-flow"
import { showToast } from "./toast"

export { continuingChildren, currentRef } from "./session"

export interface FlowEnv {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly i18n: I18n
  readonly navigate: (route: Route) => void
}

// ---------------------------------------------------------------------------------------------------------------
// Shared per-runtime state: one estimator (the popover and the variant button share its cache) and the policy.

const estimators = new WeakMap<ServerRuntime, Estimator>()

export function estimatorFor(runtime: ServerRuntime) {
  const existing = estimators.get(runtime)
  if (existing) return existing
  const estimator = createEstimator({
    call: (sessionID, target, accountID) =>
      runtime.rpc.call("switch.estimate", {
        sessionID,
        target,
        ...(accountID === undefined ? {} : { accountID }),
        reason: "manual",
      }),
  })
  // A switch, a binding change or a compaction changes every cost of that session.
  runtime.own.on("switch.recorded", (event) => estimator.invalidate(event.data.sessionID))
  runtime.own.on("binding.changed", (event) => estimator.invalidate(event.data.sessionID))
  runtime.bus.on("session.compaction.ended", (event) => estimator.invalidate(event.data.sessionID))
  runtime.bus.on("server.connected", () => estimator.invalidate())
  estimators.set(runtime, estimator)
  return estimator
}

const policies = new WeakMap<ServerRuntime, { readonly at: number; readonly value: Promise<Policy.File | undefined> }>()
const POLICY_MS = 60_000

/** `policy.thresholds.confirm` (03 §6.2: never hardcoded); the protocol defaults when the router cannot answer. */
export async function confirmThresholds(runtime: ServerRuntime): Promise<Policy.Confirm> {
  const cached = policies.get(runtime)
  const entry =
    cached && Date.now() - cached.at < POLICY_MS
      ? cached
      : {
          at: Date.now(),
          value: runtime.rpc.call("policy.get", {}).then(
            (output) => output.policy,
            () => undefined,
          ),
        }
  policies.set(runtime, entry)
  return (await entry.value)?.thresholds.confirm ?? Policy.defaults.thresholds.confirm
}

export async function decideFor(
  runtime: ServerRuntime,
  sessionID: string,
  target: TargetRef,
  estimate: Estimate.Result,
) {
  const confirm = await confirmThresholds(runtime)
  const current = currentRef(runtime, sessionID)
  const slot = current
    ? slotOf(runtime.own.state.cache[sessionID], current.providerID, runtime.own.state.binding[sessionID]?.accountID)
    : undefined
  return withChildWait(
    decide({
      estimate,
      current,
      target,
      confirm,
      dialogAtTokens: switcherControl.state.override[sessionID],
      currentCold: slot?.state === "cold",
    }),
    estimate,
  )
}

/**
 * Subagents still run on the subscription the main leaves for another one of its company (07 §5.5,
 * `busyChildren`): the switch always asks, so the dialog offers [끝나면 바꾸기] [멈추고 바꾸기].
 */
export function withChildWait(decision: Decision, estimate: Pick<Estimate.Result, "busyChildren">): Decision {
  return estimate.busyChildren && decision.level !== "same" ? { ...decision, level: "dialog" } : decision
}

/** Strategies that move the main of this root, so `switch.apply{children}` decides about its busy subagents. */
export const CHILD_WAIT: ReadonlySet<Estimate.Strategy> = new Set(["now", "compact-then-switch", "switch-then-compact"])

// ---------------------------------------------------------------------------------------------------------------
// Entry points

export type RequestOutcome = "same" | "applied" | "dialog" | "inline" | "failed"

/**
 * One switch request (switcher Apply, variant button, "이 계정으로 고정"). `confirmedInline`: the user already saw the
 * inline cost on the Apply button (03 §6.2 20k–100k row), so an `inline` decision applies. `route`: the one the
 * switcher saw while open (team-flow.ts `routeOf`), else read now.
 */
export async function requestSwitch(
  env: FlowEnv,
  input: {
    readonly sessionID: string
    readonly target: TargetRef
    readonly estimate?: Estimate.Result
    readonly confirmedInline?: boolean
    readonly opener?: Element | null
    readonly route?: SwitchRoute
  },
): Promise<RequestOutcome> {
  const runtime = env.runtime
  const route = input.route ?? routeOf(runtime, input.sessionID, input.target)
  if (route.kind === "team-account")
    return (await openTeamAccount(env, { ...input, teamID: route.teamID })) ? "dialog" : "failed"
  try {
    const estimate = input.estimate ?? (await estimatorFor(runtime).fetch(input.sessionID, input.target))
    const decision = await decideFor(runtime, input.sessionID, input.target, estimate)
    if (decision.level === "same") return "same"
    if (decision.level === "dialog") {
      // A 팀 계정 바꾸기 plan left for this session must not take the place of these options.
      closeTeamDialog(input.sessionID)
      switcherControl.openDialog({
        serverKey: env.serverKey,
        sessionID: input.sessionID,
        target: input.target,
        estimate,
        opener: input.opener,
      })
      return "dialog"
    }
    if (decision.level === "inline" && !input.confirmedInline) {
      switcherControl.open({ target: input.target, anchor: input.opener instanceof HTMLElement ? input.opener : null })
      return "inline"
    }
    return (await applyNow(env, { ...input, route, estimateID: estimate.estimateID, decision })) ? "applied" : "failed"
  } catch (error) {
    if (await teamSwitch(env, error, input)) return "dialog"
    failure(env, error)
    return "failed"
  }
}

/** `team_switch_required{teamID}` (07 §5.5) from any switch path opens 팀 계정 바꾸기 instead of failing. */
async function teamSwitch(
  env: FlowEnv,
  error: unknown,
  input: { readonly sessionID: string; readonly target: TargetRef; readonly opener?: Element | null },
) {
  const teamID = teamSwitchRequired(error)
  return teamID !== undefined && (await openTeamAccount(env, { ...input, teamID }))
}

/** A new session has no cache yet: the switcher only sets the target of the first send (03 §5.1). */
export function chooseNewSessionTarget(env: FlowEnv, target: TargetRef) {
  switcherControl.setNewSessionTarget(env.serverKey, target)
  switcherControl.remember(target)
}

/**
 * `지금 전환`: `switch.apply{strategy:"now"}`, with `children` when subagents run on the subscription the main leaves
 * (07 §5.5). An owner conversation's change is its area main's (`area.main{model, now:true}`, 06 §9.5); the team
 * main's move to another subscription of a team company opens 팀 계정 바꾸기 and switches nothing here.
 */
export async function applyNow(
  env: FlowEnv,
  input: {
    readonly sessionID: string
    readonly target: TargetRef
    readonly estimateID?: string
    readonly decision?: Decision
    readonly children?: Switch.Children
    readonly route?: SwitchRoute
  },
) {
  const runtime = env.runtime
  const route = input.route ?? routeOf(runtime, input.sessionID, input.target)
  if (route.kind === "owner") return applyAreaMain(env, { ...route, model: { ...input.target }, now: true })
  if (route.kind === "team-account") {
    await openTeamAccount(env, { ...input, teamID: route.teamID })
    return false
  }
  const apply = (estimateID?: string) =>
    runtime.rpc.call("switch.apply", {
      sessionID: input.sessionID,
      estimateID,
      target: input.target,
      strategy: "now",
      reason: "manual",
      children: input.children,
    })
  try {
    const result = await apply(input.estimateID).catch((error: unknown) => {
      // PLANNED expires five minutes after the estimate (02 §5.4): apply against the current state instead.
      if (error instanceof OwnRpcError && error.type === "estimate_expired") return apply()
      throw error
    })
    announceApply(env, input.sessionID, input.target, result, input.decision)
    return result.state !== "FAILED" && result.state !== "BLOCKED"
  } catch (error) {
    if (!(await teamSwitch(env, error, input))) failure(env, error)
    return false
  }
}

function announceApply(
  env: FlowEnv,
  sessionID: string,
  target: TargetRef,
  result: { readonly state: string; readonly detail?: Switch.State },
  decision: Decision | undefined,
) {
  const i18n = env.i18n
  // The session's account on the target (SL-8: a Claude model switch stays on the conversation's Claude account); a
  // switch to Claude from another company lands on the account the router's record names (SL-17).
  const to =
    targetAccount(env.runtime, target.providerID, sessionID, pendingAccountID(result.detail))?.label ??
    target.providerID
  if (result.state === "STEADY") return
  if (result.state === "BLOCKED")
    return void showToast({ message: i18n.t("own.switch.blocked", { to }), tone: "danger" })
  if (result.state === "FAILED")
    return void showToast({ message: i18n.t("own.switch.failed", { reason: result.state }), tone: "danger" })
  switcherControl.remember(target)
  if (result.state === "WAIT_SAFE") return void showToast({ message: i18n.t("own.switch.pendingBusy") })
  switcherControl.markAnnounced(sessionID)
  if (decision?.note === "variant")
    return void showToast({
      message: i18n.t("own.switch.variantApplied", { variant: variantName(i18n, target.variant) }),
    })
  const message =
    decision?.note === "currentCold"
      ? `${i18n.t("own.switch.applied", { to })} · ${i18n.t("own.switch.currentCold")}`
      : decision && decision.tokens.hi > 0 && decision.note !== "new"
        ? i18n.t("own.switch.appliedTokens", { to, tokens: formatTokens(decision.tokens.hi) })
        : i18n.t("own.switch.applied", { to })
  showToast({ message, action: { label: i18n.t("own.switch.undo"), run: () => void undo(env, sessionID) } })
}

/** `switch.undo` (03 §6.2): only before the first `step.started` on the new account. */
export async function undo(env: FlowEnv, sessionID: string) {
  const i18n = env.i18n
  try {
    await env.runtime.rpc.call("switch.undo", { sessionID })
    showToast({ message: i18n.t("own.switch.undone") })
  } catch (error) {
    if (error instanceof OwnRpcError && error.type === "undo_window_closed")
      return void showToast({ message: i18n.t("own.switch.undoClosed") })
    showToast({ message: i18n.t("own.switch.undoFailed", { reason: reasonOf(error) }), tone: "danger" })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The cost dialog's strategies (03 §6.3 table, 02 §5.9)

export async function executeStrategy(
  env: FlowEnv,
  input: {
    readonly sessionID: string
    readonly target: TargetRef
    readonly estimate: Estimate.Result
    readonly option: Estimate.Option
    /** "이 세션에서는 {tokens} 미만이면 다시 묻지 않기". */
    readonly dontAskBelow?: number
    /** [끝나면 바꾸기] / [멈추고 바꾸기] for subagents on the subscription the main leaves (07 §5.5). */
    readonly children?: Switch.Children
  },
) {
  const runtime = env.runtime
  const i18n = env.i18n
  // SL-17: a switch to Claude lands on the account the estimate names (the switcher moved the tree to it first).
  const to =
    targetAccount(runtime, input.target.providerID, input.sessionID, input.estimate.target.accountID)?.label ??
    input.target.providerID
  if (input.dontAskBelow !== undefined) {
    switcherControl.setOverride(input.sessionID, input.dontAskBelow)
    void runtime.rpc
      .call("switch.setConfirmOverride", { sessionID: input.sessionID, silentBelowTokens: input.dontAskBelow })
      .catch(report)
  }
  try {
    switch (input.option.strategy) {
      case "now": {
        const decision = await decideFor(runtime, input.sessionID, input.target, input.estimate)
        return await applyNow(env, { ...input, estimateID: input.estimate.estimateID, decision })
      }
      case "compact-then-switch":
      case "switch-then-compact": {
        const result = await runtime.rpc.call("switch.apply", {
          sessionID: input.sessionID,
          estimateID: input.estimate.estimateID,
          target: input.target,
          strategy: input.option.strategy,
          reason: "manual",
          children: input.children,
        })
        switcherControl.remember(input.target)
        if (result.state === "WAIT_SAFE") showToast({ message: i18n.t("own.switch.pendingBusy") })
        // A service before the server-side compaction (02 §5.9(b)(c), 9efcddb79f; an older SSH host) hands it over.
        if (result.clientAction?.type === "compact") {
          showToast({ message: i18n.t("own.switch.compactRequested", { to }) })
          return await compactForSwitch(env, input.sessionID, input.target)
        }
        // The service admits the compaction itself: COMPACTING switches when it ends; PLANNED means it could not admit
        // it and nothing switched (03 §6.5).
        if (result.state === "COMPACTING") showToast({ message: i18n.t("own.switch.compactRequested", { to }) })
        if (result.state !== "PLANNED") return true
        showToast({
          message: i18n.t("own.switch.compactFailed"),
          tone: "danger",
          action: {
            label: i18n.t("own.switch.optNow"),
            run: () => void applyNow(env, { sessionID: input.sessionID, target: input.target }),
          },
        })
        return false
      }
      case "cold-point": {
        await runtime.rpc.call("switch.schedule", {
          sessionID: input.sessionID,
          target: input.target,
          trigger: input.option.trigger ?? "either",
        })
        switcherControl.remember(input.target)
        showToast({ message: i18n.t("own.switch.scheduled", { to }) })
        return true
      }
      case "new-session":
        return await handoff(env, input)
      case "fork":
        return await fork(env, input)
    }
  } catch (error) {
    if (!(await teamSwitch(env, error, input))) failure(env, error)
    return false
  }
}

/**
 * `clientAction: compact` of a service before the server-side compaction (02 §5.9(b)(c)): never while a revert is
 * staged (`POST /compact` would commit it). On failure the router goes back to PLANNED; the UI cancels and offers
 * `지금 전환` (03 §6.5).
 */
async function compactForSwitch(env: FlowEnv, sessionID: string, target: TargetRef) {
  const runtime = env.runtime
  const i18n = env.i18n
  try {
    const session = await runtime.client().session.get({ sessionID })
    if (session.revert) {
      await runtime.rpc.call("switch.cancel", { sessionID }).catch(report)
      showToast({ message: i18n.t("own.switch.unavailable.revert_staged"), tone: "danger" })
      return false
    }
    await runtime.data.session.compact({ sessionID })
    return true
  } catch (error) {
    report(error)
    await runtime.rpc.call("switch.cancel", { sessionID }).catch(report)
    showToast({
      message: i18n.t("own.switch.compactFailed"),
      tone: "danger",
      action: { label: i18n.t("own.switch.optNow"), run: () => void applyNow(env, { sessionID, target }) },
    })
    return false
  }
}

/** Instruction for the handoff summary (02 §5.9(f) step 1). Model-facing, not UI copy. */
const HANDOFF_PROMPT = [
  "Write a handoff summary of this conversation so that a new session can continue the work without it.",
  "Cover the goal, decisions and their reasons, the current state of the work and the files touched,",
  "open problems, and the next steps. Keep exact names, paths and identifiers.",
  "Write it in the language the user has been using.",
].join(" ")

/** How many recent user messages seed a handoff when the source account cannot summarize (02 §5.9(f) step 2). */
const SEED_MESSAGES = 5

/** 새 세션으로 인계 (02 §5.9(f)): summary on the source, new session with the source's rules, seed, record. */
async function handoff(
  env: FlowEnv,
  input: { readonly sessionID: string; readonly target: TargetRef; readonly estimate: Estimate.Result },
) {
  const runtime = env.runtime
  const i18n = env.i18n
  const client = runtime.client()
  const source = runtime.data.session.get(input.sessionID) ?? (await client.session.get({ sessionID: input.sessionID }))
  const sourceUsable = !input.estimate.options.some((option) => option.reason === "source_exhausted")
  const generated = sourceUsable
    ? await client.session
        .generate({ sessionID: input.sessionID, prompt: HANDOFF_PROMPT })
        .then((output) => output.text.trim())
        .catch(() => "")
    : ""
  const summary = generated || recentUserText(runtime, input.sessionID)
  if (!generated) showToast({ message: i18n.t("own.switch.summaryFallback") })
  const title = source.title || i18n.t("own.shell.untitled")
  // The new session inherits the source's approval rules as they are (03 §5.1 exception, §16.3).
  const created = await client.session.create({
    title: i18n.t("own.switch.handoffTitle", { title }),
    model: input.target,
    location: { directory: source.location.directory },
    permissions: source.permissions,
    metadata: { own: { seededFrom: input.sessionID } },
  })
  runtime.data.session.remember(created)
  const seed = `${i18n.t("own.switch.handoffHeader", { title })}\n\n${summary}`
  await runtime.data.session.prompt({ sessionID: created.id, text: seed })
  await runtime.rpc
    .call("switch.apply", {
      sessionID: input.sessionID,
      estimateID: input.estimate.estimateID,
      target: input.target,
      strategy: "new-session",
      reason: "manual",
      childSessionID: created.id,
    })
    .catch(report)
  switcherControl.remember(input.target)
  env.navigate({ name: "session", serverKey: env.serverKey, sessionID: created.id })
  showToast({ message: i18n.t("own.switch.handedOff") })
  return true
}

function recentUserText(runtime: ServerRuntime, sessionID: string) {
  return runtime.data.session.message
    .list(sessionID)
    .flatMap((message) => (message.type === "user" && message.text.trim() ? [message.text.trim()] : []))
    .slice(-SEED_MESSAGES)
    .map((text) => `- ${text}`)
    .join("\n")
}

/** 곁가지 포크 (02 §5.9(e)): fork, switch only the copy, open it. The original keeps its account and cache. */
async function fork(env: FlowEnv, input: { readonly sessionID: string; readonly target: TargetRef }) {
  const runtime = env.runtime
  const from =
    accountOf(runtime, currentRef(runtime, input.sessionID)?.providerID ?? "", input.sessionID)?.label ??
    env.i18n.t("own.cache.unknown")
  const forked = await runtime.client().session.fork({ sessionID: input.sessionID })
  runtime.data.session.remember(forked)
  // The fork toast below says it all; the copy's `switch.recorded` must not add a second one.
  switcherControl.markAnnounced(forked.id)
  await runtime.rpc.call(
    "switch.apply",
    { sessionID: forked.id, target: input.target, strategy: "now", reason: "manual" },
    { directory: forked.location.directory },
  )
  switcherControl.remember(input.target)
  env.navigate({ name: "session", serverKey: env.serverKey, sessionID: forked.id })
  showToast({ message: env.i18n.t("own.switch.forked", { from }) })
  return true
}

/** Pins an unpinned session to what it resolves to now: no cost, no LLM message (03 §5.2.1, 01 §8.5). */
export async function pinCurrentDefault(env: FlowEnv, sessionID: string) {
  const runtime = env.runtime
  try {
    const directory = runtime.data.session.get(sessionID)?.location.directory
    const output = await runtime.client().model.default({ location: directory ? { directory } : undefined })
    const model = output.data
    if (!model) return false
    return await applyNow(env, { sessionID, target: { providerID: model.providerID, id: model.id } })
  } catch (error) {
    failure(env, error)
    return false
  }
}

export function isCurrent(env: FlowEnv, sessionID: string | undefined, target: TargetRef) {
  return sessionID !== undefined && sameRef(currentRef(env.runtime, sessionID), target)
}

export { nowOption }

function failure(env: FlowEnv, error: unknown) {
  report(error)
  showToast({ message: env.i18n.t("own.switch.failed", { reason: reasonOf(error) }), tone: "danger" })
}

export function reasonOf(error: unknown) {
  if (error instanceof OwnRpcError) return error.type
  if (error instanceof Error) return error.message
  return String(error)
}

function report(error: unknown) {
  console.error("[own-web] switch flow", error)
}

/** Test/diagnostics: the upper bound for "다시 묻지 않기" next to the dialog checkbox. */
export function dontAskFor(estimateTokensHi: number, confirm: Policy.Confirm, override?: number) {
  return dontAskTokens(estimateTokensHi, override ?? confirm.dialogAtTokens)
}

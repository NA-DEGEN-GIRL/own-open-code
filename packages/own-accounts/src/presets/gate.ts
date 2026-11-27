export * as Gate from "./gate.js"

import { Schema } from "effect"
import type { Result } from "@opencode/plugin/promise/tool"
import { optional } from "@opencode/schema/schema"
import { Account, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Variant } from "../switching/variant.js"
import { Access } from "./access.js"
import { PresetBudget } from "./budget.js"
import { Fallback } from "./fallback.js"
import { PresetUsage } from "./usage.js"

/** Core's subagent tool (`packages/core/src/tool/plugin/subagent.ts` `name`). */
export const TOOL = "subagent"

/** What the gate reads and writes of a tool `execute.before` event (`plugin/src/promise/tool.ts`). */
export interface Before {
  readonly tool: string
  /** The calling session: the parent of a new child. */
  readonly sessionID: string
  /** The tool call; its `execute.after` settles the call's reservation ({@link after}). */
  readonly id?: string
  input: unknown
}

/** What {@link after} reads and writes of a tool `execute.after` event. */
export type After = {
  readonly tool: string
  readonly sessionID: string
  readonly id?: string
} & ({ readonly status: "completed"; result: Result } | { readonly status: "error" })

/** The subagent tool's input fields the gate reads; the rest of the input is passed on as it came. */
const Call = Schema.Struct({ agent: Schema.String, model: optional(Schema.String), sessionID: optional(Schema.String) })
type Call = typeof Call.Type
const isCall = Schema.is(Call)

/** The subagent tool's metadata for a background launch (`{sessionID, status: "running"}`). */
const isLaunch = Schema.is(Schema.Struct({ sessionID: Schema.String, status: Schema.Literal("running") }))

/** A per-call effort as the call's result records it (`metadata.own.effort`, 07 §2.3): asked, and sent (`null` = none). */
interface Effort {
  readonly requested: string
  readonly used: string | null
}

type Decision =
  | { readonly type: "keep" }
  | { readonly type: "inherit" }
  | {
      readonly type: "model"
      readonly ref: Variant.Ref
      readonly notice?: string
      /** An id the LLM wrote names no effort of its own: like the main, its effort is the main's (07 §2.8). */
      readonly inherits?: true
      readonly effort?: Effort
    }
  | {
      readonly type: "override"
      readonly requested: Variant.Ref
      readonly used: Variant.Ref
      readonly notice?: string
      readonly effort?: Effort
    }
  | {
      readonly type: "reject"
      readonly rejection: Preset.Rejection
      readonly requested: string
      /** The paid account a `consent` or `budget` rejection is about (the UI card asks about it). */
      readonly accountID?: Account.ID
    }

const KEEP: Decision = { type: "keep" }
const INHERIT: Decision = { type: "inherit" }

/** What the gate knows of the root once its main is known. */
interface Root {
  readonly main: Access.Main
  readonly binding: Preset.Binding | undefined
  readonly preset: Preset.Info | undefined
  readonly plan: Access.Plan
  /** Roles with a row in the preset, named in a `model` rejection. */
  readonly roles: ReadonlyArray<Preset.Role>
}

/**
 * The subagent gate (07 §5.4), `execute.before` of the subagent tool.
 * 1. Finds the root and its binding; delegation `off` declines every call unless ultra is on, which delegates
 *    `active` whatever the preset says (07 §2.9; the guidance entry says the same, `Preset.renderGuidance`).
 * 2. A new child's target = the role a written `model` names (or the main canonical id moved onto the main slot) ??
 *    the first usable target of the agent's role row (`single`: `workers.single`) ?? the agent's configured
 *    `agent.model` ?? the parent. A role whose targets cannot run falls back to its next target and at the end to the
 *    parent, with a notice in the call's result (07 §1.2, `Fallback`). Any other `model` the LLM wrote is declined
 *    (`model`, listing the preset's roles): the LLM never picks an account or a provider (07 §3.1).
 * 3. Allowed set A (`Access.plan`): the main account's models, the preset's pinned targets that resolve now with R4
 *    and the binding's team (a team-broken target is skipped), and for the called agent only its configured model on
 *    a local provider or a usable paid account within budget (`Access.admit`). A configured subscription slot runs on
 *    the role's target instead (`subagent_model_overridden`); another slot of the main's company (the same login's
 *    codex/siwc sibling too) is never a target.
 * 4. Money: a paid target whose budget is used up declines the call (`budget`); a fallback onto a paid target waits
 *    for the user's consent for this conversation (`consent`, no paid request before it). A remote service has no
 *    budgets: it goes by the local PC's mirrored verdict, and a paid account without one counts as used up (T3,
 *    `PresetBudget.exhausted`).
 * 5–6. Caps (`Preset.caps` with ultra and the global ultra level; per message raised by `raiseOnce`): checked and the
 *    call held in one synchronous step in the runtime's reservation map, after every await of the decision, so the
 *    calls of one step never exceed a cap. A call over a cap is declined at once (`caps`).
 * A model pool preset (07 §5.4 2단계 모델 묶음) maps the LLM's `model` instead: a pool name, a role name (that role's
 * default), the main model itself, or a model id one entry has (a free entry first); anything else is declined
 * listing the pool's names. With no `model` a new child takes the default rule (`Preset.poolPick` over what can run
 * now). A pick that cannot run now runs on the agent's default with a notice (`Fallback.poolNotice`), and so does a
 * default that differs from the one the guidance names. A paid entry runs within its budget without consent.
 * A continued child stays where it is while its slot is in A (cache kept), else it moves to its role's target
 * (07 §5.5). What the gate decides it writes into `input.model` explicitly, so the agent's configured model cannot
 * win in core (`override ?? agent.model ?? parent.model`). When it cannot decide (no main, a failed lookup, any throw)
 * only a plain inherit from the parent passes (`undecided`, decision 2026-10-02); a reservation taken before a throw is
 * released.
 *
 * A per-call effort (07 §2.3 대화에서 정하는 강도, `<target>#<intent>` or `#<intent>`, `provider/model#variant` too) never
 * changes where the call runs: the target is decided without it, then the intent is fitted to the target's levels
 * (`Preset.fitRequest`) and checked against the ceiling: lowering always passes, a raise above the target's preset
 * effort only up to the preset's `subagentEffortMax` (`max` for a call of the user message the user allowed more for)
 * and never on a target that costs money. A continued child keeps its model when the new effort would not keep its
 * cache (`Variant.only`). Every `#` it accepts is rewritten away, since core reads one only after `provider/model`.
 *
 * A remote service runs the same gate over the mirrored registry and `presets.json` (07 §8.1 원격): the presets
 * store judged R4 again on load without identities, and with no Codex metadata there, effort and ultra follow the
 * no-metadata rules (T2.10).
 *
 * A rejection never throws (a promise plugin's throw is a session error, not a tool result): the gate writes
 * {@link Preset.rejection} into `input.agent`, and core answers the LLM `Unknown agent: own-preset: …`. Nothing is
 * written to the session (permissions, instruction entries, model), so its request bytes stay as they were.
 */
export function create(deps: Deps, peers: Module.Peers, access: Access.Api) {
  const log = deps.log.child("presets.gate")

  /** The agent's configured model. A failed lookup throws, and the call goes to `undecided`. */
  const agentModel = async (agentID: string) => (await deps.ctx.agent.get({ agentID })).data.model

  const decide = async (call: Call, event: Before): Promise<Decision> => {
    const main = await access.main(event.sessionID)
    if (!main) return undecided(call, event.sessionID, "main")
    const binding = await access.binding(main.root)
    const preset = access.preset(main, binding)
    if (preset?.delegation === "off" && binding?.ultra === undefined)
      return { type: "reject", rejection: { reason: "off" }, requested: call.agent }
    const request = Preset.effortRequest(call.model)
    if (request.type === "invalid")
      return { type: "reject", rejection: { reason: "effort" }, requested: call.model ?? call.agent }
    const roles = Preset.ROLES.filter((role) => preset?.workers.roles[role] !== undefined)
    const plan = await access.plan(main, preset, binding?.team)
    const root: Root = { main, binding, preset, plan, roles }
    // Where the call runs is decided as if no effort were asked (07 §2.3: an effort never moves a call).
    const plain: Call = request.target === undefined ? withoutModel(call) : { ...call, model: request.target }
    const decision = await target(plain, event.sessionID, root, call)
    if (decision.type === "reject" || decision.type === "inherit") return decision
    // 07 §2.3 강도 고정 (PF 2026-11-03): a level the preset or the chosen pool entry fixes is the call's effort (ultra
    // keeps its own), fitted to its model; a per-call effort the LLM asked for is not used and the result says so.
    const forced = root.binding?.ultra ? undefined : Preset.forcedFor(root.preset, poolEntryOf(decision, root))
    const asked = request.type === "effort" ? request.intent : undefined
    const fitted =
      forced !== undefined
        ? await refit(decision, forced, plain, root, { asked })
        : asked !== undefined
          ? await refit(decision, asked, plain, root)
          : decision
    if (fitted.type === "reject") return fitted
    return hold(fitted, call, event, root)
  }

  /**
   * Steps 2–4: where the call runs. `raw` is the call as the LLM wrote it, which an undecidable continued child is
   * judged by (an effort it asked for is declined, never dropped).
   */
  const target = async (call: Call, sessionID: string, root: Root, raw: Call): Promise<Decision> => {
    const main = root.main
    const team = root.binding?.team
    const pool = root.plan.pool
    if (call.model !== undefined) return pool ? named(call.model, call.agent, root, pool) : written(call.model, root)
    if (call.sessionID === undefined) {
      if (pool) return defaulted(call.agent, root, pool)
      const row = rowOf(root, call.agent)
      if (row) return picked(row.role, row.resolution, call.agent, root)
      const model = await agentModel(call.agent)
      return model ? configured(model, main, root.roles, team) : KEEP
    }
    // A continued child: core moves it to the agent's model when the call names another agent; otherwise it stays
    // where it is, which must still be in A.
    const model = await agentModel(call.agent)
    const child = await deps.ctx.session.get({ sessionID: call.sessionID })
    if (model && child.agent !== call.agent) return configured(model, main, root.roles, team)
    if (!child.model) return undecided(raw, sessionID, "child")
    const current = child.model
    if (current.providerID === main.ref.providerID || root.plan.pinned.has(current.providerID)) return KEEP
    const admitted =
      model !== undefined && current.providerID === model.providerID && (await access.admit(main, model, team)) === "ok"
    if (admitted) return KEEP
    if (pool) return defaulted(call.agent, root, pool)
    const row = rowOf(root, call.agent)
    return row ? picked(row.role, row.resolution, call.agent, root) : { type: "model", ref: main.parent }
  }

  /**
   * A `model` the LLM wrote under a model pool (07 §5.4 2단계 모델 묶음), first match: a pool name; a role name (that
   * role's default); the main model itself (its slot, or the canonical id moved onto it); a bare or `provider/model`
   * id one entry has (a free entry first, then pool order; the provider is never read, so the LLM never picks an
   * account). Anything else, a main-account model outside the pool included, is declined with the pool's names. A
   * `#variant` after any of them is the call's per-call effort ({@link decide}), fitted to the entry like `#high`.
   */
  const named = (value: string, agent: string, root: Root, pool: Access.Pool): Decision | Promise<Decision> => {
    const exact = pool.entries.find((entry) => entry.key === value)
    if (exact) return chosen(exact, agent, root, pool)
    const role = Preset.roleOf(value)
    if (role) return poolDefault(role, root, pool) ?? { type: "model", ref: root.main.parent }
    const parsed = Access.parse(value)
    const mapped = parsed && access.onMain(root.main, parsed)
    if (mapped?.id === root.main.ref.id) return { type: "model", ref: mapped, inherits: true }
    if (value === root.main.ref.id) return { type: "model", ref: root.main.parent }
    const id = parsed?.id ?? value
    const found = pool.entries
      .filter((entry) => entry.model === id)
      .toSorted((a, b) => Number(costs(a)) - Number(costs(b)))[0]
    if (found) return chosen(found, agent, root, pool)
    const [first, ...others] = pool.entries.map((entry) => entry.key)
    if (first === undefined) return reject("model", root.roles, value)
    return { type: "reject", rejection: { reason: "model", models: [first, ...others] }, requested: value }
  }

  /** A pool entry the LLM named: it runs when it can now, else the agent's default does, with a notice (D4). */
  const chosen = (entry: Access.PoolEntry, agent: string, root: Root, pool: Access.Pool): Decision => {
    if (entry.usable && entry.ref) return { type: "model", ref: entry.ref }
    const key = Preset.poolPick(agent, pool.entries, pool.main)
    const to = pool.entries.find((item) => item.key === key)?.ref
    return {
      type: "model",
      ref: to ?? root.main.parent,
      notice: Fallback.poolNotice(entry.key, to ? key : undefined, entry.spent),
    }
  }

  /**
   * A new child under a model pool that names no model (07 §3.3 U7a): the default rule over what can run now; with no
   * pick, the agent's configured model, else the parent. When the guidance's default for the agent cannot run now, the
   * call says where it ran instead.
   */
  const defaulted = async (agent: string, root: Root, pool: Access.Pool): Promise<Decision> => {
    const pick = poolDefault(agent, root, pool)
    if (pick) return pick
    const model = await agentModel(agent)
    return model ? configured(model, root.main, root.roles, root.binding?.team) : KEEP
  }

  /**
   * A model the LLM wrote: a role name (07 §3.2, that role's target; a role without a row runs like the main), or an
   * id on the main account. Anything else is the LLM picking a provider, which it may not (07 §3.1).
   */
  const written = (value: string, root: Root): Decision | Promise<Decision> => {
    const role = Preset.roleOf(value)
    if (role) {
      const row = rowOf(root, role)
      return row ? picked(row.role, row.resolution, value, root) : { type: "model", ref: root.main.parent }
    }
    const parsed = Access.parse(value)
    const mapped = parsed && access.onMain(root.main, parsed)
    return mapped ? { type: "model", ref: mapped, inherits: true } : reject("model", root.roles, value)
  }

  /** A role row's target after the fallback walk (07 §1.2) and the money rules (07 §5.4 step 4). */
  const picked = async (
    role: Preset.Role,
    resolution: Preset.RoleResolution,
    requested: string,
    root: Root,
  ): Promise<Decision> => {
    const answers = await PresetBudget.consent(deps, root.main.root)
    const pick = await Fallback.pick(role, resolution, root.main.parent, {
      paid: access.paid,
      consent: (accountID) => answers.get(accountID),
      exhausted: (account) => PresetBudget.exhausted(peers, account),
    })
    if (pick.type === "reject")
      return {
        type: "reject",
        rejection: { reason: pick.reason, roles: root.roles },
        requested,
        accountID: pick.accountID,
      }
    return { type: "model", ref: pick.ref, ...(pick.notice === undefined ? {} : { notice: pick.notice }) }
  }

  /** A configured `agent.model`: the user's own setting, admitted for that agent or replaced (07 §5.4 step 3). */
  const configured = async (
    ref: Variant.Ref,
    main: Access.Main,
    roles: ReadonlyArray<Preset.Role>,
    team: Preset.Team | undefined,
  ): Promise<Decision> => {
    if (ref.providerID === main.ref.providerID) return KEEP
    const admission = await access.admit(main, ref, team)
    if (admission === "ok") return { type: "model", ref }
    // The agent has no role row here (a row wins over a configured model), so its role runs like the main.
    if (admission === "subscription") return { type: "override", requested: ref, used: main.parent }
    return reject(admission === "budget" ? "budget" : "model", roles, Access.text(ref))
  }

  /**
   * The per-call effort step (07 §2.3 대화에서 정하는 강도): the decided target's Ref with the intent fitted and checked
   * against the ceiling, or a rejection (`effort`, `effort-cap`). A kept call is written out, since its `#` must go.
   * A continued child whose cache the new effort would not keep stays as it is, with a notice.
   */
  const refit = async (
    decision: Decision,
    intent: string,
    call: Call,
    root: Root,
    /** A level the preset fixes (07 §2.3 강도 고정): no ceiling, and `asked` is the per-call effort it overrode. */
    forced?: { readonly asked: string | undefined },
  ): Promise<Decision> => {
    const child = call.sessionID === undefined ? undefined : await deps.ctx.session.get({ sessionID: call.sessionID })
    const ref = await runsOn(decision, call, root, child)
    if (!ref) return reject("model", root.roles, intent)
    const levels = await peers().presets.resolver.levels(ref)
    const inherit = root.main.ref.variant
    const base =
      decision.type === "model" && decision.inherits
        ? Preset.effortToVariant(inherit, levels.variants, levels.meta).variant
        : ref.variant
    const paid = !free(ref.providerID)
    const usage = await PresetUsage.read(deps, root.main.root)
    const once = PresetUsage.effortOnce(usage, await PresetUsage.message(deps, root.main.root))
    const ceiling = forced ? "max" : Preset.effortCeiling(Preset.effortMaxOf(root.preset ?? {}), { paid, once })
    const fit = Preset.fitRequest({
      intent,
      ...(inherit === undefined ? {} : { inherit }),
      ...(base === undefined ? {} : { base }),
      variants: levels.variants,
      ...(levels.meta === undefined ? {} : { meta: levels.meta }),
      ...(ceiling === undefined ? {} : { ceiling }),
    })
    if (!fit.ok)
      return {
        type: "reject",
        rejection:
          fit.reason === "unknown"
            ? { reason: "effort" }
            : { reason: "effort-cap", max: fit.max, once: !paid && !once },
        requested: intent,
      }
    const next = {
      providerID: ref.providerID,
      id: ref.id,
      ...(fit.variant === undefined ? {} : { variant: fit.variant }),
    }
    // 07 §5.5: a continued child keeps its cache. An effort switch that would rewrite it (a route without per-message
    // effort updates, a non-effort variant, a kind this build cannot judge) leaves the child as it is.
    const current = child?.model
    const kind = access.groupOf(next.providerID)
    const switched = current && Variant.only(current, next, kind && !Preset.isLocal(kind) ? kind : undefined)
    const kept = current && switched && !switched.preservesCache ? current : undefined
    const used = kept ?? next
    const notice = [
      decision.type === "model" ? decision.notice : undefined,
      forced?.asked !== undefined && forced.asked !== intent ? fixedAt(intent, forced.asked) : undefined,
      kept ? keptAt(kept.variant, next.variant) : sentAs(intent === "inherit" ? inherit : intent, fit),
    ].filter((line) => line !== undefined)
    const effort = { requested: forced?.asked ?? intent, used: used.variant ?? null }
    const noted = notice.length ? { notice: notice.join("\n") } : {}
    if (decision.type === "override") return { ...decision, used, ...noted, effort }
    return { type: "model", ref: used, ...noted, effort }
  }

  /**
   * The Ref a decided call runs on: the decision's, else (kept) what core picks for it: a new child's configured
   * `agent.model`, else the parent; a continued child's agent's model when the call switches it to an agent with one,
   * else the child's own. `undefined` for a continued child without a model.
   */
  const runsOn = async (
    decision: Decision,
    call: Call,
    root: Root,
    child: { readonly agent?: string; readonly model?: Variant.Ref } | undefined,
  ): Promise<Variant.Ref | undefined> => {
    if (decision.type === "model") return decision.ref
    if (decision.type === "override") return decision.used
    const model = await agentModel(call.agent)
    if (!child) return model ?? root.main.parent
    return model && child.agent !== call.agent ? model : child.model
  }

  /**
   * A target whose effort may be raised (07 §2.3): an own subscription, the Claude slot, a local provider or a local
   * model account (02 §3.3a).
   */
  const free = (providerID: string) => {
    const account = peers().slots.slot(providerID)?.account
    return (
      access.subscription(providerID) ||
      Preset.LOCAL_PROVIDERS.some((id) => id === providerID) ||
      (account !== undefined && Account.isLocal(account))
    )
  }

  /**
   * Steps 5–6: the caps in force and the hold. Every await comes before `runtime.reservations.take`, which checks and
   * holds in one synchronous step.
   */
  const hold = async (decision: Decision, call: Call, event: Before, root: Root): Promise<Decision> => {
    const caps = root.preset
      ? Preset.caps(root.preset, root.binding?.ultra !== undefined, peers().presets.settings().ultraCaps)
      : Preset.CAPS
    const usage = await PresetUsage.read(deps, root.main.root)
    const message = call.sessionID === undefined ? await PresetUsage.message(deps, root.main.root) : undefined
    const notice = decision.type === "model" || decision.type === "override" ? decision.notice : undefined
    const effort = decision.type === "model" || decision.type === "override" ? decision.effort : undefined
    const taken = deps.runtime.reservations.take(
      {
        root: root.main.root,
        parent: event.sessionID,
        ...(event.id === undefined ? {} : { callID: event.id }),
        ...(message === undefined ? {} : { message }),
        ...(call.sessionID === undefined ? {} : { child: call.sessionID }),
        ...(notice === undefined ? {} : { notice }),
        ...(effort === undefined ? {} : { effort }),
      },
      { ...caps, perMessage: message === undefined ? caps.perMessage : PresetUsage.perMessage(caps, usage, message) },
      usage.perSession,
    )
    if (taken.ok) return decision
    return { type: "reject", rejection: { reason: "caps", cap: taken.cap, max: taken.max }, requested: call.agent }
  }

  /**
   * The gate cannot decide (decision 2026-10-02): no main (a failed session lookup or a root without a stored model), a
   * child without a model, a failed agent lookup or any throw. Only a plain inherit from the parent passes: no
   * explicit model (a role name runs like the main, so it names none) and an agent known to have no configured model.
   * Anything else may leave A unseen, so it is rejected; so is a per-call effort (`#…` is no role name), never dropped
   * into a plain inherit (07 §2.3). Never throws. A call it lets through is held against the caps only when the main
   * is known (a continued child without a model); without a main nothing is counted.
   */
  const undecided = async (call: Call, sessionID: string, cause: string, error?: unknown): Promise<Decision> => {
    log.warn("subagent_gate_undecided", { sessionID, agent: call.agent, cause, error })
    if (call.model !== undefined && !Preset.roleOf(call.model)) return reject("model", [], call.model)
    const lookup = await agentModel(call.agent).then(
      (model) => ({ model }),
      () => undefined,
    )
    if (!lookup) return reject("model", [], call.agent)
    if (lookup.model) return reject("model", [], Access.text(lookup.model))
    return call.model === undefined ? KEEP : INHERIT
  }

  return async (event: Before) => {
    if (event.tool !== TOOL || !isCall(event.input)) return
    const call = event.input
    const decision = await decide(call, event).catch((error) => {
      // A reservation taken before the failure goes with it.
      if (event.id !== undefined) deps.runtime.reservations.finish(event.id, { failed: true })
      return undecided(call, event.sessionID, "error", error)
    })
    if (decision.type === "keep") return
    if (decision.type === "inherit") {
      // A role name with no main to write: without it core runs the call on the parent's model.
      const { model: _role, ...inherit } = call
      event.input = inherit
      return
    }
    if (decision.type === "model") {
      event.input = { ...call, model: Access.text(decision.ref) }
      return
    }
    const telemetry = peers().telemetry
    if (decision.type === "override") {
      const requested = Access.text(decision.requested)
      const used = Access.text(decision.used)
      event.input = { ...call, model: used }
      log.info("subagent_model_overridden", { sessionID: event.sessionID, requested, used })
      telemetry.alert({
        code: "subagent_model_overridden",
        severity: "info",
        sessionID: event.sessionID,
        subject: requested,
        message: `하위 에이전트 설정 모델 ${requested}은(는) 구독 계정이라 ${used}에서 실행했습니다.`,
      })
      return
    }
    const reason = decision.rejection.reason
    const accountID = decision.accountID
    event.input = { ...call, agent: Preset.rejection(decision.rejection) }
    if (reason === "budget" && accountID !== undefined)
      log.info("preset_budget_exhausted", { sessionID: event.sessionID, accountID })
    log.info("subagent_rejected", { sessionID: event.sessionID, requested: decision.requested, reason, accountID })
    telemetry.alert({
      code: "subagent_rejected",
      severity: "info",
      sessionID: event.sessionID,
      ...(accountID === undefined ? {} : { accountID }),
      subject: `${reason}:${decision.requested}`,
      message: `하위 에이전트 요청을 막았습니다(${reason}): ${decision.requested}`,
    })
  }
}

/**
 * `execute.after` of the subagent tool: settles the call's reservation (a failure whose child never ran is taken back,
 * a background launch keeps counting until its child shows up busy), says a fallback's or a per-call effort's notice
 * with the result (07 §1.2, §2.3), records a per-call effort in `metadata.own.effort` (`{requested, used}`), and
 * persists the conversation count (KV `presetUsage`) once a new child was created.
 */
export function after(deps: Deps) {
  return async (event: After) => {
    if (event.tool !== TOOL || event.id === undefined) return
    const metadata = event.status === "completed" ? event.result.metadata : undefined
    const claim = deps.runtime.reservations.finish(event.id, {
      failed: event.status === "error",
      ...(isLaunch(metadata) ? { launched: metadata.sessionID } : {}),
    })
    if (!claim || event.status !== "completed") return
    if (claim.notice !== undefined) event.result = noted(event.result, claim.notice)
    if (claim.effort !== undefined)
      event.result = {
        ...event.result,
        metadata: { ...metadata, own: { ...metadata?.own, effort: claim.effort } },
      }
    if (claim.message !== undefined)
      await PresetUsage.record(deps, claim.root, deps.runtime.reservations.counts(claim.root).session)
  }
}

/** A result with a notice after its text: the subagent tool answers in one text, which core shows the LLM. */
function noted(result: Result, notice: string): Result {
  const content = result.content
  if (content === undefined) return result
  return {
    ...result,
    content: typeof content === "string" ? `${content}\n\n${notice}` : [...content, { type: "text", text: notice }],
  }
}

/**
 * The resolved row a call's role runs on: `workers.single` for every call in `single` mode, else the role's row when
 * it has targets. `undefined` = no row (the agent's configured model, else the parent).
 */
function rowOf(root: Root, name: string) {
  const resolution = root.plan.resolution
  const workers = root.preset?.workers
  if (!resolution || !workers) return undefined
  const role = Preset.ROLES.find((item) => item === name)
  if (Preset.modeOf(workers) === "single") {
    const single = resolution.roles.general
    return single ? { role: role ?? "general", resolution: single } : undefined
  }
  const found = role && resolution.roles[role]
  return role && found?.targets.length ? { role, resolution: found } : undefined
}

/**
 * The default rule's pick for an agent under a model pool (07 §3.3 U7a), with a notice when the guidance's default for
 * it cannot run now; `undefined` = no pick and nothing to say (the agent runs as it would without a pool).
 */
function poolDefault(agent: string, root: Root, pool: Access.Pool): Decision | undefined {
  const key = Preset.poolPick(agent, pool.entries, pool.main)
  const role = Preset.ROLES.find((item) => item === agent)
  const usual = role === undefined ? undefined : pool.defaults[role]
  const missed = usual !== undefined && usual !== key ? pool.entries.find((entry) => entry.key === usual) : undefined
  const ref = pool.entries.find((entry) => entry.key === key)?.ref
  const notice = missed && Fallback.poolNotice(missed.key, ref ? key : undefined, missed.spent)
  if (ref) return { type: "model", ref, ...(notice ? { notice } : {}) }
  if (notice) return { type: "model", ref: root.main.parent, notice }
  return undefined
}

function reject(reason: "model" | "budget", roles: ReadonlyArray<Preset.Role>, requested: string): Decision {
  return { type: "reject", rejection: { reason, roles }, requested }
}

/** Whether a pool entry costs money (07 §5.3): a paid key, or a metered main account. */
function costs(entry: Access.PoolEntry) {
  return entry.side.runs === "paid" || entry.side.runs === "main-paid"
}

/** The call without `model`: `#<intent>` names no target, so the call runs where it would with `model` empty. */
function withoutModel(call: Call): Call {
  const { model: _effort, ...rest } = call
  return rest
}

/**
 * What the LLM reads when a per-call effort went out otherwise than asked (07 §2.3): a model without levels, a level
 * the model lacks (sent as its next level), or a level rounded down to the ceiling. Nothing when sent as asked.
 */
function sentAs(
  asked: string | undefined,
  fit: { readonly variant?: string; readonly unplaced: boolean; readonly capped: boolean },
) {
  if (fit.unplaced) return "Note: this subagent's model has no reasoning levels, so it runs without a reasoning effort."
  if (asked === undefined || asked === "default" || asked === fit.variant) return undefined
  const sent = fit.variant ?? "the model's default"
  return fit.capped
    ? `Note: reasoning effort ${asked} is above this session's limit on this model, so this subagent runs at ${sent}.`
    : `Note: this subagent's model has no reasoning effort ${asked}, so it runs at ${sent}.`
}

/** A per-call effort the preset's fixed level overrode (07 §2.3 강도 고정, PF 2026-11-03). */
function fixedAt(level: string, asked: string) {
  return `Note: this preset fixes reasoning effort at ${level}, so the requested ${asked} was not used.`
}

/**
 * The pool entry a decided call runs on (07 §2.3 강도 고정: its own fixed level wins over the preset's), found by the
 * entry's Ref; `undefined` outside a model pool or for a call on no entry.
 */
function poolEntryOf(decision: Decision, root: Root) {
  const ref = decision.type === "model" ? decision.ref : undefined
  const pool = root.plan.pool
  if (!ref || !pool) return undefined
  const key = pool.entries.find((entry) => entry.ref?.providerID === ref.providerID && entry.ref.id === ref.id)?.key
  return key === undefined ? undefined : root.preset?.workers.pool?.find((entry) => entry.key === key)
}

/** A continued child kept at its effort so its cache is kept (07 §5.5): how to get the asked one. */
function keptAt(current: string | undefined, asked: string | undefined) {
  return `Note: this continued subagent keeps reasoning effort ${current ?? "default"} so its cached context is kept; start a new subagent (no sessionID) to run at ${asked ?? "default"}.`
}

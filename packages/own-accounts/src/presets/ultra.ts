export * as PresetUltra from "./ultra.js"

import { Struct } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import { CodexMeta } from "../slots/codex-meta.js"
import { Variant } from "../switching/variant.js"
import type { PresetApply } from "./apply.js"
import { PresetBinding } from "./binding.js"

/**
 * Owner: PRESETS (07 §2.9). The composer's ultra switch, a session state kept in the binding (`ultra`), never in a
 * preset; a new session starts with it off.
 * - On: the main's effort follows the company's tool (`Preset.ultraEffort`): ChatGPT (`codex`, `siwc`, `oai`) the
 *   Codex rule (07 Appendix A), reading the model's Codex metadata (`CodexMeta`: `multi_agent_reasoning_effort` and
 *   the level order) for `codex` and `oai`, the same OpenAI models (07 §2.9; never `siwc`, 07 §2.2; never
 *   `ultra`); Claude unchanged unless `켤 때 강도도 xhigh로` (`raiseClaude`, only ever up from below `xhigh`); every
 *   other group the `xhigh` intent fitted to the model. The variant before is kept in `ultra.before` while ultra changed it.
 * - Off: that variant comes back, fitted to the model the session runs now (07 §2.3, in Codex's level order).
 * - A changed effort is a 02 variant switch: `switch.estimate` (returned, the cost dialog's numbers) and, without
 *   `dryRun`, `switch.apply{strategy:"now"}`, which waits for idle. Delegation and caps follow ultra through the
 *   guidance entry (`active`, the ultra caps).
 * - A user's own effort change on the same model turns ultra off, except for Claude (ultracode is a toggle apart from
 *   effort): {@link survives}. On Claude that effort is the user's from then on ({@link byHand}).
 * - Another account or main model keeps ultra on and decides its effort again for the new model ({@link after}):
 *   {@link Api.retune} switches to it at once on the effort-update path, otherwise the binding keeps it as
 *   `ultra.pending` until the user confirms the cost dialog (`session.ultra.set{on:true}`).
 */
export interface Api {
  set: RpcTypes.Handler<"session.ultra.set">
  /**
   * After the main moved with ultra on ({@link after} said `retune`): the effort ultra wants on the new model, as a
   * 02 variant switch now when it keeps the cache (`variantOnly.preservesCache`), else stored as `ultra.pending` for
   * the client's cost dialog. Never on the session's serial runner (the switch runs on it).
   */
  retune(sessionID: string): Promise<void>
  /** The main's effort ultra wants on this model now; `undefined` when it sends none (07 §2.9). */
  effort(
    group: Preset.Group,
    ref: Variant.Ref,
    variants: ReadonlyArray<string>,
    raiseClaude?: boolean,
  ): Promise<string | undefined>
}

export function create(deps: Deps, peers: Module.Peers, sessions: PresetApply.Api): Api {
  /**
   * The main model's Codex metadata row (07 §4.5) for ultra's Codex rule: `codex` and `oai`, the same OpenAI models
   * (07 §2.9: an API key on gpt-6-astra sends Codex's `xhigh`, not `max`); never `siwc` (07 §2.2).
   */
  const metaOf = (group: Preset.Group, modelID: string) =>
    group === "codex" || group === "oai" ? CodexMeta.model(deps, modelID) : Promise.resolve(undefined)

  const effort: Api["effort"] = async (group, ref, variants, raiseClaude) => {
    const current = plain(ref.variant)
    const meta = await metaOf(group, ref.id)
    const fit = Preset.ultraEffort(group, variants, {
      ...(current === undefined ? {} : { current }),
      ...(meta === undefined ? {} : { meta }),
      ...(raiseClaude ? { raiseClaude } : {}),
    })
    return fit.unplaced ? current : fit.variant
  }

  const set: Api["set"] = async (input, context) => {
    const sessionID = input.sessionID
    const session = await sessions.session(sessionID)
    const ref = session?.ref
    if (!session || !ref) return context.error("internal_error", "the session has no model", {})
    const group = peers().presets.groupOf(ref.providerID)
    if (!group) return context.error("internal_error", "the session's main is in no provider group", {})
    const binding = await sessions.binding(session, group)
    const variants = (await peers().presets.resolver.main(ref, sessionID))?.variants ?? []
    const current = plain(ref.variant)
    // The user's effort without ultra: what ultra replaced, else what runs now.
    const baseline = binding.ultra?.before === undefined ? current : (binding.ultra.before ?? undefined)
    const to = input.on
      ? await effort(
          group,
          { ...ref, ...(baseline === undefined ? {} : { variant: baseline }) },
          variants,
          input.raiseClaude,
        )
      : binding.ultra?.before === undefined
        ? current
        : Preset.effortToVariant(baseline, variants, await metaOf(group, ref.id)).variant
    const target = Variant.ref({
      providerID: ref.providerID,
      id: ref.id,
      ...(to === undefined ? {} : { variant: to }),
    })
    const changes = !Variant.same(ref, target)
    const variant = { from: nullable(current), to: nullable(to) }
    const state: Preset.Binding["ultra"] = input.on
      ? {
          ...(input.raiseClaude ? { raiseClaude: true } : {}),
          ...(to !== baseline ? { before: baseline === undefined ? null : Model.VariantID.make(baseline) } : {}),
        }
      : undefined
    const store = () => sessions.update(session, group, (bound) => withUltra(bound, state))

    const switching = peers().switching
    const declined = (error: unknown) => (error instanceof Declined ? error : Promise.reject(error))
    const estimated = changes
      ? await switching
          .estimate({ sessionID, target, reason: "manual" }, inner<"switch.estimate">(context.signal))
          .catch(declined)
      : null
    if (estimated instanceof Declined) return forward(context, estimated)
    // The in-process context throws instead of returning an error, so anything else is the estimate.
    const estimate = estimated && "estimateID" in estimated ? estimated : null
    if (input.dryRun) return { on: input.on, variant, estimate, dryRun: true }

    // Off: the binding first, so the switch back is not read as the user's own effort change. On: the switch first,
    // and ultra only when it was not refused.
    if (!input.on) {
      const committed = await store()
      if (!committed.ok) return context.error("internal_error", committed.message, {})
    }
    const result =
      estimate === null
        ? undefined
        : await switching
            .apply(
              { sessionID, estimateID: estimate.estimateID, target, strategy: "now", reason: "manual" },
              inner<"switch.apply">(context.signal),
            )
            .catch(declined)
    if (result instanceof Declined) return forward(context, result)
    const applied = result && "state" in result ? result : undefined
    const refused = applied?.state === "BLOCKED" || applied?.state === "FAILED"
    if (input.on && !refused) {
      const committed = await store()
      if (!committed.ok) return context.error("internal_error", committed.message, {})
    }
    return {
      on: input.on && !refused,
      variant,
      estimate,
      ...(applied ? { switch: applied } : {}),
      dryRun: false,
    }
  }

  return {
    effort,
    set,

    retune: async (sessionID) => {
      const session = await sessions.session(sessionID)
      const group = session?.ref && peers().presets.groupOf(session.ref.providerID)
      const bound = await PresetBinding.read(deps, sessionID)
      if (!session || !group || !bound?.ultra) return
      const input = {
        sessionID: SessionID.make(sessionID),
        on: true,
        ...(bound.ultra.raiseClaude ? { raiseClaude: true } : {}),
      }
      const context = inner<"session.ultra.set">(new AbortController().signal)
      const planned = await set({ ...input, dryRun: true }, context)
      if (!("variant" in planned)) return
      if (planned.estimate === null || planned.estimate.variantOnly?.preservesCache === true)
        return void (await set(input, context))
      const pending = planned.variant.to
      if (pending === null) return
      const stored = await sessions.update(session, group, (current) =>
        current.ultra ? { ...current, ultra: { ...current.ultra, pending } } : current,
      )
      if (!stored.ok) throw new Error(stored.message)
    },
  }
}

/**
 * Whether ultra stays on after the main changed from `previous` to `next` (07 §2.9): a change of account or model
 * keeps it (its effort is decided again for the new model), Claude keeps it on any effort, and on the same model of
 * another group only the effort ultra wants (`effort`) keeps it.
 */
export function survives(
  group: Preset.Group,
  previous: Variant.Ref | undefined,
  next: Variant.Ref,
  effort: string | undefined,
) {
  if (group === "claude-sub" || group === "anth") return true
  if (moved(previous, next)) return true
  return plain(next.variant) === effort
}

/**
 * Claude's ultra after the user's own effort change on the same model (UC 2026-10-18): ultra stays on (07 §2.9), but
 * the effort it raised is no longer ultra's, so `raiseClaude` and `before` go and turning ultra off keeps the effort
 * the user picked. ultra's own switch (to `effort`, the effort it wants now) and every other group change nothing.
 */
export function byHand(
  group: Preset.Group,
  ultra: NonNullable<Preset.Binding["ultra"]>,
  next: Variant.Ref,
  effort: string | undefined,
): NonNullable<Preset.Binding["ultra"]> {
  if (group !== "claude-sub" && group !== "anth") return ultra
  if (plain(next.variant) === effort) return ultra
  return Struct.omit(ultra, ["raiseClaude", "before"])
}

/** Whether the main moved to another account or model (not only another effort); an unknown previous main counts. */
export function moved(previous: Variant.Ref | undefined, next: Variant.Ref) {
  return !previous || previous.providerID !== next.providerID || previous.id !== next.id
}

/** The user's own effort with ultra on: what ultra replaced (`before`, `null` = none), else what the main runs. */
export function userEffort(ultra: NonNullable<Preset.Binding["ultra"]>, ref: Variant.Ref) {
  return ultra.before === undefined ? plain(ref.variant) : (ultra.before ?? undefined)
}

/**
 * Ultra after the main moved to `ref` (07 §2.9): still on, `want` being the effort it wants there ({@link Api.effort}
 * from {@link userEffort}). `before` keeps the user's own effort whenever ultra changes or will change it, so
 * `session.ultra.set` and turning it off read the same baseline; a pending effort of the previous model is dropped.
 * `retune`: the main runs another effort than `want` ({@link Api.retune}).
 */
export function after(ultra: NonNullable<Preset.Binding["ultra"]>, ref: Variant.Ref, want: string | undefined) {
  const user = userEffort(ultra, ref)
  const retune = plain(ref.variant) !== want
  const state: NonNullable<Preset.Binding["ultra"]> = {
    ...(ultra.raiseClaude ? { raiseClaude: true } : {}),
    ...(retune || want !== user ? { before: nullable(user) } : {}),
  }
  return { state, retune }
}

/** A binding with ultra set (`on`) or cleared, nothing else changed. */
function withUltra(binding: Preset.Binding, ultra: Preset.Binding["ultra"]): Preset.Binding {
  const { ultra: _previous, ...rest } = binding
  return ultra === undefined ? rest : { ...rest, ultra }
}

/** A Ref's variant as an effort: none for `default` (core's read of a Ref stored without one). */
function plain(variant: string | undefined) {
  return variant === undefined || variant === "default" ? undefined : variant
}

function nullable(variant: string | undefined) {
  return variant === undefined ? null : Model.VariantID.make(variant)
}

/** A switching error, carried out of the in-process call so `session.ultra.set` can answer it. */
class Declined {
  constructor(
    readonly type: string,
    readonly message: string,
    readonly data: unknown,
  ) {}
}

/**
 * The call context of an in-process call (switching's, or `session.ultra.set` itself in `retune`): a declared error
 * comes back as a rejected {@link Declined}.
 */
function inner<N extends "switch.estimate" | "switch.apply" | "session.ultra.set">(
  signal: AbortSignal,
): RpcTypes.Context<N> {
  return {
    signal,
    error: (type: string, message: string, data?: unknown) => {
      throw new Declined(type, message, data)
    },
  }
}

/**
 * A switching error as `session.ultra.set`'s own: the errors it declares too keep their data, which switching built
 * with the same `OwnError.data` schema; any other (a team switch, a staged revert …) is `internal_error`.
 */
function forward(context: RpcTypes.Context<"session.ultra.set">, declined: Declined) {
  const message = declined.message
  // SAFETY: each `data` below was built by switching for this very error type (`OwnError.data[type]`).
  const data = declined.data as never
  switch (declined.type) {
    case "account_not_found":
      return context.error("account_not_found", message, data)
    case "slot_misconfigured":
      return context.error("slot_misconfigured", message, data)
    case "no_eligible_target":
      return context.error("no_eligible_target", message, data)
    case "session_busy":
      return context.error("session_busy", message, data)
    case "needs_reauth":
      return context.error("needs_reauth", message, data)
    case "vault_unavailable":
      return context.error("vault_unavailable", message, data)
  }
  return context.error("internal_error", `${declined.type}: ${message}`, {})
}

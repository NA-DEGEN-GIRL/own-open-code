export * as PresetForce from "./force.js"

import { SessionID } from "@opencode/schema/session-id"
import { Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import { Variant } from "../switching/variant.js"
import { PresetBinding } from "./binding.js"
import { PresetStore } from "./store.js"

/**
 * Owner: PRESETS (07 §2.3 강도 고정, PF 2026-11-03). A preset's `forcedEffort` on the conversation's main: the level
 * fitted to the main model's own levels (`Preset.forcedFit`, the nearest the model has, said on screen) becomes the
 * main's effort when the preset is applied, when a new root is bound to it, when the main moves to another model or
 * account, and when the preset's forced level is edited. In between the user may pick another effort in the composer
 * (an override for the conversation until one of those moments). Ultra keeps its own effort (07 §2.9).
 *
 * A changed effort is a 02 variant switch (`switch.estimate`, then `switch.apply{strategy:"now"}`, which waits for
 * idle), the same path as ultra's; a route without per-message effort updates rewrites the prompt prefix once, which
 * the user accepted by choosing a preset that fixes the effort. Subagents take the level in the gate (`Gate`).
 */
export interface Api {
  /** The main's effort the preset in effect fixes now; `undefined` when it fixes none, ultra is on, or no model. */
  want(sessionID: string): Promise<Want | undefined>
  /**
   * Switches the main to {@link want} when it runs another effort. Never on the session's serial runner (the switch
   * runs on it); a busy session's switch waits for its idle, so callers must not await it then. Never throws.
   */
  enforce(sessionID: string): Promise<void>
}

export interface Want {
  readonly level: Preset.ForcedEffort
  readonly variant: string | undefined
  readonly ref: Variant.Ref
}

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("presets.force")

  const want: Api["want"] = async (sessionID) => {
    const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
    const ref = info?.model
    if (!ref || info.parentID) return undefined
    const presets = peers().presets
    const group = presets.groupOf(ref.providerID)
    if (!group) return undefined
    const binding = await PresetBinding.read(deps, sessionID)
    if (binding?.ultra) return undefined
    const level = Preset.forcedEffortOf(PresetStore.inEffect(presets, binding, group).forcedEffort)
    if (!level) return undefined
    const main = await presets.resolver.main(ref, sessionID)
    const fit = Preset.forcedFit(level, main?.variants ?? [], main?.meta)
    return fit.unplaced ? undefined : { level, variant: fit.variant, ref }
  }

  const enforce: Api["enforce"] = async (sessionID) => {
    const wanted = await want(sessionID).catch(() => undefined)
    if (!wanted) return
    const target = Variant.ref({
      providerID: wanted.ref.providerID,
      id: wanted.ref.id,
      ...(wanted.variant === undefined ? {} : { variant: wanted.variant }),
    })
    if (Variant.same(wanted.ref, target)) return
    const switching = peers().switching
    const id = SessionID.make(sessionID)
    const estimated = await switching
      .estimate({ sessionID: id, target, reason: "manual" }, inner<"switch.estimate">())
      .catch((error: unknown) => log.info("preset_forced_effort_skipped", { sessionID, error: String(error) }))
    if (!estimated || !("estimateID" in estimated)) return
    await switching
      .apply(
        { sessionID: id, estimateID: estimated.estimateID, target, strategy: "now", reason: "manual" },
        inner<"switch.apply">(),
      )
      .then(() => log.info("preset_forced_effort", { sessionID, level: wanted.level, variant: wanted.variant }))
      .catch((error: unknown) => log.warn("preset_forced_effort_failed", { sessionID, error: String(error) }))
  }

  return { want, enforce }
}

/** An in-process call context: a declared error rejects, so the caller logs it and leaves the main as it is. */
function inner<N extends "switch.estimate" | "switch.apply">(): RpcTypes.Context<N> {
  return {
    signal: new AbortController().signal,
    error: (type: string, message: string, _data?: unknown) => {
      throw new Error(`${type}: ${message}`)
    },
  }
}

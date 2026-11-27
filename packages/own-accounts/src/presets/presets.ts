export * as Presets from "./presets.js"

import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Preset } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import type { Variant } from "../switching/variant.js"
import { Access } from "./access.js"
import { Agents } from "./agents.js"
import { PresetApply } from "./apply.js"
import { PresetConsent } from "./consent.js"
import { PresetForce } from "./force.js"
import { Gate } from "./gate.js"
import { PresetGuidance } from "./guidance.js"
import { ModelsFilter } from "./models-filter.js"
import { PresetRepair } from "./repair.js"
import { PresetResolve } from "./resolve.js"
import { PresetStore } from "./store.js"
import { PresetSuggest } from "./suggest.js"
import { PresetUltra } from "./ultra.js"

/**
 * Owner: PRESETS (07). The `presets` module: `presets.json` with each group's presets, ★, lighter pairs,
 * new-session default model and repair history and the `presets.*` methods (`PresetStore`), target resolution
 * (`resolver`, `PresetResolve`, with the lighter pairs of `PresetLighter`), suggestions and starters
 * (`PresetSuggest`), the session binding with its `own.preset` guidance entry (`PresetApply`, `PresetGuidance`,
 * `PresetBinding`), ultra (`PresetUltra`), the per-message raise and paid-use consent (`PresetConsent`), repair
 * notices and the gone-main guard (`repair`, `PresetRepair`, 07 §4.3), the subagent gate (`Gate`, tool
 * `execute.before`), the `opencode_models` filter (`ModelsFilter`, tool `execute.after`) and the check of hidden agents'
 * configured models (`Agents`, `ctx.agent.transform`). `hooks.ts` registers the hooks in setup; `Agents` adds its late
 * `agent.transform` registration. Bound sessions follow `presets.json` changes (`store.changed{presets}`) and their
 * main's `session.model.selected`.
 */
export interface Api extends PresetStore.Api {
  /** Target resolution over the live registry, catalog and lighter pairs (07 §4.2). */
  readonly resolver: PresetResolve.Api
  /** Repair notices of gone models and the gone-main guard (07 §4.3). */
  readonly repair: Pick<PresetRepair.Api, "main" | "check">
  suggest: RpcTypes.Handler<"presets.suggest">
  onToolBefore(event: Gate.Before): Promise<void>
  onToolAfter(event: ModelsFilter.After): Promise<void>
  /** `ctx.agent.transform` fold body. No I/O. */
  transformAgents(editor: AgentEditor): void
  /** Hidden agents' models the latest folds of every live instance removed (`diagnostics.selfTest.agentModels`). */
  removedAgentModels(): ReadonlyArray<Agents.Removal>
  /** The Claude slot's detection changed (`plugins` `setSlot`): the hidden agents' check may judge differently. */
  recheckAgents(): void
  /** The group of a main on this provider, as the gate sees it (`Access.groupOf`); the session binding uses it. */
  groupOf(providerID: string): Preset.Group | undefined
  /** `session.preset.get` (07 §8.1). */
  sessionGet: RpcTypes.Handler<"session.preset.get">
  /** `session.preset.apply` (07 §5.3). */
  sessionApply: RpcTypes.Handler<"session.preset.apply">
  /** `session.ultra.set` (07 §2.9). */
  ultraSet: RpcTypes.Handler<"session.ultra.set">
  /** `session.preset.raiseOnce` (07 §2.6). */
  raiseOnce: RpcTypes.Handler<"session.preset.raiseOnce">
  /** `session.preset.consent` (07 §5.4 step 4). */
  consent: RpcTypes.Handler<"session.preset.consent">
  /**
   * The `own.preset` entry a new root's first binding needs (`PresetBinding.ensure`, on the session's runner): written
   * now when the preset needs one; its hash, or `null` without an entry.
   */
  entry(sessionID: string, ref: Variant.Ref, preset: Preset.Info): Promise<string | null>
  /** The preset's fixed effort on a root's main (`PresetForce`, 07 §2.3 강도 고정); never on the session's runner. */
  enforce: PresetForce.Api["enforce"]
}

export interface Options {
  /** Default `localVerified`: a local model whose running window the slots verified (07 §6.2 #8, PG9). */
  readonly resolver?: PresetResolve.Options
  /**
   * The own service the guidance entry is written to (06 §2.6 self-HTTP). Default: the registration file of this
   * server's channel (`ServiceTarget.Service`), read on first use; source runs and tests pass `ServiceTarget.fixed`.
   */
  readonly service?: ServiceTarget.Source
}

export function create(deps: Deps, peers: Module.Peers, options: Options = {}): Api {
  const log = deps.log.child("presets")
  const store = PresetStore.create(deps, peers)
  const access = Access.create(deps, peers)
  const agents = Agents.create(deps, peers, access)
  const service: { source?: ServiceTarget.Source } = { source: options.service }
  const writer = PresetGuidance.writer(() => {
    service.source ??= new ServiceTarget.Service(ServiceTarget.registrationPath(deps.ctx.app.channel))
    return service.source
  })
  const repair = PresetRepair.create(deps, peers)
  const consent: PresetConsent.Api = PresetConsent.create(deps, peers, (sessionID) => sessions.caps(sessionID))
  const force = PresetForce.create(deps, peers)
  const sessions: PresetApply.Api = PresetApply.create(deps, peers, {
    writer,
    effort: (...input) => ultra.effort(...input),
    retune: (sessionID) => ultra.retune(sessionID),
    main: repair.main,
    enforce: force.enforce,
  })
  const ultra = PresetUltra.create(deps, peers, sessions)
  const stops: Array<() => void> = []
  return {
    ...store,
    resolver: PresetResolve.create(deps, peers, store, {
      localVerified: (providerID, modelID) => peers().slots.localWindow(providerID, modelID)?.status === "verified",
      ...options.resolver,
    }),
    repair: { main: repair.main, check: repair.check },
    suggest: PresetSuggest.create(deps, peers),
    start: async () => {
      await store.start()
      await agents.start()
      await repair.start()
      const reconcile = () =>
        void sessions.reconcile().catch((error: unknown) => log.warn("preset_reconcile_failed", { error }))
      // After the store's own listener, which takes the changed file synchronously (the runtime cached it first).
      stops.push(
        deps.runtime.broadcast.on("store.changed", (payload) => {
          if (payload.store !== "presets") return
          reconcile()
        }),
      )
      // 07 §5.3: this Location's sessions bound to a preset removed or edited while the Location was not loaded follow
      // now, entry included. A remote service follows the mirrored `presets.json` the same way (07 §8.1 원격; a mirror
      // that could not be read keeps its last file, so nothing is rebound by a read error). On the next turn of the
      // event loop, once the modules after this one (switching's per-session queue) have started too.
      const initial = setTimeout(reconcile, 0)
      stops.push(() => clearTimeout(initial))
    },
    stop: async () => {
      for (const stop of stops.splice(0)) stop()
      await repair.stop()
      await agents.stop()
      await store.stop()
    },
    onEvent: (event, meta) => {
      agents.onEvent?.(event, meta)
      repair.onEvent?.(event, meta)
      if (meta.local) {
        consent.observe(event)
        if (event.type === "session.model.selected")
          sessions.onModelSelected(event.data.sessionID, event.data.model, event.data.previous)
      }
      return store.onEvent?.(event, meta)
    },
    onToolBefore: Gate.create(deps, peers, access),
    onToolAfter: ModelsFilter.create(access),
    transformAgents: agents.transform,
    removedAgentModels: agents.removed,
    recheckAgents: agents.recheck,
    groupOf: access.groupOf,
    sessionGet: sessions.get,
    sessionApply: sessions.apply,
    ultraSet: ultra.set,
    raiseOnce: consent.raiseOnce,
    consent: consent.consent,
    entry: sessions.entry,
    enforce: force.enforce,
  }
}

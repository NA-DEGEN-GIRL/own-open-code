export * as SessionCompaction from "./compaction.js"

import { Option, Predicate, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { ClaudeAgent, Compaction, Kv, Switch } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Emitter } from "../emitter.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import type { SwitchInbox } from "./inbox.js"
import type { Planner } from "./planner.js"
import type { Tracker } from "./tracker.js"
import type { Variant } from "./variant.js"

/**
 * The session side of auto-compaction (02 §4.7.4): the "compact earlier" value (`compaction.setSession`, KV
 * `sess:<sid>:compaction`), `compaction.due` detection on `step.ended`, the staged-revert guard, and the
 * `cache.state.compaction` view. The slot threshold itself is enforced by core through the registered `limit.input`
 * (slots); this module only ever compacts earlier. It admits those compactions on the server through the plugin's
 * `session.compact` (upstream 924c12b291, {@link compact}), so they run without a connected client, and never while a
 * revert is staged, because admitting a compaction commits a staged revert (4.7.1).
 */

export interface Host {
  readonly deps: Deps
  readonly peers: Module.Peers
  readonly tracker: Tracker.Store
  readonly planner: Planner.Planner
  /** The session's current model; loads it (and its revert state) when unknown. */
  readonly current: (sessionID: string) => Promise<Variant.Ref | undefined>
  /** The switch state machine waits for a compaction it asked for (COMPACTING). */
  readonly switchCompacting: (sessionID: string) => boolean
  readonly emit: <N extends Emitter.SessionEvent>(name: N, body: RpcTypes.EventBody<N>) => void
  /** The session's pending inbox, read back after a resubscribe lost events (`Tracker.Store.resync`). */
  readonly inbox: SwitchInbox.Reader
}

export type SetResult =
  | { readonly ok: true; readonly compaction: Compaction.View | null }
  | { readonly ok: false; readonly error: Compaction.OutOfRange }

const decodeValue = Schema.decodeUnknownOption(Switch.SessionCompaction)
const decodeDue = Schema.decodeUnknownOption(Switch.CompactionDue)
const decodeEpoch = Schema.decodeUnknownOption(Schema.Int)
const decodeSessionID = Schema.decodeUnknownOption(SessionID)
const toJson = Schema.decodeUnknownSync(Schema.Json)
const encodeDue = Schema.encodeSync(Switch.CompactionDue)

export function create(host: Host) {
  const deps = host.deps
  const storage = () => deps.ctx.storage
  const log = deps.log.child("switching.compaction")
  /** Sessions whose pending due was sent a second time (02 §4.7.4: once more on the next `step.ended`). */
  const repeated = new Set<string>()
  /** Revert staged, per session; missing = ask the index, then the session itself. */
  const staged = new Map<string, boolean>()

  const now = () => deps.clock.now()

  async function value(sessionID: string) {
    const stored = await storage()
      .get(Kv.compaction(sessionID))
      .catch(() => undefined)
    return Option.getOrUndefined(decodeValue(stored))?.triggerTokens
  }

  async function due(sessionID: string) {
    const stored = await storage()
      .get(Kv.compactionDue(sessionID))
      .catch(() => undefined)
    return Option.getOrUndefined(decodeDue(stored))
  }

  async function clearDue(sessionID: string) {
    repeated.delete(sessionID)
    await storage()
      .remove(Kv.compactionDue(sessionID))
      .catch(() => undefined)
  }

  /** The cold point count: compactions and committed reverts (telemetry's KV epoch, else what this instance saw). */
  async function epoch(sessionID: string) {
    const stored = await storage()
      .get(Kv.epoch(sessionID))
      .catch(() => undefined)
    return Math.max(host.tracker.epoch(sessionID), Option.getOrUndefined(decodeEpoch(stored)) ?? 0)
  }

  function revertStaged(sessionID: string) {
    return staged.get(sessionID) ?? deps.runtime.sessions.get(sessionID)?.revertStaged ?? false
  }

  /** Records a revert state change (`session.revert.*`, or a lookup after a restart). */
  async function setRevert(sessionID: string, value: boolean) {
    staged.set(sessionID, value)
    deps.runtime.sessions.update(sessionID, { revertStaged: value })
    if (value) await clearDue(sessionID)
  }

  /** P of 02 §4.7.4 as last measured; after a restart, the index's last value. */
  function measuredP(sessionID: string) {
    if (host.tracker.measured(sessionID)) return host.tracker.P(sessionID)
    return deps.runtime.sessions.get(sessionID)?.P ?? null
  }

  /**
   * The session's current model with its slot threshold and the effective one. Runs on every step end (via
   * `cache.state`), so it reads memory first: own slots and the Claude slot resolve from the registry and the fold's
   * catalog snapshot; only a built-in provider's window needs the planner's catalog lookup.
   */
  async function resolved(sessionID: string) {
    const model = await host.current(sessionID)
    if (!model) return undefined
    const slot =
      host.peers().slots.compaction(model.providerID, model.id, undefined, sessionID) ??
      (await host.planner.resolve(model, sessionID)).compaction?.slot
    if (!slot) return undefined
    return { model, compaction: { slot, effective: Compaction.withSession(slot, await value(sessionID)) } }
  }

  /** `cache.state.compaction` (02 §9.2); `null` for an unpinned session or an unknown window. */
  async function view(sessionID: string): Promise<Compaction.View | null> {
    const found = await resolved(sessionID)
    if (!found) return null
    const slot = found.compaction.slot
    const effective = found.compaction.effective
    const core = host.peers().slots.core()
    const P = measuredP(sessionID)
    const pending = revertStaged(sessionID) ? undefined : await due(sessionID)
    const current = pending && pending.epoch === (await epoch(sessionID)) ? pending : undefined
    return {
      providerID: Provider.ID.make(found.model.providerID),
      modelID: Model.ID.make(found.model.id),
      windowTokens: slot.windowTokens,
      triggerTokens: effective.triggerTokens,
      slotTriggerTokens: slot.triggerTokens,
      source: effective.source,
      sessionTriggerTokens: effective.sessionTriggerTokens,
      floorTokens: slot.floorTokens,
      keepTokens: core.keepTokens,
      auto: core.auto,
      P,
      remainingTokens: P === null ? null : Math.max(0, effective.triggerTokens - P),
      cycle: {
        Z: host.tracker.Z(sessionID),
        delta: host.tracker.delta(sessionID),
        summary: host.tracker.summary(sessionID),
      },
      pendingDue: current ? { inputID: current.inputID, P: current.P, triggerTokens: current.triggerTokens } : null,
    }
  }

  /**
   * `compaction.setSession` (02 §9.2): `[floorTokens, slotTriggerTokens)` or `null`. The caller emits `cache.state`
   * and then runs {@link check}, so a value already below `P` compacts right away.
   */
  async function set(sessionID: string, triggerTokens: number | null): Promise<SetResult> {
    const key = Kv.compaction(sessionID)
    const found = await resolved(sessionID)
    if (triggerTokens === null) {
      await storage().remove(key)
      await clearDue(sessionID)
      return { ok: true, compaction: found ? await view(sessionID) : null }
    }
    if (!found) return { ok: false, error: { field: "triggerTokens", min: null, max: null } }
    const slot = found.compaction.slot
    if (!Number.isInteger(triggerTokens) || triggerTokens < slot.floorTokens || triggerTokens >= slot.triggerTokens)
      return { ok: false, error: { field: "triggerTokens", min: slot.floorTokens, max: slot.triggerTokens - 1 } }
    await storage().set(key, toJson({ triggerTokens, setAt: now() }))
    return { ok: true, compaction: await view(sessionID) }
  }

  /**
   * Admits a compaction of the session on the server (`ctx.session.compact`, 02 §4.7.4), as a client's `POST /compact`
   * would, so it runs with no client connected. Never while a revert is staged: read from the session itself right
   * before, because the admission would commit it. With `inputID`, a repeat or a client's admission of the same
   * `compaction.due` is the same item, and a conflict means that item was already delivered. `failed` leaves it to the
   * next attempt (or a connected client).
   */
  async function compact(sessionID: string, inputID?: SessionMessage.ID) {
    const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
    if (!info) return "failed" as const
    if (info.revert !== undefined) {
      await setRevert(sessionID, true)
      return "revert_staged" as const
    }
    return deps.ctx.session.compact({ sessionID, ...(inputID === undefined ? {} : { id: inputID }) }).then(
      () => "admitted" as const,
      (error: unknown) => {
        if (Predicate.isTagged(error, "Session.CompactionConflictError")) return "admitted" as const
        log.warn("compaction_admit_failed", { sessionID, error })
        return "failed" as const
      },
    )
  }

  /**
   * `compaction.due` detection (02 §4.7.4), after every `step.ended` of a local session and after `setSession`. Due
   * when the session value is the effective threshold, `P` reached it, no compaction runs or is awaited by the switch
   * machine, no context reset waits, and no revert is staged; one per epoch, repeated once with the same `inputID` if no
   * compaction started. After a resubscribe lost events, the waiting reset and a running compaction are read back first.
   * The server admits it ({@link compact}); the event then tells clients, whose admission of the same id changes nothing.
   */
  async function check(sessionID: string) {
    if (revertStaged(sessionID)) return
    // Without a session value only a Claude Agent conversation can be due: core keeps its own ceiling for that route.
    if (
      (await value(sessionID)) === undefined &&
      (await host.current(sessionID))?.providerID !== ClaudeAgent.PROVIDER_ID
    )
      return
    const found = await resolved(sessionID)
    const P = measuredP(sessionID)
    if (!found || P === null || !ownEnforced(found.model.providerID, found.compaction)) return
    const triggerTokens = found.compaction.effective.triggerTokens
    if (P < triggerTokens) return
    if (host.tracker.stale(sessionID)) await resync(sessionID)
    if (host.tracker.get(sessionID)?.compacting || host.switchCompacting(sessionID)) return
    // A context reset waiting for the turn leaves nothing to compact: core would settle the compaction as not needed
    // when it applies (11 §7.2), and a client admitting the due's id after that would compact the empty new context.
    if (host.tracker.get(sessionID)?.waitingReset !== undefined) return
    const current = await epoch(sessionID)
    const pending = await due(sessionID)
    const id = Option.getOrUndefined(decodeSessionID(sessionID))
    if (!id) return
    const admit = async (inputID: SessionMessage.ID) => {
      if ((await compact(sessionID, inputID)) === "revert_staged") return
      host.emit("compaction.due", { sessionID: id, inputID, P, triggerTokens, epoch: current })
    }
    if (pending && pending.epoch === current) {
      if (repeated.has(sessionID)) return
      repeated.add(sessionID)
      return admit(pending.inputID)
    }
    const record: Switch.CompactionDue = {
      inputID: SessionMessage.ID.create(),
      epoch: current,
      P,
      triggerTokens,
      at: now(),
    }
    repeated.delete(sessionID)
    await storage().set(Kv.compactionDue(sessionID), toJson(encodeDue(record)))
    log.info("compaction_due", { sessionID, P, triggerTokens, epoch: current })
    await admit(record.inputID)
  }

  /**
   * Whether own, not core, compacts the session at its effective threshold: a session value ("compact earlier"), or a
   * Claude Agent conversation whose kind default or account setting lies below core's ceiling (CAG-50). Core registers
   * one window per route model for every Claude Agent account, so own cannot hand it a per-account `limit.input`.
   */
  function ownEnforced(
    providerID: string,
    compaction: { readonly slot: Compaction.Resolved; readonly effective: Compaction.SessionResolved },
  ) {
    if (compaction.effective.source === "session") return true
    return providerID === ClaudeAgent.PROVIDER_ID && compaction.effective.triggerTokens < compaction.slot.ceilingTokens
  }

  /**
   * After a resubscribe lost events (events.ts), the waiting context reset and a running compaction as the server has
   * them: the session inbox (self-HTTP) and its context. Without both answers the session stays stale and the next
   * check reads again; until then the tracker's values hold.
   */
  async function resync(sessionID: string) {
    const mark = host.tracker.mark(sessionID)
    const [inbox, context] = await Promise.all([
      host.inbox(sessionID).catch(() => undefined),
      deps.ctx.session.context({ sessionID }).catch(() => undefined),
    ])
    if (!inbox || !context) return
    host.tracker.resync(sessionID, mark, {
      waitingReset: inbox.find((item) => item.type === "reset")?.id,
      compacting: context.some((message) => message.type === "compaction" && message.status === "running"),
    })
  }

  /** `compaction.started`: whoever asked, the due is answered (02 §4.7.4). */
  async function started(sessionID: string) {
    await clearDue(sessionID)
  }

  return { view, set, check, compact, started, revertStaged, setRevert, clearDue, value, epoch }
}

export type SessionCompaction = ReturnType<typeof create>

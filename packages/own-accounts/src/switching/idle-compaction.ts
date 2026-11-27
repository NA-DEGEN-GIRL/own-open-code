export * as IdleCompaction from "./idle-compaction.js"

import { Option, Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { CompactionCache, Kv, OwnID } from "@own/protocol"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { OwnTeam } from "@own/protocol/rpc-team"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { SessionCompaction } from "./compaction.js"
import type { Tracker } from "./tracker.js"

/**
 * Idle compaction before the cache expires (02 §4.7.7, CC 2026-10-24). An opt-in (`policy.compaction.idle.enabled`),
 * off by default: it compacts below the threshold on own's initiative and spends whether or not the user comes back
 * (U6, 07 P-D8). When a session goes idle on a cache that surely expires at `TTL_lo` (`CompactionCache.idleSuits`: OpenAI
 * GPT-5.6+, Anthropic), a timer fires {@link CompactionCache.IDLE} `leadSeconds` before `TTL_lo` after its last primary
 * request started (the lifetime counts from a request's start). If the user has been away `minIdleMinutes` by then and
 * every gate holds, it admits a compaction the way `compaction.due` does (the staged-revert check included), once per
 * cold point epoch. That compaction reads the still warm cache (the older request, or on Anthropic the full-prefix one
 * where that would miss, P-034), so coming back rebuilds only the checkpoint instead of the whole context. It gets no
 * stand-in models and no digest (own-harness reads the trigger): a failed one leaves the session as it was. ChatGPT and
 * DeepSeek are never compacted this way, nor child, team or imported sessions, nor a session a client still shows on a
 * screen the user touched within `policy.awayDetect.hiddenMinutes` (`session.presence`, when that is on and a client
 * reports). The compaction hook tells the admitted item from a user's `/compact` by the session's durable history
 * (`origin`) and drops it when it delivers too late. Not the Anthropic `max_tokens: 0` keep-alive (not approved).
 */
export interface Host {
  readonly deps: Deps
  readonly peers: Module.Peers
  readonly tracker: Tracker.Store
  readonly compaction: SessionCompaction
  /** The switch state machine of the session is at rest (no planned, scheduled, waiting or compacting switch). */
  readonly switchIdle: (sessionID: string) => boolean
  /** The session's serial work queue (`Switching.Api.serial`). */
  readonly serial: <T>(sessionID: string, work: () => Promise<T>) => Promise<T>
}

/** What a skipped, admitted or dropped idle compaction records (`compaction.idle` ledger event, the log). */
export type Outcome =
  | "admitted"
  | "late"
  | "returned"
  | "revert_staged"
  | "failed"
  | "disabled"
  | "expired"
  | "busy"
  | "pending"
  | "switch"
  | "moved"
  /** The session's tree moved to another Claude account since its last request (SL-8): that cache is not its. */
  | "account"
  | "away"
  | "present"
  | "small"
  | "session"
  | "children"
  | "limit"
  | "epoch"

/**
 * The running compaction is the idle one (`{}`), or it is but delivered too late and is dropped with this message
 * (`drop`, core P-034 `cancel`): after its deadline (the cache cooled) or after the user came back.
 */
export interface Origin {
  readonly drop?: string
}

/** The messages of a dropped idle compaction (its compaction row shows it as cancelled). */
export const DROPPED = {
  late: "Dropped: this idle compaction was delivered after its cache had cooled",
  returned: "Dropped: the user was back before this idle compaction ran",
} as const

const decodeRecord = Schema.decodeUnknownOption(CompactionCache.IdleRecord)
const toJson = Schema.decodeUnknownSync(Schema.Json)
const encodeRecord = Schema.encodeSync(CompactionCache.IdleRecord)

export function create(host: Host) {
  const deps = host.deps
  const log = deps.log.child("switching.idle")
  const now = () => deps.clock.now()
  const timers = new Map<string, () => void>()
  /** When each local session's last execution ended. */
  const idleSince = new Map<string, number>()
  /** Unanswered inbox items and permission or question requests, per session. */
  const waiting = new Map<string, Set<string>>()
  /** When a client last showed each session to the user (`session.presence`, CC-14). */
  const presence = new Map<string, number>()
  /** When the user last sent each session a prompt (the prompt hook, before the prompt wakes the runner). */
  const prompted = new Map<string, number>()
  /** Idle items already reported as dropped. */
  const dropped = new Set<string>()
  let stopped = false

  const policy = () => {
    const idle = deps.runtime.policy.cached()?.compaction?.idle
    return idle?.enabled === true
      ? {
          minTokens: idle.minTokens ?? CompactionCache.IDLE.minTokens,
          minIdleMinutes: idle.minIdleMinutes ?? CompactionCache.IDLE.minIdleMinutes,
        }
      : undefined
  }

  function cancel(sessionID: string) {
    timers.get(sessionID)?.()
    timers.delete(sessionID)
  }

  function mark(sessionID: string, id: string, on: boolean) {
    const set = waiting.get(sessionID) ?? new Set<string>()
    if (on) set.add(id)
    else set.delete(id)
    if (set.size === 0) waiting.delete(sessionID)
    else waiting.set(sessionID, set)
  }

  /** Local events only (the switching module's dispatcher). */
  function onEvent(event: Module.OpenCodeEvent) {
    switch (event.type) {
      case "session.execution.started":
      case "session.step.started":
        cancel(event.data.sessionID)
        idleSince.delete(event.data.sessionID)
        return
      case "session.compaction.started":
        cancel(event.data.sessionID)
        idleSince.delete(event.data.sessionID)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        idleSince.set(event.data.sessionID, now())
        void arm(event.data.sessionID).catch((error: unknown) => log.warn("idle_arm_failed", { error }))
        return
      case "session.inbox.enqueued":
        mark(event.data.sessionID, event.data.inboxID, true)
        return
      case "session.inbox.delivered":
        mark(event.data.sessionID, event.data.inboxID, false)
        return
      case "session.inbox.cancelled":
        mark(event.data.sessionID, event.data.inboxID, false)
        return
      case "permission.asked":
        mark(event.data.sessionID, event.data.id, true)
        return
      case "permission.replied":
        mark(event.data.sessionID, event.data.requestID, false)
        return
      case "session.deleted":
        cancel(event.data.sessionID)
        idleSince.delete(event.data.sessionID)
        waiting.delete(event.data.sessionID)
        presence.delete(event.data.sessionID)
        prompted.delete(event.data.sessionID)
        return
      default:
        return
    }
  }

  /** Arms the session's timer at `deadline − lead` when the setting is on and its cache suits idle compaction. */
  async function arm(sessionID: string) {
    cancel(sessionID)
    if (stopped || policy() === undefined) return
    const cache = await host.peers().telemetry.primaryCache(sessionID)
    const ttl = cache?.ttl
    // A Claude account switch since the last request: the next account has none of this cache to keep (SL-8).
    if (!cache || cache.moved || !CompactionCache.idleSuits(ttl) || EXCLUDED.has(cache.kind ?? "")) return
    const deadline = cache.startedAt + ttl.lo
    const fireAt = deadline - CompactionCache.IDLE.leadSeconds * 1000
    if (fireAt <= now()) return
    timers.set(
      sessionID,
      deps.clock.schedule(fireAt - now(), () => {
        timers.delete(sessionID)
        void host
          .serial(sessionID, () => fire(sessionID, cache.startedAt, deadline))
          .then((outcome) => record(sessionID, outcome, { deadline, ttlMs: ttl.lo, P: host.tracker.P(sessionID) }))
          .catch((error: unknown) => log.warn("idle_compaction_failed", { sessionID, error }))
      }),
    )
  }

  /** The gates at fire time (02 §4.7.7), then the admission. */
  async function fire(sessionID: string, startedAt: number, deadline: number): Promise<Outcome> {
    const setting = policy()
    if (setting === undefined || host.peers().slots.core().auto === false) return "disabled"
    if (now() >= deadline) return "expired"
    const session = host.tracker.get(sessionID)
    if (!session || session.busy || session.compacting) return "busy"
    if (waiting.has(sessionID)) return "pending"
    if (!host.switchIdle(sessionID)) return "switch"
    const cache = await host.peers().telemetry.primaryCache(sessionID)
    if (cache?.startedAt !== startedAt) return "moved"
    if (cache.moved) return "account"
    const since = idleSince.get(sessionID)
    if (since === undefined || now() - since < setting.minIdleMinutes * 60_000) return "away"
    // Reading a long answer is not being away: a screen that shows the session holds it back (CC-14).
    const away = deps.runtime.policy.cached()?.awayDetect
    const shown = presence.get(sessionID)
    if (away?.enabled === true && shown !== undefined && now() - shown < away.hiddenMinutes * 60_000) return "present"
    if (!host.tracker.measured(sessionID) || host.tracker.P(sessionID) < setting.minTokens) return "small"
    if (session.child || session.imported) return "session"
    const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
    if (!info || info.parentID !== undefined) return "session"
    if (OwnImportRouting.marked(info.metadata) || info.metadata?.[OwnTeam.SESSION_META] !== undefined) return "session"
    if (deps.runtime.sessions.children(sessionID).some((child) => child.busy)) return "children"
    if (overLimit(sessionID, cache.providerID)) return "limit"
    const epoch = await host.compaction.epoch(sessionID)
    const previous = Option.getOrUndefined(decodeRecord(await deps.ctx.storage.get(Kv.idleCompaction(sessionID))))
    if (previous?.epoch === epoch) return "epoch"
    const inputID = SessionMessage.ID.create()
    await deps.ctx.storage.set(
      Kv.idleCompaction(sessionID),
      toJson(encodeRecord({ epoch, inputID, at: now(), deadline })),
    )
    return host.compaction.compact(sessionID, inputID)
  }

  /**
   * The running compaction's origin, read in the compaction hook (CC-16). The runner projects a delivered `/compact`
   * item as the running compaction message, under the item's id, before the hooks run, so this epoch's record and the
   * session's durable history tell the idle item from a user's `/compact`, after a restart too, whatever order the
   * events reach this module in. An idle item that delivers only after its deadline, or after the user came back (a
   * prompt, or with `awayDetect` on a screen showing the session), is dropped rather than run.
   */
  async function origin(sessionID: string): Promise<Origin | undefined> {
    const admitted = Option.getOrUndefined(decodeRecord(await deps.ctx.storage.get(Kv.idleCompaction(sessionID))))
    if (!admitted) return undefined
    const history = await deps.ctx.session.context({ sessionID })
    const running = history.findLast((message) => message.type === "compaction" && message.status === "running")
    if (running?.id !== admitted.inputID) return undefined
    const late = now() >= admitted.deadline
    const shown = deps.runtime.policy.cached()?.awayDetect?.enabled === true ? presence.get(sessionID) : undefined
    const back = Math.max(prompted.get(sessionID) ?? 0, shown ?? 0) > admitted.at
    if (!late && !back) return {}
    const outcome = late ? "late" : "returned"
    if (!dropped.has(admitted.inputID))
      record(sessionID, outcome, { deadline: admitted.deadline, P: host.tracker.P(sessionID) })
    dropped.add(admitted.inputID)
    return { drop: DROPPED[outcome] }
  }

  /** A subscription slot (the Claude slot, a seat account) whose plan window is used past the threshold. */
  function overLimit(sessionID: string, providerID: string) {
    const peers = host.peers()
    const info = peers.slots.slot(providerID)
    const claude = providerID === "anthropic"
    // The Claude Agent route's account is a plan too (02 §8.10).
    const agent = peers.claudeAgent.member(providerID, sessionID)?.id
    if (!claude && !agent && info?.account.billing !== "subscription") return false
    const accountID = agent ?? (claude ? peers.claude.peek(sessionID) : info?.account.id)
    if (accountID === undefined || accountID === null) return false
    return deps.runtime.limits
      .list({ accountID })
      .some((window) => (window.usedPercent ?? 0) >= CompactionCache.IDLE.limitPercent)
  }

  function record(sessionID: string, outcome: Outcome, data: { deadline: number; ttlMs?: number; P: number }) {
    log.info("idle_compaction", { sessionID, outcome, ...data })
    if (outcome !== "admitted" && outcome !== "late" && outcome !== "returned") return
    void deps.runtime.ledger
      .event({
        eid: `ic_${OwnID.ulid()}`,
        type: "compaction.idle",
        sessionID,
        providerID: null,
        accountID: null,
        data: { outcome, ...data },
      })
      .catch((error: unknown) => log.warn("idle_ledger_failed", { sessionID, error }))
  }

  return {
    onEvent,
    origin,
    /** `session.presence`: a client shows the session on a screen the user touched lately. */
    seen: (sessionID: string) => void presence.set(sessionID, now()),
    /** The prompt hook: the user sent the session a prompt (it is back). */
    prompted: (sessionID: string) => void prompted.set(sessionID, now()),
    stop: () => {
      stopped = true
      for (const sessionID of [...timers.keys()]) cancel(sessionID)
    },
  }
}

/** ChatGPT (lifetime unknown, so compacting at 5 minutes may be needless) and DeepSeek (no warm guarantee). */
const EXCLUDED: ReadonlySet<string> = new Set(["codex", "siwc", "ds"])

export type IdleCompaction = ReturnType<typeof create>

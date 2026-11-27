export * as Tracker from "./tracker.js"

import { Compaction } from "@own/protocol"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { SlotSamples } from "@own/runtime"
import type { Module } from "../module.js"
import type { Resets } from "../resets.js"
import type { Estimator } from "./estimator.js"
import type { Hysteresis } from "./hysteresis.js"
import type { Variant } from "./variant.js"

/** Estimator defaults when the session has no measurement yet (02 §6.3 ⑫, §6.4). */
export const DEFAULTS = { Z: 12_000, delta: 3_000, summary: 8_000, message: 2_000, seed: 6_000 } as const

const SAMPLES = 20
const COLD_WINDOW_MS = 15 * 60_000
/** Resets per session whose size before them a store keeps for their undo (last in, first out: the newest matter). */
const MAX_RESETS = 16

interface SlotObservation {
  readonly lastReqAt: number
  readonly L: number
  readonly epoch: number
  readonly modelID: string
  readonly variant: string | null
}

interface StepStart {
  readonly model: Variant.Ref
  readonly started: number
}

/** A slot's Z and one exchange (09 §4.3 `x`) as `estimate.request` reports them. */
export interface SlotMeasure {
  readonly Z: number
  readonly zSource: "measured" | "default"
  readonly exchange: number
}

/** What this instance saw of one local session, from `ctx.event.subscribe` (02 §5.3 idle rule, §6.1 inputs). */
export interface Session {
  /** Seen through a local event, the prompt hook, or a session lookup naming this Location. */
  local: boolean
  busy: boolean
  /** The session's current Ref as last observed (created, `model.selected`, `step.started`). */
  model: Variant.Ref | undefined
  /** `compaction.ended` count seen by this instance. */
  epoch: number
  compacting: boolean
  /** Measured steps (02 §6.5 confidence). */
  steps: number
  /** `session.created` was seen, so the first step seen is the session's first step (Z measurement). */
  created: boolean
  /**
   * own.import wrote the session (its `session.created` metadata has `own.import`: an imported conversation or a
   * hidden helper, 09 §4.2). Its first step carries the imported history, so it never measures Z, and none of its
   * steps enter the slot samples.
   */
  imported: boolean
  /** Created with a parent (a subagent or task session): another agent's system and tools, so no slot samples. */
  child: boolean
  firstL: number | undefined
  firstPrompt: number | undefined
  last: { readonly providerID: string; readonly L: number; readonly output: number } | undefined
  /** Context right after the last compaction (Z + summary + K), until the next step measures it. */
  compactedP: number | undefined
  /**
   * The last cold point was a context reset or its undo (11 §7): the size is unmeasured until the next step measures
   * it, and {@link Store.P} answers {@link estimate}.
   */
  cleared: boolean
  /**
   * P while no step measured it after a reset or an undo: the fixed prefix Z after a reset; after an undo the size
   * before that reset plus what the conversation after it added, or the session history's figure (`Store.estimate`).
   */
  estimate: number | undefined
  /** Reset id → the size measured right before it (`undefined`: not measured), for its undo. */
  readonly resets: Map<string, number | undefined>
  /** The context reset waiting for the turn (its inbox id), from its admission until its delivery or cancellation. */
  waitingReset: string | undefined
  /** Counts the events that may change `waitingReset` or `compacting`, so a {@link Store.resync} never undoes one. */
  marks: number
  /** The event stream subscription `waitingReset` and `compacting` are known for ({@link Store.resubscribed}). */
  subscription: number
  /** Last step or user message, for the SCHEDULED idle clock (02 §5.9(d)). */
  lastActivity: number
  readonly slots: Map<string, SlotObservation>
  readonly pending: Map<string, StepStart>
  readonly deltas: number[]
  readonly summaries: number[]
  colds: Hysteresis.ColdSample[]
  stepsThisExecution: number
  readonly stepsPerExecution: number[]
}

/** A step that ended, as the state machine needs it (first step after a switch, cooldown requests). */
export interface StepEnd {
  readonly sessionID: string
  readonly model: Variant.Ref
  /** `input + cache.write`: the uncached part. */
  readonly cold: number
  readonly L: number
}

/**
 * Per-instance observations of local sessions. Everything here is memory only: after a restart the estimator falls
 * back to telemetry's KV cache state (`sess:<sid>:cache:<pid>`) or to {@link DEFAULTS}.
 */
export class Store {
  readonly #sessions = new Map<string, Session>()
  /**
   * Per providerID: first-step Z and step δ samples of root sessions own.import did not write (09 §4.3: the import is
   * such a session). The process's store (`runtime.samples`), so every instance adds its Location's sessions and
   * {@link slotMeasure} answers for the whole slot wherever it is asked (09 §5.6).
   */
  readonly #samples: SlotSamples.Store
  /** Core `keep` (K) of the own global config; the context right after a compaction is `Z + S_sum + K`. */
  readonly #keep: () => number
  /** Event stream subscriptions after the first: each lost the events before it ({@link resubscribed}). */
  #subscription = 0

  constructor(options: { readonly keep?: () => number; readonly samples?: SlotSamples.Store } = {}) {
    this.#keep = options.keep ?? (() => Compaction.KEEP_TOKENS)
    this.#samples = options.samples ?? new SlotSamples.Store()
  }

  get(sessionID: string) {
    return this.#sessions.get(sessionID)
  }

  ensure(sessionID: string, now: number) {
    const found = this.#sessions.get(sessionID)
    if (found) return found
    const created: Session = {
      local: false,
      busy: false,
      model: undefined,
      epoch: 0,
      compacting: false,
      steps: 0,
      created: false,
      imported: false,
      child: false,
      firstL: undefined,
      firstPrompt: undefined,
      last: undefined,
      compactedP: undefined,
      cleared: false,
      estimate: undefined,
      resets: new Map(),
      waitingReset: undefined,
      marks: 0,
      subscription: this.#subscription,
      lastActivity: now,
      slots: new Map(),
      pending: new Map(),
      deltas: [],
      summaries: [],
      colds: [],
      stepsThisExecution: 0,
      stepsPerExecution: [],
    }
    this.#sessions.set(sessionID, created)
    return created
  }

  forget(sessionID: string) {
    this.#sessions.delete(sessionID)
  }

  /** Records one local event; returns the ended step when the event closed one. */
  observe(event: Module.OpenCodeEvent, now: number): StepEnd | undefined {
    const data: unknown = "data" in event ? event.data : undefined
    if (typeof data === "object" && data !== null && "sessionID" in data && typeof data.sessionID === "string")
      this.ensure(data.sessionID, now).local = true
    switch (event.type) {
      case "session.created": {
        const session = this.ensure(event.data.sessionID, now)
        session.created = true
        session.imported = OwnImportRouting.marked(event.data.metadata)
        session.child = event.data.parentID !== undefined
        session.model = event.data.model ?? session.model
        return undefined
      }
      case "session.model.selected": {
        this.ensure(event.data.sessionID, now).model = event.data.model
        return undefined
      }
      case "session.execution.started": {
        const session = this.ensure(event.data.sessionID, now)
        session.busy = true
        session.stepsThisExecution = 0
        return undefined
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const session = this.ensure(event.data.sessionID, now)
        session.busy = false
        if (session.stepsThisExecution > 0) push(session.stepsPerExecution, session.stepsThisExecution)
        session.stepsThisExecution = 0
        return undefined
      }
      case "session.step.started": {
        const session = this.ensure(event.data.sessionID, now)
        session.pending.set(event.data.assistantMessageID, { model: event.data.model, started: event.data.started })
        session.model = event.data.model
        session.lastActivity = now
        return undefined
      }
      case "session.step.ended":
      case "session.step.failed": {
        const session = this.ensure(event.data.sessionID, now)
        const start = session.pending.get(event.data.assistantMessageID)
        session.pending.delete(event.data.assistantMessageID)
        const tokens = event.data.tokens
        if (!start || !tokens) return undefined
        return this.#step(event.data.sessionID, session, start, tokens, now)
      }
      case "session.compaction.started": {
        const session = this.ensure(event.data.sessionID, now)
        session.compacting = true
        session.marks += 1
        return undefined
      }
      case "session.compaction.ended": {
        const session = this.ensure(event.data.sessionID, now)
        session.compacting = false
        session.marks += 1
        session.epoch += 1
        const summary = event.data.tokens?.output
        if (summary !== undefined && summary > 0) push(session.summaries, summary)
        session.compactedP = this.Z(event.data.sessionID) + (summary ?? DEFAULTS.summary) + this.#keep()
        session.estimate = undefined
        session.lastActivity = now
        return undefined
      }
      case "session.compaction.failed": {
        const session = this.ensure(event.data.sessionID, now)
        session.compacting = false
        session.marks += 1
        return undefined
      }
      case "session.inbox.enqueued": {
        const session = this.ensure(event.data.sessionID, now)
        if (event.data.item.type === "reset") session.waitingReset = event.data.inboxID
        session.marks += 1
        return undefined
      }
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        const session = this.ensure(event.data.sessionID, now)
        if (session.waitingReset === event.data.inboxID) session.waitingReset = undefined
        session.marks += 1
        return undefined
      }
      default:
        return undefined
    }
  }

  /**
   * The event stream was subscribed again (events.ts): a context reset's delivery or cancellation, or a compaction's
   * end, may be lost, which would hold `compaction.due` forever (02 §4.7.4). Every session seen before is
   * {@link stale} until a {@link resync} reads both back from the server.
   */
  resubscribed() {
    this.#subscription += 1
  }

  /** `waitingReset` and `compacting` may miss events lost before the current subscription. */
  stale(sessionID: string) {
    const session = this.#sessions.get(sessionID)
    return session !== undefined && session.subscription < this.#subscription
  }

  /** Taken before reading the server for {@link resync}. */
  mark(sessionID: string) {
    return { marks: this.#sessions.get(sessionID)?.marks, subscription: this.#subscription }
  }

  /**
   * The waiting reset (the session inbox) and whether a compaction runs (the session context) as the server answered
   * after `mark`; an event seen meanwhile is newer, so the read is then dropped and the session stays stale.
   */
  resync(
    sessionID: string,
    mark: ReturnType<Store["mark"]>,
    server: { readonly waitingReset: string | undefined; readonly compacting: boolean },
  ) {
    const session = this.#sessions.get(sessionID)
    if (!session || session.marks !== mark.marks) return
    session.waitingReset = server.waitingReset
    session.compacting = server.compacting
    session.subscription = mark.subscription
  }

  /**
   * A context reset or its undo (`EventMeta.reset`, 11 §7) is a cold point that no step measured: no last step, no
   * estimate after a compaction. A reset keeps the size before it for its undo and leaves the fixed prefix Z. The undo
   * brings that size back plus what the conversation after the reset added (its size above Z); for a reset this store
   * did not see, the switching module reads the figure from the session's history (`estimate`). Never 0 (02 §4.7.4).
   */
  cold(point: Resets.ColdPoint, now: number) {
    const session = this.ensure(point.sessionID, now)
    const Z = this.Z(point.sessionID)
    const current = this.measured(point.sessionID) ? this.P(point.sessionID) : session.estimate
    if (point.kind === "reset") {
      session.resets.set(point.resetID, current)
      const oldest = session.resets.keys().next().value
      if (session.resets.size > MAX_RESETS && oldest !== undefined) session.resets.delete(oldest)
      session.estimate = Z
    }
    if (point.kind === "undo") {
      const before = session.resets.get(point.resetID)
      session.resets.delete(point.resetID)
      session.estimate = before === undefined ? undefined : before + Math.max(0, (current ?? Z) - Z)
    }
    session.epoch += 1
    session.last = undefined
    session.compactedP = undefined
    session.cleared = true
    session.lastActivity = now
  }

  /** Whether {@link P} has a figure after a reset or an undo: measured, or estimated by {@link cold} or {@link estimate}. */
  estimated(sessionID: string) {
    const session = this.#sessions.get(sessionID)
    return session !== undefined && (this.measured(sessionID) || session.estimate !== undefined)
  }

  /** The restored size of an undo, read from the session's history; a step that measured meanwhile wins. */
  estimate(sessionID: string, P: number) {
    const session = this.#sessions.get(sessionID)
    if (session?.cleared && session.estimate === undefined) session.estimate = P
  }

  /** A user message was admitted (prompt hook): restarts the idle clock and measures u_1 for Z. */
  prompt(sessionID: string, text: string, now: number) {
    const session = this.ensure(sessionID, now)
    session.local = true
    session.lastActivity = now
    if (session.created && session.steps === 0 && session.firstPrompt === undefined)
      session.firstPrompt = Math.ceil(text.length / 4)
  }

  busy(sessionID: string) {
    return this.#sessions.get(sessionID)?.busy ?? false
  }

  /** A step (or a compaction) measured the context in this process, so {@link P} is not a guess. */
  measured(sessionID: string) {
    const session = this.#sessions.get(sessionID)
    return session !== undefined && (session.last !== undefined || session.compactedP !== undefined)
  }

  /** P_cur: the last step's input plus its output (02 §6.1); after a compaction, `Z + S_sum + K`. */
  P(sessionID: string) {
    const session = this.#sessions.get(sessionID)
    if (!session) return 0
    if (session.compactedP !== undefined) return session.compactedP
    return session.last ? session.last.L + session.last.output : (session.estimate ?? 0)
  }

  /**
   * Z: the first step's input minus the first user message; otherwise the 12k default (an imported session: its
   * slot's Z, 09 §4.2), never above P.
   */
  Z(sessionID: string) {
    const session = this.#sessions.get(sessionID)
    if (session?.firstL !== undefined) return Math.max(0, session.firstL - (session.firstPrompt ?? 0))
    const P = session?.last ? session.last.L + session.last.output : 0
    const providerID = session?.last?.providerID ?? session?.model?.providerID
    const fallback = session?.imported && providerID !== undefined ? this.slotMeasure(providerID).Z : DEFAULTS.Z
    return P > 0 ? Math.min(fallback, P) : fallback
  }

  /**
   * A slot's Z and one exchange for a session not started on it yet (09 §4.3, §5.6): the medians of the first-step Z
   * and the step δ of its recent root sessions own.import did not write, in any Location of this process, else
   * {@link DEFAULTS}. Only root sessions count because an import is one: a subagent runs another agent's system and
   * tools.
   */
  slotMeasure(providerID: string): SlotMeasure {
    const Z = median(this.#samples.get(providerID, "Z"))
    return {
      Z: Z ?? DEFAULTS.Z,
      zSource: Z === undefined ? "default" : "measured",
      exchange: median(this.#samples.get(providerID, "delta")) ?? DEFAULTS.delta,
    }
  }

  /** Z + u_1: exactly the first step's input when it was seen. */
  Zu1(sessionID: string) {
    return this.#sessions.get(sessionID)?.firstL ?? this.Z(sessionID)
  }

  delta(sessionID: string) {
    return median(this.#sessions.get(sessionID)?.deltas ?? []) ?? DEFAULTS.delta
  }

  summary(sessionID: string) {
    return median(this.#sessions.get(sessionID)?.summaries ?? []) ?? DEFAULTS.summary
  }

  /** H: five times the median steps per turn once three turns were seen, else the policy value (02 §5.7). */
  horizon(sessionID: string, fallback: number) {
    const samples = this.#sessions.get(sessionID)?.stepsPerExecution ?? []
    return samples.length >= 3 ? (median(samples) ?? fallback / 5) * 5 : fallback
  }

  steps(sessionID: string) {
    return this.#sessions.get(sessionID)?.steps ?? 0
  }

  epoch(sessionID: string) {
    return this.#sessions.get(sessionID)?.epoch ?? 0
  }

  colds(sessionID: string, now: number) {
    const session = this.#sessions.get(sessionID)
    if (!session) return []
    session.colds = session.colds.filter((sample) => now - sample.at < COLD_WINDOW_MS)
    return session.colds
  }

  /** The slot's cache state as the estimator reads it; lookback counters are unknown here (0). */
  slot(sessionID: string, providerID: string): Estimator.SlotCache | undefined {
    const found = this.#sessions.get(sessionID)?.slots.get(providerID)
    if (!found) return undefined
    return { ...found, blocksSince: 0, messageEndsSince: 0, watermark: false }
  }

  #step(
    sessionID: string,
    session: Session,
    start: StepStart,
    tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    },
    now: number,
  ): StepEnd {
    const L = tokens.input + tokens.cache.read + tokens.cache.write
    const cold = tokens.input + tokens.cache.write
    const sampled = !session.imported && !session.child
    if (session.steps === 0 && session.created && session.firstL === undefined && !session.imported) {
      session.firstL = L
      if (sampled) this.#samples.add(start.model.providerID, "Z", this.Z(sessionID))
    }
    const continuing = session.last?.providerID === start.model.providerID && session.compactedP === undefined
    if (continuing) push(session.deltas, cold)
    if (continuing && sampled) this.#samples.add(start.model.providerID, "delta", cold)
    session.steps += 1
    session.stepsThisExecution += 1
    session.compactedP = undefined
    session.cleared = false
    session.estimate = undefined
    session.last = { providerID: start.model.providerID, L, output: tokens.output + tokens.reasoning }
    session.slots.set(start.model.providerID, {
      lastReqAt: start.started,
      L,
      epoch: session.epoch,
      modelID: start.model.id,
      variant: start.model.variant ?? null,
    })
    session.colds.push({ at: now, cold })
    session.lastActivity = now
    return { sessionID, model: start.model, cold, L }
  }
}

function push(samples: number[], value: number) {
  samples.push(value)
  if (samples.length > SAMPLES) samples.shift()
}

function median(values: ReadonlyArray<number>) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

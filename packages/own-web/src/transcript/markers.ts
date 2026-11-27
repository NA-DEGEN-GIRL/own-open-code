// UI-only timeline markers (03 §4.5): account/model/variant switches and context compactions, derived from the
// durable messages the server already projects (`model-switched`, `compaction`). Nothing here writes to the session:
// the markers are never part of the model input (03 0-6, S8), the UI only draws them.
import type { ModelRef, SessionMessageInfo } from "@opencode/client/promise"

export type SwitchKind = "account" | "model" | "variant"

export interface SwitchMarker {
  /** The `model-switched` message that draws the marker (the last one of a run). */
  readonly id: string
  readonly from: ModelRef
  readonly to: ModelRef
  readonly kind: SwitchKind
  readonly at: number
  /** Last step before the switch: its ledger line names the account the conversation left (SL-8). */
  readonly beforeStepID: string | undefined
  /** First step after the switch: its uncached input is the measured cache rewrite, its line the account it runs on. */
  readonly firstStepID: string | undefined
}

export interface CompactionMarker {
  readonly id: string
  /** Last step before the compaction: its request size is the context that was summarized. */
  readonly beforeStepID: string | undefined
  /** First step after it: its request size is the context that remained. */
  readonly afterStepID: string | undefined
  /** A switch applied right after this compaction (compact-then-switch shows "전환 준비"). */
  readonly switchID: string | undefined
}

export interface MarkerIndex {
  /** Effective switch markers by message id. A `model-switched` id missing here draws nothing. */
  readonly switches: ReadonlyMap<string, SwitchMarker>
  readonly compactions: ReadonlyMap<string, CompactionMarker>
}

/**
 * One pass over the messages. Consecutive `model-switched` messages with no step between them are one switch from
 * the first `previous` to the last `model`; a run that ends where it started (A→B→A, e.g. `switch.undo`) or that has
 * no `previous` (the session's first selection) draws nothing (03 §4.5 "되돌린 전환은 접는다").
 */
export function markerIndex(messages: readonly SessionMessageInfo[]): MarkerIndex {
  const switches = new Map<string, SwitchMarker>()
  const compactions = new Map<string, CompactionMarker>()
  let run: Extract<SessionMessageInfo, { type: "model-switched" }>[] = []
  let awaitingStep: string[] = []
  let awaitingAfter: string[] = []
  let awaitingSwitch: string[] = []
  let lastStep: string | undefined

  const flush = () => {
    const first = run[0]
    const last = run.at(-1)
    run = []
    if (!first?.previous || !last || sameRef(first.previous, last.model)) return
    switches.set(last.id, {
      id: last.id,
      from: first.previous,
      to: last.model,
      kind: switchKind(first.previous, last.model),
      at: last.time.created,
      beforeStepID: lastStep,
      firstStepID: undefined,
    })
    awaitingStep.push(last.id)
    awaitingSwitch.forEach((id) => compactions.set(id, { ...compactions.get(id)!, switchID: last.id }))
    awaitingSwitch = []
  }

  for (const message of messages) {
    if (message.type === "model-switched") {
      run.push(message)
      continue
    }
    if (message.type === "compaction") {
      flush()
      compactions.set(message.id, {
        id: message.id,
        beforeStepID: lastStep,
        afterStepID: undefined,
        switchID: undefined,
      })
      awaitingAfter.push(message.id)
      awaitingSwitch.push(message.id)
      continue
    }
    if (message.type === "assistant") {
      flush()
      awaitingStep.forEach((id) => switches.set(id, { ...switches.get(id)!, firstStepID: message.id }))
      awaitingAfter.forEach((id) => compactions.set(id, { ...compactions.get(id)!, afterStepID: message.id }))
      awaitingStep = []
      awaitingAfter = []
      awaitingSwitch = []
      lastStep = message.id
      continue
    }
    if (message.type === "user" || message.type === "shell") {
      flush()
      awaitingSwitch = []
    }
  }
  flush()
  return { switches, compactions }
}

export function switchKind(from: ModelRef, to: ModelRef): SwitchKind {
  if (from.providerID !== to.providerID) return "account"
  if (from.id !== to.id) return "model"
  return "variant"
}

export function sameRef(a: ModelRef | undefined, b: ModelRef | undefined) {
  return a?.providerID === b?.providerID && a?.id === b?.id && (a?.variant ?? undefined) === (b?.variant ?? undefined)
}

export function sameSwitch(a: SwitchMarker | undefined, b: SwitchMarker | undefined) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.id === b.id &&
      a.beforeStepID === b.beforeStepID &&
      a.firstStepID === b.firstStepID &&
      a.at === b.at &&
      sameRef(a.from, b.from) &&
      sameRef(a.to, b.to))
  )
}

export function sameCompaction(a: CompactionMarker | undefined, b: CompactionMarker | undefined) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.id === b.id &&
      a.beforeStepID === b.beforeStepID &&
      a.afterStepID === b.afterStepID &&
      a.switchID === b.switchID)
  )
}

/**
 * The context sizes a compaction marker shows (03 §4.5 "압축 표시"): `before` = the whole request of the last step
 * before it (what was summarized, its output included), `after` = the request size of the first step after it (what
 * remained). Core records only the compaction request's own usage, so these come from the neighbouring steps; a
 * neighbour that is not loaded (or not there yet) leaves its side out. The marker and the 압축 내용 dialog share it.
 */
export function compactionSizes(
  marker: Pick<CompactionMarker, "beforeStepID" | "afterStepID"> | undefined,
  messageByID: (id: string) => SessionMessageInfo | undefined,
) {
  const tokens = (id: string | undefined) => {
    const message = id ? messageByID(id) : undefined
    return message?.type === "assistant" ? message.tokens : undefined
  }
  const before = tokens(marker?.beforeStepID)
  const after = tokens(marker?.afterStepID)
  return {
    before: before
      ? before.input + before.cache.read + before.cache.write + before.output + before.reasoning
      : undefined,
    after: after ? after.input + after.cache.read + after.cache.write : undefined,
  }
}

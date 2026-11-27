export * as Fill from "./fill.js"

import type { Model } from "@opencode/schema/model"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Transcript } from "../transcript/ir.js"

/**
 * Zones and fill of a migration (09 §4.1, §4.3): which part of a conversation the model sees after the import and how
 * many of the newest turns stay as they are. Pure: every size comes from the caller's {@link Measure} (the stored
 * shape, `render/store.ts`) and the target's window, so no number here is a threshold of its own (IG9, 07 R8·U6).
 */

/**
 * A place in the turn list (positions, 0-based). Without `step`: right before turn `turn`, so its user message comes
 * after. With `step`: inside turn `turn`, after its user message and its first `step` steps, which is where the tools
 * compact mid-turn (09 §2.4). `{turn: turns.length}` is the end.
 */
export interface Cut {
  readonly turn: number
  readonly step?: number
}

export const START: Cut = { turn: 0 }

/** Orders two cuts: negative when `a` comes first, 0 when they are the same place. */
export function compare(a: Cut, b: Cut) {
  return a.turn - b.turn || (a.step ?? -1) - (b.step ?? -1)
}

/** A checkpoint's place: right after its original record, inside its turn (09 §4.1). */
export function at(checkpoint: Transcript.Checkpoint): Cut {
  return { turn: checkpoint.at.turn, step: checkpoint.at.step }
}

/**
 * One turn's share of the part between two cuts: its user message when `user`, its steps `from` (inclusive) to `to`
 * (exclusive), and its end (the `idle` marker) when `end`. `index` is the turn's position.
 */
export interface Piece {
  readonly index: number
  readonly turn: Transcript.Turn
  readonly user: boolean
  readonly from: number
  readonly to: number
  readonly end: boolean
}

/** The pieces between `from` and `to` (default: the end), oldest first. A turn with nothing there is left out. */
export function pieces(turns: ReadonlyArray<Transcript.Turn>, from: Cut = START, to?: Cut): Piece[] {
  const until = to ?? { turn: turns.length }
  return turns.flatMap((turn, index): Piece[] => {
    if (index < from.turn || index > until.turn) return []
    const user = (index > from.turn || from.step === undefined) && (index < until.turn || until.step !== undefined)
    const stop = index === until.turn ? Math.min(until.step ?? 0, turn.steps.length) : turn.steps.length
    const start = index === from.turn ? Math.min(from.step ?? 0, stop) : 0
    const end = index < until.turn
    if (!user && start === stop && !end) return []
    return [{ index, turn, user, from: start, to: stop, end }]
  })
}

/** Where a piece starts, as a cut. */
export function cutOf(piece: Piece): Cut {
  return piece.user ? { turn: piece.index } : { turn: piece.index, step: piece.from }
}

/** Tokens of one item as stored: a turn's user message (`step` absent) or one of its steps. */
export type Measure = (turn: Transcript.Turn, step?: number) => number

/** Tokens of a piece: its user message and its steps (the `idle` marker costs nothing). */
export function size(piece: Piece, measure: Measure) {
  const steps = Array.from({ length: piece.to - piece.from }, (_, offset) => measure(piece.turn, piece.from + offset))
  return (piece.user ? measure(piece.turn) : 0) + steps.reduce((sum, tokens) => sum + tokens, 0)
}

/** Tokens between two cuts. */
export function tokens(turns: ReadonlyArray<Transcript.Turn>, measure: Measure, from: Cut = START, to?: Cut) {
  return pieces(turns, from, to).reduce((sum, piece) => sum + size(piece, measure), 0)
}

// ---------------------------------------------------------------------------------------------------------------
// Zones (09 §4.1)

export interface Zones {
  /** The turns the import takes: all of them, or up to `upToTurn` (`여기까지` cuts first). */
  readonly turns: ReadonlyArray<Transcript.Turn>
  /** The checkpoints inside those turns, in order of their places. */
  readonly checkpoints: ReadonlyArray<Transcript.Checkpoint>
  /** The last checkpoint: it decides V. */
  readonly last?: Transcript.Checkpoint
  /** The last `foreign` checkpoint (the last checkpoint itself unless that one is `codex-remote`). */
  readonly foreign?: Transcript.Checkpoint
  /**
   * Where V starts at the earliest; the turns before it are P, which the model does not see: the last foreign
   * checkpoint, else the start. Without a remote last checkpoint V is exactly this.
   */
  readonly visible: Cut
  /**
   * The last checkpoint is `codex-remote`: its summary is encrypted, so V is filled newest first from `visible`
   * across the remote boundaries ({@link full}), and a program checkpoint `briefAt(x)` stands before what fits.
   */
  readonly remote: boolean
}

export function zones(
  transcript: Pick<Transcript.Info, "turns" | "checkpoints">,
  options: { readonly upToTurn?: number } = {},
): Zones {
  const turns = options.upToTurn === undefined ? transcript.turns : transcript.turns.slice(0, options.upToTurn + 1)
  const checkpoints = transcript.checkpoints
    .filter((checkpoint) => checkpoint.at.turn < turns.length)
    .toSorted((a, b) => compare(at(a), at(b)))
  const last = checkpoints.at(-1)
  const foreign = checkpoints.findLast((checkpoint) => checkpoint.kind === "foreign")
  return {
    turns,
    checkpoints,
    ...(last === undefined ? {} : { last }),
    ...(foreign === undefined ? {} : { foreign }),
    visible: foreign === undefined ? START : at(foreign),
    remote: last?.kind === "codex-remote",
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Capacity and fill (09 §4.3)

/** What the target's window holds besides the stored turns, in tokens (09 §4.3, `estimate.request`). */
export interface Budget {
  /** `Compaction.ceiling(window)` of the target slot. */
  readonly ceiling: number
  /** The target slot's system and tools. */
  readonly Z: number
  /** The import notice. */
  readonly notice: number
  /** `x`: one exchange on the target slot, so the first follow-up does not compact at once. */
  readonly exchange: number
}

/**
 * `C = ceiling − (Z + |checkpoint| + notice + x)`. `|checkpoint|`: summary cap + `keepTokens` for an LLM summary, the
 * actual size of `briefAt` for the program checkpoint. Negative when even those do not fit.
 */
export function capacity(budget: Budget, checkpoint: number) {
  return budget.ceiling - (budget.Z + checkpoint + budget.notice + budget.exchange)
}

export interface Filled {
  /** Where the tail kept as it is starts (`from` when everything fits). The checkpoint stands right before it. */
  readonly cut: Cut
  /** Tokens of the tail. */
  readonly tokens: number
  /** Everything from `from` fits: no new checkpoint is needed. */
  readonly whole: boolean
}

/**
 * `fill(turns, C)`: whole turns from the newest back while they fit in `capacity`. When the newest one alone does not
 * fit, it is split by steps: its newest steps that fit stay and the checkpoint goes right before the first of them
 * (the same mid-turn place as a source checkpoint, 09 §4.1). What stays is the tail; the rest from `from` is old.
 */
export function fill(turns: ReadonlyArray<Transcript.Turn>, from: Cut, capacity: number, measure: Measure): Filled {
  const all = pieces(turns, from)
  const totals = suffix(all.map((piece) => size(piece, measure)))
  const first = totals.findIndex((total) => total <= capacity)
  if (all.length === 0 || first === 0) return { cut: from, tokens: totals[0] ?? 0, whole: true }
  if (first > 0) return { cut: cutOf(all[first]), tokens: totals[first], whole: false }
  const newest = all[all.length - 1]
  const steps = suffix(
    Array.from({ length: newest.to - newest.from }, (_, offset) => measure(newest.turn, newest.from + offset)),
  )
  const kept = steps.findIndex((total) => total <= capacity)
  if (kept < 0) return { cut: { turn: newest.index, step: newest.to }, tokens: 0, whole: false }
  return { cut: { turn: newest.index, step: newest.from + kept }, tokens: steps[kept], whole: false }
}

/** `totals[i]` = the sum of `sizes[i..]`. Totals shrink as `i` grows, so the first that fits is the longest tail. */
function suffix(sizes: ReadonlyArray<number>) {
  const totals = sizes.map(() => 0)
  for (let index = sizes.length - 1; index >= 0; index--) totals[index] = sizes[index] + (totals[index + 1] ?? 0)
  return totals
}

export interface Fitted extends Filled {
  /** The capacity `C` the tail was filled to. */
  readonly capacity: number
  /** `|checkpoint|` at the tail's start. */
  readonly checkpoint: number
}

/**
 * {@link fill} with `C = capacity(budget, |checkpoint|)`. A fixed `checkpoint` (an LLM summary: its cap plus
 * `keepTokens`) fills once. A program checkpoint's size depends on where it lands (`briefAt(x)` covers what is before
 * x), so the cut is moved later until the tail and the checkpoint at its start fit together; it only ever moves later,
 * so this ends.
 */
export function fit(input: {
  readonly turns: ReadonlyArray<Transcript.Turn>
  readonly from: Cut
  readonly budget: Budget
  readonly checkpoint: number | ((cut: Cut) => number)
  readonly measure: Measure
}): Fitted {
  const known = new Map<string, number>()
  const measure: Measure = (turn, step) => {
    const key = `${turn.index}:${step ?? "user"}`
    const found = known.get(key)
    if (found !== undefined) return found
    const tokens = input.measure(turn, step)
    known.set(key, tokens)
    return tokens
  }
  const fixed = input.checkpoint
  const sizeAt = typeof fixed === "number" ? () => fixed : fixed
  // Each round moves the cut strictly later, so this ends within the number of steps after `from`.
  for (let cut = input.from; ; ) {
    const checkpoint = sizeAt(cut)
    const room = capacity(input.budget, checkpoint)
    const filled = fill(input.turns, input.from, room, measure)
    if (compare(filled.cut, cut) <= 0)
      return {
        cut,
        tokens: tokens(input.turns, measure, cut),
        whole: compare(cut, input.from) === 0,
        capacity: room,
        checkpoint,
      }
    cut = filled.cut
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Boundaries (09 §4.4 최종 가져오기 모양)

/** An LLM summary of the turns before the tail, as the helper session's compaction returned it (09 §4.4). */
export interface Summary {
  /** The summary text `S`; the store appends the brief of the turns before the tail. */
  readonly text: string
  /** `R`: the end of the old part core kept verbatim (`keep`). */
  readonly recent: string
  /** The model that summarized. */
  readonly model: typeof Model.Ref.Encoded
  /** The summary request's own usage, copied for display (core's schema meaning). */
  readonly cost?: number
  readonly tokens?: typeof TokenUsage.Info.Encoded
}

/**
 * What stands right before the model-visible part: nothing (`none`); the source's own last checkpoint (`source`, a
 * foreign one); the program checkpoint `briefAt(at)` past a Codex remote compaction (`remote`, mode `full`) or as the
 * LLM-free summary (`brief`, mode `summary`); or an LLM summary of the turns before `at` (`llm`, mode `summary`).
 */
export type Boundary =
  | { readonly type: "none" }
  | { readonly type: "source"; readonly checkpoint: Transcript.Checkpoint }
  | { readonly type: "remote"; readonly at: Cut }
  | { readonly type: "brief"; readonly at: Cut }
  | { readonly type: "llm"; readonly at: Cut; readonly summary: Summary }

/** Where the model-visible part starts for a boundary. */
export function start(boundary: Boundary): Cut {
  if (boundary.type === "none") return START
  if (boundary.type === "source") return at(boundary.checkpoint)
  return boundary.at
}

/**
 * The boundary of `그대로 이어가기` (09 §4.1, §4.3 table). Without a remote last checkpoint the model sees what the
 * original model last saw: the last foreign checkpoint and after, or everything. With one, the turns after the last
 * foreign checkpoint (or from the start) are filled newest first across the remote boundaries and the checkpoint moves
 * to the oldest kept place x with `briefAt(x)` (`brief` gives its size); when everything fits there is no new
 * checkpoint. Filled, so it always fits and needs no LLM call.
 */
export function full(input: {
  readonly zones: Zones
  readonly budget: Budget
  readonly measure: Measure
  readonly brief: (cut: Cut) => number
}): { readonly boundary: Boundary; readonly fitted?: Fitted } {
  const kept: Boundary =
    input.zones.foreign === undefined ? { type: "none" } : { type: "source", checkpoint: input.zones.foreign }
  if (!input.zones.remote) return { boundary: kept }
  const fitted = fit({
    turns: input.zones.turns,
    from: input.zones.visible,
    budget: input.budget,
    checkpoint: input.brief,
    measure: input.measure,
  })
  return { boundary: fitted.whole ? kept : { type: "remote", at: fitted.cut }, fitted }
}

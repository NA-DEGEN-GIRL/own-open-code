import { describe, expect, test } from "bun:test"
import { Fill } from "../../src/migrate/fill.js"
import { Store } from "../../src/render/store.js"
import { CodexTranscript } from "../../src/transcript/codex.js"
import type { Transcript } from "../../src/transcript/ir.js"
import { T0, compactionItem, localSummary, rollout, threadId, userItem } from "../fixtures/codex.js"

const text = (value: string, time = T0): Transcript.Step => ({ type: "text", text: value, time })
const tool = (name: string, time = T0): Transcript.Step => ({
  type: "tool",
  name,
  input: { command: "bun test" },
  output: { text: "ok", error: false },
  exit: 0,
  time,
})

function turn(index: number, steps: ReadonlyArray<Transcript.Step> = [text(`answer ${index}`)]): Transcript.Turn {
  return {
    index,
    time: T0 + index * 1000,
    user: { text: `request ${index}`, images: [] },
    steps: [...steps],
    end: "completed",
  }
}

function checkpoint(
  kind: Transcript.Checkpoint["kind"],
  at: { readonly turn: number; readonly step: number },
): Transcript.Checkpoint {
  return {
    at: { ...at, source: { ordinal: at.turn * 10 + at.step } },
    kind,
    ...(kind === "foreign" ? { summary: `summary at ${at.turn}.${at.step}` } : {}),
    recent: [],
  }
}

/** Every user message costs 10 tokens and every step 5, so sizes are easy to read. */
const unit: Fill.Measure = (_turn, step) => (step === undefined ? 10 : 5)

const budget = (ceiling: number): Fill.Budget => ({ ceiling, Z: 0, notice: 0, exchange: 0 })

describe("cuts and pieces", () => {
  const turns = [turn(0, [text("a"), text("b")]), turn(1, [text("c"), text("d"), text("e")]), turn(2)]

  test("compare orders a turn start before its user message's steps", () => {
    expect(Fill.compare({ turn: 1 }, { turn: 1, step: 0 })).toBeLessThan(0)
    expect(Fill.compare({ turn: 1, step: 2 }, { turn: 2 })).toBeLessThan(0)
    expect(Fill.compare({ turn: 1, step: 2 }, { turn: 1, step: 2 })).toBe(0)
    expect(Fill.compare({ turn: 0, step: 9 }, { turn: 1 })).toBeLessThan(0)
  })

  test("whole turns hold their user message, all steps and the end", () => {
    expect(Fill.pieces(turns).map((piece) => [piece.index, piece.user, piece.from, piece.to, piece.end])).toEqual([
      [0, true, 0, 2, true],
      [1, true, 0, 3, true],
      [2, true, 0, 1, true],
    ])
  })

  test("a mid-turn cut splits the steps exactly: before it the user message and the first steps, after it the rest", () => {
    const at = { turn: 1, step: 2 }
    expect(
      Fill.pieces(turns, Fill.START, at).map((piece) => [piece.index, piece.user, piece.from, piece.to, piece.end]),
    ).toEqual([
      [0, true, 0, 2, true],
      [1, true, 0, 2, false],
    ])
    expect(Fill.pieces(turns, at).map((piece) => [piece.index, piece.user, piece.from, piece.to, piece.end])).toEqual([
      [1, false, 2, 3, true],
      [2, true, 0, 1, true],
    ])
  })

  test("a cut before a turn keeps the whole turn on one side", () => {
    expect(Fill.pieces(turns, Fill.START, { turn: 1 }).map((piece) => piece.index)).toEqual([0])
    expect(Fill.pieces(turns, { turn: 1 }).map((piece) => [piece.index, piece.user])).toEqual([
      [1, true],
      [2, true],
    ])
  })

  test("a checkpoint after a turn's last step leaves the turn's end after it", () => {
    const at = { turn: 0, step: 2 }
    expect(Fill.pieces(turns, Fill.START, at).map((piece) => [piece.index, piece.to, piece.end])).toEqual([
      [0, 2, false],
    ])
    expect(Fill.pieces(turns, at)[0]).toMatchObject({ index: 0, user: false, from: 2, to: 2, end: true })
  })

  test("tokens add the user messages and the steps between two cuts", () => {
    expect(Fill.tokens(turns, unit)).toBe(30 + 6 * 5)
    expect(Fill.tokens(turns, unit, { turn: 1, step: 1 })).toBe(2 * 5 + 10 + 5)
  })
})

describe("zones (09 §4.1)", () => {
  const turns = [turn(0), turn(1), turn(2), turn(3), turn(4)]

  test("no checkpoint: V is everything", () => {
    const zones = Fill.zones({ turns, checkpoints: [] })
    expect(zones).toMatchObject({ visible: Fill.START, remote: false })
    expect(zones.last).toBeUndefined()
    expect(Fill.full({ zones, budget: budget(1), measure: unit, brief: () => 0 }).boundary).toEqual({ type: "none" })
  })

  test("a foreign last checkpoint: V is that checkpoint and after, P is before; a mid-turn one splits its turn", () => {
    const last = checkpoint("foreign", { turn: 3, step: 1 })
    const zones = Fill.zones({ turns, checkpoints: [checkpoint("foreign", { turn: 1, step: 0 }), last] })
    expect(zones).toMatchObject({ visible: { turn: 3, step: 1 }, remote: false, last, foreign: last })
    // 그대로 keeps the source checkpoint whatever the window: the model sees what the original model saw.
    expect(Fill.full({ zones, budget: budget(1), measure: unit, brief: () => 0 }).boundary).toEqual({
      type: "source",
      checkpoint: last,
    })
  })

  test("a codex-remote last checkpoint: V is filled from after the last foreign checkpoint (or the start)", () => {
    const foreign = checkpoint("foreign", { turn: 1, step: 0 })
    const remote = checkpoint("codex-remote", { turn: 3, step: 0 })
    expect(Fill.zones({ turns, checkpoints: [remote, foreign] })).toMatchObject({
      visible: { turn: 1, step: 0 },
      remote: true,
      last: remote,
      foreign,
    })
    expect(Fill.zones({ turns, checkpoints: [remote] })).toMatchObject({ visible: Fill.START, remote: true })
  })

  test("upToTurn cuts first: later turns and their checkpoints are gone before the boundary is chosen", () => {
    const early = checkpoint("foreign", { turn: 1, step: 0 })
    const zones = Fill.zones(
      {
        turns,
        checkpoints: [
          early,
          checkpoint("foreign", { turn: 3, step: 0 }),
          checkpoint("codex-remote", { turn: 4, step: 0 }),
        ],
      },
      { upToTurn: 2 },
    )
    expect(zones.turns.map((item) => item.index)).toEqual([0, 1, 2])
    expect(zones.checkpoints).toEqual([early])
    expect(zones).toMatchObject({ visible: { turn: 1, step: 0 }, remote: false })
    // The last kept turn keeps its checkpoint.
    expect(
      Fill.zones({ turns, checkpoints: [checkpoint("foreign", { turn: 2, step: 1 })] }, { upToTurn: 2 }).foreign,
    ).toBeDefined()
  })
})

describe("capacity and fill (09 §4.3)", () => {
  // 4 turns of 10 + 2·5 = 20 tokens each.
  const turns = [0, 1, 2, 3].map((index) => turn(index, [text("x"), text("y")]))

  test("C = ceiling − (Z + |checkpoint| + notice + x)", () => {
    expect(Fill.capacity({ ceiling: 100_000, Z: 12_000, notice: 90, exchange: 3_000 }, 30_000)).toBe(54_910)
    expect(Fill.capacity({ ceiling: 10, Z: 12_000, notice: 0, exchange: 0 }, 0)).toBe(-11_990)
  })

  test("whole turns go in from the newest back while they fit; the checkpoint lands before the oldest kept turn", () => {
    expect(Fill.fill(turns, Fill.START, 80, unit)).toEqual({ cut: Fill.START, tokens: 80, whole: true })
    expect(Fill.fill(turns, Fill.START, 79, unit)).toEqual({ cut: { turn: 1 }, tokens: 60, whole: false })
    expect(Fill.fill(turns, Fill.START, 45, unit)).toEqual({ cut: { turn: 2 }, tokens: 40, whole: false })
  })

  test("when the newest turn alone does not fit it is split by steps, the checkpoint right before the first kept step", () => {
    const big = [...turns.slice(0, 3), turn(3, [text("a"), text("b"), text("c"), text("d")])]
    expect(Fill.fill(big, Fill.START, 12, unit)).toEqual({ cut: { turn: 3, step: 2 }, tokens: 10, whole: false })
    expect(Fill.fill(big, Fill.START, 4, unit)).toEqual({ cut: { turn: 3, step: 4 }, tokens: 0, whole: false })
  })

  test("a fill that starts mid-turn treats the partial turn as the oldest piece", () => {
    expect(Fill.fill(turns, { turn: 1, step: 1 }, 1_000, unit)).toEqual({
      cut: { turn: 1, step: 1 },
      tokens: 45,
      whole: true,
    })
    expect(Fill.fill(turns, { turn: 1, step: 1 }, 44, unit)).toEqual({ cut: { turn: 2 }, tokens: 40, whole: false })
  })

  test("IG9: no constant threshold, only the capacity of each window decides", () => {
    const many = Array.from({ length: 40 }, (_, index) => turn(index, [text("x"), tool("exec_command")]))
    const total = Fill.tokens(many, unit)
    // Windows from tiny to huge: the tail only grows with the capacity, and everything fits exactly when total <= C.
    const results = [0, 7, 19, 20, 21, 199, 200, 399, 400, 401, 799, 800, 801, 10_000].map((capacity) => ({
      capacity,
      filled: Fill.fill(many, Fill.START, capacity, unit),
    }))
    for (const item of results) {
      expect(item.filled.whole).toBe(total <= item.capacity)
      expect(item.filled.tokens).toBeLessThanOrEqual(Math.max(item.capacity, 0))
    }
    const kept = results.map((item) => item.filled.tokens)
    expect(kept).toEqual(kept.toSorted((a, b) => a - b))
    // One more token than a whole turn always keeps that turn: the fill is greedy, not stepped.
    expect(Fill.fill(many, Fill.START, 20, unit).cut).toEqual({ turn: 39 })
  })

  test("fit with a fixed checkpoint (an LLM summary cap + keep) fills once against the reduced capacity", () => {
    const fitted = Fill.fit({ turns, from: Fill.START, budget: budget(100), checkpoint: 40, measure: unit })
    expect(fitted).toEqual({ cut: { turn: 1 }, tokens: 60, whole: false, capacity: 60, checkpoint: 40 })
  })

  test("fit with briefAt sizes moves the cut later until the tail and the checkpoint at its start fit together", () => {
    // The program checkpoint grows by 7 tokens per turn before it.
    const brief = (cut: Fill.Cut) => 7 * cut.turn + (cut.step === undefined ? 0 : 3)
    // 64: turns 1–3 (60) fit without a checkpoint, but not beside the one before turn 1 (7); turns 2–3 fit beside 14.
    const fitted = Fill.fit({ turns, from: Fill.START, budget: budget(64), checkpoint: brief, measure: unit })
    expect(fitted).toEqual({ cut: { turn: 2 }, whole: false, checkpoint: 14, capacity: 50, tokens: 40 })
    expect(fitted.tokens + brief(fitted.cut)).toBeLessThanOrEqual(64)
    expect(Fill.fit({ turns, from: Fill.START, budget: budget(75), checkpoint: brief, measure: unit }).cut).toEqual({
      turn: 1,
    })
    // Everything fits: no checkpoint is needed.
    expect(Fill.fit({ turns, from: Fill.START, budget: budget(80), checkpoint: brief, measure: unit })).toMatchObject({
      cut: Fill.START,
      whole: true,
    })
  })
})

describe("그대로 across Codex remote compactions (09 §4.1)", () => {
  const PREFIX = CodexTranscript.SUMMARY_PREFIX
  const start = {
    rootID: "codex-0123456789ab",
    path: "C:\\fixture\\rollout.jsonl",
    bytes: 1,
    mtimeMs: T0,
    now: T0 + 3_600_000,
  }

  /** A local summary after turn 1, then two remote compactions, the second in the middle of turn 4. */
  function transcript() {
    const builder = rollout()
      .meta({ id: threadId(7) })
      .user("turn zero")
      .assistant("zero done")
      .user("turn one")
      .assistant("one done")
      .compacted(localSummary("Local summary of turns zero and one.", PREFIX), [
        userItem("turn zero"),
        userItem("turn one"),
      ])
      .user("turn two")
      .call("exec_command", { cmd: "bun test" }, "call_2")
      .output("call_2", "2 pass")
      .assistant("two done")
      .user("turn three")
      .assistant("three done")
      .compacted("", [userItem("turn two"), userItem("turn three"), compactionItem()])
      .user("turn four")
      .call("exec_command", { cmd: "bun run build" }, "call_4")
      .compacted("", [userItem("turn two"), userItem("turn three"), userItem("turn four"), compactionItem()])
      .output("call_4", "built")
      .assistant("four done")
    return CodexTranscript.parse(builder.lines(), start)
  }

  test("the parser gives the expected checkpoints", () => {
    const info = transcript()
    expect(info.checkpoints.map((item) => [item.kind, item.at.turn, item.at.step])).toEqual([
      ["foreign", 1, 1],
      ["codex-remote", 3, 1],
      ["codex-remote", 4, 1],
    ])
  })

  test("the fill starts after the local summary, crosses the remote boundaries and moves the checkpoint to x", () => {
    const info = transcript()
    const zones = Fill.zones(info)
    expect(zones).toMatchObject({ remote: true, visible: { turn: 1, step: 1 } })
    const measure = Store.measure("codex", { images: false })
    const brief = Store.briefSize(zones)
    const everything = Fill.tokens(zones.turns, measure, zones.visible)
    const roomy = Fill.full({ zones, budget: budget(everything + brief(zones.visible) + 10), measure, brief })
    // Everything after the local summary fits: the local summary itself is the boundary (no program checkpoint).
    expect(roomy.boundary).toEqual({ type: "source", checkpoint: info.checkpoints[0] })

    // Room for the newest two turns and a bit: x lands before turn 3, before the first remote boundary's place.
    const tail = Fill.tokens(zones.turns, measure, { turn: 3 })
    const tight = Fill.full({ zones, budget: budget(tail + brief({ turn: 3 }) + 1), measure, brief })
    expect(tight.boundary).toEqual({ type: "remote", at: { turn: 3 } })
    expect(tight.fitted?.tokens).toBe(tail)

    // Room for less than the newest turn: it is split by steps.
    const split = Fill.full({
      zones,
      budget: budget(brief({ turn: 4, step: 1 }) + measure(zones.turns[4], 1) + 1),
      measure,
      brief,
    })
    expect(split.boundary).toEqual({ type: "remote", at: { turn: 4, step: 1 } })
  })
})

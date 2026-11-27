import { describe, expect, test } from "bun:test"
import {
  applyDelta,
  applyEnded,
  askError,
  cachedShare,
  costText,
  insertText,
  running,
  type Thread,
  type Turn,
} from "./model"
import { closeSide, openSide, sideTarget } from "./intents"

const turn = (over: Partial<Turn> = {}): Turn => ({
  question: "이 함수는 어디서 불려?",
  answer: "",
  status: "running",
  startedAt: 1,
  ...over,
})

const thread = (turns: Turn[]): Thread => ({
  id: "side_01JB0000000000000000000000",
  sessionID: "ses_1" as Thread["sessionID"],
  createdAt: 1,
  updatedAt: 1,
  turns,
})

describe("side panel model (03 §4.4.2)", () => {
  test("deltas append in order, skip text already shown and ask for a reread after a gap", () => {
    const start = thread([turn()])
    const one = applyDelta(start, { turn: 0, offset: 0, text: "run.ts에서" })
    if (one === "gap") throw new Error("gap")
    expect(one.turns[0]?.answer).toBe("run.ts에서")
    const overlap = applyDelta(one, { turn: 0, offset: 6, text: "에서만 불려요" })
    if (overlap === "gap") throw new Error("gap")
    expect(overlap.turns[0]?.answer).toBe("run.ts에서만 불려요")
    expect(applyDelta(overlap, { turn: 0, offset: 0, text: "run" })).toBe(overlap)
    expect(applyDelta(overlap, { turn: 0, offset: 40, text: "더" })).toBe("gap")
    // A finished turn takes no more deltas.
    const done = thread([turn({ status: "done", answer: "끝" })])
    expect(applyDelta(done, { turn: 0, offset: 1, text: "!" })).toBe(done)
  })

  test("an ended turn replaces the running one; one the copy lacks is a gap", () => {
    const start = thread([turn({ answer: "부분" })])
    const ended = turn({ answer: "전체 답", status: "done", finish: "stop" })
    const next = applyEnded(start, { index: 0, turn: ended })
    if (next === "gap") throw new Error("gap")
    expect(next.turns).toEqual([ended])
    expect(running(next)).toBe(false)
    expect(running(start)).toBe(true)
    expect(applyEnded(start, { index: 1, turn: ended })).toBe("gap")
  })

  test("the cached share is read over all input", () => {
    expect(cachedShare(undefined)).toBeUndefined()
    expect(cachedShare({ input: 100, cacheRead: 900, cacheWrite: 0, cacheWrite1h: null, output: 5, reasoning: 0 })).toBe(0.9)
  })

  test("대화에 넣기 sends the question and the answer as plain words", () => {
    const text = insertText({ question: " 왜 실패해? ", answer: "경로가 틀렸어요.\n" }, "ko")
    expect(text).toBe("곁질문으로 물어본 것: 왜 실패해?\n\n받은 답:\n경로가 틀렸어요.")
    expect(insertText({ question: "why", answer: "path" }, "en")).toContain("Side question I asked: why")
  })

  test("refusals get the panel's words: an old service, the scope, busy, a full thread, a removed thread", () => {
    expect(askError({ type: "rpc.method_not_found", message: "" }, 8).key).toBe("own.side.error.old")
    expect(askError({ type: "own.scope_denied", message: "" }, 8).key).toBe("own.side.error.scope")
    expect(askError({ type: "side_busy", message: "", data: { max: 2 } }, 8)).toEqual({
      key: "own.side.error.busy",
      params: { max: 2 },
    })
    expect(askError({ type: "side_busy", message: "", data: { max: 8 } }, 8).key).toBe("own.side.error.turns")
    expect(askError({ type: "side_not_found", message: "" }, 8).key).toBe("own.side.error.gone")
    expect(askError({ type: "side_unavailable", message: "", data: { reason: "session" } }, 8).key).toBe(
      "own.side.error.session",
    )
    expect(askError({ type: "boom", message: "x" }, 8)).toEqual({ key: "own.side.error.failed", params: { reason: "x" } })
  })

  test("every open is a new target, so a second /btw remounts the panel with its question; close clears it", () => {
    openSide({ serverKey: "local", sessionID: "ses_1", question: "q" })
    const first = sideTarget()
    openSide({ serverKey: "local", sessionID: "ses_1", question: "q" })
    expect(sideTarget()).toEqual(first)
    expect(sideTarget()).not.toBe(first)
    closeSide()
    expect(sideTarget()).toBeUndefined()
  })
})

describe("an answer's cost", () => {
  test("dollars, and credits as the transcript's estimate", () => {
    expect(costText({ amount: 0.0123, unit: "USD", source: "ratecard" })).toBe("$0.012")
    expect(costText({ amount: 2.5, unit: "USD", source: "ratecard" })).toBe("$2.50")
    expect(costText({ amount: 0.17, unit: "credits", source: "estimate" })).toBe("≈0.2 cr")
  })
})

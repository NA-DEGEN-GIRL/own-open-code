// Revert model (03 §18.7, 18.13): turns after a boundary, account switch in range, /undo and /redo targets, the queue
// sweep with its cutoff, the cold-point estimate input and the file summary. Also the label rule: `되돌리기` belongs
// to switch.undo, so no revert-owned string uses it.
import { describe, expect, test } from "bun:test"
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode/client"
import {
  boundaryContext,
  failureReason,
  isPending,
  filesSummary,
  redoTarget,
  staleQueue,
  switchInRange,
  turnsAfter,
  undoTarget,
  userMessages,
} from "./model"
import { revertEn, revertKo } from "./strings"

const A = { providerID: "own-oai-alpha", id: "gpt-5.5" }
const B = { providerID: "own-codex-pro", id: "gpt-5.5" }
const user = (id: string) => ({ id, type: "user", text: id, time: { created: 0 } }) as SessionMessageInfo
const assistant = (id: string, model = A, tokens?: { input: number; read: number; write: number }) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: 0 },
    tokens: tokens && {
      input: tokens.input,
      output: 10,
      reasoning: 0,
      cache: { read: tokens.read, write: tokens.write },
    },
  }) as unknown as SessionMessageInfo
const switched = (id: string, model = B) =>
  ({ id, type: "model-switched", model, time: { created: 0 } }) as SessionMessageInfo

const messages = [
  user("m01"),
  assistant("m02", A, { input: 1_000, read: 0, write: 5_000 }),
  user("m03"),
  assistant("m04", A, { input: 200, read: 6_000, write: 300 }),
  user("m05"),
  assistant("m06"),
]

test("turnsAfter counts the user turns after the boundary", () => {
  expect(turnsAfter(messages, "m01")).toBe(2)
  expect(turnsAfter(messages, "m05")).toBe(0)
})

test("prompts still in the inbox are not messages: no boundary, not counted; order is by id", () => {
  const queued = {
    id: "m07",
    sessionID: "s",
    time: { created: 0 },
    type: "user",
    delivery: "queue",
    payload: { text: "q" },
  }
  // createData lists the optimistic prompt among the messages, sometimes before older ones.
  const listed = [user("m01"), user("m07"), assistant("m02"), user("m03")]
  expect(userMessages(listed, [queued as SessionInboxInfo]).map((message) => message.id)).toEqual(["m01", "m03"])
  expect(turnsAfter(listed, "m01", [queued as SessionInboxInfo])).toBe(1)
  expect(isPending([queued as SessionInboxInfo], "m07")).toBe(true)
  expect(isPending([queued as SessionInboxInfo], "m03")).toBe(false)
})

describe("switchInRange", () => {
  test("no switch: false", () => expect(switchInRange(messages, "m03")).toBe(false))
  test("a model-switched message to another account after the boundary", () => {
    expect(switchInRange([...messages, switched("m07"), user("m08"), assistant("m09", B)], "m05")).toBe(true)
  })
  test("a switch before the boundary does not count; an answer on another account after it does", () => {
    const history = [user("m01"), assistant("m02", A), switched("m03", B), user("m04"), assistant("m05", B)]
    expect(switchInRange(history, "m04")).toBe(false)
    expect(switchInRange([user("m01"), assistant("m02", A), user("m03"), assistant("m04", B)], "m03")).toBe(true)
  })
  test("same account (variant or model change within it) does not count", () => {
    expect(switchInRange([user("m01"), assistant("m02", A), switched("m03", { ...A, id: "gpt-5.6" })], "m01")).toBe(
      false,
    )
  })
})

describe("/undo and /redo targets (upstream semantics)", () => {
  const users = [{ id: "m01" }, { id: "m03" }, { id: "m05" }]
  test("undo: the last turn first, then one further back each time", () => {
    expect(undoTarget(users, undefined)).toBe("m05")
    expect(undoTarget(users, "m05")).toBe("m03")
    expect(undoTarget(users, "m01")).toBeUndefined()
  })
  test("redo: one turn forward, clearing at the end; nothing when no revert is staged", () => {
    expect(redoTarget(users, "m01")).toEqual({ kind: "stage", messageID: "m03" })
    expect(redoTarget(users, "m05")).toEqual({ kind: "clear" })
    expect(redoTarget(users, undefined)).toBeUndefined()
  })
})

test("staleQueue: local items and authoritative items up to the cutoff, user items only, no duplicates", () => {
  const item = (id: string, created: number, type = "user") =>
    ({ id, sessionID: "s", time: { created }, type, delivery: "queue", payload: { text: id } }) as SessionInboxInfo
  expect(
    staleQueue([item("i1", 1), item("c1", 1, "compaction")], [item("i1", 1), item("i2", 5), item("i3", 20)], 10),
  ).toEqual(["i1", "i2"])
})

test("boundaryContext: the context of the first step after the boundary message", () => {
  expect(boundaryContext(messages, "m03")).toBe(6_500)
  expect(boundaryContext(messages, "m05")).toBeUndefined()
  expect(boundaryContext(messages, "nope")).toBeUndefined()
})

test("filesSummary", () => {
  expect(
    filesSummary([
      { file: "a.ts", patch: "", additions: 3, deletions: 1, status: "modified" },
      { file: "b.ts", patch: "", additions: 10, deletions: 0, status: "added" },
    ]),
  ).toEqual({ count: 2, additions: 13, deletions: 1 })
  expect(filesSummary(undefined)).toEqual({ count: 0, additions: 0, deletions: 0 })
})

test("failureReason recognizes core's busy error by tag", () => {
  expect(failureReason(Object.assign(new Error("busy"), { _tag: "SessionBusyError" }))).toBe("busy")
  expect(failureReason(new Error("boom"))).toBe("boom")
})

test("label rule (18.7): revert strings say 복원, never 되돌리기 (reserved for switch.undo)", () => {
  expect(Object.values(revertKo).filter((value) => value.includes("되돌리기"))).toEqual([])
  expect(Object.values(revertEn).filter((value) => /\bundo\b/i.test(value ?? ""))).toEqual([])
})

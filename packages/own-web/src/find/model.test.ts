// Find in session (03 §19.13): documents and ids as session-ui renders them, case/NFC-insensitive search with a hit
// cap, the start match near the view, and the index's incremental sync (inline here; the worker runs the same code).
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { collectRanges } from "./highlight"
import { documentsOf, normalizeNeedle, prepareText, searchPrepared, startAt, turnsOf } from "./model"
import { createFindIndex } from "./search-index"

// SAFETY: fixtures carry the fields the find model reads (type, id, text, content); the rest of the message shape is
// irrelevant to it.
const messages = [
  { type: "user", id: "msg_u1", text: "결제 웹훅을 설계해 줘" },
  {
    type: "assistant",
    id: "msg_a1",
    content: [
      { type: "reasoning", text: "생각: 결제" },
      { type: "text", text: "결제 웹훅은 재시도가 필요합니다. 결제 ID를 저장하세요." },
      { type: "tool", id: "call_1", name: "shell" },
      { type: "text", text: "끝." },
    ],
  },
  { type: "shell", id: "msg_s1", command: "ls" },
  { type: "assistant", id: "msg_a2", content: [{ type: "text", text: "RPC 결제" }] },
  { type: "user", id: "msg_u2", text: "고마워" },
] as unknown as SessionMessageInfo[]

describe("documents", () => {
  test("user text and assistant text parts, with session-ui part ids and their turn", () => {
    expect(documentsOf(messages)).toEqual([
      { id: "msg_u1:text:0", turn: "msg_u1", messageID: "msg_u1", text: "결제 웹훅을 설계해 줘" },
      {
        id: "msg_a1:text:0",
        turn: "msg_u1",
        messageID: "msg_a1",
        text: "결제 웹훅은 재시도가 필요합니다. 결제 ID를 저장하세요.",
      },
      { id: "msg_a1:text:1", turn: "msg_u1", messageID: "msg_a1", text: "끝." },
      { id: "msg_a2:text:0", turn: "msg_s1", messageID: "msg_a2", text: "RPC 결제" },
      { id: "msg_u2:text:0", turn: "msg_u2", messageID: "msg_u2", text: "고마워" },
    ])
    expect(turnsOf(messages)).toEqual(["msg_u1", "msg_s1", "msg_u2"])
  })
})

describe("search", () => {
  const prepared = documentsOf(messages).map((doc) => prepareText(doc.text))

  test("every occurrence in document order; case and Unicode form do not matter", () => {
    const result = searchPrepared(prepared, normalizeNeedle(" 결제 "))
    expect(result.total).toBe(4)
    expect(result.hits).toEqual([
      { doc: 0, occurrence: 0 },
      { doc: 1, occurrence: 0 },
      { doc: 1, occurrence: 1 },
      { doc: 3, occurrence: 0 },
    ])
    expect(searchPrepared(prepared, normalizeNeedle("rpc")).total).toBe(1)
    expect(searchPrepared(prepared, normalizeNeedle("결제".normalize("NFD"))).total).toBe(4)
    expect(searchPrepared(prepared, "").total).toBe(0)
  })

  test("hits are capped, the total is not", () => {
    const result = searchPrepared(["aaaa"], "a", 2)
    expect(result.hits).toHaveLength(2)
    expect(result.total).toBe(4)
  })

  test("a new query starts at the first match at or below the turn on top of the view", () => {
    const hits = searchPrepared(prepared, normalizeNeedle("결제")).hits
    const turnOf = (doc: number) => [0, 0, 0, 1, 2][doc]!
    expect(startAt(hits, turnOf, 0)).toBe(0)
    expect(startAt(hits, turnOf, 1)).toBe(3)
    expect(startAt(hits, turnOf, 2)).toBe(3)
    expect(startAt(hits, turnOf, undefined)).toBe(3)
    expect(startAt([], turnOf, 0)).toBe(-1)
  })
})

describe("index", () => {
  test("syncs only changed texts and follows order changes; queries see the latest documents", async () => {
    const index = createFindIndex()
    const docs = documentsOf(messages)
    expect(index.sync(docs)).toBe(true)
    expect(index.sync(docs)).toBe(false)
    expect((await index.query("결제")).total).toBe(4)
    const streamed = docs.map((doc) => (doc.id === "msg_a2:text:0" ? { ...doc, text: "RPC 결제 결제" } : doc))
    expect(index.sync(streamed)).toBe(true)
    expect((await index.query("결제")).total).toBe(5)
    expect(index.sync(streamed.slice(0, 2))).toBe(true)
    expect((await index.query("결제")).total).toBe(3)
    index.dispose()
  })
})

describe("highlight ranges", () => {
  test("only text bodies of searched parts; the active occurrence is separate", () => {
    document.body.innerHTML = `
      <div id="root">
        <div data-timeline-part-id="msg_a1:text:0"><div data-slot="text-part-body"><p>결제 <b>결제</b></p></div></div>
        <div data-timeline-part-id="msg_x:reasoning:0"><div data-slot="text-part-body">결제</div></div>
      </div>`
    const root = document.getElementById("root")!
    const ranges = collectRanges(root, "결제", new Set(["msg_a1:text:0"]), { doc: "msg_a1:text:0", occurrence: 1 })
    expect(ranges.hits).toHaveLength(1)
    expect(ranges.current).toHaveLength(1)
    expect(ranges.current[0]!.toString()).toBe("결제")
  })
})

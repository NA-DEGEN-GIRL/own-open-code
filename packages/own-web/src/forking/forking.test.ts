// Fork and manual compaction (03 §19.12, 01 §17.1 #27): which messages a fork can start before, the pin/archive
// flags cleared on a fork, and the compaction phase from the request, the inbox and the durable events.
import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent, SessionInboxInfo, SessionMessageInfo } from "@opencode/client"
import { createStore } from "solid-js/store"
import { createEventBus } from "@/data/events"
import { createCompactionTracker } from "./compaction"
import { clearForkFlags, compactionPhase, errorText, filterMessages, forkableMessages } from "./model"

// SAFETY: test fixtures carry only the fields the functions read.
const messages = [
  { id: "msg_1", type: "user", text: "첫 질문\n두 줄", time: { created: 1 } },
  { id: "msg_2", type: "assistant", time: { created: 2 } },
  {
    id: "msg_3",
    type: "user",
    text: "파일 봐 줘\nAttached file: `/tmp/uploads/1/a.txt`",
    metadata: {
      displayText: "파일 봐 줘",
      attachments: [{ name: "a.txt", mime: "text/plain", path: "/tmp/uploads/1/a.txt" }],
    },
    time: { created: 3 },
  },
  { id: "msg_4", type: "user", text: "   ", time: { created: 4 } },
  { id: "msg_5", type: "user", text: "대기 중인 질문", time: { created: 5 } },
] as unknown as SessionMessageInfo[]

describe("fork", () => {
  test("user messages newest first, without empty ones; attachments counted; queued ones marked", () => {
    const pending = [{ id: "msg_5", type: "user" }] as unknown as SessionInboxInfo[]
    const rows = forkableMessages(messages, pending)
    expect(rows.map((row) => [row.id, row.preview, row.pending, row.attachments])).toEqual([
      ["msg_5", "대기 중인 질문", true, 0],
      ["msg_3", "파일 봐 줘", false, 1],
      ["msg_1", "첫 질문 두 줄", false, 0],
    ])
    expect(filterMessages(rows, "파일").map((row) => row.id)).toEqual(["msg_3"])
    expect(filterMessages(rows, "  ").length).toBe(3)
  })

  test("pin and archive flags are cleared (flat keys and the nested own object), the rest is kept", () => {
    expect(clearForkFlags(undefined)).toBeUndefined()
    expect(clearForkFlags({ "own.note": "메모" })).toBeUndefined()
    expect(clearForkFlags({ "own.pinned": true, "own.archived": 12, "own.note": "메모" })).toEqual({
      "own.note": "메모",
    })
    expect(clearForkFlags({ own: { pinned: true, seededFrom: "ses_0" }, other: 1 })).toEqual({
      own: { seededFrom: "ses_0" },
      other: 1,
    })
  })

  test("error text: server data message, then message, never an object dump", () => {
    expect(errorText({ data: { message: "Message not found" }, message: "404" })).toBe("Message not found")
    expect(errorText(new Error("offline"))).toBe("offline")
    expect(errorText({ nothing: true })).toBeUndefined()
  })
})

describe("compaction", () => {
  test("phase order: running, requesting, queued, failed", () => {
    const facts = { requesting: false, queued: false, running: false, failed: false }
    expect(compactionPhase(facts)).toBe("idle")
    expect(compactionPhase({ ...facts, failed: true })).toBe("failed")
    expect(compactionPhase({ ...facts, failed: true, queued: true })).toBe("queued")
    expect(compactionPhase({ ...facts, queued: true, requesting: true })).toBe("requesting")
    expect(compactionPhase({ ...facts, requesting: true, running: true })).toBe("running")
  })

  function fakeRuntime(compact: () => Promise<unknown>) {
    const bus = createEventBus()
    const [store, setStore] = createStore<{ pending: Record<string, { id: string; type: string }[]> }>({ pending: {} })
    const data = {
      session: {
        pending: { list: (id: string) => store.pending[id] ?? [] },
        message: { list: () => [] },
        compact: async (input: { sessionID: string }) => {
          setStore("pending", input.sessionID, [{ id: "cmp_1", type: "compaction" }])
          return compact()
        },
      },
    }
    // SAFETY: the tracker reads only `bus` and these data methods.
    const tracker = createCompactionTracker({ bus, data } as unknown as Parameters<typeof createCompactionTracker>[0])
    const publish = (type: string, payload: Record<string, unknown>) => {
      // SAFETY: minimal events of the types the tracker subscribes to.
      bus.publish({ type, data: { sessionID: "ses_1", ...payload } } as unknown as OpenCodeEvent)
      bus.flush()
    }
    return { tracker, publish, clearPending: () => setStore("pending", "ses_1", []) }
  }

  test("request → queued → running → done; failures show until dismissed or the next start", async () => {
    const release = Promise.withResolvers<void>()
    const env = fakeRuntime(() => release.promise)
    const request = env.tracker.request("ses_1")
    expect(env.tracker.view("ses_1").phase).toBe("requesting")
    release.resolve()
    expect(await request).toBe(true)
    expect(env.tracker.view("ses_1").phase).toBe("queued")
    env.clearPending()
    env.publish("session.compaction.started", { reason: "manual", recent: "" })
    expect(env.tracker.view("ses_1")).toEqual({ phase: "running", reason: "manual" })
    env.publish("session.compaction.failed", { reason: "manual", error: { type: "x", message: "context too small" } })
    expect(env.tracker.view("ses_1")).toMatchObject({
      phase: "failed",
      error: "context too small",
      requestFailed: false,
    })
    env.publish("session.compaction.started", { reason: "auto", recent: "" })
    expect(env.tracker.view("ses_1")).toEqual({ phase: "running", reason: "auto" })
    env.publish("session.compaction.ended", { reason: "auto", text: "", recent: "" })
    expect(env.tracker.view("ses_1").phase).toBe("idle")
  })

  test("a refused request is a failure of the request; dismiss hides it", async () => {
    const env = fakeRuntime(() =>
      Promise.reject(Object.assign(new Error("boom"), { data: { message: "Session busy" } })),
    )
    expect(await env.tracker.request("ses_1")).toBe(false)
    env.clearPending()
    expect(env.tracker.view("ses_1")).toMatchObject({ phase: "failed", error: "Session busy", requestFailed: true })
    env.tracker.dismiss("ses_1")
    expect(env.tracker.view("ses_1").phase).toBe("idle")
  })
})

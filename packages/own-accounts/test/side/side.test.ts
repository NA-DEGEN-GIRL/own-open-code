// 곁질문 (02 §9.7): the side.* handlers over an in-memory plugin KV and a stand-in for core's `ctx.session.side`. A
// question streams as side.delta events, ends with side.ended and a `side` ledger line, follow-ups resend the thread,
// a tool call before any text is asked again without tools, cancel ends a running answer, and nothing about a side
// question reaches anything but the plugin's own KV row.
import { describe, expect, test } from "bun:test"
import type { SessionSideInput, SessionSideResult } from "@opencode/plugin/promise/session"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Kv, Side, type Ledger } from "@own/protocol"
import type { Schema } from "effect"
import type { Modules } from "../../src/modules.js"
import { SideRpc } from "../../src/rpc/side.js"
import { SideQuestions } from "../../src/side/side.js"
import { call, ok, recordEvents, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

const SESSION = "ses_side_test"

function memoryStorage() {
  const values = new Map<string, Schema.Json>()
  const storage: StorageDomain = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      await Bun.sleep(0)
      values.set(key, structuredClone(value))
    },
    remove: async (key) => {
      await Bun.sleep(0)
      values.delete(key)
    },
    scan: async () => ({ entries: [] }),
  }
  return { storage, values }
}

type Answer = (input: SessionSideInput, signal: AbortSignal | undefined) => Promise<SessionSideResult>

const MODEL = { providerID: "own-codex-a1", id: "gpt-6.1-sol" } as SessionSideResult["model"]

const streamed =
  (...parts: string[]): Answer =>
  async (input) => {
    parts.forEach((part) => input.onText?.(part))
    return {
      text: parts.join(""),
      finish: "stop",
      model: MODEL,
      tokens: { input: 40, output: 12, reasoning: 0, cache: { read: 960, write: 0 } },
      cost: 0.002,
    }
  }

async function rig(answer: Answer, sessions: ReadonlySet<string> = new Set([SESSION])) {
  const kv = memoryStorage()
  const asked: Array<SessionSideInput> = []
  const lines: Array<{ readonly tokens: Ledger.Tokens | null; readonly costUSD: number | null }> = []
  const state = { answer }
  const t = await testDeps({
    ctx: {
      storage: kv.storage,
      session: {
        get: async (input: { sessionID: string }) => {
          if (!sessions.has(input.sessionID)) throw new Error("not found")
          return {}
        },
        side: (input: SessionSideInput, options?: { readonly signal?: AbortSignal }) => {
          asked.push(input)
          return state.answer(input, options?.signal)
        },
      } as never,
    },
  })
  const cost: Ledger.Cost = { unit: "credits", amount: 0.3, source: "ratecard" }
  const peers = () =>
    ({
      telemetry: {
        recordSide: async (input: { readonly tokens: Ledger.Tokens | null; readonly costUSD: number | null }) => {
          lines.push(input)
          return cost
        },
      },
    }) as unknown as Modules.All
  const side = SideQuestions.create(t.deps, peers)
  const rpc = SideRpc.handlers({ side } as unknown as Modules.All)
  return {
    t,
    kv,
    asked,
    lines,
    cost,
    state,
    side,
    rpc,
    events: recordEvents(t.deps),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

const endedOf = (events: ReadonlyArray<{ readonly name: string; readonly payload: Readonly<Record<string, unknown>> }>) =>
  events.filter((event) => event.name === "side.ended")

describe("side questions", () => {
  test("a question streams as deltas, ends with the stored turn and a side ledger line, and stays out of the session", async () => {
    await using r = await rig(streamed("run.ts에서", "만 불려요."))
    const asked = await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "이 함수는 어디서 불려?" } as never)
    expect(asked.thread.turns).toEqual([
      expect.objectContaining({ question: "이 함수는 어디서 불려?", answer: "", status: "running" }),
    ])
    expect(asked.thread.id).toMatch(Side.ID_PATTERN)
    await until(() => endedOf(r.events).length === 1)
    const text = r.events
      .filter((event) => event.name === "side.delta")
      .map((event) => [event.payload.offset, event.payload.text])
    expect(text.map((item) => item[1]).join("")).toBe("run.ts에서만 불려요.")
    expect(text[0]?.[0]).toBe(0)
    const ended = endedOf(r.events)[0]!.payload
    expect(ended).toMatchObject({ sessionID: SESSION, threadID: asked.thread.id, index: 0 })
    expect(ended.turn).toMatchObject({
      answer: "run.ts에서만 불려요.",
      status: "done",
      finish: "stop",
      model: { providerID: "own-codex-a1", id: "gpt-6.1-sol" },
      tokens: { input: 40, cacheRead: 960, cacheWrite: 0, cacheWrite1h: null, output: 12, reasoning: 0 },
      cost: r.cost,
    })
    expect(r.lines).toEqual([expect.objectContaining({ costUSD: 0.002 })])
    // The model saw the instruction once, in the question's own message, and no tool choice.
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0]?.toolChoice).toBeUndefined()
    expect(r.asked[0]?.turns).toEqual([
      { role: "user", text: `${SideQuestions.INSTRUCTION}\n\n이 함수는 어디서 불려?` },
    ])
    // Only the plugin's own row was written.
    expect([...r.kv.values.keys()]).toEqual([Kv.side(SESSION)])
    const listed = await ok(r.rpc["side.list"], { sessionID: SESSION } as never)
    expect(listed.threads).toEqual([
      expect.objectContaining({ id: asked.thread.id, question: "이 함수는 어디서 불려?", turns: 1, status: "done" }),
    ])
  })

  test("a follow-up resends the thread byte for byte before the new question", async () => {
    await using r = await rig(streamed("첫 답"))
    const first = await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "첫 질문" } as never)
    await until(() => endedOf(r.events).length === 1)
    r.state.answer = streamed("둘째 답")
    const second = await ok(r.rpc["side.ask"], {
      sessionID: SESSION,
      threadID: first.thread.id,
      question: "이어서",
    } as never)
    expect(second.thread.turns.map((turn) => turn.status)).toEqual(["done", "running"])
    await until(() => endedOf(r.events).length === 2)
    expect(r.asked[1]?.turns).toEqual([
      { role: "user", text: `${SideQuestions.INSTRUCTION}\n\n첫 질문` },
      { role: "assistant", text: "첫 답" },
      { role: "user", text: "이어서" },
    ])
    const thread = await ok(r.rpc["side.get"], { sessionID: SESSION, threadID: first.thread.id } as never)
    expect(thread.thread.turns.map((turn) => turn.answer)).toEqual(["첫 답", "둘째 답"])
  })

  test("a model that goes for a tool before any text is asked once more with no tool call", async () => {
    const calls: Array<"none" | undefined> = []
    await using r = await rig(async (input) => {
      calls.push(input.toolChoice)
      if (input.toolChoice === undefined) return { text: "", finish: "tool-calls", model: MODEL }
      input.onText?.("도구 없이 답해요")
      return { text: "도구 없이 답해요", finish: "stop", model: MODEL }
    })
    await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "파일 목록은?" } as never)
    await until(() => endedOf(r.events).length === 1)
    expect(calls).toEqual([undefined, "none"])
    expect(endedOf(r.events)[0]?.payload.turn).toMatchObject({ answer: "도구 없이 답해요", status: "done" })
  })

  test("cancel ends a running answer as cancelled and keeps what arrived", async () => {
    await using r = await rig(
      (input, signal) =>
        new Promise((_resolve, reject) => {
          input.onText?.("부분")
          signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    const asked = await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "길게 설명해 줘" } as never)
    const running = await ok(r.rpc["side.get"], { sessionID: SESSION, threadID: asked.thread.id } as never)
    expect(running.thread.turns[0]).toMatchObject({ status: "running", answer: "부분" })
    expect(await ok(r.rpc["side.cancel"], { sessionID: SESSION, threadID: asked.thread.id } as never)).toEqual({
      cancelled: true,
    })
    await until(() => endedOf(r.events).length === 1)
    expect(endedOf(r.events)[0]?.payload.turn).toMatchObject({ status: "cancelled", answer: "부분" })
    expect(r.lines).toEqual([])
    expect(await ok(r.rpc["side.cancel"], { sessionID: SESSION, threadID: asked.thread.id } as never)).toEqual({
      cancelled: false,
    })
  })

  test("a conversation waits for at most two answers; an unknown conversation or thread is refused", async () => {
    const hold: Array<() => void> = []
    await using r = await rig(
      () =>
        new Promise((resolve) =>
          hold.push(() => resolve({ text: "끝", finish: "stop", model: MODEL })),
        ),
    )
    await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "하나" } as never)
    await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "둘" } as never)
    const third = await call(r.rpc["side.ask"], { sessionID: SESSION, question: "셋" } as never)
    expect(third).toMatchObject({ ok: false, type: "side_busy", data: { max: Side.RUNNING_MAX } })
    const unknown = await call(r.rpc["side.ask"], { sessionID: "ses_gone", question: "?" } as never)
    expect(unknown).toMatchObject({ ok: false, type: "side_unavailable", data: { reason: "session" } })
    const missing = await call(r.rpc["side.ask"], {
      sessionID: SESSION,
      threadID: "side_01JB0000000000000000000000",
      question: "?",
    } as never)
    expect(missing).toMatchObject({ ok: false, type: "side_not_found" })
    hold.forEach((release) => release())
    await until(() => endedOf(r.events).length === 2)
  })

  test("a turn left running by a restart reads as failed; removal and a deleted conversation drop the row", async () => {
    await using r = await rig(streamed("답"))
    const id = "side_01JB0000000000000000000001"
    await r.kv.storage.set(Kv.side(SESSION), {
      threads: [
        {
          id,
          sessionID: SESSION,
          createdAt: 1,
          updatedAt: 1,
          turns: [{ question: "질문", answer: "", status: "running", startedAt: 1 }],
        },
      ],
    })
    const read = await ok(r.rpc["side.get"], { sessionID: SESSION, threadID: id } as never)
    expect(read.thread.turns[0]).toMatchObject({ status: "failed", error: "서비스가 다시 시작돼 답이 끊겼어요." })
    expect(await ok(r.rpc["side.remove"], { sessionID: SESSION, threadID: id } as never)).toEqual({ removed: true })
    expect(r.kv.values.has(Kv.side(SESSION))).toBe(false)
    await ok(r.rpc["side.ask"], { sessionID: SESSION, question: "다시" } as never)
    await until(() => endedOf(r.events).length === 1)
    expect(r.kv.values.has(Kv.side(SESSION))).toBe(true)
    await r.side.onEvent?.({ type: "session.deleted", data: { sessionID: SESSION } } as never, { local: true })
    await until(() => !r.kv.values.has(Kv.side(SESSION)))
  })
})

import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { SessionMessage } from "@opencode/schema/session-message"
import { Schema } from "effect"
import { Names } from "../../src/host/names.js"
import { V1View } from "../../src/host/view.js"

const decode = Schema.decodeUnknownSync(SessionMessage.Info)
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const OTHER = { providerID: "fake-a", id: "gpt-5.5" }
const SESSION: V1View.Session = { id: "ses_1", agent: "build", model: Schema.decodeUnknownSync(Model.Ref)(MODEL), directory: "C:/work" }
const agents = Names.agents({
  registered: new Map([["explore", "explore"]]),
  keyOf: (name) => (name.toLowerCase().startsWith("sisyphus") ? "sisyphus" : name.toLowerCase()),
})

const user = (id: string, text: string, created: number, metadata?: Record<string, unknown>) =>
  decode({ id, type: "user", text, time: { created }, ...(metadata === undefined ? {} : { metadata }) })
const assistant = (id: string, content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  decode({
    id,
    type: "assistant",
    agent: "build",
    model: MODEL,
    content,
    time: { created: 1000, completed: 2000 },
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 0 } },
    cost: 0.5,
    ...extra,
  })

describe("V1View (15 §3.3)", () => {
  test("user, synthetic and assistant messages with OpenCode 1 ids, roles, agents and models", () => {
    const view = V1View.messages({
      history: [
        user("msg_001", "hello", 100),
        assistant("msg_002", [
          { type: "reasoning", text: "thinking", time: { created: 1100, completed: 1200 } },
          { type: "text", text: "hi" },
        ], { finish: "stop" }),
        decode({ id: "msg_003", type: "synthetic", text: "continue <!-- OMO_INTERNAL_INITIATOR -->", time: { created: 3000 } }),
      ],
      session: SESSION,
      agents,
    })
    expect<unknown>(view.map((message) => [message.info.id, message.info.role])).toEqual([
      ["msg_001", "user"],
      ["msg_002", "assistant"],
      ["msg_003", "user"],
    ])
    const [first, second, third] = view
    expect<unknown>(first!.info).toMatchObject({ agent: Names.SISYPHUS, model: { providerID: "fake-ds", modelID: "deepseek-v4-pro" }, time: { created: 100 } })
    expect<unknown>(first!.parts).toEqual([{ id: "prt_001_0", sessionID: "ses_1", messageID: "msg_001", type: "text", text: "hello" }])
    expect<unknown>(second!.info).toMatchObject({
      role: "assistant",
      parentID: "msg_001",
      agent: Names.SISYPHUS,
      providerID: "fake-ds",
      modelID: "deepseek-v4-pro",
      finish: "stop",
      cost: 0.5,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 0 } },
      time: { created: 1000, completed: 2000 },
      path: { cwd: "C:/work", root: "C:/work" },
    })
    expect<unknown>(second!.parts.map((part) => part.type)).toEqual(["reasoning", "text"])
    expect<unknown>(third!.parts[0]).toMatchObject({ type: "text", synthetic: true })
    expect<unknown>((third!.parts[0] as { text: string }).text).toContain("OMO_INTERNAL_INITIATOR")
  })

  test("tool parts: streaming, running, completed and error, under OpenCode 1 names and inputs", () => {
    const [message] = V1View.messages({
      history: [
        assistant(
          "msg_010",
          [
            { type: "tool", id: "c1", name: "shell", state: { status: "streaming", input: "{\"comm" }, time: { created: 1000 } },
            {
              type: "tool",
              id: "c2",
              name: "read",
              state: { status: "running", input: { path: "a.ts" }, metadata: { title: "a.ts" } },
              time: { created: 1000, ran: 1100 },
            },
            {
              type: "tool",
              id: "c3",
              name: "omo_task",
              state: {
                status: "completed",
                input: { prompt: "p" },
                content: [{ type: "text", text: "done" }, { type: "text", text: "more" }],
                metadata: { title: "Task", sessionID: "ses_2" },
              },
              time: { created: 1000, ran: 1100, completed: 1500 },
            },
            {
              type: "tool",
              id: "c4",
              name: "patch",
              state: { status: "error", input: { patchText: "x" }, error: { type: "tool", message: "bad patch" } },
              time: { created: 1000, ran: 1100, completed: 1600 },
            },
          ],
          { finish: "tool-calls" },
        ),
      ],
      session: SESSION,
      agents,
    })
    const tools = message!.parts as Array<Record<string, any>>
    expect<unknown>(tools.map((part) => [part.callID, part.tool, part.state.status])).toEqual([
      ["c1", "bash", "pending"],
      ["c2", "read", "running"],
      ["c3", "task", "completed"],
      ["c4", "apply_patch", "error"],
    ])
    expect<unknown>(tools[0]!.state).toEqual({ status: "pending", input: {}, raw: "{\"comm" })
    expect<unknown>(tools[1]!.state).toEqual({ status: "running", input: { filePath: "a.ts" }, title: "a.ts", metadata: { title: "a.ts" }, time: { start: 1100 } })
    expect<unknown>(tools[2]!.state).toMatchObject({ output: "done\nmore", title: "Task", metadata: { sessionID: "ses_2" }, time: { start: 1100, end: 1500 } })
    expect<unknown>(tools[3]!.state).toMatchObject({ error: "bad patch", input: { patchText: "x" }, time: { start: 1100, end: 1600 } })
    expect<unknown>(message!.info).toMatchObject({ finish: "tool-calls" })
  })

  test("an interrupted step is MessageAbortedError; other errors are APIError", () => {
    const view = V1View.messages({
      history: [
        assistant("msg_020", [{ type: "text", text: "partial" }], { error: { type: "aborted", message: "Step interrupted" } }),
        assistant("msg_021", [], { error: { type: "provider", message: "rate limited", status: 429 } }),
      ],
      session: SESSION,
      agents,
    })
    expect<unknown>(view[0]!.info).toMatchObject({ error: { name: "MessageAbortedError", data: { message: "Step interrupted" } } })
    expect<unknown>(view[1]!.info).toMatchObject({ error: { name: "APIError", data: { message: "rate limited", statusCode: 429 } } })
  })

  test("a completed compaction is OpenCode 1's pair; idle, system, switch and shell markers are left out", () => {
    const view = V1View.messages({
      history: [
        user("msg_030", "old", 100),
        decode({
          id: "msg_031",
          type: "compaction",
          status: "completed",
          reason: "auto",
          summary: "what happened",
          recent: "",
          time: { created: 200 },
        }),
        decode({ id: "msg_032", type: "idle", outcome: "succeeded", time: { created: 300 } }),
        decode({ id: "msg_033", type: "system", text: "update", time: { created: 400 } }),
        decode({ id: "msg_034", type: "agent-switched", agent: "plan", previous: "build", time: { created: 500 } }),
      ],
      session: SESSION,
      agents,
    })
    expect<unknown>(view.map((message) => [message.info.id, message.info.role, message.info.agent])).toEqual([
      ["msg_030", "user", Names.SISYPHUS],
      ["msg_031", "user", "compaction"],
      ["msg_031s", "assistant", "compaction"],
    ])
    expect<unknown>(view[1]!.parts).toEqual([{ id: "prt_031_0", sessionID: "ses_1", messageID: "msg_031", type: "compaction", auto: true }])
    expect<unknown>(view[2]!.info).toMatchObject({ summary: true, finish: "stop", parentID: "msg_031" })
    expect<unknown>(view[2]!.parts[0]).toMatchObject({ type: "text", text: "what happened" })
  })

  // OpenCode 1 kept a failed compaction's summary message with its error: omo's next idle sees a compaction marker as the
  // latest message and continues nothing, also when the failed compaction's drain ends as a success.
  test("a failed compaction is the pair with the error on its summary message; a running one is left out", () => {
    const view = V1View.messages({
      history: [
        user("msg_040", "compact this", 100),
        assistant("msg_041", [{ type: "text", text: "ok" }], { finish: "stop" }),
        decode({
          id: "msg_042",
          type: "compaction",
          status: "failed",
          reason: "manual",
          error: { type: "provider", message: "overloaded", status: 529 },
          time: { created: 300 },
        }),
        decode({ id: "msg_043", type: "compaction", status: "running", reason: "manual", summary: "", recent: "", time: { created: 400 } }),
      ],
      session: SESSION,
      agents,
    })
    expect<unknown>(view.map((message) => [message.info.id, message.info.role, message.info.agent])).toEqual([
      ["msg_040", "user", Names.SISYPHUS],
      ["msg_041", "assistant", Names.SISYPHUS],
      ["msg_042", "user", "compaction"],
      ["msg_042s", "assistant", "compaction"],
    ])
    expect<unknown>(view[2]!.parts).toEqual([{ id: "prt_042_0", sessionID: "ses_1", messageID: "msg_042", type: "compaction", auto: false }])
    expect<unknown>(view[3]!.info).toMatchObject({
      summary: true,
      mode: "compaction",
      parentID: "msg_042",
      modelID: "deepseek-v4-pro",
      time: { created: 300, completed: 300 },
      error: { name: "APIError", data: { message: "overloaded", statusCode: 529 } },
    })
    expect(view[3]!.info).not.toHaveProperty("finish")
    expect<unknown>(view[3]!.parts).toEqual([])
  })

  test("a context reset is a compaction pair without summary text, so omo sees the boundary; an undone one is left out", () => {
    const reset = (id: string, extra: Record<string, unknown> = {}) =>
      decode({ id, type: "compaction", status: "completed", reason: "reset", summary: "", recent: "", time: { created: 300 }, ...extra })
    const view = V1View.messages({ history: [reset("msg_060")], session: SESSION, agents })
    expect<unknown>(view.map((message) => [message.info.id, message.info.role, message.info.agent])).toEqual([
      ["msg_060", "user", "compaction"],
      ["msg_060s", "assistant", "compaction"],
    ])
    expect<unknown>(view[0]!.parts).toEqual([{ id: "prt_060_0", sessionID: "ses_1", messageID: "msg_060", type: "compaction", auto: false }])
    expect<unknown>(view[1]!.parts).toEqual([])
    expect<unknown>(view[1]!.info).toMatchObject({ summary: true, finish: "stop" })
    const undone = V1View.messages({
      history: [user("msg_061", "before", 100), reset("msg_062", { undone: 400 }), user("msg_063", "after", 500)],
      session: SESSION,
      agents,
    })
    expect<unknown>(undone.map((message) => message.info.id)).toEqual(["msg_061", "msg_063"])
  })

  test("agent and model are folded back over switches; tools are the session's overlay", () => {
    const view = V1View.messages({
      history: [
        user("msg_040", "first", 100),
        decode({ id: "msg_041", type: "agent-switched", agent: "omo-explore", previous: "build", time: { created: 150 } }),
        decode({ id: "msg_042", type: "model-switched", model: MODEL, previous: OTHER, time: { created: 160 } }),
        user("msg_043", "second", 200),
      ],
      session: { ...SESSION, agent: "omo-explore" },
      agents,
      tools: { task: false, write: false },
    })
    expect<unknown>(view[0]!.info).toMatchObject({ agent: Names.SISYPHUS, model: { providerID: "fake-a", modelID: "gpt-5.5" } })
    expect<unknown>(view[1]!.info).toMatchObject({ agent: "explore", model: { providerID: "fake-ds" }, tools: { task: false, write: false } })
  })

  test("omo's appended text is part of the user message it was made for", () => {
    const [message] = V1View.messages({
      history: [user("msg_050", "ulw do it", 100, { "own.omo": { append: { suffix: "\n\n---\n\n<ultrawork-mode>", parts: ["extra"] } } })],
      session: SESSION,
      agents,
    })
    expect<unknown>(message!.parts.map((part) => (part as { text: string }).text)).toEqual(["ulw do it\n\n---\n\n<ultrawork-mode>", "extra"])
    expect<unknown>(message!.parts[1]).toMatchObject({ synthetic: true })
    // With skills attached, the model's copy has their texts first: the append names where the message's text is.
    expect(V1View.appendOf({ "own.omo": { append: { suffix: "x", at: 2 } } })).toEqual({ suffix: "x", at: 2 })
    expect(V1View.appendOf({ "own.omo": { append: "x" } })).toBeUndefined()
  })

  test("limit keeps the newest messages, as OpenCode 1's messages({limit}) did", () => {
    expect<unknown>(V1View.limited([1, 2, 3, 4], 2)).toEqual([3, 4])
    expect<unknown>(V1View.limited([1, 2], 5)).toEqual([1, 2])
    expect<unknown>(V1View.limited([1, 2], undefined)).toEqual([1, 2])
  })
})

import { describe, expect, test } from "bun:test"
import { V1Events } from "../../src/host/events.js"
import { Names } from "../../src/host/names.js"

const agents = Names.agents({ registered: new Map([["explore", "explore"]]), keyOf: (name) => name.toLowerCase() })
const input = { agents, directory: "C:/work", now: 5000 }
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }

// SAFETY: test events carry the fields the projector reads; the full event union is the server's.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const event = (type: string, data: Record<string, unknown>) => ({ type, data }) as unknown as V1Events.V2Event

describe("V1Events.project (15 §3.4)", () => {
  test("execution: busy while it runs, then idle; a failure and an interruption are session errors first", () => {
    const state = new V1Events.State()
    expect(V1Events.project(event("session.execution.started", { sessionID: "ses_1" }), state, input)).toEqual([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
    ])
    expect(state.status.get("ses_1")).toEqual({ type: "busy" })
    expect(V1Events.project(event("session.execution.succeeded", { sessionID: "ses_1" }), state, input)).toEqual([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID: "ses_1" } },
    ])
    expect(state.status.has("ses_1")).toBe(false)
    const failed = V1Events.project(
      event("session.execution.failed", { sessionID: "ses_1", error: { type: "provider", message: "boom" } }),
      state,
      input,
    )
    expect(failed.map((entry) => entry.type)).toEqual(["session.error", "session.status", "session.idle"])
    expect(failed[0]!.properties).toMatchObject({ error: { name: "APIError", data: { message: "boom" } } })
    const interrupted = V1Events.project(event("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }), state, input)
    expect(interrupted[0]).toMatchObject({ type: "session.error", properties: { error: { name: "MessageAbortedError" } } })
    expect(interrupted.map((entry) => entry.type)).toEqual(["session.error", "session.status", "session.idle"])
    // A shutdown is no turn end: the restarted service resumes the same execution.
    expect(V1Events.project(event("session.execution.interrupted", { sessionID: "ses_1", reason: "shutdown" }), state, input)).toEqual([])
  })

  test("steps are message.updated with the assistant's agent, model, parent and finish", () => {
    const state = new V1Events.State()
    V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_user" }), state, input)
    const started = V1Events.project(
      event("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        agent: "omo-explore",
        model: MODEL,
        started: 4000,
      }),
      state,
      input,
    )
    expect(started[0]).toMatchObject({
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { id: "msg_a", role: "assistant", agent: "explore", parentID: "msg_user", modelID: "deepseek-v4-pro", time: { created: 4000 } },
      },
    })
    const ended = V1Events.project(
      event("session.step.ended", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        finish: "stop",
        cost: 0.25,
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      }),
      state,
      input,
    )
    expect(ended[0]!.properties).toMatchObject({
      info: { finish: "stop", cost: 0.25, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, time: { created: 4000, completed: 5000 } },
    })
    // A step that ended before this instance saw it start has nothing to update.
    expect(V1Events.project(event("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_x", finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), state, input)).toEqual([])
  })

  test("tools are message.part.updated under their OpenCode 1 names: running, then completed or error", () => {
    const state = new V1Events.State()
    V1Events.project(event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "c1", name: "shell" }), state, input)
    const called = V1Events.project(
      event("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "c1", input: { command: "ls" }, executed: false }),
      state,
      input,
    )
    expect(called[0]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "ls" } } } },
    })
    const done = V1Events.project(
      event("session.tool.success", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "c1",
        content: [{ type: "text", text: "a.ts" }],
        metadata: { title: "ls" },
        executed: false,
      }),
      state,
      input,
    )
    expect(done[0]).toMatchObject({ properties: { part: { tool: "bash", state: { status: "completed", output: "a.ts", title: "ls" } } } })
    V1Events.project(event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "c2", name: "omo_task" }), state, input)
    const failed = V1Events.project(
      event("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "c2", error: { type: "tool", message: "no" }, executed: false }),
      state,
      input,
    )
    expect(failed[0]).toMatchObject({ properties: { part: { tool: "task", state: { status: "error", error: "no" } } } })
  })

  test("created, deleted and compacted sessions; children are remembered and forgotten", () => {
    const state = new V1Events.State()
    const created = V1Events.project(
      event("session.created", {
        sessionID: "ses_child",
        parentID: "ses_parent",
        projectID: "prj",
        slug: "s",
        location: { directory: "C:/work" },
        title: "find add",
        version: "2.0.32",
      }),
      state,
      input,
    )
    expect(created[0]).toMatchObject({
      type: "session.created",
      properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_parent", directory: "C:/work", title: "find add" } },
    })
    expect([...(state.children.get("ses_parent") ?? [])]).toEqual(["ses_child"])
    expect(V1Events.project(event("session.compaction.ended", { sessionID: "ses_parent" }), state, input)).toEqual([
      { type: "session.compacted", properties: { sessionID: "ses_parent" } },
    ])
    expect(V1Events.project(event("session.deleted", { sessionID: "ses_child" }), state, input)[0]).toMatchObject({
      type: "session.deleted",
      properties: { sessionID: "ses_child", info: { id: "ses_child" } },
    })
    expect([...(state.children.get("ses_parent") ?? [])]).toEqual([])
  })

  test("a delivered user or synthetic message is OpenCode 1's message.updated and its text parts", () => {
    const state = new V1Events.State()
    const session = { agent: "build", model: { ...MODEL, variant: "high" } } as V1Events.Selection
    const append = { "own.omo": { append: { suffix: "\n\n<ultrawork-mode>", parts: ["extra"] } } }
    V1Events.project(
      event("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_u", item: { type: "user", payload: { text: "ulw go", metadata: append }, delivery: "steer" } }),
      state,
      input,
    )
    expect(state.pending("ses_1", "msg_u")).toBe(true)
    const user = V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_u" }), state, { ...input, session })
    expect(user).toEqual([
      {
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: {
            id: "msg_u",
            sessionID: "ses_1",
            role: "user",
            time: { created: 5000 },
            agent: Names.SISYPHUS,
            model: { providerID: "fake-ds", modelID: "deepseek-v4-pro", variant: "high" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: "ses_1", part: { id: "prt_u_0", sessionID: "ses_1", messageID: "msg_u", type: "text", text: "ulw go\n\n<ultrawork-mode>" } },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: "ses_1", part: { id: "prt_u_1", sessionID: "ses_1", messageID: "msg_u", type: "text", text: "extra", synthetic: true } },
      },
    ])
    expect(state.pending("ses_1", "msg_u")).toBe(false)
    expect(state.lastUser.get("ses_1")).toBe("msg_u")
    V1Events.project(
      event("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_s", item: { type: "synthetic", payload: { text: "TODO CONTINUATION" }, delivery: "steer" } }),
      state,
      input,
    )
    const synthetic = V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_s" }), state, { ...input, session })
    expect(synthetic.map((entry) => entry.type)).toEqual(["message.updated", "message.part.updated"])
    expect(synthetic[1]!.properties).toMatchObject({ part: { text: "TODO CONTINUATION", synthetic: true } })
    // A cancelled item, a move and an item admitted before this instance ran announce nothing.
    V1Events.project(
      event("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_c", item: { type: "user", payload: { text: "never" }, delivery: "queue" } }),
      state,
      input,
    )
    V1Events.project(event("session.inbox.cancelled", { sessionID: "ses_1", inboxID: "msg_c" }), state, input)
    expect(V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_c" }), state, input)).toEqual([])
    V1Events.project(
      event("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_m",
        item: { type: "move", payload: { location: { directory: "C:/other" }, projectID: "prj" }, delivery: "queue" },
      }),
      state,
      input,
    )
    expect(V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_m" }), state, input)).toEqual([])
    expect(V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_old" }), state, input)).toEqual([])
    expect(state.inbox.size).toBe(0)
  })

  // On OpenCode 1 a manual compaction's user message and its part cancel omo's 2 s continuation countdown; a compaction
  // that ended inside the countdown was otherwise followed by a TODO CONTINUATION.
  test("a delivered manual compaction is OpenCode 1's compaction user message; its end is session.compacted", () => {
    const state = new V1Events.State()
    V1Events.project(
      event("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_k", item: { type: "compaction", payload: {}, delivery: "steer" } }),
      state,
      input,
    )
    expect(state.pending("ses_1", "msg_k")).toBe(true)
    const compaction = V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_k" }), state, {
      ...input,
      session: { agent: "build", model: MODEL } as V1Events.Selection,
    })
    expect(compaction).toEqual([
      {
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: {
            id: "msg_k",
            sessionID: "ses_1",
            role: "user",
            time: { created: 5000 },
            agent: "compaction",
            model: { providerID: "fake-ds", modelID: "deepseek-v4-pro" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: "ses_1", part: { id: "prt_k_0", sessionID: "ses_1", messageID: "msg_k", type: "compaction", auto: false } },
      },
    ])
    expect(state.pending("ses_1", "msg_k")).toBe(false)
    expect(state.lastUser.get("ses_1")).toBe("msg_k")
    expect(V1Events.project(event("session.compaction.ended", { sessionID: "ses_1" }), state, input)).toEqual([
      { type: "session.compacted", properties: { sessionID: "ses_1" } },
    ])
  })

  test("a delivered context reset is OpenCode 1's compaction pair, without session.compacted", () => {
    const state = new V1Events.State()
    V1Events.project(
      event("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "msg_r", item: { type: "reset", payload: {}, delivery: "queue" } }),
      state,
      input,
    )
    const reset = V1Events.project(event("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_r" }), state, {
      ...input,
      session: { agent: "build", model: MODEL } as V1Events.Selection,
    })
    expect(reset.map((entry) => entry.type)).toEqual(["message.updated", "message.part.updated", "message.updated"])
    expect(reset[0]!.properties).toMatchObject({ info: { id: "msg_r", role: "user", agent: "compaction" } })
    expect(reset[1]!.properties).toEqual({
      sessionID: "ses_1",
      part: { id: "prt_r_0", sessionID: "ses_1", messageID: "msg_r", type: "compaction", auto: false },
    })
    expect(reset[2]!.properties).toMatchObject({
      info: { id: "msg_rs", role: "assistant", agent: "compaction", summary: true, finish: "stop", parentID: "msg_r", modelID: "deepseek-v4-pro" },
    })
  })

  test("only the events the pump forwards name a session; text deltas and the like are dropped first", () => {
    expect(V1Events.sessionOf(event("session.execution.started", { sessionID: "ses_1" }))).toBe("ses_1")
    expect(V1Events.sessionOf(event("session.text.delta", { sessionID: "ses_1" }))).toBeUndefined()
    expect(V1Events.sessionOf(event("plugin.updated", {}))).toBeUndefined()
  })
})

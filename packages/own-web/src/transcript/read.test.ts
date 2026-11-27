// The transcript's first message read (read.ts) against the real createData with an in-memory API: a step the event
// stream added while the read was in flight survives the read's older snapshot, and so do its later events (the
// websearch e2e lost the search card this way); older pages a read drops on purpose ask no second read; a turn that
// keeps outrunning the reads stops after the last reread.
import { expect, test } from "bun:test"
import { OpenCode, type OpenCodeEvent, type SessionMessageInfo } from "@opencode/client"
import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client/promise"
import { createData, type CreateDataInput } from "@opencode/client/solid"
import { createRoot } from "solid-js"
import { readMessages } from "./read"

const SESSION = "ses_read_race"

const user = (id: string, created: number): SessionMessageInfo => ({
  id,
  type: "user",
  text: "[websearch] bun 1.4",
  time: { created },
})

const step = (id: string, created: number, content: SessionMessageAssistantTool[] = []) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "deepseek", id: "deepseek-v4" },
    content,
    time: { created, completed: created + 1 },
  }) satisfies SessionMessageAssistant

/** createData over an API whose message reads answer, one by one, with the snapshots `answer` hands out. */
function setup(answer: (read: number) => Promise<readonly SessionMessageInfo[]>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const reads = { count: 0 }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        if (!new URL(request.url).pathname.endsWith("/message")) return Response.json({ data: [] })
        const data = await answer(++reads.count)
        return Response.json({ data: [...data].reverse(), cursor: {} })
      },
      { preconnect: () => {} },
    ),
  })
  const root = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  let seq = 0
  const emit = (type: string, created: number, data: Record<string, unknown>) => {
    const event = {
      id: `evt_${++seq}`,
      created,
      type,
      durable: { aggregateID: SESSION, seq, version: 1 },
      data: { sessionID: SESSION, ...data },
    } as unknown as OpenCodeEvent
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
  }
  return { data: root.data, dispose: root.dispose, emit, reads }
}

const ids = (data: ReturnType<typeof setup>["data"]) => data.session.message.list(SESSION).map((message) => message.id)

test("a step that started while the first read was in flight keeps its message and its later events", async () => {
  const first = Promise.withResolvers<void>()
  const searched = [
    user("msg_user", 1),
    step("msg_step1", 2, [
      {
        type: "tool",
        id: "call_search",
        name: "websearch",
        time: { created: 3, ran: 3 },
        state: { status: "running", input: { query: "bun 1.4" }, metadata: {} },
      },
    ]),
  ]
  // The server took the first snapshot before the step started; the second read sees the step and its search.
  const ctx = setup(async (read) => {
    if (read > 1) return searched
    await first.promise
    return [user("msg_user", 1)]
  })
  try {
    const read = readMessages(ctx.data, SESSION)
    ctx.emit("session.step.started", 2, {
      assistantMessageID: "msg_step1",
      agent: "build",
      model: { providerID: "deepseek", id: "deepseek-v4" },
      started: 2,
    })
    ctx.emit("session.tool.input.started", 3, { assistantMessageID: "msg_step1", id: "call_search", name: "websearch" })
    expect(ids(ctx.data)).toEqual(["msg_step1"])
    first.resolve()
    await read
    expect(ids(ctx.data)).toEqual(["msg_user", "msg_step1"])
    expect(ctx.reads.count).toBe(2)
    // The step's later events reach it again: the search card gets its result.
    ctx.emit("session.tool.success", 4, {
      assistantMessageID: "msg_step1",
      id: "call_search",
      metadata: { provider: "own-chatgpt" },
      content: [{ type: "text", text: "results" }],
      executed: true,
    })
    const message = ctx.data.session.message.get(SESSION, "msg_step1")
    expect(message?.type === "assistant" ? message.content[0] : undefined).toMatchObject({
      type: "tool",
      name: "websearch",
      state: { status: "completed", metadata: { provider: "own-chatgpt" } },
    })
  } finally {
    ctx.dispose()
  }
})

test("older pages that the read drops on purpose ask no second read", async () => {
  const pages = [user("msg_old", 1), step("msg_old_step", 2), user("msg_new", 10), step("msg_new_step", 11)]
  const ctx = setup(async (read) => (read === 1 ? pages : pages.slice(2)))
  try {
    await readMessages(ctx.data, SESSION)
    expect(ids(ctx.data)).toEqual(["msg_old", "msg_old_step", "msg_new", "msg_new_step"])
    // A reconnect reads the newest page again; the store held the older one, which the read leaves out.
    ctx.data.session.message.invalidate(SESSION)
    await readMessages(ctx.data, SESSION)
    expect(ids(ctx.data)).toEqual(["msg_new", "msg_new_step"])
    expect(ctx.reads.count).toBe(2)
  } finally {
    ctx.dispose()
  }
})

test("older pages whose messages share the newest page's time still ask no second read", async () => {
  // One millisecond for the whole history (an import, a fork, a fast turn): the read cannot tell older pages by time.
  const pages = [user("msg_old", 5), step("msg_old_step", 5), user("msg_new", 5), step("msg_new_step", 5)]
  const ctx = setup(async (read) => (read === 1 ? pages : pages.slice(2)))
  try {
    await readMessages(ctx.data, SESSION)
    ctx.data.session.message.invalidate(SESSION)
    await readMessages(ctx.data, SESSION)
    expect(ids(ctx.data)).toEqual(["msg_new", "msg_new_step"])
    expect(ctx.reads.count).toBe(2)
  } finally {
    ctx.dispose()
  }
})

test("a turn that keeps outrunning the reads stops after the last reread", async () => {
  const ctx = setup(async (read) => {
    // Every read's window sees a new step that its snapshot does not hold.
    ctx.emit("session.step.started", 10 + read, {
      assistantMessageID: `msg_step${read}`,
      agent: "build",
      model: { providerID: "deepseek", id: "deepseek-v4" },
      started: 10 + read,
    })
    return [user("msg_user", 1)]
  })
  try {
    await readMessages(ctx.data, SESSION)
    expect(ctx.reads.count).toBe(4)
  } finally {
    ctx.dispose()
  }
})

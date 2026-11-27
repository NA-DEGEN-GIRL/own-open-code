import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Schema } from "effect"
import { V1Client } from "../../src/host/client.js"
import { V1Events } from "../../src/host/events.js"
import { Names } from "../../src/host/names.js"
import { Overlays } from "../../src/host/overlay.js"
import { Todos } from "../../src/host/todo.js"

const MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"
const PARENT_MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const PARENT_RULES = [
  { action: "edit", resource: "**", effect: "allow" as const },
  { action: "own_harness_omo", resource: "*", effect: "allow" as const },
]

function fake() {
  const sessions = new Map<string, Record<string, unknown>>([
    [
      "ses_parent",
      {
        id: "ses_parent",
        projectID: "prj",
        agent: "build",
        model: PARENT_MODEL,
        location: { directory: "C:/work" },
        permissions: PARENT_RULES,
        title: "parent",
      },
    ],
  ])
  const calls: Array<[string, Record<string, unknown>]> = []
  const stored = new Map<string, unknown>()
  const history = new Map<string, ReadonlyArray<SessionMessage.Info>>()
  const ctx = {
    location: { directory: "C:/work" },
    storage: {
      get: (key: string) => Effect.sync(() => stored.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
      remove: (key: string) => Effect.sync(() => void stored.delete(key)),
    },
    model: {
      list: () => Effect.succeed({ data: [{ ...PARENT_MODEL, name: "DeepSeek V4 Pro" }] }),
      default: () => Effect.succeed({ data: { ...PARENT_MODEL, name: "DeepSeek V4 Pro" } }),
    },
    session: {
      get: (input: { sessionID: string }) => {
        const found = sessions.get(input.sessionID)
        return found === undefined ? Effect.fail(new Error("not found")) : Effect.succeed(found)
      },
      create: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push(["create", input])
          const parent = sessions.get(input.parentID as string)!
          const created = { ...input, projectID: "prj", location: parent.location }
          sessions.set(input.id as string, created)
          return created
        }),
      switchAgent: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push(["switchAgent", input])
          sessions.set(input.sessionID as string, { ...sessions.get(input.sessionID as string), agent: input.agent })
        }),
      synthetic: (input: Record<string, unknown>) => Effect.sync(() => void calls.push(["synthetic", input])),
      prompt: (input: Record<string, unknown>) => Effect.sync(() => void calls.push(["prompt", input])),
      interrupt: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push(["interrupt", input])
          return { interrupted: true }
        }),
      wait: () => Effect.void,
      compact: (input: Record<string, unknown>) => Effect.sync(() => void calls.push(["compact", input])),
      context: (input: { sessionID: string }) => Effect.succeed(history.get(input.sessionID) ?? []),
    },
  } as unknown as Pick<Context, "session" | "location" | "model" | "storage">
  const state = new V1Events.State()
  const overlays = new Overlays.Store(ctx)
  const todos = new Todos.Store(ctx)
  const agents = Names.agents({
    registered: new Map([
      ["explore", "explore"],
      ["sisyphus-junior", "Sisyphus-Junior"],
    ]),
    keyOf: (name) => (name.toLowerCase().startsWith("sisyphus - ") ? "sisyphus" : name.toLowerCase()),
  })
  const toasts: Array<Record<string, unknown>> = []
  const client = V1Client.make({
    ctx,
    state,
    overlays,
    todos,
    agents: () => agents,
    listAgents: async () => [{ name: "explore", mode: "subagent" }],
    marker: MARKER,
    toast: (body) => void toasts.push(body),
  })
  return { client, calls, sessions, state, overlays, todos, history, toasts }
}

describe("V1Client (15 §3.4)", () => {
  test("a child is created with its first prompt, on the parent's model and location, with its denials", async () => {
    const env = fake()
    const created = await env.client.session.create({
      body: {
        parentID: "ses_parent",
        title: "find add (@explore subagent)",
        permission: [
          { permission: "question", action: "deny", pattern: "*" },
          { permission: "bash", action: "allow", pattern: "*" },
        ],
      },
    })
    const id = created.data!.id
    expect(created.data).toMatchObject({ parentID: "ses_parent", directory: "C:/work", title: "find add (@explore subagent)" })
    // Pending: readable, no messages, nothing created yet.
    expect((await env.client.session.get({ path: { id } })).data).toMatchObject({ id, parentID: "ses_parent" })
    expect((await env.client.session.messages({ path: { id } })).data).toEqual([])
    expect(env.calls).toEqual([])
    expect([...(env.state.children.get("ses_parent") ?? [])]).toEqual([id])
    await env.client.session.promptAsync({
      path: { id },
      body: {
        agent: "explore",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        variant: "max",
        system: "skill text",
        tools: { task: false, call_omo_agent: true, question: false },
        parts: [{ type: "text", text: `Find add\n${MARKER}` }],
      },
    })
    expect(env.calls[0]).toEqual([
      "create",
      {
        id,
        parentID: "ses_parent",
        title: "find add (@explore subagent)",
        agent: "omo-explore",
        model: PARENT_MODEL,
        // The parent's rules and omo's denials only: omo never widens a child's rules. GitHub's writes ask last.
        permissions: [
          ...PARENT_RULES,
          { action: "question", resource: "*", effect: "deny" },
          { action: "github.write", resource: "*", effect: "ask" },
        ],
        // omo's background manager reports the child; core's own report stays off (core P-063).
        metadata: { "own.report": false },
      },
    ])
    expect(env.calls[1]).toEqual([
      "synthetic",
      {
        sessionID: id,
        text: `Find add\n${MARKER}`,
        description: "omo 알림",
        metadata: { source: "own.omo" },
        background: true,
        resume: true,
      },
    ])
    expect(await Effect.runPromise(env.overlays.get(id))).toEqual({
      system: "skill text",
      tools: { task: false, call_omo_agent: true, question: false },
    })
  })

  test("prompts: internal text is a synthetic message with a Korean description; noReply admits only; real text is a prompt", async () => {
    const env = fake()
    await env.client.session.promptAsync({
      path: { id: "ses_parent" },
      body: {
        agent: "Sisyphus - ultraworker",
        model: { providerID: "x", modelID: "y" },
        noReply: true,
        parts: [{ type: "text", text: "[BACKGROUND TASK COMPLETED] bg_1", synthetic: true }],
      },
    })
    await env.client.session.promptAsync({
      path: { id: "ses_parent" },
      body: { parts: [{ type: "text", text: `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]\n${MARKER}`, synthetic: true }] },
    })
    await env.client.session.promptAsync({ path: { id: "ses_parent" }, body: { parts: [{ type: "text", text: "real words" }] } })
    expect(env.calls).toEqual([
      [
        "synthetic",
        expect.objectContaining({ description: "omo: 배경 작업이 끝났어요", resume: false, background: true, metadata: { source: "own.omo" } }),
      ],
      ["synthetic", expect.objectContaining({ description: "omo: 남은 할 일을 이어서 해요", resume: true })],
      ["prompt", { sessionID: "ses_parent", text: "real words", resume: true, metadata: { source: "own.omo" } }],
    ])
    // A top-level session's agent and model are never switched.
    expect(env.calls.some(([name]) => name === "switchAgent")).toBe(false)
  })

  test("a child omo created switches agent when a later prompt names another one", async () => {
    const env = fake()
    const id = (await env.client.session.create({ body: { parentID: "ses_parent" } })).data!.id
    await env.client.session.promptAsync({ path: { id }, body: { agent: "explore", parts: [{ type: "text", text: `a\n${MARKER}` }] } })
    await env.client.session.promptAsync({ path: { id }, body: { agent: "explore", parts: [{ type: "text", text: `b\n${MARKER}` }] } })
    await env.client.session.promptAsync({
      path: { id },
      body: { agent: "Sisyphus-Junior", parts: [{ type: "text", text: `c\n${MARKER}` }] },
    })
    expect(env.calls.filter(([name]) => name === "switchAgent")).toEqual([["switchAgent", { sessionID: id, agent: "omo-sisyphus-junior" }]])
  })

  test("delete does nothing; abort interrupts; status, todo, provider.list and config.get have OpenCode 1 shapes", async () => {
    const env = fake()
    expect(await env.client.session.delete({ path: { id: "ses_parent" } })).toMatchObject({ data: true, error: undefined })
    expect(env.sessions.has("ses_parent")).toBe(true)
    expect((await env.client.session.abort({ path: { id: "ses_parent" } })).data).toBe(true)
    expect(env.calls).toEqual([["interrupt", { sessionID: "ses_parent" }]])
    env.state.status.set("ses_parent", { type: "busy" })
    expect((await env.client.session.status()).data).toEqual({ ses_parent: { type: "busy" } })
    await Effect.runPromise(env.todos.set("ses_parent", [{ content: "a", status: "pending", priority: "high" }]))
    expect((await env.client.session.todo({ path: { id: "ses_parent" } })).data).toEqual([
      { content: "a", status: "pending", priority: "high" },
    ])
    expect<unknown>((await env.client.provider.list()).data).toEqual({
      all: [{ id: "fake-ds", name: "fake-ds", models: { "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", providerID: "fake-ds" } } }],
      connected: ["fake-ds"],
      default: {},
    })
    expect((await env.client.config.get()).data).toEqual({ model: "fake-ds/deepseek-v4-pro" })
    await env.client.tui.showToast({ body: { title: "t", message: "m" } })
    expect(env.toasts).toEqual([{ title: "t", message: "m" }])
  })

  test("errors are {error} unless throwOnError; messages and message read the OpenCode 1 view", async () => {
    const env = fake()
    expect(await env.client.session.get({ path: { id: "ses_missing" } })).toMatchObject({ data: undefined, error: { name: "UnknownError" } })
    expect(env.client.session.get({ path: { id: "ses_missing" }, throwOnError: true })).rejects.toThrow()
    const decode = Schema.decodeUnknownSync(SessionMessage.Info)
    env.history.set("ses_parent", [
      decode({ id: "msg_1", type: "user", text: "q", time: { created: 1 } }),
      decode({
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: PARENT_MODEL,
        content: [{ type: "text", text: "a" }],
        finish: "stop",
        time: { created: 2, completed: 3 },
      }),
    ])
    const listed = (await env.client.session.messages({ path: { id: "ses_parent" }, query: { limit: 1 } })).data!
    expect<unknown>(listed.map((message) => message.info.id)).toEqual(["msg_2"])
    expect((await env.client.session.message({ path: { id: "ses_parent", messageID: "msg_1" } })).data?.info.role).toBe("user")
  })

  test("v1 session rules: denials and asks only", () => {
    expect(
      V1Client.permissions([
        { permission: "bash", action: "deny", pattern: "rm *" },
        { permission: "edit", action: "ask", pattern: "*" },
        { permission: "webfetch", action: "allow", pattern: "*" },
        "junk",
      ]),
    ).toEqual([
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
    ])
  })
})

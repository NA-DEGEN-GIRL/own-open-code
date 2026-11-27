// The agent trees after a restart (agent-store.ts): a new Tree over the same plugin storage and sessions resolves the
// agents by path or id, gives an agent's requests the history it forked, and tells the parent when the agent finishes;
// only the instance of the session's Location answers for it. Sessions are an in-memory stand-in for core's.
import { describe, expect, spyOn, test } from "bun:test"
import { Media, Message, ToolCallPart, ToolResultPart } from "@opencode/ai/effect"
import type { Tool } from "@opencode/schema/tool"
import type { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { AgentStore } from "../../../src/codex/agent-store.js"
import { Collab } from "../../../src/codex/collab.js"
import { CollabV1 } from "../../../src/codex/collab-v1.js"

interface FakeSession {
  readonly id: string
  readonly parentID?: string
  readonly metadata: Record<string, unknown>
  readonly location: { readonly directory: string }
}

/** Core's sessions, synthetic messages and prompts as the trees use them; shared across "restarts". */
class World {
  readonly sessions = new Map<string, FakeSession>()
  readonly storage = new Map<string, unknown>()
  readonly delivered: Array<{
    readonly sessionID: string
    readonly text: string
    readonly resume?: boolean
    readonly background?: boolean
    readonly startedAt?: number
  }> = []
  /** Turns other agents stopped (`Tree.stop`), and the marks taken back because no turn was running. */
  readonly stops: Array<string> = []
  readonly withdrawn: Array<string> = []
  /** What core's interrupt answers: whether a turn was running. */
  running = true
  private next = 0

  constructor() {
    this.sessions.set("ses_root", { id: "ses_root", metadata: {}, location: { directory: "/work" } })
  }

  /**
   * One plugin instance: its own Location, tools and trees over the shared state. `pending` stands in for the input
   * that reached a session's running turn (ResetWatch).
   */
  instance(directory = "/work", pending: Record<string, ReadonlyArray<Record<string, unknown> | undefined>> = {}) {
    const tools = new Map<string, Tool.Info>()
    const ctx = {
      location: { directory },
      storage: {
        get: (key: string) => Effect.sync(() => this.storage.get(key)),
        set: (key: string, value: unknown) => Effect.sync(() => void this.storage.set(key, structuredClone(value))),
        remove: (key: string) => Effect.sync(() => void this.storage.delete(key)),
      },
      session: {
        get: (input: { readonly sessionID: string }) => {
          const found = this.sessions.get(input.sessionID)
          return found === undefined ? Effect.fail(new Error("Session.NotFoundError")) : Effect.succeed(found)
        },
        create: (input: { readonly parentID: string; readonly metadata: Record<string, unknown> }) =>
          Effect.sync(() => {
            const id = `ses_child${++this.next}`
            const parent = this.sessions.get(input.parentID)!
            this.sessions.set(id, { id, parentID: input.parentID, metadata: input.metadata, location: parent.location })
            return { id }
          }),
        synthetic: (input: World["delivered"][number]) => Effect.sync(() => void this.delivered.push(input)),
        prompt: (input: { readonly sessionID: string; readonly text: string }) =>
          Effect.sync(() => {
            this.delivered.push({ sessionID: input.sessionID, text: input.text })
            return { id: `msg_${this.next}` }
          }),
        interrupt: () => Effect.sync(() => ({ interrupted: this.running })),
      },
      tool: {
        transform: (callback: (editor: { add: (tool: Tool.Info) => void }) => void) =>
          Effect.sync(() => callback({ add: (tool) => void tools.set(tool.name, tool) })),
      },
    } as unknown as ConstructorParameters<typeof Collab.Tree>[0]
    const tree = new Collab.Tree(
      ctx,
      (sessionID) => pending[sessionID] ?? [],
      (sessionID) => {
        this.stops.push(sessionID)
        return () => void this.withdrawn.push(sessionID)
      },
    )
    const treeV1 = new CollabV1.Tree(ctx, tree)
    Effect.runSync(Effect.scoped(Collab.register(ctx, tree)))
    Effect.runSync(Effect.scoped(CollabV1.register(ctx, treeV1)))
    const call = async (name: string, input: unknown, sessionID = "ses_root") => {
      const result = await Effect.runPromise(
        tools.get(name)!.execute(input, {
          sessionID,
          agent: "build",
          messageID: "msg_call",
          id: "call_1",
          progress: () => Effect.void,
        } as unknown as Tool.Context) as Effect.Effect<Tool.Result, unknown>,
      )
      return { text: String(result.content), metadata: result.metadata as Record<string, unknown> }
    }
    return { tree, treeV1, call }
  }
}

/** What a parent's request carried: text, a tool call and its result, reasoning with provider state, an image. */
const HISTORY = [
  Message.make({ role: "user", content: "Look at the logo." }),
  Message.make({
    role: "assistant",
    content: [
      { type: "reasoning", text: "", encrypted: "gAAAA", providerMetadata: { openai: { itemId: "rs_1" } } },
      { type: "tool-call", id: "call_0", name: "exec_command", input: { cmd: "ls" } },
    ],
  }),
  Message.make({
    role: "tool",
    content: [ToolResultPart.make({ id: "call_0", name: "exec_command", result: "logo.png\n" })],
  }),
  Message.make({
    role: "user",
    content: [
      Message.media(Media.from({ type: "bytes", data: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }), {
        filename: "logo.png",
      }),
    ],
  }),
]

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

/** The parent's request as sent: developer messages, the context, then the conversation (CodexRequest.build). */
const INPUT = {
  system: [],
  messages: [
    Message.make({
      role: "system",
      content: [{ type: "text", text: "<base instructions>", providerMetadata: { "opencode.responses.inputText": {} } }],
    }),
    Message.make({ role: "system", content: "<multi_agent_role>You are `/root`.</multi_agent_role>" }),
    Message.make({ role: "user", content: "<environment_context />" }),
    ...HISTORY,
    Message.make({
      role: "assistant",
      content: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/old\nPayload:\nok",
    }),
  ],
  thread: "ses_root",
}

describe("AgentStore.Forks", () => {
  test("a history fork comes back from storage as the same messages", async () => {
    const world = new World()
    const first = world.instance()
    await Effect.runPromise(first.tree.forks.save("ses_child9" as Session.ID, { kind: "history", messages: HISTORY }))
    const restored = await Effect.runPromise(world.instance().tree.forked("ses_child9" as Session.ID))
    expect(restored?.kind).toBe("history")
    expect(restored!.messages.every((message) => Array.isArray(message.content))).toBe(true)
    expect(json(restored)).toEqual(json({ kind: "history", messages: HISTORY }))
  })

  test("a prefix fork comes back from storage as the same request", async () => {
    const world = new World()
    const fork: AgentStore.Fork = { kind: "prefix", ...INPUT }
    await Effect.runPromise(world.instance().tree.forks.save("ses_child9" as Session.ID, fork))
    const restored = await Effect.runPromise(world.instance().tree.forked("ses_child9" as Session.ID))
    expect(restored?.kind).toBe("prefix")
    expect(json(restored)).toEqual(json(fork))
  })

  // Trees stored before Codex 0.164.0 keep their shape: no migration.
  test("a fork stored as a message array reads back as a history fork", async () => {
    const world = new World()
    world.storage.set("collab-fork/ses_child9", json(HISTORY))
    const restored = await Effect.runPromise(world.instance().tree.forked("ses_child9" as Session.ID))
    expect(json(restored)).toEqual(json({ kind: "history", messages: HISTORY }))
  })

  test("a prefix over the storage cap falls back to the history fork and says so", async () => {
    const world = new World()
    const warned = spyOn(process.stderr, "write").mockImplementation(() => true)
    const huge = Message.make({ role: "user", content: "x".repeat(AgentStore.MAX_FORK_CHARS) })
    const history: AgentStore.Fork = { kind: "history", messages: HISTORY }
    await Effect.runPromise(
      world
        .instance()
        .tree.forks.save("ses_child9" as Session.ID, { kind: "prefix", ...INPUT, messages: [huge] }, history),
    )
    const logged = warned.mock.calls.map((call) => String(call[0]))
    warned.mockRestore()
    expect(logged.some((line) => line.includes("agent_fork_prefix_not_stored"))).toBe(true)
    expect(json(await Effect.runPromise(world.instance().tree.forked("ses_child9" as Session.ID)))).toEqual(
      json(history),
    )
  })

  test("a session that forked nothing has no forked history", async () => {
    const world = new World()
    expect(await Effect.runPromise(world.instance().tree.forked("ses_root" as Session.ID))).toBeUndefined()
  })

  test("a stored running status reads as interrupted", () => {
    expect(AgentStore.restored("running")).toBe("interrupted")
    expect(AgentStore.restored("pending_init")).toBe("interrupted")
    expect(AgentStore.restored({ completed: "done" })).toEqual({ completed: "done" })
  })
})

describe("multi-agent v2 tree across a restart", () => {
  test("paths, forks, statuses and FINAL_ANSWER delivery survive; other Locations stay out", async () => {
    const world = new World()
    const before = world.instance()
    before.tree.remember("ses_root" as Session.ID, HISTORY, INPUT)
    const spawned = await before.call("collaboration__spawn_agent", {
      task_name: "helper",
      message: "Read the logo.",
      fork_turns: "all",
    })
    expect(spawned.text).toBe('{"task_name":"/root/helper"}')
    const child = spawned.metadata.sessionID as Session.ID
    await Effect.runPromise(before.tree.started(child))

    // The process stops while the helper runs. A new instance starts with nothing in memory.
    const after = world.instance()
    expect(after.tree.path(child, world.sessions.get(child)!.metadata)).toBe("/root/helper")
    // The full-history fork (Codex 0.164.0): the parent's request unchanged, inter-agent messages and its role included,
    // then the spawning call completed as `aborted`.
    expect(json(await Effect.runPromise(after.tree.forked(child)))).toEqual(
      json({
        kind: "prefix",
        system: [],
        messages: [
          ...INPUT.messages,
          Message.make({
            role: "assistant",
            content: [
              ToolCallPart.make({
                id: "call_1",
                name: "collaboration__spawn_agent",
                input: { task_name: "helper", message: "Read the logo.", fork_turns: "all" },
              }),
            ],
          }),
          Message.make({
            role: "tool",
            content: [
              ToolResultPart.make({
                id: "call_1",
                name: "collaboration__spawn_agent",
                result: "aborted",
                resultType: "text",
              }),
            ],
          }),
        ],
        thread: "ses_root",
      }),
    )
    const listed = await after.call("collaboration__list_agents", {})
    expect(JSON.parse(listed.text).agents).toEqual([
      { agent_name: "/root", agent_status: "running" },
      { agent_name: "/root/helper", agent_status: "interrupted" },
    ])

    // followup_task finds the helper by path; its end wakes wait_agent with its FINAL_ANSWER.
    const followup = await after.call("collaboration__followup_task", { target: "/root/helper", message: "Go on." })
    expect(followup.metadata.success).toBe(true)
    expect(world.delivered.at(-1)).toMatchObject({ sessionID: child })
    const waiting = after.call("collaboration__wait_agent", { timeout_ms: 20_000 })
    await Bun.sleep(50)
    await Effect.runPromise(after.tree.ended(child, { completed: "The logo is a PNG." }))
    expect(JSON.parse((await waiting).text)).toEqual({ message: "Wait completed.", timed_out: false })
    expect(world.delivered.at(-1)!.sessionID).toBe("ses_root")
    expect(world.delivered.at(-1)!.text).toContain("Message Type: FINAL_ANSWER")

    // Another restart, and the helper's next turn ends before anyone used the tree: the Location's instance reads it
    // and tells the parent; an instance of another Location does not.
    const elsewhere = world.instance("/other")
    const count = world.delivered.length
    await Effect.runPromise(elsewhere.tree.ended(child, { completed: "Again." }))
    expect(world.delivered.length).toBe(count)
    const again = world.instance()
    await Effect.runPromise(again.tree.ended(child, { completed: "Again." }))
    expect(world.delivered.length).toBe(count + 1)
    expect(world.delivered.at(-1)!.text).toContain("Payload:\nAgain.")

    // Deleting the helper drops it from the stored tree.
    await Effect.runPromise(again.tree.forget(child))
    world.sessions.delete(child)
    const last = world.instance()
    expect(await Effect.runPromise(last.tree.forked(child))).toBeUndefined()
    expect(JSON.parse((await last.call("collaboration__list_agents", {})).text).agents).toEqual([
      { agent_name: "/root", agent_status: "running" },
    ])
  }, 30_000)

  test("a parent whose request was not recorded forks its history without inter-agent messages", async () => {
    const world = new World()
    const before = world.instance()
    before.tree.remember("ses_root" as Session.ID, INPUT.messages.slice(3))
    const spawned = await before.call("collaboration__spawn_agent", { task_name: "helper", message: "Read the logo." })
    const child = spawned.metadata.sessionID as Session.ID
    expect(json(await Effect.runPromise(world.instance().tree.forked(child)))).toEqual(
      json({ kind: "history", messages: HISTORY }),
    )
  })
})

describe("multi-agent v1 tree across a restart", () => {
  test("ids, nicknames, forks, closed flags and wait_agent survive", async () => {
    const world = new World()
    const before = world.instance()
    before.tree.remember("ses_root" as Session.ID, HISTORY)
    const first = JSON.parse(
      (await before.call("multi_agent_v1__spawn_agent", { message: "Read the logo.", fork_context: true })).text,
    ) as { agent_id: string; nickname: string }
    const second = JSON.parse(
      (await before.call("multi_agent_v1__spawn_agent", { message: "Count files.", fork_context: false })).text,
    ) as { agent_id: string; nickname: string }
    await before.call("multi_agent_v1__close_agent", { target: second.agent_id })
    const child = [...world.sessions.values()].find((session) => session.metadata[CollabV1.ID_KEY] === first.agent_id)!
      .id as Session.ID

    const after = world.instance()
    expect(json(await Effect.runPromise(after.tree.forked(child)))).toEqual(
      json({ kind: "history", messages: HISTORY }),
    )
    // The closed agent stays closed; the open one answers by id, and wait_agent returns when it finishes.
    const waiting = after.call("multi_agent_v1__wait_agent", { targets: [first.agent_id], timeout_ms: 20_000 })
    await Bun.sleep(50)
    await Effect.runPromise(after.treeV1.ended(child, { completed: "PNG." }))
    expect(JSON.parse((await waiting).text)).toEqual({
      status: { [first.agent_id]: { completed: "PNG." } },
      timed_out: false,
    })
    expect(world.delivered.at(-1)!.sessionID).toBe("ses_root")
    expect(world.delivered.at(-1)!.text).toContain("<subagent_notification>")
    const sent = await after.call("multi_agent_v1__send_input", {
      target: first.agent_id,
      message: "More.",
      interrupt: false,
    })
    expect(sent.metadata.success).toBe(true)
    const closed = await after.call("multi_agent_v1__send_input", { target: second.agent_id, message: "Hi." })
    expect(closed.metadata.success).toBe(false)

    // A third agent after the restart gets a nickname the stored agents do not have.
    const third = JSON.parse(
      (await after.call("multi_agent_v1__spawn_agent", { message: "Third.", fork_context: false })).text,
    ) as { nickname: string }
    expect([first.nickname, second.nickname]).not.toContain(third.nickname)
  }, 30_000)
})

describe("wait_agent with input already pending (Codex 0.164.0, #55644)", () => {
  test("steered input ends it at once before a pending message; an inter-agent message alone is the mailbox", async () => {
    const steered = new World().instance("/work", { ses_root: [{ source: Collab.SOURCE }, { source: "web" }] })
    expect(JSON.parse((await steered.call("collaboration__wait_agent", { timeout_ms: 20_000 })).text)).toEqual({
      message: "Wait interrupted by new input.",
      timed_out: false,
    })
    // An inter-agent message is no steer: it ends the wait once delivered (the mailbox), not as pending input.
    const agents = new World().instance("/work", { ses_root: [{ source: Collab.SOURCE }] })
    const waiting = agents.call("collaboration__wait_agent", { timeout_ms: 20_000 })
    expect(await Promise.race([waiting.then(() => "returned"), Bun.sleep(200).then(() => "waiting")])).toBe("waiting")
    agents.tree.input("ses_root" as Session.ID, { source: "web" })
    expect(JSON.parse((await waiting).text)).toEqual({ message: "Wait interrupted by new input.", timed_out: false })
  })
})

describe("an agent's stop of another agent's turn (Codex 0.164.0, #52640)", () => {
  test("interrupt_agent and v1 send_input with interrupt mark the stop as no user's; an idle target takes it back", async () => {
    const world = new World()
    const one = world.instance()
    const v2 = (
      await one.call("collaboration__spawn_agent", { task_name: "helper", message: "Go.", fork_turns: "none" })
    ).metadata.sessionID as Session.ID
    await one.call("collaboration__interrupt_agent", { target: "/root/helper" })
    expect(world.stops).toEqual([v2])
    expect(world.withdrawn).toEqual([])
    const v1 = JSON.parse(
      (await one.call("multi_agent_v1__spawn_agent", { message: "Count.", fork_context: false })).text,
    ).agent_id as string
    const v1Session = [...world.sessions.values()].find((session) => session.metadata[CollabV1.ID_KEY] === v1)!.id
    world.running = false
    await one.call("multi_agent_v1__send_input", { target: v1, message: "Stop.", interrupt: true })
    expect(world.stops).toEqual([v2, v1Session])
    expect(world.withdrawn).toEqual([v1Session])
  })
})

describe("agent results are background work of the recipient's turn (core P-035, 11 §7.2)", () => {
  test("v2: FINAL_ANSWER and MESSAGE carry the sender's task start; NEW_TASK starts a task, after a restart unknown", async () => {
    const world = new World()
    const one = world.instance()
    const before = Date.now()
    const spawned = await one.call("collaboration__spawn_agent", {
      task_name: "helper",
      message: "Read the logo.",
      fork_turns: "none",
    })
    const child = spawned.metadata.sessionID as Session.ID
    const task = world.delivered.at(-1)!
    expect(task.sessionID).toBe(child)
    expect(task.background).toBeUndefined()
    await one.call("collaboration__send_message", { target: "/root", message: "Half way." }, child)
    const progress = world.delivered.at(-1)!
    expect(progress).toMatchObject({ sessionID: "ses_root", resume: false, background: true })
    expect(progress.startedAt).toBeGreaterThanOrEqual(before)
    await Effect.runPromise(one.tree.ended(child, { completed: "PNG." }))
    expect(world.delivered.at(-1)).toMatchObject({
      sessionID: "ses_root",
      resume: false,
      background: true,
      startedAt: progress.startedAt,
    })
    // A new task moves the start; a restart forgets it, and the result is still background work.
    await Bun.sleep(5)
    await one.call("collaboration__followup_task", { target: "/root/helper", message: "Go on." })
    await Effect.runPromise(one.tree.ended(child, { completed: "Done." }))
    expect(world.delivered.at(-1)!.startedAt).toBeGreaterThan(progress.startedAt!)
    const after = world.instance()
    await Effect.runPromise(after.tree.ended(child, { completed: "Again." }))
    expect(world.delivered.at(-1)).toMatchObject({ sessionID: "ses_root", background: true })
    expect(world.delivered.at(-1)!.startedAt).toBeUndefined()
  })

  test("v1: <subagent_notification> carries the time input last reached the agent", async () => {
    const world = new World()
    const one = world.instance()
    const before = Date.now()
    const spawned = JSON.parse(
      (await one.call("multi_agent_v1__spawn_agent", { message: "Count files.", fork_context: false })).text,
    ) as { agent_id: string }
    const child = [...world.sessions.values()].find(
      (session) => session.metadata[CollabV1.ID_KEY] === spawned.agent_id,
    )!.id as Session.ID
    await Effect.runPromise(one.treeV1.ended(child, { completed: "12." }))
    const notice = world.delivered.at(-1)!
    expect(notice).toMatchObject({ sessionID: "ses_root", resume: false, background: true })
    expect(notice.text).toContain("<subagent_notification>")
    expect(notice.startedAt).toBeGreaterThanOrEqual(before)
    const after = world.instance()
    await Effect.runPromise(after.treeV1.ended(child, { completed: "13." }))
    expect(world.delivered.at(-1)).toMatchObject({ sessionID: "ses_root", background: true })
    expect(world.delivered.at(-1)!.startedAt).toBeUndefined()
  })
})

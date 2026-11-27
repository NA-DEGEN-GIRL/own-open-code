import { describe, expect, test } from "bun:test"
import CAPTURE from "../../../codex-data/code-mode.win32.json" with { type: "json" }
import { CodexAgents } from "../../../src/codex/agents/index.js"
import { Catalog } from "../../../src/codex/catalog.js"

const ROOT_ID = "019a0000-0000-7000-8000-000000000001"

/** Keeps the tree in memory: statuses, mailboxes of delivered messages, and the calls the handlers made. */
class FakeHost implements CodexAgents.Host {
  readonly agents = new Map<string, CodexAgents.Agent>([["/root", { id: ROOT_ID, path: "/root", status: "running" }]])
  readonly mailboxes = new Map<string, Array<CodexAgents.Communication>>()
  readonly spawns: Array<CodexAgents.SpawnRequest> = []
  readonly interrupts: Array<string> = []
  readonly waits: Array<number> = []
  rejection: string | undefined

  async list() {
    return [...this.agents.values()]
  }

  async prepareSpawn(_caller: CodexAgents.Agent, overrides: CodexAgents.SpawnOverrides) {
    if (overrides.model === "gpt-nope") return CodexAgents.unknownModel("gpt-nope", ["gpt-6.1-sol", "gpt-6-sol"])
    return this.rejection
  }

  async spawn(request: CodexAgents.SpawnRequest) {
    this.spawns.push(request)
    const agent: CodexAgents.Agent = { id: `id-${this.agents.size}`, path: request.path, status: "running" }
    this.agents.set(request.path, agent)
    this.deliver(request.communication)
    return agent
  }

  async followup(target: CodexAgents.Agent, communication: CodexAgents.Communication) {
    this.deliver(communication)
    this.agents.set(target.path, { ...target, status: "running" })
  }

  async send(_target: CodexAgents.Agent, communication: CodexAgents.Communication) {
    this.deliver(communication)
  }

  async interrupt(target: CodexAgents.Agent) {
    this.interrupts.push(target.path)
    if (target.status === "running") this.agents.set(target.path, { ...target, status: "interrupted" })
  }

  async wait(caller: CodexAgents.Agent, timeoutMs: number): Promise<CodexAgents.WaitOutcome> {
    this.waits.push(timeoutMs)
    return (this.mailboxes.get(caller.path)?.length ?? 0) > 0 ? "mailbox" : "timed_out"
  }

  /** The child's turn ended: record its status and send the parent Codex's notification. */
  finish(path: string, status: CodexAgents.AgentStatus) {
    const agent = this.agents.get(path)!
    this.agents.set(path, { ...agent, status })
    const message = CodexAgents.completion(path, status)
    if (message !== undefined) this.deliver(message)
  }

  take(path: string) {
    const messages = this.mailboxes.get(path) ?? []
    this.mailboxes.delete(path)
    return messages
  }

  private deliver(communication: CodexAgents.Communication) {
    this.mailboxes.set(communication.recipient, [...(this.mailboxes.get(communication.recipient) ?? []), communication])
  }
}

const call = (
  host: FakeHost,
  tool: CodexAgents.ToolName,
  args: unknown,
  caller = "/root",
  config?: CodexAgents.Config,
) => CodexAgents.handle(tool, typeof args === "string" ? args : JSON.stringify(args), { host, caller, config })

const failure = (text: string) => ({ text, success: false })

describe("CodexAgents", () => {
  test("spawn, wait, and the child's final answer delivered to the parent", async () => {
    const host = new FakeHost()
    expect(await call(host, "spawn_agent", { task_name: "worker", message: "Count the files." })).toEqual({
      text: '{"task_name":"/root/worker"}',
      success: true,
    })
    expect(host.spawns[0]).toMatchObject({ path: "/root/worker", fork: "all", parent: { path: "/root" } })
    expect(host.take("/root/worker")).toEqual([
      {
        author: "/root",
        recipient: "/root/worker",
        content: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nCount the files.",
        triggerTurn: true,
      },
    ])

    expect(await call(host, "wait_agent", { timeout_ms: 1000 })).toEqual({
      text: JSON.stringify({
        message: "Wait timed out.\n\nRequested timeout of 1000ms was clamped to the minimum of 10000ms.",
        timed_out: true,
      }),
      success: undefined,
    })

    host.finish("/root/worker", { completed: "There are 3 files." })
    expect(await call(host, "wait_agent", {})).toEqual({
      text: '{"message":"Wait completed.","timed_out":false}',
      success: undefined,
    })
    expect(host.waits).toEqual([10_000, 30_000])
    const [answer] = host.take("/root")
    expect(answer).toEqual({
      author: "/root/worker",
      recipient: "/root",
      content: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nThere are 3 files.",
      triggerTurn: false,
    })
    expect(CodexAgents.agentMessageItem(answer!)).toEqual({
      type: "agent_message",
      author: "/root/worker",
      recipient: "/root",
      content: [{ type: "input_text", text: answer!.content }],
    })
  })

  test("followup_task starts a NEW_TASK turn; send_message queues a MESSAGE", async () => {
    const host = new FakeHost()
    await call(host, "spawn_agent", { task_name: "worker", message: "first", fork_turns: "none" })
    expect(host.spawns[0]!.fork).toBe("none")
    host.take("/root/worker")
    host.finish("/root/worker", { completed: null })
    expect(host.take("/root")[0]!.content).toBe(
      "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\n",
    )

    expect(await call(host, "followup_task", { target: "worker", message: "second" })).toEqual({
      text: "",
      success: true,
    })
    expect(host.agents.get("/root/worker")!.status).toBe("running")
    expect(await call(host, "send_message", { target: "id-1", message: "note" })).toEqual({ text: "", success: true })
    expect(host.take("/root/worker").map((message) => [message.content, message.triggerTurn])).toEqual([
      ["Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nsecond", true],
      ["Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nnote", false],
    ])

    expect(await call(host, "send_message", { target: "/root", message: "progress" }, "/root/worker")).toEqual({
      text: "",
      success: true,
    })
    expect(host.take("/root")[0]!.content).toBe(
      "Message Type: MESSAGE\nTask name: /root\nSender: /root/worker\nPayload:\nprogress",
    )
    expect(await call(host, "followup_task", { target: "/root", message: "x" }, "/root/worker")).toEqual(
      failure("Follow-up tasks can't target the root agent"),
    )
    expect(await call(host, "send_message", { target: "worker", message: "  \n" })).toEqual(
      failure("Empty message can't be sent to an agent"),
    )
  })

  test("interrupt_agent returns the previous status and refuses the root and the caller", async () => {
    const host = new FakeHost()
    await call(host, "spawn_agent", { task_name: "worker", message: "go" })
    expect(await call(host, "interrupt_agent", { target: "worker" })).toEqual({
      text: '{"previous_status":"running"}',
      success: true,
    })
    expect(host.interrupts).toEqual(["/root/worker"])
    expect(host.agents.get("/root/worker")!.status).toBe("interrupted")
    expect(await call(host, "interrupt_agent", { target: "/root/worker" })).toEqual({
      text: '{"previous_status":"interrupted"}',
      success: true,
    })
    expect(await call(host, "interrupt_agent", { target: ROOT_ID })).toEqual(failure("root is not a spawned agent"))
    expect(await call(host, "interrupt_agent", { target: "/root/worker" }, "/root/worker")).toEqual(
      failure("an agent cannot interrupt itself; return your result and let the parent interrupt you if needed"),
    )
    // An interrupted turn does not notify the parent.
    expect(CodexAgents.completion("/root/worker", "interrupted")).toBeUndefined()
  })

  test("list_agents lists the tree with Codex's statuses, optionally under a prefix", async () => {
    const host = new FakeHost()
    await call(host, "spawn_agent", { task_name: "researcher", message: "a" })
    await call(host, "spawn_agent", { task_name: "worker", message: "b" }, "/root/researcher")
    await call(host, "spawn_agent", { task_name: "alpha", message: "c" })
    host.finish("/root/alpha", { completed: "done" })
    host.finish("/root/researcher/worker", { errored: "boom" })
    expect(JSON.parse((await call(host, "list_agents", {})).text)).toEqual({
      agents: [
        { agent_name: "/root", agent_status: "running" },
        { agent_name: "/root/alpha", agent_status: { completed: "done" } },
        { agent_name: "/root/researcher", agent_status: "running" },
        { agent_name: "/root/researcher/worker", agent_status: { errored: "boom" } },
      ],
    })
    expect(await call(host, "list_agents", { path_prefix: "worker" }, "/root/researcher")).toEqual({
      text: '{"agents":[{"agent_name":"/root/researcher/worker","agent_status":{"errored":"boom"}}]}',
      success: true,
    })
    expect(await call(host, "list_agents", { path_prefix: "Bad" })).toEqual(
      failure("agent_name must use only lowercase letters, digits, and underscores"),
    )
    expect(host.take("/root/researcher").at(-1)!.content).toBe(
      "Message Type: FINAL_ANSWER\nTask name: /root/researcher\nSender: /root/researcher/worker\nPayload:\nAgent errored: boom\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
    )
  })

  test("spawned agents may run max_concurrent_threads_per_session - 1 turns at once", async () => {
    const host = new FakeHost()
    const spawn = (name: string) => call(host, "spawn_agent", { task_name: name, message: "go" })
    expect((await spawn("a")).success).toBe(true)
    expect((await spawn("b")).success).toBe(true)
    expect((await spawn("c")).success).toBe(true)
    expect(await spawn("d")).toEqual(failure("collab spawn failed: agent thread limit reached"))
    host.finish("/root/a", { completed: "ok" })
    expect(
      await call(host, "followup_task", { target: "a", message: "again" }, "/root", {
        ...CodexAgents.DEFAULT_CONFIG,
        maxConcurrentThreadsPerSession: 3,
      }),
    ).toEqual(failure("collab tool failed: agent thread limit reached"))
    // A running target takes the task without a new slot.
    expect((await call(host, "followup_task", { target: "b", message: "more" })).success).toBe(true)
    expect((await spawn("d")).success).toBe(true)
    expect(CodexAgents.roleText({ slots: 4 })).toContain("There are 4 available concurrency slots")
  })

  test("invalid arguments answer with Codex's texts", async () => {
    const host = new FakeHost()
    await call(host, "spawn_agent", { task_name: "worker", message: "go" })
    const cases: ReadonlyArray<readonly [CodexAgents.ToolName, unknown, string]> = [
      [
        "spawn_agent",
        '{"message":"m"}',
        "failed to parse function arguments: missing field `task_name` at line 1 column 15",
      ],
      [
        "spawn_agent",
        { message: "m", task_name: "t", items: [] },
        "failed to parse function arguments: unknown field `items`, expected one of `message`, `task_name`, `agent_type`, `model`, `reasoning_effort`, `fork_turns`, `fork_context` at line 1 column 38",
      ],
      [
        "spawn_agent",
        { message: "m", task_name: "t", fork_context: true },
        "fork_context is not supported in MultiAgentV2; use fork_turns instead",
      ],
      ["spawn_agent", { message: "m", task_name: "t", fork_turns: "banana" }, "fork_turns must be `none` or `all`"],
      ["spawn_agent", { message: "m", task_name: "t", fork_turns: "0" }, "fork_turns must be `none` or `all`"],
      ["spawn_agent", { message: " ", task_name: "t" }, "Empty message can't be sent to an agent"],
      [
        "spawn_agent",
        { message: "m", task_name: "Bad-Name" },
        "agent_name must use only lowercase letters, digits, and underscores",
      ],
      ["spawn_agent", { message: "m", task_name: "root" }, "agent_name `root` is reserved"],
      ["spawn_agent", { message: "m", task_name: "worker" }, "agent path `/root/worker` already exists"],
      [
        "spawn_agent",
        { message: "m", task_name: "t", model: "gpt-nope" },
        "Unknown model `gpt-nope` for spawn_agent. Available models: gpt-6.1-sol, gpt-6-sol",
      ],
      [
        "spawn_agent",
        { message: "m", task_name: "t", reasoning_effort: "" },
        "failed to parse function arguments: reasoning_effort must not be empty at line 1 column 53",
      ],
      [
        "send_message",
        { target: "w", message: "m", interrupt: true },
        "failed to parse function arguments: unknown field `interrupt`, expected `target` or `message` at line 1 column 39",
      ],
      ["send_message", { target: "nobody", message: "m" }, "live agent path `/root/nobody` not found"],
      ["send_message", { target: "", message: "m" }, "agent path must not be empty"],
      [
        "send_message",
        { target: "019a0000-0000-7000-8000-00000000ABCD", message: "m" },
        "agent with id 019a0000-0000-7000-8000-00000000abcd not found",
      ],
      [
        "followup_task",
        { target: 5, message: "m" },
        "failed to parse function arguments: invalid type: integer `5`, expected a string at line 1 column 11",
      ],
      ["wait_agent", { timeout_ms: 3_600_001 }, "timeout_ms must be at most 3600000"],
      [
        "wait_agent",
        { timeout_ms: 1.5 },
        "failed to parse function arguments: invalid type: floating point `1.5`, expected i64 at line 1 column 17",
      ],
      [
        "wait_agent",
        { targets: ["w"] },
        "failed to parse function arguments: unknown field `targets`, expected `timeout_ms` at line 1 column 10",
      ],
      ["interrupt_agent", "", "failed to parse function arguments: EOF while parsing a value at line 1 column 0"],
      [
        "list_agents",
        "[]",
        "failed to parse function arguments: invalid length 0, expected struct ListAgentsArgs with 1 element at line 1 column 2",
      ],
    ]
    const answers = await Promise.all(cases.map(([tool, args]) => call(host, tool, args)))
    expect(answers).toEqual(cases.map(([, , text]) => failure(text)))
    expect((await call(host, "spawn_agent", { message: "m", task_name: "t2", fork_turns: " 3 " })).success).toBe(true)
    expect(host.spawns.at(-1)!.fork).toBe("all")
  })

  test("role and mode texts equal the ones Codex sent", () => {
    expect(CodexAgents.roleText({ path: "/root", slots: 4 })).toBe(CAPTURE.multiAgentRole)
    expect(CodexAgents.roleText({ path: "/root", slots: 4, model: Catalog.lookup("gpt-6-sol") })).toBe(
      CAPTURE.multiAgentRole,
    )
    expect(CodexAgents.modeText({ effort: "high" })).toBe(CAPTURE.multiAgentMode)
    expect(CodexAgents.modeText({ effort: "ultra" })).toBe(
      `<multi_agent_mode>${CodexAgents.PROACTIVE_MODE}</multi_agent_mode>`,
    )
    expect(CodexAgents.modeText({ configured: "" })).toBeUndefined()

    const subagent = CodexAgents.roleText({ path: "/root/worker", slots: 4 })!
    expect(
      subagent.startsWith("<multi_agent_role>You are an agent in a team of agents collaborating to complete a task."),
    ).toBe(true)
    expect(subagent).toContain("In addition, your final answer may be read by a human, so ensure it is legible.\n")
    expect(subagent.endsWith('set `fork_turns` to `"none"`.</multi_agent_role>')).toBe(true)

    // A V2 model without catalog role texts gets Codex's bundled text, unwrapped.
    const bundled = CodexAgents.roleText({ path: "/root", slots: 2, model: Catalog.lookup("gpt-5.6-sol") })!
    expect(bundled.startsWith(CodexAgents.ROOT_ROLE)).toBe(true)
    expect(bundled).toContain(
      "There are 2 available concurrency slots, meaning that up to 2 agents can be active at once, including you.",
    )
    expect(bundled).not.toContain("<multi_agent_role>")
    expect(CodexAgents.roleText({ configured: "" })).toBeUndefined()
  })

  test("the environment lists direct children", () => {
    const agents = ["/root", "/root/b", "/root/a", "/root/a/deep"].map((path) => ({
      id: path,
      path,
      status: "running" as const,
    }))
    expect(CodexAgents.environmentSubagents(agents, "/root")).toBe(
      '  <subagents>\n    <agent name="/root/a" />\n    <agent name="/root/b" />\n  </subagents>\n',
    )
    expect(CodexAgents.environmentSubagents(agents, "/root/b")).toBeUndefined()
  })
})

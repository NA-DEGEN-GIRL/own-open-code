import { describe, expect, test } from "bun:test"
import GOLDEN from "../../golden/codex/exec-unknown-model.json" with { type: "json" }
import { CodexAgents } from "../../../src/codex/agents/index.js"
import { CodexAgentsV1 } from "../../../src/codex/agents/v1.js"

const CHILD = "019a0000-0000-7000-8000-00000000000a"
const OTHER = "019a0000-0000-7000-8000-00000000000b"
const UNKNOWN = "019a0000-0000-7000-8000-0000000000ff"

/** Keeps the session's agents in memory and records what the handlers asked for. */
class FakeHost implements CodexAgentsV1.Host {
  readonly agents = new Map<string, CodexAgentsV1.Agent>()
  readonly closed = new Map<string, CodexAgentsV1.Agent>()
  readonly calls: Array<string> = []
  readonly spawns: Array<CodexAgentsV1.SpawnRequest> = []
  readonly inputs: Array<ReadonlyArray<unknown>> = []
  readonly waits: Array<number> = []
  readonly nicknames = new CodexAgentsV1.NicknamePool(CodexAgentsV1.NICKNAMES, () => 0)
  rejection: string | undefined
  /** What `wait` resolves to when no target is final yet. */
  settles: ReadonlyArray<readonly [string, CodexAgentsV1.AgentStatus]> = []

  add(id: string, status: CodexAgentsV1.AgentStatus) {
    this.agents.set(id, { id, status, nickname: this.nicknames.reserve() })
  }

  async list() {
    return [...this.agents.values()]
  }

  async prepareSpawn(overrides: CodexAgentsV1.SpawnOverrides) {
    if (overrides.model === "gpt-nope") return CodexAgents.unknownModel("gpt-nope", ["gpt-5.5", "gpt-5.4"])
    return this.rejection
  }

  async spawn(request: CodexAgentsV1.SpawnRequest) {
    this.spawns.push(request)
    const id = `019a0000-0000-7000-8000-${String(this.spawns.length).padStart(12, "0")}`
    const agent = { id, status: "pending_init" as const, nickname: this.nicknames.reserve() }
    this.agents.set(id, agent)
    return agent
  }

  async sendInput(id: string, input: ReadonlyArray<unknown>) {
    this.calls.push(`send ${id}`)
    if (!this.agents.has(id)) throw new CodexAgents.AgentError(CodexAgentsV1.notFound(id))
    this.inputs.push(input)
    return "019a0000-0000-7000-8000-0000000000aa"
  }

  async interrupt(id: string) {
    this.calls.push(`interrupt ${id}`)
    if (!this.agents.has(id)) throw new CodexAgents.AgentError(CodexAgentsV1.notFound(id))
  }

  async resume(id: string, depth: number) {
    this.calls.push(`resume ${id} at ${depth}`)
    const open = this.agents.get(id)
    if (open !== undefined) return open.status
    const closed = this.closed.get(id)
    if (closed === undefined) throw new CodexAgents.AgentError(CodexAgentsV1.notFound(id))
    if (this.agents.size >= CodexAgentsV1.DEFAULT_MAX_THREADS)
      throw new CodexAgents.AgentError(CodexAgentsV1.THREAD_LIMIT_TOOL)
    this.agents.set(id, { ...closed, status: "pending_init" })
    return "pending_init" as const
  }

  async close(id: string) {
    const agent = this.agents.get(id)
    if (agent === undefined) throw new CodexAgents.AgentError(CodexAgentsV1.notFound(id))
    this.agents.delete(id)
    this.closed.set(id, { ...agent, status: "shutdown" })
    return agent.status
  }

  async status(id: string) {
    return this.agents.get(id)?.status ?? "not_found"
  }

  async wait(ids: ReadonlyArray<string>, timeoutMs: number) {
    this.calls.push(`wait ${ids.join(",")}`)
    this.waits.push(timeoutMs)
    return this.settles
  }
}

function call(host: FakeHost, tool: CodexAgentsV1.ToolName, args: unknown, depth = 0) {
  return CodexAgentsV1.handle(tool, typeof args === "string" ? args : JSON.stringify(args), { host, depth })
}

function failed(text: string) {
  return { text, success: false }
}

describe("the multi_agent_v1 namespace", () => {
  test("is the captured definition, deferred in registration order", () => {
    const captured = GOLDEN.requests[0]!.body.tools.find((tool) => tool.name === "multi_agent_v1")
    expect(JSON.stringify(CodexAgentsV1.DEFINITION)).toBe(JSON.stringify(captured))
    expect(CodexAgentsV1.DEFINITION.description).toBe("Tools for spawning and managing sub-agents.")
    const entries = CodexAgentsV1.searchEntries()
    expect(entries.map((entry) => entry.tool.name)).toEqual([...CodexAgentsV1.TOOL_NAMES])
    expect(entries.every((entry) => entry.source === CodexAgentsV1.SEARCH_SOURCE)).toBe(true)
    expect(entries[0]!.namespace).toEqual({ name: "multi_agent_v1", description: CodexAgentsV1.NAMESPACE_DESCRIPTION })
  })
})

describe("spawn_agent", () => {
  test("spawns with the message and answers the id and nickname", async () => {
    const host = new FakeHost()
    const output = await call(host, "spawn_agent", {
      message: "inspect the repo",
      agent_type: "  explorer ",
      model: "gpt-5.5",
      reasoning_effort: "high",
    })
    expect(output).toEqual({
      text: '{"agent_id":"019a0000-0000-7000-8000-000000000001","nickname":"Euclid"}',
      success: true,
    })
    expect(host.spawns).toEqual([
      {
        forkContext: false,
        model: "gpt-5.5",
        reasoningEffort: "high",
        agentType: "explorer",
        input: [{ type: "text", text: "inspect the repo" }],
        depth: 1,
      },
    ])
  })

  test("passes structured items and full-history forks", async () => {
    const host = new FakeHost()
    await call(host, "spawn_agent", {
      items: [
        { type: "mention", name: "drive", path: "app://google_drive" },
        { type: "text", text: "read the folder", text_elements: [] },
        { type: "image", image_url: "data:image/png;base64,AA", detail: "low" },
        { type: "local_image", path: "C:\\shot.png" },
        { type: "skill", name: "lint", path: "/skills/lint/SKILL.md", extra: 1 },
      ],
      fork_context: true,
    })
    expect(host.spawns[0]!.forkContext).toBe(true)
    expect(host.spawns[0]!.input).toEqual([
      { type: "mention", name: "drive", path: "app://google_drive" },
      { type: "text", text: "read the folder" },
      { type: "image", image_url: "data:image/png;base64,AA", detail: "low" },
      { type: "local_image", path: "C:\\shot.png" },
      { type: "skill", name: "lint", path: "/skills/lint/SKILL.md" },
    ])
  })

  test("requires exactly one non-empty input", async () => {
    const host = new FakeHost()
    expect(await call(host, "spawn_agent", {})).toEqual(failed("Provide one of: message or items"))
    expect(await call(host, "spawn_agent", { message: " \n " })).toEqual(
      failed("Empty message can't be sent to an agent"),
    )
    expect(await call(host, "spawn_agent", { items: [] })).toEqual(failed("Items can't be empty"))
    expect(await call(host, "spawn_agent", { message: "", items: [{ type: "text", text: "x" }] })).toEqual(
      failed("Provide either message or items, but not both"),
    )
    expect(await call(host, "spawn_agent", { message: null, items: null })).toEqual(
      failed("Provide one of: message or items"),
    )
    expect(host.spawns).toEqual([])
  })

  test("enforces the spawn depth before validating overrides", async () => {
    const host = new FakeHost()
    expect(await call(host, "spawn_agent", { message: "go", model: "gpt-nope" }, 1)).toEqual(
      failed("Agent depth limit reached. Solve the task yourself."),
    )
    expect(await call(host, "spawn_agent", { message: "go", agent_type: "explorer", fork_context: true })).toEqual(
      failed(
        "Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork.",
      ),
    )
    expect(await call(host, "spawn_agent", { message: "go", agent_type: " ", fork_context: true })).toMatchObject({
      success: true,
    })
    expect(await call(host, "spawn_agent", { message: "go", model: "gpt-nope" })).toEqual(
      failed("Unknown model `gpt-nope` for spawn_agent. Available models: gpt-5.5, gpt-5.4"),
    )
  })

  test("counts every open agent of the session against the thread limit", async () => {
    const host = new FakeHost()
    Array.from({ length: 5 }, (_, index) =>
      host.add(`019a0000-0000-7000-8000-1000000000${index}0`, { completed: null }),
    )
    expect(await call(host, "spawn_agent", { message: "sixth" })).toMatchObject({ success: true })
    expect(await call(host, "spawn_agent", { message: "seventh" })).toEqual(
      failed("collab spawn failed: agent thread limit reached"),
    )
    const limited = await CodexAgentsV1.handle("spawn_agent", '{"message":"x"}', {
      host,
      depth: 0,
      config: { maxThreads: 8, maxDepth: 2 },
    })
    expect(limited.success).toBe(true)
  })

  test("decodes arguments like serde: unknown keys ignored, Codex's error texts", async () => {
    const host = new FakeHost()
    expect(await call(host, "spawn_agent", '{"message":"go","fork_turns":"all","task_name":7}')).toMatchObject({
      success: true,
    })
    expect(await call(host, "spawn_agent", '{"message": 5}')).toEqual(
      failed("failed to parse function arguments: invalid type: integer `5`, expected a string at line 1 column 13"),
    )
    expect(await call(host, "spawn_agent", '{"message":"go","fork_context":null}')).toEqual(
      failed("failed to parse function arguments: invalid type: null, expected a boolean at line 1 column 35"),
    )
    expect(await call(host, "spawn_agent", '{"message":"go","x":[1,}')).toEqual(
      failed("failed to parse function arguments: expected value at line 1 column 24"),
    )
    expect(await call(host, "spawn_agent", '{"message":"go","message":"again"}')).toEqual(
      failed("failed to parse function arguments: duplicate field `message` at line 1 column 25"),
    )
    expect(await call(host, "spawn_agent", '["go"]')).toEqual(
      failed(
        "failed to parse function arguments: invalid length 1, expected struct SpawnAgentArgs with 6 elements at line 1 column 6",
      ),
    )
  })

  test("decodes items as Codex's internally tagged UserInput", async () => {
    const host = new FakeHost()
    const error = async (items: string) => (await call(host, "spawn_agent", `{"items":${items}}`)).text
    expect(await error('[{"type":"bogus"}]')).toBe(
      "failed to parse function arguments: unknown variant `bogus`, expected one of `text`, `image`, `local_image`, `audio`, `local_audio`, `skill`, `mention` at line 1 column 25",
    )
    expect(await error('[{"text":"hi"}]')).toBe(
      "failed to parse function arguments: missing field `type` at line 1 column 23",
    )
    expect(await error('[{"type":"text"}]')).toBe(
      "failed to parse function arguments: missing field `text` at line 1 column 26",
    )
    expect(await error('[{"type":"text","text":1}]')).toBe(
      "failed to parse function arguments: invalid type: integer `1`, expected a string at line 1 column 35",
    )
    expect(await error('[{"type":"local_image","path":null}]')).toBe(
      "failed to parse function arguments: invalid type: null, expected path string at line 1 column 45",
    )
    expect(await error('[{"type":"image"}]')).toBe(
      "failed to parse function arguments: data did not match any variant of untagged enum ImageReference at line 1 column 27",
    )
    expect(await error('["hi"]')).toBe(
      'failed to parse function arguments: invalid type: string "hi", expected internally tagged enum UserInput at line 1 column 14',
    )
    expect(await error('{"type":"text"}')).toBe(
      "failed to parse function arguments: invalid type: map, expected a sequence at line 1 column 9",
    )
  })
})

describe("send_input", () => {
  test("answers the submission id, interrupting first when asked", async () => {
    const host = new FakeHost()
    host.add(CHILD, "running")
    expect(
      await call(host, "send_input", { target: CHILD.toUpperCase(), message: "redirect", interrupt: true }),
    ).toEqual({
      text: '{"submission_id":"019a0000-0000-7000-8000-0000000000aa"}',
      success: true,
    })
    expect(host.calls).toEqual([`interrupt ${CHILD}`, `send ${CHILD}`])
    expect(host.inputs).toEqual([[{ type: "text", text: "redirect" }]])
  })

  test("rejects malformed ids, bad input and unknown agents", async () => {
    const host = new FakeHost()
    expect(await call(host, "send_input", { target: "not-a-uuid", message: "hi" })).toEqual(
      failed("invalid agent id not-a-uuid: Error(ParseChar { character: 'n', index: 1 })"),
    )
    expect(await call(host, "send_input", { target: CHILD, message: "" })).toEqual(
      failed("Empty message can't be sent to an agent"),
    )
    expect(await call(host, "send_input", { target: UNKNOWN, message: "hi", interrupt: true })).toEqual(
      failed(`agent with id ${UNKNOWN} not found`),
    )
    expect(await call(host, "send_input", { message: "hi" })).toEqual(
      failed("failed to parse function arguments: missing field `target` at line 1 column 16"),
    )
    expect(host.calls).toEqual([`interrupt ${UNKNOWN}`])
  })
})

describe("resume_agent", () => {
  test("reopens a closed agent and answers its status", async () => {
    const host = new FakeHost()
    host.add(CHILD, "running")
    expect(await call(host, "resume_agent", { id: CHILD })).toEqual({ text: '{"status":"running"}', success: true })
    await call(host, "close_agent", { target: CHILD })
    expect(await call(host, "resume_agent", { id: `{${CHILD}}` })).toEqual({
      text: '{"status":"pending_init"}',
      success: true,
    })
    expect(host.calls).toEqual([`resume ${CHILD} at 1`, `resume ${CHILD} at 1`])
  })

  test("rejects bad ids, unknown agents and the depth limit", async () => {
    const host = new FakeHost()
    expect(await call(host, "resume_agent", { id: "not-a-uuid" })).toMatchObject({
      text: "invalid agent id not-a-uuid: Error(ParseChar { character: 'n', index: 1 })",
    })
    expect(await call(host, "resume_agent", { id: UNKNOWN })).toEqual(failed(`agent with id ${UNKNOWN} not found`))
    expect(await call(host, "resume_agent", { id: CHILD }, 1)).toEqual(
      failed("Agent depth limit reached. Solve the task yourself."),
    )
  })
})

describe("wait_agent", () => {
  test("answers final statuses at once, without waiting", async () => {
    const host = new FakeHost()
    host.add(CHILD, { completed: "done" })
    host.add(OTHER, "running")
    expect(await call(host, "wait_agent", { targets: [OTHER, CHILD, UNKNOWN] })).toEqual({
      text: `{"status":{"${CHILD}":{"completed":"done"},"${UNKNOWN}":"not_found"},"timed_out":false}`,
      success: undefined,
    })
    expect(host.waits).toEqual([])
  })

  test("waits for the first final status, or times out with an empty status", async () => {
    const host = new FakeHost()
    host.add(CHILD, "running")
    host.add(OTHER, "pending_init")
    host.settles = [[OTHER, { errored: "boom" }]]
    expect(await call(host, "wait_agent", { targets: [CHILD, OTHER], timeout_ms: 120_000 })).toEqual({
      text: `{"status":{"${OTHER}":{"errored":"boom"}},"timed_out":false}`,
      success: undefined,
    })
    host.settles = []
    expect(await call(host, "wait_agent", { targets: [CHILD] })).toEqual({
      text: '{"status":{},"timed_out":true}',
      success: undefined,
    })
    expect(host.calls).toEqual([`wait ${CHILD},${OTHER}`, `wait ${CHILD}`])
  })

  test("clamps the timeout to 10 s .. 1 h, defaulting to 30 s", async () => {
    const host = new FakeHost()
    host.add(CHILD, "running")
    await call(host, "wait_agent", { targets: [CHILD], timeout_ms: 10 })
    await call(host, "wait_agent", { targets: [CHILD], timeout_ms: 99_999_999_999 })
    await call(host, "wait_agent", { targets: [CHILD] })
    expect(host.waits).toEqual([10_000, 3_600_000, 30_000])
  })

  test("rejects empty targets, bad ids and non-positive timeouts", async () => {
    const host = new FakeHost()
    expect(await call(host, "wait_agent", {})).toEqual(failed("agent ids must be non-empty"))
    expect(await call(host, "wait_agent", { targets: [] })).toEqual(failed("agent ids must be non-empty"))
    expect(await call(host, "wait_agent", { targets: ["invalid"] })).toEqual(
      failed("invalid agent id invalid: Error(ParseChar { character: 'i', index: 1 })"),
    )
    expect(await call(host, "wait_agent", { targets: [CHILD], timeout_ms: 0 })).toEqual(
      failed("timeout_ms must be greater than zero"),
    )
    expect(await call(host, "wait_agent", { targets: [CHILD], timeout_ms: -5 })).toEqual(
      failed("timeout_ms must be greater than zero"),
    )
    expect(await call(host, "wait_agent", { targets: "x" })).toEqual(
      failed('failed to parse function arguments: invalid type: string "x", expected a sequence at line 1 column 14'),
    )
    expect(await call(host, "wait_agent", { targets: [1] })).toEqual(
      failed("failed to parse function arguments: invalid type: integer `1`, expected a string at line 1 column 13"),
    )
  })
})

describe("close_agent", () => {
  test("answers the status before the shutdown", async () => {
    const host = new FakeHost()
    host.add(CHILD, { completed: null })
    expect(await call(host, "close_agent", { target: CHILD })).toEqual({
      text: '{"previous_status":{"completed":null}}',
      success: true,
    })
    expect(await call(host, "close_agent", { target: CHILD })).toEqual(failed(`agent with id ${CHILD} not found`))
  })
})

describe("agent ids", () => {
  test("accept uuid's four forms and print them hyphenated in lowercase", () => {
    const canonical = "67e55044-10b1-426f-9247-bb680e5fe0c8"
    expect(
      [canonical, "67E5504410B1426F9247BB680E5FE0C8", `urn:uuid:${canonical}`, `{${canonical.toUpperCase()}}`].map(
        CodexAgentsV1.parseThreadId,
      ),
    ).toEqual([canonical, canonical, canonical, canonical])
  })

  test("report uuid's errors in Debug form (uuid 1.20 parser tests)", () => {
    const cases: Record<string, string> = {
      "": "ParseSimpleLength { len: 0 }",
      "!": "ParseChar { character: '!', index: 1 }",
      "F9168C5E-CEB2-4faa-B6BF-329BF39FA1E45": "ParseGroupLength { group: 4, len: 13, index: 25 }",
      "F9168C5E-CEB2-4faa-BBF-329BF39FA1E4": "ParseGroupLength { group: 3, len: 3, index: 20 }",
      "F9168C5E-CEB2-4faa-BGBF-329BF39FA1E4": "ParseChar { character: 'G', index: 21 }",
      "F9168C5E-CEB2F4faaFB6BFF329BF39FA1E4": "ParseGroupCount { count: 2 }",
      "{F9168C5E-CEB2-4faa9B6BFF329BF39FA1E41": "ParseChar { character: '{', index: 1 }",
      "{F9168C5E-CEB2-4faa9B6BFF329BF39FA1E41}": "ParseGroupCount { count: 3 }",
      "F9168C5E-CEB-24fa-eB6BFF32-BF39FA1E4": "ParseGroupLength { group: 1, len: 3, index: 10 }",
      "01020304-1112-2122-3132-41424344": "ParseGroupLength { group: 4, len: 8, index: 25 }",
      "67e5504410b1426f9247bb680e5fe0c": "ParseSimpleLength { len: 31 }",
      "67e5504410b1426%9247bb680e5fe0c8": "ParseChar { character: '%', index: 16 }",
      "231231212212423424324323477343246663": "ParseSimpleLength { len: 36 }",
      "{00000000000000000000000000000000}": "ParseGroupCount { count: 1 }",
      "\u{bcf3c}": "ParseChar { character: '\\u{bcf3c}', index: 1 }",
    }
    expect(Object.fromEntries(Object.keys(cases).map((input) => [input, CodexAgentsV1.parseThreadId(input)]))).toEqual(
      Object.fromEntries(Object.entries(cases).map(([input, error]) => [input, { error: `Error(${error})` }])),
    )
  })
})

describe("the parent's notification", () => {
  test("is sent for final statuses only", () => {
    expect(CodexAgentsV1.notification(CHILD, { completed: "all done" })).toBe(
      `<subagent_notification>\n{"agent_path":"${CHILD}","status":{"completed":"all done"}}\n</subagent_notification>`,
    )
    expect(CodexAgentsV1.notification(CHILD, "shutdown")).toBe(
      `<subagent_notification>\n{"agent_path":"${CHILD}","status":"shutdown"}\n</subagent_notification>`,
    )
    expect(CodexAgentsV1.notification(CHILD, "running")).toBeUndefined()
    expect(CodexAgentsV1.notification(CHILD, "interrupted")).toBeUndefined()
    expect(CodexAgentsV1.notification(CHILD, "pending_init")).toBeUndefined()
  })
})

describe("nicknames", () => {
  test("draw unused names, then restart the pool with ordinals", () => {
    const pool = new CodexAgentsV1.NicknamePool(["Euclid", "Kepler"], () => 0)
    expect([pool.reserve(), pool.reserve(), pool.reserve(), pool.reserve(), pool.reserve("Hypatia")]).toEqual([
      "Euclid",
      "Kepler",
      "Euclid the 2nd",
      "Kepler the 2nd",
      "Hypatia",
    ])
    expect(new CodexAgentsV1.NicknamePool([]).reserve()).toBeUndefined()
    expect(CodexAgentsV1.NICKNAMES).toHaveLength(101)
  })

  test("format ordinals like Codex", () => {
    expect(
      [1, 2, 3, 10, 11, 12, 20, 21, 100, 110, 111].map((resets) => CodexAgentsV1.nickname("Gauss", resets)),
    ).toEqual([
      "Gauss the 2nd",
      "Gauss the 3rd",
      "Gauss the 4th",
      "Gauss the 11th",
      "Gauss the 12th",
      "Gauss the 13th",
      "Gauss the 21st",
      "Gauss the 22nd",
      "Gauss the 101st",
      "Gauss the 111th",
      "Gauss the 112th",
    ])
  })
})

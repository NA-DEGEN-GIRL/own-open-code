import { describe, expect, test } from "bun:test"
import { Message, SystemPart, ToolCallPart, ToolResultPart } from "@opencode/ai/effect"
import { Effect } from "effect"
import { CodexAgentsV1 } from "../../../src/codex/agents/v1.js"
import { CodeModeDeclarations } from "../../../src/codex/code-mode/declarations.js"
import { CodeModeTools } from "../../../src/codex/code-mode-tools.js"
import { Catalog } from "../../../src/codex/catalog.js"
import { Fragments } from "../../../src/codex/fragments.js"
import { CodexIncremental } from "../../../src/codex/incremental.js"
import { CodexRequest } from "../../../src/codex/request.js"
import { CodexTools } from "../../../src/codex/tools.js"
import { CodexVariant } from "../../../src/codex/variant.js"
import { Notice } from "../../../src/notice.js"
import { PiVariant } from "../../../src/pi/variant.js"

const BASELINE = [
  "Instructions from: C:\\work\\app\\AGENTS.md\nBe brief.",
  "Today's date: Sun Oct 11 2026",
  "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: C:\\work\\app\n  Platform: win32\n</env>",
  '<context key="own.preset">\nPlanner.\n</context>',
].join("\n\n")

const SESSION: CodexRequest.Session = {
  model: "gpt-5.5",
  sessionID: "ses_test",
  responses: true,
  cwd: "C:\\work\\app",
  mode: "full",
  reads: false,
  shell: "powershell",
  timezone: "Asia/Seoul",
  plan: false,
  skills: [],
  freeform: true,
}

function draft(messages: Array<Message>) {
  return {
    system: [
      SystemPart.make("You are an AI agent running in OpenCode, a coding agent harness."),
      SystemPart.make("# Your Model\n- Name: GPT\n- Provider ID: openai\n- Model ID: gpt-5.5"),
      SystemPart.make(BASELINE),
      SystemPart.make("When you create a worktree outside the current working directory, use session_move."),
    ],
    messages,
    options: {} as Record<string, unknown>,
    tools: {
      shell: { description: "shell", input: {} },
      exec_command: { description: "exec", input: {} },
      apply_patch: { description: "patch", input: { type: "object" } },
      subagent: { description: "subagent", input: {} },
      read: { description: "read", input: {} },
      exec: { description: "exec", input: { type: "object" } },
      wait: { description: "wait", input: {} },
      request_user_input: { description: "ask", input: {} },
      clock__sleep: { description: "sleep", input: { type: "object" } },
      execute: { description: "core code mode", input: {} },
    },
  }
}

const texts = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : part.type))

describe("CodexRequest.build", () => {
  test("Codex's prefix from core's system parts, own's context kept as developer text", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    CodexRequest.build(request, SESSION)
    expect(request.system).toEqual([])
    expect(texts(request.messages[0]!)[0]).toStartWith("You are Codex, a coding agent based on GPT-5.")
    const developer = texts(request.messages[1]!)
    expect(developer[0]).toBe('<context key="own.preset">\nPlanner.\n</context>')
    expect(developer[1]).toBe("When you create a worktree outside the current working directory, use session_move.")
    expect(developer.at(-2)).toStartWith("<permissions instructions>")
    expect(developer.at(-1)).toStartWith("<collaboration_mode>")
    expect(texts(request.messages[2]!)).toEqual([
      "# AGENTS.md instructions for C:\\work\\app\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>",
      expect.stringContaining("<current_date>2026-10-11</current_date>"),
    ])
    expect(request.messages[1]!.content[0]).toMatchObject({ providerMetadata: { "opencode.responses.inputText": {} } })
    expect(Object.keys(request.tools!)).toEqual(["exec_command", "request_user_input", "apply_patch", "execute"])
    expect(request.tools!.apply_patch!.input).toMatchObject({ "x-opencode-freeform": { syntax: "lark" } })
    expect(request.options).toMatchObject({ parallelToolCalls: true, textVerbosity: "low", reasoningSummary: null })
  })

  test("config instructions are Codex's developer_instructions; AGENTS.md keeps the global and project files", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    request.system[2] = SystemPart.make(
      [
        "Instructions from: C:\\Users\\me\\.config\\opencode\\AGENTS.md\nGlobal rules.",
        "Instructions from: C:\\work\\app\\AGENTS.md\nBe brief.",
        "Instructions from: C:\\work\\app\\CONTRIBUTING.md\nRun the linter.",
        "Instructions from: https://example.com/team.md\nTeam rules.",
        BASELINE.slice(BASELINE.indexOf("Today's date: ")),
      ].join("\n\n"),
    )
    CodexRequest.build(request, { ...SESSION, agentInstructions: "Agent prompt." })
    const developer = texts(request.messages[1]!)
    expect(developer.slice(0, 3)).toEqual([
      "Agent prompt.",
      "Run the linter.\n\nTeam rules.",
      '<context key="own.preset">\nPlanner.\n</context>',
    ])
    expect(texts(request.messages[2]!)[0]).toBe(
      "# AGENTS.md instructions for C:\\work\\app\n\n<INSTRUCTIONS>\nGlobal rules.\n\n--- project-doc ---\n\nBe brief.\n</INSTRUCTIONS>",
    )
  })

  test("v1 agent tools: deferred behind tool_search on gpt-5.5, up front for models outside the catalog", () => {
    const withAgents = (model: string) => {
      const base = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
      const request: CodexRequest.Draft = {
        ...base,
        tools: {
          ...base.tools,
          multi_agent_v1__spawn_agent: { description: "spawn", input: { type: "object" } },
          tool_search: { description: "search", input: { type: "object" } },
        },
      }
      CodexRequest.build(request, { ...SESSION, model })
      return request.tools!
    }
    const gpt = withAgents("gpt-5.5")
    expect(Object.keys(gpt)).toEqual([
      "exec_command",
      "request_user_input",
      "apply_patch",
      "multi_agent_v1__spawn_agent",
      "tool_search",
      "execute",
    ])
    expect(gpt.multi_agent_v1__spawn_agent!.input).toMatchObject({
      "x-opencode-namespace": { namespace: "multi_agent_v1", name: "spawn_agent", deferred: true },
    })
    expect(gpt.tool_search!.input).toMatchObject({ "x-opencode-hosted": { type: "tool_search", execution: "client" } })
    const unknown = withAgents("own-unknown-model")
    expect(Object.keys(unknown)).toEqual([
      "exec_command",
      "request_user_input",
      "multi_agent_v1__spawn_agent",
      "execute",
    ])
    expect(unknown.multi_agent_v1__spawn_agent!.input).toMatchObject({
      "x-opencode-namespace": { namespace: "multi_agent_v1", deferred: false },
    })
  })

  test("Codex's hosted web_search only in full approval; ask and read-only get own's websearch, which asks (MR12-5)", () => {
    const withSearch = () => {
      const base = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
      const tools: NonNullable<CodexRequest.Draft["tools"]> = {
        ...base.tools,
        web_search: { description: "hosted", input: {} },
        websearch: { description: "own's search", input: {} },
      }
      return { ...base, tools }
    }
    const names = (mode: Fragments.Mode) => {
      const request = withSearch()
      CodexRequest.build(request, { ...SESSION, mode })
      return request.tools!
    }
    const full = names("full")
    expect(Object.keys(full)).toContain("web_search")
    expect(Object.keys(full)).not.toContain("websearch")
    expect(full.web_search!.input).toMatchObject({ "x-opencode-hosted": { type: "web_search", external_web_access: true } })
    for (const mode of ["ask", "read-only"] as const) {
      expect(Object.keys(names(mode))).toContain("websearch")
      expect(Object.keys(names(mode))).not.toContain("web_search")
    }
  })

  test("a config deny of websearch keeps the hosted web_search out even in full approval (RL2-M2)", () => {
    const base = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    const tools: NonNullable<CodexRequest.Draft["tools"]> = {
      ...base.tools,
      web_search: { description: "hosted", input: {} },
      websearch: { description: "own's search", input: {} },
    }
    const request = { ...base, tools }
    // A user's config `websearch: deny` on the build agent (core's `*` allow first).
    const rules = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "deny" },
    ]
    CodexRequest.build(request, { ...SESSION, mode: "full", searchDenied: CodexRequest.searchDenied("build", rules) })
    expect(Object.keys(request.tools!)).toContain("websearch")
    expect(Object.keys(request.tools!)).not.toContain("web_search")
  })

  test("searchDenied reads the agent's rules as own-accounts' evaluate hook does", () => {
    const allow = { action: "*", resource: "*", effect: "allow" }
    expect(CodexRequest.searchDenied("build", [allow])).toBe(false)
    expect(CodexRequest.searchDenied("build", [allow, { action: "websearch", resource: "*", effect: "deny" }])).toBe(true)
    // A deny of some queries is a deny the hosted search cannot keep.
    expect(
      CodexRequest.searchDenied("build", [allow, { action: "websearch", resource: "*secret*", effect: "deny" }]),
    ).toBe(true)
    expect(CodexRequest.searchDenied("build", [{ action: "*", resource: "*", effect: "deny" }, allow])).toBe(false)
    // The user's own later ask for every query lifts the deny; a read-only role's own ask does not.
    const asked = [
      { action: "websearch", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "ask" },
    ]
    expect(CodexRequest.searchDenied("build", asked)).toBe(false)
    expect(CodexRequest.searchDenied("explore", asked)).toBe(true)
    expect(CodexRequest.searchDenied("build", [allow, { action: "webfetch", resource: "*", effect: "deny" }])).toBe(false)
  })

  test("non-Responses models get the same text in system", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    CodexRequest.build(request, { ...SESSION, model: "claude-opus-5-5", responses: false, freeform: false })
    expect(request.system[0]!.text).toStartWith("You are a coding agent running in the Codex CLI")
    expect(request.messages[0]!.role).toBe("user")
    expect(Object.keys(request.tools!)).toEqual(["exec_command", "request_user_input", "execute"])
  })

  test("code_mode_only models get Code Mode's tools over Responses Lite", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    CodexRequest.build(request, { ...SESSION, model: "gpt-6.1-sol" })
    expect(Object.keys(request.tools!)).toEqual(["exec", "wait", "request_user_input", "clock__sleep"])
    expect(request.tools!.exec!.input).toMatchObject({ "x-opencode-freeform": { type: "grammar", syntax: "lark" } })
    expect(request.tools!.exec!.description).toContain("### `exec_command`")
    expect(request.tools!.exec!.description).toContain("### `read_mcp_resource`")
    expect(request.tools!.exec!.description).not.toContain("### `web__run`")
    expect(request.tools!.clock__sleep!.input).toMatchObject({
      "x-opencode-namespace": {
        namespace: "clock",
        name: "sleep",
        description: "Tools for reading and waiting on time.",
      },
    })
    expect(request.options).toMatchObject({
      parallelToolCalls: false,
      reasoningContext: "all_turns",
      responsesLite: {
        id: expect.stringMatching(/^at_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      },
    })
  })

  test("GPT-5.6 has no clock tools", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    CodexRequest.build(request, { ...SESSION, model: "gpt-5.6-sol" })
    expect(Object.keys(request.tools!)).toEqual(["exec", "wait", "request_user_input"])
    expect(request.tools!.exec!.description).not.toContain("clock__curr_time")
  })

  test("kept tools the request hook attached are nested in exec, not sent top-level", () => {
    const base = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    const request = {
      ...base,
      tools: { ...base.tools, lint: { description: "Lint the project.", input: { type: "object" } } },
    }
    const lint: CodeModeDeclarations.Definition = {
      name: "lint",
      toolName: "lint",
      description: "Lint the project.",
      kind: "function",
      input: { type: "object", properties: { fix: { type: "boolean" } } },
    }
    const info = { name: "lint", description: lint.description, input: {}, execute: () => Effect.die("unused") }
    CodeModeTools.attach(request.tools, [{ id: "lint", info, mcp: false, direct: true, definition: lint }])
    CodexRequest.build(request, { ...SESSION, model: "gpt-6.1-sol" })
    expect(Object.keys(request.tools!)).not.toContain("lint")
    expect(request.tools!.exec!.description).toContain(
      "### `lint`\nLint the project.\n\nexec tool declaration:\n```ts\ndeclare const tools: { lint(args: { fix?: boolean; }): Promise<unknown>; };\n```",
    )
  })

  test("own's image tool is never nested: it stays a top-level tool next to exec (IM-26)", async () => {
    // The live registry as kept() reads it: a plugin tool and own's image tool, both `codemode: false`.
    const tool = (name: string) => ({
      id: name,
      name,
      description: name,
      input: { type: "object" },
      options: { codemode: false },
      execute: () => Effect.die("unused"),
    })
    const ctx = {
      tool: { list: () => Effect.succeed([tool("lint"), tool("image_generate")]) },
      session: { get: () => Effect.fail("none") },
      agent: { get: () => Effect.fail("none") },
      mcp: { list: () => Effect.succeed({ data: [] }) },
    }
    const kept = await Effect.runPromise(CodeModeTools.kept(ctx as never, "ses_1" as never, "build" as never))
    expect(kept.map((entry) => entry.id)).toEqual(["lint"])
    const base = draft([Message.make({ id: "u1", role: "user", content: "draw a cat" })])
    const request = {
      ...base,
      tools: {
        ...base.tools,
        lint: { description: "lint", input: { type: "object" } },
        image_generate: { description: "Generates a new image.", input: { type: "object" } },
      },
    }
    CodeModeTools.attach(request.tools, kept)
    CodexRequest.build(request, { ...SESSION, model: "gpt-6.1-sol" })
    expect(Object.keys(request.tools!)).toContain("image_generate")
    expect(Object.keys(request.tools!)).not.toContain("lint")
    expect(request.tools!.exec!.description).not.toContain("image_generate")
  })

  test("an interrupted turn gets <turn_aborted> after its last message and tool results", () => {
    const request = draft([
      Message.make({ id: "u1", role: "user", content: "run it" }),
      Message.make({
        id: "a1",
        role: "assistant",
        content: [ToolCallPart.make({ id: "c1", name: "exec_command", input: { cmd: "sleep" } })],
      }),
      Message.tool({ id: "c1", name: "exec_command", result: "aborted", resultType: "text" }),
      Message.make({ id: "u2", role: "user", content: "never mind" }),
    ])
    CodexRequest.build(request, { ...SESSION, interrupted: new Set(["a1"]) })
    const history = request.messages.slice(3)
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "user"])
    expect(texts(history[3]!)[0]).toStartWith("<turn_aborted>\nThe user interrupted the previous turn on purpose.")
  })

  test("a change of model gets Codex's <model_switch> with the new model's instructions before its turn", () => {
    const request = draft([
      Message.make({ id: "u1", role: "user", content: "first, on GPT-6" }),
      Message.make({ id: "a1", role: "assistant", content: "done" }),
      Message.make({ id: "u2", role: "user", content: "now on GPT-5.5" }),
    ])
    CodexRequest.build(request, { ...SESSION, switches: new Map([["u2", "gpt-5.5"]]) })
    const history = request.messages.slice(3)
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "system", "user"])
    expect(texts(history[2]!)[0]).toBe(
      `<model_switch>\nThe user was previously using a different model. Please continue the conversation according to the following instructions:\n\n${Catalog.instructions(Catalog.lookup("gpt-5.5"))}\n</model_switch>`,
    )
    // Without developer messages (Chat Completions, Anthropic) it is user text.
    const chat = draft([Message.make({ id: "u2", role: "user", content: "on DeepSeek" })])
    CodexRequest.build(chat, {
      ...SESSION,
      model: "deepseek-v4-pro",
      responses: false,
      switches: new Map([["u2", "deepseek-v4-pro"]]),
    })
    expect(chat.messages.slice(1).map((message) => message.role)).toEqual(["user", "user"])
    expect(texts(chat.messages[1]!)[0]).toStartWith("<model_switch>\nThe user was previously using a different model.")
  })

  test("the harness switch notice goes out as a developer message", () => {
    const request = draft([Message.make({ id: "s1", role: "user", content: Notice.text("opencode", "codex") })])
    CodexRequest.build(request, SESSION)
    expect(request.messages[3]!.role).toBe("system")
  })

  test("a Code Mode notify becomes one more output of its exec call; without the call it drops out", () => {
    const notified = () => [
      Message.make({ id: "u1", role: "user", content: "watch the build" }),
      Message.make({
        id: "a1",
        role: "assistant",
        content: [ToolCallPart.make({ id: "call_1", name: "exec", input: { input: 'notify("half way")' } })],
      }),
      Message.tool({ id: "call_1", name: "exec", result: "Script completed", resultType: "text" }),
      Message.make({ id: "n1", role: "user", content: CodeModeTools.notification("call_1", "half way") }),
      Message.make({ id: "n2", role: "user", content: CodeModeTools.notification("call_gone", "old news") }),
    ]
    const code = draft(notified())
    CodexRequest.build(code, { ...SESSION, model: "gpt-6.1-sol" })
    const history = code.messages.filter((message) => message.role !== "system").slice(1)
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"])
    const extra = history[3]!.content[0]!
    expect(extra.type === "tool-result" && extra.id === "call_1" && extra.name === "exec").toBe(true)
    expect(extra.type === "tool-result" ? extra.result : undefined).toEqual({ type: "text", value: "half way" })

    // A Direct request (no `exec`) keeps the texts as they were.
    const direct = draft(notified())
    CodexRequest.build(direct, SESSION)
    expect(direct.messages.slice(3).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "user",
    ])
  })
})

describe("CodexRequest.build, full-history forks (Codex 0.164.0, #55548)", () => {
  const GPT6 = { ...SESSION, model: "gpt-6.1-sol" }
  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown
  const spawnStep = (id: string, task: string) => [
    Message.make({
      role: "assistant",
      content: [
        ToolCallPart.make({ id, name: "collaboration__spawn_agent", input: { task_name: task, message: "Go." } }),
      ],
    }),
    Message.make({
      role: "tool",
      content: [ToolResultPart.make({ id, name: "collaboration__spawn_agent", result: "aborted", resultType: "text" })],
    }),
  ]
  const task = (path: string, sender: string) =>
    Message.make({
      role: "user",
      content: `Message Type: NEW_TASK\nTask name: ${path}\nSender: ${sender}\nPayload:\nGo.`,
    })

  test("the child's request starts with the parent's request unchanged, then its own fragments and its task", () => {
    const parent = draft([
      Message.make({ id: "u1", role: "user", content: "Delegate." }),
      Message.make({
        role: "user",
        content: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/old\nPayload:\nok",
      }),
    ])
    const built = CodexRequest.build(parent, { ...GPT6, sessionID: "ses_root" })
    expect(built.input).toBeDefined()
    expect(json(built.input!.messages)).toEqual(json(parent.messages))
    // Inter-agent messages and the root's <multi_agent_role> stay in what a child inherits.
    expect(parent.messages.some((entry) => texts(entry)[0]!.startsWith("<multi_agent_role>You are `/root`"))).toBe(true)
    expect(parent.messages.some((entry) => texts(entry)[0]!.startsWith("Message Type: FINAL_ANSWER"))).toBe(true)

    const forked = {
      kind: "prefix" as const,
      ...built.input!,
      messages: [...built.input!.messages, ...spawnStep("call_s", "helper")],
    }
    const child = draft([task("/root/helper", "/root")])
    const childBuilt = CodexRequest.build(child, { ...GPT6, sessionID: "ses_child", agentPath: "/root/helper", forked })
    expect(json(child.messages.slice(0, parent.messages.length))).toEqual(json(parent.messages))
    const added = child.messages.slice(parent.messages.length)
    expect(added.map((entry) => [entry.role, texts(entry)[0]!.slice(0, 18)])).toEqual([
      ["assistant", "tool-call"],
      ["tool", "tool-result"],
      ["system", CodexRequest.INHERITED_NOTICE.slice(0, 18)],
      ["system", "<multi_agent_role>"],
      ["system", "<multi_agent_mode>"],
      ["assistant", "Message Type: NEW_"],
    ])
    expect(texts(added[3]!)[0]).toContain("You are an agent in a team")
    expect(texts(added[5]!)[0]).toContain("Task name: /root/helper\nSender: /root\n")
    // Same model, permissions and context: nothing of the child's initial context is repeated.
    expect(added.filter((entry) => entry.role === "user")).toEqual([])
    // The tools item keeps the inherited id, so the copied prefix is identical down to its first item.
    expect(child.options.responsesLite).toEqual(parent.options.responsesLite)
    expect(childBuilt.input!.thread).toBe("ses_root")

    // A grandchild starts with the child's request unchanged.
    const grand = draft([task("/root/helper/leaf", "/root/helper")])
    CodexRequest.build(grand, {
      ...GPT6,
      sessionID: "ses_grand",
      agentPath: "/root/helper/leaf",
      forked: {
        kind: "prefix",
        ...childBuilt.input!,
        messages: [...childBuilt.input!.messages, ...spawnStep("call_g", "leaf")],
      },
    })
    expect(json(grand.messages.slice(0, child.messages.length))).toEqual(json(child.messages))
    expect(grand.options.responsesLite).toEqual(parent.options.responsesLite)
  })

  test("a child on another model or with other permissions appends what differs", () => {
    const parent = draft([Message.make({ id: "u1", role: "user", content: "Delegate." })])
    const built = CodexRequest.build(parent, { ...GPT6, sessionID: "ses_root" })
    // The parent ran a Responses Lite window: the child continues it (MR8-17).
    expect(built.input!.window).toEqual({
      model: "gpt-6.1-sol",
      base: Catalog.instructions(Catalog.lookup("gpt-6.1-sol")),
    })
    const child = draft([task("/root/helper", "/root")])
    CodexRequest.build(child, {
      ...GPT6,
      model: "gpt-5.6-sol",
      mode: "read-only",
      sessionID: "ses_child",
      agentPath: "/root/helper",
      forked: { kind: "prefix", ...built.input! },
    })
    const added = child.messages.slice(parent.messages.length).map((entry) => texts(entry)[0]!)
    expect(added[0]).toBe(CodexRequest.INHERITED_NOTICE)
    expect(added[1]).toContain("You are an agent in a team")
    expect(added[2]).toBe(
      CodexIncremental.instructions("gpt-5.6-sol", Catalog.instructions(Catalog.lookup("gpt-5.6-sol"))),
    )
    expect(added[3]).toStartWith("<collaboration_mode>")
    expect(added.some((text) => text.startsWith("<model_switch>"))).toBe(false)
    // Other permissions: the developer message goes again.
    expect(added.some((text) => text.startsWith('<context key="own.preset">'))).toBe(true)
    expect(child.messages.at(-2)!.role).toBe("user")
    expect(texts(child.messages.at(-2)!).at(-1)).toContain("<environment_context>")
  })

  // MR8-17: Codex continues the parent's Responses Lite window in a child on another model (world state diff after
  // `preserve_fork_prefix`): `<model_instructions>` and the child's `<collaboration_mode>`, nothing else of its own.
  test("a child on another Lite model with the same permissions sends only <model_instructions> and its collaboration", () => {
    const parent = draft([Message.make({ id: "u1", role: "user", content: "Delegate." })])
    const built = CodexRequest.build(parent, { ...GPT6, sessionID: "ses_root" })
    const child = draft([task("/root/helper", "/root")])
    const childBuilt = CodexRequest.build(child, {
      ...GPT6,
      model: "gpt-6.1-terra",
      sessionID: "ses_child",
      agentPath: "/root/helper",
      forked: { kind: "prefix", ...built.input! },
    })
    const added = child.messages.slice(parent.messages.length)
    const terra = Catalog.instructions(Catalog.lookup("gpt-6.1-terra"))
    expect(added.map((entry) => [entry.role, texts(entry)[0]!.slice(0, 20)])).toEqual([
      ["system", CodexRequest.INHERITED_NOTICE.slice(0, 20)],
      ["system", "<multi_agent_role>Yo"],
      ["system", "<model_instructions>"],
      ["system", "<collaboration_mode>"],
      ["system", "<multi_agent_mode>An"],
      ["assistant", "Message Type: NEW_TA"],
    ])
    expect(texts(added[2]!)[0]).toBe(
      CodexIncremental.instructions(
        "gpt-6.1-terra",
        terra === Catalog.instructions(Catalog.lookup("gpt-6.1-sol")) ? undefined : terra,
      ),
    )
    expect(texts(added[3]!)[0]).toBe(Fragments.collaboration(false, Catalog.lookup("gpt-6.1-terra")))
    // The child's own window is Terra's, which its children continue in turn.
    expect(childBuilt.input!.window).toEqual({ model: "gpt-6.1-terra", base: terra })
    // A prefix stored before merge round 8 has no window: the child keeps <model_switch>.
    const old = draft([task("/root/helper", "/root")])
    const { window: _window, ...stored } = built.input!
    CodexRequest.build(old, {
      ...GPT6,
      model: "gpt-6.1-terra",
      sessionID: "ses_old",
      agentPath: "/root/helper",
      forked: { kind: "prefix", ...stored },
    })
    const oldAdded = old.messages.slice(parent.messages.length).map((entry) => texts(entry)[0]!)
    expect(oldAdded.some((text) => text.startsWith("<model_instructions>"))).toBe(false)
    expect(oldAdded.some((text) => text.startsWith("<model_switch>"))).toBe(
      terra !== Catalog.instructions(Catalog.lookup("gpt-6.1-sol")),
    )
  })

  test("a history fork keeps the shape from before 0.164.0: the child's own context, then the history", () => {
    const child = draft([task("/root/helper", "/root")])
    CodexRequest.build(child, {
      ...GPT6,
      sessionID: "ses_child",
      agentPath: "/root/helper",
      forked: { kind: "history", messages: [Message.make({ role: "user", content: "Delegate." })] },
    })
    expect(texts(child.messages[0]!)[0]).toStartWith("You are Codex")
    const at = child.messages.findIndex((entry) => texts(entry)[0] === "Delegate.")
    expect(texts(child.messages[at - 1]!).at(-1)).toContain("<environment_context>")
    expect(child.messages.some((entry) => texts(entry)[0] === CodexRequest.INHERITED_NOTICE)).toBe(false)
    expect(child.options.responsesLite).toMatchObject({ id: expect.stringMatching(/^at_/) })
  })

  test("a preserved prefix carries the parent's effort updates and pin (Codex 0.165.0's updates with #55548)", () => {
    const efforts = (messages: ReadonlyArray<Message>) =>
      messages.flatMap((entry) => (entry.content[0]?.type === "effort" ? [entry.content[0]] : []))
    const parent = draft([Message.make({ id: "u1", role: "user", content: "Delegate." })])
    parent.options = { reasoningEffort: "low" }
    const built = CodexRequest.build(parent, { ...GPT6, sessionID: "ses_root" })
    expect(efforts(parent.messages).map((part) => part.effort)).toEqual(["low"])
    const forked = {
      kind: "prefix" as const,
      ...built.input!,
      messages: [...built.input!.messages, ...spawnStep("call_s", "helper")],
    }
    const child = (effort: string) => {
      const request = draft([task("/root/helper", "/root")])
      request.options = { reasoningEffort: effort }
      CodexRequest.build(request, { ...GPT6, sessionID: "ses_child", agentPath: "/root/helper", forked })
      return request
    }
    // The same effort: the inherited update stands and the child records none of its own.
    const same = child("low")
    expect(efforts(same.messages).map((part) => part.effort)).toEqual(["low"])
    expect(json(same.messages.slice(0, parent.messages.length))).toEqual(json(parent.messages))
    // Another effort: one update after the child's task, and the window keeps the parent's pinned effort on top.
    const other = child("high")
    expect(efforts(other.messages).map((part) => [part.effort, part.previous])).toEqual([
      ["low", "low"],
      ["high", "low"],
    ])
    expect(other.messages.at(-1)!.content[0]?.type).toBe("effort")
    expect(other.options.reasoningEffort).toBe("high")
  })

  test("off Responses a session records no request to fork", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    expect(CodexRequest.build(request, { ...GPT6, responses: false }).input).toBeUndefined()
  })
})

describe("CodexRequest.build, own's revision (10 §3.9)", () => {
  // Core's Code Mode catalog as a session receives it, one entry of the 2026-10-16 capture.
  const CATALOG = `# Code Mode

The tools listed below cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

The catalog is complete. Do not guess tool names.

## Code Mode tools (call only inside \`execute\`)

- opencode (1 tools) // Tools for managing OpenCode itself.
  - tools.opencode.session_rename({
  /** Omit to rename the current session. @pattern ^ses */
  sessionID?: string,
  /** New session title. @minLength 1 */
  title: string,
}): Promise<{
  /** @pattern ^ses */
  sessionID: string,
  title: string,
}> // Rename a session, or omit sessionID to rename the current session.`
  const spawn = (
    CodexAgentsV1.DEFINITION.tools as ReadonlyArray<{ name: string; description: string; parameters?: unknown }>
  ).find((tool) => tool.name === "spawn_agent")!
  const request = (model: string, prompt: "own" | "reference", mode: Fragments.Mode = "ask") => {
    const base = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    const built: CodexRequest.Draft = {
      ...base,
      system: [base.system[0]!, base.system[1]!, SystemPart.make(`${CATALOG}\n\n${BASELINE}`)],
      tools: {
        ...base.tools,
        exec_command: { description: "exec", input: CodexTools.definition("exec_command").parameters },
        multi_agent_v1__spawn_agent: { description: spawn.description, input: spawn.parameters },
      },
    }
    CodexRequest.build(built, { ...SESSION, model, prompt, mode, responses: false, freeform: false })
    return built
  }
  const system = (built: CodexRequest.Draft) => built.system.map((part) => part.text)
  const environment = (built: CodexRequest.Draft) => texts(built.messages[0]!).at(-1)!
  const properties = (built: CodexRequest.Draft, name: string) =>
    Object.keys((built.tools![name]!.input as { properties: Record<string, unknown> }).properties)

  test("the lean tier: own's base text, Pi's one-line catalog, own's permissions, lean spawn_agent", () => {
    const built = request("claude-opus-5-5", "own")
    const texts = system(built)
    expect(texts[0]).toStartWith("You are a coding agent running in own, a coding app the user opens")
    expect(texts[0]).toContain("\n# Editing files\n")
    expect(texts[0]).not.toContain("## Presenting your work and final message")
    expect(texts).toContain(PiVariant.codemode(CATALOG))
    expect(texts).not.toContain(CATALOG)
    expect(texts.some((text) => text.startsWith("# Your Model"))).toBe(true)
    expect(texts.at(-2)).toBe(CodexVariant.permissions("ask", false))
    expect(environment(built)).toContain('<entry access="write"><path>C:\\work\\app</path></entry></file_system>')
    expect(environment(built)).not.toContain(".git")
    expect(properties(built, "exec_command")).toEqual([
      "cmd",
      "login",
      "max_output_tokens",
      "shell",
      "tty",
      "workdir",
      "yield_time_ms",
    ])
    expect(built.tools!.multi_agent_v1__spawn_agent!.description).toBe(CodexVariant.SPAWN_AGENT_LEAN)
    expect(built.tools!.multi_agent_v1__spawn_agent!.description).toContain("model names are not spawn_agent arguments")
    expect(properties(built, "multi_agent_v1__spawn_agent")).toEqual(["fork_context", "items", "message", "model"])
  })

  test("outside the lean tier the revision keeps Codex's prompt with its replacements, and the same tool fixes", () => {
    const built = request("claude-sonnet-5-5", "own")
    const texts = system(built)
    expect(texts[0]).toStartWith("You are a coding agent running in own,")
    expect(texts[0]).toContain("## Presenting your work and final message")
    expect(texts[0]).toContain(CodexVariant.PATCH)
    expect(texts).toContain(PiVariant.codemode(CATALOG))
    expect(texts.at(-2)).toBe(CodexVariant.permissions("ask", false))
    expect(environment(built)).not.toContain(".agents")
    expect(built.tools!.multi_agent_v1__spawn_agent!.description).toBe(
      CodexVariant.spawnAgent(spawn.description, false),
    )
    expect(built.tools!.multi_agent_v1__spawn_agent!.description).toContain("model names are not spawn_agent arguments")
    expect(properties(built, "multi_agent_v1__spawn_agent")).not.toContain("reasoning_effort")
    expect(properties(built, "exec_command")).not.toContain("sandbox_permissions")
    expect(system(request("deepseek-v4-pro", "own", "full")).at(-2)).toBe(CodexVariant.permissions("full", false))
  })

  test("the original variant sends Codex's bytes", () => {
    const built = request("claude-opus-5-5", "reference")
    const texts = system(built)
    expect(texts[0]).toBe(Catalog.instructions(Catalog.lookup("claude-opus-5-5")))
    expect(texts).toContain(CATALOG)
    expect(texts.some((text) => text.startsWith("# Your Model"))).toBe(false)
    expect(texts.at(-2)).toBe(Fragments.permissions("ask", SESSION.cwd))
    expect(environment(built)).toContain('<entry access="read"><path>C:\\work\\app\\.git</path></entry>')
    expect(properties(built, "exec_command")).toContain("prefix_rule")
    expect(properties(built, "multi_agent_v1__spawn_agent")).toContain("reasoning_effort")
    expect(built.tools!.multi_agent_v1__spawn_agent!.description).toBe(spawn.description)
  })

  test("a <model_switch> to a lean-tier model carries the lean text, to another model the revised fallback", () => {
    const switched = (to: string) => {
      const built = draft([Message.make({ id: "u2", role: "user", content: "next" })])
      CodexRequest.build(built, {
        ...SESSION,
        model: to,
        prompt: "own",
        responses: false,
        freeform: false,
        switches: new Map([["u2", to]]),
      })
      return texts(built.messages[1]!)[0]!
    }
    expect(switched("claude-fable-5-1")).toContain("\n\nYou are a coding agent running in own, a coding app")
    expect(switched("claude-fable-5-1")).toContain("\n# Editing files\n")
    expect(switched("deepseek-v4-pro")).toContain("## Presenting your work and final message")
    expect(switched("deepseek-v4-pro")).not.toContain("# Editing files")
  })
})

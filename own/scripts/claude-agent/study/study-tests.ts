// STUDY RECORD ONLY (branch claude-agent-study, 8f86e2c9e9 and d5f963659d): the tests behind
// own/reports/claude-agent-provider-2026-10-31.md §1, §4–§7 and §12. Moved out of packages/core on 2026-10-31 and in no
// test tier; its imports name packages/core paths, so it runs only from its old place on branch claude-agent-study.
// The Claude Agent route's real tests are packages/core/test/plugin/provider/claude-agent/own-*.test.ts and the own
// packages' tests.
// own study, not upstream's (own/reports/claude-agent-provider-2026-10-31.md): own's harness request hooks, an
// own-accounts account switch, a context reset and compaction against upstream's Claude Agent provider and its fake
// `claude`. The harness hooks are own-harness's real request builders (Pi and Codex), registered after the provider's
// hooks, which is where own.harness sits (internal plugins register first).
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Message, SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import type { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { make, ID } from "@opencode/core/plugin/provider/claude-agent/index"
import { ClaudeAgentLanguageModel } from "@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { ClaudeSystemPrompt } from "@opencode/core/plugin/provider/claude-agent/language-model/system-prompt"
import { ClaudeProvider } from "@opencode/core/plugin/provider/claude-agent/provider"
import { Checkpoints } from "@opencode/core/plugin/provider/claude-agent/sync/checkpoints"
import { CatchUp } from "@opencode/core/plugin/provider/claude-agent/sync/catch-up"
import { SyncDecision } from "@opencode/core/plugin/provider/claude-agent/sync/decide"
import { NativeTranscript } from "@opencode/core/plugin/provider/claude-agent/sync/native"
import { ToolNames } from "@opencode/core/plugin/provider/claude-agent/tools/names"
import { Session } from "@opencode/core/session"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"
import { it as effect } from "../../../lib/effect"
import { testEffect } from "../../../lib/effect"
import { PluginTestLayer } from "../../fixture"

// own-harness's own request builders, loaded at run time: core's type check has no declarations for their text imports.
const harness = "../../../../../own-harness/src"
const { PiRequest } = (await import(`${harness}/pi/request.js`)) as {
  PiRequest: { build: (draft: unknown, session: unknown) => { prompt: string } }
}
const { CodexRequest } = (await import(`${harness}/codex/request.js`)) as {
  CodexRequest: { build: (draft: unknown, session: unknown) => unknown }
}

const it = testEffect(PluginTestLayer)
const opus = Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("opus") })
const PI_MARK = "You are a coding assistant running inside pi"

const addPlugin = Effect.fn(function* (io: ClaudeIO.Interface) {
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const host = yield* PluginHost.make(yield* Plugin.Service, ID)
  yield* make(io, registry).effect(host)
  return registry
})

// Core's request as own-harness receives it: [agent prompt, identity, instructions (keyed sources), a plugin part].
const coreRequest = (sessionID: Session.ID) => ({
  sessionID,
  agent: Agent.ID.make("build"),
  model: opus,
  system: [
    SystemPart.make("CORE-AGENT-PROMPT"),
    SystemPart.make("# Your Model\n- Name: Opus\n- Provider ID: claude-agent\n- Model ID: opus"),
    {
      ...SystemPart.make("AGENTS-MD-TEXT"),
      metadata: { experimental: { instructions: [{ key: "core/agents-md", text: "AGENTS-MD-TEXT" }] } },
    },
    SystemPart.make("OWN-PLUGIN-PART"),
  ] as SystemPart[],
  messages: [Message.user("Fix the parser.")] as Message[],
  options: {} as Record<string, unknown>,
  tools: {
    shell: { description: "core shell", input: { type: "object", properties: { command: { type: "string" } } } },
    read: { description: "core read", input: { type: "object", properties: { path: { type: "string" } } } },
    edit: { description: "core edit", input: { type: "object" } },
    write: { description: "core write", input: { type: "object" } },
    pi_read: { description: "Pi read", input: { type: "object", properties: { path: { type: "string" } } } },
    pi_bash: { description: "Pi bash", input: { type: "object", properties: { command: { type: "string" } } } },
    pi_edit: { description: "Pi edit", input: { type: "object" } },
    pi_write: { description: "Pi write", input: { type: "object" } },
    subagent: { description: "x".repeat(3000) + "\nAvailable subagents: general", input: { type: "object" } },
  } as Record<string, { description: string; input: any }>,
})

const newSession = Effect.gen(function* () {
  // The test layer has no built-in agents, so add a build agent without a system prompt.
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), () => {})
  })
  const location = yield* Location.Service
  const sessions = yield* Session.Service
  return yield* sessions.create({ location: { directory: location.directory } })
})

// own.harness's place: a context hook registered after the provider's.
const registerPi = (writeOptions: boolean) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        const built = PiRequest.build(event, { cwd: "C:/work", responses: false, skills: [] })
        if (!writeOptions) return
        // The fix own-harness can make without a core patch: hand the harness's own system to the provider's options.
        event.options[ClaudeSystemPrompt.AGENT_OPTION] = built.prompt
        event.options[ClaudeSystemPrompt.INSTRUCTIONS_OPTION] = ""
      }),
    )
  })

function toCall(event: ReturnType<typeof coreRequest>) {
  const tools: LanguageModelV3FunctionTool[] = Object.entries(event.tools).map(([name, tool]) => ({
    type: "function",
    name,
    description: tool.description,
    inputSchema: tool.input,
  }))
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: event.system.map((part) => part.text).join("\n\n") },
    ...event.messages.map((message) => ({
      role: "user" as const,
      content: message.content.flatMap((part) => (part.type === "text" ? [{ type: "text" as const, text: part.text }] : [])),
    })),
  ]
  return { tools, prompt, providerOptions: { [ClaudeProvider.ID]: event.options as Record<string, any> } }
}

const sendThroughProvider = Effect.fn(function* (event: ReturnType<typeof coreRequest>) {
  const claude = FakeClaude.make([FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()])
  const test = yield* TestSessions.start(claude)
  const call = toCall(event)
  const result = yield* Effect.promise(() =>
    test.model.doStream({
      ...call,
      headers: { [RequestKind.SESSION_HEADER]: "session-h", [RequestKind.HEADER]: "primary" },
    }),
  )
  yield* Effect.promise(() => TestSessions.collect(result.stream))
  const run = claude.runs[0]!
  const init = run.received.find((message) => message.request?.subtype === "initialize").request
  yield* test.registry.close()
  claude.check()
  return { init, run, tools: call.tools }
})

describe("own harness hooks on claude-agent", () => {
  it.live("Pi's prompt never reaches Claude: the provider read the system before own.harness rebuilt it", () =>
    Effect.gen(function* () {
      yield* addPlugin(FakeIO.make({ claude: FakeClaude.make([]) }))
      yield* registerPi(false)
      const hooks = yield* PluginHooks.Service
      const event = yield* hooks.trigger("session", "context", coreRequest((yield* newSession).id))
      // own.harness did build Pi's request: Pi's prompt, Pi's tool names.
      expect(event.system[0]!.text).toContain(PI_MARK)
      expect(Object.keys(event.tools)).toEqual(["read", "bash", "edit", "write", "subagent"])
      // The provider captured core's instructions (and the plugin part) before that, and drops system[0] for Claude.
      // The provider captured core's parts (the identity block too) before own.harness ran, and drops system[0].
      expect(event.options[ClaudeSystemPrompt.INSTRUCTIONS_OPTION]).toBe(
        "# Your Model\n- Name: Opus\n- Provider ID: claude-agent\n- Model ID: opus\n\nAGENTS-MD-TEXT\n\nOWN-PLUGIN-PART",
      )
      expect(event.options[ClaudeSystemPrompt.AGENT_OPTION]).toBe("")

      const sent = yield* sendThroughProvider(event)
      const append = String(sent.init.appendSystemPrompt ?? "")
      expect(sent.init.systemPrompt).toBeUndefined()
      expect(append).toContain("AGENTS-MD-TEXT")
      expect(append).not.toContain(PI_MARK)
      // Pi's tools do reach Claude, as the `opencode` MCP server, under Pi's names.
      expect(sent.init.sdkMcpServers).toEqual(["opencode"])
      expect(sent.tools.map((tool) => ToolNames.PREFIX + ToolNames.short(tool.name))).toEqual([
        "mcp__opencode__read",
        "mcp__opencode__bash",
        "mcp__opencode__edit",
        "mcp__opencode__write",
        "mcp__opencode__subagent",
      ])
      expect(sent.run.args).toContain("--permission-mode=dontAsk")
    }),
  )

  it.live("own-harness can hand its own prompt to the provider: Pi's prompt then reaches Claude after the preset", () =>
    Effect.gen(function* () {
      yield* addPlugin(FakeIO.make({ claude: FakeClaude.make([]) }))
      yield* registerPi(true)
      const hooks = yield* PluginHooks.Service
      const event = yield* hooks.trigger("session", "context", coreRequest((yield* newSession).id))
      const sent = yield* sendThroughProvider(event)
      const append = String(sent.init.appendSystemPrompt ?? "")
      expect(append).toContain("# Agent role (from OpenCode)\n" + PI_MARK)
      // Pi's prompt holds the AGENTS.md text and the plugin part itself (its <addendum>), so nothing is lost or doubled.
      expect(append.split("OWN-PLUGIN-PART").length - 1).toBe(1)
      expect(sent.init.systemPrompt).toBeUndefined()
    }),
  )

  it.live("Codex on a non-Responses route: its base and developer text are lost, its user context and tools stay", () =>
    Effect.gen(function* () {
      yield* addPlugin(FakeIO.make({ claude: FakeClaude.make([]) }))
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          CodexRequest.build(event, {
            model: "opus",
            responses: false,
            cwd: "C:/work",
            mode: "full",
            reads: false,
            shell: "powershell",
            plan: false,
            skills: [],
            freeform: false,
            sessionID: event.sessionID,
          })
        }),
      )
      const request = coreRequest((yield* newSession).id)
      request.tools = {
        ...request.tools,
        exec_command: { description: "Runs a command", input: { type: "object" } },
        write_stdin: { description: "Writes to a session", input: { type: "object" } },
        apply_patch: { description: "Applies a patch", input: { type: "object" } },
      }
      const event = yield* hooks.trigger("session", "context", request)
      const base = event.system[0]!.text
      expect(base.length).toBeGreaterThan(1000)
      // Codex keeps AGENTS.md and <environment_context> as the first user message, which Claude does see.
      expect(event.messages[0]!.role).toBe("user")
      const sent = yield* sendThroughProvider(event)
      const append = String(sent.init.appendSystemPrompt ?? "")
      expect(append).not.toContain(base.slice(0, 200))
      const users = sent.run.received.filter((message) => message.type === "user")
      expect(JSON.stringify(users[0].message.content)).toContain("environment_context")
      const names = sent.tools.map((tool) => tool.name)
      expect(names).toContain("exec_command")
      expect(names).toContain("write_stdin")
      // apply_patch is a freeform tool only on Responses (P-020); off Responses Codex's prompt (lost here) tells the
      // model to patch through exec_command. Core's shell and subagent give way to Codex's tools.
      expect(names).not.toContain("apply_patch")
      expect(names).not.toContain("shell")
      expect(names).not.toContain("subagent")
    }),
  )
})

describe("own-accounts account switch between claude-agent slots", () => {
  const first = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")
  const slotA = { CLAUDE_CONFIG_DIR: "C:/own/claude-accounts/a" }
  const slotB = { CLAUDE_CONFIG_DIR: "C:/own/claude-accounts/b" }

  effect.effect("one registry: a switch restarts claude with the new account and resumes the same transcript", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn({ index: 1 }),
        FakeClaude.expectInterrupt(),
      ])
      const test = yield* TestSessions.start(claude)
      const onA = new ClaudeAgentLanguageModel.Model("opus", test.model.dependencies, slotA)
      const onB = new ClaudeAgentLanguageModel.Model("opus", test.model.dependencies, slotB)
      yield* TestSessions.reply(onA, first)
      yield* TestSessions.reply(onB, TestSessions.followup())
      expect(claude.runs).toHaveLength(2)
      const id = claude.runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]
      expect(claude.runs[0]!.env.CLAUDE_CONFIG_DIR).toBe(slotA.CLAUDE_CONFIG_DIR)
      expect(claude.runs[1]!.env.CLAUDE_CONFIG_DIR).toBe(slotB.CLAUDE_CONFIG_DIR)
      expect(claude.runs[1]!.args).toContain(`--resume=${id}`)
      // Only the new question goes in; the earlier turn is Claude's own transcript (which the new account must be able to read).
      const users = claude.runs[1]!.received.filter((message) => message.type === "user")
      expect(users).toHaveLength(1)
      expect(users[0].message.content).toEqual([{ type: "text", text: "What was the marker? Reply only with it." }])
      yield* test.registry.close()
      claude.check()
    }),
  )

  effect.effect("a registry per slot: the other slot has no record and re-sends the history as one checkpoint", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn({ index: 1 }),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectInterrupt(),
      ])
      const a = yield* TestSessions.start(claude)
      const b = yield* TestSessions.start(claude)
      yield* TestSessions.reply(a.model, first)
      yield* TestSessions.reply(b.model, TestSessions.followup())
      expect(claude.runs).toHaveLength(2)
      expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--resume="))).toBe(false)
      const users = claude.runs[1]!.received.filter((message) => message.type === "user")
      const text = JSON.stringify(users[0].message.content)
      expect(text).toContain("<conversation-checkpoint>")
      expect(text).toContain("COPPER-OTTER")
      yield* b.registry.close()
      yield* a.registry.close()
      claude.check()
    }),
  )
})

describe("history changes own makes: model switches, context reset, compaction", () => {
  const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
  const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })
  const system = { role: "system" as const, content: "S" }
  const recorded = (prompt: LanguageModelV3Prompt, reply: string) => ({
    claudeSessionID: "claude-1",
    history: Checkpoints.build({
      prompt,
      userID: "u-last",
      reply: [{ type: "text", text: reply }],
      messageID: "m-last",
      toolMessages: new Map(),
    }),
  })

  test("a GPT or DeepSeek turn in between is caught up once; going back continues the same transcript", () => {
    const opening: LanguageModelV3Prompt = [system, user("one")]
    const record = recorded(opening, "claude says one")
    const back: LanguageModelV3Prompt = [
      ...opening,
      assistant("claude says one"),
      user("two"),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "exec_command", input: { cmd: "ls" } }],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "exec_command", output: { type: "text", value: "a.ts" } }] },
      assistant("gpt says two"),
      user("three"),
    ]
    const decision = SyncDecision.decide(back, record)
    expect(decision.kind).toBe("catch-up")
    const blocks = CatchUp.content(back, decision.start)
    const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n")
    expect(text).toContain("<conversation-checkpoint>")
    expect(text).toContain('"name":"exec_command"')
    expect(text.indexOf("three")).toBeGreaterThan(text.indexOf("</conversation-checkpoint>"))
  })

  test("a context reset (P-035) and its undo, and a compaction, each start a new Claude transcript", () => {
    const before: LanguageModelV3Prompt = [system, user("one"), assistant("a1"), user("two")]
    const record = recorded(before, "a2")
    // After a reset the next request holds only what follows the boundary.
    expect(SyncDecision.decide([system, user("three")], record).kind).toBe("fresh")
    const afterReset = recorded([system, user("three")], "a3")
    // Undo brings the old history back; the record now names the post-reset transcript.
    const undone: LanguageModelV3Prompt = [...before, assistant("a2"), user("four")]
    expect(SyncDecision.decide(undone, afterReset).kind).toBe("fresh")
    // A compaction's checkpoint opens the history.
    expect(SyncDecision.decide([system, user("<checkpoint>summary</checkpoint>"), user("five")], record).kind).toBe(
      "fresh",
    )
  })

  test("Claude's MCP tool descriptions stop at 2,048 characters: long harness descriptions are cut", () => {
    const long: LanguageModelV3FunctionTool = { type: "function", name: "apply_patch", description: "y".repeat(5000), inputSchema: {} }
    expect(ToolNames.description(long).length).toBe(2048)
  })
})

describe("native transcript (own prototype)", () => {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "S" },
    { role: "user", content: [{ type: "text", text: "Look up key a." }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "GPT thinking, unsigned for Claude" },
        { type: "text", text: "Looking it up." },
        { type: "tool-call", toolCallId: "call:gpt/1", toolName: "lookup", input: { key: "a" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call:gpt/1", toolName: "lookup", output: { type: "text", value: "LILAC-HERON" } },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "The marker is LILAC-HERON." }] },
  ]
  const tools: LanguageModelV3FunctionTool[] = [{ type: "function", name: "lookup", inputSchema: {} }]

  test("writes another model's turns as linked entries with real tool_use and tool_result blocks", () => {
    const built = NativeTranscript.build({ sessionId: "s-1", cwd: "C:/work", version: "2.1.301", prompt, tools })
    expect(built.entries.map((entry) => entry.type)).toEqual(["user", "assistant", "user", "assistant"])
    expect(built.entries.map((entry) => entry.parentUuid)).toEqual([null, ...built.entries.slice(0, -1).map((entry) => entry.uuid)])
    const call = (built.entries[1]!.message.content as any[]).find((block) => block.type === "tool_use")
    const result = (built.entries[2]!.message.content as any[])[0]
    expect(call).toMatchObject({ name: "mcp__opencode__lookup", input: { key: "a" } })
    expect(call.id).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: "LILAC-HERON" }] })
    // Thinking from another provider is dropped: Claude's API takes only its own signed thinking.
    expect(JSON.stringify(built.entries)).not.toContain("GPT thinking")
  })

  test("its record continues like a transcript Claude wrote: the next question is sent alone", () => {
    const built = NativeTranscript.build({ sessionId: "s-1", cwd: "C:/work", version: "2.1.301", prompt, tools })
    const next: LanguageModelV3Prompt = [...prompt, { role: "user", content: [{ type: "text", text: "Which tool?" }] }]
    const decision = SyncDecision.decide(next, { claudeSessionID: "s-1", history: built.history })
    expect(decision).toEqual({ kind: "continue", start: next.length - 1 })
    expect(SyncDecision.boundary(next, { claudeSessionID: "s-1", history: built.history })?.messageID).toBe(
      built.entries.at(-1)!.uuid,
    )
  })
})

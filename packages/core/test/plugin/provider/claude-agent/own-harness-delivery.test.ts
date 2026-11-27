// OWN-PATCH(P-045) begin
// own, not upstream's (2026-10-31 decisions, own/reports/claude-agent-provider-2026-10-31.md §4.3): own-harness's real
// request hooks registered after upstream's Claude Agent provider, as own.harness sits (internal plugins register
// first), with upstream's fake `claude`. codex, pi and dsh hand their whole system to the provider, so Claude gets
// Claude Code's prompt and then the harness's; `opencode` and `claude-code` keep the provider's role and instructions.
// What the fake `claude` receives is read back: the system prompt in its initialize request, the tools from the SDK's
// answer to an MCP `tools/list`, and a harness tool's call coming back to OpenCode under the harness's name.
import fs from "node:fs"
import path from "node:path"
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Message, SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { make, ID } from "@opencode/core/plugin/provider/claude-agent/index"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { ClaudeSystemPrompt } from "@opencode/core/plugin/provider/claude-agent/language-model/system-prompt"
import { ClaudeProvider } from "@opencode/core/plugin/provider/claude-agent/provider"
import { Session } from "@opencode/core/session"
import { describe, expect } from "bun:test"
import { Effect, type Scope } from "effect"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"
import { TestTools } from "./lib/tools"
import { testEffect } from "../../../lib/effect"
import { PluginTestLayer } from "../../fixture"

// own-harness's modules, loaded at run time: core's type check has no declarations for their text imports.
const harnessSource = "../../../../../own-harness/src"
const { Hooks } = (await import(`${harnessSource}/hooks.js`)) as {
  Hooks: {
    register: (
      ctx: unknown,
      tree: unknown,
      treeV1: unknown,
      fallback: ReadonlyArray<string>,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
}
const { Collab } = (await import(`${harnessSource}/codex/collab.js`)) as {
  Collab: { Tree: new (ctx: unknown) => object }
}
const { CollabV1 } = (await import(`${harnessSource}/codex/collab-v1.js`)) as {
  CollabV1: { Tree: new (ctx: unknown, shared: unknown) => object }
}
const { CodexVariant } = (await import(`${harnessSource}/codex/variant.js`)) as {
  CodexVariant: { PATCH_TOOL: string; PATCH_TOOL_DESCRIPTION: string }
}
const { PiPrompt } = (await import(`${harnessSource}/pi/prompt.js`)) as { PiPrompt: { PREAMBLE: string } }
const { DshPrompt } = (await import(`${harnessSource}/dsh/prompt.js`)) as { DshPrompt: { IDENTITY: string } }

const it = testEffect(PluginTestLayer)
const opus = Model.Ref.make({ providerID: ClaudeProvider.ID, id: Model.ID.make("opus") })
const ROLE_HEADING = "# Agent role (from OpenCode)\n"
type Harness = "codex" | "pi" | "dsh" | "opencode" | "claude-code"

const addPlugin = Effect.fn(function* () {
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const host = yield* PluginHost.make(yield* Plugin.Service, ID)
  yield* make(FakeIO.make({ claude: FakeClaude.make([]) }), registry).effect(host)
})

// own.harness's place: its request hooks, registered after the provider's, on a plugin context of its own.
const addHarness = Effect.gen(function* () {
  const host = yield* PluginHost.make(yield* Plugin.Service, "own.harness")
  const tree = new Collab.Tree(host)
  yield* Hooks.register(host, tree, new CollabV1.Tree(host, tree), [])
})

const newSession = Effect.fn(function* (harness: Harness) {
  // The test layer has no built-in agents, so add a build agent without a system prompt.
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), () => {})
  })
  const location = yield* Location.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    location: { directory: location.directory },
    metadata: { "own.harness": { id: harness, v: 1, prompt: "own" } },
  })
  return { session, directory: fs.realpathSync(location.directory) }
})

const schema = (properties: Record<string, unknown>) => ({ type: "object", properties })

/** upstream's fixture tool, standing in for another plugin's tool. */
const CONFIRM = TestTools.tools.find((tool) => tool.name === "confirm")!

/** The tools each harness's gate lets its sessions list (own-harness gate.ts), under their registered names. */
const HARNESS_TOOLS: Record<Harness, Record<string, { description: string; input: any }>> = {
  codex: {
    exec_command: { description: "Runs a command.", input: schema({ cmd: { type: "string" } }) },
    write_stdin: { description: "Writes to a session.", input: schema({ session_id: { type: "number" } }) },
    apply_patch: {
      description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool.",
      input: {
        type: "object",
        properties: { input: { type: "string", description: "The entire contents of the apply_patch command" } },
        required: ["input"],
        additionalProperties: false,
      },
    },
  },
  pi: {
    pi_read: { description: "Pi read", input: schema({ path: { type: "string" } }) },
    pi_bash: { description: "Pi bash", input: schema({ command: { type: "string" } }) },
    pi_edit: { description: "Pi edit", input: schema({ path: { type: "string" } }) },
    pi_write: { description: "Pi write", input: schema({ path: { type: "string" } }) },
  },
  dsh: {
    dsh_read: { description: "dsh read", input: schema({ path: { type: "string" } }) },
    [process.platform === "win32" ? "dsh_pwsh" : "dsh_bash"]: {
      description: "dsh shell",
      input: schema({ command: { type: "string" } }),
    },
  },
  opencode: {},
  "claude-code": {},
}

// Core's request as own-harness receives it: [agent prompt, identity, instruction baseline (keyed sources), a plugin
// part], core's tools, the harness's gated tools and a plugin's tool (`confirm`, kept by every harness).
function coreRequest(sessionID: Session.ID, harness: Harness, directory: string) {
  const agentsMd = `Instructions from: ${path.join(directory, "AGENTS.md")}\nAGENTS-MD-TEXT`
  const date = "Today's date: Sat Oct 31 2026"
  const environment = `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${directory}\n</env>`
  const entry = '<context key="own.team.role">\nTEAM-ROLE-TEXT\n</context>'
  return {
    sessionID,
    agent: Agent.ID.make("build"),
    model: opus,
    system: [
      SystemPart.make("CORE-AGENT-PROMPT"),
      SystemPart.make("# Your Model\n- Name: Opus\n- Provider ID: claude-agent\n- Model ID: opus"),
      {
        ...SystemPart.make([agentsMd, date, environment, entry].join("\n\n")),
        metadata: {
          experimental: {
            instructions: [
              { key: "core/agents-md", text: agentsMd },
              { key: "core/date", text: date },
              { key: "core/environment", text: environment },
              { key: "api/own.team.role", text: entry },
            ],
          },
        },
      },
      SystemPart.make("OWN-PLUGIN-PART"),
    ] as SystemPart[],
    messages: [Message.user("Fix the parser.")] as Message[],
    options: {} as Record<string, unknown>,
    tools: {
      shell: { description: "core shell", input: schema({ command: { type: "string" } }) },
      read: { description: "core read", input: schema({ path: { type: "string" } }) },
      edit: { description: "core edit", input: schema({}) },
      write: { description: "core write", input: schema({}) },
      ...HARNESS_TOOLS[harness],
      confirm: { description: CONFIRM.description!, input: CONFIRM.inputSchema },
    } as Record<string, { description: string; input: any }>,
  }
}

const built = Effect.fn(function* (harness: Harness) {
  yield* addPlugin()
  yield* addHarness
  const created = yield* newSession(harness)
  const hooks = yield* PluginHooks.Service
  return yield* hooks.trigger("session", "context", coreRequest(created.session.id, harness, created.directory))
})

function toCall(event: { system: SystemPart[]; messages: Message[]; tools: Record<string, any>; options: object }) {
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
      content: message.content.flatMap((part) =>
        part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
      ),
    })),
  ]
  return { tools, prompt, providerOptions: { [ClaudeProvider.ID]: event.options as Record<string, any> } }
}

const LIST_ID = "own-tools-list"

/**
 * One text turn whose `claude` first asks the SDK's `opencode` server for its tools, as Claude Code does at startup.
 * The turn's result waits for that answer, so the script stays in order.
 */
function listingTurn() {
  const listed: FakeClaude.Step = {
    type: "exchange",
    input: { type: "control_response", response: { request_id: LIST_ID } },
    replies: [],
    started: Promise.withResolvers<void>(),
    done: Promise.withResolvers<void>(),
  }
  const turn = FakeClaude.expectTurn()
  const ask = {
    type: "control_request",
    request_id: LIST_ID,
    request: {
      subtype: "mcp_message",
      server_name: "opencode",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    },
  }
  return [{ ...turn, replies: [ask, ...turn.replies], beforeResult: listed.done.promise }, listed]
}

const sendThroughProvider = Effect.fn(function* (event: Parameters<typeof toCall>[0]) {
  const claude = FakeClaude.make([FakeClaude.expectStartup(), ...listingTurn(), FakeClaude.expectInterrupt()])
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
  const listed = run.received.find((message) => message.response?.request_id === LIST_ID)
  yield* test.registry.close()
  claude.check()
  const tools: Array<{ name: string; description: string; inputSchema: unknown }> =
    listed.response.response.mcp_response.result.tools
  return { init, append: String(init.appendSystemPrompt ?? ""), tools }
})

const count = (text: string, part: string) => text.split(part).length - 1

describe("own-harness on claude-agent: each harness's prompt and tools reach Claude", () => {
  const MARKS = { codex: CodexVariant.PATCH_TOOL, pi: PiPrompt.PREAMBLE, dsh: DshPrompt.IDENTITY }

  for (const harness of ["codex", "pi", "dsh"] as const)
    it.live(`${harness}: Claude Code's prompt, then the harness's whole system as the agent role`, () =>
      Effect.gen(function* () {
        const event = yield* built(harness)
        const system = event.system.map((part) => part.text).join("\n\n")
        expect(event.options[ClaudeSystemPrompt.AGENT_OPTION]).toBe(system)
        expect(event.options[ClaudeSystemPrompt.INSTRUCTIONS_OPTION]).toBe("")
        const sent = yield* sendThroughProvider(event)
        // The preset stays (no replacement system prompt); its append carries the harness's prompt, once.
        expect(sent.init.systemPrompt).toBeUndefined()
        expect(sent.append).toBe(ClaudeSystemPrompt.make(system, "").append)
        expect(sent.append).toContain(ROLE_HEADING + event.system[0]!.text)
        expect(sent.append).toContain(MARKS[harness])
        expect(sent.append).not.toContain("CORE-AGENT-PROMPT")
        expect(count(sent.append, "OWN-PLUGIN-PART")).toBe(1)
        expect(count(sent.append, "TEAM-ROLE-TEXT")).toBe(1)
        expect(sent.init.sdkMcpServers).toEqual(["opencode"])
        const names = sent.tools.map((tool) => tool.name)
        if (harness === "codex") {
          // Codex's tools replace core's file and shell tools; a plugin's tool stays.
          expect(names).toEqual(["exec_command", "write_stdin", "apply_patch", "confirm"])
          const patch = sent.tools.find((tool) => tool.name === "apply_patch")!
          expect(patch.description).toBe(CodexVariant.PATCH_TOOL_DESCRIPTION)
          expect(patch.inputSchema).toEqual(HARNESS_TOOLS.codex.apply_patch!.input)
        }
        if (harness === "pi") expect(names).toEqual(["read", "bash", "edit", "write", "confirm"])
        if (harness === "dsh")
          expect(names).toEqual([process.platform === "win32" ? "pwsh" : "bash", "read", "confirm"])
      }),
    )

  for (const harness of ["opencode", "claude-code"] as const)
    it.live(`${harness}: Claude Code's prompt with OpenCode's instructions, core's tools`, () =>
      Effect.gen(function* () {
        const event = yield* built(harness)
        // The provider's own reading of core's system stands: no agent role, the instructions without date and env.
        expect(event.options[ClaudeSystemPrompt.AGENT_OPTION]).toBe("")
        const sent = yield* sendThroughProvider(event)
        expect(sent.init.systemPrompt).toBeUndefined()
        expect(sent.append).not.toContain(ROLE_HEADING)
        expect(sent.append).not.toContain("CORE-AGENT-PROMPT")
        expect(sent.append).not.toContain("Today's date")
        for (const text of ["AGENTS-MD-TEXT", "TEAM-ROLE-TEXT", "OWN-PLUGIN-PART"])
          expect(count(sent.append, text)).toBe(1)
        expect(sent.tools.map((tool) => tool.name)).toEqual(["shell", "read", "edit", "write", "confirm"])
      }),
    )
})

describe("own-harness on claude-agent: a harness tool call comes back to OpenCode under the harness's name", () => {
  // upstream's recorded tool turn (two `lookup` calls, then `confirm`), with `lookup` renamed to the harness's tool.
  const renamed = (steps: FakeClaude.Step[], name: string) =>
    steps.map((step) => {
      if (step.type === "startup") return step
      const rename = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value)
            .replaceAll('"mcp__opencode__lookup"', `"mcp__opencode__${name}"`)
            .replaceAll('"name":"lookup"', `"name":"${name}"`),
        )
      if (step.type === "exchange") return { ...step, input: rename(step.input), replies: rename(step.replies) }
      return { ...step, replies: rename(step.replies) }
    })

  for (const [harness, name] of [
    ["pi", "read"],
    ["codex", "exec_command"],
  ] as const)
    it.live(`${harness}: Claude's ${name} call is OpenCode's ${name} call, and its result goes back to Claude`, () =>
      Effect.gen(function* () {
        const event = yield* built(harness)
        const claude = FakeClaude.make(renamed(FakeClaude.replay("tools"), name))
        const test = yield* TestSessions.start(claude)
        const call = toCall(event)
        const steps = []
        for (let i = 0; i < 3; i++) {
          const parts = yield* TestTools.step(test.model, call.prompt, call.tools, "primary", call.providerOptions)
          steps.push(parts)
          TestTools.append(call.prompt, parts, TestTools.output)
        }
        expect(steps[0]!.filter((part) => part.type === "tool-call").map((part) => part.toolName)).toEqual([name, name])
        expect(steps[1]!.find((part) => part.type === "tool-call")?.toolName).toBe("confirm")
        expect(TestSessions.text(steps[2]!)).toBe("COPPER-OTTER")
        // One `claude` ran the whole turn, with the harness's prompt, and got OpenCode's results back.
        expect(claude.runs).toHaveLength(1)
        const init = claude.runs[0]!.received.find((message) => message.request?.subtype === "initialize").request
        expect(String(init.appendSystemPrompt)).toContain(ROLE_HEADING + event.system[0]!.text)
        const outputs = claude.runs[0]!.received.filter((message) => message.response?.response?.mcp_response).map(
          (message) => message.response.response.mcp_response.result.content[0].text,
        )
        expect(outputs).toEqual(["LILAC-HERON", "LEMON-IBIS", "COPPER-OTTER"])
        yield* test.registry.close()
        claude.check()
      }),
    )
})
// OWN-PATCH(P-045) end

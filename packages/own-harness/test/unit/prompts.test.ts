// `prompt.preview` (10 §3.11) over an in-memory fake of the model list, the tool registry and the plugin storage: the
// parts come from the harnesses' request builders (the same functions the request hooks call), 내 지시문 replaces only
// the editable part and falls back to 개선판 without a saved text, and own's changes say which apply to a model.
// `하위 에이전트`: core's `subagent` with core's "Available subagents:" list for the default agent, pinned to core's
// first line, output limit and Claude Agent naming; Codex's agent tools by tier and version.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SystemPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect } from "effect"
import { ToolNames } from "../../../core/src/plugin/provider/claude-agent/tools/names.js"
import { ToolOutput } from "../../../core/src/tool-output.js"
import { CodexAgents } from "../../src/codex/agents/index.js"
import { CodexAgentsV1 } from "../../src/codex/agents/v1.js"
import { Catalog } from "../../src/codex/catalog.js"
import { Collab } from "../../src/codex/collab.js"
import { CollabV1 } from "../../src/codex/collab-v1.js"
import { Fragments } from "../../src/codex/fragments.js"
import { CodexRequest } from "../../src/codex/request.js"
import { CodexVariant } from "../../src/codex/variant.js"
import { Custom } from "../../src/custom.js"
import { DshPrompt } from "../../src/dsh/prompt.js"
import { DshShell } from "../../src/dsh/shell.js"
import { DshShellTool } from "../../src/dsh/shell-tool.js"
import { DshTools } from "../../src/dsh/tools.js"
import { Gate } from "../../src/gate.js"
import { Hooks } from "../../src/hooks.js"
import { PiPrompt } from "../../src/pi/prompt.js"
import { PiTools } from "../../src/pi/tools.js"
import { Prompts } from "../../src/prompts.js"

const CWD = "C:\\work\\app"
const SPAWN = CodexAgentsV1.DEFINITION.tools.find((tool) => tool.name === "spawn_agent")!.description
const SPAWN_V2 = (CodexAgents.DEFINITION.tools as ReadonlyArray<{ name: string; description: string }>).find(
  (tool) => tool.name === "spawn_agent",
)!.description

function fake(
  models = MODELS,
  more: { readonly tools?: ReadonlyArray<Record<string, unknown>>; readonly agents?: ReadonlyArray<unknown> } = {},
) {
  const stored = new Map<string, unknown>()
  const ctx = {
    model: { list: () => Effect.succeed({ data: models }) },
    agent: { list: () => Effect.succeed({ data: more.agents ?? [] }) },
    tool: {
      list: () =>
        Effect.succeed([
          ...(more.tools ?? []),
          { id: "exec_command", description: "Runs a command.", options: { permission: Gate.ACTION } },
          { id: "multi_agent_v1__spawn_agent", description: SPAWN, options: { permission: Gate.ACTION } },
          { id: PiTools.INTERNAL.read, description: "Read a file.", options: { permission: Gate.PI_ACTION } },
          {
            id: DshTools.INTERNAL[DshShell.kind()],
            description: DshShellTool.description(DshShell.kind()),
            options: { permission: Gate.DSH_ACTION },
          },
          { id: DshTools.INTERNAL.read, description: "dsh read.", options: { permission: Gate.DSH_ACTION } },
          { id: "websearch", description: "Core's search.", options: { codemode: false } },
        ]),
    },
    storage: {
      get: (key: string) => Effect.sync(() => stored.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
      remove: (key: string) => Effect.sync(() => void stored.delete(key)),
    },
    location: { directory: CWD },
  } as unknown as Pick<Context, "model" | "tool" | "storage" | "location" | "agent">
  return ctx
}

const MODELS = [
  { providerID: "oa", id: "gpt-5.5", name: "GPT-5.5", enabled: true, package: Hooks.RESPONSES_PACKAGE },
  { providerID: "an", id: "claude-opus-5-5", name: "Claude Opus 5.5", enabled: true },
  { providerID: "an", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", enabled: true },
  { providerID: "an", id: "claude-haiku-4-5", name: "Haiku", enabled: false },
]

const run = (ctx: ReturnType<typeof fake>, input: Prompts.Input) => Effect.runPromise(Prompts.preview(ctx, input))
const opus = { providerID: "an", modelID: "claude-opus-5-5" }
const sonnet = { providerID: "an", modelID: "claude-sonnet-5-5" }
const gpt = { providerID: "oa", modelID: "gpt-5.5" }
const text = (preview: OwnHarness.PromptPreview, kind: OwnHarness.PromptPartKind) =>
  preview.parts.find((part) => part.kind === kind)?.text

describe("prompt.preview: codex", () => {
  test("개선판 for the lean tier: own's short text first, then core's model block and own's permissions text", async () => {
    const preview = await run(fake(), { harness: "codex", prompt: "own", model: opus })
    expect(preview).toMatchObject({ tier: "lean", applied: "own", responses: false, mode: "ask", examples: false })
    expect(preview.parts.map((part) => [part.kind, part.role, part.editable])).toEqual([
      ["base", "system", true],
      ["identity", "system", false],
      ["permissions", "system", false],
      ["collaboration", "system", false],
      ["environment", "user", false],
    ])
    expect(text(preview, "base")).toBe(CodexVariant.LEAN)
    expect(text(preview, "identity")).toBe(
      "# Your Model\n- Name: Claude Opus 5.5\n- Provider ID: an\n- Model ID: claude-opus-5-5",
    )
    expect(text(preview, "permissions")).toBe(CodexVariant.permissions("ask", true))
    expect(text(preview, "environment")).toContain(`<cwd>${CWD}</cwd>`)
    // The enabled models to pick from; the disabled one is not offered.
    expect(preview.models.map((model) => model.modelID)).toEqual(["gpt-5.5", "claude-opus-5-5", "claude-sonnet-5-5"])
    // The harness's own tools after own's revision; core's tools are not listed.
    expect(preview.tools.map((tool) => tool.name)).toEqual(["exec_command", "multi_agent_v1__spawn_agent"])
    expect(preview.tools[1]!.description).toBe(CodexVariant.SPAWN_AGENT_LEAN)
  })

  test("원본: Codex's fallback prompt, Codex's permissions text and no model block", async () => {
    const preview = await run(fake(), { harness: "codex", prompt: "reference", model: opus, mode: "full" })
    expect(text(preview, "base")).toBe(Catalog.fallbackInstructions())
    expect(text(preview, "identity")).toBeUndefined()
    expect(text(preview, "permissions")).toBe(Fragments.permissions("full", CWD))
    expect(preview.tools[1]!.description).toBe(SPAWN)
  })

  test("a GPT model of Codex's catalog on Responses: developer messages, Codex's template under 개선판 too", async () => {
    const own = await run(fake(), { harness: "codex", prompt: "own", model: gpt })
    const reference = await run(fake(), { harness: "codex", prompt: "reference", model: gpt })
    expect(own.tier).toBe("catalog")
    expect(own.responses).toBe(true)
    expect(own.parts[0]).toMatchObject({ kind: "base", role: "developer" })
    // Codex 0.167.0's `<tools>` closes the developer message: the deferred v1 agent namespace.
    expect(own.parts.filter((part) => part.role === "developer").at(-1)).toMatchObject({
      kind: "tools",
      text: "<tools>\nDeferred tool namespaces:\n- multi_agent_v1: Tools for spawning and managing sub-agents.\n</tools>",
    })
    expect(own.parts).toEqual(reference.parts)
    expect(own.changes.filter((change) => change.applies)).toEqual([])
  })

  test("내 지시문 replaces the base text only, with own's patch section in its slot; without a text it runs 개선판", async () => {
    const ctx = fake()
    const own = await run(ctx, { harness: "codex", prompt: "own", model: opus })
    const unsaved = await run(ctx, { harness: "codex", prompt: "custom", model: opus })
    expect(unsaved.applied).toBe("own")
    expect(unsaved.parts).toEqual(own.parts)
    expect(unsaved.custom).toBeUndefined()

    await Effect.runPromise(Custom.save(ctx, "codex", "Answer in Korean.\n\n# Editing files\n{{patch}}"))
    const custom = await run(ctx, { harness: "codex", prompt: "custom", model: opus })
    expect(custom.applied).toBe("custom")
    expect(custom.custom?.text).toBe("Answer in Korean.\n\n# Editing files\n{{patch}}")
    expect(text(custom, "base")).toBe(`Answer in Korean.\n\n# Editing files\n${CodexVariant.PATCH}`)
    expect(custom.parts.slice(1)).toEqual(own.parts.slice(1))
    expect(custom.tools).toEqual(own.tools)

    // 기본으로 되돌리기: the text is gone and the variant runs 개선판 again.
    await Effect.runPromise(Custom.save(ctx, "codex", null))
    expect((await run(ctx, { harness: "codex", prompt: "custom", model: opus })).parts).toEqual(own.parts)
  })

  test("내 지시문 starts from 개선판 or 원본: saved unchanged, it sends what that variant sends", async () => {
    const ctx = fake()
    for (const model of [opus, sonnet, gpt]) {
      const preview = await run(ctx, { harness: "codex", prompt: "own", model })
      const entry = Catalog.lookup(model.modelID)
      expect(preview.starts.own).toBe(CodexVariant.start(entry, "own"))
      expect(CodexVariant.instructions(entry, "custom", preview.starts.own)).toBe(text(preview, "base")!)
      expect(CodexVariant.instructions(entry, "custom", preview.starts.reference)).toBe(Catalog.instructions(entry))
    }
    // The patch section stays generated: the lean text's copy holds the slot, not the section.
    expect(CodexVariant.start(Catalog.lookup("claude-opus-5-5"), "own")).toContain(
      `# Editing files\n${CodexVariant.PATCH_SLOT}`,
    )
    expect(CodexVariant.start(Catalog.lookup("claude-opus-5-5"), "own")).not.toContain(CodexVariant.PATCH)
  })

  test("own's changes come from variant.ts and say which the model gets", async () => {
    const applying = async (model: typeof opus) =>
      (await run(fake(), { harness: "codex", prompt: "own", model })).changes.flatMap((change) =>
        change.applies ? [change.id] : [],
      )
    const replacements = CodexVariant.REPLACEMENTS.map((item) => `codex.base.${item.id}`)
    const spawn = CodexVariant.SPAWN_AGENT_REPLACEMENTS.map((item) => `codex.spawn.${item.id}`)
    const common = ["codex.identity", "codex.permissions", "codex.environment", "codex.catalog", "codex.escalation"]
    expect(await applying(sonnet)).toEqual([
      ...replacements,
      ...common,
      "codex.spawn.models",
      ...spawn,
      "codex.spawn.effort",
    ])
    expect(await applying(opus)).toEqual(["codex.lean", ...common, "codex.spawn.lean", "codex.spawn.effort"])
    const changes = (await run(fake(), { harness: "codex", prompt: "reference", model: sonnet })).changes
    expect(changes.every((change) => change.title !== "" && change.why !== "")).toBe(true)
    const first = changes.find((change) => change.id === "codex.base.where")!
    expect([first.before, first.after]).toEqual([CodexVariant.REPLACEMENTS[0]!.from, CodexVariant.REPLACEMENTS[0]!.to])
    expect(changes.find((change) => change.id === "codex.permissions")).toMatchObject({
      before: Fragments.permissions("ask", CWD),
      after: CodexVariant.permissions("ask", true),
    })
  })

  test("without enabled models: examples of each tier", async () => {
    const preview = await run(fake([]), { harness: "codex", prompt: "own" })
    expect(preview.examples).toBe(true)
    expect(preview.model.modelID).toBe("gpt-5.5")
    expect(preview.models.map((model) => model.modelID)).toContain("claude-opus-5-5")
  })
})

describe("prompt.preview: pi", () => {
  test("Pi's sections; 내 지시문 replaces the opening paragraph and nothing else", async () => {
    const ctx = fake()
    const own = await run(ctx, { harness: "pi", prompt: "own", model: gpt })
    expect(own.parts.map((part) => [part.kind, part.role, part.editable])).toEqual([
      ["preamble", "developer", true],
      ["tools", "developer", false],
      ["rules", "developer", false],
      ["cwd", "developer", false],
    ])
    expect(text(own, "preamble")).toBe(PiPrompt.PREAMBLE)
    expect(own.starts).toEqual({ reference: PiPrompt.PREAMBLE, own: PiPrompt.PREAMBLE })
    expect(own.tools.map((tool) => tool.name)).toEqual(["read"])
    expect(own.tier).toBeUndefined()
    expect(own.changes.map((change) => [change.id, change.applies])).toEqual([["pi.catalog", true]])

    await Effect.runPromise(Custom.save(ctx, "pi", "You are a careful assistant. Answer in Korean."))
    const custom = await run(ctx, { harness: "pi", prompt: "custom", model: gpt })
    expect(text(custom, "preamble")).toBe("You are a careful assistant. Answer in Korean.")
    expect(custom.parts.slice(1)).toEqual(own.parts.slice(1))
    // The codex harness keeps its own text.
    expect((await run(ctx, { harness: "codex", prompt: "custom", model: gpt })).applied).toBe("own")
  })
})

describe("prompt.preview: dsh", () => {
  test("dsh's sections, then the messages after the first user message; 내 지시문 replaces the persona line", async () => {
    const ctx = fake()
    const reference = await run(ctx, { harness: "dsh", prompt: "reference", model: sonnet })
    expect(reference.parts.map((part) => [part.kind, part.role, part.editable])).toEqual([
      ["harness", "system", false],
      ["persona", "system", true],
      ["tools", "system", false],
      ["tools", "system", false],
      ["environment", "user", false],
      ["time", "user", false],
    ])
    expect(text(reference, "persona")).toBe("You are a coding agent powered by the claude-sonnet-5-5 model.")
    expect(text(reference, "environment")).toContain("Current DSH file policy: workspace-write.")
    expect(text(reference, "time")).toContain("Browser time zone for this request: unavailable.")
    expect(reference.tools.map((tool) => tool.name)).toEqual([DshShell.kind(), "read"])
    expect(reference.tools[0]!.description).toContain(DshShellTool.SANDBOX_SENTENCE)
    expect(reference.starts).toEqual({ reference: DshPrompt.PERSONA, own: DshPrompt.PERSONA })
    expect(reference.changes.map((change) => change.id)).toEqual([
      "dsh.policy",
      "dsh.sandbox",
      "dsh.zone",
      "dsh.catalog",
    ])

    const own = await run(ctx, { harness: "dsh", prompt: "own", model: sonnet, mode: "full" })
    expect(text(own, "environment")).toContain("Approval mode: full.")
    expect(own.tools[0]!.description).not.toContain(DshShellTool.SANDBOX_SENTENCE)
    await Effect.runPromise(Custom.save(ctx, "dsh", "You are a careful assistant on {{model}}."))
    const custom = await run(ctx, { harness: "dsh", prompt: "custom", model: sonnet, mode: "full" })
    expect(text(custom, "persona")).toBe("You are a careful assistant on claude-sonnet-5-5.")
    expect(custom.parts.filter((part) => part.kind !== "persona" && part.kind !== "time")).toEqual(
      own.parts.filter((part) => part.kind !== "persona" && part.kind !== "time"),
    )
  })
})

describe("prompt.preview: 하위 에이전트", () => {
  const SUBAGENT_TOOL = { id: "subagent", description: "Spawns an agent in a child session.", options: {} }
  const rule = (action: string, resource: string, effect: "allow" | "deny") => ({ action, resource, effect })
  const agent = (id: string, mode: "primary" | "subagent" | "all", more: Record<string, unknown> = {}) => ({
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode,
    hidden: false,
    permissions: [],
    ...more,
  })
  // Core's Agent.list puts the default agent first; it may start every subagent but `secret`.
  const AGENTS = [
    agent("build", "primary", { permissions: [rule("*", "*", "allow"), rule("subagent", "secret", "deny")] }),
    agent("plan", "primary", { description: "Plans." }),
    agent("general", "subagent", { description: "General work." }),
    agent("explore", "subagent", { description: "Read-only search." }),
    agent("secret", "subagent", { description: "Denied to build." }),
    agent("hidden", "subagent", { hidden: true, description: "Hidden." }),
    agent("quiet", "all"),
  ]
  const listed = (description: string) =>
    [
      description,
      "",
      "Available subagents:",
      "- explore: Read-only search.",
      "- general: General work.",
      "- quiet: This subagent should only be called when explicitly requested.",
    ].join("\n")

  test("Pi, DeepSeek and Claude Agent 기본 send core's subagent with the default agent's list; OpenCode 기본 too", async () => {
    const ctx = fake(MODELS, { tools: [SUBAGENT_TOOL], agents: AGENTS })
    const expected = {
      kind: "core" as const,
      tool: { name: "subagent", description: listed(SUBAGENT_TOOL.description) },
      agent: "build",
      opening: Prompts.OPENING,
      guidance: "",
      cut: Prompts.CUT,
    }
    for (const harness of ["pi", "dsh", "claude-code"] as const)
      expect([harness, (await run(ctx, { harness, prompt: "own", model: sonnet })).subagent]).toEqual([
        harness,
        expected,
      ])
    expect(await Effect.runPromise(Prompts.subagent(ctx))).toEqual(expected)
    // The harness's tool list stays its own tools: core's subagent is shown in its own part.
    expect((await run(ctx, { harness: "pi", prompt: "own", model: sonnet })).tools.map((tool) => tool.name)).toEqual([
      "read",
    ])
  })

  test("the child's first line and the cut are core's", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../core/src/tool/plugin/subagent.ts")).text()
    expect(Prompts.OPENING.endsWith("\n")).toBe(true)
    expect(source).toContain(`[${JSON.stringify(Prompts.OPENING.slice(0, -1))}, input.prompt].join("\\n")`)
    expect(Prompts.CUT).toEqual({ lines: ToolOutput.MAX_LINES, bytes: ToolOutput.MAX_BYTES })
  })

  test("no list without a default agent or a subagent it may start; no tool when none is registered", async () => {
    const bare = { kind: "core" as const, opening: Prompts.OPENING, guidance: "", cut: Prompts.CUT }
    expect(await Effect.runPromise(Prompts.subagent(fake(MODELS, { tools: [SUBAGENT_TOOL] })))).toEqual({
      ...bare,
      tool: { name: "subagent", description: SUBAGENT_TOOL.description },
    })
    const closed = [agent("build", "primary", { permissions: [rule("subagent", "*", "deny")] }), ...AGENTS.slice(1)]
    expect(await Effect.runPromise(Prompts.subagent(fake(MODELS, { tools: [SUBAGENT_TOOL], agents: closed })))).toEqual(
      { ...bare, tool: { name: "subagent", description: SUBAGENT_TOOL.description }, agent: "build" },
    )
    expect(await Effect.runPromise(Prompts.subagent(fake(MODELS, { agents: AGENTS })))).toEqual(bare)
  })

  test("on the Claude Agent provider: Claude Code's MCP name, and a long description keeps the list first", async () => {
    const claude = { providerID: OwnHarness.CLAUDE_AGENT, modelID: "opus" }
    const named = (description: string) =>
      run(fake(MODELS, { tools: [{ ...SUBAGENT_TOOL, description }], agents: AGENTS }), {
        harness: "claude-code",
        prompt: "own",
        model: claude,
      })
    const viaMcp = (description: string) =>
      ToolNames.description({ type: "function", name: "subagent", description, inputSchema: {} })
    expect((await named(SUBAGENT_TOOL.description)).subagent?.tool).toEqual({
      name: ToolNames.PREFIX + ToolNames.short("subagent"),
      description: viaMcp(listed(SUBAGENT_TOOL.description)),
    })
    const long = "x".repeat(2_100)
    const cut = (await named(long)).subagent?.tool?.description
    expect(cut).toBe(viaMcp(listed(long)))
    expect(cut?.startsWith("Available subagents:\n- explore")).toBe(true)
    expect(cut?.length).toBe(2_048)
  })

  test("Codex: its v1 agent tools outside v2, its collaboration tools with a NEW_TASK and a role for v2", async () => {
    const ctx = fake(MODELS, {
      tools: [{ id: Collab.toolName("spawn_agent"), description: SPAWN_V2, options: { permission: Gate.ACTION } }],
    })
    expect((await run(ctx, { harness: "codex", prompt: "own", model: opus })).subagent).toEqual({
      kind: "codex-v1",
      tool: { name: CollabV1.toolName("spawn_agent"), description: CodexVariant.SPAWN_AGENT_LEAN },
      opening: "",
      guidance: "",
    })
    expect((await run(ctx, { harness: "codex", prompt: "reference", model: gpt })).subagent).toMatchObject({
      kind: "codex-v1",
      tool: { description: SPAWN },
    })
    const sol = { providerID: "oa", modelID: "gpt-6-sol" }
    const v2 = (await run(ctx, { harness: "codex", prompt: "own", model: sol })).subagent
    expect(v2?.kind).toBe("codex-v2")
    expect(v2?.tool?.name).toBe(Collab.toolName("spawn_agent"))
    expect(v2?.opening).toBe("Message Type: NEW_TASK\nTask name: /root/<task_name>\nSender: /root\nPayload:\n")
    const role = (at: string) => CodexAgents.roleText({ path: at, model: Catalog.lookup("gpt-6-sol") })
    expect(v2?.guidance).toBe(role("/root/review")!)
    expect(v2?.guidance).not.toBe(role("/root")!)
    expect(v2?.cut).toBeUndefined()
  })

  test("Codex in Code Mode on a v1 model (GPT-5.6 Luna on Responses) keeps core's subagent, as its request does", async () => {
    const luna = { providerID: "oa", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", enabled: true }
    const ctx = fake([{ ...luna, package: Hooks.RESPONSES_PACKAGE }, ...MODELS], {
      tools: [SUBAGENT_TOOL],
      agents: AGENTS,
    })
    const preview = await run(ctx, { harness: "codex", prompt: "own", model: { providerID: "oa", modelID: luna.id } })
    expect(preview.responses).toBe(true)
    expect(preview.subagent).toEqual({
      kind: "core",
      tool: { name: "subagent", description: listed(SUBAGENT_TOOL.description) },
      agent: "build",
      opening: Prompts.OPENING,
      guidance: "",
      cut: Prompts.CUT,
    })
    // The request builder a session runs: Code Mode sends `subagent` and none of the v1 agent tools.
    const tools = (responses: boolean) => {
      const draft: CodexRequest.Draft = {
        system: [SystemPart.make("agent")],
        messages: [],
        options: {},
        tools: {
          subagent: { description: SUBAGENT_TOOL.description, input: {} },
          [CollabV1.toolName("spawn_agent")]: { description: SPAWN, input: {} },
        },
      }
      CodexRequest.build(draft, {
        model: luna.id,
        responses,
        cwd: CWD,
        mode: "ask",
        reads: true,
        shell: "powershell",
        timezone: "UTC",
        plan: false,
        skills: [],
        freeform: responses,
        jsonPatch: false,
        sessionID: "ses_luna",
        prompt: "own",
      })
      return Object.keys(draft.tools ?? {})
    }
    expect(tools(true)).toContain("subagent")
    expect(tools(true)).not.toContain(CollabV1.toolName("spawn_agent"))
    // Off Responses the same model gets the Direct tools: Codex's v1 agent tools in place of core's subagent.
    expect(tools(false)).toEqual([CollabV1.toolName("spawn_agent")])
    const direct = await run(ctx, { harness: "codex", prompt: "own", model: { providerID: "chat", modelID: luna.id } })
    expect(direct.responses).toBe(false)
    expect(direct.subagent?.kind).toBe("codex-v1")
  })

  test("what each Codex tier asks of a child, as the page's notes say (the lean tier asks for no changed files)", () => {
    const changed = "list the file paths it changed"
    // Codex's own text (catalog GPT models, and 원본 for every model): the changed paths, then a quick review.
    expect(SPAWN).toContain(changed)
    expect(SPAWN).toContain("quickly review the uploaded changes")
    // The fallback tier keeps both in this app's words.
    const fallback = CodexVariant.spawnAgent(SPAWN, false)
    expect(fallback).toContain(changed)
    expect(fallback).toContain("quickly review the files it changed")
    // The lean tier asks for neither, only the result wanted back.
    expect(CodexVariant.SPAWN_AGENT_LEAN).not.toContain(changed)
    expect(CodexVariant.SPAWN_AGENT_LEAN).not.toContain("review")
    expect(CodexVariant.SPAWN_AGENT_LEAN).toContain("the result you want back")
    // v2: the final answer is delivered; wait_agent does not return it.
    expect(SPAWN_V2).not.toContain(changed)
    expect(SPAWN_V2).toContain("its final answer will be provided to you when it finishes")
    const wait = (CodexAgents.DEFINITION.tools as ReadonlyArray<{ name: string; description: string }>).find(
      (tool) => tool.name === "wait_agent",
    )!.description
    expect(wait).toContain("Does not return the content")
  })
})

describe("own's change texts", () => {
  test("speak the app's Korean (03 §14.1): 해요체, 이 앱 rather than own, no banned words", async () => {
    const changes = [
      ...(await run(fake(), { harness: "codex", prompt: "own", model: sonnet })).changes,
      ...(await run(fake(), { harness: "pi", prompt: "own", model: sonnet })).changes,
      ...(await run(fake(), { harness: "dsh", prompt: "own", model: sonnet })).changes,
    ]
    const offending = changes.flatMap((change) =>
      [change.title, change.why].flatMap((line) =>
        /[가-힣](니다|니까)(?=$|[\s.,)])|(?<![\w.-])own(?![\w.-])|세션|하네스|공급자|프로바이더|컨텍스트|(?<![\w@/-])own\.[a-z]+/.test(
          line,
        )
          ? [`${change.id}: ${line}`]
          : [],
      ),
    )
    expect(offending).toEqual([])
    changes.forEach((change) =>
      expect([change.id, change.why.endsWith("요.") || change.why.endsWith("요")]).toEqual([change.id, true]),
    )
  })
})

describe("Custom", () => {
  test("only blanks or more than the limit cannot be saved", () => {
    expect(Custom.problem(" \n\t")).toBe("empty")
    expect(Custom.problem("x".repeat(Custom.LIMIT + 1))).toBe("too_long")
    expect(Custom.problem("x".repeat(Custom.LIMIT))).toBeUndefined()
  })

  test("saved lists the harnesses with a text", async () => {
    const ctx = fake()
    await Effect.runPromise(Custom.save(ctx, "pi", "x"))
    expect(await Effect.runPromise(Custom.saved(ctx))).toEqual(["pi"])
    // A stored value that no longer decodes counts as none.
    await Effect.runPromise(ctx.storage.set("prompt/custom/codex", { text: 1 }))
    expect(await Effect.runPromise(Custom.get(ctx, "codex"))).toBeUndefined()
  })
})

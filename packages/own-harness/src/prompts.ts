// What each harness sends (10 §3.11, 설정 > 에이전트 방식): `prompt.preview` runs the harness's own request builder
// (codex/request.ts, pi/request.ts, dsh/request.ts) on an empty conversation, so the page shows the bytes a session's first request
// carries for the same model and approval mode, part by part. Core's per-conversation additions (the agent prompt the
// harness drops, AGENTS.md, skills, the Code Mode catalog, MCP guidance) are not in that draft; core's `# Your Model`
// block is, as core writes it, so the page shows where own keeps it. Tools are the harness's own (the ones its gate
// lists), after the builder's renames and revisions; core's other tools go along unchanged. own's changes come from
// variant.ts, so the list cannot drift from what runs. `하위 에이전트` says how the harness hands work to a child: core's
// `subagent` tool as the registry and core's context hook give it (`prompt.subagent` for OpenCode 기본, and Codex in Code
// Mode on a v1 model), or Codex's agent tools with a child's first message and role text from the code that writes them.
export * as Prompts from "./prompts.js"

import { Message, SystemPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Agent } from "@opencode/schema/agent"
import type { Tool } from "@opencode/schema/tool"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect } from "effect"
import { CodexAgents } from "./codex/agents/index.js"
import { AgentPath } from "./codex/agents/path.js"
import { CodexAgentsV1 } from "./codex/agents/v1.js"
import { Catalog } from "./codex/catalog.js"
import { Collab } from "./codex/collab.js"
import { CollabV1 } from "./codex/collab-v1.js"
import { ExecManager } from "./codex/exec/manager.js"
import { Fragments } from "./codex/fragments.js"
import { CodexRequest } from "./codex/request.js"
import { CodexVariant } from "./codex/variant.js"
import { Custom } from "./custom.js"
import { DshContext } from "./dsh/context.js"
import { DshPrompt } from "./dsh/prompt.js"
import { DshReadable } from "./dsh/readable.js"
import { DshRequest } from "./dsh/request.js"
import { DshShellTool } from "./dsh/shell-tool.js"
import { DshVariant } from "./dsh/variant.js"
import { Gate } from "./gate.js"
import { Hooks } from "./hooks.js"
import { PiPrompt } from "./pi/prompt.js"
import { PiRequest } from "./pi/request.js"
import { PiShell } from "./pi/shell.js"
import { PiVariant } from "./pi/variant.js"

type Ctx = Pick<Context, "model" | "tool" | "storage" | "location" | "agent">

export interface Input {
  readonly harness: OwnHarness.PreviewHarnessID
  readonly prompt: OwnHarness.PromptID
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly mode?: OwnHarness.ApprovalMode
  readonly directory?: string
}

/** Models to preview when the service has no enabled model: one of each Codex tier. */
const EXAMPLES: ReadonlyArray<OwnHarness.PromptModel> = [
  { providerID: "openai", modelID: "gpt-5.5", name: "GPT-5.5" },
  { providerID: "anthropic", modelID: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { providerID: "anthropic", modelID: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { providerID: "deepseek", modelID: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
]

/** Stands in for core's agent prompt, the system part both harnesses drop. */
const AGENT_PROMPT = "(core's agent prompt)"

/** Core's delegation tool (core/src/tool/plugin/subagent.ts `name`). */
const SUBAGENT = "subagent"

/**
 * What core's `subagent` puts before the parent's text in a new child's first message (core/src/tool/plugin/subagent.ts,
 * `[…, input.prompt].join("\n")`); a continued child gets the parent's text alone. A unit test pins it to core's source.
 */
export const OPENING = "You are a subagent spawned by another session.\n"

/**
 * Core's tool output limit (core/src/tool-output.ts `MAX_LINES`, `MAX_BYTES`): a foreground `subagent` result longer
 * than this keeps its start, and the rest is saved to a file. A unit test pins it to core's constants.
 */
export const CUT = { lines: 2_000, bytes: 50 * 1024 }

/** A Codex v2 child's path as the page names it: any path below `/root` gets the same texts. */
const CHILD_PATH = `${AgentPath.ROOT}/<task_name>`

export function preview(ctx: Ctx, input: Input) {
  return Effect.gen(function* () {
    const catalog = (yield* ctx.model.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))).data
    const enabled = catalog.filter((entry) => entry.enabled)
    const models =
      enabled.length > 0
        ? enabled.map((entry) => ({ providerID: entry.providerID, modelID: entry.id, name: entry.name }))
        : EXAMPLES
    const chosen = pick(models, input.model)
    const entry = catalog.find((item) => item.providerID === chosen.providerID && item.id === chosen.modelID)
    const registered = yield* ctx.tool.list().pipe(Effect.orElseSucceed(() => []))
    const saved = input.harness === "claude-code" ? undefined : yield* Custom.get(ctx, input.harness)
    const setting = {
      model: chosen,
      responses: entry?.package === Hooks.RESPONSES_PACKAGE,
      mode: input.mode ?? "ask",
      cwd: input.directory ?? ctx.location.directory,
      prompt: input.prompt,
      custom: saved?.text,
      tools: input.harness === "claude-code" ? {} : harnessTools(registered, input.harness),
    }
    const built =
      input.harness === "codex"
        ? codex(setting)
        : input.harness === "dsh"
          ? dsh(setting)
          : input.harness === "pi"
            ? pi(setting)
            : claudeCode(setting)
    // Codex replaces core's `subagent` with its agent tools (codex/request.ts) except in Code Mode on a v1 model; the
    // others send core's.
    const subagent =
      ("subagent" in built ? built.subagent : undefined) ?? (yield* core(ctx, registered, chosen.providerID))
    const preview: OwnHarness.PromptPreview = {
      harness: input.harness,
      prompt: input.prompt,
      // `claude-code` has no variants: it always sends Claude Code's own prompt.
      applied:
        input.harness === "claude-code"
          ? "reference"
          : input.prompt === "custom" && saved === undefined
            ? "own"
            : input.prompt,
      model: chosen,
      ...built,
      responses: setting.responses,
      mode: setting.mode,
      ...(saved === undefined ? {} : { custom: saved }),
      models: [...models],
      examples: enabled.length === 0,
      limit: Custom.LIMIT,
      subagent,
    }
    return preview
  })
}

/** `prompt.subagent`: core's `subagent` as a new conversation of OpenCode 기본 gets it (no model, so no MCP renaming). */
export function subagent(ctx: Pick<Ctx, "tool" | "agent">) {
  return Effect.gen(function* () {
    const registered = yield* ctx.tool.list().pipe(Effect.orElseSucceed(() => []))
    return yield* core(ctx, registered, undefined)
  })
}

/**
 * Core's `subagent` as a new conversation's model gets it: the registered description with the "Available subagents:"
 * list core's context hook appends for the session's agent (core/src/tool/plugin/subagent.ts `hook`), here the default
 * agent, which core's `Agent.list` puts first. On the Claude Agent provider the tool goes over MCP under Claude Code's
 * name and length limit.
 */
function core(
  ctx: Pick<Ctx, "agent">,
  registered: ReadonlyArray<Tool.Info & { readonly id: string }>,
  providerID: string | undefined,
) {
  return Effect.gen(function* () {
    const view: OwnHarness.PromptSubagent = { kind: "core", opening: OPENING, guidance: "", cut: CUT }
    const found = registered.find((tool) => tool.id === SUBAGENT)
    if (found === undefined) return view
    const agents = (yield* ctx.agent.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))).data
    const selected = agents.find((agent) => agent.mode !== "subagent" && !agent.hidden)
    const description = selected === undefined ? found.description : withAgents(found.description, agents, selected)
    const tool =
      providerID === OwnHarness.CLAUDE_AGENT
        ? { name: `${CLAUDE_AGENT_PREFIX}${SUBAGENT}`, description: claudeAgent(description) }
        : { name: SUBAGENT, description }
    const result: OwnHarness.PromptSubagent = {
      ...view,
      tool,
      ...(selected === undefined ? {} : { agent: selected.id }),
    }
    return result
  })
}

/** Core's context hook: the subagents `selected` may start, by id, after the description (none: unchanged). */
function withAgents(description: string, agents: ReadonlyArray<Agent.Info>, selected: Agent.Info) {
  const available = agents
    .filter(
      (agent) =>
        agent.mode !== "primary" &&
        !agent.hidden &&
        DshReadable.evaluate(SUBAGENT, agent.id, selected.permissions) !== "deny",
    )
    .toSorted((a, b) => a.id.localeCompare(b.id))
  if (available.length === 0) return description
  return [
    description,
    "",
    "Available subagents:",
    ...available.map(
      (agent) =>
        `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
    ),
  ].join("\n")
}

/** The MCP server prefix of the Claude Agent provider's tools (core plugin/provider/claude-agent/tools/names.ts). */
const CLAUDE_AGENT_PREFIX = "mcp__opencode__"
/** Claude Code cuts an MCP tool's description at this many characters (the same file). */
const CLAUDE_AGENT_LIMIT = 2048

/** `subagent`'s description over MCP: when too long, the subagent list moves first so the cut keeps it. */
function claudeAgent(text: string) {
  if (text.length <= CLAUDE_AGENT_LIMIT) return text
  const agents = text.indexOf("Available subagents:")
  if (agents === -1) return text.slice(0, CLAUDE_AGENT_LIMIT)
  return (text.slice(agents) + "\n\n" + text.slice(0, agents)).slice(0, CLAUDE_AGENT_LIMIT)
}

/**
 * How Codex starts a child for `model`: its v1 tools (the parent's text is the child's first message as it is) or its
 * v2 collaboration tools (a NEW_TASK message carries it, and the child gets the subagent `<multi_agent_role>`).
 * Undefined in Code Mode on a v1 model (GPT-5.6 Luna on Responses), which sends no v1 tools and keeps core's
 * `subagent` (CodexRequest.codeMode).
 */
function codexSubagent(model: Catalog.Model, tools: ReadonlyArray<OwnHarness.PromptTool>, responses: boolean) {
  const v2 = CodexRequest.collaboration(model)
  // The preview builds with `freeform` as `responses`, as a session does (hooks.ts).
  if (!v2 && CodexRequest.codeMode(model, { responses, freeform: responses })) return undefined
  const name = v2 ? Collab.toolName("spawn_agent") : CollabV1.toolName("spawn_agent")
  const tool = tools.find((entry) => entry.name === name)
  const subagent: OwnHarness.PromptSubagent = {
    kind: v2 ? "codex-v2" : "codex-v1",
    ...(tool === undefined ? {} : { tool }),
    opening: v2 ? CodexAgents.interAgentMessage("NEW_TASK", CHILD_PATH, AgentPath.ROOT, "") : "",
    guidance: v2 ? (CodexAgents.roleText({ path: CHILD_PATH, model }) ?? "") : "",
  }
  return subagent
}

interface Setting {
  readonly model: OwnHarness.PromptModel
  readonly responses: boolean
  readonly mode: OwnHarness.ApprovalMode
  readonly cwd: string
  readonly prompt: OwnHarness.PromptID
  readonly custom: string | undefined
  readonly tools: Record<string, { description: string; input: unknown }>
}

function codex(setting: Setting) {
  const model = Catalog.lookup(setting.model.modelID)
  const identity = identityBlock(setting.model)
  const draft: CodexRequest.Draft = {
    system: [SystemPart.make(AGENT_PROMPT), SystemPart.make(identity)],
    messages: [],
    options: {},
    tools: setting.tools,
  }
  const shell = ExecManager.defaultShell().type
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // own's read-only and ask bundles carry the protected denies, so exec_command answers reads (CodexReadOnly.serves).
  const reads = setting.mode !== "full"
  CodexRequest.build(draft, {
    model: setting.model.modelID,
    responses: setting.responses,
    cwd: setting.cwd,
    mode: setting.mode,
    reads,
    shell,
    timezone,
    plan: false,
    skills: [],
    freeform: setting.responses,
    jsonPatch: setting.model.providerID === OwnHarness.CLAUDE_AGENT,
    sessionID: "prompt-preview",
    prompt: setting.prompt,
    custom: setting.custom,
  })
  const sent = setting.responses
    ? draft.messages.flatMap((message) =>
        texts(message).map((text) => ({ role: message.role === "system" ? "developer" : "user", text }) as const),
      )
    : [
        ...draft.system.map((part) => ({ role: "system", text: part.text }) as const),
        ...draft.messages.flatMap((message) => texts(message).map((text) => ({ role: "user", text }) as const)),
      ]
  const parts = sent.map((part, index) => ({
    kind: index === 0 ? ("base" as const) : codexKind(part.text),
    role: part.role,
    text: part.text,
    editable: index === 0,
  }))
  const lean = CodexVariant.lean(model, "own")
  const tools = listed(draft.tools)
  return {
    tier: model.known ? ("catalog" as const) : lean ? ("lean" as const) : ("fallback" as const),
    parts,
    tools,
    changes: codexChanges({ model, lean, identity, mode: setting.mode, reads, cwd: setting.cwd, shell, timezone }),
    starts: { reference: CodexVariant.start(model, "reference"), own: CodexVariant.start(model, "own") },
    subagent: codexSubagent(model, tools, setting.responses),
  }
}

function pi(setting: Setting) {
  const draft: PiRequest.Draft = { system: [SystemPart.make(AGENT_PROMPT)], messages: [], tools: setting.tools }
  const built = PiRequest.build(draft, {
    cwd: setting.cwd,
    responses: setting.responses,
    skills: [],
    prompt: setting.prompt,
    custom: setting.custom,
    guidelines: PiShell.windowsGuidelines(),
  })
  const role = setting.responses ? ("developer" as const) : ("system" as const)
  const parts = Object.entries(built.sections)
    .filter(([, text]) => text.length > 0)
    .map(([name, text]) => ({ kind: piKind(name), role, text, editable: name === "preamble" }))
  return {
    parts,
    tools: listed(draft.tools),
    changes: [
      { id: "pi.catalog", ...PiVariant.CHANGE, part: "catalog" as const, before: "", after: "", applies: true },
    ],
    starts: { reference: PiPrompt.PREAMBLE, own: PiPrompt.PREAMBLE },
  }
}

/**
 * What a `claude-code` session sends. On the Claude Agent provider (core `ClaudeSystemPrompt.make`): Claude Code's own
 * prompt, which Claude Code writes itself, with OpenCode's agent role and instructions appended; core's tools go along
 * as they are. Elsewhere it runs as `opencode`: core's own prompt.
 */
function claudeCode(setting: Setting) {
  const parts =
    setting.model.providerID === OwnHarness.CLAUDE_AGENT
      ? [
          { kind: "base" as const, text: CLAUDE_CODE_PROMPT },
          { kind: "context" as const, text: CLAUDE_CODE_ROLE },
          { kind: "context" as const, text: CLAUDE_CODE_INSTRUCTIONS },
        ]
      : [{ kind: "base" as const, text: OPENCODE_PROMPT }]
  const role = setting.responses ? ("developer" as const) : ("system" as const)
  return {
    parts: parts.map((part) => ({ ...part, role, editable: false })),
    tools: [],
    changes: [],
    starts: { reference: "", own: "" },
  }
}

const CLAUDE_CODE_PROMPT =
  "(Claude Code's own system prompt, its `claude_code` preset, which Claude Code writes itself)"
const CLAUDE_CODE_ROLE = "# Agent role (from OpenCode)\n(the agent's own prompt, when the agent has one)"
const CLAUDE_CODE_INSTRUCTIONS =
  "(OpenCode's instructions: AGENTS.md, skills, MCP guidance and own's entries; Claude Code writes its own date and environment)"
const OPENCODE_PROMPT = "(OpenCode's own prompt: off the Claude Agent provider, claude-code runs as opencode)"

/**
 * dsh's first request: its system prompt section by section, then the messages it adds after the user's first message
 * (the workspace instructions and the skill catalog only in a conversation that has them, so here the runtime context
 * and a time reading taken now).
 */
function dsh(setting: Setting) {
  const draft: DshRequest.Draft = { system: [SystemPart.make(AGENT_PROMPT)], messages: [], tools: setting.tools }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const session = {
    cwd: setting.cwd,
    model: { id: setting.model.modelID, providerID: setting.model.providerID },
    responses: setting.responses,
    skills: [],
    prompt: setting.prompt,
    custom: setting.custom,
    mode: setting.mode,
    timeZone,
  }
  const built = DshRequest.build(draft, session)
  const role = setting.responses ? ("developer" as const) : ("system" as const)
  const revised = DshVariant.revised(setting.prompt)
  const time = DshContext.time({
    now: Date.now(),
    turn: 1,
    step: 1,
    timeZone,
    ...(revised ? { zone: DshVariant.zone(timeZone) } : {}),
  })
  const parts = [
    ...built.sections
      .filter((section) => section.text.length > 0)
      .map((section) => ({
        kind: dshKind(section.name),
        role,
        text: section.text,
        editable: section.name === "deployment:persona-prefix",
      })),
    ...[
      { kind: "agents-md" as const, text: built.context.instructions },
      { kind: "environment" as const, text: built.context.runtime },
      { kind: "skills" as const, text: built.context.skills },
      { kind: "time" as const, text: time },
    ]
      .filter((part) => part.text.length > 0)
      .map((part) => ({ ...part, role: "user" as const, editable: false })),
  ]
  const note = (id: keyof typeof DshVariant.NOTES) => DshVariant.NOTES[id]
  return {
    parts,
    tools: listed(draft.tools),
    changes: [
      {
        id: "dsh.policy",
        ...note("policy"),
        part: "environment" as const,
        before: DshContext.policy(setting.mode, setting.cwd).join("\n\n"),
        after: DshVariant.policy(setting.mode).join("\n\n"),
        applies: true,
      },
      {
        id: "dsh.sandbox",
        ...note("sandbox"),
        part: "tools" as const,
        before: DshShellTool.SANDBOX_SENTENCE,
        after: "",
        applies: true,
      },
      {
        id: "dsh.zone",
        ...note("zone"),
        part: "environment" as const,
        before: DshContext.time({ now: 0, turn: 1, step: 1, timeZone }).split("\n")[1]!,
        after: DshVariant.zone(timeZone),
        applies: true,
      },
      { id: "dsh.catalog", ...note("catalog"), part: "catalog" as const, before: "", after: "", applies: true },
    ] satisfies ReadonlyArray<OwnHarness.PromptChange>,
    starts: { reference: DshPrompt.PERSONA, own: DshPrompt.PERSONA },
  }
}

function dshKind(section: string): OwnHarness.PromptPartKind {
  if (section === "harness:identity") return "harness"
  if (section === "deployment:persona-prefix") return "persona"
  if (section.startsWith("tool:")) return "tools"
  return "context"
}

/** The asked model when given (also one the service does not list), else the first one. */
function pick(models: ReadonlyArray<OwnHarness.PromptModel>, asked: Input["model"]) {
  if (asked === undefined) return models[0]!
  return (
    models.find((model) => model.providerID === asked.providerID && model.modelID === asked.modelID) ?? {
      ...asked,
      name: asked.modelID,
    }
  )
}

/**
 * The harness's own tools as its sessions list them: those carrying its gate action (gate.ts), which only its sessions
 * allow. Core's other tools go along unchanged and are not shown.
 */
function harnessTools(tools: ReadonlyArray<Tool.Info & { readonly id: string }>, harness: OwnHarness.CustomHarnessID) {
  const action = Gate.ACTIONS[harness]
  return Object.fromEntries(
    tools
      .filter((tool) => tool.options?.permission === action)
      .map((tool) => [tool.id, { description: tool.description, input: {} }] as const),
  )
}

function listed(tools: Record<string, { description: string; input: unknown }> | undefined) {
  return Object.entries(tools ?? {}).map(([name, entry]) => ({ name, description: entry.description }))
}

function texts(message: Message) {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
}

/** Core's `# Your Model` block (core/src/plugin/identity.ts), which core puts after the agent prompt. */
function identityBlock(model: OwnHarness.PromptModel) {
  return [
    "# Your Model",
    `- Name: ${model.name}`,
    `- Provider ID: ${model.providerID}`,
    `- Model ID: ${model.modelID}`,
  ].join("\n")
}

function codexKind(text: string): OwnHarness.PromptPartKind {
  if (text.startsWith("# Your Model\n")) return "identity"
  if (text.startsWith("<permissions instructions>")) return "permissions"
  if (text.startsWith("<collaboration_mode>")) return "collaboration"
  // Codex 0.167.0's deferred tool namespaces (`Fragments.deferredTools`).
  if (text.startsWith("<tools>")) return "tools"
  if (text.startsWith("<multi_agent_")) return "agents"
  if (text.startsWith("# AGENTS.md instructions")) return "agents-md"
  if (text.startsWith("<environment_context>")) return "environment"
  return "context"
}

function piKind(section: string): OwnHarness.PromptPartKind {
  if (section === "project_context") return "project"
  if (section === "tools" || section === "rules" || section === "addendum" || section === "skills") return section
  if (section === "cwd") return "cwd"
  return "preamble"
}

/**
 * own's changes to Codex's request (variant.ts), with the texts before and after; `applies` says whether 개선판 makes
 * the change for `model`: the replacements for the fallback tier, the lean text for the lean tier, the rest for both.
 * Codex's own models keep Codex's request under 개선판, so none applies to them.
 */
function codexChanges(input: {
  readonly model: Catalog.Model
  readonly lean: boolean
  readonly identity: string
  readonly mode: OwnHarness.ApprovalMode
  readonly reads: boolean
  readonly cwd: string
  readonly shell: string
  readonly timezone: string
}) {
  const revised = CodexVariant.revised(input.model, "own")
  const fallback = revised && !input.lean
  const environment = (carveOuts: boolean) =>
    Fragments.environment({ cwd: input.cwd, shell: input.shell, timezone: input.timezone, mode: input.mode, carveOuts })
  const spawn = CodexAgentsV1.DEFINITION.tools.find((tool) => tool.name === "spawn_agent")?.description ?? ""
  const note = (id: keyof typeof CodexVariant.NOTES) => CodexVariant.NOTES[id]
  return [
    {
      id: "codex.lean",
      ...note("lean"),
      part: "base",
      before: Catalog.fallbackInstructions(),
      after: CodexVariant.LEAN,
      applies: revised && input.lean,
    },
    ...CodexVariant.REPLACEMENTS.map((item) => ({
      id: `codex.base.${item.id}`,
      title: item.title,
      why: item.why,
      part: "base" as const,
      before: item.from.trim(),
      after: item.to.trim(),
      applies: fallback,
    })),
    {
      id: "codex.identity",
      ...note("identity"),
      part: "identity",
      before: "",
      after: input.identity,
      applies: revised,
    },
    {
      id: "codex.permissions",
      ...note("permissions"),
      part: "permissions",
      before: Fragments.permissions(input.mode, input.cwd),
      after: CodexVariant.permissions(input.mode, input.reads),
      applies: revised,
    },
    {
      id: "codex.environment",
      ...note("environment"),
      part: "environment",
      before: environment(true),
      after: environment(false),
      applies: revised && environment(true) !== environment(false),
    },
    { id: "codex.catalog", ...note("catalog"), part: "catalog", before: "", after: "", applies: revised },
    {
      id: "codex.escalation",
      ...note("escalation"),
      part: "tools",
      before: CodexVariant.ESCALATION_FIELDS.join(", "),
      after: "",
      applies: revised,
    },
    {
      id: "codex.spawn.lean",
      ...note("spawnLean"),
      part: "tools",
      before: spawn,
      after: CodexVariant.SPAWN_AGENT_LEAN,
      applies: revised && input.lean,
    },
    {
      id: "codex.spawn.models",
      ...note("spawnModels"),
      part: "tools",
      before: spawn.slice(0, spawn.indexOf(CodexVariant.SPAWN_AGENT_START)).trim(),
      after: "",
      applies: fallback,
    },
    ...CodexVariant.SPAWN_AGENT_REPLACEMENTS.map((item) => ({
      id: `codex.spawn.${item.id}`,
      title: item.title,
      why: item.why,
      part: "tools" as const,
      before: item.from,
      after: item.to,
      applies: fallback,
    })),
    {
      id: "codex.spawn.effort",
      ...note("reasoningEffort"),
      part: "tools",
      before: "reasoning_effort",
      after: "",
      applies: revised,
    },
  ] satisfies ReadonlyArray<OwnHarness.PromptChange>
}

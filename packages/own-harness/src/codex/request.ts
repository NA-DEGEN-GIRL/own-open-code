// Builds a Codex-shaped request from core's request (10 §3.3): the order of codex-rs/core/src/session/mod.rs
// `build_initial_context_with_world_state` and client.rs (rust-v0.165.0): base instructions as the first developer
// message, one developer message with the context fragments, one user message with AGENTS.md and
// `<environment_context>`, then the conversation with Codex's model updates (incremental.ts on Responses Lite,
// `<model_switch>` elsewhere), deferred tool namespace updates (`<tools>`, rust-v0.167.0) and reasoning-effort updates
// (effort.ts). Everything here is a pure function of the
// request, the stored session state and static data, so the same history gives the same bytes (02 §4.3 D1).
export * as CodexRequest from "./request.js"

import { Message, SystemPart, type TextPart } from "@opencode/ai/effect"
import { Preset } from "@own/protocol/preset"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { History } from "../history.js"
import { Notice } from "../notice.js"
import { Registry } from "../registry.js"
import APPLY_PATCH_GRAMMAR from "../../codex-data/apply_patch.lark" with { type: "text" }
import type { AgentStore } from "./agent-store.js"
import { Baseline } from "./baseline.js"
import { Catalog } from "./catalog.js"
import { CodexVariant } from "./variant.js"
import { AsyncQuestion } from "./async-question.js"
import { SendMessage } from "./send-message.js"
import { CodeModeTools } from "./code-mode-tools.js"
import { CodexCompaction } from "./compaction.js"
import { CodexEffort } from "./effort.js"
import { CodexIncremental } from "./incremental.js"
import { CodexAgents } from "./agents/index.js"
import { Collab } from "./collab.js"
import { CollabV1 } from "./collab-v1.js"
import { CodexAgentsV1 } from "./agents/v1.js"
import { ToolSearch } from "./tool-search.js"
import { Fragments } from "./fragments.js"
import { McpResources } from "./mcp-resources.js"
import { CodexTools } from "./tools.js"
import { Wildcard } from "./wildcard.js"
import { PiVariant } from "../pi/variant.js"

/** Core tools Codex has no counterpart for or replaces with its own (exec_command, apply_patch, request_user_input). */
export const REPLACED = CodexTools.REPLACED

/** Codex's Direct-mode tools, in Codex's order. */
export const CODEX_TOOLS = [
  "exec_command",
  "write_stdin",
  ...McpResources.NAMES,
  "request_user_input",
  "apply_patch",
  "view_image",
  // An up-front namespace lists its tools by name (deferred ones are not sent).
  ...CollabV1.TOOLS.toSorted(),
  "get_goal",
  "create_goal",
  "update_goal",
  ToolSearch.TOOL_NAME,
  "web_search",
]

export interface Draft {
  system: Array<SystemPart>
  messages: Array<Message>
  options: Record<string, unknown>
  tools?: Record<string, { description: string; input: unknown }>
}

export interface Session {
  readonly model: string
  /** The provider speaks OpenAI Responses (developer messages, custom tools). */
  readonly responses: boolean
  /** The Location's directory: Codex's turn cwd. */
  readonly cwd: string
  /** `cwd` resolved as core resolves the folders it walks for AGENTS.md (Baseline.sources); `cwd` when absent. */
  readonly realCwd?: string
  readonly mode: Fragments.Mode
  /**
   * The agent's own rules (a user's config) deny some web search, or could not be read (`searchDenied`): Codex's
   * hosted `web_search` cannot be checked per query, so own's `websearch` goes instead (decisions RL2-M2).
   */
  readonly searchDenied?: boolean
  /** exec_command answers reads itself (read-only or ask with own's protected denies, CodexReadOnly.serves). */
  readonly reads: boolean
  readonly shell: string
  readonly timezone?: string
  readonly plan: boolean
  /** The agent's own system prompt (a config agent's `system`); core's default prompts are replaced by Codex's. */
  readonly agentInstructions?: string
  /** own's skills with their files, for the skills the baseline lists. */
  readonly skills: ReadonlyArray<Fragments.Skill>
  /** The model accepts freeform (grammar) tools on this route (P-020); else apply_patch goes through exec_command. */
  readonly freeform: boolean
  /**
   * apply_patch goes as a JSON function tool (`{input}`, the patch text) where freeform tools cannot: the Claude Agent
   * provider, whose tools reach Claude as MCP tools. The base instructions then point at that tool, not exec_command.
   */
  readonly jsonPatch?: boolean
  /** own's session id: Codex's thread id, which namespaces the ids of prompt-only items. */
  readonly sessionID: string
  /** Ids of the last model-visible message of each turn the user interrupted (core's `idle` marker, `interrupted`). */
  readonly interrupted?: ReadonlySet<string>
  /**
   * The first model-visible message after each change of model, with the model it changed to (`<model_switch>`, or
   * `<model_instructions>` in a Responses Lite window).
   */
  readonly switches?: ReadonlyMap<string, string>
  /** The agent's canonical path in a multi-agent tree; `/root` when absent. */
  readonly agentPath?: string
  /** What this agent forked (collab.ts, collab-v1.ts): the parent's request it starts with, or its history. */
  readonly forked?: AgentStore.Fork
  /** The step's reasoning effort, which selects Codex's `<multi_agent_mode>` text. */
  readonly effort?: string
  /**
   * The session model's variant. Core puts a variant's settings (its reasoning effort) on the model, under the request's
   * own options, so an effort variant is the user's choice even while the request's options name no effort.
   */
  readonly variant?: string
  /** The session's base prompt variant (10 §3.9); absent is Codex's own. */
  readonly prompt?: OwnHarness.PromptID
  /** The user's base instructions (내 지시문, 10 §3.11) under `custom`; without them `custom` runs `own`. */
  readonly custom?: string
  /** The model and variant of each assistant message (one logical LLM call each), by message id (effort.ts). */
  readonly steps?: ReadonlyMap<string, CodexEffort.Step>
  /** The route takes Codex's `configuration_update` items; false on Sign in with ChatGPT, which refuses them. */
  readonly effortUpdates?: boolean
  /** What the request is for (hooks.ts); absent is a sampling request (`context`). */
  readonly kind?: "context" | "compaction" | "generate"
  /** Core's checkpoint metadata by message id (`CodexCompaction.checkpoints`); absent renders checkpoints as core wrote them. */
  readonly checkpoints?: CodexCompaction.Checkpoints
}

export function build(draft: Draft, session: Session) {
  const model = Catalog.lookup(session.model)
  // Codex places its own effort updates (effort.ts), so core's markers at each variant switch give way.
  const route = session.responses && session.effortUpdates !== false && session.kind !== "generate"
  const updates = CodexEffort.enabled(session.model, route)
  const translated = History.translate(
    updates ? draft.messages.filter((entry) => !CodexEffort.isUpdate(entry)) : draft.messages,
    Registry.codex,
  )
    .flatMap((entry) => CodexCompaction.render(entry, session.checkpoints))
    .map(switchNotice)
    .map(agentMessage)
  // A window a Responses Lite model opened keeps the base instructions and collaboration text it opened with
  // (incremental.ts); a later model gets its own as updates in the window.
  const lite = (id: string) => session.responses && Catalog.lookup(id).use_responses_lite
  const opened = CodexIncremental.opener(translated, session.steps ?? new Map(), session.model, lite)
  const first = opened === undefined ? model : Catalog.lookup(opened)
  // The deferred tool namespaces of a model on this route (`<tools>`): the initial context lists the window's, as its
  // first step recorded them, and each later change of model in the window gets what changed (toolUpdates).
  const agentsV1 = draft.tools !== undefined && CollabV1.TOOLS.some((name) => draft.tools?.[name] !== undefined)
  const namespaces = (id: string) => deferredNamespaces(Catalog.lookup(id), session, agentsV1)
  const listed = namespaces(opened ?? CodexIncremental.firstStep(translated, session.steps ?? new Map(), session.model))
  const toolUpdates = namespaceUpdates(translated, session.switches, listed, namespaces)
  // Core's system: [agent prompt, `# Your Model` identity, baseline, parts plugins appended]. The agent prompt and the
  // identity block give way to Codex's base instructions; the baseline is read back; other parts stay as developer text.
  const texts = draft.system.map((part) => part.text)
  const at = texts.findIndex(Baseline.isBaseline)
  const baseline = at < 0 ? undefined : Baseline.parse(texts[at]!)
  // Code Mode models get Codex's `exec` in place of core's `execute`, so core's guidance for `execute` goes too.
  const code = codeMode(model, session)
  const revised = CodexVariant.revised(model, session.prompt)
  const appended = texts.filter(
    (text, index) =>
      index !== 0 && index !== at && (revised || !IDENTITY.test(text)) && !(code && EXECUTE_HINT.test(text)),
  )
  // own's revision lists core's Code Mode tools one line each, as the pi revision does (10 §3.9).
  const catalog =
    revised && baseline?.codemode !== undefined ? PiVariant.codemode(baseline.codemode) : baseline?.codemode
  const files = Baseline.sources(baseline?.instructions ?? [], session.realCwd ?? session.cwd)
  // Config `instructions` (files and URLs) are what Codex's `developer_instructions` setting holds: user text that opens
  // the developer message, here after a config agent's own prompt. Joined with a blank line, as Codex joins its docs.
  const configured = files.configured
    .map((file) => file.content)
    .filter((text) => text !== "")
    .join("\n\n")
  const developer = [
    ...(session.agentInstructions === undefined ? [] : [session.agentInstructions]),
    ...(configured === "" ? [] : [configured]),
    ...(baseline?.contexts ?? []).map((entry) => `<context key="${entry.key}">\n${entry.value}\n</context>`),
    ...[code ? undefined : catalog, baseline?.mcp, baseline?.references].filter((text) => text !== undefined),
    ...(baseline?.rest ?? []),
    ...appended,
    ...[Fragments.skills(session.skills, undefined)].filter((text) => text !== undefined),
    revised ? CodexVariant.permissions(session.mode, session.reads) : Fragments.permissions(session.mode, session.cwd),
    Fragments.collaboration(session.plan, first),
    ...[Fragments.deferredTools(listed)].filter((text) => text !== undefined),
  ]
  // own's global AGENTS.md is Codex's user instructions; the project's go from the root down, as Codex reads them.
  const context = [
    Fragments.agentsMd({
      user: files.global.map((file) => file.content).join("\n\n") || undefined,
      project: files.project.map((file) => file.content),
      cwd: session.cwd,
    }),
    Fragments.environment({
      cwd: session.cwd,
      shell: session.shell,
      date: baseline?.date === undefined ? undefined : Baseline.isoDate(baseline.date),
      timezone: session.timezone,
      mode: session.mode,
      carveOuts: !revised,
    }),
  ].filter((text) => text !== undefined)

  const base = CodexVariant.instructions(first, session.prompt, session.custom, session.jsonPatch)
  // A preserved-prefix fork needs developer messages to keep the parent's request in front (Codex is Responses only).
  // Off Responses a child keeps the conversation of what it inherited, after its own initial context.
  const inherited = session.forked?.kind === "prefix" && session.responses ? session.forked : undefined
  const forkedHistory =
    session.forked?.kind === "history"
      ? session.forked.messages
      : session.forked?.kind === "prefix" && inherited === undefined
        ? session.forked.messages.filter((entry) => entry.role !== "system")
        : []
  const marked = aborted(translated, session.interrupted, model.multi_agent_version === "v2")
  const conversation = [
    ...forkedHistory,
    ...(opened === undefined
      ? switched(marked, session.switches, toolUpdates, session)
      : CodexIncremental.apply({
          history: marked,
          switches: session.switches ?? new Map(),
          opener: opened,
          lite,
          base: (id) => CodexVariant.instructions(Catalog.lookup(id), session.prompt, session.custom),
          collaboration: (id) => Fragments.collaboration(session.plan, Catalog.lookup(id)),
          modelSwitch: (id) => modelSwitch(CodexVariant.instructions(Catalog.lookup(id), session.prompt, session.custom)),
          tools: toolUpdates,
          developer: (texts) => message("system", texts),
        })),
  ]
  // A Code Mode cell's `notify(...)` texts become extra `exec` outputs; elsewhere they stay the user text they were.
  const notified = code ? CodeModeTools.notifications(conversation) : conversation
  // MultiAgentV2 models get `<multi_agent_role>` and `<multi_agent_mode>`, each its own developer message.
  const role = collaboration(model) ? CodexAgents.roleText({ path: session.agentPath, model }) : undefined
  const mode = collaboration(model) ? CodexAgents.modeText({ model, effort: session.effort }) : undefined
  const agents = [role, mode].filter((text) => text !== undefined)
  const prefix = session.responses
    ? [
        message("system", [base]),
        message("system", developer),
        ...agents.map((text) => message("system", [text])),
        message("user", context),
      ]
    : [message("user", context)]
  draft.system =
    inherited !== undefined
      ? [...inherited.system]
      : session.responses
        ? []
        : [SystemPart.make(base), ...[...developer, ...agents].map((text) => SystemPart.make(text))]
  // What the conversation follows: this agent's own initial context, or the request it inherited and what a child adds.
  const lead =
    inherited === undefined
      ? prefix
      : [
          ...inherited.messages,
          ...childContext(inherited, {
            base,
            developer,
            role,
            mode,
            context,
            model: session.model,
            lite: lite(session.model),
            collaboration: Fragments.collaboration(session.plan, first),
          }),
        ]
  // The `additional_tools` item keeps the id of the request it was inherited from, so the copied prefix is identical.
  const thread = inherited?.thread ?? session.sessionID
  if (draft.tools !== undefined) draft.tools = tools(draft.tools, model, session)
  const settled = options(draft.options, model, session, draft.tools, thread)
  const effort =
    typeof settled.reasoningEffort === "string"
      ? settled.reasoningEffort
      : CodexEffort.effortOf(session.model, session.variant)?.value
  // The walk starts at the request's first message: an inherited request carries the parent's updates, and Codex's
  // fork inherits the parent's pin with them (effort.ts). An initial context has no updates and starts no window.
  const placed = updates
    ? CodexEffort.apply({
        history: [...lead, ...notified],
        steps: session.steps ?? new Map(),
        model: session.model,
        effort,
        enabled: (id) => CodexEffort.enabled(id, route),
        sampling: session.kind !== "compaction",
      })
    : undefined
  draft.messages = placed?.history ?? [...lead, ...notified]
  const history = draft.messages.slice(lead.length)
  draft.options = placed === undefined ? settled : { ...settled, reasoningEffort: placed.effort }
  // What a full-history fork of this session's children starts with (collab.ts): the request exactly as built.
  // A request in a Responses Lite window records where the window stands, so a child on another model continues it.
  const window =
    opened === undefined
      ? undefined
      : { model: session.model, base: CodexVariant.instructions(model, session.prompt, session.custom) }
  const input: AgentStore.Prefix | undefined = session.responses
    ? { system: [...draft.system], messages: [...draft.messages], thread, ...(window === undefined ? {} : { window }) }
    : undefined
  return { history, input }
}

/** Codex's notice after a preserved prefix (spawn.rs, rust-v0.165.0), a developer message of its own. */
export const INHERITED_NOTICE =
  "You are now a newly spawned child agent. The preceding conversation is inherited parent context. Follow your own role, identity, and task below; earlier identities, tasks, and action-specific approvals belong to your ancestors. Inherited tool calls are historical records; live tool sessions and process handles are not inherited. Report your result to your parent."

/**
 * What a child adds after the request it inherited, before its own conversation (Codex spawn.rs with
 * `preserve_fork_prefix` and the child's first turn, rust-v0.165.0): the inherited-context notice, its own
 * `<multi_agent_role>`, a `<model_switch>` when its base instructions are not the inherited ones, its developer message
 * and its context message where no inherited message is the same (Codex appends world state that changed), and its
 * `<multi_agent_mode>`. Codex's current-time notices have no counterpart: own sends none.
 * A child on a Responses Lite model whose parent ran a Lite window continues that window (MR8-17, incremental.ts):
 * `<model_instructions>` (its model, and its base when the window's differs) in place of `<model_switch>`, then its
 * `<collaboration_mode>` when the model changed, and its developer message only where more than that text differs.
 */
function childContext(
  inherited: AgentStore.Prefix,
  own: {
    readonly base: string
    readonly developer: ReadonlyArray<string>
    readonly role: string | undefined
    readonly mode: string | undefined
    readonly context: ReadonlyArray<string>
    readonly model: string
    readonly lite: boolean
    readonly collaboration: string
  },
) {
  const present = (role: "system" | "user", texts: ReadonlyArray<string>) =>
    inherited.messages.some(
      (entry) =>
        entry.role === role &&
        entry.content.length === texts.length &&
        entry.content.every((part, index) => part.type === "text" && part.text === texts[index]),
    )
  const window = own.lite ? inherited.window : undefined
  const changed = window !== undefined && window.model !== own.model
  const replaced = window !== undefined && window.base !== own.base
  const updates =
    window === undefined
      ? present("system", [own.base])
        ? []
        : [modelSwitch(own.base)]
      : changed || replaced
        ? [
            CodexIncremental.instructions(changed ? own.model : undefined, replaced ? own.base : undefined),
            ...(changed ? [own.collaboration] : []),
          ]
        : []
  // In a continued window a change of model sends the collaboration text itself; the rest of the developer message
  // goes again only when some other part of it differs from what the child inherited.
  const developer =
    present("system", own.developer) ||
    (changed &&
      inherited.messages.some(
        (entry) =>
          entry.role === "system" &&
          entry.content.length === own.developer.length &&
          entry.content.every(
            (part, index) =>
              part.type === "text" &&
              (own.developer[index] === own.collaboration
                ? part.text.startsWith("<collaboration_mode>")
                : part.text === own.developer[index]),
          ),
      ))
  return [
    message("system", [INHERITED_NOTICE]),
    ...(own.role === undefined ? [] : [message("system", [own.role])]),
    ...updates.map((text) => message("system", [text])),
    ...(developer ? [] : [message("system", own.developer)]),
    ...(own.mode === undefined ? [] : [message("system", [own.mode])]),
    ...(present("user", own.context) ? [] : [message("user", own.context)]),
  ]
}

/** Codex's MultiAgentV2 collaboration tools and texts (agents/index.ts); the others get the v1 agent tools. */
export function collaboration(model: Catalog.Model) {
  return model.multi_agent_version === "v2"
}

/**
 * Codex records a delivered inter-agent message as an `agent_message` item the model reads in its analysis channel;
 * own sends Codex's text-only form, an assistant message. They arrive as synthetic (user) messages (collab.ts).
 */
function agentMessage(entry: Message) {
  const first = entry.content[0]
  if (entry.role !== "user" || entry.content.length !== 1 || first?.type !== "text") return entry
  if (!Collab.isAgentMessage(first.text)) return entry
  return Message.make({ ...entry, role: "assistant", content: [first] })
}

/** Core's hint to move into a worktree through `execute` (core/src/tool/plugin/opencode.ts). */
// `tools.opencode.session.move` since v2.4.0 (#65080), `session_move` before.
const EXECUTE_HINT = /^When you create a worktree .*consider using `execute` to call `tools\.opencode\.session[._]move`/

/** Core's `# Your Model` block (core/src/plugin/identity.ts). */
const IDENTITY = /^# Your Model\n- Name: .*\n- Provider ID: .*\n- Model ID: .*$/

const TURN_ABORTED_BODY =
  "Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed."

/**
 * Codex records `<turn_aborted>` where the user interrupted a turn (core/src/context/turn_aborted.rs): a user message,
 * or a developer one for multi-agent v2 models. It goes after the turn's last message and that message's tool results.
 */
function aborted(history: ReadonlyArray<Message>, ids: ReadonlySet<string> | undefined, developer: boolean) {
  if (ids === undefined || ids.size === 0) return [...history]
  const notice = developer
    ? message("system", [
        `<turn_aborted>\nThe previous turn was interrupted on purpose. ${TURN_ABORTED_BODY}\n</turn_aborted>`,
      ])
    : message("user", [
        `<turn_aborted>\nThe user interrupted the previous turn on purpose. ${TURN_ABORTED_BODY}\n</turn_aborted>`,
      ])
  return history.flatMap((entry, index) => {
    if (history[index + 1]?.role === "tool") return [entry]
    const owner = entry.role === "tool" ? history.slice(0, index).findLast((before) => before.role !== "tool") : entry
    return owner?.id !== undefined && ids.has(owner.id) ? [entry, notice] : [entry]
  })
}

/**
 * Codex's `<model_switch>` in an ordinary window (core/src/context/model_switch_instructions.rs, world_state/model.rs):
 * where the model changed, a developer message with the new model's base instructions goes before the turn that ran
 * on it, then the `<tools>` update when the deferred tool namespaces changed (`toolUpdates`), a message of its own as
 * own sends no `<collaboration_mode>` again here. Routes without developer messages get the notice as user text, like
 * `<turn_aborted>` (they defer no tools).
 */
function switched(
  history: ReadonlyArray<Message>,
  switches: ReadonlyMap<string, string> | undefined,
  toolUpdates: ReadonlyMap<string, string>,
  session: Session,
) {
  if (switches === undefined || switches.size === 0) return [...history]
  return history.flatMap((entry) => {
    const next = entry.id === undefined ? undefined : switches.get(entry.id)
    if (entry.id === undefined || next === undefined) return [entry]
    const text = modelSwitch(
      CodexVariant.instructions(Catalog.lookup(next), session.prompt, session.custom, session.jsonPatch),
    )
    const tools = toolUpdates.get(entry.id)
    return [
      message(session.responses ? "system" : "user", [text]),
      ...(tools === undefined ? [] : [message("system", [tools])]),
      entry,
    ]
  })
}

/**
 * The deferred tool namespaces Codex lists in `<tools>` for a model (`ToolRegistry::deferred_tool_namespaces`): the v1
 * agent tools' `multi_agent_v1` while they sit behind `tool_search` (`shape`), which takes OpenAI Responses, a model
 * with client tool search, Direct tools and no MultiAgentV2 tools, and the agent tools in the request (`agents`).
 */
function deferredNamespaces(model: Catalog.Model, session: Session, agents: boolean): Fragments.Namespaces {
  if (!agents || codeMode(model, session) || collaboration(model) || !search(model, session)) return new Map()
  return new Map([[CodexAgentsV1.NAMESPACE, CodexAgentsV1.NAMESPACE_DESCRIPTION]])
}

/**
 * The `<tools>` update at each change of model in the newest window (Codex's `ToolsState::render_diff` against the
 * window's last snapshot), by the id of the message it goes before. The window starts from the namespaces its initial
 * context listed (`listed`); a change of model before the newest window start gets none, as a new window lists them
 * afresh.
 */
function namespaceUpdates(
  history: ReadonlyArray<Message>,
  switches: ReadonlyMap<string, string> | undefined,
  listed: Fragments.Namespaces,
  namespaces: (model: string) => Fragments.Namespaces,
) {
  const start = history.findLastIndex(CodexEffort.windowStart)
  return history.slice(start + 1).reduce(
    (state, entry) => {
      const target = entry.id === undefined ? undefined : switches?.get(entry.id)
      if (entry.id === undefined || target === undefined) return state
      const next = namespaces(target)
      const update = Fragments.deferredTools(next, state.last)
      return { last: next, updates: update === undefined ? state.updates : state.updates.set(entry.id, update) }
    },
    { last: listed, updates: new Map<string, string>() },
  ).updates
}

function modelSwitch(instructions: string) {
  return `<model_switch>\nThe user was previously using a different model. Please continue the conversation according to the following instructions:\n\n${instructions}\n</model_switch>`
}

/**
 * Codex sends every developer message as input_text items. @opencode/ai joins a system message's parts unless one of
 * them carries its input-text marker in its provider metadata (P-021, `OpenResponses.INPUT_TEXT_KEY`). The marker is
 * never sent.
 */
const INPUT_TEXT = { "opencode.responses.inputText": {} }

function message(role: "system" | "user", texts: ReadonlyArray<string>) {
  const content = texts.map(
    (text, index): TextPart => ({
      type: "text",
      text,
      ...(role === "system" && index === 0 ? { providerMetadata: INPUT_TEXT } : {}),
    }),
  )
  return role === "system" ? Message.make({ role, content }) : Message.make({ role, content })
}

/** The harness switch notice is a synthetic (user) message in core; Codex sends such notices as developer messages. */
function switchNotice(entry: Message) {
  const first = entry.content[0]
  if (entry.role !== "user" || entry.content.length !== 1 || first?.type !== "text") return entry
  if (!first.text.startsWith(`<${Notice.TAG}>`)) return entry
  return Message.make({
    role: "system",
    content: [{ ...first, providerMetadata: { ...first.providerMetadata, ...INPUT_TEXT } }],
  })
}

/** Codex's Code Mode tools (code-mode-tools.ts); `code_mode_only` models get these in place of the Direct ones. */
export const CODE_MODE_TOOLS = ["exec", "wait", CodeModeTools.SLEEP, AsyncQuestion.NAME, SendMessage.NAME]

/** Codex's tools first in Codex's order, then the tools own keeps (subagents, Code Mode, MCP, own plugins). */
function tools(current: NonNullable<Draft["tools"]>, model: Catalog.Model, session: Session) {
  if (codeMode(model, session)) return codeModeTools(current, model, session)
  const visible = CODEX_TOOLS.filter((name) => {
    if (current[name] === undefined) return false
    if (name === "apply_patch")
      return session.jsonPatch === true || (model.apply_patch_tool_type === "freeform" && session.freeform)
    // Codex lists its MCP resource tools while MCP servers are configured (spec_plan.rs `add_mcp_resource_tools`).
    if (McpResources.NAMES.includes(name)) return CodeModeTools.mcpServers(current)
    // MultiAgent v1 models get Codex's v1 agent tools, behind `tool_search` where the model supports it.
    if (CollabV1.TOOLS.includes(name)) return !collaboration(model)
    if (name === ToolSearch.TOOL_NAME) return !collaboration(model) && search(model, session)
    // Hosted search exists on OpenAI Responses only; other models keep own's `websearch`, and so does a session outside
    // full approval (`hostedSearch`).
    if (name === "web_search") return hostedSearch(session) && CodexTools.WEB_SEARCH !== undefined
    return true
  })
  const replaced = hostedSearch(session) ? [...REPLACED, "websearch"] : REPLACED
  const kept = Object.keys(current).filter(
    (name) =>
      !replaced.includes(name) &&
      !CODEX_TOOLS.includes(name) &&
      !CODE_MODE_TOOLS.includes(name) &&
      !agentTool(name, model) &&
      // Codex has no `subagent`: its agent tools replace it.
      name !== "subagent",
  )
  return Object.fromEntries([
    ...[...visible, ...kept].map(
      (name) => [name, shape(name, revise(name, current[name]!, model, session), model, session)] as const,
    ),
    ...collaborationTools(current, model, session),
  ])
}

/**
 * Whether the turn gets Codex's hosted `web_search` in place of own's `websearch`: on OpenAI Responses, in full
 * approval only. The provider runs a hosted search, so no permission is ever asked for it; Codex itself never asks either
 * (outside full access it searches OpenAI's cache, `external_web_access: false`). own's `묻기` and `읽기 전용` ask before
 * each search (MR11), so there the model gets own's `websearch`, which asks with the query (decisions MR12-5). Nor when
 * the agent's own rules deny a search: own-accounts keeps that deny under full approval (MR12-5), which only own's
 * `websearch` meets (decisions RL2-M2).
 */
function hostedSearch(session: Session) {
  return session.responses && session.mode === "full" && session.searchDenied !== true
}

/**
 * Whether an agent's rules deny some `websearch` query: a `deny` matching the action that no later rule for every
 * query (`*` or `**`, allow or ask) lifts. A read-only role's own asks (`Preset.roleWebAsk`) lift nothing, as in
 * own-accounts' `SessionApproval.agentDenies`, which then denies the query under every own bundle.
 */
export function searchDenied(
  agent: string,
  rules: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>,
) {
  const counted = rules.filter((rule) => !Preset.roleWebAsk(agent, rule) && Wildcard.match("websearch", rule.action))
  return counted.some(
    (rule, index) =>
      rule.effect === "deny" &&
      !counted
        .slice(index + 1)
        .some((later) => later.effect !== "deny" && (later.resource === "*" || later.resource === "**")),
  )
}

/**
 * Codex's Code Mode needs the Responses `custom` tool for `exec`; elsewhere the model gets the Direct tools. Code Mode
 * sends no v1 agent tools: a v1 model there keeps core's `subagent` (codeModeTools).
 */
export function codeMode(model: Catalog.Model, session: Pick<Session, "responses" | "freeform">) {
  return model.tool_mode === "code_mode_only" && session.responses && session.freeform
}

/**
 * Code Mode's tools in Codex's order: `exec` (freeform JavaScript, describing the nested tools own runs), `wait`,
 * `request_user_input`, then `clock.sleep` for models with the clock tools. Core's own `execute` (Code Mode) gives way
 * to `exec`. The other tools own keeps (MCP, core's Code Mode tools, other plugins' tools) are nested in `exec` as
 * Codex nests MCP and dynamic tools, from the list the request hook attached (CodeModeTools.attachKept); without one
 * they stay top-level. `subagent` stays top-level.
 */
function codeModeTools(current: NonNullable<Draft["tools"]>, model: Catalog.Model, session: Session) {
  const exec = CodeModeTools.spec("functions", "exec")
  const nested = CodeModeTools.attached(current) ?? []
  const nestedIDs = new Set(nested.map((entry) => entry.id))
  const clock = CodeModeTools.namespace("clock")
  const entries = [
    ...(current.exec === undefined
      ? []
      : [
          [
            "exec",
            {
              description: CodeModeTools.execDescription(
                CodeModeTools.nestedNames(model),
                nested.map((entry) => entry.definition),
              ),
              input: { ...(current.exec.input as object), "x-opencode-freeform": exec.format },
            },
          ] as const,
        ]),
    ...(["wait", "request_user_input"] as const).flatMap((name) =>
      current[name] === undefined ? [] : [[name, current[name]] as const],
    ),
    ...(AsyncQuestion.available(model) && current[AsyncQuestion.NAME] !== undefined
      ? [[AsyncQuestion.NAME, current[AsyncQuestion.NAME]] as const]
      : []),
    ...(SendMessage.available(model) && current[SendMessage.NAME] !== undefined
      ? [[SendMessage.NAME, current[SendMessage.NAME]] as const]
      : []),
    ...(CodeModeTools.clock(model) && current[CodeModeTools.SLEEP] !== undefined
      ? [
          [
            CodeModeTools.SLEEP,
            {
              ...current[CodeModeTools.SLEEP],
              // P-024: sent as `sleep` inside Codex's `clock` namespace.
              input: {
                ...(current[CodeModeTools.SLEEP].input as object),
                "x-opencode-namespace": { namespace: clock.name, name: "sleep", description: clock.description },
              },
            },
          ] as const,
        ]
      : []),
    ...collaborationTools(current, model, session),
  ]
  const kept = Object.keys(current).filter(
    (name) =>
      ![...REPLACED, "websearch", "execute"].includes(name) &&
      !CODEX_TOOLS.includes(name) &&
      !CODE_MODE_TOOLS.includes(name) &&
      !agentTool(name, model) &&
      !nestedIDs.has(name),
  )
  return Object.fromEntries([...entries, ...kept.map((name) => [name, current[name]!] as const)])
}

/** Collaboration tools stay out of the kept tools; with them, own's `subagent` gives way as Codex has no such tool. */
function agentTool(name: string, model: Catalog.Model) {
  return Collab.TOOLS.includes(name) || (collaboration(model) && name === "subagent")
}

/** Codex's `collaboration` namespace for MultiAgentV2 models, placed on the wire by P-024 on OpenAI Responses. */
function collaborationTools(current: NonNullable<Draft["tools"]>, model: Catalog.Model, session: Session) {
  if (!collaboration(model)) return []
  return Collab.TOOLS.flatMap((name) => {
    const entry = current[name]
    if (entry === undefined) return []
    const leaf = name.slice(`${CodexAgents.NAMESPACE}__`.length)
    // Codex lists the account's models in `spawn_agent` (10 §6.14): the served catalog's when there is one.
    const listed = leaf === "spawn_agent" ? Catalog.spawnModels() : undefined
    const described = listed === undefined ? entry : { ...entry, description: withSpawnModels(entry.description, listed) }
    const placed = session.responses
      ? {
          ...(entry.input as object),
          "x-opencode-namespace": {
            namespace: CodexAgents.NAMESPACE,
            name: leaf,
            description: CodexAgents.DEFINITION.description,
          },
        }
      : entry.input
    return [[name, { ...described, input: placed }] as const]
  })
}

/** `spawn_agent`'s description with its model list paragraph (the captured one's) replaced by `listed`. */
function withSpawnModels(description: string, listed: string) {
  return description.replace(
    /(?:Available model overrides \(optional; inherited parent model is preferred\):\n(?:- [^\n]*\n)*|No picker-visible model overrides are currently loaded\.\n)/,
    `${listed}\n`,
  )
}

/** Codex defers tools behind client `tool_search` on models that support it (OpenAI Responses only, P-026). */
function search(model: Catalog.Model, session: Session) {
  return session.responses && model.supports_search_tool === true
}

function shape(name: string, entry: { description: string; input: unknown }, model: Catalog.Model, session: Session) {
  if (name === "apply_patch") return session.jsonPatch === true ? jsonPatch(entry) : freeform(entry)
  // Codex offers `detail` only to models that can ask for original image detail (view_image_spec.rs).
  if (name === "view_image" && model.supports_image_detail_original !== true) return without(entry, ["detail"])
  // P-026: the client tool search definition. Since rust-v0.167.0 (`deferred_tool_world_state`) it no longer lists the
  // deferred tools' sources: the `<tools>` developer fragment names their namespaces instead.
  if (name === ToolSearch.TOOL_NAME)
    return {
      ...entry,
      input: {
        ...(entry.input as object),
        "x-opencode-hosted": ToolSearch.definition(CollabV1.SEARCH_INDEX.sources(), "omit"),
      },
    }
  // P-024: the v1 agent tools in Codex's `multi_agent_v1` namespace, deferred behind tool search (P-026) or up front.
  if (CollabV1.TOOLS.includes(name) && session.responses)
    return {
      ...entry,
      input: {
        ...(entry.input as object),
        "x-opencode-namespace": {
          namespace: CodexAgentsV1.NAMESPACE,
          name: name.slice(`${CodexAgentsV1.NAMESPACE}__`.length),
          description: CodexAgentsV1.NAMESPACE_DESCRIPTION,
          deferred: search(model, session),
        },
      },
    }
  // P-023: `x-opencode-hosted` makes @opencode/ai send Codex's hosted definition in place of a function tool.
  if (name === "web_search")
    return { ...entry, input: { ...(entry.input as object), "x-opencode-hosted": webSearch(model, session) } }
  return entry
}

/**
 * Codex's hosted web search for the turn (hosted_spec.rs, config `resolve_web_search_mode_for_turn`): live search in
 * full access (the only mode that sends it, `hostedSearch`); image results for models whose catalog says so.
 */
function webSearch(model: Catalog.Model, session: Session) {
  const { search_content_types: types, ...rest } = (CodexTools.WEB_SEARCH ?? {}) as Record<string, unknown>
  return {
    ...rest,
    external_web_access: session.mode === "full",
    ...(model.web_search_tool_type === "text_and_image" ? { search_content_types: types ?? ["text", "image"] } : {}),
  }
}

function without(entry: { description: string; input: unknown }, names: ReadonlyArray<string>) {
  const input = entry.input as { properties?: Record<string, unknown> }
  const properties = Object.fromEntries(Object.entries(input.properties ?? {}).filter(([key]) => !names.includes(key)))
  return { ...entry, input: { ...input, properties } }
}

/**
 * own's revision of two Codex tools (10 §3.9): exec_command without the sandbox escalation fields own ignores, and
 * spawn_agent with own's model rule and without `reasoning_effort`, which own's sub-agents do not apply (collab-v1.ts).
 */
function revise(name: string, entry: { description: string; input: unknown }, model: Catalog.Model, session: Session) {
  if (!CodexVariant.revised(model, session.prompt)) return entry
  if (name === "exec_command") return without(entry, CodexVariant.ESCALATION_FIELDS)
  if (name !== CollabV1.toolName("spawn_agent")) return entry
  return {
    ...without(entry, ["reasoning_effort"]),
    description: CodexVariant.spawnAgent(entry.description, CodexVariant.lean(model, session.prompt)),
  }
}

/**
 * apply_patch as Codex sends it: a freeform tool constrained by Codex's grammar. The marker is read by @opencode/ai's
 * Responses lowering (P-020, `OpenResponses.FREEFORM_KEY`); the call still reaches the tool as `{ input }`.
 */
function freeform(entry: { description: string; input: unknown }) {
  const input = entry.input as Record<string, unknown>
  return { ...entry, input: { ...input, "x-opencode-freeform": { syntax: "lark", definition: APPLY_PATCH_GRAMMAR } } }
}

/** apply_patch as a JSON function tool: its `{input}` schema as registered, with a description for that form. */
function jsonPatch(entry: { description: string; input: unknown }) {
  return { ...entry, description: CodexVariant.PATCH_TOOL_DESCRIPTION }
}

/**
 * Codex's request fields where the model catalog sets them and the user did not choose. `thread` names the request's
 * `additional_tools` item: the session itself, or the first session of the full-history fork chain it inherited from.
 */
function options(
  current: Record<string, unknown>,
  model: Catalog.Model,
  session: Session,
  tools: Draft["tools"],
  thread: string,
) {
  const lite = session.responses && model.use_responses_lite
  return {
    ...current,
    // Responses Lite (P-022): tools in an `additional_tools` item whose id hashes them within the session, no parallel
    // calls, and reasoning kept across turns (codex-rs/core/src/client.rs `build_responses_request`).
    parallelToolCalls: model.supports_parallel_tool_calls && !lite,
    ...(lite
      ? {
          responsesLite: { id: `at_${uuidV5(uuidV5(OID_NAMESPACE, thread), JSON.stringify(tools ?? {}))}` },
          reasoningContext: "all_turns",
        }
      : {}),
    // Codex always sends `tool_choice: "auto"` (P-022 `toolChoiceAuto`), and since 0.165.0 it replays a function call
    // with the `completed` status the server gave it (P-022 `completedCalls`).
    ...(session.responses ? { toolChoiceAuto: true, completedCalls: true } : {}),
    ...(model.support_verbosity && model.default_verbosity !== null ? { textVerbosity: model.default_verbosity } : {}),
    // The catalog's default effort only where the user chose none: an effort variant's own setting sits under these
    // options (Codex's `effective_reasoning_effort`: the selection, else the model's default).
    ...(current.reasoningEffort === undefined &&
    (session.variant === undefined || session.variant === "default") &&
    model.default_reasoning_level !== null
      ? { reasoningEffort: model.default_reasoning_level }
      : {}),
    // Codex asks for reasoning summaries only when the catalog's default is not `none` (every GPT model today). The
    // OpenAI provider defaults GPT-5 models to `auto`; a null option replaces that default and decodes as absent.
    ...(model.default_reasoning_summary === "none" ? { reasoningSummary: null } : {}),
    // Otherwise Codex asks for the catalog's summary level (`auto` outside the catalog) unless the user chose one.
    ...(model.default_reasoning_summary !== "none" && session.responses && current.reasoningSummary === undefined
      ? { reasoningSummary: model.default_reasoning_summary }
      : {}),
  }
}

/** `Uuid::NAMESPACE_OID`. */
const OID_NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

/** RFC 4122 version 5 UUID (SHA-1 of namespace bytes and name). */
function uuidV5(namespace: string, name: string) {
  const hasher = new Bun.CryptoHasher("sha1")
  hasher.update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
  hasher.update(name)
  const bytes = hasher.digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

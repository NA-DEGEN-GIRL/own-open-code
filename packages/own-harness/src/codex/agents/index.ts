// Ports Codex's MultiAgentV2 collaboration tools (`collaboration.spawn_agent`, `followup_task`, `send_message`,
// `wait_agent`, `interrupt_agent`, `list_agents`) and the model-facing texts around them, on top of a `Host` that own
// implements with child sessions. Sources: codex-rs/core/src/tools/handlers/multi_agents_v2*.rs and
// multi_agents_common.rs (arguments, errors, outputs), core/src/agent/control*.rs (target resolution, interruption
// rules, execution capacity, listing, delivery), core/src/agent/control/{delivery,completion}.rs and
// core/src/session_prefix.rs (inter-agent messages), core/src/context/inter_agent_*.rs, core/src/session/multi_agents.rs
// and codex-rs/prompts/src/{multi_agent_instructions.rs,model_messages/multi_agent.rs} (`<multi_agent_role>` and
// `<multi_agent_mode>`), core/src/context/world_state/{multi_agent_mode,multi_agent_usage_hint}.rs and
// core/src/session/world_state.rs (`<subagents>` in the environment context).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
//
// Codex owns the agent tree in-process (one thread per agent). Here the Host owns it: it creates and runs child
// sessions, keeps each agent's status and mailbox, inserts delivered messages into the recipient's history, and
// reports the parent's terminal-turn notifications through `completion`. The handlers only validate, resolve targets
// and enforce the rules Codex enforces before reaching its controller.
export * as CodexAgents from "./index.js"

import models from "../../../codex-data/models.json" with { type: "json" }
import CAPTURE from "../../../codex-data/code-mode.win32.json" with { type: "json" }
import { RustStr } from "../apply-patch/rust-str.js"
import { Catalog } from "../catalog.js"
import { Truncate } from "../truncate/index.js"
import { AgentArgs } from "./args.js"
import { AgentPath } from "./path.js"

// ---------------------------------------------------------------------------------------------------------------
// Configuration (codex-rs/core/src/config/mod.rs, MultiAgentV2Config defaults)

/** `max_concurrent_threads_per_session`: agents that may run at once, the root included. */
export const DEFAULT_MAX_CONCURRENT_THREADS_PER_SESSION = 4
export const MIN_WAIT_TIMEOUT_MS = 10_000
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000
export const MAX_WAIT_TIMEOUT_MS = 3_600_000
export const NAMESPACE = "collaboration"

export interface Config {
  /**
   * `features.multi_agent_v2.max_concurrent_threads_per_session`, or `agents.max_concurrent_threads_per_session + 1`
   * when only that is configured. The role text advertises this number; spawned agents may run `value - 1` turns at
   * once (`effective_agent_max_threads` for V2), because the root is never counted.
   */
  readonly maxConcurrentThreadsPerSession: number
  readonly minWaitTimeoutMs: number
  readonly maxWaitTimeoutMs: number
  readonly defaultWaitTimeoutMs: number
  /** `hide_spawn_agent_metadata` (default true): `spawn_agent` answers `{"task_name"}` without `nickname`. */
  readonly hideSpawnAgentMetadata: boolean
}

export const DEFAULT_CONFIG: Config = {
  maxConcurrentThreadsPerSession: DEFAULT_MAX_CONCURRENT_THREADS_PER_SESSION,
  minWaitTimeoutMs: MIN_WAIT_TIMEOUT_MS,
  maxWaitTimeoutMs: MAX_WAIT_TIMEOUT_MS,
  defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
  hideSpawnAgentMetadata: true,
}

interface Definition {
  readonly type: string
  readonly name: string
  readonly description: string
  readonly tools?: ReadonlyArray<unknown>
}

/**
 * The `collaboration` namespace exactly as Codex sent it for a gpt-6 root agent (codex-data/code-mode.win32.json).
 * Codex builds `spawn_agent`'s description from the account's model list, so that paragraph is account-specific.
 */
export const DEFINITION = (CAPTURE.tools as ReadonlyArray<Definition>).find((tool) => tool.name === NAMESPACE)!

// ---------------------------------------------------------------------------------------------------------------
// The agent tree the Host maintains

/** Codex's `AgentStatus`, in its serde JSON shape (`"running"`, `{"completed": "…"}`, …). */
export type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { readonly completed: string | null }
  | { readonly errored: string }

export interface Agent {
  /** Stable id (Codex: the thread id); tools accept it as a target as well as the path. */
  readonly id: string
  /** Canonical task name: `/root`, `/root/<task_name>`, `/root/<task_name>/<child>`, … */
  readonly path: string
  readonly status: AgentStatus
  readonly nickname?: string
}

/** One inter-agent message (Codex's `InterAgentCommunication` with plaintext content). */
export interface Communication {
  readonly author: string
  readonly recipient: string
  /** The model-visible text: `Message Type: …\nTask name: <recipient>\nSender: <author>\nPayload:\n<payload>`. */
  readonly content: string
  /**
   * True for NEW_TASK (`spawn_agent`, `followup_task`): start a turn when the recipient is idle, otherwise steer into its
   * running turn at the next sampling boundary. False for MESSAGE and FINAL_ANSWER: queue in the mailbox and show it at
   * the recipient's next sampling boundary (its next turn when idle) without starting a turn.
   */
  readonly triggerTurn: boolean
}

/** `fork_turns`: `none` starts empty; `all` (also any positive turn count, accepted as legacy) forks the full history. */
export type Fork = "none" | "all"

export interface SpawnOverrides {
  readonly fork: Fork
  /** `model` as the model sent it; Codex validates it against the account's model list. */
  readonly model?: string
  /** `reasoning_effort` as sent (non-empty); Codex validates it against the selected model's levels. */
  readonly reasoningEffort?: string
  /** `agent_type` (trimmed, non-empty): a configured role; hidden from the captured schema but still accepted. */
  readonly agentType?: string
}

export interface SpawnRequest extends SpawnOverrides {
  readonly parent: Agent
  /** The child's canonical path, `<parent path>/<task_name>`. */
  readonly path: string
  /** The initial NEW_TASK message, author = parent path, recipient = child path, `triggerTurn` true. */
  readonly communication: Communication
}

/** Why `wait_agent` returned: mailbox activity for the caller, new user input steered into its turn, or the deadline. */
export type WaitOutcome = "mailbox" | "steered" | "timed_out"

/**
 * What own implements on top of its child sessions. Methods reject with `AgentError` to answer the model with
 * Codex's text; any other rejection is a host failure and propagates.
 */
export interface Host {
  /** Every live agent of the caller's tree, the root included (Codex's registry; closed or shut-down agents omitted). */
  list(): Promise<ReadonlyArray<Agent>>
  /**
   * Validates overrides before anything is created (Codex's `prepare_agent_spawn_config`); resolves to the error text
   * to answer, e.g. `unknownModel(...)` or `unsupportedEffort(...)`. Full-history forks still apply overrides.
   */
  prepareSpawn?(caller: Agent, overrides: SpawnOverrides): Promise<string | undefined>
  /**
   * Creates the child session at `request.path` (its history: none, or for a full-history fork the parent's
   * model-visible input unchanged, then the subagent `roleText`), delivers `request.communication` and starts its turn.
   * Resolves to the new agent.
   */
  spawn(request: SpawnRequest): Promise<Agent>
  /** `followup_task`: deliver a NEW_TASK and start a turn if the target is idle (steer it in if running). */
  followup(target: Agent, communication: Communication): Promise<void>
  /** `send_message`: queue a MESSAGE on the target without starting a turn. */
  send(target: Agent, communication: Communication): Promise<void>
  /** Interrupts the target's current turn, if any; the agent stays available. */
  interrupt(target: Agent): Promise<void>
  /**
   * Waits until a message is queued for (or already pending on) the caller, new user input is steered into the
   * caller's turn, or `timeoutMs` passes. It does not consume the messages: they enter history as usual.
   */
  wait(caller: Agent, timeoutMs: number): Promise<WaitOutcome>
}

/** A Host rejection Codex reports to the model (`FunctionCallError::RespondToModel`). */
export class AgentError extends Error {}

export interface Context {
  readonly host: Host
  /** Canonical path of the calling agent (`/root` for the user's session). */
  readonly caller: string
  readonly config?: Config
}

/** A `function_call_output`: its text and Codex's `success` flag (absent for `wait_agent`). */
export interface Output {
  readonly text: string
  readonly success: boolean | undefined
}

export type ToolName =
  | "spawn_agent"
  | "followup_task"
  | "send_message"
  | "wait_agent"
  | "interrupt_agent"
  | "list_agents"

export const TOOL_NAMES: ReadonlyArray<ToolName> = [
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_message",
  "spawn_agent",
  "wait_agent",
]

// ---------------------------------------------------------------------------------------------------------------
// Handlers

/** Runs one collaboration tool call from its raw JSON arguments. */
export function handle(tool: ToolName, args: string, context: Context): Promise<Output> {
  return answer(() => HANDLERS[tool](args, context))
}

const HANDLERS: Readonly<Record<ToolName, (args: string, context: Context) => Promise<Output>>> = {
  spawn_agent: spawnAgent,
  followup_task: (args, context) => message("followup_task", args, context),
  send_message: (args, context) => message("send_message", args, context),
  wait_agent: waitAgent,
  interrupt_agent: interruptAgent,
  list_agents: listAgents,
}

const SPAWN_ARGS: AgentArgs.Struct = {
  name: "SpawnAgentArgs",
  fields: [
    { name: "message", type: "string", required: true },
    { name: "task_name", type: "string", required: true },
    { name: "agent_type", type: "string" },
    { name: "model", type: "string" },
    { name: "reasoning_effort", type: "effort" },
    { name: "fork_turns", type: "string" },
    { name: "fork_context", type: "bool" },
  ],
}

const MESSAGE_ARGS: Readonly<Record<"send_message" | "followup_task", AgentArgs.Struct>> = {
  send_message: {
    name: "SendMessageArgs",
    fields: [
      { name: "target", type: "string", required: true },
      { name: "message", type: "string", required: true },
    ],
  },
  followup_task: {
    name: "FollowupTaskArgs",
    fields: [
      { name: "target", type: "string", required: true },
      { name: "message", type: "string", required: true },
    ],
  },
}

const WAIT_ARGS: AgentArgs.Struct = { name: "WaitArgs", fields: [{ name: "timeout_ms", type: "i64" }] }
const INTERRUPT_ARGS: AgentArgs.Struct = {
  name: "InterruptAgentArgs",
  fields: [{ name: "target", type: "string", required: true }],
}
const LIST_ARGS: AgentArgs.Struct = { name: "ListAgentsArgs", fields: [{ name: "path_prefix", type: "string" }] }

const EMPTY_MESSAGE = "Empty message can't be sent to an agent"
const AGENT_LIMIT = "agent thread limit reached"

async function spawnAgent(args: string, context: Context): Promise<Output> {
  const values = decode(SPAWN_ARGS, args)
  if (values.has("fork_context"))
    return failure("fork_context is not supported in MultiAgentV2; use fork_turns instead")
  const fork = forkMode(text(values, "fork_turns"))
  if (fork === undefined) return failure("fork_turns must be `none` or `all`")
  const message = text(values, "message") ?? ""
  if (RustStr.trim(message) === "") return failure(EMPTY_MESSAGE)
  const agentType = RustStr.trim(text(values, "agent_type") ?? "")
  const overrides: SpawnOverrides = {
    fork,
    model: text(values, "model"),
    reasoningEffort: text(values, "reasoning_effort"),
    agentType: agentType === "" ? undefined : agentType,
  }
  const config = context.config ?? DEFAULT_CONFIG
  const agents = await context.host.list()
  const caller = callerAgent(agents, context.caller)
  const rejected = await context.host.prepareSpawn?.(caller, overrides)
  if (rejected !== undefined) return failure(rejected)
  const joined = AgentPath.join(caller.path, text(values, "task_name") ?? "")
  if (!joined.ok) return failure(joined.error)
  if (!hasCapacity(agents, config)) return failure(`collab spawn failed: ${AGENT_LIMIT}`)
  if (agents.some((agent) => agent.path === joined.path)) return failure(`agent path \`${joined.path}\` already exists`)
  const spawned = await context.host.spawn({
    ...overrides,
    parent: caller,
    path: joined.path,
    communication: {
      author: caller.path,
      recipient: joined.path,
      content: interAgentMessage("NEW_TASK", joined.path, caller.path, message),
      triggerTurn: true,
    },
  })
  const result = config.hideSpawnAgentMetadata
    ? { task_name: joined.path }
    : { task_name: joined.path, nickname: spawned.nickname ?? null }
  return { text: JSON.stringify(result), success: true }
}

async function message(tool: "send_message" | "followup_task", args: string, context: Context): Promise<Output> {
  const values = decode(MESSAGE_ARGS[tool], args)
  const payload = text(values, "message") ?? ""
  if (RustStr.trim(payload) === "") return failure(EMPTY_MESSAGE)
  const agents = await context.host.list()
  const caller = callerAgent(agents, context.caller)
  const target = resolveTarget(agents, caller, text(values, "target") ?? "")
  if (typeof target === "string") return failure(target)
  const followup = tool === "followup_task"
  if (followup && AgentPath.isRoot(target.path)) return failure("Follow-up tasks can't target the root agent")
  // An idle recipient needs a free execution slot to start its turn; a running one takes the task in place.
  if (followup && !isActive(target) && !hasCapacity(agents, context.config ?? DEFAULT_CONFIG))
    return failure(`collab tool failed: ${AGENT_LIMIT}`)
  const communication: Communication = {
    author: caller.path,
    recipient: target.path,
    content: interAgentMessage(followup ? "NEW_TASK" : "MESSAGE", target.path, caller.path, payload),
    triggerTurn: followup,
  }
  await (followup ? context.host.followup(target, communication) : context.host.send(target, communication))
  return { text: "", success: true }
}

async function waitAgent(args: string, context: Context): Promise<Output> {
  const values = decode(WAIT_ARGS, args)
  const config = context.config ?? DEFAULT_CONFIG
  const requested = values.get("timeout_ms")
  const timeoutMs = (() => {
    if (typeof requested !== "bigint") return config.defaultWaitTimeoutMs
    if (requested > BigInt(config.maxWaitTimeoutMs)) return undefined
    return Math.max(Number(requested), config.minWaitTimeoutMs)
  })()
  if (timeoutMs === undefined) return failure(`timeout_ms must be at most ${config.maxWaitTimeoutMs}`)
  const agents = await context.host.list()
  const outcome = await context.host.wait(callerAgent(agents, context.caller), timeoutMs)
  const summary = WAIT_SUMMARY[outcome]
  const clamped =
    typeof requested === "bigint" && requested < BigInt(timeoutMs)
      ? `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeoutMs}ms.`
      : ""
  return {
    text: JSON.stringify({ message: `${summary}${clamped}`, timed_out: outcome === "timed_out" }),
    success: undefined,
  }
}

const WAIT_SUMMARY: Readonly<Record<WaitOutcome, string>> = {
  mailbox: "Wait completed.",
  steered: "Wait interrupted by new input.",
  timed_out: "Wait timed out.",
}

async function interruptAgent(args: string, context: Context): Promise<Output> {
  const values = decode(INTERRUPT_ARGS, args)
  const agents = await context.host.list()
  const caller = callerAgent(agents, context.caller)
  const target = resolveTarget(agents, caller, text(values, "target") ?? "")
  if (typeof target === "string") return failure(target)
  if (AgentPath.isRoot(target.path)) return failure("root is not a spawned agent")
  if (target.path === caller.path)
    return failure("an agent cannot interrupt itself; return your result and let the parent interrupt you if needed")
  await context.host.interrupt(target)
  return { text: JSON.stringify({ previous_status: target.status }), success: true }
}

async function listAgents(args: string, context: Context): Promise<Output> {
  const values = decode(LIST_ARGS, args)
  const agents = await context.host.list()
  const caller = callerAgent(agents, context.caller)
  const reference = text(values, "path_prefix")
  const prefix = reference === undefined ? undefined : AgentPath.resolve(caller.path, reference)
  if (prefix !== undefined && !prefix.ok) return failure(prefix.error)
  const matches = (path: string) => prefix === undefined || matchesPrefix(path, prefix.path)
  const root = agents.filter((agent) => AgentPath.isRoot(agent.path) && matches(agent.path))
  const others = agents
    .filter((agent) => !AgentPath.isRoot(agent.path) && matches(agent.path))
    .toSorted((left, right) => compare(left.path, right.path) || compare(left.id, right.id))
  const listed = [...root, ...others].map((agent) => ({ agent_name: agent.path, agent_status: agent.status }))
  return { text: JSON.stringify({ agents: listed }), success: true }
}

/**
 * Thrown by `decode` so each handler reads as its happy path; `answer` turns it into the failure output (the V1 tools
 * in ./v1.ts share these).
 */
class Rejection {
  constructor(readonly text: string) {}
}

export async function answer(run: () => Promise<Output>): Promise<Output> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Rejection) return failure(error.text)
    if (error instanceof AgentError) return failure(error.message)
    throw error
  }
}

export function decode(struct: AgentArgs.Struct, args: string) {
  const parsed = AgentArgs.parse(struct, args)
  if (!parsed.ok) throw new Rejection(parsed.error)
  return parsed.values
}

export function failure(text: string): Output {
  return { text, success: false }
}

function text(values: ReadonlyMap<string, AgentArgs.Value>, name: string) {
  const value = values.get(name)
  return typeof value === "string" ? value : undefined
}

/** `SpawnAgentArgs::fork_mode`: trimmed, case-insensitive `none`/`all`, or a positive turn count (treated as `all`). */
function forkMode(forkTurns: string | undefined): Fork | undefined {
  const trimmed = RustStr.trim(forkTurns ?? "")
  const value = trimmed === "" ? "all" : trimmed
  if (asciiLower(value) === "none") return "none"
  if (asciiLower(value) === "all") return "all"
  // Rust's `usize::from_str` for `NonZeroUsize`: an optional `+`, ASCII digits, no overflow, not zero.
  const digits = value.startsWith("+") ? value.slice(1) : value
  if (!/^[0-9]+$/.test(digits)) return undefined
  const count = BigInt(digits)
  return count > 0n && count <= 2n ** 64n - 1n ? "all" : undefined
}

function asciiLower(value: string) {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

function callerAgent(agents: ReadonlyArray<Agent>, path: string): Agent {
  return agents.find((agent) => agent.path === path) ?? { id: "", path, status: "running" }
}

/**
 * Codex's `resolve`: an agent id first, then a task name relative to the caller or an absolute path. Unknown UUID-shaped
 * ids answer as Codex does for an unknown thread id.
 */
function resolveTarget(agents: ReadonlyArray<Agent>, caller: Agent, target: string): Agent | string {
  const byId = agents.find((agent) => agent.id !== "" && agent.id === target)
  if (byId !== undefined) return byId
  const uuid = threadId(target)
  if (uuid !== undefined) {
    const known = agents.find((agent) => threadId(agent.id) === uuid)
    return known ?? `agent with id ${uuid} not found`
  }
  const resolved = AgentPath.resolve(caller.path, target)
  if (!resolved.ok) return resolved.error
  return agents.find((agent) => agent.path === resolved.path) ?? `live agent path \`${resolved.path}\` not found`
}

/** `ThreadId::from_string` (a UUID in hyphenated, simple, braced or URN form), displayed hyphenated lowercase. */
function threadId(value: string) {
  const bare = value.replace(/^urn:uuid:/i, "").replace(/^\{(.*)\}$/, "$1")
  const hex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare)
    ? bare.replaceAll("-", "")
    : /^[0-9a-f]{32}$/i.test(bare)
      ? bare
      : undefined
  if (hex === undefined) return undefined
  const lower = hex.toLowerCase()
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`
}

function isActive(agent: Agent) {
  return agent.status === "running" || agent.status === "pending_init"
}

/**
 * `ensure_execution_capacity`: spawned agents may run `max_concurrent_threads_per_session - 1` turns at once; the root
 * is never limited or counted.
 */
function hasCapacity(agents: ReadonlyArray<Agent>, config: Config) {
  const active = agents.filter((agent) => !AgentPath.isRoot(agent.path) && isActive(agent)).length
  return active < Math.max(config.maxConcurrentThreadsPerSession - 1, 0)
}

function matchesPrefix(path: string, prefix: string) {
  if (AgentPath.isRoot(prefix)) return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

function compare(left: string, right: string) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

// ---------------------------------------------------------------------------------------------------------------
// Messages between agents

export type MessageType = "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER"

/** `InterAgentMessage` / `InterAgentCompletionMessage` bodies (no markers). */
export function interAgentMessage(type: MessageType, taskName: string, sender: string, payload: string) {
  return `Message Type: ${type}\nTask name: ${taskName}\nSender: ${sender}\nPayload:\n${payload}`
}

const ERROR_MAX_TOKENS = 900
const ERROR_NEXT_ACTION =
  "This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task."
const GUARDIAN_NEXT_ACTION =
  "Tell the user this agent stopped after repeated Guardian denials. Do not resume this agent or retry its blocked work until the user explicitly confirms that it should continue."

/**
 * The FINAL_ANSWER a child sends its parent when one of its turns ends (`notify_parent_of_terminal_turn`): undefined
 * while it is pending, running or interrupted (an interrupted turn notifies nobody). It queues without starting a
 * parent turn. `guardian` is the Guardian-denial variant for an errored turn.
 */
export function completion(child: string, status: AgentStatus, guardian = false): Communication | undefined {
  const parent = AgentPath.parent(child)
  if (parent === undefined) return undefined
  const payload = completionPayload(status, guardian)
  if (payload === undefined) return undefined
  return {
    author: child,
    recipient: parent,
    content: interAgentMessage("FINAL_ANSWER", parent, child, payload),
    triggerTurn: false,
  }
}

function completionPayload(status: AgentStatus, guardian: boolean) {
  if (status === "pending_init" || status === "running" || status === "interrupted") return undefined
  if (status === "shutdown") return "Agent shut down."
  if (status === "not_found") return "Agent was not found."
  if ("completed" in status) return status.completed ?? ""
  const error = Truncate.truncateText(status.errored, { mode: "tokens", limit: ERROR_MAX_TOKENS })
  return guardian
    ? `Agent interrupted by Guardian: ${error}\n\n${GUARDIAN_NEXT_ACTION}`
    : `Agent errored: ${error}\n\n${ERROR_NEXT_ACTION}`
}

/**
 * How Codex records a delivered message in the recipient's history (`InterAgentCommunication::to_model_input_item`):
 * a Responses API `agent_message` item, which the model sees in its analysis channel addressed `to=<recipient>`. Its
 * text-only fallback form (the `ContextualUserFragment`) is an `assistant`-role message with the same text.
 */
export function agentMessageItem(communication: Communication) {
  return {
    type: "agent_message",
    author: communication.author,
    recipient: communication.recipient,
    content: [{ type: "input_text", text: communication.content }],
  } as const
}

// ---------------------------------------------------------------------------------------------------------------
// `<multi_agent_role>` and `<multi_agent_mode>`

export const ROOT_ROLE = `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent without triggering a turn.
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the \`fork_turns\` parameter.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
They may be addressed as to=/root
`

export const SUBAGENT_ROLE = `You are an agent in a team of agents collaborating to complete a task.

You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent.
Child agents can also spawn their own sub-agents.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
You may also see them addressed as to=/root/..., which indicates your identity is /root/...
`

const SHARED_GUIDANCE = `Note that collaboration tools cannot be called from inside \`functions.exec\`. Call \`spawn_agent\`, \`send_message\`, \`followup_task\`, \`wait_agent\`, \`interrupt_agent\`, and \`list_agents\` only as direct tool calls using the recipient shown in their tool definitions, such as \`to=functions.collaboration.spawn_agent\`, since they are intentionally absent from the \`functions.exec\` \`tools.*\` namespace. Available tools in \`functions.exec\` are explicitly described with a \`tools\` namespace in the developer message.

All agents share the same directory. In detail:
- All agents have access to the same container and filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.
`

const WAIT_GUIDANCE = "When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling."
const MODEL_OVERRIDE_GUIDANCE =
  'Full-history forks (`fork_turns` omitted or `"all"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `"none"`.'

export const EXPLICIT_MODE =
  "Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work."
export const PROACTIVE_MODE =
  "Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.\n\nIf at any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality."

const MULTI_AGENT_MODE_MAX_TOKENS = 400

/** `model_messages.multi_agent` of a catalog entry. */
export interface MultiAgentMessages {
  readonly role?: { readonly root?: string | null; readonly subagent?: string | null } | null
  readonly mode?: {
    readonly explicit?: string | null
    readonly proactive?: string | null
    readonly hint_text?: string | null
  } | null
}

/** The role texts the catalog ships (every catalog model that has them shares one set: the gpt-6 family). */
const CATALOG_MULTI_AGENT = (models.models as ReadonlyArray<{ readonly model_messages?: unknown }>)
  .map((model) => readMultiAgent(model.model_messages))
  .find((messages) => messages?.role?.root !== undefined && messages.role.root !== null)

export function multiAgentMessages(model: Catalog.Model) {
  return readMultiAgent(model.model_messages)
}

function readMultiAgent(modelMessages: unknown): MultiAgentMessages | undefined {
  if (typeof modelMessages !== "object" || modelMessages === null || !("multi_agent" in modelMessages)) return undefined
  const value = modelMessages.multi_agent
  if (typeof value !== "object" || value === null) return undefined
  return value
}

export interface RoleOptions {
  /** The agent's canonical path. Codex does not interpolate it: `/root` gets the root text, any other path the subagent text. */
  readonly path?: string
  /** `max_concurrent_threads_per_session` (default 4). */
  readonly slots?: number
  /** Overrides the choice made from `path`. */
  readonly subagent?: boolean
  /**
   * The agent's catalog model. A model whose catalog entry has a role text gets it wrapped in `<multi_agent_role>`; one
   * without gets Codex's bundled text, unwrapped. Omitted: the catalog's role texts (what gpt-6 models get).
   */
  readonly model?: Catalog.Model
  /** `root_agent_usage_hint_text` / `subagent_usage_hint_text`: sent verbatim, unwrapped; empty suppresses the role. */
  readonly configured?: string
  /** `wait_agent_enabled` (default true). */
  readonly waitAgent?: boolean
  /** `expose_spawn_agent_model_overrides` (default true). */
  readonly modelOverrides?: boolean
  /** True when update_plan is off and no custom catalog is configured (own: always), dropping plan-tool sections. */
  readonly omitUpdatePlan?: boolean
}

/**
 * The `<multi_agent_role>` developer message of a V2 agent (`MultiAgentRoleInstructions`), or undefined when
 * suppressed. Codex sends it as its own developer message after the main developer message, for the root and for
 * thread-spawned subagents, and again only when the rendered text changes.
 */
export function roleText(options: RoleOptions = {}) {
  const subagent = options.subagent ?? !AgentPath.isRoot(options.path ?? AgentPath.ROOT)
  if (options.configured !== undefined) return options.configured === "" ? undefined : options.configured
  const catalog = options.model === undefined ? CATALOG_MULTI_AGENT : multiAgentMessages(options.model)
  const fromCatalog = subagent ? catalog?.role?.subagent : catalog?.role?.root
  const base = fromCatalog ?? (subagent ? SUBAGENT_ROLE : ROOT_ROLE)
  if (base === "") return undefined
  const slots = options.slots ?? DEFAULT_MAX_CONCURRENT_THREADS_PER_SESSION
  const filtered = (options.omitUpdatePlan ?? true) ? Catalog.withoutUpdatePlan(base) : base
  const wait = (options.waitAgent ?? true) ? `${WAIT_GUIDANCE}\n\n` : ""
  const overrides = (options.modelOverrides ?? true) ? `\n\n${MODEL_OVERRIDE_GUIDANCE}` : ""
  const body = `${filtered}\n${SHARED_GUIDANCE}\n${wait}There are ${slots} available concurrency slots, meaning that up to ${slots} agents can be active at once, including you.${overrides}`
  return fromCatalog === undefined || fromCatalog === null ? body : `<multi_agent_role>${body}</multi_agent_role>`
}

export interface ModeOptions {
  /** The step's effective reasoning effort; `ultra` selects proactive delegation. */
  readonly effort?: string
  readonly model?: Catalog.Model
  /** `multi_agent_mode_hint_text`: replaces both modes; empty suppresses the message. */
  readonly configured?: string
}

/**
 * The `<multi_agent_mode>` developer message (`MultiAgentModeInstructions`) of a V2 agent, root or subagent, or
 * undefined when an empty hint suppresses it. Codex sends it as its own developer message after the role message on
 * the first request, then only when the mode changes (for example when the effort switches to or from `ultra`); when
 * a proactive mode goes away it sends the explicit text again.
 */
export function modeText(options: ModeOptions = {}) {
  const messages = options.model === undefined ? undefined : multiAgentMessages(options.model)
  const hint = options.configured ?? messages?.mode?.hint_text ?? undefined
  const proactive = options.effort === "ultra"
  const catalog = proactive ? messages?.mode?.proactive : messages?.mode?.explicit
  const custom = hint ?? catalog ?? undefined
  if (custom === "") return undefined
  const body =
    custom === undefined
      ? proactive
        ? PROACTIVE_MODE
        : EXPLICIT_MODE
      : Truncate.truncateText(custom, { mode: "tokens", limit: MULTI_AGENT_MODE_MAX_TOKENS })
  return `<multi_agent_mode>${body}</multi_agent_mode>`
}

const ENCODER = new TextEncoder()
const MAX_ENVIRONMENT_SUBAGENTS = 8
const MAX_ENVIRONMENT_SUBAGENT_BYTES = 1_024

/**
 * The `<subagents>` block Codex adds inside `<environment_context>` for a V2 agent: its direct children,
 * alphabetically, at most 8 lines and 1024 bytes; undefined when it has none.
 */
export function environmentSubagents(agents: ReadonlyArray<Agent>, parent: string) {
  const children = agents
    .map((agent) => agent.path)
    .filter((path) => path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/"))
    .toSorted(compare)
  const lines = children.reduce<{ readonly lines: ReadonlyArray<string>; readonly bytes: number }>(
    (state, path) => {
      if (state.lines.length === MAX_ENVIRONMENT_SUBAGENTS) return state
      const line = `<agent name="${path}" />`
      const bytes = state.bytes + "    \n".length + ENCODER.encode(line).length
      return bytes <= MAX_ENVIRONMENT_SUBAGENT_BYTES ? { lines: [...state.lines, line], bytes } : state
    },
    { lines: [], bytes: "  <subagents>\n  </subagents>\n".length },
  ).lines
  if (lines.length === 0) return undefined
  return `  <subagents>\n${lines.map((line) => `    ${line}\n`).join("")}  </subagents>\n`
}

// ---------------------------------------------------------------------------------------------------------------
// Override validation texts (core/src/agent/child_config.rs) for `Host.prepareSpawn`

/** At most this many models are listed (`MAX_SPAWN_AGENT_MODEL_OVERRIDES`). */
const MAX_LISTED_MODELS = 16

/** `find_spawn_agent_model_name`'s error; `available` are the picker-visible models that support V2, in order. */
export function unknownModel(requested: string, available: ReadonlyArray<string>) {
  return `Unknown model \`${requested}\` for spawn_agent. Available models: ${available.slice(0, MAX_LISTED_MODELS).join(", ")}`
}

/** `validate_spawn_agent_reasoning_effort`'s error. */
export function unsupportedEffort(model: string, effort: string, supported: ReadonlyArray<string>) {
  return `Reasoning effort \`${effort}\` is not supported for model \`${model}\`. Supported reasoning efforts: ${supported.join(", ")}`
}

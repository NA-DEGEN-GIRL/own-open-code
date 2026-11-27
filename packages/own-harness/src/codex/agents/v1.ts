// Ports Codex's MultiAgent V1 collaboration tools (namespace `multi_agent_v1`: `spawn_agent`, `send_input`,
// `resume_agent`, `wait_agent`, `close_agent`), which models with `multi_agent_version` v1 or unset get, deferred
// behind `tool_search` when the model supports search. Sources: codex-rs/core/src/tools/handlers/multi_agents.rs,
// multi_agents/*.rs and multi_agents_common.rs (arguments, errors, outputs, search texts),
// multi_agents_spec.rs (namespace), core/src/agent/registry.rs (thread limit, depth, nicknames),
// core/assets/agent/agent_names.txt, core/src/agent/control.rs and core/src/context/subagent_notification.rs (the
// parent's completion notification), and uuid 1.20's parser for agent ids. Ported from openai/codex (Apache-2.0)
// @ rust-v0.162.1.
//
// Agents are addressed by thread id only (V1 has no task paths). The Host owns the session's agent tree: it runs the
// child sessions, tracks statuses, reserves nicknames from a `NicknamePool`, and injects `notification(...)` into the
// parent when a child reaches a final status. The handlers validate and enforce what Codex checks before its
// controller: argument decoding, id syntax, input shape, spawn depth and the session's thread limit.
export * as CodexAgentsV1 from "./v1.js"

import GOLDEN from "../../../test/golden/codex/exec-unknown-model.json" with { type: "json" }
import { RustStr } from "../apply-patch/rust-str.js"
import { ToolSearch } from "../tool-search.js"
import { AgentArgs } from "./args.js"
import { CodexAgents } from "./index.js"

// ---------------------------------------------------------------------------------------------------------------
// Configuration (codex-rs/core/src/config/mod.rs)

export const NAMESPACE = "multi_agent_v1"
export const NAMESPACE_DESCRIPTION = "Tools for spawning and managing sub-agents."
/** `agents.max_concurrent_threads_per_session` default: open spawned agents per session, the root not counted. */
export const DEFAULT_MAX_THREADS = 6
/** `agents.max_depth` default: the user's session may spawn, its children may not. */
export const DEFAULT_MAX_DEPTH = 1
export const MIN_WAIT_TIMEOUT_MS = 10_000
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000
export const MAX_WAIT_TIMEOUT_MS = 3_600_000

export interface Config {
  readonly maxThreads: number
  readonly maxDepth: number
}

export const DEFAULT_CONFIG: Config = { maxThreads: DEFAULT_MAX_THREADS, maxDepth: DEFAULT_MAX_DEPTH }

export type ToolName = "spawn_agent" | "send_input" | "resume_agent" | "wait_agent" | "close_agent"

/** Registration order (`spec_plan.rs`), which is also the order of the deferred search entries. */
export const TOOL_NAMES: ReadonlyArray<ToolName> = [
  "spawn_agent",
  "send_input",
  "resume_agent",
  "wait_agent",
  "close_agent",
]

/**
 * The `multi_agent_v1` namespace exactly as Codex sent it up front for a model without search
 * (test/golden/codex/exec-unknown-model.json; tools in Codex's merged, name-sorted order). `spawn_agent`'s
 * description lists the account's models, so that paragraph is account-specific.
 */
export const DEFINITION: ToolSearch.Namespace = (GOLDEN.requests[0]!.body.tools as ReadonlyArray<unknown>).find(
  isNamespace,
)!

function isNamespace(value: unknown): value is ToolSearch.Namespace {
  return typeof value === "object" && value !== null && "type" in value && "name" in value && value.name === NAMESPACE
}

/** Each handler's `search_info` text: the only text `tool_search` indexes for these tools. */
export const SEARCH_TEXT: Readonly<Record<ToolName, string>> = {
  spawn_agent:
    "spawn_agent spawn agent subagent sub-agent delegate delegation parallel work worker explorer no-apps fork model reasoning",
  send_input: "send_input send message existing agent subagent follow up interrupt redirect queue target",
  resume_agent: "resume_agent resume reopen closed agent subagent thread id target",
  wait_agent: "wait_agent wait agent subagent status final result complete timeout targets",
  close_agent: "close_agent close shutdown stop agent subagent thread status target",
}

/** The source these tools list in the `tool_search` description. */
export const SEARCH_SOURCE: ToolSearch.Source = {
  name: "Multi-agent tools",
  description: "Spawn and manage sub-agents.",
}

/** The deferred `tool_search` entries for the V1 tools of `definition`, in registration order. */
export function searchEntries(definition: ToolSearch.Namespace = DEFINITION): ReadonlyArray<ToolSearch.Entry> {
  return TOOL_NAMES.flatMap((name) => {
    const tool = definition.tools.find((candidate) => candidate.name === name)
    if (tool === undefined) return []
    return [
      {
        searchText: SEARCH_TEXT[name],
        namespace: { name: definition.name, description: definition.description },
        tool,
        source: SEARCH_SOURCE,
      },
    ]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The agent tree the Host maintains

export type AgentStatus = CodexAgents.AgentStatus

export interface Agent {
  /** The thread id, lowercase hyphenated (`ThreadId`'s display form). */
  readonly id: string
  readonly status: AgentStatus
  readonly nickname?: string
}

export interface SpawnOverrides {
  /** `fork_context`: start from the parent's full history instead of only the initial input. */
  readonly forkContext: boolean
  readonly model?: string
  /** `reasoning_effort` as sent (non-empty). */
  readonly reasoningEffort?: string
  /** `agent_type`, trimmed and non-empty: a configured role; Codex does not apply it to full-history forks. */
  readonly agentType?: string
}

export interface SpawnRequest extends SpawnOverrides {
  /** The child's initial input (`message` becomes one text item). */
  readonly input: ReadonlyArray<AgentArgs.UserInput>
  /** The child's spawn depth: the caller's plus one. */
  readonly depth: number
}

/**
 * What own implements on top of its child sessions. Methods reject with `CodexAgents.AgentError` to answer the model
 * with Codex's text (see `notFound`, `THREAD_LIMIT` and the other texts below); any other rejection is a host failure.
 */
export interface Host {
  /** The session's open spawned agents at every depth (Codex's registry): spawned and not yet closed. */
  list(): Promise<ReadonlyArray<Agent>>
  /** Validates overrides before anything is created (`prepare_agent_spawn_config`); resolves to an error text. */
  prepareSpawn?(overrides: SpawnOverrides): Promise<string | undefined>
  /** Creates the child session with a nickname from the session's `NicknamePool` and starts its turn. */
  spawn(request: SpawnRequest): Promise<Agent>
  /**
   * Delivers input to an agent: starts a turn when it is idle (resolving to that turn's id) or steers the running
   * turn (resolving to a fresh UUIDv7). Unknown or closed: reject with `notFound(id)`.
   */
  sendInput(id: string, input: ReadonlyArray<AgentArgs.UserInput>): Promise<string>
  /** Interrupts the agent's current turn (`Op::Interrupt`); unknown or closed: reject with `notFound(id)`. */
  interrupt(id: string): Promise<void>
  /**
   * Reopens a closed agent from its stored history at `depth` (with its stored nickname and its open descendants),
   * resolving to its status; an open agent is left as it is. Unknown: `notFound(id)`; no free thread:
   * `THREAD_LIMIT_TOOL`.
   */
  resume(id: string, depth: number): Promise<AgentStatus>
  /**
   * Shuts the agent and its open descendants down and marks it closed, resolving to its status before the shutdown.
   * Unknown or already closed: `notFound(id)`.
   */
  close(id: string): Promise<AgentStatus>
  /** The agent's current status; `"not_found"` for an unknown or closed agent. */
  status(id: string): Promise<AgentStatus>
  /**
   * Waits until at least one of `ids` reaches a final status (see `isFinal`), then resolves to every one that is
   * final at that moment, in the order they became final; resolves to `[]` when `timeoutMs` passes first.
   */
  wait(ids: ReadonlyArray<string>, timeoutMs: number): Promise<ReadonlyArray<readonly [string, AgentStatus]>>
}

export interface Context {
  readonly host: Host
  /** The calling agent's spawn depth: 0 for the user's session, 1 for its children, and so on. */
  readonly depth: number
  readonly config?: Config
}

export type Output = CodexAgents.Output

// Texts the Host rejects with (codex-rs/core/src/tools/handlers/multi_agents_common.rs `collab_*_error`).

export function notFound(id: string) {
  return `agent with id ${id} not found`
}

/** `InternalAgentDied`: the agent's runtime went away mid-call. */
export function closedAgent(id: string) {
  return `agent with id ${id} is closed`
}

export const THREAD_LIMIT_SPAWN = "collab spawn failed: agent thread limit reached"
export const THREAD_LIMIT_TOOL = "collab tool failed: agent thread limit reached"
export const NO_NICKNAMES = "no available agent nicknames"
export const MANAGER_UNAVAILABLE = "collab manager unavailable"

// ---------------------------------------------------------------------------------------------------------------
// Handlers

/** Runs one `multi_agent_v1` tool call from its raw JSON arguments. */
export function handle(tool: ToolName, args: string, context: Context): Promise<Output> {
  return CodexAgents.answer(() => HANDLERS[tool](args, context))
}

const HANDLERS: Readonly<Record<ToolName, (args: string, context: Context) => Promise<Output>>> = {
  spawn_agent: spawnAgent,
  send_input: sendInput,
  resume_agent: resumeAgent,
  wait_agent: waitAgent,
  close_agent: closeAgent,
}

const SPAWN_ARGS: AgentArgs.Struct = {
  name: "SpawnAgentArgs",
  ignoreUnknownFields: true,
  fields: [
    { name: "message", type: "string" },
    { name: "items", type: "inputs" },
    { name: "agent_type", type: "string" },
    { name: "model", type: "string" },
    { name: "reasoning_effort", type: "effort" },
    { name: "fork_context", type: "bool", default: true },
  ],
}

const SEND_INPUT_ARGS: AgentArgs.Struct = {
  name: "SendInputArgs",
  ignoreUnknownFields: true,
  fields: [
    { name: "target", type: "string", required: true },
    { name: "message", type: "string" },
    { name: "items", type: "inputs" },
    { name: "interrupt", type: "bool", default: true },
  ],
}

const RESUME_ARGS: AgentArgs.Struct = {
  name: "ResumeAgentArgs",
  ignoreUnknownFields: true,
  fields: [{ name: "id", type: "string", required: true }],
}

const WAIT_ARGS: AgentArgs.Struct = {
  name: "WaitArgs",
  ignoreUnknownFields: true,
  fields: [
    { name: "targets", type: "strings", default: true },
    { name: "timeout_ms", type: "i64" },
  ],
}

const CLOSE_ARGS: AgentArgs.Struct = {
  name: "CloseAgentArgs",
  ignoreUnknownFields: true,
  fields: [{ name: "target", type: "string", required: true }],
}

const DEPTH_LIMIT = "Agent depth limit reached. Solve the task yourself."
const FULL_FORK_AGENT_TYPE =
  "Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork."

async function spawnAgent(args: string, context: Context): Promise<Output> {
  const values = CodexAgents.decode(SPAWN_ARGS, args)
  const agentType = RustStr.trim(text(values, "agent_type") ?? "")
  const input = collabInput(values)
  const config = context.config ?? DEFAULT_CONFIG
  const depth = context.depth + 1
  if (depth > config.maxDepth) return CodexAgents.failure(DEPTH_LIMIT)
  const forkContext = values.get("fork_context") === true
  if (forkContext && agentType !== "") return CodexAgents.failure(FULL_FORK_AGENT_TYPE)
  const overrides: SpawnOverrides = {
    forkContext,
    model: text(values, "model"),
    reasoningEffort: text(values, "reasoning_effort"),
    agentType: agentType === "" ? undefined : agentType,
  }
  const rejected = await context.host.prepareSpawn?.(overrides)
  if (rejected !== undefined) return CodexAgents.failure(rejected)
  const open = await context.host.list()
  if (open.length >= config.maxThreads) return CodexAgents.failure(THREAD_LIMIT_SPAWN)
  const spawned = await context.host.spawn({ ...overrides, input, depth })
  return success({ agent_id: spawned.id, nickname: spawned.nickname ?? null })
}

async function sendInput(args: string, context: Context): Promise<Output> {
  const values = CodexAgents.decode(SEND_INPUT_ARGS, args)
  const id = agentId(text(values, "target") ?? "")
  const input = collabInput(values)
  if (values.get("interrupt") === true) await context.host.interrupt(id)
  const submission = await context.host.sendInput(id, input)
  return success({ submission_id: submission })
}

async function resumeAgent(args: string, context: Context): Promise<Output> {
  const values = CodexAgents.decode(RESUME_ARGS, args)
  const id = agentId(text(values, "id") ?? "")
  const depth = context.depth + 1
  if (depth > (context.config ?? DEFAULT_CONFIG).maxDepth) return CodexAgents.failure(DEPTH_LIMIT)
  return success({ status: await context.host.resume(id, depth) })
}

async function waitAgent(args: string, context: Context): Promise<Output> {
  const values = CodexAgents.decode(WAIT_ARGS, args)
  const targets = list(values, "targets").filter((target) => typeof target === "string")
  if (targets.length === 0) return CodexAgents.failure("agent ids must be non-empty")
  const parsed = targets.map(agentId)
  const requested = values.get("timeout_ms")
  const timeoutMs = typeof requested === "bigint" ? requested : BigInt(DEFAULT_WAIT_TIMEOUT_MS)
  if (timeoutMs <= 0n) return CodexAgents.failure("timeout_ms must be greater than zero")
  const clamped = Number(
    timeoutMs < MIN_WAIT_TIMEOUT_MS
      ? MIN_WAIT_TIMEOUT_MS
      : timeoutMs > MAX_WAIT_TIMEOUT_MS
        ? MAX_WAIT_TIMEOUT_MS
        : timeoutMs,
  )
  const current = await Promise.all(parsed.map(async (id) => [id, await context.host.status(id)] as const))
  const final = current.filter(([, status]) => isFinal(status))
  const statuses = final.length > 0 ? final : await context.host.wait(parsed, clamped)
  // Codex keys a HashMap by agent id, so a repeated target answers once; its serialized order is unspecified.
  const status = Object.fromEntries(statuses)
  return { text: JSON.stringify({ status, timed_out: statuses.length === 0 }), success: undefined }
}

async function closeAgent(args: string, context: Context): Promise<Output> {
  const values = CodexAgents.decode(CLOSE_ARGS, args)
  const id = agentId(text(values, "target") ?? "")
  return success({ previous_status: await context.host.close(id) })
}

function success(result: object): Output {
  return { text: JSON.stringify(result), success: true }
}

function text(values: ReadonlyMap<string, AgentArgs.Value>, name: string) {
  const value = values.get(name)
  return typeof value === "string" ? value : undefined
}

/** A `strings` or `inputs` field's elements (empty when absent). */
function list(values: ReadonlyMap<string, AgentArgs.Value>, name: string): ReadonlyArray<string | AgentArgs.UserInput> {
  const value = values.get(name)
  return typeof value === "object" ? value : []
}

/** `parse_collab_input`: exactly one of `message` (non-blank) and `items` (non-empty). */
function collabInput(values: ReadonlyMap<string, AgentArgs.Value>): ReadonlyArray<AgentArgs.UserInput> {
  const message = text(values, "message")
  const items = values.has("items")
  if (message !== undefined && items) throw new CodexAgents.AgentError("Provide either message or items, but not both")
  if (message !== undefined) {
    if (RustStr.trim(message) === "") throw new CodexAgents.AgentError("Empty message can't be sent to an agent")
    return [{ type: "text", text: message }]
  }
  if (!items) throw new CodexAgents.AgentError("Provide one of: message or items")
  const inputs = list(values, "items").filter((item) => typeof item === "object")
  if (inputs.length === 0) throw new CodexAgents.AgentError("Items can't be empty")
  return inputs
}

// ---------------------------------------------------------------------------------------------------------------
// Agent ids (`ThreadId::from_string`, uuid 1.20 `Uuid::parse_str`)

/** The canonical id of `target`, or the rejection Codex answers for it. */
function agentId(target: string) {
  const parsed = parseThreadId(target)
  if (typeof parsed === "string") return parsed
  throw new CodexAgents.AgentError(`invalid agent id ${target}: ${parsed.error}`)
}

const ENCODER = new TextEncoder()
const URN = "urn:uuid:"
const HEX = /^[0-9a-fA-F]$/

/** A UUID in simple, hyphenated, braced or URN form as its lowercase hyphenated text, or uuid's `Debug` error. */
export function parseThreadId(input: string): string | { readonly error: string } {
  const bytes = ENCODER.encode(input)
  const hex = simpleOrHyphenated(input, bytes.length)
  if (hex === undefined) return { error: `Error(${uuidError(input, bytes.length)})` }
  const lower = hex.toLowerCase()
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`
}

function simpleOrHyphenated(input: string, length: number) {
  if (length === 32) return [...input].every((char) => HEX.test(char)) ? input : undefined
  if (length === 36) return hyphenated(input)
  if (length === 38 && input.startsWith("{") && input.endsWith("}")) return hyphenated(input.slice(1, -1))
  if (length === 45 && input.startsWith(URN)) return hyphenated(input.slice(URN.length))
  return undefined
}

function hyphenated(text: string) {
  const hyphens = [8, 13, 18, 23]
  const valid = [...text].every((char, index) => (hyphens.includes(index) ? char === "-" : HEX.test(char)))
  return valid && text.length === 36 ? text.replaceAll("-", "") : undefined
}

/** `InvalidUuid::into_err`, printed with `Debug`. */
function uuidError(input: string, length: number) {
  const braced = input.length >= 2 && input.startsWith("{") && input.endsWith("}")
  const urn = !braced && input.startsWith(URN)
  const offset = braced ? 1 : urn ? URN.length : 0
  const body = braced ? input.slice(1, -1) : urn ? input.slice(URN.length) : input
  const scan = [...body].reduce<{
    readonly index: number
    readonly hyphens: ReadonlyArray<number>
    readonly bad?: string
  }>(
    (state, char) => {
      if (state.bad !== undefined) return state
      const next = state.index + ENCODER.encode(char).length
      const code = char.codePointAt(0)!
      const position = state.index + offset + 1
      if (code > 0xff || (char !== "-" && !HEX.test(char)))
        return { ...state, bad: `ParseChar { character: ${charDebug(char)}, index: ${position} }` }
      if (char === "-") return { index: next, hyphens: [...state.hyphens, state.index] }
      return { ...state, index: next }
    },
    { index: 0, hyphens: [] },
  )
  if (scan.bad !== undefined) return scan.bad
  if (scan.hyphens.length === 0 && !braced && !urn) return `ParseSimpleLength { len: ${length} }`
  if (scan.hyphens.length !== 4) return `ParseGroupCount { count: ${scan.hyphens.length + 1} }`
  const starts = [0, 9, 14, 19, 24]
  const group = scan.hyphens.findIndex((bound, index) => bound !== starts[index + 1]! - 1)
  if (group !== -1)
    return `ParseGroupLength { group: ${group}, len: ${scan.hyphens[group]! - starts[group]!}, index: ${offset + starts[group]! + 1} }`
  return `ParseGroupLength { group: 4, len: ${length - starts[4]!}, index: ${offset + starts[4]! + 1} }`
}

/** Rust's `{:?}` for `char` (`char::escape_debug`, quoted with `'`). */
function charDebug(char: string) {
  const simple: Readonly<Record<string, string>> = {
    "'": "\\'",
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\0": "\\0",
  }
  const escaped =
    simple[char] ??
    (/^[\p{C}\p{Zl}\p{Zp}\p{Mn}\p{Me}]$/u.test(char) || (char !== " " && /^\p{Zs}$/u.test(char))
      ? `\\u{${char.codePointAt(0)!.toString(16)}}`
      : char)
  return `'${escaped}'`
}

// ---------------------------------------------------------------------------------------------------------------
// Statuses and the parent's notification

/** `is_final`: anything but pending, running or interrupted. */
export function isFinal(status: AgentStatus) {
  return status !== "pending_init" && status !== "running" && status !== "interrupted"
}

/**
 * The user-role message Codex injects into the parent's history, without starting a turn, when a spawned (or
 * resumed) child reaches a final status (`SubagentNotification`); undefined for a status that is not final. Codex
 * sends nothing for a `shutdown` caused by the whole session shutting down.
 */
export function notification(agentId: string, status: AgentStatus) {
  if (!isFinal(status)) return undefined
  return `<subagent_notification>\n${JSON.stringify({ agent_path: agentId, status })}\n</subagent_notification>`
}

// ---------------------------------------------------------------------------------------------------------------
// Nicknames (core/src/agent/registry.rs, core/assets/agent/agent_names.txt)

export const NICKNAMES: ReadonlyArray<string> = [
  "Euclid",
  "Archimedes",
  "Ptolemy",
  "Hypatia",
  "Avicenna",
  "Averroes",
  "Aquinas",
  "Copernicus",
  "Kepler",
  "Galileo",
  "Bacon",
  "Descartes",
  "Pascal",
  "Fermat",
  "Huygens",
  "Leibniz",
  "Newton",
  "Halley",
  "Euler",
  "Lagrange",
  "Laplace",
  "Volta",
  "Gauss",
  "Ampere",
  "Faraday",
  "Darwin",
  "Lovelace",
  "Boole",
  "Pasteur",
  "Maxwell",
  "Mendel",
  "Curie",
  "Planck",
  "Tesla",
  "Poincare",
  "Noether",
  "Hilbert",
  "Einstein",
  "Raman",
  "Bohr",
  "Turing",
  "Hubble",
  "Feynman",
  "Franklin",
  "McClintock",
  "Meitner",
  "Herschel",
  "Linnaeus",
  "Wegener",
  "Chandrasekhar",
  "Sagan",
  "Goodall",
  "Carson",
  "Carver",
  "Socrates",
  "Plato",
  "Aristotle",
  "Epicurus",
  "Cicero",
  "Confucius",
  "Mencius",
  "Zeno",
  "Locke",
  "Hume",
  "Kant",
  "Hegel",
  "Kierkegaard",
  "Mill",
  "Nietzsche",
  "Peirce",
  "James",
  "Dewey",
  "Russell",
  "Popper",
  "Sartre",
  "Beauvoir",
  "Arendt",
  "Rawls",
  "Singer",
  "Anscombe",
  "Parfit",
  "Kuhn",
  "Boyle",
  "Hooke",
  "Harvey",
  "Dalton",
  "Ohm",
  "Helmholtz",
  "Gibbs",
  "Lorentz",
  "Schrodinger",
  "Heisenberg",
  "Pauli",
  "Dirac",
  "Bernoulli",
  "Godel",
  "Nash",
  "Banach",
  "Ramanujan",
  "Erdos",
  "Jason",
]

/**
 * A session's nickname reservations (`AgentRegistry::reserve_agent_nickname`): a random name not used yet in this
 * session (names are not released when agents close); once all are used, the pool resets and names gain an ordinal
 * (`Euclid the 2nd`, then `the 3rd`, …).
 */
export class NicknamePool {
  private readonly used = new Set<string>()
  private resets = 0

  constructor(
    private readonly names: ReadonlyArray<string> = NICKNAMES,
    private readonly random: () => number = Math.random,
  ) {}

  /** Reserves `preferred` (a resumed agent's stored nickname) or a fresh name; undefined when there are no names. */
  reserve(preferred?: string) {
    const nickname = preferred ?? this.pick()
    if (nickname !== undefined) this.used.add(nickname)
    return nickname
  }

  private pick() {
    if (this.names.length === 0) return undefined
    const available = this.names.map((name) => nickname(name, this.resets)).filter((name) => !this.used.has(name))
    if (available.length > 0) return available[Math.floor(this.random() * available.length)]!
    this.used.clear()
    this.resets += 1
    return nickname(this.names[Math.floor(this.random() * this.names.length)]!, this.resets)
  }
}

const ORDINAL_SUFFIXES = ["th", "st", "nd", "rd"]

/** `format_agent_nickname`. */
export function nickname(name: string, resets: number) {
  if (resets === 0) return name
  const value = resets + 1
  const teen = value % 100 >= 11 && value % 100 <= 13
  const suffix = teen ? "th" : (ORDINAL_SUFFIXES[value % 10] ?? "th")
  return `${name} the ${value}${suffix}`
}

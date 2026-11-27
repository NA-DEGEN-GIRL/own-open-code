// Codex's Code Mode tools for `code_mode_only` models (GPT-6, GPT-5.6; codex-rs/core/src/tools/code_mode,
// rust-v0.162.1): `exec` runs JavaScript whose `tools.*` calls reach own's exec_command, write_stdin, apply_patch,
// view_image and clock__curr_time; `wait` resumes a yielded cell; `clock.sleep` waits for time or new input. Their
// definitions are the bytes Codex sends (codex-data/code-mode.<platform>.json, captured by script/codex-golden.ts).
// Nested calls ask own's permissions through the same paths as the Direct tools, under the `exec` call.
// The other tools own keeps in a codex session (MCP tools, core's Code Mode tools, other plugins' tools) are nested in
// `exec` too, as Codex nests MCP and dynamic tools (`Kept`).
export * as CodeModeTools from "./code-mode-tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import { Message, ToolResultPart } from "@opencode/ai/effect"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema, Stream } from "effect"
import CODE_MODE_WIN32 from "../../codex-data/code-mode.win32.json" with { type: "json" }
import { Gate } from "../gate.js"
import { Catalog } from "./catalog.js"
import { Clock } from "./clock.js"
import { CodeModeDeclarations } from "./code-mode/declarations.js"
import { CodeModeRuntime } from "./code-mode/index.js"
import { CodeModeMedia } from "./code-mode/media.js"
import { ExecManager } from "./exec/manager.js"
import { ExecOutput } from "./exec/output.js"
import { GoalRuntime } from "./goal-runtime.js"
import { McpResources } from "./mcp-resources.js"
import { Platform } from "./platform.js"
import { CodexTools } from "./tools.js"
import { Truncate } from "./truncate/index.js"
import { Wildcard } from "./wildcard.js"

type Ctx = Pick<Context, "tool" | "session" | "permission" | "shell" | "location" | "agent" | "mcp" | "event">

interface Spec {
  readonly type: string
  readonly name: string
  readonly description: string
  readonly parameters?: Record<string, unknown>
  readonly format?: { readonly type: string; readonly syntax: string; readonly definition: string }
}

interface Namespace {
  readonly type: "namespace"
  readonly name: string
  readonly description: string
  readonly tools: ReadonlyArray<Spec>
}

const NAMESPACES = Platform.value(CODE_MODE_WIN32.tools as ReadonlyArray<Namespace>)

export function spec(namespace: string, name: string) {
  const found = NAMESPACES.find((entry) => entry.name === namespace)?.tools.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`codex-data has no Code Mode tool ${namespace}.${name}`)
  return found
}

export function namespace(name: string) {
  const found = NAMESPACES.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`codex-data has no Code Mode namespace ${name}`)
  return found
}

/** `<multi_agent_role>` and `<multi_agent_mode>`: Codex's developer messages for multi-agent v2 models. */
export const MULTI_AGENT_ROLE = CODE_MODE_WIN32.multiAgentRole
export const MULTI_AGENT_MODE = CODE_MODE_WIN32.multiAgentMode

/** `clock.sleep` as an own tool: a flat name placed in Codex's `clock` namespace on the wire (P-024). */
export const SLEEP = "clock__sleep"

/** Nested tools own runs inside `exec`, by Codex's JavaScript name. */
export const NESTED = [
  "apply_patch",
  "create_goal",
  "exec_command",
  "get_goal",
  "update_goal",
  "view_image",
  "write_stdin",
  "clock__curr_time",
  ...McpResources.NAMES,
] as const

/**
 * Codex's `exec` description (`build_exec_tool_description`) with the sections of the built-in nested tools present
 * and of `extra` nested tools, in Codex's order (`compare_code_mode_tools`): tools without a namespace first, then each
 * namespace under its `## <namespace>` header. The built-in sections are the captured bytes; `extra` sections are
 * rendered (CodeModeDeclarations). An extra tool whose JavaScript name is taken is left out, as Codex skips it.
 */
export function execDescription(
  present: ReadonlySet<string>,
  extra: ReadonlyArray<CodeModeDeclarations.Definition> = [],
) {
  if (CAPTURED.blocks.length === 0) return spec("functions", "exec").description
  const builtins = CAPTURED.blocks.filter((block) => present.has(block.definition.name))
  const added = distinct(
    extra,
    (definition) => CodeModeDeclarations.identifier(definition.name),
    builtins.map((block) => block.definition.name),
  ).map((definition) => ({ definition, text: CodeModeDeclarations.section(definition) }))
  const blocks = [...builtins, ...added].toSorted((left, right) =>
    CodeModeDeclarations.compare(left.definition, right.definition),
  )
  const sections = blocks.flatMap((block, index) => {
    const namespace = block.definition.namespace
    const header =
      namespace !== undefined && namespace !== blocks[index - 1]?.definition.namespace
        ? CAPTURED.headers.get(namespace)
        : undefined
    return header === undefined ? [block.text] : [header, block.text]
  })
  return [CAPTURED.preamble, ...(sections.length === 0 ? [] : [sections.join("\n\n")])].join("\n\n")
}

/** Items whose key is not taken, the first of each key (Codex skips a tool whose JavaScript name repeats). */
function distinct<A>(items: ReadonlyArray<A>, key: (item: A) => string, taken: ReadonlyArray<string>) {
  return items.reduce(
    (state, item) =>
      state.keys.has(key(item)) ? state : { keys: new Set([...state.keys, key(item)]), items: [...state.items, item] },
    { keys: new Set(taken), items: [] as Array<A> },
  ).items
}

/**
 * The captured `exec` description split into the text before the nested tools, one block per tool (`### \`name\``)
 * and the `## <namespace>` headers. Sections are separated by a blank line; the last one runs to the end of the text
 * (web__run's description has `## ` headings of its own, so a namespace header is a `## name` line, its description
 * line and a tool heading).
 */
const CAPTURED = (() => {
  const lines = spec("functions", "exec").description.split("\n")
  const toolAt = (index: number) => /^### `([^`]+)`$/.exec(lines[index] ?? "")?.[1]
  const namespaceAt = (index: number) =>
    /^## ([a-z_]+)$/.exec(lines[index] ?? "")?.[1] !== undefined &&
    lines[index + 2] === "" &&
    toolAt(index + 3) !== undefined
      ? lines[index]!.slice(3)
      : undefined
  const starts = lines.flatMap((_, index) =>
    toolAt(index) !== undefined || namespaceAt(index) !== undefined ? [index] : [],
  )
  const parsed = starts.reduce(
    (state, start, index) => {
      const end = starts[index + 1]
      const text = lines.slice(start, end === undefined ? lines.length : end - 1).join("\n")
      const namespace = namespaceAt(start)
      if (namespace !== undefined)
        return { ...state, namespace, headers: new Map([...state.headers, [namespace, text]]) }
      const name = toolAt(start)!
      const prefix = state.namespace === undefined ? "" : CodeModeDeclarations.codeModeName(state.namespace, "")
      const definition: CodeModeDeclarations.Definition = {
        name,
        namespace: state.namespace,
        toolName: prefix !== "" && name.startsWith(prefix) ? name.slice(prefix.length) : name,
        description: "",
        kind: "function",
      }
      return { ...state, blocks: [...state.blocks, { definition, text }] }
    },
    {
      namespace: undefined as string | undefined,
      headers: new Map<string, string>(),
      blocks: [] as Array<{ readonly definition: CodeModeDeclarations.Definition; readonly text: string }>,
    },
  )
  return {
    preamble: lines.slice(0, Math.max(0, (starts[0] ?? 0) - 1)).join("\n"),
    headers: parsed.headers,
    blocks: parsed.blocks,
  }
})()

/** The nested tools a model gets: view_image needs image input, clock__curr_time the `clock` tools. */
export function nestedNames(model: Catalog.Model) {
  return new Set<string>(
    NESTED.filter((name) => {
      if (name === "view_image") return !model.known || (model.input_modalities?.includes("image") ?? false)
      if (name === "clock__curr_time") return clock(model)
      return true
    }),
  )
}

/** Codex's `clock` tools are on for models whose catalog lists them in `experimental_supported_tools`. */
export function clock(model: Catalog.Model) {
  return model.experimental_supported_tools?.includes("clock") ?? false
}

/** Per-session Code Mode state, and the sessions whose turn runs (Codex delivers `notify` only during a turn). */
export class Runtimes {
  private readonly sessions = new Map<string, CodeModeRuntime.Session>()
  private readonly turns = new Set<string>()

  get(sessionID: string) {
    const found = this.sessions.get(sessionID)
    if (found !== undefined) return found
    const created = new CodeModeRuntime.Session()
    this.sessions.set(sessionID, created)
    return created
  }

  turn(sessionID: string, running: boolean) {
    if (running) this.turns.add(sessionID)
    if (!running) this.turns.delete(sessionID)
  }

  running(sessionID: string) {
    return this.turns.has(sessionID)
  }

  /**
   * A user interrupt of the session's turn (Codex `interrupt_active_cells`, #51835, on by default since 0.163.0): its
   * live cells end, those an earlier `exec` left running after a yield included, with their nested calls; the stored
   * values stay for the next cell.
   */
  interrupt(sessionID: string) {
    return this.sessions.get(sessionID)?.terminateAll() ?? Promise.resolve()
  }

  async terminate(sessionID?: string) {
    const targets =
      sessionID === undefined ? [...this.sessions.entries()] : [[sessionID, this.sessions.get(sessionID)] as const]
    await Promise.all(
      targets.map(async ([id, session]) => {
        this.sessions.delete(id)
        this.turns.delete(id)
        await session?.terminateAll()
      }),
    )
  }
}

/** Metadata `source` of the synthetic messages that carry `notify(...)` texts. */
export const NOTIFY_SOURCE = "own.harness.exec.notify"

const NOTIFY = /^<exec_notify call_id="([^"]+)">\n([\s\S]*)\n<\/exec_notify>$/

/** The synthetic message text of a `notify(...)` from the cell that the `exec` call `callID` started. */
export function notification(callID: string, text: string) {
  return `<exec_notify call_id="${callID}">\n${text}\n</exec_notify>`
}

/**
 * Codex's record of a `notify(...)` (`CodeModeHost::notify`, tools/code_mode/delegate.rs): one more
 * `custom_tool_call_output` of the `exec` call that started the cell, after whatever the history holds by then. own
 * admits it as a synthetic message, which reaches the history at the next step boundary as Codex's injected input
 * reaches the next sampling request; here it becomes that tool output. Without the call in the history (compacted away)
 * it drops out, as Codex drops outputs without their call; other messages pass unchanged.
 */
export function notifications(history: ReadonlyArray<Message>) {
  const calls = new Set(
    history.flatMap((entry) => entry.content.flatMap((part) => (part.type === "tool-call" ? [part.id] : []))),
  )
  return history.flatMap((entry) => {
    const first = entry.content[0]
    if (entry.role !== "user" || entry.content.length !== 1 || first?.type !== "text") return [entry]
    const found = NOTIFY.exec(first.text)
    if (found === null) return [entry]
    if (!calls.has(found[1]!)) return []
    return [
      Message.make({
        ...(entry.id === undefined ? {} : { id: entry.id }),
        role: "tool",
        content: [ToolResultPart.make({ id: found[1]!, name: "exec", result: found[2]!, resultType: "text" })],
      }),
    ]
  })
}

export const register = (
  ctx: Ctx,
  manager: ExecManager.Manager,
  runtimes: Runtimes,
  activity: Clock.Activity,
  goals: GoalRuntime.Runtime,
  /** Whether input reached the session's running turn and waits for its next step (ResetWatch `pending`). */
  pending: (sessionID: string) => boolean = () => false,
) =>
  Effect.gen(function* () {
    yield* ctx.tool.transform((editor) => {
      const options = { codemode: false, permission: Gate.ACTION }
      editor.add({
        name: "exec",
        description: spec("functions", "exec").description,
        input: {
          type: "object",
          properties: { input: { type: "string", description: "JavaScript source for exec" } },
          required: ["input"],
          additionalProperties: false,
        },
        options,
        execute: (raw: unknown, tool: Tool.Context) =>
          exec(ctx, manager, runtimes, goals, String((raw as { input: string }).input), tool),
      })
      editor.add({
        name: "wait",
        description: spec("functions", "wait").description,
        input: spec("functions", "wait").parameters!,
        options,
        execute: (raw: unknown, tool: Tool.Context) => wait(runtimes, raw as CodeModeRuntime.WaitArgs, tool),
      })
      editor.add({
        name: SLEEP,
        description: spec("clock", "sleep").description,
        input: spec("clock", "sleep").parameters!,
        options,
        execute: (raw: unknown, tool: Tool.Context) =>
          Effect.promise(() =>
            Clock.sleep(
              activity,
              tool.sessionID,
              (raw as { duration_ms: number }).duration_ms,
              pending(tool.sessionID),
            ),
          ).pipe(Effect.map((content) => ({ content, metadata: { truncated: true } }))),
      })
    })
    // Which sessions run a turn: a `notify(...)` outside one is dropped, as Codex fails to inject it. A user's stop
    // ends the session's cells (`Runtimes.interrupt`); a shutdown leaves them to the plugin's end.
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "session.execution.started") runtimes.turn(event.data.sessionID, true)
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          )
            runtimes.turn(event.data.sessionID, false)
          if (event.type === "session.execution.interrupted" && event.data.reason === "user")
            void runtimes.interrupt(event.data.sessionID)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Registered before the request hooks (hooks.ts, after this in index.ts), so the kept tools are attached to the
    // request's tool list when `CodexRequest.build` reads them. Hooks run in registration order.
    yield* ctx.session.hook("context", (event) => attachKept(ctx, event))
    yield* ctx.session.hook("compaction", (event) => attachKept(ctx, event))
    yield* ctx.session.hook("generate", (event) => attachKept(ctx, event))
  })

function exec(
  ctx: Ctx,
  manager: ExecManager.Manager,
  runtimes: Runtimes,
  goals: GoalRuntime.Runtime,
  source: string,
  tool: Tool.Context,
) {
  return Effect.gen(function* () {
    const model = yield* ctx.session.get({ sessionID: tool.sessionID }).pipe(
      Effect.map((info) => Catalog.lookup(info.model?.id ?? "")),
      Effect.orElseSucceed(() => Catalog.lookup("")),
    )
    const runtime = runtimes.get(tool.sessionID)
    const present = nestedNames(model)
    // Nested calls report progress (a command's live output) on this call's card while it runs. A cell outlives its
    // `exec` call (a yield, then `wait`), and core refuses progress for a settled call, so later reports are dropped.
    const call = { open: true }
    const scoped: Tool.Context = {
      ...tool,
      progress: (update) => (call.open ? tool.progress(update) : Effect.void),
    }
    const builtins = nested(ctx, manager, goals, scoped).filter((entry) => present.has(entry.name))
    // The registry as it is now: tools that MCP servers or later plugins registered since the request are callable too
    // (Codex: "Tool availability can change between calls").
    const extra = distinct(
      yield* kept(ctx, tool.sessionID, tool.agent),
      (entry) => CodeModeDeclarations.identifier(entry.definition.name),
      builtins.map((entry) => entry.name),
    ).map((entry) => keptTool(entry, scoped))
    // Codex keeps a notification in history within the model's truncation budget plus its serialization allowance.
    const limit = Truncate.tokenBudget(Truncate.withSerializationAllowance(model.truncation_policy))
    const startedAt = Date.now()
    const items = yield* Effect.tryPromise({
      try: () =>
        runtime.exec(source, [...builtins, ...extra], {
          onNotify: (text) =>
            notify(ctx, runtimes, tool, Truncate.truncateText(text, { mode: "tokens", limit }), startedAt),
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) => Effect.succeed(failure(error))),
      // A stopped `exec` call ends the session's cells at once; a user's stop also ends those left running after a
      // yield (`Runtimes.interrupt`). A nested exec_command cut off with its cell ends its process
      // (`ToolContext.terminated`).
      Effect.onInterrupt(() => Effect.promise(() => runtime.terminateAll())),
      Effect.ensuring(Effect.sync(() => void (call.open = false))),
    )
    return result(items)
  })
}

/**
 * Admits a `notify(...)` text at once: a synthetic message delivered at the session's next step boundary (core steers
 * it in), which the request turns into Codex's extra `exec` output (`notifications`). Outside a turn it is dropped.
 * It reports the cell's work in the background (core P-035, 11 §7.2): a context reset waiting for the turn does not
 * hold it back, and one that applied since the `exec` call started (`startedAt`) keeps it out of the new context.
 */
function notify(
  ctx: Pick<Context, "session">,
  runtimes: Runtimes,
  tool: Tool.Context,
  text: string,
  startedAt: number,
) {
  if (!runtimes.running(tool.sessionID)) return Promise.resolve()
  return Effect.runPromise(
    ctx.session.synthetic({
      sessionID: tool.sessionID,
      text: notification(tool.id, text),
      description: "exec notify",
      metadata: { source: NOTIFY_SOURCE, callID: tool.id },
      delivery: "steer",
      resume: false,
      background: true,
      startedAt,
    }),
  ).then(() => undefined)
}

function wait(runtimes: Runtimes, args: CodeModeRuntime.WaitArgs, tool: Tool.Context) {
  return Effect.tryPromise({ try: () => runtimes.get(tool.sessionID).wait(args), catch: (error) => error }).pipe(
    Effect.catch((error) => Effect.succeed(failure(error))),
    Effect.map(result),
  )
}

/** `RespondToModel` errors reach the model as text; anything else is reported the same way rather than lost. */
function failure(error: unknown): Array<CodeModeRuntime.ContentItem> {
  return [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
}

/** The content items of Codex's `custom_tool_call_output`. */
function result(items: ReadonlyArray<CodeModeRuntime.ContentItem>): Tool.Result {
  return {
    content: items.map((item): Tool.Content => {
      if (item.type === "text") return { type: "text", text: item.text }
      const url = item.type === "image" ? item.image_url : item.audio_url
      const mime = /^data:([^;,]+)[;,]/.exec(url)?.[1]
      if (mime === undefined) return { type: "text", text: url }
      return {
        type: "file",
        mime,
        uri: url,
        ...(item.type === "image" && item.name !== undefined ? { name: item.name } : {}),
      }
    }),
    metadata: { truncated: true },
  }
}

/** The nested tools as Codex's `tools.<name>(...)`, run with the `exec` call's context. */
function nested(
  ctx: Ctx,
  manager: ExecManager.Manager,
  goals: GoalRuntime.Runtime,
  tool: Tool.Context,
): Array<CodeModeRuntime.NestedTool> {
  const run = <A>(effect: Effect.Effect<A, unknown>, signal: AbortSignal) => Effect.runPromise(effect, { signal })
  const outcome = (value: CodexTools.ExecOutcome) => {
    if (value.kind === "result") return ExecOutput.codeModeResult(value.result)
    // Codex's nested call fails with the text it would answer the model.
    throw new Error(value.text)
  }
  // Goal tools return their JSON value (`JsonToolOutput::code_mode_result`); failures reject with Codex's text.
  const goal = GoalRuntime.TOOLS.map(
    (name): CodeModeRuntime.NestedTool => ({
      name,
      description: CodexTools.definition(name).description ?? "",
      input: CodexTools.definition(name).parameters ?? {},
      execute: async (input) => {
        const result = await goals.call(name, tool.sessionID, input)
        if (!result.ok) throw new Error(result.message)
        return result.value
      },
    }),
  )
  return [
    ...goal,
    {
      name: "apply_patch",
      description: CodexTools.definition("apply_patch").description ?? "",
      input: "string",
      execute: async (input, context) => {
        const done = await run(CodexTools.patch(ctx, String(input), ctx.location.directory, tool), context.signal)
        const text = typeof done.content === "string" ? done.content : ""
        // `ApplyPatchToolOutput::code_mode_result` is an empty object; failures reject with Codex's text.
        if (!text.startsWith("Exit code: 0\n")) throw new Error(text)
        return {}
      },
    },
    {
      name: "exec_command",
      description: CodexTools.definition("exec_command").description ?? "",
      input: CodexTools.definition("exec_command").parameters ?? {},
      execute: async (input, context) =>
        outcome(
          await run(
            CodexTools.runExec(ctx, manager, input as CodexTools.ExecArgs, tool, context.terminated),
            context.signal,
          ),
        ),
    },
    {
      name: "write_stdin",
      description: CodexTools.definition("write_stdin").description ?? "",
      input: CodexTools.definition("write_stdin").parameters ?? {},
      execute: async (input, context) =>
        outcome(await run(CodexTools.runWrite(ctx, manager, input as CodexTools.WriteArgs, tool), context.signal)),
    },
    {
      name: "view_image",
      description: CodexTools.definition("view_image").description ?? "",
      input: CodexTools.definition("view_image").parameters ?? {},
      execute: async (input, context) => {
        const done = await run(CodexTools.viewImage(ctx, input, tool), context.signal)
        const file = typeof done.content === "string" ? undefined : done.content?.find((item) => item.type === "file")
        if (file?.type !== "file")
          throw new Error(typeof done.content === "string" ? done.content : "view_image failed")
        // Codex 0.171.0's unified image budget (#59282) answers the URL only; `detail` left the output schema.
        return { image_url: file.uri }
      },
    },
    // `FunctionToolOutput` answers its JSON text as a string; argument and MCP errors reject with Codex's text.
    ...McpResources.NAMES.map(
      (name): CodeModeRuntime.NestedTool => ({
        name,
        description: McpResources.DEFINITIONS[name]!.description,
        input: McpResources.DEFINITIONS[name]!.parameters as Record<string, unknown>,
        execute: async (input, context) => {
          const outcome = await run(McpResources.run(ctx, name, input, tool), context.signal)
          if (!outcome.ok) throw new Error(outcome.text)
          return outcome.text
        },
      }),
    ),
    {
      name: "clock__curr_time",
      description: "Return the current time in UTC.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({
        current_time: /It is (.*)\.<\/current_time_reminder>/.exec(Clock.currentTime())![1],
      }),
    },
  ]
}

/** A tool own keeps in a codex session, nested in `exec` as Codex nests MCP and dynamic tools. */
export interface Kept {
  /** own's registry id: the tool's name on the Direct path. */
  readonly id: string
  readonly info: Tool.Info
  /** Registered by core for an MCP server (its namespace is the server's): it answers Codex's CallToolResult. */
  readonly mcp: boolean
  /** A `codemode: false` tool, which core lists in the request itself. */
  readonly direct: boolean
  readonly definition: CodeModeDeclarations.Definition
}

/**
 * Tools that stay top-level or are not own's to nest: the harness's own tools (`Gate.ACTION`: the built-in nested
 * tools and Code Mode's top-level ones), core's Code Mode `execute`, the core tools Codex replaces, `subagent` (the
 * multi-agent tools replace it separately) and Codex's `collaboration` namespace. Core's `websearch` is nested: Codex
 * searches from `exec` through its `web__run` (OpenAI's own backend, which own does not have), and a Code Mode request
 * sends no hosted `web_search`, so without it a GPT-6 session could not search at all.
 * own's image tool (`image_generate`, `OwnImage.TOOL`) stays top-level too: its result is the image itself, a file part
 * the model must see as an image and own-web draws under the call's card; nested, `exec` would hand the JavaScript
 * program the image's whole base64 as a string, the model would never see the picture and the card would not show
 * (decisions IM-26). It is listed only while the user's image setting is on.
 */
const TOP_LEVEL = ["execute", "subagent", "image_generate", ...CodexTools.REPLACED]

function nestable(tool: Tool.Info & { readonly id: string }) {
  if (tool.options?.permission === Gate.ACTION || TOP_LEVEL.includes(tool.id)) return false
  // Codex's own MCP resource tools (mcp-resources.ts) read through these.
  if (tool.id === McpResources.CORE_LIST || tool.id === McpResources.CORE_READ) return false
  return !tool.id.startsWith("collaboration__")
}

/**
 * The tools own keeps for this session, from the live registry (`ctx.tool.list()` is the result of every transform,
 * whenever it was registered, MCP tools included), without those the agent's and the session's rules deny outright
 * (core's own catalog filter, `Tool.snapshot`). Read at request time (`attachKept`) and again at every `exec`, which
 * therefore sees the current registry without a late transform registration.
 */
export function kept(
  ctx: Pick<Context, "tool" | "session" | "agent" | "mcp">,
  sessionID: Session.ID,
  agentID: Agent.ID,
) {
  return Effect.gen(function* () {
    const tools = yield* ctx.tool.list()
    const session = yield* ctx.session.get({ sessionID }).pipe(Effect.option)
    const agent = yield* ctx.agent.get({ agentID }).pipe(Effect.option)
    const rules = [
      ...(agent._tag === "Some" ? agent.value.data.permissions : []),
      ...(session._tag === "Some" ? (session.value.permissions ?? []) : []),
    ]
    const servers = yield* ctx.mcp.list().pipe(
      // core/src/tool/mcp.ts registers a server's tools under this namespace.
      Effect.map((list) => new Set(list.data.map((server) => server.name.replace(/[^a-zA-Z0-9_-]/g, "_")))),
      Effect.orElseSucceed(() => new Set<string>()),
    )
    return tools
      .filter((tool) => nestable(tool) && !denied(tool.options?.permission ?? tool.id, rules))
      .map((tool): Kept => {
        const mcp = tool.options?.namespace !== undefined && servers.has(tool.options.namespace)
        return {
          id: tool.id,
          info: tool,
          mcp,
          direct: tool.options?.codemode === false,
          definition: definition(tool, mcp),
        }
      })
  })
}

/** `Tool.snapshot`'s `whollyDisabled`: the last rule for the action denies every resource. */
function denied(action: string, rules: ReadonlyArray<Permission.Rule>) {
  const rule = rules.findLast((entry) => Wildcard.match(action, entry.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

/**
 * The tool as Codex would declare it. MCP tools take Codex's names (`mcp__<server>__<tool>`, codex-mcp tools.rs) and
 * a CallToolResult output; other tools are Codex's dynamic tools, under their own namespace if they have one.
 */
function definition(tool: Tool.Info, mcp: boolean): CodeModeDeclarations.Definition {
  const namespace = tool.options?.namespace
  if (mcp && namespace !== undefined) {
    const sanitized = CodeModeDeclarations.sanitizeName(namespace)
    const server = sanitized.startsWith("mcp__") ? sanitized : `mcp__${sanitized}`
    const toolName = CodeModeDeclarations.sanitizeName(tool.name)
    return {
      name: CodeModeDeclarations.codeModeName(server, toolName),
      namespace: server,
      toolName,
      description: tool.description,
      kind: "function",
      input: CodeModeDeclarations.sanitizeMcpInput(jsonSchema(tool.input)),
      output: CodeModeDeclarations.mcpOutputSchema(jsonSchema(tool.output) ?? {}),
    }
  }
  return {
    name: CodeModeDeclarations.codeModeName(namespace, tool.name),
    namespace,
    toolName: tool.name,
    description: tool.description,
    kind: "function",
    input: CodeModeDeclarations.sanitizeInput(jsonSchema(tool.input)),
    output: jsonSchema(tool.output),
  }
}

/**
 * A tool schema as JSON Schema (core's `definition` converts the same three kinds). A schema that cannot be converted
 * renders as `unknown`; the converters report that only by throwing.
 */
function jsonSchema(schema: Tool.ValueSchema | undefined): unknown {
  if (schema === undefined) return undefined
  try {
    if (Schema.isSchema(schema)) {
      // As core's conversion (core/src/tool/runtime.ts): closed objects, which effect 4.0.1 no longer makes by default.
      const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
      return Object.keys(document.definitions).length === 0
        ? document.schema
        : { ...document.schema, $defs: document.definitions }
    }
    if (isStandard(schema)) return schema["~standard"].jsonSchema?.input({ target: "draft-2020-12" })
    return schema
  } catch {
    return undefined
  }
}

/** The parts of a Standard Schema (standardschema.dev) own reads; core accepts these as tool schemas. */
interface StandardSchema {
  readonly "~standard": {
    readonly validate: (value: unknown) => StandardResult | Promise<StandardResult>
    readonly jsonSchema?: { readonly input: (options: { readonly target: string }) => unknown }
  }
}

interface StandardResult {
  readonly value?: unknown
  readonly issues?: ReadonlyArray<{ readonly message: string }>
}

function isStandard(schema: unknown): schema is StandardSchema {
  return typeof schema === "object" && schema !== null && "~standard" in schema
}

const ATTACHED = new WeakMap<object, { readonly kept?: ReadonlyArray<Kept>; readonly mcpServers: boolean }>()

/**
 * Attaches what `CodexRequest.build` needs beyond the request: the kept tools of a Code Mode request, and whether MCP
 * servers are configured (Codex's MCP resource tools). Keyed by the tool list itself: the kept Direct tools are those
 * this list carries.
 */
export function attach(tools: object, entries: ReadonlyArray<Kept> | undefined, mcpServers = false) {
  ATTACHED.set(tools, { kept: entries, mcpServers })
}

export function attached(tools: object) {
  return ATTACHED.get(tools)?.kept
}

/** Whether the request hook found MCP servers configured for this request. */
export function mcpServers(tools: object) {
  return ATTACHED.get(tools)?.mcpServers ?? false
}

/**
 * The request hook, for codex sessions (only they list the harness's tools): whether MCP servers are configured and,
 * for a Code Mode model, the kept tools; a Direct tool counts when the request lists it, with the input schema core
 * sent for it. On failure nothing is attached: the request keeps those tools top-level and has no MCP resource tools.
 */
function attachKept(ctx: Ctx, event: SessionContext) {
  if (event.tools.exec === undefined && event.tools[McpResources.LIST_RESOURCES] === undefined) return Effect.void
  const code = event.tools.exec !== undefined && Catalog.lookup(event.model.id).tool_mode === "code_mode_only"
  return Effect.all({
    entries: code
      ? kept(ctx, event.sessionID, event.agent).pipe(Effect.map(listedOnly(event)))
      : Effect.succeed(undefined),
    servers: McpResources.hasServers(ctx),
  }).pipe(
    Effect.map((found) => attach(event.tools, found.entries, found.servers)),
    Effect.catchCause(() => Effect.void),
  )
}

/** Kept Direct tools the request lists, with the input schema core sent for them. */
const listedOnly = (event: SessionContext) => (entries: ReadonlyArray<Kept>) =>
  entries.flatMap((entry) => {
    if (!entry.direct) return [entry]
    const listed = event.tools[entry.id]
    if (listed === undefined) return []
    const input = entry.mcp
      ? CodeModeDeclarations.sanitizeMcpInput(listed.input)
      : CodeModeDeclarations.sanitizeInput(listed.input)
    return [{ ...entry, definition: { ...entry.definition, input } }]
  })

/** A kept tool as `tools.<name>(args)`, run under the `exec` call like the built-in nested tools. */
function keptTool(entry: Kept, tool: Tool.Context): CodeModeRuntime.NestedTool {
  const input = entry.definition.input
  return {
    name: CodeModeDeclarations.identifier(entry.definition.name),
    // `ALL_TOOLS` lists Codex's augmented description: the text and the declaration.
    description: CodeModeDeclarations.sample(entry.definition),
    input:
      typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
    execute: async (args, context) => {
      const outcome = await Effect.runPromise(runKept(entry, args, tool), { signal: context.signal })
      if (!outcome.ok) throw new Error(outcome.message)
      outcome.images.forEach((image) => context.show(image))
      return outcome.value
    },
  }
}

/**
 * Runs a kept tool and gives the program Codex's `code_mode_result`: an MCP tool's CallToolResult (a failure as an
 * `isError` result, `CallToolResult::from_error_text`); a tool with an output schema, its output; any other tool, its
 * text (`response_input_to_code_mode_result`), with a failure rejecting the call with its message.
 */
function runKept(entry: Kept, args: unknown, tool: Tool.Context) {
  return decode(entry, args).pipe(
    Effect.flatMap((input) => entry.info.execute(input, tool)),
    Effect.flatMap((result) =>
      Effect.map(
        codeModeResult(entry, result),
        (value): Outcome => ({ ok: true, value, images: shown(entry, result) }),
      ),
    ),
    Effect.catch((error: unknown) => {
      const message = errorMessage(error)
      if (entry.mcp)
        return Effect.succeed<Outcome>({
          ok: true,
          value: { content: [{ type: "text", text: message }], isError: true },
          images: [],
        })
      return Effect.succeed<Outcome>({ ok: false, message })
    }),
  )
}

type Outcome =
  | { readonly ok: true; readonly value: unknown; readonly images: ReadonlyArray<CodeModeRuntime.ContentItem> }
  | { readonly ok: false; readonly message: string }

/**
 * Images a non-MCP tool with an output schema returns beside that output (own.computer-use's screenshots): the
 * program receives only the output, so the images go straight to the cell's output, as `image(...)` would put them,
 * with their file names. Without this a codex conversation never saw a screenshot (2026-11-24 live check, decisions
 * CUU-5). An MCP tool's images stay in its CallToolResult and a tool without an output schema hands over their data
 * URLs in its text, as Codex does; the program shows those itself.
 */
function shown(entry: Kept, result: Tool.Result): ReadonlyArray<CodeModeRuntime.ContentItem> {
  if (entry.mcp || entry.info.output === undefined || !("output" in result) || typeof result.content === "string")
    return []
  return (result.content ?? []).flatMap((part) =>
    part.type === "file" && part.mime.startsWith("image/") && part.uri.startsWith("data:")
      ? [
          {
            type: "image" as const,
            image_url: part.uri,
            detail: CodeModeMedia.DEFAULT_IMAGE_DETAIL,
            ...(part.name === undefined ? {} : { name: part.name }),
          },
        ]
      : [],
  )
}

/**
 * The input as the tool expects it (core's `decodeInput`): decoded by an Effect or Standard schema. A JSON Schema
 * input passes as the program gave it; core validates those through a converted codec, MCP servers validate their own.
 */
function decode(entry: Kept, args: unknown): Effect.Effect<unknown, unknown> {
  const schema = entry.info.input
  if (Schema.isSchema(schema)) return Schema.decodeUnknownEffect(schema)(args)
  if (isStandard(schema))
    return Effect.promise(async () => schema["~standard"].validate(args)).pipe(
      Effect.flatMap((result) =>
        result.issues === undefined
          ? Effect.succeed(result.value)
          : Effect.fail(
              new Error(
                `Invalid arguments for tool "${entry.id}": ${result.issues.map((issue) => issue.message).join(", ")}`,
              ),
            ),
      ),
    )
  return Effect.succeed(args)
}

function codeModeResult(entry: Kept, result: Tool.Result): Effect.Effect<unknown, unknown> {
  const parts =
    typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : (result.content ?? [])
  if (entry.mcp) {
    // Core keeps a server's structuredContent as the output of a tool with an output schema (core/src/tool/mcp.ts).
    const output = entry.info.output
    const structured =
      typeof output === "object" && output !== null && Object.keys(output).length > 0 && result.output != null
    return Effect.succeed({
      content: parts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : mcpBlock(part))),
      ...(structured ? { structuredContent: result.output } : {}),
    })
  }
  const output = entry.info.output
  if (output !== undefined && "output" in result)
    return Schema.isSchema(output) ? Schema.encodeUnknownEffect(output)(result.output) : Effect.succeed(result.output)
  // A single text item is the text itself; otherwise the non-empty texts and file URLs, one per line.
  const [only] = parts
  if (parts.length === 1 && only?.type === "text") return Effect.succeed(only.text)
  return Effect.succeed(
    parts
      .map((part) => (part.type === "text" ? part.text : part.uri))
      .filter((text) => text.trim() !== "")
      .join("\n"),
  )
}

/** An own file part as an MCP content block: core turns a server's image and audio blocks into data URLs. */
function mcpBlock(part: Tool.FileContent) {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(part.uri)
  if (data === null) return { type: "resource_link", name: part.name ?? part.uri, uri: part.uri, mimeType: part.mime }
  return { type: part.mime.startsWith("audio/") ? "audio" : "image", data: data[2], mimeType: part.mime }
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}

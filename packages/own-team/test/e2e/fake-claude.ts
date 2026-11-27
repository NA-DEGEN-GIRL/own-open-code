// A stand-in for Claude Code's `claude` binary in the team e2e tests: upstream's Claude Agent provider (core
// `plugin/provider/claude-agent`) starts it through the Agent SDK when `OPENCODE_CLAUDE_PATH` names this file (the SDK
// runs a `.ts` path with its JS runtime, `bun` under the e2e server). Every model step is answered by the directive
// responder (`directives.ts`), so an owner on the `claude-agent` provider follows the same directives as one on the
// other fakes. Nothing leaves this PC: no network, no real account; the only files it touches are under
// `CLAUDE_CONFIG_DIR` (the Claude Agent account folder the provider names, own's P-045).
//
// The protocol subset (stream-json on stdin/stdout, as in core's recordings `test/plugin/provider/claude-agent/
// fixtures/recordings/*.jsonl`):
//
// - Flags read: `--session-id=<id>`, `--resume=<id>`, `--no-session-persistence`, `--model=<alias>`. A run without a
//   session flag (the login probe) gets a random id.
// - SDK → claude `control_request`s: `initialize` (keeps `hooks` PreToolUse/PostToolUse callback ids, the SDK MCP
//   servers and their `sdkMcpServerManifests` tool lists, `systemPrompt` and `appendSystemPrompt`; answers commands,
//   models, the account, the version 2.1.302), `interrupt` (stops the running turn: a `result` of
//   `error_during_execution` follows; `{still_queued: []}`), `set_model`, `get_context_usage` (a 200k window); any
//   other control is answered with success and no data. SDK `control_response`s answer the fake's own requests.
// - SDK `user` messages: the first starts a turn; one that arrives during a turn (a steer, `priority: "next"`) joins it
//   before the next model step, after the tool results it waited behind.
// - A turn: `system/init` (the `opencode` server connected), then per model step the directive responder reads an
//   Anthropic Messages request `{system, messages, tools}` and answers. Text: `stream_event`s (message_start,
//   content_block_start/delta, the `assistant` message, content_block_stop, message_delta, message_stop) and a
//   `result`. A tool call: the same events with a `tool_use` block named `mcp__opencode__<name>`, then the claude → SDK
//   requests `hook_callback` (PreToolUse), `mcp_message` `tools/call` to server `opencode` (it returns once OpenCode ran
//   the tool through its permissions and the provider handed the result back), `hook_callback` (PostToolUse; an
//   `updatedMCPToolOutput` replaces the result), the `user` tool_result message, and the next step.
// - The conversation is kept as Anthropic messages. The provider's catch-up text (`<conversation-checkpoint>`, and the
//   `<user>`, `<assistant>`, `<tool>` role tags with `<tool-call>`/`<tool-result>` JSON) is read back into messages, so
//   the responder sees prior turns as history and only the newest user text as the request.
// - Transcripts: with a session flag and without `--no-session-persistence`, every user, assistant and tool result
//   message is appended to `CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric char as '-'>/<id>.jsonl` as
//   Claude Code writes it (`uuid`/`parentUuid`, `sessionId`, `message`, plus `last-prompt` lines), so the SDK's
//   session helpers (getSessionInfo, getSessionMessages, forkSession, deleteSession) work on it and `--resume` reads it
//   back (the chain from its newest user or assistant entry), forks included.
// - Plan limits (02 §8.10.4, P-039): a turn whose newest user text holds `[limit-rejected]` first reports a refused
//   five-hour window (`rate_limit_event`, as Claude Code does on a subscription); the usage control request
//   (`get_usage`) answers the folder's `fake-usage.json` (`{"fiveHour": <percent>}`, 12 without one) as plan windows.
// - Every received line is appended to `CLAUDE_CONFIG_DIR/fake-claude.jsonl` (`{kind: "in"}`), with the start
//   (`{kind: "spawn", args, cwd, anthropicConfigDir}`), each responder answer (`{kind: "reply"}`), each control request the fake sends
//   (`{kind: "out"}`: hook callbacks, `tools/call`), each model step's request (`{kind: "request"}`: the conversation as
//   the Anthropic messages the step read, so a test sees what a resumed transcript gave the model, P-043) and the end
//   of the process (`{kind: "exit"}`), for the tests to check.
//
// The test imports the constants and helpers below; the script itself runs only as the main module.

import fs from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit"
import { responder, turn } from "./directives.js"

/** The log of received messages, under the account folder. */
export const LOG = "fake-claude.jsonl"
export const VERSION = "2.1.302"
/** How core's compaction request asks for its summary (`session/compaction.ts` `buildPrompt`). */
export const SUMMARY_ASK = ["into a structured summary", "Update the existing checkpoint"]
/** The summary the fake writes for a compaction: core accepts a reply with the template's headings. */
export const SUMMARY = "## Objective\n- e2e 대화를 요약했습니다.\n\n## Next Move\n1. (none)"
/** In a user text: the turn reports a refused five-hour window before it answers. */
export const LIMIT_REJECTED = "[limit-rejected]"
/** The file in an account folder that sets the five-hour use the usage request answers. */
export const USAGE_FILE = "fake-usage.json"
/**
 * In a user text, `[usage:<n>]`: the turn's model steps report `n` input tokens (a large context without sending one,
 * for the compaction thresholds, CAG-50).
 */
export const USAGE_DIRECTIVE = /\[usage:(\d+)\]/
/**
 * A file in an account folder that makes the `initialize` answer leave the version out, as Claude Code 2.1.282 does
 * (CAG-49). The SDK runs this `.ts` with Bun, so a `--version` of it does not answer either.
 */
export const NO_VERSION_FILE = "fake-no-version"
/**
 * A file in an account folder that replaces {@link MODELS} (`{ models: FakeModel[] }`): the list as a real Claude
 * Code reports it (`displayName` "Opus", `resolvedModel`, `supportsFastMode`), each with the window
 * `get_context_usage` and the turns' `modelUsage` report, and Fast that runs only on a model that supports it
 * (decisions CAM). Without it nothing changes.
 */
export const MODELS_FILE = "fake-models.json"

export interface FakeModel {
  readonly value: string
  readonly resolvedModel?: string
  readonly displayName: string
  readonly description?: string
  readonly supportsFastMode?: boolean
  readonly contextWindow?: number
}
const PREFIX = "mcp__opencode__"

export const MODELS = [
  { value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default (recommended)" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
].map((model) => ({
  ...model,
  description: "e2e",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high"],
  supportsAdaptiveThinking: true,
}))

/** The models an account folder's Claude Code lists: {@link MODELS_FILE}'s, else {@link MODELS}. */
function modelsOf(configDir: string): ReadonlyArray<FakeModel> {
  const file = path.join(configDir, MODELS_FILE)
  if (!fs.existsSync(file)) return MODELS
  const listed = (JSON.parse(fs.readFileSync(file, "utf8")) as { models: FakeModel[] }).models
  return listed.map((model) => ({
    description: "e2e",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
    ...model,
  }))
}

/** Claude Code's project folder name for a working directory (the SDK's `projectKey`: realpath, then sanitized). */
export function projectKey(directory: string) {
  const real = fs.realpathSync(path.resolve(directory))
  const key = real.replace(/[^a-zA-Z0-9]/g, "-")
  if (key.length <= 200) return key
  const hash = [...real].reduce((sum, char) => ((sum << 5) - sum + char.charCodeAt(0)) | 0, 0)
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/** One line of {@link LOG}. */
export interface LogLine {
  readonly at: number
  readonly pid: number
  readonly session: string
  readonly kind: "spawn" | "in" | "out" | "reply" | "request" | "exit" | "error"
  readonly error?: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  /** `spawn`: the Anthropic profile directory it got (`ANTHROPIC_CONFIG_DIR`, core P-045), if any. */
  readonly anthropicConfigDir?: string
  readonly message?: Readonly<Record<string, unknown>>
  readonly reply?: Readonly<Record<string, unknown>>
  /** `request`: what the model step read (`{model, system, messages, tools}`, the conversation as Anthropic messages). */
  readonly request?: Readonly<Record<string, unknown>>
}

/** The lines of the log in an account folder, in write order. */
export function readLog(configDir: string): ReadonlyArray<LogLine> {
  const file = path.join(configDir, LOG)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

type Block = Readonly<Record<string, unknown>> & { readonly type: string }
interface Message {
  readonly role: "user" | "assistant"
  readonly content: ReadonlyArray<Block>
}
interface Entry {
  readonly type: "user" | "assistant"
  readonly uuid: string
  readonly parentUuid: string | null
  readonly message: { readonly role: "user" | "assistant"; readonly content: string | ReadonlyArray<Block> }
}
interface Tool {
  readonly name: string
}
/** A running turn; `stopped` once an interrupt or the end of input arrives. */
interface Turn {
  stopped: boolean
  readonly stop: PromiseWithResolvers<undefined>
}

async function main() {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (!configDir) {
    process.stderr.write("fake claude: CLAUDE_CONFIG_DIR is not set\n")
    process.exit(2)
  }
  const args = process.argv.slice(2)
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const resume = flag("resume")
  const sessionID = resume ?? flag("session-id") ?? crypto.randomUUID()
  const persist = (resume ?? flag("session-id")) !== undefined && !args.includes("--no-session-persistence")
  const cwd = process.cwd()
  const file = locate(configDir, cwd, sessionID)
  const loaded = resume === undefined ? [] : load(file)
  const state = {
    model: flag("model") ?? "default",
    system: "",
    tools: new Array<Tool>(),
    servers: new Array<string>(),
    hooks: {} as { pre?: string; post?: string },
    entries: loaded,
    last: loaded.at(-1)?.uuid ?? null,
    queue: new Array<{ readonly uuid: string; readonly content: ReadonlyArray<Block> }>(),
    turn: undefined as Turn | undefined,
    rpc: 0,
    /** Input tokens each model step reports (`[usage:<n>]`). */
    input: 1,
    /** Claude Code's `fastMode` flag setting (`apply_flag_settings`). */
    fast: false,
  }
  const waiting = new Map<string, (response: Readonly<Record<string, unknown>>) => void>()
  const respond = responder({ before: summary })

  const log = (kind: LogLine["kind"], data: Partial<LogLine>) =>
    fs.appendFileSync(
      path.join(configDir, LOG),
      JSON.stringify({ at: Date.now(), pid: process.pid, session: sessionID, kind, ...data }) + "\n",
    )
  const send = (message: Readonly<Record<string, unknown>>) => process.stdout.write(JSON.stringify(message) + "\n")
  const models = modelsOf(configDir)
  const current = () => models.find((model) => model.value === state.model)
  const resolved = () => current()?.resolvedModel ?? state.model

  /** Appends a transcript entry (when persisting) and keeps it as conversation. */
  const remember = (type: Entry["type"], uuid: string, content: ReadonlyArray<Block>) => {
    const entry: Entry = {
      type,
      uuid,
      parentUuid: state.last,
      message: type === "user" ? { role: "user", content } : assistant(content),
    }
    state.entries.push(entry)
    state.last = uuid
    if (!persist) return
    const line = {
      ...entry,
      isSidechain: false,
      userType: "external",
      cwd,
      sessionId: sessionID,
      version: VERSION,
      timestamp: new Date().toISOString(),
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(line) + "\n")
  }
  const assistant = (content: ReadonlyArray<Block>) => ({
    id: `msg_e2e${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant" as const,
    model: resolved(),
    content,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: state.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })

  /** A claude → SDK control request; resolves with the SDK's answer, or `undefined` once the turn stops. */
  const control = (turn: Turn, request: Readonly<Record<string, unknown>>) => {
    const id = crypto.randomUUID()
    const answer = new Promise<Readonly<Record<string, unknown>> | undefined>((resolve) => waiting.set(id, resolve))
    const message = { type: "control_request", request_id: id, request }
    log("out", { message })
    send(message)
    return Promise.race([answer, turn.stop.promise])
  }

  const hook = (turn: Turn, event: "PreToolUse" | "PostToolUse", use: Block, output?: unknown) => {
    const id = event === "PreToolUse" ? state.hooks.pre : state.hooks.post
    if (id === undefined) return Promise.resolve(undefined)
    return control(turn, {
      subtype: "hook_callback",
      callback_id: id,
      tool_use_id: use.id,
      input: {
        session_id: sessionID,
        transcript_path: file,
        cwd,
        permission_mode: "dontAsk",
        hook_event_name: event,
        tool_name: use.name,
        tool_input: use.input,
        tool_use_id: use.id,
        ...(output === undefined ? {} : { tool_response: output }),
      },
    })
  }

  /** PreToolUse, `tools/call` over the SDK's MCP server, PostToolUse: the tool_result block, or `undefined` if stopped. */
  const call = async (turn: Turn, use: Block): Promise<Block | undefined> => {
    await hook(turn, "PreToolUse", use)
    if (turn.stopped) return undefined
    state.rpc += 1
    const called = await control(turn, {
      subtype: "mcp_message",
      server_name: "opencode",
      message: {
        jsonrpc: "2.0",
        id: state.rpc,
        method: "tools/call",
        params: {
          name: String(use.name).slice(PREFIX.length),
          arguments: use.input,
          _meta: { "claudecode/toolUseId": use.id },
        },
      },
    })
    if (turn.stopped || called === undefined) return undefined
    const mcp = record(record(called.response).mcp_response)
    const result = record(mcp.result)
    const failure = typeof called.error === "string" ? called.error : record(mcp.error).message
    const content = Array.isArray(result.content)
      ? result.content
      : [{ type: "text", text: String(failure ?? "the tool call failed") }]
    const after = await hook(turn, "PostToolUse", use, content)
    if (turn.stopped) return undefined
    const replaced = record(record(after?.response).hookSpecificOutput).updatedMCPToolOutput
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: Array.isArray(replaced) ? replaced : content,
      ...(result.isError === true || failure !== undefined ? { is_error: true } : {}),
    }
  }

  const stream = (event: Readonly<Record<string, unknown>>) =>
    send({ type: "stream_event", event, session_id: sessionID, parent_tool_use_id: null, uuid: crypto.randomUUID() })

  /** One model reply as Claude Code streams it, kept as conversation. */
  const emit = (blocks: ReadonlyArray<Block>, stop: "end_turn" | "tool_use") => {
    const uuid = crypto.randomUUID()
    remember("assistant", uuid, blocks)
    const message = state.entries.at(-1)?.message
    stream({ type: "message_start", message: { ...message, content: [] } })
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
        stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
      }
      if (block.type === "tool_use") {
        stream({ type: "content_block_start", index, content_block: { ...block, input: {} } })
        stream({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        })
      }
    })
    send({ type: "assistant", message, parent_tool_use_id: null, session_id: sessionID, uuid })
    blocks.forEach((_, index) => stream({ type: "content_block_stop", index }))
    stream({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
    stream({ type: "message_stop" })
  }

  /** The user messages that wait: kept as conversation, a `last-prompt` line after each. */
  const take = () => {
    for (const input of state.queue.splice(0)) {
      remember("user", input.uuid, input.content)
      const text = input.content.flatMap((block) => (typeof block.text === "string" ? [block.text] : [])).join("\n")
      if (persist)
        fs.appendFileSync(
          file,
          JSON.stringify({ type: "last-prompt", lastPrompt: text.slice(0, 200), sessionId: sessionID }) + "\n",
        )
    }
  }

  const request = (): RecordedRequest => {
    const json = {
      model: resolved(),
      system: state.system,
      messages: state.entries.flatMap(messagesOf),
      tools: state.tools.map((tool) => ({ name: tool.name })),
    }
    return {
      seq: 0,
      fake: "claude",
      transport: "http",
      method: "POST",
      path: "/claude",
      headers: {},
      identity: undefined,
      body: JSON.stringify(json),
      bodyHash: "",
      json,
      model: resolved(),
      cache: undefined,
      status: 200,
      responseHeaders: {},
      at: Date.now(),
    }
  }

  /** The model steps of one turn, until a text answer, an error answer or a stop. */
  const steps = async (turn: Turn, count = 1): Promise<{ readonly steps: number; readonly end: Reply | "stopped" }> => {
    take()
    const asked = request()
    log("request", { request: asked.json as Readonly<Record<string, unknown>> })
    const reply: Reply = respond(asked) ?? { type: "text", text: "" }
    log("reply", { reply })
    const delay = "delayMs" in reply ? reply.delayMs : undefined
    if (delay !== undefined) await Promise.race([Bun.sleep(delay), turn.stop.promise])
    if (turn.stopped) return { steps: count, end: "stopped" }
    if (reply.type === "text") {
      emit([{ type: "text", text: reply.text }], "end_turn")
      return { steps: count, end: reply }
    }
    if (reply.type !== "tool-call") return { steps: count, end: reply }
    const use = {
      type: "tool_use",
      id: reply.id ?? `toolu_${crypto.randomUUID()}`,
      name: PREFIX + reply.name,
      input: reply.input,
    }
    emit([use], "tool_use")
    const result = await call(turn, use)
    const uuid = crypto.randomUUID()
    const content = [
      result ?? { type: "tool_result", tool_use_id: use.id, content: "Interrupted by user", is_error: true },
    ]
    remember("user", uuid, content)
    send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionID, uuid })
    if (turn.stopped) return { steps: count, end: "stopped" }
    return steps(turn, count + 1)
  }

  const run = async () => {
    while (state.queue.length > 0 && state.turn === undefined) {
      const turn: Turn = { stopped: false, stop: Promise.withResolvers<undefined>() }
      state.turn = turn
      send({
        type: "system",
        subtype: "init",
        cwd,
        session_id: sessionID,
        tools: state.tools.map((tool) => PREFIX + tool.name),
        mcp_servers: state.servers.map((name) => ({ name, status: "connected", source: "sdk" })),
        model: resolved(),
        permissionMode: "dontAsk",
        apiKeySource: "none",
        claude_code_version: VERSION,
        uuid: crypto.randomUUID(),
      })
      const asked = state.queue.flatMap((item) => item.content.map((block) => String(record(block).text ?? "")))
      state.input = Number(asked.map((text) => USAGE_DIRECTIVE.exec(text)?.[1]).find(Boolean) ?? 1)
      if (asked.some((text) => text.includes(LIMIT_REJECTED)))
        send({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            utilization: 1,
            resetsAt: Math.floor(Date.now() / 1000) + 3600,
          },
          uuid: crypto.randomUUID(),
          session_id: sessionID,
        })
      const outcome = await steps(turn)
      if (outcome.end === "stopped") {
        const uuid = crypto.randomUUID()
        const content = [{ type: "text", text: "[Request interrupted by user]" }]
        remember("user", uuid, content)
        send({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: sessionID,
          uuid,
        })
      }
      const model = current()
      const window = model?.contextWindow
      send({
        ...result(sessionID, outcome.steps, outcome.end),
        ...(window === undefined
          ? {}
          : {
              modelUsage: {
                [resolved()]: {
                  inputTokens: state.input,
                  outputTokens: 1,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                  webSearchRequests: 0,
                  costUSD: 0,
                  contextWindow: window,
                  maxOutputTokens: 128_000,
                },
              },
            }),
        ...(fs.existsSync(path.join(configDir, MODELS_FILE))
          ? state.fast && model?.supportsFastMode
            ? { fast_mode_state: "on" }
            : { fast_mode_state: "off", ...(state.fast ? { fast_mode_disabled_reason: "model_not_allowed" } : {}) }
          : {}),
      })
      state.turn = undefined
    }
  }

  const answer = (message: Readonly<Record<string, unknown>>) => {
    const asked = record(message.request)
    const reply = (response: unknown = {}) =>
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })
    if (asked.subtype === "initialize") {
      const hooks = record(asked.hooks)
      const first = (event: string) => {
        const matcher = record(Array.isArray(hooks[event]) ? hooks[event][0] : undefined)
        return Array.isArray(matcher.hookCallbackIds) ? String(matcher.hookCallbackIds[0]) : undefined
      }
      state.hooks = { pre: first("PreToolUse"), post: first("PostToolUse") }
      state.servers = Array.isArray(asked.sdkMcpServers) ? asked.sdkMcpServers.map(String) : []
      const manifest = record(record(record(asked.sdkMcpServerManifests).opencode).toolsListResult)
      state.tools = (Array.isArray(manifest.tools) ? manifest.tools : []).map((tool) => ({
        name: String(record(tool).name),
      }))
      const system = Array.isArray(asked.systemPrompt) ? asked.systemPrompt.join("\n") : asked.systemPrompt
      state.system = [system, asked.appendSystemPrompt]
        .filter((part) => typeof part === "string" && part !== "")
        .join("\n")
      return reply(initialized(configDir))
    }
    if (asked.subtype === "interrupt") {
      const running = state.turn
      if (running && !running.stopped) {
        running.stopped = true
        running.stop.resolve(undefined)
      }
      return reply({ still_queued: [] })
    }
    if (asked.subtype === "set_model") {
      state.model = typeof asked.model === "string" ? asked.model : "default"
      return reply()
    }
    if (asked.subtype === "get_context_usage") {
      const window = current()?.contextWindow ?? 200_000
      return reply({ totalTokens: 0, maxTokens: window, rawMaxTokens: window, percentage: 0, model: resolved() })
    }
    if (asked.subtype === "apply_flag_settings") {
      const settings = record(asked.settings)
      if (typeof settings.fastMode === "boolean") state.fast = settings.fastMode
      return reply()
    }
    if (asked.subtype === "get_usage") return reply(usage(configDir))
    return reply()
  }

  log("spawn", { args, cwd, anthropicConfigDir: process.env.ANTHROPIC_CONFIG_DIR })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (line.trim() === "") return
    const message = record(JSON.parse(line))
    log("in", { message })
    if (message.type === "control_request") return answer(message)
    if (message.type === "control_response") {
      const response = record(message.response)
      const resolve = waiting.get(String(response.request_id))
      waiting.delete(String(response.request_id))
      return resolve?.(response)
    }
    if (message.type !== "user") return
    const content = record(message.message).content
    state.queue.push({
      uuid: typeof message.uuid === "string" ? message.uuid : crypto.randomUUID(),
      content: typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [],
    })
    if (state.turn === undefined) void run().catch((error: unknown) => log("error", { error: String(error) }))
  })
  await new Promise<void>((resolve) => lines.once("close", resolve))
  const running = state.turn
  if (running) {
    running.stopped = true
    running.stop.resolve(undefined)
  }
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
  log("exit", {})
  process.exit(0)
}

/** core's compaction request gets {@link SUMMARY}; everything else goes to the directive responder. */
function summary(request: RecordedRequest): Reply | undefined {
  const user = turn(request).user
  return SUMMARY_ASK.some((ask) => user.includes(ask)) ? { type: "text", text: SUMMARY } : undefined
}

/** A usage answer for the folder (a subscription's plan windows, `utilization` in percent). */
function usage(configDir: string) {
  const file = path.join(configDir, USAGE_FILE)
  const set = fs.existsSync(file) ? record(JSON.parse(fs.readFileSync(file, "utf8"))) : {}
  const fiveHour = typeof set.fiveHour === "number" ? set.fiveHour : 12
  const resets = new Date(Date.now() + 3 * 3600_000).toISOString()
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: fiveHour, resets_at: resets },
      seven_day: { utilization: 3, resets_at: new Date(Date.now() + 5 * 86400_000).toISOString() },
    },
  }
}

/** The `initialize` answer: the models, the folder's login (its credentials file) and the version. */
function initialized(configDir: string) {
  const loggedIn = fs.existsSync(path.join(configDir, ".credentials.json"))
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: modelsOf(configDir).map((model) => {
      const { contextWindow: _window, ...listed } = model
      return listed
    }),
    account: loggedIn
      ? {
          email: "agent@example.test",
          subscriptionType: "Claude Max",
          apiProvider: "firstParty",
          tokenSource: "claude.ai",
        }
      : { tokenSource: "none", apiProvider: "firstParty" },
    pid: process.pid,
    ...(fs.existsSync(path.join(configDir, NO_VERSION_FILE)) ? {} : { claude_code_version: VERSION }),
    current_permission_mode: "dontAsk",
    fast_mode_state: "off",
    session_state: "idle",
    capabilities: [],
  }
}

function result(sessionID: string, steps: number, end: Reply | "stopped") {
  const base = {
    type: "result",
    session_id: sessionID,
    uuid: crypto.randomUUID(),
    num_turns: steps,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  }
  if (end === "stopped")
    return {
      ...base,
      subtype: "error_during_execution",
      is_error: true,
      stop_reason: null,
      errors: ["[ede_diagnostic] interrupted"],
      terminal_reason: "aborted_streaming",
    }
  if (end.type === "text")
    return {
      ...base,
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      result: end.text,
      terminal_reason: "completed",
    }
  const status = end.type === "error" ? end.status : 500
  const body = end.type === "error" ? record(record(end.body).error) : {}
  return {
    ...base,
    subtype: "success",
    is_error: true,
    stop_reason: null,
    result: typeof body.message === "string" ? body.message : `e2e answer ${end.type}`,
    api_error_status: status,
    terminal_reason: "completed",
  }
}

/** The transcript of a session: under this directory's project folder, else wherever another folder name holds it. */
function locate(configDir: string, cwd: string, sessionID: string) {
  const own = path.join(configDir, "projects", projectKey(cwd), `${sessionID}.jsonl`)
  if (fs.existsSync(own)) return own
  const projects = path.join(configDir, "projects")
  const found = (fs.existsSync(projects) ? fs.readdirSync(projects) : [])
    .map((name) => path.join(projects, name, `${sessionID}.jsonl`))
    .find((candidate) => fs.existsSync(candidate))
  return found ?? own
}

/** A transcript's conversation: the chain from its newest user or assistant entry back to the first. */
function load(file: string): Entry[] {
  if (!fs.existsSync(file)) return []
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => record(JSON.parse(line)))
    .filter((line): line is Entry & Readonly<Record<string, unknown>> => {
      return (line.type === "user" || line.type === "assistant") && typeof line.uuid === "string"
    })
  const byID = new Map(entries.map((entry) => [entry.uuid, entry]))
  const chain = (entry: Entry | undefined): Entry[] =>
    entry === undefined ? [] : [...chain(entry.parentUuid === null ? undefined : byID.get(entry.parentUuid)), entry]
  return chain(entries.at(-1)).map((entry) => ({
    type: entry.type,
    uuid: entry.uuid,
    parentUuid: entry.parentUuid,
    message: entry.message,
  }))
}

/** A transcript entry as the Anthropic messages a model reads (see {@link expand}). */
function messagesOf(entry: Entry): Message[] {
  const content =
    typeof entry.message.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message.content
  if (entry.type === "assistant") return [{ role: "assistant", content }]
  return expand(content)
}

const ROLE_TAGS = new Set(["<user>", "<assistant>", "<tool>"])
/** The provider's catch-up frame (`sync/catch-up.ts`); its history follows in role tags. */
const CATCH_UP = "<conversation-checkpoint>\nThe following is conversation history from OpenCode"

/**
 * One user input as messages: the provider's catch-up history (its `<conversation-checkpoint>` frame and the role tags
 * of `ConvertToClaudeMessage`) becomes the messages it stands for, core's own checkpoint text after a compaction (a
 * summary and recent context in one `<conversation-checkpoint>` block) a message of its own, and the blocks outside
 * any tag one user message: the newest user text the responder reads.
 */
function expand(content: ReadonlyArray<Block>): Message[] {
  const out: Message[] = []
  const loose: Block[] = []
  const open: { group?: { readonly role: string; readonly content: Block[] } } = {}
  for (const block of content) {
    const text = block.type === "text" && typeof block.text === "string" ? block.text : undefined
    if (text?.startsWith(CATCH_UP) || text === "</conversation-checkpoint>") continue
    if (text?.startsWith("<conversation-checkpoint>") && open.group === undefined) {
      out.push({ role: "user", content: [block] })
      continue
    }
    if (text !== undefined && ROLE_TAGS.has(text)) {
      open.group = { role: text.slice(1, -1), content: [] }
      continue
    }
    const group = open.group
    if (group && text === `</${group.role}>`) {
      out.push({ role: group.role === "assistant" ? "assistant" : "user", content: group.content })
      open.group = undefined
      continue
    }
    if (group) {
      group.content.push(tagged(block, text))
      continue
    }
    loose.push(block)
  }
  if (loose.length > 0) out.push({ role: "user", content: loose })
  return out
}

/** A `<tool-call>` or `<tool-result>` text of the catch-up history as the block it stands for. */
function tagged(block: Block, text: string | undefined): Block {
  const call = text === undefined ? null : /^<tool-call>\n([\s\S]*)\n<\/tool-call>$/.exec(text)
  if (call) {
    const parsed = record(JSON.parse(call[1] ?? "{}"))
    return { type: "tool_use", id: parsed.id, name: parsed.name, input: parsed.input }
  }
  const output = text === undefined ? null : /^<tool-result>\n([\s\S]*)\n<\/tool-result>$/.exec(text)
  if (output) {
    const parsed = record(JSON.parse(output[1] ?? "{}"))
    return { type: "tool_result", tool_use_id: parsed.id, content: JSON.stringify(parsed.output) }
  }
  return block
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

// Last, so the module's constants are initialized when the script runs.
if (import.meta.main) await main()

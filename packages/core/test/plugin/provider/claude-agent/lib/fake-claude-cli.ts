// OWN-PATCH(P-052) begin
// A stand-in `claude` binary that speaks the stream-json protocol over real stdio, for tests that start it as a child
// process (the PC side of the SSH-host relay, 02 §8.10.13, and own-accounts' fake-SSH e2e). Run it with Bun:
// `OPENCODE_CLAUDE_PATH=<this file>`. It needs no network and no login: its "login" is `<CLAUDE_CONFIG_DIR>/.credentials.json`
// existing, and it never prints that file.
//
// A user message picks the turn by its last text block:
// - `TOOL <name> <json>`: calls the OpenCode tool `<name>` with that input over MCP (with the PreToolUse/PostToolUse
//   hooks, as claude does), then answers `DONE <the tool's text>`.
// - `SLOW <ms>`: waits that long before answering (pool tests).
// - a text longer than 600 characters, or one naming the summary template (a compaction's request and its nudge): a
//   summary in core's template shape.
// - anything else: answers `ECHO <text>`.
// Every turn reports a `rate_limit_event` (five_hour at 42 %) and writes the conversation to
// `<CLAUDE_CONFIG_DIR>/projects/<project>/<session>.jsonl` like Claude Code (chained by parentUuid; `--resume` continues
// the file's last entry), unless `--no-session-persistence`. Each start appends its arguments, working folder,
// environment names and Anthropic profile directory to `<CLAUDE_CONFIG_DIR>/fake-claude-runs.jsonl`.
import fs from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"

const VERSION = "2.1.301"
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log(`${VERSION} (Claude Code)`)
  process.exit(0)
}

const flag = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
const configDir = process.env.CLAUDE_CONFIG_DIR ?? ""
const persist = !args.includes("--no-session-persistence")
const resumed = flag("--resume")
const sessionID = resumed ?? flag("--session-id") ?? crypto.randomUUID()
const state = { model: flag("--model") ?? "sonnet", leaf: null as string | null, next: 1, initialized: false }

if (configDir) {
  fs.appendFileSync(
    path.join(configDir, "fake-claude-runs.jsonl"),
    JSON.stringify({
      args,
      cwd: process.cwd(),
      env: Object.keys(process.env).sort(),
      configDir,
      baseURL: process.env.ANTHROPIC_BASE_URL ?? null,
      // The Anthropic profile directory it would read (P-045: the account folder's own, never the PC's).
      anthropicConfigDir: process.env.ANTHROPIC_CONFIG_DIR ?? null,
      at: Date.now(),
    }) + "\n",
  )
}

const projectKey = (directory: string) => {
  const real = (() => {
    try {
      return fs.realpathSync(path.resolve(directory))
    } catch {
      return path.resolve(directory)
    }
  })()
  return real.replace(/[^a-zA-Z0-9]/g, "-")
}
const file = path.join(configDir, "projects", projectKey(process.cwd()), `${sessionID}.jsonl`)
if (resumed && fs.existsSync(file)) {
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
  state.leaf = entries.at(-1)?.uuid ?? null
}

const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n")
const record = (type: "user" | "assistant", message: unknown, given?: string) => {
  // Like Claude Code, a user message keeps the uuid the SDK sent with it.
  const uuid = given ?? crypto.randomUUID()
  if (persist && configDir) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(
      file,
      JSON.stringify({
        type,
        uuid,
        parentUuid: state.leaf,
        isSidechain: false,
        userType: "external",
        entrypoint: "sdk-ts",
        cwd: process.cwd(),
        sessionId: sessionID,
        version: VERSION,
        timestamp: new Date().toISOString(),
        message,
      }) + "\n",
    )
  }
  state.leaf = uuid
  return uuid
}

const waiting = new Map<string, (response: any) => void>()
const ask = (request: Record<string, unknown>) => {
  const id = `fake-${state.next++}`
  write({ type: "control_request", request_id: id, request })
  return new Promise<any>((resolve) => waiting.set(id, resolve))
}

const queue: any[] = []
const busy = { turn: false }

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return
  const message = JSON.parse(line)
  if (message.type === "control_response") {
    const id = message.response?.request_id
    waiting.get(id)?.(message.response)
    waiting.delete(id)
    return
  }
  if (message.type === "control_request") return control(message)
  if (message.type === "user") {
    queue.push(message)
    void drain()
  }
})
process.stdin.on("end", () => {
  const wait = setInterval(() => {
    if (busy.turn) return
    clearInterval(wait)
    process.exit(0)
  }, 20)
})

const hooks = { pre: undefined as string | undefined, post: undefined as string | undefined }

function control(message: any) {
  const request = message.request
  const reply = (response?: unknown) =>
    write({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, ...(response === undefined ? {} : { response }) },
    })
  if (request.subtype === "initialize") {
    hooks.pre = request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0]
    hooks.post = request.hooks?.PostToolUse?.[0]?.hookCallbackIds?.[0]
    state.initialized = true
    return reply({
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [
        { value: "sonnet", displayName: "Sonnet (fake)", description: "fake", supportedEffortLevels: ["low", "medium", "high"] },
        { value: "haiku", displayName: "Haiku (fake)", description: "fake", supportedEffortLevels: [] },
      ],
      account: {
        email: "fake-owner@example.invalid",
        organization: "Fake Org",
        subscriptionType: "max",
        tokenSource: "claude.ai",
        apiProvider: "firstParty",
      },
      claude_code_version: VERSION,
      pid: process.pid,
    })
  }
  if (request.subtype === "set_model") {
    state.model = request.model ?? state.model
    return reply()
  }
  if (request.subtype === "get_context_usage") return reply({ categories: [], totalTokens: 0, maxTokens: 200000, rawMaxTokens: 200000, percentage: 0 })
  if (request.subtype === "get_usage")
    return reply({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, subscription_type: "max" })
  if (request.subtype === "interrupt") return reply({ still_queued: [] })
  return reply()
}

async function drain() {
  if (busy.turn) return
  busy.turn = true
  while (queue.length > 0) await turn(queue.shift())
  busy.turn = false
}

const text = (message: any) => {
  const content = message.message?.content
  if (typeof content === "string") return content
  const blocks = Array.isArray(content) ? content.filter((block: any) => block.type === "text") : []
  return blocks.at(-1)?.text ?? ""
}

function assistant(content: unknown[], stop: "end_turn" | "tool_use") {
  const id = `msg_fake_${state.next++}`
  const message = { model: state.model, id, type: "message", role: "assistant", content, stop_reason: null, usage: { input_tokens: 3, output_tokens: 5 } }
  const event = (body: object) =>
    write({ type: "stream_event", event: body, parent_tool_use_id: null, session_id: sessionID, uuid: crypto.randomUUID() })
  event({ type: "message_start", message: { ...message, content: [] } })
  content.forEach((block: any, index) => {
    if (block.type === "text") {
      event({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
      event({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
    }
    if (block.type === "tool_use") {
      event({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })
      event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
    }
    event({ type: "content_block_stop", index })
  })
  const uuid = record("assistant", message)
  write({ type: "assistant", message, parent_tool_use_id: null, session_id: sessionID, uuid })
  write({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, parent_tool_use_id: null, session_id: sessionID, uuid: crypto.randomUUID() })
  write({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, session_id: sessionID, uuid: crypto.randomUUID() })
}

async function turn(message: any) {
  const said = text(message)
  record("user", message.message, typeof message.uuid === "string" ? message.uuid : undefined)
  write({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionID,
    tools: [],
    mcp_servers: [{ name: "opencode", status: "connected", source: "sdk" }],
    model: state.model,
    permissionMode: "dontAsk",
    uuid: crypto.randomUUID(),
  })
  write({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: "five_hour",
      utilization: 0.42,
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
    },
    uuid: crypto.randomUUID(),
    session_id: sessionID,
  })
  const tool = /^TOOL (\S+) (.+)$/s.exec(said.trim())
  const slow = /^SLOW (\d+)/.exec(said.trim())
  if (slow) await Bun.sleep(Number(slow[1]))
  // A long instruction (a compaction's summary request) gets a summary in core's template shape.
  const summary =
    said.length > 600 || said.includes("summary template")
      ? "## Objective\n- fake summary of the conversation\n\n## Next Move\n1. (none)\n"
      : undefined
  const answer = tool ? await call(tool[1]!, JSON.parse(tool[2]!)) : (summary ?? `ECHO ${said}`)
  assistant([{ type: "text", text: answer }], "end_turn")
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    result: answer,
    stop_reason: "end_turn",
    session_id: sessionID,
    total_cost_usd: 0,
    usage: { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
  })
}

async function call(name: string, input: unknown) {
  const id = `toolu_fake_${state.next++}`
  assistant([{ type: "tool_use", id, name: `mcp__opencode__${name}`, input }], "tool_use")
  const hook = (callback: string | undefined, event: "PreToolUse" | "PostToolUse", extra: object) =>
    callback
      ? ask({
          subtype: "hook_callback",
          callback_id: callback,
          input: { session_id: sessionID, cwd: process.cwd(), hook_event_name: event, tool_name: `mcp__opencode__${name}`, tool_input: input, tool_use_id: id, ...extra },
        })
      : Promise.resolve(undefined)
  await hook(hooks.pre, "PreToolUse", {})
  const answer = await ask({
    subtype: "mcp_message",
    server_name: "opencode",
    message: { method: "tools/call", params: { name, arguments: input, _meta: { "claudecode/toolUseId": id } }, jsonrpc: "2.0", id: state.next++ },
  })
  const content = answer?.response?.mcp_response?.result?.content ?? []
  await hook(hooks.post, "PostToolUse", { tool_response: content })
  const result = content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n")
  const echo = { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] }
  const uuid = record("user", echo)
  write({ type: "user", message: echo, parent_tool_use_id: null, session_id: sessionID, uuid })
  return `DONE ${result.slice(0, 400)}`
}
// OWN-PATCH(P-052) end

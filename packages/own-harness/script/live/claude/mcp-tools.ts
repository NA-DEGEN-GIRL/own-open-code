// A stdio MCP server that serves one harness's own tools to `claude -p` (script/live/claude/run.ts): the codex
// harness's exec_command, write_stdin and apply_patch, or the pi harness's read, bash, edit and write. The tools are the
// harness plugin's own definitions, registered against a stand-in plugin context that approves everything (the test
// runs with full access in a scratch folder), so results come back in each harness's exact text.
//
//   bun mcp-tools.ts --harness codex|pi --cwd <folder>
import path from "node:path"
import { Effect } from "effect"
import { CodexTools } from "../../../src/codex/tools.js"
import { ExecManager } from "../../../src/codex/exec/manager.js"
import { PiBash } from "../../../src/pi/bash.js"
import { PiEdit } from "../../../src/pi/edit.js"
import { PiRead } from "../../../src/pi/read.js"
import { PiTools } from "../../../src/pi/tools.js"
import { PiWrite } from "../../../src/pi/write.js"

const args = process.argv.slice(2)
const option = (name: string) => args[args.indexOf(`--${name}`) + 1]
const harness = option("harness") === "pi" ? "pi" : "codex"
const cwd = path.resolve(option("cwd") ?? process.cwd())
const SESSION = "ses_claude_live_test"

type Definition = {
  readonly name: string
  readonly execute: (raw: unknown, tool: unknown) => Effect.Effect<{ content: unknown }, unknown>
}
const registered = new Map<string, Definition>()
const ctx = {
  location: { directory: cwd },
  tool: {
    transform: (apply: (editor: unknown) => void) =>
      Effect.sync(() =>
        apply({
          get: () => undefined,
          add: (definition: Definition) => void registered.set(definition.name, definition),
        }),
      ),
  },
  shell: { authorize: (input: { cwd: string }) => Effect.succeed({ cwd: path.resolve(cwd, input.cwd) }) },
  permission: {
    paths: (input: { paths: ReadonlyArray<string> }) =>
      Effect.succeed(input.paths.map((entry) => ({ absolute: path.resolve(cwd, entry), resource: path.resolve(cwd, entry) }))),
    assert: () => Effect.void,
  },
  session: {
    get: () => Effect.succeed({ id: SESSION, model: { providerID: "anthropic", id: "claude-opus-5-5" }, location: { directory: cwd } }),
  },
  model: {
    list: () =>
      Effect.succeed({ data: [{ providerID: "anthropic", id: "claude-opus-5-5", capabilities: { input: ["text", "image"] } }] }),
  },
}
const manager = new ExecManager.Manager()
// SAFETY: the stand-in implements only what these tools call; the test drives no other plugin API.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const plugin = ctx as never
if (harness === "codex") await Effect.runPromise(CodexTools.register(plugin, manager) as Effect.Effect<void>)
else await Effect.runPromise(PiTools.register(plugin) as Effect.Effect<void>)

/** What Claude sees: the harness's tool names, descriptions and JSON schemas. */
const TOOLS =
  harness === "codex"
    ? [
        { name: "exec_command", run: "exec_command", spec: CodexTools.definition("exec_command") },
        { name: "write_stdin", run: "write_stdin", spec: CodexTools.definition("write_stdin") },
        {
          name: "apply_patch",
          run: "apply_patch",
          spec: {
            description: CodexTools.definition("apply_patch").description,
            parameters: { type: "object", properties: { input: { type: "string", description: "The entire contents of the apply_patch command" } }, required: ["input"] },
          },
        },
      ].map((tool) => ({ name: tool.name, run: tool.run, description: tool.spec.description ?? "", inputSchema: tool.spec.parameters }))
    : [PiRead, PiBash, PiEdit, PiWrite].map((tool) => ({
        name: tool.NAME,
        run: PiTools.INTERNAL[tool.NAME]!,
        description: tool.DESCRIPTION,
        inputSchema: tool.SCHEMA,
      }))

let counter = 0
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
const fail = (id: unknown, message: string) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }) + "\n")

async function handle(message: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  if (message.method === "initialize")
    return reply(message.id, {
      protocolVersion: (message.params?.protocolVersion as string | undefined) ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: `own-${harness}`, version: "1.0.0" },
    })
  if (message.method === "tools/list")
    return reply(message.id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) })
  if (message.method === "tools/call") {
    const tool = TOOLS.find((entry) => entry.name === message.params?.name)
    const definition = tool && registered.get(tool.run)
    if (!definition) return fail(message.id, `unknown tool ${String(message.params?.name)}`)
    const call = { sessionID: SESSION, agent: "build", messageID: "msg_claude", id: `call_${++counter}`, progress: () => Effect.void }
    const result = await Effect.runPromise(
      definition.execute(message.params?.arguments ?? {}, call).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: String(cause) })),
      ),
    )
    if (!result.ok) return reply(message.id, { content: [{ type: "text", text: result.error }], isError: true })
    const content = result.value.content
    const text =
      typeof content === "string"
        ? content
        : (content as Array<{ type: string; text?: string; name?: string }>)
            .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type} ${item.name ?? ""}]`))
            .join("\n")
    return reply(message.id, { content: [{ type: "text", text }] })
  }
  if (message.method === "ping") return reply(message.id, {})
  if (message.id !== undefined) return fail(message.id, `unsupported ${message.method}`)
}

const decoder = new TextDecoder()
const reader = Bun.stdin.stream().getReader()
let buffer = ""
for (let read = await reader.read(); !read.done; read = await reader.read()) {
  buffer += decoder.decode(read.value, { stream: true })
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines.filter((entry) => entry.trim() !== "")) await handle(JSON.parse(line))
}
manager.terminate()

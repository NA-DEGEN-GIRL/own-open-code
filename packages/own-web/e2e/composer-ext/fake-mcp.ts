// A tiny MCP server over stdio for the composer-ext e2e (newline-delimited JSON-RPC 2.0, no SDK import so it runs
// from any directory): one prompt (`docs:summarize` as a slash command) and two resources (`@` mentions).
const PROMPTS = [
  {
    name: "summarize",
    description: "Summarize a topic <topic>",
    arguments: [{ name: "topic", description: "Topic to summarize", required: true }],
  },
]
const RESOURCES = [
  { uri: "docs://handbook/onboarding", name: "Onboarding handbook", mimeType: "text/markdown" },
  { uri: "docs://handbook/release", name: "Release checklist", mimeType: "text/markdown" },
]

interface Message {
  readonly jsonrpc: "2.0"
  readonly id?: number | string
  readonly method?: string
  readonly params?: {
    readonly protocolVersion?: string
    readonly arguments?: { readonly topic?: string }
    readonly uri?: string
  }
}

function reply(id: Message["id"], result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function fail(id: Message["id"], code: number, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`)
}

function handle(message: Message) {
  if (message.id === undefined || !message.method) return
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { prompts: { listChanged: false }, resources: { listChanged: false }, tools: {} },
        serverInfo: { name: "fake-docs", version: "1.0.0" },
      })
    case "ping":
      return reply(message.id, {})
    case "tools/list":
      return reply(message.id, { tools: [] })
    case "prompts/list":
      return reply(message.id, { prompts: PROMPTS })
    case "prompts/get":
      return reply(message.id, {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Summarize for the team: ${message.params?.arguments?.topic ?? "(none)"}` },
          },
        ],
      })
    case "resources/list":
      return reply(message.id, { resources: RESOURCES })
    case "resources/templates/list":
      return reply(message.id, { resourceTemplates: [] })
    case "resources/read":
      return reply(message.id, {
        contents: [{ uri: message.params?.uri, mimeType: "text/markdown", text: "# Handbook\nFake content." }],
      })
    default:
      return fail(message.id, -32601, `Method not found: ${message.method}`)
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line) as Message)
    } catch (error) {
      process.stderr.write(`fake-mcp: ${String(error)}\n`)
    }
  }
})
process.stdin.on("end", () => process.exit(0))

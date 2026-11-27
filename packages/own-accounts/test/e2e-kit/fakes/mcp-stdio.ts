// A fake stdio MCP server for own's MCP tests (03 §18.14, SM): run as `bun <this file> [tool …]`. Enough of MCP for
// core's client and own's connection test: `initialize` (echoing the client's protocol version), notifications,
// `tools/list` (the tool names given as arguments, default `lookup` and `summarize`, in pages of two with
// `nextCursor`), `tools/call` (echoes its arguments and the value of FAKE_MCP_ECHO), `ping`; anything else is
// "method not found". FAKE_MCP_FAIL=<text> writes the text to stderr and exits with code 3 before answering;
// FAKE_MCP_REQUIRE=<NAME> does the same when that variable is unset (a missing value). Fake data only.
import { createInterface } from "node:readline"

export const FAKE_MCP_STDIO = import.meta.path

if (import.meta.main) {
  const failure = process.env.FAKE_MCP_FAIL
  const required = process.env.FAKE_MCP_REQUIRE
  if (failure || (required && !process.env[required])) {
    process.stderr.write(`fake mcp: ${failure ?? `${required} is not set`}\n`)
    process.exit(3)
  }
  const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lookup", "summarize"]
  const tools = names.map((name) => ({
    name,
    description: `Fake ${name} tool.`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  }))
  const reply = (id: unknown, result: unknown) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: unknown
      method?: string
      params?: { protocolVersion?: string; cursor?: string; arguments?: unknown }
    }
    if (message.id === undefined) return
    if (message.method === "initialize")
      return reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "own-fake-mcp", version: "1.0.0" },
      })
    if (message.method === "tools/list") {
      const start = Number(message.params?.cursor ?? 0)
      const next = start + 2
      return reply(message.id, {
        tools: tools.slice(start, next),
        ...(next < tools.length ? { nextCursor: String(next) } : {}),
      })
    }
    if (message.method === "tools/call")
      return reply(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              arguments: message.params?.arguments ?? {},
              echo: process.env.FAKE_MCP_ECHO ?? null,
            }),
          },
        ],
      })
    if (message.method === "ping") return reply(message.id, {})
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`,
    )
  })
  lines.on("close", () => process.exit(0))
}

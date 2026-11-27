// A stand-in for `github-mcp-server stdio` (GH-22): answers MCP's initialize and tools/list with one read tool,
// `get_env`, whose result is this process's environment as JSON, so a test sees what own gave the program.
const answer = (frame: { id?: number; method?: string }) => {
  if (frame.id === undefined) return undefined
  if (frame.method === "initialize")
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "env-server", version: "1" },
    }
  if (frame.method === "tools/list")
    return {
      tools: [
        {
          name: "get_env",
          description: "This process's environment",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    }
  if (frame.method === "tools/call") return { content: [{ type: "text", text: JSON.stringify(process.env) }] }
  return undefined
}

async function serve() {
  const decoder = new TextDecoder()
  const state = { buffer: "" }
  for await (const chunk of Bun.stdin.stream()) {
    state.buffer += decoder.decode(chunk, { stream: true })
    const lines = state.buffer.split("\n")
    state.buffer = lines.pop() ?? ""
    for (const line of lines.filter((item) => item.trim())) {
      // SAFETY: the test's client sends JSON-RPC frames only.
      const frame = JSON.parse(line) as { id?: number; method?: string }
      if (frame.id !== undefined)
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: answer(frame) }) + "\n")
    }
  }
}

void serve()

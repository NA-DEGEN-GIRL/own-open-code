import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { mcpServersUsed } from "./mcp-used"

const tool = (name: string, input: Record<string, unknown> = {}) => ({
  type: "tool",
  id: name,
  name,
  state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
  time: { created: 0 },
})

describe("mcpServersUsed", () => {
  test("direct MCP tools and Code Mode calls name their servers; built-in tools add nothing", () => {
    const messages = [
      { type: "user", id: "u1", text: "hi" },
      {
        type: "assistant",
        id: "a1",
        time: { created: 1, completed: 2 },
        content: [
          tool("shell", { command: "ls" }),
          tool("secure_search", { query: "x" }),
          tool("execute", { code: "const r = await docs.search({ q: 1 })\nawait my-server.fetch()" }),
          { type: "text", text: "done" },
        ],
      },
    ] as unknown as SessionMessageInfo[]
    expect(mcpServersUsed(messages)).toEqual(["docs", "my-server", "secure"])
    expect(mcpServersUsed([])).toEqual([])
  })
})

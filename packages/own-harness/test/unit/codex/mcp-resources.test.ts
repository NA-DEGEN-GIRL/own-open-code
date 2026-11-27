import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { McpResources } from "../../../src/codex/mcp-resources.js"

const CATALOG = {
  resources: [
    { server: "zeta", name: "z", uri: "z://1" },
    { server: "alpha", name: "a", uri: "a://1", description: "First", mimeType: "text/plain" },
  ],
  templates: [{ server: "alpha", name: "rows", uriTemplate: "a://rows/{id}" }],
}

const calls: Array<{ id: string; input: unknown }> = []

/** core's resource tools as the registry lists them (core/src/tool/plugin/mcp-resource.ts), answering fixed data. */
const coreTools = [
  {
    id: McpResources.CORE_LIST,
    name: "list_mcp_resources",
    description: "",
    input: { type: "object" },
    execute: (input: { server?: string }) => {
      calls.push({ id: McpResources.CORE_LIST, input })
      if (input.server === "missing") return Effect.fail({ message: 'MCP server "missing" not found' })
      if (input.server === undefined) return Effect.succeed({ output: CATALOG })
      return Effect.succeed({
        output: {
          resources: CATALOG.resources.filter((entry) => entry.server === input.server),
          templates: CATALOG.templates.filter((entry) => entry.server === input.server),
        },
      })
    },
  },
  {
    id: McpResources.CORE_READ,
    name: "read_mcp_resource",
    description: "",
    input: { type: "object" },
    execute: (input: { server: string; uri: string }) => {
      calls.push({ id: McpResources.CORE_READ, input })
      return Effect.succeed({
        output: {
          server: input.server,
          uri: input.uri,
          contents: [
            { type: "text", uri: input.uri, text: "hello", mimeType: "text/plain" },
            { type: "blob", uri: `${input.uri}#bin`, blob: "AAEC" },
          ],
        },
      })
    },
  },
]

const ctx = {
  tool: { list: () => Effect.succeed(coreTools) },
  session: { get: () => Effect.succeed({ model: { id: "gpt-5.5" } }) },
} as unknown as Pick<Context, "tool" | "session">

const context = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" } as unknown as Tool.Context

const run = (name: string, args: unknown) => Effect.runPromise(McpResources.run(ctx, name, args, context))

describe("McpResources (mcp_resource.rs)", () => {
  test("list_mcp_resources over every server: servers in name order, Codex's field order", async () => {
    expect(await run("list_mcp_resources", {})).toEqual({
      ok: true,
      text: '{"resources":[{"server":"alpha","uri":"a://1","name":"a","description":"First","mimeType":"text/plain"},{"server":"zeta","uri":"z://1","name":"z"}]}',
    })
  })

  test("one server: the server leads the payload; blank arguments are absent", async () => {
    expect(await run("list_mcp_resource_templates", { server: " alpha ", cursor: "  " })).toEqual({
      ok: true,
      text: '{"server":"alpha","resourceTemplates":[{"server":"alpha","uriTemplate":"a://rows/{id}","name":"rows"}]}',
    })
    expect(calls.at(-1)).toEqual({ id: McpResources.CORE_LIST, input: { server: "alpha" } })
  })

  test("read_mcp_resource gives the server, the URI and the contents", async () => {
    expect(await run("read_mcp_resource", { server: "alpha", uri: "a://1" })).toEqual({
      ok: true,
      text: '{"server":"alpha","uri":"a://1","contents":[{"uri":"a://1","mimeType":"text/plain","text":"hello"},{"uri":"a://1#bin","blob":"AAEC"}]}',
    })
  })

  test("Codex's argument and failure texts", async () => {
    expect(await run("list_mcp_resources", { cursor: "next" })).toEqual({
      ok: false,
      text: "cursor can only be used when a server is specified",
    })
    expect(await run("list_mcp_resources", { server: 3 })).toEqual({
      ok: false,
      text: "failed to parse function arguments: invalid type: integer `3`, expected a string",
    })
    expect(await run("read_mcp_resource", { uri: "a://1" })).toEqual({
      ok: false,
      text: "failed to parse function arguments: missing field `server`",
    })
    expect(await run("read_mcp_resource", { server: " ", uri: "a://1" })).toEqual({
      ok: false,
      text: "server must be provided",
    })
    expect(await run("read_mcp_resource", undefined)).toEqual({
      ok: false,
      text: "failed to parse function arguments: expected value",
    })
    expect(await run("list_mcp_resources", { server: "missing" })).toEqual({
      ok: false,
      text: 'resources/list failed: MCP server "missing" not found',
    })
  })
})

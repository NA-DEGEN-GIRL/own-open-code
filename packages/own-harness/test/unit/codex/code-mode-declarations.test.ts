import { describe, expect, test } from "bun:test"
import TOOLS_WIN32 from "../../../codex-data/tools.win32.json" with { type: "json" }
import { CodeModeDeclarations } from "../../../src/codex/code-mode/declarations.js"
import { CodeModeTools } from "../../../src/codex/code-mode-tools.js"

const FULL = CodeModeTools.spec("functions", "exec").description

const tool = (name: string) => {
  const found = (TOOLS_WIN32.tools as ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }>).find(
    (entry) => entry.name === name,
  )
  if (found === undefined) throw new Error(name)
  return found
}

// Output schemas of Codex's built-in tools (codex-rs/core/src/tools/handlers: shell_spec.rs
// `unified_exec_output_schema`, view_image_spec.rs, current_time.rs); requests do not carry them.
const UNIFIED_EXEC_OUTPUT = {
  type: "object",
  properties: {
    chunk_id: { type: "string", description: "Chunk identifier included when the response reports one." },
    wall_time_seconds: { type: "number", description: "Elapsed wall time spent waiting for output in seconds." },
    exit_code: { type: "number", description: "Process exit code when the command finished during this call." },
    session_id: {
      type: "number",
      description: "Session identifier to pass to write_stdin when the process is still running.",
    },
    original_token_count: { type: "number", description: "Approximate token count before output truncation." },
    output: { type: "string", description: "Command output text, possibly truncated." },
  },
  required: ["wall_time_seconds", "output"],
  additionalProperties: false,
}
// Since rust-v0.171.0 the unified image budget (#59282, on by default) leaves `detail` out of the output.
const VIEW_IMAGE_OUTPUT = {
  type: "object",
  properties: {
    image_url: { type: "string", description: "Data URL for the loaded image." },
  },
  required: ["image_url"],
  additionalProperties: false,
}
const CURRENT_TIME_OUTPUT = {
  type: "object",
  properties: {
    current_time: { type: "string", description: "Current UTC time formatted as YYYY-MM-DD HH:MM:SS UTC." },
  },
  required: ["current_time"],
  additionalProperties: false,
}

const fn = (name: string, output?: unknown): CodeModeDeclarations.Definition => ({
  name,
  toolName: name,
  description: tool(name).description ?? "",
  kind: "function",
  input: tool(name).parameters,
  output,
})

const BUILTINS: ReadonlyArray<CodeModeDeclarations.Definition> = [
  { name: "apply_patch", toolName: "apply_patch", description: tool("apply_patch").description ?? "", kind: "freeform" },
  fn("create_goal"),
  fn("exec_command", UNIFIED_EXEC_OUTPUT),
  fn("get_goal"),
  fn("update_goal"),
  fn("view_image", VIEW_IMAGE_OUTPUT),
  fn("write_stdin", UNIFIED_EXEC_OUTPUT),
  {
    name: "clock__curr_time",
    namespace: "clock",
    toolName: "curr_time",
    description: "Return the current time in UTC.",
    kind: "function",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: CURRENT_TIME_OUTPUT,
  },
]

describe("CodeModeDeclarations.section", () => {
  test.each(BUILTINS.map((definition) => [definition.name, definition] as const))(
    "%s renders as in Codex's exec description",
    (_, definition) => {
      const text = CodeModeDeclarations.section(definition)
      expect(FULL).toContain(`\n\n${text}\n\n`)
    },
  )

  test("the built-in sections in Codex's order give the captured nested tool sections", () => {
    const present = new Set(BUILTINS.map((definition) => definition.name))
    const sections = BUILTINS.toSorted(CodeModeDeclarations.compare).map((definition) =>
      definition.namespace === "clock"
        ? `## clock\nTools for reading and waiting on time.\n\n${CodeModeDeclarations.section(definition)}`
        : CodeModeDeclarations.section(definition),
    )
    expect(CodeModeTools.execDescription(present)).toEndWith(`\n\n${sections.join("\n\n")}`)
  })
})

describe("CodeModeDeclarations.render (json_schema_types.rs)", () => {
  test("objects, property comments, required and optional fields", () => {
    expect(
      CodeModeDeclarations.render({
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      }),
    ).toBe("{ city: string; }")
    expect(
      CodeModeDeclarations.render({
        type: "object",
        properties: {
          weather: {
            type: "array",
            description: "look up weather for a given list of locations",
            items: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
          },
        },
        required: ["weather"],
      }),
    ).toBe("{\n  // look up weather for a given list of locations\n  weather: Array<{ location: string; }>;\n}")
    expect(CodeModeDeclarations.render({ type: "object", properties: {} })).toBe("{ [key: string]: unknown; }")
    expect(CodeModeDeclarations.render({ type: "object", properties: { "a-b": { const: 1 } } })).toBe(
      '{ "a-b"?: 1; }',
    )
  })

  test("recursive local refs with escaped pointer segments", () => {
    const rendered = CodeModeDeclarations.render({
      type: "object",
      properties: { clauses: { type: "array", items: { $ref: "#/$defs/Boolean~1Clause~0v1" } } },
      $defs: {
        "Boolean/Clause~v1": { type: "object", properties: { query: { $ref: "#/$defs/Query" } } },
        Query: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: { clauses: { type: "array", items: { $ref: "#/$defs/Boolean~1Clause~0v1" } } },
            },
          ],
        },
      },
    })
    expect(rendered).toContain("clauses?: Array<{ query?: string | { clauses?: Array<{")
    expect(rendered).toContain("query?: string | { clauses?: Array<unknown>; };")
  })

  test("ref siblings, URI fragments and allOf precedence", () => {
    expect(
      CodeModeDeclarations.render({ $ref: "#/$defs/Label", enum: ["A"], $defs: { Label: { type: "string" } } }),
    ).toBe('(string) & ("A")')
    expect(CodeModeDeclarations.render({ $ref: "#/$defs/Foo%20Bar", $defs: { "Foo Bar": { type: "string" } } })).toBe(
      "string",
    )
    expect(
      CodeModeDeclarations.render({
        allOf: [{ $ref: "#/$defs/Choice" }, { type: "object", properties: { value: { type: "string" } } }],
        $defs: { Choice: { oneOf: [{ type: "string" }, { type: "number" }] } },
      }),
    ).toBe("(string | number) & { value?: string; }")
  })

  test("local refs under a nested schema resource stay unresolved", () => {
    expect(
      CodeModeDeclarations.render({
        $defs: { Choice: { type: "string" } },
        type: "object",
        properties: {
          nested: {
            $id: "urn:nested",
            $defs: { Choice: { type: "number" } },
            type: "object",
            properties: { value: { $ref: "#/$defs/Choice" } },
          },
        },
      }),
    ).toBe("{ nested?: { value?: unknown; }; }")
  })

  test("ref expansions are bounded; dangling refs are not charged", () => {
    const missing = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`a_missing_${index}`, { $ref: `#/$defs/Missing${index}` }]),
    )
    expect(
      CodeModeDeclarations.render({
        type: "object",
        properties: { ...missing, z_valid: { $ref: "#/$defs/Valid" } },
        $defs: { Valid: { type: "string" } },
      }),
    ).toContain("z_valid?: string;")
    const rendered = CodeModeDeclarations.render({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 34 }, (_, index) => [`property_${index}`, { $ref: "#/$defs/Item" }]),
      ),
      $defs: { Item: { type: "string" } },
    })
    expect(rendered.match(/string/g)).toHaveLength(32)
    expect(rendered.match(/unknown/g)).toHaveLength(2)
  })

  test("budgets: render work and the size cap give unknown", () => {
    expect(
      CodeModeDeclarations.render({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`property_${index}`, { $ref: "#/$defs/Item" }]),
        ),
        $defs: {
          Item: {
            type: "object",
            properties: { value: { type: "string", description: "x".repeat(8_000) } },
          },
        },
      }),
    ).toBe("unknown")
    expect(
      CodeModeDeclarations.render({ $ref: "#/$defs/Value", $defs: { Value: { const: "x".repeat(64_000) } } }),
    ).toBe("unknown")
    expect(
      CodeModeDeclarations.render({ type: "object", properties: { value: { type: "string", description: "x".repeat(16_000) } } }),
    ).toBe("unknown")
  })
})

describe("CodeModeDeclarations.sample (description.rs)", () => {
  const mcpResult = (structured: unknown) => CodeModeDeclarations.mcpOutputSchema(structured)

  test("a typed declaration with its output", () => {
    expect(
      CodeModeDeclarations.sample({
        name: "hidden_dynamic_tool",
        toolName: "hidden_dynamic_tool",
        description: "Test tool",
        kind: "function",
        input: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
        output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      }),
    ).toBe(
      "Test tool\n\nexec tool declaration:\n```ts\ndeclare const tools: { hidden_dynamic_tool(args: { city: string; }): Promise<{ ok: boolean; }>; };\n```",
    )
  })

  test("MCP tools return CallToolResult with their structured content type", () => {
    const sample = (output: unknown) =>
      CodeModeDeclarations.sample({
        name: "mcp__sample__search",
        namespace: "mcp__sample",
        toolName: "search",
        description: "Search",
        kind: "function",
        input: { type: "object", properties: {}, additionalProperties: false },
        output,
      })
    expect(
      sample(
        mcpResult({
          type: "object",
          properties: { results: { type: "array", items: { $ref: "#/definitions/Result~1item~0v1" } } },
          required: ["results"],
          additionalProperties: false,
          definitions: {
            "Result/item~v1": {
              type: "object",
              properties: { id: { type: "string" }, score: { type: "number" } },
              required: ["id", "score"],
              additionalProperties: false,
            },
          },
        }),
      ),
    ).toContain(
      "mcp__sample__search(args: {}): Promise<CallToolResult<{ results: Array<{ id: string; score: number; }>; }>>;",
    )
    expect(sample(mcpResult({}))).toContain("mcp__sample__search(args: {}): Promise<CallToolResult>;")
  })

  test("names: identifiers, Code Mode names and headings", () => {
    expect(CodeModeDeclarations.identifier("hidden-dynamic-tool")).toBe("hidden_dynamic_tool")
    expect(CodeModeDeclarations.identifier("1tool")).toBe("_tool")
    expect(CodeModeDeclarations.codeModeName("mcp__docs", "search")).toBe("mcp__docs__search")
    expect(CodeModeDeclarations.codeModeName("mcp__docs_", "search")).toBe("mcp__docs_search")
    expect(CodeModeDeclarations.sanitizeName("my-server.v2")).toBe("my_server_v2")
    expect(
      CodeModeDeclarations.heading({ name: "web-tools__run", toolName: "run", description: "", kind: "function" }),
    ).toBe("### `web_tools__run` (`web-tools__run`)")
  })
})

describe("CodeModeDeclarations.sanitizeInput (tools/src/json_schema.rs)", () => {
  test("lowers to Codex's schema subset", () => {
    expect(
      CodeModeDeclarations.sanitizeInput({
        type: "object",
        properties: {
          mode: { const: "fast" },
          flag: true,
          count: { minimum: 1 },
          pair: { prefixItems: [{ type: "number" }, { type: "string" }] },
          anything: { title: "free-form" },
        },
        $defs: { Unused: { type: "string" } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        anything: {},
        count: { type: "number" },
        flag: { type: "string" },
        mode: { type: "string", enum: ["fast"] },
        pair: { type: "array", items: { type: "string" } },
      },
    })
  })

  test("MCP input gets root properties; a singleton null schema is rejected", () => {
    expect(CodeModeDeclarations.sanitizeMcpInput({ type: "object" })).toEqual({ type: "object", properties: {} })
    expect(CodeModeDeclarations.sanitizeInput({ type: "null" })).toBeUndefined()
  })

  test("large schemas are compacted, descriptions first", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field_${index}`, { type: "string", description: "d".repeat(200) }]),
    )
    const lowered = CodeModeDeclarations.sanitizeInput({ type: "object", properties })
    expect(lowered).toEqual({
      type: "object",
      properties: Object.fromEntries(Object.keys(properties).toSorted().map((key) => [key, { type: "string" }])),
    })
  })
})

describe("CodeModeTools.execDescription with own's kept tools", () => {
  const present = new Set(["apply_patch", "exec_command", "clock__curr_time"])

  test("kept tools are sorted in among Codex's sections", () => {
    const text = CodeModeTools.execDescription(present, [
      { name: "b_tool", toolName: "b_tool", description: "B.", kind: "function", input: { type: "object", properties: {} } },
      {
        name: "mcp__docs__search",
        namespace: "mcp__docs",
        toolName: "search",
        description: "Search docs.",
        kind: "function",
        input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        output: CodeModeDeclarations.mcpOutputSchema({}),
      },
    ])
    const order = ["### `apply_patch`", "### `b_tool`", "### `exec_command`", "## clock\n", "### `mcp__docs__search`"]
    const positions = order.map((marker) => text.indexOf(marker))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect(positions).toEqual(positions.toSorted((left, right) => left - right))
    expect(text).toEndWith(
      "### `mcp__docs__search`\nSearch docs.\n\nexec tool declaration:\n```ts\ndeclare const tools: { mcp__docs__search(args: { q: string; }): Promise<CallToolResult>; };\n```",
    )
  })

  test("a kept tool whose JavaScript name is taken is left out", () => {
    const text = CodeModeTools.execDescription(present, [
      { name: "exec-command", toolName: "exec-command", description: "Other.", kind: "function" },
    ])
    expect(text).not.toContain("Other.")
  })
})

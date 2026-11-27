import { describe, expect, test } from "bun:test"
import { CodeModeCatalog } from "../../../../core/src/codemode/catalog.js"
import { CodeModeInstructions } from "../../../../core/src/codemode/instructions.js"
import { PiVariant } from "../../../src/pi/variant.js"

// Core's Code Mode catalog as a pi session received it (2026-10-14 prompt capture), three of its eight entries.
const CATALOG = `# Code Mode

The tools listed below cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

The catalog is complete. Do not guess tool names.

## Code Mode tools (call only inside \`execute\`)

- opencode (8 tools) // Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.
  - tools.opencode.session_rename({
  /** Omit to rename the current session. @pattern ^ses */
  sessionID?: string,
  /** New session title. @minLength 1 */
  title: string,
}): Promise<{
  /** @pattern ^ses */
  sessionID: string,
  title: string,
}> // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo...
  - tools.opencode.worktree_list(): Promise<{
  worktrees: Array<{
      directory: string,
      strategy?: string,
    }>,
}> // List a repository's worktrees.
  - tools.opencode.worktree_remove({
  /** Absolute path of the worktree to remove. @minLength 1 */
  directory: string,
  /** Discard modified and untracked files. Only set this when the user has confirmed forced removal. */
  force?: boolean,
}): Promise<{
  directory: string,
  removed: boolean,
}> // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.`

describe("PiVariant.codemode", () => {
  test("each entry becomes its path, argument names and description; core's heading text stays", () => {
    expect(PiVariant.codemode(CATALOG)).toBe(`# Code Mode

The tools listed below cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

The catalog is complete. Do not guess tool names.

## Code Mode tools (call only inside \`execute\`)

Each tool is listed by its argument names (\`?\` marks an optional one). Return a call's result from \`execute\` to see its shape.

- opencode (8 tools) // Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.
  - tools.opencode.session_rename({ sessionID?, title }) // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo...
  - tools.opencode.worktree_list() // List a repository's worktrees.
  - tools.opencode.worktree_remove({ directory, force? }) // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.`)
  })

  test("a one-line object input and bracketed paths", () => {
    const text = `## Code Mode tools (call only inside \`execute\`)\n\n- mcp (1 tools)\n  - tools.mcp["read-file"]({ path: string, lines?: number }): Promise<string> // Reads a file.`
    expect(PiVariant.codemode(text)).toContain(`  - tools.mcp["read-file"]({ path, lines? }) // Reads a file.`)
  })

  test("cuts the catalog core renders now (a renamed heading would leave it whole)", () => {
    const rendered = CodeModeInstructions.render(
      CodeModeCatalog.summarize({
        tools: [
          {
            type: "namespace",
            name: "own",
            tools: [
              {
                type: "tool",
                name: "pick",
                description: "Picks a file.",
                signature:
                  "tools.own.pick({\n  /** The file. */\n  path: string,\n  lines?: number,\n}): Promise<{\n  text: string,\n}>",
              },
            ],
          },
        ],
      }),
    )
    const cut = PiVariant.codemode(rendered)
    expect(cut).not.toBe(rendered)
    expect(cut).toContain("  - tools.own.pick({ path, lines? }) // Picks a file.")
  })

  test("a catalog without tools, or a signature it does not know, stays as core wrote it", () => {
    const none = "No Code Mode tools are currently available."
    expect(PiVariant.codemode(none)).toBe(none)
    const odd = `## Code Mode tools (call only inside \`execute\`)\n\n- x (1 tools)\n  - tools.x.y(input: string): Promise<string> // Odd.`
    expect(PiVariant.codemode(odd)).toBe(odd)
  })
})

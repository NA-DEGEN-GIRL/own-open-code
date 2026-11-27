// The Code Mode golden comparison (10 §4.1) shared by the GPT-6 scenes (golden-gpt6.test.ts) and the runtime-row scene
// (runtime-row.test.ts): own's two requests for "Show me what is in hello.txt." against Codex CLI 0.171.0's capture,
// normalized (ids, Codex-internal metadata, paths, CRLF, the capture's date), except the known gaps below.
import { expect } from "bun:test"
import { CodeModeTools } from "../../src/codex/code-mode-tools.js"

/** What Codex sends that the codex harness does not have yet. */
export const KNOWN_GAPS = {
  /** Nested tools `exec` describes. `web.run` calls OpenAI's standalone search backend (`alpha/search`). */
  nested: ["web__run"],
  /** Tools in the `functions` namespace. */
  functions: [] as Array<string>,
  namespaces: [] as Array<string>,
  /** own's tools Codex has no counterpart for yet (Codex's `collaboration` namespace replaces `subagent`). */
  extra: [] as Array<string>,
  /**
   * own's kept tools `exec` describes that Codex has no counterpart for: core's Code Mode tools in its `opencode`
   * namespace, nested as Codex nests dynamic tools. Its MCP resource tools are not nested: Codex's own
   * list_mcp_resources and read_mcp_resource read through them.
   */
  ownNested: [
    // Core's web search, nested because own has no web__run (code-mode-tools.ts TOP_LEVEL).
    "websearch",
    // Core's MCP event list (v2.4.0, #65271).
    "opencode__list_mcp_events",
    "opencode__models",
    "opencode__worktree_create",
    "opencode__worktree_list",
    "opencode__worktree_remove",
    // `tools.opencode.session.move` and `.rename` since v2.4.0 (#65080): nested one level deeper.
    "opencode_session__move",
    "opencode_session__rename",
  ],
  /** Developer messages, by their opening tag. */
  developer: [] as Array<string>,
  fields: [] as Array<string>,
}

export type Item = Record<string, any>
export type Body = { input: Array<Item>; [key: string]: unknown }

/** Drops what differs by design between any two runs (ids, Codex-internal metadata) and folds paths and CRLF. */
export function normalize(value: unknown, workspace?: string): unknown {
  const text = JSON.stringify(value, (key, entry) =>
    key === "id" || key === "internal_chat_message_metadata_passthrough" ? undefined : entry,
  )
  // The capture's date is the day it was taken.
  const folded = text
    .replaceAll("\\r\\n", "\\n")
    .replace(/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/g, "<current_date>DATE</current_date>")
  const placed =
    workspace === undefined ? folded : folded.replaceAll(JSON.stringify(workspace).slice(1, -1), "<WORKSPACE>")
  return JSON.parse(placed)
}

/** A message with the skill list of its `<skills_instructions>` folded to a placeholder. */
const skillFrame = (item: Item) =>
  Array.isArray(item.content)
    ? {
        ...item,
        content: item.content.map((part: Item) => ({
          ...part,
          text: String(part.text).replace(/### Skill roots\n[\s\S]*<\/skills_instructions>$/, "<SKILLS></skills_instructions>"),
        })),
      }
    : item

const opening = (item: Item) => /^<[a-z_]+>/.exec(item.content?.[0]?.text ?? "")?.[0]

/** The nested tool headings of an `exec` description. */
const nestedNames = (description: string) => [...description.matchAll(/^### `([^`]+)`/gm)].map((match) => match[1]!)

/** own's `exec` description without the sections of `KNOWN_GAPS.ownNested` (sections start at a `### ` heading). */
const withoutOwnNested = (description: string) =>
  description
    .split(/\n\n(?=### `|## [a-z_]+\n)/)
    .filter((section) => !KNOWN_GAPS.ownNested.some((name) => section.startsWith(`### \`${name}\``)))
    .join("\n\n")

/** Codex's `additional_tools` with the known gaps taken out, for comparison with own's. */
function withoutGaps(tools: Array<Item>) {
  return tools
    .filter((namespace) => !KNOWN_GAPS.namespaces.includes(namespace.name))
    .map((namespace) =>
      namespace.name !== "functions"
        ? namespace
        : {
            ...namespace,
            tools: namespace.tools
              .filter((tool: Item) => !KNOWN_GAPS.functions.includes(tool.name))
              .map((tool: Item) =>
                tool.name !== "exec"
                  ? tool
                  : {
                      ...tool,
                      description: CodeModeTools.execDescription(
                        new Set(
                          [...String(tool.description).matchAll(/^### `([^`]+)`$/gm)]
                            .map((match) => match[1]!)
                            .filter((name) => !KNOWN_GAPS.nested.includes(name)),
                        ),
                      ),
                    },
              ),
          },
    )
}

/**
 * Expects own's two requests (`mine`, normalized) to be Codex's (`theirs`, normalized) but for the known gaps. own's
 * extra nested tools are exactly {@link KNOWN_GAPS} `ownNested`, or with `partialOwnNested` some of them (a server whose
 * plugins leave some of core's tools out).
 */
export function expectCodeModeParity(mine: Array<Body>, theirs: Array<Body>, partialOwnNested = false) {
  // Both requests: the same items in the same order (the effort update right after the user's message, once).
  const kinds = (body: Body) => body.input.map((item) => `${item.type}${item.role ? `/${item.role}` : ""}`)
  expect(mine.map(kinds)).toEqual(theirs.map(kinds))
  const updates = (body: Body) => body.input.filter((item) => item.type === "configuration_update")
  expect(mine.map(updates)).toEqual(theirs.map(updates))
  const low = { type: "configuration_update", reasoning: { effort: "low" } }
  expect(theirs.map(updates)).toEqual([[low], [low]])

  // Tools: one additional_tools item, Codex's bytes but for the gaps; no top-level tools.
  expect(mine[0]!.tools).toBeUndefined()
  const myTools = mine[0]!.input[0]!.tools.map((namespace: Item) =>
    namespace.name !== "functions"
      ? namespace
      : {
          ...namespace,
          tools: namespace.tools
            .filter((tool: Item) => !KNOWN_GAPS.extra.includes(tool.name))
            .map((tool: Item) =>
              tool.name !== "exec" ? tool : { ...tool, description: withoutOwnNested(String(tool.description)) },
            ),
        },
  )
  const execOf = (tools: Array<Item>) =>
    String(tools.find((namespace) => namespace.name === "functions")!.tools.find((tool: Item) => tool.name === "exec")!.description)
  const theirNested = nestedNames(execOf(theirs[0]!.input[0]!.tools))
  const extra = nestedNames(execOf(mine[0]!.input[0]!.tools)).filter((name) => !theirNested.includes(name))
  expect(extra).toEqual(partialOwnNested ? KNOWN_GAPS.ownNested.filter((name) => extra.includes(name)) : KNOWN_GAPS.ownNested)
  expect({ ...mine[0]!.input[0], tools: myTools }).toEqual({
    ...theirs[0]!.input[0],
    tools: withoutGaps(theirs[0]!.input[0]!.tools),
  })
  expect(theirs[0]!.input[0]!.tools.map((namespace: Item) => namespace.name)).toEqual([
    "functions",
    "clock",
    "collaboration",
  ])

  // Developer and context messages: Codex's, but for the multi-agent messages.
  // The skills fragment lists each installation's own skills, so only its frame is compared.
  const theirPrefix = theirs[0]!.input.slice(1, -1).filter((item) => !KNOWN_GAPS.developer.includes(opening(item)!))
  expect(mine[0]!.input.slice(1, -1).map(skillFrame)).toEqual(theirPrefix.map(skillFrame))
  expect(mine[0]!.input.at(-1)).toEqual(theirs[0]!.input.at(-1))

  // The exec call and its output items (timings differ per run).
  const myCall = mine[1]!.input.find((item) => item.type === "custom_tool_call")
  const theirCall = theirs[1]!.input.find((item) => item.type === "custom_tool_call")
  expect({ ...myCall, call_id: undefined }).toEqual({ ...theirCall, call_id: undefined })
  const myOutput = mine[1]!.input.find((item) => item.type === "custom_tool_call_output")!.output as Array<Item>
  const theirOutput = theirs[1]!.input.find((item) => item.type === "custom_tool_call_output")!.output as Array<Item>
  const header = /^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/
  expect(myOutput[0]!.text).toMatch(header)
  expect(theirOutput[0]!.text).toMatch(header)
  expect(myOutput.slice(1)).toEqual(theirOutput.slice(1))

  // Request fields.
  const fields = Object.keys(theirs[0]!).filter(
    (field) => !["input", "client_metadata", "prompt_cache_key", "model"].includes(field),
  )
  expect(fields.filter((field) => JSON.stringify(mine[0]![field]) !== JSON.stringify(theirs[0]![field]))).toEqual(
    KNOWN_GAPS.fields,
  )
}

export * as Brief from "./brief.js"

import { optional } from "@opencode/schema/schema"
import { Token } from "@own/protocol/token"
import { Option, Schema } from "effect"
import { Fill } from "../migrate/fill.js"
import type { Transcript } from "./ir.js"

/**
 * The program's facts about a conversation and the LLM-free checkpoint `briefAt(x)` (09 §4.4). Both are extracted
 * deterministically from the IR, so the same transcript always gives the same text (01 R8). LLM summaries keep
 * decisions but hardly ever commands (`[R-others]`: decisions 77%, commands 0.2%), so the brief is appended to every
 * summary, as 06 §6.2's program hand-off does.
 */

export const HEADER = "## Facts extracted from the original record"
/** Commands the brief lists, the newest ones. */
export const COMMANDS = 20
/** Characters of the last assistant text the brief keeps as the stop point. */
export const STOP_CHARS = 500
/** User requests `briefAt` keeps, newest first: Codex's `replacement_history` rule (20k tokens, the last one cut). */
export const RECENT_TOKENS = 20_000
/** Core's `TOOL_OUTPUT_MAX_CHARS` (`packages/core/src/session/compaction.ts`): what a summary request shows of one tool output. */
export const TOOL_CHARS = 1_250
/** Characters of one command line in the brief. */
const COMMAND_CHARS = 300

/** Tools that run a shell command: Codex `exec_command`, `shell`, `local_shell`, Claude Code `Bash`, `PowerShell`. */
export const SHELL: ReadonlySet<string> = new Set([
  "exec_command",
  "shell",
  "shell_command",
  "local_shell",
  "container.exec",
  "Bash",
  "PowerShell",
])

/** Claude Code tools that write one file named by `file_path` (or `notebook_path`). */
const EDIT: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
/** Plan tools: Claude Code `TodoWrite`, Codex `update_plan`. */
const PLAN: ReadonlySet<string> = new Set(["TodoWrite", "update_plan"])

/**
 * The facts of the given pieces (09 §4.4 brief): the files changed, the last {@link COMMANDS} commands with their exit
 * codes, the last plan (`TodoWrite`, `update_plan`) and where the original model stopped (the first
 * {@link STOP_CHARS} characters of its last text). Sections without facts are left out.
 */
export function brief(pieces: ReadonlyArray<Fill.Piece>) {
  const steps = pieces.flatMap((piece) => piece.turn.steps.slice(piece.from, piece.to))
  const tools = steps.filter((step): step is Transcript.ToolStep => step.type === "tool")
  const files = [...new Set(tools.filter((tool) => tool.output?.error !== true).flatMap(changed))]
  const commands = tools.flatMap((tool) => {
    const line = SHELL.has(tool.name) ? command(tool.input) : undefined
    return line === undefined ? [] : [`- ${oneLine(line)} (${exit(tool)})`]
  })
  const plan = tools.findLast((tool) => PLAN.has(tool.name))
  const stop = steps.findLast((step) => step.type === "text")
  const sections = [
    ...(files.length === 0 ? [] : [["Changed files:", ...files.map((file) => `- ${file}`)].join("\n")]),
    ...(commands.length === 0 ? [] : [["Last commands, oldest first:", ...commands.slice(-COMMANDS)].join("\n")]),
    ...(plan === undefined ? [] : [`Last plan (${plan.name}):\n${planText(plan.input)}`]),
    ...(stop === undefined
      ? []
      : [
          `Where it stopped (the last assistant text, first ${STOP_CHARS} characters):\n${chars(stop.text, STOP_CHARS)}`,
        ]),
  ]
  return [HEADER, ...(sections.length === 0 ? ["Nothing was recorded before this point."] : sections)].join("\n\n")
}

/**
 * The program checkpoint at x (09 §4.4): what covers the conversation before x without an LLM. `summary` is the last
 * foreign summary before x (already cleaned by the parser) followed by the brief of everything before x. `recent` is
 * the user requests before x, newest first up to {@link RECENT_TOKENS}, as `[User]:` lines in their order; at a Codex
 * remote boundary that is exactly the requests Codex kept in `replacement_history`.
 */
export function briefAt(transcript: Pick<Fill.Zones, "turns" | "checkpoints">, x: Fill.Cut) {
  const before = Fill.pieces(transcript.turns, Fill.START, x)
  const placed = transcript.checkpoints.filter((checkpoint) => Fill.compare(Fill.at(checkpoint), x) <= 0)
  const foreign = placed.findLast((checkpoint) => checkpoint.kind === "foreign" && checkpoint.summary !== undefined)
  const remote = placed.find(
    (checkpoint) => checkpoint.kind === "codex-remote" && Fill.compare(Fill.at(checkpoint), x) === 0,
  )
  const facts = brief(before)
  return {
    summary: foreign?.summary === undefined ? facts : `${foreign.summary}\n\n${facts}`,
    recent: remote === undefined ? requests(before) : serialize(remote.recent),
  }
}

/**
 * The user requests of the pieces as `[User]:` lines: from the newest back while they fit in `budget` tokens; the one
 * that does not fit is cut to what is left and ends the list (Codex `build_compacted_history`).
 */
export function requests(pieces: ReadonlyArray<Fill.Piece>, budget = RECENT_TOKENS) {
  const texts = pieces.flatMap((piece) =>
    piece.user && piece.turn.user.text.trim() !== "" ? [piece.turn.user.text] : [],
  )
  const kept: string[] = []
  for (let index = texts.length - 1, left = budget; index >= 0 && left > 0; index--) {
    const tokens = Token.estimate(texts[index])
    if (tokens <= left) {
      kept.push(texts[index])
      left -= tokens
      continue
    }
    const cut = fitTokens(texts[index], left)
    if (cut.trim() !== "") kept.push(`${cut}\n[truncated]`)
    break
  }
  return kept
    .toReversed()
    .map((text) => `[User]: ${text}`)
    .join("\n\n")
}

const LABEL: Record<Transcript.Line["role"], string> = {
  user: "[User]",
  assistant: "[Assistant]",
  "tool-call": "[Assistant tool call]",
  "tool-result": "[Tool result]",
}

/**
 * A checkpoint's `recent` lines in core's `messageToText` format (`[User]: …`, `[Assistant]: …`,
 * `[Assistant tool call]: …`, `[Tool result]: …` cut like core). One entry per message: a user line starts one, and so
 * does model text after a tool result; lines of one entry are joined by a line break, entries by a blank line.
 */
export function serialize(lines: ReadonlyArray<Transcript.Line>) {
  return lines
    .map((line, index) => {
      const previous = lines[index - 1]
      const text = `${LABEL[line.role]}: ${line.role === "tool-result" ? truncate(line.text) : line.text}`
      if (previous === undefined) return text
      const entry =
        line.role === "user" ||
        previous.role === "user" ||
        (line.role === "assistant" && previous.role === "tool-result")
      return `${entry ? "\n\n" : "\n"}${text}`
    })
    .join("")
}

/** Core's `truncateToolOutput`: at most `max` code points, then `\n[truncated]`. */
export function truncate(text: string, max = TOOL_CHARS) {
  const points = Array.from(text)
  return points.length <= max ? text : `${points.slice(0, max).join("")}\n[truncated]`
}

const Shell = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const decodeShell = Schema.decodeUnknownOption(Schema.Struct({ cmd: optional(Shell), command: optional(Shell) }))
/** The flag before an inline script: `bash -lc <script>`, `cmd /c <script>`, `powershell -Command <script>`. */
const SCRIPT_FLAG = /^(?:-l?c|\/c|-command)$/i

/**
 * The command line of a shell tool's input (`cmd` or `command`, a string or an argv). An argv that runs an inline
 * script (`["bash", "-lc", "bun test"]`) is the script; another argv is joined with spaces.
 */
export function command(input: unknown) {
  const value = Option.getOrUndefined(decodeShell(input))
  const line = value?.cmd ?? value?.command
  if (line === undefined || typeof line === "string") return line
  return line.length >= 3 && SCRIPT_FLAG.test(line[line.length - 2]) ? line[line.length - 1] : line.join(" ")
}

const decodeFile = Schema.decodeUnknownOption(
  Schema.Struct({ file_path: optional(Schema.String), notebook_path: optional(Schema.String) }),
)
const decodePatch = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Struct({ input: Schema.String }), Schema.Struct({ patch: Schema.String })]),
)
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm

/** The files a tool call changed: its per-file diff, an `apply_patch` body's file lines, an edit tool's path. */
function changed(tool: Transcript.ToolStep) {
  const diff = tool.diff?.map((file) => file.file) ?? []
  if (tool.name === "apply_patch") {
    const patch = Option.getOrUndefined(decodePatch(tool.input))
    const body =
      patch === undefined ? "" : typeof patch === "string" ? patch : "input" in patch ? patch.input : patch.patch
    return [...diff, ...Array.from(body.matchAll(PATCH_FILE), (match) => match[1].trim())]
  }
  if (!EDIT.has(tool.name)) return diff
  const file = Option.getOrUndefined(decodeFile(tool.input))
  const path = file?.file_path ?? file?.notebook_path
  return path === undefined ? diff : [...diff, path]
}

function exit(tool: Transcript.ToolStep) {
  if (tool.exit !== undefined) return `exit ${tool.exit}`
  if (tool.output === undefined) return "no result"
  return tool.output.error ? "failed" : "no exit code"
}

const decodeTodos = Schema.decodeUnknownOption(
  Schema.Struct({ todos: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })) }),
)
const decodeSteps = Schema.decodeUnknownOption(
  Schema.Struct({
    explanation: optional(Schema.NullOr(Schema.String)),
    plan: Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
  }),
)

/** A plan tool's input as `- [status] item` lines; an input of another shape as its JSON. */
function planText(input: unknown) {
  const todos = Option.getOrUndefined(decodeTodos(input))
  if (todos !== undefined) return todos.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")
  const steps = Option.getOrUndefined(decodeSteps(input))
  if (steps !== undefined)
    return [
      ...(steps.explanation ? [steps.explanation] : []),
      ...steps.plan.map((step) => `- [${step.status}] ${step.step}`),
    ].join("\n")
  return typeof input === "string" ? input : (JSON.stringify(input) ?? "")
}

/** A command on one line: line breaks become ` ⏎ `, then at most {@link COMMAND_CHARS} characters. */
function oneLine(text: string) {
  const line = text.trim().replace(/\s*\r?\n\s*/g, " ⏎ ")
  const points = Array.from(line)
  return points.length <= COMMAND_CHARS ? line : `${points.slice(0, COMMAND_CHARS).join("")}…`
}

/** The first `max` code points. */
function chars(text: string, max: number) {
  return Array.from(text).slice(0, max).join("")
}

/** The longest prefix of `text` (in code points) whose estimate fits `tokens`; the estimate grows with the prefix. */
function fitTokens(text: string, tokens: number) {
  const points = Array.from(text)
  const search = (low: number, high: number): number => {
    if (low >= high) return low
    const middle = Math.ceil((low + high) / 2)
    return Token.estimate(points.slice(0, middle).join("")) <= tokens ? search(middle, high) : search(low, middle - 1)
  }
  return points.slice(0, search(0, points.length)).join("")
}

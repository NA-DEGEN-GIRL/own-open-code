export * as Repeat from "./repeat.js"

import type { Result } from "@opencode/plugin/promise/tool"
import { Tool } from "@opencode/schema/tool"
import type { Logger } from "../logger.js"

/** The counts that get the reminder (dsh's defaults). */
export const THRESHOLDS: ReadonlyArray<number> = [3, 5, 8]

/**
 * Tools ignored when `policy.json` has no `repeatReminderExclude`: computer use repeats the same screenshot, key or
 * scroll call on purpose while the screen changes.
 */
export const EXCLUDE: ReadonlyArray<string> = ["computer_*"]

/** Core's Code Mode tool (`packages/core/src/tool.ts`). */
export const CODE_MODE = "execute"

/** Sessions kept at most; the oldest go first. */
export const MEMORY_KEYS = 4_000

/** What the reminder reads of a session `model.request` event (`plugin/src/promise/session.ts`). */
export type Request = {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string }
  readonly kind: string
}

/**
 * What it reads and writes of a tool `execute.after` event (`plugin/src/promise/tool.ts`). `codemode` marks a call a
 * Code Mode program made: since upstream v2.3.1 (#64324) such a call has an ID of its own and the event says where it
 * came from (surface entry `codemode-nested-call-id`).
 */
export type After = {
  readonly tool: string
  readonly sessionID: string
  readonly agent: string
  readonly id: string
  readonly input: unknown
  readonly codemode: boolean
} & ({ readonly status: "completed"; result: Result } | { readonly status: "error"; error: Tool.Error })

type Chain = {
  readonly own: boolean
  /** Hash of the last tracked call: a large argument (a file being written) is not kept in memory. */
  call?: number | bigint
  count: number
}

/**
 * Repeated identical tool-call reminder (external-repos report P1-1, decision D4 option A, 2026-10-05). Own code after
 * the idea of dsh `packages/guard/repeat-tool-reminder` (MIT; nothing copied): thresholds 3, 5 and 8, a chain keyed by
 * the tool name and key-sorted arguments, reset by user input, advisory only.
 * - Scope: a (session, agent) whose last primary model request went to an own slot. Every other provider is untouched.
 * - A call is its tool name plus its arguments with object keys sorted at every depth. Each identical call in a row
 *   counts up; any other tracked call starts a new chain at 1. A user prompt resets every chain of its session.
 * - Excluded tools (policy `repeatReminderExclude`, else {@link EXCLUDE}) and the calls a Code Mode program makes are
 *   transparent: they neither count nor break a chain. A program's calls answer the program, not the model.
 * - At each of {@link THRESHOLDS} the fixed {@link note} goes BEFORE the result text: core's `ToolOutput.truncate`
 *   keeps the head of a long result. A tool result sits at the end of the conversation, so the cached prefix is
 *   untouched. The call is never blocked, and its output is never dropped.
 */
export function create(input: {
  /** Whether `providerID` is an own slot. */
  readonly own: (providerID: string) => boolean
  /** Tool-name patterns to ignore (`*` matches any run of characters), read at every call. */
  readonly exclude: () => ReadonlyArray<string>
  readonly log: Logger.Logger
}) {
  const sessions = new Map<string, Map<string, Chain>>()
  return {
    /** A primary request decides whether the (session, agent)'s next tool calls are counted. */
    onModelRequest(event: Request) {
      if (event.kind !== "primary") return
      const own = input.own(event.model.providerID)
      const agents = sessions.get(event.sessionID) ?? new Map<string, Chain>()
      remember(sessions, event.sessionID, agents)
      if (agents.get(event.agent)?.own !== own) agents.set(event.agent, { own, count: 0 })
    },
    /** User input starts every chain of the session again. */
    onPrompt(event: { readonly sessionID: string }) {
      for (const chain of sessions.get(event.sessionID)?.values() ?? []) {
        chain.call = undefined
        chain.count = 0
      }
    },
    after(event: After) {
      if (event.codemode) return
      const chain = sessions.get(event.sessionID)?.get(event.agent)
      if (!chain?.own || input.exclude().some((pattern) => matches(pattern, event.tool))) return
      const call = Bun.hash(JSON.stringify([event.tool, sorted(event.input)]))
      chain.count = chain.call === call ? chain.count + 1 : 1
      chain.call = call
      if (!THRESHOLDS.includes(chain.count)) return
      const text = note(event.tool, chain.count)
      input.log.info("repeat_reminder", {
        sessionID: event.sessionID,
        agent: event.agent,
        tool: event.tool,
        count: chain.count,
        status: event.status,
      })
      if (event.status === "completed") {
        event.result = prepend(event.result, text)
        return
      }
      // A failure with a cause shows the model the cause's own message (core `toSessionError`), and dropping the cause
      // would change the error's kind (a permission refusal would read as a tool failure), so it gets no note.
      if (event.error.error !== undefined) return
      event.error = new Tool.Error({
        message: `${text}\n\n${event.error.message}`,
        ...(event.error.metadata === undefined ? {} : { metadata: event.error.metadata }),
      })
    },
  }
}

/** The fixed reminder for the `count`-th identical call in a row. */
export function note(tool: string, count: number) {
  return [
    "<system-reminder>",
    `You have now called ${tool} ${count} times in a row with the same arguments. If the result is not changing, repeating the call will not help: find out why, try a different approach, or ask the user. If you are deliberately waiting for something to change, carry on.`,
    "</system-reminder>",
  ].join("\n")
}

/** `value` with the keys of every object sorted, so key order never makes two calls differ. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map((entry) => [entry[0], sorted(entry[1])]),
  )
}

/** Insertion-ordered bounded map write: the entry moves to the end and the oldest one goes past {@link MEMORY_KEYS}. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size <= MEMORY_KEYS) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

function matches(pattern: string, tool: string) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`^${escaped.join(".*")}$`).test(tool)
}

/**
 * `result` with `text` before its text. The first text part takes it, so a single-text result keeps its shape; a result
 * that starts with a file gets a text part in front. A result without content (the `opencode_models` filter drops it)
 * gets the output rendered as core would render it, after the note, and keeps its `output`.
 */
function prepend(result: Result, text: string): Result {
  const content =
    typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : (result.content ?? [])
  if (content.length === 0)
    return { ...result, content: [{ type: "text", text: `${text}\n\n${render(result.output)}` }] }
  const first = content[0]
  if (first.type === "file") return { ...result, content: [{ type: "text", text }, ...content] }
  return { ...result, content: [{ ...first, text: `${text}\n\n${first.text}` }, ...content.slice(1)] }
}

/** Core's text for a result that has only an output (`normalizeContent` in `packages/core/src/tool/runtime.ts`). */
function render(output: unknown) {
  if (typeof output === "string") return output
  return JSON.stringify(output) ?? String(output)
}

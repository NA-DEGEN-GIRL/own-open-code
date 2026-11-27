export * as Clean from "./clean.js"

/**
 * Claude Code harness text (09 §2.6, §2.7): what Claude Code wraps around the human's words and around its own compact
 * summaries. None of it is the conversation, and some of it is an instruction to the model (`continue without asking`)
 * or a path below `~/.claude`, so it never reaches the imported history. Everything here is pure text processing; the
 * parsers decide what to do with the parts.
 */

// ---------------------------------------------------------------------------------------------------------------
// Human input

/** What remains of one human message once the harness wrappers are removed. */
export interface Human {
  /** The human's own words, wrappers removed and trimmed; empty when the message was only harness text. */
  readonly text: string
  /** `<task-notification>` blocks, one line each: they become `note` steps, not human words. */
  readonly notes: ReadonlyArray<string>
  /** `/name args` when the message invoked a slash command (`<command-name>`, `<command-args>`). */
  readonly command?: string
  /** The `[Request interrupted by user…]` marker Claude Code writes when the human stops a turn. */
  readonly interrupted: boolean
  /** How many wrappers were removed. */
  readonly stripped: number
}

/**
 * Wrappers removed with their content (09 §2.6 사람의 입력): `<system-reminder>`, the slash-command triple
 * `<command-name|message|args>`, `<local-command-stdout|stderr|caveat>` and the IDE context `<ide_opened_file>`,
 * `<ide_selection>`.
 */
const WRAPPER =
  /<(system-reminder|command-name|command-message|command-args|local-command-[a-z-]+|ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g
const TASK = /<task-notification>([\s\S]*?)<\/task-notification>/g
const INTERRUPT = /^\[Request interrupted by user[^\]]*\]$/
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** Splits one human message into the human's words, task notifications and the harness wrappers around them. */
export function human(input: string): Human {
  const notes = [...input.matchAll(TASK)].map((match) => notification(match[1]))
  const withoutTasks = input.replace(TASK, "")
  const stripped = [...withoutTasks.matchAll(WRAPPER)].length
  const text = tidy(withoutTasks.replace(WRAPPER, ""))
  const name = COMMAND_NAME.exec(input)?.[1]?.trim()
  const args = COMMAND_ARGS.exec(input)?.[1]?.trim()
  const command = name ? [name.startsWith("/") ? name : `/${name}`, args].filter(Boolean).join(" ") : undefined
  if (INTERRUPT.test(text)) return { text: "", notes, command, interrupted: true, stripped }
  return { text, notes, command, interrupted: false, stripped }
}

/** A task notification as one line: its `<summary>` when it has one, else its text without tags. */
export function notification(body: string) {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]
  return oneLine(summary ?? body.replace(/<[^>]+>/g, " "), NOTE_MAX)
}

/** The longest note line. */
export const NOTE_MAX = 200

/** Blank lines left by a removed wrapper collapse to one; the ends are trimmed. */
function tidy(text: string) {
  return text.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, "\n\n").trim()
}

/**
 * `text` on one line (whitespace runs become one space), cut to `max` code points with `…` (SDK
 * `_extract_first_prompt_from_head`, MIT). A surrogate pair is never split.
 */
export function oneLine(text: string, max: number) {
  const line = text.replace(/\s+/g, " ").trim()
  const points = Array.from(line)
  if (points.length <= max) return line
  return `${points.slice(0, max).join("").trimEnd()}…`
}

// ---------------------------------------------------------------------------------------------------------------
// Compact summaries

/** A compact summary without Claude Code's harness phrases. */
export interface Summary {
  readonly text: string
  /** Harness phrases that were expected but not found (`boilerplateUnmatched`); their text, if any, stays. */
  readonly unmatched: number
}

/**
 * The three harness phrases every local Claude Code compact summary carried (09 §2.6). Each is matched by keywords on
 * whole lines, so a slightly reworded release still matches, and only where Claude Code puts it: the opener among the
 * first lines, the others among the last ones, so a sentence of the summary itself is never taken for them.
 * - `opener`: "This session is being continued from a previous conversation…" (with a following "…summarized
 *   below:" line).
 * - `transcript`: "…read the full transcript at: <path>.jsonl", which would hand the model a path below `~/.claude`.
 * - `continue`: "Please continue the conversation … without asking the user any further questions…", an instruction
 *   to act on its own.
 */
const PHRASES = [
  {
    where: "head",
    test: (line: string) =>
      /\b(?:session|conversation|chat)\b/i.test(line) &&
      /\bcontinu\w*/i.test(line) &&
      /\b(?:previous|prior|earlier)\b/i.test(line),
  },
  {
    where: "tail",
    test: (line: string) =>
      /\btranscript\b/i.test(line) && /\.jsonl\b|\btranscript at\b|\bfull transcript\b/i.test(line),
  },
  {
    where: "tail",
    test: (line: string) => /\bwithout asking\b/i.test(line) && /\b(?:continue|resume|proceed|pick up)\b/i.test(line),
  },
] as const

/** How many non-empty lines at each end may hold a harness phrase. */
const EDGE = 5

const BELOW = /\bsummari[sz]ed below\b|\bsummary below\b/i

/** Removes the harness phrases from a compact summary (`isCompactSummary`) and counts the ones not found. */
export function summary(input: string): Summary {
  const lines = input.replace(/\r\n?/g, "\n").split("\n")
  const filled = lines.flatMap((line, index) => (line.trim() === "" ? [] : [index]))
  const head = new Set(filled.slice(0, EDGE))
  const tail = new Set(filled.slice(-EDGE))
  const found = PHRASES.map((phrase) =>
    lines.findIndex((line, index) => (phrase.where === "head" ? head : tail).has(index) && phrase.test(line)),
  )
  const opener = found[0]
  const next = opener === -1 ? undefined : filled.find((index) => index > opener)
  const removed = new Set([
    ...found.filter((index) => index !== -1),
    ...(next !== undefined && head.has(next) && BELOW.test(lines[next]) ? [next] : []),
  ])
  return {
    text: tidy(lines.filter((_line, index) => !removed.has(index)).join("\n")),
    unmatched: found.filter((index) => index === -1).length,
  }
}

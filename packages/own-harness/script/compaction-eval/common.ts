// Shared pieces of the compaction evaluation (own/docs/11-compaction-prompt.md §4): where data lives, the flattened
// message shape, token estimates and redaction. Data and results stay outside the repository (OWN_EVAL_DIR).
import path from "node:path"

export const EVAL_DIR =
  process.env.OWN_EVAL_DIR ??
  path.join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "own-compaction-eval")

export const DATA_DIR = path.join(EVAL_DIR, "data")

/** One flattened message: the user's own words, or everything the assistant side did (text, tool calls, results). */
export interface Flat {
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface Span {
  readonly sid: string
  readonly source: string
  /** The condensed span. */
  readonly messages: ReadonlyArray<Flat>
  /** What happened right after the span: the truth for the next step. */
  readonly after: ReadonlyArray<Flat>
  readonly tokens: number
}

/** A rough token count: ASCII at 4 characters a token, other text (Korean) at 1.5. */
export function tokens(text: string) {
  const ascii = text.replace(/[^\x00-\x7f]/g, "").length
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5)
}

const SECRETS: ReadonlyArray<RegExp> = [
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?<=(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',]{6,}/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
]

/** Removes credentials and e-mail addresses before any text leaves this PC. */
export function redact(text: string) {
  return SECRETS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), text)
}

/** Head and tail of a long text, the way harnesses prune old tool output. */
export function clip(text: string, limit: number) {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  return `${text.slice(0, head)}\n[... ${text.length - limit} characters omitted ...]\n${text.slice(text.length - (limit - head))}`
}

/** The span as plain text for readers that take a file (Claude subagents), lines kept short for file readers. */
export function transcript(messages: ReadonlyArray<Flat>) {
  return messages
    .map((message) => `### ${message.role.toUpperCase()}\n${wrap(message.text, 1200)}`)
    .join("\n\n")
}

function wrap(text: string, width: number) {
  return text
    .split("\n")
    .flatMap((line) => (line.length <= width ? [line] : (line.match(new RegExp(`.{1,${width}}`, "gs")) ?? [line])))
    .join("\n")
}

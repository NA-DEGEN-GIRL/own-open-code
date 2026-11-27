// Turns a Claude Code or Codex transcript into an evaluation span: the user's real messages, the assistant side
// flattened (text, tool calls and clipped results), credentials redacted. The span ends on an assistant message once
// it reaches the token target; the next messages are kept as the truth for the next step.
//
//   bun script/compaction-eval/extract.ts <sid> <transcript.jsonl> [targetTokens=60000] [skipTokens=0]
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { clip, DATA_DIR, type Flat, redact, type Span, tokens, transcript } from "./common.js"

const [sid, source, target = "60000", skip = "0"] = process.argv.slice(2)
if (!sid || !source) throw new Error("usage: extract.ts <sid> <transcript.jsonl> [targetTokens] [skipTokens]")

const lines = (await Bun.file(source).text()).split("\n").filter((line) => line.trim() !== "")
const flat = merge(lines.flatMap((line) => read(JSON.parse(line))))
const start = startAfter(flat, Number(skip))
const picked = take(flat.slice(start), Number(target))
const span: Span = {
  sid,
  source: path.basename(source),
  messages: picked.messages,
  after: flat.slice(start + picked.count, start + picked.count + 12),
  tokens: picked.tokens,
}
const dir = path.join(DATA_DIR, sid)
await mkdir(dir, { recursive: true })
await Bun.write(path.join(dir, "span.json"), JSON.stringify(span, null, 1))
await Bun.write(path.join(dir, "span.txt"), transcript(span.messages))
await Bun.write(path.join(dir, "after.txt"), transcript(span.after))
console.log(
  `${sid}: ${span.messages.length} messages (${span.messages.filter((m) => m.role === "user").length} user), ~${span.tokens} tokens`,
)

/** One transcript line as zero or more flat messages (Claude Code `user`/`assistant`, Codex `response_item`). */
function read(entry: Record<string, any>): Array<Flat> {
  if (entry.type === "user" || entry.type === "assistant") return claude(entry)
  if (entry.type === "response_item") return codex(entry.payload ?? {})
  return []
}

function claude(entry: Record<string, any>): Array<Flat> {
  if (entry.isMeta || entry.isCompactSummary) return []
  const content = entry.message?.content
  const blocks: Array<Record<string, any>> = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])
  if (entry.type === "user") {
    const said = blocks
      .filter((block) => block.type === "text")
      .map((block) => cleanUser(String(block.text)))
      .filter((text) => text !== "")
    const results = blocks
      .filter((block) => block.type === "tool_result")
      .map((block) => `[tool result]\n${clip(resultText(block.content), 1500)}`)
    return [
      ...(results.length > 0 ? [{ role: "assistant" as const, text: results.join("\n") }] : []),
      ...(said.length > 0 ? [{ role: "user" as const, text: said.join("\n") }] : []),
    ]
  }
  const parts = blocks.flatMap((block) => {
    if (block.type === "text") return [String(block.text)]
    if (block.type === "tool_use") return [`[tool call] ${block.name}: ${clip(JSON.stringify(block.input), 600)}`]
    return []
  })
  return parts.length > 0 ? [{ role: "assistant", text: parts.join("\n") }] : []
}

function codex(item: Record<string, any>): Array<Flat> {
  if (item.type === "message") {
    const text = (item.content ?? []).map((part: Record<string, any>) => part.text ?? "").join("\n")
    if (item.role === "user") {
      const said = cleanUser(text)
      // Harness fragments (AGENTS.md, environment, plugin lists) arrive with the user role but are not the user.
      return said === "" || /^# AGENTS\.md/.test(said) || /^(?:\s*<([a-z_]+)[^>]*>[\s\S]*?<\/\1>)+\s*$/.test(said)
        ? []
        : [{ role: "user", text: said }]
    }
    if (item.role === "assistant") return text.trim() === "" ? [] : [{ role: "assistant", text }]
    return []
  }
  if (item.type === "function_call" || item.type === "custom_tool_call")
    return [{ role: "assistant", text: `[tool call] ${item.name}: ${clip(String(item.arguments ?? item.input ?? ""), 600)}` }]
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    return [{ role: "assistant", text: `[tool result]\n${clip(resultText(item.output), 1500)}` }]
  return []
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value.map((part) => (typeof part === "string" ? part : (part?.text ?? (part?.type ? `[${part.type}]` : "")))).join("\n")
  if (value && typeof value === "object" && "content" in value) return resultText((value as { content: unknown }).content)
  return JSON.stringify(value ?? "")
}

/** The user's words without harness wrappers (system reminders, command tags, pasted-content tags). */
function cleanUser(text: string) {
  return redact(
    text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/<\/?pasted_content[^>]*>/g, "")
      .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ""),
  ).trim()
}

/** Adjacent assistant pieces become one assistant message; user messages stay separate. */
function merge(messages: ReadonlyArray<Flat>) {
  return messages.reduce<Array<Flat>>((merged, message) => {
    const last = merged.at(-1)
    const text = message.role === "assistant" ? redact(message.text) : message.text
    // Long autonomous runs stay in pieces of about 20k characters, so a span can end inside them.
    if (last && last.role === "assistant" && message.role === "assistant" && last.text.length + text.length < 20_000) {
      merged[merged.length - 1] = { role: "assistant", text: `${last.text}\n${text}` }
      return merged
    }
    merged.push({ role: message.role, text })
    return merged
  }, [])
}

/** The first user message after `skip` tokens, so a span can start later in a long session. */
function startAfter(messages: ReadonlyArray<Flat>, skip: number) {
  const reached = messages.reduce<{ readonly total: number; readonly at: number }>(
    (state, message, index) =>
      state.at >= 0 ? state : state.total >= skip && message.role === "user" ? { ...state, at: index } : { total: state.total + tokens(message.text), at: -1 },
    { total: 0, at: -1 },
  )
  return Math.max(0, reached.at)
}

/** Messages up to the token target, ending on an assistant message. */
function take(messages: ReadonlyArray<Flat>, target: number) {
  const counted = messages.reduce<{ readonly count: number; readonly tokens: number; readonly done: boolean }>(
    (state, message, index) => {
      if (state.done) return state
      const total = state.tokens + tokens(message.text)
      const next = messages[index + 1]
      const end = total >= target && message.role === "assistant" && next !== undefined
      return { count: index + 1, tokens: total, done: end }
    },
    { count: 0, tokens: 0, done: false },
  )
  return { messages: messages.slice(0, counted.count), count: counted.count, tokens: counted.tokens }
}

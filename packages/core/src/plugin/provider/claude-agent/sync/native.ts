// OWN-PATCH(P-043) begin
export * as NativeTranscript from "./native.js"

// own (report §12, §14; 02 §8.10.11): OpenCode history written as a Claude Code transcript, so claude resumes it as
// structured history (tool_use and tool_result blocks with their ids, chained by parentUuid) instead of one
// `<conversation-checkpoint>` text. OpenCode's history stays the only source: the entries are derived from it, the same
// history always gives the same entries (ids from the conversation, the entry before and the group's fingerprint;
// times counted on from the entry before), and each fingerprint group maps to the entry that ends it, exactly as for a
// transcript Claude wrote, so continue, catch-up and branch work on it unchanged. Only `user` and `assistant` entries
// are written; claude adds its own kinds when it resumes.
import { createHash } from "node:crypto"
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
import { ToolNames } from "../tools/names.js"
import { ToolResult } from "../tools/result.js"
import type { Fingerprint } from "./fingerprint.js"
import type { SessionRecord } from "./record.js"

type Block = ConvertToClaudeMessage.ContentBlock | ToolUse | ToolResultBlock

interface ToolUse {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: unknown
}

interface ToolResultBlock {
  readonly type: "tool_result"
  readonly tool_use_id: string
  readonly content: ConvertToClaudeMessage.ContentBlock[] | string
  readonly is_error?: boolean
}

export interface Entry {
  readonly type: "user" | "assistant"
  readonly uuid: string
  readonly parentUuid: string | null
  readonly isSidechain: false
  readonly userType: "external"
  readonly entrypoint: "sdk-ts"
  readonly cwd: string
  readonly sessionId: string
  readonly version: string
  readonly timestamp: string
  readonly message: Readonly<Record<string, unknown>>
}

/** The entry the written ones follow: the last of a transcript claude or own wrote before. */
export interface Parent {
  readonly uuid: string
  readonly timestamp?: string
  // The tool calls of that entry, when it is an assistant reply waiting for their results.
  readonly calls?: readonly string[]
}

// A new transcript counts its times on from here: no clock, so the same history always gives the same file.
const EPOCH = Date.parse("2000-01-01T00:00:00.000Z")

/** The text claude gets when the history it resumes ends with tool results and nothing new was asked. */
export const CONTINUE = "Continue from where you left off."

export function build(input: {
  readonly sessionId: string
  readonly cwd: string
  readonly version: string
  readonly prompt: LanguageModelV3Prompt
  // The groups to write, in order (a run of `Fingerprint.groups(prompt)`).
  readonly groups: readonly Fingerprint.Group[]
  readonly tools: readonly LanguageModelV3FunctionTool[]
  readonly parent?: Parent
}) {
  const entries: Entry[] = []
  const history: SessionRecord.Checkpoint[] = []
  const parsed = input.parent?.timestamp ? Date.parse(input.parent.timestamp) : EPOCH
  const start = Number.isFinite(parsed) ? parsed : EPOCH
  // The calls the last reply made as tool_use, with the results the tool groups after it answer them with. A call or a
  // result that has no partner among the entries written here is history only, written as text.
  const pending = new Map<string, ToolResult.Result>()
  const answer = (from: number, calls: Iterable<string>) => {
    pending.clear()
    const run = input.groups.slice(from)
    const stop = run.findIndex((group) => group.role !== "tool")
    const tools = stop === -1 ? run : run.slice(0, stop)
    if (tools.length === 0) return
    const collected = ToolResult.collect(input.prompt, tools[0]!.start)
    for (const id of calls) {
      const result = collected.results.get(id)
      if (result) pending.set(id, result)
    }
  }
  if (input.parent?.calls) answer(0, input.parent.calls)

  const push = (type: Entry["type"], hash: string, message: Readonly<Record<string, unknown>>) => {
    const parentUuid = entries.at(-1)?.uuid ?? input.parent?.uuid ?? null
    const entry: Entry = {
      type,
      uuid: uuid([input.sessionId, parentUuid ?? "", hash].join("\n")),
      parentUuid,
      isSidechain: false,
      userType: "external",
      entrypoint: "sdk-ts",
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: input.version,
      timestamp: new Date(start + entries.length + 1).toISOString(),
      message,
    }
    entries.push(entry)
    history.push({ hash, claudeMessageID: entry.uuid })
    return entry.uuid
  }

  input.groups.forEach((group, index) => {
    const messages = input.prompt.slice(group.start, group.end)
    if (group.role === "assistant") {
      const calls = messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool-call" && !part.providerExecuted && isObject(part.input) ? [part.toolCallId] : [],
            )
          : [],
      )
      answer(index + 1, calls)
      const content: Block[] = []
      for (const message of messages) {
        if (message.role !== "assistant") continue
        for (const part of message.content) {
          if (part.type === "text" && part.text) content.push({ type: "text", text: part.text })
          // Thinking from another model carries no signature Claude's API accepts; as core's history does for a model
          // that needs one, only its readable text goes on, as text.
          if (part.type === "reasoning" && part.text.trim()) content.push({ type: "text", text: part.text })
          if (part.type === "tool-call") {
            if (pending.has(part.toolCallId)) {
              content.push({
                type: "tool_use",
                id: toolID(part.toolCallId),
                name: toolName(part.toolName, input.tools),
                input: part.input,
              })
              continue
            }
            // A provider's own tool, or a call without a result here: history the model reads, not a call to answer.
            content.push({ type: "text", text: tagged("tool-call", callOf(part)) })
          }
          if (part.type === "tool-result")
            content.push({ type: "text", text: tagged("tool-result", resultOf(part)) })
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no visible content)" })
      const used = content.some((block) => block.type === "tool_use")
      push("assistant", group.hash, {
        id: `msg_oc_${digest([input.sessionId, entries.at(-1)?.uuid ?? input.parent?.uuid ?? "", group.hash].join("\n")).slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content,
        stop_reason: used ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      })
      return
    }
    if (group.role === "tool") {
      const content: Block[] = []
      for (const message of messages) {
        if (message.role !== "tool") continue
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const result = pending.get(part.toolCallId)
          if (!result) {
            content.push({ type: "text", text: tagged("tool-result", resultOf(part)) })
            continue
          }
          const blocks = (result.replacement ?? fromMcp(result.mcp.content)).filter(
            (block) => block.type !== "text" || block.text !== "",
          )
          content.push({
            type: "tool_result",
            tool_use_id: toolID(part.toolCallId),
            content: blocks.length > 0 ? blocks : "",
            ...(result.mcp.isError ? { is_error: true } : {}),
          })
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no visible content)" })
      push("user", group.hash, { role: "user", content })
      return
    }
    pending.clear()
    push("user", group.hash, { role: "user", content: ConvertToClaudeMessage.content(messages) })
  })
  return { entries, history }
}

/** The groups of `groups` from prompt index `from` to `to` (both on group boundaries). */
export function between(groups: readonly Fingerprint.Group[], from: number, to: number) {
  return groups.filter((group) => group.start >= from && group.end <= to)
}

/** Where the new input starts: after the last group that is not the user's (the trailing user messages are the turn). */
export function inputStart(groups: readonly Fingerprint.Group[], from = 0) {
  return Math.max(from, groups.findLast((group) => group.role !== "user")?.end ?? from)
}

/** A Claude session id for a transcript own writes: the same conversation and history give the same id. */
export function sessionID(conversation: string, groups: readonly Fingerprint.Group[]) {
  return uuid(`${conversation}\n${groups.map((group) => group.hash).join(",")}`)
}

/** The digest of a chain's messages (type, uuid and message as read back), for a seal. */
export function chainDigest(messages: ReadonlyArray<{ readonly type: string; readonly uuid: string; readonly message: unknown }>) {
  const hash = createHash("sha256")
  for (const message of messages) hash.update(JSON.stringify([message.type, message.uuid, message.message]) + "\n")
  return hash.digest("hex")
}

// Claude's API takes tool ids of letters, digits, `_` and `-`; another provider's id becomes one, the same every time.
function toolID(id: string) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id
  return `toolu_oc_${digest(id).slice(0, 32)}`
}

// A tool this conversation no longer offers keeps its OpenCode name under the same prefix: history only names it.
function toolName(name: string, tools: readonly LanguageModelV3FunctionTool[]) {
  return ToolNames.PREFIX + ToolNames.short(tools.find((tool) => tool.name === name)?.name ?? name)
}

// The catch-up form of a call or result that is not a tool_use pair: `<tool-call>` JSON `</tool-call>`.
function tagged(tag: string, value: unknown) {
  return [`<${tag}>`, JSON.stringify(value), `</${tag}>`].join("\n")
}

function isObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function callOf(part: { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }) {
  return { id: part.toolCallId, name: part.toolName, input: part.input }
}

function resultOf(part: { readonly toolCallId: string; readonly toolName: string; readonly output: unknown }) {
  return { id: part.toolCallId, name: part.toolName, output: part.output }
}

function fromMcp(content: ToolResult.Result["mcp"]["content"]): ConvertToClaudeMessage.ContentBlock[] {
  return content.flatMap((item): ConvertToClaudeMessage.ContentBlock[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }]
    if (item.type === "image")
      return [{ type: "image", source: { type: "base64", media_type: item.mimeType as "image/png", data: item.data } }]
    return []
  })
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

// A UUID-shaped id from a hash (version 4 layout, so tools that check the shape accept it).
function uuid(value: string) {
  const hex = digest(value)
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
// OWN-PATCH(P-043) end

export * as NativeTranscript from "./native-transcript.ts"

// STUDY ONLY: the P-043 prototype for phase 3 (native transcripts), moved out of packages/core on 2026-10-31. Not
// product code; native-live.ts and study.test.ts use it.

// own study prototype (own/reports/claude-agent-provider-2026-10-31.md §12): writes OpenCode history as a Claude Code
// transcript, so a rebuilt Claude session resumes structured history (tool_use and tool_result blocks with their ids)
// instead of one `<conversation-checkpoint>` text message. OpenCode's history stays the source of truth: the file is
// derived from it, and the record maps each fingerprint group to the transcript entry that ends it, exactly as for a
// transcript Claude wrote itself, so continue, catch-up and branch work on it unchanged.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { ConvertToClaudeMessage } from "../../../../packages/core/src/plugin/provider/claude-agent/language-model/convert-to-claude-message.ts"
import { ToolNames } from "../../../../packages/core/src/plugin/provider/claude-agent/tools/names.ts"
import { ToolResult } from "../../../../packages/core/src/plugin/provider/claude-agent/tools/result.ts"
import { Fingerprint } from "../../../../packages/core/src/plugin/provider/claude-agent/sync/fingerprint.ts"
import type { SessionRecord } from "../../../../packages/core/src/plugin/provider/claude-agent/sync/record.ts"

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
  readonly content: ConvertToClaudeMessage.ContentBlock[]
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
  readonly message: Record<string, unknown>
}

export function build(input: {
  readonly sessionId: string
  readonly cwd: string
  readonly version: string
  readonly prompt: LanguageModelV3Prompt
  readonly tools: readonly LanguageModelV3FunctionTool[]
  readonly now?: () => string
}) {
  const now = input.now ?? (() => new Date().toISOString())
  const entries: Entry[] = []
  const history: SessionRecord.Checkpoint[] = []
  const ids = new Map<string, string>()
  const toolID = (id: string) => {
    const saved = ids.get(id)
    if (saved) return saved
    // Claude's API takes tool ids of letters, digits, `_` and `-`; other providers' ids are mapped once per transcript.
    const safe = /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : `toolu_oc_${ids.size}_${id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}`
    ids.set(id, safe)
    return safe
  }
  const toolName = (name: string) =>
    // A tool this session no longer offers keeps its OpenCode name under the same prefix: history only names it.
    ToolNames.PREFIX + ToolNames.short(input.tools.find((tool) => tool.name === name)?.name ?? name)
  const push = (type: Entry["type"], message: Record<string, unknown>) => {
    const entry: Entry = {
      type,
      uuid: crypto.randomUUID(),
      parentUuid: entries.at(-1)?.uuid ?? null,
      isSidechain: false,
      userType: "external",
      entrypoint: "sdk-ts",
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: input.version,
      timestamp: now(),
      message,
    }
    entries.push(entry)
    return entry.uuid
  }

  for (const group of Fingerprint.groups(input.prompt)) {
    const messages = input.prompt.slice(group.start, group.end)
    if (group.role === "assistant") {
      const content: Block[] = []
      for (const message of messages) {
        if (message.role !== "assistant") continue
        for (const part of message.content) {
          // Thinking from any model cannot be replayed: it carries no signature Claude's API accepts.
          if (part.type === "text" && part.text) content.push({ type: "text", text: part.text })
          if (part.type === "tool-call")
            content.push({ type: "tool_use", id: toolID(part.toolCallId), name: toolName(part.toolName), input: part.input })
        }
      }
      const uuid = push("assistant", {
        id: `msg_oc_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content,
        stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      })
      history.push({ hash: group.hash, claudeMessageID: uuid })
      continue
    }
    if (group.role === "tool") {
      const collected = ToolResult.collect(input.prompt, group.start)
      const content: ToolResultBlock[] = []
      for (const message of messages) {
        if (message.role !== "tool") continue
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          const result = collected.results.get(part.toolCallId)
          if (!result) continue
          content.push({
            type: "tool_result",
            tool_use_id: toolID(part.toolCallId),
            content: result.replacement ?? fromMcp(result.mcp.content),
            ...(result.mcp.isError ? { is_error: true } : {}),
          })
        }
      }
      const uuid = push("user", { role: "user", content })
      history.push({ hash: group.hash, claudeMessageID: uuid })
      continue
    }
    const content = ConvertToClaudeMessage.content(messages)
    const uuid = push("user", { role: "user", content })
    history.push({ hash: group.hash, claudeMessageID: uuid })
  }
  return { entries, history }
}

/** Where Claude Code keeps a session's transcript: `<config>/projects/<cwd with every other character a dash>/<id>.jsonl`. */
export function file(configDir: string, cwd: string, sessionId: string) {
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
}

export async function write(configDir: string, cwd: string, sessionId: string, entries: readonly Entry[]) {
  const target = file(configDir, cwd, sessionId)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  return target
}

function fromMcp(content: ToolResult.Result["mcp"]["content"]): ConvertToClaudeMessage.ContentBlock[] {
  return content.flatMap((item): ConvertToClaudeMessage.ContentBlock[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }]
    if (item.type === "image")
      return [
        {
          type: "image",
          source: { type: "base64", media_type: item.mimeType as "image/png", data: item.data },
        },
      ]
    return []
  })
}

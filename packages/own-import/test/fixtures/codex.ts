import path from "node:path"
import { codexRollout, writeJsonl, writeText, type WriteOptions } from "./make.js"

/**
 * Synthetic Codex rollouts (09 §7.3). Records are written from the formats in the research notes (record envelope,
 * `session_meta`, `response_item`, `event_msg`, `compacted`, …) and Codex's open-source types; nothing is copied or cut
 * from a real `~/.codex`. Conversation text is invented. {@link rollout} assigns timestamps one second apart and, for
 * paginated files, ordinals; {@link writeRollout} puts the records where Codex would (`sessions/YYYY/MM/DD/`).
 */

export const T0 = Date.UTC(2026, 9, 8, 9)

/** A UUIDv7-shaped thread id: `019a0000-0000-7000-8000-<n, 12 digits>`. */
export function threadId(n: number) {
  return `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`
}

/** `\\?\C:\work\proj`: how Codex on Windows mostly records a cwd (09 §2.2). */
export const VERBATIM_CWD = "\\\\?\\C:\\work\\proj"

export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json | undefined }

export interface Meta {
  readonly id: string
  readonly cwd?: string
  readonly cliVersion?: string
  readonly originator?: string
  /** `cli`, `vscode`, `exec`, or a sub-agent source object. */
  readonly source?: Json
  readonly threadSource?: string
  readonly provider?: string
  readonly historyMode?: "legacy" | "paginated"
  readonly base?: { readonly rolloutId: string; readonly endOrdinal: number; readonly endByteOffset: number }
  readonly subagentStart?: number
  readonly parent?: string
  readonly forkedFrom?: string
  readonly branch?: string
  readonly timestamp?: number
  /** Length of a synthetic `base_instructions` text: makes the first line long (the head window, 09 §2.3). */
  readonly instructions?: number
}

/** The payload of a `session_meta` record (with the flattened `git`). */
export function metaPayload(meta: Meta) {
  return {
    session_id: meta.parent ?? meta.id,
    id: meta.id,
    ...(meta.forkedFrom ? { forked_from_id: meta.forkedFrom } : {}),
    ...(meta.parent ? { parent_thread_id: meta.parent } : {}),
    timestamp: new Date(meta.timestamp ?? T0).toISOString(),
    cwd: meta.cwd ?? VERBATIM_CWD,
    originator: meta.originator ?? "codex-tui",
    cli_version: meta.cliVersion ?? "0.153.0",
    source: meta.source ?? "cli",
    ...(meta.threadSource ? { thread_source: meta.threadSource } : {}),
    model_provider: meta.provider ?? "openai",
    base_instructions: {
      text: `You are a synthetic coding agent. ${"x".repeat(meta.instructions ?? 64)}`,
      provenance: { type: "model", model: "fixture" },
    },
    history_mode: meta.historyMode ?? "paginated",
    ...(meta.base
      ? {
          history_base: {
            thread_id: meta.base.rolloutId,
            end_ordinal_exclusive: meta.base.endOrdinal,
            end_byte_offset: meta.base.endByteOffset,
          },
        }
      : {}),
    ...(meta.subagentStart !== undefined ? { subagent_history_start_ordinal: meta.subagentStart } : {}),
    ...(meta.branch
      ? { git: { commit_hash: "0".repeat(40), branch: meta.branch, repository_url: "https://example.invalid/r.git" } }
      : {}),
  }
}

/** A sub-agent `source` (`{subagent: {thread_spawn: …}}`). */
export function spawnSource(parent: string, agentPath = "/root/worker") {
  return {
    subagent: {
      thread_spawn: {
        parent_thread_id: parent,
        depth: 1,
        agent_path: agentPath,
        agent_nickname: "Worker",
        agent_role: "worker",
      },
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// response_item payloads (also used inside `replacement_history`)

export interface Part {
  readonly text?: string
  /** A `data:` URL. */
  readonly image?: string
  /** Its `content_item_kinds` entry. */
  readonly kind?: string
}

/** A user message; `kinds: true` labels parts (`user.text`, `user.image`, or the part's own `kind`). */
export function userItem(
  parts: string | ReadonlyArray<Part>,
  input: { readonly kinds?: boolean; readonly turnId?: string } = {},
) {
  const list: ReadonlyArray<Part> = typeof parts === "string" ? [{ text: parts }] : parts
  const kinds = list.map((part) => part.kind ?? (part.image ? "user.image" : "user.text"))
  return {
    type: "message",
    role: "user",
    content: list.map((part) =>
      part.image
        ? { type: "input_image", image_url: part.image, detail: "auto" }
        : { type: "input_text", text: part.text ?? "" },
    ),
    internal_chat_message_metadata_passthrough: {
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      create_time: 1,
      ...(input.kinds ? { content_item_kinds: kinds } : {}),
    },
  }
}

export function developerItem(text: string) {
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ["permissions.instructions"], create_time: 1 },
  }
}

/** OpenAI's encrypted remote compaction item (never decodable outside OpenAI). */
export function compactionItem() {
  return { type: "compaction", encrypted_content: "gAAAA-FAKE-encrypted-compaction-blob" }
}

/** A 1×1 PNG as a `data:` URL (synthetic bytes). */
export const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

export const ENVIRONMENT =
  "<environment_context>\n  <cwd>C:\\work\\proj</cwd>\n  <shell>powershell</shell>\n</environment_context>"
export const AGENTS_MD = "# AGENTS.md instructions for C:\\work\\proj\n\n<INSTRUCTIONS>\nUse bun.\n</INSTRUCTIONS>"

// ---------------------------------------------------------------------------------------------------------------
// The rollout builder

export interface RolloutRecord {
  readonly timestamp?: string
  readonly type: string
  readonly payload?: unknown
  readonly ordinal?: number
  readonly [key: string]: unknown
}

export interface RolloutOptions {
  /** Time of the first record; each next record is one second later. */
  readonly start?: number
  /** Paginated files number their records (`ordinal`); legacy files do not. Default true. */
  readonly ordinals?: boolean
  /** The first ordinal (a file continuing a `history_base` starts at its `end_ordinal_exclusive`). */
  readonly firstOrdinal?: number
}

/** Builds one rollout's records in order. Every method appends one record and returns the builder. */
export function rollout(options: RolloutOptions = {}) {
  const records: RolloutRecord[] = []
  const clock = { tick: 0, ordinal: options.firstOrdinal ?? 0 }
  const add = (type: string, payload: unknown, extra: object = {}) => {
    const timestamp = new Date((options.start ?? T0) + clock.tick * 1000).toISOString()
    clock.tick += 1
    const ordinal = options.ordinals === false ? {} : { ordinal: clock.ordinal++ }
    records.push({ timestamp, type, payload, ...ordinal, ...extra })
    return builder
  }
  const item = (payload: unknown) => add("response_item", payload)
  const event = (payload: unknown) => add("event_msg", payload)
  const builder = {
    records: () => [...records],
    lines: () => records.map((record) => JSON.stringify(record)),
    raw: (record: RolloutRecord) => {
      records.push(record)
      return builder
    },
    meta: (meta: Meta) => add("session_meta", metaPayload(meta)),
    user: (parts: string | ReadonlyArray<Part>, input: { readonly kinds?: boolean; readonly turnId?: string } = {}) =>
      item(userItem(parts, input)),
    developer: (text: string) => item(developerItem(text)),
    assistant: (text: string, phase: "commentary" | "final_answer" = "final_answer") =>
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text }], phase }),
    reasoning: (input: { readonly summary?: string; readonly plain?: string } = {}) =>
      item({
        type: "reasoning",
        summary: input.summary ? [{ type: "summary_text", text: input.summary }] : [],
        content: input.plain ? [{ type: "reasoning_text", text: input.plain }] : null,
        encrypted_content: "gAAAA-FAKE-encrypted-reasoning",
      }),
    call: (name: string, args: unknown, callId: string, namespace?: string) =>
      item({
        type: "function_call",
        name,
        arguments: JSON.stringify(args),
        call_id: callId,
        ...(namespace ? { namespace } : {}),
      }),
    output: (callId: string, output: unknown) => item({ type: "function_call_output", call_id: callId, output }),
    custom: (name: string, input: string, callId: string) =>
      item({ type: "custom_tool_call", status: "completed", call_id: callId, name, input }),
    customOutput: (callId: string, output: unknown) =>
      item({ type: "custom_tool_call_output", call_id: callId, output }),
    localShell: (callId: string, command: ReadonlyArray<string>) =>
      item({ type: "local_shell_call", call_id: callId, status: "completed", action: { type: "exec", command } }),
    webSearch: (query: string) =>
      item({ type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query } }),
    toolSearch: (callId: string, query: string) =>
      item({
        type: "tool_search_call",
        call_id: callId,
        status: "completed",
        execution: "client",
        arguments: { query, limit: 5 },
      }),
    toolSearchOutput: (callId: string, namespace: string, tools: ReadonlyArray<string>) =>
      item({
        type: "tool_search_output",
        call_id: callId,
        status: "completed",
        execution: "client",
        tools: [
          {
            type: "namespace",
            name: namespace,
            description: "d",
            tools: tools.map((name) => ({ type: "function", name, parameters: { type: "object" } })),
          },
        ],
      }),
    imageGeneration: (prompt: string) =>
      item({
        type: "image_generation_call",
        id: "ig_fixture",
        status: "completed",
        revised_prompt: prompt,
        result: "RkFLRQ==",
      }),
    agentMessage: (author: string, recipient: string, text: string, encrypted = false) =>
      item({
        type: "agent_message",
        author,
        recipient,
        content: [
          { type: "input_text", text },
          ...(encrypted ? [{ type: "encrypted_content", encrypted_content: "gAAAA-FAKE" }] : []),
        ],
      }),
    item,
    event,
    turnContext: (input: {
      readonly model?: string
      readonly cwd?: string
      readonly turnId?: string
      readonly provider?: string
    }) =>
      add("turn_context", {
        turn_id: input.turnId ?? "turn-x",
        cwd: input.cwd ?? VERBATIM_CWD,
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { model_provider: input.provider } : {}),
        effort: "high",
        summary: "auto",
      }),
    taskStarted: (turnId: string) =>
      event({ type: "task_started", turn_id: turnId, started_at: 1, model_context_window: 258400 }),
    taskComplete: (turnId: string) =>
      event({ type: "task_complete", turn_id: turnId, last_agent_message: null, completed_at: 2 }),
    turnAborted: (turnId: string) => event({ type: "turn_aborted", turn_id: turnId, reason: "interrupted" }),
    userEvent: (message: string) =>
      event({ type: "user_message", message, images: [], local_images: [], text_elements: [] }),
    agentEvent: (message: string) => event({ type: "agent_message", message, phase: "final_answer" }),
    rolledBack: (turns: number) => event({ type: "thread_rolled_back", num_turns: turns }),
    tokenCount: (input: number, output: number, cached: number) =>
      event({
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
          },
          last_token_usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 2,
          },
          model_context_window: 258400,
        },
        rate_limits: { limit_id: "fixture", primary: { used_percent: 1, window_minutes: 300, resets_at: 1 } },
      }),
    tokenUsage: (model: string, provider = "openai") =>
      add("token_usage_record", {
        thread_id: "t",
        turn_id: "u",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        served_by: { provider_id: provider, model, request_head: "r" },
      }),
    commandDone: (callId: string, exitCode: number, output = "") =>
      event({
        type: "item_completed",
        thread_id: "t",
        turn_id: "u",
        item: {
          type: "CommandExecution",
          id: callId,
          command: ["bun", "test"],
          cwd: "C:\\work\\proj",
          aggregated_output: output,
          exit_code: exitCode,
          status: exitCode === 0 ? "completed" : "failed",
        },
      }),
    fileChangeDone: (callId: string, changes: Readonly<{ [path: string]: unknown }>) =>
      event({
        type: "item_completed",
        thread_id: "t",
        turn_id: "u",
        item: { type: "FileChange", id: callId, changes, status: "completed" },
      }),
    subAgentDone: (agentThreadId: string, agentPath: string) =>
      event({
        type: "item_completed",
        thread_id: "t",
        turn_id: "u",
        item: {
          type: "SubAgentActivity",
          id: "sa",
          agent_thread_id: agentThreadId,
          agent_path: agentPath,
          kind: "started",
        },
      }),
    subAgentEvent: (agentThreadId: string, agentPath: string) =>
      event({
        type: "sub_agent_activity",
        event_id: "e",
        occurred_at_ms: 1,
        agent_thread_id: agentThreadId,
        agent_path: agentPath,
        kind: "started",
      }),
    patchApplyEnd: (callId: string, changes: Readonly<{ [path: string]: unknown }>) =>
      event({
        type: "patch_apply_end",
        call_id: callId,
        turn_id: "u",
        stdout: "",
        stderr: "",
        success: true,
        changes,
        status: "completed",
      }),
    execEnd: (callId: string, exitCode: number) =>
      event({
        type: "exec_command_end",
        call_id: callId,
        turn_id: "u",
        command: ["bun", "test"],
        cwd: "C:\\work\\proj",
        parsed_cmd: [],
        exit_code: exitCode,
      }),
    error: (message: string) => event({ type: "error", message }),
    /** A `compacted` record: a local summary (`message`) or, with an empty message, a remote one. */
    compacted: (message: string, replacement: ReadonlyArray<unknown>) =>
      add("compacted", { message, replacement_history: replacement, window_number: 1, window_id: "w" }),
    contextCompacted: () => event({ type: "context_compacted" }),
    worldState: () => add("world_state", { full: true, state: { model: "fixture" } }),
    unknown: (type: string) => add(type, { anything: true }),
  }
  return builder
}

export type Rollout = ReturnType<typeof rollout>

/** The local compaction summary text as Codex writes it: `SUMMARY_PREFIX\n<summary>`. */
export function localSummary(summary: string, prefix: string) {
  return `${prefix}\n${summary}`
}

// ---------------------------------------------------------------------------------------------------------------
// Files

export interface RolloutFileInput extends WriteOptions {
  readonly id: string
  readonly at?: number
  readonly zst?: boolean
  readonly archived?: boolean
  readonly rolloutId?: string
  readonly records: ReadonlyArray<unknown>
}

/** Writes a rollout where Codex keeps it and returns its path. */
export function writeRollout(root: string, input: RolloutFileInput) {
  return writeJsonl(
    codexRollout(root, {
      id: input.id,
      at: input.at ?? T0,
      zst: input.zst,
      archived: input.archived,
      rolloutId: input.rolloutId,
    }),
    input.records,
    input,
  )
}

/** `session_index.jsonl` (`{id, thread_name, updated_at}` per line; the last line of an id wins). */
export function writeSessionIndex(
  root: string,
  entries: ReadonlyArray<{ readonly id: string; readonly name: string | null }>,
) {
  return writeText(
    path.join(root, "session_index.jsonl"),
    entries
      .map((entry) => JSON.stringify({ id: entry.id, thread_name: entry.name, updated_at: "2026-10-08T09:00:00Z" }))
      .join("\n") + "\n",
  )
}

/** The byte length of `records` written as JSON lines: a `history_base` end offset. */
export function byteLength(records: ReadonlyArray<unknown>) {
  return Buffer.byteLength(records.map((record) => `${JSON.stringify(record)}\n`).join(""))
}

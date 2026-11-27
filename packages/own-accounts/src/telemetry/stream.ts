export * as StreamUsage from "./stream.js"

import { Option, Schema } from "effect"
import type { Ledger } from "@own/protocol"

/**
 * Usage of a streamed model response that core does not record (session `generate`, and `title`, whose
 * `session.usage.recorded` never reaches plugins, 02 §7.5 "core가 기록하지 않는 사용량"). Reads a *clone* of the
 * response to the end in the background; the text itself is dropped as it streams. Mapping follows core's parsers
 * (⚠AC-P41): Responses `response.completed.usage`, Anthropic `message_start` + `message_delta` usage (the last
 * value of each field wins), Chat the last chunk with `usage`.
 */

/** Largest single SSE event kept while scanning; bigger events cannot carry usage and are skipped. */
const MAX_EVENT_CHARS = 1_000_000

export interface Accumulator {
  /** Feeds one SSE `data:` payload (already JSON-parsed). */
  push(data: unknown): void
  result(): Ledger.Tokens | undefined
}

export function accumulator(): Accumulator {
  const state: {
    responses?: Record<string, unknown>
    anthropic: Record<string, unknown>
    chat?: Record<string, unknown>
  } = { anthropic: {} }
  return {
    push: (data) => {
      const json = record(data)
      if (!json) return
      const type = json.type
      if (
        (type === "response.completed" || type === "response.incomplete" || type === "response.done") &&
        record(record(json.response)?.usage)
      )
        state.responses = record(record(json.response)?.usage)
      if (type === "message_start") Object.assign(state.anthropic, defined(record(record(json.message)?.usage)))
      if (type === "message_delta") Object.assign(state.anthropic, defined(record(json.usage)))
      if (type === undefined && record(json.usage)) state.chat = record(json.usage)
    },
    result: () => {
      if (state.responses) return responses(state.responses)
      if (Object.keys(state.anthropic).length > 0) return anthropic(state.anthropic)
      if (state.chat) return chat(state.chat)
      return undefined
    },
  }
}

/**
 * Reads an SSE response body to the end and returns the final usage, or `undefined` when none was found, the body
 * is not SSE, or `signal` aborts first.
 */
export async function read(response: Response, signal?: AbortSignal): Promise<Ledger.Tokens | undefined> {
  const body = response.body
  if (!body) return undefined
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  const abort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener("abort", abort, { once: true })
  const usage = accumulator()
  const state = { buffer: "" }
  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data === "" || data === "[DONE]") return
    const parsed = parse(data)
    if (parsed !== undefined) usage.push(parsed)
  }
  const pump = async (): Promise<void> => {
    const chunk = await reader.read()
    if (chunk.done) return
    state.buffer += chunk.value
    const blocks = state.buffer.split(/\r?\n\r?\n/)
    state.buffer = blocks.pop() ?? ""
    if (state.buffer.length > MAX_EVENT_CHARS) state.buffer = ""
    blocks.forEach(flush)
    return pump()
  }
  const done = await pump().then(
    () => true,
    () => false,
  )
  signal?.removeEventListener("abort", abort)
  if (!done || signal?.aborted) return undefined
  if (state.buffer.trim() !== "") flush(state.buffer)
  return usage.result()
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parse(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function defined(value: Record<string, unknown> | undefined) {
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry) => entry[1] !== null && entry[1] !== undefined))
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** Responses: `input_tokens` includes cached and cache-write subsets; `output_tokens` includes reasoning. */
function responses(usage: Record<string, unknown>): Ledger.Tokens {
  const input = record(usage.input_tokens_details)
  const output = record(usage.output_tokens_details)
  const cacheRead = count(input?.cached_tokens)
  const cacheWrite = count(input?.cache_write_tokens)
  const reasoning = count(output?.reasoning_tokens)
  return {
    input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    output: Math.max(0, count(usage.output_tokens) - reasoning),
    reasoning,
  }
}

/** Anthropic: `input_tokens` is already non-cached; 1h writes are only split in precise mode (not here). */
function anthropic(usage: Record<string, unknown>): Ledger.Tokens {
  const reasoning = count(record(usage.output_tokens_details)?.thinking_tokens)
  return {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite1h: null,
    output: Math.max(0, count(usage.output_tokens) - reasoning),
    reasoning,
  }
}

/** Chat completions (OpenAI-compatible, DeepSeek dialect): `prompt_tokens` includes cached tokens. */
function chat(usage: Record<string, unknown>): Ledger.Tokens {
  const prompt = record(usage.prompt_tokens_details)
  const completion = record(usage.completion_tokens_details)
  const cacheRead = count(prompt?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens)
  const cacheWrite = count(prompt?.cache_write_tokens)
  const reasoning = count(completion?.reasoning_tokens)
  return {
    input: Math.max(0, count(usage.prompt_tokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    output: Math.max(0, count(usage.completion_tokens) - reasoning),
    reasoning,
  }
}

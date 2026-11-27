// Ports `ExecCommandToolOutput` (codex-rs/core/src/tools/context.rs): the header and truncation of what
// exec_command and write_stdin answer. Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as ExecOutput from "./output.js"

import { Buffer } from "node:buffer"
import { Truncate } from "../truncate/index.js"
import { HeadTail } from "./buffer.js"

/** `DEFAULT_MAX_OUTPUT_TOKENS`. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000

export interface Result {
  /** Six lowercase hex digits (`generate_chunk_id`). */
  readonly chunkID: string
  readonly wallTimeMs: number
  /** The collected output, with the omission marker when the 1 MiB collection cap dropped bytes. */
  readonly raw: string
  readonly omittedBytes: number
  /** `approx_tokens_from_byte_count` of everything the process wrote during the collection. */
  readonly originalTokenCount: number
  /** Set while the process still runs. */
  readonly sessionID?: number
  readonly exitCode?: number
  readonly maxOutputTokens?: number
  /** The model's `truncation_policy`. */
  readonly policy: Truncate.TruncationPolicy
}

export function chunkID() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 16).toString(16)).join("")
}

/** `response_text`: the header, then the output truncated so the whole text fits the policy plus Codex's 20%. */
export function text(result: Result) {
  const head = header(result)
  const budget = Math.max(
    0,
    Truncate.byteBudget(Truncate.withSerializationAllowance(result.policy)) - (Buffer.byteLength(head, "utf8") + 1),
  )
  const fit = (policy: Truncate.TruncationPolicy): string => {
    const output = truncated(result, policy)
    const size = Buffer.byteLength(output, "utf8")
    if (size <= budget || Truncate.byteBudget(policy) === 0) return output
    const excess = size - budget
    return fit(
      policy.mode === "bytes"
        ? { mode: "bytes", limit: Math.max(0, policy.limit - excess) }
        : { mode: "tokens", limit: Math.max(0, policy.limit - Truncate.tokenBudget({ mode: "bytes", limit: excess })) },
    )
  }
  return `${head}\n${fit(modelPolicy(result))}`
}

function header(result: Result) {
  return [
    ...(result.chunkID === "" ? [] : [`Chunk ID: ${result.chunkID}`]),
    `Wall time: ${(result.wallTimeMs / 1000).toFixed(4)} seconds`,
    ...(result.exitCode === undefined ? [] : [`Process exited with code ${result.exitCode}`]),
    ...(result.sessionID === undefined ? [] : [`Process running with session ID ${result.sessionID}`]),
    `Original token count: ${result.originalTokenCount}`,
    "Output:",
  ].join("\n")
}

/** The smaller of the requested `max_output_tokens` and the model's policy. */
function modelPolicy(result: Result): Truncate.TruncationPolicy {
  const requested: Truncate.TruncationPolicy = {
    mode: "tokens",
    limit: result.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
  return Truncate.byteBudget(requested) < Truncate.byteBudget(result.policy) ? requested : result.policy
}

function truncated(result: Result, policy: Truncate.TruncationPolicy) {
  if (result.omittedBytes === 0) return Truncate.formattedTruncateText(result.raw, policy)
  const marker = HeadTail.omissionMarker(result.omittedBytes)
  if (Buffer.byteLength(result.raw, "utf8") <= Truncate.byteBudget(policy))
    return result.raw.includes(marker) ? result.raw : `${marker}\n${result.raw}`
  const cut = Truncate.truncateText(result.raw, policy)
  const notice = cut.includes(marker) ? "" : `${marker}\n`
  return `Warning: truncated output (original token count: ${result.originalTokenCount})\n${notice}\n${cut}`
}

/**
 * `code_mode_result`: what `tools.exec_command(...)` / `tools.write_stdin(...)` return inside Code Mode's `exec`,
 * `{chunk_id?, wall_time_seconds, exit_code?, session_id?, original_token_count?, output}` with absent fields omitted.
 * The output is truncated to `max_output_tokens` when the call gave one, else returned whole.
 */
export function codeModeResult(result: Result) {
  return {
    ...(result.chunkID === "" ? {} : { chunk_id: result.chunkID }),
    wall_time_seconds: result.wallTimeMs / 1000,
    ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
    ...(result.sessionID === undefined ? {} : { session_id: result.sessionID }),
    original_token_count: result.originalTokenCount,
    output:
      result.maxOutputTokens === undefined
        ? result.raw
        : truncated(result, { mode: "tokens", limit: result.maxOutputTokens }),
  }
}

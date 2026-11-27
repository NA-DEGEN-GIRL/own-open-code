// Ports codex-rs/utils/string/src/truncate.rs (approximate token counts, middle truncation on UTF-8 boundaries) and
// codex-rs/utils/output-truncation/src/lib.rs (truncation policies, the formatted warning, MCP result and content-item
// truncation), plus `TruncationPolicy` from codex-rs/protocol/src/protocol.rs. Lengths are UTF-8 byte lengths.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as Truncate from "./index.js"

import { Buffer } from "node:buffer"

const APPROX_BYTES_PER_TOKEN = 4
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder("utf-8", { ignoreBOM: true })

/** Codex's `TruncationPolicy`, serialized as `{ mode, limit }`. */
export type TruncationPolicy = { mode: "bytes"; limit: number } | { mode: "tokens"; limit: number }

export function approxTokenCount(text: string) {
  return approxTokensFromByteCount(Buffer.byteLength(text, "utf8"))
}

export function approxBytesForTokens(tokens: number) {
  return tokens * APPROX_BYTES_PER_TOKEN
}

export function approxTokensFromByteCount(bytes: number) {
  return Math.floor((bytes + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN)
}

/** `approx_tokens_from_byte_count_i64`: non-positive byte counts are zero tokens. */
export function approxTokensFromByteCountI64(bytes: number) {
  return bytes <= 0 ? 0 : approxTokensFromByteCount(bytes)
}

/** Keeps at most `maxBytes` from the two ends and puts a `…N chars truncated…` marker (outside that budget) between. */
export function truncateMiddleChars(text: string, maxBytes: number) {
  return truncateWithByteEstimate(text, maxBytes, false)
}

/**
 * Truncates the middle so the result including `marker` is at most `maxBytes` bytes. Text that fits is returned as is;
 * when the marker alone does not fit, the longest prefix that does is returned.
 */
export function truncateMiddleWithMarker(text: string, maxBytes: number, marker: string) {
  const bytes = ENCODER.encode(text)
  if (bytes.length <= maxBytes) return text
  const markerLength = Buffer.byteLength(marker, "utf8")
  if (maxBytes < markerLength) return decode(bytes, 0, floorCharBoundary(bytes, maxBytes))
  const [left, right] = splitBudget(maxBytes - markerLength)
  const prefixEnd = floorCharBoundary(bytes, left)
  const suffixStart = ceilCharBoundary(bytes, Math.max(bytes.length - right, 0))
  return decode(bytes, 0, prefixEnd) + marker + decode(bytes, suffixStart, bytes.length)
}

/**
 * Truncates the middle to about `maxTokens` tokens, keeping both ends, with a `…N tokens truncated…` marker. Returns the
 * text and, when it was truncated, the original approximate token count.
 */
export function truncateMiddleWithTokenBudget(text: string, maxTokens: number): [string, number | undefined] {
  if (text === "") return ["", undefined]
  const byteBudget = approxBytesForTokens(maxTokens)
  if (maxTokens > 0 && Buffer.byteLength(text, "utf8") <= byteBudget) return [text, undefined]
  const truncated = truncateWithByteEstimate(text, byteBudget, true)
  return truncated === text ? [truncated, undefined] : [truncated, approxTokenCount(text)]
}

function truncateWithByteEstimate(text: string, maxBytes: number, useTokens: boolean) {
  if (text === "") return ""
  const bytes = ENCODER.encode(text)
  if (maxBytes === 0)
    return truncationMarker(useTokens, removedUnits(useTokens, bytes.length, useTokens ? 0 : charCount(bytes)))
  if (bytes.length <= maxBytes) return text
  const [left, right] = splitBudget(maxBytes)
  const split = useTokens
    ? // Token markers depend only on byte counts, so the discarded middle is not scanned.
      {
        removedChars: 0,
        prefixEnd: floorCharBoundary(bytes, left),
        suffixStart: ceilCharBoundary(bytes, bytes.length - right),
      }
    : splitBytes(bytes, left, right)
  const marker = truncationMarker(
    useTokens,
    removedUnits(useTokens, Math.max(bytes.length - maxBytes, 0), split.removedChars),
  )
  return decode(bytes, 0, split.prefixEnd) + marker + decode(bytes, split.suffixStart, bytes.length)
}

/**
 * Codex's `split_string`: the characters that end within `beginningBytes` form the prefix, those starting at or after
 * `length - endBytes` the suffix; returns how many characters lie between, and both ends.
 */
export function splitString(text: string, beginningBytes: number, endBytes: number): [number, string, string] {
  if (text === "") return [0, "", ""]
  const bytes = ENCODER.encode(text)
  const split = splitBytes(bytes, beginningBytes, endBytes)
  return [split.removedChars, decode(bytes, 0, split.prefixEnd), decode(bytes, split.suffixStart, bytes.length)]
}

function splitBytes(bytes: Uint8Array, beginningBytes: number, endBytes: number) {
  const tailStartTarget = Math.max(bytes.length - endBytes, 0)
  let prefixEnd = 0
  let suffixStart: number | undefined = undefined
  let removedChars = 0
  for (let index = 0; index < bytes.length; index += charWidth(bytes[index]!)) {
    const charEnd = index + charWidth(bytes[index]!)
    if (charEnd <= beginningBytes) {
      prefixEnd = charEnd
      continue
    }
    if (index >= tailStartTarget) {
      suffixStart ??= index
      continue
    }
    removedChars += 1
  }
  return { removedChars, prefixEnd, suffixStart: Math.max(suffixStart ?? bytes.length, prefixEnd) }
}

function splitBudget(budget: number) {
  const left = Math.floor(budget / 2)
  return [left, budget - left] as const
}

function truncationMarker(useTokens: boolean, removed: number) {
  return useTokens ? `…${removed} tokens truncated…` : `…${removed} chars truncated…`
}

function removedUnits(useTokens: boolean, removedBytes: number, removedChars: number) {
  return useTokens ? approxTokensFromByteCount(removedBytes) : removedChars
}

/** Width of the UTF-8 sequence led by `byte` (input comes from `TextEncoder`, so it is well formed). */
function charWidth(byte: number) {
  if (byte < 0x80) return 1
  if (byte < 0xe0) return 2
  if (byte < 0xf0) return 3
  return 4
}

function charCount(bytes: Uint8Array) {
  return bytes.reduce((count, byte) => ((byte & 0xc0) === 0x80 ? count : count + 1), 0)
}

function isCharBoundary(bytes: Uint8Array, index: number) {
  return index === 0 || index >= bytes.length || (bytes[index]! & 0xc0) !== 0x80
}

function floorCharBoundary(bytes: Uint8Array, index: number) {
  if (index >= bytes.length) return bytes.length
  let boundary = index
  while (!isCharBoundary(bytes, boundary)) boundary -= 1
  return boundary
}

function ceilCharBoundary(bytes: Uint8Array, index: number) {
  if (index > bytes.length) return bytes.length
  let boundary = index
  while (!isCharBoundary(bytes, boundary)) boundary += 1
  return boundary
}

function decode(bytes: Uint8Array, start: number, end: number) {
  return DECODER.decode(bytes.subarray(start, end))
}

// --- codex-rs/utils/output-truncation ---------------------------------------------------------------------------

export function tokenBudget(policy: TruncationPolicy) {
  return policy.mode === "bytes" ? approxTokensFromByteCount(policy.limit) : policy.limit
}

export function byteBudget(policy: TruncationPolicy) {
  return policy.mode === "bytes" ? policy.limit : approxBytesForTokens(policy.limit)
}

/** `policy * multiplier`, rounding the limit up. */
export function scalePolicy(policy: TruncationPolicy, multiplier: number): TruncationPolicy {
  return { mode: policy.mode, limit: Math.ceil(policy.limit * multiplier) }
}

/** Adds Codex's 20% allowance for serialization and headers. Saved history budgets already include it. */
export function withSerializationAllowance(policy: TruncationPolicy) {
  return scalePolicy(policy, 1.2)
}

/**
 * Text within the policy's byte budget unchanged; otherwise
 * `Warning: truncated output (original token count: N)\nTotal output lines: L\n\n<truncated text>`.
 */
export function formattedTruncateText(content: string, policy: TruncationPolicy) {
  if (Buffer.byteLength(content, "utf8") <= byteBudget(policy)) return content
  return `Warning: truncated output (original token count: ${approxTokenCount(content)})\nTotal output lines: ${lineCount(content)}\n\n${truncateText(content, policy)}`
}

export function truncateText(content: string, policy: TruncationPolicy) {
  return policy.mode === "bytes"
    ? truncateMiddleChars(content, policy.limit)
    : truncateMiddleWithTokenBudget(content, policy.limit)[0]
}

/** Rust's `str::lines().count()`: a final line needs no terminator, and a trailing newline adds no empty line. */
function lineCount(text: string) {
  const newlines = text.split("\n").length - 1
  return text === "" || text.endsWith("\n") ? newlines : newlines + 1
}

/** An MCP `CallToolResult` as Codex serializes it (absent optional fields are omitted). */
export interface CallToolResult {
  content: Array<unknown>
  structuredContent?: unknown
  isError?: boolean
  _meta?: unknown
}

/**
 * Replaces a result whose JSON exceeds `maxBytes` with a single text item previewing that JSON (middle-truncated),
 * keeping `isError` and dropping structured content and metadata. Returns `result` itself when it fits.
 */
export function truncateMcpToolResult(result: CallToolResult, maxBytes: number): CallToolResult {
  const serialized = serialize(result)
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") <= maxBytes) return result
  let previewBudget = maxBytes
  while (true) {
    const preview = previewBudget === 0 ? "" : truncateText(serialized, { mode: "bytes", limit: previewBudget })
    const truncated: CallToolResult = {
      content: [{ type: "text", text: preview }],
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    }
    const truncatedSerialized = serialize(truncated)
    if (truncatedSerialized === undefined) return result
    const truncatedLength = Buffer.byteLength(truncatedSerialized, "utf8")
    if (truncatedLength <= maxBytes || previewBudget === 0) return truncated
    // Escaping can make the JSON preview exceed its raw budget; scale by the observed size of the whole replacement.
    previewBudget = Math.min(Math.floor((previewBudget * maxBytes) / truncatedLength), Math.max(previewBudget - 1, 0))
  }
}

/** Serializes in Codex's field order (`content`, `structuredContent`, `isError`, `_meta`); `undefined` if it cannot. */
function serialize(result: CallToolResult) {
  const ordered = {
    content: result.content,
    structuredContent: result.structuredContent,
    isError: result.isError,
    _meta: result._meta,
  }
  try {
    return JSON.stringify(ordered)
  } catch {
    return undefined
  }
}

/** A function-call output content item as the Responses API serializes it. */
export type ContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
  | { type: "input_audio"; audio_url: string }
  | { type: "encrypted_content"; encrypted_content: string }

/**
 * Joins all text items with `\n`; when that exceeds the byte budget, returns one formatted, truncated text item
 * followed by the non-text items in order, with the joined text's approximate token count. Otherwise the items as is.
 */
export function formattedTruncateTextContentItemsWithPolicy(
  items: ReadonlyArray<ContentItem>,
  policy: TruncationPolicy,
): [Array<ContentItem>, number | undefined] {
  const texts = items.flatMap((item) => (item.type === "input_text" ? [item.text] : []))
  if (texts.length === 0) return [[...items], undefined]
  // Codex adds a separator only once the joined text is non-empty, so leading empty texts add none.
  const combined = texts.reduce((joined, text) => (joined === "" ? text : `${joined}\n${text}`), "")
  if (Buffer.byteLength(combined, "utf8") <= byteBudget(policy)) return [[...items], undefined]
  return [
    [
      { type: "input_text", text: formattedTruncateText(combined, policy) },
      ...items.filter((item) => item.type !== "input_text"),
    ],
    approxTokenCount(combined),
  ]
}

/**
 * Spends the policy's budget on items in order: text that fits is kept, the first that does not is truncated to the
 * remainder, and later text is omitted; audio costs `estimateAudioTokenCount` tokens and is omitted when it does not
 * fit; images and encrypted content always stay. Empty texts are dropped. Omissions are summarised in trailing
 * `[omitted N text items ...]` / `[omitted N audio items ...]` items.
 */
export function truncateFunctionOutputItemsWithPolicy(
  items: ReadonlyArray<ContentItem>,
  policy: TruncationPolicy,
  estimateAudioTokenCount: (audioUrl: string) => number,
) {
  const out: Array<ContentItem> = []
  let remaining = policy.mode === "bytes" ? byteBudget(policy) : tokenBudget(policy)
  let omittedText = 0
  let omittedAudio = 0
  for (const item of items) {
    if (item.type === "input_text") {
      if (item.text === "") continue
      if (remaining === 0) {
        omittedText += 1
        continue
      }
      const cost = policy.mode === "bytes" ? Buffer.byteLength(item.text, "utf8") : approxTokenCount(item.text)
      if (cost <= remaining) {
        out.push({ type: "input_text", text: item.text })
        remaining -= cost
        continue
      }
      const snippet = truncateText(item.text, { mode: policy.mode, limit: remaining })
      if (snippet === "") omittedText += 1
      if (snippet !== "") out.push({ type: "input_text", text: snippet })
      remaining = 0
      continue
    }
    if (item.type === "input_audio") {
      const tokens = estimateAudioTokenCount(item.audio_url)
      const cost = policy.mode === "bytes" ? approxBytesForTokens(tokens) : tokens
      if (cost > remaining) {
        omittedAudio += 1
        continue
      }
      out.push(item)
      remaining = Math.max(remaining - cost, 0)
      continue
    }
    out.push(item)
  }
  if (omittedText > 0) out.push({ type: "input_text", text: `[omitted ${omittedText} text items ...]` })
  if (omittedAudio > 0) out.push({ type: "input_text", text: `[omitted ${omittedAudio} audio items ...]` })
  return out
}

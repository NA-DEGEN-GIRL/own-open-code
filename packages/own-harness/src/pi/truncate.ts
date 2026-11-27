// Ports packages/coding-agent/src/core/tools/truncate.ts: tool output limits (2000 lines or 50KB, whichever is hit
// first), head truncation for file reads and tail truncation for shell output. Never returns partial lines except the
// tail case where the last line alone exceeds the byte limit.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiTruncate from "./truncate.js"

import { Buffer } from "node:buffer"

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export interface Result {
  readonly content: string
  readonly truncated: boolean
  readonly truncatedBy: "lines" | "bytes" | null
  readonly totalLines: number
  readonly totalBytes: number
  /** Complete lines in the output. */
  readonly outputLines: number
  readonly outputBytes: number
  /** The last line was cut (tail truncation only). */
  readonly lastLinePartial: boolean
  /** The first line alone exceeds the byte limit (head truncation only). */
  readonly firstLineExceedsLimit: boolean
  readonly maxLines: number
  readonly maxBytes: number
}

export interface Options {
  readonly maxLines?: number
  readonly maxBytes?: number
}

/** `formatSize`: bytes as B, KB or MB with one decimal. */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Keeps the first lines that fit both limits (file reads). */
export function truncateHead(content: string, options: Options = {}): Result {
  const limits = { maxLines: options.maxLines ?? DEFAULT_MAX_LINES, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES }
  const totalBytes = byteLength(content)
  const lines = splitLinesForCounting(content)
  const base = { ...limits, totalLines: lines.length, totalBytes, lastLinePartial: false }
  if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes) return untouched(content, base)
  if (byteLength(lines[0]!) > limits.maxBytes)
    return {
      ...base,
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    }
  const sizes = lines.slice(0, limits.maxLines).map((line, index) => byteLength(line) + (index > 0 ? 1 : 0))
  const over = running(sizes).findIndex((total) => total > limits.maxBytes)
  const kept = lines.slice(0, over < 0 ? sizes.length : over)
  const output = kept.join("\n")
  return {
    ...base,
    content: output,
    truncated: true,
    truncatedBy: over >= 0 && kept.length < limits.maxLines ? "bytes" : "lines",
    outputLines: kept.length,
    outputBytes: byteLength(output),
    firstLineExceedsLimit: false,
  }
}

/** Keeps the last lines that fit both limits (shell output); a last line over the byte limit keeps its end. */
export function truncateTail(content: string, options: Options = {}): Result {
  const limits = { maxLines: options.maxLines ?? DEFAULT_MAX_LINES, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES }
  const totalBytes = byteLength(content)
  const lines = splitLinesForCounting(content)
  const base = { ...limits, totalLines: lines.length, totalBytes, firstLineExceedsLimit: false }
  if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes)
    return { ...untouched(content, base), lastLinePartial: false }
  const newest = lines.toReversed().slice(0, limits.maxLines)
  const sizes = newest.map((line, index) => byteLength(line) + (index > 0 ? 1 : 0))
  const over = running(sizes).findIndex((total) => total > limits.maxBytes)
  const partial = over === 0
  const kept = partial
    ? [truncateStringToBytesFromEnd(newest[0]!, limits.maxBytes)]
    : newest.slice(0, over < 0 ? newest.length : over).toReversed()
  const output = kept.join("\n")
  return {
    ...base,
    content: output,
    truncated: true,
    truncatedBy: over >= 0 && kept.length < limits.maxLines ? "bytes" : "lines",
    outputLines: kept.length,
    outputBytes: byteLength(output),
    lastLinePartial: partial,
  }
}

function untouched(
  content: string,
  base: {
    readonly totalLines: number
    readonly totalBytes: number
    readonly maxLines: number
    readonly maxBytes: number
  },
) {
  return {
    ...base,
    content,
    truncated: false,
    truncatedBy: null,
    outputLines: base.totalLines,
    outputBytes: base.totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
  }
}

/** Lines for counting: a trailing newline does not start another line. */
function splitLinesForCounting(content: string) {
  if (content.length === 0) return []
  const lines = content.split("\n")
  return content.endsWith("\n") ? lines.slice(0, -1) : lines
}

/** Running totals of `sizes`. */
function running(sizes: ReadonlyArray<number>) {
  const sum = { total: 0 }
  return sizes.map((size) => (sum.total += size))
}

/** The end of `text` within `maxBytes`, starting on a UTF-8 character boundary. */
function truncateStringToBytesFromEnd(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf-8")
  if (buffer.length <= maxBytes) return text
  const tail = buffer.subarray(buffer.length - maxBytes)
  const start = tail.findIndex((byte) => (byte & 0xc0) !== 0x80)
  return tail.subarray(start < 0 ? tail.length : start).toString("utf-8")
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf-8")
}

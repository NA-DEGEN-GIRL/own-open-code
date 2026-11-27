// Ports packages/coding-agent/src/core/tools/read.ts with utils/mime.ts and utils/image-process.ts: Pi's `read` tool.
// Text files come back from `offset` (1-indexed) up to `limit` lines, cut at 2000 lines or 50KB with Pi's continuation
// notices; images found by their magic bytes come back as an attachment after a `Read image file [type]` note. Pi
// resizes images to the provider's inline limits and converts BMP to PNG with a bundled image library; own sends PNG,
// JPEG, GIF and WebP as they are and answers Pi's conversion notice for BMP. Text is streamed and only the lines the
// read can show are kept (Pi 1.5.1, 3a7bb6f48, #9654): a one-line read of a large log no longer holds the file three
// times over in the shared service process. The text the model reads is the same.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiRead from "./read.js"

import { Buffer } from "node:buffer"
import { constants } from "node:fs"
import { access, open, readFile } from "node:fs/promises"
import type { PiArgs } from "./args.js"
import { PiTruncate } from "./truncate.js"

export const NAME = "read"

export const DESCRIPTION = `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${PiTruncate.DEFAULT_MAX_LINES} lines or ${PiTruncate.DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`

export const SCHEMA: PiArgs.ObjectSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["path"],
}

export interface Input {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

const NON_VISION_NOTE = "[Current model does not support images. The image will be omitted from this request.]"
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/**
 * Reads `absolute` (the path `input.path` resolved to) as Pi's read tool does. Fails like Pi with the filesystem's
 * error (`ENOENT: …`), with `Offset N is beyond end of file (M lines total)`, and with `Operation aborted` when `signal`
 * aborts a streamed read. `stream` is Pi's `ReadOperations.createReadStream` (default {@link readLocalFileChunks}).
 */
export async function execute(
  input: Input,
  absolute: string,
  options: {
    readonly vision: boolean
    readonly signal?: AbortSignal
    readonly stream?: (file: string, signal: AbortSignal | undefined) => AsyncIterable<Uint8Array>
  },
) {
  await access(absolute, constants.R_OK)
  const mimeType = await detectImageMimeType(absolute)
  const note = options.vision ? undefined : NON_VISION_NOTE
  if (mimeType !== null) {
    const bytes = await readFile(absolute)
    if (!INLINE_TYPES.has(mimeType))
      return {
        content: [
          {
            type: "text",
            text: withNote(
              `Read image file [${mimeType}]\n[Image omitted: could not be converted to a supported inline image format.]`,
              note,
            ),
          },
        ] satisfies ReadonlyArray<Content>,
        details: undefined,
      }
    return {
      content: [
        { type: "text", text: withNote(`Read image file [${mimeType}]`, note) },
        { type: "image", data: bytes.toString("base64"), mimeType },
      ] satisfies ReadonlyArray<Content>,
      details: undefined,
    }
  }
  // Offset converts from 1-indexed input to 0-indexed line access.
  const start = input.offset ? Math.max(0, input.offset - 1) : 0
  const startDisplay = start + 1
  const selected = streamable(input.offset, input.limit)
    ? await selectLinesFromStream(
        (options.stream ?? readLocalFileChunks)(absolute, options.signal),
        start,
        input.limit,
        options.signal,
      )
    : selectLinesFromBuffer(await readFile(absolute), start, input.limit)
  const total = selected.totalFileLines
  if (start >= total) throw new Error(`Offset ${input.offset} is beyond end of file (${total} lines total)`)
  // A user-specified limit is honored before truncation.
  const end = input.limit === undefined ? total : Math.min(start + input.limit, total)
  const truncation = selected.truncation
  const output = (() => {
    if (truncation.firstLineExceedsLimit) {
      const size = PiTruncate.formatSize(selected.firstLineBytes)
      return `[Line ${startDisplay} is ${size}, exceeds ${PiTruncate.formatSize(PiTruncate.DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startDisplay}p' ${input.path} | head -c ${PiTruncate.DEFAULT_MAX_BYTES}]`
    }
    if (truncation.truncated) {
      const endDisplay = startDisplay + truncation.outputLines - 1
      const limit =
        truncation.truncatedBy === "lines" ? "" : ` (${PiTruncate.formatSize(PiTruncate.DEFAULT_MAX_BYTES)} limit)`
      return `${truncation.content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${total}${limit}. Use offset=${endDisplay + 1} to continue.]`
    }
    if (input.limit !== undefined && end < total)
      return `${truncation.content}\n\n[${total - end} more lines in file. Use offset=${end + 1} to continue.]`
    return truncation.content
  })()
  return {
    content: [{ type: "text", text: output }] satisfies ReadonlyArray<Content>,
    details: truncation.truncated ? { truncation } : undefined,
  }
}

function withNote(text: string, note: string | undefined) {
  return note === undefined ? text : `${text}\n${note}`
}

/** The lines a read shows, with the file's line count; line counts follow `text.split("\n")`. */
interface Selected {
  readonly totalFileLines: number
  readonly truncation: PiTruncate.Result
  /** Bytes of the first selected line, for the notice when it alone exceeds the byte limit. */
  readonly firstLineBytes: number
}

/**
 * `readLocalFileChunks`: a file streamed the way `readFile` reads it, a regular file up to its size when opened (text
 * appended during the read is not counted, and a growing file still ends), a file reporting size 0 (such as /proc
 * files) and other file types until EOF. own reads 1 MiB chunks where Pi takes Node's 64 KiB: Bun pays per chunk, and
 * a one-line read of a 200 MB log on this PC took 2.7–16 s in 64 KiB chunks and 0.9–2.8 s in 1 MiB ones under load
 * (peak memory 66–78 MB vs about 100 MB; the whole-file read it replaces peaked at 536 MB). The text is the same.
 */
export async function* readLocalFileChunks(file: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const handle = await open(file, "r")
  try {
    const stats = await handle.stat()
    const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined
    yield* handle.createReadStream({ end, signal, autoClose: false, highWaterMark: 1024 * 1024 })
  } finally {
    await handle.close()
  }
}

/**
 * `isStreamableRange`: other values (a fractional offset or limit, a negative limit) keep the whole-file path, whose
 * array slicing defines what they select, for example limit -1 as all lines but the last.
 */
function streamable(offset: number | undefined, limit: number | undefined) {
  return (
    (offset === undefined || Number.isInteger(offset)) &&
    (limit === undefined || (Number.isInteger(limit) && limit >= 0))
  )
}

/** `selectLinesFromBuffer`: the lines of a whole file in memory, for ranges the stream does not take. */
function selectLinesFromBuffer(buffer: Buffer, start: number, limit: number | undefined): Selected {
  const lines = buffer.toString("utf-8").split("\n")
  const end = limit === undefined ? undefined : Math.min(start + limit, lines.length)
  const truncation = PiTruncate.truncateHead(lines.slice(start, end).join("\n"))
  return {
    totalFileLines: lines.length,
    truncation,
    firstLineBytes: truncation.firstLineExceedsLimit ? Buffer.byteLength(lines[start]!, "utf-8") : 0,
  }
}

/**
 * `selectLinesFromStream`: the lines of a file read in chunks. Only lines truncateHead can show are stored, plus one
 * past its caps; the rest are counted, so memory does not grow with the file. Stops reading when `signal` aborts
 * (leaving the loop closes the stream).
 */
async function selectLinesFromStream(
  chunks: AsyncIterable<Uint8Array>,
  start: number,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<Selected> {
  const end = limit === undefined ? Number.POSITIVE_INFINITY : start + limit
  // Non-fatal UTF-8 that keeps a byte order mark decodes like Buffer.toString("utf-8").
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
  const stored: Array<string> = []
  const state = {
    storedBytes: 0,
    storedPastCaps: false,
    line: 0,
    selectedLines: 0,
    selectedBytes: 0,
    firstLineBytes: 0,
    lastLineEmpty: true,
    // The selected line being read: its text, while it is stored, and its size.
    pieces: [] as Array<string> | undefined,
    lineBytes: 0,
    lineHasText: false,
  }
  const appendToLine = (text: string, from: number, to: number) => {
    state.lineHasText = true
    if (state.pieces === undefined) return
    const piece = text.slice(from, to)
    // A line over the byte cap is never shown, and a first line over it is only measured: never store all of a 1 GB
    // line.
    if (state.lineBytes <= PiTruncate.DEFAULT_MAX_BYTES) state.pieces.push(piece)
    state.lineBytes += Buffer.byteLength(piece, "utf-8")
  }
  const finishLine = () => {
    if (state.pieces !== undefined) {
      if (state.selectedLines === 0) state.firstLineBytes = state.lineBytes
      // Storing continues one line past the caps: truncateHead ignores a trailing empty line, so the line after the cap
      // must be there for it to decide truncation as for the full text.
      if (stored.length > PiTruncate.DEFAULT_MAX_LINES || state.storedBytes > PiTruncate.DEFAULT_MAX_BYTES)
        state.storedPastCaps = true
      const text = state.pieces.join("")
      state.storedBytes += Buffer.byteLength(text, "utf-8") + (stored.length > 0 ? 1 : 0)
      stored.push(text)
    }
    state.selectedLines++
    state.lastLineEmpty = !state.lineHasText
    state.pieces = state.storedPastCaps ? undefined : []
    state.lineBytes = 0
    state.lineHasText = false
  }
  const select = (text: string) => {
    // Start of the selected text in this piece, measured as a whole: the joined lines' size.
    const cursor = { position: 0, selectionStart: -1 }
    while (true) {
      const selected = state.line >= start && state.line < end
      if (selected && cursor.selectionStart === -1) cursor.selectionStart = cursor.position
      const newline = text.indexOf("\n", cursor.position)
      const lineEnd = newline === -1 ? text.length : newline
      if (selected && lineEnd > cursor.position) appendToLine(text, cursor.position, lineEnd)
      if (newline === -1) break
      if (selected) {
        finishLine()
        if (state.line + 1 === end) {
          state.selectedBytes += Buffer.byteLength(text.slice(cursor.selectionStart, newline), "utf-8")
          cursor.selectionStart = -1
        }
      }
      state.line++
      cursor.position = newline + 1
    }
    if (cursor.selectionStart !== -1)
      state.selectedBytes += Buffer.byteLength(text.slice(cursor.selectionStart), "utf-8")
  }
  for await (const chunk of chunks) {
    if (signal?.aborted) throw new Error("Operation aborted")
    select(decoder.decode(chunk, { stream: true }))
  }
  select(decoder.decode())
  if (state.line >= start && state.line < end) finishLine()
  return {
    totalFileLines: state.line + 1,
    truncation: {
      ...PiTruncate.truncateHead(stored.join("\n")),
      // truncateHead's counts for the joined selected lines, which drop a trailing empty line.
      totalLines: state.selectedBytes === 0 ? 0 : state.selectedLines - (state.lastLineEmpty ? 1 : 0),
      totalBytes: state.selectedBytes,
    },
    firstLineBytes: state.firstLineBytes,
  }
}

const SNIFF_BYTES = 4100
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** `detectSupportedImageMimeTypeFromFile`: the image type by magic bytes, not by extension. */
export async function detectImageMimeType(file: string) {
  const handle = await open(file, "r")
  const head = await handle
    .read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0)
    .then((read) => read.buffer.subarray(0, read.bytesRead))
    .finally(() => handle.close())
  return detectSupportedImageMimeType(head)
}

export function detectSupportedImageMimeType(buffer: Uint8Array) {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? null : "image/jpeg"
  if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null
  if (ascii(buffer, 0, "GIF87a") || ascii(buffer, 0, "GIF89a")) return "image/gif"
  if (ascii(buffer, 0, "RIFF") && ascii(buffer, 8, "WEBP")) return "image/webp"
  if (ascii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp"
  return null
}

function isPng(buffer: Uint8Array) {
  return buffer.length >= 16 && uint32BE(buffer, PNG_SIGNATURE.length) === 13 && ascii(buffer, 12, "IHDR")
}

/** An APNG has an `acTL` chunk before its first `IDAT`. */
function isAnimatedPng(buffer: Uint8Array, offset = PNG_SIGNATURE.length): boolean {
  if (offset + 8 > buffer.length) return false
  if (ascii(buffer, offset + 4, "acTL")) return true
  if (ascii(buffer, offset + 4, "IDAT")) return false
  const next = offset + 8 + uint32BE(buffer, offset) + 4
  if (next <= offset || next > buffer.length) return false
  return isAnimatedPng(buffer, next)
}

function isBmp(buffer: Uint8Array) {
  if (buffer.length < 26) return false
  const declared = uint32LE(buffer, 2)
  const pixels = uint32LE(buffer, 10)
  const header = uint32LE(buffer, 14)
  if (declared !== 0 && declared < 26) return false
  if (pixels < 14 + header) return false
  if (declared !== 0 && pixels >= declared) return false
  const fields =
    header === 12
      ? { planes: uint16LE(buffer, 22), bits: uint16LE(buffer, 24) }
      : header >= 40 && header <= 124 && buffer.length >= 30
        ? { planes: uint16LE(buffer, 26), bits: uint16LE(buffer, 28) }
        : undefined
  return fields !== undefined && fields.planes === 1 && [1, 4, 8, 16, 24, 32].includes(fields.bits)
}

function uint16LE(buffer: Uint8Array, offset: number) {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8)
}

function uint32BE(buffer: Uint8Array, offset: number) {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  )
}

function uint32LE(buffer: Uint8Array, offset: number) {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  )
}

function startsWith(buffer: Uint8Array, bytes: ReadonlyArray<number>) {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte)
}

function ascii(buffer: Uint8Array, offset: number, text: string) {
  return (
    buffer.length >= offset + text.length &&
    [...text].every((char, index) => buffer[offset + index] === char.charCodeAt(0))
  )
}

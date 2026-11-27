// Ports packages/coding-agent/src/core/tools/output-accumulator.ts and utils/output-files.ts: streamed shell output with
// bounded memory. Chunks decode with a streaming UTF-8 decoder, only a decoded tail is kept for the model's snapshot,
// and once the output passes a limit the full raw output goes to `<tmpdir>/pi-bash-<16 hex>.log` (mode 0600).
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiOutput from "./output.js"

import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { createWriteStream, type WriteStream } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PiTruncate } from "./truncate.js"

export interface Snapshot {
  readonly content: string
  readonly truncation: PiTruncate.Result
  readonly fullOutputPath?: string
}

export class Accumulator {
  private readonly maxLines: number
  private readonly maxBytes: number
  private readonly maxRollingBytes: number
  private readonly decoder = new TextDecoder()
  private rawChunks: Array<Buffer> = []
  private tailText = ""
  private tailBytes = 0
  private tailStartsAtLineBoundary = true
  private totalRawBytes = 0
  private totalDecodedBytes = 0
  private completedLines = 0
  private totalLines = 0
  private currentLineBytes = 0
  private hasOpenLine = false
  private finished = false
  private tempFilePath: string | undefined
  private tempFileStream: WriteStream | undefined

  constructor(
    private readonly tempFilePrefix = "pi-output",
    options: PiTruncate.Options = {},
  ) {
    this.maxLines = options.maxLines ?? PiTruncate.DEFAULT_MAX_LINES
    this.maxBytes = options.maxBytes ?? PiTruncate.DEFAULT_MAX_BYTES
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1)
  }

  append(data: Buffer) {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator")
    this.totalRawBytes += data.length
    this.appendDecodedText(this.decoder.decode(data, { stream: true }))
    if (this.tempFileStream !== undefined || this.shouldUseTempFile()) {
      this.ensureTempFile()
      this.tempFileStream?.write(data)
      return
    }
    if (data.length > 0) this.rawChunks.push(data)
  }

  finish() {
    if (this.finished) return
    this.finished = true
    this.appendDecodedText(this.decoder.decode())
    if (this.shouldUseTempFile()) this.ensureTempFile()
  }

  snapshot(options: { readonly persistIfTruncated?: boolean } = {}): Snapshot {
    const tail = PiTruncate.truncateTail(this.snapshotText(), { maxLines: this.maxLines, maxBytes: this.maxBytes })
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes
    const truncation: PiTruncate.Result = {
      ...tail,
      truncated,
      truncatedBy: truncated
        ? (tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
        : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    }
    if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile()
    return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath }
  }

  closeTempFile() {
    const stream = this.tempFileStream
    if (stream === undefined) return Promise.resolve()
    this.tempFileStream = undefined
    return new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("finish", () => resolve())
      stream.end()
    })
  }

  lastLineBytes() {
    return this.currentLineBytes
  }

  private appendDecodedText(text: string) {
    if (text.length === 0) return
    const bytes = Buffer.byteLength(text, "utf-8")
    this.totalDecodedBytes += bytes
    this.tailText += text
    this.tailBytes += bytes
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail()
    const lastNewline = text.lastIndexOf("\n")
    if (lastNewline < 0) {
      this.currentLineBytes += bytes
      this.hasOpenLine = true
    }
    if (lastNewline >= 0) {
      this.completedLines += text.split("\n").length - 1
      const rest = text.slice(lastNewline + 1)
      this.currentLineBytes = Buffer.byteLength(rest, "utf-8")
      this.hasOpenLine = rest.length > 0
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0)
  }

  private trimTail() {
    const buffer = Buffer.from(this.tailText, "utf-8")
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length
      return
    }
    const cut = buffer.length - this.maxRollingBytes
    const boundary = buffer.subarray(cut).findIndex((byte) => (byte & 0xc0) !== 0x80)
    const start = boundary < 0 ? buffer.length : cut + boundary
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a
    this.tailText = buffer.subarray(start).toString("utf-8")
    this.tailBytes = Buffer.byteLength(this.tailText, "utf-8")
  }

  private snapshotText() {
    if (this.tailStartsAtLineBoundary) return this.tailText
    const firstNewline = this.tailText.indexOf("\n")
    return firstNewline < 0 ? this.tailText : this.tailText.slice(firstNewline + 1)
  }

  private shouldUseTempFile() {
    return (
      this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
    )
  }

  private ensureTempFile() {
    if (this.tempFilePath !== undefined) return
    // Output can carry private data, so only the user may read the file; `wx` never follows a planted link.
    const file = path.join(tmpdir(), `${this.tempFilePrefix}-${randomBytes(8).toString("hex")}.log`)
    this.tempFilePath = file
    this.tempFileStream = createWriteStream(file, { mode: 0o600, flags: "wx" })
    this.rawChunks.forEach((chunk) => this.tempFileStream?.write(chunk))
    this.rawChunks = []
  }
}

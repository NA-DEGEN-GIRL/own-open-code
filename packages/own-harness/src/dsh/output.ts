// Ports packages/subprocess/subprocess-local/src/output.ts `OutputCollector`: one stream collected with a bounded
// in-memory tail (byte-exact at the cap, errors and results cluster at the end of command output) and, on the first
// overflow, every chunk of the stream written to a private spill file (`wx`, mode 0600) while the whole stream stays
// within the spill cap; a larger stream keeps only its tail. Spilling is best-effort: a failure drops the spill and
// collection goes on.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshOutput from "./output.js"

import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export interface Collected {
  readonly text: string
  readonly truncated: boolean
  readonly spillPath?: string
}

const state = { counter: 0, dir: undefined as string | undefined }

/** dsh's private per-process spill directory under the OS temp folder, made on first use. */
function spillDir() {
  state.dir ??= mkdtempSync(path.join(tmpdir(), "dsh-subprocess-"))
  return state.dir
}

export class Collector {
  private chunks: Array<Buffer> = []
  private bytes = 0
  private dropped = false
  private total = 0
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean

  constructor(
    private readonly maxBytes: number,
    private readonly label: string,
    private readonly spill: { readonly maxBytes: number } | undefined,
  ) {
    this.spillDisabled = spill === undefined
  }

  push(chunk: Buffer) {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (this.spill !== undefined && !this.spillDisabled && (overflows || this.spillFd !== undefined))
      this.spillAll(this.spill, chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]!
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /** Closes the spill file and answers the tail, whether bytes were dropped, and the spill path while it is whole. */
  finalize(): Collected {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        this.spillFile = undefined
      }
      this.spillFd = undefined
    }
    return {
      text: Buffer.concat(this.chunks).toString("utf8"),
      truncated: this.dropped,
      ...(this.spillFile === undefined ? {} : { spillPath: this.spillFile }),
    }
  }

  private spillAll(spill: { readonly maxBytes: number }, chunk: Buffer) {
    if (this.total > spill.maxBytes) return this.discardSpill()
    try {
      if (this.spillFd === undefined) {
        const file = path.join(
          spillDir(),
          `dsh-subprocess-${process.pid}-${++state.counter}-${randomBytes(6).toString("hex")}-${this.label}.log`,
        )
        const fd = openSync(file, "wx", 0o600)
        this.spillFile = file
        this.spillFd = fd
        this.chunks.forEach((prior) => writeSync(fd, prior))
      }
      writeSync(this.spillFd, chunk)
    } catch {
      this.discardSpill()
    }
  }

  private discardSpill() {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined)
      try {
        closeSync(fd)
      } catch {
        // A failed close leaves only the descriptor; the in-memory tail stays.
      }
    if (file !== undefined)
      try {
        unlinkSync(file)
      } catch {
        // At most the spill cap is left behind.
      }
  }
}

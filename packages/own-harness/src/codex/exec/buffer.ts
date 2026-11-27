// Ports codex-rs/core/src/unified_exec/head_tail_buffer.rs and `format_output_omission_marker` (unified_exec/mod.rs).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as HeadTail from "./buffer.js"

/** `UNIFIED_EXEC_OUTPUT_MAX_BYTES`: output kept per collection, half from the start and half from the end. */
export const MAX_BYTES = 1024 * 1024

export function omissionMarker(omitted: number) {
  return `... ${omitted} bytes omitted ...`
}

/** Keeps the first and the last `max / 2` bytes of a stream and counts what fell between them. */
export class Buffer {
  private head: Uint8Array = new Uint8Array(0)
  private tail: Uint8Array = new Uint8Array(0)
  private omitted = 0

  constructor(private readonly max = MAX_BYTES) {}

  private get headBudget() {
    return Math.floor(this.max / 2)
  }

  private get tailBudget() {
    return this.max - this.headBudget
  }

  get retainedBytes() {
    return this.head.length + this.tail.length
  }

  get omittedBytes() {
    return this.omitted
  }

  get totalBytes() {
    return this.retainedBytes + this.omitted
  }

  get empty() {
    return this.retainedBytes === 0 && this.omitted === 0
  }

  push(chunk: Uint8Array) {
    this.pushTail(this.fillHead(chunk))
  }

  private fillHead(chunk: Uint8Array) {
    const room = Math.max(0, this.headBudget - this.head.length)
    if (room === 0) return chunk
    this.head = concat(this.head, chunk.subarray(0, room))
    return chunk.subarray(room)
  }

  private adoptHead(head: Uint8Array) {
    this.head = head
    return new Uint8Array(0)
  }

  private pushTail(chunk: Uint8Array) {
    const room = Math.max(0, this.tailBudget - this.tail.length)
    const excess = Math.max(0, chunk.length - room)
    this.omitted += excess
    if (excess <= this.tail.length) {
      this.tail = concat(this.tail.subarray(excess), chunk)
      return
    }
    this.tail = chunk.slice(excess - this.tail.length)
  }

  bytes() {
    return concat(this.head, this.tail)
  }

  bytesWithOmissionMarker() {
    if (this.omitted === 0) return this.bytes()
    return concat(this.head, new TextEncoder().encode(`\n${omissionMarker(this.omitted)}\n`), this.tail)
  }

  /** Takes another buffer's contents (Codex `push_buffer`), as a collection drains a process's pending output. */
  pushBuffer(other: Buffer) {
    this.omitted += other.omitted
    const overflow = this.head.length === 0 ? this.adoptHead(other.head) : this.fillHead(other.head)
    if (other.tail.length === this.tailBudget) {
      this.omitted += this.tail.length + overflow.length
      this.tail = other.tail
      return
    }
    this.pushTail(overflow)
    if (this.tail.length === 0) {
      this.tail = other.tail
      return
    }
    this.pushTail(other.tail)
  }

  /** Moves everything out, leaving this buffer empty. */
  take() {
    const taken = new Buffer(this.max)
    taken.head = this.head
    taken.tail = this.tail
    taken.omitted = this.omitted
    this.head = new Uint8Array(0)
    this.tail = new Uint8Array(0)
    this.omitted = 0
    return taken
  }
}

function concat(...parts: ReadonlyArray<Uint8Array>) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((offset, part) => (out.set(part, offset), offset + part.length), 0)
  return out
}

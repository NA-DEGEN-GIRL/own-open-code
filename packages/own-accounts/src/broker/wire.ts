export * as Wire from "./wire.js"

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type net from "node:net"
import { Broker } from "@own/protocol"

/**
 * Framing and handshake primitives shared by the local broker server and the remote broker client (04 §8.3–8.4):
 * 4-byte big-endian length + UTF-8 JSON, at most `Broker.MAX_FRAME_BYTES`; HMAC-SHA256 proofs compared in constant
 * time. Nothing here logs frame bytes (04 §8.4: a first frame that is not `hello` is closed without recording it).
 */

export type DecodeError = "too_large" | "not_json"

/** Incremental frame decoder. After an error it stays failed; the caller closes the connection. */
export class Decoder {
  #buffer: Buffer = Buffer.alloc(0)
  #failed: DecodeError | undefined
  readonly #max: number

  constructor(max = Broker.MAX_FRAME_BYTES) {
    this.#max = max
  }

  /** Appends bytes and returns the complete frames' JSON values in order. */
  push(chunk: Uint8Array): { readonly frames: unknown[]; readonly error?: DecodeError } {
    if (this.#failed) return { frames: [], error: this.#failed }
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk])
    const frames: unknown[] = []
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length > this.#max) return this.#fail(frames, "too_large")
      if (this.#buffer.length < 4 + length) break
      const body = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      try {
        frames.push(JSON.parse(body.toString("utf8")))
      } catch {
        return this.#fail(frames, "not_json")
      }
    }
    return { frames }
  }

  #fail(frames: unknown[], error: DecodeError) {
    this.#failed = error
    this.#buffer = Buffer.alloc(0)
    return { frames, error }
  }
}

export const encode = Broker.encodeFrame

/** 16 random bytes as hex, for `nonceR` / `nonceL`. */
export function nonce() {
  return randomBytes(16).toString("hex")
}

export interface MacInput {
  readonly hostId: string
  readonly epoch: number
  readonly nonceR: string
  readonly nonceL: string
}

export function mac(key: Uint8Array, side: "L" | "R", input: MacInput) {
  return createHmac("sha256", key).update(Broker.macInput(side, input)).digest("hex")
}

/** Constant-time comparison of two hex strings (unequal lengths are simply unequal). */
export function equal(a: string, b: string) {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * A framed JSON channel over a socket. `send` never throws (a closed socket drops the frame); `onFrame` receives
 * decoded values; a decode error or a socket error ends the channel. Frames that arrive while nobody listens (e.g. a
 * push right behind `ready`, before the session registered its handler) are queued for the next listener.
 */
export class Channel {
  readonly socket: net.Socket
  readonly #decoder = new Decoder()
  readonly #listeners = new Set<(value: unknown) => void>()
  readonly #closers = new Set<(reason: string) => void>()
  readonly #queue: unknown[] = []
  #closed = false

  constructor(socket: net.Socket) {
    this.socket = socket
    socket.on("data", (chunk: Buffer) => {
      if (this.#closed) return
      const decoded = this.#decoder.push(chunk)
      for (const frame of decoded.frames) {
        if (this.#closed) return
        this.#dispatch(frame)
      }
      if (decoded.error) this.close(decoded.error)
    })
    socket.on("error", () => this.close("socket_error"))
    socket.on("close", () => this.close("closed"))
  }

  get closed() {
    return this.#closed
  }

  onFrame(listener: (value: unknown) => void) {
    this.#listeners.add(listener)
    while (this.#queue.length > 0 && this.#listeners.has(listener) && !this.#closed) listener(this.#queue.shift())
    return () => void this.#listeners.delete(listener)
  }

  #dispatch(frame: unknown) {
    if (this.#listeners.size === 0) {
      if (this.#queue.length < 64) this.#queue.push(frame)
      else this.close("backlog")
      return
    }
    for (const listener of [...this.#listeners]) listener(frame)
  }

  onClose(listener: (reason: string) => void) {
    if (this.#closed) {
      listener("closed")
      return () => {}
    }
    this.#closers.add(listener)
    return () => void this.#closers.delete(listener)
  }

  send(value: unknown) {
    if (this.#closed) return false
    try {
      this.socket.write(encode(value))
      return true
    } catch {
      return false
    }
  }

  /** Resolves with the next frame, or `undefined` after `timeoutMs` or when the channel closes. */
  next(timeoutMs: number): Promise<unknown> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift())
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const cleanup: Array<() => void> = []
      let settled = false
      const done = (value: unknown) => {
        if (settled) return
        settled = true
        for (const run of cleanup) run()
        resolve(value)
      }
      const timer = setTimeout(() => done(undefined), timeoutMs)
      cleanup.push(() => clearTimeout(timer))
      cleanup.push(this.onClose(() => done(undefined)))
      cleanup.push(this.onFrame((value) => done(value)))
      if (settled) for (const run of cleanup) run()
    })
  }

  close(reason = "closed") {
    if (this.#closed) return
    this.#closed = true
    this.#listeners.clear()
    this.socket.destroy()
    for (const closer of [...this.#closers]) closer(reason)
    this.#closers.clear()
  }
}

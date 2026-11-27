// The live view of a running exec_command / write_stdin for the transcript (display only): while a collection waits,
// the call's progress metadata carries the output so far (session-ui shows a running tool's `metadata.output`; own-web
// draws both tools as the shell card), at most every INTERVAL_MS and only when it changed. The model's result is the
// collection's own text (ExecOutput); nothing here reaches it, and the finished card shows that result instead.
export * as ExecLive from "./live.js"

import type { Tool } from "@opencode/schema/tool"
import { Effect, Fiber } from "effect"

/** The most of the output one update carries: its tail, in characters. */
export const MAX_CHARS = 64 * 1024
export const INTERVAL_MS = 250

/** Decoded output that keeps its last MAX_CHARS characters; `version` counts the changes. */
export class Tail {
  private readonly decoder = new TextDecoder()
  private pieces: Array<string> = []
  private size = 0
  version = 0

  push(chunk: Uint8Array) {
    const text = this.decoder.decode(chunk, { stream: true })
    if (text === "") return
    this.pieces.push(text)
    this.size += text.length
    this.version += 1
    // Joining at every chunk would copy the tail per line of output; trim only once it doubled.
    if (this.size > 2 * MAX_CHARS) this.text()
  }

  text() {
    const joined = this.pieces.join("").slice(-MAX_CHARS)
    this.pieces = [joined]
    this.size = joined.length
    return joined
  }
}

/**
 * Runs `collect` (one collection, given a sink for each output chunk) while publishing `{...metadata, output}` as the
 * call's progress. A failed publication is dropped (core refuses progress once the call settled); the ticker stops
 * when the collection ends, before the tool returns.
 */
export function watch<A, E, R>(
  progress: Tool.Context["progress"],
  metadata: Readonly<Record<string, unknown>>,
  collect: (onOutput: (chunk: Uint8Array) => void) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tail = new Tail()
    const sent = { version: 0 }
    const publish = Effect.suspend(() => {
      if (tail.version === sent.version) return Effect.void
      sent.version = tail.version
      return progress({ ...metadata, output: tail.text() })
    }).pipe(Effect.catchCause(() => Effect.void))
    const ticker = yield* publish.pipe(Effect.delay(INTERVAL_MS), Effect.forever, Effect.forkChild)
    return yield* collect((chunk) => tail.push(chunk)).pipe(Effect.ensuring(Fiber.interrupt(ticker)))
  })
}

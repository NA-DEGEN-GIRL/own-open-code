export * as HelperTransport from "./transport.js"

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { Option, Schema } from "effect"
import { HelperProtocol } from "./protocol.js"

/**
 * The child-process side of the helper protocol, modelled on own-runtime's vault transport: the helper starts lazily on
 * the first request with a minimal environment and no window, answers `hello` before anything else is sent, and is
 * killed (pending requests fail) on a timeout, a crash, an oversized line or a refused `hello`; the next request starts
 * a fresh one, with a backoff after repeated failures. Lines without `rid` that name an `event` are passed to
 * `onEvent`. Promise-based like the vault client; the driver wraps it in Effects.
 */

export type Reason = "unavailable" | "timeout" | "protocol"

export class TransportError extends Error {
  readonly reason: Reason

  constructor(reason: Reason, message: string) {
    super(message)
    this.reason = reason
  }
}

export interface Options {
  /** `[exe]`, or a replacement command line such as `[bun, test/fixtures/fake-helper.ts]`. */
  readonly command: ReadonlyArray<string>
  /** Environment of the helper. Default: only `SystemRoot` and `windir` (like own-vault, 01 §13 "최소 env"). */
  readonly env?: Readonly<Record<string, string>>
  /** Per-request timeout; on expiry the helper is killed. */
  readonly timeoutMs: number
  /** How long `close` and `restart` wait after stdin EOF before killing the helper. Default 1 s. */
  readonly closeTimeoutMs?: number
  readonly maxLineBytes?: number
  /** Why a `hello` answer is refused, or `undefined` to accept it. */
  readonly accept: (hello: unknown) => string | undefined
  readonly onEvent?: (event: unknown) => void
  /**
   * A helper that had answered `hello` stopped without `close` or `restart`: it crashed, someone killed it, or it was
   * killed after a timeout or a broken line. Input it pressed may still be held, so the caller stops computer use (and
   * the Windows driver releases what it had pressed through the next helper).
   */
  readonly onExit?: (code: number | null) => void
  readonly now?: () => number
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: TransportError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const decodeRid = Schema.decodeUnknownOption(Schema.Struct({ rid: Schema.Int }))

export class Transport {
  readonly #options: Options
  readonly #now: () => number
  #child: ChildProcessWithoutNullStreams | undefined
  #starting: Promise<ChildProcessWithoutNullStreams> | undefined
  /** The child that answered `hello`, and that answer. */
  #ready: { readonly child: ChildProcessWithoutNullStreams; readonly hello: Record<string, unknown> } | undefined
  // Insertion-ordered: a response without `rid` belongs to the oldest request (the helper answers in order).
  readonly #pending = new Map<number, Pending>()
  #rid = 0
  #partial: Array<string> = []
  #partialLength = 0
  #failures = 0
  #retryAt = 0
  #closed = false

  constructor(options: Options) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /** A helper is up and answered `hello`. */
  get running() {
    return this.#ready !== undefined && this.#ready.child === this.#child && this.#starting === undefined
  }

  /** The accepted `hello` answer of the running helper. */
  get hello() {
    return this.running ? this.#ready?.hello : undefined
  }

  async request(message: Readonly<Record<string, unknown>>) {
    if (this.#closed) throw new TransportError("unavailable", "computer-use helper is closed")
    const child = await this.#ensure()
    const response = await this.#send(child, message)
    // A later `hello` replaces the stored answer: the stop chord can be registered after the start.
    if (message.op === "hello" && this.#ready?.child === child && this.#options.accept(response) === undefined)
      this.#ready = { child, hello: response }
    return response
  }

  /** Like `request`, but never starts a helper; `undefined` when none is running. */
  requestIfRunning(message: Readonly<Record<string, unknown>>) {
    const child = this.#child
    if (!this.running || child === undefined) return Promise.resolve(undefined)
    return this.#send(child, message)
  }

  /**
   * Stops the running helper like `close` (stdin EOF, so it releases held input itself) without reporting an exit, and
   * clears the backoff; the next request starts a new one.
   */
  async restart() {
    const child = this.#child
    this.#failures = 0
    this.#retryAt = 0
    if (child === undefined) return
    this.#child = undefined
    this.#starting = undefined
    this.#ready = undefined
    this.#reset()
    this.#rejectAll(new TransportError("unavailable", "computer-use helper was restarted"))
    await this.#stop(child)
  }

  async close() {
    this.#closed = true
    const child = this.#child ?? (await this.#starting?.catch(() => undefined))
    if (!child) return
    await this.#stop(child)
    this.#fail(child, new TransportError("unavailable", "computer-use helper is closed"))
  }

  // stdin EOF makes the helper release held input and exit; a kill only follows after the grace time, because killing
  // it first would skip that release (Windows keeps injected input pressed when the injecting process dies).
  async #stop(child: ChildProcessWithoutNullStreams) {
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once("exit", () => resolve())
    })
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), this.#options.closeTimeoutMs ?? 1_000)
    await exited
    clearTimeout(timer)
  }

  #ensure() {
    if (this.#child && !this.#starting) return Promise.resolve(this.#child)
    if (this.#starting) return this.#starting
    if (this.#now() < this.#retryAt)
      return Promise.reject(new TransportError("unavailable", "computer-use helper is unavailable (restart backoff)"))
    const starting = this.#start().finally(() => {
      if (this.#starting === starting) this.#starting = undefined
    })
    this.#starting = starting
    return starting
  }

  async #start() {
    const command = this.#options.command
    const env =
      this.#options.env ??
      Object.fromEntries(
        (["SystemRoot", "windir"] as const).flatMap((name) => {
          const value = process.env[name]
          return value ? [[name, value]] : []
        }),
      )
    const child = this.#spawn(command, env)
    this.#child = child
    this.#reset()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.#receive(child, chunk))
    // stderr is drained so the pipe never fills, and never logged (it could echo input).
    child.stderr.resume()
    // Writes after the helper died fail with EPIPE; the exit handler already failed the pending requests.
    child.stdin.on("error", () => undefined)
    child.on("error", (error) => this.#fail(child, cannotStart(error)))
    child.on("exit", (code, signal) =>
      this.#fail(
        child,
        new TransportError("unavailable", `computer-use helper exited (${code ?? signal ?? "unknown"})`),
        code,
      ),
    )
    const hello = await this.#send(child, { op: "hello" })
    const problem = this.#options.accept(hello)
    if (problem !== undefined) {
      const error = new TransportError("protocol", problem)
      this.#fail(child, error)
      throw error
    }
    this.#ready = { child, hello }
    this.#failures = 0
    this.#retryAt = 0
    return child
  }

  // Bun throws from spawn itself for some failures instead of emitting `error` (EUNKNOWN when Windows refuses the exe);
  // that is a failed start like any other, with the same backoff.
  #spawn(command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) {
    try {
      return spawn(command[0] ?? "", command.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env })
    } catch (error) {
      this.#failed()
      throw cannotStart(error)
    }
  }

  #send(child: ChildProcessWithoutNullStreams, message: Readonly<Record<string, unknown>>) {
    const rid = ++this.#rid
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.#child !== child) return reject(new TransportError("unavailable", "computer-use helper is not running"))
      const timeoutMs = this.#options.timeoutMs
      const timer = setTimeout(
        () =>
          this.#fail(
            child,
            new TransportError("timeout", `computer-use helper did not answer ${message.op} within ${timeoutMs} ms`),
          ),
        timeoutMs,
      )
      this.#pending.set(rid, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ ...message, rid })}\n`)
    })
  }

  // Captures arrive as one multi-megabyte line in many chunks: keep the pieces and join once per line.
  #receive(child: ChildProcessWithoutNullStreams, chunk: string) {
    if (this.#child !== child) return
    const max = this.#options.maxLineBytes ?? HelperProtocol.MAX_LINE_BYTES
    const segments = chunk.split("\n")
    const rest = segments.pop() ?? ""
    for (const segment of segments) {
      const line = this.#partial.length === 0 ? segment : [...this.#partial, segment].join("")
      this.#reset()
      if (line.length > max) return this.#fail(child, tooLong(max))
      this.#line(line)
      if (this.#child !== child) return
    }
    this.#partial.push(rest)
    this.#partialLength += rest.length
    if (this.#partialLength > max) this.#fail(child, tooLong(max))
  }

  #line(text: string) {
    const value = Option.getOrUndefined(decodeLine(text.trim()))
    if (value === undefined) return
    if (typeof value.event === "string" && value.rid === undefined) return this.#options.onEvent?.(value)
    const rid = Option.getOrUndefined(decodeRid(value))?.rid ?? this.#pending.keys().next().value
    const pending = rid === undefined ? undefined : this.#pending.get(rid)
    if (!pending || rid === undefined) return
    this.#pending.delete(rid)
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  // Once anything goes wrong with a helper, none of its later answers are trusted: kill it, fail every pending
  // request, and let the next request start a fresh one. Repeated failures back off (up to 30 s).
  #fail(child: ChildProcessWithoutNullStreams, error: TransportError, code: number | null = null) {
    if (this.#child !== child) return
    const ready = this.#ready?.child === child
    this.#child = undefined
    this.#ready = undefined
    this.#reset()
    if (!this.#closed) this.#failed()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    this.#rejectAll(error)
    if (ready && !this.#closed) this.#options.onExit?.(code)
  }

  #failed() {
    this.#failures += 1
    this.#retryAt = this.#failures >= 3 ? this.#now() + Math.min(30_000, 500 * 2 ** (this.#failures - 3)) : 0
  }

  #rejectAll(error: TransportError) {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(error)
    }
  }

  #reset() {
    this.#partial = []
    this.#partialLength = 0
  }
}

/**
 * An unknown spawn error on Windows is what an application control policy produces: Smart App Control (or WDAC) refusing
 * the unsigned, locally built helper (Code Integrity events 3077/3033), seen on the real desktop.
 */
function cannotStart(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const blocked = /\bE?UNKNOWN\b/.test(message)
    ? "; Windows may have blocked it (Smart App Control or an application control policy)"
    : ""
  return new TransportError("unavailable", `computer-use helper could not start: ${message}${blocked}`)
}

function tooLong(max: number) {
  return new TransportError("protocol", `computer-use helper sent a line over ${max} bytes`)
}

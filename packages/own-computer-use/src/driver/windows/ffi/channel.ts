export * as FfiChannel from "./channel.js"

import { Option, Schema } from "effect"
import { HelperTransport } from "../transport.js"
import { Native } from "./native.js"

/**
 * The main-thread side of a driver worker (desktop.ts, uia.ts), shaped like the helper's child-process transport so
 * the Windows driver runs over either: the worker starts lazily on the first request, answers `hello` before anything
 * else is sent, and answers `{rid, ok, …}` messages; `{event}` messages go to `onEvent`. Synchronous FFI never runs on
 * this thread. A request that is not answered within `timeoutMs`, an uncaught error in the worker or its unexpected end
 * abandons the worker (`terminate`, which returns at once even while it is stuck in a native call), fails every pending
 * request and reports `onExit` if it had answered `hello`; the next request starts a fresh one, with the transport's
 * backoff after repeated failures. `close` and `restart` ask the worker to `close` first (it releases held input, the
 * stop chord and the desktop mutex) and terminate it after that answer or `closeTimeoutMs`.
 */

export interface Handlers {
  readonly message: (data: unknown) => void
  /** An uncaught error in the worker (Bun then ends it). */
  readonly error: (message: string) => void
  readonly exit: (code: number | null) => void
}

/** One started worker. */
export interface Port {
  readonly post: (message: unknown) => void
  /** Ends the worker; returns at once. */
  readonly terminate: () => void
}

/** Starts a worker that reports to `handlers`. The default is `worker(source)`; tests inject a fake. */
export type Spawn = (handlers: Handlers) => Port

export interface Options {
  /** Names the worker in error messages ("computer-use desktop worker"). */
  readonly name: string
  readonly spawn: Spawn
  readonly timeoutMs: number
  /** How long `close` and `restart` wait for the worker's own `close` before terminating it. Default 1 s. */
  readonly closeTimeoutMs?: number
  /** Why a `hello` answer is refused, or `undefined` to accept it. */
  readonly accept: (hello: unknown) => string | undefined
  readonly onEvent?: (event: unknown) => void
  /** A worker that had answered `hello` ended without `close` or `restart` (crash, or abandoned after a timeout). */
  readonly onExit?: (code: number | null) => void
  readonly now?: () => number
}

/** A worker's whole source: every `Native` function, then `entry(config)` (desktop.ts and uia.ts `main`). */
export function script<C>(entry: (config: C) => Promise<void>, config: C) {
  return [
    ...Object.values(Native).filter((value) => typeof value === "function"),
    `(${String(entry)})(${JSON.stringify(config)})`,
  ]
    .map(String)
    .join("\n")
}

/**
 * A Bun worker running `source`. The plugin is one bundled file, so the source travels as text and runs from a Blob URL
 * (revoked once the worker has loaded it). Unreferenced: a worker never keeps the service process alive.
 */
export function worker(source: string): Spawn {
  return (handlers) => {
    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
    const value = new Worker(url) as unknown as BunWorker
    // Not on `open`: Bun fires it before the module is fetched (revoking then fails the load, seen with two workers).
    // A message means the source ran.
    const revoke = () => URL.revokeObjectURL(url)
    value.unref()
    value.addEventListener("message", (event) => {
      revoke()
      handlers.message(event.data)
    })
    value.addEventListener("error", (event) => {
      revoke()
      handlers.error(event.message ?? "unknown error")
    })
    value.addEventListener("close", (event) => {
      revoke()
      handlers.exit(event.code ?? null)
    })
    return { post: (message) => value.postMessage(message), terminate: () => value.terminate() }
  }
}

/**
 * What this uses of Bun's `Worker`: with the DOM lib loaded, the global `Worker` type is the browser's, without Bun's
 * `close` event (which carries the exit code) or `unref`.
 */
interface BunWorker {
  readonly postMessage: (message: unknown) => void
  readonly terminate: () => void
  readonly unref: () => void
  readonly addEventListener: (
    type: "message" | "error" | "close",
    listener: (event: { readonly data?: unknown; readonly message?: string; readonly code?: number }) => void,
  ) => void
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: HelperTransport.TransportError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const decodeMessage = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeRid = Schema.decodeUnknownOption(Schema.Struct({ rid: Schema.Int }))

/** The rid of a worker's own `close` while it is being stopped (requests count from 1). */
const CLOSE_RID = 0

export class Channel {
  readonly #options: Options
  readonly #now: () => number
  #port: Port | undefined
  #starting: Promise<Port> | undefined
  /** The port that answered `hello`, and that answer. */
  #ready: { readonly port: Port; readonly hello: Record<string, unknown> } | undefined
  readonly #pending = new Map<number, Pending>()
  /** Workers being stopped, each waiting for its `close` answer or its end. */
  readonly #stopping = new Map<Port, () => void>()
  #rid = 0
  #failures = 0
  #retryAt = 0
  #closed = false

  constructor(options: Options) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /** A worker is up and answered `hello`. */
  get running() {
    return this.#ready !== undefined && this.#ready.port === this.#port && this.#starting === undefined
  }

  /** The accepted `hello` answer of the running worker. */
  get hello() {
    return this.running ? this.#ready?.hello : undefined
  }

  async request(message: Readonly<Record<string, unknown>>) {
    if (this.#closed) throw new HelperTransport.TransportError("unavailable", `${this.#options.name} is closed`)
    const port = await this.#ensure()
    const response = await this.#send(port, message)
    // A later `hello` replaces the stored answer: the stop chord can be registered after the start.
    if (message.op === "hello" && this.#ready?.port === port && this.#options.accept(response) === undefined)
      this.#ready = { port, hello: response }
    return response
  }

  /** Like `request`, but never starts a worker; `undefined` when none is running. */
  requestIfRunning(message: Readonly<Record<string, unknown>>) {
    const port = this.#port
    if (!this.running || port === undefined) return Promise.resolve(undefined)
    return this.#send(port, message)
  }

  /** Stops the running worker like `close` without reporting an exit, and clears the backoff. */
  async restart() {
    const port = this.#port
    this.#failures = 0
    this.#retryAt = 0
    if (port === undefined) return
    this.#port = undefined
    this.#starting = undefined
    this.#ready = undefined
    this.#rejectAll(new HelperTransport.TransportError("unavailable", `${this.#options.name} was restarted`))
    await this.#stop(port)
  }

  async close() {
    this.#closed = true
    const port = this.#port ?? (await this.#starting?.catch(() => undefined))
    if (port === undefined) return
    this.#port = undefined
    this.#ready = undefined
    this.#rejectAll(new HelperTransport.TransportError("unavailable", `${this.#options.name} is closed`))
    await this.#stop(port)
  }

  async #stop(port: Port) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.#options.closeTimeoutMs ?? 1_000)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.#stopping.set(port, done)
      port.post({ op: "close", rid: CLOSE_RID })
    })
    this.#stopping.delete(port)
    port.terminate()
  }

  #ensure() {
    if (this.#port && !this.#starting) return Promise.resolve(this.#port)
    if (this.#starting) return this.#starting
    if (this.#now() < this.#retryAt)
      return Promise.reject(
        new HelperTransport.TransportError("unavailable", `${this.#options.name} is unavailable (restart backoff)`),
      )
    const starting = this.#start().finally(() => {
      if (this.#starting === starting) this.#starting = undefined
    })
    this.#starting = starting
    return starting
  }

  async #start() {
    const port = this.#spawn()
    this.#port = port
    const hello = await this.#send(port, { op: "hello" })
    const problem = this.#options.accept(hello)
    if (problem !== undefined) {
      const error = new HelperTransport.TransportError("protocol", problem)
      this.#fail(port, error)
      throw error
    }
    this.#ready = { port, hello }
    this.#failures = 0
    this.#retryAt = 0
    return port
  }

  // The handlers belong to the port they were given with; a port that is no longer current is ignored.
  #spawn() {
    const holder: { port?: Port } = {}
    const handlers: Handlers = {
      message: (data) => {
        if (holder.port !== undefined) this.#message(holder.port, data)
      },
      error: (message) => {
        if (holder.port !== undefined)
          this.#fail(
            holder.port,
            new HelperTransport.TransportError("unavailable", `${this.#options.name} failed: ${message}`),
          )
      },
      exit: (code) => {
        if (holder.port !== undefined) this.#ended(holder.port, code)
      },
    }
    try {
      const port = this.#options.spawn(handlers)
      holder.port = port
      return port
    } catch (error) {
      this.#failed()
      throw new HelperTransport.TransportError(
        "unavailable",
        `${this.#options.name} could not start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  #send(port: Port, message: Readonly<Record<string, unknown>>) {
    const rid = ++this.#rid
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.#port !== port)
        return reject(new HelperTransport.TransportError("unavailable", `${this.#options.name} is not running`))
      const timeoutMs = this.#options.timeoutMs
      const timer = setTimeout(
        () =>
          this.#fail(
            port,
            new HelperTransport.TransportError(
              "timeout",
              `${this.#options.name} did not answer ${String(message.op)} within ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      )
      this.#pending.set(rid, { resolve, reject, timer })
      port.post({ ...message, rid })
    })
  }

  #message(port: Port, data: unknown) {
    const value = Option.getOrUndefined(decodeMessage(data))
    if (value === undefined) return
    const rid = Option.getOrUndefined(decodeRid(value))?.rid
    if (port !== this.#port) {
      if (rid === CLOSE_RID) this.#stopping.get(port)?.()
      return
    }
    if (typeof value.event === "string" && rid === undefined) return this.#options.onEvent?.(value)
    const pending = rid === undefined ? undefined : this.#pending.get(rid)
    if (pending === undefined || rid === undefined) return
    this.#pending.delete(rid)
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  #ended(port: Port, code: number | null) {
    this.#stopping.get(port)?.()
    this.#fail(
      port,
      new HelperTransport.TransportError("unavailable", `${this.#options.name} stopped (${code ?? "unknown"})`),
      code,
    )
  }

  // Once anything goes wrong with a worker, none of its later answers are trusted: abandon it, fail every pending
  // request, and let the next request start a fresh one. Repeated failures back off (up to 30 s).
  #fail(port: Port, error: HelperTransport.TransportError, code: number | null = null) {
    if (this.#port !== port) return
    const ready = this.#ready?.port === port
    this.#port = undefined
    this.#ready = undefined
    if (!this.#closed) this.#failed()
    port.terminate()
    this.#rejectAll(error)
    if (ready && !this.#closed) this.#options.onExit?.(code)
  }

  #failed() {
    this.#failures += 1
    this.#retryAt = this.#failures >= 3 ? this.#now() + Math.min(30_000, 500 * 2 ** (this.#failures - 3)) : 0
  }

  #rejectAll(error: HelperTransport.TransportError) {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(error)
    }
  }
}

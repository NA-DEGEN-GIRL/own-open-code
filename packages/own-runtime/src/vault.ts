export * as Vault from "./vault.js"

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs"
import { Option, Schema } from "effect"

// Wire contract: own/native/own-vault/README.md (protocol 1). Keep this file in step with it.

/** Protocol version this client speaks (`hello.protocol`). */
export const PROTOCOL = 1
/** Vault item id format accepted by the helper. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const DOS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** Maximum `value` size in UTF-8 bytes. */
export const MAX_VALUE_BYTES = 256 * 1024

/** Largest old-app key file `linked.get` reads (README §5.3). */
export const LINKED_MAX_FILE_BYTES = 16 * 1024
/** Name of the old app's root directory in `linked.get` paths (compared ASCII case-insensitively). */
export const LINKED_APP_DIR = "codex-multi-provider"
const LINKED_LOCATIONS: ReadonlyArray<ReadonlyArray<string>> = [["profiles"], ["work", "control-center", "credentials"]]

/** Helper error codes (README §5.4) plus `unavailable` for a helper that cannot be reached. */
export type ErrorCode =
  | "bad_request"
  | "unknown_op"
  | "invalid_id"
  | "path_denied"
  | "not_found"
  | "decrypt_failed"
  | "encrypt_failed"
  | "conflict"
  | "busy"
  | "io_error"
  | "unavailable"

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "bad_request",
  "unknown_op",
  "invalid_id",
  "path_denied",
  "not_found",
  "decrypt_failed",
  "encrypt_failed",
  "conflict",
  "busy",
  "io_error",
  "unavailable",
])

export interface Failure {
  readonly ok: false
  readonly error: ErrorCode
  /** Human-readable; never contains secret values. */
  readonly message?: string
  /** `not_found` / `decrypt_failed`: whether `<id>.dpapi.prev` exists (README §6.4). */
  readonly hasPrev?: boolean
  /** `conflict`: the generation actually stored, `null` when there is no file. */
  readonly generation?: number | null
}

/** A refresh lease `{pid, startedAt, until}` held through the helper (README §5.3 `lease.*`). */
export interface Lease {
  readonly pid: number
  readonly startedAt: number
  readonly until: number
}

const Generation = Schema.NullOr(Schema.Int)
const LeaseSchema = Schema.Struct({ pid: Schema.Int, startedAt: Schema.Finite, until: Schema.Finite })
const FailureSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
  hasPrev: Schema.optionalKey(Schema.Boolean),
  generation: Schema.optionalKey(Generation),
})
const HelloSchema = Schema.Struct({
  ok: Schema.Literal(true),
  name: Schema.String,
  version: Schema.String,
  protocol: Schema.Int,
  pid: Schema.Int,
  vaultDir: Schema.String,
  /** Ops the helper answers (0.2.0+); absent from 0.1.0, which has no `linked.get`. */
  ops: Schema.optionalKey(Schema.Array(Schema.String)),
})
const Responses = {
  hello: HelloSchema,
  get: Schema.Struct({ ok: Schema.Literal(true), value: Schema.String, generation: Generation }),
  put: Schema.Struct({ ok: Schema.Literal(true), generation: Generation }),
  delete: Schema.Struct({ ok: Schema.Literal(true), deleted: Schema.Boolean }),
  list: Schema.Struct({ ok: Schema.Literal(true), ids: Schema.Array(Schema.String) }),
  "lease.acquire": Schema.Struct({
    ok: Schema.Literal(true),
    acquired: Schema.Boolean,
    lease: Schema.NullOr(LeaseSchema),
  }),
  "lease.release": Schema.Struct({ ok: Schema.Literal(true), released: Schema.Boolean }),
  "linked.get": Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.String,
    size: Schema.Int,
    mtimeMs: Schema.Finite,
  }),
}
type Op = keyof typeof Responses
type Success<O extends Op> = (typeof Responses)[O]["Type"]

export type Hello = Success<"hello">
export type Result<O extends Op> = Success<O> | Failure

const decodeFailure = Schema.decodeUnknownOption(FailureSchema)

/**
 * Carries one request object to the helper and resolves with its parsed response object. Rejects only when the
 * helper cannot answer (not running, crashed, timed out); protocol errors arrive as `{ok:false}` responses.
 */
export interface Transport {
  request(message: Readonly<Record<string, unknown>>): Promise<unknown>
  close(): Promise<void>
}

/**
 * Typed vault client (README §5). Every method resolves; failures are values, and a helper that cannot be reached
 * is `{ok:false, error:"unavailable"}` (02 §9.4 `vault_unavailable`). Values are passed through, never logged.
 */
export class Client {
  readonly #transport: Transport
  #status: "unknown" | "ok" | "unavailable" = "unknown"
  #hello: Hello | undefined

  constructor(transport: Transport) {
    this.#transport = transport
  }

  /** `ok` after the last request got an answer, `unavailable` after it could not, `unknown` before any request. */
  status() {
    return this.#status
  }

  /** The last `hello` answer (helper name, version, protocol), without secrets. */
  info() {
    return this.#hello
  }

  async hello(): Promise<Result<"hello">> {
    const result = await this.#call("hello", {})
    if (result.ok) this.#hello = result
    return result
  }

  /** Reads a secret. `prev` reads `<id>.dpapi.prev` for recovery (README §6.4). */
  get(id: string, options: { readonly prev?: boolean } = {}): Promise<Result<"get">> {
    return this.#withId(id, () => this.#call("get", { id, ...(options.prev ? { prev: true } : {}) }))
  }

  /**
   * Writes a secret atomically; `ok` means it is on disk (persist-before-use, 02 §3.5 F4). `ifGeneration` makes it
   * a compare-and-swap on the stored `generation`; `keepPrev` keeps the replaced value as `.prev`.
   */
  put(
    id: string,
    value: string,
    options: { readonly keepPrev?: boolean; readonly ifGeneration?: number } = {},
  ): Promise<Result<"put">> {
    return this.#withId(id, () =>
      this.#call("put", {
        id,
        value,
        ...(options.keepPrev ? { keepPrev: true } : {}),
        ...(options.ifGeneration === undefined ? {} : { ifGeneration: options.ifGeneration }),
      }),
    )
  }

  /** Deletes the secret and its `.prev`; `shred` overwrites them first (02 §3.5 F7). Idempotent. */
  delete(id: string, options: { readonly shred?: boolean } = {}): Promise<Result<"delete">> {
    return this.#withId(id, () => this.#call("delete", { id, ...(options.shred ? { shred: true } : {}) }))
  }

  /** Account ids that have a secret, sorted. */
  list(): Promise<Result<"list">> {
    return this.#call("list", {})
  }

  /**
   * Decrypts an API key file saved by the older codex-multi-provider app, read-only (README §5.3 `linked.get`,
   * 02 §3.2b). Paths outside the helper's allowlist are refused here already (`path_denied`), without a request.
   * The value is the key itself: callers keep it in memory only and never log it.
   */
  linkedGet(path: string): Promise<Result<"linked.get">> {
    const problem = linkedPathProblem(path)
    if (problem) return Promise.resolve({ ok: false, error: "path_denied", message: problem })
    return this.#call("linked.get", { path })
  }

  /** Tries to take the refresh lease of `id` for process `pid` (02 §3.5 F3). `acquired:false` is not an error. */
  acquireLease(id: string, input: { readonly pid: number; readonly ttlMs?: number }): Promise<Result<"lease.acquire">> {
    return this.#withId(id, () =>
      this.#call("lease.acquire", {
        id,
        pid: input.pid,
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      }),
    )
  }

  /** Releases a lease only if it is still held by the same `pid` and `startedAt`. */
  releaseLease(
    id: string,
    lease: { readonly pid: number; readonly startedAt: number },
  ): Promise<Result<"lease.release">> {
    return this.#withId(id, () => this.#call("lease.release", { id, pid: lease.pid, startedAt: lease.startedAt }))
  }

  close() {
    return this.#transport.close()
  }

  #withId<T>(id: string, call: () => Promise<T>): Promise<T | Failure> {
    if (!validId(id)) return Promise.resolve({ ok: false, error: "invalid_id", message: "invalid vault id" })
    return call()
  }

  async #call<O extends Op>(op: O, fields: Record<string, unknown>): Promise<Result<O>> {
    const answer = await this.#transport.request({ op, ...fields }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    if ("error" in answer) {
      this.#status = "unavailable"
      return { ok: false, error: "unavailable", message: describe(answer.error) }
    }
    this.#status = "ok"
    const success: Option.Option<Success<O>> = Schema.decodeUnknownOption(Responses[op])(answer.value)
    if (Option.isSome(success)) return success.value
    const failure = Option.getOrUndefined(decodeFailure(answer.value))
    if (!failure) return { ok: false, error: "unavailable", message: `malformed ${op} response from the vault helper` }
    return { ...failure, error: isErrorCode(failure.error) ? failure.error : "io_error" }
  }
}

function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.has(value)
}

export function validId(id: string) {
  return ID_PATTERN.test(id) && !DOS_DEVICE.test(id)
}

/**
 * Why own-vault would refuse `path` for `linked.get` (README §5.3 allowlist), or `undefined` when it is one of the old
 * app's key locations: a drive-absolute path ending in `codex-multi-provider\profiles\<name>.dpapi` or
 * `codex-multi-provider\work\control-center\credentials\<name>.dpapi` (ASCII case-insensitive, `\` or `/`), with no
 * empty, `.`, `..` or trailing-dot/space components and no reserved characters. Mirrors `linked.rs` `check_path`;
 * the helper stays authoritative and also refuses reparse points and files over 16 KiB.
 */
export function linkedPathProblem(path: string) {
  if (!path || [...path].length > 1024) return "path is empty or too long"
  if (path.length < 4 || !/^[A-Za-z]:[\\/]/.test(path)) return "path is not a drive-absolute path"
  const components = path.slice(3).split(/[\\/]/)
  const problem = components.map(componentProblem).find((item) => item !== undefined)
  if (problem) return problem
  const file = components.at(-1) ?? ""
  const dirs = components.slice(0, -1)
  if (!asciiLower(file).endsWith(".dpapi")) return "not a .dpapi file"
  if (!validId(file.slice(0, -".dpapi".length))) return "file name is not a plain key name"
  const located = LINKED_LOCATIONS.some(
    (chain) =>
      dirs.length > chain.length &&
      chain.every((name, index) => asciiLower(dirs[dirs.length - chain.length + index] ?? "") === name) &&
      asciiLower(dirs[dirs.length - chain.length - 1] ?? "") === LINKED_APP_DIR,
  )
  return located ? undefined : "not a codex-multi-provider key location"
}

function componentProblem(component: string) {
  if (!component) return "path has an empty component"
  if (component === "." || component === "..") return "path is not normalized"
  if (component.endsWith(".") || component.endsWith(" ")) return "path component ends with a dot or space"
  if ([...component].length > 255) return "path component is too long"
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (/[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(component)) return "path component has a reserved character"
  return undefined
}

// Only ASCII letters fold, like Rust's `eq_ignore_ascii_case` (`"K".toLowerCase()` would be a Latin "k").
function asciiLower(text: string) {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

// ---------------------------------------------------------------------------------------------------------------
// Child-process transport (README §7)

export interface SpawnOptions {
  /** `app\current\own-vault.exe`, or `own/native/own-vault/target/release/own-vault.exe` in development. */
  readonly exePath: string
  /** `OWN_HOME`; the helper stores secrets in `<home>\vault`. */
  readonly home: string
  /** Replaces `[exePath, "--home", home]`, e.g. to run a fake helper in tests. */
  readonly command?: ReadonlyArray<string>
  /** Environment of the helper. Default: only `SystemRoot` (README §2, 01 §13 "최소 env"). */
  readonly env?: Readonly<Record<string, string>>
  /** Per-request timeout; on expiry the helper is killed and restarted by the next request. Default 15 s. */
  readonly timeoutMs?: number
  /** How long `close` waits for the helper to exit after stdin EOF before killing it. Default 1 s. */
  readonly closeTimeoutMs?: number
  readonly now?: () => number
}

/** Starts the helper lazily on the first request and restarts it after a crash or timeout. */
export function spawnHelper(options: SpawnOptions): Transport {
  return new ProcessTransport(options)
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeRid = Schema.decodeUnknownOption(Schema.Struct({ rid: Schema.Int }))
const decodeHello = Schema.decodeUnknownOption(HelloSchema)

class ProcessTransport implements Transport {
  readonly #options: SpawnOptions
  readonly #now: () => number
  #child: ChildProcessWithoutNullStreams | undefined
  #starting: Promise<ChildProcessWithoutNullStreams> | undefined
  // Insertion-ordered: a response without `rid` (an overlong request line) belongs to the oldest request.
  readonly #pending = new Map<number, Pending>()
  #rid = 0
  #buffer = ""
  #failures = 0
  #retryAt = 0
  #closed = false

  constructor(options: SpawnOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  async request(message: Readonly<Record<string, unknown>>) {
    if (this.#closed) throw new Error("vault helper closed")
    return this.#send(await this.#ensure(), message)
  }

  async close() {
    this.#closed = true
    const child = this.#child ?? (await this.#starting?.catch(() => undefined))
    if (!child) return
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once("exit", () => resolve())
    })
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), this.#options.closeTimeoutMs ?? 1_000)
    await exited
    clearTimeout(timer)
    this.#fail(child, new Error("vault helper closed"))
  }

  #ensure() {
    if (this.#child && !this.#starting) return Promise.resolve(this.#child)
    if (this.#starting) return this.#starting
    if (this.#now() < this.#retryAt) return Promise.reject(new Error("vault helper unavailable (restart backoff)"))
    const starting = this.#start().finally(() => {
      if (this.#starting === starting) this.#starting = undefined
    })
    this.#starting = starting
    return starting
  }

  async #start() {
    const command = this.#options.command ?? [this.#options.exePath, "--home", this.#options.home]
    const env = this.#options.env ?? (process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
    const child = spawn(command[0] ?? this.#options.exePath, command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    })
    this.#child = child
    this.#buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.#receive(child, chunk))
    // stderr is only written on startup failures; it is drained so the pipe never fills, and never logged.
    child.stderr.resume()
    // Writes after the helper died fail with EPIPE; the exit handler already failed the pending requests.
    child.stdin.on("error", () => undefined)
    child.on("error", (error) => this.#fail(child, error))
    child.on("exit", (exitCode, signal) =>
      this.#fail(child, new Error(`vault helper exited (${exitCode ?? signal ?? "unknown"})`)),
    )
    const hello = Option.getOrUndefined(decodeHello(await this.#send(child, { op: "hello" })))
    if (hello?.protocol !== PROTOCOL) {
      const error = new Error(`vault helper protocol ${hello?.protocol ?? "unknown"} is not ${PROTOCOL}`)
      this.#fail(child, error)
      throw error
    }
    this.#failures = 0
    this.#retryAt = 0
    return child
  }

  #send(child: ChildProcessWithoutNullStreams, message: Readonly<Record<string, unknown>>) {
    const rid = ++this.#rid
    return new Promise<unknown>((resolve, reject) => {
      if (this.#child !== child) return reject(new Error("vault helper is not running"))
      const timeoutMs = this.#options.timeoutMs ?? 15_000
      const timer = setTimeout(
        () => this.#fail(child, new Error(`vault helper did not answer within ${timeoutMs} ms`)),
        timeoutMs,
      )
      this.#pending.set(rid, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ ...message, rid })}\n`)
    })
  }

  #receive(child: ChildProcessWithoutNullStreams, chunk: string) {
    if (this.#child !== child) return
    const lines = (this.#buffer + chunk).split("\n")
    this.#buffer = lines.pop() ?? ""
    for (const line of lines) {
      const value = Option.getOrUndefined(decodeLine(line.trim()))
      if (value === undefined) continue
      const rid = Option.getOrUndefined(decodeRid(value))?.rid ?? this.#pending.keys().next().value
      const pending = rid === undefined ? undefined : this.#pending.get(rid)
      if (!pending || rid === undefined) continue
      this.#pending.delete(rid)
      clearTimeout(pending.timer)
      pending.resolve(value)
    }
  }

  // Once anything goes wrong with a helper, none of its later answers are trusted: kill it, fail every pending
  // request, and let the next request start a fresh one. Repeated failures back off (up to 30 s).
  #fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.#child !== child) return
    this.#child = undefined
    this.#buffer = ""
    if (!this.#closed) {
      this.#failures += 1
      this.#retryAt = this.#failures >= 3 ? this.#now() + Math.min(30_000, 500 * 2 ** (this.#failures - 3)) : 0
    }
    if (child.exitCode === null && child.signalCode === null) child.kill()
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(error)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// In-memory fake helper for tests

export interface MemoryOptions {
  readonly now?: () => number
  /** Liveness of lease owners; default: every pid is alive. */
  readonly isAlive?: (pid: number) => boolean
}

/**
 * In-memory implementation of the helper's wire protocol (README §5), no encryption. It answers the same JSON the
 * real helper does, so the client decoding path is exercised too. {@link Memory.handle} is synchronous so a fake
 * helper process can reuse it.
 */
export class Memory implements Transport {
  readonly #items = new Map<string, { value: string; prev?: string }>()
  readonly #leases = new Map<string, Lease>()
  readonly #now: () => number
  readonly #isAlive: (pid: number) => boolean
  readonly #faults: Array<(request: Readonly<Record<string, unknown>>) => Record<string, unknown> | undefined> = []
  #closed = false
  /** Requests answered, by op. */
  readonly calls = new Map<string, number>()

  constructor(options: MemoryOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#isAlive = options.isAlive ?? (() => true)
  }

  request(message: Readonly<Record<string, unknown>>) {
    if (this.#closed) return Promise.reject(new Error("vault helper closed"))
    return Promise.resolve().then(() => this.handle(message))
  }

  close() {
    this.#closed = true
    return Promise.resolve()
  }

  /** Answers the next request for which `fault` returns a response, instead of handling it. */
  inject(fault: (request: Readonly<Record<string, unknown>>) => Record<string, unknown> | undefined) {
    this.#faults.push(fault)
  }

  /** Ids with a current value, ids with a `.prev`, and leases, for assertions. */
  snapshot() {
    return {
      ids: [...this.#items.keys()].sort(),
      prev: [...this.#items].flatMap((entry) => (entry[1].prev === undefined ? [] : [entry[0]])).sort(),
      leases: Object.fromEntries(this.#leases),
    }
  }

  /** Stores a raw value, bypassing the protocol (e.g. to plant corrupt content). */
  plant(id: string, value: string) {
    this.#items.set(id, { value, prev: this.#items.get(id)?.prev })
  }

  handle(request: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const rid = "rid" in request ? { rid: request.rid } : {}
    const op = typeof request.op === "string" ? request.op : ""
    this.calls.set(op, (this.calls.get(op) ?? 0) + 1)
    for (const [index, fault] of this.#faults.entries()) {
      const response = fault(request)
      if (response === undefined) continue
      this.#faults.splice(index, 1)
      return { ...response, ...rid }
    }
    return { ...this.#dispatch(op, request), ...rid }
  }

  #dispatch(op: string, request: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (op === "hello")
      return {
        ok: true,
        name: "own-vault-memory",
        version: "0.0.0",
        protocol: PROTOCOL,
        pid: process.pid,
        vaultDir: "memory",
        ops: ["hello", "get", "put", "delete", "list", "lease.acquire", "lease.release", "linked.get"],
      }
    if (op === "list") return { ok: true, ids: [...this.#items.keys()].sort() }
    if (op === "linked.get") return linkedFromDisk(request.path)
    if (!["get", "put", "delete", "lease.acquire", "lease.release"].includes(op))
      return { ok: false, error: "unknown_op", message: `unknown op ${op}` }
    const id = request.id
    if (typeof id !== "string") return { ok: false, error: "bad_request", message: "missing id" }
    if (!validId(id)) return { ok: false, error: "invalid_id", message: "invalid id" }
    const item = this.#items.get(id)
    if (op === "get") {
      const value = request.prev === true ? item?.prev : item?.value
      if (value === undefined) return { ok: false, error: "not_found", hasPrev: item?.prev !== undefined }
      return { ok: true, value, generation: generationOf(value) }
    }
    if (op === "put") return this.#put(id, item, request)
    if (op === "delete") {
      this.#items.delete(id)
      const lease = this.#leases.get(id)
      if (lease && this.#stale(lease)) this.#leases.delete(id)
      return { ok: true, deleted: item !== undefined }
    }
    if (op === "lease.acquire") return this.#acquire(id, request)
    const lease = this.#leases.get(id)
    const released = lease !== undefined && lease.pid === request.pid && lease.startedAt === request.startedAt
    if (released) this.#leases.delete(id)
    return { ok: true, released }
  }

  #put(id: string, item: { value: string; prev?: string } | undefined, request: Readonly<Record<string, unknown>>) {
    const value = request.value
    if (typeof value !== "string") return { ok: false, error: "bad_request", message: "missing value" }
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES)
      return { ok: false, error: "bad_request", message: "value too large" }
    const expected = request.ifGeneration
    if (typeof expected === "number") {
      const actual = item === undefined ? null : generationOf(item.value)
      if (actual !== expected) return { ok: false, error: "conflict", generation: actual }
    }
    const prev = request.keepPrev === true && item ? item.value : item?.prev
    this.#items.set(id, { value, prev })
    return { ok: true, generation: generationOf(value) }
  }

  #acquire(id: string, request: Readonly<Record<string, unknown>>) {
    const pid = request.pid
    const ttlMs = request.ttlMs ?? 60_000
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
      return { ok: false, error: "bad_request", message: "pid is required" }
    if (typeof ttlMs !== "number" || ttlMs < 1_000 || ttlMs > 600_000)
      return { ok: false, error: "bad_request", message: "ttlMs out of range" }
    const held = this.#leases.get(id)
    if (held && !this.#stale(held)) return { ok: true, acquired: false, lease: held }
    const startedAt = this.#now()
    const lease = { pid, startedAt, until: startedAt + ttlMs }
    this.#leases.set(id, lease)
    return { ok: true, acquired: true, lease }
  }

  #stale(lease: Lease) {
    return this.#now() >= lease.until || lease.until - lease.startedAt > 600_000 || !this.#isAlive(lease.pid)
  }
}

export function memory(options?: MemoryOptions) {
  return new Memory(options)
}

const FAKE_SEAL = "own-vault-fake-seal/v1:"

/**
 * Test-only stand-in for an old-app DPAPI key file, understood by the {@link Memory} helper's `linked.get` (and by
 * nothing else: the real helper answers `decrypt_failed`). Lets tests with the memory vault put fake keys on disk at
 * the allowlisted paths and change them. The value is base64-encoded so it never sits in the file as plain text.
 */
export function fakeSeal(value: string) {
  return new TextEncoder().encode(FAKE_SEAL + Buffer.from(value, "utf8").toString("base64"))
}

/** The Memory helper's `linked.get`: README §5.3 on the real file, with {@link fakeSeal} instead of DPAPI. */
function linkedFromDisk(path: unknown): Record<string, unknown> {
  if (typeof path !== "string") return { ok: false, error: "bad_request", message: "missing field `path`" }
  const problem = linkedPathProblem(path)
  if (problem) return { ok: false, error: "path_denied", message: problem }
  const stat = (() => {
    try {
      return fs.lstatSync(path)
    } catch {
      return undefined
    }
  })()
  if (!stat) return { ok: false, error: "not_found" }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: "path_denied", message: "not a regular file" }
  if (stat.size > LINKED_MAX_FILE_BYTES)
    return { ok: false, error: "path_denied", message: "the key file is too large" }
  const text = (() => {
    try {
      return fs.readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  })()
  if (text === undefined) return { ok: false, error: "not_found" }
  if (!text.startsWith(FAKE_SEAL)) return { ok: false, error: "decrypt_failed" }
  return {
    ok: true,
    value: Buffer.from(text.slice(FAKE_SEAL.length), "base64").toString("utf8"),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  }
}

const decodeGeneration = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ generation: Schema.Int })))

/** The top-level integer `generation` of a JSON object value, as the helper reports it; otherwise `null`. */
export function generationOf(value: string) {
  return Option.getOrUndefined(decodeGeneration(value))?.generation ?? null
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : "vault helper unavailable"
}

export * as Lock from "./lock.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { code, remove, sleep } from "./fsx.js"

/** Runs async sections one at a time, in call order (02 §2.3 "프로세스 안에서는 뮤텍스"). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(section)
    this.#tail = result.catch(() => undefined)
    return result
  }
}

/** Content of a lease file `{pid, startedAt, until}` (02 §3.5 F3), plus a random token naming this holder. */
export interface Lease {
  readonly pid: number
  readonly startedAt: number
  readonly until: number
  readonly token: string
}

const LeaseFile = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    startedAt: Schema.Finite,
    until: Schema.Finite,
    token: Schema.optionalKey(Schema.String),
  }),
)
const decodeLease = Schema.decodeUnknownOption(LeaseFile)

/** A lease longer than this is treated as corrupt and therefore stale (same bound as own-vault leases). */
export const MAX_TTL_MS = 600_000

export interface FileOptions {
  /** Lease length; a holder that outlives it can be broken. Default 60 s (02 §3.5 F3). */
  readonly ttlMs?: number
  /** How long to wait for a live holder before giving up. Default 10 s. */
  readonly timeoutMs?: number
  readonly pid?: number
  readonly now?: () => number
  readonly isAlive?: (pid: number) => boolean
}

export class TimeoutError extends Error {
  constructor(
    readonly file: string,
    readonly holder: { readonly pid: number; readonly until: number } | undefined,
  ) {
    super(`Timed out waiting for lock ${path.basename(file)}${holder ? ` held by pid ${holder.pid}` : ""}`)
    this.name = "Lock.TimeoutError"
  }
}

/** Runs `section` while holding the lease file `file` (e.g. `locks\registry.lock`). */
export async function withFile<T>(file: string, section: () => Promise<T>, options: FileOptions = {}) {
  const lease = await acquire(file, options)
  return section().finally(() => release(file, lease))
}

/**
 * Takes a cross-process lease file (02 §2.3, §3.5 F3): creates it exclusively (`open(path,"wx")`) with
 * `{pid, startedAt, until, token}`. A holder is stale when `until` has passed, its pid is gone, the lease is longer
 * than {@link MAX_TTL_MS}, or (for unreadable content) the file is older than the TTL. Only the process that creates
 * `<file>.breaker` removes a stale lease, so two contenders cannot both break it and then delete each other's fresh
 * lease. Waits with backoff up to `timeoutMs`, then throws {@link TimeoutError}.
 */
export async function acquire(file: string, options: FileOptions = {}): Promise<Lease> {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 60_000
  // Waiting is real time; `now` only stamps and judges leases.
  const deadline = performance.now() + (options.timeoutMs ?? 10_000)
  const check = { now, ttlMs, isAlive: options.isAlive ?? isAlive }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const attempt = async (delay: number): Promise<Lease> => {
    const startedAt = now()
    const lease = { pid: options.pid ?? process.pid, startedAt, until: startedAt + ttlMs, token: token() }
    if (await create(file, lease)) return lease
    const holder = await inspect(file)
    if (!holder) return attempt(delay)
    if (stale(holder, check)) {
      await breakStale(file, holder, check)
      return attempt(delay)
    }
    if (performance.now() >= deadline) throw new TimeoutError(file, holder.lease)
    await sleep(delay)
    return attempt(Math.min(delay * 2, 500))
  }
  return attempt(10)
}

/** Removes the lease if it is still ours. Returns whether it was. */
export async function release(file: string, lease: Lease) {
  const holder = await inspect(file)
  if (holder?.lease?.token !== lease.token) return false
  await remove(file)
  return true
}

/** Whether a process id is running. `EPERM` means it exists but belongs to someone we may not signal. */
export function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return code(error) === "EPERM"
  }
}

interface Holder {
  readonly lease: Lease | undefined
  readonly mtimeMs: number
}

interface StaleCheck {
  readonly now: () => number
  readonly ttlMs: number
  readonly isAlive: (pid: number) => boolean
}

async function create(file: string, lease: Lease, retried = false): Promise<boolean> {
  const handle = await fs.open(file, "wx", 0o600).catch(async (error: unknown) => {
    if (code(error) === "EEXIST") return undefined
    // Windows refuses the create with EPERM while a removed lease is still delete-pending because another
    // process has it open. A file stat still sees is the same contention; a missing one is retried once.
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(code(error) ?? "")) throw error
    if (await fs.stat(file).catch(() => undefined)) return undefined
    if (retried) throw error
    return "retry" as const
  })
  if (handle === "retry") return create(file, lease, true)
  if (!handle) return false
  await handle
    .writeFile(JSON.stringify(lease))
    .then(() => handle.sync())
    .finally(() => handle.close())
  return true
}

async function inspect(file: string): Promise<Holder | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat) return undefined
  const text = await fs.readFile(file, "utf8").catch(() => "")
  const decoded = Option.getOrUndefined(decodeLease(text))
  return {
    lease: decoded && {
      pid: decoded.pid,
      startedAt: decoded.startedAt,
      until: decoded.until,
      token: decoded.token ?? "",
    },
    mtimeMs: stat.mtimeMs,
  }
}

function stale(holder: Holder, check: StaleCheck) {
  const now = check.now()
  if (!holder.lease) return now - holder.mtimeMs > check.ttlMs
  return (
    now >= holder.lease.until ||
    holder.lease.until - holder.lease.startedAt > MAX_TTL_MS ||
    !check.isAlive(holder.lease.pid)
  )
}

async function breakStale(file: string, holder: Holder, check: StaleCheck) {
  const breaker = `${file}.breaker`
  const claimed = await create(breaker, {
    pid: process.pid,
    startedAt: check.now(),
    until: check.now(),
    token: token(),
  })
  if (!claimed) {
    // A breaker left by a crashed contender would block every later break.
    const stat = await fs.stat(breaker).catch(() => undefined)
    if (stat && check.now() - stat.mtimeMs > check.ttlMs) await remove(breaker)
    await sleep(10)
    return
  }
  const current = await inspect(file)
  const same =
    current &&
    (current.lease && holder.lease
      ? current.lease.token === holder.lease.token && current.lease.startedAt === holder.lease.startedAt
      : current.mtimeMs === holder.mtimeMs)
  await (same ? remove(file) : Promise.resolve()).finally(() => remove(breaker))
}

function token() {
  return randomBytes(8).toString("hex")
}

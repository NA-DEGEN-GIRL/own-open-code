export * as Fsx from "./fsx.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

/** Node file-system error code (`ENOENT`, `EEXIST`, …) of an unknown thrown value. */
export function code(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Windows refuses to replace or delete a file while any handle to it is open (readers, indexers, antivirus).
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"])
// A folder stays non-empty while Windows finishes deleting a file another handle still holds.
const TREE_RETRYABLE = new Set([...RETRYABLE, "ENOTEMPTY"])
const RETRY_DEADLINE_MS = 2_000

/**
 * Atomically replaces `file` (02 §2.3 "temp 파일에 쓰고 fsync한 뒤 rename"): writes a uniquely named temp file next to
 * it, fsyncs, and renames it over the target, so readers only ever see the old or the new content. The rename is
 * retried for up to 2 s on Windows sharing errors. On POSIX the directory entry is fsynced too; Windows does not
 * allow opening a directory for that.
 */
export async function writeAtomic(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  const handle = await fs.open(temp, "wx", 0o600)
  await handle
    .writeFile(data)
    .then(() => handle.sync())
    .finally(() => handle.close())
  await retrying(() => fs.rename(temp, file)).catch(async (error: unknown) => {
    await fs.rm(temp, { force: true })
    throw error
  })
  if (process.platform !== "win32") await syncDirectory(path.dirname(file))
}

/** Renames `from` over `to`, retrying Windows sharing errors for up to 2 s (as {@link writeAtomic} does). */
export function rename(from: string, to: string) {
  return retrying(() => fs.rename(from, to))
}

/** Writes `file` and fsyncs it before closing (a staged file that is renamed into place later). */
export async function writeSynced(file: string, data: string | Uint8Array) {
  const handle = await fs.open(file, "w")
  await handle
    .writeFile(data)
    .then(() => handle.sync())
    .finally(() => handle.close())
}

/** Removes a file, retrying Windows sharing errors. Missing files are fine. */
export function remove(file: string) {
  return retrying(() => fs.rm(file, { force: true }))
}

/**
 * Removes a folder and everything in it, retrying Windows sharing errors for up to 2 s (an indexer, antivirus or a
 * just-ended process holding a file). Bun accepts `fs.rm`'s `maxRetries` but does not retry. A missing folder is fine.
 */
export function removeTree(dir: string) {
  return retrying(() => fs.rm(dir, { recursive: true, force: true }), TREE_RETRYABLE)
}

/** UTF-8 text of a file without a leading BOM, or `undefined` when it does not exist. */
export async function readText(file: string) {
  return fs.readFile(file, "utf8").then(stripBom, (error: unknown) => {
    if (code(error) === "ENOENT") return undefined
    throw error
  })
}

export type Bounded =
  | { readonly type: "ok"; readonly text: string; readonly mtimeMs: number; readonly size: number }
  | { readonly type: "missing" }
  | { readonly type: "too_large"; readonly size: number }
  | { readonly type: "error"; readonly code: string }

/**
 * Reads a file of at most `maxBytes` read-only, with the stat taken from the same open handle so it describes the
 * bytes returned. The handle is held only for the read: on Windows an open handle blocks another process's
 * rename-over-this-file, so readers of files owned by others must stay brief.
 */
export async function readBounded(file: string, maxBytes: number): Promise<Bounded> {
  const handle = await fs.open(file, "r").catch((error: unknown) => failure(error))
  if ("type" in handle) return handle
  return (async (): Promise<Bounded> => {
    const stat = await handle.stat()
    if (stat.size > maxBytes) return { type: "too_large", size: stat.size }
    const text = stripBom(await handle.readFile("utf8"))
    return { type: "ok", text, mtimeMs: stat.mtimeMs, size: stat.size }
  })()
    .catch((error: unknown) => failure(error))
    .finally(() => handle.close())
}

export function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function retrying<T>(
  operation: () => Promise<T>,
  retryable: ReadonlySet<string> = RETRYABLE,
  started = Date.now(),
  delay = 20,
): Promise<T> {
  return operation().catch(async (error: unknown) => {
    if (!retryable.has(code(error) ?? "") || Date.now() - started > RETRY_DEADLINE_MS) throw error
    await sleep(delay)
    return retrying(operation, retryable, started, Math.min(delay * 2, 250))
  })
}

async function syncDirectory(dir: string) {
  const handle = await fs.open(dir, "r").catch(() => undefined)
  if (!handle) return
  await handle
    .sync()
    .catch(() => undefined)
    .finally(() => handle.close())
}

function failure(error: unknown): Bounded {
  const errorCode = code(error)
  if (errorCode === "ENOENT" || errorCode === "ENOTDIR") return { type: "missing" }
  return { type: "error", code: errorCode ?? "EIO" }
}

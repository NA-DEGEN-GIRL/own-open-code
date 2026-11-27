// Filesystem access and Rust `io::Error` display texts for the apply_patch port: codex-rs/exec-server
// local_file_system.rs (`read_file_text`, `get_metadata`), regular_file.rs (`open_sync`), and codex-rs/file-system
// `read_file_text` (UTF-8 decoding).
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as PatchIo from "./io.js"

import { isUtf8 } from "node:buffer"
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"

/** The filesystem operations apply_patch needs; `node:fs/promises` satisfies it. Errors carry Node's `code`. */
export interface PatchFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  /** Follows symlinks, like Codex's `get_metadata` with `follow_symlinks`. */
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
  unlink(path: string): Promise<void>
}

export const nodeFs: PatchFs = { readFile, writeFile, mkdir, stat, unlink }

/** An `io::Error` that does not come from the OS (`io::Error::new(kind, message)`); its display is the message. */
export class RustIoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RustIoError"
  }
}

/**
 * Codex's `read_file_text`: a non-regular file is refused (`path `…` is not a file`) and the bytes must be UTF-8,
 * kept with any byte order mark.
 */
export async function readText(fs: PatchFs, path: string) {
  const metadata = await fs.stat(path)
  if (!metadata.isFile()) throw new RustIoError(`path \`${path}\` is not a file`)
  const bytes = await fs.readFile(path)
  if (!isUtf8(bytes)) throw new RustIoError(utf8ErrorMessage(bytes))
  return DECODER.decode(bytes)
}

const DECODER = new TextDecoder("utf-8", { ignoreBOM: true })

export function isNotFound(error: unknown) {
  return errorCode(error) === "ENOENT"
}

/**
 * The display text Rust gives the I/O error. OS errors read `<strerror> (os error <errno>)` with the Linux errno and
 * glibc message on every OS, as Codex prints them on Unix (Windows would print its own `FormatMessageW` text and
 * code). Codes outside the table fall back to Node's message.
 */
export function describeIoError(error: unknown) {
  if (error instanceof RustIoError) return error.message
  const code = errorCode(error)
  const known = code === undefined ? undefined : OS_ERRORS[code]
  if (known !== undefined) return `${known[1]} (os error ${known[0]})`
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string")
    return undefined
  return error.code
}

/** Node error code → [Linux errno, glibc `strerror` text]. */
const OS_ERRORS: Record<string, readonly [number, string]> = {
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  EIO: [5, "Input/output error"],
  ENXIO: [6, "No such device or address"],
  EBADF: [9, "Bad file descriptor"],
  EAGAIN: [11, "Resource temporarily unavailable"],
  ENOMEM: [12, "Cannot allocate memory"],
  EACCES: [13, "Permission denied"],
  EBUSY: [16, "Device or resource busy"],
  EEXIST: [17, "File exists"],
  EXDEV: [18, "Invalid cross-device link"],
  ENODEV: [19, "No such device"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  EINVAL: [22, "Invalid argument"],
  ENFILE: [23, "Too many open files in system"],
  EMFILE: [24, "Too many open files"],
  ETXTBSY: [26, "Text file busy"],
  EFBIG: [27, "File too large"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
  EMLINK: [31, "Too many links"],
  ENAMETOOLONG: [36, "File name too long"],
  ENOTEMPTY: [39, "Directory not empty"],
  ELOOP: [40, "Too many levels of symbolic links"],
  ENOTSUP: [95, "Operation not supported"],
  EDQUOT: [122, "Disk quota exceeded"],
}

/**
 * Rust's `Utf8Error` display for invalid bytes (`invalid utf-8 sequence of N bytes from index I`, or
 * `incomplete utf-8 byte sequence from index I` at a truncated end), mirroring `core::str::run_utf8_validation`.
 */
export function utf8ErrorMessage(bytes: Uint8Array) {
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index]!
    const width = utf8Width(first)
    if (width === 0) return invalidSequence(index, 1)
    // A missing later byte makes the sequence incomplete; a wrong one ends an invalid sequence of the bytes before it.
    for (let offset = 1; offset < width; offset++) {
      const byte = bytes[index + offset]
      if (byte === undefined) return `incomplete utf-8 byte sequence from index ${index}`
      const valid = offset === 1 ? secondByteValid(first, byte) : continuation(byte)
      if (!valid) return invalidSequence(index, offset)
    }
    index += width
  }
  return `incomplete utf-8 byte sequence from index ${bytes.length}`
}

function utf8Width(first: number) {
  if (first < 0x80) return 1
  if (first >= 0xc2 && first <= 0xdf) return 2
  if (first >= 0xe0 && first <= 0xef) return 3
  if (first >= 0xf0 && first <= 0xf4) return 4
  return 0
}

function invalidSequence(start: number, length: number) {
  return `invalid utf-8 sequence of ${length} bytes from index ${start}`
}

function continuation(byte: number) {
  return byte >= 0x80 && byte <= 0xbf
}

function secondByteValid(first: number, second: number) {
  if (first === 0xe0) return second >= 0xa0 && second <= 0xbf
  if (first === 0xed) return second >= 0x80 && second <= 0x9f
  if (first === 0xf0) return second >= 0x90 && second <= 0xbf
  if (first === 0xf4) return second >= 0x80 && second <= 0x8f
  return continuation(second)
}

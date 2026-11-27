export * as LogFile from "./log-file.js"

import fs from "node:fs"
import path from "node:path"

/**
 * Plugin log files under `OWN_HOME\logs` (02 §7.2, RH-20): the background service's stderr is a pipe nobody reads once
 * it runs (a detached service's parent closes it: `EPIPE`), so own's plugins also append their lines to a file there
 * (`own-accounts.log`, `own-team.log`). One append stream per file in this process, shared by every plugin instance
 * and child logger that writes it, so a hook that logs never waits on the disk.
 */

/** A log file past this size moves to `<file>.1` (replacing the older one) before the next line. */
export const MAX_BYTES = 10 * 1024 * 1024
/**
 * While a full file cannot be moved (another process holds it without delete sharing), lines still go to it up to this
 * size and are dropped after, so the file never grows without bound. The move is tried again every
 * {@link ROTATE_RETRY_MS}.
 */
export const CAP_BYTES = 2 * MAX_BYTES
export const ROTATE_RETRY_MS = 60_000

/**
 * Plugin modules are imported again per Location (and per plugin bundle), so the streams live on `globalThis`: one per
 * file in the process, whichever copy of this module asks.
 */
function streams() {
  const key = Symbol.for("own-open-code.log-files")
  // This file owns the key; the value is always the map made here.
  const holder = globalThis as unknown as Record<symbol, Map<string, (line: string) => void> | undefined>
  const known = holder[key]
  if (known) return known
  const created = new Map<string, (line: string) => void>()
  holder[key] = created
  return created
}

/**
 * The sink that appends lines to `file`. Past {@link MAX_BYTES} the file moves to `<file>.1` and a new one starts; a
 * file that cannot be moved stops at {@link CAP_BYTES}. Sizes count from the file's size when it was opened plus this
 * process's lines. A file that cannot be opened or written loses its lines only.
 */
export function sink(file: string): (line: string) => void {
  const files = streams()
  const known = files.get(file)
  if (known) return known
  const state = { stream: open(file), size: size(file), retryAt: 0 }
  const write = (line: string) => {
    if (state.size > MAX_BYTES && Date.now() >= state.retryAt) {
      state.retryAt = Date.now() + ROTATE_RETRY_MS
      if (rotate(file)) {
        state.stream.end()
        state.stream = open(file)
        state.size = 0
      }
    }
    if (state.size > CAP_BYTES) return
    state.stream.write(line + "\n")
    state.size += Buffer.byteLength(line) + 1
  }
  files.set(file, write)
  return write
}

function size(file: string) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function open(file: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    // The stream's own open fails then too, and its error listener drops the lines.
  }
  const stream = fs.createWriteStream(file, { flags: "a" })
  stream.on("error", () => {})
  return stream
}

/** Moves the file to `<file>.1`; the open stream follows it there and is ended by the caller. */
function rotate(file: string) {
  try {
    fs.renameSync(file, `${file}.1`)
    return true
  } catch {
    return false
  }
}

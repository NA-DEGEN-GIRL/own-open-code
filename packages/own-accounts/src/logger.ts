export * as Logger from "./logger.js"

import { LogFile, Redact } from "@own/runtime"
import type { Options } from "./options.js"

const RANK: Readonly<Record<Options.LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

export type Fields = Readonly<Record<string, unknown>>

/**
 * Structured logger. Messages and fields always pass through `Redact` (01 §13.2, 02 §9.1 "로그는 가림 처리"), so a
 * token that slips into a field is replaced by `[redacted:<hash8>]`. Still, never pass secrets on purpose: log
 * hashes (`Hash.short`) and ids instead.
 */
export interface Logger {
  debug(message: string, fields?: Fields): void
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string, fields?: Fields): void
  /** A logger whose lines carry `scope` (e.g. the module name). */
  child(scope: string): Logger
}

export interface Input {
  readonly level?: Options.LogLevel
  readonly scope: string
  /** Receives one JSON line per entry. Default: stderr, which the server captures (`OPENCODE_PRINT_LOGS=1`). */
  readonly sink?: (line: string) => void
  /**
   * Also appends every line to this file (`OWN_HOME\logs\own-accounts.log`, 02 §7.2). The background service's stderr
   * is a pipe nobody reads once it has started, so without the file its lines are lost.
   */
  readonly file?: string
  readonly now?: () => number
}

/** A log file past this size moves to `<file>.1` (replacing the older one) before the next line (`LogFile`). */
export const FILE_MAX_BYTES = LogFile.MAX_BYTES
/** While a full file cannot be moved, lines still go to it up to this size and are dropped after (`LogFile`). */
export const FILE_CAP_BYTES = LogFile.CAP_BYTES

export function create(input: Input): Logger {
  const minimum = RANK[input.level ?? "info"]
  const out = input.sink ?? ((line: string) => process.stderr.write(line + "\n"))
  const file = input.file === undefined ? undefined : LogFile.sink(input.file)
  const sink =
    file === undefined
      ? out
      : (line: string) => {
          out(line)
          file(line)
        }
  const now = input.now ?? Date.now
  const write = (level: Options.LogLevel) => (message: string, fields?: Fields) => {
    if (RANK[level] < minimum) return
    sink(
      JSON.stringify({
        ts: now(),
        level,
        scope: input.scope,
        msg: Redact.text(message),
        ...(fields ? Redact.record(fields) : {}),
      }),
    )
  }
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (scope) => create({ ...input, scope: `${input.scope}.${scope}` }),
  }
}

/** A logger that drops everything, for unit tests. */
export const silent: Logger = create({ scope: "silent", sink: () => {} })

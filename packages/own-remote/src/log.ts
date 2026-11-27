export * as Log from "./log.js"

import { LogFile, Redact } from "@own/runtime"
import type { Options } from "./options.js"

const RANK: Readonly<Record<Options.LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

export type Fields = Readonly<Record<string, unknown>>

/**
 * Structured logger (same shape as own-accounts). Messages and fields pass through `Redact`; never log prompt
 * answers, registration passwords, server tokens or broker keys (04 §15 "로그·오류 문구 누수").
 *
 * The background service's stderr is a pipe nobody reads once it runs (RH-20), so with `file` every line also goes to
 * `OWN_HOME\logs\own-remote.log` (`LogFile`: one stream per process, `.1` past 10 MB), like own-team.log.
 */
export interface Logger {
  debug(message: string, fields?: Fields): void
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string, fields?: Fields): void
  child(scope: string): Logger
}

export function create(input: {
  readonly level?: Options.LogLevel
  readonly scope: string
  readonly sink?: (line: string) => void
  /** Also appends every line to this file (`OWN_HOME\logs\own-remote.log`). */
  readonly file?: string
}): Logger {
  const minimum = RANK[input.level ?? "info"]
  const sink = input.sink ?? ((line: string) => process.stderr.write(line + "\n"))
  const file = input.file === undefined ? undefined : LogFile.sink(input.file)
  const write = (level: Options.LogLevel) => (message: string, fields?: Fields) => {
    if (RANK[level] < minimum) return
    const line = JSON.stringify({
      ts: Date.now(),
      level,
      scope: input.scope,
      msg: Redact.text(message),
      ...(fields ? Redact.record(fields) : {}),
    })
    // A closed stderr (EPIPE) must not take the file's line with it.
    try {
      sink(line)
    } catch {
      // Nobody reads stderr; the file keeps the line.
    }
    file?.(line)
  }
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (scope) => create({ ...input, scope: `${input.scope}.${scope}` }),
  }
}

export const silent: Logger = create({ scope: "silent", sink: () => {} })

/**
 * Diagnostic text that may be shown or stored (`detail`, `stderrTail`): the registration block and secret patterns
 * removed, bounded to `max` characters from the end.
 */
export function scrub(text: string, max = 2048) {
  const cleaned = text
    .replace(/OPENCODE_SSH_REGISTRATION_BEGIN[\s\S]*?(?:OPENCODE_SSH_REGISTRATION_END|$)/g, "")
    .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"[redacted]"')
  return Redact.text(cleaned).slice(-max).trim()
}

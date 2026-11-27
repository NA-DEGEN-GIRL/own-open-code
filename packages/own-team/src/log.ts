export * as Log from "./log.js"

import { LogFile, Redact } from "@own/runtime"
import type { Options } from "./options.js"

const RANK: Readonly<Record<Options.LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

export type Fields = Readonly<Record<string, unknown>>

/**
 * Structured logger (the shape of own-accounts and own-remote). Messages and fields pass through `Redact`; never log
 * the service password, prompt texts or tool inputs.
 *
 * RH-20: the background service's stderr is a pipe nobody reads (a detached service's parent closes it: `EPIPE` at
 * every host service start), so with `file` every line also goes to `OWN_HOME\logs\own-team.log` (`LogFile`: one
 * stream per process, `.1` past 10 MB). The process also keeps its last warnings and errors (`recent`), which
 * `diagnostics` answers.
 */
export interface Logger {
  debug(message: string, fields?: Fields): void
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string, fields?: Fields): void
  child(scope: string): Logger
}

/** Warnings and errors kept in memory per process (`recent`). */
export const KEPT = 400

export function create(input: {
  readonly level?: Options.LogLevel
  readonly scope: string
  readonly sink?: (line: string) => void
  /** Also appends every line to this file (`OWN_HOME\logs\own-team.log`). */
  readonly file?: string
}): Logger {
  const minimum = RANK[input.level ?? "info"]
  const out = input.sink ?? ((line: string) => process.stderr.write(line + "\n"))
  const file = input.file === undefined ? undefined : LogFile.sink(input.file)
  const write = (level: Options.LogLevel) => (message: string, fields?: Fields) => {
    if (RANK[level] < minimum) return
    const redacted = fields ? Redact.record(fields) : {}
    const line = JSON.stringify({ ts: Date.now(), level, scope: input.scope, msg: Redact.text(message), ...redacted })
    // A closed stderr (EPIPE) must not take the file's line with it.
    try {
      out(line)
    } catch {
      // Nobody reads stderr; the file keeps the line.
    }
    file?.(line)
    if (RANK[level] >= RANK.warn) keep(line, fields?.teamID)
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

interface Kept {
  readonly line: string
  readonly teamID?: string
}

/** The process's kept lines; plugin modules are imported again per Location, so they live on `globalThis`. */
function kept(): Kept[] {
  const key = Symbol.for("own-open-code.team-log-recent")
  // This file owns the key; the value is always the array made here.
  const holder = globalThis as unknown as Record<symbol, Kept[] | undefined>
  const known = holder[key]
  if (known) return known
  const created: Kept[] = []
  holder[key] = created
  return created
}

function keep(line: string, teamID: unknown) {
  const list = kept()
  list.push({ line, ...(typeof teamID === "string" ? { teamID } : {}) })
  if (list.length > KEPT) list.splice(0, list.length - KEPT)
}

/** The last `limit` warnings and errors of this process about `teamID` or no team in particular, oldest first. */
export function recent(teamID: string, limit = 50) {
  return kept()
    .filter((item) => item.teamID === undefined || item.teamID === teamID)
    .slice(-limit)
    .map((item) => item.line)
}

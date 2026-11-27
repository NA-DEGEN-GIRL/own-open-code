export * as ProtectedMatch from "./match.js"

import path from "node:path"

/**
 * Protected patterns matched as core matches rule resources (`core/src/util/wildcard.ts`): `\` read as `/`, `*` any
 * run (across `/` too), `?` one character, case-insensitive on Windows. A resource is a path relative to the
 * session's Location (core's `FileAccess.resolve`) or an absolute one; both are matched as the absolute path.
 */

/** One pattern with what a message names it by. */
export interface Labeled {
  readonly pattern: string
  /** The protected place as the user knows it (`~\.ssh`, a path of the user's list). */
  readonly label: string
}

export interface Matcher {
  /** The label of the first pattern `absolute` matches. */
  readonly find: (absolute: string) => string | undefined
}

export function matcher(patterns: ReadonlyArray<Labeled>, platform: NodeJS.Platform = process.platform): Matcher {
  const compiled = patterns.map((item) => ({ regex: compile(item.pattern, platform), label: item.label }))
  return {
    find: (absolute) => {
      const value = absolute.replaceAll("\\", "/")
      return compiled.find((item) => item.regex.test(value))?.label
    },
  }
}

/** core's wildcard as a regular expression. */
export function compile(pattern: string, platform: NodeJS.Platform = process.platform) {
  const source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${source}$`, platform === "win32" ? "si" : "s")
}

/** A rule resource as the absolute path it names: relative ones are relative to the Location (`directory`). */
export function absolute(resource: string, directory: string, platform: NodeJS.Platform = process.platform) {
  const join = platform === "win32" ? path.win32 : path.posix
  return join.resolve(directory, resource).replaceAll("\\", "/")
}

/** `absolute` as the user's machine writes it, with `~` for the home folder. */
export function display(absolute: string, home: string, platform: NodeJS.Platform = process.platform) {
  const native = platform === "win32" ? absolute.replaceAll("/", "\\") : absolute
  const base = platform === "win32" ? home.replaceAll("/", "\\") : home
  const inside = platform === "win32" ? native.toLowerCase().startsWith(base.toLowerCase()) : native.startsWith(base)
  if (!inside) return native
  const rest = native.slice(base.length)
  if (rest === "") return "~"
  return /^[\\/]/.test(rest) ? `~${rest}` : native
}

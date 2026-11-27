// core/src/util/wildcard.ts `match`, for reading permission rules the way core does (a plugin cannot import core).
export * as Wildcard from "./wildcard.js"

/** Whether `input` matches `pattern`: `*` any run, `?` one character, a trailing ` *` optional, case-blind on Windows. */
export function match(input: string, pattern: string) {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const tail = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped
  return new RegExp(`^${tail}$`, process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"))
}

export * as McpRules from "./mcp-rules.js"

import { McpDsn } from "./mcp-dsn.js"
import { encode, strings, type Text } from "./mcp-json.js"

/**
 * The plain rules of own's MCP servers (03 §18.14, SM), shared by own.accounts and own-web without the schema graph:
 * names, value names and limits, the masked hint of a stored value, a free name for a found server, and the `${NAME}`
 * references an argument or the command may make to a stored environment value.
 */

/** A server's name as core and the agents see it (its tools are `<name>_<tool>`, the permission action too). */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Environment variable names (POSIX portable), and HTTP header names (RFC 9110 tokens). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

/** A secret value's longest length; values are pasted tokens, paths or short settings. */
export const MAX_VALUE = 8192
/** Values at least this long show their last four characters; shorter ones show only that they are set. */
export const HINT_MIN = 12

/** The last four characters of a long enough value, never the value. */
export function hint(value: string) {
  return value.length >= HINT_MIN ? `…${value.slice(-4)}` : undefined
}

/**
 * A name own can use for a found or pasted server: characters a name cannot have become `-`, and `-2`, `-3` … keep
 * it apart from `taken` (compared without case, as own compares names).
 */
export function suggestName(name: string | undefined, taken: Iterable<string>) {
  const used = new Set([...taken].map((item) => item.toLowerCase()))
  const cleaned =
    (name ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/-+$/, "")
      .slice(0, 60) || "server"
  const free = (index: number): string => {
    const candidate = index === 1 ? cleaned : `${cleaned}-${index}`
    return used.has(candidate.toLowerCase()) ? free(index + 1) : candidate
  }
  return free(1)
}

/**
 * `${NAME}` in a command or an argument: the stored environment value NAME, put in when the server starts. Claude
 * Code's `${NAME:-default}` (SM-25) is the value NAME, else the default (group 2, which holds no `}`).
 */
export const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})(?::-([^}]*))?\}/g

/** The environment value names a text needs stored: its `${NAME}` references (one with a default needs none). */
export function references(text: string) {
  return [...text.matchAll(REFERENCE)].flatMap((match) => (match[2] === undefined ? [match[1]!] : []))
}

/**
 * The text with every reference to a name of `values` replaced by its value, and a `${NAME:-default}` whose name has
 * none by its default; other references stay as written. In a JSON argument (the argument, or after `--flag=`, `KEY=`
 * or `Name:`, as `McpSecrets` reads one) a string that holds a reference is read, filled in and written again as JSON,
 * so a stored value is the value itself and a `"` or `\` in it stays JSON (SM-26), in the string's own escape style
 * (`McpJson.encode`: `\/`, `\u00e9`, SM-27; a string that was only a reference is written in the plain style, so a
 * value moved whole comes back as the same JSON value, not always the same escapes); every other token stays as
 * written. Likewise in a connection string (`McpDsn.quoted`, SM-28) a quoted value that holds a reference is read,
 * filled in and quoted again (`Password="${P}"` with `a"b` gives `Password="a""b"`, `{…}` doubles `}`, libpq's `'…'`
 * escapes `'` and `\`), so a stored password is the one the driver reads.
 */
export function expand(text: string, values: Readonly<Record<string, string>>): string {
  const json = jsonPart(text)
  if (json === undefined) return connection(text, values)
  return (
    fill(text.slice(0, json.at), values) +
    json.strings.reduceRight((out, item) => {
      const raw = out.slice(item.start, item.end)
      if (raw.search(REFERENCE) === -1) return out
      return out.slice(0, item.start) + encode(expand(item.value, values), raw) + out.slice(item.end)
    }, text.slice(json.at))
  )
}

function connection(text: string, values: Readonly<Record<string, string>>) {
  const found = McpDsn.quoted(text)
  if (found === undefined) return fill(text, values)
  return (
    fill(text.slice(0, found.at), values) +
    found.pieces
      .map((piece) =>
        piece.kind === "value" && piece.quote !== undefined && piece.text.search(REFERENCE) !== -1
          ? McpDsn.write(fill(McpDsn.read(piece.text, piece.quote), values), piece.quote)
          : fill(piece.text, values),
      )
      .join("")
  )
}

function fill(text: string, values: Readonly<Record<string, string>>) {
  return text.replace(REFERENCE, (whole, name: string, fallback: string | undefined) =>
    Object.hasOwn(values, name) ? values[name]! : (fallback ?? whole),
  )
}

/** The JSON part of an argument: from its start or after a `=` or `:`, to its end. */
function jsonPart(text: string) {
  return [0, ...[...text.matchAll(/[=:]/g)].map((match) => match.index + 1)]
    .filter((at) => /^[ \t\n\r]*[{[]/.test(text.slice(at)))
    .map((at) => ({ at, strings: strings(text.slice(at)) }))
    .find((part): part is { at: number; strings: ReadonlyArray<Text> } => part.strings !== undefined)
}

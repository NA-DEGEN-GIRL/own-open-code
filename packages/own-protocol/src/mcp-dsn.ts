export * as McpDsn from "./mcp-dsn.js"

/**
 * Connection strings read part by part (03 §18.14, SM-26, SM-27, SM-28), so `McpSecrets` moves and masks only their
 * secret parts and `McpRules.expand` writes a quoted value back in its own quoting. Plain code, no schemas, as the other
 * MCP rules. The forms:
 * - `Name=value;…` (ADO.NET, ODBC, Azure): a name of letters, digits and spaces, a value as written up to `;`, or quoted
 *   in `"…"`, `'…'` or ODBC's `{…}` (a doubled quote or `}}` inside; a `${NAME}` inside braces is one piece);
 * - libpq's `host=db password='a b'`: names, `=` and values apart by spaces, a value bare or in `'…'` (`\` escapes);
 * - Go MySQL's `user:pass@tcp(host:3306)/db` ({@link goMysql});
 * - Oracle's EZConnect `user/pass@host:1521/svc` ({@link oracle}).
 */

/** How a value is quoted: ADO.NET's `"…"` and `'…'`, ODBC's `{…}` (doubled to escape), libpq's `'…'` (`\` escapes). */
export type Quote = '"' | "'" | "{" | "\\'"
export const QUOTES: ReadonlyArray<Quote> = ['"', "'", "{", "\\'"]

export type Piece =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "value"
      /** The part's name; Go MySQL's and Oracle's password is `PASSWORD`. */
      readonly name: string
      /** The value as written (between its quotes). */
      readonly text: string
      /** The value as the driver reads it: a doubled quote or `}}` as one, libpq's `\'` as `'`. */
      readonly read: string
      /** A quoted value's quoting, so a read text is written back in its place ({@link write}). */
      readonly quote?: Quote
    }

const PART_NAME = /[ \t]*([A-Za-z][A-Za-z0-9_.-]*(?:[ \t]+[A-Za-z0-9_.-]+)*)[ \t]*=[ \t]*/y
/** A `${…}` reference: one piece inside a quoted value, never read or written as its characters. */
const REFERENCE = String.raw`\$\{[^{}\s]*\}`
const REFERENCED = new RegExp(REFERENCE)
const QUOTED = {
  '"': /"((?:[^"]|"")*)"/y,
  "'": /'((?:[^']|'')*)'/y,
  // A `$` before `{` only as a reference, so a reference and its characters never both match (no backtracking blow-up).
  "{": new RegExp(String.raw`\{((?:${REFERENCE}|\$(?!\{)|[^}$]|\}\})*)\}`, "y"),
}
const UNQUOTED = /[^;]*/y
const BETWEEN = /[\s;]*/y
const AFTER = /[ \t]*(?:;|$)/y
const LIBPQ_NAME = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/y
const LIBPQ_VALUE = /'((?:[^'\\]|\\[\s\S])*)'|((?:[^\s'\\]|\\[\s\S])+)/y
const LIBPQ_AFTER = /(?=\s|$)/y
/**
 * Go MySQL's `user:pass@tcp(host:3306)/db?…`: the password runs to the last `@`, as the driver reads it (one that starts
 * with `/` or `\` would be a folder, `C:\…`). The address is a protocol with its address in parentheses (`tcp(…)`,
 * `unix(…)`, any other), `tcp` or `unix` alone, or none (`@/db`), so `scope:read@org/repo` and `pkg:github/org/repo@main/x`
 * are no DSN (SM-28); `@//` is Oracle's.
 */
const GO_USER = /^([^:@/\\\s()]+):((?![\\/])\S+)$/
const GO_ADDRESS = /^@(?:tcp|unix|[A-Za-z][A-Za-z0-9]*\([^()\s]*\))?\/(?!\/)\S*$/
/**
 * Oracle's EZConnect `user/pass@host:1521/svc`, `user/pass@//host[:port]/svc` (`:server` and `/instance` after it) and
 * JDBC's `host:port:SID` (SM-28: a SID with digits, `ORCL19`), `jdbc:oracle:thin:` before it too. A service or a SID
 * must follow, and without `//` or `jdbc:oracle:` the port must be a listener's (1500–1599, 2483, 2484), so
 * `owner/repo@v1.2.3`, `owner/repo@main:443` and `org/repo@host:8080/path` are no DSN.
 */
const ORACLE = new RegExp(
  String.raw`^((jdbc:oracle:[A-Za-z]+:)?[A-Za-z][A-Za-z0-9_$#]*/)([^/@\s"]+)` +
    String.raw`(@(?:(//)[A-Za-z0-9.-]+(?::\d+)?|[A-Za-z0-9.-]+:(\d+))` +
    String.raw`(?:/[A-Za-z0-9_.$#-]+(?::[A-Za-z]+)?(?:/[A-Za-z0-9_.$#-]+)?|:[A-Za-z][A-Za-z0-9_$#]*))$`,
)
const LISTENER = /^(?:15\d\d|248[34])$/

/** `Name=value;…` of at least `min` parts, every part so ({@link PART_NAME}; a quoted value as one, `;` and all). */
export function parts(text: string, min: number): Piece[] | undefined {
  const scan = scanner(text)
  const pieces: Piece[] = []
  const state = { count: 0 }
  // A loop over the parts, as `McpJson` reads members, so a long string does not use up the stack.
  while (true) {
    pieces.push({ kind: "text", text: scan.take(BETWEEN)![0] })
    if (scan.done()) return state.count >= min ? pieces : undefined
    const name = scan.take(PART_NAME)
    if (!name) return undefined
    state.count++
    const open = scan.next()
    if (open !== '"' && open !== "'" && open !== "{") {
      const value = scan.take(UNQUOTED)![0]
      const trimmed = value.trimEnd()
      pieces.push(
        { kind: "text", text: name[0] },
        { kind: "value", name: name[1]!, text: trimmed, read: trimmed },
        { kind: "text", text: value.slice(trimmed.length) },
      )
      continue
    }
    const quoted = scan.take(QUOTED[open])
    const after = quoted ? scan.take(AFTER) : undefined
    if (!quoted || !after) return undefined
    pieces.push(
      { kind: "text", text: name[0] + open },
      { kind: "value", name: name[1]!, text: quoted[1]!, read: read(quoted[1]!, open), quote: open },
      { kind: "text", text: quoted[0].at(-1)! + after[0] },
    )
  }
}

/** libpq's `host=db password='a b'` of at least `min` names: every word so ({@link LIBPQ_NAME}, {@link LIBPQ_VALUE}). */
export function libpq(text: string, min: number): Piece[] | undefined {
  const scan = scanner(text)
  const pieces: Piece[] = []
  const state = { count: 0 }
  while (true) {
    const name = scan.take(LIBPQ_NAME)
    if (!name) {
      const rest = scan.rest()
      return rest.trim() === "" && state.count >= min ? [...pieces, { kind: "text", text: rest }] : undefined
    }
    const value = scan.take(LIBPQ_VALUE)
    if (!value || !scan.take(LIBPQ_AFTER)) return undefined
    state.count++
    const inner = value[1] ?? value[2]!
    // As libpq reads it, bare or quoted: `\'` and `\\` are the characters themselves.
    const quote = value[1] === undefined ? "" : "'"
    pieces.push(
      { kind: "text", text: name[0] + quote },
      {
        kind: "value",
        name: name[1]!,
        text: inner,
        read: read(inner, "\\'"),
        ...(quote === "" ? {} : { quote: "\\'" as const }),
      },
      { kind: "text", text: quote },
    )
  }
}

/** Go MySQL's `user:pass@tcp(host:3306)/db`: the password, up to the last `@` ({@link GO_ADDRESS}). */
export function goMysql(text: string): Piece[] | undefined {
  const at = text.lastIndexOf("@")
  const user = at < 0 ? null : GO_USER.exec(text.slice(0, at))
  if (!user || !GO_ADDRESS.test(text.slice(at))) return undefined
  return [
    { kind: "text", text: `${user[1]}:` },
    { kind: "value", name: "PASSWORD", text: user[2]!, read: user[2]! },
    { kind: "text", text: text.slice(at) },
  ]
}

/** Oracle's `user/pass@host:1521/svc` ({@link ORACLE}): the password. */
export function oracle(text: string): Piece[] | undefined {
  const match = ORACLE.exec(text)
  if (!match) return undefined
  if (match[2] === undefined && match[5] === undefined && !LISTENER.test(match[6] ?? "")) return undefined
  return [
    { kind: "text", text: match[1]! },
    { kind: "value", name: "PASSWORD", text: match[3]!, read: match[3]! },
    { kind: "text", text: match[4]! },
  ]
}

/**
 * The connection string of an argument where `McpSecrets.lift` reads one (the whole argument, after its first `=` as in
 * `--flag=` and `KEY=`, after a header's `Name:`, or the `;name=value` properties after an address's host or path),
 * when a quoted value in it holds a `${NAME}`: where it starts and its pieces. Otherwise undefined.
 */
export function quoted(text: string) {
  const equals = text.indexOf("=")
  const colon = /^[^:]*:[ \t]*/.exec(text)?.[0].length
  const address = text.indexOf("://")
  const semicolon = address < 0 ? -1 : text.indexOf(";", address)
  const starts = [
    { at: 0, min: 2 },
    ...(equals < 0 ? [] : [{ at: equals + 1, min: 2 }]),
    ...(colon === undefined ? [] : [{ at: colon, min: 2 }]),
    ...(semicolon < 0 ? [] : [{ at: semicolon + 1, min: 1 }]),
  ]
  return starts.flatMap((start) => {
    const rest = text.slice(start.at)
    const pieces = [parts(rest, start.min), libpq(rest, start.min)].find((found) =>
      found?.some((piece) => piece.kind === "value" && piece.quote !== undefined && REFERENCED.test(piece.text)),
    )
    return pieces === undefined ? [] : [{ at: start.at, pieces }]
  })[0]
}

/** A quoted value's text as the driver reads it (`Pa""ss` → `Pa"ss`); a `${NAME}` in it stays as written. */
export function read(text: string, quote: Quote) {
  return literal(text, (part) =>
    quote === "\\'" ? part.replace(/\\([\s\S])/g, "$1") : part.replaceAll(closing(quote).repeat(2), closing(quote)),
  )
}

/** A text as a value quoted so is written (`Pa"ss` → `Pa""ss`); a `${NAME}` in it stays as written. */
export function write(text: string, quote: Quote) {
  return literal(text, (part) =>
    quote === "\\'" ? part.replace(/['\\]/g, "\\$&") : part.replaceAll(closing(quote), closing(quote).repeat(2)),
  )
}

function closing(quote: Quote) {
  return quote === "{" ? "}" : quote
}

/** `text` with `change` applied to the parts between its `${…}` references. */
function literal(text: string, change: (part: string) => string) {
  const references = [...text.matchAll(new RegExp(REFERENCE, "g"))]
  const ends = [0, ...references.map((match) => match.index + match[0].length)]
  return (
    references.map((match, index) => change(text.slice(ends[index], match.index)) + match[0]).join("") +
    change(text.slice(ends.at(-1)))
  )
}

/** Sticky patterns taken one after another from the start of `text`. */
function scanner(text: string) {
  const state = { at: 0 }
  return {
    take: (pattern: RegExp) => {
      pattern.lastIndex = state.at
      const match = pattern.exec(text)
      if (match) state.at = pattern.lastIndex
      return match ?? undefined
    },
    next: () => text[state.at],
    done: () => state.at >= text.length,
    rest: () => text.slice(state.at),
  }
}

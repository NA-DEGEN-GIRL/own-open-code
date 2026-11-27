export * as McpJson from "./mcp-json.js"

/**
 * A JSON argument read token by token (03 §18.14, SM-26): where each string stands, so `McpSecrets` rewrites a value
 * in place and `McpRules.expand` puts one back without parsing the rest again. Every other token stays byte for byte:
 * a number keeps all its digits (`12345678901234567890`), the spacing and the field order stay. Plain code, no
 * schemas, as the other MCP rules.
 */

export interface Text {
  /** Where the string's opening quote is, and the place after its closing one. */
  readonly start: number
  readonly end: number
  /** The string as JSON reads it (escapes resolved). */
  readonly value: string
  /** A field's name rather than a value. */
  readonly key: boolean
  /** The field a value belongs to: its own name, or for an array's items the array's (as `{"apiKeys": […]}`). */
  readonly field: string | undefined
}

/** Deeper than this is no argument a person writes; it is read as plain text and the stack stays small. */
const DEPTH = 64
const SPACE = /[ \t\n\r]*/y
const CHARS = String.raw`(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*`
const STRING = new RegExp(`"${CHARS}"`, "y")
const BODY = new RegExp(`^${CHARS}$`)
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
const WORD = /true|false|null/y

/**
 * A text as the inside of a JSON string writes it (`a"b` → `a\"b`); `ascii` also writes every character past ASCII
 * as `\uXXXX` (`é` → `\u00e9`), as Python's `json.dumps` does by default (SM-27).
 */
export function escape(text: string, ascii = false) {
  const body = JSON.stringify(text).slice(1, -1)
  return ascii ? asciiOnly(body, false) : body
}

/**
 * A text as a JSON string (quotes included) in the escape style of `raw`, the string it takes the place of (SM-27):
 * `\/` for `/` when `raw` writes a slash so, and `\uXXXX` for every character past ASCII when `raw` writes one so (in
 * the case of its hex digits; not when `unicode` is false, for a text that is only shown). So a string rewritten in
 * place reads as the rest of its JSON was written.
 */
export function encode(text: string, raw: string, unicode = true) {
  // Left to right every `\` starts one escape, so `\\u00e9` is a backslash and `u00e9`, not an escape of `é`.
  const escapes = [...raw.matchAll(/\\(u[0-9a-fA-F]{4}|[\s\S])/g)].map((match) => match[1]!)
  const wide = escapes.find((escape) => escape.length === 5 && parseInt(escape.slice(1), 16) >= 0x80)
  const json = JSON.stringify(text)
  const slashed = escapes.includes("/") ? json.replaceAll("/", "\\/") : json
  return wide === undefined || !unicode ? slashed : asciiOnly(slashed, /[A-F]/.test(wide))
}

/** Every UTF-16 unit past ASCII as `\uXXXX`: a character beyond the BMP as its two surrogates, as `json.dumps` does. */
function asciiOnly(text: string, upper: boolean) {
  return text.replace(/[\u0080-\uffff]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0")
    return `\\u${upper ? hex.toUpperCase() : hex}`
  })
}

/** The inside of a JSON string read (`a\"b` → `a"b`), when the text is one; otherwise undefined. */
export function unescape(body: string): string | undefined {
  // The text matched JSON's string grammar, so this reads it without throwing.
  return BODY.test(body) ? JSON.parse(`"${body}"`) : undefined
}

/** The strings of `text` when it is one JSON object or array, spacing around it allowed; otherwise undefined. */
export function strings(text: string): ReadonlyArray<Text> | undefined {
  const found: Text[] = []
  const state = { at: 0 }
  const take = (pattern: RegExp) => {
    pattern.lastIndex = state.at
    const match = pattern.exec(text)
    if (match) state.at = pattern.lastIndex
    return match?.[0]
  }
  const next = () => {
    take(SPACE)
    return text[state.at]
  }
  const string = (key: boolean, field: string | undefined) => {
    const start = state.at
    const raw = take(STRING)
    if (raw === undefined) return undefined
    // The token matched JSON's string grammar, so this reads it without throwing.
    const value: string = JSON.parse(raw)
    found.push({ start, end: state.at, value, key, field })
    return value
  }
  const value = (field: string | undefined, depth: number): boolean => {
    const char = next()
    if (char === "{" || char === "[") return depth < DEPTH && container(field, depth + 1)
    if (char === '"') return string(false, field) !== undefined
    return take(NUMBER) !== undefined || take(WORD) !== undefined
  }
  const container = (field: string | undefined, depth: number) => {
    const close = text[state.at] === "{" ? "}" : "]"
    state.at++
    if (next() === close) {
      state.at++
      return true
    }
    const member = () => {
      if (close === "]") return value(field, depth)
      next()
      const name = string(true, undefined)
      if (name === undefined || next() !== ":") return false
      state.at++
      return value(name, depth)
    }
    // A loop rather than a call per member, so a long array does not use up the stack.
    while (member()) {
      const after = next()
      state.at++
      if (after === close) return true
      if (after !== ",") return false
    }
    return false
  }
  const first = next()
  if (first !== "{" && first !== "[") return undefined
  if (!container(undefined, 1)) return undefined
  return next() === undefined ? found : undefined
}

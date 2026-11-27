export * as Redact from "./redact.js"

import { entries, short, type HeadersLike } from "./hash.js"

/**
 * Secret patterns for logs and scans (01 §13 "로그") and for imported conversations (09 §4.2): the http-recorder list
 * (`packages/http-recorder/src/redaction/secrets.ts`) plus xAI keys and JWTs. Applied in this order, so `sk-ant-`
 * must precede `sk-`. Labels are shown to the model by {@link named}.
 */
export const PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}/g },
  { label: "xAI API key", pattern: /\bxai-[A-Za-z0-9]{20,}/g },
  { label: "JWT", pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // `gh?_` tokens and fine-grained personal access tokens (`github_pat_`, 16 §4, GH).
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g },
  {
    label: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
]

/**
 * Field names whose string values are secrets wherever they appear, compared case-insensitively. Covers OAuth token
 * endpoint bodies (whose tokens sit outside any Bearer header, 01 §13), the vault item fields, and the old app's
 * `auth.json`. A bare `key` is not listed because ledger and usage rows use it for group keys.
 */
export const FIELDS: ReadonlySet<string> = new Set([
  "access",
  "access_token",
  "accesstoken",
  "refresh",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "token",
  "authorization_code",
  "code_verifier",
  "client_secret",
  "api_key",
  "apikey",
  "openai_api_key",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "password",
  "secret",
])

/** Headers whose values are always replaced. */
export const HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
])

/** Replacement for one secret: `[redacted:<first 8 hex of its SHA-256>]`. */
export function marker(secret: string) {
  return `[redacted:${short(secret)}]`
}

/** Replaces every secret-looking substring. A Bearer scheme word is kept so the header shape stays readable. */
export function text(input: string) {
  return PATTERNS.reduce(
    (result, item) =>
      result.replace(item.pattern, (match) => {
        const bearer = /^(Bearer\s+)(.+)$/is.exec(match)
        return bearer ? bearer[1] + marker(bearer[2]) : marker(match)
      }),
    input,
  )
}

/** Result of {@link named}. */
export interface Named {
  readonly text: string
  /** Markers the call added, the sum of {@link labels}. */
  readonly count: number
  /** Markers added per pattern label, in {@link PATTERNS} order; labels with none are left out. */
  readonly labels: Readonly<Record<string, number>>
}

/**
 * {@link text} for model-visible text such as imported conversations (09 §4.2): each secret becomes
 * `[redacted:<label>]` with the label of the first pattern that takes it, e.g. `[redacted:API key]`. It never writes
 * a hash fragment, which would put a distinct value per secret into the prompt. A Bearer scheme word is kept.
 *
 * After the patterns, a value of a secret-named field ({@link secretField}) becomes `[redacted:<field>]`, whatever it
 * looks like: a JSON or quoted key (`"refresh_token": "…"`), an assignment (`password=…`, `OPENAI_API_KEY=…`,
 * `spring.datasource.password = …`, `?token=…`) or a key at the start of a line (`client_secret: …`, `export
 * GITHUB_TOKEN=…`, `Authorization: Basic …`). These show up in tool output (`cat` of a config or auth file, `env`).
 * A value that already shows a marker, a reference (`$VAR`, `${{ … }}`) or a call (`token = getToken()`) stays.
 *
 * Counts are the label markers in the result less those already in the input, so they match what the text shows: a
 * private key block that spans a marker written by an earlier pattern counts once, and running it again over its own
 * output changes and counts nothing.
 */
export function named(input: string): Named {
  const patterned = PATTERNS.reduce(
    (result, item) =>
      result.replace(item.pattern, (match) => `${/^Bearer\s+/i.exec(match)?.[0] ?? ""}[redacted:${item.label}]`),
    input,
  )
  const fields = new Set<string>()
  const hide = (key: string, value: string, quoted = false) => {
    if (!secretField(key, quoted) || value === "" || value.includes("[redacted:") || value.startsWith("$"))
      return undefined
    const label = key.toLowerCase()
    fields.add(label)
    return `[redacted:${label}]`
  }
  const output = patterned
    .replace(QUOTED_FIELD, (match, open: string, key: string, colon: string, quote: string, value: string) => {
      const shown = hide(key, value, true)
      return shown === undefined ? match : `${open}${key}${open}${colon}${quote}${shown}${quote}`
    })
    .replace(ASSIGNED_FIELD, (match, key: string, equals: string, value: string) => {
      const quoted = /^(["'])(.*)\1$/s.exec(value)
      const shown = hide(key, quoted?.[2] ?? value)
      if (shown === undefined) return match
      return `${key}${equals}${quoted ? `${quoted[1]}${shown}${quoted[1]}` : shown}`
    })
    .replace(LINE_FIELD, (match, lead: string, key: string, colon: string, value: string) => {
      const quoted = /^(["'])(.*)\1$/s.exec(value)
      if (quoted === null && /^[{[|>&*#]/.test(value)) return match
      const shown = hide(key, quoted?.[2] ?? value)
      if (shown === undefined) return match
      return `${lead}${key}${colon}${quoted ? `${quoted[1]}${shown}${quoted[1]}` : shown}`
    })
  if (output === input) return { text: output, count: 0, labels: {} }
  const labels = Object.fromEntries(
    [...PATTERNS.map((item) => item.label), ...fields].flatMap((label): Array<[string, number]> => {
      const added = occurrences(output, label) - occurrences(input, label)
      return added > 0 ? [[label, added]] : []
    }),
  )
  return { text: output, count: Object.values(labels).reduce((sum, added) => sum + added, 0), labels }
}

/**
 * Whether {@link named} hides a field's value: a {@link FIELDS} name (case-insensitive; of a dotted key, its last
 * segment), or an environment-style name ending in `_API_KEY`, `_ACCESS_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`
 * (upper case only, so `max_token` in code stays). `access` and `refresh` count only as JSON or quoted keys: as bare
 * words they name settings (`access: public`).
 */
function secretField(key: string, quoted = false) {
  const last = key.split(".").at(-1)?.toLowerCase() ?? ""
  if (!quoted && (last === "access" || last === "refresh")) return false
  return FIELDS.has(last) || /^[A-Z][A-Z0-9_]*_(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)
}

/** `"<key>": "<value>"` (or single quotes) on one line. */
const QUOTED_FIELD = /(["'])([A-Za-z_][\w.-]*)\1(\s*:\s*)(["'])((?:\\.|(?!\4)[^\\\r\n])*)\4/g
/**
 * `<key>=<value>`: a quoted value, or a bare one up to a space or separator that is not a call or an index
 * (`getToken()`, `os.environ[…]`). `==`, `!=` and `<=` are comparisons.
 */
const ASSIGNED_FIELD =
  /(?<![\w.])([A-Za-z_][\w.-]*)(\s*(?<![=!<>])=(?!=)\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`&;,(){}[\]<>]+(?![(\w.[]))/g
/** `<key>: <value>` at the start of a line (YAML, `.env`-like files, HTTP headers), the value to the line's end. */
const LINE_FIELD = /^([ \t]*(?:export[ \t]+|-[ \t]+)?)([A-Za-z_][\w.-]*)([ \t]*:[ \t]*)(\S(?:[^\r\n]*\S)?)[ \t]*$/gm

/**
 * Deep copy with secrets removed: string values of {@link FIELDS} become markers, every other string goes through
 * {@link text}. Errors keep only their name and redacted message. Cycles become `"[circular]"`.
 */
export function value(input: unknown): unknown {
  return walk(input, new WeakSet())
}

/** {@link value} for a record, keeping the record type. */
export function record(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const seen = new WeakSet<object>([input])
  return Object.fromEntries(Object.entries(input).map((entry) => [entry[0], field(entry[0], entry[1], seen)]))
}

/** Header record safe to log: credential headers become markers, other values go through {@link text}. */
export function headers(input: HeadersLike): Record<string, string> {
  return Object.fromEntries(
    entries(input).map((entry) => [entry[0], HEADERS.has(entry[0]) ? marker(entry[1]) : text(entry[1])]),
  )
}

/** Message of an unknown thrown value, redacted. */
export function error(input: unknown) {
  if (input instanceof Error) return text(`${input.name}: ${input.message}`)
  return text(String(input))
}

/** One secret found by {@link findings}. */
export interface Finding {
  readonly path: string
  readonly reason: string
}

/** Paths of secret-looking strings in a value, for leak scans such as G14 (01 §16.1). Never returns the values. */
export function findings(input: unknown): Finding[] {
  return strings(input, "", new WeakSet()).flatMap((entry) => [
    ...(entry.field && FIELDS.has(entry.field.toLowerCase()) && entry.value.length > 0
      ? [{ path: entry.path, reason: "secret field" }]
      : []),
    ...TESTS.filter((item) => item.pattern.test(entry.value)).map((item) => ({ path: entry.path, reason: item.label })),
  ])
}

// `test` on a global RegExp is stateful (`lastIndex`), so scans use non-global copies.
const TESTS = PATTERNS.map((item) => ({
  label: item.label,
  pattern: new RegExp(item.pattern.source, item.pattern.flags.replace("g", "")),
}))

function occurrences(input: string, label: string) {
  return input.split(`[redacted:${label}]`).length - 1
}

function walk(input: unknown, seen: WeakSet<object>): unknown {
  if (typeof input === "string") return text(input)
  if (input instanceof Error) return { name: input.name, message: text(input.message) }
  if (input === null || typeof input !== "object") return input
  if (seen.has(input)) return "[circular]"
  seen.add(input)
  if (Array.isArray(input)) return input.map((item) => walk(item, seen))
  return Object.fromEntries(Object.entries(input).map((entry) => [entry[0], field(entry[0], entry[1], seen)]))
}

function field(name: string, input: unknown, seen: WeakSet<object>) {
  return FIELDS.has(name.toLowerCase()) && typeof input === "string" ? marker(input) : walk(input, seen)
}

function strings(
  input: unknown,
  path: string,
  seen: WeakSet<object>,
  field?: string,
): Array<{ path: string; value: string; field?: string }> {
  if (typeof input === "string") return [{ path, value: input, field }]
  if (input === null || typeof input !== "object" || seen.has(input)) return []
  seen.add(input)
  if (Array.isArray(input)) return input.flatMap((item, index) => strings(item, `${path}[${index}]`, seen))
  return Object.entries(input).flatMap((entry) =>
    strings(entry[1], path ? `${path}.${entry[0]}` : entry[0], seen, entry[0]),
  )
}

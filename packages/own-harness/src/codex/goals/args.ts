// Decodes goal tool arguments the way Codex's `serde_json::from_str` does for `CreateGoalRequest` and `UpdateGoalArgs`
// (codex-rs/ext/goal/src/tool.rs), reproducing serde_json 1.0.149's error texts and `at line L column C` positions
// (columns count UTF-8 bytes). Fields are checked in document order, so the first error matches serde's. Unknown keys
// are ignored, a repeated known key is `duplicate field`, and a struct may also be given in serde's sequence form.
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1 (092d3acd6b)
export * as GoalArgs from "./args.js"

const ENCODER = new TextEncoder()
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const U64_MAX = 2n ** 64n - 1n
const STATUS_VARIANTS = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const

export type StatusVariant = (typeof STATUS_VARIANTS)[number]
export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

export interface CreateArgs {
  readonly objective: string
  readonly token_budget?: number
}

export interface UpdateArgs {
  readonly status: StatusVariant
}

/** Arguments arrive either as the raw JSON text the model produced or as an already parsed value (re-serialized compactly). */
export function create(input: unknown): Decoded<CreateArgs> {
  const decoded = decode(input, "CreateGoalRequest", [
    { name: "objective", kind: "string", required: true },
    { name: "token_budget", kind: "i64", required: false },
  ])
  if (!decoded.ok) return decoded
  const fields = decoded.value
  return {
    ok: true,
    value: {
      objective: fields.objective as string,
      ...(fields.token_budget === undefined ? {} : { token_budget: fields.token_budget as number }),
    },
  }
}

export function update(input: unknown): Decoded<UpdateArgs> {
  const decoded = decode(input, "UpdateGoalArgs", [{ name: "status", kind: "status", required: true }])
  if (!decoded.ok) return decoded
  return { ok: true, value: { status: decoded.value.status as StatusVariant } }
}

interface Field {
  readonly name: string
  readonly kind: "string" | "i64" | "status"
  readonly required: boolean
}

class Failure {
  constructor(
    readonly message: string,
    readonly index: number,
  ) {}
}

function decode(input: unknown, struct: string, fields: readonly Field[]) {
  const text = typeof input === "string" ? input : (JSON.stringify(input ?? {}) ?? "{}")
  const parser = new Parser(text)
  return parser.run(() => {
    const value = parser.struct(struct, fields)
    parser.end()
    return value
  })
}

// A minimal JSON reader that follows serde_json's `Deserializer<SliceRead>` order of checks and error positions.
class Parser {
  private index = 0
  constructor(private readonly text: string) {}

  run<T>(body: () => T): Decoded<T> {
    const result = attempt(body)
    if (!(result instanceof Failure)) return { ok: true, value: result }
    return { ok: false, message: `${result.message} at ${this.position(result.index)}` }
  }

  struct(struct: string, fields: readonly Field[]) {
    const first = this.peek("EOF while parsing a value")
    if (first === "{") return this.object(fields)
    if (first === "[") return this.sequence(struct, fields)
    const unexpected = this.scalar()
    throw new Failure(`invalid type: ${unexpected}, expected struct ${struct}`, this.index)
  }

  end() {
    this.whitespace()
    if (this.index < this.text.length) throw new Failure("trailing characters", this.index + 1)
  }

  private object(fields: readonly Field[]) {
    this.index++
    const values: Record<string, unknown> = {}
    const seen = new Set<string>()
    const loop = (first: boolean): void => {
      const next = this.peek("EOF while parsing an object")
      if (next === "}") return
      if (!first) {
        if (next !== ",") throw new Failure("expected `,` or `}`", this.index + 1)
        this.index++
        this.peek("EOF while parsing a value")
      }
      if (this.text[this.index] !== '"') {
        if (this.text[this.index] === "}" && !first) throw new Failure("trailing comma", this.index + 1)
        throw new Failure("key must be a string", this.index + 1)
      }
      const key = this.string()
      const field = fields.find((entry) => entry.name === key)
      if (field && seen.has(key)) throw new Failure(`duplicate field \`${key}\``, this.index)
      if (this.peek("EOF while parsing an object") !== ":") throw new Failure("expected `:`", this.index + 1)
      this.index++
      if (!field) {
        this.skip()
        return loop(false)
      }
      seen.add(key)
      values[key] = this.field(field)
      return loop(false)
    }
    loop(true)
    this.index++
    const missing = fields.find((field) => field.required && !seen.has(field.name))
    if (missing) throw new Failure(`missing field \`${missing.name}\``, this.index)
    return values
  }

  private sequence(struct: string, fields: readonly Field[]) {
    this.index++
    const values: Record<string, unknown> = {}
    const read = (position: number): number => {
      if (position === fields.length) return position
      const next = this.peek("EOF while parsing a list")
      if (next === "]") return position
      if (position > 0) {
        if (next !== ",") throw new Failure("expected `,` or `]`", this.index + 1)
        this.index++
        if (this.peek("EOF while parsing a value") === "]") throw new Failure("trailing comma", this.index + 1)
      }
      values[fields[position].name] = this.field(fields[position])
      return read(position + 1)
    }
    const count = read(0)
    const close = this.peek("EOF while parsing a list")
    if (count < fields.length) {
      if (close === "]") this.index++
      throw new Failure(`invalid length ${count}, expected struct ${struct} with ${fields.length} elements`, this.index)
    }
    if (close !== "]") throw new Failure("trailing characters", this.index + 1)
    this.index++
    return values
  }

  private field(field: Field) {
    if (field.kind === "string") return this.stringField()
    if (field.kind === "i64") return this.i64Field()
    return this.statusField()
  }

  private stringField() {
    if (this.peek("EOF while parsing a value") === '"') return this.string()
    const unexpected = this.scalar()
    throw new Failure(`invalid type: ${unexpected}, expected a string`, this.index)
  }

  private i64Field() {
    const next = this.peek("EOF while parsing a value")
    if (next === "n") {
      this.literal("null")
      return undefined
    }
    if (next !== "-" && !isDigit(next)) {
      const unexpected = this.scalar()
      throw new Failure(`invalid type: ${unexpected}, expected i64`, this.index)
    }
    const number = this.number()
    if (number.kind === "float") throw new Failure(`invalid type: ${number.display}, expected i64`, this.index)
    if (number.value > I64_MAX)
      throw new Failure(`invalid value: integer \`${number.value}\`, expected i64`, this.index)
    return Number(number.value)
  }

  private statusField(): StatusVariant {
    const next = this.peek("EOF while parsing a value")
    if (next === '"') return this.variant(this.string())
    if (next !== "{") throw new Failure("expected value", this.index + 1)
    this.index++
    if (this.peek("EOF while parsing a value") !== '"') throw new Failure("expected value", this.index + 1)
    const variant = this.variant(this.string())
    if (this.peek("EOF while parsing an object") !== ":") throw new Failure("expected `:`", this.index + 1)
    this.index++
    if (this.peek("EOF while parsing a value") !== "n") {
      const unexpected = this.scalar()
      throw new Failure(`invalid type: ${unexpected}, expected unit`, this.index)
    }
    this.literal("null")
    if (this.peek("EOF while parsing an object") !== "}") throw new Failure("expected `}`", this.index + 1)
    this.index++
    return variant
  }

  private variant(value: string) {
    const variant = STATUS_VARIANTS.find((entry) => entry === value)
    if (variant) return variant
    const expected = STATUS_VARIANTS.map((entry) => `\`${entry}\``).join(", ")
    throw new Failure(`unknown variant \`${value}\`, expected one of ${expected}`, this.index)
  }

  /** serde_json's `peek_invalid_type`: consumes a scalar and describes it; `[`/`{` are described without consuming. */
  private scalar(): string {
    const next = this.text[this.index]
    if (next === "n") return (this.literal("null"), "null")
    if (next === "t") return (this.literal("true"), "boolean `true`")
    if (next === "f") return (this.literal("false"), "boolean `false`")
    if (next === '"') return `string ${rustDebug(this.string())}`
    if (next === "[") return "sequence"
    if (next === "{") return "map"
    if (next === "-" || isDigit(next)) {
      const number = this.number()
      return number.kind === "float" ? number.display : `integer \`${number.value}\``
    }
    throw new Failure("expected value", this.index + 1)
  }

  private skip(): void {
    const next = this.peek("EOF while parsing a value")
    if (next === "{") return this.skipContainer("}", "EOF while parsing an object", true)
    if (next === "[") return this.skipContainer("]", "EOF while parsing a list", false)
    this.scalar()
  }

  private skipContainer(close: string, eof: string, keyed: boolean) {
    this.index++
    const loop = (first: boolean): void => {
      const next = this.peek(eof)
      if (next === close) return
      if (!first) {
        if (next !== ",") throw new Failure(`expected \`,\` or \`${close}\``, this.index + 1)
        this.index++
        if (this.peek("EOF while parsing a value") === close) throw new Failure("trailing comma", this.index + 1)
      }
      if (keyed) {
        if (this.text[this.index] !== '"') throw new Failure("key must be a string", this.index + 1)
        this.string()
        if (this.peek(eof) !== ":") throw new Failure("expected `:`", this.index + 1)
        this.index++
      }
      this.skip()
      return loop(false)
    }
    loop(true)
    this.index++
  }

  private string() {
    const start = this.index
    this.index++
    const scan = (): void => {
      if (this.index >= this.text.length) throw new Failure("EOF while parsing a string", this.text.length)
      const char = this.text.charCodeAt(this.index)
      if (char === 0x22) return
      if (char < 0x20)
        throw new Failure("control character (\\u0000-\\u001F) found while parsing a string", this.index + 1)
      if (char !== 0x5c) {
        this.index++
        return scan()
      }
      const escape = this.text[this.index + 1]
      if (escape === undefined) throw new Failure("EOF while parsing a string", this.text.length)
      if (escape === "u") {
        const hex = this.text.slice(this.index + 2, this.index + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Failure("invalid escape", this.index + 2 + hexLength(hex) + 1)
        this.index += 6
        return scan()
      }
      if (!'"\\/bfnrt'.includes(escape)) throw new Failure("invalid escape", this.index + 2)
      this.index += 2
      return scan()
    }
    scan()
    this.index++
    return JSON.parse(this.text.slice(start, this.index)) as string
  }

  private number() {
    const start = this.index
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.slice(start))
    if (!match || match[0] === "-") throw new Failure("invalid number", start + (match?.[0].length ?? 0) + 1)
    this.index = start + match[0].length
    if (isDigit(this.text[this.index]) || this.text[this.index] === ".")
      throw new Failure("invalid number", this.index + 1)
    if (match[2] !== undefined || match[3] !== undefined) return float(Number(match[0]), this.index)
    const value = BigInt(match[0])
    if (match[0].startsWith("-")) {
      if (value === 0n) return float(-0, this.index)
      if (value < I64_MIN) return float(Number(match[0]), this.index)
      return { kind: "integer" as const, value }
    }
    if (value > U64_MAX) return float(Number(match[0]), this.index)
    return { kind: "integer" as const, value }
  }

  private literal(word: string) {
    const actual = this.text.slice(this.index, this.index + word.length)
    const mismatch = [...word].findIndex((char, offset) => actual[offset] !== char)
    if (mismatch === -1) {
      this.index += word.length
      return
    }
    if (this.index + mismatch >= this.text.length) throw new Failure("EOF while parsing a value", this.text.length)
    throw new Failure("expected ident", this.index + mismatch + 1)
  }

  private whitespace() {
    const match = /^[ \t\n\r]*/.exec(this.text.slice(this.index))
    this.index += match?.[0].length ?? 0
  }

  private peek(eof: string) {
    this.whitespace()
    if (this.index >= this.text.length) throw new Failure(eof, this.text.length)
    return this.text[this.index]
  }

  private position(index: number) {
    const lineStart = this.text.lastIndexOf("\n", index - 1) + 1
    const line = this.text.slice(0, lineStart).split("\n").length
    return `line ${line} column ${ENCODER.encode(this.text.slice(lineStart, index)).length}`
  }
}

function attempt<T>(body: () => T): T | Failure {
  try {
    return body()
  } catch (error) {
    if (error instanceof Failure) return error
    throw error
  }
}

function float(value: number, index: number) {
  if (!Number.isFinite(value)) throw new Failure("number out of range", index)
  return { kind: "float" as const, display: `floating point \`${formatFloat(value)}\`` }
}

/** serde_json formats floats in errors with `zmij`: shortest round-trip digits, fixed notation for 1e-5 <= |x| < 1e16. */
export function formatFloat(value: number) {
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"
  const exponent = Number(value.toExponential().split("e")[1])
  if (exponent < -5 || exponent >= 16) return value.toExponential()
  const fixed = String(value)
  return fixed.includes(".") ? fixed : `${fixed}.0`
}

/** Rust's `{:?}` for `str`, used by serde's `Unexpected::Str`. */
function rustDebug(value: string) {
  const body = [...value]
    .map((char) => {
      if (char === "\\") return "\\\\"
      if (char === '"') return '\\"'
      if (char === "\n") return "\\n"
      if (char === "\r") return "\\r"
      if (char === "\t") return "\\t"
      if (char === "\0") return "\\0"
      const code = char.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) return `\\u{${code.toString(16)}}`
      return char
    })
    .join("")
  return `"${body}"`
}

function hexLength(hex: string) {
  const invalid = [...hex].findIndex((char) => !/[0-9a-fA-F]/.test(char))
  return invalid === -1 ? hex.length : invalid
}

function isDigit(char: string | undefined) {
  return char !== undefined && char >= "0" && char <= "9"
}

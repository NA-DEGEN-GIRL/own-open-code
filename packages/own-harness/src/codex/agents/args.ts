// Decodes tool arguments the way Codex does: `serde_json::from_str` into a flat `#[derive(Deserialize)]` struct with
// `#[serde(deny_unknown_fields)]` (codex-rs/core/src/tools/handlers/mod.rs `parse_arguments`), reproducing serde's error
// texts and serde_json's `at line L column C` positions (UTF-8 byte columns) so the model sees Codex's messages.
// Ported from serde_json 1.0.149 `de.rs`/`read.rs`/`error.rs` (floats printed by zmij 1.0.19) and serde 1.0.228's
// `de::Error` texts and derive visitors, the versions openai/codex (Apache-2.0) @ rust-v0.162.1 locks.
//
// Not reproduced: serde_json's recursion limit (irrelevant for flat structs) and its float parsing, which is not
// always correctly rounded (here `Number()` is), so a float's printed digits can differ in the last place.
export * as AgentArgs from "./args.js"

/** `strings` is `Vec<String>`; `inputs` is `Vec<UserInput>` (codex-rs/protocol/src/user_input.rs). */
export type FieldType = "string" | "i64" | "bool" | "effort" | "strings" | "inputs"

export interface Field {
  readonly name: string
  readonly type: FieldType
  /** Required fields are Rust `String`; the others are `Option<_>` (absent or `null` is `None`). */
  readonly required?: boolean
  /**
   * `#[serde(default)]` on a non-`Option` field: absent (also a missing trailing array element) leaves it unset for
   * the caller's default, while `null` is a type error.
   */
  readonly default?: boolean
}

export interface Struct {
  /** The Rust struct name, as serde reports it in `expected struct <name>`. */
  readonly name: string
  readonly fields: ReadonlyArray<Field>
  /** Without `#[serde(deny_unknown_fields)]`: other keys are skipped (`IgnoredAny`), their values still parsed. */
  readonly ignoreUnknownFields?: boolean
}

/** Codex's `UserInput` in its serde JSON shape (the internally tagged `type` and the fields own uses). */
export type UserInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly image_url: string; readonly detail?: ImageDetail }
  | { readonly type: "image"; readonly file_id: string; readonly detail?: ImageDetail }
  | { readonly type: "local_image"; readonly path: string; readonly detail?: ImageDetail }
  | { readonly type: "audio"; readonly audio_url: string }
  | { readonly type: "local_audio"; readonly path: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string }
  | { readonly type: "mention"; readonly name: string; readonly path: string }

export type ImageDetail = "auto" | "low" | "high" | "original"

export type Value = string | bigint | boolean | ReadonlyArray<string> | ReadonlyArray<UserInput>

export type Parsed =
  | { readonly ok: true; readonly values: ReadonlyMap<string, Value> }
  | { readonly ok: false; readonly error: string }

/** `parse_arguments`: the decoded fields, or Codex's `failed to parse function arguments: …` text. */
export function parse(struct: Struct, json: string): Parsed {
  const reader = new Reader(json)
  const outcome = attempt(() => {
    const values = reader.deserializeStruct(struct)
    reader.end()
    return values
  })
  if ("error" in outcome) return { ok: false, error: `failed to parse function arguments: ${outcome.error.display()}` }
  return { ok: true, values: outcome.value }
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder("utf-8")
const U64_MAX = 2n ** 64n - 1n
const I64_MAX = 2n ** 63n - 1n
const I64_MIN_MAGNITUDE = 2n ** 63n

class SerdeError {
  constructor(
    readonly message: string,
    public line = 0,
    public column = 0,
  ) {}

  display() {
    return this.line === 0 ? this.message : `${this.message} at line ${this.line} column ${this.column}`
  }
}

type Outcome<A> = { readonly value: A } | { readonly error: SerdeError }

// The parser unwinds on the first error like serde's `?`; this is the one place that catches it.
function attempt<A>(run: () => A): Outcome<A> {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof SerdeError) return { error }
    throw error
  }
}

type ParsedNumber =
  | { readonly kind: "u64"; readonly value: bigint }
  | { readonly kind: "i64"; readonly value: bigint }
  | { readonly kind: "f64"; readonly value: number }

const CODES = {
  eofList: "EOF while parsing a list",
  eofObject: "EOF while parsing an object",
  eofString: "EOF while parsing a string",
  eofValue: "EOF while parsing a value",
  colon: "expected `:`",
  listCommaOrEnd: "expected `,` or `]`",
  objectCommaOrEnd: "expected `,` or `}`",
  ident: "expected ident",
  value: "expected value",
  escape: "invalid escape",
  number: "invalid number",
  range: "number out of range",
  control: "control character (\\u0000-\\u001F) found while parsing a string",
  key: "key must be a string",
  loneSurrogate: "lone leading surrogate in hex escape",
  trailingComma: "trailing comma",
  trailingCharacters: "trailing characters",
  hexEnd: "unexpected end of hex escape",
} as const

const WHITESPACE = new Set([0x20, 0x0a, 0x09, 0x0d])
const QUOTE = 0x22
const BACKSLASH = 0x5c

class Reader {
  private readonly bytes: Uint8Array
  private index = 0

  constructor(json: string) {
    this.bytes = ENCODER.encode(json)
  }

  deserializeStruct(struct: Struct) {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    if (peek !== 0x7b && peek !== 0x5b) throw this.fix(this.peekInvalidType(`struct ${struct.name}`))
    this.index += 1
    // serde_json evaluates `(visit_map, end_map)` together and reports the visitor's error first. A JSON array fills
    // the struct positionally (serde derive's `visit_seq`).
    const visited = attempt(() => (peek === 0x7b ? this.visitMap(struct) : this.visitSeq(struct)))
    const ended = attempt(() => (peek === 0x7b ? this.endMap() : this.endSeq()))
    if ("error" in visited) throw this.fix(visited.error)
    if ("error" in ended) throw this.fix(ended.error)
    return visited.value
  }

  end() {
    if (this.whitespace() !== undefined) throw this.peekError(CODES.trailingCharacters)
  }

  private visitMap(struct: Struct) {
    const values = new Map<string, Value>()
    const read = (first: boolean): void => {
      const key = this.nextKey(first)
      if (key === undefined) return
      const field = struct.fields.find((candidate) => candidate.name === key)
      if (field === undefined && !struct.ignoreUnknownFields) throw new SerdeError(unknownField(key, struct.fields))
      if (values.has(key)) throw new SerdeError(`duplicate field \`${key}\``)
      this.objectColon()
      if (field === undefined) {
        this.ignoreValue()
        return read(false)
      }
      const value = field.required || field.default ? this.deserialize(field.type) : this.deserializeOption(field.type)
      if (value !== undefined) values.set(key, value)
      read(false)
    }
    read(true)
    const missing = struct.fields.find((field) => field.required && !values.has(field.name))
    if (missing !== undefined) throw new SerdeError(`missing field \`${missing.name}\``)
    return values
  }

  /** `MapAccess::next_key_seed` (`has_next_key`, then the key string). */
  private nextKey(first: boolean) {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofObject)
    if (peek === 0x7d) return undefined
    if (first && peek !== QUOTE) throw this.peekError(CODES.key)
    if (!first) {
      if (peek !== 0x2c) throw this.peekError(CODES.objectCommaOrEnd)
      this.index += 1
      const next = this.whitespace()
      if (next === 0x7d) throw this.peekError(CODES.trailingComma)
      if (next === undefined) throw this.peekError(CODES.eofValue)
      if (next !== QUOTE) throw this.peekError(CODES.key)
    }
    this.index += 1
    return this.parseString()
  }

  /** serde derive's `visit_seq`: every field in declaration order, `Option` fields included. */
  private visitSeq(struct: Struct) {
    const count = struct.fields.length
    const expected = `struct ${struct.name} with ${count} element${count === 1 ? "" : "s"}`
    return struct.fields.reduce((values, field, position) => {
      if (!this.hasNextElement(position === 0)) {
        if (field.default) return values
        throw new SerdeError(`invalid length ${position}, expected ${expected}`)
      }
      const value = field.required || field.default ? this.deserialize(field.type) : this.deserializeOption(field.type)
      if (value !== undefined) values.set(field.name, value)
      return values
    }, new Map<string, Value>())
  }

  private hasNextElement(first: boolean) {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofList)
    if (peek === 0x5d) return false
    if (first) return true
    if (peek !== 0x2c) throw this.peekError(CODES.listCommaOrEnd)
    this.index += 1
    const next = this.whitespace()
    if (next === 0x5d) throw this.peekError(CODES.trailingComma)
    if (next === undefined) throw this.peekError(CODES.eofValue)
    return true
  }

  private endSeq() {
    const peek = this.whitespace()
    if (peek === 0x5d) {
      this.index += 1
      return
    }
    if (peek === undefined) throw this.peekError(CODES.eofList)
    if (peek !== 0x2c) throw this.peekError(CODES.trailingCharacters)
    this.index += 1
    throw this.peekError(this.whitespace() === 0x5d ? CODES.trailingComma : CODES.trailingCharacters)
  }

  private objectColon() {
    const peek = this.whitespace()
    if (peek === 0x3a) {
      this.index += 1
      return
    }
    if (peek === undefined) throw this.peekError(CODES.eofObject)
    throw this.peekError(CODES.colon)
  }

  private endMap() {
    const peek = this.whitespace()
    if (peek === 0x7d) {
      this.index += 1
      return
    }
    if (peek === 0x2c) throw this.peekError(CODES.trailingComma)
    if (peek === undefined) throw this.peekError(CODES.eofObject)
    throw this.peekError(CODES.trailingCharacters)
  }

  private deserializeOption(type: FieldType) {
    if (this.whitespace() !== 0x6e) return this.deserialize(type)
    this.index += 1
    this.ident("ull")
    return undefined
  }

  private deserialize(type: FieldType): Value {
    if (type === "bool") return this.deserializeBool()
    if (type === "i64") return this.deserializeI64()
    if (type === "strings") return this.deserializeSeq(() => this.deserializeString())
    if (type === "inputs") return this.deserializeSeq(() => this.deserializeUserInput())
    const text = this.deserializeString()
    // `ReasoningEffort::from_str` (codex-rs/protocol/src/openai_models.rs): any other text is a custom effort.
    if (type === "effort" && text === "") throw new SerdeError("reasoning_effort must not be empty")
    return text
  }

  private deserializeString() {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    if (peek !== QUOTE) throw this.fix(this.peekInvalidType("a string"))
    this.index += 1
    return this.parseString()
  }

  private deserializeBool() {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    if (peek === 0x74 || peek === 0x66) {
      this.index += 1
      this.ident(peek === 0x74 ? "rue" : "alse")
      return peek === 0x74
    }
    throw this.fix(this.peekInvalidType("a boolean"))
  }

  private deserializeI64() {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    const number = (() => {
      if (peek === 0x2d) {
        this.index += 1
        return this.parseInteger(false)
      }
      if (isDigit(peek)) return this.parseInteger(true)
      throw this.fix(this.peekInvalidType("i64"))
    })()
    if (number.kind === "f64")
      throw this.fix(new SerdeError(`invalid type: floating point \`${floatDisplay(number.value)}\`, expected i64`))
    if (number.kind === "u64" && number.value > I64_MAX)
      throw this.fix(new SerdeError(`invalid value: integer \`${number.value}\`, expected i64`))
    return number.value
  }

  /** serde_json `deserialize_seq` with serde's `Vec` visitor. */
  private deserializeSeq<A>(element: () => A): ReadonlyArray<A> {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    if (peek !== 0x5b) throw this.fix(this.peekInvalidType("a sequence"))
    this.index += 1
    const visited = attempt(() => {
      const values: Array<A> = []
      while (this.hasNextElement(values.length === 0)) values.push(element())
      return values
    })
    const ended = attempt(() => this.endSeq())
    if ("error" in visited) throw this.fix(visited.error)
    if ("error" in ended) throw this.fix(ended.error)
    return visited.value
  }

  /**
   * serde's internally tagged `UserInput`: `deserialize_any` buffers the map (reading `type` as the variant
   * identifier), then the variant is decoded from the buffered content. Errors from that second stage carry no
   * position; the enclosing `deserialize_seq` places them after its `end_seq`, as serde_json does.
   */
  private deserializeUserInput(): UserInput {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    if (peek === 0x5b) {
      // serde reads a sequence's first element as the tag and the rest positionally; models never send that form,
      // so it is reported rather than decoded.
      this.ignoreValue()
      throw this.fix(new SerdeError(`invalid type: sequence, expected ${USER_INPUT}`))
    }
    if (peek !== 0x7b) throw this.fix(this.peekInvalidType(USER_INPUT))
    this.index += 1
    const visited = attempt(() => this.visitTaggedMap())
    const ended = attempt(() => this.endMap())
    if ("error" in visited) throw this.fix(visited.error)
    if ("error" in ended) throw this.fix(ended.error)
    const tagged = visited.value
    // Raised inside `deserialize_any`, so it is placed right after the map; variant errors below are not.
    if (tagged.tag === undefined) throw this.fix(new SerdeError("missing field `type`"))
    return userInput(tagged.tag, tagged.entries)
  }

  private visitTaggedMap() {
    const entries: Array<readonly [string, Content]> = []
    const read = (first: boolean, tag: Variant | undefined): Variant | undefined => {
      const key = this.nextKey(first)
      if (key === undefined) return tag
      if (key === "type") {
        if (tag !== undefined) throw new SerdeError("duplicate field `type`")
        this.objectColon()
        return read(false, this.deserializeVariant())
      }
      this.objectColon()
      this.whitespace()
      const start = this.index
      this.ignoreValue()
      const raw = DECODER.decode(this.bytes.subarray(start, this.index))
      entries.push([key, { raw, value: JSON.parse(raw) }])
      return read(false, tag)
    }
    return { tag: read(true, undefined), entries }
  }

  /** serde_json `deserialize_identifier` (a string) for the `UserInput` variant. */
  private deserializeVariant(): Variant {
    const peek = this.whitespace()
    if (peek === undefined) throw this.peekError(CODES.eofValue)
    if (peek !== QUOTE) throw this.fix(this.peekInvalidType("variant identifier"))
    this.index += 1
    const name = this.parseString()
    const variant = VARIANTS.find((candidate) => candidate === name)
    if (variant === undefined) throw this.fix(new SerdeError(unknownVariant(name, VARIANTS)))
    return variant
  }

  /** serde_json `ignore_value`: skips one value (an unknown field's), raising the same syntax errors. */
  private ignoreValue() {
    const frames: Array<number> = []
    const scalar = (peek: number) => {
      if (peek === 0x6e || peek === 0x74 || peek === 0x66) {
        this.index += 1
        this.ident(peek === 0x6e ? "ull" : peek === 0x74 ? "rue" : "alse")
        return
      }
      if (peek === 0x2d || isDigit(peek)) {
        if (peek === 0x2d) this.index += 1
        this.ignoreInteger()
        return
      }
      if (peek === QUOTE) {
        this.index += 1
        this.ignoreString()
        return
      }
      throw this.peekError(CODES.value)
    }
    // After a scalar or a closed container: a comma, or the end of the enclosing containers.
    const close = (frame: number, acceptComma: boolean): number | undefined => {
      const next = this.whitespace()
      if (next === 0x2c && acceptComma) {
        this.index += 1
        return frame
      }
      const closes = (next === 0x5d && frame === 0x5b) || (next === 0x7d && frame === 0x7b)
      if (next === undefined) throw this.peekError(frame === 0x5b ? CODES.eofList : CODES.eofObject)
      if (!closes) {
        if (acceptComma) throw this.peekError(frame === 0x5b ? CODES.listCommaOrEnd : CODES.objectCommaOrEnd)
        return frame
      }
      this.index += 1
      const outer = frames.pop()
      return outer === undefined ? undefined : close(outer, true)
    }
    // A loop rather than recursion: an ignored array may hold more elements than the call stack has frames.
    let enclosing: number | undefined
    while (true) {
      const peek = this.whitespace()
      if (peek === undefined) throw this.peekError(CODES.eofValue)
      const opened = peek === 0x5b || peek === 0x7b
      if (opened) {
        if (enclosing !== undefined) frames.push(enclosing)
        this.index += 1
      }
      if (!opened) scalar(peek)
      const current = opened ? peek : (enclosing ?? frames.pop())
      if (current === undefined) return
      const frame = close(current, !opened)
      if (frame === undefined) return
      if (frame === 0x7b) this.objectKey()
      enclosing = frame
    }
  }

  /** The key and colon `ignore_value` reads before each object member. */
  private objectKey() {
    const quote = this.whitespace()
    if (quote === undefined) throw this.peekError(CODES.eofObject)
    if (quote !== QUOTE) throw this.peekError(CODES.key)
    this.index += 1
    this.ignoreString()
    const colon = this.whitespace()
    if (colon === undefined) throw this.peekError(CODES.eofObject)
    if (colon !== 0x3a) throw this.peekError(CODES.colon)
    this.index += 1
  }

  private ignoreInteger() {
    const first = this.nextByte() ?? 0
    if (first === 0x30) {
      if (isDigit(this.peek() ?? 0)) throw this.peekError(CODES.number)
    }
    if (first !== 0x30 && !isDigit(first)) throw this.error(CODES.number)
    if (first !== 0x30) this.digits()
    const next = this.peek()
    if (next === 0x2e) return this.ignoreDecimal()
    if (next === 0x65 || next === 0x45) this.ignoreExponent()
  }

  private ignoreDecimal() {
    this.index += 1
    const start = this.index
    this.digits()
    if (this.index === start) throw this.peekError(CODES.number)
    const next = this.peek()
    if (next === 0x65 || next === 0x45) this.ignoreExponent()
  }

  private ignoreExponent() {
    this.index += 1
    const sign = this.peek()
    if (sign === 0x2b || sign === 0x2d) this.index += 1
    if (!isDigit(this.nextByte() ?? 0)) throw this.error(CODES.number)
    this.digits()
  }

  /** `SliceRead::ignore_str`: escapes are checked for shape only; a control character is not consumed. */
  private ignoreString() {
    while (true) {
      if (this.index >= this.bytes.length) throw this.error(CODES.eofString)
      const byte = this.bytes[this.index]!
      if (byte === QUOTE) {
        this.index += 1
        return
      }
      if (byte < 0x20) throw this.error(CODES.control)
      this.index += 1
      if (byte !== BACKSLASH) continue
      const escape = this.nextByte()
      if (escape === undefined) throw this.error(CODES.eofString)
      if (escape === 0x75) this.hexEscape()
      if (escape !== 0x75 && !SIMPLE_ESCAPES.has(escape)) throw this.error(CODES.escape)
    }
  }

  /** `peek_invalid_type`: consumes scalars to describe them; arrays and objects are only peeked. */
  private peekInvalidType(expected: string) {
    const peek = this.peek()
    const unexpected = (() => {
      if (peek === 0x6e) {
        this.index += 1
        this.ident("ull")
        return "null"
      }
      if (peek === 0x74 || peek === 0x66) {
        this.index += 1
        this.ident(peek === 0x74 ? "rue" : "alse")
        return `boolean \`${peek === 0x74}\``
      }
      if (peek === 0x2d || (peek !== undefined && isDigit(peek))) {
        if (peek === 0x2d) this.index += 1
        const number = this.parseInteger(peek !== 0x2d)
        return number.kind === "f64"
          ? `floating point \`${floatDisplay(number.value)}\``
          : `integer \`${number.value}\``
      }
      if (peek === QUOTE) {
        this.index += 1
        return `string ${rustDebug(this.parseString())}`
      }
      if (peek === 0x5b) return "sequence"
      if (peek === 0x7b) return "map"
      return undefined
    })()
    if (unexpected === undefined) return this.peekError(CODES.value)
    return new SerdeError(`invalid type: ${unexpected}, expected ${expected}`)
  }

  private parseInteger(positive: boolean): ParsedNumber {
    const first = this.nextByte()
    if (first === undefined) throw this.error(CODES.eofValue)
    if (first === 0x30) {
      const next = this.peek()
      if (next !== undefined && isDigit(next)) throw this.peekError(CODES.number)
      return this.parseNumber(positive, 0n, this.index - 1)
    }
    if (!isDigit(first)) throw this.error(CODES.number)
    const start = this.index - 1
    const significand = (value: bigint): bigint => {
      const next = this.peek()
      if (next === undefined || !isDigit(next)) return value
      const grown = value * 10n + BigInt(next - 0x30)
      if (grown > U64_MAX) return -1n
      this.index += 1
      return significand(grown)
    }
    const value = significand(BigInt(first - 0x30))
    if (value >= 0n) return this.parseNumber(positive, value, start)
    // `parse_long_integer`: the rest of the digits make it a float.
    this.digits()
    return this.parseNumber(positive, U64_MAX, start, true)
  }

  private parseNumber(positive: boolean, significand: bigint, start: number, long = false): ParsedNumber {
    const next = this.peek()
    if (next === 0x2e) {
      this.index += 1
      const after = this.peek()
      if (after === undefined || !isDigit(after))
        throw this.peekError(after === undefined ? CODES.eofValue : CODES.number)
      this.digits()
      if (this.peek() === 0x65 || this.peek() === 0x45) this.exponent()
      return this.float(positive, start)
    }
    if (next === 0x65 || next === 0x45) {
      this.exponent()
      return this.float(positive, start)
    }
    if (long) return this.float(positive, start)
    if (positive) return { kind: "u64", value: significand }
    // `-0` and magnitudes past i64::MIN become floats.
    if (significand === 0n || significand > I64_MIN_MAGNITUDE) return { kind: "f64", value: -Number(significand) }
    return { kind: "i64", value: -significand }
  }

  private exponent() {
    this.index += 1
    const sign = this.peek()
    if (sign === 0x2b || sign === 0x2d) this.index += 1
    const first = this.nextByte()
    if (first === undefined) throw this.error(CODES.eofValue)
    if (!isDigit(first)) throw this.error(CODES.number)
    this.digits()
  }

  private float(positive: boolean, start: number): ParsedNumber {
    const magnitude = Number(DECODER.decode(this.bytes.subarray(start, this.index)))
    if (!Number.isFinite(magnitude)) throw this.error(CODES.range)
    return { kind: "f64", value: positive ? magnitude : -magnitude }
  }

  private digits() {
    while (this.index < this.bytes.length && isDigit(this.bytes[this.index]!)) this.index += 1
  }

  private parseString() {
    const parts: Array<string> = []
    // Byte loop rather than recursion: a message argument may be far longer than the call stack.
    let start = this.index
    while (true) {
      if (this.index >= this.bytes.length) throw this.error(CODES.eofString)
      const byte = this.bytes[this.index]!
      if (byte === QUOTE) {
        parts.push(DECODER.decode(this.bytes.subarray(start, this.index)))
        this.index += 1
        return parts.join("")
      }
      if (byte === BACKSLASH) {
        parts.push(DECODER.decode(this.bytes.subarray(start, this.index)))
        this.index += 1
        parts.push(this.escape())
        start = this.index
        continue
      }
      this.index += 1
      if (byte < 0x20) throw this.error(CODES.control)
    }
  }

  private escape() {
    const byte = this.nextByte()
    if (byte === undefined) throw this.error(CODES.eofString)
    const simple: Readonly<Record<number, string>> = {
      0x22: '"',
      0x5c: "\\",
      0x2f: "/",
      0x62: "\b",
      0x66: "\f",
      0x6e: "\n",
      0x72: "\r",
      0x74: "\t",
    }
    if (simple[byte] !== undefined) return simple[byte]
    if (byte !== 0x75) throw this.error(CODES.escape)
    const lead = this.hexEscape()
    if (lead >= 0xdc00 && lead <= 0xdfff) throw this.error(CODES.loneSurrogate)
    if (lead < 0xd800 || lead > 0xdbff) return String.fromCharCode(lead)
    if (this.peek() === undefined) throw this.error(CODES.eofString)
    if (this.nextByte() !== BACKSLASH) throw this.error(CODES.hexEnd)
    if (this.peek() === undefined) throw this.error(CODES.eofString)
    if (this.nextByte() !== 0x75) throw this.error(CODES.hexEnd)
    const trail = this.hexEscape()
    if (trail < 0xdc00 || trail > 0xdfff) throw this.error(CODES.loneSurrogate)
    return String.fromCharCode(lead, trail)
  }

  /** `SliceRead::decode_hex_escape`: takes four bytes, then validates them. */
  private hexEscape() {
    if (this.index + 4 > this.bytes.length) {
      this.index = this.bytes.length
      throw this.error(CODES.eofString)
    }
    const digits = Array.from(this.bytes.subarray(this.index, this.index + 4), hexValue)
    this.index += 4
    if (digits.some((digit) => digit === undefined)) throw this.error(CODES.escape)
    return digits.reduce<number>((value, digit) => value * 16 + (digit ?? 0), 0)
  }

  private ident(rest: string) {
    Array.from(rest).forEach((expected) => {
      const byte = this.nextByte()
      if (byte === undefined) throw this.error(CODES.eofValue)
      if (byte !== expected.charCodeAt(0)) throw this.error(CODES.ident)
    })
  }

  private whitespace() {
    while (this.index < this.bytes.length && WHITESPACE.has(this.bytes[this.index]!)) this.index += 1
    return this.peek()
  }

  private peek() {
    return this.index < this.bytes.length ? this.bytes[this.index] : undefined
  }

  private nextByte() {
    const byte = this.peek()
    if (byte !== undefined) this.index += 1
    return byte
  }

  private error(message: string) {
    return this.at(new SerdeError(message), this.index)
  }

  private peekError(message: string) {
    return this.at(new SerdeError(message), Math.min(this.index + 1, this.bytes.length))
  }

  /** `fix_position`: an error raised without a position gets the reader's current one. */
  private fix(error: SerdeError) {
    return error.line === 0 ? this.at(error, this.index) : error
  }

  private at(error: SerdeError, index: number) {
    const head = this.bytes.subarray(0, index)
    const startOfLine = head.lastIndexOf(0x0a) + 1
    error.line = 1 + head.subarray(0, startOfLine).filter((byte) => byte === 0x0a).length
    error.column = index - startOfLine
    return error
  }
}

function isDigit(byte: number) {
  return byte >= 0x30 && byte <= 0x39
}

function hexValue(byte: number) {
  if (isDigit(byte)) return byte - 0x30
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37
  return undefined
}

/** serde's `unknown_field` with `OneOf`. */
function unknownField(key: string, fields: ReadonlyArray<Field>) {
  return `unknown field \`${key}\`, ${oneOf(fields.map((field) => field.name))}`
}

function unknownVariant(name: string, variants: ReadonlyArray<string>) {
  return `unknown variant \`${name}\`, ${oneOf(variants)}`
}

function oneOf(names: ReadonlyArray<string>) {
  const quoted = names.map((name) => `\`${name}\``)
  if (quoted.length === 0) return "there are no fields"
  if (quoted.length === 1) return `expected ${quoted[0]}`
  if (quoted.length === 2) return `expected ${quoted[0]} or ${quoted[1]}`
  return `expected one of ${quoted.join(", ")}`
}

// ---------------------------------------------------------------------------------------------------------------
// `UserInput` from serde's buffered `Content`

const USER_INPUT = "internally tagged enum UserInput"
const VARIANTS = ["text", "image", "local_image", "audio", "local_audio", "skill", "mention"] as const
type Variant = (typeof VARIANTS)[number]
const IMAGE_DETAILS: ReadonlyArray<ImageDetail> = ["auto", "low", "high", "original"]
const SIMPLE_ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74])

/** A buffered value: its JSON text (to tell `1` from `1.0`, as serde's `Content` does) and its parsed form. */
interface Content {
  readonly raw: string
  readonly value: unknown
}

type ContentKind = "string" | "path" | "sequence" | "detail"

interface ContentField {
  readonly name: string
  readonly kind: ContentKind
  readonly required: boolean
}

const VARIANT_FIELDS: Readonly<Record<Exclude<Variant, "image">, ReadonlyArray<ContentField>>> = {
  text: [
    { name: "text", kind: "string", required: true },
    { name: "text_elements", kind: "sequence", required: false },
  ],
  local_image: [
    { name: "path", kind: "path", required: true },
    { name: "detail", kind: "detail", required: false },
  ],
  audio: [{ name: "audio_url", kind: "string", required: true }],
  local_audio: [{ name: "path", kind: "path", required: true }],
  skill: [
    { name: "name", kind: "string", required: true },
    { name: "path", kind: "path", required: true },
  ],
  mention: [
    { name: "name", kind: "string", required: true },
    { name: "path", kind: "string", required: true },
  ],
}

/**
 * Decodes a variant's struct from the buffered entries: unknown keys are ignored, a repeated known key is
 * `duplicate field`, then the first missing required field (declaration order) is reported. `image` flattens the
 * untagged `ImageReference` (`{image_url}` or `{file_id}`) beside `detail`. `text_elements` is checked to be a
 * sequence only; own does not use its byte ranges.
 */
function userInput(variant: Variant, entries: ReadonlyArray<readonly [string, Content]>): UserInput {
  const fields =
    variant === "image" ? [{ name: "detail", kind: "detail", required: false } as const] : VARIANT_FIELDS[variant]
  const values = entries.reduce((decoded, [key, content]) => {
    const field = fields.find((candidate) => candidate.name === key)
    if (field === undefined) return decoded
    if (decoded.has(key)) throw new SerdeError(`duplicate field \`${key}\``)
    return decoded.set(key, decodeContent(field.kind, content))
  }, new Map<string, unknown>())
  const missing = fields.find((field) => field.required && !values.has(field.name))
  if (missing !== undefined) throw new SerdeError(`missing field \`${missing.name}\``)
  const detail = IMAGE_DETAILS.find((candidate) => candidate === values.get("detail"))
  const withDetail = detail === undefined ? {} : { detail }
  const text = (name: string) => String(values.get(name))
  if (variant === "image") return { ...imageReference(entries.filter(([key]) => key !== "detail")), ...withDetail }
  if (variant === "text") return { type: "text", text: text("text") }
  if (variant === "local_image") return { type: "local_image", path: text("path"), ...withDetail }
  if (variant === "audio") return { type: "audio", audio_url: text("audio_url") }
  if (variant === "local_audio") return { type: "local_audio", path: text("path") }
  if (variant === "skill") return { type: "skill", name: text("name"), path: text("path") }
  return { type: "mention", name: text("name"), path: text("path") }
}

function imageReference(entries: ReadonlyArray<readonly [string, Content]>) {
  const string = (name: string) => {
    const found = entries.find(([key]) => key === name)?.[1].value
    return typeof found === "string" ? found : undefined
  }
  const imageUrl = string("image_url")
  if (imageUrl !== undefined) return { type: "image", image_url: imageUrl } as const
  const fileId = string("file_id")
  if (fileId !== undefined) return { type: "image", file_id: fileId } as const
  throw new SerdeError("data did not match any variant of untagged enum ImageReference")
}

function decodeContent(kind: ContentKind, content: Content) {
  const value = content.value
  if (kind === "detail") {
    if (value === null) return undefined
    if (typeof value !== "string") throw new SerdeError(`invalid type: ${unexpected(content)}, expected string or map`)
    const detail = IMAGE_DETAILS.find((candidate) => candidate === value)
    if (detail === undefined) throw new SerdeError(unknownVariant(value, IMAGE_DETAILS))
    return detail
  }
  if (kind === "sequence") {
    if (!Array.isArray(value)) throw new SerdeError(`invalid type: ${unexpected(content)}, expected a sequence`)
    return value
  }
  if (typeof value === "string") return value
  throw new SerdeError(`invalid type: ${unexpected(content)}, expected ${kind === "path" ? "path string" : "a string"}`)
}

/** serde's `Unexpected` for a buffered value, as serde_json's `JsonUnexpected` prints it (`Unit` is `null`). */
function unexpected(content: Content) {
  const value = content.value
  if (value === null) return "null"
  if (typeof value === "boolean") return `boolean \`${value}\``
  if (typeof value === "string") return `string ${rustDebug(value)}`
  if (Array.isArray(value)) return "sequence"
  if (typeof value === "object") return "map"
  const integer = /^-?(0|[1-9][0-9]*)$/.test(content.raw) ? BigInt(content.raw) : undefined
  const negative = content.raw.startsWith("-")
  const fits =
    integer !== undefined && (negative ? integer !== 0n && -integer <= I64_MIN_MAGNITUDE : integer <= U64_MAX)
  return fits ? `integer \`${integer}\`` : `floating point \`${floatDisplay(Number(content.raw))}\``
}

/**
 * serde_json's `floating point` text (`zmij::Buffer::format`): the shortest round-trip digits, in decimal notation with
 * at least one fractional digit when the decimal exponent is within -5..=15, else `d.ddde+XX` / `de-X`.
 */
export function floatDisplay(value: number) {
  if (Number.isNaN(value)) return "NaN"
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf"
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"
  const scientific = value.toExponential()
  const exponent = Number(scientific.slice(scientific.indexOf("e") + 1))
  if (exponent < -5 || exponent > 15) return scientific
  const decimal = String(value)
  return decimal.includes(".") ? decimal : `${decimal}.0`
}

/** Rust's `{:?}` for `str`: quotes plus `char::escape_debug` (control characters as `\u{…}`). */
export function rustDebug(text: string) {
  const escaped = Array.from(text)
    .map((char) => {
      if (char === "\\") return "\\\\"
      if (char === '"') return '\\"'
      if (char === "\n") return "\\n"
      if (char === "\r") return "\\r"
      if (char === "\t") return "\\t"
      if (char === "\0") return "\\0"
      const code = char.codePointAt(0) ?? 0
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return `\\u{${code.toString(16)}}`
      return char
    })
    .join("")
  return `"${escaped}"`
}

// Minimal YAML subset reader for own/ledger/*.yaml (Node 22, no dependencies).
//
// Supported: block mappings and sequences (including `- key: value` items and `key:` followed by a
// same-indent sequence), flow sequences/mappings on one or more lines, single/double quoted scalars,
// plain scalars (null/~, true/false, integers, floats, everything else is a string — dates stay strings),
// `|`/`>` block scalars, `#` comments, and a leading `---`.
// Not supported (reported as errors): tabs for indentation, anchors/aliases/tags, multi-document streams,
// complex keys. The ledgers are hand-written, so unsupported input fails loudly instead of guessing.

export class YamlError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `line ${line}: ${message}`)
    this.name = "YamlError"
    this.line = line
  }
}

export function parseYaml(text) {
  const parser = new Parser(text)
  const first = parser.peek()
  if (first === undefined) return null
  if (first.text === "---") {
    parser.next()
    if (parser.peek() === undefined) return null
  }
  const value = parser.node(parser.peek().indent)
  const rest = parser.peek()
  if (rest !== undefined) throw new YamlError(`unexpected content "${rest.text}"`, rest.line)
  return value
}

class Parser {
  constructor(text) {
    this.lines = text.replace(/^﻿/, "").split(/\r?\n/)
    this.index = 0
    this.virtual = undefined
  }

  // Next meaningful line (comments and blank lines skipped) without consuming it.
  peek() {
    if (this.virtual !== undefined && this.virtual.index === this.index) return this.virtual
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index]
      const content = stripComment(raw)
      if (content.trim() === "") {
        this.index++
        continue
      }
      const indent = raw.length - raw.trimStart().length
      if (raw.slice(0, indent).includes("\t")) throw new YamlError("tabs are not allowed for indentation", this.index + 1)
      return { index: this.index, indent, text: content.trim(), line: this.index + 1 }
    }
    return undefined
  }

  next() {
    this.virtual = undefined
    this.index++
  }

  node(indent) {
    const token = this.peek()
    if (isSequenceItem(token.text)) return this.sequence(indent)
    if (splitKey(token.text) !== undefined) return this.mapping(indent)
    this.next()
    return this.inline(token.text, token)
  }

  sequence(indent) {
    const items = []
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.indent < indent) break
      if (token.indent > indent) throw new YamlError("bad indentation in sequence", token.line)
      if (!isSequenceItem(token.text)) break
      const rest = token.text.slice(1).trimStart()
      if (rest === "") {
        this.next()
        const child = this.peek()
        items.push(child !== undefined && child.indent > indent ? this.node(child.indent) : null)
        continue
      }
      const column = token.indent + (token.text.length - rest.length)
      if (isSequenceItem(rest) || splitKey(rest) !== undefined) {
        // Re-read the remainder of this line as the first line of a nested block at its own column.
        this.virtual = { index: token.index, indent: column, text: rest, line: token.line }
        items.push(this.node(column))
        continue
      }
      this.next()
      items.push(this.value(rest, token, indent))
    }
    return items
  }

  mapping(indent) {
    const result = {}
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.indent < indent) break
      if (token.indent > indent) throw new YamlError("bad indentation in mapping", token.line)
      if (isSequenceItem(token.text)) break
      const pair = splitKey(token.text)
      if (pair === undefined) throw new YamlError(`expected "key: value", got "${token.text}"`, token.line)
      if (pair.key === "__proto__") throw new YamlError("key __proto__ is not allowed", token.line)
      if (Object.hasOwn(result, pair.key)) throw new YamlError(`duplicate key "${pair.key}"`, token.line)
      this.next()
      if (pair.rest !== "") {
        result[pair.key] = this.value(pair.rest, token, indent)
        continue
      }
      const child = this.peek()
      if (child !== undefined && child.indent > indent) result[pair.key] = this.node(child.indent)
      else if (child !== undefined && child.indent === indent && isSequenceItem(child.text))
        result[pair.key] = this.sequence(indent)
      else result[pair.key] = null
    }
    return result
  }

  // A value that starts on the current (already consumed) line.
  value(text, token, parentIndent) {
    if (/^[|>][+-]?$/.test(text)) return this.blockScalar(text, parentIndent)
    return this.inline(text, token)
  }

  inline(text, token) {
    if (text.startsWith("&") || text.startsWith("*") || text.startsWith("!"))
      throw new YamlError("anchors, aliases and tags are not supported", token.line)
    if (text.startsWith("[") || text.startsWith("{")) return this.flow(text, token)
    return parseScalar(text, token.line)
  }

  flow(text, token) {
    let source = text
    while (!balanced(source)) {
      const next = this.peek()
      if (next === undefined) throw new YamlError("unterminated flow collection", token.line)
      this.next()
      source += " " + next.text
    }
    const reader = new FlowReader(source, token.line)
    const value = reader.value()
    reader.skipSpace()
    if (!reader.done()) throw new YamlError(`unexpected "${source.slice(reader.pos)}" after flow collection`, token.line)
    return value
  }

  blockScalar(header, parentIndent) {
    const lines = []
    let blockIndent
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index]
      if (raw.trim() === "") {
        lines.push("")
        this.index++
        continue
      }
      const indent = raw.length - raw.trimStart().length
      if (indent <= parentIndent) break
      blockIndent ??= indent
      if (indent < blockIndent) break
      lines.push(raw.slice(blockIndent))
      this.index++
    }
    this.virtual = undefined
    const chomp = header.slice(1)
    while (chomp !== "+" && lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    const body = header.startsWith(">") ? foldLines(lines) : lines.join("\n")
    if (chomp === "-") return body
    return body === "" ? "" : body + "\n"
  }
}

class FlowReader {
  constructor(source, line) {
    this.source = source
    this.pos = 0
    this.line = line
  }

  done() {
    return this.pos >= this.source.length
  }

  skipSpace() {
    while (!this.done() && /\s/.test(this.source[this.pos])) this.pos++
  }

  fail(message) {
    throw new YamlError(`${message} in flow collection`, this.line)
  }

  value() {
    this.skipSpace()
    const char = this.source[this.pos]
    if (char === "[") return this.sequence()
    if (char === "{") return this.mapping()
    if (char === '"' || char === "'") return this.quoted()
    return parseScalar(this.plain(",]}"), this.line)
  }

  sequence() {
    this.pos++
    const items = []
    this.skipSpace()
    if (this.source[this.pos] === "]") {
      this.pos++
      return items
    }
    for (;;) {
      items.push(this.value())
      this.skipSpace()
      const char = this.source[this.pos++]
      if (char === "]") return items
      if (char !== ",") this.fail('expected "," or "]"')
      this.skipSpace()
      if (this.source[this.pos] === "]") {
        this.pos++
        return items
      }
    }
  }

  mapping() {
    this.pos++
    const result = {}
    this.skipSpace()
    if (this.source[this.pos] === "}") {
      this.pos++
      return result
    }
    for (;;) {
      this.skipSpace()
      const char = this.source[this.pos]
      const key = char === '"' || char === "'" ? this.quoted() : this.plain(":,}")
      if (typeof key !== "string" || key === "") this.fail("expected a key")
      if (key === "__proto__") this.fail("key __proto__ is not allowed")
      this.skipSpace()
      if (this.source[this.pos++] !== ":") this.fail(`expected ":" after key "${key}"`)
      result[key] = this.value()
      this.skipSpace()
      const separator = this.source[this.pos++]
      if (separator === "}") return result
      if (separator !== ",") this.fail('expected "," or "}"')
      this.skipSpace()
      if (this.source[this.pos] === "}") {
        this.pos++
        return result
      }
    }
  }

  quoted() {
    const end = quotedEnd(this.source, this.pos)
    if (end === -1) this.fail("unterminated quoted string")
    const value = unquote(this.source.slice(this.pos, end + 1), this.line)
    this.pos = end + 1
    return value
  }

  plain(stops) {
    const start = this.pos
    while (!this.done() && !stops.includes(this.source[this.pos])) this.pos++
    return this.source.slice(start, this.pos).trim()
  }
}

function isSequenceItem(text) {
  return text === "-" || text.startsWith("- ")
}

// Split `key: rest` (quoted or plain key). Returns undefined when the line is not a mapping entry.
function splitKey(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text, 0)
    if (end === -1) return undefined
    const after = text.slice(end + 1)
    const match = /^\s*:(?:\s+(.*)|)$/.exec(after)
    if (match === null) return undefined
    return { key: unquote(text.slice(0, end + 1)), rest: (match[1] ?? "").trim() }
  }
  if (/^[[{\-?:,&*!|>%@`]/.test(text) && !/^-[^\s]/.test(text)) return undefined
  const match = /^([^:]*?)\s*:(?:\s+(.*)|)$/.exec(text)
  if (match === null || match[1] === "" || /[\[\]{},]/.test(match[1])) return undefined
  return { key: match[1], rest: (match[2] ?? "").trim() }
}

function parseScalar(text, line) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = quotedEnd(text, 0)
    if (end !== text.length - 1) throw new YamlError(`unexpected text after quoted scalar: ${text}`, line)
    return unquote(text, line)
  }
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null
  if (text === "true" || text === "True" || text === "TRUE") return true
  if (text === "false" || text === "False" || text === "FALSE") return false
  if (/^[-+]?(?:0|[1-9]\d*)$/.test(text)) return Number(text)
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(text) && /[.eE]/.test(text)) return Number(text)
  return text
}

function quotedEnd(text, start) {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++
      continue
    }
    if (text[i] !== quote) continue
    if (quote === "'" && text[i + 1] === "'") {
      i++
      continue
    }
    return i
  }
  return -1
}

const escapes = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", b: "\b", f: "\f" }

function unquote(text, line) {
  const body = text.slice(1, -1)
  if (text[0] === "'") return body.replaceAll("''", "'")
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, code) => {
    if (code.length > 1) return String.fromCharCode(Number.parseInt(code.slice(1), 16))
    if (!(code in escapes)) throw new YamlError(`unknown escape \\${code}`, line)
    return escapes[code]
  })
}

// Remove a trailing `# comment` that sits outside quotes. Quotes only open at token starts, so an
// apostrophe inside a plain scalar ("don't") does not hide a later comment.
function stripComment(line) {
  let quote
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") i++
      else if (char === quote && !(quote === "'" && line[i + 1] === "'")) quote = undefined
      else if (char === quote) i++
      continue
    }
    const previous = i === 0 ? " " : line[i - 1]
    if ((char === '"' || char === "'") && /[\s[{,:-]/.test(previous)) quote = char
    else if (char === "#" && /\s/.test(previous)) return line.slice(0, i)
  }
  return line
}

function balanced(text) {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"' || char === "'") {
      const end = quotedEnd(text, i)
      if (end === -1) return false
      i = end
      continue
    }
    if (char === "[" || char === "{") depth++
    if (char === "]" || char === "}") depth--
  }
  return depth <= 0
}

function foldLines(lines) {
  return lines.reduce((out, line, i) => {
    if (i === 0) return line
    if (line === "" || lines[i - 1] === "") return out + "\n" + line
    return out + " " + line
  }, "")
}

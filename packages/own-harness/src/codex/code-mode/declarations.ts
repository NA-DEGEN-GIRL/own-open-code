// The `exec` description's sections for nested tools, as Codex renders them (rust-v0.162.1):
// codex-rs/code-mode-protocol/src/description.rs (sections, headings, identifiers, `exec tool declaration:`),
// code-mode-protocol/src/json_schema_types.rs (JSON Schema to TypeScript, with its budgets),
// tools/src/json_schema.rs and json_schema/compaction.rs (how Codex lowers an MCP or dynamic tool's input schema before
// it renders it), tools/src/mcp_tool.rs (the CallToolResult output schema) and tools/src/code_mode.rs (names).
// Byte counts are UTF-8 as in Rust; serde_json keeps object key order (the workspace enables `preserve_order`).
export * as CodeModeDeclarations from "./declarations.js"

/** `DEFAULT_INPUT_SCHEMA_MAX_BYTES`: the render budget of one schema. */
export const DEFAULT_INPUT_SCHEMA_MAX_BYTES = 16_000

/** A nested tool as Codex's `ToolDefinition`: its Code Mode name, its `ToolName`, kind and schemas. */
export interface Definition {
  /** `code_mode_name_for_tool_name`: the name before identifier normalization, e.g. `mcp__docs__search`. */
  readonly name: string
  /** `ToolName.namespace`; tools in one namespace are grouped under its `## <namespace>` header. */
  readonly namespace?: string
  /** `ToolName.name`, the name inside the namespace. */
  readonly toolName: string
  readonly description: string
  readonly kind: "function" | "freeform"
  /** A function tool's input JSON Schema, already lowered (`sanitizeInput`); absent renders `unknown`. */
  readonly input?: unknown
  readonly output?: unknown
}

/** `normalize_code_mode_identifier`: the JavaScript name of `tools.<name>`. */
export function identifier(key: string) {
  const normalized = [...key]
    .map((char, index) => (index === 0 ? /^[_$A-Za-z]$/ : /^[_$A-Za-z0-9]$/).test(char) ? char : "_")
    .join("")
  return normalized === "" ? "_" : normalized
}

/** `code_mode_name_for_tool_name`. */
export function codeModeName(namespace: string | undefined, name: string) {
  if (namespace === undefined) return name
  if (namespace.endsWith("_") || name.startsWith("_")) return `${namespace}${name}`
  return `${namespace}__${name}`
}

/** `sanitize_responses_api_tool_name`: MCP server and tool names as the model sees them. */
export function sanitizeName(name: string) {
  const sanitized = [...name].map((char) => (/^[A-Za-z0-9_]$/.test(char) ? char : "_")).join("")
  return sanitized === "" ? "_" : sanitized
}

/** `render_tool_heading`. */
export function heading(definition: Definition) {
  const global = identifier(definition.name)
  return global === definition.name ? `### \`${global}\`` : `### \`${global}\` (\`${definition.name}\`)`
}

/** A tool's section in the `exec` description: its heading, description and declaration. */
export function section(definition: Definition) {
  const body = sample(definition).trim()
  return body === "" ? heading(definition) : `${heading(definition)}\n${body}`
}

/** `render_code_mode_sample_for_definition`: the description, then the tool's TypeScript declaration. */
export function sample(definition: Definition) {
  const input =
    definition.kind === "freeform"
      ? "string"
      : definition.input === undefined
        ? "unknown"
        : render(definition.input)
  const structured = mcpStructuredContent(definition.output)
  const output =
    structured !== undefined
      ? callToolResult(render(structured))
      : definition.output === undefined
        ? "unknown"
        : render(definition.output)
  const parameter = definition.kind === "freeform" ? "input" : "args"
  const declaration = `declare const tools: { ${identifier(definition.name)}(${parameter}: ${input}): Promise<${output}>; };`
  return `${definition.description}\n\nexec tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``
}

const callToolResult = (structured: string) => (structured === "unknown" ? "CallToolResult" : `CallToolResult<${structured}>`)

/** `compare_code_mode_tools`: tools without a namespace first, then by namespace, tool name and Code Mode name. */
export function compare(left: Definition, right: Definition) {
  if (left.namespace !== right.namespace) {
    if (left.namespace === undefined) return -1
    if (right.namespace === undefined) return 1
    return byteOrder(left.namespace, right.namespace)
  }
  return byteOrder(left.toolName, right.toolName) || byteOrder(left.name, right.name)
}

/** `mcp_call_tool_result_output_schema`: an MCP tool's result, with its structured content schema. */
export function mcpOutputSchema(structuredContent: unknown) {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      structuredContent,
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
    additionalProperties: false,
  }
}

/** `mcp_structured_content_schema`: the structured content schema of a CallToolResult output schema. */
function mcpStructuredContent(output: unknown) {
  if (!isObject(output) || !isObject(output.properties)) return undefined
  const properties = output.properties
  const content = properties.content
  if (!isObject(content) || content.type !== "array") return undefined
  if (!isObject(content.items) || content.items.type !== "object") return undefined
  if (!isObject(properties.isError) || properties.isError.type !== "boolean") return undefined
  if (!isObject(properties._meta) || properties._meta.type !== "object") return undefined
  return Object.hasOwn(properties, "structuredContent") ? properties.structuredContent : true
}

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema to TypeScript (json_schema_types.rs)

const MAX_LOCAL_REF_EXPANSIONS_PER_PATH = 2
const MAX_TOTAL_LOCAL_REF_EXPANSIONS = 32
const RENDER_WORK_MULTIPLIER = 4

/** `render_json_schema_to_typescript_with_budget`. */
export function render(schema: unknown, maxBytes = DEFAULT_INPUT_SCHEMA_MAX_BYTES) {
  const rendered = new Renderer(schema, maxBytes).render(schema)
  return bytes(rendered) > maxBytes ? "unknown" : rendered
}

const RENDERABLE = [
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "allOf",
  "type",
  "properties",
  "additionalProperties",
  "required",
  "items",
  "prefixItems",
]

class Renderer {
  private nestedResourceDepth = 0
  private readonly activeRefs = new Map<string, number>()
  private remainingRefs = MAX_TOTAL_LOCAL_REF_EXPANSIONS
  private remainingWork: number
  private exhausted = false

  constructor(
    private readonly root: unknown,
    maxBytes: number,
  ) {
    this.remainingWork = maxBytes * RENDER_WORK_MULTIPLIER
  }

  render(schema: unknown): string {
    if (this.exhausted) return "unknown"
    // A nested `$id` starts a new schema resource; fragment-only refs below it are not the root's.
    const nested = schema !== this.root && isObject(schema) && Object.hasOwn(schema, "$id")
    if (nested) this.nestedResourceDepth += 1
    const rendered =
      schema === true ? "unknown" : schema === false ? "never" : isObject(schema) ? this.renderMap(schema) : "unknown"
    if (nested) this.nestedResourceDepth -= 1
    return this.consume(bytes(rendered)) ? rendered : "unknown"
  }

  private renderMap(map: Record<string, unknown>): string {
    if (this.exhausted) return "unknown"
    if (Object.hasOwn(map, "$ref")) return this.renderRef(map)
    if (Object.hasOwn(map, "const")) return this.literal(map.const)
    if (Array.isArray(map.enum)) {
      const literals: Array<string> = []
      for (const value of map.enum) {
        const literal = this.literal(value)
        if (this.exhausted || !this.consume(bytes(literal))) return "unknown"
        literals.push(literal)
      }
      if (literals.length > 0) return literals.join(" | ")
    }
    for (const key of ["anyOf", "oneOf"]) {
      const variants = map[key]
      if (!Array.isArray(variants)) continue
      const rendered: Array<string> = []
      for (const variant of variants) {
        if (this.exhausted) return "unknown"
        rendered.push(this.render(variant))
      }
      if (rendered.length > 0) return rendered.join(" | ")
    }
    if (Array.isArray(map.allOf)) {
      const rendered: Array<string> = []
      for (const variant of map.allOf) {
        if (this.exhausted) return "unknown"
        const type = this.render(variant)
        rendered.push(type.includes(" | ") ? `(${type})` : type)
      }
      if (rendered.length > 0) return rendered.join(" & ")
    }
    if (Object.hasOwn(map, "type")) {
      if (Array.isArray(map.type)) {
        const rendered: Array<string> = []
        for (const type of map.type.filter((entry) => typeof entry === "string")) {
          if (this.exhausted) return "unknown"
          rendered.push(this.renderType(map, type))
        }
        if (rendered.length > 0) return rendered.join(" | ")
      }
      if (typeof map.type === "string") return this.renderType(map, map.type)
    }
    if (["properties", "additionalProperties", "required"].some((key) => Object.hasOwn(map, key)))
      return this.renderObject(map)
    if (Object.hasOwn(map, "items") || Object.hasOwn(map, "prefixItems")) return this.renderArray(map)
    return "unknown"
  }

  private renderRef(map: Record<string, unknown>) {
    const referenced = this.referenced(map.$ref) ?? "unknown"
    if (this.exhausted) return "unknown"
    const siblings = Object.fromEntries(
      Object.entries(map).filter(([key]) => key !== "$ref" && key !== "$defs" && key !== "definitions"),
    )
    if (!RENDERABLE.some((key) => Object.hasOwn(siblings, key))) return referenced
    const sibling = this.renderMap(siblings)
    if (referenced === "unknown") return sibling
    if (sibling === "unknown") return referenced
    return `(${referenced}) & (${sibling})`
  }

  /** A local `$ref`'s rendering: one nested repetition per path, then `unknown`; `undefined` when it does not resolve. */
  private referenced(ref: unknown) {
    if (this.nestedResourceDepth > 0 || typeof ref !== "string") return undefined
    const pointer = localPointer(ref)
    if (pointer === undefined) return undefined
    const active = this.activeRefs.get(pointer) ?? 0
    if (active >= MAX_LOCAL_REF_EXPANSIONS_PER_PATH || this.remainingRefs === 0) return "unknown"
    const target = pointer === "" ? this.root : resolvePointer(this.root, pointer)
    if (target === undefined) return undefined
    this.remainingRefs -= 1
    this.activeRefs.set(pointer, active + 1)
    const rendered = this.render(target)
    if (active === 0) this.activeRefs.delete(pointer)
    else this.activeRefs.set(pointer, active)
    return rendered
  }

  private renderType(map: Record<string, unknown>, type: string) {
    if (type === "string") return "string"
    if (type === "number" || type === "integer") return "number"
    if (type === "boolean") return "boolean"
    if (type === "null") return "null"
    if (type === "array") return this.renderArray(map)
    if (type === "object") return this.renderObject(map)
    return "unknown"
  }

  private renderArray(map: Record<string, unknown>) {
    if (Object.hasOwn(map, "items")) {
      const item = this.render(map.items)
      if (this.exhausted) return "unknown"
      return `Array<${item}>`
    }
    if (Array.isArray(map.prefixItems)) {
      const items: Array<string> = []
      for (const item of map.prefixItems) {
        if (this.exhausted) return "unknown"
        items.push(this.render(item))
      }
      if (items.length > 0) return `[${items.join(", ")}]`
    }
    return "unknown[]"
  }

  private additionalPropertiesLine(
    lines: Array<string>,
    map: Record<string, unknown>,
    properties: Record<string, unknown>,
    prefix: string,
  ) {
    if (Object.hasOwn(map, "additionalProperties")) {
      const additional = map.additionalProperties
      if (additional === false) return true
      const type = additional === true ? "unknown" : this.render(additional)
      return this.push(lines, `${prefix}[key: string]: ${type};`)
    }
    if (Object.keys(properties).length === 0) return this.push(lines, `${prefix}[key: string]: unknown;`)
    return true
  }

  private property(name: string, value: unknown, required: ReadonlyArray<string>) {
    if (bytes(name) > this.remainingWork) {
      this.exhausted = true
      return "unknown"
    }
    const optional = required.includes(name) ? "" : "?"
    const type = this.render(value)
    if (this.exhausted) return "unknown"
    return `${identifier(name) === name ? name : JSON.stringify(name)}${optional}: ${type};`
  }

  private renderObject(map: Record<string, unknown>) {
    const required = Array.isArray(map.required)
      ? map.required.filter((entry): entry is string => typeof entry === "string")
      : []
    const properties = isObject(map.properties) ? map.properties : {}
    const sorted = Object.entries(properties).toSorted(([left], [right]) => byteOrder(left, right))
    const lines: Array<string> = []
    if (sorted.some(([, value]) => isObject(value) && typeof value.description === "string" && value.description !== "")) {
      if (!this.push(lines, "{")) return "unknown"
      for (const [name, value] of sorted) {
        const description = isObject(value) && typeof value.description === "string" ? value.description : ""
        const comments = description
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
        for (const line of comments) {
          if (bytes(line) + 5 > this.remainingWork || !this.push(lines, `  // ${line}`)) return "unknown"
        }
        const property = this.property(name, value, required)
        if (this.exhausted || !this.push(lines, `  ${property}`)) return "unknown"
      }
      if (!this.additionalPropertiesLine(lines, map, properties, "  ") || !this.push(lines, "}")) return "unknown"
      return lines.join("\n")
    }
    for (const [name, value] of sorted) {
      const property = this.property(name, value, required)
      if (this.exhausted || !this.push(lines, property)) return "unknown"
    }
    if (!this.additionalPropertiesLine(lines, map, properties, "")) return "unknown"
    if (lines.length === 0) return "{}"
    return `{ ${lines.join(" ")} }`
  }

  private literal(value: unknown) {
    if (literalUpperBound(value) > this.remainingWork) {
      this.exhausted = true
      return "unknown"
    }
    return JSON.stringify(value) ?? "unknown"
  }

  private consume(count: number) {
    if (count > this.remainingWork) {
      this.exhausted = true
      return false
    }
    this.remainingWork -= count
    return true
  }

  private push(lines: Array<string>, line: string) {
    if (!this.consume(bytes(line))) return false
    lines.push(line)
    return true
  }
}

/** `local_json_pointer`: a `#` fragment, percent-decoded, that is empty or starts with `/`. */
function localPointer(ref: string) {
  if (!ref.startsWith("#")) return undefined
  const pointer = percentDecode(ref.slice(1))
  if (pointer === undefined) return undefined
  return pointer === "" || pointer.startsWith("/") ? pointer : undefined
}

/** `percent_decode_uri_fragment`: strict `%XX` decoding into UTF-8. */
function percentDecode(fragment: string) {
  const source = Buffer.from(fragment, "utf8")
  const decoded: Array<number> = []
  for (let index = 0; index < source.length; ) {
    if (source[index] !== 0x25) {
      decoded.push(source[index]!)
      index += 1
      continue
    }
    const high = hexDigit(source[index + 1])
    const low = hexDigit(source[index + 2])
    if (high === undefined || low === undefined) return undefined
    decoded.push((high << 4) | low)
    index += 3
  }
  return utf8(Uint8Array.from(decoded))
}

function hexDigit(byte: number | undefined) {
  if (byte === undefined) return undefined
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  return undefined
}

const UTF8 = new TextDecoder("utf-8", { fatal: true })

/** Invalid UTF-8 is not a pointer (`String::from_utf8(...).ok()`); TextDecoder reports it only by throwing. */
function utf8(data: Uint8Array) {
  try {
    return UTF8.decode(data)
  } catch {
    return undefined
  }
}

/** `Value::pointer` (RFC 6901): `~1` is `/`, `~0` is `~`; array indexes without a sign or leading zero. */
function resolvePointer(root: unknown, pointer: string) {
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, token) => {
      if (Array.isArray(value)) {
        if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined
        return value[Number(token)]
      }
      if (isObject(value)) return Object.hasOwn(value, token) ? value[token] : undefined
      return undefined
    }, root)
}

/** `json_literal_serialization_upper_bound`. */
function literalUpperBound(value: unknown): number {
  if (value === null) return 4
  if (value === false) return 5
  if (value === true) return 4
  if (typeof value === "number") return String(value).length
  if (typeof value === "string") return bytes(value) * 6 + 2
  if (Array.isArray(value)) return value.reduce<number>((size, item) => size + 1 + literalUpperBound(item), 2)
  if (isObject(value))
    return Object.entries(value).reduce((size, [key, item]) => size + 4 + bytes(key) * 6 + literalUpperBound(item), 2)
  return 0
}

// ---------------------------------------------------------------------------------------------------------------
// Input schema lowering (tools/src/json_schema.rs, json_schema/compaction.rs, json_schema/types.rs)

const DEFINITION_TABLES = ["$defs", "definitions"] as const
const SCHEMA_CHILDREN = ["items", "anyOf", "oneOf", "allOf"] as const
const COMPOSITIONS = ["anyOf", "oneOf", "allOf"] as const
const PRIMITIVES = ["string", "number", "boolean", "integer", "object", "array", "null"]
/** `DEFAULT_COMPACT_TOOL_SCHEMA_BYTES`. */
const COMPACT_SCHEMA_BYTES = 5_000
const MAX_COMPACT_SCHEMA_DEPTH = 3

/**
 * An MCP tool's input schema as Codex sends and renders it (`parse_mcp_tool`): a missing or null root `properties`
 * becomes `{}`, then {@link sanitizeInput}.
 */
export function sanitizeMcpInput(schema: unknown) {
  const root = isObject(schema) ? schema : {}
  return sanitizeInput(root.properties === undefined || root.properties === null ? { ...root, properties: {} } : root)
}

/**
 * `parse_tool_input_schema`: Codex lowers a dynamic or MCP tool's input schema to its JSON Schema subset (types
 * inferred, `const` as a one-value `enum`, unreachable definitions pruned, schemas over 5000 bytes compacted) and
 * renders that. `undefined` where Codex rejects the schema (the tool is not registered in Codex).
 */
export function sanitizeInput(schema: unknown) {
  const prepared = pruneDefinitions(sanitize(structuredClone(schema)))
  const compacted = COMPACTION_PASSES.reduce(
    (value, pass) => (fits(value, COMPACT_SCHEMA_BYTES) ? value : pass(value)),
    prepared,
  )
  const projected = project(compacted)
  if (projected === undefined || projected.type === "null") return undefined
  return projected
}

function sanitize(value: unknown): unknown {
  if (typeof value === "boolean") return { type: "string" }
  if (Array.isArray(value)) return value.map(sanitize)
  if (!isObject(value)) return value
  const map: Record<string, unknown> = { ...value }
  if (isObject(map.properties))
    map.properties = Object.fromEntries(Object.entries(map.properties).map(([key, item]) => [key, sanitize(item)]))
  if (Object.hasOwn(map, "items")) map.items = sanitize(map.items)
  if (Object.hasOwn(map, "additionalProperties") && typeof map.additionalProperties !== "boolean")
    map.additionalProperties = sanitize(map.additionalProperties)
  if (Object.hasOwn(map, "prefixItems")) map.prefixItems = sanitize(map.prefixItems)
  COMPOSITIONS.forEach((key) => {
    if (Object.hasOwn(map, key)) map[key] = sanitize(map[key])
  })
  DEFINITION_TABLES.forEach((key) => {
    if (!Object.hasOwn(map, key)) return
    const table = map[key]
    if (isObject(table))
      map[key] = Object.fromEntries(Object.entries(table).map(([name, item]) => [name, sanitize(item)]))
    else delete map[key]
  })
  if (Object.hasOwn(map, "const")) {
    const constant = map.const
    delete map.const
    map.enum = [constant]
  }
  const declared = schemaTypes(map)
  if (declared.length === 0 && (Object.hasOwn(map, "$ref") || COMPOSITIONS.some((key) => Object.hasOwn(map, key))))
    return map
  const types = declared.length > 0 ? declared : inferredTypes(map)
  if (types.length === 0) return {}
  map.type = types.length === 1 ? types[0] : types
  if (types.includes("object") && !Object.hasOwn(map, "properties")) map.properties = {}
  if (types.includes("array") && !Object.hasOwn(map, "items")) map.items = { type: "string" }
  return map
}

function schemaTypes(map: Record<string, unknown>) {
  if (typeof map.type === "string") return PRIMITIVES.includes(map.type) ? [map.type] : []
  if (Array.isArray(map.type))
    return map.type.filter((entry): entry is string => typeof entry === "string" && PRIMITIVES.includes(entry))
  return []
}

function inferredTypes(map: Record<string, unknown>) {
  const has = (key: string) => Object.hasOwn(map, key)
  if (has("properties") || has("required") || has("additionalProperties")) return ["object"]
  if (has("items") || has("prefixItems")) return ["array"]
  if (has("enum") || has("format")) return ["string"]
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some(has)) return ["number"]
  return []
}

/** `prune_unreachable_definitions`: root definitions no reference outside the tables reaches. */
function pruneDefinitions(value: unknown) {
  if (!isObject(value)) return value
  const reachable = new Set<string>()
  const pending = refsOutsideDefinitions(value)
  while (pending.length > 0) {
    const pointer = pending.pop()!
    if (reachable.has(pointer)) continue
    reachable.add(pointer)
    const [table, name] = JSON.parse(pointer) as [string, string]
    const tableValue = value[table]
    if (isObject(tableValue) && Object.hasOwn(tableValue, name)) pending.push(...allRefs(tableValue[name]))
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!DEFINITION_TABLES.some((table) => table === key) || !isObject(item)) return [[key, item]]
      const kept = Object.entries(item).filter(([name]) => reachable.has(JSON.stringify([key, name])))
      return kept.length === 0 ? [] : [[key, Object.fromEntries(kept)]]
    }),
  )
}

function refsOutsideDefinitions(value: unknown): Array<string> {
  if (Array.isArray(value)) return value.flatMap(refsOutsideDefinitions)
  if (!isObject(value)) return []
  return [...ownRef(value), ...schemaChildren(value, false).flatMap(refsOutsideDefinitions)]
}

function allRefs(value: unknown): Array<string> {
  if (Array.isArray(value)) return value.flatMap(allRefs)
  if (!isObject(value)) return []
  return [...ownRef(value), ...Object.values(value).flatMap(allRefs)]
}

function ownRef(map: Record<string, unknown>) {
  const pointer = typeof map.$ref === "string" ? definitionRef(map.$ref) : undefined
  return pointer === undefined ? [] : [pointer]
}

/** `parse_local_definition_ref`: `#/$defs/<name>` or `#/definitions/<name>` (deeper pointers keep `<name>`). */
function definitionRef(ref: string) {
  if (!ref.startsWith("#")) return undefined
  const pointer = urlDecode(ref.slice(1))
  if (pointer === undefined || !pointer.startsWith("/")) return undefined
  const tokens = pointer.slice(1).split("/")
  if (tokens.some((token) => /~(?![01])/.test(token))) return undefined
  const [table, name] = tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
  if (name === undefined || !DEFINITION_TABLES.some((candidate) => candidate === table)) return undefined
  return JSON.stringify([table, name])
}

/** `urlencoding::decode`: `%XX` sequences decoded, malformed ones kept; invalid UTF-8 fails. */
function urlDecode(text: string) {
  const source = Buffer.from(text, "utf8")
  const decoded: Array<number> = []
  for (let index = 0; index < source.length; index += 1) {
    const high = source[index] === 0x25 ? hexDigit(source[index + 1]) : undefined
    const low = high === undefined ? undefined : hexDigit(source[index + 2])
    if (high === undefined || low === undefined) {
      decoded.push(source[index]!)
      continue
    }
    decoded.push((high << 4) | low)
    index += 2
  }
  return utf8(Uint8Array.from(decoded))
}

/** `for_each_schema_child`: property schemas, items and compositions, a schema `additionalProperties`, tables. */
function schemaChildren(map: Record<string, unknown>, definitions: boolean) {
  return [
    ...(isObject(map.properties) ? Object.values(map.properties) : []),
    ...SCHEMA_CHILDREN.flatMap((key) => (Object.hasOwn(map, key) ? [map[key]] : [])),
    ...(Object.hasOwn(map, "additionalProperties") && typeof map.additionalProperties !== "boolean"
      ? [map.additionalProperties]
      : []),
    ...(definitions
      ? DEFINITION_TABLES.flatMap((key) => {
          const table = map[key]
          return isObject(table) ? Object.values(table) : []
        })
      : []),
  ]
}

/** `for_each_schema_child_mut` as a copy: the map with each schema child replaced by `update(child)`. */
function mapSchemaChildren(map: Record<string, unknown>, definitions: boolean, update: (value: unknown) => unknown) {
  const next: Record<string, unknown> = { ...map }
  if (isObject(map.properties))
    next.properties = Object.fromEntries(Object.entries(map.properties).map(([key, item]) => [key, update(item)]))
  SCHEMA_CHILDREN.forEach((key) => {
    if (Object.hasOwn(map, key)) next[key] = update(map[key])
  })
  if (Object.hasOwn(map, "additionalProperties") && typeof map.additionalProperties !== "boolean")
    next.additionalProperties = update(map.additionalProperties)
  if (definitions)
    DEFINITION_TABLES.forEach((key) => {
      const table = map[key]
      if (isObject(table))
        next[key] = Object.fromEntries(Object.entries(table).map(([name, item]) => [name, update(item)]))
    })
  return next
}

/** `compact_large_tool_schema`'s increasingly lossy passes, each applied only while the schema is over budget. */
const COMPACTION_PASSES: ReadonlyArray<(value: unknown) => unknown> = [
  stripDescriptions,
  dropDefinitions,
  (value) => collapseDeep(value, 0),
  pruneCompositions,
]

/** `compact_normalized_schema_len`: the serialized subset's UTF-8 length; a schema Codex rejects counts as 0. */
function fits(value: unknown, maxBytes: number) {
  const projected = project(value)
  return projected === undefined || bytes(JSON.stringify(projected)) <= maxBytes
}

function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions)
  if (!isObject(value)) return value
  const { description: _, ...rest } = value
  return mapSchemaChildren(rest, true, stripDescriptions)
}

function dropDefinitions(value: unknown) {
  const rewritten = emptyDefinitionRefs(value)
  if (!isObject(rewritten)) return rewritten
  return Object.fromEntries(
    Object.entries(rewritten).filter(([key]) => !DEFINITION_TABLES.some((table) => table === key)),
  )
}

function emptyDefinitionRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(emptyDefinitionRefs)
  if (!isObject(value)) return value
  if (typeof value.$ref === "string" && definitionRef(value.$ref) !== undefined) return {}
  return mapSchemaChildren(value, false, emptyDefinitionRefs)
}

function collapseDeep(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => collapseDeep(item, depth))
  if (!isObject(value)) return value
  const complex =
    SCHEMA_CHILDREN.some((key) => Object.hasOwn(value, key)) ||
    ["properties", "additionalProperties", "$ref"].some((key) => Object.hasOwn(value, key))
  if (depth >= MAX_COMPACT_SCHEMA_DEPTH && complex) return {}
  return mapSchemaChildren(value, false, (item) => collapseDeep(item, depth + 1))
}

function pruneCompositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneCompositions)
  if (!isObject(value)) return value
  if (COMPOSITIONS.some((key) => Object.hasOwn(value, key))) return {}
  return mapSchemaChildren(value, false, pruneCompositions)
}

/**
 * Codex's `JsonSchema` subset (types.rs) as deserialized and serialized again: unknown keywords drop out, `null`
 * fields are absent, and a field of the wrong shape rejects the schema (`undefined`).
 */
function project(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined
  const fields: Array<[string, unknown]> = []
  const field = (key: string, convert: (item: unknown) => unknown) => {
    const item = value[key]
    if (item === undefined || item === null) return true
    const converted = convert(item)
    if (converted === undefined) return false
    fields.push([key, converted])
    return true
  }
  const string = (item: unknown) => (typeof item === "string" ? item : undefined)
  const schemas = (item: unknown) => {
    if (!Array.isArray(item)) return undefined
    const projected = item.map(project)
    return projected.every((entry) => entry !== undefined) ? projected : undefined
  }
  const table = (item: unknown) => {
    if (!isObject(item)) return undefined
    const entries = Object.entries(item)
      .toSorted(([left], [right]) => byteOrder(left, right))
      .map(([key, entry]) => [key, project(entry)] as const)
    return entries.every(([, entry]) => entry !== undefined) ? Object.fromEntries(entries) : undefined
  }
  const ok = [
    field("$ref", string),
    field("type", (item) => {
      if (typeof item === "string") return PRIMITIVES.includes(item) ? item : undefined
      if (!Array.isArray(item)) return undefined
      return item.every((entry) => typeof entry === "string" && PRIMITIVES.includes(entry)) ? item : undefined
    }),
    field("description", string),
    field("encrypted", (item) => (typeof item === "boolean" ? item : undefined)),
    field("enum", (item) => (Array.isArray(item) ? item : undefined)),
    field("items", project),
    field("minItems", (item) => (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : undefined)),
    field("properties", table),
    field("required", (item) =>
      Array.isArray(item) && item.every((entry) => typeof entry === "string") ? item : undefined,
    ),
    field("additionalProperties", (item) => (typeof item === "boolean" ? item : project(item))),
    field("anyOf", schemas),
    field("oneOf", schemas),
    field("allOf", schemas),
    field("$defs", table),
    field("definitions", table),
  ].every(Boolean)
  return ok ? Object.fromEntries(fields) : undefined
}

// ---------------------------------------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bytes(text: string) {
  return Buffer.byteLength(text, "utf8")
}

/** Rust's `str` order: by UTF-8 bytes. */
function byteOrder(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

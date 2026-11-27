// Ports Codex's client-executed `tool_search` over deferred tools: the tool definition and its source list
// (codex-rs/core/src/tools/handlers/tool_search_spec.rs), argument decoding (`SearchToolCallParams` via
// `serde_json::from_value`, codex-rs/core/src/tools/router.rs), the BM25 search over each deferred tool's search
// text (codex-rs/core/src/tools/handlers/tool_search.rs, see ../bm25) and the `tool_search_output` tools: the matched
// tools normalized into namespaces with `defer_loading: true` and merged per namespace in rank order
// (codex-rs/tools/src/{tool_search.rs,responses_api.rs} `normalize_search_spec`, `coalesce_loadable_tool_specs`).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
//
// Not covered: the Code Mode variant (`tools.tool_search` inside `exec`, answering `{"tools":[{name,description}]}`)
// and model-specific indirect namespace description prefixes, which apply to MCP namespaces only.
export * as ToolSearch from "./tool-search.js"

import { AgentArgs } from "./agents/args.js"
import { RustStr } from "./apply-patch/rust-str.js"
import { Bm25 } from "./bm25/index.js"

export const TOOL_NAME = "tool_search"
export const DEFAULT_LIMIT = 8
const DEFAULT_FUNCTION_NAMESPACE = "functions"
const MAX_SOURCE_DESCRIPTION_BYTES = 512 * 1024

/** A deferred tool's origin, listed in the `tool_search` description (`ToolSearchSourceInfo`). */
export interface Source {
  readonly name: string
  readonly description?: string
}

export interface FunctionTool {
  readonly type: "function"
  readonly name: string
  readonly description: string
  readonly strict: boolean
  readonly defer_loading?: boolean
  readonly parameters: unknown
}

export interface CustomTool {
  readonly type: "custom"
  readonly name: string
  readonly description: string
  readonly defer_loading?: boolean
  readonly format: unknown
}

export type Tool = FunctionTool | CustomTool

export interface Namespace {
  readonly type: "namespace"
  readonly name: string
  readonly description: string
  readonly tools: ReadonlyArray<Tool>
}

/** One deferred tool as a handler registers it (`ToolSearchInfo`). */
export interface Entry {
  /** The handler's `search_info` text, the only text BM25 indexes. */
  readonly searchText: string
  /** The namespace the tool is defined in; omitted for a plain function (Codex's `functions` namespace). */
  readonly namespace?: { readonly name: string; readonly description: string }
  readonly tool: Tool
  readonly source?: Source
}

// ---------------------------------------------------------------------------------------------------------------
// The tool definition

export type SourceListing = "include" | "omit"

/**
 * `create_tool_search_tool`: the definition with its source list built from the deferred tools' sources (deduplicated
 * by name, sorted, the first description kept). `omit` drops the list when the world state already advertises it.
 */
export function definition(sources: ReadonlyArray<Source>, listing: SourceListing = "include") {
  return {
    type: "tool_search",
    execution: "client",
    description: description(sources, listing),
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: `Maximum number of tools to return. Defaults to ${DEFAULT_LIMIT}.` },
        query: { type: "string", description: "Search query for deferred tools." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  } as const
}

export function description(sources: ReadonlyArray<Source>, listing: SourceListing = "include") {
  const section =
    listing === "omit"
      ? "\n\n"
      : `\n\nYou have access to tools from the following sources:\n${renderSources(sources)}\n`
  return `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.${section}Some of the tools may not have been provided to you upfront, and you should use this tool (\`${TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_NAME}\` instead of \`list_mcp_resources\` or \`list_mcp_resource_templates\`.`
}

const ENCODER = new TextEncoder()

/** The `- name: description` lines, bounded to 512 KiB with every name kept before descriptions are cut. */
function renderSources(sources: ReadonlyArray<Source>) {
  const byName = sources.reduce((map, source) => {
    if (!map.has(source.name) || map.get(source.name) === undefined) map.set(source.name, source.description)
    return map
  }, new Map<string, string | undefined>())
  if (byName.size === 0) return "None currently enabled."
  const names = [...byName.keys()].toSorted(compareUtf8)
  const reserved = names.reduce((sum, name) => sum + 2 + bytes(name), names.length - 1)
  const rendered = names.reduce(
    (state, name) => {
      const separator = state.text === "" ? 0 : 1
      if (separator + 2 + bytes(name) > MAX_SOURCE_DESCRIPTION_BYTES - bytes(state.text)) return state
      const line = `${separator === 1 ? "\n" : ""}- ${name}`
      const sourceDescription = byName.get(name)
      if (sourceDescription === undefined || state.budget < 2) return { text: state.text + line, budget: state.budget }
      const bounded = takeBytes(sourceDescription, state.budget - 2)
      return { text: `${state.text}${line}: ${bounded}`, budget: state.budget - 2 - bytes(bounded) }
    },
    { text: "", budget: Math.max(MAX_SOURCE_DESCRIPTION_BYTES - reserved, 0) },
  )
  return rendered.text
}

function bytes(text: string) {
  return ENCODER.encode(text).length
}

/** `take_bytes_at_char_boundary`: the longest prefix of at most `limit` UTF-8 bytes that ends on a character. */
function takeBytes(text: string, limit: number) {
  const encoded = ENCODER.encode(text)
  if (encoded.length <= limit) return text
  // Step back over continuation bytes (0b10xxxxxx) to the start of the character the limit cuts through.
  const boundary = [0, 1, 2, 3].find((back) => limit - back <= 0 || (encoded[limit - back]! & 0xc0) !== 0x80) ?? 0
  return new TextDecoder().decode(encoded.subarray(0, Math.max(limit - boundary, 0)))
}

/** Rust `String` order: UTF-8 bytes, which is code point order. */
export function compareUtf8(left: string, right: string) {
  const a = Array.from(left, (char) => char.codePointAt(0)!)
  const b = Array.from(right, (char) => char.codePointAt(0)!)
  const differing = a.findIndex((code, index) => code !== b[index])
  if (differing === -1) return a.length - b.length
  return differing >= b.length ? 1 : a[differing]! - b[differing]!
}

// ---------------------------------------------------------------------------------------------------------------
// Search

/** `ToolSearchHandler`: the BM25 index over the deferred tools, in registration order. */
export class Index {
  private readonly bm25: Bm25.Index

  constructor(readonly entries: ReadonlyArray<Entry>) {
    this.bm25 = new Bm25.Index(entries.map((entry) => entry.searchText))
  }

  /** The `source_info` of every entry, for `definition`. */
  sources() {
    return this.entries.flatMap((entry) => (entry.source === undefined ? [] : [entry.source]))
  }

  /** The best `limit` entries for `query`, best first. */
  rank(query: string, limit: number) {
    return this.bm25
      .matches(query)
      .slice(0, limit)
      .map((match) => this.entries[match.id]!)
  }

  /** `ToolSearchHandler::search`: the ranked entries as loadable namespaces, merged by name in first-seen order. */
  search(query: string, limit: number): ReadonlyArray<Namespace> {
    return this.rank(query, limit).reduce<ReadonlyArray<Namespace>>((merged, entry) => {
      const spec = loadable(entry)
      const existing = merged.find((namespace) => namespace.name === spec.name)
      if (existing === undefined) return [...merged, spec]
      return merged.map((namespace) =>
        namespace === existing ? { ...namespace, tools: [...namespace.tools, ...spec.tools] } : namespace,
      )
    }, [])
  }
}

/** `normalize_search_spec`: the tool in its namespace, marked `defer_loading: true`, in Codex's field order. */
function loadable(entry: Entry): Namespace {
  const name = entry.namespace?.name ?? DEFAULT_FUNCTION_NAMESPACE
  const given = entry.namespace?.description ?? ""
  return {
    type: "namespace",
    name,
    description: RustStr.trim(given) === "" ? defaultNamespaceDescription(name) : given,
    tools: [deferred(entry.tool)],
  }
}

function defaultNamespaceDescription(name: string) {
  return name === DEFAULT_FUNCTION_NAMESPACE ? "" : `Tools in the ${name} namespace.`
}

function deferred(tool: Tool): Tool {
  if (tool.type === "custom")
    return { type: "custom", name: tool.name, description: tool.description, defer_loading: true, format: tool.format }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    strict: tool.strict,
    defer_loading: true,
    parameters: tool.parameters,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Calls

/**
 * What a `tool_search_call` answers. `output` is the `tool_search_output` tools; a rejected call (`error`: empty
 * query, zero limit) still answers an empty `tools` list, because Codex turns every handler failure for this payload
 * into an empty completed output and only logs the text. `invalid` is an argument decoding failure, which Codex
 * records as a `function_call_output` (with an empty `call_id`) carrying `text`.
 */
export type Outcome =
  | { readonly kind: "output"; readonly tools: ReadonlyArray<Namespace>; readonly error?: string }
  | { readonly kind: "invalid"; readonly text: string }

/** Handles one `tool_search_call` from its `arguments` value (already parsed JSON). */
export function handle(index: Index, args: unknown): Outcome {
  const params = decodeArguments(args)
  if (typeof params === "string") return { kind: "invalid", text: `failed to parse tool_search arguments: ${params}` }
  const query = RustStr.trim(params.query)
  if (query === "") return { kind: "output", tools: [], error: "query must not be empty" }
  const limit = params.limit ?? DEFAULT_LIMIT
  if (limit === 0) return { kind: "output", tools: [], error: "limit must be greater than zero" }
  if (index.entries.length === 0) return { kind: "output", tools: [] }
  return { kind: "output", tools: index.search(query, limit) }
}

/** The `tool_search_output` input item that answers `callId`. */
export function outputItem(callId: string, tools: ReadonlyArray<Namespace>) {
  return { type: "tool_search_output", call_id: callId, status: "completed", execution: "client", tools } as const
}

const PARAMS = "struct SearchToolCallParams"

/**
 * `SearchToolCallParams { query: String, #[serde(default)] limit: Option<usize> }` from a JSON value, with
 * serde_json's `Value` deserializer texts. JavaScript numbers do not keep `1.0` apart from `1`, so an
 * integer-valued float limit is accepted where serde_json would reject it.
 */
function decodeArguments(args: unknown): { readonly query: string; readonly limit?: number } | string {
  if (Array.isArray(args)) return decodeSequence(args)
  if (typeof args !== "object" || args === null) return `invalid type: ${unexpected(args)}, expected ${PARAMS}`
  const entries = Object.entries(args)
  const failure = entries
    .map(([key, value]) => (key === "query" ? queryError(value) : key === "limit" ? limitError(value) : undefined))
    .find((error) => error !== undefined)
  if (failure !== undefined) return failure
  const query = entries.find(([key]) => key === "query")?.[1]
  if (typeof query !== "string") return "missing field `query`"
  const limit = entries.find(([key]) => key === "limit")?.[1]
  return typeof limit === "number" ? { query, limit } : { query }
}

function decodeSequence(args: ReadonlyArray<unknown>) {
  if (args.length === 0) return `invalid length 0, expected ${PARAMS} with 2 elements`
  const failure = queryError(args[0]) ?? (args.length > 1 ? limitError(args[1]) : undefined)
  if (failure !== undefined) return failure
  if (args.length > 2) return `invalid length ${args.length}, expected fewer elements in array`
  const query = String(args[0])
  return typeof args[1] === "number" ? { query, limit: args[1] } : { query }
}

function queryError(value: unknown) {
  return typeof value === "string" ? undefined : `invalid type: ${unexpected(value)}, expected a string`
}

function limitError(value: unknown) {
  if (value === null) return undefined
  const text = unexpected(value)
  if (!text.startsWith("integer")) return `invalid type: ${text}, expected usize`
  if (typeof value === "number" && value < 0) return `invalid value: ${text}, expected usize`
  return undefined
}

/** serde_json's `JsonUnexpected` text for a JSON value; integers are those serde_json keeps as `u64`/`i64`. */
function unexpected(value: unknown) {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return `boolean \`${value}\``
  if (typeof value === "number") {
    const integer = Number.isInteger(value) && !Object.is(value, -0) && value >= -(2 ** 63) && value < 2 ** 64
    return integer ? `integer \`${BigInt(value)}\`` : `floating point \`${AgentArgs.floatDisplay(value)}\``
  }
  if (typeof value === "string") return `string ${AgentArgs.rustDebug(value)}`
  if (Array.isArray(value)) return "sequence"
  return "map"
}

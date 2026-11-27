export * as SearchWire from "./wire.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { WebSearch } from "@opencode/schema/websearch"
import { CodexModels } from "@own/protocol"

/**
 * The Codex backend request of own's ChatGPT web search and the reading of its answer (02 §9.2 웹 검색 서비스). Pure.
 * Shapes follow Codex CLI 0.162.1: the hosted tool in live mode as `codex-rs/tools/src/tool_spec.rs` serializes it
 * (`{"type":"web_search","external_web_access":true}`), and the structured answer as `--output-schema` sends it
 * (`text.format` json_schema, strict, `codex-api/src/common.rs`), which Codex sends together with its hosted tools.
 * `include: ["web_search_call.action.sources"]` adds the pages each search read to its `web_search_call` item.
 */

/** Small fast models first: they search as well and spend less of the plan. The first the account offers wins. */
export const MODELS = ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.5"] as const

/** Results kept from one answer. */
export const LIMIT = 10

export const INSTRUCTIONS = [
  "You are a web search service for another AI agent. Use the web_search tool to search the web for the user's query",
  "before you answer; search more than once when the first results are thin.",
  `Answer only with JSON that matches the schema: up to ${LIMIT} results, the most relevant first.`,
  "- url: the exact address of a page your searches actually found. Never invent or guess an address.",
  "- title: the page's title.",
  "- content: a concise, factual excerpt or summary (2 to 4 sentences) of what that page says about the query,",
  "  with concrete facts, numbers, versions and dates where the page has them.",
  "Leave out pages that are not relevant. When nothing relevant is found, answer with an empty results list.",
].join("\n")

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["url", "title", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
}

/** The `/responses` body of one search: streamed and unstored, as the ChatGPT backend requires. */
export function body(input: { readonly model: string; readonly effort: string; readonly query: string }) {
  return {
    model: input.model,
    instructions: INSTRUCTIONS,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input.query }] }],
    tools: [{ type: "web_search", external_web_access: true }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: input.effort },
    store: false,
    stream: true,
    include: ["web_search_call.action.sources"],
    text: { format: { type: "json_schema", name: "web_search_results", strict: true, schema: SCHEMA } },
  }
}

/**
 * The model and effort of a search. The first list with models decides (the account's own list, then the shared
 * one): the first of {@link MODELS} it offers, else its first model by Codex priority. Without any list, the first
 * of {@link MODELS}. Effort `low` when the model lists it (or lists none), else its lowest level that can search:
 * `minimal` and `none` cannot use web search.
 */
export function choose(lists: ReadonlyArray<CodexModels.Snapshot | undefined>) {
  const models = lists.find((list) => list !== undefined && list.models.length > 0)?.models
  if (!models) return { model: MODELS[0], effort: "low" }
  const row =
    MODELS.flatMap((slug) => models.filter((model) => model.slug === slug))[0] ??
    models.toSorted(
      (a, b) =>
        (CodexModels.priority(a) ?? Number.POSITIVE_INFINITY) - (CodexModels.priority(b) ?? Number.POSITIVE_INFINITY),
    )[0]!
  const levels = CodexModels.levels(row)
  const effort =
    levels.length === 0 || levels.includes("low")
      ? "low"
      : (levels.find((level) => level !== "minimal" && level !== "none") ?? "low")
  return { model: row.slug, effort }
}

const Annotation = Schema.Struct({
  type: Schema.String,
  url: optional(Schema.String),
  title: optional(Schema.String),
  start_index: optional(Schema.Number),
})

const Part = Schema.Struct({
  type: Schema.String,
  text: optional(Schema.String),
  annotations: optional(Schema.NullOr(Schema.Array(Annotation))),
})

const Action = Schema.Struct({
  type: optional(Schema.String),
  url: optional(Schema.NullOr(Schema.String)),
  sources: optional(Schema.NullOr(Schema.Array(Schema.Struct({ url: optional(Schema.String) })))),
})

export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  type: Schema.String,
  content: optional(Schema.NullOr(Schema.Array(Part))),
  action: optional(Schema.NullOr(Action)),
})

const Problem = Schema.Struct({ code: optional(Schema.NullOr(Schema.String)), type: optional(Schema.String) })

/** One stream event, only the fields read here; anything else in it is ignored. */
const Event = Schema.Struct({
  type: Schema.String,
  item: optional(Item),
  response: optional(
    Schema.Struct({
      output: optional(Schema.NullOr(Schema.Array(Item))),
      error: optional(Schema.NullOr(Problem)),
    }),
  ),
  error: optional(Schema.NullOr(Problem)),
  code: optional(Schema.NullOr(Schema.String)),
})
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

const END = new Map<string, Read["end"]>([
  ["response.completed", "completed"],
  ["response.incomplete", "incomplete"],
  ["response.failed", "failed"],
  ["error", "failed"],
])

export interface Read {
  /** The answer's output items: every `response.output_item.done`, else the terminal event's `output`. */
  readonly items: ReadonlyArray<Item>
  /** How the stream ended; `cut` when it ended without a terminal event. */
  readonly end: "completed" | "incomplete" | "failed" | "cut"
  /** A failed response's error code (`usage_limit_reached`, …), never its message. */
  readonly code?: string
}

/** Reads a whole SSE body of `/responses` (Responses stream events, Codex's shapes). */
export function read(text: string): Read {
  const events = text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    return data === "" ? [] : Option.toArray(decodeEvent(data))
  })
  const done = events.flatMap((event) => (event.type === "response.output_item.done" && event.item ? [event.item] : []))
  const terminal = events.findLast((event) => END.has(event.type))
  const end = (terminal && END.get(terminal.type)) ?? "cut"
  const code = terminal?.response?.error?.code ?? terminal?.error?.code ?? terminal?.code ?? terminal?.error?.type
  return {
    items: done.length > 0 ? done : (terminal?.response?.output ?? []),
    end,
    ...(end === "failed" && code ? { code } : {}),
  }
}

const Answer = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ url: Schema.String, title: optional(Schema.String), content: optional(Schema.String) }),
  ),
})
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))

/** A citation's markdown link as the model writes it in prose, e.g. ` ([example.com](https://example.com/))`. */
const CITATION = /\s*\(\[[^\]]*\]\([^)]*\)\)/g

/**
 * The search results of an answer: the structured answer's results; when it has none (not JSON, or empty), the
 * answer's `url_citation` annotations (title from the annotation, content the cited line) and then the pages the
 * searches read (`action.sources`, opened pages). Only http(s) addresses ({@link address}), each once, in order, at
 * most {@link LIMIT}.
 */
export function results(items: ReadonlyArray<Item>): WebSearch.Result[] {
  const parts = items
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
  const answered = Option.getOrUndefined(decodeAnswer(parts.map((part) => part.text ?? "").join("")))?.results ?? []
  const found: ReadonlyArray<{ readonly url: string; readonly title?: string; readonly content?: string }> =
    answered.length > 0 ? answered : [...cited(parts), ...sourced(items)]
  const pages = found.flatMap((entry) => {
    const url = address(entry.url)
    return url === undefined ? [] : [{ ...entry, url }]
  })
  return pages
    .filter((entry, index) => pages.findIndex((other) => other.url === entry.url) === index)
    .slice(0, LIMIT)
    .map((entry) => ({
      url: entry.url,
      ...(entry.title?.trim() ? { title: entry.title.trim() } : {}),
      ...(entry.content?.trim() ? { content: entry.content.trim() } : {}),
      time: {},
    }))
}

function cited(parts: ReadonlyArray<typeof Part.Type>) {
  return parts.flatMap((part) =>
    (part.annotations ?? []).flatMap((annotation) =>
      annotation.type === "url_citation" && annotation.url
        ? [{ url: annotation.url, title: annotation.title, content: line(part.text ?? "", annotation.start_index) }]
        : [],
    ),
  )
}

function sourced(items: ReadonlyArray<Item>) {
  return items
    .filter((item) => item.type === "web_search_call")
    .flatMap((item) => [
      ...(item.action?.sources ?? []).flatMap((source) => (source.url ? [source.url] : [])),
      ...(item.action?.url ? [item.action.url] : []),
    ])
    .map((url) => ({ url }))
}

/** The line of `text` holding position `at`, without citation links. */
function line(text: string, at: number | undefined) {
  if (at === undefined) return undefined
  const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1
  const end = text.indexOf("\n", at)
  return (
    text
      .slice(start, end === -1 ? undefined : end)
      .replace(CITATION, "")
      .trim() || undefined
  )
}

/**
 * An http(s) address as one page: OpenAI tags the links it cites with `utm_source=openai`, which the same page found
 * by a search does not carry, so the tag is dropped. `undefined` for any other scheme or no address at all.
 */
function address(url: string) {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== "https:" && parsed?.protocol !== "http:") return undefined
  if (parsed.searchParams.get("utm_source") === "openai") parsed.searchParams.delete("utm_source")
  return parsed.href
}

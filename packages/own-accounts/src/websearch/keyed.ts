export * as KeyedSearch from "./keyed.js"

import { Option, Schema } from "effect"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { optional } from "@opencode/schema/schema"
import type { WebSearch } from "@opencode/schema/websearch"
import { SearchKey } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"

/**
 * own's keyed variants of core's keyless web search services (02 §9.2, SK 2026-10-23): `own-exa`, `own-firecrawl`,
 * `own-parallel`, `own-tavily` and `own-tinyfish` search with the user's own key of that service, kept in own's vault
 * as a feature item (`websearch-<service>`, DPAPI) like Brave's. Core's keyless service stays as it is (free, its
 * own id); core's key method would keep the key in plain text in `opencode-own.db`, and own-web never calls it
 * (01 §13), so no core credential, no integration and no environment variable is involved.
 * - Each request is core's own request to the same URL, with the key placed where core places it (Exa: the
 *   `exaApiKey` query parameter; Firecrawl, Parallel, Tavily: `Authorization: Bearer`; TinyFish: `X-API-Key`). Ported
 *   from upstream opencode (MIT), packages/core/src/plugin/websearch/{exa,firecrawl,parallel,tavily,tinyfish}.ts and
 *   mcp.ts at 1aae67e853, TinyFish's MCP session at v2.0.32 (86755e1cea; check-surface `websearch-keyed-*` flags a
 *   change there). Differences: plain `fetch` with the tool call's cancel signal; an MCP answer with `isError` (an
 *   exhausted or refused key) is a failure, not an empty result (upstream #54311 reads it as no results); only http(s)
 *   result addresses, each once.
 * - Listed only while the service's key is in the vault (a keyed variant without a key would only fail, and `random`
 *   could draw it); storing or removing a key folds every Location again (`searchKey.changed`). Never core's default.
 * - A service given test endpoints (any override) without its own never asks the real host (`no_endpoint`), like the
 *   Codex version check's registry.
 * - Logged once per query: `websearch_query` with the provider, duration, result count and error code. Never the
 *   query, the key or a request URL (Exa's holds the key).
 */

export type Service = SearchKey.Keyed

export const SERVICES = SearchKey.KEYED

/** The services' names in core's list (core's own names). */
export const NAMES: Readonly<Record<Service, string>> = {
  exa: "Exa",
  firecrawl: "Firecrawl",
  parallel: "Parallel",
  tavily: "Tavily",
  tinyfish: "TinyFish",
}

/** own's id of a service's keyed variant (`own-exa`). */
export function idOf(service: Service) {
  return SearchKey.providerID(service)
}

/** The service of a keyed variant's id, `undefined` for any other id. */
export function serviceOf(id: string): Service | undefined {
  return SERVICES.find((service) => idOf(service) === id)
}

/** The name core lists the keyed variant under, next to its keyless one: `Exa (내 키)`. */
export function nameOf(service: Service) {
  return `${NAMES[service]} (내 키)`
}

/** Results asked for, as core asks (Exa `numResults`, Firecrawl `limit`, Tavily `max_results`). */
export const COUNT = 8

/** A search without its whole answer by then fails (core's MCP and Tavily timeout). */
export const TIMEOUT_MS = 25_000

/** The longest answer read (core's `WebSearchMcp.MAX_RESPONSE_BYTES`). */
export const MAX_RESPONSE_BYTES = 256 * 1024

/**
 * Registers the keyed variants on this Location; the result stops the reloads. As with Brave, the keys are looked up
 * after registering, not awaited (a process's first vault request may wait for the vault helper to start), and a key
 * found then folds the services again.
 */
export async function register(deps: Deps) {
  const log = deps.log.child("websearch")
  const hook = Hooks.guard(log)
  const keyed = new Set<Service>()
  const executes = new Map(SERVICES.map((service) => [service, create(deps, service)]))
  await deps.ctx.websearch.transform((editor) =>
    hook.sync("websearch.transform:keyed", () => fold(editor, keyed, (service) => executes.get(service)!)),
  )
  const refresh = async (services: readonly Service[]) => {
    const states = await Promise.all(services.map(async (service) => ({ service, now: await stored(deps, service) })))
    const changed = states.filter((state) => keyed.has(state.service) !== state.now)
    if (changed.length === 0) return
    for (const state of changed) state.now ? keyed.add(state.service) : keyed.delete(state.service)
    await deps.ctx.websearch.reload()
  }
  const reread = (services: readonly Service[]) =>
    void refresh(services).catch((error: unknown) => log.error("websearch_reload_failed", { error }))
  reread(SERVICES)
  return deps.runtime.broadcast.on("searchKey.changed", (payload) => {
    if (SearchKey.isKeyed(payload.service)) reread([payload.service])
  })
}

/** The websearch fold: a keyed variant for every service whose key is in the vault. Never touches the default. */
export function fold(
  editor: WebSearchEditor,
  keyed: ReadonlySet<Service>,
  execute: (service: Service) => WebSearchDefinition["execute"],
) {
  for (const service of SERVICES)
    if (keyed.has(service)) editor.add({ id: idOf(service), name: nameOf(service), execute: execute(service) })
}

/**
 * The id `여러 서비스 함께` asks for a selected service (MS, SK): a keyless service whose keyed variant is listed is
 * asked with the key; a keyed variant whose key was removed is asked keyless again; any other id as it is.
 */
export function resolve(id: string, listed: readonly string[]) {
  const service = SearchKey.isKeyed(id) ? id : serviceOf(id)
  if (!service) return id
  if (listed.includes(idOf(service))) return idOf(service)
  return listed.includes(service) ? service : id
}

/** How a query ended. */
export type Outcome =
  | { readonly type: "ok"; readonly results: WebSearch.Result[] }
  | { readonly type: "failed"; readonly code: string }

/** A keyed variant's `execute`: one query, logged; a failure throws an error that names only its code. */
export function create(deps: Deps, service: Service): WebSearchDefinition["execute"] {
  const log = deps.log.child("websearch")
  return async (input, context) => {
    const begin = performance.now()
    const outcome = await search(deps, service, input.query, context.signal)
    log.info("websearch_query", {
      provider: idOf(service),
      durationMs: Math.round(performance.now() - begin),
      results: outcome.type === "ok" ? outcome.results.length : 0,
      ...(outcome.type === "failed" ? { error: outcome.code } : {}),
    })
    if (outcome.type === "failed")
      throw new Error(`${NAMES[service]} web search with your key failed (${outcome.code})`)
    return outcome.results
  }
}

/** One query with the vault's key, within {@link TIMEOUT_MS} or until `cancel`. Never throws. */
export async function search(deps: Deps, service: Service, query: string, cancel: AbortSignal): Promise<Outcome> {
  const text = query.trim()
  if (text === "") return failure("empty_query")
  const endpoint = endpointOf(deps, service)
  if (!endpoint) return failure("no_endpoint")
  const request = await prepare(deps, service, endpoint, text)
  if (!request.ok) return failure(request.problem === "not_found" ? "no_key" : "vault_unavailable")
  const opened = service === "tinyfish" ? await session(request, cancel) : undefined
  if (opened?.type === "failed") return opened
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT_MS)])
  const sent = await post(request.url, opened?.headers ?? request.headers, request.body, signal)
  if (sent.type === "failed") return sent
  const body = await read(sent.response, signal)
  if (body.type === "failed") return body
  return answer(service, body.text)
}

/** The answer's results, or why there are none: `service_error` for an MCP tool error, `bad_response` else. */
export function answer(service: Service, body: string): Outcome {
  if (service === "tavily") {
    const tavily = Option.getOrUndefined(decodeTavily(body))
    return tavily
      ? { type: "ok", results: pages(tavily.results.map((item) => ({ ...item, time: {} }))) }
      : { type: "failed", code: "bad_response" }
  }
  const envelope = mcpResult(body)
  if (!envelope) return { type: "failed", code: "bad_response" }
  if (envelope.type === "error" || envelope.result.isError === true) return { type: "failed", code: "service_error" }
  const read = READERS[service](envelope.result)
  return read ? { type: "ok", results: pages(read) } : { type: "failed", code: "bad_response" }
}

// ---------------------------------------------------------------------------------------------------------------
// Requests (core's, packages/core/src/plugin/websearch/*.ts)

type Ready = {
  readonly ok: true
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

type Prepared = Ready | { readonly ok: false; readonly problem: string }

type Failed = Extract<Outcome, { readonly type: "failed" }>

const failure = (code: string): Failed => ({ type: "failed", code })

/** The URL, headers (the key where core puts it) and body of one search. */
async function prepare(deps: Deps, service: Service, endpoint: string, query: string): Promise<Prepared> {
  const credentials = deps.runtime.credentials
  const id = SearchKey.keyID(service)
  const mcp = { accept: "application/json, text/event-stream" }
  if (service === "exa") {
    const keyed = await credentials.featureURL(id, endpoint, "exaApiKey")
    if (!keyed.ok) return keyed
    return {
      ok: true,
      url: keyed.url,
      headers: mcp,
      body: call("web_search_exa", { query, numResults: COUNT }),
    }
  }
  const auth = await credentials.featureHeaders(id, service === "tinyfish" ? { header: "X-API-Key" } : "Bearer")
  if (!auth.ok) return auth
  // core's `App.useragent` (packages/core/src/app.ts); Exa's request carries none.
  const app = deps.ctx.app
  const agent = { "user-agent": `opencode/${app.channel}/${app.version}/${app.name}` }
  if (service === "tavily")
    return {
      ok: true,
      url: endpoint,
      headers: { accept: "application/json", ...agent, "X-Client-Name": "opencode2", ...auth.headers },
      body: { query, search_depth: "basic", chunks_per_source: 3, max_results: COUNT },
    }
  const body =
    service === "parallel"
      ? call("web_search", { objective: query, search_queries: [query] })
      : service === "firecrawl"
        ? call("firecrawl_search", { query, limit: COUNT })
        : call("search", { query })
  return { ok: true, url: endpoint, headers: { ...mcp, ...agent, ...auth.headers }, body }
}

/** The JSON-RPC body of an MCP tool call, as core sends it (TinyFish's within its {@link session}). */
function call(name: string, args: Readonly<Record<string, unknown>>) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
}

/**
 * TinyFish's MCP session, opened as core opens it (`initialize` in packages/core/src/plugin/websearch/tinyfish.ts since
 * v2.0.32, 86755e1cea): TinyFish refuses a keyed `tools/call` without the `Mcp-Session-Id` that `initialize` answers.
 * `initialize` with the search's headers, its answer read (up to {@link MAX_RESPONSE_BYTES}), then
 * `notifications/initialized` with the session, within their own {@link TIMEOUT_MS} or until `cancel`. The result is
 * the search's headers with the session; an answer without one fails as `no_session`.
 */
async function session(request: Ready, cancel: AbortSignal) {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT_MS)])
  const opened = await post(request.url, request.headers, INITIALIZE, signal)
  if (opened.type === "failed") return opened
  const body = await read(opened.response, signal)
  if (body.type === "failed") return body
  const id = opened.response.headers.get("mcp-session-id")
  if (!id) return failure("no_session")
  const headers = { ...request.headers, "Mcp-Session-Id": id }
  const initialized = await post(request.url, headers, INITIALIZED, signal)
  if (initialized.type === "failed") return initialized
  await initialized.response.body?.cancel().catch(() => undefined)
  return { type: "ok", headers } as const
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode", version: "1.0" } },
}

const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" }

/** One POST of `body` as JSON; a status outside 2xx fails with its code. */
async function post(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  signal: AbortSignal,
): Promise<{ readonly type: "ok"; readonly response: Response } | Failed> {
  // Never followed: a redirect would carry the key (a header, or Exa's URL) to the host it names. A 3xx fails as
  // `status_3xx`.
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
    signal,
  }).catch(() => undefined)
  if (!response) return failure(interrupted(signal))
  if (response.ok) return { type: "ok", response }
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 401 || response.status === 403) return failure("auth")
  return failure(response.status === 429 ? "rate_limit" : `status_${response.status}`)
}

/** An answer's text, up to {@link MAX_RESPONSE_BYTES}. */
async function read(
  response: Response,
  signal: AbortSignal,
): Promise<{ readonly type: "ok"; readonly text: string } | Failed> {
  const body = await bounded(response).catch(() => undefined)
  if (body === undefined) return failure(signal.aborted ? interrupted(signal) : "bad_response")
  if (body === TOO_LARGE) return failure("too_large")
  return { type: "ok", text: body }
}

/**
 * The request URL, or `undefined` when this service is given test endpoints but none of its own: then a test that
 * forgot this one never reaches the real service.
 */
function endpointOf(deps: Deps, service: Service) {
  const overrides = deps.endpoints.overrides
  return overrides[service] ?? (Object.keys(overrides).length === 0 ? deps.endpoints.url[service] : undefined)
}

// ---------------------------------------------------------------------------------------------------------------
// Answers

const TOO_LARGE = Symbol("too_large")

/** The whole body as text, or {@link TOO_LARGE} past {@link MAX_RESPONSE_BYTES}. */
async function bounded(response: Response): Promise<string | typeof TOO_LARGE> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  const state = { size: 0 }
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    state.size += next.value.byteLength
    if (state.size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      return TOO_LARGE
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const Content = Schema.Array(Schema.Struct({ type: Schema.String, text: optional(Schema.String) }))

const ToolResult = Schema.Struct({
  content: optional(Content),
  structuredContent: optional(Schema.Unknown),
  isError: optional(Schema.Boolean),
})
type ToolResult = typeof ToolResult.Type

const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ result: optional(ToolResult), error: optional(Schema.Unknown) })),
)

/**
 * The tool call's result from an MCP answer: a JSON body, else the first `data:` line of an event stream that holds
 * one (core's `WebSearchMcp.parseResponse`); `error` for a JSON-RPC error; `undefined` for anything else.
 */
export function mcpResult(body: string) {
  const parse = (payload: string) => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const envelope = Option.getOrUndefined(decodeEnvelope(trimmed))
    if (envelope?.result) return { type: "result", result: envelope.result } as const
    return envelope?.error === undefined ? undefined : ({ type: "error" } as const)
  }
  return (
    parse(body) ??
    body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => parse(line.slice(5)))
      .find((found) => found !== undefined)
  )
}

/** The first text of a tool result's content. */
function firstText(result: ToolResult) {
  return result.content?.find((item) => item.text)?.text
}

const decodeParallel = Schema.decodeUnknownOption(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        url: Schema.String,
        title: optional(Schema.NullOr(Schema.String)),
        publish_date: optional(Schema.NullOr(Schema.String)),
        excerpts: optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  }),
)

const decodeFirecrawl = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        web: Schema.Array(
          Schema.Struct({
            url: Schema.String,
            title: optional(Schema.NullOr(Schema.String)),
            description: optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    }),
  ),
)

const decodeTinyFish = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({ url: Schema.String, title: optional(Schema.String), snippet: optional(Schema.String) }),
      ),
    }),
  ),
)

const decodeTavily = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({ url: Schema.String, title: optional(Schema.String), content: optional(Schema.String) }),
      ),
    }),
  ),
)

type Page = {
  readonly url: string
  readonly title?: string | null
  readonly content?: string | null
  readonly time: WebSearch.Result["time"]
}

/** Each MCP service's results, as core maps them; `undefined` when the result is not in the service's shape. */
const READERS: Readonly<Record<Exclude<Service, "tavily">, (result: ToolResult) => readonly Page[] | undefined>> = {
  exa: (result) => {
    const text = firstText(result)
    return text === undefined ? [] : exaResults(text)
  },
  parallel: (result) =>
    Option.getOrUndefined(decodeParallel(result.structuredContent))?.results.map((item) => ({
      url: item.url,
      title: item.title,
      content: item.excerpts?.length ? item.excerpts.join("\n\n") : undefined,
      time: published(item.publish_date ?? undefined),
    })),
  firecrawl: (result) => {
    const text = firstText(result)
    if (text === undefined) return []
    return Option.getOrUndefined(decodeFirecrawl(text))?.data.web.map((item) => ({
      url: item.url,
      title: item.title,
      content: item.description,
      time: {},
    }))
  },
  tinyfish: (result) => {
    const text = firstText(result)
    if (text === undefined) return []
    return Option.getOrUndefined(decodeTinyFish(text))?.results.map((item) => ({
      url: item.url,
      title: item.title,
      content: item.snippet,
      time: {},
    }))
  },
}

/** Exa's text answer: blocks split by `---` lines with `Title:`, `URL:`, `Published:` and `Highlights:`/`Text:`. */
export function exaResults(text: string): Page[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!url) return []
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const date = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    return [
      {
        url,
        title: title === "N/A" ? undefined : title,
        content,
        time: published(date === "N/A" ? undefined : date),
      },
    ]
  })
}

/** Core's results: http(s) addresses only, each once, in the service's order; no empty title or content. */
function pages(items: readonly Page[]): WebSearch.Result[] {
  const kept = items.filter((item) => {
    const url = URL.parse(item.url)
    return url?.protocol === "https:" || url?.protocol === "http:"
  })
  return kept
    .filter((item, index) => kept.findIndex((other) => other.url === item.url) === index)
    .map((item) => ({
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.content ? { content: item.content } : {}),
      time: item.time,
    }))
}

function published(text: string | undefined): WebSearch.Result["time"] {
  const time = text ? Date.parse(text) : Number.NaN
  return Number.isFinite(time) ? { published: time } : {}
}

/** Whether the service's key is in the vault now. */
async function stored(deps: Deps, service: Service) {
  return (await deps.runtime.credentials.inspectFeatureKey(SearchKey.keyID(service))).configured
}

/** Why a request ended without an answer: the timeout, core cancelling the tool call, else the network. */
function interrupted(signal: AbortSignal) {
  if (!signal.aborted) return "network"
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled"
}

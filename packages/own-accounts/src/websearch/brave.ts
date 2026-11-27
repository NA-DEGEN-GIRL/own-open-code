export * as BraveSearch from "./brave.js"

import { Option, Schema } from "effect"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { optional } from "@opencode/schema/schema"
import type { WebSearch } from "@opencode/schema/websearch"
import { SearchKey } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"

/**
 * own's web search service `brave` (02 §9.2 웹 검색 서비스, SP 2026-10-19): core's `websearch` tool searches with the Brave
 * Search API (`GET {brave}/web/search`, in production `https://api.search.brave.com/res/v1/web/search`) and a key the
 * user got from Brave. The key is a feature item of own's vault (`websearch-brave`, DPAPI), stored from own-web's web
 * search settings through `websearch.key.set` (`SearchKeyRpc`) like the voice-only keys: never an account, never
 * core's credential table, no environment variable. Each request asks the vault for its header
 * (`X-Subscription-Token`); the key is never read out, logged or sent anywhere else.
 * - Brave has no keyless use, so the service is listed only while the key is in the vault; storing or removing it
 *   folds every Location again (`searchKey.changed`). Never core's default: it answers only when the user chose it (or
 *   core's `random` drew it from the list).
 * - The query is cut to {@link MAX_QUERY} characters and {@link MAX_WORDS} words (the API's limits). A query with
 *   Hangul asks for Korean pages from Korea (`search_lang=ko`, `country=KR`). Results: title, url, `description`
 *   and `extra_snippets` without Brave's `<strong>` marks as content, `page_age` as the publication time.
 * - Logged once per query: `websearch_query` with the duration, result count and error code. Never the query or the key.
 */

export const ID = "brave"

export const NAME = "Brave"

/** The vault item of the key. */
export const KEY_ID = SearchKey.keyID("brave")

/** The API's longest query: 400 characters and 50 words. */
export const MAX_QUERY = 400
export const MAX_WORDS = 50

/** Results asked for (Brave's most: 20). */
export const COUNT = 10

/** A search without its whole answer by then fails. */
export const TIMEOUT_MS = 25_000

/**
 * Registers the service on this Location; the result stops the reloads. The key is looked up after registering, not
 * awaited: a process's first vault request starts the vault helper (up to its 15 s request timeout), and plugin setup,
 * which every model list waits for (at most 5 s, server `awaitPlugins`), must not wait on it. A key found then folds
 * the services again.
 */
export async function register(deps: Deps) {
  const log = deps.log.child("websearch")
  const hook = Hooks.guard(log)
  const state = { keyed: false }
  const execute = create(deps)
  await deps.ctx.websearch.transform((editor) =>
    hook.sync("websearch.transform:brave", () => fold(editor, state.keyed, execute)),
  )
  const refresh = async () => {
    const now = await keyed(deps)
    if (now === state.keyed) return
    state.keyed = now
    await deps.ctx.websearch.reload()
  }
  const reread = () => void refresh().catch((error: unknown) => log.error("websearch_reload_failed", { error }))
  reread()
  return deps.runtime.broadcast.on("searchKey.changed", (payload) => {
    if (payload.service === ID) reread()
  })
}

/** The websearch fold: `brave` while its key is in the vault. Never sets or changes the default. */
export function fold(editor: WebSearchEditor, keyed: boolean, execute: WebSearchDefinition["execute"]) {
  if (keyed) editor.add({ id: ID, name: NAME, execute })
}

/** How a query ended. */
export type Outcome =
  | { readonly type: "ok"; readonly results: WebSearch.Result[] }
  | { readonly type: "failed"; readonly code: string }

/** The service's `execute`: one query, logged; a failure throws an error that names only its code. */
export function create(deps: Deps): WebSearchDefinition["execute"] {
  const log = deps.log.child("websearch")
  return async (input, context) => {
    const begin = performance.now()
    const outcome = await search(deps, input.query, context.signal)
    log.info("websearch_query", {
      provider: ID,
      durationMs: Math.round(performance.now() - begin),
      results: outcome.type === "ok" ? outcome.results.length : 0,
      ...(outcome.type === "failed" ? { error: outcome.code } : {}),
    })
    if (outcome.type === "failed") throw new Error(`Brave web search failed (${outcome.code})`)
    return outcome.results
  }
}

/** One query with the vault's key, within {@link TIMEOUT_MS} or until `cancel`. Never throws. */
export async function search(deps: Deps, query: string, cancel: AbortSignal): Promise<Outcome> {
  const failed = (code: string): Outcome => ({ type: "failed", code })
  const text = cut(query)
  if (text === "") return failed("empty_query")
  const auth = await deps.runtime.credentials.featureHeaders(KEY_ID, { header: "X-Subscription-Token" })
  if (!auth.ok) return failed(auth.problem === "not_found" ? "no_key" : "vault_unavailable")
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT_MS)])
  // Never followed: a redirect would carry the key header to the host it names. A 3xx fails as `status_3xx`.
  const response = await fetch(url(deps.endpoints.url.brave, text), {
    headers: { ...auth.headers, accept: "application/json" },
    redirect: "manual",
    signal,
  }).catch(() => undefined)
  if (!response) return failed(interrupted(signal))
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) return failed("auth")
    return failed(response.status === 429 ? "rate_limit" : `status_${response.status}`)
  }
  const answer = read(await response.text().catch(() => ""))
  if (!answer) return failed(signal.aborted ? interrupted(signal) : "bad_response")
  return { type: "ok", results: results(answer) }
}

/** The request URL of one search: the cut query, {@link COUNT}, extra snippets, and Korean for a Hangul query. */
export function url(base: string, query: string) {
  const target = new URL(`${base.replace(/\/+$/, "")}/web/search`)
  target.searchParams.set("q", cut(query))
  target.searchParams.set("count", String(COUNT))
  target.searchParams.set("extra_snippets", "true")
  if (/\p{Script=Hangul}/u.test(query)) {
    target.searchParams.set("search_lang", "ko")
    target.searchParams.set("country", "KR")
  }
  return target.href
}

/** The query trimmed and cut to {@link MAX_WORDS} words and {@link MAX_QUERY} characters (code points). */
export function cut(query: string) {
  const words = query.trim().split(/\s+/).slice(0, MAX_WORDS).join(" ")
  return Array.from(words).slice(0, MAX_QUERY).join("").trimEnd()
}

const Item = Schema.Struct({
  title: optional(Schema.NullOr(Schema.String)),
  url: optional(Schema.NullOr(Schema.String)),
  description: optional(Schema.NullOr(Schema.String)),
  extra_snippets: optional(Schema.NullOr(Schema.Array(Schema.String))),
  page_age: optional(Schema.NullOr(Schema.String)),
})
export type Item = typeof Item.Type
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ web: optional(Schema.Struct({ results: optional(Schema.Array(Schema.Unknown)) })) }),
  ),
)
const decodeItem = Schema.decodeUnknownOption(Item)

/** The web results of an answer (`web.results`, none when Brave found no web page); `undefined` if no such body. */
export function read(text: string): ReadonlyArray<Item> | undefined {
  const answer = Option.getOrUndefined(decodeAnswer(text))
  return answer && (answer.web?.results ?? []).flatMap((entry) => Option.toArray(decodeItem(entry)))
}

/**
 * Core's results of an answer: http(s) addresses only, each once, in Brave's order; the title, the description and
 * the extra snippets (each once) as content, without Brave's highlight markup; `page_age` (ISO 8601) as the
 * publication time when it parses (`age` is display text such as "2 days ago" and is not read).
 */
export function results(items: ReadonlyArray<Item>): WebSearch.Result[] {
  const pages = items.flatMap((item) => {
    const url = item.url ? URL.parse(item.url) : null
    return url?.protocol === "https:" || url?.protocol === "http:" ? [{ item, url: url.href }] : []
  })
  return pages
    .filter((page, index) => pages.findIndex((other) => other.url === page.url) === index)
    .map((page) => {
      const title = plain(page.item.title ?? "")
      const parts = [page.item.description ?? "", ...(page.item.extra_snippets ?? [])].map(plain).filter(Boolean)
      const content = [...new Set(parts)].join("\n\n")
      const published = page.item.page_age ? Date.parse(page.item.page_age) : Number.NaN
      return {
        url: page.url,
        ...(title ? { title } : {}),
        ...(content ? { content } : {}),
        time: Number.isFinite(published) ? { published } : {},
      }
    })
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
}

/** Brave's text without its HTML highlight tags (`<strong>…</strong>`) and with its common entities decoded. */
function plain(text: string) {
  return text
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .trim()
}

/** Whether the key is in the vault now. */
async function keyed(deps: Deps) {
  return (await deps.runtime.credentials.inspectFeatureKey(KEY_ID)).configured
}

/** Why a request ended without an answer: the timeout, core cancelling the tool call, else the network. */
function interrupted(signal: AbortSignal) {
  if (!signal.aborted) return "network"
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled"
}

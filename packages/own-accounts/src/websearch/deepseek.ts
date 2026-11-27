export * as DeepSeekSearch from "./deepseek.js"

import { Option, Schema } from "effect"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { optional } from "@opencode/schema/schema"
import type { WebSearch } from "@opencode/schema/websearch"
import { type Account, OwnID, type Registry } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { Modules } from "../modules.js"
import { Registration } from "../slots/registration.js"

/**
 * own's web search service `own-deepseek` (02 §9.2 웹 검색 서비스, SP 2026-10-19): core's `websearch` tool searches with
 * DeepSeek's Search API (`POST {deepseek}/tools/search`, in production `https://api.deepseek.com/v1/tools/search`)
 * and the key of the user's DeepSeek (`ds`) account, whatever model or harness the session runs. A search that answers
 * HTTP 200 with results costs that account's balance $0.75 per 1,000 (an empty or failed one is free), and the query
 * goes to DeepSeek's servers in China, so the service only answers when the user chose it (or core's `random` drew it
 * from the list the user allowed).
 * - Registered on every Location while a `ds` account is there and not turned off (any status but `disabled` and
 *   `retired`, as `own-chatgpt` since WM), so a chosen DeepSeek never hands searches to another service silently; a
 *   search without a usable account fails instead. Never core's default (`editor.default` is not touched). Accounts
 *   changing reload the fold.
 * - A query goes to the first ready (or unverified) `ds` account without an exhaustion, in registry order, and on to
 *   the next one on 402 (insufficient balance) or a login failure (no key, 401); any other failure ends the query.
 * - The query is cut to {@link MAX_QUERY} characters (the API's limit, counted in characters: a 128-character Korean
 *   query of 296 UTF-8 bytes went through live). Results: title, url, `summary` (else `snippet`) as content cut to
 *   {@link MAX_CONTENT}, `date` as the publication time, in the API's order. Full page `content` is not asked for.
 * - Logged once per query: `websearch_query` with the slot, duration, result count and error code; a search DeepSeek
 *   bills also writes an events-ledger line `websearch` with its account and estimated cost. Never the query or a key.
 */

export const ID = "own-deepseek"

export const NAME = Registration.KIND_NAMES.ds

/** The session id `logins.headers` gets for search requests; it names no session. */
export const SESSION = "own-accounts:websearch"

/** The API's longest query, in characters. */
export const MAX_QUERY = 128

/** Results asked for (1–50; the price is per request, not per result). */
export const COUNT = 10

/** A search without its whole answer by then fails. */
export const TIMEOUT_MS = 30_000

/** DeepSeek's price of one billed search: $0.75 per 1,000 requests with results (2026-10-19). */
export const PRICE_USD = 0.00075

/**
 * Longest content kept per result, in characters. The docs promise 600–800 for `summary`; live answers (2026-10-19)
 * ran from 150 to 4,500, so ten long ones would put some 45,000 characters into the model's context.
 */
export const MAX_CONTENT = 1_500

/** Registers the service on this Location; the result stops the reloads. */
export async function register(deps: Deps, modules: Modules.All) {
  const log = deps.log.child("websearch")
  const hook = Hooks.guard(log)
  const execute = create(deps, modules)
  await deps.ctx.websearch.transform((editor) =>
    hook.sync("websearch.transform:deepseek", () => fold(editor, modules.slots.snapshot(), execute)),
  )
  return deps.runtime.broadcast.on("store.changed", (payload) => {
    if (payload.store !== "accounts") return
    void deps.ctx.websearch.reload().catch((error: unknown) => log.error("websearch_reload_failed", { error }))
  })
}

/** The websearch fold: `own-deepseek` while a `ds` account is listed. Never sets or changes the default. */
export function fold(
  editor: WebSearchEditor,
  registry: Pick<Registry.File, "accounts">,
  execute: WebSearchDefinition["execute"],
) {
  if (registry.accounts.some(listed)) editor.add({ id: ID, name: NAME, execute })
}

/**
 * How a query ended. `slot`: the own slot of the account that answered or failed last. `billed`: DeepSeek charges
 * this search (HTTP 200 with at least one result, before own drops any).
 */
export type Outcome =
  | {
      readonly type: "ok"
      readonly slot: string
      readonly account: Account.Info
      readonly results: WebSearch.Result[]
      readonly billed: boolean
    }
  | { readonly type: "failed"; readonly slot?: string; readonly code: string }

/** The service's `execute`: one query, logged; a failure throws an error that names only its code. */
export function create(deps: Deps, modules: Modules.All): WebSearchDefinition["execute"] {
  const log = deps.log.child("websearch")
  return async (input, context) => {
    const begin = performance.now()
    const outcome = await search(deps, modules, input.query, context.signal)
    log.info("websearch_query", {
      provider: ID,
      ...(outcome.slot === undefined ? {} : { slot: outcome.slot }),
      durationMs: Math.round(performance.now() - begin),
      results: outcome.type === "ok" ? outcome.results.length : 0,
      ...(outcome.type === "failed" ? { error: outcome.code } : {}),
    })
    if (outcome.type === "failed") throw new Error(`DeepSeek web search failed (${outcome.code})`)
    if (outcome.billed) record(deps, outcome.account)
    return outcome.results
  }
}

/** Codes that move a query on to the next account. */
const FALLBACK: ReadonlySet<string> = new Set(["auth", "insufficient_balance"])

/**
 * One query over the ready `ds` accounts, in registry order, within {@link TIMEOUT_MS} or until `cancel`. Without a
 * usable one it fails at once: `insufficient_balance` when the ready ones are all exhausted (or an account is out of
 * balance), `auth` when the listed ones all need attention, `no_account` without any; `empty_query` for a blank query.
 */
export async function search(deps: Deps, modules: Modules.All, query: string, cancel: AbortSignal): Promise<Outcome> {
  const text = cut(query)
  if (text === "") return { type: "failed", code: "empty_query" }
  const registry = modules.slots.snapshot().accounts
  const accounts = registry.filter(ready)
  const usable = accounts.filter((account) => deps.runtime.limits.exhaustion(account.id) === undefined)
  if (usable.length === 0) return { type: "failed", code: unusable(registry, accounts) }
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT_MS)])
  const next = async ([account, ...rest]: ReadonlyArray<Account.Info>, last: Outcome): Promise<Outcome> => {
    if (!account) return last
    const outcome = await once(deps, modules, account, text, signal)
    return outcome.type === "failed" && FALLBACK.has(outcome.code) ? next(rest, outcome) : outcome
  }
  return next(usable, { type: "failed", code: "no_account" })
}

/** One request with one account. Never throws. */
async function once(
  deps: Deps,
  modules: Modules.All,
  account: Account.Info,
  query: string,
  signal: AbortSignal,
): Promise<Outcome> {
  const slot = account.providerID
  const failed = (code: string): Outcome => ({ type: "failed", slot, code })
  const auth = await modules.logins.headers(account, SESSION)
  if (!auth.ok) return failed("auth")
  const response = await fetch(`${deps.endpoints.url.deepseek.replace(/\/+$/, "")}/tools/search`, {
    method: "POST",
    headers: { ...auth.headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body(query)),
    signal,
  }).catch(() => undefined)
  if (!response) return failed(interrupted(signal))
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) {
      modules.logins.unauthorized(account)
      return failed("auth")
    }
    return failed(response.status === 402 ? "insufficient_balance" : `status_${response.status}`)
  }
  const text = await response.text().catch(() => undefined)
  if (text === undefined) return failed(interrupted(signal))
  const answer = read(text)
  if (!answer) return failed("bad_response")
  return { type: "ok", slot, account, results: results(answer), billed: answer.length > 0 }
}

/** The request body of one search: the cut query and {@link COUNT}; no full page content. */
export function body(query: string) {
  return { query: cut(query), count: COUNT }
}

/** The query trimmed and cut to {@link MAX_QUERY} characters (code points, so a surrogate pair is never split). */
export function cut(query: string) {
  return Array.from(query.trim()).slice(0, MAX_QUERY).join("").trimEnd()
}

const Item = Schema.Struct({
  title: optional(Schema.NullOr(Schema.String)),
  url: optional(Schema.NullOr(Schema.String)),
  snippet: optional(Schema.NullOr(Schema.String)),
  summary: optional(Schema.NullOr(Schema.String)),
  date: optional(Schema.NullOr(Schema.String)),
})
export type Item = typeof Item.Type
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Schema.Unknown) })),
)
const decodeItem = Schema.decodeUnknownOption(Item)

/** The answer's results (`{results: [...]}`), each entry as far as it has the fields read here; `undefined` if no such body. */
export function read(text: string): ReadonlyArray<Item> | undefined {
  return Option.getOrUndefined(decodeAnswer(text))?.results.flatMap((entry) => Option.toArray(decodeItem(entry)))
}

/**
 * Core's results of an answer: http(s) addresses only, each once, in the API's order (it ranks them by
 * `rerank_score` already); title, `summary` (DeepSeek's text written for a model) else `snippet` as content, cut to
 * {@link MAX_CONTENT}, and `date` (RFC 3339, or `null`) as the publication time when it parses.
 */
export function results(items: ReadonlyArray<Item>): WebSearch.Result[] {
  const pages = items.flatMap((item) => {
    const url = item.url ? URL.parse(item.url) : null
    return url?.protocol === "https:" || url?.protocol === "http:" ? [{ item, url: url.href }] : []
  })
  return pages
    .filter((page, index) => pages.findIndex((other) => other.url === page.url) === index)
    .map((page) => {
      const title = page.item.title?.trim()
      const content = shorten(page.item.summary?.trim() || page.item.snippet?.trim())
      const published = page.item.date ? Date.parse(page.item.date) : Number.NaN
      return {
        url: page.url,
        ...(title ? { title } : {}),
        ...(content ? { content } : {}),
        time: Number.isFinite(published) ? { published } : {},
      }
    })
}

/** `text` cut to {@link MAX_CONTENT} characters (code points), with an ellipsis when it was cut. */
function shorten(text: string | undefined) {
  if (!text) return undefined
  const characters = Array.from(text)
  return characters.length <= MAX_CONTENT ? text : `${characters.slice(0, MAX_CONTENT).join("").trimEnd()}…`
}

/**
 * A billed search in the events ledger (`events-YYYY-MM.jsonl`, 02 §2.3): the account it was charged to and its
 * estimated price. Usage lines stay model requests: a search belongs to no session or model step.
 */
export function record(deps: Deps, account: Account.Info) {
  void deps.runtime.ledger
    .event({
      eid: `ws_${OwnID.ulid(deps.clock.now())}`,
      type: "websearch",
      accountID: account.id,
      providerID: account.providerID,
      data: { service: ID, cost: { unit: "USD", amount: PRICE_USD, source: "estimate" } },
    })
    .catch((error: unknown) => deps.log.child("websearch").warn("websearch_record_failed", { error }))
}

/** Why a request ended without an answer: the timeout, core cancelling the tool call, else the network. */
function interrupted(signal: AbortSignal) {
  if (!signal.aborted) return "network"
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled"
}

/** Why no account may search: all ready ones (or the rest) are out of balance, all listed ones need a login, or none. */
function unusable(registry: ReadonlyArray<Account.Info>, ready: ReadonlyArray<Account.Info>) {
  if (ready.length > 0 || registry.some((account) => account.kind === "ds" && account.status === "exhausted"))
    return "insufficient_balance"
  return registry.some(listed) ? "auth" : "no_account"
}

/** A `ds` account that keeps the service registered: there and not turned off by the user or removed. */
function listed(account: Account.Info) {
  return account.kind === "ds" && account.status !== "disabled" && account.status !== "retired"
}

/** A `ds` account whose key may be used: ready, or not verified yet (the planner's rule). */
function ready(account: Account.Info) {
  return account.kind === "ds" && (account.status === "ready" || account.status === "unverified")
}

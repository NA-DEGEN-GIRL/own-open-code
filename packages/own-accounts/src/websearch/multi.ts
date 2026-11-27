export * as MultiSearch from "./multi.js"

import { readFileSync } from "node:fs"
import { Option, Schema } from "effect"
import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import type { WebSearch } from "@opencode/schema/websearch"
import { Approval, Kv } from "@own/protocol"
import type { Clock } from "../clock.js"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { Modules } from "../modules.js"
import { CoreConfig } from "../slots/core-config.js"
import { BraveSearch } from "./brave.js"
import { ChatGPTSearch } from "./chatgpt.js"
import { DeepSeekSearch } from "./deepseek.js"
import { KeyedSearch } from "./keyed.js"

/**
 * own's web search service `own-multi` (`여러 서비스 함께`, 03 §18.2, 02 §9.2, MS 2026-10-19): one search asks every
 * service of the user's selection at once and merges their answers. The user asked (2026-10-19) whether several
 * services could be used instead of one; `random` asks one per conversation and moves on only after an HTTP 429.
 * - Registered only while own's global config names it (`{provider:"own-multi"}`, what `websearch.set{multi}` writes),
 *   so core's `random` never draws it and the first-use form never lists it. Core's config fold is a `post` plugin
 *   that runs after this one (packages/core/src/plugin/internal.ts), so the fold reads the file itself: core's config
 *   watcher reloads the services after the file changed, and the fold reads it again then. A project config's
 *   `websearch` is not looked at (own never writes one).
 * - The selection is own's KV row `websearch:multi` (`{services}`), else {@link defaults}: ChatGPT while listed and
 *   core's keyless services without a key of core's; own's paid DeepSeek and Brave and a service with a key in core
 *   are never in the default. A keyless service whose key is in own's vault (SK 2026-10-23) is asked with that key
 *   through own's keyed variant (`own-exa` for `exa`, {@link KeyedSearch.resolve}), the default included: the user
 *   put the key in for this. Only services listed now are asked, in the selection's order; own's own (ChatGPT,
 *   DeepSeek, Brave, the keyed variants) directly with a signal, the others through core's `websearch.query` with that
 *   `providerID` (core's MCP requests keep their own 25 s timeout and cannot be cancelled from here, so a late one
 *   finishes unheard). No network host is added: each service's request is its own.
 * - Time limit ({@link LIMITS}): the answer goes back when every service answered, else 8 s after the first answer
 *   with results, else at the 25 s cap. A ChatGPT search still running is waited for until the cap: its searches take
 *   9–21 s, and its subscription usage is spent whether or not its answer is used.
 * - A service that fails, times out, or answers empty while another found results is left out of the query and
 *   cooled down (2 min, doubling on each further miss up to 30 min, cleared by an answer with results). An empty
 *   answer is how Exa's and Firecrawl's keyless servers look to core once their free tier is used up (upstream
 *   #54311). When every chosen service is cooling down, all are asked anyway. When none answers, the search fails
 *   with each service's reason.
 * - Merge: one result per page (the {@link normalize}d address), ranked by reciprocal rank fusion (k 60) across the
 *   services, at most {@link LIMITS} `results`; each keeps its best-ranked title, text and date and ends with a line
 *   `Found by: ChatGPT, Exa` (the services' names), which the model reads and own-web's card counts.
 * - Logged once per query: `websearch_query` with `provider:"own-multi"`, the duration, the merged count and per
 *   service its duration, result count and error code, and the services skipped while cooling down. Never the query
 *   or a key. A billed DeepSeek search writes its events-ledger line as `own-deepseek` does.
 */

export const ID = Approval.WEB_SEARCH_MULTI

export const NAME = "여러 서비스"

/** Core's keyless services (packages/core/src/plugin/websearch/): free without a key, within limits. */
export const KEYLESS = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"] as const

/** The time limits, the result count, the fusion constant and the cooldown. */
export const LIMITS = {
  /** After the first answer with results, the others get this long. */
  graceMs: 8_000,
  /** No search waits longer. */
  capMs: 25_000,
  /** Merged results kept (the services ask for 8 to 10 each). */
  results: 10,
  /** Reciprocal rank fusion's `k`. */
  rrfK: 60,
  /** First cooldown after a miss; doubles per further miss. */
  cooldownMs: 120_000,
  cooldownMaxMs: 1_800_000,
} as const

export type Limits = { readonly [K in keyof typeof LIMITS]: number }

/** Services worth waiting for until the cap (see the module comment). */
const PATIENT: ReadonlySet<string> = new Set([ChatGPTSearch.ID])

/** The line each merged result ends with. */
export const FOUND_BY = "Found by: "

/** Registers the service on this Location (it appears only while chosen); the result is a no-op stop. */
export async function register(deps: Deps, modules: Modules.All) {
  const hook = Hooks.guard(deps.log.child("websearch"))
  const execute = create(deps, modules)
  await deps.ctx.websearch.transform((editor) =>
    hook.sync("websearch.transform:multi", () => fold(editor, chosen(deps.configDir), execute)),
  )
  return () => undefined
}

/** The websearch fold: `own-multi` while it is chosen. Never sets or changes the default. */
export function fold(editor: WebSearchEditor, isChosen: boolean, execute: WebSearchDefinition["execute"]) {
  if (isChosen) editor.add({ id: ID, name: NAME, execute })
}

/**
 * Whether own's global config names `own-multi` now. Read synchronously because core's folds are synchronous; the
 * file is small and read only when the services are folded again.
 */
export function chosen(configDir: string | undefined) {
  if (!configDir) return false
  const text = readConfig(CoreConfig.file(configDir))
  return text !== undefined && CoreConfig.webSearchOf(text)?.type === "multi"
}

function readConfig(file: string) {
  // A missing or unreadable file names nothing.
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const Stored = Schema.Struct({ services: Schema.Array(Schema.String) })
const decodeStored = Schema.decodeUnknownOption(Stored)

/** The stored selection, `undefined` without one. */
export async function stored(deps: Pick<Deps, "ctx">) {
  const value = await deps.ctx.storage.get(Kv.websearchMulti).catch(() => undefined)
  return Option.getOrUndefined(decodeStored(value))?.services
}

export async function store(deps: Pick<Deps, "ctx">, services: readonly string[]) {
  await deps.ctx.storage.set(Kv.websearchMulti, { services: [...services] })
}

/**
 * own's default selection over the services listed now: ChatGPT while listed, then the keyless ones without a key in
 * core (`keys`), each with the user's key from own's vault when its keyed variant is listed.
 */
export function defaults(listed: readonly string[], keys: Readonly<Record<string, Approval.WebSearchKey>> | undefined) {
  return [
    ...(listed.includes(ChatGPTSearch.ID) ? [ChatGPTSearch.ID] : []),
    ...KEYLESS.filter((id) => !keys?.[id])
      .map((id) => KeyedSearch.resolve(id, listed))
      .filter((id) => listed.includes(id)),
  ]
}

/**
 * The selection `websearch.get` shows and a search asks: the stored one, else {@link defaults}; each service as it is
 * asked now (with or without the user's key, {@link KeyedSearch.resolve}), once.
 */
export async function selection(
  deps: Pick<Deps, "ctx">,
  listed: readonly string[],
  keys: Readonly<Record<string, Approval.WebSearchKey>> | undefined,
): Promise<Approval.WebSearchMulti> {
  const services = await stored(deps)
  if (!services) return { services: defaults(listed, keys), custom: false }
  return { services: [...new Set(services.map((id) => KeyedSearch.resolve(id, listed)))], custom: true }
}

/** One service's answer to one query. */
export type Answer =
  | { readonly type: "ok"; readonly results: readonly WebSearch.Result[] }
  | { readonly type: "failed"; readonly code: string }

/** A service of the selection as a search asks it. `run` never throws. */
export interface Member {
  readonly id: string
  readonly name: string
  readonly run: (query: string, signal: AbortSignal) => Promise<Answer>
}

/** How a member ended in one query: its answer and how long it took, `timeout` past the deadline, `cancelled`. */
export interface Settled {
  readonly id: string
  readonly name: string
  readonly answer: Answer
  readonly ms: number
}

/** The service's `execute`: one query over the selection, logged once; it fails only when no service answered. */
export function create(deps: Deps, modules: Modules.All): WebSearchDefinition["execute"] {
  const log = deps.log.child("websearch")
  const cooling = cooldowns(deps)
  return async (input, context) => {
    const begin = deps.clock.now()
    const listed = (await deps.ctx.websearch.providers()).data.filter((provider) => provider.id !== ID)
    const keys = await readKeys(deps)
    const chosen = (
      await selection(
        deps,
        listed.map((provider) => provider.id),
        keys,
      )
    ).services.flatMap((id) => listed.find((provider) => provider.id === id) ?? [])
    const ready = chosen.filter((provider) => !cooling.active(provider.id))
    const asked = ready.length > 0 ? ready : chosen
    const settled = await ask(
      deps.clock,
      asked.map((provider) => member(deps, modules, provider)),
      input.query,
      context.signal,
    )
    const found = settled.some((item) => item.answer.type === "ok" && item.answer.results.length > 0)
    for (const item of settled) {
      if (item.answer.type === "ok" && item.answer.results.length > 0) cooling.clear(item.id)
      else if (item.answer.type === "failed" ? item.answer.code !== "cancelled" : found) cooling.miss(item.id)
    }
    const results = merge(settled)
    log.info("websearch_query", {
      provider: ID,
      durationMs: Math.round(deps.clock.now() - begin),
      results: results.length,
      services: settled.map((item) => ({
        id: item.id,
        durationMs: Math.round(item.ms),
        ...(item.answer.type === "ok" ? { results: item.answer.results.length } : { error: item.answer.code }),
      })),
      ...(asked.length < chosen.length
        ? { skipped: chosen.filter((provider) => !asked.includes(provider)).map((provider) => provider.id) }
        : {}),
      ...(chosen.length === 0 ? { error: "no_service" } : {}),
    })
    if (chosen.length === 0) throw new Error("Multi-service web search failed (no_service)")
    if (settled.every((item) => item.answer.type === "failed"))
      throw new Error(
        `Web search failed on every service (${settled
          .map((item) => `${item.name}: ${item.answer.type === "failed" ? item.answer.code : ""}`)
          .join(", ")})`,
      )
    return results
  }
}

/**
 * Asks every member at once and settles when all answered, `graceMs` after the first answer with results (the cap
 * while a {@link PATIENT} one is still running), at `capMs`, or when `cancel` fires. Members still running then are
 * `timeout` (`cancelled` after `cancel`) and their signal is aborted.
 */
export function ask(
  clock: Clock.Clock,
  members: readonly Member[],
  query: string,
  cancel: AbortSignal,
  limits: Limits = LIMITS,
): Promise<Settled[]> {
  const begin = clock.now()
  const stop = new AbortController()
  const signal = AbortSignal.any([cancel, stop.signal])
  const answers = new Map<string, Settled>()
  return new Promise((resolve) => {
    const state: { done: boolean; firstAt?: number; timer?: () => void } = { done: false }
    const finish = () => {
      if (state.done) return
      state.done = true
      state.timer?.()
      cancel.removeEventListener("abort", finish)
      const code = cancel.aborted ? "cancelled" : "timeout"
      resolve(
        members.map(
          (item) =>
            answers.get(item.id) ?? {
              id: item.id,
              name: item.name,
              answer: { type: "failed", code },
              ms: clock.now() - begin,
            },
        ),
      )
      stop.abort()
    }
    const check = () => {
      const running = members.filter((item) => !answers.has(item.id))
      if (running.length === 0 || cancel.aborted) return finish()
      const waits = state.firstAt === undefined || running.some((item) => PATIENT.has(item.id))
      const deadline = waits ? begin + limits.capMs : Math.min(begin + limits.capMs, state.firstAt! + limits.graceMs)
      state.timer?.()
      state.timer = clock.schedule(deadline - clock.now(), finish)
    }
    cancel.addEventListener("abort", finish)
    for (const item of members)
      void item
        .run(query, signal)
        .catch((): Answer => ({ type: "failed", code: "error" }))
        .then((answer) => {
          if (state.done) return
          answers.set(item.id, { id: item.id, name: item.name, answer, ms: clock.now() - begin })
          if (state.firstAt === undefined && answer.type === "ok" && answer.results.length > 0)
            state.firstAt = clock.now()
          check()
        })
    check()
  })
}

/**
 * The merged results: one per page (the {@link normalize}d address), by reciprocal rank fusion over the services'
 * ranks (a service listing a page twice counts once, at its better rank), ties by the best rank and then the
 * services' order. Each takes the best-ranked hit's address and the first title, text and date in hit order, and ends
 * with {@link FOUND_BY} and the services that found it.
 */
export function merge(settled: readonly Settled[], limits: Pick<Limits, "results" | "rrfK"> = LIMITS) {
  type Hit = { readonly order: number; readonly rank: number; readonly name: string; readonly result: WebSearch.Result }
  const pages = new Map<string, { score: number; hits: Hit[] }>()
  settled.forEach((item, order) => {
    if (item.answer.type !== "ok") return
    item.answer.results.forEach((result, rank) => {
      const key = normalize(result.url)
      if (key === undefined) return
      const page = pages.get(key) ?? { score: 0, hits: [] }
      if (page.hits.some((hit) => hit.order === order)) return
      page.score += 1 / (limits.rrfK + rank + 1)
      page.hits.push({ order, rank, name: item.name, result })
      pages.set(key, page)
    })
  })
  const best = (hits: readonly Hit[]) => hits.toSorted((a, b) => a.rank - b.rank || a.order - b.order)
  return [...pages.values()]
    .map((page) => ({ ...page, hits: best(page.hits) }))
    .sort((a, b) => b.score - a.score || a.hits[0]!.rank - b.hits[0]!.rank || a.hits[0]!.order - b.hits[0]!.order)
    .slice(0, limits.results)
    .map((page): WebSearch.Result => {
      const title = page.hits.find((hit) => hit.result.title)?.result.title
      const content = page.hits.find((hit) => hit.result.content)?.result.content
      const published = page.hits.find((hit) => hit.result.time.published !== undefined)?.result.time.published
      const names = page.hits.toSorted((a, b) => a.order - b.order).map((hit) => hit.name)
      return {
        url: page.hits[0]!.result.url,
        ...(title ? { title } : {}),
        content: [content, `${FOUND_BY}${names.join(", ")}`].filter(Boolean).join("\n\n"),
        time: published === undefined ? {} : { published },
      }
    })
}

/** Query parameters that only track where a click came from. */
const TRACKING = /^(?:utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|srsltid|_hsenc|_hsmi|ref_src)$/i

/**
 * A page's address as the merge compares it: http and https alike, the host in lower case without `www.`, the path
 * without a trailing slash, no fragment, no tracking parameters, the other parameters sorted. `undefined` for an
 * address that is not http(s).
 */
export function normalize(url: string) {
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return undefined
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
  const params = [...parsed.searchParams]
    .filter(([name]) => !TRACKING.test(name))
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ""
  return `${host}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname.replace(/\/+$/, "")}${query}`
}

/** A listed service as a member: own's own directly, any other through core's `websearch.query`. */
function member(deps: Deps, modules: Modules.All, provider: { readonly id: string; readonly name: string }): Member {
  const ok = (results: readonly WebSearch.Result[]): Answer => ({ type: "ok", results })
  const failed = (code: string): Answer => ({ type: "failed", code })
  const run = (): Member["run"] => {
    if (provider.id === ChatGPTSearch.ID)
      return async (query, signal) => {
        const outcome = await ChatGPTSearch.search(deps, modules, query, signal)
        return outcome.type === "ok" ? ok(outcome.results) : failed(outcome.code)
      }
    if (provider.id === DeepSeekSearch.ID)
      return async (query, signal) => {
        const outcome = await DeepSeekSearch.search(deps, modules, query, signal)
        if (outcome.type === "failed") return failed(outcome.code)
        if (outcome.billed) DeepSeekSearch.record(deps, outcome.account)
        return ok(outcome.results)
      }
    if (provider.id === BraveSearch.ID)
      return async (query, signal) => {
        const outcome = await BraveSearch.search(deps, query, signal)
        return outcome.type === "ok" ? ok(outcome.results) : failed(outcome.code)
      }
    const keyed = KeyedSearch.serviceOf(provider.id)
    if (keyed)
      return async (query, signal) => {
        const outcome = await KeyedSearch.search(deps, keyed, query, signal)
        return outcome.type === "ok" ? ok(outcome.results) : failed(outcome.code)
      }
    return (query) =>
      deps.ctx.websearch.query({ query, providerID: provider.id }).then(
        (response) => ok(response.data.results),
        (error: unknown) => failed(requestCode(error)),
      )
  }
  return { id: provider.id, name: provider.name, run: run() }
}

/** A core `websearch.query` failure as a code: `status_<n>` for an HTTP failure, else the error's kind. */
function requestCode(error: unknown) {
  const tagged = error as { readonly _tag?: unknown; readonly cause?: { readonly response?: { status?: unknown } } }
  const status = tagged?.cause?.response?.status
  if (typeof status === "number") return `status_${status}`
  if (tagged?._tag === "WebSearch.ProviderNotFound") return "not_listed"
  return tagged?._tag === "WebSearch.Request" ? "request_failed" : "error"
}

/** Missed services and until when they are left out; one table per process (a used-up quota is everyone's). */
const tables = new WeakMap<object, Map<string, { until: number; misses: number }>>()

export function cooldowns(
  deps: Pick<Deps, "runtime" | "clock">,
  limits: Pick<Limits, "cooldownMs" | "cooldownMaxMs"> = LIMITS,
) {
  const table = tables.get(deps.runtime) ?? new Map<string, { until: number; misses: number }>()
  tables.set(deps.runtime, table)
  return {
    active: (id: string) => (table.get(id)?.until ?? 0) > deps.clock.now(),
    miss: (id: string) => {
      const misses = (table.get(id)?.misses ?? 0) + 1
      const wait = Math.min(limits.cooldownMs * 2 ** (misses - 1), limits.cooldownMaxMs)
      table.set(id, { until: deps.clock.now() + wait, misses })
    },
    clear: (id: string) => void table.delete(id),
  }
}

/**
 * Which listed services use the user's own key (`websearch.get`'s `keys`, 03 §18.2): a stored key (`key`) or an
 * environment variable (`env`) on the service's same-id integration. `undefined` when either list fails.
 */
export async function readKeys(deps: Pick<Deps, "ctx">) {
  const [providers, integrations] = await Promise.all([
    deps.ctx.websearch.providers().then(
      (result) => result.data,
      () => undefined,
    ),
    deps.ctx.integration.list().then(
      (result) => result.data,
      () => undefined,
    ),
  ])
  if (!providers || !integrations) return undefined
  return Object.fromEntries(
    providers.flatMap((provider): Array<[string, Approval.WebSearchKey]> => {
      const connections = integrations.find((integration) => integration.id === provider.id)?.connections ?? []
      if (connections.some((connection) => connection.type === "credential")) return [[provider.id, "key"]]
      if (connections.some((connection) => connection.type === "env")) return [[provider.id, "env"]]
      return []
    }),
  )
}

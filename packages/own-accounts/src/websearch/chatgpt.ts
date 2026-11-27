export * as ChatGPTSearch from "./chatgpt.js"

import type { WebSearchDefinition, WebSearchEditor } from "@opencode/plugin/promise/websearch"
import { Provider } from "@opencode/schema/provider"
import type { WebSearch } from "@opencode/schema/websearch"
import type { Account, Registry } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { Modules } from "../modules.js"
import { CodexMeta } from "../slots/codex-meta.js"
import { Registration } from "../slots/registration.js"
import { Windows } from "../telemetry/windows.js"
import { SearchWire } from "./wire.js"

/**
 * own's web search service `own-chatgpt` (02 §9.2 웹 검색 서비스): core's `websearch` tool searches with the user's
 * ChatGPT subscription, whatever model or harness the session runs, by asking the Codex backend for one streamed
 * answer with its hosted `web_search` tool (`SearchWire`). It spends that account's Codex usage like a model request.
 * - Registered on every Location while a `codex` account is there and not turned off (any status but `disabled` and
 *   `retired`), and core's default while nothing else is selected: core's config plugin folds the user's `websearch`
 *   key after this plugin (a `post` internal plugin), so a choice in `opencode.jsonc` (a service, `random`, off or
 *   `own-multi`) always wins. Accounts
 *   changing reload the fold. A login that needs attention keeps it registered (2026-10-19, WM): dropping it made the
 *   server fall back to an earlier first-use answer, often `random` over third-party services, so searches silently
 *   went elsewhere; now such a search fails with `auth` and the user sees ChatGPT named on the card.
 * - A query goes to the first such account that is not at its usage limit (the planner's rule, `runtime.limits`),
 *   and on to the next one when an account's login fails or it hits its usage limit; any other failure ends the query.
 *   The `x-codex-*` usage headers of each answer update that account's windows, as a session request's would.
 * - Logged once per query: `websearch_query` with the slot, duration, result count and error code. Never the query,
 *   a token, an e-mail or a ChatGPT account id.
 */

export const ID = "own-chatgpt"

export const NAME = Registration.KIND_NAMES.codex

/** The `session-id` header of search requests; it names no session. */
export const SESSION = "own-accounts:websearch"

/** A search without its whole answer by then fails. */
export const TIMEOUT_MS = 60_000

/** Registers the service on this Location; the result stops the reloads. */
export async function register(deps: Deps, modules: Modules.All) {
  const log = deps.log.child("websearch")
  const hook = Hooks.guard(log)
  const execute = create(deps, modules)
  await deps.ctx.websearch.transform((editor) =>
    hook.sync("websearch.transform", () => fold(editor, modules.slots.snapshot(), execute)),
  )
  return deps.runtime.broadcast.on("store.changed", (payload) => {
    if (payload.store !== "accounts") return
    void deps.ctx.websearch.reload().catch((error: unknown) => log.error("websearch_reload_failed", { error }))
  })
}

/**
 * The websearch fold: `own-chatgpt` while a codex account is listed, and the default when no earlier fold chose one
 * (no `websearch` key in the config, no other plugin's default). Never overrides a choice.
 */
export function fold(
  editor: WebSearchEditor,
  registry: Pick<Registry.File, "accounts">,
  execute: WebSearchDefinition["execute"],
) {
  if (!registry.accounts.some(listed)) return
  editor.add({ id: ID, name: NAME, execute })
  if (editor.default.get() === undefined) editor.default.set(ID)
}

/** How a query ended. `slot`: the own slot of the account that answered or failed last. */
export type Outcome =
  | { readonly type: "ok"; readonly slot: string; readonly results: WebSearch.Result[] }
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
    if (outcome.type === "failed") throw new Error(`ChatGPT web search failed (${outcome.code})`)
    return outcome.results
  }
}

/** Codes that move a query on to the next account. */
const FALLBACK: ReadonlySet<string> = new Set(["auth", "usage_limit"])

/**
 * One query over the ready codex accounts, in registry order, within {@link TIMEOUT_MS} or until `cancel`. Without a
 * ready one it fails at once: `usage_limit` when they are all at their limit, `auth` when the listed ones all need a
 * login, else `no_account`.
 */
export async function search(deps: Deps, modules: Modules.All, query: string, cancel: AbortSignal): Promise<Outcome> {
  const registry = modules.slots.snapshot().accounts
  const accounts = registry.filter(ready)
  const usable = accounts.filter((account) => !exhausted(deps, account.id))
  if (usable.length === 0)
    return {
      type: "failed",
      code: accounts.length > 0 ? "usage_limit" : registry.some(listed) ? "auth" : "no_account",
    }
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT_MS)])
  const next = async ([account, ...rest]: ReadonlyArray<Account.Info>, last: Outcome): Promise<Outcome> => {
    if (!account) return last
    const outcome = await once(deps, modules, account, query, signal)
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
  const choice = SearchWire.choose([await CodexMeta.accountList(deps, account.id), await CodexMeta.snapshot(deps)])
  const response = await fetch(`${deps.endpoints.url.codex.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: { ...auth.headers, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(SearchWire.body({ ...choice, query })),
    signal,
  }).catch(() => undefined)
  if (!response) return failed(interrupted(signal))
  publish(deps, account, response)
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401) modules.logins.unauthorized(account)
    if (response.status === 401 || response.status === 403) return failed("auth")
    return failed(response.status === 429 ? "usage_limit" : `status_${response.status}`)
  }
  const text = await response.text().catch(() => undefined)
  if (text === undefined) return failed(interrupted(signal))
  const read = SearchWire.read(text)
  if (read.end === "failed") {
    const code = read.code ?? "response_failed"
    return failed(/usage_limit|rate_limit|insufficient_quota/.test(code) ? "usage_limit" : code)
  }
  if (read.end === "cut" && read.items.length === 0) return failed("incomplete_stream")
  return { type: "ok", slot, results: SearchWire.results(read.items) }
}

/** The answer's `x-codex-*` usage headers → the account's windows, announced like a session request's (02 §7.1). */
function publish(deps: Deps, account: Account.Info, response: Response) {
  const windows = Windows.codexHeaders(
    response.headers,
    { accountID: account.id, providerID: Provider.ID.make(account.providerID) },
    { observedAt: deps.clock.now(), source: response.ok ? "header" : "error" },
  )
  if (windows.length === 0) return
  const changed = deps.runtime.limits.upsert(windows)
  if (changed.length > 0) deps.runtime.broadcast.emit("limits.updated", { windows: changed })
}

/** Why a request ended without an answer: the timeout, core cancelling the tool call, else the network. */
function interrupted(signal: AbortSignal) {
  if (!signal.aborted) return "network"
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled"
}

/** A codex account that keeps the service registered: there and not turned off by the user or removed. */
function listed(account: Account.Info) {
  return account.kind === "codex" && account.status !== "disabled" && account.status !== "retired"
}

/** A codex account whose login may be used: ready, or not verified yet (the planner's rule). */
function ready(account: Account.Info) {
  return account.kind === "codex" && (account.status === "ready" || account.status === "unverified")
}

/** At its usage limit now: a classified exhaustion, or a plan window the backend reported exhausted. */
function exhausted(deps: Deps, accountID: string) {
  return (
    deps.runtime.limits.exhaustion(accountID) !== undefined ||
    deps.runtime.limits
      .list({ accountID })
      .some((window) => window.kind === "rolling_quota" && window.status === "exhausted")
  )
}

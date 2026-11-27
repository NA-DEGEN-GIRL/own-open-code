export * as Poller from "./poller.js"

import type { Account, Limit, OwnError } from "@own/protocol"
import type { Credentials } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { ResetCredits } from "./reset-credits.js"
import { Windows } from "./windows.js"

/**
 * Leader poller (02 §7.2 "poller"), at most once per account every {@link INTERVAL_MS}:
 * - DeepSeek `GET /user/balance`, for accounts with `pollBalance: true`. New `ds`, `or` and `xai` accounts start with
 *   it on (slots.ts `POLL_BALANCE`); the account menu turns it off (`false`), and `null`/absent (older accounts) means
 *   off. OpenRouter `/api/v1/key` and xAI key info are not implemented yet, so only `ds` accounts are asked.
 * - ChatGPT `GET <chatgpt>/wham/usage` for `codex` accounts (CL, 2026-10-18; what Codex CLI's `/status` reads), unless
 *   `pollBalance: false`, and only while the account has no plan window observed within {@link INTERVAL_MS}: the
 *   requests' own headers and `codex.rate_limits` frames come first, the poll fills the gaps (after a restart, an
 *   account no conversation uses, a path whose observations never arrived). The same answer carries the account's
 *   reset credit count (`rate_limit_reset_credits`, 02 §7.1.1), published with the windows; the poller never reads
 *   the credits' details and never redeems one.
 * - Never for Sign in with ChatGPT (`siwc`), though it is the same plan: OpenAI's token-sharing guide says not to point
 *   that token at ChatGPT's `backend-api` (where `wham/usage` lives), and its access token carries no account id
 *   (opaque auth metadata). Its answers carry no plan headers either (02 §7.1), so a siwc account shows none.
 */

export const INTERVAL_MS = 15 * 60_000
/** How often the leader checks which accounts are due. */
export const TICK_MS = 60_000
export const TIMEOUT_MS = 10_000
/** Session id passed to `logins.headers` for poller requests (no session exists). */
export const SESSION_ID = "own-balance-poller"
/** A codex login is polled only while its access token has at least this long left (no refresh for a poll). */
export const FRESH_MS = 10 * 60_000

export interface Poller {
  /** Polls every due account now (leader only). Resolves when done; never throws. */
  tick(): Promise<void>
}

/** What a poll observed: windows, and a ChatGPT account's reset credit count when the answer had one. */
export type Publish = (windows: ReadonlyArray<Limit.Window>, credits?: Limit.ResetCredits) => void

export function create(deps: Deps, peers: Module.Peers, publish: Publish, fetcher: typeof fetch = fetch): Poller {
  const log = deps.log.child("telemetry.poller")
  const last = new Map<string, number>()

  const balance = async (account: Account.Info, headers: Readonly<Record<string, string>>) => {
    const url = new URL("/user/balance", deps.endpoints.url.deepseek)
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const observation = { observedAt: deps.clock.now(), source: "poll" as const }
    const subject = { accountID: account.id, providerID: account.providerID }
    const previous = deps.runtime.limits.list({ accountID: account.id })
    if (response.status === 402)
      return publish(
        Windows.deepseekBalance(
          { is_available: false, balance_infos: [{ total_balance: 0 }] },
          subject,
          observation,
          previous,
        ),
      )
    if (!response.ok) return log.debug("poll_failed", { accountID: account.id, status: response.status })
    publish(Windows.deepseekBalance(await response.json(), subject, observation, previous))
  }

  const poll = async (account: Account.Info) => {
    const now = deps.clock.now()
    last.set(account.id, now)
    // A codex poll never refreshes a token nor changes an idle account's status: only a login usable as it is goes
    // (a linked one the old app keeps fresh, a vault one not yet due).
    if (account.kind === "codex" && !(await ready(deps, account)))
      return log.debug("poll_skipped", { accountID: account.id, problem: "credential_not_ready" })
    const auth = await peers().logins.headers(account, SESSION_ID)
    if (!auth.ok) return log.debug("poll_skipped", { accountID: account.id, problem: auth.problem })
    if (account.kind !== "codex") return balance(account, auth.headers)
    const read = await readUsage(deps, fetcher, account, auth.headers)
    if (!read.ok) return log.debug("poll_failed", { accountID: account.id, reason: read.reason, status: read.status })
    publish(read.windows, read.credits)
  }

  /** A codex account whose plan windows the requests reported lately needs no poll. */
  const observed = (account: Account.Info, now: number) =>
    deps.runtime.limits
      .list({ accountID: account.id })
      .some((window) => window.id.startsWith("codex.") && now - window.observedAt < INTERVAL_MS)

  const wanted = (account: Account.Info, now: number) => {
    if (account.kind === "ds") return account.pollBalance === true
    return account.kind === "codex" && account.pollBalance !== false && !observed(account, now)
  }

  return {
    tick: async () => {
      if (!deps.runtime.isLeader()) return
      const now = deps.clock.now()
      const due = peers()
        .slots.snapshot()
        .accounts.filter(
          (account) =>
            account.status !== "disabled" &&
            account.status !== "retired" &&
            now - (last.get(account.id) ?? Number.NEGATIVE_INFINITY) >= INTERVAL_MS &&
            wanted(account, now),
        )
      await Promise.all(
        due.map((account) =>
          poll(account).catch((error: unknown) => log.warn("poll_error", { accountID: account.id, error })),
        ),
      )
    },
  }
}

/** The fetch the ChatGPT reads use (`fetch`; a test may give up sooner). */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** Why a ChatGPT read gave nothing: no answer in {@link TIMEOUT_MS}, no connection, an error status, another body. */
export type ReadFailure = {
  readonly ok: false
  readonly reason: "timeout" | "network" | "status" | "invalid"
  readonly status?: number
}

/**
 * Whether a `codex` login is usable as it is: stored and valid for more than {@link FRESH_MS}. ChatGPT's usage and reset
 * credit reads ask nothing of a login that is not (02 §7.1.1): they never refresh a token.
 */
export async function ready(deps: Deps, account: Account.Info) {
  return (await unready(deps, account)) === undefined
}

/** Why a `codex` login is not usable as it is ({@link ready}), as `credential_not_ready` names it; else `undefined`. */
export async function unready(deps: Deps, account: Account.Info) {
  const inspection = await deps.runtime.credentials.inspect(account)
  if (!inspection.ok) return causeOf(inspection.problem)
  return (inspection.expiresAt ?? Number.POSITIVE_INFINITY) > deps.clock.now() + FRESH_MS ? undefined : "expiring"
}

/** A credential problem (`inspect`, `headersFor`) as `credential_not_ready` names it (02 §7.1.1). */
export function causeOf(problem: Credentials.Problem | undefined): OwnError.CredentialCause {
  if (problem === "expired") return "expiring"
  // The status tracker turns these into the account's `needs_reauth` (credentials/status.ts).
  if (problem === "needs_reauth" || problem === "decrypt_failed" || problem === "corrupt") return "needs_reauth"
  if (problem === "not_found") return "missing"
  if (problem === "source_stale") return "source_stale"
  return "unusable"
}

/**
 * `GET <chatgpt>/wham/usage` with `headers` (`TIMEOUT_MS`): the windows {@link Windows.codexUsage} reads and the reset
 * credit count ({@link ResetCredits.fromUsage}), both observed now. Never throws.
 */
export async function readUsage(
  deps: Deps,
  fetcher: Fetcher,
  account: Account.Info,
  headers: Readonly<Record<string, string>>,
): Promise<
  | { readonly ok: true; readonly windows: ReadonlyArray<Limit.Window>; readonly credits?: Limit.ResetCredits }
  | ReadFailure
> {
  const read = await getJson(fetcher, `${chatgptRoot(deps)}/wham/usage`, headers)
  if (!read.ok) return read
  const subject = { accountID: account.id, providerID: account.providerID }
  const observedAt = deps.clock.now()
  const counted = ResetCredits.fromUsage(read.json)
  return {
    ok: true,
    windows: Windows.codexUsage(read.json, subject, { observedAt, source: "poll" }),
    ...(counted ? { credits: ResetCredits.observed(subject, observedAt, counted) } : {}),
  }
}

/** A JSON `GET` of ChatGPT's backend (`accept: application/json`, {@link TIMEOUT_MS}). Never throws. */
export async function getJson(
  fetcher: Fetcher,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly ok: true; readonly json: unknown } | ReadFailure> {
  return send(fetcher, url, { headers: { ...headers, accept: "application/json" } })
}

/** One request to ChatGPT's backend with {@link TIMEOUT_MS}: its JSON body, or why there is none. Never throws. */
export async function send(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
): Promise<{ readonly ok: true; readonly json: unknown } | ReadFailure> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
    (error: unknown) => error,
  )
  if (!(response instanceof Response))
    return { ok: false, reason: response instanceof Error && response.name === "TimeoutError" ? "timeout" : "network" }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: "status", status: response.status }
  }
  const json: unknown = await response.json().catch((error: unknown) => error)
  if (json instanceof Error) return { ok: false, reason: json.name === "TimeoutError" ? "timeout" : "invalid" }
  return { ok: true, json }
}

/** ChatGPT's `backend-api` root (`endpoints.chatgpt`, moved with `endpoints.codex` in tests). */
export function chatgptRoot(deps: Deps) {
  return deps.endpoints.url.chatgpt.replace(/\/+$/, "")
}

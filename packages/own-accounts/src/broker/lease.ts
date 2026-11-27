export * as Lease from "./lease.js"

import { Broker, type Account, type Registry } from "@own/protocol"
import { Credentials, Store } from "@own/runtime"
import type { Contract } from "./contract.js"
import { Mirror } from "./mirror.js"

/**
 * `headers.get` of the local broker (04 §8.5, §8.8, §8.9): turns the local credential path (`logins.headers`, the
 * same vault cache, refresh single-flight and linked reader as a local request) into a short lease for one host.
 *
 * - vault / takeover: a Codex token closer than `5 min + 120 s` to expiry is refreshed first (single-flight), never
 *   leased short. Only a token whose refresh the token endpoint deferred (`earliest_refresh_at`) is leased short:
 *   until the refresh may run, and at most until {@link DEFERRED_MARGIN_MS} before its expiry.
 * - linked: never refreshed (token endpoint calls: 0); the source is only re-read. A token below the minimum
 *   validity, or one this host reported with a 401 that is still the source's, is refused as `source_stale` for this
 *   host only (`account.status{scope:"host"}`), and released (`ready`) when the old app wrote a usable one.
 * - A remote `invalidate` never marks the local reader rejected (04 §8.8, §10.5): remote reports are trusted less.
 */

export interface Backend {
  readonly now: () => number
  readonly registry: () => Promise<Registry.File>
  /** The local header path (`logins.headers`): tracker verdicts and the vault refresher included. */
  readonly headers: (account: Account.Info, sessionID: string) => Promise<Credentials.Auth>
  /**
   * Forced single-flight refresh of a vault OAuth item. `deferred`: the token endpoint asked for no refresh before
   * `until` (`earliest_refresh_at`, Sign in with ChatGPT) and the current token still works.
   */
  readonly refresh: (
    account: Account.Info,
  ) => Promise<{ readonly type: "refreshed" | "failed" } | { readonly type: "deferred"; readonly until: number }>
  /** `credentials.unauthorized` for vault OAuth: the served generation is refreshed on its next use. */
  readonly unauthorized: (account: Account.Info) => void
}

/** A push this lease decision sends to the host (`account.status` host scope, `revoke`). */
export interface PushOut {
  readonly event: "account.status" | "revoke"
  readonly data: Broker.AccountStatus | Broker.Revoke
}

export interface Outcome {
  readonly result: Broker.HeadersResult
  readonly pushes: ReadonlyArray<PushOut>
  /** The account a lease was issued for (audit), if any. */
  readonly issued?: Account.ID
}

/** A token whose refresh the token endpoint deferred is leased up to this long before its expiry (clock skew). */
export const DEFERRED_MARGIN_MS = 60_000

/** Headers that carry a credential or an account identifier (02 §4.1); everything else is added by the remote. */
export const LEASED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "chatgpt-account-id",
  "openai-organization",
  "openai-project",
])

/** Per-host lease state (memory only: stale marks and remote rejections are not persisted, 04 §8.8). */
export class HostState {
  readonly hostId: string
  settings: Contract.HostSettings = { accounts: { mode: "all" }, leaseSeconds: Broker.LEASE_SECONDS_DEFAULT, failClosedGraceSeconds: Broker.GRACE_SECONDS_DEFAULT }
  /** Token bucket of `headers.get` (30/s, burst 60). */
  tokens: number = Broker.RATE_BURST
  refilledAt = 0
  /** Linked accounts refused as `source_stale` on this host, with the hash the host rejected (if a 401 did it). */
  readonly stale = new Map<string, { readonly rejected: string | null }>()
  readonly invalidatedAt = new Map<string, number>()
  /** Leases by provider: `expiresAt` local time, for `leasesActive`. */
  readonly leases = new Map<string, { readonly accountID: string; readonly expiresAt: number }>()
  /** Issued-lease audit of the current window (04 §8.9). */
  readonly audit = new Map<string, { count: number; readonly firstAt: number; lastAt: number }>()

  constructor(hostId: string) {
    this.hostId = hostId
  }

  active(now: number) {
    let count = 0
    for (const lease of this.leases.values()) if (lease.expiresAt > now) count++
    return count
  }
}

/** `generation` per account: grows whenever the leased value (its hash) changes. Process-wide, never reused. */
export class Generations {
  readonly #last = new Map<string, { readonly hash: string; readonly generation: number }>()

  of(accountID: string, hash: string) {
    const last = this.#last.get(accountID)
    if (last?.hash === hash) return last.generation
    const generation = (last?.generation ?? 0) + 1
    this.#last.set(accountID, { hash, generation })
    return generation
  }
}

export class Issuer {
  readonly #backend: Backend
  readonly #generations = new Generations()
  /** Test override of the lease length (plugin option `broker.leaseMs`). */
  readonly #leaseMs: number | undefined

  constructor(backend: Backend, options: { readonly leaseMs?: number } = {}) {
    this.#backend = backend
    this.#leaseMs = options.leaseMs
  }

  /** The broker's own session id for local header calls (keeps `lastResponse` of real sessions untouched). */
  static sessionOf(hostId: string) {
    return `own-broker:${hostId}`
  }

  async issue(host: HostState, params: Broker.HeadersGet): Promise<Outcome> {
    const now = this.#backend.now()
    if (!take(host, now)) return refused("rate_limited")
    const registry = await this.#backend.registry()
    const account = Store.accountFor(registry, params.providerID)
    if (!account) return refused("not_found")
    if (!Mirror.allowed(account, host.settings.accounts) || account.status === "disabled")
      return refused("account_not_remote")
    if (account.status === "needs_reauth") return refused("needs_reauth")
    const linked = Credentials.credentialOf(account).type === "linked-codex-source"
    const pushes: PushOut[] = []
    const session = Issuer.sessionOf(host.hostId)

    if (params.invalidate !== undefined) {
      const early = await this.#invalidate(host, account, params.invalidate, linked, now, pushes)
      if (early) return { ...early, pushes: [...pushes, ...early.pushes] }
    }

    let auth = await this.#backend.headers(account, session)
    // vault / takeover: refresh before leasing rather than hand out a token that expires on the remote (8.5). A token
    // whose refresh the token endpoint deferred (02 §3.2c) is never refreshed early; it is leased until the refresh may
    // run, so the host comes back for the new token then.
    const refreshed =
      !linked && auth.ok && auth.expiresAt !== null && auth.expiresAt - now < Broker.MIN_VALIDITY_MS
        ? await this.#backend.refresh(account)
        : undefined
    const deferred = refreshed?.type === "deferred" ? refreshed.until : undefined
    if (refreshed && refreshed.type !== "deferred") {
      auth = await this.#backend.headers(account, session)
      if (auth.ok && auth.expiresAt !== null && auth.expiresAt - this.#backend.now() < Broker.MIN_VALIDITY_MS)
        return { result: { error: "vault_unavailable" }, pushes }
    }
    if (!auth.ok) {
      if (linked) {
        this.#stale(host, account, null, pushes)
        return { result: { error: "source_stale" }, pushes }
      }
      return { result: { error: problemOf(auth.problem) }, pushes }
    }
    if (linked) {
      const remaining = (auth.expiresAt ?? now) - now
      const mark = host.stale.get(account.id)
      if (remaining < Broker.MIN_VALIDITY_MS || (mark?.rejected !== undefined && mark.rejected === auth.hash)) {
        this.#stale(host, account, mark?.rejected ?? null, pushes)
        return { result: { error: "source_stale", expiresInMs: remaining }, pushes }
      }
      if (mark) {
        host.stale.delete(account.id)
        pushes.push(status(account.id, "ready"))
      }
    }
    const leaseMs = this.#leaseMs ?? host.settings.leaseSeconds * 1000
    // The five-minute margin is time for a refresh; a deferred token cannot be refreshed, and the issuer accepts it
    // until it expires.
    const margin = deferred === undefined ? Broker.EXPIRY_MARGIN_MS : DEFERRED_MARGIN_MS
    const until =
      auth.expiresAt === null
        ? now + leaseMs
        : Math.min(auth.expiresAt - margin, deferred ?? Number.POSITIVE_INFINITY, now + leaseMs)
    const ttlMs = Math.floor(until - now)
    if (ttlMs <= 0) return { result: { error: linked ? "source_stale" : "vault_unavailable" }, pushes }
    const headers = Object.fromEntries(
      Object.entries(auth.headers).filter(([name]) => LEASED_HEADERS.has(name.toLowerCase())),
    )
    host.leases.set(account.providerID, { accountID: account.id, expiresAt: now + ttlMs })
    const audit = host.audit.get(account.id)
    if (audit) {
      audit.count++
      audit.lastAt = now
    } else host.audit.set(account.id, { count: 1, firstAt: now, lastAt: now })
    return {
      result: { headers, authHash8: auth.hash, ttlMs, generation: this.#generations.of(account.id, auth.hash) },
      pushes,
      issued: account.id,
    }
  }

  /**
   * Leader sweep (04 §8.5 "풀림"): a linked account stale on a host is released once the source holds a token with
   * enough validity that the host did not reject. Returns the pushes per host.
   */
  async release(host: HostState): Promise<ReadonlyArray<PushOut>> {
    if (host.stale.size === 0) return []
    const registry = await this.#backend.registry()
    const pushes: PushOut[] = []
    for (const [accountID, mark] of [...host.stale]) {
      const account = registry.accounts.find((item) => item.id === accountID && item.status !== "retired")
      if (!account) {
        host.stale.delete(accountID)
        continue
      }
      const auth = await this.#backend.headers(account, Issuer.sessionOf(host.hostId))
      if (!auth.ok || auth.expiresAt === null) continue
      if (auth.expiresAt - this.#backend.now() < Broker.MIN_VALIDITY_MS) continue
      if (mark.rejected !== null && mark.rejected === auth.hash) continue
      host.stale.delete(accountID)
      pushes.push(status(account.id, "ready"))
    }
    return pushes
  }

  /**
   * 04 §8.8: a lease the provider refused. vault/takeover: refresh when it is still the current value; linked:
   * remember the rejected hash for this host (the local reader is not touched) and refuse while the source keeps it.
   * At most once per host and account every 5 minutes; in between the current value is answered as it is.
   */
  async #invalidate(
    host: HostState,
    account: Account.Info,
    rejected: string,
    linked: boolean,
    now: number,
    pushes: PushOut[],
  ): Promise<Outcome | undefined> {
    const last = host.invalidatedAt.get(account.id)
    if (last !== undefined && now - last < Broker.INVALIDATE_INTERVAL_MS) {
      const mark = host.stale.get(account.id)
      if (linked && mark?.rejected === rejected) return { result: { error: "source_stale" }, pushes: [] }
      return undefined
    }
    host.invalidatedAt.set(account.id, now)
    const current = await this.#backend.headers(account, Issuer.sessionOf(host.hostId))
    if (!current.ok || current.hash !== rejected) return undefined
    if (!linked) {
      this.#backend.unauthorized(account)
      return undefined
    }
    this.#stale(host, account, rejected, pushes)
    pushes.push({ event: "revoke", data: { providerID: account.providerID } })
    host.leases.delete(account.providerID)
    const remaining = current.expiresAt === null ? undefined : current.expiresAt - now
    return { result: { error: "source_stale", ...(remaining === undefined ? {} : { expiresInMs: remaining }) }, pushes: [] }
  }

  #stale(host: HostState, account: Account.Info, rejected: string | null, pushes: PushOut[]) {
    const previous = host.stale.get(account.id)
    host.stale.set(account.id, { rejected: rejected ?? previous?.rejected ?? null })
    if (!previous) pushes.push(status(account.id, "auth_failed", "codex_source_stale"))
  }
}

function status(accountID: string, value: Account.Status, reason?: string): PushOut {
  return {
    event: "account.status",
    // SAFETY: account ids come from the registry, which decoded them as `Account.ID`.
    data: { accountID: accountID as Account.ID, status: value, ...(reason ? { reason } : {}), scope: "host" },
  }
}

function refused(error: Broker.HeadersError): Outcome {
  return { result: { error }, pushes: [] }
}

/** Token bucket: `RATE_PER_SECOND` refill, `RATE_BURST` capacity. */
function take(host: HostState, now: number) {
  const elapsed = Math.max(0, now - host.refilledAt)
  host.tokens = Math.min(Broker.RATE_BURST, host.tokens + (elapsed / 1000) * Broker.RATE_PER_SECOND)
  host.refilledAt = now
  if (host.tokens < 1) return false
  host.tokens -= 1
  return true
}

function problemOf(problem: Credentials.Problem): Broker.HeadersError {
  switch (problem) {
    case "needs_reauth":
    case "not_found":
    case "decrypt_failed":
    case "corrupt":
      return "needs_reauth"
    case "source_stale":
    case "source_invalid":
      return "source_stale"
    default:
      return "vault_unavailable"
  }
}

export * as Refresh from "./refresh.js"

import { Option, Schema } from "effect"
import { Credential } from "@own/protocol"
import { sleep } from "./fsx.js"
import type { Client } from "./vault.js"

/** Refresh when the access token expires within this window (02 §3.5 F1). */
export const DUE_MS = 5 * 60_000

/**
 * Whether a vault OAuth item is due for a refresh: its access token expires within {@link DUE_MS} and no
 * `earliest_refresh_at` holds it back ({@link deferredUntil}). A 401 on the served generation refreshes regardless
 * (02 §3.5 F1).
 */
export function due(item: Pick<Credential.OAuthSecret, "expiresAt" | "earliestRefreshAt">, now: number) {
  return item.expiresAt - now < DUE_MS && deferredUntil(item, now) === undefined
}

/**
 * The token endpoint's `earliest_refresh_at` (Sign in with ChatGPT) while it still holds back a refresh of this item:
 * until then the current, still valid token keeps being used, even by a forced refresh. An expired token is never
 * held back, and a time at or after the token's expiry cannot be a limit for it (a misread value or clock skew), so
 * neither can leave an account without a usable token.
 */
export function deferredUntil(item: Pick<Credential.OAuthSecret, "expiresAt" | "earliestRefreshAt">, now: number) {
  const earliest = item.earliestRefreshAt
  return earliest !== undefined && now < earliest && earliest < item.expiresAt ? earliest : undefined
}

/**
 * A token response's `earliest_refresh_at` in epoch ms: a number is epoch seconds, a string an ISO time. Anything
 * else, or an unparseable value, means no limit.
 */
export function earliestOf(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed
}

/**
 * What the token endpoint call (own-accounts owns the HTTP) reports. `permanent` covers `invalid_grant`,
 * `refresh_token_reused` and "already used": the family is dead and the account needs a new login (02 §3.5 F5).
 * `transient` covers network errors and 5xx.
 */
export type Outcome =
  | {
      readonly type: "tokens"
      readonly access: string
      readonly refresh: string
      /** Absent keeps the stored id token. */
      readonly idToken?: string
      /** Epoch ms (`now + expires_in`). */
      readonly expiresAt: number
      /** Granted scopes of the response; absent keeps the stored ones (a refresh may omit `scope`). */
      readonly scopes?: ReadonlyArray<string>
      /** Absent keeps the stored client id. */
      readonly clientId?: string
      /** Epoch ms ({@link earliestOf}). It belongs to the new tokens: absent means no limit for them. */
      readonly earliestRefreshAt?: number
    }
  | { readonly type: "permanent"; readonly reason: string }
  | { readonly type: "transient"; readonly reason: string }

/** Calls the token endpoint with `current.refresh`. Must not log the values it receives or returns. */
export type Refresher = (current: Credential.OAuthSecret) => Promise<Outcome>

export type Result =
  /** This process refreshed; the new tokens are on disk. */
  | { readonly type: "refreshed"; readonly item: Credential.OAuthSecret }
  /** Another process (or an earlier call) already stored newer tokens, or no refresh was needed. */
  | { readonly type: "current"; readonly item: Credential.OAuthSecret }
  | { readonly type: "needs_reauth"; readonly reason: string }
  /** A transient failure; no new attempt before `until`. The current tokens may still be valid. */
  | { readonly type: "backoff"; readonly until: number; readonly reason: string }
  /** The vault cannot be used or holds no OAuth item. */
  | { readonly type: "unavailable"; readonly reason: string }

export interface Options {
  readonly vault: Client
  /** Owner of the leases: this server process, not the helper (README §5.3 `lease.acquire`). */
  readonly pid?: number
  readonly now?: () => number
  readonly leaseTtlMs?: number
  /** How long to wait for another process's lease before giving up. Default 70 s (README §6.3). */
  readonly waitMs?: number
  /** First and last delay between lease attempts. Default 250 ms → 2 s. */
  readonly pollMs?: readonly [number, number]
  /** Transient-failure backoff, doubling from the first to the last value. Default 30 s → 5 min (02 §3.5 F5). */
  readonly backoffMs?: readonly [number, number]
}

const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(Credential.OAuthSecret))

/**
 * One refresher per token family (02 §3.5 F2–F5, own-vault README §6.3): calls for one account share a single
 * in-flight refresh in this process, and processes serialize on the helper's `vault\<id>.lock` lease. After taking
 * the lease the item is read again; if another process already rotated it, that result is used instead. New tokens
 * are stored with `put{keepPrev, ifGeneration}` before anyone uses them.
 */
export class Coordinator {
  readonly #vault: Client
  readonly #pid: number
  readonly #now: () => number
  readonly #leaseTtlMs: number
  readonly #waitMs: number
  readonly #pollMs: readonly [number, number]
  readonly #backoffMs: readonly [number, number]
  readonly #running = new Map<string, Promise<Result>>()
  readonly #backoff = new Map<string, { readonly until: number; readonly delay: number; readonly reason: string }>()
  // Generations whose refresh token is known dead (permanent failure, or rotated tokens we could not persist). Their
  // refresh is never attempted again (02 §3.5 F5 "재시도 루프를 돌지 않는다"); a newer generation (a new login, or
  // another process's write) is refreshed normally.
  readonly #dead = new Map<string, { readonly generation: number; readonly reason: string }>()

  constructor(options: Options) {
    this.#vault = options.vault
    this.#pid = options.pid ?? process.pid
    this.#now = options.now ?? Date.now
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000
    this.#waitMs = options.waitMs ?? 70_000
    this.#pollMs = options.pollMs ?? [250, 2_000]
    this.#backoffMs = options.backoffMs ?? [30_000, 300_000]
  }

  /**
   * Refreshes the account's OAuth item unless another holder already did. `staleGeneration` is the generation that
   * is due or was rejected with 401: when the vault already holds a newer one, it is returned without a refresh.
   */
  run(accountID: string, refresher: Refresher, staleGeneration: number): Promise<Result> {
    const running = this.#running.get(accountID)
    if (running) return running
    const dead = this.#dead.get(accountID)
    if (dead?.generation === staleGeneration) return Promise.resolve({ type: "needs_reauth", reason: dead.reason })
    const backoff = this.#backoff.get(accountID)
    if (backoff && backoff.until > this.#now())
      return Promise.resolve({ type: "backoff", until: backoff.until, reason: backoff.reason })
    const run = this.#run(accountID, refresher, staleGeneration).finally(() => this.#running.delete(accountID))
    this.#running.set(accountID, run)
    return run
  }

  /** Clears a transient backoff and a dead-family mark, e.g. after a new login. */
  reset(accountID: string) {
    this.#backoff.delete(accountID)
    this.#dead.delete(accountID)
  }

  async #run(accountID: string, refresher: Refresher, staleGeneration: number): Promise<Result> {
    // Waiting is real time even when `now` is a test clock: the loop sleeps on real timers.
    const deadline = performance.now() + this.#waitMs
    const acquire = async (delay: number): Promise<Result | { readonly type: "lease"; readonly startedAt: number }> => {
      const lease = await this.#vault.acquireLease(accountID, { pid: this.#pid, ttlMs: this.#leaseTtlMs })
      if (!lease.ok) return { type: "unavailable", reason: lease.error }
      if (lease.acquired && lease.lease) return { type: "lease", startedAt: lease.lease.startedAt }
      const newer = await this.#read(accountID)
      if (newer.type !== "item") return newer
      if (newer.item.generation !== staleGeneration) return { type: "current", item: newer.item }
      if (performance.now() >= deadline) return { type: "unavailable", reason: "lease_timeout" }
      await sleep(delay)
      return acquire(Math.min(delay * 2, this.#pollMs[1]))
    }
    const lease = await acquire(this.#pollMs[0])
    if (lease.type !== "lease") return lease
    return this.#refreshHeld(accountID, refresher, staleGeneration).finally(() =>
      this.#vault.releaseLease(accountID, { pid: this.#pid, startedAt: lease.startedAt }),
    )
  }

  async #refreshHeld(accountID: string, refresher: Refresher, staleGeneration: number): Promise<Result> {
    const fresh = await this.#read(accountID)
    if (fresh.type !== "item") return fresh
    if (fresh.item.generation !== staleGeneration) return { type: "current", item: fresh.item }
    const outcome = await refresher(fresh.item).catch(
      (): Outcome => ({ type: "transient", reason: "refresher_failed" }),
    )
    if (outcome.type === "permanent") return this.#kill(accountID, fresh.item.generation, outcome.reason)
    if (outcome.type === "transient") return this.#fail(accountID, outcome.reason)
    // The spread keeps the family and any metadata the outcome does not replace.
    const next: Credential.OAuthSecret = {
      ...fresh.item,
      access: outcome.access,
      refresh: outcome.refresh,
      idToken: outcome.idToken ?? fresh.item.idToken,
      clientId: outcome.clientId ?? fresh.item.clientId,
      scopes: outcome.scopes ?? fresh.item.scopes,
      earliestRefreshAt: outcome.earliestRefreshAt,
      expiresAt: outcome.expiresAt,
      obtainedAt: this.#now(),
      generation: fresh.item.generation + 1,
    }
    const stored = await this.#vault.put(accountID, JSON.stringify(next), {
      keepPrev: true,
      ifGeneration: fresh.item.generation,
    })
    if (stored.ok) {
      this.#backoff.delete(accountID)
      return { type: "refreshed", item: next }
    }
    if (stored.error === "conflict") {
      // Someone wrote outside the lease, or the account was deleted: never resurrect it with our tokens.
      const again = await this.#read(accountID)
      return again.type === "item" ? { type: "current", item: again.item } : again
    }
    // The endpoint already rotated the family, so tokens that could not be persisted are lost (02 §3.5 F4).
    return this.#kill(accountID, fresh.item.generation, `persist_failed:${stored.error}`)
  }

  #kill(accountID: string, generation: number, reason: string): Result {
    this.#backoff.delete(accountID)
    this.#dead.set(accountID, { generation, reason })
    return { type: "needs_reauth", reason }
  }

  async #read(accountID: string): Promise<{ readonly type: "item"; readonly item: Credential.OAuthSecret } | Result> {
    const result = await this.#vault.get(accountID)
    if (!result.ok) {
      if (result.error === "not_found" || result.error === "decrypt_failed")
        return { type: "needs_reauth", reason: result.error }
      return { type: "unavailable", reason: result.error }
    }
    const item = Option.getOrUndefined(decodeOAuth(result.value))
    if (!item) return { type: "unavailable", reason: "not_oauth" }
    return { type: "item", item }
  }

  #fail(accountID: string, reason: string): Result {
    const previous = this.#backoff.get(accountID)
    const delay = previous ? Math.min(previous.delay * 2, this.#backoffMs[1]) : this.#backoffMs[0]
    const until = this.#now() + delay
    this.#backoff.set(accountID, { until, delay, reason })
    return { type: "backoff", until, reason }
  }
}

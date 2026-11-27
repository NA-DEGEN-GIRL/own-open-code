export * as SecretCache from "./secret-cache.js"

/** Default TTL of decrypted secrets, `policy.secretCacheSeconds` (02 §2.4.3). */
export const DEFAULT_TTL_SECONDS = 600

interface Entry<T> {
  readonly value: T
  readonly expiresAt: number
}

export type Loaded<T, F> = { readonly ok: true; readonly value: T } | F

/**
 * Process-global cache of decrypted secrets (02 §2.4.5, 01 §8.3): one entry per account, identified as
 * `accountId:generation`. The hot path (`model.request`) reads only the cache; a miss runs one single-flight load per
 * account that every concurrent caller awaits.
 *
 * - A value with a lower `generation` never replaces a newer one, so a slow load cannot undo a refresh.
 * - {@link evict} cancels a load under way: it bumps the entry's epoch, and a load that started in an older epoch
 *   caches nothing (what it read may be the secret just removed) and is no longer joined by later readers.
 * - TTL `0` disables caching; loads stay single-flight.
 * - Values sit in private fields: they are not enumerable and do not show up in `JSON.stringify` or inspection.
 */
export class Cache<T extends { readonly generation: number }, F extends { readonly ok: false }> {
  readonly #entries = new Map<string, Entry<T>>()
  readonly #loads = new Map<string, Promise<Loaded<T, F>>>()
  // Bumped by every evict, never reset: one number per id ever evicted (accounts and feature keys).
  readonly #epochs = new Map<string, number>()
  readonly #now: () => number
  #ttlMs: number

  constructor(options: { readonly ttlSeconds?: number; readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
  }

  /** Changes the TTL (e.g. after `policy.set`). Entries already cached keep their expiry, except with TTL 0. */
  configure(ttlSeconds: number) {
    this.#ttlMs = ttlSeconds * 1000
    if (this.#ttlMs <= 0) this.#entries.clear()
  }

  get(accountID: string): T | undefined {
    const entry = this.#entries.get(accountID)
    if (!entry) return undefined
    if (entry.expiresAt > this.#now()) return entry.value
    this.#entries.delete(accountID)
    return undefined
  }

  /** Caches a value unless a newer generation is already cached. Returns whether it was stored. */
  set(accountID: string, value: T) {
    if (this.#ttlMs <= 0) return false
    const current = this.#entries.get(accountID)
    if (current && current.value.generation > value.generation && current.expiresAt > this.#now()) return false
    this.#entries.set(accountID, { value, expiresAt: this.#now() + this.#ttlMs })
    return true
  }

  /**
   * Drops the account's entry, e.g. after `replaceKey` or removal (02 §2.4.5 "무효화"), and cancels its load under
   * way: that load caches nothing and still answers the callers that asked before (with a newer cached generation
   * when there is one, as after `replaceKey`), and the next read starts a new one.
   */
  evict(accountID: string) {
    this.#epochs.set(accountID, this.#epoch(accountID) + 1)
    this.#entries.delete(accountID)
    this.#loads.delete(accountID)
  }

  clear() {
    this.#entries.clear()
  }

  /** `accountId:generation` of every live entry, for diagnostics. Never the values. */
  keys() {
    const now = this.#now()
    return [...this.#entries].flatMap((entry) =>
      entry[1].expiresAt > now ? [`${entry[0]}:${entry[1].value.generation}`] : [],
    )
  }

  /**
   * The cached value, or the result of one shared `loader` call. A successful load is cached; when a newer
   * generation was cached while it ran, the newer value is returned instead.
   */
  read(accountID: string, loader: () => Promise<Loaded<T, F>>): Promise<Loaded<T, F>> {
    const cached = this.get(accountID)
    if (cached) return Promise.resolve({ ok: true, value: cached })
    const running = this.#loads.get(accountID)
    if (running) return running
    const epoch = this.#epoch(accountID)
    const load = loader()
      .then((result): Loaded<T, F> => {
        if (!result.ok) return result
        if (this.#epoch(accountID) === epoch) this.set(accountID, result.value)
        const newer = this.get(accountID)
        return newer && newer.generation > result.value.generation ? { ok: true, value: newer } : result
      })
      .finally(() => {
        if (this.#loads.get(accountID) === load) this.#loads.delete(accountID)
      })
    this.#loads.set(accountID, load)
    return load
  }

  #epoch(accountID: string) {
    return this.#epochs.get(accountID) ?? 0
  }
}

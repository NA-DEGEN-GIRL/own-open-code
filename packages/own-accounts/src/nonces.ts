export * as Nonces from "./nonces.js"

import { OwnID } from "@own/protocol"
import type { Clock } from "./clock.js"

/** Validity of a destructive `*.plan` nonce (02 §9.2). */
export const TTL_MS = 5 * 60_000

/**
 * One-time tokens of one plan/execute pair (02 §9.2, 01 §13 destructive-action rule). Each module keeps its own
 * typed scope, so `execute` gets back exactly what `plan` computed. Plans live in the instance that answered
 * `plan`; global methods always go to the control location, so `execute` reaches the same instance.
 */
export class Scope<T> {
  readonly #clock: Clock
  readonly #ttlMs: number
  readonly #entries = new Map<string, { readonly payload: T; readonly expiresAt: number }>()

  constructor(clock: Clock, options: { readonly ttlMs?: number } = {}) {
    this.#clock = clock
    this.#ttlMs = options.ttlMs ?? TTL_MS
  }

  /** Stores `payload` and returns the fields every plan result carries (`nonce`, `expiresAt`). */
  issue(payload: T) {
    this.#sweep()
    const nonce = OwnID.Nonce.create()
    const expiresAt = this.#clock.now() + this.#ttlMs
    this.#entries.set(nonce, { payload, expiresAt })
    return { nonce, expiresAt }
  }

  /** Returns the payload once; an unknown, used or expired nonce gives `undefined` (answer `nonce_invalid`). */
  consume(nonce: string): T | undefined {
    const entry = this.#entries.get(nonce)
    this.#entries.delete(nonce)
    if (!entry || entry.expiresAt <= this.#clock.now()) return undefined
    return entry.payload
  }

  /** The payload without using the nonce up (a `dryRun` execute); `undefined` like {@link consume}. */
  peek(nonce: string): T | undefined {
    const entry = this.#entries.get(nonce)
    if (!entry || entry.expiresAt <= this.#clock.now()) return undefined
    return entry.payload
  }

  #sweep() {
    const now = this.#clock.now()
    for (const [nonce, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(nonce)
  }
}

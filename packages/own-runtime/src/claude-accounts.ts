export * as ClaudeAccounts from "./claude-accounts.js"

/**
 * Which Claude subscription account signed a request (02 §8.5, G4 2026-10-10), shared by every plugin of one build:
 * own-accounts installs the resolver (the patched claude-auth's `accountOf(request)`, keyed by the very request object
 * the plugin returned, then mapped to the own account id), and own-telemetry and own-accounts' observers ask it about
 * `event.request` of an `anthropic` response. The current binding of the session is never used for this: a request
 * signed before a switch still counts for the account that signed it. In memory only.
 */
export type Resolver = (request: Request) => string | undefined

/** Sessions whose last signing account is kept (most recent first out when full). */
export const MAX_SESSIONS = 10_000

export class Attribution {
  readonly #resolvers: Resolver[] = []
  readonly #last = new Map<string, string>()

  /**
   * Records the account that signed a session's latest `anthropic` response (own-telemetry, on the response), so a
   * ledger line written when the step ends names the account of its request, not the binding at that moment.
   */
  remember(sessionID: string, accountID: string) {
    this.#last.delete(sessionID)
    this.#last.set(sessionID, accountID)
    if (this.#last.size > MAX_SESSIONS) this.#last.delete(this.#last.keys().next().value!)
  }

  /** The account of {@link remember} for a session, if any. */
  lastOf(sessionID: string) {
    return this.#last.get(sessionID)
  }

  readonly #switched = new Set<string>()

  /**
   * own-accounts moved the session to another Claude account in this retry (02 §8.8, C-D3) and asked for an immediate
   * retry: own-telemetry, whose `retry` hook runs later, still records the old account's exhaustion but leaves the
   * retry decision alone ({@link takeSwitched}).
   */
  markSwitched(sessionID: string) {
    this.#switched.add(sessionID)
  }

  /** Whether {@link markSwitched} marked the session's current retry; the mark is used up. */
  takeSwitched(sessionID: string) {
    return this.#switched.delete(sessionID)
  }

  /** Adds a resolver (one per own-accounts instance); the returned function removes it. */
  install(resolver: Resolver) {
    this.#resolvers.push(resolver)
    return () => {
      const index = this.#resolvers.indexOf(resolver)
      if (index >= 0) this.#resolvers.splice(index, 1)
    }
  }

  /** The own account id that signed `request`, or `undefined` (single-account plugin, not an `anthropic` request). */
  accountOf(request: Request) {
    for (const resolver of this.#resolvers) {
      const accountID = resolver(request)
      if (accountID !== undefined) return accountID
    }
    return undefined
  }
}

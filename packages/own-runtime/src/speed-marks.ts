export * as SpeedMarks from "./speed-marks.js"

import type { CodexModels, Speed } from "@own/protocol"

/**
 * Process-wide speed facts (02 §4.8) that every plugin instance of one build shares: requests run in the session's
 * Location while the lists are read in the control Location, so a refusal one instance saw must hold in all of them.
 * - Marks: what a provider said about a tier for one account and model. `unavailable` holds until that account's model
 *   list is read again ({@link Store.clear}); `cooldown` until its `until`, with the consecutive cooldowns counted so
 *   the next one can wait longer (`strikes`, reset by a success).
 * - Lists: the speed tiers a Sign in with ChatGPT account's own model list named, per model (`undefined` = the list
 *   said nothing about tiers). Codex accounts keep theirs in `codex-meta.json`.
 * - Served: what the responses to a tier answered per account and model, so a tier the provider keeps serving slower
 *   (never honored) can be told from a passing downgrade (02 §4.8). A list read again forgets it.
 * - Retention: how often a tier change of a kind kept the cache, measured from the first request after it.
 * Memory only: a restart reads the lists again and tries a refused tier once more.
 */
export class Store {
  readonly #marks = new Map<string, Entry>()
  readonly #lists = new Map<string, List>()
  readonly #served = new Map<string, Served & { readonly accountID: string }>()
  readonly #retention = new Map<string, Retention>()

  /** Records what the provider said about `mark.tier` for the account and model; replaces an earlier mark. */
  mark(accountID: string, modelID: string, mark: Speed.Mark) {
    const key = keyOf(accountID, modelID, mark.tier)
    const previous = this.#marks.get(key)
    const strikes = mark.status === "cooldown" && previous?.mark.status === "cooldown" ? previous.strikes + 1 : 0
    this.#marks.set(key, { accountID, modelID, mark, strikes })
  }

  /** The account's marks for a model, expired cooldowns included (`Speed.offers` reads `until`). */
  marks(accountID: string, modelID: string): Speed.Mark[] {
    return [...this.#marks.values()]
      .filter((entry) => entry.accountID === accountID && entry.modelID === modelID)
      .map((entry) => entry.mark)
  }

  /** Cooldowns in a row for the tier without a success in between (0 for the first). */
  strikes(accountID: string, modelID: string, tier: string) {
    return this.#marks.get(keyOf(accountID, modelID, tier))?.strikes ?? 0
  }

  /** A request at the tier succeeded: its mark (and the cooldown count) goes. Answers whether there was one. */
  unmark(accountID: string, modelID: string, tier: string) {
    return this.#marks.delete(keyOf(accountID, modelID, tier))
  }

  /** The account's model list was read again: every `unavailable` mark of it goes, cooldowns run on. */
  clear(accountID: string) {
    for (const [key, entry] of this.#marks)
      if (entry.accountID === accountID && entry.mark.status === "unavailable") this.#marks.delete(key)
    for (const [key, entry] of this.#served) if (entry.accountID === accountID) this.#served.delete(key)
  }

  /**
   * The final answer to one request sent at `tier`: served at that speed (`honored`) or slower. Answers the slower
   * answers in a row since the last honored one, and whether the tier was honored for the account and model since its
   * list was last read.
   */
  served(accountID: string, modelID: string, tier: string, honored: boolean): Served {
    const key = keyOf(accountID, modelID, tier)
    const known = this.#served.get(key)
    const next = honored
      ? { slower: 0, honored: true }
      : { slower: (known?.slower ?? 0) + 1, honored: known?.honored ?? false }
    this.#served.set(key, { ...next, accountID })
    return next
  }

  /** A Sign in with ChatGPT account's list: model slug → the tiers it named (`undefined` = none reported). */
  list(accountID: string): List | undefined {
    return this.#lists.get(accountID)
  }

  setList(accountID: string, list: List) {
    this.#lists.set(accountID, list)
    this.clear(accountID)
  }

  /** One observation of a kind's tier change: the first request after it read the cache (`kept`) or not. */
  observe(kind: string, kept: boolean) {
    const known = this.#retention.get(kind) ?? { kept: 0, lost: 0 }
    this.#retention.set(kind, kept ? { ...known, kept: known.kept + 1 } : { ...known, lost: known.lost + 1 })
  }

  retention(kind: string): Retention | undefined {
    return this.#retention.get(kind)
  }
}

export interface List {
  readonly fetchedAt: number
  readonly models: ReadonlyMap<string, ReadonlyArray<CodexModels.Tier> | undefined>
}

export interface Served {
  /** Answers in a row served slower than sent. */
  readonly slower: number
  /** The tier was served as sent at least once. */
  readonly honored: boolean
}

export interface Retention {
  readonly kept: number
  readonly lost: number
}

interface Entry {
  readonly accountID: string
  readonly modelID: string
  readonly mark: Speed.Mark
  readonly strikes: number
}

function keyOf(accountID: string, modelID: string, tier: string) {
  return `${accountID}\u0000${modelID}\u0000${tier}`
}

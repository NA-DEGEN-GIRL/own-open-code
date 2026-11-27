export * as StripRules from "./strip.js"

import { Option, Schema } from "effect"
import { Kv, Switch } from "@own/protocol"
import type { Deps } from "../deps.js"

/** Sessions whose rules stay in memory; the oldest are forgotten first (they are re-read from KV on use). */
export const MEMORY_SESSIONS = 2_000

const decodeRules = Schema.decodeUnknownOption(Schema.Array(Switch.StripRule))

/**
 * Strip rules of 02 §4.4, KV `sess:<sid>:strip` (owner: auth, ARCHITECTURE.md §8). The `context`/`compaction`/
 * `generate` hooks read them on every request of the session's slot, so they are kept in memory after the first read.
 * A rule lasts until the session's next `compaction.ended` (`until: "next-compaction"`), so the prefix changes once.
 * KV failures degrade to "no rule" (a missing safety net), never to a thrown hook.
 */
export class Store {
  readonly #deps: Deps
  readonly #memory = new Map<string, ReadonlyArray<Switch.StripRule>>()

  constructor(deps: Deps) {
    this.#deps = deps
  }

  async get(sessionID: string): Promise<ReadonlyArray<Switch.StripRule>> {
    const cached = this.#memory.get(sessionID)
    if (cached) return cached
    const stored: unknown = await this.#deps.ctx.storage.get(Kv.strip(sessionID)).catch(() => undefined)
    const rules = Option.getOrElse(decodeRules(stored ?? []), () => [])
    this.#remember(sessionID, rules)
    return rules
  }

  /** Adds or replaces the rule of `rule.providerID`. Returns `false` when the same rule already exists. */
  async add(sessionID: string, rule: Switch.StripRule) {
    const current = await this.get(sessionID)
    const same = current.find((item) => item.providerID === rule.providerID)
    if (same && same.dropBefore === rule.dropBefore) return false
    const next = [...current.filter((item) => item.providerID !== rule.providerID), rule]
    this.#remember(sessionID, next)
    await this.#deps.ctx.storage.set(
      Kv.strip(sessionID),
      next.map((item) => ({
        providerID: item.providerID,
        dropBefore: item.dropBefore,
        kinds: [...item.kinds],
        until: item.until,
      })),
    )
    return true
  }

  /** `compaction.ended` of the session: every rule expires. */
  async clear(sessionID: string) {
    const current = this.#memory.get(sessionID)
    this.#remember(sessionID, [])
    if (current?.length === 0) return
    await this.#deps.ctx.storage.remove(Kv.strip(sessionID))
  }

  #remember(sessionID: string, rules: ReadonlyArray<Switch.StripRule>) {
    this.#memory.delete(sessionID)
    this.#memory.set(sessionID, rules)
    if (this.#memory.size <= MEMORY_SESSIONS) return
    const oldest = this.#memory.keys().next().value
    if (oldest !== undefined) this.#memory.delete(oldest)
  }
}

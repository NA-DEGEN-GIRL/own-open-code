export * as PresetLighter from "./lighter.js"

import { Preset } from "@own/protocol"
import type { PresetStore } from "./store.js"

/**
 * Owner: PRESETS (07 §4.2). A group's lighter pairs (`메인 계정의 더 가벼운 모델`): the row of the main model in the
 * group's table (`presets.json` `groups[g].lighter`), else decided once by `Preset.lighterPick` over the main account's
 * models priced like 07 §3.4 (the newest model of the cheapest cheaper family; a main already in the cheapest family
 * pairs with itself as `none`) and stored `source:"auto"`. A stored row is never decided again: a newer or cheaper
 * model, or a new Codex priority 1 (07 §4.5), leaves it as it is (U3), and only the user changes it
 * (`presets.defaults.set{lighter}`, `source:"user"`). Codex priorities rank "strongest" only (07 §3.4,
 * `presets.suggest`); a lighter pair is decided by price alone, since a priority says nothing about how light a model is.
 * Local groups have no prices, so their pairs are never decided here.
 */
export interface Api {
  /**
   * The pair of a main model; `undefined` while it cannot be decided (a local group, a main without a price). A missing
   * pair is decided: `write` stores it (the first need: applying a preset, the gate; two concurrent writes keep the
   * first stored value), `read` keeps it in memory as the value a later write stores, and `preview` (saving a preset,
   * which is not a need, 07 §4.2) only answers it.
   */
  pair(group: Preset.Group, main: Preset.Main, mode: Mode): Promise<Preset.Lighter | undefined>
}

export type Mode = "write" | "read" | "preview"

/** `candidates`: the main account's models priced like 07 §3.4 (`Preset.candidates`). */
export function create(
  store: PresetStore.Api,
  candidates: (account: string) => Promise<ReadonlyArray<Preset.Candidate>>,
): Api {
  /** Pairs decided by a read path and not stored yet, by group and main model. */
  const decided = new Map<string, Preset.Lighter>()

  return {
    pair: async (group, main, mode) => {
      const stored = store.lighter(group)[main.ref.id]
      if (stored) return stored
      if (Preset.isLocal(group)) return undefined
      const key = `${group}\n${main.ref.id}`
      const value = decided.get(key) ?? Preset.lighterPick(group, main.ref.id, await candidates(main.account))
      if (!value || mode === "preview") return value
      // A concurrent call may have decided meanwhile; the first decision stands.
      const first = decided.get(key) ?? value
      if (mode === "read") {
        decided.set(key, first)
        return first
      }
      const written = await store.recordLighter(group, main.ref.id, first)
      // Kept in memory only while presets.json could not be written; the stored pair wins from then on.
      if (!written) {
        decided.set(key, first)
        return first
      }
      decided.delete(key)
      return written
    },
  }
}

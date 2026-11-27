export * as CreatorState from "./state.js"

import { Creator } from "@own/protocol/creator"
import { Hash } from "@own/runtime"
import { Match } from "./match.js"
import type { CreatorStore } from "./store.js"

/** Sessions whose fragments one instance keeps current when an extension changes (the newest first out). */
const KNOWN = 500

/** One Location's view of the store: the snapshot read last and the extensions in force in this Location. */
export class State {
  snapshot: CreatorStore.Snapshot = {
    file: { version: Creator.STORE_VERSION, extensions: [] },
    loaded: [],
    broken: false,
  }
  list: ReadonlyArray<Match.Applicable> = []
  /** Sessions of this Location whose instruction entries this instance wrote or checked. */
  readonly known = new Set<string>()

  constructor(
    readonly store: CreatorStore.Store,
    readonly directory: string,
  ) {}

  set(snapshot: CreatorStore.Snapshot) {
    this.snapshot = snapshot
    this.list = Match.applicable(snapshot, this.directory)
  }

  remember(sessionID: string) {
    this.known.delete(sessionID)
    this.known.add(sessionID)
    if (this.known.size > KNOWN) this.known.delete(this.known.values().next().value!)
  }

  /** A hash of the items of `types` in force, to reload a domain only when what it registers changed. */
  fingerprint(types: ReadonlyArray<Creator.ItemType>) {
    return Hash.stable(
      this.list.map((item) => [
        item.loaded.entry.id,
        item.extension.items.filter((entry) => types.includes(entry.type)),
      ]),
    )
  }
}

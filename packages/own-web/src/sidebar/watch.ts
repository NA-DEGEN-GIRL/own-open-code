// Batched `watchVisible` (OwnStore): rows appear and disappear one by one while scrolling, but bindings should load
// in one `session.binding` call per change set, not one RPC per row (02 §9.1, 03 §8 "보이는 세션의 session.binding").
// `sync(ids)` diffs against the current set; added ids are watched together, and a batch is released once all of
// its ids left.

interface Batch {
  readonly release: () => void
  readonly left: Set<string>
}

export function createWatchSet(watch: (ids: readonly string[]) => () => void) {
  const live = new Map<string, Batch>()

  function drop(id: string) {
    const batch = live.get(id)
    if (!batch) return
    live.delete(id)
    batch.left.delete(id)
    if (!batch.left.size) batch.release()
  }

  return {
    sync(ids: Iterable<string>) {
      const next = new Set(ids)
      for (const id of [...live.keys()]) if (!next.has(id)) drop(id)
      const added = [...next].filter((id) => !live.has(id))
      if (!added.length) return
      const batch: Batch = { release: watch(added), left: new Set(added) }
      for (const id of added) live.set(id, batch)
    },
    size: () => live.size,
    dispose() {
      for (const id of [...live.keys()]) drop(id)
    },
  }
}

export type WatchSet = ReturnType<typeof createWatchSet>

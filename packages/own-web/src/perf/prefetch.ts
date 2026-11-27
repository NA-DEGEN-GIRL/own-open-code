// PF1 (01 §6.6, 05 §9.1, T0-2): the saved session list is asked for as the entry module runs, before the host
// exists, so opening IndexedDB overlaps the host setup and the first render instead of following them.
import type { SessionListCache } from "@/data/session-cache"

/** `cache` whose first read of `key` is already running; later reads (and other keys) go to the store. */
export function prefetched(cache: SessionListCache, key: string): SessionListCache {
  let early: ReturnType<SessionListCache["read"]> | undefined = cache.read(key)
  return {
    read(serverKey) {
      if (serverKey !== key || !early) return cache.read(serverKey)
      const value = early
      early = undefined
      return value
    },
    write: (list) => cache.write(list),
  }
}

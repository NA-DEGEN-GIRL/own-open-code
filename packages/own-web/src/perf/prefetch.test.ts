// PF1 (05 T0-2): the entry's early read of the saved session list is the data layer's first read of that server.
import { describe, expect, test } from "bun:test"
import type { CachedSessionList, SessionListCache } from "@/data/session-cache"
import { prefetched } from "./prefetch"

function counting(): SessionListCache & { reads: string[]; writes: number } {
  const reads: string[] = []
  const list = (serverKey: string): CachedSessionList => ({
    serverKey,
    savedAt: reads.length,
    sessions: [],
    projects: [],
  })
  const cache = {
    reads,
    writes: 0,
    read: async (serverKey: string) => {
      reads.push(serverKey)
      return list(serverKey)
    },
    write: async () => {
      cache.writes++
    },
  }
  return cache
}

describe("prefetched session list (PF1)", () => {
  test("reads the key at once; the first read of it is that same read", async () => {
    const store = counting()
    const cache = prefetched(store, "local")
    expect(store.reads).toEqual(["local"])
    const first = await cache.read("local")
    expect(first?.savedAt).toBe(1)
    expect(store.reads).toEqual(["local"])
  })

  test("later reads and other servers go to the store; writes pass through", async () => {
    const store = counting()
    const cache = prefetched(store, "local")
    await cache.read("local")
    await cache.read("local")
    await cache.read("ssh:box")
    await cache.write({ serverKey: "local", savedAt: 1, sessions: [], projects: [] })
    expect(store.reads).toEqual(["local", "local", "ssh:box"])
    expect(store.writes).toBe(1)
  })
})

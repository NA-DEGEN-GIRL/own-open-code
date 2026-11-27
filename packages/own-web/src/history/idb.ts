// A small key-value store over IndexedDB for the composer's own data (prompt history, draft chips and attachment
// bytes, 03 §19.9 "IndexedDB에 이미지 blob"). Its own database, so the data layer's `own-web` database (session list
// cache) keeps its version. A missing or blocked IndexedDB (private windows, tests) is not an error: every call
// resolves, reads come back empty and writes are dropped.

export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

const DB = "own-web-composer"
const VERSION = 1
export const STORES = ["history", "drafts"] as const
export type StoreName = (typeof STORES)[number]

const databases = new Map<string, Promise<IDBDatabase | undefined>>()

function open(name: string) {
  return new Promise<IDBDatabase | undefined>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined)
    try {
      const request = indexedDB.open(name, VERSION)
      request.onupgradeneeded = () => {
        for (const store of STORES)
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
      request.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

/** One IndexedDB object store of the composer database. */
export function idbStore(store: StoreName, name = DB): KeyValueStore {
  const database = () => {
    const known = databases.get(name)
    if (known) return known
    const created = open(name)
    databases.set(name, created)
    return created
  }
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await database()
    if (!db) return undefined
    return new Promise<T | undefined>((resolve) => {
      try {
        const transaction = db.transaction(store, mode)
        const request = fn(transaction.objectStore(store))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onerror = () => resolve(undefined)
        transaction.onabort = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }
  return {
    get: (key) => run("readonly", (objects) => objects.get(key)),
    set: async (key, value) => void (await run("readwrite", (objects) => objects.put(value, key))),
    delete: async (key) => void (await run("readwrite", (objects) => objects.delete(key))),
  }
}

/** Tests and fallbacks: same contract, kept in memory. */
export function memoryStore(): KeyValueStore & { readonly entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>()
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
  }
}

/** Runs `fn` when the page is idle (at most `timeout` ms later); a plain timer where requestIdleCallback is missing. */
export function whenIdle(fn: () => void, timeout = 2_000) {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(fn, { timeout })
    return () => cancelIdleCallback(handle)
  }
  const timer = setTimeout(fn, 0)
  return () => clearTimeout(timer)
}

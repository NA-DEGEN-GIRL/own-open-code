// Session list snapshot per server (01 §6.3, 03 §4.3, 05 T0-2): drawn before the service answers so the list is
// visible within PF1's 1 s. Only list fields go in: title, times, model (for the chip), status, project, directory.
// Never message bodies, tokens or remote-server credentials (04 §12.1). A missing or broken store is not an error.

export interface SessionRow {
  readonly id: string
  readonly title?: string
  readonly created: number
  readonly updated: number
  readonly projectID: string
  readonly directory: string
  readonly parentID?: string
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly status?: "idle" | "busy" | "retry"
  /** Archived sessions stay out of `order` (sidebar list); kept so a cached row never resurrects one. */
  readonly archived?: number
  /**
   * The own flags of the session metadata (19.11 `own.pinned`, `own.archived`, `own.archivedWithProject`; `{}` without
   * them). Only these keys: the rest of the metadata stays with the session, not the list.
   */
  readonly metadata?: { readonly [key: string]: number | boolean }
  /** Last turn result (sidebar `!` mark before the session is opened). */
  readonly outcome?: "succeeded" | "failed" | "interrupted"
}

export interface ProjectRow {
  readonly id: string
  readonly name?: string
  readonly directory: string
}

export interface CachedSessionList {
  readonly serverKey: string
  readonly savedAt: number
  readonly sessions: readonly SessionRow[]
  readonly projects: readonly ProjectRow[]
}

export interface SessionListCache {
  read(serverKey: string): Promise<CachedSessionList | undefined>
  write(list: CachedSessionList): Promise<void>
}

/** 03 §4.3: at most 100 rows per server. */
export const CACHE_ROWS = 100

const DB = "own-web"
const STORE = "session-list"
const VERSION = 1

export function createIndexedDbCache(name = DB): SessionListCache {
  let db: Promise<IDBDatabase | undefined> | undefined
  const open = () =>
    (db ??= new Promise<IDBDatabase | undefined>((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(undefined)
      const request = indexedDB.open(name, VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: "serverKey" })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
      request.onblocked = () => resolve(undefined)
    }))
  return {
    async read(serverKey) {
      const database = await open()
      if (!database) return undefined
      return new Promise((resolve) => {
        try {
          const request = database.transaction(STORE, "readonly").objectStore(STORE).get(serverKey)
          request.onsuccess = () => resolve(valid(request.result))
          request.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      })
    },
    async write(list) {
      const database = await open()
      if (!database) return
      await new Promise<void>((resolve) => {
        try {
          const transaction = database.transaction(STORE, "readwrite")
          transaction.objectStore(STORE).put(trim(list))
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => resolve()
          transaction.onabort = () => resolve()
        } catch {
          resolve()
        }
      })
    },
  }
}

export function createMemoryCache(): SessionListCache & { readonly entries: Map<string, CachedSessionList> } {
  const entries = new Map<string, CachedSessionList>()
  return {
    entries,
    read: async (serverKey) => entries.get(serverKey),
    write: async (list) => void entries.set(list.serverKey, trim(list)),
  }
}

function trim(list: CachedSessionList): CachedSessionList {
  const sessions = list.sessions.slice(0, CACHE_ROWS)
  const used = new Set(sessions.map((session) => session.projectID))
  return { ...list, sessions, projects: list.projects.filter((project) => used.has(project.id)) }
}

/** Shape check at the storage boundary: an old or foreign record reads as "no cache". */
function valid(value: unknown): CachedSessionList | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("serverKey" in value) || typeof value.serverKey !== "string") return undefined
  if (!("savedAt" in value) || typeof value.savedAt !== "number") return undefined
  if (!("sessions" in value) || !Array.isArray(value.sessions)) return undefined
  if (!("projects" in value) || !Array.isArray(value.projects)) return undefined
  // SAFETY: written only by `write` above with this shape; the checks reject other versions.
  return value as CachedSessionList
}

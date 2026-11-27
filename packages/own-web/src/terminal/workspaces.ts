// One terminal store per (server, location), shared by the work panel tab and the bottom dock so both show the same
// tabs, and kept for the page's lifetime (a store is a small keyed object; the heavy part is the view, which the
// panel keeps only for recent locations).
import type { ServerRuntime } from "@/data"
import { createPtyApi } from "./api"
import { createTerminalStore, type TerminalStore } from "./store"

const stores = new Map<string, TerminalStore>()

export function terminalStore(runtime: ServerRuntime, directory: string) {
  const key = `${runtime.key}\0${directory}`
  const existing = stores.get(key)
  if (existing) return existing
  const created = createTerminalStore({
    api: createPtyApi({
      client: runtime.client,
      // The runtime is attached before a location is known (a session or project route), so the entry exists.
      baseUrl: () => runtime.entry()?.baseUrl ?? location.origin,
      directory,
    }),
    events: runtime.bus,
    storage: storage(),
    storageKey: `own.web.terminal.${runtime.key}.${directory}`,
  })
  stores.set(key, created)
  return created
}

function storage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

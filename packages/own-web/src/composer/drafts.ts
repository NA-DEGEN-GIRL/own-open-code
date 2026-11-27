// Per-session drafts (03 §19.9): the composer element is shared by every session (it is never re-created, IME rule 5),
// so its text is swapped per `(serverKey, sessionID)`. Kept in memory; saved to localStorage 500 ms after the last
// change and only when the page is idle, never inside an input handler (03 §20.2 R6). A missing or blocked storage
// only loses persistence.

const KEY = "own.web.composer.drafts"
const DEBOUNCE_MS = 500
const MAX_DRAFTS = 50
const MAX_LENGTH = 20_000

export interface Drafts {
  get(key: string): string
  set(key: string, text: string): void
  delete(key: string): void
  /** Writes pending changes now (page hidden). */
  flush(): void
}

export function draftKey(serverKey: string, sessionID: string | undefined) {
  return `${serverKey}/${sessionID ?? "home"}`
}

export function createDrafts(storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage()): Drafts {
  let memory: Map<string, string> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false

  const load = () => {
    if (memory) return memory
    memory = new Map()
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}")
      if (parsed && typeof parsed === "object")
        for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") memory.set(key, value)
    } catch {}
    return memory
  }

  const write = () => {
    timer = undefined
    if (!dirty || !memory) return
    dirty = false
    const entries = [...memory].filter(([, text]) => text.trim()).slice(-MAX_DRAFTS)
    try {
      storage?.setItem(KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch {}
  }

  const schedule = () => {
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(write, { timeout: 2_000 })
      else write()
    }, DEBOUNCE_MS)
  }

  return {
    get: (key) => load().get(key) ?? "",
    set(key, text) {
      const map = load()
      const value = text.slice(0, MAX_LENGTH)
      if ((map.get(key) ?? "") === value) return
      // Most recent last, so the cap drops the oldest drafts.
      map.delete(key)
      if (value) map.set(key, value)
      schedule()
    },
    delete(key) {
      if (load().delete(key)) schedule()
    },
    flush() {
      clearTimeout(timer)
      write()
    },
  }
}

function safeStorage() {
  try {
    return typeof localStorage === "object" ? localStorage : undefined
  } catch {
    return undefined
  }
}

// Open file tabs per session (03 §19.4 "열린 파일 탭"; 4.7 "세션을 바꾸면 … 파일 … 탭 내용은 그 세션의 것으로 바뀐다").
// A tab is a path in the paths.ts form; `line` is a one-shot jump (a `:12` link) and is not stored. The list, the
// active tab and the recently opened files (quick open's pinned rows) are kept in localStorage per session as a
// per-window convenience: everything works when storage fails.
import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"

export interface FileTab {
  readonly path: string
  /** Jump target of the last open (1-based); consumed by the viewer. */
  readonly line?: number
  /** Increments on every open of the same path, so a second click on the same `:12` link jumps again. */
  readonly jump?: number
}

interface SessionTabs {
  readonly tabs: readonly FileTab[]
  readonly active?: string
  readonly recent: readonly string[]
}

const STORAGE_KEY = "own.web.files.tabs"
const MAX_TABS = 12
const MAX_RECENT = 20
const MAX_SESSIONS = 30
const EMPTY: SessionTabs = { tabs: [], recent: [] }

const store = createRoot(() => {
  const [state, setState] = createStore<{ bySession: Record<string, SessionTabs | undefined> }>({
    bySession: read(),
  })
  return { state, setState }
})

const persist = (() => {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  return () => {
    if (timer.id !== undefined) return
    timer.id = setTimeout(() => {
      timer.id = undefined
      write(store.state.bySession)
    }, 500)
  }
})()

export const fileTabs = {
  get(key: string): SessionTabs {
    return store.state.bySession[key] ?? EMPTY
  },
  /** Opens (or re-activates) a tab; past MAX_TABS the oldest inactive tab closes. */
  open(key: string, path: string, line?: number) {
    const current = fileTabs.get(key)
    const existing = current.tabs.find((tab) => tab.path === path)
    const tab: FileTab = { path, line, jump: (existing?.jump ?? 0) + 1 }
    const tabs = existing ? current.tabs.map((item) => (item.path === path ? tab : item)) : [...current.tabs, tab]
    const trimmed =
      tabs.length > MAX_TABS
        ? tabs.filter((item, index) => index >= tabs.length - MAX_TABS || item.path === path)
        : tabs
    update(key, {
      tabs: trimmed,
      active: path,
      recent: [path, ...current.recent.filter((item) => item !== path)].slice(0, MAX_RECENT),
    })
  },
  activate(key: string, path: string) {
    const current = fileTabs.get(key)
    if (current.active === path || !current.tabs.some((tab) => tab.path === path)) return
    update(key, { ...current, active: path })
  },
  /** Closes a tab; the neighbour to the right (else left) becomes active when it was the active one. */
  close(key: string, path: string) {
    const current = fileTabs.get(key)
    const index = current.tabs.findIndex((tab) => tab.path === path)
    if (index < 0) return
    const tabs = current.tabs.filter((tab) => tab.path !== path)
    const active = current.active === path ? (tabs[index] ?? tabs[index - 1])?.path : current.active
    update(key, { ...current, tabs, active })
  },
  /** Moves a tab to a new index (drag or Ctrl+Shift+PageUp/PageDown). */
  move(key: string, path: string, to: number) {
    const current = fileTabs.get(key)
    const tab = current.tabs.find((item) => item.path === path)
    if (!tab) return
    const rest = current.tabs.filter((item) => item.path !== path)
    const index = Math.max(0, Math.min(rest.length, to))
    update(key, { ...current, tabs: [...rest.slice(0, index), tab, ...rest.slice(index)] })
  },
}

function update(key: string, next: SessionTabs) {
  store.setState(
    "bySession",
    produce((all) => {
      delete all[key]
      all[key] = next
      const keys = Object.keys(all)
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete all[old]
    }),
  )
  persist()
}

function read(): Record<string, SessionTabs | undefined> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) => {
        const entry = value as { tabs?: unknown; active?: unknown; recent?: unknown }
        const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item) => typeof item === "string") : [])
        const tabs = strings(entry.tabs).slice(-MAX_TABS)
        return [
          [
            key,
            {
              tabs: tabs.map((path) => ({ path })),
              active: typeof entry.active === "string" && tabs.includes(entry.active) ? entry.active : tabs.at(-1),
              recent: strings(entry.recent).slice(0, MAX_RECENT),
            },
          ],
        ]
      }),
    )
  } catch {
    return {}
  }
}

function write(all: Record<string, SessionTabs | undefined>) {
  try {
    const plain = Object.fromEntries(
      Object.entries(all).flatMap(([key, value]) =>
        value ? [[key, { tabs: value.tabs.map((tab) => tab.path), active: value.active, recent: value.recent }]] : [],
      ),
    )
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plain))
  } catch {}
}

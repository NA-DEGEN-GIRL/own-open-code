// Prompt history store (03 §19.9): two lists (prompts, `!` shell commands) kept in IndexedDB, loaded when the page is
// idle after the first paint (PF1/PF7: nothing is read at startup), written 500 ms after the last change and only when
// idle (03 §20.2 R6: never inside an input handler). Sends recorded before the load finished are merged in order.
import { createRoot } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { idbStore, whenIdle, type KeyValueStore } from "./idb"
import { pushEntry, readEntries, type HistoryEntry, type HistoryMode } from "./model"

const DEBOUNCE_MS = 500
const MODES: readonly HistoryMode[] = ["normal", "shell"]

export interface PromptHistory {
  /** Newest first. Reactive; empty until `load()` finished. */
  entries(mode: HistoryMode): readonly HistoryEntry[]
  /** Records a send (text and the chips it went with). */
  record(mode: HistoryMode, entry: Omit<HistoryEntry, "at">): void
  /** Reads the stored lists once (idempotent). */
  load(): Promise<void>
  /** Writes pending changes now (page hidden, tests). */
  flush(): Promise<void>
  readonly loaded: () => boolean
}

export function createPromptHistory(
  store: KeyValueStore = idbStore("history"),
  now: () => number = Date.now,
): PromptHistory {
  const [state, setState] = createStore<{ loaded: boolean; lists: Record<HistoryMode, HistoryEntry[]> }>({
    loaded: false,
    lists: { normal: [], shell: [] },
  })
  const early: { mode: HistoryMode; entry: HistoryEntry }[] = []
  const dirty = new Set<HistoryMode>()
  let loading: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelIdle: (() => void) | undefined

  const write = async () => {
    timer = undefined
    cancelIdle = undefined
    const modes = [...dirty]
    dirty.clear()
    await Promise.all(modes.map((mode) => store.set(mode, [...unwrap(state.lists[mode])])))
  }
  const schedule = () => {
    if (!state.loaded || !dirty.size) return
    clearTimeout(timer)
    cancelIdle?.()
    timer = setTimeout(() => (cancelIdle = whenIdle(() => void write())), DEBOUNCE_MS)
  }
  const load = () => {
    loading ??= (async () => {
      const stored = await Promise.all(MODES.map(async (mode) => readEntries(await store.get(mode))))
      MODES.forEach((mode, index) => {
        // Stored lists first, then what was sent while they loaded (oldest to newest).
        const merged = early
          .filter((item) => item.mode === mode)
          .reduce<readonly HistoryEntry[]>((list, item) => pushEntry(list, item.entry), stored[index]!)
        setState("lists", mode, reconcile([...merged]))
      })
      early.length = 0
      setState("loaded", true)
      schedule()
    })()
    return loading
  }

  return {
    entries: (mode) => state.lists[mode],
    loaded: () => state.loaded,
    load,
    record(mode, entry) {
      const full = { ...entry, at: now() }
      const next = pushEntry(state.lists[mode], full)
      if (next === state.lists[mode]) return
      if (!state.loaded) {
        early.push({ mode, entry: full })
        void load()
      }
      setState("lists", mode, reconcile([...next]))
      dirty.add(mode)
      schedule()
    },
    async flush() {
      clearTimeout(timer)
      cancelIdle?.()
      if (state.loaded && dirty.size) await write()
    },
  }
}

/** The app's history (one per window; every composer shares it). Nothing is read until `load()`. */
export const promptHistory = createRoot(() => createPromptHistory())

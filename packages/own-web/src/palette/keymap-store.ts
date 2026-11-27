// User key overrides (03 §10 "단축키 도움말에서 키를 다시 지정할 수 있다", 19.15). Ids stay the keymap's; only chords
// change. Stored per browser in localStorage (a per-viewer preference like the layout widths): a failing store means
// the defaults, never an error. The effective keymap feeds the shortcut registry (`createRebindableRegistry`), the
// palette's key hints and the settings page. Kept free of UI imports: the registry wiring is in the first chunk.
import { createRoot, createSignal } from "solid-js"
import { normalizeChord } from "@/keyboard/chord"
import { DEFAULT_KEYMAP, type Keymap, type ShortcutDefinition, type ShortcutID } from "@/keyboard/keymap"

export const KEYMAP_STORAGE_KEY = "own.web.keymap.v1"

export type KeymapOverrides = Partial<Record<ShortcutID, readonly string[]>>

const store = createRoot(() => {
  const [overrides, setOverrides] = createSignal<KeymapOverrides>(read())
  return { overrides, setOverrides }
})
const listeners = new Set<(keymap: Keymap) => void>()

/** The user's overrides (reactive). An empty list means "not assigned". */
export const keymapOverrides = store.overrides

/** Defaults with the user's chords in place (reactive when read in a tracking scope). */
export function effectiveKeymap(): Keymap {
  return mergeKeymap(DEFAULT_KEYMAP, store.overrides())
}

export function mergeKeymap(defaults: Keymap, overrides: KeymapOverrides): Keymap {
  const entries = (Object.entries(defaults) as [ShortcutID, ShortcutDefinition][]).map(([id, definition]) => {
    const chords = overrides[id]
    return [id, chords ? { ...definition, chords } : definition] as const
  })
  return Object.fromEntries(entries) as Keymap
}

/** Replaces the chords of one id (`[]` = not assigned). Setting the defaults back removes the override. */
export function setChords(id: ShortcutID, chords: readonly string[]) {
  const normalized = [...new Set(chords.map(normalizeChord))]
  const defaults = DEFAULT_KEYMAP[id].chords.map(normalizeChord)
  const same = normalized.length === defaults.length && normalized.every((chord, index) => chord === defaults[index])
  const next = { ...store.overrides() }
  if (same) delete next[id]
  else next[id] = normalized
  commit(next)
}

export function resetChords(id: ShortcutID) {
  const next = { ...store.overrides() }
  delete next[id]
  commit(next)
}

export function resetAllChords() {
  commit({})
}

/** For non-reactive consumers (the registry wrapper). Returns the removal. */
export function onKeymapChange(listener: (keymap: Keymap) => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function commit(next: KeymapOverrides) {
  store.setOverrides(next)
  try {
    if (Object.keys(next).length) localStorage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(KEYMAP_STORAGE_KEY)
  } catch {}
  const keymap = effectiveKeymap()
  listeners.forEach((listener) => listener(keymap))
}

/** Known ids with string arrays only; anything else in storage is dropped. */
export function parseOverrides(raw: unknown): KeymapOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const entries = Object.entries(raw).flatMap(([id, chords]) => {
    if (!(id in DEFAULT_KEYMAP) || !Array.isArray(chords)) return []
    const valid = chords.filter((chord): chord is string => typeof chord === "string" && chord.length > 0)
    return valid.length === chords.length ? [[id, valid.map(normalizeChord)] as const] : []
  })
  return Object.fromEntries(entries) as KeymapOverrides
}

function read(): KeymapOverrides {
  try {
    return parseOverrides(JSON.parse(localStorage.getItem(KEYMAP_STORAGE_KEY) ?? "{}"))
  } catch {
    return {}
  }
}

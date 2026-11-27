// Shortcut registry (03 §10): one keydown listener, chords by `event.code`, nothing fires during IME composition
// (03 §12 rule 3), focus contexts decide what is live. Features register handlers by id; the keymap owns the keys.
import { chordOf, normalizeChord, type ChordEvent } from "./chord"
import { DEFAULT_KEYMAP, findConflicts, PASS_THROUGH_ALLOWED, type Keymap, type ShortcutID } from "./keymap"

export interface ShortcutKeyEvent extends ChordEvent {
  readonly isComposing: boolean
  readonly keyCode: number
  readonly target: EventTarget | null
  readonly defaultPrevented: boolean
  preventDefault(): void
  stopPropagation(): void
}

/**
 * Focus contexts, from the nearest `data-own-keys` ancestor of the event target:
 * - `composer`: the composer textarea (composer-scope ids live, `notInComposer` ids off),
 * - `pass-through`: a terminal or the native browser pane (only PASS_THROUGH_ALLOWED).
 */
export type KeyContext = "default" | "composer" | "pass-through"

/** Return `false` to let the event continue (not handled after all). */
export type ShortcutHandler = (event: ShortcutKeyEvent) => void | boolean

interface Registration {
  readonly handler: ShortcutHandler
  readonly when?: () => boolean
}

export function createShortcutRegistry(input?: { readonly keymap?: Keymap; readonly mac?: boolean }) {
  const keymap = input?.keymap ?? DEFAULT_KEYMAP
  const handlers = new Map<ShortcutID, Registration[]>()
  const byChord = new Map<string, ShortcutID[]>()
  for (const [id, definition] of Object.entries(keymap) as [ShortcutID, Keymap[ShortcutID]][])
    for (const chord of definition.chords) {
      const key = normalizeChord(chord)
      byChord.set(key, [...(byChord.get(key) ?? []), id])
    }

  function live(id: ShortcutID, context: KeyContext) {
    const definition = keymap[id]
    if (context === "pass-through") return PASS_THROUGH_ALLOWED.has(id)
    if (definition.scope === "composer") return context === "composer"
    return !(context === "composer" && "notInComposer" in definition && definition.notInComposer)
  }

  return {
    keymap,
    /** Registers a handler for an id; the latest registration wins while it is active. Returns a release. */
    register(id: ShortcutID, handler: ShortcutHandler, options?: { readonly when?: () => boolean }) {
      const registration: Registration = { handler, when: options?.when }
      handlers.set(id, [...(handlers.get(id) ?? []), registration])
      return () =>
        handlers.set(
          id,
          (handlers.get(id) ?? []).filter((item) => item !== registration),
        )
    },
    /** Handles one keydown; returns the id that ran, if any. */
    handle(event: ShortcutKeyEvent): ShortcutID | undefined {
      if (event.defaultPrevented) return undefined
      if (event.isComposing || event.keyCode === 229) return undefined
      const chord = chordOf(event, input?.mac)
      if (!chord) return undefined
      const context = contextOf(event.target)
      for (const id of byChord.get(chord) ?? []) {
        if (!live(id, context)) continue
        const registration = (handlers.get(id) ?? []).findLast((item) => item.when?.() ?? true)
        if (!registration) continue
        if (registration.handler(event) === false) continue
        event.preventDefault()
        event.stopPropagation()
        return id
      }
      return undefined
    },
    /** Ids with a live handler, for the help (03 §10 `Ctrl+/`). */
    registered(): ShortcutID[] {
      return [...handlers].filter(([, list]) => list.length).map(([id]) => id)
    },
    conflicts: () => findConflicts(keymap),
  }
}

export type ShortcutRegistry = ReturnType<typeof createShortcutRegistry>

export function contextOf(target: EventTarget | null): KeyContext {
  if (typeof Element === "undefined" || !(target instanceof Element)) return "default"
  const owner = target.closest("[data-own-keys]")
  const value = owner?.getAttribute("data-own-keys")
  if (value === "composer") return "composer"
  if (value === "terminal" || value === "browser") return "pass-through"
  return "default"
}

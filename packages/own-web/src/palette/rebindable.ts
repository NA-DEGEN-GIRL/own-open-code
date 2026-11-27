// A shortcut registry that follows the user's keymap (03 §10 rebinding) without changing `src/keyboard`: it keeps
// every registration and, when the keymap changes, builds a new inner registry with the same registrations in the
// same order ("latest registration wins" is kept). The shell passes it to `<ShortcutProvider value={…}>`.
import { createShortcutRegistry, type ShortcutRegistry } from "@/keyboard/registry"
import type { Keymap, ShortcutID } from "@/keyboard/keymap"
import { effectiveKeymap, onKeymapChange } from "./keymap-store"

type Handler = Parameters<ShortcutRegistry["register"]>[1]
type Options = Parameters<ShortcutRegistry["register"]>[2]
type Release = ReturnType<ShortcutRegistry["register"]>

interface Kept {
  readonly id: ShortcutID
  readonly handler: Handler
  readonly options: Options
  release: Release
}

export function createRebindableRegistry(input?: {
  readonly keymap?: () => Keymap
  /** Change feed; default: the user keymap store. Returns its removal. */
  readonly subscribe?: (listener: (keymap: Keymap) => void) => () => void
  readonly mac?: boolean
}): ShortcutRegistry & { readonly dispose: () => void } {
  const kept = new Set<Kept>()
  const build = (keymap: Keymap) => createShortcutRegistry({ keymap, mac: input?.mac })
  let inner = build((input?.keymap ?? effectiveKeymap)())
  const dispose = (input?.subscribe ?? onKeymapChange)((keymap) => {
    const next = build(keymap)
    for (const item of kept) {
      item.release()
      item.release = next.register(item.id, item.handler, item.options)
    }
    inner = next
  })
  return {
    get keymap() {
      return inner.keymap
    },
    register(id, handler, options) {
      const item: Kept = { id, handler, options, release: inner.register(id, handler, options) }
      kept.add(item)
      return () => {
        kept.delete(item)
        return item.release()
      }
    },
    handle: (event) => inner.handle(event),
    registered: () => inner.registered(),
    conflicts: () => inner.conflicts(),
    dispose,
  }
}

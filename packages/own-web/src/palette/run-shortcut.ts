// Runs the handler a shortcut id has right now, as if its keys were pressed outside any focused widget (context
// `default`). The palette uses it for actions that only exist as shortcut handlers (the approval menu, message
// navigation, find, zoom…), so a feature that registers a shortcut is reachable from Ctrl+K without extra wiring.
import { isMac } from "@/keyboard/chord"
import type { ShortcutID } from "@/keyboard/keymap"
import type { ShortcutRegistry } from "@/keyboard/registry"

/** True when a live handler took it. */
export function runShortcut(registry: ShortcutRegistry, id: ShortcutID, mac = isMac) {
  const chord = registry.keymap[id].chords[0]
  if (!chord) return false
  const parts = chord.split("+")
  const code = parts.at(-1) ?? ""
  const event = new KeyboardEvent("keydown", {
    code,
    key: keyOf(code),
    ctrlKey: mac ? parts.includes("Ctrl") : parts.includes("Mod"),
    metaKey: mac && parts.includes("Mod"),
    altKey: parts.includes("Alt"),
    shiftKey: parts.includes("Shift"),
    bubbles: true,
    cancelable: true,
  })
  return registry.handle(event) === id
}

/** Can the palette offer it: a handler is registered (a `when` guard is checked only when it runs). */
export function hasShortcutHandler(registry: ShortcutRegistry, id: ShortcutID) {
  return registry.registered().includes(id) && registry.keymap[id].chords.length > 0
}

function keyOf(code: string) {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase()
  if (code.startsWith("Digit")) return code.slice(5)
  return code
}

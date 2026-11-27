import { createContext, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { createShortcutRegistry, type ShortcutHandler, type ShortcutRegistry } from "./registry"
import type { ShortcutID } from "./keymap"

export { chordLabel, chordOf, eventCode, isMac } from "./chord"
export { DEFAULT_KEYMAP, findConflicts, type ShortcutID } from "./keymap"
export { createShortcutRegistry, type ShortcutRegistry } from "./registry"

const ShortcutContext = createContext<ShortcutRegistry>()

/** Installs the single window keydown listener (bubble phase, so focused widgets see keys first). */
export function ShortcutProvider(props: ParentProps<{ value?: ShortcutRegistry }>) {
  const registry = props.value ?? createShortcutRegistry()
  onMount(() => {
    const listener = (event: KeyboardEvent) => void registry.handle(event)
    window.addEventListener("keydown", listener)
    onCleanup(() => window.removeEventListener("keydown", listener))
  })
  return <ShortcutContext.Provider value={registry}>{props.children}</ShortcutContext.Provider>
}

export function useShortcuts() {
  const value = useContext(ShortcutContext)
  if (!value) throw new Error("useShortcuts() needs <ShortcutProvider>")
  return value
}

const GateContext = createContext<() => boolean>()

/**
 * Shortcuts registered below are live only while `value` is true (03 §4.1.1: the focused split pane's composer, find
 * and switcher take the keys; the other panes' registrations wait).
 */
export const ShortcutGate = GateContext.Provider

/** Registers for the lifetime of the calling component (gated by a surrounding `ShortcutGate`). */
export function useShortcut(id: ShortcutID, handler: ShortcutHandler, options?: { readonly when?: () => boolean }) {
  const registry = useShortcuts()
  onCleanup(registry.register(id, handler, gated(useContext(GateContext), options)))
}

/** A registration's `when` under a gate: live only while the gate is open and its own condition holds. */
export function gated(gate: (() => boolean) | undefined, options?: { readonly when?: () => boolean }) {
  const when = options?.when
  return gate ? { when: () => gate() && (when?.() ?? true) } : options
}

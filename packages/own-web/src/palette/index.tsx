// Palette module entry (03 §3 "명령 팔레트", §10, 19.15 [gap] 32; owner: palette). The eager part is tiny: the
// `palette.open` shortcut (Ctrl+K, live in terminals and the browser pane too), the open state and the command
// registry other modules add to. The dialog and its built-in commands are a lazy chunk, prefetched when the page is
// idle so the first Ctrl+K opens at once. Also here: the user keymap (rebinding, 03 §10) with the registry wrapper
// the shell uses, and the shortcut settings page (`./shortcut-settings`, lazy, for /settings/shortcuts).
import { lazy, onMount, Show, Suspense } from "solid-js"
import { loadEnglish } from "@/i18n"
import { useShortcut } from "@/keyboard"
import { closePalette, paletteOpen, togglePalette } from "./control"

export { closePalette, openPalette, paletteOpen, togglePalette, type PaletteRequest } from "./control"
export {
  PALETTE_GROUPS,
  registerPaletteSource,
  usePaletteCommands,
  type PaletteCommand,
  type PaletteGroup,
  type PaletteSource,
} from "./registry"
export {
  effectiveKeymap,
  keymapOverrides,
  onKeymapChange,
  resetAllChords,
  resetChords,
  setChords,
  type KeymapOverrides,
} from "./keymap-store"
export { createRebindableRegistry } from "./rebindable"
export { runShortcut } from "./run-shortcut"
// Strings stay out of this entry (it is in the first chunk): import `@/palette/strings` where they are needed.

const Palette = lazy(() => import("./palette"))

/** Mount once in the shell (inside the shell, router, data and shortcut providers). */
export function PaletteLayer() {
  useShortcut("palette.open", () => togglePalette())
  onMount(() => {
    const prefetch = () => {
      void import("./palette")
      // The commands' words in the other language (builtin.ts `other`).
      void loadEnglish()
    }
    if (typeof requestIdleCallback === "function") requestIdleCallback(prefetch, { timeout: 5_000 })
    else setTimeout(prefetch, 2_000)
  })
  return (
    <Show when={paletteOpen()} keyed>
      {(request) => (
        <Suspense>
          <Palette request={request} onClose={closePalette} />
        </Suspense>
      )}
    </Show>
  )
}

// Ctrl+F priority between the session find (19.13) and session-ui's file find. session-ui's `File` installs one window
// keydown listener in the capture phase the first time a file viewer mounts (packages/session-ui/src/pierre/
// file-find.ts); from then on it takes Ctrl+F from anywhere in the page — focus in the transcript opened the files
// tab's find bar. This guard is installed by the shell at startup, so it runs before that listener: outside a file
// viewer (the files tab's code view, the review diff) the transcript on screen gets the key, and the default is
// prevented, which session-ui's listener respects. Inside a file viewer session-ui keeps it. First chunk: tiny.
import type { ShortcutRegistry } from "@/keyboard"
import { chordOf, normalizeChord } from "@/keyboard/chord"

/** Where session-ui's file find owns the key (files tab code view, review diff preview). */
export const FILE_FIND_HOST = "[data-own-file-find]"

let open: (() => void) | undefined

/** The session find on screen claims the key while it is active; returns the release. */
export function claimSessionFind(handler: () => void) {
  open = handler
  return () => {
    if (open === handler) open = undefined
  }
}

export function installFindPriority(registry: Pick<ShortcutRegistry, "keymap">) {
  const listener = (event: KeyboardEvent) => {
    if (!open || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    const chord = chordOf(event)
    if (!chord || !registry.keymap["session.find"].chords.some((item) => normalizeChord(item) === chord)) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(FILE_FIND_HOST) || document.activeElement?.closest(FILE_FIND_HOST)) return
    // A terminal or the browser pane keeps its keys (03 §10); a modal (palette, dialogs) keeps everything under it.
    if (target?.closest('[data-own-keys="terminal"], [data-own-keys="browser"], [aria-modal="true"]')) return
    event.preventDefault()
    event.stopPropagation()
    open()
  }
  window.addEventListener("keydown", listener, { capture: true })
  return () => window.removeEventListener("keydown", listener, { capture: true })
}

// The pane chords a native browser view hands to its window (03 §4.1.1, own-browser.ts `wireBrowserViews`). Pure, so
// the shell test covers it without Electron.
import type { OwnBrowserViewKey } from "../preload/own-api"

/**
 * F6, Shift+F6 and Ctrl+Alt+1–4 with no other modifier. Every other key stays with the page; on layouts where AltGr+1–4
 * types a character (AltGr is Ctrl+Alt on Windows), those four go to the window instead.
 */
export function paneChord(
  input: Pick<Electron.Input, "type" | "code" | "control" | "alt" | "shift" | "meta">,
): OwnBrowserViewKey | undefined {
  if (input.type !== "keyDown" || input.meta) return undefined
  if (input.code === "F6" && !input.control && !input.alt)
    return { code: "F6", ctrl: false, alt: false, shift: input.shift }
  if (input.control && input.alt && !input.shift && /^Digit[1-4]$/.test(input.code))
    return { code: input.code, ctrl: true, alt: true, shift: false }
  return undefined
}

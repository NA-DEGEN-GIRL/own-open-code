// ↑/↓ prompt history in the composer (03 §19.9). IME-safe (03 §12 rule 3): a key that belongs to a composition
// (`isComposing`, keyCode 229 or our own flag) is never taken, and the text is only replaced from a plain keydown, never
// while composing (rule 5). Modified arrows stay with their shortcuts (Alt+↑ previous session, Ctrl+↑ queue edit,
// Shift+↑ selection). The suggestion list gets the keys first (the composer calls this after `suggest.keydown`).
//
// Browsing keeps the draft the user was writing (text and chips) as position -1; ↓ past the newest entry puts it back.
import { createSignal } from "solid-js"
import type { ImeKeyEvent } from "@/ime/ime-enter"
import { isImeKey } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import type { ChipStore, MentionChip } from "@/mentions"
import { canNavigate, step, type HistoryMode } from "./model"
import type { PromptHistory } from "./store"

export interface HistoryNavigatorOptions {
  readonly element: () => HTMLTextAreaElement | undefined
  readonly history: PromptHistory
  /** `shell` while the composer is in `!` shell mode (its own list). */
  readonly mode: () => HistoryMode
  /** The composer's own composition flag (`createComposerInput().composing`). */
  readonly composing: () => boolean
  /** Chips of the draft on screen: an entry brings its chips back, the saved draft gets its own back. */
  readonly chips?: ChipStore
  readonly draftKey: () => string
  /**
   * The text changed without an `input` event: save the draft, resize, let the suggestions look again (the composer's
   * `drafts.set`, `resize`, `suggest.reset`).
   */
  readonly changed: (text: string) => void
}

interface Snapshot {
  readonly text: string
  readonly chips: readonly MentionChip[]
}

export type HistoryNavigator = ReturnType<typeof createHistoryNavigator>

export function createHistoryNavigator(options: HistoryNavigatorOptions) {
  const [index, setIndex] = createSignal(-1)
  let saved: Snapshot | undefined

  const apply = (element: HTMLTextAreaElement, next: Snapshot, caret: "start" | "end") => {
    element.value = next.text
    const at = caret === "start" ? 0 : next.text.length
    element.setSelectionRange(at, at)
    const chips = options.chips
    if (chips) {
      const key = options.draftKey()
      chips.clear(key)
      chips.restore(key, next.chips)
    }
    options.changed(next.text)
  }

  return {
    /** Position on screen: `-1` is the draft, `0` the newest entry. */
    index,
    browsing: () => index() >= 0,
    /** Call from the textarea's keydown after the suggestion list; `true` means handled (stop). */
    keydown(event: ImeKeyEvent): boolean {
      if (isImeKey(event, options.composing())) return false
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      const code = eventCode(event)
      if (code !== "ArrowUp" && code !== "ArrowDown") return false
      const element = options.element()
      if (!element) return false
      const direction = code === "ArrowUp" ? "up" : "down"
      const caret = {
        text: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
        browsing: index() >= 0,
      }
      if (!canNavigate(direction, caret)) return false
      if (!options.history.loaded()) {
        void options.history.load()
        return false
      }
      const entries = options.history.entries(options.mode())
      const next = step(index(), direction, entries.length)
      if (next === undefined) return false
      event.preventDefault()
      if (index() === -1) saved = { text: element.value, chips: [...(options.chips?.list(options.draftKey()) ?? [])] }
      setIndex(next)
      const entry = next === -1 ? saved : entries[next]
      if (next === -1) saved = undefined
      apply(element, { text: entry?.text ?? "", chips: entry?.chips ?? [] }, direction === "up" ? "start" : "end")
      return true
    },
    /** After a send, a session change or a mode change: the next ↑ starts at the newest entry again. */
    reset() {
      setIndex(-1)
      saved = undefined
    },
  }
}
